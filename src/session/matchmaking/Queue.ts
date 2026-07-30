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
import { humansRequired, mutualWindows, wideningFor, windowsForTicket, type SearchWindows } from './Widening';
import type {
  ConnectionInfo, HumanSlot, MatchProposal, MatchQuality, MatchRoster, PlaylistDef,
  PlaylistId, QueueTicket, RegionId, TicketId, WideningParams,
} from './types';

export interface QueueOptions {
  /** Bots per team ceiling — the GPU budget, not a matchmaking rule. */
  maxBotsPerTeam?: number;
  /** Matches formed per tick, per playlist. Keeps a burst from hitching. */
  maxMatchesPerTick?: number;
  /**
   * Seeds examined per playlist per tick before the pass gives up. Bounds the
   * cost of the head-of-line fallback in `tick()` on a very long queue.
   */
  maxSeedsPerTick?: number;
  /**
   * Live-ops override applied on top of every playlist's widening params.
   * This is the knob you turn at 3am when a region's population collapses and
   * queue times triple; it is also what `tools/session-mm-sweep.mjs` walks to
   * plot the speed-versus-fairness frontier.
   */
  widening?: Partial<WideningParams>;
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
  return ticketConnection(t).region;
}

/** The party leader's connection stands in for the party when bucketing. */
export function ticketConnection(t: QueueTicket): ConnectionInfo {
  const leader = t.members.find((m) => m.playerId === t.leaderId) ?? t.members[0];
  return leader.connection;
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

  /** Playlist widening params with any live-ops override folded in. */
  paramsFor(def: PlaylistDef): WideningParams {
    const base = wideningFor(def);
    return this.opts.widening ? { ...base, ...this.opts.widening } : base;
  }

  /* ------------------------------------------------------------- status -- */

  status(id: TicketId, now: number): TicketStatus | null {
    const ticket = this.tickets.get(id);
    if (!ticket) return null;
    const def = playlistDef(ticket.playlist);
    const params = this.paramsFor(def);
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
    const params = this.paramsFor(def);
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

  /**
   * Forms as many matches as it can. Returns the proposals; removes the tickets.
   *
   * The oldest ticket is always tried first — it has the widest windows and the
   * strongest claim — but when it *cannot* form, the pass moves down the list
   * and tries the next one instead of abandoning the playlist for this tick.
   *
   * Skipping that fallback is a head-of-line stall, and it is subtle because it
   * only bites once the queue starts holding out for humans. One apac player at
   * the head of a queue full of eu-west players blocks every match in the
   * playlist until they hit the 120 s hard timeout, at which point they launch a
   * bot lobby and the next unlucky seed inherits the block. Measured cost in the
   * 500-player sim: median queue 75 s instead of 20 s, and a bot-fill rate that
   * stayed pinned near 45% no matter how large the population grew — the
   * giveaway, since a genuine supply problem gets better when you add players.
   */
  tick(now: number): MatchProposal[] {
    const out: MatchProposal[] = [];
    const limit = this.opts.maxMatchesPerTick ?? 8;
    const seedBudget = this.opts.maxSeedsPerTick ?? 32;
    for (const id of this.byPlaylist.keys()) {
      let formed = 0;
      let seedIndex = 0;
      let tried = 0;
      while (formed < limit && tried < seedBudget) {
        const list = this.ordered(id);
        if (seedIndex >= list.length) break;
        tried++;
        const proposal = this.tryForm(list[seedIndex], id, now);
        if (proposal) {
          out.push(proposal);
          formed++;
          // The list just changed under us; restart from the oldest.
          seedIndex = 0;
        } else {
          seedIndex++;
        }
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

  /**
   * Candidate tickets compatible with `seed` right now, best fit first.
   *
   * "Best fit" is a *normalised* blend of the two axes rather than skill alone.
   * Ordering purely on rating distance is what produced 142 ms mean lobbies in
   * the population sim: the greedy accumulator would happily reach across an
   * ocean for a player 3 rating points closer, and once eleven such players are
   * seated the host election has nothing good left to pick from. Dividing each
   * distance by the window that currently admits it makes them comparable —
   * "how much of my skill budget does this cost" versus "how much of my latency
   * budget" — so a marginally worse skill fit next door beats a perfect one
   * three regions away, which is the trade a player would make themselves.
   */
  private poolFor(seed: QueueTicket, now: number, def: PlaylistDef): Array<{ ticket: QueueTicket; windows: SearchWindows }> {
    const params = this.paramsFor(def);
    const seedW = windowsForTicket(seed, now, params);
    const seedRegion = ticketRegion(seed);
    const seedConn = ticketConnection(seed);
    const out: Array<{ ticket: QueueTicket; windows: SearchWindows; cost: number }> = [];
    for (const t of this.ordered(def.id)) {
      if (t.id === seed.id) continue;
      const w = mutualWindows(seedW, windowsForTicket(t, now, params));
      const dSkill = Math.abs(t.skill - seed.skill);
      if (dSkill > w.skill) continue;
      if (!w.crossRegion && ticketRegion(t) !== seedRegion) continue;
      // Pairwise RTT is a proxy for "will this player be happy behind whatever
      // host we end up electing". It is not the admission test — that is the
      // host-viability check in `tryForm`, which knows the real topology — but
      // it is the right thing to *rank* on.
      const dPing = effectiveRtt(ticketConnection(t), seedConn);
      const cost = dSkill / Math.max(1, w.skill) + dPing / Math.max(1, w.ping);
      out.push({ ticket: t, windows: w, cost });
    }
    out.sort((a, b) => (a.cost !== b.cost ? a.cost - b.cost : a.ticket.joinedAt - b.ticket.joinedAt));
    return out;
  }

  /**
   * Ticket arrivals per second, aged. The raw EMA only moves when a ticket
   * arrives, so a playlist that has gone quiet keeps reporting the rate it had
   * before everyone left — and the launch gate below would then hold a lobby
   * open waiting for humans who are not coming. Dividing by the drought length
   * makes "nobody has queued for 30 s" read as the near-zero supply it is.
   */
  private arrivalsPerSecond(id: PlaylistId, now: number): number {
    const raw = this.arrivalRate.get(id) ?? 0;
    if (raw <= 0) return 0;
    const last = this.lastArrival.get(id);
    if (last === undefined) return 0;
    const quiet = Math.max(0, now - last);
    return raw / (1 + quiet / 10);
  }

  /** Mean party size currently queued for a playlist, floored at 1. */
  private meanPartySize(id: PlaylistId): number {
    const set = this.byPlaylist.get(id);
    if (!set || set.size === 0) return 1;
    let n = 0;
    for (const tid of set) n += this.tickets.get(tid)?.members.length ?? 0;
    return Math.max(1, n / set.size);
  }

  private tryForm(seed: QueueTicket | undefined, id: PlaylistId, now: number): MatchProposal | null {
    if (!seed) return null;
    const def = playlistDef(id);
    const params = this.paramsFor(def);
    const capacity = slotCount(def);

    const seedW = windowsForTicket(seed, now, params);
    if (seed.members.length > capacity) { this.remove(seed.id); return null; }

    // Remaining seats per team. Parties are never split, so a candidate is only
    // addable if it fits *inside one team* — checking only the lobby total lets
    // the accumulator build groups like 5+4+3 for a 6v6, which no assignment
    // can pack. Those extra players are then rejected by `balanceTeams` and
    // silently replaced by bots, which is how a lobby the gate approved with
    // twelve humans reaches the map with nine.
    const bins = new Array<number>(def.teams).fill(def.teamSize);
    if (!seatParty(bins, seed.members.length)) { this.remove(seed.id); return null; }

    const group: QueueTicket[] = [seed];
    let humans = seed.members.length;
    let members: HostCandidateInfo[] = seed.members.map((m) => ({ playerId: m.playerId, connection: m.connection }));

    for (const cand of this.poolFor(seed, now, def)) {
      if (humans >= capacity) break;
      const t = cand.ticket;
      const size = t.members.length;
      if (!bins.some((b) => b >= size)) continue;
      const merged = members.concat(t.members.map((m) => ({ playerId: m.playerId, connection: m.connection })));
      // A viable host must exist for the *whole* group under the ping window.
      const host = selectHost(merged, merged.length - 1);
      if (host.hostId && host.worstPing > cand.windows.ping && !cand.windows.desperate) continue;
      if (!seatParty(bins, size)) continue;
      group.push(t);
      members = merged;
      humans += size;
    }

    const full = humans >= capacity;
    const canBotFill = def.allowBots && (seedW.botFill || seedW.desperate);

    // How many humans the curve *wants* before it will accept bots...
    const demand = humansRequired(seedW.waited, capacity, def.minHumansToStart, params);
    // ...capped by how many the population can plausibly still deliver before
    // this seed times out. Four friends alone in a playlist must not be held
    // hostage to a floor of nine; a busy playlist must not launch at four just
    // because the timer said it could.
    const remaining = Math.max(0, params.hardTimeout - seedW.waited);
    const inbound = this.arrivalsPerSecond(def.id, now) * this.meanPartySize(def.id) * remaining;
    const supply = Math.min(capacity, Math.floor(humans + inbound));
    const need = Math.max(def.minHumansToStart, Math.min(demand, supply));

    const ready = canBotFill && humans >= need;
    const forced = seedW.desperate && humans >= def.minHumansToStart;
    if (!full && !ready && !forced) return null;

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

/**
 * Seats a party of `size` in the emptiest team that can hold it, mutating
 * `bins`. Returns false when no team has room. Emptiest-first mirrors
 * `balanceTeams`, so the packing the accumulator assumes is the packing the
 * assignment step actually finds.
 */
function seatParty(bins: number[], size: number): boolean {
  let best = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] < size) continue;
    if (best < 0 || bins[i] > bins[best]) best = i;
  }
  if (best < 0) return false;
  bins[best] -= size;
  return true;
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
