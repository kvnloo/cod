/**
 * Delta — snapshot delta compression against a client's last ACKED snapshot.
 *
 * ## Model
 *
 * The host keeps, *per client*, a short history of the world states that client
 * has been sent. The client acks the newest tick it has decoded. The host then
 * encodes the next snapshot as a difference against the acked one, and the
 * client applies that difference to the same baseline. Both sides store the
 * *snapped* (post-quantisation) state, so the two baselines are bit-identical
 * and can never drift — see the `snap` discussion in Serialize.ts.
 *
 * When there is no usable baseline — a fresh connection, or a client whose last
 * ack has aged out of the history window — the host sends a **baseline
 * snapshot**: every entity, every field, full precision, no mask. Baselines are
 * self-contained, so a client can join or recover from a long stall with no
 * extra handshake.
 *
 * ## Why this survives the move off a peer host
 *
 * Nothing here knows what a WebRTC DataChannel is, or that the host is a peer.
 * {@link DeltaEncoder} is per-client state owned by whatever runs the
 * simulation; {@link DeltaDecoder} is per-connection state owned by whatever
 * receives it. Running the same simulation in a headless Node process changes
 * who constructs the encoder, not the encoder.
 *
 * ## Bandwidth budgeting
 *
 * `encode()` takes `maxBytes`. Entities are offered in caller-supplied priority
 * order (interest management decides that order — this layer only obeys it) and
 * the encoder writes until the next entity would breach the budget, then rolls
 * the bitstream back to before that entity and stops.
 *
 * The critical part is what the history then records. For an entity that was
 * *not* sent, the client still holds its baseline value, so the history entry
 * for this tick must carry the **baseline** state forward, not the current one.
 * Get that wrong and every budget-limited tick silently corrupts a client. This
 * is asserted directly in tools/net-wire.mjs under a 200-byte cap.
 *
 * ## Packet layout
 *
 * ```
 *   varuint   tick
 *   1 bit     isBaseline
 *   if baseline:  16 bits  protocolHash & 0xffff
 *   else:         varuint  (tick - baselineTick)
 *
 *   removals:   [ 1 bit more, varuint (id - prevId - 1) ]* , 1 bit stop
 *   updates:    [ 1 bit more, varuint id, 1 bit isNew,
 *                 if isNew: 8 bits schemaWireId,
 *                 schema payload ]* , 1 bit stop
 * ```
 *
 * Update ids are written in full (not delta-coded) because entities are emitted
 * in priority order, not id order. At realistic entity counts a varuint id is
 * one byte either way, so priority ordering is free — and priority ordering is
 * what makes the byte budget mean something.
 */

import { BitWriter } from './BitWriter';
import { BitReader } from './BitReader';
import type { AnySchema } from './Serialize';
import { SchemaRegistry, schemaRegistry } from './Serialize';

/** One entity offered to the encoder for this tick. */
export interface EntitySnapshotView {
  /** Stable network id. Any non-negative integer below 2^32. */
  readonly id: number;
  readonly schema: AnySchema;
  /** Live (un-snapped) state matching `schema`. */
  readonly state: Record<string, unknown>;
  /**
   * Higher goes first when the byte budget bites. Interest management owns this
   * number; the wire layer only sorts by it. Default 0.
   */
  readonly priority?: number;
}

/** An entity as the far end holds it: snapped state. Treat as immutable. */
export interface ReplicatedEntity {
  readonly schema: AnySchema;
  readonly state: Record<string, unknown>;
}

type StoredSnapshot = Map<number, ReplicatedEntity>;

export interface DeltaEncoderOptions {
  /** How many past snapshots to retain as candidate baselines. Default 64. */
  historyTicks?: number;
  registry?: SchemaRegistry;
  /**
   * How long to keep betting on an unacknowledged baseline before giving up and
   * sending a fresh one, in ticks. Default 8.
   *
   * A joining client cannot ack anything for a full round trip. Sending a full
   * world every tick until that ack lands costs a baseline per tick of RTT —
   * with twelve clients joining at match start that is a multi-megabit spike on
   * a peer host's uplink, exactly when it can least afford one. Instead, after
   * the first baseline goes out we assume it arrived and delta against it. If
   * the bet is wrong, the client cannot decode those deltas, so it never acks,
   * and after this many ticks we send another baseline. The wrong bet costs a
   * few small undecodable packets; the right bet — the overwhelmingly common
   * case — saves a full world per tick of RTT.
   */
  baselineRetryTicks?: number;
}

export interface EncodeOptions {
  /** Hard cap on the encoded packet in bytes. Default: unlimited. */
  maxBytes?: number;
  /** Force a full baseline snapshot regardless of acks. */
  forceBaseline?: boolean;
}

export interface EncodeResult {
  tick: number;
  /** -1 when this packet is a baseline. */
  baselineTick: number;
  isBaseline: boolean;
  bytes: number;
  bits: number;
  entitiesWritten: number;
  /** Entities dropped because the byte budget ran out. */
  entitiesSkipped: number;
  /** Entities unchanged since the baseline (cost 0 bits). */
  entitiesUnchanged: number;
  removed: number;
  /** True when the budget stopped the encoder early. */
  budgetExceeded: boolean;
}

/* -------------------------------------------------------------------------- */
/* Encoder                                                                    */
/* -------------------------------------------------------------------------- */

export class DeltaEncoder {
  private readonly history = new Map<number, StoredSnapshot>();
  private readonly historyTicks: number;
  private readonly registry: SchemaRegistry;
  private readonly baselineRetryTicks: number;
  private acked = -1;
  private lastTick = -1;
  private pendingBaseline = -1;

  constructor(options: DeltaEncoderOptions = {}) {
    this.historyTicks = Math.max(2, options.historyTicks ?? 64);
    this.registry = options.registry ?? schemaRegistry;
    // 0 disables the bet entirely: every tick re-sends a full world until the
    // client acks. Costly, but it is the only mode where a joining client can
    // never be handed a delta it cannot decode.
    this.baselineRetryTicks = Math.max(
      0,
      Math.min(options.baselineRetryTicks ?? 8, this.historyTicks),
    );
  }

  /**
   * The last baseline we sent that the client has not confirmed, or -1. Deltas
   * are currently being bet against it; a transport that can deliver the
   * baseline reliably should ack it instead of leaving this pending.
   */
  get pendingBaselineTick(): number {
    return this.pendingBaseline;
  }

  /** Newest tick this client has confirmed. -1 until the first ack. */
  get ackedTick(): number {
    return this.acked;
  }

  get historySize(): number {
    return this.history.size;
  }

  /**
   * Record a client ack. Older snapshots are dropped: once the client confirms
   * tick T, nothing before T can ever be a baseline again.
   */
  ack(tick: number): void {
    if (tick <= this.acked) return; // duplicate or reordered
    if (!this.history.has(tick)) return; // ack for something we never sent
    this.acked = tick;
    for (const t of this.history.keys()) {
      if (t < tick) this.history.delete(t);
    }
  }

  /**
   * The exact world state this client holds once it has applied the snapshot for
   * `tick` — including entities the byte budget skipped, which keep their older
   * value. Interest management uses it to decide what is stale; the tests use it
   * to assert the two baselines never drift.
   */
  expectedView(tick: number): ReadonlyMap<number, ReplicatedEntity> | undefined {
    return this.history.get(tick);
  }

  /** Drop all state — use when a client reconnects on the same encoder. */
  reset(): void {
    this.history.clear();
    this.acked = -1;
    this.lastTick = -1;
    this.pendingBaseline = -1;
  }

  /**
   * Encode the world for `tick` into `w`.
   *
   * `entities` is consumed in iteration order when no budget applies, and sorted
   * by descending `priority` when one does.
   */
  encode(
    w: BitWriter,
    tick: number,
    entities: Iterable<EntitySnapshotView>,
    options: EncodeOptions = {},
  ): EncodeResult {
    const list: EntitySnapshotView[] = Array.isArray(entities)
      ? (entities as EntitySnapshotView[])
      : Array.from(entities);

    const baseTick = options.forceBaseline ? -1 : this.usableBaselineTick(tick);
    const baseline = baseTick >= 0 ? this.history.get(baseTick) : undefined;
    const isBaseline = baseline === undefined;

    const budgetBits =
      options.maxBytes !== undefined ? w.mark() + options.maxBytes * 8 : Number.MAX_SAFE_INTEGER;

    const startBits = w.mark();

    w.writeVarUint(tick);
    w.writeBool(isBaseline);
    if (isBaseline) {
      w.writeBits(this.registry.protocolHash & 0xffff, 16);
    } else {
      w.writeVarUint(tick - baseTick);
    }

    const next: StoredSnapshot = new Map();
    const result: EncodeResult = {
      tick,
      baselineTick: isBaseline ? -1 : baseTick,
      isBaseline,
      bytes: 0,
      bits: 0,
      entitiesWritten: 0,
      entitiesSkipped: 0,
      entitiesUnchanged: 0,
      removed: 0,
      budgetExceeded: false,
    };

    /* --- removals: ids in the baseline that are gone this tick -------------- */
    if (baseline !== undefined) {
      const present = new Set<number>();
      for (const e of list) present.add(e.id);
      const removed: number[] = [];
      for (const id of baseline.keys()) if (!present.has(id)) removed.push(id);
      removed.sort((a, b) => a - b);
      let prev = -1;
      for (const id of removed) {
        w.writeBool(true);
        w.writeVarUint(id - prev - 1);
        prev = id;
      }
      result.removed = removed.length;
    }
    w.writeBool(false); // end of removals

    /* --- updates ----------------------------------------------------------- */
    const ordered =
      options.maxBytes === undefined
        ? list
        : list.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    let stopped = false;
    for (const e of ordered) {
      const prior = baseline?.get(e.id);
      // A prior entry only counts as a baseline if it used the same schema;
      // a schema change is a re-spawn as far as the wire is concerned.
      const usable = prior !== undefined && prior.schema === e.schema ? prior : undefined;

      if (stopped) {
        // Budget already blown: carry the baseline forward so this client's view
        // of the entity stays exactly what it already holds.
        if (prior !== undefined) next.set(e.id, prior);
        result.entitiesSkipped++;
        continue;
      }

      const before = w.mark();
      w.writeBool(true);
      w.writeVarUint(e.id);
      w.writeBool(usable === undefined);
      if (usable === undefined) w.writeBits(e.schema.wireId < 0 ? 0 : e.schema.wireId, 8);

      const anyChanged = e.schema.encode(w, e.state, usable === undefined ? null : usable.state);

      if (usable !== undefined && !anyChanged) {
        // Nothing moved. Drop the whole record — including its header — and
        // carry the baseline forward. This is the cheapest entity in the game.
        w.rollback(before);
        next.set(e.id, usable);
        result.entitiesUnchanged++;
        continue;
      }

      if (w.bitLength > budgetBits || w.overflowed) {
        w.rollback(before);
        stopped = true;
        result.budgetExceeded = true;
        if (prior !== undefined) next.set(e.id, prior);
        result.entitiesSkipped++;
        continue;
      }

      next.set(e.id, { schema: e.schema, state: e.schema.snapshot(e.state) });
      result.entitiesWritten++;
    }
    w.writeBool(false); // end of updates

    this.history.set(tick, next);
    this.lastTick = tick;
    if (isBaseline) this.pendingBaseline = tick;
    this.trimHistory(tick);

    result.bits = w.bitLength - startBits;
    result.bytes = Math.ceil(result.bits / 8);
    return result;
  }

  private usableBaselineTick(tick: number): number {
    // A confirmed baseline is always the right answer: the client provably has
    // it, so a delta against it is guaranteed decodable.
    if (
      this.acked >= 0 &&
      tick - this.acked <= this.historyTicks &&
      this.history.has(this.acked)
    ) {
      return this.acked;
    }
    // Nothing confirmed. Bet on the last baseline we sent, for as long as its
    // ack could still plausibly be in flight. See baselineRetryTicks.
    if (
      this.pendingBaseline > this.acked &&
      tick - this.pendingBaseline <= this.baselineRetryTicks &&
      this.history.has(this.pendingBaseline)
    ) {
      return this.pendingBaseline;
    }
    return -1;
  }

  private trimHistory(tick: number): void {
    if (this.history.size <= this.historyTicks) return;
    const cutoff = tick - this.historyTicks;
    for (const t of this.history.keys()) {
      if (t < cutoff && t !== this.acked && t !== this.pendingBaseline) this.history.delete(t);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Decoder                                                                    */
/* -------------------------------------------------------------------------- */

export interface DecodedEntity {
  readonly id: number;
  readonly schema: AnySchema;
  /** Snapped state. Immutable — copy before mutating. */
  readonly state: Record<string, unknown>;
}

export interface DecodedSnapshot {
  readonly tick: number;
  /** -1 when this was a baseline. */
  readonly baselineTick: number;
  readonly isBaseline: boolean;
  /** The complete world after applying this snapshot. */
  readonly entities: ReadonlyMap<number, DecodedEntity>;
  /** Ids updated by this packet. */
  readonly changed: readonly number[];
  /** Ids removed by this packet. */
  readonly removed: readonly number[];
}

export type DecodeError =
  | 'truncated'
  | 'unknown-baseline'
  | 'unknown-schema'
  | 'protocol-mismatch'
  | 'stale';

export interface DeltaDecoderOptions {
  historyTicks?: number;
  registry?: SchemaRegistry;
  /**
   * Reject baseline packets whose truncated protocol hash disagrees with the
   * local registry. Default true — a mismatch means the peers are on different
   * builds and every subsequent byte would be misread.
   */
  checkProtocolHash?: boolean;
}

export class DeltaDecoder {
  private readonly snapshots = new Map<number, DecodedSnapshot>();
  private readonly historyTicks: number;
  private readonly registry: SchemaRegistry;
  private readonly checkHash: boolean;
  private newest: DecodedSnapshot | null = null;

  /** Reason the last decode() returned null. */
  lastError: DecodeError | null = null;

  constructor(options: DeltaDecoderOptions = {}) {
    this.historyTicks = Math.max(2, options.historyTicks ?? 64);
    this.registry = options.registry ?? schemaRegistry;
    this.checkHash = options.checkProtocolHash ?? true;
  }

  /** Newest successfully decoded snapshot, or null. */
  get latest(): DecodedSnapshot | null {
    return this.newest;
  }

  /** The tick to send back as an ack. -1 when nothing has decoded yet. */
  get ackTick(): number {
    return this.newest ? this.newest.tick : -1;
  }

  snapshotAt(tick: number): DecodedSnapshot | undefined {
    return this.snapshots.get(tick);
  }

  reset(): void {
    this.snapshots.clear();
    this.newest = null;
    this.lastError = null;
  }

  /**
   * Decode one packet. Returns null and sets {@link lastError} on any problem;
   * the caller should drop the packet and keep the previous state. Failing to
   * ack is itself the recovery signal — the host will fall back to a baseline.
   */
  decode(r: BitReader): DecodedSnapshot | null {
    this.lastError = null;
    const tick = r.readVarUint();
    const isBaseline = r.readBool();

    let baselineTick = -1;
    let base: ReadonlyMap<number, DecodedEntity> | null = null;

    if (isBaseline) {
      const hash = r.readBits(16);
      if (this.checkHash && hash !== (this.registry.protocolHash & 0xffff)) {
        this.lastError = 'protocol-mismatch';
        return null;
      }
    } else {
      const back = r.readVarUint();
      baselineTick = tick - back;
      const prior = this.snapshots.get(baselineTick);
      if (!prior) {
        this.lastError = 'unknown-baseline';
        return null;
      }
      base = prior.entities;
    }

    if (r.overflowed) {
      this.lastError = 'truncated';
      return null;
    }

    const entities = new Map<number, DecodedEntity>();
    if (base) for (const [id, e] of base) entities.set(id, e);

    /* --- removals ---------------------------------------------------------- */
    const removed: number[] = [];
    let prev = -1;
    while (r.readBool()) {
      const id = prev + 1 + r.readVarUint();
      prev = id;
      entities.delete(id);
      removed.push(id);
      if (r.overflowed) {
        this.lastError = 'truncated';
        return null;
      }
    }

    /* --- updates ----------------------------------------------------------- */
    const changed: number[] = [];
    while (r.readBool()) {
      const id = r.readVarUint();
      const isNew = r.readBool();
      if (r.overflowed) {
        this.lastError = 'truncated';
        return null;
      }

      let schema: AnySchema | undefined;
      let priorState: Record<string, unknown> | null = null;
      if (isNew) {
        schema = this.registry.get(r.readBits(8));
        if (!schema) {
          this.lastError = 'unknown-schema';
          return null;
        }
      } else {
        const prior = entities.get(id);
        if (!prior) {
          // Delta for an entity we do not have: the streams have diverged.
          this.lastError = 'unknown-baseline';
          return null;
        }
        schema = prior.schema;
        priorState = prior.state;
      }

      const state = schema.decode(r, priorState) as Record<string, unknown>;
      if (r.overflowed) {
        this.lastError = 'truncated';
        return null;
      }
      entities.set(id, { id, schema, state });
      changed.push(id);
    }

    if (r.overflowed) {
      this.lastError = 'truncated';
      return null;
    }

    const snapshot: DecodedSnapshot = {
      tick,
      baselineTick,
      isBaseline,
      entities,
      changed,
      removed,
    };

    this.snapshots.set(tick, snapshot);
    if (!this.newest || tick > this.newest.tick) this.newest = snapshot;
    this.trim(tick);
    return snapshot;
  }

  private trim(tick: number): void {
    if (this.snapshots.size <= this.historyTicks) return;
    const cutoff = tick - this.historyTicks;
    for (const t of this.snapshots.keys()) if (t < cutoff) this.snapshots.delete(t);
  }
}

/* -------------------------------------------------------------------------- */
/* Bandwidth helpers                                                          */
/* -------------------------------------------------------------------------- */

/** kbit/s implied by a per-snapshot byte count at `hz` snapshots per second. */
export function kbitPerSecond(bytesPerSnapshot: number, hz: number): number {
  return (bytesPerSnapshot * 8 * hz) / 1000;
}

/** Rolling bandwidth meter — one per connection direction. */
export class BandwidthMeter {
  private readonly samples: number[] = [];
  private readonly window: number;
  total = 0;
  packets = 0;

  constructor(windowSamples = 120) {
    this.window = Math.max(1, windowSamples);
  }

  add(bytes: number): void {
    this.total += bytes;
    this.packets++;
    this.samples.push(bytes);
    if (this.samples.length > this.window) this.samples.shift();
  }

  get mean(): number {
    if (this.samples.length === 0) return 0;
    let sum = 0;
    for (const s of this.samples) sum += s;
    return sum / this.samples.length;
  }

  get max(): number {
    let m = 0;
    for (const s of this.samples) if (s > m) m = s;
    return m;
  }

  /** Percentile over the window, `p` in [0,1]. */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  reset(): void {
    this.samples.length = 0;
    this.total = 0;
    this.packets = 0;
  }
}
