/**
 * LoopbackTransport — two simulations, one process, one fake internet between them.
 *
 * This is the most load-bearing file in the transport layer, because it is how
 * every other netcode change gets tested. Prediction, reconciliation, interest
 * management and delta compression are all judged by how they behave at 120 ms
 * with 5% loss, and nobody is going to open two browsers for every iteration.
 *
 * Two design decisions make it useful rather than a toy:
 *
 * 1. **Virtual time.** `poll(nowMs)` is the only clock. Nothing here uses
 *    setTimeout, Date.now or performance.now. A test can run 60 simulated seconds
 *    in a few milliseconds of wall time, and — because impairment draws come from
 *    the seeded `Rand` in src/core/Rand.ts — the exact same packets drop on every
 *    run. A netcode bug found in CI is reproducible on a developer's machine from
 *    the seed alone.
 *
 * 2. **Impairment that matches the reliability model.** Unreliable packets are
 *    dropped outright. Reliable packets are never lost — they are *delayed by a
 *    retransmit timeout*, and on an ordered channel everything queued behind them
 *    is delayed too. That head-of-line stall is the real cost of putting gameplay
 *    state on a reliable channel, and a simulator that quietly delivered reliable
 *    packets on time would hide exactly the mistake it exists to catch.
 */

import { Rand } from '../../core/Rand';
import type {
  ChannelConfig,
  PeerId,
  ResolvedChannel,
  Transport,
  TransportListener,
  TransportOptions,
  Unsubscribe,
} from './Transport';
import { BaseTransport } from './BaseTransport';

export interface LinkConditions {
  /** One-way base delay in ms. Round-trip is roughly twice this. */
  latencyMs: number;
  /** Uniform +/- ms added to each packet's one-way delay. Causes reordering. */
  jitterMs: number;
  /** Probability 0..1 that an unreliable packet is discarded. */
  loss: number;
  /** Probability 0..1 that an unreliable packet is delivered twice. */
  duplicate: number;
  /**
   * When false, unreliable packets are forced to keep send order even under
   * jitter. Real UDP reorders; set false only to isolate a bug.
   */
  reorder: boolean;
  /** Serialisation cap in bytes/sec for this direction. Infinity for uncapped. */
  bandwidthBytesPerSec: number;
}

export const DEFAULT_CONDITIONS: LinkConditions = {
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  duplicate: 0,
  reorder: true,
  bandwidthBytesPerSec: Number.POSITIVE_INFINITY,
};

export interface LinkCounters {
  /** Packets handed to the link. */
  sent: number;
  /** Unreliable packets discarded by the loss model. */
  dropped: number;
  /** Unreliable packets delivered more than once. */
  duplicated: number;
  /** Reliable packets that took a retransmit penalty instead of being dropped. */
  retransmitted: number;
  /** Packets handed to the far end. Includes duplicates. */
  delivered: number;
  /** Wire bytes handed to the link. */
  bytes: number;
}

export interface LoopbackLinkOptions {
  seed?: number | string;
  /** Applied to both directions unless overridden. */
  conditions?: Partial<LinkConditions>;
  aToB?: Partial<LinkConditions>;
  bToA?: Partial<LinkConditions>;
  channels?: readonly ChannelConfig[];
  aId?: PeerId;
  bId?: PeerId;
  pingIntervalMs?: number;
  /** Default 0 — loopback links do not time out unless a test asks them to. */
  timeoutMs?: number;
}

interface Packet {
  deliverAtMs: number;
  order: number;
  channel: string;
  bytes: Uint8Array;
}

function newCounters(): LinkCounters {
  return { sent: 0, dropped: 0, duplicated: 0, retransmitted: 0, delivered: 0, bytes: 0 };
}

class Direction {
  conditions: LinkConditions;
  queue: Packet[] = [];
  nextFreeMs = 0;
  lastOrderedMs = new Map<string, number>();
  counters: LinkCounters = newCounters();
  byChannel = new Map<string, LinkCounters>();
  private seq = 0;

  constructor(conditions: LinkConditions) {
    this.conditions = conditions;
  }

  nextOrder(): number {
    return this.seq++;
  }

  /** Bump one counter on both the aggregate and the per-channel view. */
  bump(channel: string, key: keyof LinkCounters, by = 1): void {
    this.counters[key] += by;
    let c = this.byChannel.get(channel);
    if (!c) {
      c = newCounters();
      this.byChannel.set(channel, c);
    }
    c[key] += by;
  }

  resetCounters(): void {
    this.counters = newCounters();
    this.byChannel.clear();
  }
}

export type LinkDirection = 'aToB' | 'bToA';

/**
 * The pipe. Owns virtual time, the impairment model and both endpoints.
 * Build one with `createLoopbackPair`.
 */
export class LoopbackLink {
  readonly a: LoopbackTransport;
  readonly b: LoopbackTransport;
  readonly rand: Rand;

  /** Virtual clock in ms. Advanced only by `poll`. */
  timeMs = 0;

  private readonly ab: Direction;
  private readonly ba: Direction;
  private closed = false;

  constructor(opts: LoopbackLinkOptions = {}) {
    this.rand = new Rand(opts.seed ?? 'loopback');
    const base: LinkConditions = { ...DEFAULT_CONDITIONS, ...(opts.conditions ?? {}) };
    this.ab = new Direction({ ...base, ...(opts.aToB ?? {}) });
    this.ba = new Direction({ ...base, ...(opts.bToA ?? {}) });

    const shared: TransportOptions = {
      channels: opts.channels,
      pingIntervalMs: opts.pingIntervalMs ?? 250,
      timeoutMs: opts.timeoutMs ?? 0,
      clock: () => this.timeMs,
    };
    this.a = new LoopbackTransport(this, 'a', {
      ...shared,
      localId: opts.aId ?? 'peer-a',
      remoteId: opts.bId ?? 'peer-b',
    });
    this.b = new LoopbackTransport(this, 'b', {
      ...shared,
      localId: opts.bId ?? 'peer-b',
      remoteId: opts.aId ?? 'peer-a',
    });
  }

  /** Brings both endpoints up. Resolves on the next microtask. */
  async connect(): Promise<void> {
    await Promise.all([this.a.connect(), this.b.connect()]);
  }

  conditions(dir: LinkDirection): LinkConditions {
    return dir === 'aToB' ? this.ab.conditions : this.ba.conditions;
  }

  /** Change impairment mid-flight — lag spikes, a peer going over a cell tower. */
  setConditions(patch: Partial<LinkConditions>, dir?: LinkDirection): void {
    if (dir === undefined || dir === 'aToB') Object.assign(this.ab.conditions, patch);
    if (dir === undefined || dir === 'bToA') Object.assign(this.ba.conditions, patch);
  }

  counters(dir: LinkDirection): Readonly<LinkCounters> {
    return dir === 'aToB' ? this.ab.counters : this.ba.counters;
  }

  /**
   * Ground truth for one channel in one direction. Aggregate counters mix in the
   * transport's own keepalive traffic, so per-channel numbers are what a test
   * should assert against.
   */
  channelCounters(dir: LinkDirection, channel: string): Readonly<LinkCounters> {
    const d = dir === 'aToB' ? this.ab : this.ba;
    return d.byChannel.get(channel) ?? { sent: 0, dropped: 0, duplicated: 0, retransmitted: 0, delivered: 0, bytes: 0 };
  }

  resetCounters(): void {
    this.ab.resetCounters();
    this.ba.resetCounters();
  }

  /** Packets currently in flight in a direction. */
  inFlight(dir: LinkDirection): number {
    return (dir === 'aToB' ? this.ab : this.ba).queue.length;
  }

  /**
   * Advance virtual time to `nowMs`, deliver everything due, then pump both
   * endpoints so handlers run inside this call.
   */
  poll(nowMs: number): void {
    if (nowMs < this.timeMs) return;
    this.timeMs = nowMs;
    if (!this.closed) {
      this.deliver(this.ab, this.b, nowMs);
      this.deliver(this.ba, this.a, nowMs);
    }
    this.a.poll(nowMs);
    this.b.poll(nowMs);
  }

  /**
   * Run from the current time to `untilMs` in `stepMs` slices. Convenience for
   * tests: one call replaces a hand-written loop and guarantees the endpoints are
   * polled at a fixed rate.
   */
  run(untilMs: number, stepMs = 1000 / 60, onStep?: (nowMs: number) => void): void {
    let t = this.timeMs;
    while (t < untilMs) {
      t = Math.min(untilMs, t + stepMs);
      this.poll(t);
      onStep?.(t);
    }
  }

  close(reason = 'link closed'): void {
    this.closed = true;
    this.a.close(reason);
    this.b.close(reason);
    this.ab.queue.length = 0;
    this.ba.queue.length = 0;
  }

  /** Called by the endpoints. Applies the impairment model and queues. */
  submit(from: 'a' | 'b', ch: ResolvedChannel, bytes: Uint8Array): boolean {
    if (this.closed) return false;
    const dir = from === 'a' ? this.ab : this.ba;
    const c = dir.conditions;
    const now = this.timeMs;
    const wire = bytes.length + 48;

    dir.bump(ch.name, 'sent');
    dir.bump(ch.name, 'bytes', wire);

    // Serialisation delay: a capped pipe can only put one packet on the wire at a time.
    let base = now;
    if (c.bandwidthBytesPerSec !== Number.POSITIVE_INFINITY && c.bandwidthBytesPerSec > 0) {
      base = Math.max(now, dir.nextFreeMs);
      dir.nextFreeMs = base + (wire * 1000) / c.bandwidthBytesPerSec;
    }

    const oneWay = () => Math.max(0, c.latencyMs + (c.jitterMs > 0 ? this.rand.range(-c.jitterMs, c.jitterMs) : 0));

    let deliverAt = base + oneWay();
    const hit = c.loss > 0 && this.rand.next() < c.loss;

    if (hit) {
      if (!ch.reliable) {
        dir.bump(ch.name, 'dropped');
        return true; // The send "succeeded"; the network ate it. That is the point.
      }
      // SCTP does not lose reliable data, it pays for it in time.
      dir.bump(ch.name, 'retransmitted');
      deliverAt += Math.max(1, c.latencyMs * 2 + c.jitterMs);
    }

    // Ordered channels cannot deliver ahead of anything queued before them.
    if (ch.ordered || (!ch.reliable && !c.reorder)) {
      const prev = dir.lastOrderedMs.get(ch.name) ?? 0;
      if (deliverAt < prev) deliverAt = prev;
      dir.lastOrderedMs.set(ch.name, deliverAt);
    }

    dir.queue.push({ deliverAtMs: deliverAt, order: dir.nextOrder(), channel: ch.name, bytes });

    if (!ch.reliable && c.duplicate > 0 && this.rand.next() < c.duplicate) {
      dir.bump(ch.name, 'duplicated');
      dir.queue.push({
        deliverAtMs: base + oneWay(),
        order: dir.nextOrder(),
        channel: ch.name,
        bytes,
      });
    }
    return true;
  }

  private deliver(dir: Direction, dst: LoopbackTransport, nowMs: number): void {
    if (dir.queue.length === 0) return;
    const due: Packet[] = [];
    const keep: Packet[] = [];
    for (let i = 0; i < dir.queue.length; i++) {
      const p = dir.queue[i];
      if (p.deliverAtMs <= nowMs) due.push(p);
      else keep.push(p);
    }
    if (due.length === 0) return;
    dir.queue = keep;
    due.sort((x, y) => (x.deliverAtMs - y.deliverAtMs) || (x.order - y.order));
    for (let i = 0; i < due.length; i++) {
      dir.bump(due[i].channel, 'delivered');
      dst.deliver(due[i].channel, due[i].bytes);
    }
  }
}

/** One endpoint of a `LoopbackLink`. Never construct directly. */
export class LoopbackTransport extends BaseTransport {
  private readonly link: LoopbackLink;
  private readonly side: 'a' | 'b';

  constructor(link: LoopbackLink, side: 'a' | 'b', opts: TransportOptions) {
    super('loopback', opts);
    this.link = link;
    this.side = side;
  }

  protected doConnect(): Promise<void> {
    this.setState('connected', 'loopback');
    return Promise.resolve();
  }

  protected doClose(_reason: string): void {
    /* nothing to release */
  }

  protected rawSend(ch: ResolvedChannel, frame: Uint8Array): boolean {
    return this.link.submit(this.side, ch, frame);
  }

  /** Called by the link when a packet's delivery time arrives. */
  deliver(channel: string, bytes: Uint8Array): void {
    this.receiveRaw(channel, bytes);
  }
}

export function createLoopbackPair(opts: LoopbackLinkOptions = {}): LoopbackLink {
  return new LoopbackLink(opts);
}

/**
 * One host, N clients, all in this process — the shape a real match has.
 *
 * `LoopbackHub` implements the same `TransportListener` the WebRTC host does, so
 * host code written against it runs unchanged against real peers, and a headless
 * Node server later. Each client gets its own `LoopbackLink`, so you can give one
 * player 300 ms and 10% loss while another is on fibre.
 */
export class LoopbackHub implements TransportListener {
  readonly kind = 'loopback' as const;
  readonly localId: PeerId;

  private readonly links: LoopbackLink[] = [];
  private readonly hostSide: Transport[] = [];
  private readonly connHandlers = new Set<(t: Transport) => void>();
  private readonly discHandlers = new Set<(t: Transport, reason: string) => void>();
  private readonly opts: LoopbackLinkOptions;
  private counter = 0;
  private stopped = false;

  constructor(opts: LoopbackLinkOptions & { localId?: PeerId } = {}) {
    this.localId = opts.localId ?? 'host';
    this.opts = opts;
  }

  get connections(): readonly Transport[] {
    return this.hostSide;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  onConnection(fn: (t: Transport) => void): Unsubscribe {
    this.connHandlers.add(fn);
    return () => {
      this.connHandlers.delete(fn);
    };
  }

  onDisconnection(fn: (t: Transport, reason: string) => void): Unsubscribe {
    this.discHandlers.add(fn);
    return () => {
      this.discHandlers.delete(fn);
    };
  }

  /**
   * Attach a simulated client. Returns the client's transport plus the link so a
   * test can tune that one player's conditions.
   */
  addClient(
    clientId?: PeerId,
    conditions?: Partial<LinkConditions>,
  ): { client: Transport; host: Transport; link: LoopbackLink } {
    if (this.stopped) throw new Error('[LoopbackHub] stopped');
    const id = clientId ?? `client-${++this.counter}`;
    const link = new LoopbackLink({
      ...this.opts,
      seed: `${String(this.opts.seed ?? 'loopback')}:${id}`,
      conditions: { ...(this.opts.conditions ?? {}), ...(conditions ?? {}) },
      aId: this.localId,
      bId: id,
    });
    this.links.push(link);
    this.hostSide.push(link.a);

    link.b.onStateChange((state, reason) => {
      if (state === 'closed' || state === 'failed') this.drop(link, reason);
    });
    link.a.onStateChange((state, reason) => {
      if (state === 'closed' || state === 'failed') this.drop(link, reason);
    });

    void link.a.connect().catch(() => {});
    void link.b.connect().catch(() => {});
    for (const fn of this.connHandlers) fn(link.a);
    return { client: link.b, host: link.a, link };
  }

  private drop(link: LoopbackLink, reason: string): void {
    const i = this.links.indexOf(link);
    if (i < 0) return;
    this.links.splice(i, 1);
    const j = this.hostSide.indexOf(link.a);
    if (j >= 0) this.hostSide.splice(j, 1);
    for (const fn of this.discHandlers) fn(link.a, reason);
  }

  poll(nowMs: number): void {
    for (let i = this.links.length - 1; i >= 0; i--) this.links[i].poll(nowMs);
  }

  stop(reason = 'hub stopped'): void {
    this.stopped = true;
    for (const l of this.links.slice()) l.close(reason);
    this.links.length = 0;
    this.hostSide.length = 0;
  }
}
