/**
 * The install point: a `Transport` decorator.
 *
 * `PeerHost`, `PeerSession` and `NetSystem` all take a `Transport` in their
 * options, so wrapping it is the only seam that lets the guards run in front of
 * the real authority **without editing a single file another agent owns**:
 *
 * ```ts
 * const guard = new HostGuard({ selfStableId: myId });
 * session = new PeerSession({ transport: guardTransport(raw, guard), ... });
 * ```
 *
 * Everything above the wrapper — handshake, migration, replication, prediction —
 * is untouched and cannot tell the difference. Everything below it is unchanged
 * bytes. The guard sees exactly what the transport delivers, tagged with the
 * `PeerId` the transport attests, which is the only identity in this system that
 * an attacker cannot choose.
 *
 * Cost: one extra `codec.decode` per inbound frame (the application decodes
 * again). With `JsonCodec` that is the dominant term and it is measured in
 * `tools/net-cheat.mjs` §B4. A binary codec would make it negligible; if it ever
 * matters, the honest fix is for the codec port to expose "decode once, hand the
 * object up", not to weaken the check.
 */

import type { ClientGuard } from './ClientGuard';
import type { Channel, Codec, Transport } from '../host/ports';
import type { PeerId } from '../host/types';

export interface GuardTransportOptions {
  /** Must be the same codec the host/session is constructed with. */
  codec: Codec;
  /**
   * Monotonic clock in ms. Defaults to `performance.now()` / `Date.now()`.
   *
   * **Must be the same clock the session is driven with** (`PeerSession.update`'s
   * `nowMs`). Every rate limit in the policy is expressed against it, so a guard
   * reading wall time while the match runs on a virtual clock will see a whole
   * match arrive in one instant and refuse honest traffic. That is not
   * hypothetical: it is what this option was added for after `tools/net-cheat.mjs`
   * §B4 refused 56 legitimate frames.
   */
  now?: () => number;
  /**
   * Frames larger than `policy.maxFrameBytes` are refused without being decoded.
   * Set false only if some other layer already bounds datagram size.
   */
  enforceFrameSize?: boolean;
}

/** Wrap a transport so every inbound frame passes `guard` before delivery. */
export function guardTransport(
  inner: Transport,
  guard: ClientGuard,
  opts: GuardTransportOptions,
): Transport {
  return new GuardedTransport(inner, guard, opts);
}

class GuardedTransport implements Transport {
  private inner: Transport;
  private guard: ClientGuard;
  private codec: Codec;
  private now: () => number;
  private enforceSize: boolean;

  private msgCbs = new Set<(from: PeerId, data: Uint8Array, channel: Channel) => void>();
  private unsubs: Array<() => void> = [];

  /** Frames refused before decode, by byte size. */
  oversizeDrops = 0;
  /** Frames the codec could not decode at all. */
  undecodable = 0;

  constructor(inner: Transport, guard: ClientGuard, opts: GuardTransportOptions) {
    this.inner = inner;
    this.guard = guard;
    this.codec = opts.codec;
    this.enforceSize = opts.enforceFrameSize ?? true;
    this.now = opts.now ?? defaultClock();

    this.unsubs.push(inner.onMessage((from, data, channel) => this.onRaw(from, data, channel)));
    this.unsubs.push(inner.onPeerLeave((peer) => this.guard.peerLeft(peer)));
  }

  private onRaw(from: PeerId, data: Uint8Array, channel: Channel): void {
    if (this.enforceSize && data.byteLength > this.guard.policy.maxFrameBytes) {
      this.oversizeDrops++;
      return;
    }
    let msg: unknown;
    try {
      msg = this.codec.decode(data);
    } catch {
      // A frame the codec cannot read is a frame the application cannot read
      // either; dropping it here just means the application's own try/catch
      // never runs. Counted so it is not invisible.
      this.undecodable++;
      return;
    }
    const verdict = this.guard.inbound(from, msg, this.now());
    if (verdict.action === 'drop') return;
    const out = verdict.action === 'rewrite' ? this.codec.encode(verdict.message) : data;
    for (const cb of this.msgCbs) cb(from, out, channel);
  }

  /* ------------------------------------------------- Transport port --- */

  get localId(): PeerId { return this.inner.localId; }
  peers(): readonly PeerId[] { return this.inner.peers(); }
  get bytesSent(): number { return this.inner.bytesSent; }
  get bytesReceived(): number { return this.inner.bytesReceived; }

  send(to: PeerId, data: Uint8Array, channel: Channel): void {
    this.observeOutbound(to, data);
    this.inner.send(to, data, channel);
  }

  broadcast(data: Uint8Array, channel: Channel): void {
    for (const p of this.inner.peers()) this.observeOutbound(p, data);
    this.inner.broadcast(data, channel);
  }

  /**
   * The guard learns from what we send: which peer we joined (so an unsolicited
   * welcome from anyone else is refusable) and which slot we welcomed a peer
   * into (so a forged `clientId` on an input frame is refusable).
   */
  private observeOutbound(to: PeerId, data: Uint8Array): void {
    try {
      const msg = this.codec.decode(data);
      if (msg && typeof msg === 'object') this.guard.outbound(to, msg as Record<string, unknown>);
    } catch { /* our own frame failed to decode; nothing to learn */ }
  }

  onMessage(cb: (from: PeerId, data: Uint8Array, channel: Channel) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }

  onPeerJoin(cb: (peer: PeerId) => void): () => void { return this.inner.onPeerJoin(cb); }
  onPeerLeave(cb: (peer: PeerId, reason: string) => void): () => void { return this.inner.onPeerLeave(cb); }

  close(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.msgCbs.clear();
    this.inner.close();
  }
}

function defaultClock(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf && typeof perf.now === 'function') return () => perf.now();
  return () => Date.now();
}
