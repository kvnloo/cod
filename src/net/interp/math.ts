/**
 * Minimal allocation-free vector/quaternion helpers for the interpolation layer.
 *
 * Deliberately not `three`: this module has to run in a bare Node process for
 * the headless netcode tests, and pulling three in for four functions would
 * make that harness a build step. Everything here writes into an `out` struct
 * so the hot path never allocates — the interpolator runs over every remote
 * entity every frame.
 */

import type { Quat, Vec3 } from './types';

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

export function copyVec(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x; out.y = a.y; out.z = a.z;
  return out;
}

export function copyQuat(out: Quat, a: Quat): Quat {
  out.x = a.x; out.y = a.y; out.z = a.z; out.w = a.w;
  return out;
}

export function setVec(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x; out.y = y; out.z = z;
  return out;
}

export function addVec(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
  return out;
}

export function subVec(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
  return out;
}

export function scaleVec(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
  return out;
}

export function lengthVec(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function lerpVec(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * Cubic Hermite between two positions with their endpoint velocities.
 * `dtSec` is the time between the two samples in seconds; velocities are m/s.
 *
 * This is what makes a 20 Hz feed look like it was sampled at 200 Hz: a linear
 * lerp cuts every corner, and on a strafing player that reads as a visible
 * stutter-and-snap at every snapshot boundary.
 */
export function hermiteVec(
  out: Vec3, p0: Vec3, v0: Vec3, p1: Vec3, v1: Vec3, t: number, dtSec: number,
): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  out.x = h00 * p0.x + h10 * v0.x * dtSec + h01 * p1.x + h11 * v1.x * dtSec;
  out.y = h00 * p0.y + h10 * v0.y * dtSec + h01 * p1.y + h11 * v1.y * dtSec;
  out.z = h00 * p0.z + h10 * v0.z * dtSec + h01 * p1.z + h11 * v1.z * dtSec;
  return out;
}

/** Analytic derivative of `hermiteVec`, in m/s. */
export function hermiteVelocity(
  out: Vec3, p0: Vec3, v0: Vec3, p1: Vec3, v1: Vec3, t: number, dtSec: number,
): Vec3 {
  const t2 = t * t;
  const d00 = 6 * t2 - 6 * t;
  const d10 = 3 * t2 - 4 * t + 1;
  const d01 = -6 * t2 + 6 * t;
  const d11 = 3 * t2 - 2 * t;
  const inv = dtSec > 1e-6 ? 1 / dtSec : 0;
  out.x = (d00 * p0.x + d01 * p1.x) * inv + d10 * v0.x + d11 * v1.x;
  out.y = (d00 * p0.y + d01 * p1.y) * inv + d10 * v0.y + d11 * v1.y;
  out.z = (d00 * p0.z + d01 * p1.z) * inv + d10 * v0.z + d11 * v1.z;
  return out;
}

export function normalizeQuat(out: Quat): Quat {
  const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
  if (l > 1e-8) {
    const inv = 1 / l;
    out.x *= inv; out.y *= inv; out.z *= inv; out.w *= inv;
  } else {
    out.x = 0; out.y = 0; out.z = 0; out.w = 1;
  }
  return out;
}

/**
 * Shortest-arc spherical linear interpolation.
 *
 * The sign flip on a negative dot is not optional: without it a quaternion pair
 * that happens to straddle the double cover takes the long way round and a
 * player's torso spins 300 degrees between two snapshots.
 */
export function slerpQuat(out: Quat, a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let s0: number, s1: number;
  if (cos > 0.9995) {
    // Nearly parallel — nlerp, which is numerically safe where acos is not.
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out.x = a.x * s0 + bx * s1;
  out.y = a.y * s0 + by * s1;
  out.z = a.z * s0 + bz * s1;
  out.w = a.w * s0 + bw * s1;
  return normalizeQuat(out);
}

/** Angle between two orientations in radians, in [0, PI]. */
export function quatAngle(a: Quat, b: Quat): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential decay factor for a time constant `tauMs`. */
export function decayFactor(tauMs: number, dtMs: number): number {
  if (tauMs <= 0) return 0;
  return Math.exp(-dtMs / tauMs);
}

export const IDENTITY_QUAT: Readonly<Quat> = { x: 0, y: 0, z: 0, w: 1 };
export const ZERO_VEC: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
