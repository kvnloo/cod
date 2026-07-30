/**
 * Transport — the authority-boundary cable.
 *
 * Everything above this file (replication, prediction, lag compensation) talks to
 * a `Transport`. Nothing above this file may know whether the thing on the other
 * end is a browser peer over WebRTC, a dedicated server over WebSocket, or a
 * second simulation running in the same process. That is the whole point: the
 * host can move off a peer and onto a headless Node process without a single
 * line of gameplay code changing.
 *
 * Shape of the contract:
 *
 *   - A transport is a **point-to-point link to exactly one remote peer**. A host
 *     that serves N clients owns N transports, handed to it by a
 *     `TransportListener`. There is no broadcast primitive here on purpose —
 *     interest management decides per-client what goes out, so a broadcast
 *     primitive would only ever be the wrong tool.
 *
 *   - Traffic is split across named **channels** with independent reliability.
 *     Two are always present: `control` (reliable-ordered — joins, spawns, chat,
 *     match state) and `state` (unreliable-sequenced — snapshots and inputs, where
 *     a late packet is worthless and retransmitting it actively hurts). A third
 *     reserved channel, `sys`, carries transport keepalive and is invisible to
 *     callers.
 *
 *   - **Inbound messages are delivered from `poll(nowMs)`, never spontaneously.**
 *     A fixed-tick simulation must not have packets landing in the middle of a
 *     step. Every transport queues arrivals and dispatches them synchronously
 *     inside `poll`, so message ordering relative to the tick loop is identical
 *     for loopback, WebRTC and WebSocket. This is what makes headless replay of a
 *     recorded session meaningful.
 *
 *   - `send` returns `false` rather than throwing or silently dropping when the
 *     message is too large for the channel or over its bandwidth budget. Callers
 *     are expected to check it and coalesce.
 */

/** Stable identifier for a peer. Assigned by signalling, or by config for tests. */
export type PeerId = string;

export type Unsubscribe = () => void;

export type TransportKind = 'loopback' | 'webrtc' | 'websocket';

/**
 * Per-channel delivery guarantee.
 *
 *  - `reliable-ordered`     retransmitted and delivered in order. Head-of-line
 *                           blocking applies: one lost packet stalls the channel.
 *                           Use for anything a client cannot reconstruct.
 *  - `reliable-unordered`   retransmitted, delivered as it arrives.
 *  - `unreliable-sequenced` never retransmitted; the transport stamps a 16-bit
 *                           sequence and silently discards anything older than the
 *                           newest already delivered. This is the correct mode for
 *                           snapshots and input frames.
 *  - `unreliable`           never retransmitted, no sequencing, no filtering.
 */
export type Reliability =
  | 'reliable-ordered'
  | 'reliable-unordered'
  | 'unreliable-sequenced'
  | 'unreliable';

export type ConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'closed'
  | 'failed';

export interface ChannelConfig {
  readonly name: string;
  readonly reliability: Reliability;
  /**
   * Hard cap on a single message. Defaults to 1180 bytes for unreliable channels
   * (one Ethernet MTU minus DTLS/SCTP headers) and 65535 for reliable ones.
   *
   * The unreliable default is deliberately small and deliberately enforced. An
   * unreliable SCTP message larger than the path MTU is fragmented, and losing
   * any one fragment loses the whole message — so a 4 KB "unreliable" snapshot on
   * a 2% loss link effectively sees ~8% loss. Snapshot code must fragment at the
   * application layer, where it can make each fragment independently useful.
   */
  readonly maxMessageBytes?: number;
  /** Outbound token-bucket budget in bytes/sec, wire cost included. Omit for uncapped. */
  readonly budgetBytesPerSec?: number;
  /** Burst allowance in seconds of budget. Default 0.5. */
  readonly burstSeconds?: number;
}

/** A `ChannelConfig` with defaults resolved and a wire id assigned. */
export interface ResolvedChannel {
  readonly id: number;
  readonly name: string;
  readonly reliability: Reliability;
  readonly maxMessageBytes: number;
  readonly budgetBytesPerSec: number;
  readonly burstSeconds: number;
  readonly sequenced: boolean;
  readonly reliable: boolean;
  readonly ordered: boolean;
}

export const CH_CONTROL = 'control';
export const CH_STATE = 'state';
/** Reserved. Transport keepalive/stat exchange; callers must not send on it. */
export const CH_SYS = 'sys';

/** Bytes of DTLS + SCTP + UDP + IP framing charged to every packet for accounting. */
export const WIRE_OVERHEAD_BYTES = 48;

export const DEFAULT_CHANNELS: readonly ChannelConfig[] = [
  { name: CH_CONTROL, reliability: 'reliable-ordered', maxMessageBytes: 65535 },
  { name: CH_STATE, reliability: 'unreliable-sequenced', maxMessageBytes: 1180 },
  { name: CH_SYS, reliability: 'unreliable', maxMessageBytes: 64 },
];

export interface TransportStats {
  /** Smoothed round-trip time in ms (RFC 6298 style, alpha 1/8). */
  rttMs: number;
  /** Lowest RTT ever observed — the floor of the path. */
  rttMinMs: number;
  /** Mean RTT deviation in ms (RFC 6298 rttvar). */
  jitterMs: number;
  /** Fraction 0..1 of packets the peer sent us that never arrived. */
  lossIn: number;
  /** Fraction 0..1 of packets we sent that never reached the peer, as reported by it. */
  lossOut: number;

  bytesInPerSec: number;
  bytesOutPerSec: number;
  packetsInPerSec: number;
  packetsOutPerSec: number;

  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;

  /** Bytes sitting in the transport's own send queue. Non-zero means congestion. */
  bufferedBytes: number;

  /** Sends refused because the message exceeded the channel's `maxMessageBytes`. */
  dropsOversize: number;
  /** Sends refused because the channel's bandwidth budget was exhausted. */
  dropsBudget: number;
  /** Sends refused because the link was not connected. */
  dropsClosed: number;
  /** Inbound packets discarded by the unreliable-sequenced filter as stale. */
  dropsStale: number;

  /** Transport clock (ms) at which the last inbound packet arrived. */
  lastRecvMs: number;
  /** Transport clock (ms) at which the link reached `connected`. */
  connectedAtMs: number;
}

export interface TransportMessage {
  readonly channel: string;
  readonly bytes: Uint8Array;
  /** Transport clock (ms) when the packet arrived, before queueing. */
  readonly recvMs: number;
}

export type MessageHandler = (msg: TransportMessage) => void;
export type StateHandler = (state: ConnectionState, reason: string) => void;

export interface TransportOptions {
  localId?: PeerId;
  remoteId?: PeerId;
  channels?: readonly ChannelConfig[];
  /** ms between transport keepalive pings. Default 250. */
  pingIntervalMs?: number;
  /** ms of silence before the link is declared failed. Default 8000. 0 disables. */
  timeoutMs?: number;
  /** Clock source in ms. Defaults to performance.now(). Loopback injects virtual time. */
  clock?: () => number;
}

/**
 * A live point-to-point link to one remote peer.
 *
 * Lifecycle: `new` → `connecting` → `connected` → (`closing`) → `closed` | `failed`.
 * Once terminal it never reopens; build a fresh transport to reconnect.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly localId: PeerId;
  readonly remoteId: PeerId;
  readonly state: ConnectionState;
  /** Channels excluding the reserved `sys` channel. */
  readonly channels: readonly ResolvedChannel[];
  readonly stats: Readonly<TransportStats>;

  /** Resolves when `connected`, rejects if the link fails first. Idempotent. */
  connect(): Promise<void>;

  /**
   * Queue one message. Returns false if it was refused — not connected, unknown
   * channel is a throw, too large, or over budget. Never partially sends.
   */
  send(channel: string, bytes: Uint8Array): boolean;

  /** Largest single message accepted on a channel. */
  maxMessageBytes(channel: string): number;

  /** Register an inbound handler. Handlers fire synchronously inside `poll`. */
  onMessage(fn: MessageHandler): Unsubscribe;
  onStateChange(fn: StateHandler): Unsubscribe;

  /**
   * Pump. Dispatches queued inbound messages, runs keepalive, rolls stat windows.
   * Call once per frame (client) or once per tick (host) with a monotonic clock.
   */
  poll(nowMs: number): void;

  close(reason?: string): void;
}

/**
 * Host-side accept loop. `WebRtcHost` (peer host), `LoopbackHub` (tests) and a
 * future `WebSocketListener` (dedicated server) all implement this, which is the
 * seam that lets the host move off a peer without gameplay changes.
 */
export interface TransportListener {
  readonly kind: TransportKind;
  readonly localId: PeerId;
  readonly connections: readonly Transport[];
  start(): Promise<void>;
  onConnection(fn: (t: Transport) => void): Unsubscribe;
  onDisconnection(fn: (t: Transport, reason: string) => void): Unsubscribe;
  /** Pumps every accepted transport. */
  poll(nowMs: number): void;
  stop(reason?: string): void;
}

export class TransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export function isTerminal(state: ConnectionState): boolean {
  return state === 'closed' || state === 'failed';
}

/**
 * Resolve channel configs to runtime channels. Ids are assigned by sorted name so
 * two independently-configured peers agree on the wire numbering with no
 * handshake — which is what lets `WebSocketTransport` multiplex channels over one
 * socket using a single leading byte.
 */
export function resolveChannels(configs: readonly ChannelConfig[]): ResolvedChannel[] {
  const seen = new Set<string>();
  for (const c of configs) {
    if (seen.has(c.name)) throw new TransportError('channel', `duplicate channel "${c.name}"`);
    seen.add(c.name);
  }
  const sorted = configs.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((c, i) => {
    const reliable = c.reliability === 'reliable-ordered' || c.reliability === 'reliable-unordered';
    return {
      id: i,
      name: c.name,
      reliability: c.reliability,
      maxMessageBytes: c.maxMessageBytes ?? (reliable ? 65535 : 1180),
      budgetBytesPerSec: c.budgetBytesPerSec ?? Number.POSITIVE_INFINITY,
      burstSeconds: c.burstSeconds ?? 0.5,
      sequenced: c.reliability === 'unreliable-sequenced',
      reliable,
      ordered: c.reliability === 'reliable-ordered',
    };
  });
}

/** Signed distance between two 16-bit sequence numbers, wrap-safe. */
export function seqDiff(a: number, b: number): number {
  return ((((a - b) & 0xffff) ^ 0x8000) >>> 0) - 0x8000;
}

export function emptyStats(): TransportStats {
  return {
    rttMs: 0,
    rttMinMs: Number.POSITIVE_INFINITY,
    jitterMs: 0,
    lossIn: 0,
    lossOut: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    packetsInPerSec: 0,
    packetsOutPerSec: 0,
    bytesIn: 0,
    bytesOut: 0,
    packetsIn: 0,
    packetsOut: 0,
    bufferedBytes: 0,
    dropsOversize: 0,
    dropsBudget: 0,
    dropsClosed: 0,
    dropsStale: 0,
    lastRecvMs: 0,
    connectedAtMs: 0,
  };
}
