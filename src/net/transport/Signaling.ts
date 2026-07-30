/**
 * Signalling — how two peers find each other before WebRTC can talk.
 *
 * Kept deliberately small and deliberately separate from `WebRtcTransport`. A
 * peer-hosted match needs a rendezvous point, but the rendezvous is not part of
 * the authority boundary: once the DataChannels are up the signalling socket does
 * nothing, and a dedicated-server deployment skips it entirely. Modelling it as a
 * swappable `SignalingChannel` means the same WebRTC code works against the local
 * `tools/signal.mjs`, against a hosted relay later, or against a stub in a test.
 *
 * Wire format is JSON over WebSocket, because signalling messages are a handful
 * of kilobytes exchanged once per join. Nothing here is on the hot path.
 */

import type { Unsubscribe } from './Transport';

export type SignalRole = 'host' | 'guest';

export interface SignalPeer {
  peerId: string;
  role: SignalRole;
  name?: string;
}

export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

export type SignalMessage =
  | { t: 'hello'; room: string; role: SignalRole; name?: string }
  | { t: 'joined'; room: string; peerId: string; role: SignalRole; peers: SignalPeer[] }
  | { t: 'peer-join'; peer: SignalPeer }
  | { t: 'peer-leave'; peerId: string; reason?: string }
  | { t: 'signal'; from?: string; to?: string; data: SignalPayload }
  | { t: 'error'; message: string }
  | { t: 'bye'; reason?: string };

export interface SignalHello {
  room: string;
  peerId: string;
  role: SignalRole;
  peers: SignalPeer[];
}

export interface SignalingChannel {
  readonly localPeerId: string;
  readonly room: string;
  /** Opens the rendezvous and resolves with the room roster. */
  connect(): Promise<SignalHello>;
  send(msg: SignalMessage): void;
  onMessage(fn: (msg: SignalMessage) => void): Unsubscribe;
  onClose(fn: (reason: string) => void): Unsubscribe;
  close(reason?: string): void;
}

export interface WebSocketSignalingOptions {
  url: string;
  /**
   * Room code. Empty string asks the server to mint one — read it back from the
   * resolved `SignalHello.room` and show it to the player.
   */
  room?: string;
  role: SignalRole;
  name?: string;
  /** Injectable for tests / Node. Defaults to globalThis.WebSocket. */
  webSocketFactory?: (url: string) => WebSocket;
  /** ms before `connect()` gives up. Default 10000. */
  connectTimeoutMs?: number;
}

/** Signalling client for `tools/signal.mjs`. */
export class WebSocketSignaling implements SignalingChannel {
  localPeerId = '';
  room: string;

  private readonly opts: WebSocketSignalingOptions;
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<(msg: SignalMessage) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private pending: Promise<SignalHello> | null = null;
  private outbox: string[] = [];
  private closedReason = '';

  constructor(opts: WebSocketSignalingOptions) {
    this.opts = opts;
    this.room = opts.room ?? '';
  }

  connect(): Promise<SignalHello> {
    if (this.pending) return this.pending;
    this.pending = new Promise<SignalHello>((resolve, reject) => {
      const factory =
        this.opts.webSocketFactory ??
        ((url: string) => {
          const Ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (!Ctor) throw new Error('[Signaling] no WebSocket implementation available');
          return new Ctor(url);
        });

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`[Signaling] timed out connecting to ${this.opts.url}`));
        this.close('timeout');
      }, this.opts.connectTimeoutMs ?? 10000);

      let ws: WebSocket;
      try {
        ws = factory(this.opts.url);
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.rawSend({ t: 'hello', room: this.room, role: this.opts.role, name: this.opts.name });
        for (const q of this.outbox) ws.send(q);
        this.outbox.length = 0;
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: SignalMessage;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as SignalMessage;
        } catch {
          return;
        }
        if (msg.t === 'joined' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.localPeerId = msg.peerId;
          this.room = msg.room;
          resolve({ room: msg.room, peerId: msg.peerId, role: msg.role, peers: msg.peers });
        }
        if (msg.t === 'error' && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`[Signaling] ${msg.message}`));
        }
        for (const fn of this.handlers) {
          try {
            fn(msg);
          } catch (err) {
            console.error('[Signaling] handler threw', err);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('[Signaling] socket error'));
        }
      };

      ws.onclose = () => {
        clearTimeout(timer);
        const reason = this.closedReason || 'signalling socket closed';
        for (const fn of this.closeHandlers) fn(reason);
        if (!settled) {
          settled = true;
          reject(new Error(`[Signaling] ${reason}`));
        }
      };
    });
    return this.pending;
  }

  send(msg: SignalMessage): void {
    this.rawSend(msg);
  }

  private rawSend(msg: SignalMessage): void {
    const text = JSON.stringify(msg);
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      this.outbox.push(text);
      return;
    }
    ws.send(text);
  }

  onMessage(fn: (msg: SignalMessage) => void): Unsubscribe {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  onClose(fn: (reason: string) => void): Unsubscribe {
    this.closeHandlers.add(fn);
    return () => {
      this.closeHandlers.delete(fn);
    };
  }

  close(reason = 'client closed'): void {
    this.closedReason = reason;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      try {
        ws.close(1000, reason.slice(0, 100));
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * In-memory signalling for tests and for two simulations in one tab. Implements
 * the same contract as the WebSocket client with no server involved.
 */
export class MemorySignalingHub {
  private readonly peers = new Map<string, MemorySignaling>();
  private counter = 0;

  create(role: SignalRole, room = 'memory', name?: string): MemorySignaling {
    const id = `${role}-${++this.counter}`;
    const ch = new MemorySignaling(this, id, room, role, name);
    return ch;
  }

  register(ch: MemorySignaling): SignalPeer[] {
    const roster: SignalPeer[] = [];
    for (const other of this.peers.values()) {
      if (other.room !== ch.room) continue;
      roster.push({ peerId: other.localPeerId, role: other.role, name: other.name });
      other.receive({ t: 'peer-join', peer: { peerId: ch.localPeerId, role: ch.role, name: ch.name } });
    }
    this.peers.set(ch.localPeerId, ch);
    return roster;
  }

  route(from: MemorySignaling, msg: SignalMessage): void {
    if (msg.t !== 'signal') return;
    const target = msg.to ? this.peers.get(msg.to) : undefined;
    const deliver = { ...msg, from: from.localPeerId };
    if (target) {
      target.receive(deliver);
      return;
    }
    for (const p of this.peers.values()) {
      if (p === from || p.room !== from.room) continue;
      p.receive(deliver);
    }
  }

  unregister(ch: MemorySignaling, reason: string): void {
    if (!this.peers.delete(ch.localPeerId)) return;
    for (const other of this.peers.values()) {
      if (other.room !== ch.room) continue;
      other.receive({ t: 'peer-leave', peerId: ch.localPeerId, reason });
    }
  }
}

export class MemorySignaling implements SignalingChannel {
  readonly localPeerId: string;
  readonly room: string;
  readonly role: SignalRole;
  readonly name: string | undefined;

  private readonly hub: MemorySignalingHub;
  private readonly handlers = new Set<(msg: SignalMessage) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private open = false;

  constructor(
    hub: MemorySignalingHub,
    peerId: string,
    room: string,
    role: SignalRole,
    name?: string,
  ) {
    this.hub = hub;
    this.localPeerId = peerId;
    this.room = room;
    this.role = role;
    this.name = name;
  }

  connect(): Promise<SignalHello> {
    if (this.open) {
      return Promise.resolve({ room: this.room, peerId: this.localPeerId, role: this.role, peers: [] });
    }
    this.open = true;
    const peers = this.hub.register(this);
    return Promise.resolve({ room: this.room, peerId: this.localPeerId, role: this.role, peers });
  }

  send(msg: SignalMessage): void {
    if (!this.open) return;
    this.hub.route(this, msg);
  }

  receive(msg: SignalMessage): void {
    for (const fn of this.handlers) {
      try {
        fn(msg);
      } catch (err) {
        console.error('[Signaling] handler threw', err);
      }
    }
  }

  onMessage(fn: (msg: SignalMessage) => void): Unsubscribe {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  onClose(fn: (reason: string) => void): Unsubscribe {
    this.closeHandlers.add(fn);
    return () => {
      this.closeHandlers.delete(fn);
    };
  }

  close(reason = 'closed'): void {
    if (!this.open) return;
    this.open = false;
    this.hub.unregister(this, reason);
    for (const fn of this.closeHandlers) fn(reason);
  }
}

/** Room codes readable over voice chat: no vowels, no 0/1/I/O. */
export const ROOM_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';

export function isValidRoomCode(code: string): boolean {
  if (code.length < 4 || code.length > 12) return false;
  for (const c of code.toUpperCase()) {
    if (!ROOM_ALPHABET.includes(c)) return false;
  }
  return true;
}
