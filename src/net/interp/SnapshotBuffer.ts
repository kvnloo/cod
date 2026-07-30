/**
 * A short ring of received snapshots, deliberately kept slightly in the past.
 *
 *
 * WHY DELAY AT ALL
 *
 * Snapshots arrive at the send rate (20-30 Hz) with jitter and loss. To render
 * a remote entity you need two snapshots that *straddle* the time you are
 * drawing. If you render "now" you have only the past, so you must extrapolate
 * every single frame — and extrapolation is a guess. If you render slightly in
 * the past you always have the real future sample in hand and you interpolate,
 * which is exact at the endpoints and bounded in between. Every shipped shooter
 * does this; the only question is how far back.
 *
 *
 * HOW MUCH DELAY — the number and the reasoning
 *
 *     targetDelayMs = clamp(
 *         transitMin
 *       + max(interval * 2, gapPeak + interval)
 *       + jitterPeak * 1.5,
 *       40, 300)
 *
 *   - `transitMin` — the one-way downlink delay, measured as a decaying
 *     minimum of (arrival - snapshot server time). This term is easy to forget
 *     and it matters: render time is `serverNow - delay`, but the newest
 *     snapshot in hand is already `transit` old, so the *usable* margin is
 *     `delay - transit`. Without this term a 45 ms link silently loses 45 ms of
 *     buffer and starts extrapolating. Minimum rather than mean because the
 *     variable part is jitter, and jitter is already paid for separately.
 *   - `interval * 2`, not `* 1`. One interval is the bare minimum to have a
 *     straddling pair, and it leaves zero margin: a single dropped snapshot
 *     immediately drops you into extrapolation. Two intervals makes ONE lost
 *     snapshot invisible. At 20 Hz that is 100 ms; at 30 Hz, 67 ms. Same
 *     choice as Source's default (cl_interp_ratio 2).
 *   - `gapPeak + interval` takes over when loss comes in BURSTS. `gapPeak` is a
 *     decaying maximum of the observed server-time gap between consecutive
 *     received snapshots, so three losses in a row (a 200 ms gap at 20 Hz)
 *     deepens the buffer to cover it instead of stuttering every time. On a
 *     clean link gapPeak == interval and this term is exactly `interval * 2`,
 *     so there is no cost when there is no loss.
 *   - `+ jitterPeak * 1.5` absorbs arrival jitter. `jitterPeak` is a decaying
 *     maximum of |arrival gap - server gap|, so it tracks the worst recent late
 *     arrival rather than the average — the average is not what causes a
 *     visible hitch.
 *   - Floor 40 ms: below this any real network reintroduces extrapolation.
 *   - Ceiling 300 ms: past this the *aiming* cost dominates. Interpolation
 *     delay is added latency for the shooter — you are shooting at where a
 *     player was `delay` ago, and lag compensation on the host has to rewind by
 *     exactly that much. 300 ms of rewind is already generous; more and
 *     "shot me behind cover" complaints become unfixable. A link bad enough to
 *     hit this ceiling gets visible stutter, and that is the correct outcome:
 *     the alternative is unplayable gunfights for everyone else in the match.
 *
 * The cost is honest and worth stating: this delay is added to the effective
 * end-to-end latency of every duel. It buys smoothness. It is why the LOCAL
 * player is never interpolated — the local player is predicted (that is the
 * prediction module's job) and runs at zero delay.
 *
 *
 * WHAT THIS CLASS IS NOT
 *
 * It does not decode deltas. Snapshots arrive here already reconstructed
 * against their baseline. It does not know about the transport. It holds
 * whole-world snapshots, not per-entity histories, because a snapshot is the
 * unit the server guarantees to be internally consistent — mixing entities from
 * different ticks is how you get a player standing inside a door that has not
 * opened yet.
 */

import type { EntityState, Snapshot } from './types';
import { clamp } from './math';

export interface SnapshotEntry {
  readonly snapshot: Snapshot;
  /** id -> state, built once on insert so the interpolator is O(1) per entity. */
  readonly index: ReadonlyMap<number, EntityState>;
  /** Local/monotonic ms the snapshot was handed to `push`. */
  readonly arrivalMs: number;
}

export interface SnapshotBufferOptions {
  /** Ring capacity. 32 covers 1.6 s at 20 Hz, plenty for reordering + rewind. */
  capacity: number;
  /** Multiplier on the estimated snapshot interval. 2 survives one loss. */
  interpRatio: number;
  /** Multiplier on the peak arrival jitter. */
  jitterSafety: number;
  minDelayMs: number;
  maxDelayMs: number;
  /** Fallback interval before two snapshots have been seen (20 Hz). */
  assumedIntervalMs: number;
  /** Per-sample decay of the jitter peak. 0.94 ~ a 1 s memory at 20 Hz. */
  jitterDecay: number;
  /** Per-sample decay of the loss-burst peak. 0.97 ~ a 1.7 s memory at 20 Hz. */
  gapDecay: number;
  /** Per-sample rise rate of the transit minimum, so route changes are followed. */
  transitRise: number;
}

export const DEFAULT_BUFFER_OPTIONS: Readonly<SnapshotBufferOptions> = {
  capacity: 32,
  interpRatio: 2,
  jitterSafety: 1.5,
  minDelayMs: 40,
  maxDelayMs: 300,
  assumedIntervalMs: 50,
  jitterDecay: 0.94,
  gapDecay: 0.97,
  transitRise: 0.01,
};

export type SnapshotSample =
  /** Nothing received yet. */
  | { readonly kind: 'empty' }
  /** Render time is straddled. The normal, healthy case. */
  | { readonly kind: 'interpolate'; readonly from: SnapshotEntry; readonly to: SnapshotEntry; readonly alpha: number }
  /** Render time is past the newest snapshot — the next one is late. */
  | { readonly kind: 'extrapolate'; readonly from: SnapshotEntry; readonly aheadMs: number }
  /** Render time is older than anything held — clock jumped or we stalled hard. */
  | { readonly kind: 'behind'; readonly to: SnapshotEntry; readonly behindMs: number };

export interface SnapshotBufferStats {
  /** Snapshots accepted. */
  accepted: number;
  /** Rejected as duplicate, stale, or malformed. */
  rejected: number;
  /** Accepted but arrived after a newer one — the link reordered. */
  reordered: number;
  /** Ticks missing from the sequence. Server tick gaps, i.e. real packet loss. */
  missing: number;
  /** Evicted because the ring wrapped before anyone read them. */
  evicted: number;
}

export class SnapshotBuffer {
  private readonly opts: SnapshotBufferOptions;
  /** Ascending by serverTimeMs. Small (<= capacity), so splice is cheap. */
  private readonly entries: SnapshotEntry[] = [];

  private intervalEwma = 0;
  private haveInterval = false;
  private jitterPeak = 0;
  private jitterEwma = 0;
  private gapPeak = 0;
  private transitMin = Number.POSITIVE_INFINITY;
  private lastServerTime = Number.NEGATIVE_INFINITY;
  private lastArrival = 0;
  private highestTick = Number.NEGATIVE_INFINITY;

  readonly stats: SnapshotBufferStats = {
    accepted: 0, rejected: 0, reordered: 0, missing: 0, evicted: 0,
  };

  constructor(options: Partial<SnapshotBufferOptions> = {}) {
    this.opts = { ...DEFAULT_BUFFER_OPTIONS, ...options };
    this.intervalEwma = this.opts.assumedIntervalMs;
  }

  /**
   * Insert a reconstructed snapshot.
   *
   * @param arrivalMs monotonic ms at receive. Use the SAME clock you later pass
   *   to `Interpolator.update` (i.e. `NetClock.serverNowMs()`), so the jitter
   *   estimate and the delay it produces are in the same frame of reference.
   * @returns true if accepted.
   */
  push(snapshot: Snapshot, arrivalMs: number): boolean {
    if (!Number.isFinite(snapshot.serverTimeMs) || !Number.isFinite(snapshot.tick)) {
      this.stats.rejected++;
      return false;
    }
    // Duplicate?
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].snapshot.tick === snapshot.tick) {
        this.stats.rejected++;
        return false;
      }
      // Ring is ascending; anything older than the candidate cannot match.
      if (this.entries[i].snapshot.serverTimeMs < snapshot.serverTimeMs) break;
    }
    // Too old to ever be useful again?
    if (this.entries.length >= this.opts.capacity &&
        snapshot.serverTimeMs <= this.entries[0].snapshot.serverTimeMs) {
      this.stats.rejected++;
      return false;
    }

    const index = new Map<number, EntityState>();
    for (const e of snapshot.entities) index.set(e.id, e);
    const entry: SnapshotEntry = { snapshot, index, arrivalMs };

    // Ordered insert. Almost always a push to the back.
    let at = this.entries.length;
    while (at > 0 && this.entries[at - 1].snapshot.serverTimeMs > snapshot.serverTimeMs) at--;
    if (at !== this.entries.length) this.stats.reordered++;
    this.entries.splice(at, 0, entry);

    while (this.entries.length > this.opts.capacity) {
      this.entries.shift();
      this.stats.evicted++;
    }

    this.stats.accepted++;
    this.observeTiming(snapshot, arrivalMs);
    return true;
  }

  /**
   * Timing statistics are driven only by *in-order* arrivals. A reordered
   * packet's arrival gap is meaningless as a jitter measurement (it is negative
   * against the server gap) and would poison the delay estimate.
   */
  private observeTiming(snapshot: Snapshot, arrivalMs: number): void {
    // One-way downlink transit, tracked as a decaying minimum. Negative values
    // mean the clock offset has not converged yet; clamp rather than trust them.
    const transit = Math.max(0, arrivalMs - snapshot.serverTimeMs);
    if (!Number.isFinite(this.transitMin) || transit < this.transitMin) {
      this.transitMin = transit;
    } else {
      this.transitMin += (transit - this.transitMin) * this.opts.transitRise;
    }

    if (snapshot.serverTimeMs > this.lastServerTime) {
      if (this.lastServerTime > Number.NEGATIVE_INFINITY) {
        const serverGap = snapshot.serverTimeMs - this.lastServerTime;
        const arrivalGap = arrivalMs - this.lastArrival;

        // Server gap is a multiple of the tick interval; divide out any losses
        // so a dropped snapshot does not inflate the interval estimate.
        const steps = Math.max(1, Math.round(serverGap / Math.max(1, this.intervalEwma)));
        const perStep = serverGap / steps;
        if (perStep > 0 && perStep < 1000) {
          this.intervalEwma = this.haveInterval
            ? this.intervalEwma * 0.9 + perStep * 0.1
            : perStep;
          this.haveInterval = true;
        }

        const dev = Math.abs(arrivalGap - serverGap);
        if (Number.isFinite(dev) && dev < 5000) {
          this.jitterEwma = this.jitterEwma * 0.9 + dev * 0.1;
          this.jitterPeak = Math.max(this.jitterPeak * this.opts.jitterDecay, dev);
        }
        if (serverGap > 0 && serverGap < 5000) {
          this.gapPeak = Math.max(this.gapPeak * this.opts.gapDecay, serverGap);
        }
      }
      this.lastServerTime = snapshot.serverTimeMs;
      this.lastArrival = arrivalMs;
    }
    if (this.highestTick > Number.NEGATIVE_INFINITY && snapshot.tick > this.highestTick + 1) {
      this.stats.missing += snapshot.tick - this.highestTick - 1;
    }
    if (snapshot.tick > this.highestTick) this.highestTick = snapshot.tick;
  }

  /**
   * Find the pair of snapshots that straddle `renderTimeMs`.
   * Scans from the newest end because that is where render time almost always
   * lands; the ring is <= 32 entries so worst case is trivial anyway.
   */
  sample(renderTimeMs: number): SnapshotSample {
    const n = this.entries.length;
    if (n === 0) return { kind: 'empty' };

    const newest = this.entries[n - 1];
    if (renderTimeMs >= newest.snapshot.serverTimeMs) {
      return { kind: 'extrapolate', from: newest, aheadMs: renderTimeMs - newest.snapshot.serverTimeMs };
    }
    const oldest = this.entries[0];
    if (renderTimeMs < oldest.snapshot.serverTimeMs) {
      return { kind: 'behind', to: oldest, behindMs: oldest.snapshot.serverTimeMs - renderTimeMs };
    }
    for (let i = n - 1; i > 0; i--) {
      const to = this.entries[i];
      const from = this.entries[i - 1];
      if (renderTimeMs >= from.snapshot.serverTimeMs && renderTimeMs < to.snapshot.serverTimeMs) {
        const span = to.snapshot.serverTimeMs - from.snapshot.serverTimeMs;
        const alpha = span > 1e-6 ? (renderTimeMs - from.snapshot.serverTimeMs) / span : 0;
        return { kind: 'interpolate', from, to, alpha: clamp(alpha, 0, 1) };
      }
    }
    return { kind: 'behind', to: oldest, behindMs: 0 };
  }

  /** Newest snapshot held, or null. */
  get newest(): SnapshotEntry | null {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  /** Oldest snapshot held, or null. */
  get oldest(): SnapshotEntry | null {
    return this.entries.length ? this.entries[0] : null;
  }

  get size(): number { return this.entries.length; }

  /** Server-time span currently held, ms. This is the rewind budget. */
  get spanMs(): number {
    if (this.entries.length < 2) return 0;
    return this.entries[this.entries.length - 1].snapshot.serverTimeMs - this.entries[0].snapshot.serverTimeMs;
  }

  /** Estimated server-time gap between consecutive snapshots, ms. */
  get intervalMs(): number { return this.intervalEwma; }

  /** Decaying peak arrival deviation, ms. Drives the safety margin. */
  get jitterMs(): number { return this.jitterPeak; }

  /** Mean arrival deviation, ms. The number worth showing on a net graph. */
  get meanJitterMs(): number { return this.jitterEwma; }

  /** Worst recent server-time gap between received snapshots, ms. Loss bursts. */
  get gapPeakMs(): number { return this.gapPeak; }

  /** Estimated one-way downlink transit, ms. Decaying minimum. */
  get transitMs(): number {
    return Number.isFinite(this.transitMin) ? this.transitMin : 0;
  }

  /** Recommended interpolation delay for the current link. See the file header. */
  get targetDelayMs(): number {
    const cover = Math.max(
      this.intervalEwma * this.opts.interpRatio,
      this.gapPeak + this.intervalEwma,
    );
    const raw = this.transitMs + cover + this.jitterPeak * this.opts.jitterSafety;
    return clamp(raw, this.opts.minDelayMs, this.opts.maxDelayMs);
  }

  /** Wipe everything. Used on level change, host migration and clock epoch bumps. */
  reset(): void {
    this.entries.length = 0;
    this.intervalEwma = this.opts.assumedIntervalMs;
    this.haveInterval = false;
    this.jitterPeak = 0;
    this.jitterEwma = 0;
    this.gapPeak = 0;
    this.transitMin = Number.POSITIVE_INFINITY;
    this.lastServerTime = Number.NEGATIVE_INFINITY;
    this.lastArrival = 0;
    this.highestTick = Number.NEGATIVE_INFINITY;
  }
}
