/**
 * The transport layer's public surface.
 *
 * Code above this layer should import from here and from nowhere deeper, and
 * should hold a `Transport` / `TransportListener`, never a concrete class. That
 * is the rule that keeps the host movable: peer over WebRTC today, headless Node
 * process tomorrow, dedicated server after that, with no gameplay rewrite.
 *
 * Quick starts:
 *
 *   // Two simulations in one process, 80 ms RTT, 2% loss, reproducible.
 *   const link = createLoopbackPair({ seed: 'match-1', conditions: { latencyMs: 40, loss: 0.02 } });
 *   await link.connect();
 *   link.a.onMessage(m => host.receive(m));
 *   link.run(10_000, 1000 / 60);           // ten simulated seconds
 *
 *   // One host, many simulated clients on different connections.
 *   const hub = new LoopbackHub({ seed: 'match-1' });
 *   hub.onConnection(t => match.addPlayer(t));
 *   const { client } = hub.addClient('alice', { latencyMs: 120, loss: 0.05 });
 *
 *   // Peer-hosted over WebRTC (needs tools/signal.mjs running).
 *   const host = new WebRtcHost({ signaling: new WebSocketSignaling({ url, role: 'host' }) });
 *   await host.start();                     // host.room is the code to share
 *
 *   const t = await joinAsGuest({ signaling: new WebSocketSignaling({ url, room, role: 'guest' }) });
 */

export type {
  ChannelConfig,
  ConnectionState,
  MessageHandler,
  PeerId,
  Reliability,
  ResolvedChannel,
  StateHandler,
  Transport,
  TransportKind,
  TransportListener,
  TransportMessage,
  TransportOptions,
  TransportStats,
  Unsubscribe,
} from './Transport';
export {
  CH_CONTROL,
  CH_STATE,
  CH_SYS,
  DEFAULT_CHANNELS,
  TransportError,
  WIRE_OVERHEAD_BYTES,
  emptyStats,
  isTerminal,
  resolveChannels,
  seqDiff,
} from './Transport';

export { BaseTransport } from './BaseTransport';

export { LossEstimator, RateWindow, RttEstimator } from './Stats';

export type {
  LinkConditions,
  LinkCounters,
  LinkDirection,
  LoopbackLinkOptions,
} from './LoopbackTransport';
export {
  DEFAULT_CONDITIONS,
  LoopbackHub,
  LoopbackLink,
  LoopbackTransport,
  createLoopbackPair,
} from './LoopbackTransport';

export type {
  SignalHello,
  SignalMessage,
  SignalPayload,
  SignalPeer,
  SignalRole,
  SignalingChannel,
  WebSocketSignalingOptions,
} from './Signaling';
export {
  MemorySignaling,
  MemorySignalingHub,
  ROOM_ALPHABET,
  WebSocketSignaling,
  isValidRoomCode,
} from './Signaling';

export type {
  WebRtcGuestOptions,
  WebRtcHostOptions,
  WebRtcRole,
  WebRtcTransportOptions,
} from './WebRtcTransport';
export {
  DEFAULT_ICE_SERVERS,
  WebRtcHost,
  WebRtcTransport,
  joinAsGuest,
} from './WebRtcTransport';

export type { WebSocketLike, WebSocketTransportOptions } from './WebSocketTransport';
export { WebSocketTransport } from './WebSocketTransport';

/**
 * Preset link conditions for tests, named after what they feel like in-game.
 * Latency values are one-way, so RTT is roughly double.
 */
export const NET_PRESETS = {
  /** Same-city fibre. */
  lan: { latencyMs: 5, jitterMs: 1, loss: 0, duplicate: 0 },
  /** Healthy broadband, the common case. */
  good: { latencyMs: 25, jitterMs: 5, loss: 0.005, duplicate: 0 },
  /** Cross-country, the number most netcode should be tuned against. */
  typical: { latencyMs: 40, jitterMs: 10, loss: 0.02, duplicate: 0 },
  /** Transatlantic on hotel wifi. Prediction errors become visible here. */
  poor: { latencyMs: 90, jitterMs: 30, loss: 0.05, duplicate: 0.01 },
  /** Mobile tethering. If it holds up here it holds up anywhere. */
  awful: { latencyMs: 150, jitterMs: 60, loss: 0.12, duplicate: 0.02 },
} as const;
