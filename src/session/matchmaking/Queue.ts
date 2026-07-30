/**
 * The matchmaking queue.
 *
 * One pass per tick, per playlist:
 *
 *  1. Order tickets by priority (backfill first), then by age.
 *  2. Take the oldest as the **seed** and evaluate its widening curve.
 *  3. Sort every other ticket by skill distance from the seed and add them
 *     while they satisfy the *mutual* window (skill, ping to a viable host,
 *     region gate) and while the party fits in the remaining slots.
 *  4. Launch when the lobby is full, or when the seed's bot-fill timer has
 *     armed and we have the playlist's minimum humans, or when the seed has
 *     blown the hard timeout.
 *  5. Balance teams, choose the host, staff the empty slots with bots.
 *
 * Seeding on the *oldest* ticket rather than scanning for the globally best
 * lobby is what stops a queue growing a stuck tail: the longest-waiting player
 * is always the one being served, and their window is the widest, so they can
 * absorb whoever is around.
 *
 * Authority: only the host runs `tick()`. Clients mirror what it broadcasts.
 */

import type { Rand } from '../../core/Rand';
import { effectiveRtt, selectHost, pingsToHost, type HostCandidateInfo } from './Connection';
import { playlist as playlistDef, slotCount } from './Playlists';
import { balanceTeams } from './TeamBalance';
import { fillRoster } from './BotFill';
import { mutualWindows, wideningFor, windowsForTicket, type SearchWindows } from './Widening';
import type {
  HumanSlot, MatchProposal, MatchQuality, MatchRoster, PlaylistDef, PlaylistId,
  QueueTicket, RegionId, TicketId,
} from './types';

export interface QueueOptions {
  /** Bots per team ceiling — the GPU budget, not a matchmaking rule. */
  maxBotsPerTeam?: number;
  /** Matches formed per tick, per playlist. Keeps a burst from hitching. */
  maxMatchesPerTick?: number;
}

export interface TicketStatus {
  ticket: QueueTicket;
  windows: SearchWindows;
  /** Tickets that currently satisfy the mutual window. */
  candidates: number;
  /** Predicted seconds to launch, or -1 when unknown. */
  estimate: number;
}

export function ticketRegion(t: QueueTicket): RegionId {
  const leader = t.members.find((m) => m.playerId === t.leaderId) ?? t.members[0];
  return leader.connection.region;
}

export class MatchQueue {
  private tickets = new Map<TicketId, QueueTicket>();
  private byPlaylist = new Map<PlaylistId, Set<TicketId>>();
  /** EMA of ticket arrivals per second, per playlist — drives the ETA. */
  private arrivalRate = new Map<PlaylistId, number>();
  private lastArrival = new Map<PlaylistId, number>();
  private matchSeq = 0;

  constructor(private rng: Rand, private opts: QueueOptions = {}) { }

  get size(): number { return this.tickets.size; }

  get(id: TicketId): QueueTicket | undefined { return this.tickets.get(id); }

  all(): QueueTicket[] { return [...this.tickets.values()]; }

  countFor(id: PlaylistId): number { return this.byPlaylist.get(id)?.size ?? 0; }

  enqueue(ticket: QueueTicket): void {
    this.tickets.set(ticket.id, ticket);
    let set = this.byPlaylist.get(ticket.playlist);
    if (!set) { set = new Set(); this.byPlaylist.set(ticket.playlist, set); }
    set.add(ticket.id);

    const last = this.lastArrival.get(ticket.playlist);
    if (last !== undefined && ticket.joinedAt > last) {
      const gap = Math.max(0.05, ticket.joinedAt - last);
      const inst = 1 / gap;
      const prev = this.arrivalRate.get(ticket.playlist) ?? inst;
      this.arrivalRate.set(ticket.playlist, prev * 0.8 + inst * 0.2);
    }
    this.lastArrival.set(ticket.playlist, ticket.joinedAt);
  }

  remove(id: TicketId): QueueTicket | undefined {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    this.tickets.delete(id);
    this.byPlaylist.get(t.playlist)?.delete(id);
    return t;
  }

  clear(): void {
    this.tickets.clear();
    this.byPlaylist.clear();
  }

  /* ------------------------------------------------------------- status -- */

  status(id: TicketId, now: number): TicketStatus | null {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    const def = playlistDef(ticket.playlist);
    const params = wideningFor(def);
    const windows = windowsForTicket(ticket, now, params);
    const pool = this.poolFor(ticket, now, def);
    const candidates = pool.reduce((n, c) => n + c.ticket.members.length, 0);
    return { ticket, windows, candidates, estimate: this.estimate(ticket, def, windows, candidates, now) };
  }

  /**
   * Honest ETA: how long until enough compatible players have arrived, capped
   * by the moment bots arm (because that is a guaranteed launch). Returns -1
   * when there is no arrival history to extrapolate from.
   */
  private estimate(
    ticket: QueueTicket, def: PlaylistDef, w: SearchWindows, candidates: number, now: number,
  ): number {
    const capacity = slotCount(def);
    const have = ticket.members.length + candidates;
    const params = wideningFor(def);
    const botsIn = def.allowBots ? Math.max(0, params.botFillAfter - (now - ticket.joinedAt)) : Infinity;
    if (have >= capacity) return 0;
    const rate = this.arrivalRate.get(ticket.playlist) ?? 0;
    if (rate <= 0) return Number.isFinite(botsIn) ? botsIn : -1;
    // Widening means the effective rate grows as we wait; the 1.35 factor is
    // the average boost measured over the first minute of the default curve.
    const need = capacity - have;
    const eta = need / (rate * 1.35);
    return Math.min(eta, Number.isFinite(botsIn) ? botsIn : eta);
  }

  /* --------------------------------------------------------------- tick -- */

  /** Forms as many matches as it can. Returns the proposals; removes the tickets. */
  tick(now: number): MatchProposal[] {
    const out: MatchProposal[] = [];
    const limit = this.opts.maxMatchesPerTick ?? 8;
    for (const id of this.byPlaylist.keys()) {
      let formed = 0;
      while (formed < limit) {
        const proposal = this.tryForm(id, now);
        if (!proposal) break;
        out.push(proposal);
        formed++;
      }
    }
    return out;
  }

  private ordered(id: PlaylistId): QueueTicket[] {
    const set = this.byPlaylist.get(id);
    if (!set || set.size === 0) return [];
    const list: QueueTicket[] = [];
    for (const tid of set) {
      const t = this.tickets.get(tid);
      if (t) list.push(t);
    }
    list.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return a.id < b.id ? -1 : 1;
    });
    return list;
  }

  /** Candidate tickets compatible with `seed` right now, closest skill first. */
  private poolFor(seed: QueueTicket, now: number, def: PlaylistDef): Array<{ ticket: QueueTicket; windows: SearchWindows }> {
    const params = wideningFor(def);
    const seedW = windowsForTicket(seed, now, params);
    const seedRegion = ticketRegion(seed);
    const out: Array<{ ticket: QueueTicket; windows: SearchWindows; d: number }> = [];
    for (const t of this.ordered(def.id)) {
      if (t.id === seed.id) continue;
      const w = mutualWindows(seedW, windowsForTicket(t, now, params));
      if (Math.abs(t.skill - seed.skill) > w.skill) continue;
      if (!w.crossRegion && ticketRegion(t) !== seedRegion) continue;
      out.push({ ticket: t, windows: w, d: Math.abs(t.skill - seed.skill) });
    }
    out.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.ticket.joinedAt - b.ticket.joinedAt));
    return out;
  }

  private tryForm(id: PlaylistId, now: number): MatchProposal | null {
    const list = this.ordered(id);
    if (list.length === 0) return null;
    const def = playlistDef(id);
    const params = wideningFor(def);
    const capacity = slotCount(def);

    const seed = list[0];
    const seedW = windowsForTicket(seed, now, params);
    if (seed.members.length > capacity) { this.remove(seed.id); return null; }

    const group: QueueTicket[] = [seed];
    let humans = seed.members.length;
    let members: HostCandidateInfo[] = seed.members.map((m) => ({ playerId: m.playerId, connection: m.connection }));

    for (const cand of this.poolFor(seed, now, def)) {
      if (humans >= capacity) break;
      const t = cand.ticket;
      if (humans + t.members.length > capacity) continue;
      const merged = members.concat(t.members.map((m) => ({ playerId: m.playerId, connection: m.connection })));
      // A viable host must exist for the *whole* group under the ping window.
      const host = selectHost(merged, merged.length - 1);
      if (host.hostId && host.worstPing > cand.windows.ping && !cand.windows.desperate) continue;
      group.push(t);
      members = merged;
      humans += t.members.length;
    }

    const full = humans >= capacity;
    const canBotFill = def.allowBots && (seedW.botFill || seedW.desperate);
    const enoughHumans = humans >= def.minHumansToStart;
    if (!full && !(canBotFill && enoughHumans) && !(seedW.desperate && enoughHumans && !def.allowBots)) {
      return null;
    }

    for (const t of group) this.remove(t.id);
    return this.buildProposal(group, def, now, seedW);
  }

  /* -------------------------------------------------------------- build -- */

  buildProposal(group: QueueTicket[], def: PlaylistDef, now: number, seedW: SearchWindows): MatchProposal {
    const balance = balanceTeams(group, def);
    // Anything that could not be placed goes straight back in the queue.
    for (const r of balance.rejected) this.enqueue(r);
    const placed = group.filter((t) => balance.assignment.has(t.id));

    const roster: MatchRoster = {
      matchId: `m:${++this.matchSeq}`,
      playlist: def.id,
      mode: def.mode,
      teamSize: def.teamSize,
      teams: def.teams,
      slots: [],
      hostId: null,
      formedAt: now,
      seed: this.rng.u32(),
    };

    for (const t of placed) {
      const team = balance.assignment.get(t.id) ?? 0;
      for (const m of t.members) {
        const slot: HumanSlot = {
          kind: 'human',
          playerId: m.playerId,
          name: m.name,
          team,
          rating: m.rating,
          connection: m.connection,
          partyId: t.partyId,
          joinedAt: now,
          backfilled: t.kind === 'backfill',
        };
        roster.slots.push(slot);
      }
    }

    const candidates: HostCandidateInfo[] = roster.slots
      .filter((s): s is HumanSlot => s.kind === 'human')
      .map((s) => ({ playerId: s.playerId, connection: s.connection }));
    const host = selectHost(candidates, Math.max(0, candidates.length - 1));
    roster.hostId = host.hostId;

    fillRoster(roster, def, this.rng, now, { maxPerTeam: this.opts.maxBotsPerTeam });

    return {
      roster,
      quality: qualityOf(roster, now, placed.map((t) => now - t.joinedAt), seedW.waited),
      ticketIds: placed.map((t) => t.id),
    };
  }
}

/* -------------------------------------------------------------- quality -- */

export function qualityOf(
  roster: MatchRoster, _now: number, waits: number[], seedWait: number,
): MatchQuality {
  const humans = roster.slots.filter((s): s is HumanSlot => s.kind === 'human');
  const ratings = humans.map((h) => h.rating.rating);
  const bots = roster.slots.length - humans.length;

  const candidates: HostCandidateInfo[] = humans.map((h) => ({ playerId: h.playerId, connection: h.connection }));
  const pings = pingsToHost(candidates, roster.hostId);

  const teamMeans: number[] = [];
  for (let t = 0; t < roster.teams; t++) {
    const slots = roster.slots.filter((s) => s.team === t);
    teamMeans.push(slots.length ? slots.reduce((a, s) => a + (s.kind === 'human' ? s.rating.rating : s.rating), 0) / slots.length : 0);
  }

  return {
    skillSpread: ratings.length > 1 ? Math.max(...ratings) - Math.min(...ratings) : 0,
    teamDelta: roster.teams === 2 ? Math.abs(teamMeans[0] - teamMeans[1]) : 0,
    meanPing: pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : 0,
    worstPing: pings.length ? Math.max(...pings) : 0,
    humans: humans.length,
    bots,
    seedWait,
    waits: [...waits].sort((a, b) => b - a),
  };
}

/** Pairwise RTT helper re-exported for the simulation's reporting. */
export { effectiveRtt };
