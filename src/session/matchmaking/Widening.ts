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
 * **Bots arming is not the same as bots filling.** This distinction is the
 * difference between a healthy playlist and one where everybody is fighting
 * robots. `botFillAfter` says bots are *permitted*; `humansRequired()` says how
 * many humans the lobby must still contain, and it starts at
 * `botFillFloor × capacity` — half a twelve-slot lobby — and decays linearly to
 * `minHumansToStart` at the hard timeout:
 *
 * ```
 *   t (s)     25    45    65    85   105   120
 *   humans     6     5     4     3     2     1     (12-slot lobby, min 1)
 * ```
 *
 * 0.5 is the measured knee of the frontier (`tools/session-mm-sweep.mjs`, 500
 * synthetic players): raising it to 0.75 buys 13 points of formation-time bot
 * share for 6 s of median queue and 20 s of p95; raising it to 1.0 buys another
 * 8 points for 10 s more. Half the lobby human at launch means every match
 * starts around a real core, and the bots completing it are handed to humans
 * within seconds — time-averaged bot *occupancy* at this setting is under 3%.
 *
 * Without this the queue launches the instant the timer arms, and a playlist
 * with a perfectly healthy population still ships 80% bot lobbies because it
 * never waits for the players who were thirty seconds away. *With* it, and with
 * the supply cap the queue applies on top (see `Queue.tryForm`), a lobby only
 * takes bots when the queue genuinely cannot deliver humans — which is exactly
 * the four-friends case, where the floor collapses to 4 immediately because
 * there is nobody else in the world to wait for.
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
  botFillFloor: 0.5,
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
  botFillFloor: 1,
  hardTimeout: 300,
};

/** Private / party lobbies: start almost immediately, bots make up the rest. */
export const PRIVATE_WIDENING: Partial<WideningParams> = {
  skillWindow0: 400,
  skillDoubleEvery: 10,
  skillWindowMax: 2000,
  botFillAfter: 6,
  botFillFloor: 0,
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
 * How many of the lobby's `capacity` slots must be filled by humans before the
 * queue is willing to launch, given the seed has waited `waited` seconds.
 *
 * Above `botFillAfter` this decays linearly from `botFillFloor × capacity` down
 * to `minHumans`, reaching it at the hard timeout. Below it the answer is
 * `capacity` — bots are not permitted at all yet, so nothing short of a full
 * lobby launches.
 *
 * This is a *demand-side* floor only. The queue caps it by what the population
 * can actually supply (`Queue.tryForm`), because waiting for humans who do not
 * exist is the other way to make a queue feel broken.
 */
export function humansRequired(
  waited: number, capacity: number, minHumans: number, p: WideningParams,
): number {
  const cap = Math.max(1, Math.floor(capacity));
  const floorMin = Math.max(1, Math.min(Math.floor(minHumans), cap));
  if (!Number.isFinite(p.botFillAfter)) return cap;
  if (waited < p.botFillAfter) return cap;
  const span = Math.max(1e-6, p.hardTimeout - p.botFillAfter);
  const u = Math.max(0, Math.min(1, (waited - p.botFillAfter) / span));
  const start = Math.max(floorMin, Math.min(cap, Math.ceil(cap * p.botFillFloor)));
  return Math.max(floorMin, Math.round(start + (floorMin - start) * u));
}

/**
 * Combines two tickets' windows into the pair's operating window.
 *
 * The two axes deliberately combine in *opposite* directions, because they
 * express opposite things:
 *
 * **Skill takes the max — fairness is negotiable.** A player who has waited
 * 90 s should be able to rescue a player who just arrived. If both sides had to
 * agree, the long-waiting ticket could never be cleared by fresh arrivals,
 * which is the classic way a queue develops a permanently stuck tail.
 *
 * **Ping and region take the min — comfort is not.** Someone who queued four
 * seconds ago should not be dragged into a 220 ms cross-region lobby because a
 * stranger has been waiting a minute and a half. Their patience is not the
 * newcomer's problem. Taking the max here was worth ~50 ms of mean lobby ping
 * in the population sim, all of it paid by the players who were *not* waiting.
 *
 * The stuck tail this could create on the latency axis is bounded by
 * `desperate`: past the hard timeout a ticket stops negotiating and the pair's
 * windows open all the way. That is the correct place for the escape hatch —
 * it is explicit, it is capped, and it applies to one ticket rather than
 * quietly degrading every match in the playlist.
 */
export function mutualWindows(a: SearchWindows, b: SearchWindows): SearchWindows {
  const desperate = a.desperate || b.desperate;
  return {
    skill: Math.max(a.skill, b.skill),
    ping: desperate ? Math.max(a.ping, b.ping) : Math.min(a.ping, b.ping),
    crossRegion: desperate ? true : a.crossRegion && b.crossRegion,
    botFill: a.botFill || b.botFill,
    desperate,
    waited: Math.max(a.waited, b.waited),
  };
}

/** Sampled curve rows — printed by `tools/session-mm.mjs` so the curve is documented by the build. */
export function describeCurve(
  p: WideningParams = DEFAULT_WIDENING,
  times: readonly number[] = [0, 5, 10, 20, 30, 45, 60, 90, 120],
  rd = 0,
  capacity = 12,
  minHumans = 1,
): Array<{ t: number; skill: number; ping: number; crossRegion: boolean; botFill: boolean; humans: number }> {
  return times.map((t) => {
    const w = windowsAt(t, rd, p);
    return {
      t,
      skill: Math.round(w.skill),
      ping: Math.round(w.ping),
      crossRegion: w.crossRegion,
      botFill: w.botFill,
      humans: humansRequired(t, capacity, minHumans, p),
    };
  });
}
