/**
 * Animation primitives for the view model.
 *
 * There are no keyframe data files anywhere in this project, so every weapon
 * animation is a composition of four things: timed curves, spring-dampers,
 * value noise and additive layers. This file is all four.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';

/* ------------------------------------------------------------------ noise */

const noiseRand = new Rand('weapon-noise');
const N = 1024;
const TABLE = (() => {
  const t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = noiseRand.signed();
  return t;
})();

/** Smooth 1-D value noise in [-1, 1]. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = TABLE[((i % N) + N) % N];
  const b = TABLE[(((i + 1) % N) + N) % N];
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** Two-octave value noise — enough structure to read as breathing, not wobble. */
export function fbm1(x: number): number {
  return noise1(x) * 0.68 + noise1(x * 2.17 + 31.7) * 0.32;
}

/* ----------------------------------------------------------------- curves */

export type Key = readonly [t: number, v: number];

/**
 * Piecewise smoothstep through sorted keyframes. This is the workhorse of the
 * whole animation system: a reload is a dozen of these driving named parts.
 */
export function curve(t: number, keys: readonly Key[]): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const s = u * u * (3 - 2 * u);
      return a[1] + (b[1] - a[1]) * s;
    }
  }
  return keys[n - 1][1];
}

/** Linear variant, for things that should snap rather than ease (bolt release). */
export function curveLinear(t: number, keys: readonly Key[]): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return keys[n - 1][1];
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
}

/** Overshoot-and-settle ease, for poses that should arrive with weight. */
export function easeOutBack(t: number, overshoot = 1.42): number {
  const c = overshoot;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Damped sine impulse: 1 at t=0, ringing to 0 by t=1. */
export function ring(t: number, cycles = 2.2, decay = 5.5): number {
  if (t <= 0) return 0;
  if (t >= 1) return 0;
  return Math.sin(t * Math.PI * 2 * cycles) * Math.exp(-t * decay);
}

/* ---------------------------------------------------------------- springs */

/** Critically-dampable spring on a 3-vector. Semi-implicit, stable at 120 Hz. */
export class Spring3 {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();

  constructor(public frequency = 10, public damping = 0.7) { }

  step(target: THREE.Vector3, dt: number): THREE.Vector3 {
    const omega = 2 * Math.PI * this.frequency;
    const f = 1 + 2 * dt * this.damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    this._t.copy(target);
    this.value.set(
      (f * this.value.x + dt * this.velocity.x + hhoo * this._t.x) * det,
      (f * this.value.y + dt * this.velocity.y + hhoo * this._t.y) * det,
      (f * this.value.z + dt * this.velocity.z + hhoo * this._t.z) * det,
    );
    this.velocity.set(
      (this.velocity.x + hoo * (this._t.x - this.value.x)) * det,
      (this.velocity.y + hoo * (this._t.y - this.value.y)) * det,
      (this.velocity.z + hoo * (this._t.z - this.value.z)) * det,
    );
    return this.value;
  }

  /** Adds an instantaneous velocity impulse — how recoil enters the system. */
  impulse(x: number, y: number, z: number): void {
    this.velocity.x += x; this.velocity.y += y; this.velocity.z += z;
  }

  reset(): void { this.value.set(0, 0, 0); this.velocity.set(0, 0, 0); }
}

/** Scalar spring; same integrator. */
export class Spring1 {
  value = 0;
  velocity = 0;
  constructor(public frequency = 10, public damping = 0.7) { }

  step(target: number, dt: number): number {
    const omega = 2 * Math.PI * this.frequency;
    const f = 1 + 2 * dt * this.damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    this.value = (f * this.value + dt * this.velocity + hhoo * target) * det;
    this.velocity = (this.velocity + hoo * (target - this.value)) * det;
    return this.value;
  }

  impulse(v: number): void { this.velocity += v; }
  reset(): void { this.value = 0; this.velocity = 0; }
}

/** Frame-rate independent exponential approach. */
export function approach(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export const DEG = Math.PI / 180;
