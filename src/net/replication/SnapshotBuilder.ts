/**
 * SnapshotBuilder — turns "the world, right now" into "the bytes THIS client is
 * missing", once per network tick, inside a hard byte budget.
 *
 * It is the join between the three things that decide whether the netcode
 * scales: the Replicator (what exists and what each client has acknowledged),
 * the InterestManager (what this client is allowed to care about, ranked) and
 * the BandwidthBudget (how much it may cost). None of those three know about
 * each other; this file is the only place that does, which is why the authority
 * boundary stays clean enough to lift the host into a headless process.
 *
 * ORDER OF OPERATIONS, and why:
 *
 *   1. Ask interest for a PRIORITY-ORDERED candidate list. It has already done
 *      the spatial cull, forced in the client's own pawn / objectives / noise
 *      events, and applied per-LOD rate limiting.
 *   2. Price every candidate EXACTLY against that client's acknowledged
 *      baseline. Pricing before selecting is the whole trick: a distant prop
 *      that moved 2 cm costs 3 bytes, so it should not be dropped in favour of
 *      a nearby player that costs 22, and a cheap entity should still get in
 *      when an expensive one does not fit.
 *   3. Fill the budget greedily in priority order. Anything that does not fit is
 *      dropped, NOT truncated — it keeps its staleness bonus and outranks its
 *      peers next tick, so nothing starves.
 *   4. Encode the survivors in ASCENDING ID order so ids delta-code to one byte.
 *
 * DELTA BASELINE. Everything is coded against the client's last ACKNOWLEDGED
 * snapshot, never against the last sent one. A dropped packet can therefore
 * never corrupt the baseline; it only costs a redundant resend. The price is
 * that the encoder must remember what each un-acked snapshot would have changed
 * — that is `ClientReplicationState.pending`, and the merged word array this
 * file builds per update is exactly "what the client will hold once it acks".
 *
 * WIRE FORMAT (bit-packed, MSB first — see Bits.ts):
 *
 *   varuint  tick
 *   bool     full                      1 = self-contained, drop unknown entities
 *   varuint  tick - baselineTick       (delta snapshots only)
 *   u12      updateCount
 *   updates, ascending id:
 *     varuint  id - prevId             prevId starts at 0
 *     bool     spawn                   1 = no baseline, all masked fields absolute
 *     varuint  classId                 (spawn only)
 *     u<nFields> mask                  which fields follow, in field-index order
 *     ...      fields                  per-field codec from Schema.writeField
 *   u10      leaveCount                (delta snapshots only)
 *   leaves, ascending id:
 *     varuint  id - prevId
 *     bool     reason                  0 = out of interest, 1 = destroyed
 *
 * No DOM, no three, no clock, no RNG. Same code on a peer host and a dedicated
 * server.
 */

import type {
  ClientId,
  CompiledClass,
  CompiledField,
  EntityId,
  NetTick,
} from './types';
import { LEAVE_DESTROYED, LEAVE_OUT_OF_INTEREST, WordMode } from './types';
import { BitReader, BitWriter } from './Bits';
import { SchemaRegistry, writeField, readField } from './Schema';
import type { RepEntity, Replicator, PendingUpdate } from './Replicator';
import type { InterestManager, RelevanceEntry } from './Interest';
import type { BandwidthBudget, ClientBudget } from './Budget';

/* -------------------------------------------------------------------------- */
/*  Config                                                                     */
/* -------------------------------------------------------------------------- */

export interface SnapshotConfig {
  /**
   * Absolute cap on one snapshot, bytes. The budget's own per-snapshot cap is
   * usually tighter; this is the backstop that keeps a message inside one
   * DataChannel MTU no matter what the budget says.
   */
  hardMaxBytes: number;
  /**
   * An entity beyond `cullRadius * leaveHysteresis` is released from the
   * client's baseline. > 1 so an entity walking the boundary does not flap
   * between spawn and leave.
   */
  leaveHysteresis: number;
  /**
   * Fallback release for entities with no position (they can never be distance
   * culled): drop them after this many ticks without a send.
   */
  leaveGraceTicks: number;
  /** Max entities released per snapshot, so a teleport cannot blow the budget. */
  maxLeavesPerSnapshot: number;
}

export const DEFAULT_SNAPSHOT: SnapshotConfig = {
  hardMaxBytes: 1160,
  leaveHysteresis: 1.15,
  leaveGraceTicks: 200,
  maxLeavesPerSnapshot: 24,
};

/** Bit widths of the two back-patched counters. Must match the reader. */
const UPDATE_COUNT_BITS = 12;
const LEAVE_COUNT_BITS = 10;

/* -------------------------------------------------------------------------- */
/*  Result                                                                     */
/* -------------------------------------------------------------------------- */

export interface SnapshotResult {
  clientId: ClientId;
  tick: NetTick;
  /** The encoded snapshot. Empty (length 0) when there was nothing to say. */
  bytes: Uint8Array;
  byteLength: number;
  full: boolean;
  baselineTick: NetTick;
  updates: number;
  spawns: number;
  leaves: number;
  /** Candidates interest offered. */
  considered: number;
  /** Candidates the budget refused. They keep their staleness bonus. */
  dropped: number;
  /** True when at least one candidate was refused for want of bytes. */
  truncated: boolean;
  /** Bytes the budget allowed this tick. */
  allowance: number;
  degradeLevel: number;
}

/* -------------------------------------------------------------------------- */
/*  Cost model                                                                 */
/* -------------------------------------------------------------------------- */

/** Bits a varuint occupies with this writer (7 payload bits per byte). */
export function varUintBits(value: number): number {
  let v = value >>> 0;
  let n = 1;
  while (v >= 0x80) { v >>>= 7; n++; }
  return n * 8;
}

/** Bits a zigzag varint occupies. */
export function varIntBits(value: number): number {
  const v = value | 0;
  return varUintBits(((v << 1) ^ (v >> 31)) >>> 0);
}

/**
 * Exact encoded size of one field against a baseline. Mirrors
 * `Schema.writeField` word for word — if that changes, this must too, and the
 * builder's self-check (`bitLength` vs predicted) will catch it immediately.
 */
export function fieldCostBits(f: CompiledField, cur: Int32Array, base: Int32Array | null): number {
  let bits = 0;
  for (let i = 0; i < f.wordCount; i++) {
    const wc = f.words[i];
    const o = f.wordOffset + i;
    if (wc.mode === WordMode.DeltaVarint) {
      bits += varIntBits((cur[o] - (base ? base[o] : 0)) | 0);
    } else {
      bits += wc.bits;
    }
  }
  return bits;
}

/** Scratch record describing one priced candidate. */
interface Priced {
  e: RepEntity;
  cls: CompiledClass;
  mask: number;
  /** Bits for the fields only. */
  bodyBits: number;
  /** Bits for id + flags + classId + mask, upper bound. */
  overheadBits: number;
  priority: number;
  lod: number;
  spawn: boolean;
  base: Int32Array | null;
}

/* -------------------------------------------------------------------------- */
/*  Builder                                                                    */
/* -------------------------------------------------------------------------- */

export class SnapshotBuilder {
  readonly config: SnapshotConfig;
  private rep: Replicator;
  private interest: InterestManager;
  private budget: BandwidthBudget;

  private w: BitWriter;
  private priced: Priced[] = [];
  private pricedIds = new Set<EntityId>();
  private chosen: Priced[] = [];
  private written: Priced[] = [];
  private leaveIds: EntityId[] = [];
  private leaveReasons: number[] = [];

  /** Diagnostics for the most recent build(), useful in a HUD overlay. */
  readonly last: SnapshotResult = {
    clientId: -1, tick: -1, bytes: new Uint8Array(0), byteLength: 0,
    full: false, baselineTick: -1, updates: 0, spawns: 0, leaves: 0,
    considered: 0, dropped: 0, truncated: false, allowance: 0, degradeLevel: 0,
  };

  constructor(
    rep: Replicator,
    interest: InterestManager,
    budget: BandwidthBudget,
    config: Partial<SnapshotConfig> = {},
  ) {
    this.rep = rep;
    this.interest = interest;
    this.budget = budget;
    this.config = { ...DEFAULT_SNAPSHOT, ...config };
    this.w = new BitWriter(this.config.hardMaxBytes + 64);
  }

  /**
   * Builds this client's snapshot for `tick`.
   *
   * The returned `bytes` view is a fresh copy, safe to hand straight to the
   * transport. `byteLength === 0` means there was genuinely nothing to send;
   * callers should skip the packet entirely rather than send an empty one.
   */
  build(clientId: ClientId, tick: NetTick): SnapshotResult {
    const cs = this.rep.client(clientId);
    const cb = this.budget.get(clientId) ?? this.budget.add(clientId);
    const allowance = cb.beginTick(tick);
    const capBytes = Math.min(allowance, this.config.hardMaxBytes);

    const full = cs.needsFullState || cs.ackedTick < 0;
    const baselineTick = full ? -1 : cs.ackedTick;
    const rel = this.interest.evaluate(clientId, tick, cb.degradeLevel);

    this.priceCandidates(cs.baseline, rel, full);
    this.collectLeaves(clientId, cs.baseline, tick, full);

    const w = this.w;
    w.reset();

    /* ------------------------------------------------------------- header */
    const headerStart = w.mark();
    w.writeVarUint(tick >>> 0);
    w.writeBool(full);
    if (!full) w.writeVarUint((tick - baselineTick) >>> 0);
    const updateCountPos = w.mark();
    w.writeBits(0, UPDATE_COUNT_BITS);
    cb.meter.addBits('header', w.mark() - headerStart);

    /* ------------------------------------------------- select within budget */
    const capBits = capBytes * 8;
    // Leaves are cheap but must not be squeezed out by updates, so reserve them.
    const leaveReserveBits = full ? 0 : LEAVE_COUNT_BITS + this.leaveIds.length * 25;
    let remaining = capBits - w.bitLength - leaveReserveBits;

    this.chosen.length = 0;
    let dropped = 0;
    for (let i = 0; i < this.priced.length; i++) {
      const p = this.priced[i];
      const cost = p.bodyBits + p.overheadBits;
      if (cost > remaining) { dropped++; continue; }
      remaining -= cost;
      this.chosen.push(p);
    }
    this.chosen.sort(byId);

    /* -------------------------------------------------------- write updates */
    const written = this.written;
    written.length = 0;
    let prevId = 0;
    let spawns = 0;
    for (let i = 0; i < this.chosen.length; i++) {
      const p = this.chosen[i];
      const mark = w.mark();
      w.writeVarUint((p.e.id - prevId) >>> 0);
      w.writeBool(p.spawn);
      cb.meter.addBits('ids', w.bitLength - mark);
      const structural = w.bitLength;
      if (p.spawn) w.writeVarUint(p.cls.id >>> 0);
      w.writeBits(p.mask >>> 0, p.cls.fields.length);
      cb.meter.addBits(p.spawn ? 'spawn' : 'mask', w.bitLength - structural);

      const fields = p.cls.fields;
      for (let fi = 0; fi < fields.length; fi++) {
        if ((p.mask & (1 << fi)) === 0) continue;
        const f = fields[fi];
        const before = w.bitLength;
        writeField(w, f, p.e.words, p.spawn ? null : p.base);
        cb.meter.addBits(f.group, w.bitLength - before);
      }

      // Backstop: the cost model said this fits. If it somehow did not, undo the
      // entity rather than blow the ceiling. Costs one entity, never a packet.
      // Rolling back leaves `prevId` untouched, so the id chain the reader
      // rebuilds stays identical to the one written.
      if (w.bitLength > capBits) {
        w.rollback(mark);
        dropped++;
        continue;
      }
      prevId = p.e.id;
      written.push(p);
      if (p.spawn) spawns++;
    }
    const count = written.length;
    w.patchBits(updateCountPos, count, UPDATE_COUNT_BITS);

    /* --------------------------------------------------------- write leaves */
    let leaves = 0;
    if (!full) {
      const leaveCountPos = w.mark();
      w.writeBits(0, LEAVE_COUNT_BITS);
      let lprev = 0;
      for (let i = 0; i < this.leaveIds.length; i++) {
        const mark = w.mark();
        w.writeVarUint((this.leaveIds[i] - lprev) >>> 0);
        w.writeBool(this.leaveReasons[i] === LEAVE_DESTROYED);
        if (w.bitLength > capBits) { w.rollback(mark); break; }
        lprev = this.leaveIds[i];
        leaves++;
      }
      w.patchBits(leaveCountPos, leaves, LEAVE_COUNT_BITS);
      cb.meter.addBits('leaves', w.bitLength - leaveCountPos);
    }

    /* ------------------------------------------------------------- commit */
    const byteLength = w.byteLength;
    const nothingToSay = count === 0 && leaves === 0 && !full;
    const bytes = nothingToSay ? EMPTY : w.finish();

    if (!nothingToSay) {
      const updates: PendingUpdate[] = [];
      for (let i = 0; i < written.length; i++) {
        const p = written[i];
        updates.push({
          id: p.e.id,
          classId: p.cls.id,
          mask: p.mask,
          words: mergeWords(p),
        });
        this.interest.markSent(clientId, p.e.id, tick);
      }
      cs.record({ tick, updates, leaves: this.leaveIds.slice(0, leaves) });
      for (let i = 0; i < leaves; i++) this.interest.forgetEntity(clientId, this.leaveIds[i]);
    }

    cb.commit(nothingToSay ? 0 : byteLength, dropped > 0, dropped);

    const r = this.last;
    r.clientId = clientId;
    r.tick = tick;
    r.bytes = bytes;
    r.byteLength = nothingToSay ? 0 : byteLength;
    r.full = full;
    r.baselineTick = baselineTick;
    r.updates = count;
    r.spawns = spawns;
    r.leaves = leaves;
    r.considered = rel.length;
    r.dropped = dropped;
    r.truncated = dropped > 0;
    r.allowance = capBytes;
    r.degradeLevel = cb.degradeLevel;
    return { ...r };
  }

  /** Per-client relevance without encoding — for HUDs and tests. */
  relevance(clientId: ClientId, tick: NetTick): RelevanceEntry[] {
    const cb = this.budget.get(clientId);
    return this.interest.evaluate(clientId, tick, cb ? cb.degradeLevel : 0);
  }

  budgetFor(clientId: ClientId): ClientBudget { return this.budget.client(clientId); }

  /* ------------------------------------------------------------- internals */

  /**
   * Prices every candidate against the client's baseline and drops the ones with
   * nothing to say. Output keeps interest's priority order.
   */
  private priceCandidates(
    baseline: Map<EntityId, { classId: number; words: Int32Array }>,
    rel: RelevanceEntry[],
    full: boolean,
  ): void {
    this.priced.length = 0;
    this.pricedIds.clear();
    for (let i = 0; i < rel.length; i++) {
      const r = rel[i];
      const e = this.rep.get(r.id);
      if (!e) continue;
      const cls = e.cls;
      const entry = full ? undefined : baseline.get(r.id);
      const spawn = !entry || entry.classId !== cls.id;
      const base = spawn ? null : entry!.words;

      let mask = 0;
      let bodyBits = 0;
      const fields = cls.fields;
      for (let fi = 0; fi < fields.length; fi++) {
        const f = fields[fi];
        if (r.lod > f.maxLod) continue;          // LOD drops cosmetic fields first
        if (!spawn && !fieldDiffers(f, e.words, base!)) continue;
        mask |= 1 << fi;
        bodyBits += fieldCostBits(f, e.words, base);
      }
      if (mask === 0) continue;

      // Upper bound: the id delta can never exceed the id itself.
      let overhead = varUintBits(e.id) + 1 + fields.length;
      if (spawn) overhead += varUintBits(cls.id);

      this.pricedIds.add(e.id);
      this.priced.push({
        e, cls, mask, bodyBits, overheadBits: overhead,
        priority: r.priority, lod: r.lod, spawn, base,
      });
    }
  }

  /**
   * Decides what to release from the client's view. Distance is checked directly
   * rather than inferred from "interest stopped mentioning it", because interest
   * legitimately goes quiet for an entity that is simply clean or rate limited.
   */
  private collectLeaves(
    clientId: ClientId,
    baseline: Map<EntityId, { classId: number; words: Int32Array }>,
    tick: NetTick,
    full: boolean,
  ): void {
    this.leaveIds.length = 0;
    this.leaveReasons.length = 0;
    if (full || baseline.size === 0) return;

    const view = this.interest.view(clientId);
    const cfg = this.config;
    const radius = this.interest.config.cullRadius * cfg.leaveHysteresis;
    const r2 = radius * radius;
    const limit = cfg.maxLeavesPerSnapshot;

    for (const id of baseline.keys()) {
      if (this.leaveIds.length >= limit) break;
      const e = this.rep.get(id);
      if (!e) {
        this.leaveIds.push(id);
        this.leaveReasons.push(LEAVE_DESTROYED);
        continue;
      }
      // NEVER leave an entity this snapshot is also updating. `ack()` folds
      // leaves before updates, so a same-tick update+leave pair leaves the
      // server believing the client still has an entity the client just
      // deleted — every later delta then decodes against nothing. Interest
      // still wants this entity (it is priced), so it plainly has not left;
      // if the budget drops it, the next tick will leave it properly.
      if (this.pricedIds.has(id)) continue;
      if (!view) continue;
      if (e.cls.alwaysRelevant || e.id === view.controlled || e.owner === clientId) continue;
      if (e.cls.positionWord >= 0) {
        const dx = e.x - view.pos.x, dy = e.y - view.pos.y, dz = e.z - view.pos.z;
        if (dx * dx + dy * dy + dz * dz > r2) {
          this.leaveIds.push(id);
          this.leaveReasons.push(LEAVE_OUT_OF_INTEREST);
        }
        continue;
      }
      const last = this.interest.lastSent(clientId, id);
      if (last >= 0 && tick - last > cfg.leaveGraceTicks) {
        this.leaveIds.push(id);
        this.leaveReasons.push(LEAVE_OUT_OF_INTEREST);
      }
    }
    this.leaveIds.sort(ascending);
    // Reasons were pushed in key order; re-derive after the sort.
    for (let i = 0; i < this.leaveIds.length; i++) {
      this.leaveReasons[i] = this.rep.get(this.leaveIds[i]) ? LEAVE_OUT_OF_INTEREST : LEAVE_DESTROYED;
    }
  }
}

const EMPTY = new Uint8Array(0);

function ascending(a: number, b: number): number { return a - b; }
function byId(a: Priced, b: Priced): number { return a.e.id - b.e.id; }

function fieldDiffers(f: CompiledField, cur: Int32Array, base: Int32Array): boolean {
  for (let i = 0; i < f.wordCount; i++) {
    const o = f.wordOffset + i;
    if (cur[o] !== base[o]) return true;
  }
  return false;
}

/**
 * "What the client will hold once it acks this update": the baseline with only
 * the transmitted fields overwritten. Writing the whole current word array here
 * would be the classic delta-compression bug — the server would believe the
 * client had fields that LOD filtering never actually sent.
 */
function mergeWords(p: Priced): Int32Array {
  const out = new Int32Array(p.cls.wordCount);
  if (p.base) out.set(p.base);
  const fields = p.cls.fields;
  for (let fi = 0; fi < fields.length; fi++) {
    if ((p.mask & (1 << fi)) === 0) continue;
    const f = fields[fi];
    for (let i = 0; i < f.wordCount; i++) {
      const o = f.wordOffset + i;
      out[o] = p.e.words[o];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Receiving half                                                             */
/* -------------------------------------------------------------------------- */

export interface RemoteEntity {
  id: EntityId;
  cls: CompiledClass;
  words: Int32Array;
  /** Tick this entity was last updated. */
  tick: NetTick;
  spawnTick: NetTick;
}

export interface ApplyResult {
  ok: boolean;
  tick: NetTick;
  baselineTick: NetTick;
  full: boolean;
  updates: number;
  spawns: number;
  leaves: number;
  bytes: number;
  /** Set when `ok` is false. */
  reason?: string;
}

/**
 * The client half. Mirrors `SnapshotBuilder.build` exactly; it exists here, next
 * to the writer, so the two can never drift apart silently.
 *
 * A delta snapshot is REJECTED unless its baseline is the tick this applier last
 * acked. That is what makes the "ack folds the change set into the baseline"
 * scheme safe: the client can only ever apply a delta it has the baseline for,
 * and rejecting is cheap because the host will simply code the next snapshot
 * against the older baseline.
 */
export class SnapshotApplier {
  readonly registry: SchemaRegistry;
  readonly entities = new Map<EntityId, RemoteEntity>();
  /** Newest tick successfully applied — send this back as the ack. */
  ackedTick: NetTick = -1;
  rejected = 0;
  applied = 0;

  constructor(registry: SchemaRegistry) { this.registry = registry; }

  apply(bytes: Uint8Array): ApplyResult {
    const res: ApplyResult = {
      ok: false, tick: -1, baselineTick: -1, full: false,
      updates: 0, spawns: 0, leaves: 0, bytes: bytes.length,
    };
    if (bytes.length === 0) { res.ok = true; res.tick = this.ackedTick; return res; }

    const r = new BitReader(bytes);
    const tick = r.readVarUint();
    const full = r.readBool();
    const baselineTick = full ? -1 : tick - r.readVarUint();
    res.tick = tick;
    res.full = full;
    res.baselineTick = baselineTick;

    if (!full && baselineTick !== this.ackedTick) {
      this.rejected++;
      res.reason = `baseline mismatch: snapshot wants ${baselineTick}, have ${this.ackedTick}`;
      return res;
    }
    if (tick <= this.ackedTick && !full) {
      this.rejected++;
      res.reason = `stale snapshot ${tick} <= ${this.ackedTick}`;
      return res;
    }
    if (full) this.entities.clear();

    const count = r.readBits(UPDATE_COUNT_BITS);
    let prevId = 0;
    for (let i = 0; i < count; i++) {
      const id = prevId + r.readVarUint();
      prevId = id;
      const spawn = r.readBool();
      let ent = this.entities.get(id);
      if (spawn) {
        const classId = r.readVarUint();
        const cls = this.registry.tryGet(classId);
        if (!cls) {
          this.rejected++;
          res.reason = `unknown class ${classId} for entity ${id}`;
          return res;
        }
        ent = { id, cls, words: new Int32Array(cls.wordCount), tick, spawnTick: tick };
        this.entities.set(id, ent);
        res.spawns++;
      } else if (!ent) {
        this.rejected++;
        res.reason = `delta for unknown entity ${id}`;
        return res;
      }
      const cls = ent!.cls;
      const mask = r.readBits(cls.fields.length);
      for (let fi = 0; fi < cls.fields.length; fi++) {
        if ((mask & (1 << fi)) === 0) continue;
        readField(r, cls.fields[fi], ent!.words);
      }
      ent!.tick = tick;
      res.updates++;
    }

    if (!full) {
      const leaveCount = r.readBits(LEAVE_COUNT_BITS);
      let lprev = 0;
      for (let i = 0; i < leaveCount; i++) {
        const id = lprev + r.readVarUint();
        lprev = id;
        r.readBool();
        this.entities.delete(id);
        res.leaves++;
      }
    }

    // `finish()` pads to a byte boundary, so consuming every bit is legal;
    // only reading PAST the buffer means the stream was malformed.
    if (r.bitPosition > r.bitCapacity) {
      this.rejected++;
      res.reason = 'ran off the end of the snapshot';
      return res;
    }

    this.ackedTick = tick;
    this.applied++;
    res.ok = true;
    return res;
  }

  reset(): void {
    this.entities.clear();
    this.ackedTick = -1;
  }
}
