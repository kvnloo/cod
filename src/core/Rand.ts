/**
 * Deterministic RNG. Every gameplay/VFX system must draw from a seeded stream so
 * capture runs are byte-reproducible frame to frame.
 */

/** xoshiro128** — fast, good statistical quality, 128-bit state. */
export class Rand {
  private s0 = 0; private s1 = 0; private s2 = 0; private s3 = 0;

  constructor(seed: number | string = 1337) {
    this.seed(seed);
  }

  seed(seed: number | string): void {
    let h = typeof seed === 'string' ? hashString(seed) : (seed >>> 0) || 1;
    // splitmix32 to expand the seed into 128 bits.
    const next = () => {
      h = (h + 0x9e3779b9) | 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform uint32. */
  u32(): number {
    const r = (Math.imul(this.s1 * 5, 1) >>> 0);
    const result = (((r << 7) | (r >>> 25)) * 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0; this.s3 ^= this.s1;
    this.s1 ^= this.s2; this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result;
  }

  /** Uniform in [0,1). */
  next(): number { return this.u32() / 4294967296; }
  /** Uniform in [min,max). */
  range(min: number, max: number): number { return min + this.next() * (max - min); }
  /** Uniform integer in [min,max]. */
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  /** Uniform in [-1,1]. */
  signed(): number { return this.next() * 2 - 1; }
  bool(p = 0.5): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }

  /** Box–Muller normal, mean 0 stddev 1. */
  normal(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Uniform point in a unit disc — used for spread cones and bokeh. */
  disc(out: { x: number; y: number }): void {
    const r = Math.sqrt(this.next());
    const a = this.next() * Math.PI * 2;
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  fork(tag: string): Rand { return new Rand(this.u32() ^ hashString(tag)); }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Global gameplay stream. Seeded from the URL in capture mode. */
export const rng = new Rand(
  Number(new URLSearchParams(globalThis.location?.search ?? '').get('seed')) || 1337,
);
