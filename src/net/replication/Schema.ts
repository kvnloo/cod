/**
 * Field schemas.
 *
 * A replicated entity is a flat array of 32-bit *quantized* words. Quantizing at
 * capture time (rather than at send time) is the single most important decision
 * in this file: it means "has this field changed" is an exact integer compare,
 * so a position that jitters by 0.0001 m does not burn bandwidth every tick, and
 * every client that decodes a word gets bit-identical values.
 *
 * Class ids are assigned in definition order, so host and client MUST build
 * their registry with the same calls. Use `defineDefaultClasses()` on both ends.
 */

import { BitReader, BitWriter, bitsForValues, clampInt, packQuat, quantize, unpackQuat } from './Bits';
import type { CompiledClass, CompiledField, EntityClassDef, FieldDef, WordCodec } from './types';
import { WordMode } from './types';

const VARINT_MAX_BITS = 40;

function compileField(def: FieldDef, index: number, wordOffset: number): CompiledField {
  const words: WordCodec[] = [];
  const step = def.step ?? 0.01;
  const min = def.min ?? 0;
  switch (def.kind) {
    case 'bool':
      words.push({ mode: WordMode.Bits, bits: 1, bias: 0 });
      break;
    case 'uint': {
      const bits = def.bits ?? 8;
      words.push({ mode: WordMode.Bits, bits, bias: 0 });
      break;
    }
    case 'int': {
      const bits = def.bits ?? 8;
      words.push({ mode: WordMode.Bits, bits, bias: 1 << (bits - 1) });
      break;
    }
    case 'float32':
      words.push({ mode: WordMode.Bits, bits: 32, bias: 0 });
      break;
    case 'qfloat': {
      const max = def.max ?? 1;
      const levels = Math.max(2, Math.floor((max - min) / step) + 1);
      words.push({ mode: WordMode.Bits, bits: bitsForValues(levels), bias: 0 });
      break;
    }
    case 'qvec3':
      // Delta-coded: a walking player moves ~0.05 m per net tick, which is one
      // varint byte per axis instead of three.
      for (let i = 0; i < 3; i++) words.push({ mode: WordMode.DeltaVarint, bits: 32, bias: 0 });
      break;
    case 'qquat':
      words.push({ mode: WordMode.Bits, bits: 2, bias: 0 });
      for (let i = 0; i < 3; i++) words.push({ mode: WordMode.Bits, bits: 10, bias: 0 });
      break;
  }
  let maxBits = 0;
  for (const w of words) maxBits += w.mode === WordMode.DeltaVarint ? VARINT_MAX_BITS : w.bits;
  return {
    name: def.name,
    kind: def.kind,
    index,
    wordOffset,
    wordCount: words.length,
    words,
    maxLod: def.maxLod ?? 3,
    group: def.group ?? def.name,
    step,
    min,
    maxBits,
  };
}

export function compileClass(def: EntityClassDef, id: number): CompiledClass {
  if (def.fields.length > 32) {
    throw new Error(`[Schema] class "${def.name}" has ${def.fields.length} fields; the dirty mask is 32 bits wide`);
  }
  const fields: CompiledField[] = [];
  const fieldIndex = new Map<string, number>();
  let wordOffset = 0;
  let maxBodyBits = 0;
  for (let i = 0; i < def.fields.length; i++) {
    const f = compileField(def.fields[i], i, wordOffset);
    if (fieldIndex.has(f.name)) throw new Error(`[Schema] duplicate field "${f.name}" on class "${def.name}"`);
    fieldIndex.set(f.name, i);
    fields.push(f);
    wordOffset += f.wordCount;
    maxBodyBits += f.maxBits;
  }
  let positionWord = -1;
  let positionStep = 0.01;
  if (def.positionField) {
    const idx = fieldIndex.get(def.positionField);
    if (idx === undefined) throw new Error(`[Schema] class "${def.name}" positionField "${def.positionField}" not found`);
    const pf = fields[idx];
    if (pf.kind !== 'qvec3') throw new Error(`[Schema] positionField "${pf.name}" must be a qvec3`);
    if (pf.maxLod !== 3) throw new Error(`[Schema] positionField "${pf.name}" must have maxLod 3 — it can never be LOD-culled`);
    positionWord = pf.wordOffset;
    positionStep = pf.step;
  }
  // + class id varuint + mask + new/id bits, generously rounded.
  maxBodyBits += 32 + def.fields.length + 8;
  return {
    id,
    name: def.name,
    fields,
    fieldIndex,
    wordCount: wordOffset,
    basePriority: def.basePriority ?? 1,
    alwaysRelevant: def.alwaysRelevant ?? false,
    positionWord,
    positionStep,
    maxBodyBits,
  };
}

export class SchemaRegistry {
  private classes: CompiledClass[] = [];
  private byName = new Map<string, CompiledClass>();

  define(def: EntityClassDef): CompiledClass {
    if (this.byName.has(def.name)) throw new Error(`[Schema] duplicate class "${def.name}"`);
    const cls = compileClass(def, this.classes.length);
    this.classes.push(cls);
    this.byName.set(def.name, cls);
    return cls;
  }

  get(id: number): CompiledClass {
    const c = this.classes[id];
    if (!c) throw new Error(`[Schema] unknown class id ${id}`);
    return c;
  }

  tryGet(id: number): CompiledClass | undefined { return this.classes[id]; }
  named(name: string): CompiledClass {
    const c = this.byName.get(name);
    if (!c) throw new Error(`[Schema] unknown class "${name}"`);
    return c;
  }
  has(name: string): boolean { return this.byName.has(name); }
  get count(): number { return this.classes.length; }
  /** Order-sensitive fingerprint — host and client must agree before play. */
  hash(): number {
    let h = 2166136261 >>> 0;
    for (const c of this.classes) {
      for (const ch of c.name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      for (const f of c.fields) {
        h ^= f.index * 131 + f.maxBits * 7 + f.wordCount;
        h = Math.imul(h, 16777619);
      }
    }
    return h >>> 0;
  }
}

/* ------------------------------------------------------------------ codecs */

/** Writes one field. `base` may be null for a spawn (implicit all-zero baseline). */
export function writeField(w: BitWriter, f: CompiledField, cur: Int32Array, base: Int32Array | null): void {
  for (let i = 0; i < f.wordCount; i++) {
    const wc = f.words[i];
    const o = f.wordOffset + i;
    if (wc.mode === WordMode.DeltaVarint) {
      w.writeVarInt((cur[o] - (base ? base[o] : 0)) | 0);
    } else {
      w.writeBits((cur[o] + wc.bias) >>> 0, wc.bits);
    }
  }
}

/** Reads one field into `words`, which must already hold the baseline values. */
export function readField(r: BitReader, f: CompiledField, words: Int32Array): void {
  for (let i = 0; i < f.wordCount; i++) {
    const wc = f.words[i];
    const o = f.wordOffset + i;
    if (wc.mode === WordMode.DeltaVarint) {
      words[o] = (words[o] + r.readVarInt()) | 0;
    } else {
      words[o] = (r.readBits(wc.bits) - wc.bias) | 0;
    }
  }
}

/* ------------------------------------------------------- value accessors */

export function encodeScalar(f: CompiledField, v: number): number {
  switch (f.kind) {
    case 'bool': return v ? 1 : 0;
    case 'uint': return clampInt(Math.round(v), 0, (Math.pow(2, f.words[0].bits) - 1)) | 0;
    case 'int': {
      const bits = f.words[0].bits;
      return clampInt(Math.round(v), -(1 << (bits - 1)), (1 << (bits - 1)) - 1) | 0;
    }
    case 'qfloat': {
      const levels = (1 << f.words[0].bits) - 1;
      return clampInt(quantize(v - f.min, f.step), 0, levels) | 0;
    }
    default: return Math.round(v) | 0;
  }
}

export function decodeScalar(f: CompiledField, q: number): number {
  switch (f.kind) {
    case 'bool': return q ? 1 : 0;
    case 'qfloat': return f.min + q * f.step;
    default: return q;
  }
}

export function getNumber(f: CompiledField, words: Int32Array): number {
  return decodeScalar(f, words[f.wordOffset]);
}

export function getBool(f: CompiledField, words: Int32Array): boolean {
  return words[f.wordOffset] !== 0;
}

export function getVec3(f: CompiledField, words: Int32Array, out: { x: number; y: number; z: number }): void {
  const o = f.wordOffset;
  out.x = words[o] * f.step;
  out.y = words[o + 1] * f.step;
  out.z = words[o + 2] * f.step;
}

export function getQuat(f: CompiledField, words: Int32Array, out: { x: number; y: number; z: number; w: number }): void {
  unpackQuat(words, f.wordOffset, out);
}

export { packQuat, unpackQuat };

/* ------------------------------------------------------- default classes */

/** Bit flags packed into the player/agent `flags` field. */
export const NetFlag = {
  Firing: 1 << 0,
  Ads: 1 << 1,
  Sprinting: 1 << 2,
  Crouched: 1 << 3,
  Prone: 1 << 4,
  Reloading: 1 << 5,
  Dead: 1 << 6,
  Airborne: 1 << 7,
} as const;

export const CLASS = {
  Player: 'player',
  Agent: 'agent',
  Projectile: 'projectile',
  Pickup: 'pickup',
  Objective: 'objective',
  Prop: 'prop',
} as const;

const YAW_STEP = 0.0015;   // ~0.09 degrees
const PITCH_STEP = 0.0015;

/**
 * The shipping schema. Both ends of the wire call this; the registry hash is
 * exchanged at connect so a version mismatch fails loudly instead of decoding
 * garbage.
 */
export function defineDefaultClasses(reg: SchemaRegistry): SchemaRegistry {
  reg.define({
    name: CLASS.Player,
    basePriority: 10,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.01, max: 2048, group: 'transform' },
      { name: 'vel', kind: 'qvec3', step: 0.02, max: 128, maxLod: 2, group: 'transform' },
      { name: 'yaw', kind: 'qfloat', min: -Math.PI, max: Math.PI, step: YAW_STEP, group: 'aim' },
      { name: 'pitch', kind: 'qfloat', min: -1.6, max: 1.6, step: PITCH_STEP, group: 'aim' },
      { name: 'flags', kind: 'uint', bits: 8, group: 'state' },
      { name: 'moveState', kind: 'uint', bits: 4, group: 'state' },
      { name: 'weapon', kind: 'uint', bits: 8, group: 'state' },
      { name: 'health', kind: 'uint', bits: 8, group: 'vitals' },
      { name: 'armor', kind: 'uint', bits: 8, maxLod: 2, group: 'vitals' },
      { name: 'team', kind: 'uint', bits: 3, group: 'state' },
      { name: 'animPhase', kind: 'qfloat', min: 0, max: 1, step: 1 / 255, maxLod: 1, group: 'cosmetic' },
      { name: 'lean', kind: 'qfloat', min: -1, max: 1, step: 1 / 127, maxLod: 1, group: 'cosmetic' },
    ],
  });

  reg.define({
    name: CLASS.Agent,
    basePriority: 6,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.02, max: 2048, group: 'transform' },
      { name: 'vel', kind: 'qvec3', step: 0.05, max: 128, maxLod: 2, group: 'transform' },
      { name: 'yaw', kind: 'qfloat', min: -Math.PI, max: Math.PI, step: 0.006, group: 'aim' },
      { name: 'pitch', kind: 'qfloat', min: -1.6, max: 1.6, step: 0.012, maxLod: 2, group: 'aim' },
      { name: 'flags', kind: 'uint', bits: 8, group: 'state' },
      { name: 'archetype', kind: 'uint', bits: 6, group: 'state' },
      { name: 'health', kind: 'uint', bits: 8, group: 'vitals' },
      { name: 'team', kind: 'uint', bits: 3, group: 'state' },
      { name: 'animPhase', kind: 'qfloat', min: 0, max: 1, step: 1 / 255, maxLod: 1, group: 'cosmetic' },
    ],
  });

  reg.define({
    name: CLASS.Projectile,
    basePriority: 8,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.02, max: 2048, group: 'transform' },
      { name: 'vel', kind: 'qvec3', step: 0.05, max: 512, maxLod: 2, group: 'transform' },
      { name: 'kind', kind: 'uint', bits: 6, group: 'state' },
      { name: 'owner', kind: 'uint', bits: 16, group: 'state' },
      { name: 'fuse', kind: 'qfloat', min: 0, max: 12, step: 0.05, maxLod: 2, group: 'state' },
    ],
  });

  reg.define({
    name: CLASS.Pickup,
    basePriority: 2,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.05, max: 2048, group: 'transform' },
      { name: 'kind', kind: 'uint', bits: 8, group: 'state' },
      { name: 'state', kind: 'uint', bits: 2, group: 'state' },
      { name: 'respawnIn', kind: 'qfloat', min: 0, max: 60, step: 0.25, maxLod: 2, group: 'state' },
    ],
  });

  reg.define({
    name: CLASS.Objective,
    basePriority: 40,
    alwaysRelevant: true,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.1, max: 2048, group: 'transform' },
      { name: 'progress', kind: 'qfloat', min: 0, max: 1, step: 1 / 255, group: 'objective' },
      { name: 'owningTeam', kind: 'uint', bits: 3, group: 'objective' },
      { name: 'contested', kind: 'bool', group: 'objective' },
      { name: 'state', kind: 'uint', bits: 4, group: 'objective' },
    ],
  });

  reg.define({
    name: CLASS.Prop,
    basePriority: 3,
    positionField: 'pos',
    fields: [
      { name: 'pos', kind: 'qvec3', step: 0.02, max: 2048, group: 'transform' },
      { name: 'rot', kind: 'qquat', maxLod: 2, group: 'transform' },
      { name: 'state', kind: 'uint', bits: 4, group: 'state' },
      { name: 'health', kind: 'uint', bits: 8, maxLod: 2, group: 'vitals' },
    ],
  });

  return reg;
}

/** Convenience: a fresh registry with the shipping classes already defined. */
export function createDefaultRegistry(): SchemaRegistry {
  return defineDefaultClasses(new SchemaRegistry());
}
