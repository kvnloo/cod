/**
 * Replication — shared vocabulary.
 *
 * Nothing in this module may import `three`, the DOM, or any browser API. The
 * whole point of the authority boundary is that this exact code runs unchanged
 * in a browser peer acting as host today and in a headless Node dedicated server
 * tomorrow. If you find yourself reaching for `window`, you are on the wrong
 * side of the line.
 */

/** Network entity id. Wire-encoded as a varuint; ids are recycled after a quarantine. */
export type EntityId = number;

/** Stable per-connection id assigned by the transport layer. */
export type ClientId = number;

/** Network tick number (NOT the 120 Hz simulation tick — see ReplicationHost). */
export type NetTick = number;

export interface Vec3Like { x: number; y: number; z: number }

/**
 * How a replicated field is encoded on the wire.
 *
 *  bool     1 bit.
 *  uint     `bits` wide, unsigned.
 *  int      `bits` wide, signed (stored biased).
 *  float32  raw IEEE bits — use only where precision genuinely matters.
 *  qfloat   quantized scalar over [min,max] with `step`.
 *  qvec3    three quantized scalars; delta-coded against the client baseline,
 *           which is what makes moving entities cost ~3 bytes instead of 12.
 *  qquat    smallest-three quaternion, 2 + 3x10 bits.
 */
export type FieldKind = 'bool' | 'uint' | 'int' | 'float32' | 'qfloat' | 'qvec3' | 'qquat';

export interface FieldDef {
  name: string;
  kind: FieldKind;
  /** uint/int only. */
  bits?: number;
  /** qfloat/qvec3 range. Defaults: qfloat 0..1, qvec3 +/-1024. */
  min?: number;
  max?: number;
  /** qfloat/qvec3 quantization step. Default 0.01. */
  step?: number;
  /**
   * Detail tier this field survives to. An entity is assigned a LOD 0..3 by
   * interest management (0 = right in front of you). The field is sent when
   * `entityLod <= maxLod`. Default 3 (always sent).
   *
   * Use 1 for cosmetic-only data (anim phase, lean), 2 for things that matter
   * at mid range (velocity, armour), 3 for anything gameplay-critical.
   */
  maxLod?: number;
  /** Instrumentation bucket. Defaults to the field name. */
  group?: string;
}

export interface EntityClassDef {
  name: string;
  fields: FieldDef[];
  /** Relative importance before distance/staleness weighting. Default 1. */
  basePriority?: number;
  /** Bypasses the spatial cull entirely — objectives, game state, score. */
  alwaysRelevant?: boolean;
  /** Name of the qvec3 field that feeds interest management. */
  positionField?: string;
}

/**
 * Per-word wire codec.
 *  Bits        — fixed-width unsigned field of `bits`, value stored biased.
 *  DeltaVarint — zigzag varint of (value - baselineValue).
 */
export const WordMode = { Bits: 0, DeltaVarint: 1 } as const;
export type WordMode = (typeof WordMode)[keyof typeof WordMode];

export interface WordCodec {
  mode: WordMode;
  bits: number;
  /** Added before writing, subtracted after reading (Bits mode only). */
  bias: number;
}

export interface CompiledField {
  name: string;
  kind: FieldKind;
  /** Index of this field within its class — this is the mask bit index. */
  index: number;
  /** First word of this field in the entity word array. */
  wordOffset: number;
  wordCount: number;
  words: WordCodec[];
  maxLod: number;
  group: string;
  /** Quantization parameters, meaningful for qfloat/qvec3. */
  step: number;
  min: number;
  /** Worst-case encoded size in bits, used for budget pre-checks. */
  maxBits: number;
}

export interface CompiledClass {
  id: number;
  name: string;
  fields: CompiledField[];
  fieldIndex: Map<string, number>;
  wordCount: number;
  basePriority: number;
  alwaysRelevant: boolean;
  /** Word offset of the position vector, or -1. */
  positionWord: number;
  positionStep: number;
  /** Worst-case bits for a full (spawn) update, excluding the entity id. */
  maxBodyBits: number;
}

/**
 * A game-side object that knows how to publish its authoritative state.
 *
 * Implement this on whatever already owns the state (the AI agent, the
 * projectile, the objective). The replicator never owns simulation data, it only
 * samples it once per network tick.
 */
export interface ReplicationSource {
  sample(w: EntityStateWriterLike): void;
}

/** The subset of EntityStateWriter a ReplicationSource is allowed to touch. */
export interface EntityStateWriterLike {
  bool(field: number, v: boolean): void;
  uint(field: number, v: number): void;
  int(field: number, v: number): void;
  float(field: number, v: number): void;
  qfloat(field: number, v: number): void;
  vec3(field: number, x: number, y: number, z: number): void;
  quat(field: number, x: number, y: number, z: number, w: number): void;
  /** Field index by name for the bound class. Throws if unknown. */
  f(name: string): number;
}

/** Why an entity disappeared from a client's view. */
export const LEAVE_OUT_OF_INTEREST = 0;
export const LEAVE_DESTROYED = 1;
