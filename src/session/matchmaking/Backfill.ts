/**
 * Backfill — replacing players who leave a live match.
 *
 * Two halves:
 *
 *  - **Supply.** A match that loses a human raises a *need*. Needs are not
 *    raised instantly: a player who disconnects usually comes back, and
 *    handing their slot away in the first five seconds guarantees they cannot.
 *    After the grace window the slot is offered, first to a bot (instant, free)
 *    and then, if a human turns up, the bot yields.
 *
 *  - **Admission.** Not every match should accept a stranger. Dropping someone
 *    into the last ninety seconds of a 6–0 loss is worse for them than another
 *    twenty seconds of queue, and it is worse for the match too — the newcomer
 *    quits, which raises another need. `canBackfill` encodes the rules and
 *    returns *why* it refused, which is what makes the behaviour tunable
 *    instead of mysterious.
 *
 * Ranked playlists refuse backfill entirely: a rated match with a substitute is
 * not a rated match.
 */

import { chooseBotToYield, humansOn, removeBot, teamForIncoming } from './BotFill';
import { effectiveRtt, selectHost, type HostCandidateInfo } from './Connection';
import { playlist as playlistDef } from './Playlists';
import type {
  BackfillRefusal, BotId, HumanSlot, LiveMatchView, MatchId, MatchRoster,
  PlayerId, PlaylistDef, QueueTicket,
} from './types';

export interface BackfillPolicy {
  /** No joining after this fraction of the scheduled match length. */
  maxElapsedFraction: number;
  /** No joining with less than this many seconds left. */
  minSecondsRemaining: number;
  /** No joining once the leader has this fraction of the score limit. */
  maxLeaderFraction: number;
  /** No joining when the gap is this fraction of the limit — that is a stomp. */
  maxScoreGapFraction: number;
  /** Seconds a vacated slot is held for the player who left. */
  graceAfterLeave: number;
  /** Preferred ping ceiling for a backfill candidate, in ms. Candidates above
   *  it are not refused — they are ranked below closer ones and only taken when
   *  nothing better is on offer. See `hardMaxPing`. */
  maxPing: number;
  /**
   * Absolute ping ceiling. Above this the player genuinely cannot play and we
   * leave the bot in place.
   *
   * The gap between the two matters more than either number. Treating `maxPing`
   * as a hard refusal means a slot currently occupied by a *bot* gets withheld
   * from a real human at 180 ms — trading a player who wants to play for a
   * robot, on the grounds that the player's connection is mediocre. That is
   * backwards: the bot's "connection" is perfect and its contribution is nil.
   * So the preferred ceiling only sorts, and the hard ceiling refuses.
   */
  hardMaxPing: number;
}

export const DEFAULT_BACKFILL: BackfillPolicy = {
  maxElapsedFraction: 0.65,
  minSecondsRemaining: 90,
  maxLeaderFraction: 0.8,
  maxScoreGapFraction: 0.5,
  graceAfterLeave: 5,
  maxPing: 170,
  hardMaxPing: 280,
};

/** Why a match will or will not take a backfill right now. */
export function canBackfill(
  view: LiveMatchView, def: PlaylistDef, policy: BackfillPolicy,
): BackfillRefusal {
  if (def.ranked) return 'ranked';
  if (!def.allowBackfill) return 'playlist-forbids';
  if (view.phase !== 'live' && view.phase !== 'warmup') return 'phase';

  if (view.duration > 0) {
    if (view.elapsed / view.duration > policy.maxElapsedFraction) return 'too-late';
    if (view.duration - view.elapsed < policy.minSecondsRemaining) return 'too-late';
  }
  if (view.scoreLimit > 0 && view.teamScores.length >= 2) {
    const hi = Math.max(...view.teamScores);
    const lo = Math.min(...view.teamScores);
    if (hi / view.scoreLimit > policy.maxLeaderFraction) return 'too-late';
    if ((hi - lo) / view.scoreLimit > policy.maxScoreGapFraction) return 'blowout';
  }
  return 'ok';
}

/* ------------------------------------------------------------- registry -- */

interface Entry {
  roster: MatchRoster;
  view: LiveMatchView;
  def: PlaylistDef;
  /** playerId → match-clock time the slot was vacated. */
  vacated: Map<PlayerId, number>;
}

export interface BackfillNeed {
  matchId: MatchId;
  team: number;
  count: number;
}

export interface BackfillPlacement {
  matchId: MatchId;
  team: number;
  /** Bots removed so the humans could take their slots. */
  yieldedBots: BotId[];
  /** Slots added. */
  added: HumanSlot[];
}

export class BackfillManager {
  private matches = new Map<MatchId, Entry>();
  readonly refusals = new Map<BackfillRefusal, number>();

  constructor(public policy: BackfillPolicy = DEFAULT_BACKFILL) { }

  get size(): number { return this.matches.size; }

  register(roster: MatchRoster, view: LiveMatchView): void {
    this.matches.set(roster.matchId, {
      roster, view, def: playlistDef(roster.playlist), vacated: new Map(),
    });
  }

  update(view: LiveMatchView): void {
    const e = this.matches.get(view.matchId);
    if (e) e.view = view;
  }

  rosterOf(id: MatchId): MatchRoster | undefined { return this.matches.get(id)?.roster; }

  viewOf(id: MatchId): LiveMatchView | undefined { return this.matches.get(id)?.view; }

  end(id: MatchId): MatchRoster | undefined {
    const e = this.matches.get(id);
    this.matches.delete(id);
    return e?.roster;
  }

  matchIds(): MatchId[] { return [...this.matches.keys()]; }

  /** Removes a human from a roster and starts the grace clock on their slot. */
  playerLeft(matchId: MatchId, playerId: PlayerId, now: number): boolean {
    const e = this.matches.get(matchId);
    if (!e) return false;
    const i = e.roster.slots.findIndex((s) => s.kind === 'human' && s.playerId === playerId);
    if (i < 0) return false;
    e.roster.slots.splice(i, 1);
    e.vacated.set(playerId, now);
    // The host just left — re-elect from whoever is still connected.
    if (e.roster.hostId === playerId) {
      const candidates: HostCandidateInfo[] = e.roster.slots
        .filter((s): s is HumanSlot => s.kind === 'human')
        .map((s) => ({ playerId: s.playerId, connection: s.connection }));
      e.roster.hostId = selectHost(candidates, Math.max(0, candidates.length - 1)).hostId;
    }
    return true;
  }

  /**
   * Slots that have been empty longer than the grace window. Bots should be
   * spawned into these immediately — that is what keeps a match playable while
   * the queue looks for a human.
   */
  needs(now: number): BackfillNeed[] {
    const out: BackfillNeed[] = [];
    for (const e of this.matches.values()) {
      if (canBackfill(e.view, e.def, this.policy) !== 'ok') continue;
      let ready = false;
      for (const at of e.vacated.values()) if (now - at >= this.policy.graceAfterLeave) ready = true;
      if (!ready) continue;
      for (let t = 0; t < e.def.teams; t++) {
        const filled = e.roster.slots.filter((s) => s.team === t).length;
        const gap = e.def.teamSize - filled;
        const botsHere = e.roster.slots.filter((s) => s.kind === 'bot' && s.team === t).length;
        // A team holding bots is still a team that wants humans.
        const count = gap + botsHere;
        if (count > 0) out.push({ matchId: e.roster.matchId, team: t, count });
      }
    }
    return out;
  }

  /**
   * Finds the best live match for a ticket. Scored on skill fit first and ping
   * second — a backfilled player who cannot hit anything leaves again.
   */
  findMatch(ticket: QueueTicket, now: number): MatchId | null {
    let best: MatchId | null = null;
    let bestCost = Infinity;
    for (const e of this.matches.values()) {
      if (e.def.id !== ticket.playlist) continue;
      const refusal = canBackfill(e.view, e.def, this.policy);
      if (refusal !== 'ok') { this.count(refusal); continue; }

      const openings = this.openings(e);
      if (openings < ticket.members.length) { this.count('no-slot'); continue; }

      const humans = e.roster.slots.filter((s): s is HumanSlot => s.kind === 'human');
      const mean = humans.length
        ? humans.reduce((a, h) => a + h.rating.rating, 0) / humans.length
        : ticket.skill;

      let ping = 0;
      const host = humans.find((h) => h.playerId === e.roster.hostId);
      if (host) {
        for (const m of ticket.members) ping = Math.max(ping, effectiveRtt(m.connection, host.connection));
      }
      if (ping > this.policy.hardMaxPing) { this.count('ping'); continue; }

      // Over the preferred ceiling is a heavy sort penalty, not a refusal: a
      // closer match wins outright, but a laggy human still beats a bot.
      const overshoot = Math.max(0, ping - this.policy.maxPing);
      const cost = Math.abs(mean - ticket.skill)
        + ping * 1.5
        + overshoot * 12
        + (now - e.roster.formedAt) * 0.05;
      if (cost < bestCost) { bestCost = cost; best = e.roster.matchId; }
    }
    if (!best) this.count('match-unknown');
    return best;
  }

  private openings(e: Entry): number {
    let n = 0;
    for (let t = 0; t < e.def.teams; t++) {
      const slots = e.roster.slots.filter((s) => s.team === t);
      n += (e.def.teamSize - slots.length) + slots.filter((s) => s.kind === 'bot').length;
    }
    return n;
  }

  private count(r: BackfillRefusal): void {
    this.refusals.set(r, (this.refusals.get(r) ?? 0) + 1);
  }

  /**
   * Places a ticket into a live match, yielding bot slots as required. Returns
   * null when the match filled up between `findMatch` and here.
   */
  place(matchId: MatchId, ticket: QueueTicket, now: number): BackfillPlacement | null {
    const e = this.matches.get(matchId);
    if (!e) return null;
    if (this.openings(e) < ticket.members.length) return null;

    const yieldedBots: BotId[] = [];
    const added: HumanSlot[] = [];
    for (const m of ticket.members) {
      const team = teamForIncoming(e.roster, e.def);
      const filled = e.roster.slots.filter((s) => s.team === team).length;
      if (filled >= e.def.teamSize) {
        const bot = chooseBotToYield(e.roster, team, m.rating.rating);
        if (!bot) return added.length ? { matchId, team, yieldedBots, added } : null;
        removeBot(e.roster, bot.botId);
        yieldedBots.push(bot.botId);
      }
      const slot: HumanSlot = {
        kind: 'human',
        playerId: m.playerId,
        name: m.name,
        team,
        rating: m.rating,
        connection: m.connection,
        partyId: ticket.partyId,
        joinedAt: now,
        backfilled: true,
      };
      e.roster.slots.push(slot);
      added.push(slot);
      e.vacated.delete(m.playerId);
    }
    return { matchId, team: added[0]?.team ?? 0, yieldedBots, added };
  }

  /** Clears the grace clock for slots nobody reclaimed. */
  sweep(now: number): void {
    for (const e of this.matches.values()) {
      for (const [id, at] of e.vacated) {
        if (now - at > this.policy.graceAfterLeave * 6) e.vacated.delete(id);
      }
    }
  }
}
