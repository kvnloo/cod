/**
 * BaseTransport — everything that is identical no matter what the wire is.
 *
 * Channel resolution, the unreliable-sequenced filter, bandwidth budgets, the
 * keepalive/stat exchange, RTT/jitter/loss estimation, the inbound queue and the
 * `poll`-time dispatch all live here. A concrete transport supplies four things:
 * how to open, how to close, how to push one frame onto one channel, and a call
 * into `receiveRaw` when a frame lands.
 *
 * That split is why `WebSocketTransport` is ~150 lines: the interesting parts of
 * "being a transport" are not wire-specific.
 */

import type {
  ChannelConfig,
  ConnectionState,
  MessageHandler,
  PeerId,
  ResolvedChannel,
  StateHandler,
  Transport,
  TransportKind,
  TransportMessage,
  TransportOptions,
  TransportStats,
  Unsubscribe,
} from './Transport';
import {
  CH_SYS,
  DEFAULT_CHANNELS,
  TransportError,
  WIRE_OVERHEAD_BYTES,
  emptyStats,
  isTerminal,
  resolveChannels,
  seqDiff,
} from './Transport';
import {
  LossEstimator,
  RateWindow,
  RttEstimator,
  SYS_BYE,
  SYS_PING,
  SYS_PONG,
  decodeBye,
  decodeSys,
  encodeBye,
  encodeSys,
  u32Delta,
} from './Stats';

interface ChannelState {
  readonly cfg: ResolvedChannel;
  seqOut: number;
  seqIn: number;
  hasSeqIn: boolean;
  /**
   * Receipt history for the 32 sequences below `seqIn`, newest in bit 0. This is
   * what makes the loss figure honest under reordering: a packet that arrives
   * late fills a gap that was already counted against us, and must not be
   * counted a second time — while a duplicate must not be counted at all.
   */
  ackBits: number;
  tokens: number;
  lastRefillMs: number;
  bytesOut: number;
  bytesIn: number;
}

const defaultClock: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export abstract class BaseTransport implements Transport {
  readonly kind: TransportKind;
  localId: PeerId;
  remoteId: PeerId;

  protected readonly clock: () => number;
  protected readonly pingIntervalMs: number;
  protected readonly timeoutMs: number;

  protected readonly allChannels: ResolvedChannel[];
  private readonly chanByName = new Map<string, ChannelState>();
  private readonly chanById = new Map<number, ChannelState>();
  private readonly publicChannels: ResolvedChannel[];
  protected readonly sysChannel: ResolvedChannel | undefined;

  private _state: ConnectionState = 'new';
  private closeReason = '';
  private readonly _stats: TransportStats = emptyStats();

  private readonly inbox: TransportMessage[] = [];
  private readonly msgHandlers = new Set<MessageHandler>();
  private readonly stateHandlers = new Set<StateHandler>();

  private readonly rtt = new RttEstimator();
  private readonly lossInEst = new LossEstimator();
  private readonly lossOutEst = new LossEstimator();
  private readonly bytesInWin = new RateWindow();
  private readonly bytesOutWin = new RateWindow();
  private readonly packetsInWin = new RateWindow();
  private readonly packetsOutWin = new RateWindow();

  /** Cumulative sequenced packets we received / expected. Reported to the peer. */
  private recvCount = 0;
  private expectCount = 0;
  private peerRecvCount = 0;
  private peerExpectCount = 0;

  private pingSeqOut = 0;
  private pingSeqIn = 0;
  private hasPingSeqIn = false;
  private nextPingMs = 0;
  private timeMs = 0;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;
  private warnedOversize = false;

  constructor(kind: TransportKind, opts: TransportOptions = {}) {
    this.kind = kind;
    this.localId = opts.localId ?? 'local';
    this.remoteId = opts.remoteId ?? 'remote';
    this.clock = opts.clock ?? defaultClock;
    this.pingIntervalMs = opts.pingIntervalMs ?? 250;
    this.timeoutMs = opts.timeoutMs ?? 8000;

    const cfgs: readonly ChannelConfig[] = opts.channels ?? DEFAULT_CHANNELS;
    this.allChannels = resolveChannels(cfgs);
    for (const cfg of this.allChannels) {
      const st: ChannelState = {
        cfg,
        seqOut: 0,
        seqIn: 0,
        hasSeqIn: false,
        ackBits: 0,
        tokens: cfg.budgetBytesPerSec * cfg.burstSeconds,
        lastRefillMs: 0,
        bytesOut: 0,
        bytesIn: 0,
      };
      this.chanByName.set(cfg.name, st);
      this.chanById.set(cfg.id, st);
    }
    this.publicChannels = this.allChannels.filter((c) => c.name !== CH_SYS);
    this.sysChannel = this.allChannels.find((c) => c.name === CH_SYS);
    this.timeMs = this.clock();
  }

  /* ------------------------------------------------------------------ state */

  get state(): ConnectionState {
    return this._state;
  }

  get channels(): readonly ResolvedChannel[] {
    return this.publicChannels;
  }

  get stats(): Readonly<TransportStats> {
    return this._stats;
  }

  /** Wire ids, exposed so a multiplexing transport can map byte → channel name. */
  protected channelNameById(id: number): string | undefined {
    return this.chanById.get(id)?.cfg.name;
  }

  protected channelConfigByName(name: string): ResolvedChannel | undefined {
    return this.chanByName.get(name)?.cfg;
  }

  maxMessageBytes(channel: string): number {
    const ch = this.chanByName.get(channel);
    if (!ch) throw new TransportError('channel', `unknown channel "${channel}"`);
    return ch.cfg.maxMessageBytes;
  }

  onMessage(fn: MessageHandler): Unsubscribe {
    this.msgHandlers.add(fn);
    return () => {
      this.msgHandlers.delete(fn);
    };
  }

  onStateChange(fn: StateHandler): Unsubscribe {
    this.stateHandlers.add(fn);
    return () => {
      this.stateHandlers.delete(fn);
    };
  }

  protected setState(next: ConnectionState, reason = ''): void {
    if (this._state === next || isTerminal(this._state)) return;
    this._state = next;
    if (reason) this.closeReason = reason;
    if (next === 'connected') {
      this._stats.connectedAtMs = this.timeMs;
      this._stats.lastRecvMs = this.timeMs;
      this.nextPingMs = this.timeMs;
      const r = this.connectResolve;
      this.connectResolve = null;
      this.connectReject = null;
      r?.();
    } else if (isTerminal(next)) {
      const rej = this.connectReject;
      this.connectResolve = null;
      this.connectReject = null;
      rej?.(new TransportError('closed', `transport ${next}: ${reason || 'no reason'}`));
    }
    for (const fn of this.stateHandlers) {
      try {
        fn(next, reason || this.closeReason);
      } catch (err) {
        console.error('[Transport] state handler threw', err);
      }
    }
  }

  /* ---------------------------------------------------------------- connect */

  connect(): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (isTerminal(this._state)) {
      return Promise.reject(new TransportError('closed', `transport already ${this._state}`));
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.setState('connecting');
    // Deliberately synchronous: an in-process transport must be usable by the
    // very next statement, so a test can call connect() and then drive a plain
    // for-loop without awaiting a microtask that will never get a turn. Wires
    // that genuinely need I/O return a pending promise from doConnect and reach
    // 'connected' later, exactly as before.
    try {
      const r = this.doConnect() as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') {
        r.catch((err: unknown) => {
          this.setState('failed', err instanceof Error ? err.message : String(err));
        });
      }
    } catch (err) {
      this.setState('failed', err instanceof Error ? err.message : String(err));
    }
    return this.connectPromise;
  }

  close(reason = 'local close'): void {
    if (isTerminal(this._state) || this._state === 'closing') return;
    this.setState('closing', reason);
    if (this.sysChannel) {
      try {
        this.rawSend(this.sysChannel, encodeBye(reason));
      } catch {
        /* best effort */
      }
    }
    try {
      this.doClose(reason);
    } finally {
      this.setState('closed', reason);
    }
  }

  /** Terminal failure raised by a subclass (ICE failure, socket error, timeout). */
  protected fail(reason: string): void {
    if (isTerminal(this._state)) return;
    try {
      this.doClose(reason);
    } catch {
      /* ignore */
    }
    this.setState('failed', reason);
  }

  /* ------------------------------------------------------------------- send */

  send(channel: string, bytes: Uint8Array): boolean {
    const ch = this.chanByName.get(channel);
    if (!ch) throw new TransportError('channel', `unknown channel "${channel}"`);
    if (channel === CH_SYS) {
      throw new TransportError('channel', 'the "sys" channel is reserved by the transport');
    }
    return this.sendInternal(ch, bytes);
  }

  private sendInternal(ch: ChannelState, bytes: Uint8Array): boolean {
    if (this._state !== 'connected') {
      this._stats.dropsClosed++;
      return false;
    }
    if (bytes.length > ch.cfg.maxMessageBytes) {
      this._stats.dropsOversize++;
      if (!this.warnedOversize) {
        this.warnedOversize = true;
        console.warn(
          `[Transport] message of ${bytes.length}B exceeds ${ch.cfg.maxMessageBytes}B on channel ` +
            `"${ch.cfg.name}" (${ch.cfg.reliability}). Fragment at the application layer; an ` +
            'oversized unreliable message multiplies its own loss rate.',
        );
      }
      return false;
    }

    const frame = ch.cfg.sequenced ? prefixSeq(bytes, ch.seqOut) : bytes;
    const wire = frame.length + WIRE_OVERHEAD_BYTES;

    if (ch.cfg.budgetBytesPerSec !== Number.POSITIVE_INFINITY) {
      this.refill(ch);
      if (ch.tokens < wire) {
        this._stats.dropsBudget++;
        return false;
      }
      ch.tokens -= wire;
    }

    if (!this.rawSend(ch.cfg, frame)) return false;

    if (ch.cfg.sequenced) ch.seqOut = (ch.seqOut + 1) & 0xffff;
    ch.bytesOut += wire;
    this._stats.bytesOut += wire;
    this._stats.packetsOut++;
    this.bytesOutWin.add(wire);
    this.packetsOutWin.add(1);
    return true;
  }

  private refill(ch: ChannelState): void {
    const now = this.timeMs;
    if (ch.lastRefillMs === 0) {
      ch.lastRefillMs = now;
      return;
    }
    const dt = Math.max(0, now - ch.lastRefillMs) / 1000;
    ch.lastRefillMs = now;
    const cap = ch.cfg.budgetBytesPerSec * ch.cfg.burstSeconds;
    ch.tokens = Math.min(cap, ch.tokens + ch.cfg.budgetBytesPerSec * dt);
  }

  /* ---------------------------------------------------------------- receive */

  /**
   * Called by subclasses the instant a frame lands. Timestamps with the transport
   * clock, applies the sequence filter, then queues; handlers do not run until
   * `poll`.
   */
  protected receiveRaw(channelName: string, frame: Uint8Array): void {
    const ch = this.chanByName.get(channelName);
    if (!ch) return;
    const now = this.clock();
    this.timeMs = now;
    const wire = frame.length + WIRE_OVERHEAD_BYTES;
    ch.bytesIn += wire;
    this._stats.bytesIn += wire;
    this._stats.packetsIn++;
    this._stats.lastRecvMs = now;
    this.bytesInWin.add(wire);
    this.packetsInWin.add(1);

    if (channelName === CH_SYS) {
      this.handleSys(frame, now);
      return;
    }

    let payload = frame;
    if (ch.cfg.sequenced) {
      if (frame.length < 2) return;
      const seq = frame[0] | (frame[1] << 8);
      if (ch.hasSeqIn) {
        const d = seqDiff(seq, ch.seqIn);
        if (d <= 0) {
          // Older than what we have already delivered. The application never sees
          // it — that is the whole contract of `unreliable-sequenced` — but it
          // still counts as received so the loss figure is not inflated by mere
          // reordering. `expectCount` already advanced when the newer packet
          // opened this gap.
          this._stats.dropsStale++;
          const back = -d;
          if (back >= 1 && back <= 32) {
            const bit = 1 << (back - 1);
            if ((ch.ackBits & bit) === 0) {
              ch.ackBits = (ch.ackBits | bit) >>> 0;
              this.recvCount++;
            }
          }
          return;
        }
        ch.ackBits = d >= 32 ? 0 : (((ch.ackBits << d) | (1 << (d - 1))) >>> 0);
        this.recvCount++;
        this.expectCount += d;
      } else {
        ch.hasSeqIn = true;
        ch.ackBits = 0;
        this.recvCount++;
        this.expectCount++;
      }
      ch.seqIn = seq;
      payload = frame.subarray(2);
    }

    this.inbox.push({ channel: channelName, bytes: payload, recvMs: now });
  }

  private handleSys(frame: Uint8Array, now: number): void {
    if (frame.length === 0) return;
    const type = frame[0];
    if (type === SYS_BYE) {
      const reason = decodeBye(frame);
      if (!isTerminal(this._state)) {
        try {
          this.doClose(reason);
        } catch {
          /* ignore */
        }
        this.setState('closed', `peer closed: ${reason}`);
      }
      return;
    }
    const p = decodeSys(frame);
    if (!p) return;

    // Keepalives share the game path, so their sequence gaps are loss evidence too.
    if (type === SYS_PING) {
      if (this.hasPingSeqIn) {
        const d = seqDiff(p.seq, this.pingSeqIn);
        if (d > 0) {
          this.recvCount++;
          this.expectCount += d;
          this.pingSeqIn = p.seq;
        } else if (d < 0) {
          // Late, not lost: fills a gap already counted against the link.
          this.recvCount++;
        }
      } else {
        this.hasPingSeqIn = true;
        this.pingSeqIn = p.seq;
        this.recvCount++;
        this.expectCount++;
      }
      this.peerRecvCount = p.recvCount;
      this.peerExpectCount = p.expectCount;
      if (this.sysChannel) {
        this.sendSys({
          type: SYS_PONG,
          seq: p.seq,
          sendTimeMs: p.sendTimeMs,
          recvCount: this.recvCount,
          expectCount: this.expectCount,
        });
      }
      return;
    }

    if (type === SYS_PONG) {
      this.rtt.addSample(u32Delta(Math.round(now), p.sendTimeMs));
      this.peerRecvCount = p.recvCount;
      this.peerExpectCount = p.expectCount;
    }
  }

  private sendSys(p: {
    type: number;
    seq: number;
    sendTimeMs: number;
    recvCount: number;
    expectCount: number;
  }): void {
    const sys = this.sysChannel;
    if (!sys || this._state === 'closed' || this._state === 'failed') return;
    const st = this.chanByName.get(CH_SYS);
    if (!st) return;
    const frame = encodeSys(p);
    if (!this.rawSend(sys, frame)) return;
    const wire = frame.length + WIRE_OVERHEAD_BYTES;
    st.bytesOut += wire;
    this._stats.bytesOut += wire;
    this._stats.packetsOut++;
    this.bytesOutWin.add(wire);
    this.packetsOutWin.add(1);
  }

  /* ------------------------------------------------------------------- poll */

  poll(nowMs: number): void {
    this.timeMs = nowMs;

    this.bytesInWin.advance(nowMs);
    this.bytesOutWin.advance(nowMs);
    this.packetsInWin.advance(nowMs);
    this.packetsOutWin.advance(nowMs);

    this.pumpDriver(nowMs);

    if (this._state === 'connected') {
      if (nowMs >= this.nextPingMs) {
        this.nextPingMs = nowMs + this.pingIntervalMs;
        this.pingSeqOut = (this.pingSeqOut + 1) & 0xffff;
        this.sendSys({
          type: SYS_PING,
          seq: this.pingSeqOut,
          sendTimeMs: Math.round(nowMs) >>> 0,
          recvCount: this.recvCount,
          expectCount: this.expectCount,
        });
        this._stats.lossIn = this.lossInEst.update(nowMs, this.recvCount, this.expectCount);
        this._stats.lossOut = this.lossOutEst.update(nowMs, this.peerRecvCount, this.peerExpectCount);
      }
      if (this.timeoutMs > 0 && nowMs - this._stats.lastRecvMs > this.timeoutMs) {
        this.fail(`timeout after ${Math.round(nowMs - this._stats.lastRecvMs)}ms of silence`);
      }
    }

    this._stats.rttMs = this.rtt.srtt;
    this._stats.rttMinMs = this.rtt.min;
    this._stats.jitterMs = this.rtt.rttvar;
    this._stats.bytesInPerSec = this.bytesInWin.perSecond;
    this._stats.bytesOutPerSec = this.bytesOutWin.perSecond;
    this._stats.packetsInPerSec = this.packetsInWin.perSecond;
    this._stats.packetsOutPerSec = this.packetsOutWin.perSecond;
    this._stats.bufferedBytes = this.rawBufferedBytes();

    if (this.inbox.length > 0 && this.msgHandlers.size > 0) {
      const batch = this.inbox.splice(0, this.inbox.length);
      for (let i = 0; i < batch.length; i++) {
        for (const fn of this.msgHandlers) {
          try {
            fn(batch[i]);
          } catch (err) {
            console.error('[Transport] message handler threw', err);
          }
        }
      }
    } else if (this.inbox.length > 4096) {
      // Nobody is listening; do not grow without bound.
      this.inbox.length = 0;
    }
  }

  /* --------------------------------------------------------------- subclass */

  /** Open the underlying link. Must eventually call `setState('connected')` or throw. */
  protected abstract doConnect(): Promise<void>;
  /** Tear down the underlying link. Must be idempotent. */
  protected abstract doClose(reason: string): void;
  /** Push one frame. Return false if the wire refused it. */
  protected abstract rawSend(ch: ResolvedChannel, frame: Uint8Array): boolean;

  /** Optional per-poll work for transports that are driven rather than evented. */
  protected pumpDriver(_nowMs: number): void {}

  /** Bytes queued below the transport. Default 0 for wires that do not expose it. */
  protected rawBufferedBytes(): number {
    return 0;
  }
}

function prefixSeq(bytes: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(bytes.length + 2);
  out[0] = seq & 0xff;
  out[1] = (seq >>> 8) & 0xff;
  out.set(bytes, 2);
  return out;
}
