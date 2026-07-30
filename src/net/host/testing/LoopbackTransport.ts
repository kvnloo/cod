/**
 * In-process transport with simulated latency, jitter and loss.
 *
 * Netcode that is only ever exercised on a perfect link is netcode that has not
 * been tested. This lets the whole host/migration path run headlessly in Node,
 * deterministically (all randomness comes from a seeded stream), with a virtual
 * clock — so a "30 second match" costs milliseconds and produces the same result
 * every run.
 *
 * It satisfies the same `Transport` port as the real WebRTC DataChannel link, so
 * nothing above it can tell the difference.
 */

import { Rand } from '../../../core/Rand';
import type { Channel, Transport } from '../ports';
import type { PeerId } from '../types';

export interface LinkConditions {
  /** One-way latency in ms. */
  latencyMs: number;
  /** Uniform +/- jitter added to latency, ms. */
  jitterMs: number;
  /** Fraction of unreliable packets dropped, 0..1. Reliable packets never drop. */
  loss: number;
}

export const PERFECT_LINK: LinkConditions = { latencyMs: 0, jitterMs: 0, loss: 0 };
export const TYPICAL_LINK: LinkConditions = { latencyMs: 28, jitterMs: 8, loss: 0.02 };

interface Packet {
  at: number;
  seq: number;
  from: PeerId;
  to: PeerId;
  data: Uint8Array;
  channel: Channel;
}

/**
 * The virtual network. Create ports for each peer, wire them together, then call
 * `advanceTo(ms)` from the test loop.
 */
export class LoopbackNetwork {
  private ports = new Map<PeerId, LoopbackPort>();
  private queue: Packet[] = [];
  private links = new Map<string, LinkConditions>();
  private rand: Rand;
  private seq = 0;
  now = 0;

  totalSent = 0;
  totalBytes = 0;
  totalDropped = 0;

  constructor(seed = 0xc0ffee, public defaults: LinkConditions = PERFECT_LINK) {
    this.rand = new Rand(seed);
  }

  createPort(id: PeerId): Transport {
    const p = new LoopbackPort(this, id);
    this.ports.set(id, p);
    return p;
  }

  /** Symmetric connect. Both sides see an `onPeerJoin`. */
  connect(a: PeerId, b: PeerId, cond?: LinkConditions): void {
    const pa = this.ports.get(a), pb = this.ports.get(b);
    if (!pa || !pb) throw new Error(`[loopback] connect: unknown peer ${a}/${b}`);
    if (cond) this.links.set(linkKey(a, b), cond);
    pa.addPeer(b);
    pb.addPeer(a);
  }

  disconnect(a: PeerId, b: PeerId, reason = 'closed'): void {
    this.ports.get(a)?.removePeer(b, reason);
    this.ports.get(b)?.removePeer(a, reason);
    this.queue = this.queue.filter(
      (p) => !((p.from === a && p.to === b) || (p.from === b && p.to === a)),
    );
  }

  /** Simulate a peer vanishing: every link drops, in-flight packets are lost. */
  kill(id: PeerId, reason = 'timeout'): void {
    const port = this.ports.get(id);
    if (!port) return;
    for (const other of [...port.peers()]) this.disconnect(id, other, reason);
    port.dead = true;
    this.queue = this.queue.filter((p) => p.from !== id && p.to !== id);
  }

  conditions(a: PeerId, b: PeerId): LinkConditions {
    return this.links.get(linkKey(a, b)) ?? this.defaults;
  }

  enqueue(from: PeerId, to: PeerId, data: Uint8Array, channel: Channel): void {
    const src = this.ports.get(from);
    const dst = this.ports.get(to);
    if (!src || !dst || src.dead || dst.dead) return;
    if (!src.peers().includes(to)) return;

    const c = this.conditions(from, to);
    this.totalSent++;
    this.totalBytes += data.byteLength;
    if (channel === 'unreliable' && c.loss > 0 && this.rand.next() < c.loss) {
      this.totalDropped++;
      return;
    }
    const jitter = c.jitterMs > 0 ? this.rand.signed() * c.jitterMs : 0;
    const at = this.now + Math.max(0, c.latencyMs + jitter);
    this.queue.push({ at, seq: this.seq++, from, to, data, channel });
  }

  /** Deliver everything due at or before `ms`, in (time, sequence) order. */
  advanceTo(ms: number): void {
    this.now = ms;
    if (this.queue.length === 0) return;
    // Reliable traffic must arrive in send order even when jitter would reorder it.
    const due = this.queue.filter((p) => p.at <= ms);
    if (due.length === 0) return;
    this.queue = this.queue.filter((p) => p.at > ms);
    due.sort((a, b) => {
      if (a.channel === 'reliable' && b.channel === 'reliable' && a.from === b.from && a.to === b.to) {
        return a.seq - b.seq;
      }
      return a.at - b.at || a.seq - b.seq;
    });
    for (const p of due) {
      const dst = this.ports.get(p.to);
      if (!dst || dst.dead) continue;
      dst.deliver(p.from, p.data, p.channel);
    }
  }

  inFlight(): number { return this.queue.length; }
}

class LoopbackPort implements Transport {
  private connected: PeerId[] = [];
  private msgCbs = new Set<(from: PeerId, data: Uint8Array, channel: Channel) => void>();
  private joinCbs = new Set<(peer: PeerId) => void>();
  private leaveCbs = new Set<(peer: PeerId, reason: string) => void>();
  dead = false;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(private net: LoopbackNetwork, readonly localId: PeerId) { }

  peers(): readonly PeerId[] { return this.connected; }

  send(to: PeerId, data: Uint8Array, channel: Channel): void {
    if (this.dead) return;
    this.bytesSent += data.byteLength;
    this.net.enqueue(this.localId, to, data, channel);
  }

  broadcast(data: Uint8Array, channel: Channel): void {
    for (const p of this.connected) this.send(p, data, channel);
  }

  onMessage(cb: (from: PeerId, data: Uint8Array, channel: Channel) => void): () => void {
    this.msgCbs.add(cb); return () => this.msgCbs.delete(cb);
  }
  onPeerJoin(cb: (peer: PeerId) => void): () => void {
    this.joinCbs.add(cb); return () => this.joinCbs.delete(cb);
  }
  onPeerLeave(cb: (peer: PeerId, reason: string) => void): () => void {
    this.leaveCbs.add(cb); return () => this.leaveCbs.delete(cb);
  }

  addPeer(id: PeerId): void {
    if (this.dead || this.connected.includes(id)) return;
    this.connected.push(id);
    for (const cb of this.joinCbs) cb(id);
  }

  removePeer(id: PeerId, reason: string): void {
    const i = this.connected.indexOf(id);
    if (i < 0) return;
    this.connected.splice(i, 1);
    for (const cb of this.leaveCbs) cb(id, reason);
  }

  deliver(from: PeerId, data: Uint8Array, channel: Channel): void {
    if (this.dead) return;
    this.bytesReceived += data.byteLength;
    for (const cb of this.msgCbs) cb(from, data, channel);
  }

  close(): void { this.dead = true; this.connected.length = 0; }
}

function linkKey(a: PeerId, b: PeerId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
