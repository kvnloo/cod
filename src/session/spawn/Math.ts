/**
 * Scalar/vector helpers used by the spawn scorer.
 *
 * Everything here is allocation-free and takes primitives: the scorer runs over
 * every candidate for every request, and a 200-point map with a 12-player
 * roster is ~2,400 distance tests per spawn. That is cheap only if it never
 * touches the allocator.
 */

import type { Vec3 } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth 0→1 ramp between `edge0` and `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Gaussian bell peaking at `centre`, ~0 beyond ~2σ. */
export function bell(x: number, centre: number, sigma: number): number {
  const d = (x - centre) / (sigma || 1e-6);
  return Math.exp(-d * d);
}

/** Horizontal (XZ) distance — vertical separation lies about how far apart two
 *  fighters really are on a multi-storey map, so combat math uses XZ + a
 *  height penalty rather than raw 3D distance. */
export function distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distXZSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Signed angle difference wrapped to [-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Yaw convention used across the codebase: `atan2(dx, dz)`, i.e. 0 looks down
 * +Z. Keep every producer and consumer of yaw on this one convention.
 */
export function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function yawForward(yaw: number, out: Vec3): Vec3 {
  out.x = Math.sin(yaw);
  out.y = 0;
  out.z = Math.cos(yaw);
  return out;
}

/**
 * Perpendicular distance from `p` to the ray `(ox,oz)` heading `yaw`, together
 * with how far along the ray the closest approach is. Used by the line-of-fire
 * veto: a point 2 m off someone's muzzle line 30 m downrange is inside a
 * firefight, even though nobody is close to it.
 *
 * Returns the perpendicular distance; writes the along-ray distance into
 * `out[0]`. Negative along-ray means the point is behind the shooter.
 */
export function rayDistanceXZ(
  ox: number, oz: number, yaw: number, px: number, pz: number, out: Float64Array,
): number {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const rx = px - ox, rz = pz - oz;
  const along = rx * dx + rz * dz;
  out[0] = along;
  const cx = rx - dx * along, cz = rz - dz * along;
  return Math.sqrt(cx * cx + cz * cz);
}

/** Slab test: does the segment a→b intersect the AABB? Used by the sim's LOS. */
export function segmentHitsBox(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let t0 = 0, t1 = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) { if (ax < minX || ax > maxX) return false; }
  else {
    let n = (minX - ax) / dx, f = (maxX - ax) / dx;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) { if (ay < minY || ay > maxY) return false; }
  else {
    let n = (minY - ay) / dy, f = (maxY - ay) / dy;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) { if (az < minZ || az > maxZ) return false; }
  else {
    let n = (minZ - az) / dz, f = (maxZ - az) / dz;
    if (n > f) { const t = n; n = f; f = t; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }
  return true;
}
