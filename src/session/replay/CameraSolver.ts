/**
 * Camera solving shared by killcam, spectator and theater.
 *
 * The rule that makes a replay camera feel expensive rather than like a debug
 * fly-cam: never move the camera directly to where you want it. Move a *target*
 * there and let a critically damped spring chase it, with the damping rate
 * expressed as a half-life in seconds so it is frame-rate independent. Framing
 * is then a separate problem — decide what should be in shot, aim at it, and let
 * the spring absorb the actor's own jitter.
 *
 * Everything here is plain numbers; the bridge copies the result onto the
 * engine camera.
 */

import type { CameraPose, Vec3 } from './types';

/** Frame-rate independent exponential decay. `hl` = half-life in seconds. */
export function damp(current: number, target: number, hl: number, dt: number): number {
  if (hl <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / hl);
}

/** Same, but takes the shortest way round the circle. */
export function dampAngle(current: number, target: number, hl: number, dt: number): number {
  if (hl <= 0) return target;
  return target + shortest(current, target) * Math.pow(2, -dt / hl);
}

/** Signed shortest arc from `to` to `from`, in (-π, π]. */
export function shortest(from: number, to: number): number {
  let d = from - to;
  const twoPi = Math.PI * 2;
  d -= twoPi * Math.floor((d + Math.PI) / twoPi);
  return d;
}

/** Smoothstep, used to ease framing blends. */
export function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/* ------------------------------------------------------------------ basis -- */

export function yawPitchTo(from: Vec3, to: Vec3, out: { yaw: number; pitch: number }): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const flat = Math.sqrt(dx * dx + dz * dz);
  // Engine convention: yaw 0 looks down -Z, positive yaw turns left.
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.max(1e-5, flat));
}

export function forwardFrom(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function rightFrom(yaw: number, out: Vec3): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* ----------------------------------------------------------------- solver -- */

export interface SolverTuning {
  /** Half-life for position chase, seconds. Lower = tighter. */
  positionHalfLife: number;
  /** Half-life for look angles. */
  rotationHalfLife: number;
  /** Half-life for FOV changes. */
  fovHalfLife: number;
  /** Max metres/second the camera may travel; caps teleports on target switch. */
  maxSpeed: number;
}

export function defaultTuning(): SolverTuning {
  return { positionHalfLife: 0.11, rotationHalfLife: 0.08, fovHalfLife: 0.25, maxSpeed: 220 };
}

/**
 * Chases a desired pose. `snap()` teleports (target switch, scrub) so the
 * spring does not draw a line across the level.
 */
export class CameraSolver {
  readonly pose: CameraPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 75 };
  tuning: SolverTuning = defaultTuning();
  /** Set false for a hard cut (a new killcam, a theater scrub). */
  private primed = false;

  reset(): void { this.primed = false; }

  snap(target: CameraPose): void {
    this.pose.x = target.x; this.pose.y = target.y; this.pose.z = target.z;
    this.pose.yaw = target.yaw; this.pose.pitch = target.pitch;
    this.pose.roll = target.roll; this.pose.fov = target.fov;
    this.primed = true;
  }

  step(target: CameraPose, dt: number): CameraPose {
    if (!this.primed || dt <= 0) { this.snap(target); return this.pose; }
    const p = this.pose;
    const t = this.tuning;

    const nx = damp(p.x, target.x, t.positionHalfLife, dt);
    const ny = damp(p.y, target.y, t.positionHalfLife, dt);
    const nz = damp(p.z, target.z, t.positionHalfLife, dt);

    // Speed clamp keeps a re-targeted camera from covering the map in a frame.
    const dx = nx - p.x, dy = ny - p.y, dz = nz - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const maxD = t.maxSpeed * dt;
    if (d > maxD && d > 1e-6) {
      const s = maxD / d;
      p.x += dx * s; p.y += dy * s; p.z += dz * s;
    } else {
      p.x = nx; p.y = ny; p.z = nz;
    }

    p.yaw = dampAngle(p.yaw, target.yaw, Math.max(1e-4, t.rotationHalfLife), dt);
    p.pitch = damp(p.pitch, target.pitch, t.rotationHalfLife, dt);
    p.roll = damp(p.roll, target.roll, t.rotationHalfLife * 2, dt);
    p.fov = damp(p.fov, target.fov, t.fovHalfLife, dt);
    return p;
  }
}

/* ------------------------------------------------------------- free camera -- */

export interface FreeCamInput {
  /** [-1..1] strafe / forward. */
  moveX: number;
  moveY: number;
  /** [-1..1] down / up (crouch / jump). */
  moveUp: number;
  /** Look deltas in radians already scaled by sensitivity. */
  lookYaw: number;
  lookPitch: number;
  /** Sprint modifier. */
  boost: boolean;
  /** Slow modifier for fine framing. */
  precise: boolean;
}

export function freeCamInput(): FreeCamInput {
  return {
    moveX: 0, moveY: 0, moveUp: 0, lookYaw: 0, lookPitch: 0,
    boost: false, precise: false,
  };
}

const PITCH_LIMIT = Math.PI * 0.5 - 0.01;

/**
 * A 6-DoF fly camera with velocity smoothing. Used by spectator free-look and
 * theater. Bounds are optional; theater usually wants none, a live spectator
 * usually wants the play space.
 */
export class FreeCamera {
  readonly pose: CameraPose = { x: 0, y: 2, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 75 };
  speed = 9;
  boostScale = 3.2;
  preciseScale = 0.25;
  /** Half-life of the velocity smoothing. */
  accelHalfLife = 0.08;
  bounds: { min: Vec3; max: Vec3 } | null = null;

  private vx = 0; private vy = 0; private vz = 0;
  private readonly _f: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _r: Vec3 = { x: 0, y: 0, z: 0 };

  placeAt(p: CameraPose): void {
    this.pose.x = p.x; this.pose.y = p.y; this.pose.z = p.z;
    this.pose.yaw = p.yaw; this.pose.pitch = p.pitch;
    this.pose.roll = 0; this.pose.fov = p.fov;
    this.vx = this.vy = this.vz = 0;
  }

  step(inp: FreeCamInput, dt: number): CameraPose {
    const p = this.pose;
    p.yaw += inp.lookYaw;
    p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p.pitch + inp.lookPitch));

    forwardFrom(p.yaw, p.pitch, this._f);
    rightFrom(p.yaw, this._r);

    const s = this.speed * (inp.boost ? this.boostScale : 1) * (inp.precise ? this.preciseScale : 1);
    const tx = (this._r.x * inp.moveX + this._f.x * inp.moveY) * s;
    const ty = (this._f.y * inp.moveY) * s + inp.moveUp * s;
    const tz = (this._r.z * inp.moveX + this._f.z * inp.moveY) * s;

    this.vx = damp(this.vx, tx, this.accelHalfLife, dt);
    this.vy = damp(this.vy, ty, this.accelHalfLife, dt);
    this.vz = damp(this.vz, tz, this.accelHalfLife, dt);

    p.x += this.vx * dt;
    p.y += this.vy * dt;
    p.z += this.vz * dt;

    const b = this.bounds;
    if (b) {
      p.x = Math.max(b.min.x, Math.min(b.max.x, p.x));
      p.y = Math.max(b.min.y, Math.min(b.max.y, p.y));
      p.z = Math.max(b.min.z, Math.min(b.max.z, p.z));
    }
    return p;
  }
}

/* ----------------------------------------------------------- spline paths -- */

/**
 * Centripetal Catmull–Rom through recorded positions. Used by the final killcam
 * and by theater's saved camera paths — a spline through the snapshot track is
 * smoother than chasing it, because it can look ahead.
 */
export function catmullRom(
  p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, out: Vec3,
): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const a = -0.5 * t3 + t2 - 0.5 * t;
  const b = 1.5 * t3 - 2.5 * t2 + 1;
  const c = -1.5 * t3 + 2 * t2 + 0.5 * t;
  const d = 0.5 * t3 - 0.5 * t2;
  out.x = p0.x * a + p1.x * b + p2.x * c + p3.x * d;
  out.y = p0.y * a + p1.y * b + p2.y * c + p3.y * d;
  out.z = p0.z * a + p1.z * b + p2.z * c + p3.z * d;
  return out;
}
