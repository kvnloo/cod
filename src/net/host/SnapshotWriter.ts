/**
 * Default replication: interest management → delta compression → bandwidth budget.
 *
 * These three are what make more than eight players possible, so they are in the
 * baseline host rather than bolted on later:
 *
 *  1. **Interest** — a client is only told about entities it could plausibly
 *     perceive. Cost per client stops being O(all entities).
 *  2. **Delta** — each client's snapshot is encoded against the last snapshot
 *     *that client acknowledged*, per field, with a change mask. Standing still
 *     costs 0 bytes.
 *  3. **Budget** — when the delta does not fit the per-client byte budget, the
 *     lowest-priority entities are dropped for this tick and their priority
 *     accumulates, so they are sent soon rather than starved. Bandwidth degrades
 *     as latency-of-update, never as a stall.
 *
 * Everything here is behind `SnapshotWriter`, so a binary/quantised writer from
 * the replication layer can replace it without the authority noticing.
 */

import type { SnapshotWriter } from './ports';
import {
  ENTITY_FIELDS, ENT, type ClientId, type EntityDelta, type EntityState,
  type NetEvent, type RosterEntry, type Snapshot, type Tick, type WorldState,
} from './types';

/** Fixed-point scale per replicated field. Baselines store the *quantised* value,
 *  so host and client agree bit-for-bit on what the baseline contains. */
export const FIELD_SCALE: Readonly<Record<string, number>> = {
  px: 1024, py: 1024, pz: 1024,
  vx: 256, vy: 256, vz: 256,
  yaw: 4096, pitch: 4096,
};

const SCALES: number[] = ENTITY_FIELDS.map((f) => FIELD_SCALE[f] ?? 1);

/** Clients decode with this. Exported so the client layer never guesses a scale. */
export function fieldScale(index: number): number {
  return SCALES[index] ?? 1;
}

export interface SnapshotWriterOptions {
  /** Metres. Entities further than this from the viewer are not replicated. */
  interestRadius: number;
  /** Entities within this radius are always sent regardless of budget. */
  criticalRadius: number;
  /** Hard cap on estimated snapshot payload per client per tick. */
  maxBytesPerSnapshot: number;
  /** Force a keyframe at least this often even when deltas are flowing. */
  keyframeIntervalTicks: number;
  /** How many past snapshots to retain per client as delta baselines. */
  baselineHistory: number;
}

export const DEFAULT_WRITER_OPTIONS: SnapshotWriterOptions = {
  interestRadius: 120,
  criticalRadius: 25,
  maxBytesPerSnapshot: 1100,
  keyframeIntervalTicks: 150,
  baselineHistory: 48,
};

interface ClientRepState {
  /** tick → (entityId → quantised field values) as actually transmitted. */
  history: Map<Tick, Map<number, number[]>>;
  ackTick: Tick;
  lastKeyframeTick: Tick;
  /** Accumulated send priority per entity; reset when the entity is included. */
  priority: Map<number, number>;
  forceKeyframe: boolean;
  lastBytes: number;
}

export class DeltaSnapshotWriter implements SnapshotWriter {
  readonly options: SnapshotWriterOptions;
  private clients = new Map<ClientId, ClientRepState>();

  constructor(options: Partial<SnapshotWriterOptions> = {}) {
    this.options = { ...DEFAULT_WRITER_OPTIONS, ...options };
  }

  addClient(clientId: ClientId): void {
    this.clients.set(clientId, {
      history: new Map(), ackTick: -1, lastKeyframeTick: -1,
      priority: new Map(), forceKeyframe: true, lastBytes: 0,
    });
  }

  removeClient(clientId: ClientId): void { this.clients.delete(clientId); }

  acknowledge(clientId: ClientId, tick: Tick): void {
    const c = this.clients.get(clientId);
    if (!c || tick <= c.ackTick) return;
    if (!c.history.has(tick)) return; // ack for something we never sent
    c.ackTick = tick;
    for (const t of c.history.keys()) if (t < tick) c.history.delete(t);
  }

  invalidate(clientId: ClientId): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.forceKeyframe = true;
    c.ackTick = -1;
    c.history.clear();
  }

  bytesFor(clientId: ClientId): number {
    return this.clients.get(clientId)?.lastBytes ?? 0;
  }

  build(
    state: WorldState,
    clientId: ClientId,
    events: readonly NetEvent[],
    serverTimeMs: number,
    roster: readonly RosterEntry[] | undefined,
  ): Snapshot {
    let c = this.clients.get(clientId);
    if (!c) { this.addClient(clientId); c = this.clients.get(clientId)!; }

    const slot = state.players.get(clientId);
    const viewer = slot ? state.entities.get(slot.entityId) : undefined;

    const keyframe = c.forceKeyframe
      || c.ackTick < 0
      || state.tick - c.lastKeyframeTick >= this.options.keyframeIntervalTicks;
    const baseTick = keyframe ? -1 : c.ackTick;
    const base = keyframe ? undefined : c.history.get(baseTick);

    // ---- interest ----------------------------------------------------
    const relevant: EntityState[] = [];
    const r2 = this.options.interestRadius * this.options.interestRadius;
    const crit2 = this.options.criticalRadius * this.options.criticalRadius;
    const critical = new Set<number>();
    for (const e of state.entities.values()) {
      let d2 = 0;
      if (viewer && e.id !== viewer.id) {
        const dx = e.px - viewer.px, dy = e.py - viewer.py, dz = e.pz - viewer.pz;
        d2 = dx * dx + dy * dy + dz * dz;
        if (e.kind !== ENT.OBJECTIVE && d2 > r2) continue;
      }
      relevant.push(e);
      // Your own body, objectives and anything close enough to shoot you are
      // never allowed to be starved by the budget.
      if (!viewer || e.id === viewer.id || e.kind === ENT.OBJECTIVE || d2 <= crit2) {
        critical.add(e.id);
      }
      const w = 1 / (1 + d2 * 0.001);
      c.priority.set(e.id, (c.priority.get(e.id) ?? 0) + (e.kind === ENT.PLAYER ? 2 : 1) * w);
    }

    // ---- delta + budget ---------------------------------------------
    // `record` is what this client will believe after applying the snapshot. It
    // is NOT "what we sent": an entity starved by the budget keeps its previous
    // baseline, because starvation must mean "no update yet", never "despawn".
    const record = new Map<number, number[]>();
    const updates: EntityDelta[] = [];
    let bytes = 24; // header estimate

    const candidates = relevant.slice().sort((a, b) => {
      const ca = critical.has(a.id) ? 1 : 0, cb = critical.has(b.id) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      const pa = c.priority.get(a.id) ?? 0, pb = c.priority.get(b.id) ?? 0;
      if (pb !== pa) return pb - pa;
      return a.id - b.id; // deterministic tie-break
    });

    for (const e of candidates) {
      const vals = quantise(e);
      const prev = base?.get(e.id);
      let mask = 0;
      const values: number[] = [];
      for (let i = 0; i < vals.length; i++) {
        if (!prev || prev[i] !== vals[i]) { mask |= (1 << i); values.push(vals[i]); }
      }
      if (mask === 0) {
        // Unchanged: carry the baseline forward so the next delta still resolves.
        record.set(e.id, vals);
        continue;
      }
      const cost = 6 + values.length * 3;
      if (bytes + cost > this.options.maxBytesPerSnapshot && !critical.has(e.id)) {
        // Starved this tick; its priority keeps growing so it goes out soon.
        if (prev) record.set(e.id, prev);
        continue;
      }
      bytes += cost;
      updates.push({ id: e.id, mask, values });
      record.set(e.id, vals);
      c.priority.set(e.id, 0);
    }

    // ---- removals ----------------------------------------------------
    // Only entities the client knew about that are genuinely gone or out of
    // interest — never entities the budget merely deferred.
    const removed: number[] = [];
    if (base) {
      for (const id of base.keys()) {
        if (!record.has(id)) { removed.push(id); bytes += 3; }
      }
    }

    // Events are reliable facts; they are not subject to the budget.
    const evOut = events.slice();
    bytes += evOut.length * 28;

    c.history.set(state.tick, record);
    while (c.history.size > this.options.baselineHistory) {
      const oldest = c.history.keys().next().value as Tick | undefined;
      if (oldest === undefined) break;
      c.history.delete(oldest);
    }
    if (keyframe) { c.lastKeyframeTick = state.tick; c.forceKeyframe = false; }
    c.lastBytes = bytes;

    return {
      epoch: state.epoch,
      tick: state.tick,
      baseTick,
      ackInputTick: slot?.lastAckedInputTick ?? -1,
      serverTimeMs,
      updates,
      removed,
      events: evOut,
      roster: keyframe || roster ? roster?.map((r) => ({ ...r })) : undefined,
    };
  }
}

function quantise(e: EntityState): number[] {
  const out: number[] = new Array(ENTITY_FIELDS.length);
  for (let i = 0; i < ENTITY_FIELDS.length; i++) {
    const f = ENTITY_FIELDS[i];
    const raw = (e as unknown as Record<string, number>)[f];
    const s = SCALES[i];
    out[i] = s === 1 ? (raw | 0) : Math.round(raw * s);
  }
  return out;
}

/**
 * Reference decoder — apply a delta to a client-side entity record.
 * The client layer is welcome to write its own; this one defines the semantics.
 */
export function applyDelta(target: EntityState, mask: number, values: readonly number[]): void {
  let vi = 0;
  for (let i = 0; i < ENTITY_FIELDS.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    const s = SCALES[i];
    (target as unknown as Record<string, number>)[ENTITY_FIELDS[i]] = s === 1 ? values[vi] : values[vi] / s;
    vi++;
  }
}

/**
 * The receiving half of delta compression.
 *
 * It mirrors the writer exactly: the client keeps the same per-tick baselines the
 * host keeps, so `state(tick) = state(baseTick) + delta` always resolves against
 * the identical bytes the host encoded against. A snapshot whose baseline the
 * client no longer holds — because it arrived out of order, or the client never
 * received the baseline — is dropped, and the host's keyframe schedule (or the
 * absence of an ack) repairs it.
 *
 * Provided here rather than left to the client layer because the encoder and the
 * decoder are one contract; splitting them across owners is how silent
 * desynchronisation gets shipped.
 */
export class SnapshotReader {
  /** Reconstructed authoritative entities at `tick`, in world units. */
  readonly entities = new Map<number, EntityState>();
  tick: Tick = -1;
  applied = 0;
  droppedNoBaseline = 0;
  droppedStale = 0;

  private baselines = new Map<Tick, number[][] | undefined>();
  private byTick = new Map<Tick, Map<number, number[]>>();
  private history: number;

  constructor(history = DEFAULT_WRITER_OPTIONS.baselineHistory) {
    this.history = history;
  }

  /** Returns true if the snapshot was applied. */
  apply(s: Snapshot): boolean {
    let base: Map<number, number[]> | undefined;
    if (s.baseTick < 0) base = new Map();
    else {
      base = this.byTick.get(s.baseTick);
      if (!base) { this.droppedNoBaseline++; return false; }
    }

    const next = new Map<number, number[]>();
    for (const [id, v] of base) next.set(id, v);
    for (const d of s.updates) {
      const cur = next.get(d.id);
      const v = cur ? cur.slice() : new Array<number>(ENTITY_FIELDS.length).fill(0);
      let vi = 0;
      for (let i = 0; i < ENTITY_FIELDS.length; i++) {
        if ((d.mask & (1 << i)) === 0) continue;
        v[i] = d.values[vi++];
      }
      next.set(d.id, v);
    }
    for (const id of s.removed) next.delete(id);

    this.byTick.set(s.tick, next);
    while (this.byTick.size > this.history) {
      const oldest = this.byTick.keys().next().value as Tick | undefined;
      if (oldest === undefined) break;
      this.byTick.delete(oldest);
    }

    this.applied++;
    if (s.tick < this.tick) { this.droppedStale++; return true; }
    this.tick = s.tick;
    this.rebuild(next);
    return true;
  }

  /** Forget everything — call on (re)join and after a host migration. */
  reset(): void {
    this.entities.clear();
    this.byTick.clear();
    this.baselines.clear();
    this.tick = -1;
  }

  private rebuild(values: Map<number, number[]>): void {
    for (const id of [...this.entities.keys()]) if (!values.has(id)) this.entities.delete(id);
    for (const [id, v] of values) {
      let e = this.entities.get(id);
      if (!e) { e = blankEntity(id); this.entities.set(id, e); }
      const rec = e as unknown as Record<string, number>;
      for (let i = 0; i < ENTITY_FIELDS.length; i++) {
        const s = SCALES[i];
        rec[ENTITY_FIELDS[i]] = s === 1 ? v[i] : v[i] / s;
      }
    }
  }
}

function blankEntity(id: number): EntityState {
  return {
    id, kind: 0, owner: 0, team: 0,
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    health: 0, armor: 0, weapon: 0, ammo: 0, flags: 0, respawnTick: 0, nextFireTick: 0,
  };
}
