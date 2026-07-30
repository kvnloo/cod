/**
 * Bandwidth budgeting — the hard ceiling, the graceful ramp down to it, and the
 * instrumentation that tells you where the bytes actually went.
 *
 * Why a budget at all: the host is a peer on a home connection. Its UPLINK is
 * the scarce resource and it is shared by every client. If the snapshot encoder
 * is allowed to send "whatever is relevant" then a busy moment (everyone alive,
 * everyone shooting, grenades in the air) produces exactly the spike that turns
 * into queueing delay on the host's router, and queueing delay is
 * indistinguishable from lag. So the encoder is given a per-tick allowance in
 * bytes and is required to fit inside it, always.
 *
 * Three pieces:
 *
 *  1. TOKEN BUCKET per client. Refilled by `bytesPerSecond / tickRate` every
 *     network tick, capped at `burstTicks` worth of depth. A client that has
 *     been quiet banks a little credit and can spend it on a spawn burst; a
 *     client that has been loud runs dry and is throttled. `maxBytesPerSnapshot`
 *     caps any single snapshot to something that survives one MTU-ish
 *     DataChannel message, and `minBytesPerSnapshot` is the floor that
 *     guarantees a starved client still gets its own player state.
 *
 *  2. DEGRADATION LADDER 0..3 driven by measured utilisation with hysteresis.
 *     The level is not a switch that turns replication off — it is fed back into
 *     interest management, which stretches update intervals, biases entities to
 *     a coarser LOD (dropping cosmetic fields first) and shrinks the per-tick
 *     entity cap. Degradation therefore costs smoothness of distant actors long
 *     before it costs correctness of nearby ones.
 *
 *  3. A METER that attributes every bit to a named group ('transform', 'aim',
 *     'cosmetic', 'ids', 'header', 'leaves', ...). Without it "we are over
 *     budget" is unactionable; with it you can see that 40% of the uplink is
 *     quaternions on props and go fix that.
 *
 * Dependency-free and deterministic: no clocks, no RNG, no DOM. It runs
 * identically in a browser peer host and a headless dedicated server.
 */

import type { ClientId, NetTick } from './types';

/* -------------------------------------------------------------------------- */
/*  Config                                                                     */
/* -------------------------------------------------------------------------- */

export interface BudgetConfig {
  /** Sustained per-client ceiling, bytes per second. This is the hard limit. */
  bytesPerSecond: number;
  /** Network snapshot rate in Hz. Sets the per-tick allowance. */
  tickRate: number;
  /** Bucket depth, expressed as a multiple of the per-tick allowance. */
  burstTicks: number;
  /** Hard cap on one snapshot, bytes. Keep under the transport's MTU. */
  maxBytesPerSnapshot: number;
  /** Floor: even a fully throttled client gets at least this much. */
  minBytesPerSnapshot: number;
  /** Rolling window used to measure the achieved rate, in ticks. */
  windowTicks: number;
  /** Utilisation (0..1) above which degradation pressure builds. */
  degradeUp: number;
  /** Utilisation below which pressure bleeds off again. */
  degradeDown: number;
  /** Consecutive over-utilised ticks before the level increases. */
  pressureUpTicks: number;
  /** Consecutive under-utilised ticks before the level decreases. */
  pressureDownTicks: number;
}

/**
 * 12 kB/s = 96 kbit/s per client. Twelve clients is then ~1.15 Mbit/s of host
 * uplink, which a typical home connection can actually sustain. Raise it for a
 * dedicated server; the rest of the stack does not care where the number
 * came from.
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  bytesPerSecond: 12000,
  tickRate: 20,
  burstTicks: 3,
  maxBytesPerSnapshot: 1100,
  minBytesPerSnapshot: 64,
  windowTicks: 40,
  degradeUp: 0.9,
  degradeDown: 0.65,
  pressureUpTicks: 8,
  pressureDownTicks: 20,
};

/* -------------------------------------------------------------------------- */
/*  Meter                                                                      */
/* -------------------------------------------------------------------------- */

export interface GroupCost {
  name: string;
  /** Bits attributed to this group over the meter's lifetime. */
  bits: number;
  bytes: number;
  /** Fraction of all metered bits, 0..1. */
  share: number;
  /** Bits attributed during the most recent completed tick. */
  lastBits: number;
}

/**
 * Attribution of bits to named buckets. Groups come from the schema
 * (`FieldDef.group`) plus the structural overheads the encoder adds.
 */
export class BandwidthMeter {
  private bits = new Map<string, number>();
  private tickBits = new Map<string, number>();
  private lastTickBits = new Map<string, number>();
  totalBits = 0;
  totalTickBits = 0;

  addBits(group: string, bits: number): void {
    if (bits <= 0) return;
    this.bits.set(group, (this.bits.get(group) ?? 0) + bits);
    this.tickBits.set(group, (this.tickBits.get(group) ?? 0) + bits);
    this.totalBits += bits;
    this.totalTickBits += bits;
  }

  addBytes(group: string, bytes: number): void { this.addBits(group, bytes * 8); }

  /** Closes the current tick's attribution window. */
  endTick(): void {
    this.lastTickBits = this.tickBits;
    this.tickBits = new Map();
    this.totalTickBits = 0;
  }

  /** Sorted heaviest-first. */
  groups(): GroupCost[] {
    const out: GroupCost[] = [];
    const total = this.totalBits || 1;
    for (const [name, bits] of this.bits) {
      out.push({
        name,
        bits,
        bytes: bits / 8,
        share: bits / total,
        lastBits: this.lastTickBits.get(name) ?? 0,
      });
    }
    out.sort((a, b) => b.bits - a.bits);
    return out;
  }

  group(name: string): number { return this.bits.get(name) ?? 0; }

  reset(): void {
    this.bits.clear();
    this.tickBits.clear();
    this.lastTickBits.clear();
    this.totalBits = 0;
    this.totalTickBits = 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-client budget                                                          */
/* -------------------------------------------------------------------------- */

export interface BudgetStats {
  clientId: ClientId;
  /** Measured rate over the rolling window, bytes/second. */
  bytesPerSecond: number;
  /** bytesPerSecond / config.bytesPerSecond. */
  utilisation: number;
  degradeLevel: number;
  snapshots: number;
  totalBytes: number;
  /** Snapshots that hit the allowance and had to drop entities. */
  truncations: number;
  /** Entities relevance said to send that the budget refused. */
  droppedEntities: number;
  /** Bytes currently banked in the token bucket. */
  tokens: number;
  meanBytes: number;
}

export class ClientBudget {
  readonly clientId: ClientId;
  readonly config: BudgetConfig;
  readonly meter = new BandwidthMeter();

  /** 0 = full fidelity, 3 = maximum degradation. Fed to InterestManager. */
  degradeLevel = 0;

  private tokens: number;
  private perTick: number;
  private depth: number;

  private window: Float64Array;
  private windowIndex = 0;
  private windowFilled = 0;
  private windowSum = 0;

  private pressure = 0;
  private allowanceThisTick = 0;
  private currentTick: NetTick = -1;

  snapshots = 0;
  totalBytes = 0;
  truncations = 0;
  droppedEntities = 0;
  lastBytes = 0;
  peakBytes = 0;

  constructor(clientId: ClientId, config: BudgetConfig) {
    this.clientId = clientId;
    this.config = config;
    this.perTick = config.bytesPerSecond / config.tickRate;
    this.depth = this.perTick * config.burstTicks;
    this.tokens = this.perTick;
    this.window = new Float64Array(Math.max(1, Math.floor(config.windowTicks)));
  }

  /**
   * Refills the bucket and returns how many bytes this snapshot may occupy.
   * Idempotent within a tick, so a caller may ask twice without double-refilling.
   */
  beginTick(tick: NetTick): number {
    if (tick === this.currentTick) return this.allowanceThisTick;
    this.currentTick = tick;
    this.tokens = Math.min(this.depth, this.tokens + this.perTick);
    const cfg = this.config;
    let a = Math.floor(this.tokens);
    if (a > cfg.maxBytesPerSnapshot) a = cfg.maxBytesPerSnapshot;
    if (a < cfg.minBytesPerSnapshot) a = cfg.minBytesPerSnapshot;
    this.allowanceThisTick = a;
    return a;
  }

  /** Bytes the encoder may still spend this tick (after `beginTick`). */
  get allowance(): number { return this.allowanceThisTick; }

  /**
   * Records what was actually sent, rolls the measurement window and updates the
   * degradation level. `truncated` means relevance had more to say than fitted.
   */
  commit(bytes: number, truncated = false, dropped = 0): void {
    this.tokens -= bytes;
    // A snapshot is allowed to overshoot the bucket by at most one tick's worth
    // (the min-size floor can force this); it is paid back on the next ticks.
    if (this.tokens < -this.perTick) this.tokens = -this.perTick;

    this.snapshots++;
    this.totalBytes += bytes;
    this.lastBytes = bytes;
    if (bytes > this.peakBytes) this.peakBytes = bytes;
    if (truncated) this.truncations++;
    this.droppedEntities += dropped;

    // Rolling window of per-tick byte counts.
    const i = this.windowIndex;
    this.windowSum -= this.window[i];
    this.window[i] = bytes;
    this.windowSum += bytes;
    this.windowIndex = (i + 1) % this.window.length;
    if (this.windowFilled < this.window.length) this.windowFilled++;

    this.meter.endTick();
    this.updateDegrade();
  }

  private updateDegrade(): void {
    const cfg = this.config;
    const util = this.utilisation;
    if (util > cfg.degradeUp) {
      this.pressure = this.pressure < 0 ? 1 : this.pressure + 1;
      if (this.pressure >= cfg.pressureUpTicks && this.degradeLevel < 3) {
        this.degradeLevel++;
        this.pressure = 0;
      }
    } else if (util < cfg.degradeDown) {
      this.pressure = this.pressure > 0 ? -1 : this.pressure - 1;
      if (-this.pressure >= cfg.pressureDownTicks && this.degradeLevel > 0) {
        this.degradeLevel--;
        this.pressure = 0;
      }
    } else {
      this.pressure = 0;
    }
  }

  /** Measured send rate over the rolling window, bytes/second. */
  get bytesPerSecond(): number {
    if (this.windowFilled === 0) return 0;
    return (this.windowSum / this.windowFilled) * this.config.tickRate;
  }

  get utilisation(): number {
    return this.bytesPerSecond / (this.config.bytesPerSecond || 1);
  }

  /** True when the sustained rate has exceeded the contract. Should never happen. */
  get overCeiling(): boolean { return this.bytesPerSecond > this.config.bytesPerSecond * 1.02; }

  stats(): BudgetStats {
    return {
      clientId: this.clientId,
      bytesPerSecond: this.bytesPerSecond,
      utilisation: this.utilisation,
      degradeLevel: this.degradeLevel,
      snapshots: this.snapshots,
      totalBytes: this.totalBytes,
      truncations: this.truncations,
      droppedEntities: this.droppedEntities,
      tokens: this.tokens,
      meanBytes: this.snapshots > 0 ? this.totalBytes / this.snapshots : 0,
    };
  }

  reset(): void {
    this.tokens = this.perTick;
    this.window.fill(0);
    this.windowIndex = 0;
    this.windowFilled = 0;
    this.windowSum = 0;
    this.pressure = 0;
    this.degradeLevel = 0;
    this.snapshots = 0;
    this.totalBytes = 0;
    this.truncations = 0;
    this.droppedEntities = 0;
    this.lastBytes = 0;
    this.peakBytes = 0;
    this.currentTick = -1;
    this.allowanceThisTick = 0;
    this.meter.reset();
  }
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                   */
/* -------------------------------------------------------------------------- */

export interface BudgetTotals {
  clients: number;
  /** Sum of the per-client measured rates — the host's uplink cost. */
  uplinkBytesPerSecond: number;
  /** Ceiling the host has committed to across all clients. */
  ceilingBytesPerSecond: number;
  worstUtilisation: number;
  degraded: number;
}

export class BandwidthBudget {
  readonly config: BudgetConfig;
  private clients = new Map<ClientId, ClientBudget>();

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  add(clientId: ClientId, override: Partial<BudgetConfig> = {}): ClientBudget {
    let c = this.clients.get(clientId);
    if (!c) {
      const cfg = Object.keys(override).length > 0 ? { ...this.config, ...override } : this.config;
      c = new ClientBudget(clientId, cfg);
      this.clients.set(clientId, c);
    }
    return c;
  }

  remove(clientId: ClientId): void { this.clients.delete(clientId); }

  get(clientId: ClientId): ClientBudget | undefined { return this.clients.get(clientId); }

  /** Throwing accessor for call sites where a missing client is a bug. */
  client(clientId: ClientId): ClientBudget {
    const c = this.clients.get(clientId);
    if (!c) throw new Error(`[Budget] unknown client ${clientId}`);
    return c;
  }

  all(): ClientBudget[] { return Array.from(this.clients.values()); }

  totals(): BudgetTotals {
    let uplink = 0;
    let ceiling = 0;
    let worst = 0;
    let degraded = 0;
    for (const c of this.clients.values()) {
      uplink += c.bytesPerSecond;
      ceiling += c.config.bytesPerSecond;
      if (c.utilisation > worst) worst = c.utilisation;
      if (c.degradeLevel > 0) degraded++;
    }
    return {
      clients: this.clients.size,
      uplinkBytesPerSecond: uplink,
      ceilingBytesPerSecond: ceiling,
      worstUtilisation: worst,
      degraded,
    };
  }

  reset(): void { for (const c of this.clients.values()) c.reset(); }
}
