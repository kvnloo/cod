/**
 * Wire protocol: message kinds, framing, versioning and the small pile of pure
 * helpers everyone needs (sequence arithmetic, ack windows, quantization,
 * clock estimation, input sanitation).
 *
 * Like `types.ts` this file imports nothing but `./types`, so it runs unchanged
 * in a browser peer-host, in a headless Node authority, and in `tools/*.mjs`
 * test harnesses.
 *
 * VERSIONING POLICY
 *  - `PROTOCOL_VERSION` is bumped whenever an existing field changes meaning,
 *    changes type, or is removed. Adding a new optional field or a new message
 *    kind does NOT require a bump; old receivers ignore what they do not know.
 *  - Every datagram carries [MAGIC, VERSION]. A mismatch is rejected at decode
 *    with `error: 'version'` — a mismatched build disconnects in one packet
 *    instead of desyncing mysteriously twenty seconds later.
 *  - `contentHash` in the handshake covers simulation-affecting constants. Two
 *    builds with the same protocol but different tick rates or weapon tables
 *    would silently diverge, so that is a hard reject too.
 */

import {
  ALL_CHANNELS,
  ANGLE_Q,
  BUTTON,
  CHANNELS,
  DEFAULT_NET_CONFIG,
  HOST_CLIENT_ID,
  NET_TICK_MS,
  PITCH_LIMIT,
  POS_MAX_Q,
  POS_SCALE,
  SNAP_FIELD,
  VEL_LIMIT,
  VEL_SCALE,
  WORLD_HALF_EXTENT,
  type AckState,
  type ClientId,
  type ConnectionStats,
  type DisconnectReason,
  type EntityId,
  type InputCommand,
  type JoinInfo,
  type Millis,
  type MigrationPlan,
  type NetChannel,
  type NetConfig,
  type NetEvent,
  type NetTick,
  type PeerInfo,
  type RpcRequest,
  type RpcResponse,
  type Sequence,
  type WorldSnapshot,
} from './types';

/* ------------------------------------------------------------------------- *
 * Version and framing constants
 * ------------------------------------------------------------------------- */

/** Bumped on any breaking change to an existing field. */
export const PROTOCOL_VERSION = 1;
/** First byte of every datagram. Rejects traffic from anything but this game. */
export const PROTOCOL_MAGIC = 0xb1;
/** Framing overhead of the reference codec: magic + version. */
export const HEADER_BYTES = 2;
/** Decoder refuses anything larger; guards against a hostile peer OOMing us. */
export const MAX_PACKET_BYTES = 8192;
/** A single datagram may coalesce at most this many messages. */
export const MAX_MESSAGES_PER_PACKET = 64;
/** Sequence numbers are 16-bit and wrap. */
export const SEQ_BITS = 16;
export const SEQ_MOD = 1 << SEQ_BITS;
/** Ack bitfield covers `latest` plus the 32 sequences before it. */
export const ACK_WINDOW = 32;

/* ------------------------------------------------------------------------- *
 * Message kinds
 * ------------------------------------------------------------------------- */

export const MSG = {
  /* handshake — reliable control channel */
  HELLO: 1,             // client -> host : versions, identity nonce
  WELCOME: 2,           // host -> client : versions, provisional id, clock
  JOIN_REQUEST: 3,      // client -> host : name/team/loadout
  JOIN_ACCEPT: 4,       // host -> client : id, entity, seed, peers, config
  JOIN_REJECT: 5,       // host -> client : reason
  /* per-tick traffic */
  INPUT: 6,             // client -> host : redundant window of commands
  SNAPSHOT: 7,          // host -> client : delta or keyframe world state
  ACK: 8,               // either way   : standalone ack when nothing else flows
  EVENT: 9,             // host -> client : reliable gameplay facts
  EVENT_ACK: 10,        // client -> host : highest contiguous event id applied
  /* request/response */
  RPC: 11,
  RPC_RESULT: 12,
  /* liveness + clock */
  PING: 13,
  PONG: 14,
  /* topology */
  HOST_MIGRATE: 15,
  HOST_MIGRATE_ACK: 16,
  PEER_LIST: 17,
  DISCONNECT: 18,
} as const;

export type MsgKind = (typeof MSG)[keyof typeof MSG];

export const MSG_NAME: Readonly<Record<number, string>> = {
  [MSG.HELLO]: 'hello',
  [MSG.WELCOME]: 'welcome',
  [MSG.JOIN_REQUEST]: 'joinRequest',
  [MSG.JOIN_ACCEPT]: 'joinAccept',
  [MSG.JOIN_REJECT]: 'joinReject',
  [MSG.INPUT]: 'input',
  [MSG.SNAPSHOT]: 'snapshot',
  [MSG.ACK]: 'ack',
  [MSG.EVENT]: 'event',
  [MSG.EVENT_ACK]: 'eventAck',
  [MSG.RPC]: 'rpc',
  [MSG.RPC_RESULT]: 'rpcResult',
  [MSG.PING]: 'ping',
  [MSG.PONG]: 'pong',
  [MSG.HOST_MIGRATE]: 'hostMigrate',
  [MSG.HOST_MIGRATE_ACK]: 'hostMigrateAck',
  [MSG.PEER_LIST]: 'peerList',
  [MSG.DISCONNECT]: 'disconnect',
};

/** Which channel each kind must travel on. The sender is not free to choose. */
export const MSG_CHANNEL: Readonly<Record<number, NetChannel>> = {
  [MSG.HELLO]: 'control',
  [MSG.WELCOME]: 'control',
  [MSG.JOIN_REQUEST]: 'control',
  [MSG.JOIN_ACCEPT]: 'control',
  [MSG.JOIN_REJECT]: 'control',
  [MSG.INPUT]: 'input',
  [MSG.SNAPSHOT]: 'state',
  [MSG.ACK]: 'state',
  [MSG.EVENT]: 'event',
  [MSG.EVENT_ACK]: 'event',
  [MSG.RPC]: 'control',
  [MSG.RPC_RESULT]: 'control',
  [MSG.PING]: 'state',
  [MSG.PONG]: 'state',
  [MSG.HOST_MIGRATE]: 'control',
  [MSG.HOST_MIGRATE_ACK]: 'control',
  [MSG.PEER_LIST]: 'control',
  [MSG.DISCONNECT]: 'control',
};

export function channelFor(kind: MsgKind): NetChannel {
  return MSG_CHANNEL[kind] ?? 'control';
}

/* ------------------------------------------------------------------------- *
 * Message shapes
 * ------------------------------------------------------------------------- */

export interface BaseMessage {
  /** Message kind discriminant. */
  k: MsgKind;
  /** Per-channel 16-bit datagram sequence, assigned by the sender. */
  seq: Sequence;
  /** Sender identity. HOST_CLIENT_ID from the authority. */
  from: ClientId;
}

export interface HelloMessage extends BaseMessage {
  k: typeof MSG.HELLO;
  protocol: number;
  /** Build identifier, for humans and for logs. */
  build: string;
  /** Simulation-affecting content hash; see `PROTOCOL_CONTENT_HASH`. */
  contentHash: number;
  name: string;
  /** Random per-attempt nonce; echoed in WELCOME to bind the exchange. */
  nonce: number;
}

export interface WelcomeMessage extends BaseMessage {
  k: typeof MSG.WELCOME;
  protocol: number;
  build: string;
  contentHash: number;
  /** Provisional id; becomes final in JOIN_ACCEPT. */
  assignedId: ClientId;
  serverTimeMs: Millis;
  tick: NetTick;
  config: NetConfig;
  nonce: number;
}

export interface JoinRequestMessage extends BaseMessage {
  k: typeof MSG.JOIN_REQUEST;
  info: JoinInfo;
}

export interface JoinAcceptMessage extends BaseMessage {
  k: typeof MSG.JOIN_ACCEPT;
  clientId: ClientId;
  entityId: EntityId;
  tick: NetTick;
  serverTimeMs: Millis;
  /** Seed for every deterministic stream in the match. */
  matchSeed: number;
  mapId: string;
  mode: string;
  peers: PeerInfo[];
  config: NetConfig;
}

export interface JoinRejectMessage extends BaseMessage {
  k: typeof MSG.JOIN_REJECT;
  reason: DisconnectReason;
  detail?: string;
}

export interface InputMessage extends BaseMessage {
  k: typeof MSG.INPUT;
  /** Oldest-first window of unacked commands (redundancy against loss). */
  commands: InputCommand[];
  /** Newest snapshot tick this client has applied — the delta baseline. */
  ackSnapshotTick: NetTick;
  /** Highest contiguous NetEvent id applied. */
  ackEventId: number;
  /** Client clock when sent; feeds RTT without a separate ping. */
  clientTimeMs: Millis;
}

export interface SnapshotMessage extends BaseMessage {
  k: typeof MSG.SNAPSHOT;
  snapshot: WorldSnapshot;
  /** Newest input sequence the host has consumed from this client. */
  ackInputSeq: Sequence;
  /** The client tick that input carried — lets the client measure its lead. */
  ackClientTick: NetTick;
  /** True when the receiver must reply with an ACK immediately. */
  needsAck: boolean;
}

export interface AckMessage extends BaseMessage {
  k: typeof MSG.ACK;
  channel: NetChannel;
  ack: AckState;
  /** Newest snapshot tick applied; the host uses it to pick the baseline. */
  ackSnapshotTick: NetTick;
}

export interface EventMessage extends BaseMessage {
  k: typeof MSG.EVENT;
  events: NetEvent[];
}

export interface EventAckMessage extends BaseMessage {
  k: typeof MSG.EVENT_ACK;
  throughEventId: number;
}

export interface RpcMessage extends BaseMessage {
  k: typeof MSG.RPC;
  req: RpcRequest;
}

export interface RpcResultMessage extends BaseMessage {
  k: typeof MSG.RPC_RESULT;
  res: RpcResponse;
}

export interface PingMessage extends BaseMessage {
  k: typeof MSG.PING;
  id: number;
  sentAtMs: Millis;
}

export interface PongMessage extends BaseMessage {
  k: typeof MSG.PONG;
  id: number;
  /** Echo of PingMessage.sentAtMs, in the pinger's clock. */
  sentAtMs: Millis;
  serverTimeMs: Millis;
  serverTick: NetTick;
}

export interface HostMigrateMessage extends BaseMessage {
  k: typeof MSG.HOST_MIGRATE;
  plan: MigrationPlan;
  /**
   * Base64 of `AuthoritativeSim.serialize()` when the outgoing host had time
   * to hand off cleanly. Absent on a hard host loss, in which case the
   * successor promotes its own most recent authoritative snapshot.
   */
  stateB64?: string;
}

export interface HostMigrateAckMessage extends BaseMessage {
  k: typeof MSG.HOST_MIGRATE_ACK;
  epoch: number;
  newHostId: ClientId;
  atTick: NetTick;
}

export interface PeerListMessage extends BaseMessage {
  k: typeof MSG.PEER_LIST;
  peers: PeerInfo[];
}

export interface DisconnectMessage extends BaseMessage {
  k: typeof MSG.DISCONNECT;
  reason: DisconnectReason;
  detail?: string;
}

export type NetMessage =
  | HelloMessage
  | WelcomeMessage
  | JoinRequestMessage
  | JoinAcceptMessage
  | JoinRejectMessage
  | InputMessage
  | SnapshotMessage
  | AckMessage
  | EventMessage
  | EventAckMessage
  | RpcMessage
  | RpcResultMessage
  | PingMessage
  | PongMessage
  | HostMigrateMessage
  | HostMigrateAckMessage
  | PeerListMessage
  | DisconnectMessage;

/** Messages a client is allowed to originate. Anything else is `bad-message`. */
export const CLIENT_ORIGINATED: readonly MsgKind[] = [
  MSG.HELLO, MSG.JOIN_REQUEST, MSG.INPUT, MSG.ACK, MSG.EVENT_ACK,
  MSG.RPC, MSG.PING, MSG.PONG, MSG.HOST_MIGRATE_ACK, MSG.DISCONNECT,
];

/** Messages only the authority may originate. */
export const HOST_ORIGINATED: readonly MsgKind[] = [
  MSG.WELCOME, MSG.JOIN_ACCEPT, MSG.JOIN_REJECT, MSG.SNAPSHOT, MSG.ACK,
  MSG.EVENT, MSG.RPC_RESULT, MSG.PING, MSG.PONG, MSG.HOST_MIGRATE,
  MSG.PEER_LIST, MSG.DISCONNECT,
];

export function isClientOriginated(kind: MsgKind): boolean {
  return CLIENT_ORIGINATED.indexOf(kind) >= 0;
}

export function isHostOriginated(kind: MsgKind): boolean {
  return HOST_ORIGINATED.indexOf(kind) >= 0;
}

/* ------------------------------------------------------------------------- *
 * Codec
 * ------------------------------------------------------------------------- */

export type DecodeError =
  | 'empty'
  | 'magic'
  | 'version'
  | 'too-large'
  | 'malformed'
  | 'unknown-kind'
  | 'too-many';

export type DecodeResult =
  | { ok: true; messages: NetMessage[] }
  | { ok: false; error: DecodeError; detail?: string };

/**
 * A datagram carries one or more messages. Batching matters: measured UDP +
 * DTLS + SCTP overhead is roughly 70 bytes per datagram, which at 60 Hz is
 * 4.2 KB/s of pure overhead per stream. Coalescing every message for a peer
 * into one datagram per send opportunity is not an optimisation, it is the
 * difference between 16 players fitting on a home uplink and not.
 */
export interface NetCodec {
  readonly name: string;
  encode(messages: readonly NetMessage[]): Uint8Array;
  decode(bytes: Uint8Array): DecodeResult;
  /** Largest payload the sender should hand to the transport. */
  readonly maxPacketBytes: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Reference codec: `[MAGIC][VERSION][utf8 JSON array]`.
 *
 * JSON is deliberately the *reference*, not the target. It is inspectable,
 * trivially debuggable and correct, and it defines the semantics a binary
 * codec must reproduce. Bandwidth planning uses `estimatePackedBytes()`, which
 * models the binary layout, so nobody sizes budgets off JSON by accident.
 */
export const JsonCodec: NetCodec = {
  name: 'json',
  maxPacketBytes: DEFAULT_NET_CONFIG.mtuBytes,

  encode(messages: readonly NetMessage[]): Uint8Array {
    const body = textEncoder.encode(JSON.stringify(messages));
    const out = new Uint8Array(HEADER_BYTES + body.length);
    out[0] = PROTOCOL_MAGIC;
    out[1] = PROTOCOL_VERSION;
    out.set(body, HEADER_BYTES);
    return out;
  },

  decode(bytes: Uint8Array): DecodeResult {
    if (!bytes || bytes.length < HEADER_BYTES) return { ok: false, error: 'empty' };
    if (bytes.length > MAX_PACKET_BYTES) {
      return { ok: false, error: 'too-large', detail: String(bytes.length) };
    }
    if (bytes[0] !== PROTOCOL_MAGIC) return { ok: false, error: 'magic' };
    if (bytes[1] !== PROTOCOL_VERSION) {
      return { ok: false, error: 'version', detail: `got ${bytes[1]} want ${PROTOCOL_VERSION}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(bytes.subarray(HEADER_BYTES)));
    } catch (err) {
      return { ok: false, error: 'malformed', detail: String(err) };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: 'malformed', detail: 'not an array' };
    if (parsed.length > MAX_MESSAGES_PER_PACKET) return { ok: false, error: 'too-many' };
    for (const m of parsed) {
      if (!m || typeof m !== 'object') return { ok: false, error: 'malformed', detail: 'not an object' };
      const kind = (m as { k?: unknown }).k;
      if (typeof kind !== 'number' || MSG_NAME[kind] === undefined) {
        return { ok: false, error: 'unknown-kind', detail: String(kind) };
      }
    }
    return { ok: true, messages: parsed as NetMessage[] };
  },
};

/** Convenience for the common single-message case. */
export function encodeOne(codec: NetCodec, msg: NetMessage): Uint8Array {
  return codec.encode([msg]);
}

/* ------------------------------------------------------------------------- *
 * Content hashing and compatibility
 * ------------------------------------------------------------------------- */

/** FNV-1a, folded so callers can chain their own tables into the hash. */
export function foldHash(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Hash of every constant that changes how the simulation evolves. Gameplay
 * modules that own simulation-affecting tables (weapon damage, movement
 * constants) should fold their own canonical string into this and pass the
 * result as `contentHash` — then two mismatched builds refuse to connect
 * instead of quietly diverging.
 */
export const PROTOCOL_CONTENT_HASH: number = (() => {
  let h = foldHash(2166136261, `p${PROTOCOL_VERSION}`);
  h = foldHash(h, JSON.stringify(DEFAULT_NET_CONFIG));
  h = foldHash(h, ALL_CHANNELS.map((c) => `${c}:${CHANNELS[c].label}:${CHANNELS[c].ordered}:${CHANNELS[c].maxRetransmits}`).join('|'));
  h = foldHash(h, `q${WORLD_HALF_EXTENT}:${POS_SCALE}:${VEL_SCALE}:${VEL_LIMIT}:${ANGLE_Q}`);
  h = foldHash(h, Object.keys(MSG).join(','));
  return h;
})();

export interface CompatResult {
  ok: boolean;
  reason?: DisconnectReason;
  detail?: string;
}

/** Run this on the host before allocating any state for a new peer. */
export function checkCompatibility(
  hello: Pick<HelloMessage, 'protocol' | 'contentHash'>,
  expectedContentHash: number = PROTOCOL_CONTENT_HASH,
): CompatResult {
  if (hello.protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: 'protocol-version',
      detail: `client protocol ${hello.protocol}, host ${PROTOCOL_VERSION}`,
    };
  }
  if ((hello.contentHash >>> 0) !== (expectedContentHash >>> 0)) {
    return {
      ok: false,
      reason: 'content-mismatch',
      detail: `client ${hello.contentHash >>> 0}, host ${expectedContentHash >>> 0}`,
    };
  }
  return { ok: true };
}

export function createHello(opts: {
  seq: Sequence;
  name: string;
  nonce: number;
  build?: string;
  contentHash?: number;
}): HelloMessage {
  return {
    k: MSG.HELLO,
    seq: opts.seq,
    from: -1,
    protocol: PROTOCOL_VERSION,
    build: opts.build ?? 'dev',
    contentHash: opts.contentHash ?? PROTOCOL_CONTENT_HASH,
    name: opts.name,
    nonce: opts.nonce,
  };
}

export function createWelcome(opts: {
  seq: Sequence;
  assignedId: ClientId;
  serverTimeMs: Millis;
  tick: NetTick;
  nonce: number;
  config?: NetConfig;
  build?: string;
  contentHash?: number;
}): WelcomeMessage {
  return {
    k: MSG.WELCOME,
    seq: opts.seq,
    from: HOST_CLIENT_ID,
    protocol: PROTOCOL_VERSION,
    build: opts.build ?? 'dev',
    contentHash: opts.contentHash ?? PROTOCOL_CONTENT_HASH,
    assignedId: opts.assignedId,
    serverTimeMs: opts.serverTimeMs,
    tick: opts.tick,
    config: opts.config ?? { ...DEFAULT_NET_CONFIG },
    nonce: opts.nonce,
  };
}

/* ------------------------------------------------------------------------- *
 * Sequence arithmetic (16-bit wrapping)
 * ------------------------------------------------------------------------- */

export function nextSeq(s: Sequence): Sequence {
  return (s + 1) & (SEQ_MOD - 1);
}

/** Signed distance a - b on the wrapping circle, in (-32768, 32768]. */
export function seqDiff(a: Sequence, b: Sequence): number {
  let d = (a - b) & (SEQ_MOD - 1);
  if (d > SEQ_MOD / 2) d -= SEQ_MOD;
  return d;
}

/** True when `a` is newer than `b`, wrap-safe. */
export function seqNewer(a: Sequence, b: Sequence): boolean {
  return seqDiff(a, b) > 0;
}

/* ------------------------------------------------------------------------- *
 * Ack window
 * ------------------------------------------------------------------------- */

export function emptyAck(): AckState {
  return { latest: -1, bits: 0, received: 0, lost: 0 };
}

/** True when `seq` is already covered by the window. */
export function ackHas(ack: AckState, seq: Sequence): boolean {
  if (ack.latest < 0) return false;
  if (seq === ack.latest) return true;
  const d = seqDiff(ack.latest, seq);
  if (d <= 0 || d > ACK_WINDOW) return false;
  return (ack.bits & (1 << (d - 1))) !== 0;
}

function popcount(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24);
}

/**
 * Record a received sequence. Returns false for duplicates and for anything so
 * old it has already fallen out of the window (the caller should drop those).
 *
 * Bit i of `bits` means "sequence `latest - i - 1` arrived". Advancing to a
 * newer sequence shifts the window left; every zero bit that falls off the end
 * is a packet that will never arrive, and is counted in `lost`. That gives a
 * loss estimate without any extra traffic.
 */
export function ackReceive(ack: AckState, seq: Sequence): boolean {
  const s = seq & (SEQ_MOD - 1);
  if (ack.latest < 0) {
    ack.latest = s;
    ack.bits = 0;
    ack.received++;
    return true;
  }
  const d = seqDiff(s, ack.latest);
  if (d === 0) return false;

  if (d > 0) {
    // Count zero bits that leave the window as lost.
    const leavingCount = Math.min(d, ACK_WINDOW);
    const leavingMask = leavingCount >= 32 ? 0xffffffff : (((1 << leavingCount) - 1) << (ACK_WINDOW - leavingCount)) >>> 0;
    ack.lost += leavingCount - popcount(ack.bits & leavingMask);
    // Sequences skipped so far ahead they never even enter the window.
    if (d - 1 > ACK_WINDOW) ack.lost += d - 1 - ACK_WINDOW;

    if (d >= ACK_WINDOW + 1) {
      ack.bits = 0; // the old `latest` is already past the end of the window
    } else {
      ack.bits = (((ack.bits << d) | (1 << (d - 1))) >>> 0) & (ACK_WINDOW >= 32 ? 0xffffffff : ((1 << ACK_WINDOW) - 1));
    }
    ack.latest = s;
    ack.received++;
    return true;
  }

  // Older, but possibly still inside the window: a reordered packet.
  const back = -d;
  if (back > ACK_WINDOW) return false;
  const mask = (1 << (back - 1)) >>> 0;
  if ((ack.bits & mask) !== 0) return false;
  ack.bits = (ack.bits | mask) >>> 0;
  ack.received++;
  return true;
}

/** Loss fraction over the window, 0..1. */
export function ackLossRatio(ack: AckState): number {
  const total = ack.received + ack.lost;
  return total > 0 ? ack.lost / total : 0;
}

/* ------------------------------------------------------------------------- *
 * Quantization — shared by every codec so client and host round identically
 * ------------------------------------------------------------------------- */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function quantizePos(metres: number): number {
  const step = 1 / POS_SCALE;
  const c = clamp(metres, -WORLD_HALF_EXTENT, WORLD_HALF_EXTENT - step);
  return Math.round((c + WORLD_HALF_EXTENT) * POS_SCALE) & POS_MAX_Q;
}

export function dequantizePos(q: number): number {
  return (q & POS_MAX_Q) / POS_SCALE - WORLD_HALF_EXTENT;
}

export function quantizeVel(mps: number): number {
  const step = 1 / VEL_SCALE;
  const c = clamp(mps, -VEL_LIMIT, VEL_LIMIT - step);
  return Math.round((c + VEL_LIMIT) * VEL_SCALE) & 0xffff;
}

export function dequantizeVel(q: number): number {
  return (q & 0xffff) / VEL_SCALE - VEL_LIMIT;
}

const TWO_PI = Math.PI * 2;

/** Yaw wraps, so it uses the whole 16-bit circle with no clamping. */
export function quantizeYaw(radians: number): number {
  let a = radians % TWO_PI;
  if (a < 0) a += TWO_PI;
  return Math.round((a / TWO_PI) * ANGLE_Q) & 0xffff;
}

export function dequantizeYaw(q: number): number {
  const a = ((q & 0xffff) / ANGLE_Q) * TWO_PI;
  return a > Math.PI ? a - TWO_PI : a;
}

/** Pitch is clamped, not wrapped: looking past straight up is not a thing. */
export function quantizePitch(radians: number): number {
  const c = clamp(radians, -PITCH_LIMIT, PITCH_LIMIT);
  return Math.round(((c + PITCH_LIMIT) / (2 * PITCH_LIMIT)) * 0xffff) & 0xffff;
}

export function dequantizePitch(q: number): number {
  return ((q & 0xffff) / 0xffff) * 2 * PITCH_LIMIT - PITCH_LIMIT;
}

/** -1..1 into a signed byte, for analogue movement axes. */
export function quantizeUnit(v: number): number {
  return Math.round(clamp(v, -1, 1) * 127);
}

export function dequantizeUnit(q: number): number {
  return clamp(q / 127, -1, 1);
}

/**
 * Round a command through the wire quantizers. The client MUST predict with
 * the quantized values, not the raw ones, or prediction and the authority
 * diverge by exactly the quantization error every single tick.
 */
export function quantizeCommand(cmd: InputCommand): InputCommand {
  return {
    ...cmd,
    moveX: dequantizeUnit(quantizeUnit(cmd.moveX)),
    moveZ: dequantizeUnit(quantizeUnit(cmd.moveZ)),
    yaw: dequantizeYaw(quantizeYaw(cmd.yaw)),
    pitch: dequantizePitch(quantizePitch(cmd.pitch)),
  };
}

/* ------------------------------------------------------------------------- *
 * Input validation — the host trusts nothing
 * ------------------------------------------------------------------------- */

const ALL_BUTTONS = Object.keys(BUTTON)
  .reduce((m, k) => m | BUTTON[k as keyof typeof BUTTON], 0);

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Clamp a command into the legal envelope, or reject it outright. Returns a
 * NEW object so a hostile peer cannot retain a reference into host state.
 *
 * This is a security boundary, not a convenience: a malicious client will send
 * `moveX: 1e9`, `dtMs: 10000` and `fireCount: 2^31` on its first packet.
 */
export function sanitizeInput(
  raw: unknown,
  cfg: NetConfig = DEFAULT_NET_CONFIG,
): InputCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<InputCommand>;
  if (!finite(c.seq) || !finite(c.clientTick) || !finite(c.dtMs)) return null;
  if (!finite(c.moveX) || !finite(c.moveZ) || !finite(c.yaw) || !finite(c.pitch)) return null;
  if (!finite(c.buttons) || !finite(c.weaponSlot) || !finite(c.fireCount)) return null;
  if (c.clientTick < 0 || c.fireCount < 0) return null;

  const maxDt = (1000 / cfg.tickHz) * 2;
  return {
    seq: c.seq & (SEQ_MOD - 1),
    clientTick: Math.floor(c.clientTick),
    dtMs: clamp(c.dtMs, 1, maxDt),
    moveX: dequantizeUnit(quantizeUnit(c.moveX)),
    moveZ: dequantizeUnit(quantizeUnit(c.moveZ)),
    yaw: dequantizeYaw(quantizeYaw(c.yaw)),
    pitch: dequantizePitch(quantizePitch(c.pitch)),
    buttons: (c.buttons | 0) & ALL_BUTTONS,
    weaponSlot: clamp(Math.floor(c.weaponSlot), 0, 3),
    fireCount: Math.min(Math.floor(c.fireCount), 0x7fffffff),
  };
}

/** Default `dtMs` for a command covering exactly one net tick. */
export const DEFAULT_COMMAND_DT_MS = NET_TICK_MS;

/* ------------------------------------------------------------------------- *
 * Clock synchronisation
 * ------------------------------------------------------------------------- */

export interface ClockSample {
  rttMs: number;
  /** Add to a local timestamp to get server time. */
  offsetMs: number;
}

/**
 * One RTT sample from a PING/PONG pair. Assumes a symmetric path, which is
 * wrong by a few ms and does not matter: the client only needs the offset to
 * choose which tick to predict, and reconciliation corrects the rest.
 */
export function sampleClock(pong: Pick<PongMessage, 'sentAtMs' | 'serverTimeMs'>, nowMs: number): ClockSample {
  const rtt = Math.max(0, nowMs - pong.sentAtMs);
  return { rttMs: rtt, offsetMs: pong.serverTimeMs + rtt / 2 - nowMs };
}

/**
 * The server tick a client should be predicting: far enough ahead that its
 * input lands just before the host simulates that tick.
 * `lead = (rtt/2 + jitter + one tick) / tickMs`, at least one tick.
 */
export function predictedServerTick(
  serverTickAtSample: NetTick,
  msSinceSample: number,
  stats: Pick<ConnectionStats, 'rttMs' | 'jitterMs'>,
  cfg: NetConfig = DEFAULT_NET_CONFIG,
): NetTick {
  const tickMs = 1000 / cfg.tickHz;
  const lead = Math.ceil((stats.rttMs / 2 + stats.jitterMs + tickMs) / tickMs);
  return serverTickAtSample + Math.floor(msSinceSample / tickMs) + Math.max(1, lead);
}

/* ------------------------------------------------------------------------- *
 * Size model — bandwidth budgeting must not be sized off JSON
 * ------------------------------------------------------------------------- */

/** Binary layout costs, bytes. Keep in sync with any binary codec. */
export const PACKED = {
  /** magic + version. */
  header: HEADER_BYTES,
  /** kind + seq + from. */
  messageHeader: 4,
  /** id varint + field mask. */
  entityHeader: 4,
  pos: 6,
  rot: 4,
  vel: 6,
  flags: 2,
  health: 2,
  weapon: 1,
  anim: 2,
  team: 1,
  owner: 1,
  score: 2,
  removedEntity: 2,
  /** tick + serverTime + baselineTick + ackInputSeq + ackClientTick + counts. */
  snapshotHeader: 18,
  /** seq + clientTick delta + dt + axes + angles + buttons + slot + fireCount. */
  inputCommand: 13,
  inputHeader: 9,
  eventHeader: 8,
} as const;

/** Bytes an entity record costs given its delta field mask. */
export function entitySnapshotBytes(fields: number): number {
  let n = PACKED.entityHeader;
  if (fields & SNAP_FIELD.POS) n += PACKED.pos;
  if (fields & SNAP_FIELD.ROT) n += PACKED.rot;
  if (fields & SNAP_FIELD.VEL) n += PACKED.vel;
  if (fields & SNAP_FIELD.FLAGS) n += PACKED.flags;
  if (fields & SNAP_FIELD.HEALTH) n += PACKED.health;
  if (fields & SNAP_FIELD.WEAPON) n += PACKED.weapon;
  if (fields & SNAP_FIELD.ANIM) n += PACKED.anim;
  if (fields & SNAP_FIELD.TEAM) n += PACKED.team;
  if (fields & SNAP_FIELD.OWNER) n += PACKED.owner;
  if (fields & SNAP_FIELD.SCORE) n += PACKED.score;
  return n;
}

export function snapshotBytes(snap: WorldSnapshot): number {
  let n = PACKED.messageHeader + PACKED.snapshotHeader;
  for (const e of snap.entities) n += entitySnapshotBytes(e.fields);
  n += snap.removed.length * PACKED.removedEntity;
  return n;
}

/**
 * Modelled binary size of a message. Used for bandwidth budgeting and by
 * `tools/net-protocol.mjs` to check the numbers in docs/NETCODE.md.
 * Falls back to the JSON size for rare control messages, which is fine —
 * they are not on the per-tick path.
 */
export function estimatePackedBytes(msg: NetMessage): number {
  switch (msg.k) {
    case MSG.SNAPSHOT:
      return snapshotBytes(msg.snapshot);
    case MSG.INPUT:
      return PACKED.messageHeader + PACKED.inputHeader + msg.commands.length * PACKED.inputCommand;
    case MSG.EVENT: {
      let n = PACKED.messageHeader;
      for (const e of msg.events) n += PACKED.eventHeader + jsonBytes(e.data) + e.kind.length;
      return n;
    }
    case MSG.ACK:
      return PACKED.messageHeader + 11;
    case MSG.EVENT_ACK:
      return PACKED.messageHeader + 4;
    case MSG.PING:
    case MSG.PONG:
      return PACKED.messageHeader + 14;
    default:
      return PACKED.messageHeader + jsonBytes(msg);
  }
}

/** Total wire cost of a datagram carrying `messages`, excluding IP/UDP/DTLS. */
export function estimateDatagramBytes(messages: readonly NetMessage[]): number {
  let n = PACKED.header;
  for (const m of messages) n += estimatePackedBytes(m);
  return n;
}

/**
 * Measured per-datagram overhead below our payload: IPv4 20 + UDP 8 +
 * DTLS record ~13 + SCTP common 12 + DATA chunk 16. This is why we batch.
 */
export const DATAGRAM_OVERHEAD_BYTES = 69;

function jsonBytes(v: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(v ?? null)).length;
  } catch {
    return 0;
  }
}

/** Per-client budget derived from the config. */
export function budgetFor(cfg: NetConfig = DEFAULT_NET_CONFIG): {
  bytesPerSecond: number; bytesPerSnapshot: number; maxDatagrams: number;
} {
  const perSnapshot = Math.floor(cfg.budgetBytesPerSecond / cfg.snapshotHz);
  return {
    bytesPerSecond: cfg.budgetBytesPerSecond,
    bytesPerSnapshot: perSnapshot,
    maxDatagrams: Math.max(1, Math.ceil(perSnapshot / cfg.mtuBytes)),
  };
}
