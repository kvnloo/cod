/**
 * The search-widening curve.
 *
 * This is the single most consequential knob in the whole session layer: it
 * decides whether players get *fast* matches or *fair* ones. Every shipped
 * shooter answers it the same way — start strict, relax monotonically, and
 * never make the player wait more than about two minutes for anything.
 *
 * ## Shape, and why each axis has a different one
 *
 * ```
 *   skill(t) = min(Smax, S0 · 2^(t / Hs)) + rdWeight · RD
 *   ping(t)  = min(Pmax, P0 + Rp · t)
 * ```
 *
 * **Skill widens geometrically.** Rating points are a *log-odds* quantity: the
 * win-probability cost of 75 points is the same whether you are at 1200 or
 * 1900, and going from a 75-point window to 150 costs roughly the same amount
 * of fairness as 150→300 does. Doubling is therefore the natural step, and it
 * has the property players actually notice — the queue feels like it is trying
 * harder the longer you wait, rather than crawling.
 *
 * With the defaults (S0 = 75, Hs = 25 s, Smax = 900):
 *
 * ```
 *   t (s)    0    10    20    25    50    75   100   120
 *   skill   75   112   170   150→  300   600   900   900     (+ rdWeight·RD)
 * ```
 *
 * **Ping widens linearly.** Latency is not log-odds, it is discomfort, and it
 * is felt in absolute milliseconds. Doubling a ping window from 45 ms to 90 ms
 * is survivable; doubling again to 180 ms is a different game. A linear ramp
 * (1.6 ms per second waited) reaches the 220 ms ceiling at ~110 s, by which
 * point we would rather add bots than keep looking.
 *
 * **RD is added, not multiplied.** A player we know nothing about (RD 350) gets
 * a ±350 extra window immediately, because pretending we can place them
 * precisely is a lie. As RD falls with matches played, the same player
 * naturally gets tighter lobbies. This is the reason the rating system is
 * Glicko-2 and not Elo — see `Rating.ts`.
 *
 * **Region is a gate, not a ramp.** Cross-region is either allowed or it is
 * not; a half-open region window has no meaning. It opens at 40 s, by which
 * point the ping window (≈109 ms) is wide enough for the nearest neighbouring
 * region to actually pass the pairwise test.
 *
 * **Bots arm at 25 s.** Not immediately — a real opponent found at t = 20 s is
 * worth more than an instant bot — and not late, because a lobby of four
 * friends must never sit staring at "SEARCHING" when the game can simply start.
 * Private playlists arm at 6 s because there nobody is waiting for strangers.
 *
 * **Hard timeout at 120 s.** Past it the queue launches with whatever it has,
 * subject only to `minHumansToStart`. Nothing is worse than an infinite search.
 */

import type { PlaylistDef, QueueTicket, WideningParams } from './types';

export const DEFAULT_WIDENING: WideningParams = {
  skillWindow0: 75,
  skillDoubleEvery: 25,
  skillWindowMax: 900,
  rdWeight: 1.0,
  pingWindow0: 45,
  pingWidenRate: 1.6,
  pingWindowMax: 220,
  crossRegionAfter: 40,
  botFillAfter: 25,
  hardTimeout: 120,
};

/** Ranked: fairness beats speed. Slower widening, no cross-region until late. */
export const RANKED_WIDENING: Partial<WideningParams> = {
  skillWindow0: 45,
  skillDoubleEvery: 45,
  skillWindowMax: 420,
  rdWeight: 0.6,
  pingWindow0: 40,
  pingWidenRate: 0.9,
  pingWindowMax: 140,
  crossRegionAfter: 90,
  botFillAfter: Infinity,
  hardTimeout: 300,
};

/** Private / party lobbies: start almost immediately, bots make up the rest. */
export const PRIVATE_WIDENING: Partial<WideningParams> = {
  skillWindow0: 400,
  skillDoubleEvery: 10,
  skillWindowMax: 2000,
  botFillAfter: 6,
  crossRegionAfter: 0,
  hardTimeout: 20,
};

export function wideningFor(playlist: PlaylistDef): WideningParams {
  return { ...DEFAULT_WIDENING, ...(playlist.widening ?? {}) };
}

export interface SearchWindows {
  /** Rating points of skill difference this ticket will currently accept. */
  skill: number;
  /** Milliseconds of effective RTT this ticket will currently accept. */
  ping: number;
  crossRegion: boolean;
  botFill: boolean;
  /** Past the hard timeout: launch with whatever is on the table. */
  desperate: boolean;
  /** Seconds waited, echoed for the UI. */
  waited: number;
}

/** Evaluates the curve for one ticket at time `now`. */
export function windowsAt(waited: number, rd: number, p: WideningParams): SearchWindows {
  const t = Math.max(0, waited);
  const skillBase = Math.min(p.skillWindowMax, p.skillWindow0 * Math.pow(2, t / p.skillDoubleEvery));
  return {
    skill: skillBase + p.rdWeight * rd,
    ping: Math.min(p.pingWindowMax, p.pingWindow0 + p.pingWidenRate * t),
    crossRegion: t >= p.crossRegionAfter,
    botFill: t >= p.botFillAfter,
    desperate: t >= p.hardTimeout,
    waited: t,
  };
}

export function windowsForTicket(ticket: QueueTicket, now: number, p: WideningParams): SearchWindows {
  return windowsAt(now - ticket.joinedAt, ticket.rd, p);
}

/**
 * Two tickets are compatible when *either* is willing to accept the other.
 * Taking the max rather than the min is deliberate: a player who has waited
 * 90 s should be able to rescue a player who just arrived, otherwise the
 * long-waiting ticket can never be cleared by fresh arrivals — which is the
 * classic way queues develop a permanently stuck tail.
 */
export function mutualWindows(a: SearchWindows, b: SearchWindows): SearchWindows {
  return {
    skill: Math.max(a.skill, b.skill),
    ping: Math.max(a.ping, b.ping),
    crossRegion: a.crossRegion || b.crossRegion,
    botFill: a.botFill || b.botFill,
    desperate: a.desperate || b.desperate,
    waited: Math.max(a.waited, b.waited),
  };
}

/** Sampled curve rows — printed by `tools/session-mm.mjs` so the curve is documented by the build. */
export function describeCurve(
  p: WideningParams = DEFAULT_WIDENING,
  times: readonly number[] = [0, 5, 10, 20, 30, 45, 60, 90, 120],
  rd = 0,
): Array<{ t: number; skill: number; ping: number; crossRegion: boolean; botFill: boolean }> {
  return times.map((t) => {
    const w = windowsAt(t, rd, p);
    return {
      t,
      skill: Math.round(w.skill),
      ping: Math.round(w.ping),
      crossRegion: w.crossRegion,
      botFill: w.botFill,
    };
  });
}
