/**
 * Flat pose buffers.
 *
 * A pose is 22 local rotations plus 22 local translations, stored in typed
 * arrays rather than as `Object3D` state, so blending a dozen characters across
 * six animation layers never touches the scene graph and never allocates.
 *
 * Because the rig's rest rotation is identity everywhere (see `Rig.ts`), a pose
 * is simultaneously an absolute pose *and* a delta from rest — which is what
 * makes the additive layers below one quaternion multiply with no bind-space
 * conversion.
 */

import { BONE_COUNT } from '../Rig';

const EPS = 1e-6;

export class Pose {
  /** xyzw per bone. */
  readonly rot = new Float32Array(BONE_COUNT * 4);
  /** Local translation per bone; only root/hips normally differ from rest. */
  readonly pos = new Float32Array(BONE_COUNT * 3);
  /** Per-bone authority, used when a layer only owns part of the body. */
  readonly weight = new Float32Array(BONE_COUNT);

  constructor() { this.identity(); }

  identity(): this {
    const r = this.rot;
    for (let i = 0; i < BONE_COUNT; i++) {
      r[i * 4] = 0; r[i * 4 + 1] = 0; r[i * 4 + 2] = 0; r[i * 4 + 3] = 1;
    }
    this.pos.fill(0);
    this.weight.fill(0);
    return this;
  }

  copy(o: Pose): this {
    this.rot.set(o.rot);
    this.pos.set(o.pos);
    this.weight.set(o.weight);
    return this;
  }

  setBone(i: number, x: number, y: number, z: number, w: number): void {
    this.rot[i * 4] = x; this.rot[i * 4 + 1] = y; this.rot[i * 4 + 2] = z; this.rot[i * 4 + 3] = w;
  }

  /** `this = slerp(this, other, t)` per bone, including translations. */
  blend(other: Pose, t: number): void {
    if (t <= 0) return;
    if (t >= 1) { this.copy(other); return; }
    const a = this.rot, b = other.rot;
    for (let i = 0; i < BONE_COUNT; i++) slerpInto(a, i * 4, b, i * 4, t, a, i * 4);
    const pa = this.pos, pb = other.pos;
    for (let i = 0; i < BONE_COUNT * 3; i++) pa[i] += (pb[i] - pa[i]) * t;
    const wa = this.weight, wb = other.weight;
    for (let i = 0; i < BONE_COUNT; i++) wa[i] += (wb[i] - wa[i]) * t;
  }

  /** Blends `other` in only where `mask[bone] > 0`, scaled by `t`. */
  blendMasked(other: Pose, mask: Float32Array, t: number): void {
    if (t <= 0) return;
    const a = this.rot, b = other.rot;
    for (let i = 0; i < BONE_COUNT; i++) {
      const w = mask[i] * t;
      if (w <= EPS) continue;
      slerpInto(a, i * 4, b, i * 4, Math.min(1, w), a, i * 4);
      const pi = i * 3;
      this.pos[pi] += (other.pos[pi] - this.pos[pi]) * Math.min(1, w);
      this.pos[pi + 1] += (other.pos[pi + 1] - this.pos[pi + 1]) * Math.min(1, w);
      this.pos[pi + 2] += (other.pos[pi + 2] - this.pos[pi + 2]) * Math.min(1, w);
    }
  }

  /**
   * Composes `delta` on top of this pose in local space: `out = this * delta^w`.
   * This is the additive path used by aim offsets, recoil, breathing and hits.
   */
  additive(delta: Pose, weight: number, mask?: Float32Array): void {
    if (weight <= EPS) return;
    const a = this.rot, d = delta.rot;
    for (let i = 0; i < BONE_COUNT; i++) {
      const w = (mask ? mask[i] : 1) * weight;
      if (w <= EPS) continue;
      const o = i * 4;
      // Scale the delta by w, then multiply.
      scaleInto(d, o, w, _q);
      multiplyInto(a, o, _q, 0, a, o);
    }
    const pw = weight;
    for (let i = 0; i < BONE_COUNT * 3; i++) this.pos[i] += delta.pos[i] * pw;
  }
}

/* --------------------------------------------------------------- quat maths */

const _q = new Float32Array(4);

export function slerpInto(
  a: Float32Array, ao: number, b: Float32Array, bo: number, t: number,
  out: Float32Array, oo: number,
): void {
  let ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; }
  const sign = (ax * bx + ay * by + az * bz + aw * bw) < 0 ? -1 : 1;
  let s0: number, s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t; s1 = t;
  } else {
    const theta = Math.acos(Math.min(1, cos));
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  s1 *= sign;
  ax = s0 * ax + s1 * bx;
  ay = s0 * ay + s1 * by;
  az = s0 * az + s1 * bz;
  aw = s0 * aw + s1 * bw;
  const len = Math.hypot(ax, ay, az, aw) || 1;
  out[oo] = ax / len; out[oo + 1] = ay / len; out[oo + 2] = az / len; out[oo + 3] = aw / len;
}

/** `out = a * b` (quaternion product). */
export function multiplyInto(
  a: Float32Array, ao: number, b: Float32Array, bo: number, out: Float32Array, oo: number,
): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = aw * bx + ax * bw + ay * bz - az * by;
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** `out = slerp(identity, q, t)` — a scaled rotation. */
export function scaleInto(q: Float32Array, qo: number, t: number, out: Float32Array): void {
  const w = Math.min(1, Math.max(-1, q[qo + 3]));
  const theta = Math.acos(w);
  if (theta < 1e-5) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return; }
  const sin = Math.sin(theta);
  const s = Math.sin(t * theta) / sin;
  out[0] = q[qo] * s; out[1] = q[qo + 1] * s; out[2] = q[qo + 2] * s;
  out[3] = Math.cos(t * theta);
}

/** Euler XYZ in radians, applied in YXZ order, into a quaternion slot. */
export function eulerYXZInto(x: number, y: number, z: number, out: Float32Array, oo: number): void {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  out[oo] = s1 * c2 * c3 + c1 * s2 * s3;
  out[oo + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[oo + 2] = c1 * c2 * s3 - s1 * s2 * c3;
  out[oo + 3] = c1 * c2 * c3 + s1 * s2 * s3;
}
