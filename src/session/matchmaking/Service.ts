/**
 * MatchmakingService — the authority-aware facade.
 *
 * ## Who decides what
 *
 * ```
 *   client                      host
 *   ------                      ----
 *   requestJoin()  ──queue:join──▶ admit() → MatchQueue
 *                  ◀ticket:update─ (broadcast, every tick)
 *                  ◀─match:found── proposal
 *                  ◀roster:update─ bot fill / bot yield / backfill
 * ```
 *
 * A client's `requestJoin` never touches the local queue — it emits a message
 * and waits. `snapshot().mirrored` is true on a client so the UI can be honest
 * about showing host state. The host rebuilds every incoming ticket from *its
 * own* rating store where it knows the player, and only trusts the claimed
 * rating for someone it has never seen; a client cannot lie its way into a
 * softer lobby beyond one match.
 *
 * The service owns no clock. Call `update(now)` from wherever the session
 * layer's tick lives (`now` in seconds, monotonic).
 */

import { Rand } from '../../core/Rand';
import type { EventKey, GameEvents } from '../../core/EventBus';
import { BackfillManager, type BackfillPolicy } from './Backfill';
import { botsOn, fillRoster, humansOn } from './BotFill';
import { selectHost, type HostCandidateInfo } from './Connection';
import { MatchQueue, type QueueOptions } from './Queue';
import { applyMatch, newRating } from './Rating';
import { playlist as playlistDef } from './Playlists';
import { RatingStore } from './Store';
import { LoopbackTransport } from './Transport';
import { partySkill } from './TeamBalance';
import type {
  ConnectionInfo, HumanSlot, LiveMatchView, MatchId, MatchProposal, MatchRoster,
  MatchmakingMessage, MatchmakingSnapshot, MatchmakingTransport, PlayerId,
  PlaylistId, QueueMember, QueueState, QueueTicket, SkillRating, TicketId,
} from './types';
import { defaultConnection } from './Connection';
import './events';

export type MmEmitter = <K extends EventKey>(key: K, payload: GameEvents[K]) => void;

/** One player as the caller knows them, before the host applies its own store. */
export interface PartyMemberInput {
  playerId: PlayerId;
  name: string;
  rank?: number;
  connection?: ConnectionInfo;
  /** Claimed rating, used only when the host has never seen this player. */
  rating?: SkillRating;
}

export interface MatchmakingOptions {
  transport?: MatchmakingTransport;
  store?: RatingStore;
  emit?: MmEmitter;
  seed?: number;
  backfill?: BackfillPolicy;
  queue?: QueueOptions;
  /**
   * Seconds a fresh ticket waits before it will consider dropping into a match
   * already in progress. Join-in-progress is strictly better than a longer
   * queue once a live match has room, but not better than a fresh lobby.
   */
  joinInProgressAfter?: number;
}

export interface MatchResultReport {
  matchId: MatchId;
  /** Winning team index, or -1 for a draw. */
  winningTeam: number;
  durationSec: number;
  scores: Array<{ playerId: PlayerId; combatScore: number }>;
}

export class MatchmakingService {
  readonly queue: MatchQueue;
  readonly backfill: BackfillManager;
  readonly store: RatingStore;
  readonly rng: Rand;

  /** Proposals formed this tick, for callers that poll instead of listening. */
  readonly pending: MatchProposal[] = [];

  private transport: MatchmakingTransport;
  private emit: MmEmitter;
  private unsub: () => void;
  private ticketSeq = 0;
  private state: QueueState = 'idle';
  private localTicket: TicketId | null = null;
  private localPlaylist: PlaylistId | null = null;
  private mirror: Partial<MatchmakingSnapshot> = {};
  private currentRoster: MatchRoster | null = null;
  private now = 0;
  private readonly joinInProgressAfter: number;

  constructor(opts: MatchmakingOptions = {}) {
    this.transport = opts.transport ?? new LoopbackTransport();
    this.store = opts.store ?? new RatingStore();
    this.emit = opts.emit ?? (() => { });
    this.rng = new Rand(opts.seed ?? 0x5eed17);
    this.queue = new MatchQueue(this.rng, opts.queue);
    this.backfill = new BackfillManager(opts.backfill);
    this.joinInProgressAfter = opts.joinInProgressAfter ?? 8;
    this.store.setLocal(this.transport.localPlayerId);
    this.unsub = this.transport.subscribe((msg, from) => this.onMessage(msg, from));
  }

  get isHost(): boolean { return this.transport.isHost; }
  get localPlayerId(): PlayerId { return this.transport.localPlayerId; }
  get queueState(): QueueState { return this.state; }
  get roster(): MatchRoster | null { return this.currentRoster; }

  dispose(): void { this.unsub(); }

  /* ------------------------------------------------------------ requests -- */

  /**
   * Local player (and their party) want a match. On the host this enqueues
   * immediately; on a client it sends a request and returns null.
   */
  requestJoin(playlist: PlaylistId, party?: PartyMemberInput[], now = this.now): TicketId | null {
    const members = party ?? [{ playerId: this.localPlayerId, name: this.store.local().name }];
    this.localPlaylist = playlist;
    this.state = 'searching';
    if (this.isHost) {
      const ticket = this.admit(members, playlist, now);
      this.localTicket = ticket.id;
      this.publishTicket(ticket, now);
      return ticket.id;
    }
    const ticket = this.buildTicket(members, playlist, now, 'fresh');
    this.localTicket = ticket.id;
    this.transport.send({ t: 'queue:join', ticket });
    return null;
  }

  leaveQueue(): void {
    const id = this.localTicket;
    this.localTicket = null;
    this.state = 'idle';
    if (!id) return;
    if (this.isHost) this.queue.remove(id);
    else this.transport.send({ t: 'queue:leave', ticketId: id });
    this.emit('mm:queue:left', { ticketId: id, reason: 'player' });
  }

  /* ---------------------------------------------------------- host side -- */

  /** Host-only: turns a party into a queue ticket using host-side ratings. */
  admit(
    party: PartyMemberInput[],
    playlist: PlaylistId,
    now = this.now,
    kind: QueueTicket['kind'] = 'fresh',
  ): QueueTicket {
    const ticket = this.buildTicket(party, playlist, now, kind);
    this.queue.enqueue(ticket);
    return ticket;
  }

  private buildTicket(
    party: PartyMemberInput[],
    playlist: PlaylistId,
    now: number,
    kind: QueueTicket['kind'],
  ): QueueTicket {
    const members: QueueMember[] = party.map((p) => {
      const known = this.store.get(p.playerId);
      const conn = p.connection ?? defaultConnection(known?.region ?? 'na-east');
      const rec = this.store.ensure(p.playerId, p.name, conn.region, p.rank ?? 1);
      // Trust a claimed rating only for a player the host has never rated.
      if (p.rating && rec.rating.matches === 0 && !known) rec.rating = { ...p.rating };
      return {
        playerId: p.playerId,
        name: p.name || rec.name,
        rating: rec.rating,
        connection: conn,
        rank: p.rank ?? rec.rank,
      };
    });
    const skills = members.map((m) => m.rating.rating);
    return {
      id: `t:${++this.ticketSeq}`,
      partyId: `p:${members[0]?.playerId ?? 'anon'}`,
      leaderId: members[0]?.playerId ?? 'anon',
      members,
      playlist,
      kind,
      joinedAt: now,
      priority: kind === 'fresh' ? 0 : 10,
      skill: partySkill(skills),
      rd: members.reduce((a, m) => Math.max(a, m.rating.rd), 0),
    };
  }

  /* -------------------------------------------------------------- update -- */

  /** Host: run the queue. Client: refresh the local mirror's wait time. */
  update(now: number): MatchProposal[] {
    this.now = now;
    this.pending.length = 0;
    if (!this.isHost) return this.pending;

    this.backfill.sweep(now);
    this.topUpBots(now);
    this.serveBackfill(now);

    const proposals = this.queue.tick(now);
    for (const p of proposals) {
      this.pending.push(p);
      this.emit('mm:match:found', { proposal: p });
      this.emit('mm:botfill', {
        matchId: p.roster.matchId,
        added: p.quality.bots,
        humans: p.quality.humans,
        bots: p.quality.bots,
      });
      this.emit('mm:host:elected', {
        matchId: p.roster.matchId, hostId: p.roster.hostId, worstPing: p.quality.worstPing,
      });
      this.transport.send({ t: 'match:found', proposal: p });
      if (this.localTicket && p.ticketIds.includes(this.localTicket)) {
        this.state = 'found';
        this.currentRoster = p.roster;
        this.localTicket = null;
      }
    }

    if (this.localTicket) {
      const t = this.queue.get(this.localTicket);
      if (t) this.publishTicket(t, now);
    }
    return this.pending;
  }

  private publishTicket(ticket: QueueTicket, now: number): void {
    const status = this.queue.status(ticket.id, now);
    if (!status) return;
    this.emit('mm:queue:state', {
      state: this.state,
      playlist: ticket.playlist,
      waited: status.windows.waited,
      skillWindow: status.windows.skill,
      pingWindow: status.windows.ping,
      crossRegion: status.windows.crossRegion,
      botFillArmed: status.windows.botFill,
      candidates: status.candidates,
    });
    this.emit('mm:queue:estimate', { seconds: status.estimate, confident: status.estimate >= 0 });
    this.transport.send({
      t: 'ticket:update',
      ticketId: ticket.id,
      waited: status.windows.waited,
      skillWindow: status.windows.skill,
      pingWindow: status.windows.ping,
      candidates: status.candidates,
      estimate: status.estimate,
    });
  }

  /**
   * Any slot a leaver vacated becomes a bot once the grace window expires, so
   * a 6v6 never becomes a 6v4. The bot yields again the moment a human lands.
   */
  private topUpBots(now: number): void {
    for (const need of this.backfill.needs(now)) {
      const roster = this.backfill.rosterOf(need.matchId);
      if (!roster) continue;
      const def = playlistDef(roster.playlist);
      const before = roster.slots.length;
      const res = fillRoster(roster, def, this.rng, now);
      if (res.added.length === 0) continue;
      this.emit('mm:backfill:need', { matchId: need.matchId, team: need.team, count: need.count });
      this.emit('mm:botfill', {
        matchId: need.matchId,
        added: roster.slots.length - before,
        humans: roster.slots.filter((s) => s.kind === 'human').length,
        bots: roster.slots.filter((s) => s.kind === 'bot').length,
      });
      this.broadcastRoster(roster);
    }
  }

  /** Places waiting tickets into live matches that will take them. */
  private serveBackfill(now: number): void {
    if (this.backfill.size === 0) return;
    for (const ticket of this.queue.all()) {
      const waited = now - ticket.joinedAt;
      if (ticket.kind === 'fresh' && waited < this.joinInProgressAfter) continue;
      const matchId = this.backfill.findMatch(ticket, now);
      if (!matchId) continue;
      const placement = this.backfill.place(matchId, ticket, now);
      if (!placement) continue;
      this.queue.remove(ticket.id);

      const roster = this.backfill.rosterOf(matchId);
      const view = this.backfill.viewOf(matchId);
      for (const botId of placement.yieldedBots) {
        const forPlayer = placement.added[0]?.playerId ?? ticket.leaderId;
        this.emit('mm:bot:yield', {
          matchId, botId, botName: botId, forPlayer, team: placement.team,
        });
        this.transport.send({ t: 'bot:yield', matchId, botId, forPlayer });
      }
      for (const slot of placement.added) {
        this.emit('mm:backfill:joined', {
          matchId, playerId: slot.playerId, team: slot.team,
          late: !!view && view.duration > 0 && view.elapsed / view.duration > 0.35,
        });
      }
      if (roster) this.broadcastRoster(roster);
      if (this.localTicket === ticket.id) {
        this.localTicket = null;
        this.state = 'in-match';
        this.currentRoster = roster ?? null;
      }
    }
  }

  /* ------------------------------------------------------- live matches -- */

  registerMatch(roster: MatchRoster, view: LiveMatchView): void {
    this.backfill.register(roster, view);
  }

  updateMatch(view: LiveMatchView): void { this.backfill.update(view); }

  /** A human dropped. Their slot is held briefly, then filled with a bot. */
  reportPlayerLeft(matchId: MatchId, playerId: PlayerId, now = this.now): void {
    if (!this.backfill.playerLeft(matchId, playerId, now)) return;
    const roster = this.backfill.rosterOf(matchId);
    if (!roster) return;
    const rec = this.store.get(playerId);
    if (rec) rec.quits++;
    this.emit('mm:roster:update', { roster });
    this.broadcastRoster(roster);
  }

  endMatch(matchId: MatchId): MatchRoster | undefined {
    const roster = this.backfill.end(matchId);
    if (this.currentRoster?.matchId === matchId) {
      this.currentRoster = null;
      this.state = 'idle';
    }
    return roster;
  }

  /**
   * Rates a finished match. Every human is scored against each opposing slot;
   * bots contribute as RD-200 opponents so a lobby full of them still moves a
   * rating, just slowly and with little confidence gained.
   */
  submitResult(report: MatchResultReport, now = this.now): void {
    const roster = this.backfill.rosterOf(report.matchId) ?? this.currentRoster;
    if (!roster || roster.matchId !== report.matchId) return;
    const scoreOf = new Map(report.scores.map((s) => [s.playerId, s.combatScore]));
    const humans = roster.slots.filter((s): s is HumanSlot => s.kind === 'human');
    const lobbyMean = report.scores.length
      ? report.scores.reduce((a, s) => a + s.combatScore, 0) / report.scores.length
      : 1;

    for (const h of humans) {
      const rec = this.store.ensure(h.playerId, h.name, h.connection.region);
      const opponents: SkillRating[] = [];
      for (const s of roster.slots) {
        if (s.team === h.team) continue;
        opponents.push(s.kind === 'human'
          ? s.rating
          : { rating: s.rating, rd: 200, vol: 0.06, matches: 50, lastPlayed: now });
      }
      if (opponents.length === 0) {
        // Co-op: rate against the difficulty the director fielded.
        const bots = roster.slots.filter((s) => s.kind === 'bot');
        const mean = bots.length ? bots.reduce((a, s) => a + (s.kind === 'bot' ? s.rating : 0), 0) / bots.length : 1500;
        opponents.push({ rating: mean, rd: 250, vol: 0.06, matches: 30, lastPlayed: now });
      }
      const delta = applyMatch(rec, opponents, {
        won: report.winningTeam === h.team,
        drawn: report.winningTeam < 0,
        combatScore: scoreOf.get(h.playerId) ?? 0,
        lobbyMeanScore: lobbyMean,
        durationSec: report.durationSec,
      }, now);
      this.emit('mm:rating:update', {
        playerId: h.playerId, before: delta.before, after: delta.after,
        delta: delta.delta, rd: rec.rating.rd,
      });
      this.transport.send({
        t: 'rating:update', playerId: h.playerId,
        before: delta.before, after: delta.after, rd: rec.rating.rd,
      });
    }
    this.store.save();
  }

  private broadcastRoster(roster: MatchRoster): void {
    // Re-elect the host whenever the roster changes; the old one may be gone.
    const candidates: HostCandidateInfo[] = roster.slots
      .filter((s): s is HumanSlot => s.kind === 'human')
      .map((s) => ({ playerId: s.playerId, connection: s.connection }));
    if (candidates.length && !candidates.some((c) => c.playerId === roster.hostId)) {
      roster.hostId = selectHost(candidates, Math.max(0, candidates.length - 1)).hostId;
      this.emit('mm:host:elected', { matchId: roster.matchId, hostId: roster.hostId, worstPing: 0 });
    }
    this.emit('mm:roster:update', { roster });
    this.transport.send({ t: 'roster:update', roster });
  }

  /* ------------------------------------------------------------ messages -- */

  private onMessage(msg: MatchmakingMessage, from: PlayerId): void {
    switch (msg.t) {
      case 'queue:join':
        if (!this.isHost) return;
        this.admit(
          msg.ticket.members.map((m) => ({
            playerId: m.playerId, name: m.name, rank: m.rank,
            connection: m.connection, rating: m.rating,
          })),
          msg.ticket.playlist, this.now, msg.ticket.kind,
        );
        return;
      case 'queue:leave':
        if (!this.isHost) return;
        this.queue.remove(msg.ticketId);
        return;
      case 'ticket:update':
        if (this.isHost) return;
        this.mirror = {
          waited: msg.waited, skillWindow: msg.skillWindow, pingWindow: msg.pingWindow,
          candidates: msg.candidates, estimate: msg.estimate,
        };
        return;
      case 'match:found': {
        if (this.isHost) return;
        const mine = msg.proposal.roster.slots.some(
          (s) => s.kind === 'human' && s.playerId === this.localPlayerId,
        );
        if (!mine) return;
        this.currentRoster = msg.proposal.roster;
        this.state = 'found';
        this.emit('mm:match:found', { proposal: msg.proposal });
        return;
      }
      case 'roster:update':
        if (this.isHost) return;
        if (this.currentRoster?.matchId !== msg.roster.matchId) return;
        this.currentRoster = msg.roster;
        this.emit('mm:roster:update', { roster: msg.roster });
        return;
      case 'bot:yield':
        if (this.isHost) return;
        this.emit('mm:bot:yield', {
          matchId: msg.matchId, botId: msg.botId, botName: msg.botId,
          forPlayer: msg.forPlayer, team: 0,
        });
        return;
      case 'rating:update': {
        if (this.isHost) return;
        const rec = this.store.get(msg.playerId);
        if (rec) { rec.rating = { ...rec.rating, rating: msg.after, rd: msg.rd }; }
        return;
      }
      default:
        void from;
    }
  }

  /* ------------------------------------------------------------ snapshot -- */

  snapshot(): MatchmakingSnapshot {
    const local = this.store.local();
    const def = this.localPlaylist ? playlistDef(this.localPlaylist) : null;
    const status = this.isHost && this.localTicket
      ? this.queue.status(this.localTicket, this.now)
      : null;

    return {
      state: this.state,
      playlist: this.localPlaylist,
      playlistName: def?.name ?? '',
      waited: status?.windows.waited ?? this.mirror.waited ?? 0,
      skillWindow: status?.windows.skill ?? this.mirror.skillWindow ?? 0,
      pingWindow: status?.windows.ping ?? this.mirror.pingWindow ?? 0,
      crossRegion: status?.windows.crossRegion ?? false,
      botFillArmed: status?.windows.botFill ?? false,
      candidates: status?.candidates ?? this.mirror.candidates ?? 0,
      estimate: status?.estimate ?? this.mirror.estimate ?? -1,
      roster: this.currentRoster,
      quality: null,
      rating: local.rating.rating,
      rd: local.rating.rd,
      region: local.region,
      mirrored: !this.isHost,
    };
  }

  /** Roster composition, for the lobby screen and the tools. */
  composition(roster: MatchRoster): Array<{ team: number; humans: number; bots: number }> {
    const out: Array<{ team: number; humans: number; bots: number }> = [];
    for (let t = 0; t < roster.teams; t++) {
      out.push({ team: t, humans: humansOn(roster, t).length, bots: botsOn(roster, t).length });
    }
    return out;
  }
}

/** Unrated placeholder — exported so callers can build a party without a store. */
export function unratedMember(playerId: PlayerId, name: string): PartyMemberInput {
  return { playerId, name, rating: newRating() };
}
