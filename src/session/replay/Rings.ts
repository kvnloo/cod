/**
 * Bounded storage for the four recorded tracks.
 *
 * Every track is a ring over pre-allocated typed arrays: capacity is decided
 * once, in seconds, and the recorder can never allocate again no matter how
 * long the match runs. That is the difference between a killcam buffer and a
 * memory leak with a camera attached.
 *
 * Layout is struct-of-arrays because the access pattern is columnar — the
 * killcam wants "every sample of actor 7 between t0 and t1", not "every field
 * of one sample".
 */

import {
  ACTOR, type ActorSample, type InputFrame, type ReplayEvent, type ReplayEventKind,
  dequantAxis, dequantPitch, dequantYaw, quantAxis, quantPitch, quantYaw,
} from './types';

/* ------------------------------------------------------------- input ring -- */

/** 14 bytes per recorded actor-frame. */
export const INPUT_FRAME_BYTES = 4 + 2 + 1 + 1 + 2 + 2 + 2;

export class InputRing {
  readonly capacity: number;
  private tick: Int32Array;
  private actor: Int16Array;
  private moveX: Int8Array;
  private moveY: Int8Array;
  private yaw: Int16Array;
  private pitch: Int16Array;
  private buttons: Uint16Array;
  /** Total frames ever pushed. `head - capacity` is the oldest live index. */
  private head = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    const c = this.capacity;
    this.tick = new Int32Array(c);
    this.actor = new Int16Array(c);
    this.moveX = new Int8Array(c);
    this.moveY = new Int8Array(c);
    this.yaw = new Int16Array(c);
    this.pitch = new Int16Array(c);
    this.buttons = new Uint16Array(c);
  }

  clear(): void { this.head = 0; }

  get length(): number { return Math.min(this.head, this.capacity); }
  get bytes(): number { return this.capacity * INPUT_FRAME_BYTES; }
  /** True once the ring has begun discarding the oldest frames. */
  get wrapped(): boolean { return this.head > this.capacity; }

  /** Quantises and stores. The caller must feed the sim the *dequantised* value. */
  push(f: InputFrame): void {
    const i = this.head % this.capacity;
    this.tick[i] = f.tick;
    this.actor[i] = f.actor;
    this.moveX[i] = quantAxis(f.moveX);
    this.moveY[i] = quantAxis(f.moveY);
    this.yaw[i] = quantYaw(f.yaw);
    this.pitch[i] = quantPitch(f.pitch);
    this.buttons[i] = f.buttons & 0xffff;
    this.head++;
  }

  /** Reads slot `k` of the live window (0 = oldest). */
  read(k: number, out: InputFrame): boolean {
    const n = this.length;
    if (k < 0 || k >= n) return false;
    const base = this.head - n;
    const i = (base + k) % this.capacity;
    out.tick = this.tick[i];
    out.actor = this.actor[i];
    out.moveX = dequantAxis(this.moveX[i]);
    out.moveY = dequantAxis(this.moveY[i]);
    out.yaw = dequantYaw(this.yaw[i]);
    out.pitch = dequantPitch(this.pitch[i]);
    out.buttons = this.buttons[i];
    return true;
  }

  get oldestTick(): number {
    const n = this.length;
    if (!n) return -1;
    return this.tick[(this.head - n) % this.capacity];
  }

  get newestTick(): number {
    const n = this.length;
    if (!n) return -1;
    return this.tick[(this.head - 1) % this.capacity];
  }

  /**
   * Index of the first live slot whose tick is >= `t`. Ticks are monotonic in
   * push order, so this is a binary search over the live window.
   */
  lowerBound(t: number): number {
    let lo = 0, hi = this.length;
    const base = this.head - this.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tick[(base + mid) % this.capacity] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Appends every frame stamped `tick` into `out` (cleared first). Returns the
   * count. Zero-allocation when `out` is reused and pre-sized.
   */
  collect(tick: number, out: InputFrame[], pool: InputFrame[]): number {
    out.length = 0;
    let k = this.lowerBound(tick);
    const n = this.length;
    while (k < n) {
      while (pool.length <= out.length) {
        pool.push({ tick: 0, actor: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0 });
      }
      const slot = pool[out.length];
      this.read(k, slot);
      if (slot.tick !== tick) break;
      out.push(slot);
      k++;
    }
    return out.length;
  }
}

/* ---------------------------------------------------------- snapshot ring -- */

/** 20 bytes per actor sample. */
export const ACTOR_SAMPLE_BYTES = 4 * 3 + 2 * 2 + 1 * 4;

/**
 * A fixed-stride grid of actor samples: `frames × maxActors`. Constant stride
 * means "actor slot j at frame i" is one multiply, which is what makes
 * interpolated playback cheap enough to run inside the render loop.
 */
export class SnapshotRing {
  readonly frames: number;
  readonly maxActors: number;
  private tick: Int32Array;
  private count: Uint8Array;
  private id: Int16Array;
  private pos: Float32Array;
  private yaw: Int16Array;
  private pitch: Int16Array;
  private health: Uint8Array;
  private flags: Uint8Array;
  private team: Uint8Array;
  private weapon: Uint8Array;
  private head = 0;

  constructor(frames: number, maxActors: number) {
    this.frames = Math.max(2, frames | 0);
    this.maxActors = Math.max(1, maxActors | 0);
    const n = this.frames * this.maxActors;
    this.tick = new Int32Array(this.frames);
    this.count = new Uint8Array(this.frames);
    this.id = new Int16Array(n);
    this.pos = new Float32Array(n * 3);
    this.yaw = new Int16Array(n);
    this.pitch = new Int16Array(n);
    this.health = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.team = new Uint8Array(n);
    this.weapon = new Uint8Array(n);
  }

  clear(): void { this.head = 0; }

  get length(): number { return Math.min(this.head, this.frames); }
  get bytes(): number {
    return this.frames * (4 + 1) + this.frames * this.maxActors * ACTOR_SAMPLE_BYTES;
  }

  push(tick: number, actors: readonly ActorSample[], n: number): void {
    const f = this.head % this.frames;
    const c = Math.min(n, this.maxActors);
    this.tick[f] = tick;
    this.count[f] = c;
    const base = f * this.maxActors;
    for (let j = 0; j < c; j++) {
      const a = actors[j];
      const i = base + j;
      this.id[i] = a.id;
      this.pos[i * 3] = a.x;
      this.pos[i * 3 + 1] = a.y;
      this.pos[i * 3 + 2] = a.z;
      this.yaw[i] = quantYaw(a.yaw);
      this.pitch[i] = quantPitch(a.pitch);
      this.health[i] = Math.max(0, Math.min(255, Math.round(a.health)));
      this.flags[i] = a.flags & 0xff;
      this.team[i] = a.team & 0xff;
      this.weapon[i] = a.weapon & 0xff;
    }
    this.head++;
  }

  frameTick(k: number): number {
    const n = this.length;
    if (k < 0 || k >= n) return -1;
    return this.tick[(this.head - n + k) % this.frames];
  }

  frameCount(k: number): number {
    const n = this.length;
    if (k < 0 || k >= n) return 0;
    return this.count[(this.head - n + k) % this.frames];
  }

  read(k: number, slot: number, out: ActorSample): boolean {
    const n = this.length;
    if (k < 0 || k >= n) return false;
    const f = (this.head - n + k) % this.frames;
    if (slot < 0 || slot >= this.count[f]) return false;
    const i = f * this.maxActors + slot;
    out.id = this.id[i];
    out.x = this.pos[i * 3];
    out.y = this.pos[i * 3 + 1];
    out.z = this.pos[i * 3 + 2];
    out.yaw = dequantYaw(this.yaw[i]);
    out.pitch = dequantPitch(this.pitch[i]);
    out.health = this.health[i];
    out.flags = this.flags[i];
    out.team = this.team[i];
    out.weapon = this.weapon[i];
    return true;
  }

  /** Finds actor `id` inside frame `k`. Returns the slot or -1. */
  slotOf(k: number, id: number): number {
    const n = this.length;
    if (k < 0 || k >= n) return -1;
    const f = (this.head - n + k) % this.frames;
    const c = this.count[f];
    const base = f * this.maxActors;
    for (let j = 0; j < c; j++) if (this.id[base + j] === id) return j;
    return -1;
  }

  /** Largest frame index whose tick is <= `t`, or -1 when `t` predates the ring. */
  frameAtOrBefore(t: number): number {
    const n = this.length;
    if (!n) return -1;
    let lo = 0, hi = n - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.frameTick(mid) <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  get oldestTick(): number { return this.length ? this.frameTick(0) : -1; }
  get newestTick(): number { return this.length ? this.frameTick(this.length - 1) : -1; }
}

/* --------------------------------------------------------- keyframe ring -- */

export interface KeyframeMeta {
  tick: number;
  hash: number;
  /** Index of the first input frame in the ring that belongs to this keyframe. */
  inputCursor: number;
}

/**
 * Full-state blobs. Every blob is the same length, so this is one flat
 * Float64Array — no per-keyframe allocation once the sim's state size is known.
 */
export class KeyframeRing {
  readonly capacity: number;
  private stride = 0;
  private data: Float64Array = new Float64Array(0);
  private meta: KeyframeMeta[] = [];
  private head = 0;

  constructor(capacity: number) { this.capacity = Math.max(1, capacity | 0); }

  clear(): void { this.head = 0; this.meta.length = 0; }

  get length(): number { return Math.min(this.head, this.capacity); }
  get bytes(): number { return this.stride * this.capacity * 8 + this.capacity * 24; }
  get blobSize(): number { return this.stride; }

  push(tick: number, blob: Float64Array, hash: number): void {
    if (this.stride === 0) {
      this.stride = blob.length;
      this.data = new Float64Array(this.stride * this.capacity);
    }
    if (blob.length !== this.stride) {
      throw new Error(`[replay] keyframe size changed ${this.stride} → ${blob.length}`);
    }
    const i = this.head % this.capacity;
    this.data.set(blob, i * this.stride);
    const m: KeyframeMeta = { tick, hash, inputCursor: 0 };
    if (this.meta.length < this.capacity) this.meta.push(m); else this.meta[i] = m;
    this.head++;
  }

  /** Copies keyframe `k` (0 = oldest live) into `out`. */
  read(k: number, out: Float64Array): boolean {
    const n = this.length;
    if (k < 0 || k >= n || this.stride === 0) return false;
    const i = (this.head - n + k) % this.capacity;
    out.set(this.data.subarray(i * this.stride, (i + 1) * this.stride));
    return true;
  }

  metaAt(k: number): KeyframeMeta | null {
    const n = this.length;
    if (k < 0 || k >= n) return null;
    return this.meta[(this.head - n + k) % this.capacity] ?? null;
  }

  /** Newest keyframe at or before `tick`, or -1. */
  indexAtOrBefore(tick: number): number {
    for (let k = this.length - 1; k >= 0; k--) {
      const m = this.metaAt(k);
      if (m && m.tick <= tick) return k;
    }
    return -1;
  }

  allocBlob(): Float64Array { return new Float64Array(this.stride); }
}

/* ------------------------------------------------------------- event ring -- */

const EVENT_KINDS: ReplayEventKind[] = [
  'kill', 'damage', 'shot', 'spawn', 'objective', 'phase', 'streak',
];

/** 4+1+2+2+12+4+1+1 = 27, padded to 28. */
export const EVENT_BYTES = 28;

export class EventRing {
  readonly capacity: number;
  private tick: Int32Array;
  private kind: Uint8Array;
  private a: Int16Array;
  private b: Int16Array;
  private pos: Float32Array;
  private n: Float32Array;
  private label: Uint8Array;
  private flags: Uint8Array;
  private head = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    const c = this.capacity;
    this.tick = new Int32Array(c);
    this.kind = new Uint8Array(c);
    this.a = new Int16Array(c);
    this.b = new Int16Array(c);
    this.pos = new Float32Array(c * 3);
    this.n = new Float32Array(c);
    this.label = new Uint8Array(c);
    this.flags = new Uint8Array(c);
  }

  clear(): void { this.head = 0; }
  get length(): number { return Math.min(this.head, this.capacity); }
  get bytes(): number { return this.capacity * EVENT_BYTES; }

  push(e: ReplayEvent): void {
    const i = this.head % this.capacity;
    this.tick[i] = e.tick;
    this.kind[i] = Math.max(0, EVENT_KINDS.indexOf(e.kind));
    this.a[i] = e.a;
    this.b[i] = e.b;
    this.pos[i * 3] = e.x;
    this.pos[i * 3 + 1] = e.y;
    this.pos[i * 3 + 2] = e.z;
    this.n[i] = e.n;
    this.label[i] = e.label & 0xff;
    this.flags[i] = e.flags & 0xff;
    this.head++;
  }

  read(k: number, out: ReplayEvent): boolean {
    const len = this.length;
    if (k < 0 || k >= len) return false;
    const i = (this.head - len + k) % this.capacity;
    out.tick = this.tick[i];
    out.kind = EVENT_KINDS[this.kind[i]] ?? 'kill';
    out.a = this.a[i];
    out.b = this.b[i];
    out.x = this.pos[i * 3];
    out.y = this.pos[i * 3 + 1];
    out.z = this.pos[i * 3 + 2];
    out.n = this.n[i];
    out.label = this.label[i];
    out.flags = this.flags[i];
    return true;
  }

  /**
   * Newest event matching a predicate, searched backwards. Used to answer
   * "which shot killed me" without scanning the whole match.
   */
  findLast(match: (e: ReplayEvent) => boolean, scratch: ReplayEvent): number {
    for (let k = this.length - 1; k >= 0; k--) {
      if (this.read(k, scratch) && match(scratch)) return k;
    }
    return -1;
  }
}

/** Convenience: does a sample have the alive bit? */
export function sampleAlive(flags: number): boolean { return (flags & ACTOR.alive) !== 0; }
