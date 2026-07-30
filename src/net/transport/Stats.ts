/**
 * Transport telemetry: RTT/jitter estimation, loss accounting and rate windows,
 * plus the tiny `sys` channel wire format they ride on.
 *
 * Why measure on an unreliable channel: RTT sampled over a reliable channel is a
 * lie under loss, because a retransmit inflates the sample by a whole RTO. The
 * `sys` channel is unreliable and unordered, sharing the same path as `state`, so
 * what it measures is what the gameplay packets actually experience.
 *
 * Why the peer reports back: a sender cannot see its own outbound loss. Each side
 * counts what it received and what it expected (from sequence gaps) and ships
 * those cumulative counters in every keepalive. `lossOut` is therefore the peer's
 * measured `lossIn`, not a guess from unacked pings.
 */

export const SYS_PING = 1;
export const SYS_PONG = 2;
export const SYS_BYE = 3;

/** Fixed size of a PING/PONG packet. */
export const SYS_PACKET_BYTES = 16;

export interface SysPacket {
  type: number;
  /** Ping sequence, 16-bit wrapping. PONG echoes the PING's value. */
  seq: number;
  /** Sender clock in ms, truncated to u32. PONG echoes the PING's value verbatim. */
  sendTimeMs: number;
  /** Cumulative sequenced packets the sender has received. */
  recvCount: number;
  /** Cumulative sequenced packets the sender expected (received + sequence gaps). */
  expectCount: number;
}

export function encodeSys(p: SysPacket, out?: Uint8Array): Uint8Array {
  const buf = out ?? new Uint8Array(SYS_PACKET_BYTES);
  const dv = new DataView(buf.buffer, buf.byteOffset, SYS_PACKET_BYTES);
  dv.setUint8(0, p.type);
  dv.setUint8(1, 0);
  dv.setUint16(2, p.seq & 0xffff, true);
  dv.setUint32(4, p.sendTimeMs >>> 0, true);
  dv.setUint32(8, p.recvCount >>> 0, true);
  dv.setUint32(12, p.expectCount >>> 0, true);
  return buf;
}

export function decodeSys(bytes: Uint8Array): SysPacket | null {
  if (bytes.length < SYS_PACKET_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return {
    type: dv.getUint8(0),
    seq: dv.getUint16(2, true),
    sendTimeMs: dv.getUint32(4, true),
    recvCount: dv.getUint32(8, true),
    expectCount: dv.getUint32(12, true),
  };
}

export function encodeBye(reason: string): Uint8Array {
  const body = new TextEncoder().encode(reason.slice(0, 120));
  const buf = new Uint8Array(1 + body.length);
  buf[0] = SYS_BYE;
  buf.set(body, 1);
  return buf;
}

export function decodeBye(bytes: Uint8Array): string {
  if (bytes.length <= 1) return 'peer closed';
  return new TextDecoder().decode(bytes.subarray(1));
}

/** Unsigned 32-bit millisecond difference; correct across the u32 wrap. */
export function u32Delta(nowMs: number, thenMs: number): number {
  return ((nowMs >>> 0) - (thenMs >>> 0)) >>> 0;
}

/**
 * Sliding-window rate meter. Ten 100 ms buckets over one second: smooth enough to
 * read on a HUD, cheap enough to run per channel per peer.
 */
export class RateWindow {
  private readonly buckets: Float64Array;
  private readonly bucketMs: number;
  private cursor = 0;
  private bucketStartMs = 0;
  private started = false;

  constructor(windowMs = 1000, bucketCount = 10) {
    this.buckets = new Float64Array(bucketCount);
    this.bucketMs = windowMs / bucketCount;
  }

  add(value: number): void {
    this.buckets[this.cursor] += value;
  }

  advance(nowMs: number): void {
    if (!this.started) {
      this.started = true;
      this.bucketStartMs = nowMs;
      return;
    }
    let elapsed = nowMs - this.bucketStartMs;
    if (elapsed < this.bucketMs) return;
    let steps = Math.floor(elapsed / this.bucketMs);
    if (steps > this.buckets.length) steps = this.buckets.length;
    for (let i = 0; i < steps; i++) {
      this.cursor = (this.cursor + 1) % this.buckets.length;
      this.buckets[this.cursor] = 0;
    }
    this.bucketStartMs += steps * this.bucketMs;
    // Guard against a caller that jumped far ahead.
    if (nowMs - this.bucketStartMs > this.bucketMs * this.buckets.length) {
      this.bucketStartMs = nowMs;
    }
  }

  /** Units per second across the window. */
  get perSecond(): number {
    let sum = 0;
    for (let i = 0; i < this.buckets.length; i++) sum += this.buckets[i];
    return (sum * 1000) / (this.bucketMs * this.buckets.length);
  }

  reset(): void {
    this.buckets.fill(0);
    this.cursor = 0;
    this.started = false;
  }
}

/**
 * RFC 6298 smoothed RTT and mean deviation. `jitter` here is `rttvar`: the
 * expected swing of the next sample, which is the number a jitter buffer should
 * actually be sized from.
 */
export class RttEstimator {
  srtt = 0;
  rttvar = 0;
  min = Number.POSITIVE_INFINITY;
  last = 0;
  samples = 0;

  addSample(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 60000) return;
    this.last = rttMs;
    if (rttMs < this.min) this.min = rttMs;
    if (this.samples === 0) {
      this.srtt = rttMs;
      this.rttvar = rttMs / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rttMs);
      this.srtt = 0.875 * this.srtt + 0.125 * rttMs;
    }
    this.samples++;
  }

  reset(): void {
    this.srtt = 0;
    this.rttvar = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.last = 0;
    this.samples = 0;
  }
}

/**
 * Loss over a sliding time window, from cumulative (received, expected) counters.
 * Both directions use the same maths; only the source of the counters differs.
 *
 * A window rather than an EMA of per-tick ratios, for two reasons. Packet loss is
 * a ratio of counts, and averaging ratios computed from tiny samples is
 * statistically wrong — one dropped packet out of three keepalives reads as 33%
 * loss. And an EMA decays toward zero whenever traffic pauses, so a link that has
 * gone quiet because it is broken reports a healthy 0%.
 *
 * The window refuses to answer until it has seen `minExpect` packets, holding the
 * previous value instead of inventing a number from two samples.
 */
export class LossEstimator {
  value = 0;
  private readonly windowMs: number;
  private readonly minExpect: number;
  private readonly ts: number[] = [];
  private readonly recvs: number[] = [];
  private readonly expects: number[] = [];

  constructor(windowMs = 5000, minExpect = 20) {
    this.windowMs = windowMs;
    this.minExpect = minExpect;
  }

  /** Feed cumulative counters. Returns the loss fraction 0..1 over the window. */
  update(nowMs: number, recv: number, expect: number): number {
    this.ts.push(nowMs);
    this.recvs.push(recv);
    this.expects.push(expect);
    while (this.ts.length > 2 && this.ts[0] < nowMs - this.windowMs) {
      this.ts.shift();
      this.recvs.shift();
      this.expects.shift();
    }
    const dRecv = recv - this.recvs[0];
    const dExpect = expect - this.expects[0];
    if (dExpect >= this.minExpect) {
      this.value = Math.max(0, Math.min(1, 1 - dRecv / dExpect));
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.ts.length = 0;
    this.recvs.length = 0;
    this.expects.length = 0;
  }
}
