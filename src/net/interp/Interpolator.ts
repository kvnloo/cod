/**
 * Renders remote entities between the two snapshots that straddle render time.
 *
 * This is the presentation half of the netcode. It never simulates and it never
 * writes back to the network — given a `SnapshotBuffer` and a server clock it
 * produces, once per rendered frame, a transform per visible remote entity.
 * The LOCAL player must NOT go through here: the local player is predicted at
 * zero delay by the prediction module. Everything else does — remote players,
 * projectiles, doors, elevators, vehicles.
 *
 *
 * THE PLAYOUT CLOCK
 *
 *     renderTime = serverNow - delay
 *
 * `delay` is what `SnapshotBuffer.targetDelayMs` recommends, but *slewed*, never
 * stepped, at up to 25% of real time. That bound is the whole trick behind the
 * monotonicity guarantee: since |d(delay)/dt| <= 0.25, d(renderTime)/dt lies in
 * [0.75, 1.25], so render time strictly advances. It may briefly run at 0.75x
 * (reads as a barely perceptible slow-motion while the buffer deepens to absorb
 * new jitter) or 1.25x (a slight catch-up as the link calms down) but it never
 * runs backwards. Motion that runs backwards is far more visible than motion
 * that runs at 0.8x, and backwards render time also makes hit registration and
 * lag compensation incoherent.
 *
 * `renderTimeMs` is therefore guaranteed monotonic non-decreasing within an
 * epoch. `epoch` only changes on a catastrophic clock remap (host migration,
 * a suspended tab, a server whose clock is a second off what we believed) and
 * every entity reports `snapped` on that frame.
 *
 *
 * DISCONTINUITIES
 *
 * Two mechanisms, in priority order:
 *
 *   1. The server's `teleport` counter. Authoritative and exact. When it differs
 *      between the two straddling states the entity did something
 *      non-continuous, and we pick the nearer endpoint (nearest-neighbour hold)
 *      instead of gliding between them. Worst-case temporal error is half a
 *      snapshot interval and there is exactly one pop.
 *   2. A speed heuristic, for servers that do not maintain the counter: if the
 *      two states are further apart than `snapSpeedMps` could possibly cover in
 *      the span between them, treat it as a teleport. Tune `snapSpeedMps` up for
 *      fast projectiles, or better, make the host set `teleport`.
 *
 * Without this, a respawn glides a player across the entire map through walls,
 * which is both ugly and gives away spawn positions.
 *
 *
 * PATH FIDELITY
 *
 * When both endpoints carry velocity we use cubic Hermite rather than a lerp.
 * A lerp chords every curve, so a player circle-strafing at 20 Hz visibly
 * polygonises. Hermite can overshoot when endpoint velocities disagree with the
 * chord, so the result is clamped to within `hermiteBulgeM` of the linear
 * result — a cheap, provable bound that keeps the cure from becoming the
 * disease.
 */

import type { EntityState, InterpTransform, Quat, Snapshot, TimeSource, Vec3 } from './types';
import {
  DEFAULT_BUFFER_OPTIONS, SnapshotBuffer,
} from './SnapshotBuffer';
import type { SnapshotBufferOptions, SnapshotEntry } from './SnapshotBuffer';
import {
  DEFAULT_EXTRAPOLATION, DEFAULT_SMOOTHER, ErrorSmoother, extrapolate,
  makeExtrapolationResult,
} from './Extrapolate';
import type { ErrorSmootherOptions, ExtrapolationLimits, ExtrapolationResult } from './Extrapolate';
import {
  clamp, copyQuat, copyVec, distance, hermiteVec, hermiteVelocity, IDENTITY_QUAT,
  lerp, lerpVec, quat, scaleVec, setVec, slerpQuat, subVec, vec3,
} from './math';

export interface InterpolatorOptions {
  /** Hard floor on the playout delay, ms. */
  minDelayMs: number;
  /** Hard ceiling on the playout delay, ms. */
  maxDelayMs: number;
  /**
   * Max |d(delay)/dt|. 0.25 keeps render time advancing in [0.75x, 1.25x].
   * Raising this above 1.0 would let render time stall or reverse — do not.
   */
  delaySlewRate: number;
  /** Use cubic Hermite when snapshot velocities are available. */
  hermite: boolean;
  /** Max allowed deviation of the Hermite result from the linear result, m. */
  hermiteBulgeM: number;
  /** Heuristic teleport threshold: plausible top speed, m/s. */
  snapSpeedMps: number;
  /** Additive slack on the heuristic, m. */
  snapMarginM: number;
  /** Render time this far past the newest snapshot while still receiving = broken clock. */
  rebaselineAheadMs: number;
  /** Render time this far behind the oldest snapshot = broken clock. */
  rebaselineBehindMs: number;
  /** How recently a snapshot must have arrived for a rebaseline to be justified, ms. */
  freshnessMs: number;
  /** Internal dt clamp, ms. Protects against a backgrounded tab. */
  maxDtMs: number;
  extrapolation: ExtrapolationLimits;
  smoother: ErrorSmootherOptions;
  buffer: Partial<SnapshotBufferOptions>;
}

export const DEFAULT_INTERPOLATOR_OPTIONS: Readonly<InterpolatorOptions> = {
  minDelayMs: 40,
  maxDelayMs: 300,
  delaySlewRate: 0.25,
  hermite: true,
  hermiteBulgeM: 0.5,
  snapSpeedMps: 25,
  snapMarginM: 0.5,
  rebaselineAheadMs: 1_000,
  rebaselineBehindMs: 1_000,
  freshnessMs: 500,
  maxDtMs: 250,
  extrapolation: DEFAULT_EXTRAPOLATION,
  smoother: DEFAULT_SMOOTHER,
  buffer: DEFAULT_BUFFER_OPTIONS,
};

export interface InterpolatorStats {
  frames: number;
  /** Frames spent between two real snapshots. Want this to be ~everything. */
  interpolated: number;
  /** Frames dead reckoning past the newest snapshot. */
  extrapolated: number;
  /** Frames with at least one entity pinned at an extrapolation cap. */
  stalledFrames: number;
  /** Frames with nothing in the buffer at all. */
  starved: number;
  /** Frames render time fell behind the oldest held snapshot. */
  behind: number;
  /** Entity snaps emitted (teleport, respawn, spawn, un-hideable correction). */
  snaps: number;
  /** Catastrophic clock remaps. Each bumps `epoch`. */
  rebaselines: number;
}

/** Internal mutable view of the transform we hand out as readonly. */
interface MutableTransform {
  id: number;
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  scalars: Record<string, number>;
  snapped: boolean;
  fresh: boolean;
  extrapolatedMs: number;
  stalled: boolean;
  correctionM: number;
}

interface Track {
  readonly id: number;
  readonly out: MutableTransform;
  readonly smoother: ErrorSmoother;
  /** Last velocity we produced while interpolating — seeds dead reckoning. */
  readonly lastVelocity: Vec3;
  /** Target (pre-smoothing) position produced last frame. */
  readonly lastTarget: Vec3;
  /** `teleport` generation we last rendered, so a change fires exactly one snap. */
  teleportGen: number;
  wasExtrapolating: boolean;
  touchedFrame: number;
}

export class Interpolator {
  readonly buffer: SnapshotBuffer;
  private readonly opts: InterpolatorOptions;
  private readonly tracks = new Map<number, Track>();
  private readonly visible = new Map<number, InterpTransform>();

  private delay = 0;
  private delayInit = false;
  private renderTime = 0;
  private renderTimeInit = false;
  private lastServerNow = 0;
  private lastArrivalMs = Number.NEGATIVE_INFINITY;
  private frame = 0;
  private lastDtMs = 0;
  private source: TimeSource | null = null;

  /** Bumped on a catastrophic clock remap. Consumers hard-reset on change. */
  epoch = 0;
  private sourceEpoch = -1;

  readonly stats: InterpolatorStats = {
    frames: 0, interpolated: 0, extrapolated: 0, stalledFrames: 0,
    starved: 0, behind: 0, snaps: 0, rebaselines: 0,
  };

  /** Scratch — this class must not allocate in the per-frame path. */
  private readonly scratchLinear = vec3();
  private readonly scratchHermite = vec3();
  private readonly scratchTarget = vec3();
  private readonly scratchVel = vec3();
  private readonly scratchRot = quat();
  private readonly extra: ExtrapolationResult = makeExtrapolationResult();

  constructor(options: Partial<InterpolatorOptions> = {}) {
    this.opts = {
      ...DEFAULT_INTERPOLATOR_OPTIONS,
      ...options,
      extrapolation: { ...DEFAULT_EXTRAPOLATION, ...(options.extrapolation ?? {}) },
      smoother: { ...DEFAULT_SMOOTHER, ...(options.smoother ?? {}) },
      buffer: { ...DEFAULT_BUFFER_OPTIONS, ...(options.buffer ?? {}) },
    };
    this.buffer = new SnapshotBuffer({
      ...this.opts.buffer,
      minDelayMs: this.opts.minDelayMs,
      maxDelayMs: this.opts.maxDelayMs,
    });
  }

  /**
   * Hand a reconstructed snapshot to the buffer.
   * `arrivalMs` must be on the same clock later passed to `update` — use
   * `NetClock.serverNowMs()` at receive time.
   */
  push(snapshot: Snapshot, arrivalMs: number): boolean {
    const ok = this.buffer.push(snapshot, arrivalMs);
    if (ok) this.lastArrivalMs = Math.max(this.lastArrivalMs, arrivalMs);
    return ok;
  }

  /**
   * Advance one rendered frame.
   * @param serverNowMs from `TimeSource.serverNowMs()`.
   */
  update(serverNowMs: number): void {
    this.frame++;
    this.stats.frames++;

    let dt = this.renderTimeInit ? serverNowMs - this.lastServerNow : 0;
    if (!(dt > 0)) dt = 0;
    if (dt > this.opts.maxDtMs) dt = this.opts.maxDtMs;
    this.lastServerNow = serverNowMs;
    this.lastDtMs = dt;

    // ---- playout delay, slewed ------------------------------------------
    const target = clamp(this.buffer.targetDelayMs, this.opts.minDelayMs, this.opts.maxDelayMs);
    if (!this.delayInit) {
      this.delay = target;
      this.delayInit = true;
    } else {
      const maxStep = dt * this.opts.delaySlewRate;
      this.delay += clamp(target - this.delay, -maxStep, maxStep);
    }

    // ---- catastrophic clock check ---------------------------------------
    let forcedSnap = this.applyRebaseline(serverNowMs, target);

    // ---- render time -----------------------------------------------------
    let rt = serverNowMs - this.delay;
    if (this.renderTimeInit && rt < this.renderTime) rt = this.renderTime; // monotonic, always
    this.renderTime = rt;
    this.renderTimeInit = true;

    // A clock epoch change means the whole time base moved. Nothing we hold is
    // trustworthy relative to it.
    const src = this.timeSourceEpoch;
    if (src !== undefined && src !== this.sourceEpoch) {
      if (this.sourceEpoch >= 0) forcedSnap = true;
      this.sourceEpoch = src;
    }

    const sample = this.buffer.sample(rt);
    switch (sample.kind) {
      case 'empty':
        this.stats.starved++;
        this.clearVisible();
        return;
      case 'interpolate':
        this.stats.interpolated++;
        this.resolvePair(sample.from, sample.to, sample.alpha, dt, forcedSnap);
        break;
      case 'behind':
        this.stats.behind++;
        // Clock is behind the buffer. Show the oldest snapshot verbatim rather
        // than inventing a past we never received.
        this.resolvePair(sample.to, sample.to, 0, dt, forcedSnap);
        break;
      case 'extrapolate':
        this.stats.extrapolated++;
        this.resolveExtrapolated(sample.from, sample.aheadMs, dt, forcedSnap);
        break;
    }
    this.retire();
  }

  /** Optional: hook a `TimeSource` so epoch changes propagate automatically. */
  attachTimeSource(source: TimeSource | null): void {
    this.source = source;
  }

  private get timeSourceEpoch(): number | undefined {
    return this.source ? this.source.epoch : undefined;
  }

  /** Transform for one entity, or undefined if it is not currently visible. */
  get(id: number): InterpTransform | undefined {
    return this.visible.get(id);
  }

  /** All currently visible remote entities. Live view — do not retain across frames. */
  get transforms(): ReadonlyMap<number, InterpTransform> {
    return this.visible;
  }

  /** Render time being displayed, server-clock ms. Monotonic within an epoch. */
  get renderTimeMs(): number { return this.renderTime; }

  /** Playout delay currently applied, ms. */
  get delayMs(): number { return this.delay; }

  /** Delay the buffer would like, ms — what `delayMs` is slewing towards. */
  get targetDelayMs(): number {
    return clamp(this.buffer.targetDelayMs, this.opts.minDelayMs, this.opts.maxDelayMs);
  }

  /** How far render time currently sits behind the newest snapshot, ms. */
  get bufferHealthMs(): number {
    const n = this.buffer.newest;
    return n ? n.snapshot.serverTimeMs - this.renderTime : 0;
  }

  /** Full reset. Level change, host migration, disconnect. */
  reset(): void {
    this.buffer.reset();
    this.tracks.clear();
    this.visible.clear();
    this.delayInit = false;
    this.renderTimeInit = false;
    this.delay = 0;
    this.renderTime = 0;
    this.lastArrivalMs = Number.NEGATIVE_INFINITY;
    this.sourceEpoch = -1;
    this.epoch++;
  }

  // ----------------------------------------------------------------------
  // internals
  // ----------------------------------------------------------------------

  /**
   * Detect and repair a clock that is grossly wrong. Distinguishes "the clock
   * is wrong" from "the host stopped sending": if nothing has arrived recently
   * we must NOT rebaseline, because render time racing past a stale buffer is
   * the correct behaviour (entities stall, which is what the player should see).
   */
  private applyRebaseline(serverNowMs: number, targetDelay: number): boolean {
    const newest = this.buffer.newest;
    const oldest = this.buffer.oldest;
    if (!newest || !oldest) return false;
    const receiving = serverNowMs - this.lastArrivalMs < this.opts.freshnessMs;
    const rt = serverNowMs - this.delay;

    if (receiving && rt - newest.snapshot.serverTimeMs > this.opts.rebaselineAheadMs) {
      // Clock believes we are far in the future. Deepen the delay so render time
      // lands just behind the newest snapshot. This moves render time BACKWARDS,
      // so it is an epoch change by definition.
      this.delay = serverNowMs - (newest.snapshot.serverTimeMs - targetDelay * 0.5);
      this.renderTimeInit = false;
      this.epoch++;
      this.stats.rebaselines++;
      return true;
    }
    if (oldest.snapshot.serverTimeMs - rt > this.opts.rebaselineBehindMs) {
      // Clock believes we are far in the past. Jumping FORWARD is monotonic-safe
      // and needs no epoch bump, but every entity still moves discontinuously.
      this.delay = serverNowMs - oldest.snapshot.serverTimeMs;
      this.stats.rebaselines++;
      return true;
    }
    return false;
  }

  private resolvePair(
    from: SnapshotEntry, to: SnapshotEntry, alpha: number, dtMs: number, forcedSnap: boolean,
  ): void {
    const spanMs = to.snapshot.serverTimeMs - from.snapshot.serverTimeMs;
    const spanSec = Math.max(1e-4, spanMs * 0.001);
    const snapThreshold = this.opts.snapSpeedMps * spanSec + this.opts.snapMarginM;

    for (const b of to.snapshot.entities) {
      const track = this.track(b.id);
      const fresh = track.touchedFrame < 0;
      let snapped = forcedSnap || fresh;
      track.touchedFrame = this.frame;

      const a = from === to ? b : from.index.get(b.id);

      if (!a) {
        // Spawned between the two snapshots — there is no "from" to come from.
        this.adoptState(track, b);
        this.commit(track, b, true, fresh, 0, false, dtMs);
        continue;
      }

      const teleported = discontinuous(a, b, snapThreshold);
      if (teleported) {
        // Nearest-neighbour hold: stay on `a` for the first half of the span,
        // pop to `b` for the second. One pop, <= half an interval of error.
        const chosen = alpha < 0.5 ? a : b;
        const gen = chosen.teleport ?? 0;
        // Report the snap when the *rendered* position is about to jump. The
        // generation counter alone is not enough: a host that does not maintain
        // it would move the entity 47 m without ever raising `snapped`, and
        // downstream trails and ribbons would streak across the map.
        if (gen !== track.teleportGen ||
            distance(chosen.position, track.out.position) > snapThreshold) {
          snapped = true;
        }
        track.teleportGen = gen;
        this.adoptState(track, chosen);
        this.commit(track, chosen, snapped, fresh, 0, false, dtMs);
        continue;
      }
      track.teleportGen = b.teleport ?? 0;

      // ---- position -----------------------------------------------------
      const linear = lerpVec(this.scratchLinear, a.position, b.position, alpha);
      let pos = linear;
      if (this.opts.hermite && a.velocity && b.velocity) {
        const h = hermiteVec(
          this.scratchHermite, a.position, a.velocity, b.position, b.velocity, alpha, spanSec,
        );
        const bulge = distance(h, linear);
        if (bulge > this.opts.hermiteBulgeM) {
          // Pull the Hermite result back onto the safe ball around the chord.
          const k = this.opts.hermiteBulgeM / bulge;
          h.x = linear.x + (h.x - linear.x) * k;
          h.y = linear.y + (h.y - linear.y) * k;
          h.z = linear.z + (h.z - linear.z) * k;
        }
        pos = h;
        hermiteVelocity(
          this.scratchVel, a.position, a.velocity, b.position, b.velocity, alpha, spanSec,
        );
      } else if (a.velocity && b.velocity) {
        lerpVec(this.scratchVel, a.velocity, b.velocity, alpha);
      } else {
        subVec(this.scratchVel, b.position, a.position);
        scaleVec(this.scratchVel, this.scratchVel, 1 / spanSec);
      }
      copyVec(this.scratchTarget, pos);

      // ---- rotation -----------------------------------------------------
      const ra = a.rotation ?? b.rotation ?? IDENTITY_QUAT;
      const rb = b.rotation ?? ra;
      slerpQuat(this.scratchRot, ra, rb, alpha);

      // ---- error smoothing on return from extrapolation -----------------
      if (track.wasExtrapolating && !snapped) {
        if (!track.smoother.capture(track.out.position, this.scratchTarget)) snapped = true;
      }
      track.wasExtrapolating = false;

      copyVec(track.lastVelocity, this.scratchVel);
      copyVec(track.lastTarget, this.scratchTarget);

      const t = track.out;
      if (snapped) {
        track.smoother.clear();
        copyVec(t.position, this.scratchTarget);
      } else {
        track.smoother.apply(this.scratchTarget, dtMs, t.position);
      }
      copyQuat(t.rotation, this.scratchRot);
      copyVec(t.velocity, this.scratchVel);
      this.blendScalars(t.scalars, a, b, alpha);
      t.snapped = snapped;
      t.fresh = fresh;
      t.extrapolatedMs = 0;
      t.stalled = false;
      t.correctionM = track.smoother.magnitudeM;
      if (snapped) this.stats.snaps++;
      this.visible.set(t.id, t);
    }
  }

  private resolveExtrapolated(
    from: SnapshotEntry, aheadMs: number, dtMs: number, forcedSnap: boolean,
  ): void {
    let anyStalled = false;
    for (const s of from.snapshot.entities) {
      const track = this.track(s.id);
      const fresh = track.touchedFrame < 0;
      track.touchedFrame = this.frame;

      const gen = s.teleport ?? 0;
      let snapped = forcedSnap || fresh;
      if (gen !== track.teleportGen) { snapped = true; track.teleportGen = gen; }

      const seed = s.velocity ?? (fresh ? undefined : track.lastVelocity);
      extrapolate(s, aheadMs, this.opts.extrapolation, this.extra, seed);
      if (this.extra.stalled) anyStalled = true;

      const t = track.out;
      // Extrapolation is continuous with the last interpolated frame at
      // aheadMs == 0, so the smoother is applied here too and simply keeps
      // bleeding off whatever offset it already held.
      if (snapped) {
        track.smoother.clear();
        copyVec(t.position, this.extra.position);
      } else {
        track.smoother.apply(this.extra.position, dtMs, t.position);
      }
      copyQuat(t.rotation, this.extra.rotation);
      copyVec(t.velocity, this.extra.velocity);
      this.blendScalars(t.scalars, s, s, 0);
      t.snapped = snapped;
      t.fresh = fresh;
      t.extrapolatedMs = this.extra.appliedMs;
      t.stalled = this.extra.stalled;
      t.correctionM = track.smoother.magnitudeM;
      track.wasExtrapolating = true;
      if (snapped) this.stats.snaps++;
      this.visible.set(t.id, t);
    }
    if (anyStalled) this.stats.stalledFrames++;
  }

  /** First-sight initialisation so a spawn does not glide in from the origin. */
  private adoptState(track: Track, s: EntityState): void {
    track.teleportGen = s.teleport ?? 0;
    track.smoother.clear();
    track.wasExtrapolating = false;
    setVec(track.lastVelocity, 0, 0, 0);
    copyVec(track.lastTarget, s.position);
  }

  private commit(
    track: Track, s: EntityState, snapped: boolean, fresh: boolean,
    extrapolatedMs: number, stalled: boolean, _dtMs: number,
  ): void {
    const t = track.out;
    copyVec(t.position, s.position);
    copyQuat(t.rotation, s.rotation ?? IDENTITY_QUAT);
    setVec(t.velocity, 0, 0, 0);
    if (s.velocity) copyVec(t.velocity, s.velocity);
    this.blendScalars(t.scalars, s, s, 0);
    t.snapped = snapped;
    t.fresh = fresh;
    t.extrapolatedMs = extrapolatedMs;
    t.stalled = stalled;
    t.correctionM = 0;
    copyVec(track.lastTarget, s.position);
    if (snapped) this.stats.snaps++;
    this.visible.set(t.id, t);
  }

  private blendScalars(
    dst: Record<string, number>, a: EntityState, b: EntityState, alpha: number,
  ): void {
    const bs = b.scalars;
    for (const k in dst) {
      if (!bs || bs[k] === undefined) delete dst[k];
    }
    if (!bs) return;
    const as = a.scalars;
    for (const k in bs) {
      const av = as ? as[k] : undefined;
      dst[k] = av === undefined ? bs[k] : lerp(av, bs[k], alpha);
    }
  }

  private track(id: number): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        id,
        out: {
          id,
          position: vec3(),
          rotation: quat(),
          velocity: vec3(),
          scalars: {},
          snapped: true,
          fresh: true,
          extrapolatedMs: 0,
          stalled: false,
          correctionM: 0,
        },
        smoother: new ErrorSmoother(this.opts.smoother),
        lastVelocity: vec3(),
        lastTarget: vec3(),
        teleportGen: Number.NaN,
        wasExtrapolating: false,
        touchedFrame: -1,
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** Drop entities the server stopped replicating. */
  private retire(): void {
    for (const [id, track] of this.tracks) {
      if (track.touchedFrame !== this.frame) {
        this.tracks.delete(id);
        this.visible.delete(id);
      }
    }
  }

  private clearVisible(): void {
    this.visible.clear();
    this.tracks.clear();
  }
}

/**
 * True when the motion between two states cannot be continuous.
 * The server's `teleport` counter wins; the distance test is the fallback for
 * hosts that do not maintain it.
 */
function discontinuous(a: EntityState, b: EntityState, thresholdM: number): boolean {
  if (a.teleport !== undefined || b.teleport !== undefined) {
    return (a.teleport ?? 0) !== (b.teleport ?? 0);
  }
  return distance(a.position, b.position) > thresholdM;
}
