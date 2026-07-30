/**
 * Serialize — schema-driven encode/decode.
 *
 * ## The failure this design removes
 *
 * The classic netcode bug is a hand-written encoder and a hand-written decoder
 * that drift apart: someone adds a field to `writePlayer()` and forgets
 * `readPlayer()`, and from that bit onward every subsequent field in the packet
 * is garbage — including fields belonging to *other* entities. The symptom is a
 * player teleporting into the floor with 231 health, and the cause is eleven
 * commits away.
 *
 * This module makes that mechanically impossible:
 *
 *  1. A {@link Codec} owns `write` and `read` **in the same object**. You cannot
 *     add one without the other; there is no file where only half of a field's
 *     logic lives.
 *  2. A {@link Schema} is a declared list of `(key, codec)`. Encode and decode
 *     are the *same loop* over the *same array*. Adding a field changes one line
 *     and both directions follow.
 *  3. The state type is *inferred from the schema* via the builder, so a field
 *     that exists on the wire but not in the game state (or vice versa) is a
 *     compile error, not a runtime corruption.
 *  4. Every schema carries a 32-bit signature hash over its field names and
 *     codec parameters, and the registry folds those into a
 *     {@link SchemaRegistry.protocolHash}. Two peers running different builds
 *     detect it in the handshake instead of decoding each other's garbage.
 *
 * ## Delta encoding at the field level
 *
 * `Schema.encode(w, state, base)`:
 *  - `base === null` (spawn, or a client with no acked snapshot) writes every
 *    field with **no changed-mask** — the mask would be all ones anyway.
 *  - `base !== null` writes a 1-bit-per-field changed mask, then only the
 *    changed fields. Comparison is done against the *snapped* value (see below),
 *    so sub-quantum jitter costs zero bits.
 *
 * ## Snapping — why baselines must be quantised
 *
 * The subtle killer in delta compression: the sender deltas against its
 * full-precision state while the receiver's baseline is the *decoded*
 * (quantised) value. The two baselines disagree by a fraction of a step, and the
 * error compounds every snapshot until an entity drifts visibly.
 *
 * Every codec therefore exposes {@link Codec.snap}: the value the far end will
 * reconstruct. {@link Schema.snapshot} builds the object the sender stores as
 * its record of what the receiver now holds. Encoder-side and decoder-side
 * baselines are then bit-identical, forever — asserted in tools/net-wire.mjs.
 */

import { BitWriter } from './BitWriter';
import { BitReader } from './BitReader';
import type { NetQuat, NetVec3, Range, WorldBounds } from './Quantize';
import {
  ANGLE_BITS_COARSE,
  ANGLE_BITS_PRECISE,
  DEFAULT_VELOCITY_RANGE,
  DEFAULT_WORLD_BOUNDS,
  QUAT_BITS_DEFAULT,
  angleError,
  dequantize,
  dequantizeAngle,
  makeRange,
  packSmallestThree,
  quantize,
  quantizeAngle,
  quatErrorRad,
  rangeSignature,
  snapAngle,
  snapToRange,
  unpackSmallestThree,
} from './Quantize';

/* -------------------------------------------------------------------------- */
/* Codec                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A bidirectional field encoder. `write` and `read` are exact inverses (modulo
 * the stated `errorBound`) and live together so they cannot drift.
 *
 * `base` is the value the far end already holds, or `undefined` when there is
 * none. Both sides always agree on whether a base exists, so a codec may branch
 * on it freely — that is how delta-coded positions get to spend 8 bits instead
 * of 17.
 */
export interface Codec<T> {
  /** Human-readable kind, e.g. 'position'. */
  readonly kind: string;
  /** Parameterised identity; feeds the schema hash. Change it, break the hash. */
  readonly signature: string;
  /** Upper bound on bits written for one value. Used for budget estimates. */
  readonly maxBits: number;
  /** Worst-case absolute reconstruction error in field units. 0 = lossless. */
  readonly errorBound: number;
  /**
   * The value the far end will reconstruct.
   *
   * The binding contract is `read(write(v)) === snap(v)` for every `v` — that is
   * what keeps the two baselines identical. `snap` is deliberately *not*
   * required to be idempotent: for a rotation whose largest two components are
   * within a quantisation step of each other, `snap(snap(q))` may choose a
   * different smallest-three axis. Encoders therefore always write raw values.
   */
  snap(value: T): T;
  /** Equality over snapped values; drives the changed-mask. */
  equals(a: T, b: T): boolean;
  /** Independent copy, for baseline storage. */
  copy(value: T): T;
  write(w: BitWriter, value: T, base: T | undefined): void;
  read(r: BitReader, base: T | undefined): T;
}

const identityCopy = <T>(v: T): T => v;
const strictEquals = <T>(a: T, b: T): boolean => a === b;

/* -------------------------------------------------------------------------- */
/* Primitive codecs                                                           */
/* -------------------------------------------------------------------------- */

export const boolCodec: Codec<boolean> = {
  kind: 'bool',
  signature: 'bool',
  maxBits: 1,
  errorBound: 0,
  snap: (v) => v,
  equals: strictEquals,
  copy: identityCopy,
  write: (w, v) => w.writeBool(v),
  read: (r) => r.readBool(),
};

/** Unsigned integer in `bits` bits. Values are clamped, not wrapped. */
export function uintCodec(bits: number): Codec<number> {
  const max = Math.pow(2, bits) - 1;
  const clamp = (v: number): number => {
    const i = Math.round(v);
    return i < 0 ? 0 : i > max ? max : i;
  };
  return {
    kind: 'uint',
    signature: `uint(${bits})`,
    maxBits: bits,
    errorBound: 0,
    snap: clamp,
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeBits(clamp(v), bits),
    read: (r) => r.readBits(bits),
  };
}

/** Two's-complement signed integer in `bits` bits. */
export function intCodec(bits: number): Codec<number> {
  const lo = -Math.pow(2, bits - 1);
  const hi = Math.pow(2, bits - 1) - 1;
  const clamp = (v: number): number => {
    const i = Math.round(v);
    return i < lo ? lo : i > hi ? hi : i;
  };
  return {
    kind: 'int',
    signature: `int(${bits})`,
    maxBits: bits,
    errorBound: 0,
    snap: clamp,
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeInt(clamp(v), bits),
    read: (r) => r.readInt(bits),
  };
}

export const varUintCodec: Codec<number> = {
  kind: 'varuint',
  signature: 'varuint',
  maxBits: 40,
  errorBound: 0,
  snap: (v) => Math.max(0, Math.round(v)),
  equals: strictEquals,
  copy: identityCopy,
  write: (w, v) => w.writeVarUint(Math.max(0, Math.round(v))),
  read: (r) => r.readVarUint(),
};

export const varIntCodec: Codec<number> = {
  kind: 'varint',
  signature: 'varint',
  maxBits: 40,
  errorBound: 0,
  snap: (v) => Math.round(v),
  equals: strictEquals,
  copy: identityCopy,
  write: (w, v) => w.writeVarInt(Math.round(v)),
  read: (r) => r.readVarInt(),
};

/** Exact float32. 32 bits. Escape hatch for values with no sane bound. */
export const float32Codec: Codec<number> = {
  kind: 'float32',
  signature: 'f32',
  maxBits: 32,
  errorBound: 0,
  snap: (v) => Math.fround(v),
  equals: (a, b) => Math.fround(a) === Math.fround(b),
  copy: identityCopy,
  write: (w, v) => w.writeFloat32(v),
  read: (r) => r.readFloat32(),
};

/** Fixed-point scalar over an explicit range. */
export function scalarCodec(min: number, max: number, bits: number): Codec<number> {
  const range = makeRange(min, max, bits);
  return rangeCodec(range);
}

export function rangeCodec(range: Range): Codec<number> {
  return {
    kind: 'scalar',
    signature: rangeSignature(range),
    maxBits: range.bits,
    errorBound: range.error,
    snap: (v) => snapToRange(range, v),
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeBits(quantize(range, v), range.bits),
    read: (r) => dequantize(range, r.readBits(range.bits)),
  };
}

/** [0,1] at `bits` bits. 0 and 1 are exactly representable. */
export function unormCodec(bits = 8): Codec<number> {
  return scalarCodec(0, 1, bits);
}

/** Angle in radians, wrapped to [−π, π). */
export function angleCodec(bits: number = ANGLE_BITS_COARSE): Codec<number> {
  return {
    kind: 'angle',
    signature: `angle(${bits})`,
    maxBits: bits,
    errorBound: angleError(bits),
    snap: (v) => snapAngle(v, bits),
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeBits(quantizeAngle(v, bits), bits),
    read: (r) => dequantizeAngle(r.readBits(bits), bits),
  };
}

/** Replicated view angles: 0.00275° worst case. */
export const angleFineCodec: Codec<number> = angleCodec(ANGLE_BITS_PRECISE);
/** Cosmetic angles: 0.0439° worst case. */
export const angleCoarseCodec: Codec<number> = angleCodec(ANGLE_BITS_COARSE);

/** Index into a fixed enum of `count` values. ceil(log2(count)) bits. */
export function enumCodec(count: number): Codec<number> {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, count))));
  const max = count - 1;
  const clamp = (v: number): number => {
    const i = Math.round(v);
    return i < 0 ? 0 : i > max ? max : i;
  };
  return {
    kind: 'enum',
    signature: `enum(${count})`,
    maxBits: bits,
    errorBound: 0,
    snap: clamp,
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeBits(clamp(v), bits),
    read: (r) => Math.min(max, r.readBits(bits)),
  };
}

/** A bitfield of `bits` flags packed into exactly `bits` bits. */
export function flagsCodec(bits: number): Codec<number> {
  const mask = bits >= 32 ? 0xffffffff : Math.pow(2, bits) - 1;
  return {
    kind: 'flags',
    signature: `flags(${bits})`,
    maxBits: bits,
    errorBound: 0,
    snap: (v) => (v >>> 0) & mask,
    equals: (a, b) => ((a >>> 0) & mask) === ((b >>> 0) & mask),
    copy: identityCopy,
    write: (w, v) => w.writeBits((v >>> 0) & mask, bits),
    read: (r) => r.readBits(bits),
  };
}

/** UTF-8 string. Rarely replicated (names, chat) — keep off per-tick paths. */
export function stringCodec(maxBytes = 64): Codec<string> {
  return {
    kind: 'string',
    signature: `str(${maxBytes})`,
    maxBits: 8 * (maxBytes + 5),
    errorBound: 0,
    snap: (v) => v,
    equals: strictEquals,
    copy: identityCopy,
    write: (w, v) => w.writeString(v),
    read: (r) => r.readString(maxBytes),
  };
}

/* -------------------------------------------------------------------------- */
/* Vectors — tiered delta-coded fixed point                                   */
/* -------------------------------------------------------------------------- */

export interface TieredVec3Options {
  /** Bits for the cheap delta tier. Default 7 => ±64 quantised steps. */
  smallDeltaBits?: number;
  /** Bits for the middle delta tier. Default 12 => ±2048 quantised steps. */
  mediumDeltaBits?: number;
}

/**
 * Three fixed-point axes with a prefix-coded three-tier delta. This is the
 * single biggest bandwidth lever in the whole module, so both positions and
 * velocities go through it.
 *
 * With no base — every axis at full precision:
 *   position 17+16+17 = 50 bits, velocity 13*3 = 39 bits.
 *
 * With a base — a 3-bit per-axis changed mask, then per changed axis:
 * ```
 *   0  + int(small)    ordinary per-tick motion
 *   10 + int(medium)   a baseline that has aged out under packet loss
 *   11 + full          teleport, respawn, or a value out of delta range
 * ```
 *
 * At the defaults (small 7, medium 12) that is 8 / 14 / 19 bits per axis for a
 * position. A walking player costs 3 + 2*8 = 19 bits of position instead of 50;
 * a projectile under gravity costs 3 + 3*8 = 27 bits of velocity instead of 39.
 *
 * The tiers are what make the scheme robust rather than merely small. A client
 * whose last ack is 400 ms old still decodes correctly — it just pays the middle
 * tier for that snapshot, and there is no case where a stale baseline produces a
 * wrong answer instead of a bigger packet.
 *
 * The delta is computed in *quantised steps*, not metres, so encoder and decoder
 * do integer arithmetic on identical inputs and cannot accumulate float drift.
 */
export function tieredVec3Codec(
  kind: string,
  ranges: readonly [Range, Range, Range],
  options: TieredVec3Options = {},
): Codec<NetVec3> {
  const smallBits = options.smallDeltaBits ?? 7;
  const mediumBits = options.mediumDeltaBits ?? 12;
  const smallMin = -Math.pow(2, smallBits - 1);
  const smallMax = Math.pow(2, smallBits - 1) - 1;
  const mediumMin = -Math.pow(2, mediumBits - 1);
  const mediumMax = Math.pow(2, mediumBits - 1) - 1;
  const rx = ranges[0];
  const ry = ranges[1];
  const rz = ranges[2];
  const errorBound = Math.max(rx.error, ry.error, rz.error);
  const maxAxisBits = Math.max(rx.bits, ry.bits, rz.bits);

  const writeAxis = (w: BitWriter, range: Range, q: number, qBase: number): void => {
    const d = q - qBase;
    if (d >= smallMin && d <= smallMax) {
      w.writeBool(false);
      w.writeInt(d, smallBits);
    } else if (d >= mediumMin && d <= mediumMax) {
      w.writeBool(true);
      w.writeBool(false);
      w.writeInt(d, mediumBits);
    } else {
      w.writeBool(true);
      w.writeBool(true);
      w.writeBits(q, range.bits);
    }
  };

  const readAxis = (r: BitReader, range: Range, qBase: number): number => {
    if (!r.readBool()) return qBase + r.readInt(smallBits);
    if (!r.readBool()) return qBase + r.readInt(mediumBits);
    return r.readBits(range.bits);
  };

  return {
    kind,
    signature:
      `${kind}(${rangeSignature(rx)},${rangeSignature(ry)},${rangeSignature(rz)},` +
      `${smallBits},${mediumBits})`,
    maxBits: 3 + 3 * (2 + maxAxisBits),
    errorBound,
    snap: (v) => ({
      x: snapToRange(rx, v.x),
      y: snapToRange(ry, v.y),
      z: snapToRange(rz, v.z),
    }),
    equals: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z,
    copy: (v) => ({ x: v.x, y: v.y, z: v.z }),
    write: (w, v, base) => {
      const qx = quantize(rx, v.x);
      const qy = quantize(ry, v.y);
      const qz = quantize(rz, v.z);
      if (base === undefined) {
        w.writeBits(qx, rx.bits);
        w.writeBits(qy, ry.bits);
        w.writeBits(qz, rz.bits);
        return;
      }
      const bx = quantize(rx, base.x);
      const by = quantize(ry, base.y);
      const bz = quantize(rz, base.z);
      w.writeBool(qx !== bx);
      w.writeBool(qy !== by);
      w.writeBool(qz !== bz);
      if (qx !== bx) writeAxis(w, rx, qx, bx);
      if (qy !== by) writeAxis(w, ry, qy, by);
      if (qz !== bz) writeAxis(w, rz, qz, bz);
    },
    read: (r, base) => {
      if (base === undefined) {
        return {
          x: dequantize(rx, r.readBits(rx.bits)),
          y: dequantize(ry, r.readBits(ry.bits)),
          z: dequantize(rz, r.readBits(rz.bits)),
        };
      }
      const bx = quantize(rx, base.x);
      const by = quantize(ry, base.y);
      const bz = quantize(rz, base.z);
      const cx = r.readBool();
      const cy = r.readBool();
      const cz = r.readBool();
      return {
        x: dequantize(rx, cx ? readAxis(r, rx, bx) : bx),
        y: dequantize(ry, cy ? readAxis(r, ry, by) : by),
        z: dequantize(rz, cz ? readAxis(r, rz, bz) : bz),
      };
    },
  };
}

export interface PositionCodecOptions extends TieredVec3Options {
  bounds?: WorldBounds;
}

/**
 * A world position over {@link DEFAULT_WORLD_BOUNDS} unless told otherwise:
 * ±512 m horizontally, −64…+448 m vertically, 0.391 cm worst-case error.
 */
export function positionCodec(options: PositionCodecOptions = {}): Codec<NetVec3> {
  const bounds = options.bounds ?? DEFAULT_WORLD_BOUNDS;
  return tieredVec3Codec('pos', [bounds.x, bounds.y, bounds.z], options);
}

/** Shared default-bounds position codec. */
export const defaultPositionCodec: Codec<NetVec3> = positionCodec();

/** Bits a full (baseline) position costs — reported by the bandwidth tests. */
export const DEFAULT_POSITION_FULL_BITS =
  DEFAULT_WORLD_BOUNDS.x.bits + DEFAULT_WORLD_BOUNDS.y.bits + DEFAULT_WORLD_BOUNDS.z.bits;

/** A vector whose three axes share one range. Same tiered delta as positions. */
export function vec3Codec(
  range: Range,
  kind = 'vec3',
  options: TieredVec3Options = {},
): Codec<NetVec3> {
  return tieredVec3Codec(kind, [range, range, range], options);
}

/** ±64 m/s per axis at 13 bits: 1.563 cm/s step, 0.781 cm/s worst case. */
export const velocityCodec: Codec<NetVec3> = vec3Codec(DEFAULT_VELOCITY_RANGE, 'velocity');

/** Unbounded vector as three exact float32s. 96 bits — use sparingly. */
export const vec3RawCodec: Codec<NetVec3> = {
  kind: 'vec3raw',
  signature: 'vec3raw',
  maxBits: 96,
  errorBound: 0,
  snap: (v) => ({ x: Math.fround(v.x), y: Math.fround(v.y), z: Math.fround(v.z) }),
  equals: (a, b) =>
    Math.fround(a.x) === Math.fround(b.x) &&
    Math.fround(a.y) === Math.fround(b.y) &&
    Math.fround(a.z) === Math.fround(b.z),
  copy: (v) => ({ x: v.x, y: v.y, z: v.z }),
  write: (w, v) => {
    w.writeFloat32(v.x);
    w.writeFloat32(v.y);
    w.writeFloat32(v.z);
  },
  read: (r) => ({ x: r.readFloat32(), y: r.readFloat32(), z: r.readFloat32() }),
};

/* -------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* -------------------------------------------------------------------------- */

/** Smallest-three quaternion. 2 + 3*bits bits (32 at the default 10). */
export function quatCodec(bits: number = QUAT_BITS_DEFAULT): Codec<NetQuat> {
  return {
    kind: 'quat',
    signature: `quat(${bits})`,
    maxBits: 2 + 3 * bits,
    errorBound: quatErrorRad(bits),
    snap: (v) => unpackSmallestThree(packSmallestThree(v, bits), bits),
    equals: (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w,
    copy: (v) => ({ x: v.x, y: v.y, z: v.z, w: v.w }),
    write: (w, v) => {
      const p = packSmallestThree(v, bits);
      w.writeBits(p.largest, 2);
      w.writeBits(p.a, bits);
      w.writeBits(p.b, bits);
      w.writeBits(p.c, bits);
    },
    read: (r) => {
      const largest = r.readBits(2);
      const a = r.readBits(bits);
      const b = r.readBits(bits);
      const c = r.readBits(bits);
      return unpackSmallestThree({ largest, a, b, c }, bits);
    },
  };
}

export const defaultQuatCodec: Codec<NetQuat> = quatCodec();

/* -------------------------------------------------------------------------- */
/* Combinators                                                                */
/* -------------------------------------------------------------------------- */

/** 1 presence bit + the inner codec. `null` is the absent value. */
export function optionalCodec<T>(inner: Codec<T>): Codec<T | null> {
  return {
    kind: `optional<${inner.kind}>`,
    signature: `opt(${inner.signature})`,
    maxBits: 1 + inner.maxBits,
    errorBound: inner.errorBound,
    snap: (v) => (v === null ? null : inner.snap(v)),
    equals: (a, b) => (a === null || b === null ? a === b : inner.equals(a, b)),
    copy: (v) => (v === null ? null : inner.copy(v)),
    write: (w, v, base) => {
      w.writeBool(v !== null);
      // The inner base is only usable when both sides had a present value.
      if (v !== null) inner.write(w, v, base === null || base === undefined ? undefined : base);
    },
    read: (r, base) => {
      if (!r.readBool()) return null;
      return inner.read(r, base === null || base === undefined ? undefined : base);
    },
  };
}

/** varuint length + elements. Elements never delta against a base. */
export function arrayCodec<T>(inner: Codec<T>, maxLength = 64): Codec<T[]> {
  return {
    kind: `array<${inner.kind}>`,
    signature: `arr(${inner.signature},${maxLength})`,
    maxBits: 40 + maxLength * inner.maxBits,
    errorBound: inner.errorBound,
    snap: (v) => v.map((e) => inner.snap(e)),
    equals: (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!inner.equals(a[i], b[i])) return false;
      return true;
    },
    copy: (v) => v.map((e) => inner.copy(e)),
    write: (w, v) => {
      const n = Math.min(v.length, maxLength);
      w.writeVarUint(n);
      for (let i = 0; i < n; i++) inner.write(w, v[i], undefined);
    },
    read: (r) => {
      const n = r.readVarUint();
      if (n > maxLength) {
        // Corrupt or hostile length. Refuse rather than allocate.
        r.skipBits(r.bitsRemaining + 1);
        return [];
      }
      const out: T[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = inner.read(r, undefined);
      return out;
    },
  };
}

/**
 * Convenience namespace so call sites read as a mini schema language:
 * `C.position()`, `C.uint(8)`, `C.angleFine`.
 */
export const C = {
  bool: boolCodec,
  uint: uintCodec,
  int: intCodec,
  varuint: varUintCodec,
  varint: varIntCodec,
  float32: float32Codec,
  scalar: scalarCodec,
  range: rangeCodec,
  unorm: unormCodec,
  angle: angleCodec,
  angleFine: angleFineCodec,
  angleCoarse: angleCoarseCodec,
  enum: enumCodec,
  flags: flagsCodec,
  string: stringCodec,
  position: (options?: PositionCodecOptions): Codec<NetVec3> =>
    options === undefined ? defaultPositionCodec : positionCodec(options),
  vec3: vec3Codec,
  tieredVec3: tieredVec3Codec,
  vec3Raw: vec3RawCodec,
  velocity: velocityCodec,
  quat: (bits?: number): Codec<NetQuat> =>
    bits === undefined ? defaultQuatCodec : quatCodec(bits),
  optional: optionalCodec,
  array: arrayCodec,
} as const;

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

export interface FieldDef {
  readonly key: string;
  readonly codec: Codec<unknown>;
}

type Expand<T> = { [K in keyof T]: T[K] } & {};

/** 32-bit FNV-1a. Same function as src/core/Rand.ts hashString, kept local so
 *  the wire layer has no dependency on gameplay code. */
export function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Schema<S extends object> {
  readonly name: string;
  readonly fields: readonly FieldDef[];
  /** Stable hash over name + every field name and codec signature. */
  readonly signatureHash: number;
  readonly signature: string;
  /** Upper bound on bits for a full (baseline) encode of one entity. */
  readonly maxBits: number;
  /** Index assigned by a {@link SchemaRegistry}; -1 until registered. */
  wireId = -1;

  constructor(name: string, fields: readonly FieldDef[]) {
    this.name = name;
    this.fields = fields;
    this.signature = `${name}{${fields.map((f) => `${f.key}:${f.codec.signature}`).join(',')}}`;
    this.signatureHash = hash32(this.signature);
    let bits = fields.length; // changed mask
    for (const f of fields) bits += f.codec.maxBits;
    this.maxBits = bits;
  }

  /** The object the far end will reconstruct from `state`. */
  snapshot(state: S): S {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) {
      out[f.key] = f.codec.snap((state as Record<string, unknown>)[f.key]);
    }
    return out as S;
  }

  /** Independent copy, no quantisation. */
  copy(state: S): S {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) {
      out[f.key] = f.codec.copy((state as Record<string, unknown>)[f.key]);
    }
    return out as S;
  }

  /** True when no field differs after snapping. */
  equals(a: S, b: S): boolean {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const f of this.fields) {
      if (!f.codec.equals(f.codec.snap(ra[f.key]), rb[f.key])) return false;
    }
    return true;
  }

  /**
   * Encode `state`. `base` is what the far end already holds (already snapped);
   * pass `null` for a full encode. Returns true if anything was written beyond
   * the mask.
   */
  encode(w: BitWriter, state: S, base: S | null): boolean {
    const rs = state as Record<string, unknown>;
    if (base === null) {
      for (const f of this.fields) f.codec.write(w, rs[f.key], undefined);
      return true;
    }
    const rb = base as Record<string, unknown>;
    const n = this.fields.length;
    const changed: boolean[] = new Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const f = this.fields[i];
      changed[i] = !f.codec.equals(f.codec.snap(rs[f.key]), rb[f.key]);
      w.writeBool(changed[i]);
      if (changed[i]) any = true;
    }
    // Always write the *raw* value. `snap` is only ever used to decide whether a
    // field changed and to record the baseline; feeding a snapped value back
    // through `write` would double-quantise, and for a near-degenerate rotation
    // that can pick a different smallest-three axis than `snap` did.
    for (let i = 0; i < n; i++) {
      if (!changed[i]) continue;
      const f = this.fields[i];
      f.codec.write(w, rs[f.key], rb[f.key]);
    }
    return any;
  }

  /** Mirror of {@link encode}. Unchanged fields are carried from `base`. */
  decode(r: BitReader, base: S | null): S {
    const out: Record<string, unknown> = {};
    if (base === null) {
      for (const f of this.fields) out[f.key] = f.codec.read(r, undefined);
      return out as S;
    }
    const rb = base as Record<string, unknown>;
    const n = this.fields.length;
    const changed: boolean[] = new Array(n);
    for (let i = 0; i < n; i++) changed[i] = r.readBool();
    for (let i = 0; i < n; i++) {
      const f = this.fields[i];
      out[f.key] = changed[i] ? f.codec.read(r, rb[f.key]) : f.codec.copy(rb[f.key]);
    }
    return out as S;
  }

  /** Conservative bit cost of encoding `state` against `base`. */
  estimateBits(state: S, base: S | null): number {
    const rs = state as Record<string, unknown>;
    if (base === null) {
      let bits = 0;
      for (const f of this.fields) bits += f.codec.maxBits;
      return bits;
    }
    const rb = base as Record<string, unknown>;
    let bits = this.fields.length;
    for (const f of this.fields) {
      const s = f.codec.snap(rs[f.key]);
      if (!f.codec.equals(s, rb[f.key])) bits += f.codec.maxBits;
    }
    return bits;
  }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnySchema = Schema<any>;

/** Extract the state type a schema describes: `type P = StateOf<typeof Player>`. */
export type StateOf<T> = T extends Schema<infer S> ? S : never;

/* -------------------------------------------------------------------------- */
/* Schema builder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Accumulating builder. The state type is *derived from the field list*, so a
 * mismatch between the wire format and the game state is a type error:
 *
 * ```ts
 * export const PlayerSchema = defineSchema('player')
 *   .field('pos', C.position())
 *   .field('yaw', C.angleFine)
 *   .field('health', C.uint(8))
 *   .build();
 *
 * export type PlayerNetState = StateOf<typeof PlayerSchema>;
 * // { pos: NetVec3; yaw: number; health: number }
 * ```
 */
export class SchemaBuilder<S extends object> {
  private readonly defs: FieldDef[] = [];
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  field<K extends string, T>(key: K, codec: Codec<T>): SchemaBuilder<S & { [P in K]: T }> {
    if (this.defs.some((d) => d.key === key)) {
      throw new Error(`[Serialize] duplicate field "${key}" in schema "${this.name}"`);
    }
    this.defs.push({ key, codec: codec as unknown as Codec<unknown> });
    return this as unknown as SchemaBuilder<S & { [P in K]: T }>;
  }

  build(): Schema<Expand<S>> {
    return new Schema<Expand<S>>(this.name, this.defs.slice());
  }
}

export function defineSchema(name: string): SchemaBuilder<{}> {
  return new SchemaBuilder<{}>(name);
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Maps schemas to compact wire ids and produces the protocol hash.
 *
 * Both peers run the same build, so registration order is identical and the
 * wire id is just the index. The {@link protocolHash} is exchanged during the
 * handshake: a mismatch means the two peers disagree about the wire format, and
 * the connection must be refused rather than allowed to decode garbage.
 */
export class SchemaRegistry {
  private readonly list: Schema<any>[] = [];
  private readonly byName = new Map<string, Schema<any>>();
  private hashCache = -1;

  /** Wire ids are 8 bits. */
  static readonly MAX_SCHEMAS = 256;

  register<S extends object>(schema: Schema<S>): Schema<S> {
    if (this.byName.has(schema.name)) {
      throw new Error(`[Serialize] duplicate schema "${schema.name}"`);
    }
    if (this.list.length >= SchemaRegistry.MAX_SCHEMAS) {
      throw new Error('[Serialize] schema registry full (256 max)');
    }
    schema.wireId = this.list.length;
    this.list.push(schema as Schema<any>);
    this.byName.set(schema.name, schema as Schema<any>);
    this.hashCache = -1;
    return schema;
  }

  get(wireId: number): Schema<any> | undefined {
    return this.list[wireId];
  }

  lookup(name: string): Schema<any> | undefined {
    return this.byName.get(name);
  }

  get size(): number {
    return this.list.length;
  }

  all(): readonly Schema<any>[] {
    return this.list;
  }

  /** 32-bit hash over every registered schema signature, in wire-id order. */
  get protocolHash(): number {
    if (this.hashCache < 0) {
      this.hashCache = hash32(this.list.map((s) => s.signature).join(';'));
    }
    return this.hashCache;
  }

  reset(): void {
    this.list.length = 0;
    this.byName.clear();
    this.hashCache = -1;
  }
}

/** Process-wide registry. Both host and client register into this at import. */
export const schemaRegistry = new SchemaRegistry();

/** Declare and register in one step. */
export function registerSchema<S extends object>(schema: Schema<S>): Schema<S> {
  return schemaRegistry.register(schema);
}

/* -------------------------------------------------------------------------- */
/* Standalone helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Encode one state object to bytes. Convenience for tests and rare messages. */
export function encodeOne<S extends object>(schema: Schema<S>, state: S): Uint8Array {
  const w = new BitWriter({ capacity: Math.ceil(schema.maxBits / 8) + 8 });
  schema.encode(w, state, null);
  return w.toBytes();
}

export function decodeOne<S extends object>(schema: Schema<S>, bytes: Uint8Array): S {
  return schema.decode(new BitReader(bytes), null);
}
