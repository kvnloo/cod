/**
 * An in-process, deterministic network for testing prediction.
 *
 * Stands in for one direction of a WebRTC DataChannel: configurable one-way
 * delay, jitter, loss and reordering, driven by simulated time rather than
 * timers so a whole match can be replayed in milliseconds and produce the same
 * numbers every run. All randomness comes from the seeded `Rand` — a
 * `Math.random()` here would make every latency measurement unreproducible.
 *
 * When the transport module's real `LoopbackTransport` lands this becomes an
 * adapter: it only needs `send` and a `pump` that hands messages to a callback.
 */

import { Rand } from '../../../core/Rand';

export interface LatencyOptions {
  /** Round-trip time in milliseconds; one-way delay is half of it. */
  rttMs: number;
  /** Peak +/- deviation applied to each packet's delay, milliseconds. */
  jitterMs?: number;
  /** Fraction of packets dropped, 0..1. */
  loss?: number;
  /** False models an unreliable/unordered channel; packets may overtake. */
  ordered?: boolean;
  seed?: number | string;
}

interface Envelope<T> {
  due: number;
  order: number;
  payload: T;
}

export class LatencyLink<T> {
  readonly options: Required<LatencyOptions>;
  /** Packets accepted for delivery. */
  sent = 0;
  /** Packets discarded by the loss model. */
  dropped = 0;
  /** Packets handed to the receiver. */
  delivered = 0;
  /** Packets that arrived after a later-sent packet. */
  reordered = 0;

  private readonly rand: Rand;
  private queue: Envelope<T>[] = [];
  private counter = 0;
  private lastDeliveredOrder = -1;

  constructor(options: LatencyOptions) {
    this.options = {
      rttMs: options.rttMs,
      jitterMs: options.jitterMs ?? 0,
      loss: options.loss ?? 0,
      ordered: options.ordered ?? false,
      seed: options.seed ?? 'latency-link',
    };
    this.rand = new Rand(this.options.seed);
  }

  /** One-way delay applied to the next packet, milliseconds. */
  private nextDelay(): number {
    const base = this.options.rttMs * 0.5;
    const j = this.options.jitterMs;
    const delay = j > 0 ? base + this.rand.signed() * j : base;
    return Math.max(0, delay);
  }

  /** Offers a packet to the link at simulated time `nowMs`. */
  send(payload: T, nowMs: number): boolean {
    this.sent++;
    if (this.options.loss > 0 && this.rand.next() < this.options.loss) {
      this.dropped++;
      return false;
    }
    let due = nowMs + this.nextDelay();
    if (this.options.ordered) {
      // A reliable-ordered channel cannot deliver before anything already queued.
      for (const e of this.queue) if (e.due > due) due = e.due;
    }
    this.queue.push({ due, order: this.counter++, payload });
    return true;
  }

  /**
   * Delivers everything due at or before `nowMs`, oldest-due first. Returns the
   * number delivered.
   */
  pump(nowMs: number, deliver: (payload: T) => void): number {
    if (this.queue.length === 0) return 0;
    this.queue.sort((a, b) => (a.due - b.due) || (a.order - b.order));
    let n = 0;
    while (this.queue.length > 0 && this.queue[0].due <= nowMs) {
      const e = this.queue.shift() as Envelope<T>;
      if (e.order < this.lastDeliveredOrder) this.reordered++;
      else this.lastDeliveredOrder = e.order;
      this.delivered++;
      n++;
      deliver(e.payload);
    }
    return n;
  }

  /** Packets still in flight. */
  get inFlight(): number { return this.queue.length; }

  clear(): void {
    this.queue.length = 0;
    this.lastDeliveredOrder = -1;
  }
}
