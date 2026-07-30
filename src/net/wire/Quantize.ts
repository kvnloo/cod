/**
 * Quantize — lossy-but-*bounded* numeric encoders.
 *
 * Pure arithmetic: no bitstream knowledge lives here, so the error bounds below
 * can be reasoned about and unit-tested independently of the packet format.
 *
 * ## The contract
 *
 * Every encoder states a maximum absolute error. Encoding is `round`-to-nearest
 * over a uniform grid, so the error is at most half a step, always, for every
 * input inside the range. Inputs outside the range are clamped (positions
 * outside the world bound are a bug elsewhere, not something to silently wrap).
 *
 * A {@link Range} uses `2^bits - 1` intervals rather than `2^bits`, so both
 * endpoints are exactly representable. That matters for normalised values:
 * `unorm(8)` must be able to say exactly 0 and exactly 1.
 *
 * ## Shipped precision (defaults, all worst-case)
 *
 * | Quantity                | Range          | Bits | Step      | Max error   |
 * |-------------------------|----------------|------|-----------|-------------|
 * | Position X / Z          | ±512 m         | 17   | 7.813 mm  | **0.391 cm**|
 * | Position Y              | −64 … +448 m   | 16   | 7.813 mm  | **0.391 cm**|
 * | Velocity axis           | ±64 m/s        | 13   | 15.63 mm/s| 0.781 cm/s  |
 * | View angle (precise)    | 2π             | 16   | 0.00549°  | **0.00275°**|
 * | View angle (coarse)     | 2π             | 12   | 0.0879°   | 0.0439°     |
 * | Rotation (smallest-3)   | unit quat      | 32   | —         | **≤ 0.28°** |
 * | Normalised 0..1         | 0…1            | 8    | 0.00392   | 0.00196     |
 *
 * Sub-centimetre positions matter because the client *predicts* the local player
 * and reconciles against the replicated value: quantisation error there shows up
 * as visible jitter on the local player, not just on remote ones.
 */

/** Structurally compatible with THREE.Vector3 — no three.js dependency here. */
export interface NetVec3 {
  x: number;
  y: number;
  z: number;
}

/** Structurally compatible with THREE.Quaternion. */
export interface NetQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/* -------------------------------------------------------------------------- */
/* Scalar ranges                                                              */
/* -------------------------------------------------------------------------- */

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly bits: number;
  /** Number of intervals: `2^bits - 1`. */
  readonly steps: number;
  /** Width of one interval in field units. */
  readonly step: number;
  /** Worst-case absolute reconstruction error: `step / 2`. */
  readonly error: number;
}

/** Build a fixed-point range. `bits` must be 1..31. */
export function makeRange(min: number, max: number, bits: number): Range {
  if (!(max > min)) throw new Error(`[Quantize] bad range [${min}, ${max}]`);
  if (bits < 1 || bits > 31) throw new Error(`[Quantize] bits out of range: ${bits}`);
  const steps = Math.pow(2, bits) - 1;
  const step = (max - min) / steps;
  return { min, max, bits, steps, step, error: step / 2 };
}

/** Smallest range whose worst-case error is <= `precision` field units. */
export function rangeForPrecision(min: number, max: number, precision: number): Range {
  const needed = (max - min) / (2 * precision) + 1;
  const bits = Math.max(1, Math.min(31, Math.ceil(Math.log2(needed))));
  return makeRange(min, max, bits);
}

/** Value -> integer in [0, range.steps]. Clamped. */
export function quantize(range: Range, value: number): number {
  const v = value < range.min ? range.min : value > range.max ? range.max : value;
  const q = Math.round((v - range.min) / range.step);
  return q < 0 ? 0 : q > range.steps ? range.steps : q;
}

/** Integer in [0, range.steps] -> value. */
export function dequantize(range: Range, q: number): number {
  const c = q < 0 ? 0 : q > range.steps ? range.steps : q;
  return range.min + c * range.step;
}

/** The value the far end will actually reconstruct. Used to build baselines. */
export function snapToRange(range: Range, value: number): number {
  return dequantize(range, quantize(range, value));
}

export function rangeSignature(range: Range): string {
  return `r(${range.min},${range.max},${range.bits})`;
}

/* -------------------------------------------------------------------------- */
/* World bounds                                                               */
/* -------------------------------------------------------------------------- */

export interface WorldBounds {
  readonly x: Range;
  readonly y: Range;
  readonly z: Range;
}

export interface WorldBoundsOptions {
  /** Horizontal half-extent in metres. Default 512. */
  horizontal?: number;
  /** Lowest replicated Y in metres. Default −64. */
  minY?: number;
  /** Highest replicated Y in metres. Default 448. */
  maxY?: number;
  /** Bits per horizontal axis. Default 17 (7.81 mm step over ±512 m). */
  horizontalBits?: number;
  /** Bits on the vertical axis. Default 16 (7.81 mm step over 512 m). */
  verticalBits?: number;
}

export function makeWorldBounds(options: WorldBoundsOptions = {}): WorldBounds {
  const h = options.horizontal ?? 512;
  const minY = options.minY ?? -64;
  const maxY = options.maxY ?? 448;
  const hb = options.horizontalBits ?? 17;
  const vb = options.verticalBits ?? 16;
  return {
    x: makeRange(-h, h, hb),
    y: makeRange(minY, maxY, vb),
    z: makeRange(-h, h, hb),
  };
}

/**
 * Default replication volume: ±512 m horizontally, −64…+448 m vertically.
 * The shipped map (`src/world/Layout.ts`) is 74 m outer half-extent, so this
 * leaves ~7x headroom for larger maps without a format change. Precision is
 * 7.813 mm / 0.391 cm max error on every axis.
 */
export const DEFAULT_WORLD_BOUNDS: WorldBounds = makeWorldBounds();

/** Worst-case position error in centimetres, for reporting. */
export function worldPrecisionCm(bounds: WorldBounds = DEFAULT_WORLD_BOUNDS): NetVec3 {
  return { x: bounds.x.error * 100, y: bounds.y.error * 100, z: bounds.z.error * 100 };
}

/* -------------------------------------------------------------------------- */
/* Angles                                                                     */
/* -------------------------------------------------------------------------- */

export const TAU = Math.PI * 2;

/** 16 bits: 0.00549° step, 0.00275° max error. Use for replicated view angles. */
export const ANGLE_BITS_PRECISE = 16;
/** 12 bits: 0.0879° step, 0.0439° max error. Use for cosmetic angles. */
export const ANGLE_BITS_COARSE = 12;

/** Wrap into [−π, π). */
export function wrapAngle(rad: number): number {
  let a = rad % TAU;
  if (a >= Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

/**
 * Angle -> integer in [0, 2^bits). Wraps rather than clamps: the circle has no
 * endpoints, so all 2^bits codes are used and there is no wasted code point.
 */
export function quantizeAngle(rad: number, bits: number): number {
  const n = Math.pow(2, bits);
  const norm = (wrapAngle(rad) + Math.PI) / TAU; // [0, 1)
  let q = Math.round(norm * n);
  q = ((q % n) + n) % n;
  return q;
}

export function dequantizeAngle(q: number, bits: number): number {
  const n = Math.pow(2, bits);
  return wrapAngle((q / n) * TAU - Math.PI);
}

/** Worst-case angular error in radians for a given bit count. */
export function angleError(bits: number): number {
  return TAU / Math.pow(2, bits) / 2;
}

export function snapAngle(rad: number, bits: number): number {
  return dequantizeAngle(quantizeAngle(rad, bits), bits);
}

/* -------------------------------------------------------------------------- */
/* Rotations — smallest-three                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A unit quaternion has one component whose magnitude is at least 1/sqrt(2).
 * Drop that one, send its index (2 bits) and the other three over
 * [−1/sqrt2, +1/sqrt2], then rebuild the dropped one from the unit constraint.
 * At the default 10 bits per component that is 32 bits total for a rotation with
 * a worst-case angular error of 0.274° (see {@link quatErrorRad}). Pass 12 bits
 * (38 total) where a prop's orientation is read closely, e.g. a held weapon.
 *
 * Rejected alternatives: 3x float32 Euler (96 bits, gimbal issues, and the
 * far end has to agree on rotation order), and 4x quantised components
 * (needs more bits for the same accuracy and can denormalise).
 */
export const QUAT_BITS_DEFAULT = 10;

const INV_SQRT2 = Math.SQRT1_2;

export interface PackedQuat {
  /** Index 0..3 of the dropped (largest-magnitude) component. */
  largest: number;
  /** The three remaining components as integers in [0, 2^bits - 1]. */
  a: number;
  b: number;
  c: number;
}

function quatRange(bits: number): Range {
  return makeRange(-INV_SQRT2, INV_SQRT2, bits);
}

const QUAT_RANGE_CACHE = new Map<number, Range>();
function cachedQuatRange(bits: number): Range {
  let r = QUAT_RANGE_CACHE.get(bits);
  if (!r) {
    r = quatRange(bits);
    QUAT_RANGE_CACHE.set(bits, r);
  }
  return r;
}

export function packSmallestThree(q: NetQuat, bits: number = QUAT_BITS_DEFAULT): PackedQuat {
  // Normalise defensively: an unnormalised input would break the reconstruction.
  let { x, y, z, w } = q;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len > 1e-9) {
    const inv = 1 / len;
    x *= inv;
    y *= inv;
    z *= inv;
    w *= inv;
  } else {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  }

  const comps = [x, y, z, w];
  let largest = 0;
  let largestAbs = Math.abs(comps[0]);
  for (let i = 1; i < 4; i++) {
    const a = Math.abs(comps[i]);
    if (a > largestAbs) {
      largestAbs = a;
      largest = i;
    }
  }
  // q and -q are the same rotation; force the dropped component positive so the
  // three we send are always in [-1/sqrt2, 1/sqrt2].
  const sign = comps[largest] < 0 ? -1 : 1;

  const range = cachedQuatRange(bits);
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    out.push(quantize(range, comps[i] * sign));
  }
  return { largest, a: out[0], b: out[1], c: out[2] };
}

export function unpackSmallestThree(p: PackedQuat, bits: number = QUAT_BITS_DEFAULT): NetQuat {
  const range = cachedQuatRange(bits);
  const a = dequantize(range, p.a);
  const b = dequantize(range, p.b);
  const c = dequantize(range, p.c);
  const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
  switch (p.largest) {
    case 0:
      return { x: d, y: a, z: b, w: c };
    case 1:
      return { x: a, y: d, z: b, w: c };
    case 2:
      return { x: a, y: b, z: d, w: c };
    default:
      return { x: a, y: b, z: c, w: d };
  }
}

export function snapQuat(q: NetQuat, bits: number = QUAT_BITS_DEFAULT): NetQuat {
  return unpackSmallestThree(packSmallestThree(q, bits), bits);
}

/**
 * Analytic upper bound on the angular error, in radians.
 *
 * Each sent component carries at most `h = step/2` of error. The reconstructed
 * fourth component `d = sqrt(1 - a^2 - b^2 - c^2)` has error at most `3h`,
 * because `|dd| = |d(sumSq)| / 2d` and `d >= 1/sqrt(2)` by construction. So the
 * quaternion perturbation is bounded by `sqrt(3h^2 + 9h^2) = 2*sqrt(3)*h`, and
 * an angular error is `2 * |dq|`.
 *
 * At the default 10 bits: h = 6.911e-4 => 4.79e-3 rad => **0.274°**.
 * Verified empirically over 200k random rotations in tools/net-wire.mjs.
 */
export function quatErrorRad(bits: number = QUAT_BITS_DEFAULT): number {
  const h = cachedQuatRange(bits).error;
  return 4 * Math.sqrt(3) * h;
}

/** Angle between two rotations, in radians. Used by tests and by lag comp. */
export function quatAngleBetween(a: NetQuat, b: NetQuat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

/* -------------------------------------------------------------------------- */
/* Velocity                                                                   */
/* -------------------------------------------------------------------------- */

/** Default: ±64 m/s per axis, 13 bits => 15.63 mm/s step, 7.81 mm/s max error. */
export const DEFAULT_VELOCITY_RANGE: Range = makeRange(-64, 64, 13);
