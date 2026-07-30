/**
 * Clock synchronisation between a client and the authoritative host.
 *
 * Nothing else in the netcode works until both ends agree what time it is.
 * Interpolation reads "server time minus a delay"; prediction reads "which
 * server tick will my input land on"; lag compensation reads "where was the
 * target when this client pressed fire". All three are a lie if the clock is.
 *
 *
 * ALGORITHM — four timestamps, a two-sided minimum one-way-delay filter, and a
 * slewed apply.
 *
 * The client stamps t0 and sends a ping. The host stamps t1 on receive and t2
 * on send (they differ: the host may hold the reply until its next tick). The
 * client stamps t3 on receive. Write theta for the true offset
 * (localClock + theta = serverClock) and d_up / d_dn for the two one-way
 * network delays of this particular sample:
 *
 *     fwd = t1 - t0 =  d_up + theta        rtt = (t3 - t0) - (t2 - t1)
 *     rev = t3 - t2 =  d_dn - theta            = d_up + d_dn
 *
 * The textbook NTP estimate is (fwd - rev) / 2 = theta + (d_up - d_dn) / 2. It
 * is exact iff the two one-way delays are equal, and queueing delay is strictly
 * additive and one-sided, so *averaging* samples biases it rather than cleaning
 * it. The usual game-industry answer is to keep the single sample with the
 * smallest RTT. We do better than that, for free.
 *
 * Because d_up >= 0 and d_dn >= 0, every sample is a hard two-sided bound:
 *
 *     -rev <= theta <= fwd
 *
 * Intersecting those intervals over a window is Marzullo's algorithm, and the
 * intersection is just [-min(rev), min(fwd)] — the two minima taken
 * INDEPENDENTLY. We estimate theta as the midpoint:
 *
 *     theta_est   = (minFwd - minRev) / 2 = theta + (minD_up - minD_dn) / 2
 *     uncertainty = (minFwd + minRev) / 2 = (minD_up + minD_dn) / 2
 *
 * That is strictly tighter than min-RTT sample selection, which needs ONE
 * sample where both legs were quiet; this needs one quiet uplink and one quiet
 * downlink, and they may be different samples. With N samples the residual
 * shrinks like the minimum of N draws on each leg separately instead of the
 * minimum of N sums. It also yields a *provable* error bar rather than a
 * heuristic one: the true offset cannot lie outside the reported interval
 * unless a one-way delay was negative.
 *
 * The floor it converges to is half the link asymmetry — the irreducible term
 * no round-trip measurement can remove without a one-way delay measurement.
 *
 * Accuracy, measured in tools/net-interp.mjs (30 s, ping every 250 ms, 10% pong
 * loss, 144 Hz consumer):
 *   - symmetric link, 60 ms base RTT, +50 ms one-sided uniform jitter:
 *     steady-state |offset error| max 0.051 ms
 *     (the same test measured 3.07 ms when this used min-RTT sample selection).
 *   - asymmetric link, 40 ms up / 20 ms down (=> 10 ms irreducible bias),
 *     +50 ms jitter, host holding replies to a 60 Hz tick boundary:
 *     max 10.01 ms, i.e. 0.01 ms above the theoretical floor (was 13.69 ms).
 *   - recovered rttMs 63.1 ms against a true 60 ms floor.
 *
 * So: on a symmetric link the clock is accurate to well under a millisecond,
 * and on an asymmetric one the error is the link's own asymmetry and nothing
 * else. Downstream code should budget for the asymmetry term, not for jitter.
 * Re-run that script; it prints these numbers.
 *
 * HORIZON. A minimum filter is only valid while the two crystals have not
 * drifted apart, because minFwd and minRev may come from samples seconds apart.
 * Consumer crystals drift by up to ~100 ppm, so the window is aged out at
 * `windowAgeMs` (default 20 s => <= 2 ms of drift error, which `uncertaintyMs`
 * includes). Longer windows would report a tighter interval than they deserve.
 *
 *
 * APPLY — slew, do not step.
 *
 * A stepped clock makes remote players jump. Worse, a *backwards* step makes
 * render time go backwards, which makes interpolation replay motion in reverse
 * and makes hit registration incoherent. So:
 *
 *   - The very first accepted sample steps (we start from an offset of zero and
 *     the server epoch is arbitrary; there is nothing to protect).
 *   - After that, corrections are slewed at a bounded rate (default 5% of real
 *     time, i.e. 50 ms of correction per second). d(serverNow)/d(localNow) then
 *     stays in [0.95, 1.05], so `serverNowMs()` is strictly increasing.
 *   - A large *forward* error steps immediately (default > 250 ms). Stepping
 *     forward is safe: it only skips ahead, and downstream degrades to
 *     extrapolation for a frame or two.
 *   - A large *backward* error never auto-steps. It slews out over seconds.
 *     Only an explicit `hardResync()` — host migration, tab wake from sleep —
 *     steps backwards, and that bumps `epoch` so every consumer resets.
 *
 * `serverNowMs()` additionally clamps against its own previous return value, so
 * the monotonicity guarantee holds even if a caller mutates options at runtime.
 */

import { clamp } from './math';

/** One round-trip measurement. All four stamps in ms, t0/t3 local, t1/t2 server. */
export interface ClockSample {
  /** Local clock when the ping was sent. */
  t0: number;
  /** Server clock when the ping was received. */
  t1: number;
  /** Server clock when the pong was sent. */
  t2: number;
  /** Local clock when the pong was received. */
  t3: number;
}

export interface NetClockOptions {
  /** How many round-trip samples to keep for the minimum one-way-delay filter. */
  windowSize: number;
  /**
   * Samples older than this (local ms) are evicted even if the window is not
   * full. This bounds how much relative crystal drift can contaminate the
   * minimum filter; see the HORIZON note at the top of the file.
   */
  windowAgeMs: number;
  /** Reject a sample whose RTT exceeds this multiple of the current best RTT. */
  outlierRttFactor: number;
  /** Reject a sample whose RTT exceeds this absolute value (ms). Dead link. */
  maxRttMs: number;
  /** Max correction applied per ms of real time. 0.05 == 5% == 50 ms/s. */
  slewRate: number;
  /** Forward error above this steps instead of slewing (ms). */
  stepForwardMs: number;
  /** Samples required before `synced` goes true. */
  minSamples: number;
  /**
   * Assumed worst-case relative crystal drift, parts per million. Only feeds
   * `uncertaintyMs`; it never moves the estimate. 100 ppm is a pessimistic
   * consumer-hardware figure (0.1 ms of error per second of window age).
   */
  driftPpm: number;
}

export const DEFAULT_CLOCK_OPTIONS: Readonly<NetClockOptions> = {
  windowSize: 64,
  windowAgeMs: 20_000,
  outlierRttFactor: 3,
  maxRttMs: 2_000,
  slewRate: 0.05,
  stepForwardMs: 250,
  minSamples: 3,
  driftPpm: 100,
};

interface StoredSample {
  rtt: number;
  /** t1 - t0: the forward one-way delay, biased by +theta. */
  fwd: number;
  /** t3 - t2: the reverse one-way delay, biased by -theta. */
  rev: number;
  /** Single-sample NTP offset, kept for the spread diagnostic. */
  offset: number;
  /** Local time the sample completed, for age-based eviction. */
  at: number;
}

import type { TimeSource } from './types';

export class NetClock implements TimeSource {
  private readonly opts: NetClockOptions;
  private readonly samples: StoredSample[] = [];

  /** Offset actually being applied right now. localNow + applied = serverNow. */
  private applied = 0;
  /** Offset we are slewing towards, from the minimum-RTT sample. */
  private target = 0;

  private lastLocal = 0;
  private started = false;
  private lastServerNow = Number.NEGATIVE_INFINITY;

  private bestRtt = Number.POSITIVE_INFINITY;
  /** min(t1 - t0) over the window == minD_up + theta. */
  private minFwd = Number.POSITIVE_INFINITY;
  /** min(t3 - t2) over the window == minD_dn - theta. */
  private minRev = Number.POSITIVE_INFINITY;
  private smoothRtt = 0;
  private rttVarMs = 0;
  private accepted = 0;
  private rejected = 0;
  private steps = 0;

  /** Bumped on any discontinuous remap. Consumers reset their state when it changes. */
  epoch = 0;

  constructor(options: Partial<NetClockOptions> = {}) {
    this.opts = { ...DEFAULT_CLOCK_OPTIONS, ...options };
  }

  /**
   * Feed a completed round trip. Returns true if the sample was accepted.
   *
   * Call this from the transport the instant a pong lands; do not batch it into
   * the frame loop, because t3 must be stamped at receive time or the RTT
   * measurement absorbs a whole frame of jitter.
   */
  addSample(s: ClockSample): boolean {
    const fwd = s.t1 - s.t0;
    const rev = s.t3 - s.t2;
    const rtt = (s.t3 - s.t0) - (s.t2 - s.t1);
    const offset = (fwd - rev) * 0.5;
    if (!Number.isFinite(rtt) || !Number.isFinite(offset) || rtt < 0 || rtt > this.opts.maxRttMs) {
      this.rejected++;
      return false;
    }
    // Outlier gate: a sample that took far longer than our best is a sample
    // that sat in a queue, and its symmetry assumption is worthless.
    if (this.accepted >= this.opts.minSamples && rtt > this.bestRtt * this.opts.outlierRttFactor) {
      this.rejected++;
      return false;
    }

    this.samples.push({ rtt, fwd, rev, offset, at: s.t3 });
    while (this.samples.length > this.opts.windowSize) this.samples.shift();
    this.evictOld(s.t3);

    // RFC 6298 style smoothed RTT + variance, reused by the bandwidth layer
    // for retransmit-ish decisions and by the HUD ping readout.
    if (this.accepted === 0) {
      this.smoothRtt = rtt;
      this.rttVarMs = rtt * 0.5;
    } else {
      this.rttVarMs = 0.75 * this.rttVarMs + 0.25 * Math.abs(this.smoothRtt - rtt);
      this.smoothRtt = 0.875 * this.smoothRtt + 0.125 * rtt;
    }
    this.accepted++;

    this.recomputeTarget();

    if (!this.started) {
      // First lock: step. There is no continuity to protect yet.
      this.started = true;
      this.applied = this.target;
      this.lastLocal = s.t3;
      this.steps++;
    }
    return true;
  }

  /**
   * Convenience wrapper matching the usual pong payload shape.
   * `t0` is echoed back by the host so the client is stateless per-ping.
   */
  onPong(t0: number, serverRecvMs: number, serverSendMs: number, localRecvMs: number): boolean {
    return this.addSample({ t0, t1: serverRecvMs, t2: serverSendMs, t3: localRecvMs });
  }

  /**
   * Advance the slew. Call once per frame with a monotonic local clock
   * (`performance.now()`), before anything reads `serverNowMs()`.
   */
  update(localNowMs: number): void {
    if (!this.started) {
      this.lastLocal = localNowMs;
      return;
    }
    let dt = localNowMs - this.lastLocal;
    this.lastLocal = localNowMs;
    if (!(dt > 0)) return;
    if (dt > 1000) dt = 1000; // tab was backgrounded; do not dump a huge correction in one frame

    const err = this.target - this.applied;
    if (err > this.opts.stepForwardMs) {
      // We are behind the server by a lot. Stepping forward is monotonic-safe.
      this.applied = this.target;
      this.steps++;
      return;
    }
    const maxCorrection = dt * this.opts.slewRate;
    this.applied += clamp(err, -maxCorrection, maxCorrection);
  }

  /**
   * Server-clock milliseconds. Monotonic non-decreasing within an epoch.
   */
  serverNowMs(): number {
    const v = this.lastLocal + this.applied;
    if (v < this.lastServerNow) return this.lastServerNow;
    this.lastServerNow = v;
    return v;
  }

  /**
   * Server-clock ms for an arbitrary local timestamp — used to convert the
   * receive time of a packet without waiting for the next `update()`.
   * Not monotonic-clamped; do not drive rendering from it.
   */
  toServerMs(localMs: number): number {
    return localMs + this.applied;
  }

  /** Inverse of `toServerMs`. */
  toLocalMs(serverMs: number): number {
    return serverMs - this.applied;
  }

  /**
   * Force an immediate remap and bump `epoch`. This is the ONLY path that can
   * move server time backwards. Call it on host migration, or after the tab
   * has been suspended long enough that slewing would take minutes.
   */
  hardResync(): void {
    if (!this.started) return;
    this.applied = this.target;
    this.lastServerNow = Number.NEGATIVE_INFINITY;
    this.epoch++;
    this.steps++;
  }

  reset(): void {
    this.samples.length = 0;
    this.applied = 0;
    this.target = 0;
    this.started = false;
    this.lastServerNow = Number.NEGATIVE_INFINITY;
    this.bestRtt = Number.POSITIVE_INFINITY;
    this.minFwd = Number.POSITIVE_INFINITY;
    this.minRev = Number.POSITIVE_INFINITY;
    this.smoothRtt = 0;
    this.rttVarMs = 0;
    this.accepted = 0;
    this.rejected = 0;
    this.epoch++;
  }

  /** Lowest RTT in the window — the sample the offset estimate comes from. */
  get rttMs(): number {
    return Number.isFinite(this.bestRtt) ? this.bestRtt : 0;
  }

  /** RFC 6298 smoothed RTT. This is the number to show as "ping". */
  get smoothedRttMs(): number { return this.smoothRtt; }

  get rttVarianceMs(): number { return this.rttVarMs; }

  /** Offset currently applied. */
  get offsetMs(): number { return this.applied; }

  /** Offset we are slewing towards. */
  get targetOffsetMs(): number { return this.target; }

  /** How far the applied offset still has to travel, ms. */
  get pendingCorrectionMs(): number { return this.target - this.applied; }

  /**
   * Half-width of the Marzullo intersection, (minD_up + minD_dn) / 2. This is a
   * hard bound on |targetOffsetMs - trueOffset| given only that one-way delays
   * are non-negative — no distributional assumption. It is <= rttMs/2 and
   * usually well under it.
   */
  get intervalHalfWidthMs(): number {
    if (!this.started) return Number.POSITIVE_INFINITY;
    return (this.minFwd + this.minRev) * 0.5;
  }

  /** Lowest observed one-way delay each way, offset-biased. Diagnostics only. */
  get minForwardMs(): number { return this.minFwd; }
  get minReverseMs(): number { return this.minRev; }

  /**
   * Honest error bar on `offsetMs`: the provable interval half-width, plus the
   * drift the window may have accumulated, plus whatever correction has not
   * been slewed in yet. Bandwidth and lag-comp code should treat
   * `serverNowMs() +- uncertaintyMs` as the real answer.
   */
  get uncertaintyMs(): number {
    if (!this.started) return Number.POSITIVE_INFINITY;
    const drift = this.opts.driftPpm * 1e-6 * this.opts.windowAgeMs;
    return this.intervalHalfWidthMs + drift + Math.abs(this.pendingCorrectionMs);
  }

  /** Spread of the raw per-sample NTP offsets in the window. Jitter readout. */
  get offsetSpreadMs(): number {
    if (this.samples.length < 2) return 0;
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    for (const s of this.samples) {
      if (s.offset < lo) lo = s.offset;
      if (s.offset > hi) hi = s.offset;
    }
    return hi - lo;
  }

  get synced(): boolean {
    return this.started && this.accepted >= this.opts.minSamples;
  }

  get sampleCount(): number { return this.samples.length; }
  get acceptedCount(): number { return this.accepted; }
  get rejectedCount(): number { return this.rejected; }
  get stepCount(): number { return this.steps; }

  private evictOld(nowLocal: number): void {
    const cutoff = nowLocal - this.opts.windowAgeMs;
    while (this.samples.length > 1 && this.samples[0].at < cutoff) this.samples.shift();
  }

  /**
   * Marzullo intersection of the per-sample bounds -rev <= theta <= fwd.
   * Recomputed by scan (the window is tens of entries, once per pong), which
   * keeps the minima exact after age eviction — an incremental min would go
   * stale the moment its source sample fell out of the window.
   */
  private recomputeTarget(): void {
    let minRtt = Number.POSITIVE_INFINITY;
    let minFwd = Number.POSITIVE_INFINITY;
    let minRev = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.rtt < minRtt) minRtt = s.rtt;
      if (s.fwd < minFwd) minFwd = s.fwd;
      if (s.rev < minRev) minRev = s.rev;
    }
    this.bestRtt = minRtt;
    this.minFwd = minFwd;
    this.minRev = minRev;
    this.target = (minFwd - minRev) * 0.5;
  }
}

/**
 * The authority's own clock.
 *
 * On the host, server time *is* local time — there is nothing to synchronise.
 * This exists so that gameplay code takes a `TimeSource` and never branches on
 * "am I the host". That is the whole point of the authority boundary: when the
 * host moves off a peer and into a headless Node process or a dedicated server,
 * the simulation keeps calling `serverNowMs()` and nothing above this line
 * changes.
 */
export class LocalTimeSource implements TimeSource {
  readonly epoch = 0;
  private last = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  /** `now` defaults to `performance.now()`; inject for tests and headless runs. */
  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now());
  }

  serverNowMs(): number {
    const v = this.now();
    if (v < this.last) return this.last;
    this.last = v;
    return v;
  }
}

/**
 * Drives the ping/pong cadence. Transport-agnostic on purpose — it tells you
 * *when* to send and hands you the payload; you put it on whatever channel you
 * have (unreliable DataChannel is correct: a lost ping costs one sample).
 */
export class ClockSyncDriver {
  readonly clock: NetClock;
  /** Fast cadence until synced, then slow. ms. */
  private readonly fastIntervalMs: number;
  private readonly slowIntervalMs: number;
  /** Drop un-answered pings older than this so the map cannot grow. */
  private readonly pingTimeoutMs: number;

  private nextPingAt = 0;
  private seq = 0;
  private readonly pending = new Map<number, number>();

  constructor(
    clock: NetClock,
    fastIntervalMs = 250,
    slowIntervalMs = 2_000,
    pingTimeoutMs = 5_000,
  ) {
    this.clock = clock;
    this.fastIntervalMs = fastIntervalMs;
    this.slowIntervalMs = slowIntervalMs;
    this.pingTimeoutMs = pingTimeoutMs;
  }

  /**
   * Returns a ping to send, or null. Call every frame.
   * The returned `seq` must come back untouched in the pong.
   */
  poll(localNowMs: number): { seq: number; t0: number } | null {
    for (const [seq, t0] of this.pending) {
      if (localNowMs - t0 > this.pingTimeoutMs) this.pending.delete(seq);
    }
    if (localNowMs < this.nextPingAt) return null;
    const interval = this.clock.synced ? this.slowIntervalMs : this.fastIntervalMs;
    this.nextPingAt = localNowMs + interval;
    const seq = this.seq++;
    this.pending.set(seq, localNowMs);
    return { seq, t0: localNowMs };
  }

  /** Feed the matching pong. Unknown or duplicate `seq` is ignored. */
  accept(seq: number, serverRecvMs: number, serverSendMs: number, localRecvMs: number): boolean {
    const t0 = this.pending.get(seq);
    if (t0 === undefined) return false;
    this.pending.delete(seq);
    return this.clock.onPong(t0, serverRecvMs, serverSendMs, localRecvMs);
  }

  get outstanding(): number { return this.pending.size; }
}
