/**
 * WebRtcTransport — peer-to-peer play with no infrastructure beyond a rendezvous.
 *
 * WebRTC DataChannels are the only way a browser gets unreliable, unordered
 * delivery, and unreliable delivery is the whole reason server-authoritative
 * netcode feels good: a snapshot that arrives late is worse than one that never
 * arrives, because the client has already moved on. TCP-shaped transports cannot
 * express that.
 *
 * Two decisions worth stating:
 *
 * **Negotiated channels with fixed ids.** Both peers create every channel up
 * front with `negotiated: true` and an id taken from `resolveChannels` (assigned
 * by sorted name, so both sides agree without a handshake). This removes the
 * `ondatachannel` race entirely — there is no window where one side has a channel
 * the other does not — and makes "connected" a single, well-defined moment: every
 * channel open.
 *
 * **The signalling socket is not the transport.** `WebRtcTransport` never touches
 * a WebSocket. It is handed a `signal(payload)` callback and a `handleSignal`
 * inbox, so the same class works against the local dev server, a hosted relay, or
 * a copy-paste-the-SDP flow. Once the channels open, signalling is dead weight.
 *
 * A peer host and a dedicated server differ only in which `TransportListener` the
 * match code is constructed with. Nothing above this file changes.
 */

import type {
  ChannelConfig,
  PeerId,
  ResolvedChannel,
  Transport,
  TransportListener,
  TransportOptions,
  Unsubscribe,
} from './Transport';
import { TransportError, isTerminal } from './Transport';
import { BaseTransport } from './BaseTransport';
import type { SignalMessage, SignalPayload, SignalingChannel } from './Signaling';

/**
 * Public STUN only. Enough for most home NATs; symmetric NATs and carrier-grade
 * NAT need a TURN server, which is the point where "no infrastructure" stops
 * being true. Pass `iceServers` to supply one.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export type WebRtcRole = 'offerer' | 'answerer';

export interface WebRtcTransportOptions extends TransportOptions {
  role: WebRtcRole;
  /** Deliver a payload to the remote peer by whatever rendezvous is in use. */
  signal: (payload: SignalPayload) => void;
  iceServers?: RTCIceServer[];
  rtcConfiguration?: RTCConfiguration;
  /**
   * Backlog above which unreliable sends are refused rather than queued.
   * Queueing unreliable data is self-defeating: it arrives stale and it delays
   * the packet behind it. Default 64 KB.
   */
  maxBufferedBytes?: number;
  peerConnectionFactory?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

export class WebRtcTransport extends BaseTransport {
  readonly role: WebRtcRole;

  private readonly signalOut: (payload: SignalPayload) => void;
  private readonly rtcConfig: RTCConfiguration;
  private readonly maxBufferedBytes: number;
  private readonly pcFactory: (cfg: RTCConfiguration) => RTCPeerConnection;

  private pc: RTCPeerConnection | null = null;
  private readonly dcs = new Map<string, RTCDataChannel>();
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private pendingOffer: string | null = null;
  private remoteDescSet = false;
  private iceRestartAttempted = false;
  private openChannels = 0;

  constructor(opts: WebRtcTransportOptions) {
    super('webrtc', opts);
    this.role = opts.role;
    this.signalOut = opts.signal;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 64 * 1024;
    this.rtcConfig = {
      iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS,
      ...(opts.rtcConfiguration ?? {}),
    };
    this.pcFactory =
      opts.peerConnectionFactory ??
      ((cfg: RTCConfiguration) => {
        const Ctor = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection })
          .RTCPeerConnection;
        if (!Ctor) {
          throw new TransportError('unsupported', 'RTCPeerConnection is not available here');
        }
        return new Ctor(cfg);
      });
  }

  /* ---------------------------------------------------------------- connect */

  protected async doConnect(): Promise<void> {
    const pc = this.pcFactory(this.rtcConfig);
    this.pc = pc;

    for (const ch of this.allChannels) {
      const init: RTCDataChannelInit = { negotiated: true, id: ch.id };
      if (ch.reliability === 'reliable-ordered') {
        init.ordered = true;
      } else if (ch.reliability === 'reliable-unordered') {
        init.ordered = false;
      } else {
        init.ordered = false;
        init.maxRetransmits = 0;
      }
      const dc = pc.createDataChannel(ch.name, init);
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => this.onChannelOpen(ch.name);
      dc.onclose = () => this.onChannelClose(ch.name);
      dc.onerror = () => {
        /* channel errors surface through connectionstatechange; do not fail here */
      };
      dc.onmessage = (ev: MessageEvent) => this.onChannelMessage(ch.name, ev);
      this.dcs.set(ch.name, dc);
    }

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (isTerminal(this.state)) return;
      this.signalOut({ kind: 'ice', candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed') this.fail('peer connection failed');
      else if (s === 'closed' && !isTerminal(this.state)) this.fail('peer connection closed');
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState !== 'failed') return;
      if (this.role === 'offerer' && !this.iceRestartAttempted) {
        this.iceRestartAttempted = true;
        void this.makeOffer(true);
        return;
      }
      this.fail('ICE failed');
    };

    pc.onnegotiationneeded = () => {
      if (this.role !== 'offerer') return;
      void this.makeOffer(false);
    };

    if (this.role === 'offerer') {
      await this.makeOffer(false);
    } else if (this.pendingOffer !== null) {
      const sdp = this.pendingOffer;
      this.pendingOffer = null;
      await this.acceptOffer(sdp);
    }
  }

  private async makeOffer(iceRestart: boolean): Promise<void> {
    const pc = this.pc;
    if (!pc || isTerminal(this.state)) return;
    if (pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.signalOut({ kind: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
    } catch (err) {
      this.fail(`offer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async acceptOffer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || isTerminal(this.state)) return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      this.remoteDescSet = true;
      await this.flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signalOut({ kind: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' });
    } catch (err) {
      this.fail(`answer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Feed one payload received from the rendezvous. Safe to call before `connect`. */
  handleSignal(payload: SignalPayload): void {
    if (isTerminal(this.state)) return;
    if (payload.kind === 'offer') {
      if (!this.pc) {
        this.pendingOffer = payload.sdp;
        return;
      }
      void this.acceptOffer(payload.sdp);
      return;
    }
    if (payload.kind === 'answer') {
      const pc = this.pc;
      if (!pc) return;
      void pc
        .setRemoteDescription({ type: 'answer', sdp: payload.sdp })
        .then(() => {
          this.remoteDescSet = true;
          return this.flushIce();
        })
        .catch((err: unknown) => {
          this.fail(`set answer failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }
    // ICE
    if (!payload.candidate) return;
    if (!this.pc || !this.remoteDescSet) {
      this.pendingIce.push(payload.candidate);
      return;
    }
    void this.pc.addIceCandidate(payload.candidate).catch(() => {
      /* a candidate we cannot use is normal during trickle */
    });
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const queued = this.pendingIce.splice(0, this.pendingIce.length);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }

  /* --------------------------------------------------------------- channels */

  private onChannelOpen(name: string): void {
    this.openChannels++;
    if (this.openChannels >= this.dcs.size && this.state !== 'connected') {
      this.setState('connected', 'datachannels open');
    }
  }

  private onChannelClose(name: string): void {
    this.openChannels = Math.max(0, this.openChannels - 1);
    if (!isTerminal(this.state) && this.state !== 'closing') {
      this.fail(`datachannel "${name}" closed`);
    }
  }

  private onChannelMessage(name: string, ev: MessageEvent): void {
    const data = ev.data as ArrayBuffer | string;
    if (typeof data === 'string') {
      this.receiveRaw(name, new TextEncoder().encode(data));
      return;
    }
    this.receiveRaw(name, new Uint8Array(data));
  }

  /* ------------------------------------------------------------------- wire */

  protected rawSend(ch: ResolvedChannel, frame: Uint8Array): boolean {
    const dc = this.dcs.get(ch.name);
    if (!dc || dc.readyState !== 'open') return false;
    if (!ch.reliable && dc.bufferedAmount > this.maxBufferedBytes) return false;
    try {
      // Uint8Array is a valid DataChannel payload; the cast only satisfies the
      // ArrayBufferLike/ArrayBuffer split in the DOM typings.
      dc.send(frame as unknown as ArrayBufferView<ArrayBuffer>);
    } catch {
      return false;
    }
    return true;
  }

  protected override rawBufferedBytes(): number {
    let n = 0;
    for (const dc of this.dcs.values()) n += dc.bufferedAmount;
    return n;
  }

  protected doClose(_reason: string): void {
    for (const dc of this.dcs.values()) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onmessage = null;
      dc.onerror = null;
      try {
        dc.close();
      } catch {
        /* ignore */
      }
    }
    this.dcs.clear();
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onnegotiationneeded = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------- host */

export interface WebRtcHostOptions {
  signaling: SignalingChannel;
  channels?: readonly ChannelConfig[];
  iceServers?: RTCIceServer[];
  rtcConfiguration?: RTCConfiguration;
  pingIntervalMs?: number;
  timeoutMs?: number;
  /** Injectable so the negotiation state machine can be tested headlessly. */
  peerConnectionFactory?: (cfg: RTCConfiguration) => RTCPeerConnection;
  clock?: () => number;
}

/**
 * Accepts guests joining the signalling room and hands the match one
 * `Transport` per player. This is the peer-hosted implementation of
 * `TransportListener`; a dedicated server swaps in a different one.
 */
export class WebRtcHost implements TransportListener {
  readonly kind = 'webrtc' as const;
  localId: PeerId = '';
  room = '';

  private readonly opts: WebRtcHostOptions;
  private readonly byPeer = new Map<PeerId, WebRtcTransport>();
  private readonly live: Transport[] = [];
  private readonly connHandlers = new Set<(t: Transport) => void>();
  private readonly discHandlers = new Set<(t: Transport, reason: string) => void>();
  private started = false;
  private unsubSignal: Unsubscribe | null = null;

  constructor(opts: WebRtcHostOptions) {
    this.opts = opts;
  }

  get connections(): readonly Transport[] {
    return this.live;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const hello = await this.opts.signaling.connect();
    this.localId = hello.peerId;
    this.room = hello.room;
    this.unsubSignal = this.opts.signaling.onMessage((msg) => this.onSignal(msg));
    for (const p of hello.peers) {
      if (p.role === 'guest') this.accept(p.peerId);
    }
  }

  private onSignal(msg: SignalMessage): void {
    if (msg.t === 'peer-join') {
      if (msg.peer.role === 'guest') this.accept(msg.peer.peerId);
      return;
    }
    if (msg.t === 'peer-leave') {
      this.byPeer.get(msg.peerId)?.close(msg.reason ?? 'peer left');
      return;
    }
    if (msg.t === 'signal' && msg.from) {
      this.byPeer.get(msg.from)?.handleSignal(msg.data);
    }
  }

  private accept(peerId: PeerId): void {
    if (this.byPeer.has(peerId)) return;
    const t = new WebRtcTransport({
      role: 'offerer',
      localId: this.localId,
      remoteId: peerId,
      channels: this.opts.channels,
      iceServers: this.opts.iceServers,
      rtcConfiguration: this.opts.rtcConfiguration,
      pingIntervalMs: this.opts.pingIntervalMs,
      timeoutMs: this.opts.timeoutMs,
      signal: (data) => this.opts.signaling.send({ t: 'signal', to: peerId, data }),
    });
    this.byPeer.set(peerId, t);
    t.onStateChange((state, reason) => {
      if (state === 'connected') {
        if (!this.live.includes(t)) this.live.push(t);
        for (const fn of this.connHandlers) fn(t);
      } else if (isTerminal(state)) {
        this.byPeer.delete(peerId);
        const i = this.live.indexOf(t);
        if (i >= 0) this.live.splice(i, 1);
        for (const fn of this.discHandlers) fn(t, reason);
      }
    });
    void t.connect().catch(() => {
      /* reported through onStateChange */
    });
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

  poll(nowMs: number): void {
    for (const t of this.byPeer.values()) t.poll(nowMs);
  }

  stop(reason = 'host stopped'): void {
    this.unsubSignal?.();
    this.unsubSignal = null;
    for (const t of Array.from(this.byPeer.values())) t.close(reason);
    this.byPeer.clear();
    this.live.length = 0;
    this.opts.signaling.close(reason);
  }
}

/* ------------------------------------------------------------------ guest */

export interface WebRtcGuestOptions {
  signaling: SignalingChannel;
  channels?: readonly ChannelConfig[];
  iceServers?: RTCIceServer[];
  rtcConfiguration?: RTCConfiguration;
  pingIntervalMs?: number;
  timeoutMs?: number;
  /** ms to wait for the host's offer and the channels to open. Default 20000. */
  joinTimeoutMs?: number;
}

/**
 * Joins a peer-hosted match. Resolves once every DataChannel is open, so the
 * caller can start sending immediately.
 */
export async function joinAsGuest(opts: WebRtcGuestOptions): Promise<WebRtcTransport> {
  const hello = await opts.signaling.connect();
  const host = hello.peers.find((p) => p.role === 'host');

  const t = new WebRtcTransport({
    role: 'answerer',
    localId: hello.peerId,
    remoteId: host?.peerId ?? 'host',
    channels: opts.channels,
    iceServers: opts.iceServers,
    rtcConfiguration: opts.rtcConfiguration,
    pingIntervalMs: opts.pingIntervalMs,
    timeoutMs: opts.timeoutMs,
    signal: (data) => opts.signaling.send({ t: 'signal', to: host?.peerId, data }),
  });

  opts.signaling.onMessage((msg) => {
    if (msg.t === 'signal') t.handleSignal(msg.data);
    else if (msg.t === 'peer-leave' && msg.peerId === t.remoteId) t.close('host left');
  });

  const timeoutMs = opts.joinTimeoutMs ?? 20000;
  const connected = t.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      t.close('join timeout');
      reject(new TransportError('timeout', `join timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([connected, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return t;
}
