/**
 * WebSocketTransport — the same `Transport`, over a socket to a real server.
 *
 * This exists to prove the interface is honest. If moving the host off a peer
 * required touching gameplay code, the abstraction would be decorative. Here the
 * entire difference between "friend is hosting over WebRTC" and "we connected to
 * a dedicated server" is which constructor the client calls.
 *
 * One socket carries every channel, multiplexed behind a single leading byte
 * holding the channel id from `resolveChannels`. Because ids come from sorted
 * channel names, both ends agree with no handshake.
 *
 * Honest limitation, stated rather than hidden: TCP gives one reliable ordered
 * stream, so `unreliable-sequenced` degrades to reliable-and-in-order here. The
 * sequence filter still runs (it just never has anything to discard) and `lossIn`
 * reads zero. Under packet loss a WebSocket link therefore shows latency spikes
 * where a WebRTC link would show drops — which is exactly TCP's behaviour, not a
 * flaw in the emulation. A production dedicated server should speak WebTransport
 * or plain WebRTC to get unreliable datagrams back; this class is the LAN and
 * fallback path, and the seam that keeps that swap cheap.
 */

import type { ResolvedChannel, TransportOptions } from './Transport';
import { TransportError } from './Transport';
import { BaseTransport } from './BaseTransport';

/**
 * Structural subset of WebSocket satisfied by the browser global, Node's built-in
 * `WebSocket`, and the `ws` package. Event registration goes through
 * `addEventListener` so all three are assignable without casts.
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
  removeEventListener(type: string, listener: (ev: any) => void): void;
}

export interface WebSocketTransportOptions extends TransportOptions {
  /** Server URL. Ignored when `socket` is supplied. */
  url?: string;
  /**
   * An already-created socket. This is how a headless server wraps a connection
   * it just accepted: same class, same channels, opposite end of the wire.
   */
  socket?: WebSocketLike;
  webSocketFactory?: (url: string) => WebSocketLike;
  /** ms to wait for the socket to open. Default 10000. */
  connectTimeoutMs?: number;
  /** Backlog above which unreliable sends are refused. Default 256 KB. */
  maxBufferedBytes?: number;
}

const WS_OPEN = 1;

export class WebSocketTransport extends BaseTransport {
  private readonly url: string;
  private readonly maxBufferedBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly factory: ((url: string) => WebSocketLike) | undefined;
  private ws: WebSocketLike | null;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onOpenEv = () => this.handleOpen();
  private readonly onCloseEv = (ev: any) => this.handleClose(ev);
  private readonly onErrorEv = () => this.handleError();
  private readonly onMessageEv = (ev: any) => this.handleMessage(ev);

  constructor(opts: WebSocketTransportOptions) {
    super('websocket', opts);
    this.url = opts.url ?? '';
    this.ws = opts.socket ?? null;
    this.factory = opts.webSocketFactory;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 256 * 1024;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    if (!this.ws && !this.url) {
      throw new TransportError('config', 'WebSocketTransport needs a url or a socket');
    }
  }

  protected doConnect(): Promise<void> {
    let ws = this.ws;
    if (!ws) {
      const make =
        this.factory ??
        ((url: string): WebSocketLike => {
          const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
          if (!Ctor) throw new TransportError('unsupported', 'no WebSocket implementation here');
          return new Ctor(url);
        });
      ws = make(this.url);
      this.ws = ws;
    }
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', this.onOpenEv);
    ws.addEventListener('close', this.onCloseEv);
    ws.addEventListener('error', this.onErrorEv);
    ws.addEventListener('message', this.onMessageEv);

    if (ws.readyState === WS_OPEN) {
      this.handleOpen();
    } else if (this.connectTimeoutMs > 0) {
      this.openTimer = setTimeout(() => {
        if (this.state !== 'connected') this.fail(`socket open timed out (${this.connectTimeoutMs}ms)`);
      }, this.connectTimeoutMs);
    }
    return Promise.resolve();
  }

  private handleOpen(): void {
    if (this.openTimer !== undefined) {
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
    }
    this.setState('connected', 'socket open');
  }

  private handleClose(ev: any): void {
    const reason =
      typeof ev?.reason === 'string' && ev.reason.length > 0 ? ev.reason : 'socket closed';
    if (this.state === 'closing' || this.state === 'closed') return;
    this.fail(reason);
  }

  private handleError(): void {
    if (this.state !== 'connected') this.fail('socket error');
  }

  private handleMessage(ev: any): void {
    const data = ev?.data;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    } else if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else {
      return;
    }
    if (bytes.length < 1) return;
    const name = this.channelNameById(bytes[0]);
    if (name === undefined) return;
    this.receiveRaw(name, bytes.subarray(1));
  }

  protected rawSend(ch: ResolvedChannel, frame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    if (!ch.reliable && ws.bufferedAmount > this.maxBufferedBytes) return false;
    const out = new Uint8Array(frame.length + 1);
    out[0] = ch.id & 0xff;
    out.set(frame, 1);
    try {
      ws.send(out);
    } catch {
      return false;
    }
    return true;
  }

  protected override rawBufferedBytes(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  protected doClose(reason: string): void {
    if (this.openTimer !== undefined) {
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
    }
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeEventListener('open', this.onOpenEv);
    ws.removeEventListener('close', this.onCloseEv);
    ws.removeEventListener('error', this.onErrorEv);
    ws.removeEventListener('message', this.onMessageEv);
    try {
      ws.close(1000, reason.slice(0, 100));
    } catch {
      /* ignore */
    }
  }
}
