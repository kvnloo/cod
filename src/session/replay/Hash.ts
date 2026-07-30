/**
 * State hashing for determinism checks.
 *
 * Floats are quantised before they are mixed, so a run that differs only by the
 * last bit of a float — which no player can perceive and which a different
 * JIT tier can legitimately produce — does not report as a divergence, while a
 * real drift of a millimetre does. That threshold is a choice, and it is the
 * same one `MatchLog` in `src/game/Replay.ts` already makes.
 */

const OFFSET = 2166136261 >>> 0;
const PRIME = 16777619;

/** FNV-1a over 32-bit words. Stateful so a whole sim can be streamed in. */
export class StateHash {
  private h = OFFSET;

  reset(): this { this.h = OFFSET; return this; }

  u32(v: number): this {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, PRIME) >>> 0;
      x >>>= 8;
    }
    return this;
  }

  /** Quantised float. `scale` 1000 → millimetre / milliradian resolution. */
  f(v: number, scale = 1000): this {
    // Guard against NaN/Infinity poisoning the hash silently — they are bugs.
    if (!Number.isFinite(v)) return this.u32(0x7fc00000);
    const q = Math.round(v * scale);
    // Split so values beyond 2^31 still contribute.
    this.u32(q | 0);
    this.u32(Math.floor(q / 4294967296) | 0);
    return this;
  }

  str(s: string): this {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i));
    return this;
  }

  blob(b: Float64Array, scale = 1000): this {
    this.u32(b.length);
    for (let i = 0; i < b.length; i++) this.f(b[i], scale);
    return this;
  }

  get value(): number { return this.h >>> 0; }

  hex(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}

/** One-shot hash of a state blob. */
export function hashBlob(b: Float64Array, scale = 1000): number {
  return new StateHash().blob(b, scale).value;
}

export function hex32(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

/**
 * Interned string table. Recorded events reference weapons and objectives by
 * index so the ring buffers stay numeric and the byte cost stays predictable.
 */
export class StringTable {
  private list: string[] = [''];
  private map = new Map<string, number>([['', 0]]);

  intern(s: string): number {
    const hit = this.map.get(s);
    if (hit !== undefined) return hit;
    const i = this.list.length;
    this.list.push(s);
    this.map.set(s, i);
    return i;
  }

  get(i: number): string { return this.list[i] ?? ''; }
  get size(): number { return this.list.length; }
  toArray(): string[] { return this.list.slice(); }

  static from(list: readonly string[]): StringTable {
    const t = new StringTable();
    t.list = list.slice();
    if (t.list.length === 0 || t.list[0] !== '') t.list.unshift('');
    t.map = new Map(t.list.map((s, i) => [s, i]));
    return t;
  }

  /** Approximate resident bytes (UTF-16). */
  get bytes(): number {
    let n = 0;
    for (const s of this.list) n += s.length * 2 + 16;
    return n;
  }
}
