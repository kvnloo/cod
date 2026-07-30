/**
 * Bounded dead reckoning for when the next snapshot is late, plus the error
 * smoother that hides the correction when it finally lands.
 *
 *
 * THE RULE: EXTRAPOLATION IS A LIE WITH A DEADLINE.
 *
 * When render time runs past the newest snapshot we have no data, only a
 * velocity. Continuing that velocity forever is how you get a player sliding
 * through a wall, standing in mid-air over a stairwell, or appearing 15 m from
 * where the server says they are. So every extrapolation here is capped three
 * separate ways, and when a cap is hit the entity **stops** rather than
 * continuing to slide:
 *
 *   1. TIME  — `maxAheadMs` (default 250 ms). Past this we hold position.
 *      250 ms is roughly the point where a running player's real path and a
 *      straight-line guess diverge by more than a body width; beyond it the
 *      guess is worse than an honest freeze.
 *   2. DISTANCE — `maxDistanceM` (default 2 m). Independent of time, because a
 *      fast projectile or a vehicle blows through the time budget in 40 ms.
 *      Two metres is about one player capsule diameter: far enough to cover
 *      normal jitter, near enough that the entity cannot be through a doorway
 *      it never entered.
 *   3. SPEED — `maxSpeedMps` (default 12). Clamps a corrupt or spiking velocity
 *      before it is integrated at all.
 *
 * On top of that the reckoned velocity DECAYS exponentially (`velocityDecay`,
 * default 1.5 /s), so the entity eases to a stop instead of running into its
 * cap and stopping dead. Closed form, so it is exact at any frame rate:
 *
 *     v(t) = v0 * e^(-k t)
 *     p(t) = p0 + v0 * (1 - e^(-k t)) / k
 *
 * ROTATION IS NOT DEAD RECKONED. We do not replicate angular velocity, and
 * guessing it from two snapshots produces spinning corpses the moment a player
 * flicks their aim. Orientation holds at the last known value; a held
 * orientation is invisible for a few hundred ms, a spinning one is not.
 *
 *
 * COMING BACK — the snap-back is the visible part.
 *
 * The jump you actually see is not the extrapolation, it is the correction when
 * the real snapshot arrives and the entity teleports back onto the true path.
 * `ErrorSmoother` captures that error once, at the transition frame, and bleeds
 * it off exponentially over `tauMs` (default 110 ms). The rendered entity keeps
 * moving continuously and converges onto truth. Above `maxOffsetM` (1.2 m) the
 * error is too large to hide honestly, so we snap and let the consumer reset
 * trails and ribbons — hiding a 5 m error just produces a player who skates.
 */

import type { EntityState, Quat, Vec3 } from './types';
import {
  clamp, copyQuat, copyVec, decayFactor, lengthVec, scaleVec, setVec, subVec,
} from './math';

export interface ExtrapolationLimits {
  /** Hard cap on how far past the newest snapshot we will reckon, ms. */
  maxAheadMs: number;
  /** Hard cap on reckoned displacement, metres. */
  maxDistanceM: number;
  /** Velocity magnitude clamp before integration, m/s. */
  maxSpeedMps: number;
  /** Exponential decay rate of the reckoned velocity, 1/s. 0 disables. */
  velocityDecay: number;
}

export const DEFAULT_EXTRAPOLATION: Readonly<ExtrapolationLimits> = {
  maxAheadMs: 250,
  maxDistanceM: 2.0,
  maxSpeedMps: 12,
  velocityDecay: 1.5,
};

export interface ExtrapolationResult {
  position: Vec3;
  rotation: Quat;
  /** Current reckoned velocity (already decayed), m/s. Zero once stalled. */
  velocity: Vec3;
  /** Time actually integrated, ms. Never exceeds `maxAheadMs`. */
  appliedMs: number;
  /** Time budget was hit. */
  clampedByTime: boolean;
  /** Distance budget was hit. */
  clampedByDistance: boolean;
  /** Either cap is active: the entity is frozen, not sliding. */
  stalled: boolean;
}

export function makeExtrapolationResult(): ExtrapolationResult {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
    appliedMs: 0,
    clampedByTime: false,
    clampedByDistance: false,
    stalled: false,
  };
}

const _tmpVel: Vec3 = { x: 0, y: 0, z: 0 };
const _tmpDelta: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Dead reckon `state` forward by `aheadMs`, writing into `out`.
 * `velocity` overrides `state.velocity` when the caller has a better estimate
 * (e.g. a finite difference across the last two snapshots).
 */
export function extrapolate(
  state: EntityState,
  aheadMs: number,
  limits: ExtrapolationLimits,
  out: ExtrapolationResult,
  velocity?: Vec3,
): ExtrapolationResult {
  copyVec(out.position, state.position);
  if (state.rotation) copyQuat(out.rotation, state.rotation);
  else setQuatIdentity(out.rotation);

  const src = velocity ?? state.velocity;
  out.clampedByTime = aheadMs > limits.maxAheadMs;
  const t = clamp(aheadMs, 0, limits.maxAheadMs) * 0.001; // seconds
  out.appliedMs = t * 1000;
  out.clampedByDistance = false;
  out.stalled = out.clampedByTime;
  setVec(out.velocity, 0, 0, 0);

  if (!src || t <= 0) return out;

  // 3. Speed clamp, before anything is integrated.
  copyVec(_tmpVel, src);
  const speed = lengthVec(_tmpVel);
  if (speed > limits.maxSpeedMps && speed > 1e-6) {
    scaleVec(_tmpVel, _tmpVel, limits.maxSpeedMps / speed);
  }

  // Closed-form decayed integration.
  const k = limits.velocityDecay;
  let dist: number;
  if (k > 1e-6) {
    const e = Math.exp(-k * t);
    dist = (1 - e) / k;
    scaleVec(out.velocity, _tmpVel, e);
  } else {
    dist = t;
    copyVec(out.velocity, _tmpVel);
  }
  scaleVec(_tmpDelta, _tmpVel, dist);

  // 2. Distance clamp.
  const moved = lengthVec(_tmpDelta);
  if (moved > limits.maxDistanceM && moved > 1e-6) {
    scaleVec(_tmpDelta, _tmpDelta, limits.maxDistanceM / moved);
    out.clampedByDistance = true;
    out.stalled = true;
    setVec(out.velocity, 0, 0, 0);
  }
  if (out.clampedByTime) setVec(out.velocity, 0, 0, 0);

  out.position.x += _tmpDelta.x;
  out.position.y += _tmpDelta.y;
  out.position.z += _tmpDelta.z;
  return out;
}

function setQuatIdentity(q: Quat): void {
  q.x = 0; q.y = 0; q.z = 0; q.w = 1;
}

/**
 * Finite-difference velocity between two snapshot states, m/s.
 * Used when the server does not replicate velocity (a cheaper snapshot format,
 * which the bandwidth budget may well choose for distant entities).
 */
export function estimateVelocity(a: Vec3, b: Vec3, dtMs: number, out: Vec3): Vec3 {
  if (!(dtMs > 1e-6)) return setVec(out, 0, 0, 0);
  const inv = 1000 / dtMs;
  out.x = (b.x - a.x) * inv;
  out.y = (b.y - a.y) * inv;
  out.z = (b.z - a.z) * inv;
  return out;
}

export interface ErrorSmootherOptions {
  /** Exponential time constant for bleeding the error off, ms. */
  tauMs: number;
  /** Errors above this are snapped instead of smoothed, metres. */
  maxOffsetM: number;
  /** Below this the offset is dropped to exactly zero, metres. */
  epsilonM: number;
}

export const DEFAULT_SMOOTHER: Readonly<ErrorSmootherOptions> = {
  tauMs: 110,
  maxOffsetM: 1.2,
  epsilonM: 0.002,
};

/**
 * Bleeds a one-off positional error to zero so a correction is continuous.
 *
 * Usage is exactly two calls: `capture(renderedPrev, targetNow)` on the frame
 * the target jumps, then `apply(target, dtMs, out)` every frame after.
 */
export class ErrorSmoother {
  private readonly opts: ErrorSmootherOptions;
  private readonly offset: Vec3 = { x: 0, y: 0, z: 0 };
  private active = false;
  /** True if the last `capture` was too large to hide and was snapped instead. */
  lastCaptureSnapped = false;

  constructor(options: Partial<ErrorSmootherOptions> = {}) {
    this.opts = { ...DEFAULT_SMOOTHER, ...options };
  }

  /**
   * Record the discontinuity. Returns false when the error was too large to
   * hide — the caller must treat that as a snap (reset trails, ribbons, etc).
   */
  capture(renderedPrev: Vec3, targetNow: Vec3): boolean {
    subVec(this.offset, renderedPrev, targetNow);
    const mag = lengthVec(this.offset);
    if (mag > this.opts.maxOffsetM) {
      this.clear();
      this.lastCaptureSnapped = true;
      return false;
    }
    this.lastCaptureSnapped = false;
    this.active = mag > this.opts.epsilonM;
    if (!this.active) this.clear();
    return true;
  }

  /** Adds the (decaying) offset to `target`, writing `out`. Safe when inactive. */
  apply(target: Vec3, dtMs: number, out: Vec3): Vec3 {
    if (!this.active) return copyVec(out, target);
    const f = decayFactor(this.opts.tauMs, Math.max(0, dtMs));
    this.offset.x *= f; this.offset.y *= f; this.offset.z *= f;
    if (lengthVec(this.offset) < this.opts.epsilonM) {
      this.clear();
      return copyVec(out, target);
    }
    out.x = target.x + this.offset.x;
    out.y = target.y + this.offset.y;
    out.z = target.z + this.offset.z;
    return out;
  }

  clear(): void {
    this.offset.x = 0; this.offset.y = 0; this.offset.z = 0;
    this.active = false;
  }

  get magnitudeM(): number { return this.active ? lengthVec(this.offset) : 0; }
  get isActive(): boolean { return this.active; }
}
