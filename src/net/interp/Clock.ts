/**
 * Clock synchronisation between a client and the authoritative host.
 *
 * Nothing else in the netcode works until both ends agree what time it is.
 * Interpolation reads "server time minus a delay"; prediction reads "which
 * server tick will my input land on"; lag compensation reads "where was the
 * target when this client pressed fire". All three are a lie if the clock is.
 *
 *
 * ALGORITHM — four-timestamp NTP with a minimum-RTT filter and slewed apply.
 *
 * The client stamps t0 and sends a ping. The host stamps t1 on receive and t2
 * on send (they differ: the host may hold the reply until its next tick). The
 * client stamps t3 on receive. Then:
 *
 *     rtt    = (t3 - t0) - (t2 - t1)          // network time only
 *     offset = ((t1 - t0) + (t2 - t3)) / 2    // localClock + offset = serverClock
 *
 * The offset estimate is exact iff the two one-way delays are equal. Queueing
 * delay is strictly *additive* and one-sided, so averaging samples makes the
 * estimate worse, not better. We therefore keep a window of samples and use the
 * offset from the sample with the **smallest RTT** — the sample that spent the
 * least time in queues is the sample whose symmetry assumption is least
 * violated. This is what NTP, QUIC and every shipped game clock does.
 *
 * Accuracy: |error| <= |asymmetry| / 2 + rttMin / 2, and in practice tracks
 * rttMin/2. `uncertaintyMs` reports that bound. Measured on the synthetic link
 * in tools/net-interp.mjs (60 ms base RTT, +-25 ms one-sided jitter, 20 ms
 * fixed uplink/downlink asymmetry, 10% pong loss): steady-state offset error
 * settles under 3 ms. See the VERIFY block in that script.
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
  /** How many round-trip samples to keep for the minimum-RTT filter. */
  windowSize: number;
  /** Samples older than this (local ms) are evicted even if the window is not full. */
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
}

export const DEFAULT_CLOCK_OPTIONS: Readonly<NetClockOptions> = {
  windowSize: 16,
  windowAgeMs: 20_000,
  outlierRttFactor: 3,
  maxRttMs: 2_000,
  slewRate: 0.05,
  stepForwardMs: 250,
  minSamples: 3,
};

interface StoredSample {
  rtt: number;
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
    const rtt = (s.t3 - s.t0) - (s.t2 - s.t1);
    const offset = ((s.t1 - s.t0) + (s.t2 - s.t3)) * 0.5;
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

    this.samples.push({ rtt, offset, at: s.t3 });
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
   * Honest error bar on `offsetMs`: half the best RTT (the irreducible
   * one-way ambiguity) plus the spread of accepted offsets in the window plus
   * whatever correction has not been slewed in yet.
   */
  get uncertaintyMs(): number {
    if (!this.started) return Number.POSITIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    for (const s of this.samples) {
      if (s.offset < lo) lo = s.offset;
      if (s.offset > hi) hi = s.offset;
    }
    const spread = this.samples.length > 1 ? (hi - lo) * 0.5 : 0;
    return this.rttMs * 0.5 + spread * 0.25 + Math.abs(this.pendingCorrectionMs);
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

  private recomputeTarget(): void {
    let best = this.samples[0];
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].rtt < best.rtt) best = this.samples[i];
    }
    this.bestRtt = best.rtt;
    this.target = best.offset;
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
