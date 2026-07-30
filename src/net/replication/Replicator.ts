/**
 * Replicator — the registry of replicated entities and per-client baselines.
 *
 * It deliberately does NOT own simulation state. Gameplay systems keep their own
 * objects; they either implement `ReplicationSource` (pulled once per network
 * tick) or push values whenever they change. Either way the replicator only ever
 * holds a quantized mirror, so it can never become a second source of truth.
 *
 * Baseline model (this is the part that is easy to get subtly wrong):
 *   Every snapshot is delta-coded against the client's last *acknowledged*
 *   baseline, never against the last *sent* state. A snapshot the client never
 *   received therefore cannot corrupt the baseline. On ack we take the recorded
 *   change set for exactly that tick and fold it into the baseline; all other
 *   pending change sets are discarded, which at worst costs us a redundant
 *   resend of a field the client already had.
 */

import type {
  ClientId,
  CompiledClass,
  EntityId,
  EntityStateWriterLike,
  NetTick,
  ReplicationSource,
} from './types';
import { SchemaRegistry, encodeScalar, packQuat } from './Schema';
import { clampInt, quantize } from './Bits';

export interface EntityInit {
  /** Class id from the SchemaRegistry. */
  classId: number;
  /** Client that controls this entity; it is always force-relevant to them. */
  owner?: ClientId;
  team?: number;
  /** Multiplies the interest priority — use for a VIP, a bomb, a boss. */
  priorityBias?: number;
  source?: ReplicationSource;
  /** Force a specific network id (reconnect / deterministic tests). */
  id?: EntityId;
}

export class RepEntity {
  readonly id: EntityId;
  readonly cls: CompiledClass;
  readonly words: Int32Array;
  /** Network tick each word last changed — lets us skip clean entities fast. */
  readonly wordTick: Int32Array;
  lastChangeTick: NetTick = -1;
  spawnTick: NetTick = 0;
  owner: ClientId = -1;
  team = 0;
  priorityBias = 1;
  source: ReplicationSource | null = null;
  alive = true;
  /** Dequantized world position, refreshed each capture. Drives interest. */
  x = 0; y = 0; z = 0;

  constructor(id: EntityId, cls: CompiledClass) {
    this.id = id;
    this.cls = cls;
    this.words = new Int32Array(cls.wordCount);
    this.wordTick = new Int32Array(cls.wordCount).fill(-1);
  }

  get classId(): number { return this.cls.id; }
}

/**
 * Typed setter facade handed to `ReplicationSource.sample`. Writes are compared
 * against the current quantized word, so an unchanged value costs nothing.
 */
export class EntityStateWriter implements EntityStateWriterLike {
  private e: RepEntity | null = null;
  private tick = 0;
  private quatScratch = new Int32Array(4);

  bind(e: RepEntity, tick: NetTick): void { this.e = e; this.tick = tick; }

  private set(wordOffset: number, value: number): void {
    const e = this.e!;
    if (e.words[wordOffset] === value) return;
    e.words[wordOffset] = value;
    e.wordTick[wordOffset] = this.tick;
    e.lastChangeTick = this.tick;
  }

  f(name: string): number {
    const i = this.e!.cls.fieldIndex.get(name);
    if (i === undefined) throw new Error(`[Replicator] class "${this.e!.cls.name}" has no field "${name}"`);
    return i;
  }

  bool(field: number, v: boolean): void {
    const f = this.e!.cls.fields[field];
    this.set(f.wordOffset, v ? 1 : 0);
  }

  uint(field: number, v: number): void {
    const f = this.e!.cls.fields[field];
    this.set(f.wordOffset, encodeScalar(f, v));
  }

  int(field: number, v: number): void {
    const f = this.e!.cls.fields[field];
    this.set(f.wordOffset, encodeScalar(f, v));
  }

  float(field: number, v: number): void {
    const f = this.e!.cls.fields[field];
    f32[0] = v;
    this.set(f.wordOffset, i32[0]);
  }

  qfloat(field: number, v: number): void {
    const f = this.e!.cls.fields[field];
    this.set(f.wordOffset, encodeScalar(f, v));
  }

  vec3(field: number, x: number, y: number, z: number): void {
    const f = this.e!.cls.fields[field];
    const lim = 1 << 27;
    this.set(f.wordOffset + 0, clampInt(quantize(x, f.step), -lim, lim));
    this.set(f.wordOffset + 1, clampInt(quantize(y, f.step), -lim, lim));
    this.set(f.wordOffset + 2, clampInt(quantize(z, f.step), -lim, lim));
  }

  quat(field: number, x: number, y: number, z: number, w: number): void {
    const f = this.e!.cls.fields[field];
    packQuat(x, y, z, w, this.quatScratch, 0);
    for (let i = 0; i < 4; i++) this.set(f.wordOffset + i, this.quatScratch[i]);
  }
}

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

export interface BaselineEntry {
  classId: number;
  words: Int32Array;
}

export interface PendingUpdate {
  id: EntityId;
  classId: number;
  /** Field mask actually written in this snapshot. */
  mask: number;
  /** Copy of the entity words at send time. */
  words: Int32Array;
}

export interface PendingSnapshot {
  tick: NetTick;
  updates: PendingUpdate[];
  leaves: EntityId[];
}

/** Everything the host knows about one client's view of the world. */
export class ClientReplicationState {
  readonly clientId: ClientId;
  readonly baseline = new Map<EntityId, BaselineEntry>();
  readonly pending = new Map<NetTick, PendingSnapshot>();
  ackedTick: NetTick = -1;
  /** Set when we lost track of what the client has; next snapshot is a full one. */
  needsFullState = true;
  /** Diagnostics. */
  acksApplied = 0;
  baselineResets = 0;

  constructor(clientId: ClientId, private maxPending: number) {
    this.clientId = clientId;
  }

  record(snap: PendingSnapshot): void {
    this.pending.set(snap.tick, snap);
    if (this.pending.size > this.maxPending) {
      // Drop the oldest; if the client later acks it we cannot rebuild the
      // baseline, so we force a full state instead of guessing.
      let oldest = Infinity;
      for (const t of this.pending.keys()) if (t < oldest) oldest = t;
      this.pending.delete(oldest);
    }
  }

  /** Folds the change set for `tick` into the baseline. Returns false if unknown. */
  ack(tick: NetTick): boolean {
    if (tick <= this.ackedTick) return true;
    const snap = this.pending.get(tick);
    if (!snap) {
      this.reset();
      return false;
    }
    for (const id of snap.leaves) this.baseline.delete(id);
    for (const u of snap.updates) {
      let entry = this.baseline.get(u.id);
      if (!entry || entry.classId !== u.classId) {
        entry = { classId: u.classId, words: new Int32Array(u.words.length) };
        this.baseline.set(u.id, entry);
      }
      entry.words.set(u.words);
    }
    this.ackedTick = tick;
    this.needsFullState = false;
    this.acksApplied++;
    for (const t of this.pending.keys()) if (t <= tick) this.pending.delete(t);
    return true;
  }

  reset(): void {
    this.baseline.clear();
    this.pending.clear();
    this.ackedTick = -1;
    this.needsFullState = true;
    this.baselineResets++;
  }
}

export interface ReplicatorOptions {
  /** How many un-acked snapshots to remember per client. Default 64 (~3 s @20 Hz). */
  maxPendingSnapshots?: number;
  /** Ticks an id must stay unused before recycling. Default 600 (~30 s @20 Hz). */
  idQuarantineTicks?: number;
  /** Highest network id. Default 65535 (ids are varuint-coded). */
  maxEntityId?: number;
}

export class Replicator {
  readonly registry: SchemaRegistry;
  readonly entities = new Map<EntityId, RepEntity>();
  readonly clients = new Map<ClientId, ClientReplicationState>();
  tick: NetTick = 0;

  private opts: Required<ReplicatorOptions>;
  private nextId = 1;
  private freed: Array<{ id: EntityId; tick: NetTick }> = [];
  private writer = new EntityStateWriter();
  private ordered: RepEntity[] = [];
  private orderedDirty = true;

  constructor(registry: SchemaRegistry, opts: ReplicatorOptions = {}) {
    this.registry = registry;
    this.opts = {
      maxPendingSnapshots: opts.maxPendingSnapshots ?? 64,
      idQuarantineTicks: opts.idQuarantineTicks ?? 600,
      maxEntityId: opts.maxEntityId ?? 65535,
    };
  }

  /* ------------------------------------------------------------ entities */

  spawn(init: EntityInit): RepEntity {
    const cls = this.registry.get(init.classId);
    const id = init.id ?? this.allocId();
    if (this.entities.has(id)) throw new Error(`[Replicator] entity ${id} already exists`);
    const e = new RepEntity(id, cls);
    e.owner = init.owner ?? -1;
    e.team = init.team ?? 0;
    e.priorityBias = init.priorityBias ?? 1;
    e.source = init.source ?? null;
    e.spawnTick = this.tick;
    e.lastChangeTick = this.tick;
    this.entities.set(id, e);
    this.orderedDirty = true;
    return e;
  }

  despawn(id: EntityId): void {
    const e = this.entities.get(id);
    if (!e) return;
    e.alive = false;
    this.entities.delete(id);
    this.freed.push({ id, tick: this.tick });
    this.orderedDirty = true;
  }

  get(id: EntityId): RepEntity | undefined { return this.entities.get(id); }

  /** Entities in ascending id order — snapshots delta-code ids, so order matters. */
  all(): RepEntity[] {
    if (this.orderedDirty) {
      this.ordered = Array.from(this.entities.values()).sort((a, b) => a.id - b.id);
      this.orderedDirty = false;
    }
    return this.ordered;
  }

  private allocId(): EntityId {
    const q = this.opts.idQuarantineTicks;
    if (this.freed.length > 0 && this.tick - this.freed[0].tick > q) {
      return this.freed.shift()!.id;
    }
    if (this.nextId > this.opts.maxEntityId) {
      const recycled = this.freed.shift();
      if (!recycled) throw new Error('[Replicator] out of entity ids');
      return recycled.id;
    }
    return this.nextId++;
  }

  /* ------------------------------------------------------------- capture */

  /**
   * Samples every source and refreshes interest positions. Call once per network
   * tick, before building snapshots.
   */
  capture(tick: NetTick): void {
    this.tick = tick;
    for (const e of this.all()) {
      if (e.source) {
        this.writer.bind(e, tick);
        e.source.sample(this.writer);
      }
      const pw = e.cls.positionWord;
      if (pw >= 0) {
        const s = e.cls.positionStep;
        e.x = e.words[pw] * s;
        e.y = e.words[pw + 1] * s;
        e.z = e.words[pw + 2] * s;
      }
    }
  }

  /**
   * Push-style write. The returned writer is bound to `id` until the next call —
   * do not stash it.
   */
  write(id: EntityId): EntityStateWriter {
    const e = this.entities.get(id);
    if (!e) throw new Error(`[Replicator] write() on missing entity ${id}`);
    this.writer.bind(e, this.tick);
    return this.writer;
  }

  /* -------------------------------------------------------------- clients */

  addClient(clientId: ClientId): ClientReplicationState {
    let c = this.clients.get(clientId);
    if (!c) {
      c = new ClientReplicationState(clientId, this.opts.maxPendingSnapshots);
      this.clients.set(clientId, c);
    }
    return c;
  }

  removeClient(clientId: ClientId): void { this.clients.delete(clientId); }

  client(clientId: ClientId): ClientReplicationState {
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`[Replicator] unknown client ${clientId}`);
    return c;
  }

  /** Client reports the newest snapshot tick it has applied. */
  ack(clientId: ClientId, tick: NetTick): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    return c.ack(tick);
  }

  stats(): { entities: number; clients: number; words: number; pending: number } {
    let words = 0;
    for (const e of this.entities.values()) words += e.cls.wordCount;
    let pending = 0;
    for (const c of this.clients.values()) pending += c.pending.size;
    return { entities: this.entities.size, clients: this.clients.size, words, pending };
  }
}
