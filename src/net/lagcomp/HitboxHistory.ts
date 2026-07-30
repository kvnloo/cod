/**
 * Lag compensation — the hitbox history ring.
 *
 * WHAT THIS IS
 * A fixed-size, fixed-layout circular buffer holding roughly one second of every
 * player's hitbox transforms, sampled once per server tick. When the host has to
 * answer "where was this player when the shooter pulled the trigger", this is
 * the only thing it consults.
 *
 * WHY IT LOOKS LIKE THIS
 * - **Structure of arrays, typed.** All state lives in a handful of typed arrays
 *   sized at construction. Steady-state recording and sampling perform zero
 *   allocations, so lag compensation never contributes to a GC pause — which
 *   would show up as a hitch on the host and desync everyone.
 * - **Memory is bounded up front.** capacity x players x boxes is decided once.
 *   Default 24 players x 18 boxes x ~66 ticks is about 1.1 MB. A 64-player
 *   dedicated server is a constructor argument, not a redesign.
 * - **Slots, not ids.** Players occupy an integer slot; the ring is indexed by
 *   slot. A generation counter per slot invalidates a departed player's history
 *   in O(1) so a reconnecting player can never be shot "in the past" as the
 *   person who used to own that slot.
 * - **Transforms only.** Part ids ride along in a Uint8Array; damage tables,
 *   materials and bone names live elsewhere. The ring stores the minimum needed
 *   to reconstruct geometry.
 *
 * Box record layout, 10 floats:
 *   [0..2] position, [3..5] half extents, [6..9] rotation quaternion (x,y,z,w)
 */

import type { Quat, Vec3 } from './types';
import { DEFAULT_LAGCOMP_CONFIG } from './types';
import { lerp, nlerpQuat } from './Geom';

/** Floats per stored hitbox. */
export const FLOATS_PER_BOX = 10;

const FLAG_VALID = 1;
const FLAG_ALIVE = 2;

/** One hitbox as an object, for callers that already have them in that shape. */
export interface HitboxSample {
  part: number;
  position: Vec3;
  halfExtents: Vec3;
  rotation: Quat;
}

export interface HitboxHistoryOptions {
  /** Hard cap on simultaneous tracked players. Default 24. */
  maxPlayers?: number;
  /** Hard cap on hitboxes per player. Default 18. */
  maxBoxes?: number;
  /** Rate the host records at, used to size the ring. Default 64. */
  tickRateHz?: number;
  /** Seconds of history to keep. Default from the lagcomp config (1.0s). */
  historySeconds?: number;
  /**
   * How many ticks either side of the bracket the sampler will probe for a
   * valid record before giving up. Covers recording hitches and just-spawned
   * players. Default 6.
   */
  probeTicks?: number;
}

export class HitboxHistory {
  readonly maxPlayers: number;
  readonly maxBoxes: number;
  readonly capacity: number;
  readonly tickRateHz: number;
  readonly probeTicks: number;

  /* ---- ring storage ---- */
  private readonly tickNumbers: Int32Array;
  private readonly tickTimes: Float64Array;
  private readonly flags: Uint8Array;
  private readonly gens: Uint32Array;
  private readonly counts: Uint8Array;
  /** cx, cy, cz, radius per (tick, player) — broadphase. */
  private readonly spheres: Float32Array;
  private readonly boxes: Float32Array;
  private readonly parts: Uint8Array;

  /* ---- slot bookkeeping ---- */
  private readonly slotGen: Uint32Array;
  private readonly slotPlayer: Int32Array;
  private readonly idToSlot = new Map<number, number>();

  /* ---- cursor ---- */
  private headTick = -1;
  private oldestTick = -1;
  private writeTickSlot = -1;

  /** Writes refused because of bad indices. Non-zero means a caller bug. */
  droppedWrites = 0;
  /** Ticks recorded since construction. */
  ticksRecorded = 0;

  /** Set by the last `sampleInto` / `sampleSphereInto` call. */
  lastSampleAlive = false;
  /** True when the last sample was clamped to the edge of the ring. */
  lastSampleClamped = false;
  /** Server time actually sampled by the last `sampleInto`. */
  lastSampleTimeSec = 0;

  /* ---- locate scratch (avoids returning an object) ---- */
  private _tickA = 0;
  private _tickB = 0;

  constructor(opts: HitboxHistoryOptions = {}) {
    this.maxPlayers = Math.max(1, opts.maxPlayers ?? 24);
    this.maxBoxes = Math.max(1, opts.maxBoxes ?? 18);
    this.tickRateHz = Math.max(1, opts.tickRateHz ?? 64);
    this.probeTicks = Math.max(0, opts.probeTicks ?? 6);
    const seconds = Math.max(0.05, opts.historySeconds ?? DEFAULT_LAGCOMP_CONFIG.historySeconds);
    // +2 so the newest tick being written never evicts the oldest one a shot
    // arriving this very tick might still need.
    this.capacity = Math.ceil(seconds * this.tickRateHz) + 2;

    const tp = this.capacity * this.maxPlayers;
    const tpb = tp * this.maxBoxes;

    this.tickNumbers = new Int32Array(this.capacity).fill(-1);
    this.tickTimes = new Float64Array(this.capacity);
    this.flags = new Uint8Array(tp);
    this.gens = new Uint32Array(tp);
    this.counts = new Uint8Array(tp);
    this.spheres = new Float32Array(tp * 4);
    this.boxes = new Float32Array(tpb * FLOATS_PER_BOX);
    this.parts = new Uint8Array(tpb);

    this.slotGen = new Uint32Array(this.maxPlayers);
    this.slotPlayer = new Int32Array(this.maxPlayers).fill(-1);
  }

  /** Total bytes held by the ring. Useful for the bandwidth/memory budget HUD. */
  get bytes(): number {
    return this.tickNumbers.byteLength + this.tickTimes.byteLength + this.flags.byteLength
      + this.gens.byteLength + this.counts.byteLength + this.spheres.byteLength
      + this.boxes.byteLength + this.parts.byteLength
      + this.slotGen.byteLength + this.slotPlayer.byteLength;
  }

  /** Seconds of history the ring can physically hold. */
  get windowSeconds(): number { return this.capacity / this.tickRateHz; }

  get newestTick(): number { return this.headTick; }
  get newestTimeSec(): number {
    return this.headTick < 0 ? 0 : this.tickTimes[this.slotForTick(this.headTick)];
  }
  get oldestValidTick(): number { return this.oldestTick; }
  get oldestTimeSec(): number {
    return this.oldestTick < 0 ? 0 : this.tickTimes[this.slotForTick(this.oldestTick)];
  }
  get tickCount(): number {
    return this.headTick < 0 ? 0 : this.headTick - this.oldestTick + 1;
  }

  /* ------------------------------------------------------------------ */
  /* Slots                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Reserve a slot for a player id. Idempotent for an id already present.
   * Returns the slot, or -1 when the ring is full.
   */
  acquireSlot(playerId: number): number {
    const existing = this.idToSlot.get(playerId);
    if (existing !== undefined) return existing;
    for (let s = 0; s < this.maxPlayers; s++) {
      if (this.slotPlayer[s] !== -1) continue;
      this.slotPlayer[s] = playerId;
      // Bumping the generation invalidates every record the previous occupant
      // left behind, without touching a byte of the ring.
      this.slotGen[s] = (this.slotGen[s] + 1) >>> 0;
      this.idToSlot.set(playerId, s);
      return s;
    }
    return -1;
  }

  releaseSlot(playerId: number): void {
    const s = this.idToSlot.get(playerId);
    if (s === undefined) return;
    this.idToSlot.delete(playerId);
    this.slotPlayer[s] = -1;
    this.slotGen[s] = (this.slotGen[s] + 1) >>> 0;
  }

  slotOf(playerId: number): number {
    const s = this.idToSlot.get(playerId);
    return s === undefined ? -1 : s;
  }

  playerIdAt(slot: number): number {
    return slot >= 0 && slot < this.maxPlayers ? this.slotPlayer[slot] : -1;
  }

  get activePlayerCount(): number { return this.idToSlot.size; }

  /* ------------------------------------------------------------------ */
  /* Recording                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Open a tick for writing. Must be called once per server tick, with a
   * strictly increasing tick number and a monotonic server time in seconds.
   *
   * A gap (the host skipped ticks) is filled with empty ticks carrying
   * interpolated times, which keeps the ring contiguous and lets the sampler
   * probe across the hole rather than falling off a cliff.
   */
  beginTick(tick: number, serverTimeSec: number): boolean {
    if (!Number.isFinite(tick) || !Number.isFinite(serverTimeSec)) { this.droppedWrites++; return false; }
    tick = tick | 0;

    if (this.headTick >= 0) {
      if (tick === this.headTick) {
        // Re-opening the current tick: clear it and carry on.
        this.writeTickSlot = this.slotForTick(tick);
        this.clearTickSlot(this.writeTickSlot, tick, serverTimeSec);
        return true;
      }
      if (tick < this.headTick) { this.droppedWrites++; return false; }

      const gap = tick - this.headTick;
      if (gap > 1) {
        const fill = Math.min(gap - 1, this.capacity - 1);
        const t0 = this.tickTimes[this.slotForTick(this.headTick)];
        const step = (serverTimeSec - t0) / gap;
        for (let i = gap - fill; i < gap; i++) {
          const gt = this.headTick + i;
          this.clearTickSlot(this.slotForTick(gt), gt, t0 + step * i);
        }
      }
    }

    this.writeTickSlot = this.slotForTick(tick);
    this.clearTickSlot(this.writeTickSlot, tick, serverTimeSec);
    this.headTick = tick;
    this.oldestTick = this.oldestTick < 0
      ? tick
      : Math.max(this.oldestTick, tick - this.capacity + 1);
    this.ticksRecorded++;
    return true;
  }

  /**
   * Write one hitbox into the open tick. Scalar arguments on purpose: callers
   * pull these straight out of their own bone matrices with no intermediate
   * object.
   */
  writeBox(
    slot: number, boxIndex: number, part: number,
    px: number, py: number, pz: number,
    hx: number, hy: number, hz: number,
    qx: number, qy: number, qz: number, qw: number,
  ): boolean {
    if (this.writeTickSlot < 0 || slot < 0 || slot >= this.maxPlayers
      || boxIndex < 0 || boxIndex >= this.maxBoxes) {
      this.droppedWrites++;
      return false;
    }
    const base = ((this.writeTickSlot * this.maxPlayers + slot) * this.maxBoxes + boxIndex);
    const o = base * FLOATS_PER_BOX;
    const b = this.boxes;
    b[o] = px; b[o + 1] = py; b[o + 2] = pz;
    b[o + 3] = hx; b[o + 4] = hy; b[o + 5] = hz;
    b[o + 6] = qx; b[o + 7] = qy; b[o + 8] = qz; b[o + 9] = qw;
    this.parts[base] = part & 0xff;
    return true;
  }

  /**
   * Close a player for the open tick. Computes the broadphase sphere and marks
   * the record valid; nothing written before this is visible to the sampler.
   */
  commitPlayer(slot: number, boxCount: number, alive = true): boolean {
    if (this.writeTickSlot < 0 || slot < 0 || slot >= this.maxPlayers) { this.droppedWrites++; return false; }
    const n = Math.min(boxCount, this.maxBoxes);
    const idx = this.writeTickSlot * this.maxPlayers + slot;
    if (n <= 0) {
      this.flags[idx] = 0;
      return false;
    }

    const b = this.boxes;
    const base0 = (idx * this.maxBoxes) * FLOATS_PER_BOX;

    // Pass 1: axis-aligned bounds over each box's own bounding sphere.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = base0 + i * FLOATS_PER_BOX;
      const hx = b[o + 3], hy = b[o + 4], hz = b[o + 5];
      const r = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const cx = b[o], cy = b[o + 1], cz = b[o + 2];
      if (cx - r < minX) minX = cx - r;
      if (cy - r < minY) minY = cy - r;
      if (cz - r < minZ) minZ = cz - r;
      if (cx + r > maxX) maxX = cx + r;
      if (cy + r > maxY) maxY = cy + r;
      if (cz + r > maxZ) maxZ = cz + r;
    }
    const sx = (minX + maxX) * 0.5, sy = (minY + maxY) * 0.5, sz = (minZ + maxZ) * 0.5;

    // Pass 2: tight radius about that centre.
    let rad = 0;
    for (let i = 0; i < n; i++) {
      const o = base0 + i * FLOATS_PER_BOX;
      const hx = b[o + 3], hy = b[o + 4], hz = b[o + 5];
      const r = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const dx = b[o] - sx, dy = b[o + 1] - sy, dz = b[o + 2] - sz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + r;
      if (d > rad) rad = d;
    }

    const so = idx * 4;
    this.spheres[so] = sx; this.spheres[so + 1] = sy; this.spheres[so + 2] = sz; this.spheres[so + 3] = rad;
    this.counts[idx] = n;
    this.gens[idx] = this.slotGen[slot];
    this.flags[idx] = FLAG_VALID | (alive ? FLAG_ALIVE : 0);
    return true;
  }

  /** Object-shaped convenience wrapper. Reads only; allocates nothing. */
  recordPlayer(slot: number, samples: readonly HitboxSample[], alive = true): boolean {
    const n = Math.min(samples.length, this.maxBoxes);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const p = s.position, h = s.halfExtents, q = s.rotation;
      this.writeBox(slot, i, s.part, p.x, p.y, p.z, h.x, h.y, h.z, q.x, q.y, q.z, q.w);
    }
    return this.commitPlayer(slot, n, alive);
  }

  /* ------------------------------------------------------------------ */
  /* Sampling                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Reconstruct a player's hitboxes at an arbitrary server time.
   *
   * Writes `count * FLOATS_PER_BOX` floats into `outBoxes` and, when supplied,
   * `count` part ids into `outParts`. Returns the box count, or -1 when the
   * player has no usable record near that time.
   *
   * The requested time almost never lands on a tick boundary, so the two
   * bracketing ticks are interpolated (positions and extents linearly, rotations
   * by shortest-arc nlerp). At 64 Hz a sprinting player covers ~9 cm per tick;
   * snapping to the nearest tick instead would throw away up to half of that,
   * which is the difference between a head and a miss at range.
   */
  sampleInto(
    slot: number, timeSec: number,
    outBoxes: Float32Array, outParts?: Uint8Array | null,
    boxOffset = 0, partOffset = 0,
    interpolate = true,
  ): number {
    this.lastSampleAlive = false;
    this.lastSampleClamped = false;
    this.lastSampleTimeSec = timeSec;
    if (slot < 0 || slot >= this.maxPlayers || this.headTick < 0 || !Number.isFinite(timeSec)) return -1;
    if (!this.locate(timeSec)) return -1;

    const ia = this.findValid(slot, this._tickA, -1);
    const ib = this.findValid(slot, this._tickB, +1);
    if (ia < 0 && ib < 0) return -1;

    if (ia < 0 || ib < 0 || ia === ib) {
      const only = ia < 0 ? ib : ia;
      this.copySingle(slot, only, outBoxes, outParts, boxOffset, partOffset);
      const idx = only * this.maxPlayers + slot;
      this.lastSampleAlive = (this.flags[idx] & FLAG_ALIVE) !== 0;
      return this.counts[idx];
    }

    const ta = this.tickTimes[ia];
    const tb = this.tickTimes[ib];
    let t = tb > ta ? (timeSec - ta) / (tb - ta) : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    if (!interpolate) t = t < 0.5 ? 0 : 1;

    const idxA = ia * this.maxPlayers + slot;
    const idxB = ib * this.maxPlayers + slot;
    const n = Math.min(this.counts[idxA], this.counts[idxB]);
    this.lastSampleAlive = ((t < 0.5 ? this.flags[idxA] : this.flags[idxB]) & FLAG_ALIVE) !== 0;

    const b = this.boxes;
    const baseA = idxA * this.maxBoxes * FLOATS_PER_BOX;
    const baseB = idxB * this.maxBoxes * FLOATS_PER_BOX;
    const partBaseA = idxA * this.maxBoxes;

    for (let i = 0; i < n; i++) {
      const oa = baseA + i * FLOATS_PER_BOX;
      const ob = baseB + i * FLOATS_PER_BOX;
      const oo = boxOffset + i * FLOATS_PER_BOX;
      outBoxes[oo] = lerp(b[oa], b[ob], t);
      outBoxes[oo + 1] = lerp(b[oa + 1], b[ob + 1], t);
      outBoxes[oo + 2] = lerp(b[oa + 2], b[ob + 2], t);
      outBoxes[oo + 3] = lerp(b[oa + 3], b[ob + 3], t);
      outBoxes[oo + 4] = lerp(b[oa + 4], b[ob + 4], t);
      outBoxes[oo + 5] = lerp(b[oa + 5], b[ob + 5], t);
      nlerpQuat(
        b[oa + 6], b[oa + 7], b[oa + 8], b[oa + 9],
        b[ob + 6], b[ob + 7], b[ob + 8], b[ob + 9],
        t, outBoxes, oo + 6,
      );
      if (outParts) outParts[partOffset + i] = this.parts[partBaseA + i];
    }
    return n;
  }

  /** Sample the newest recorded tick — "where the player actually is now". */
  presentInto(
    slot: number, outBoxes: Float32Array, outParts?: Uint8Array | null,
    boxOffset = 0, partOffset = 0,
  ): number {
    if (this.headTick < 0) return -1;
    return this.sampleInto(slot, this.newestTimeSec, outBoxes, outParts, boxOffset, partOffset, false);
  }

  /**
   * Broadphase sphere at a time. Writes cx, cy, cz, radius into `out`.
   * Deliberately conservative: the radius is the larger of the two brackets so
   * the sphere can never be smaller than the geometry it must contain.
   */
  sampleSphereInto(slot: number, timeSec: number, out: Float32Array, off = 0): boolean {
    if (slot < 0 || slot >= this.maxPlayers || this.headTick < 0 || !Number.isFinite(timeSec)) return false;
    if (!this.locate(timeSec)) return false;
    const ia = this.findValid(slot, this._tickA, -1);
    const ib = this.findValid(slot, this._tickB, +1);
    if (ia < 0 && ib < 0) return false;

    const s = this.spheres;
    if (ia < 0 || ib < 0 || ia === ib) {
      const o = ((ia < 0 ? ib : ia) * this.maxPlayers + slot) * 4;
      out[off] = s[o]; out[off + 1] = s[o + 1]; out[off + 2] = s[o + 2]; out[off + 3] = s[o + 3];
      return true;
    }
    const ta = this.tickTimes[ia];
    const tb = this.tickTimes[ib];
    let t = tb > ta ? (timeSec - ta) / (tb - ta) : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const oa = (ia * this.maxPlayers + slot) * 4;
    const ob = (ib * this.maxPlayers + slot) * 4;
    out[off] = lerp(s[oa], s[ob], t);
    out[off + 1] = lerp(s[oa + 1], s[ob + 1], t);
    out[off + 2] = lerp(s[oa + 2], s[ob + 2], t);
    out[off + 3] = Math.max(s[oa + 3], s[ob + 3]);
    return true;
  }

  /** True when the ring holds a usable record for this slot at this time. */
  hasRecordAt(slot: number, timeSec: number): boolean {
    if (slot < 0 || slot >= this.maxPlayers || this.headTick < 0) return false;
    if (!this.locate(timeSec)) return false;
    return this.findValid(slot, this._tickA, -1) >= 0 || this.findValid(slot, this._tickB, +1) >= 0;
  }

  /** Drop everything. Player slots and generations survive. */
  clear(): void {
    this.tickNumbers.fill(-1);
    this.flags.fill(0);
    this.headTick = -1;
    this.oldestTick = -1;
    this.writeTickSlot = -1;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private slotForTick(tick: number): number {
    const m = tick % this.capacity;
    return m < 0 ? m + this.capacity : m;
  }

  private clearTickSlot(ringSlot: number, tick: number, timeSec: number): void {
    this.tickNumbers[ringSlot] = tick;
    this.tickTimes[ringSlot] = timeSec;
    const base = ringSlot * this.maxPlayers;
    // Only the valid bits need clearing; the payload is overwritten on commit.
    this.flags.fill(0, base, base + this.maxPlayers);
  }

  /**
   * Find the two ring slots bracketing `timeSec`, into `_tickA` / `_tickB`.
   * Both are ring slot indices (not tick numbers). Sets `lastSampleClamped`
   * when the time fell outside the ring.
   */
  private locate(timeSec: number): boolean {
    if (this.headTick < 0) return false;
    const newest = this.headTick;
    const oldest = this.oldestTick;
    const sNew = this.slotForTick(newest);
    const sOld = this.slotForTick(oldest);
    const tNew = this.tickTimes[sNew];
    const tOld = this.tickTimes[sOld];

    if (timeSec >= tNew) {
      this._tickA = sNew; this._tickB = sNew;
      this.lastSampleClamped = timeSec > tNew;
      return true;
    }
    if (timeSec <= tOld || newest === oldest) {
      this._tickA = sOld; this._tickB = sOld;
      this.lastSampleClamped = timeSec < tOld;
      return true;
    }

    // Uniform tick rate ⇒ a division lands within a tick or two; fix up locally
    // instead of binary searching. Bounded either way.
    const span = newest - oldest;
    const dt = (tNew - tOld) / span;
    let g = oldest + Math.floor((timeSec - tOld) / (dt > 0 ? dt : 1));
    if (g < oldest) g = oldest;
    if (g > newest - 1) g = newest - 1;

    let guard = span + 2;
    while (g < newest - 1 && this.tickTimes[this.slotForTick(g + 1)] <= timeSec && guard-- > 0) g++;
    guard = span + 2;
    while (g > oldest && this.tickTimes[this.slotForTick(g)] > timeSec && guard-- > 0) g--;

    this._tickA = this.slotForTick(g);
    this._tickB = this.slotForTick(g + 1);
    return true;
  }

  /**
   * Walk from a ring slot in `dir` until a record valid for this slot turns up,
   * at most `probeTicks` steps. Returns a ring slot index or -1. This is what
   * makes a recording hitch or a mid-window spawn a graceful degradation rather
   * than a dropped shot.
   */
  private findValid(slot: number, ringSlot: number, dir: number): number {
    const startTick = this.tickNumbers[ringSlot];
    if (startTick < 0) return -1;
    const gen = this.slotGen[slot];
    for (let i = 0; i <= this.probeTicks; i++) {
      const tick = startTick + dir * i;
      if (tick < this.oldestTick || tick > this.headTick) break;
      const rs = this.slotForTick(tick);
      if (this.tickNumbers[rs] !== tick) break;
      const idx = rs * this.maxPlayers + slot;
      if ((this.flags[idx] & FLAG_VALID) !== 0 && this.gens[idx] === gen) return rs;
    }
    return -1;
  }

  private copySingle(
    slot: number, ringSlot: number,
    outBoxes: Float32Array, outParts: Uint8Array | null | undefined,
    boxOffset: number, partOffset: number,
  ): void {
    const idx = ringSlot * this.maxPlayers + slot;
    const n = this.counts[idx];
    const base = idx * this.maxBoxes * FLOATS_PER_BOX;
    const partBase = idx * this.maxBoxes;
    for (let i = 0; i < n * FLOATS_PER_BOX; i++) outBoxes[boxOffset + i] = this.boxes[base + i];
    if (outParts) for (let i = 0; i < n; i++) outParts[partOffset + i] = this.parts[partBase + i];
  }
}
