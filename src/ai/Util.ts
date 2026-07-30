/**
 * Small shared maths and pooling helpers for the AI module.
 *
 * Nothing here allocates during a frame: every function either writes into a
 * caller-owned output or uses the module-local scratch pool below.
 */

import * as THREE from 'three';
import type { RayHit } from '../physics/types';

/** A fresh, zeroed ray hit. Callers keep one and reuse it forever. */
export function makeHit(): RayHit {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity,
    surface: 'concrete',
    object: null,
    entityId: -1,
    bodyHandle: -1,
    zone: 'none',
    backface: false,
  };
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function dampVec(
  current: THREE.Vector3, target: THREE.Vector3, rate: number, dt: number,
): void {
  const k = 1 - Math.exp(-rate * dt);
  current.x += (target.x - current.x) * k;
  current.y += (target.y - current.y) * k;
  current.z += (target.z - current.z) * k;
}

/** Signed shortest angular difference, radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Turn `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

export function yawOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth 0→1 ramp between `a` and `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Linear falloff from 1 at `near` to 0 at `far`. */
export function falloff(d: number, near: number, far: number): number {
  if (d <= near) return 1;
  if (d >= far) return 0;
  return 1 - (d - near) / (far - near);
}

/**
 * Squared distance from a point to a segment, and the parameter along it.
 * Used for the bullet-vs-capsule solve and for suppression proximity tests.
 */
export function pointSegmentDistSq(
  p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out?: { t: number },
): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 1e-12 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (out) out.t = t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Closest approach between a ray and a segment (a capsule's spine).
 * Returns the squared distance; `out.t` is the distance along the ray.
 */
export function raySegmentDistSq(
  ro: THREE.Vector3, rd: THREE.Vector3, maxT: number,
  a: THREE.Vector3, b: THREE.Vector3, out: { t: number; s: number },
): number {
  const ux = rd.x, uy = rd.y, uz = rd.z;
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const wx = ro.x - a.x, wy = ro.y - a.y, wz = ro.z - a.z;
  const A = ux * ux + uy * uy + uz * uz;
  const B = ux * vx + uy * vy + uz * vz;
  const C = vx * vx + vy * vy + vz * vz;
  const D = ux * wx + uy * wy + uz * wz;
  const E = vx * wx + vy * wy + vz * wz;
  const denom = A * C - B * B;
  let t: number;
  let s: number;
  if (denom < 1e-9) {
    t = 0;
    s = C > 1e-9 ? E / C : 0;
  } else {
    t = (B * E - C * D) / denom;
    s = (A * E - B * D) / denom;
  }
  t = t < 0 ? 0 : t > maxT ? maxT : t;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const px = ro.x + ux * t, py = ro.y + uy * t, pz = ro.z + uz * t;
  const qx = a.x + vx * s, qy = a.y + vy * s, qz = a.z + vz * s;
  out.t = t; out.s = s;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** Rotates `v` around the world Y axis by `a` radians, in place. */
export function rotateY(v: THREE.Vector3, a: number): THREE.Vector3 {
  const c = Math.cos(a), s = Math.sin(a);
  const x = v.x, z = v.z;
  v.x = x * c + z * s;
  v.z = -x * s + z * c;
  return v;
}

/**
 * A tiny pool of Vector3s. AI code paths run 60+ times a second across a dozen
 * agents; allocating there is what turns a smooth frame into a GC spike.
 */
export class VecPool {
  private pool: THREE.Vector3[] = [];
  private cursor = 0;
  constructor(size: number) {
    for (let i = 0; i < size; i++) this.pool.push(new THREE.Vector3());
  }
  /** Borrow a scratch vector. Valid until `reset()`. */
  get(): THREE.Vector3 {
    const v = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    return v;
  }
  reset(): void { this.cursor = 0; }
}

/** Module-wide scratch. Never hold a reference across a function boundary. */
export const scratch = new VecPool(48);
