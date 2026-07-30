/**
 * Pre-match map/mode vote.
 *
 * Three cards, one vote each, changeable until the board closes. Two things
 * matter more than the mechanic itself:
 *
 * **Every path terminates.** The vote closes when the last member has voted or
 * when the clock runs out, and an empty board still produces a winner — the
 * card flagged `recommended`. A lobby can never wedge waiting for a vote.
 *
 * **The result is migration-proof.** Both the candidate list and the tie-break
 * are derived from `hash(lobbyId, matchIndex, candidateId)` rather than from a
 * live RNG stream, so a host that takes over mid-vote computes the identical
 * board and the identical winner. Tie-break order:
 *
 *   1. most votes
 *   2. prefer a map that is not the one just played (freshness)
 *   3. the lobby leader's vote
 *   4. lowest stable hash
 */

import { hashString } from '../../core/Rand';
import type {
  GameModeId, MapDef, ModeDef, PlayerId, VoteCandidate, VoteResolution, VoteState,
} from '../types';
import { type LobbyCatalog, modeFits } from './Catalog';

export interface CandidateContext {
  lobbyId: string;
  matchIndex: number;
  players: number;
  lastMapId: string | null;
  count: number;
}

/** Stable, migration-safe ordering key for a candidate. */
function rankKey(lobbyId: string, matchIndex: number, candidateId: string): number {
  return hashString(`${lobbyId}#${matchIndex}#${candidateId}`);
}

export function candidateId(mapId: string, modeId: GameModeId): string {
  return `${modeId}@${mapId}`;
}

function makeCandidate(map: MapDef, mode: ModeDef): VoteCandidate {
  return {
    id: candidateId(map.id, mode.id),
    mapId: map.id,
    modeId: mode.id,
    label: map.name.toUpperCase(),
    sublabel: mode.name.toUpperCase(),
    tagline: mode.tagline,
    votes: 0,
    voters: [],
    recommended: false,
  };
}

/**
 * Builds the board. Prefers distinct maps and distinct modes so the cards read
 * as real alternatives rather than three shades of the same match.
 */
export function buildCandidates(catalog: LobbyCatalog, ctx: CandidateContext): VoteCandidate[] {
  const modes = catalog.modes.filter((m) => modeFits(m, ctx.players));
  const usableModes = modes.length ? modes : [catalog.modes[0]];
  const maps = catalog.maps.filter((m) => ctx.players >= m.minPlayers && ctx.players <= m.maxPlayers);
  const usableMaps = maps.length ? maps : [...catalog.maps];

  const pool: VoteCandidate[] = [];
  for (const mode of usableModes) for (const map of usableMaps) pool.push(makeCandidate(map, mode));

  pool.sort((a, b) => {
    // Freshness first: anything but the map we just played.
    const af = a.mapId === ctx.lastMapId ? 1 : 0;
    const bf = b.mapId === ctx.lastMapId ? 1 : 0;
    if (af !== bf) return af - bf;
    return rankKey(ctx.lobbyId, ctx.matchIndex, a.id) - rankKey(ctx.lobbyId, ctx.matchIndex, b.id);
  });

  const want = Math.max(1, Math.min(ctx.count, pool.length));
  const out: VoteCandidate[] = [];
  const seenMaps = new Set<string>();
  const seenModes = new Set<GameModeId>();

  // Pass 1: fully distinct map *and* mode.
  for (const c of pool) {
    if (out.length >= want) break;
    if (seenMaps.has(c.mapId) || seenModes.has(c.modeId)) continue;
    out.push(c); seenMaps.add(c.mapId); seenModes.add(c.modeId);
  }
  // Pass 2: distinct map, mode may repeat (few modes, many maps).
  for (const c of pool) {
    if (out.length >= want) break;
    if (seenMaps.has(c.mapId)) continue;
    out.push(c); seenMaps.add(c.mapId);
  }
  // Pass 3: whatever is left.
  for (const c of pool) {
    if (out.length >= want) break;
    if (out.some((o) => o.id === c.id)) continue;
    out.push(c);
  }

  if (out.length) out[0].recommended = true;
  return out;
}

export interface VoteResult {
  candidate: VoteCandidate;
  resolvedBy: VoteResolution;
}

export class VoteBooth {
  private candidates: VoteCandidate[] = [];
  private votes = new Map<PlayerId, string>();
  private timer = -1;
  private total = 0;
  private isOpen = false;
  private winner: VoteCandidate | null = null;
  private resolution: VoteResolution | null = null;

  constructor(
    private lobbyId: string,
    private matchIndex: number,
    private lastMapId: string | null,
  ) { }

  get open(): boolean { return this.isOpen; }
  get resolved(): boolean { return this.winner !== null; }
  get result(): VoteResult | null {
    return this.winner && this.resolution
      ? { candidate: this.winner, resolvedBy: this.resolution }
      : null;
  }
  get cards(): readonly VoteCandidate[] { return this.candidates; }

  /** Re-seeds the board for a new round. */
  reset(matchIndex: number, lastMapId: string | null): void {
    this.matchIndex = matchIndex;
    this.lastMapId = lastMapId;
    this.candidates = [];
    this.votes.clear();
    this.timer = -1;
    this.total = 0;
    this.isOpen = false;
    this.winner = null;
    this.resolution = null;
  }

  openBoard(candidates: VoteCandidate[], seconds: number): void {
    this.candidates = candidates;
    this.votes.clear();
    this.timer = seconds;
    this.total = seconds;
    this.isOpen = candidates.length > 1;
    this.winner = null;
    this.resolution = null;
    // A single legal option is not a vote; it is a fact.
    if (!this.isOpen && candidates.length === 1) {
      this.winner = candidates[0];
      this.resolution = 'pinned';
      this.timer = -1;
    }
  }

  /** Pins a result without a vote — the leader chose the map and mode. */
  pin(candidate: VoteCandidate): void {
    this.candidates = [candidate];
    this.votes.clear();
    this.isOpen = false;
    this.timer = -1;
    this.total = 0;
    this.winner = candidate;
    this.resolution = 'pinned';
  }

  has(candidateId_: string): boolean {
    return this.candidates.some((c) => c.id === candidateId_);
  }

  /** Records or changes a vote. False when the board is shut or the card is unknown. */
  cast(playerId: PlayerId, candidateId_: string): boolean {
    if (!this.isOpen || !this.has(candidateId_)) return false;
    this.votes.set(playerId, candidateId_);
    this.recount();
    return true;
  }

  withdraw(playerId: PlayerId): void {
    if (!this.votes.delete(playerId)) return;
    this.recount();
  }

  voteOf(playerId: PlayerId): string | null { return this.votes.get(playerId) ?? null; }
  get castCount(): number { return this.votes.size; }

  private recount(): void {
    for (const c of this.candidates) { c.votes = 0; c.voters.length = 0; }
    for (const [player, id] of this.votes) {
      const c = this.candidates.find((x) => x.id === id);
      if (!c) continue;
      c.votes++;
      c.voters.push(player);
    }
    for (const c of this.candidates) c.voters.sort();
  }

  /**
   * Advances the clock. Returns true on the tick the board closes so the caller
   * can announce the result exactly once.
   */
  tick(dt: number, electorate: number, leaderId: PlayerId): boolean {
    if (!this.isOpen) return false;
    if (electorate > 0 && this.votes.size >= electorate) {
      this.close(leaderId);
      return true;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0;
      this.close(leaderId);
      return true;
    }
    return false;
  }

  /** Shuts the board and locks the winner in. Idempotent. */
  close(leaderId: PlayerId): VoteResult | null {
    if (!this.isOpen) return this.result;
    this.isOpen = false;
    this.timer = -1;
    if (!this.candidates.length) return null;

    if (this.votes.size === 0) {
      const rec = this.candidates.find((c) => c.recommended) ?? this.candidates[0];
      this.winner = rec;
      this.resolution = 'timeout-default';
      return this.result;
    }

    let best = this.candidates[0].votes;
    for (const c of this.candidates) if (c.votes > best) best = c.votes;
    let tied = this.candidates.filter((c) => c.votes === best);
    let by: VoteResolution = 'votes';

    if (tied.length > 1 && this.lastMapId) {
      const fresh = tied.filter((c) => c.mapId !== this.lastMapId);
      if (fresh.length && fresh.length < tied.length) { tied = fresh; by = 'freshness'; }
    }
    if (tied.length > 1) {
      const leaderVote = this.votes.get(leaderId);
      const pick = leaderVote ? tied.find((c) => c.id === leaderVote) : undefined;
      if (pick) { this.winner = pick; this.resolution = 'leader'; return this.result; }
    }
    if (tied.length > 1) {
      tied.sort((a, b) =>
        rankKey(this.lobbyId, this.matchIndex, a.id) - rankKey(this.lobbyId, this.matchIndex, b.id));
      by = 'hash';
    }
    this.winner = tied[0];
    this.resolution = by;
    return this.result;
  }

  state(): VoteState {
    return {
      open: this.isOpen,
      secondsLeft: this.isOpen ? Math.max(0, Math.round(this.timer * 10) / 10) : -1,
      total: this.total,
      candidates: this.candidates.map((c) => ({ ...c, voters: [...c.voters] })),
      winner: this.winner?.id ?? null,
      resolvedBy: this.resolution,
      cast: this.votes.size,
    };
  }

  /** Restores a board from a snapshot after host migration. */
  load(state: VoteState, votes: ReadonlyArray<[PlayerId, string]>): void {
    this.candidates = state.candidates.map((c) => ({ ...c, voters: [...c.voters] }));
    this.votes = new Map(votes);
    this.isOpen = state.open;
    this.timer = state.secondsLeft;
    this.total = state.total;
    this.winner = state.winner
      ? this.candidates.find((c) => c.id === state.winner) ?? null
      : null;
    this.resolution = state.resolvedBy;
    this.recount();
  }

  /** The raw ballot, for snapshotting. */
  ballot(): Array<[PlayerId, string]> { return [...this.votes.entries()]; }
}
