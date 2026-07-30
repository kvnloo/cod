/**
 * Networking vocabulary — the shared types every net module codes against.
 *
 * HARD RULES FOR THIS FILE
 *  1. It imports NOTHING. No `three`, no DOM, no engine. The authority
 *     simulation has to run unchanged inside a headless Node process, so every
 *     type on the wire is expressed in plain numbers/strings.
 *  2. Types and constants only — no behaviour. Runtime helpers live in
 *     `Protocol.ts` so this file stays a pure, stable vocabulary.
 *  3. Additive changes only once other modules depend on it. Renaming a field
 *     here breaks seven other agents; add a new field and deprecate instead.
 *
 * See `docs/NETCODE.md` for the architecture these types encode.
 */

/* ------------------------------------------------------------------------- *
 * Identities and scalars
 * ------------------------------------------------------------------------- */

/** A server simulation tick. Monotonic, 60 per second, never wraps in a match. */
export type NetTick = number;

/** Stable per-connection identity assigned by the authority. Host is always 0. */
export type ClientId = number;

/** Networked entity handle. Matches the gameplay entity id where one exists. */
export type EntityId = number;

/** 16-bit wrapping sequence number (datagrams, input commands). */
export type Sequence = number;

/** Milliseconds. Wall-clock unless the field name says otherwise. */
export type Millis = number;

/** The authority always occupies client id 0, peer-host or dedicated alike. */
export const HOST_CLIENT_ID: ClientId = 0;
export const INVALID_CLIENT: ClientId = -1;
export const INVALID_ENTITY: EntityId = -1;
/** `baselineTick` value meaning "this snapshot is a keyframe, not a delta". */
export const NO_BASELINE: NetTick = -1;
/** `NetEvent.target` value meaning "broadcast to everyone who can see it". */
export const BROADCAST: ClientId = -1;

/* ------------------------------------------------------------------------- *
 * Roles, connection lifecycle, disconnect reasons
 * ------------------------------------------------------------------------- */

/**
 * What this process is doing.
 *  - `host`    : owns the authoritative simulation (peer-host or dedicated).
 *  - `client`  : predicts locally, obeys the host.
 *  - `offline` : single player. The same simulation runs with a loopback
 *                transport, so there is no separate "SP code path".
 */
export type NetRole = 'host' | 'client' | 'offline';

/**
 * Connection lifecycle. Strictly forward-moving except `live -> reconnecting`.
 *  offline -> signalling -> connecting -> handshaking -> syncing -> live
 *  any state -> closed
 */
export type ConnectionState =
  | 'offline'
  | 'signalling'      // exchanging SDP/ICE out of band
  | 'connecting'      // ICE/DTLS in progress, no channels open yet
  | 'handshaking'     // channels open, HELLO/WELCOME in flight
  | 'syncing'         // joined, waiting for the first keyframe snapshot
  | 'live'            // simulating
  | 'reconnecting'    // lost packets past the timeout, trying to recover
  | 'closed';

export type DisconnectReason =
  | 'client-quit'
  | 'host-quit'
  | 'kicked'
  | 'banned'
  | 'timeout'
  | 'server-full'
  | 'protocol-version'   // PROTOCOL_VERSION differs
  | 'content-mismatch'   // different game build / content hash: would desync
  | 'bad-message'        // malformed or out-of-contract packet
  | 'rate-limit'         // flooding the authority
  | 'duplicate-identity'
  | 'host-migrating'
  | 'transport-error'
  | 'unknown';

/* ------------------------------------------------------------------------- *
 * Channel taxonomy
 * ------------------------------------------------------------------------- */

/**
 * Logical channels. The transport maps each to one WebRTC DataChannel (or one
 * loopback queue). Never send state on `control` or control on `state`.
 */
export type NetChannel =
  /** Reliable + ordered. Handshake, join, RPC, host migration, disconnect. */
  | 'control'
  /** Unreliable + sequenced. Client -> host input commands. */
  | 'input'
  /** Unreliable + sequenced. Host -> client world snapshots. */
  | 'state'
  /** Reliable + unordered. Gameplay events that must not be lost (kills, hits). */
  | 'event'
  /** Reliable + ordered, low priority. Bulk payloads (loadouts, map params). */
  | 'bulk';

export interface ChannelSpec {
  /** DataChannel label. Both ends must agree; the host creates them. */
  readonly label: string;
  /** SCTP ordering. */
  readonly ordered: boolean;
  /** `undefined` = fully reliable. `0` = fire and forget. */
  readonly maxRetransmits: number | undefined;
  /** Higher drains first when the send budget is tight. */
  readonly priority: number;
  readonly notes: string;
}

/**
 * NOTE ON "UNRELIABLE-SEQUENCED": SCTP has no such mode. `ordered:true` with
 * `maxRetransmits:0` reintroduces head-of-line delay while the stack waits to
 * see whether a gap will be filled, which is exactly the latency we are trying
 * to avoid. So the transport uses `ordered:false, maxRetransmits:0` and we
 * sequence at the application layer: every datagram carries a 16-bit `seq` and
 * the receiver drops anything older than the newest it has already applied.
 * That is a true unreliable-sequenced channel with no HOL stall.
 */
export const CHANNELS: Readonly<Record<NetChannel, ChannelSpec>> = {
  control: {
    label: 'ob.control', ordered: true, maxRetransmits: undefined, priority: 100,
    notes: 'reliable-ordered; handshake, join, rpc, migration',
  },
  input: {
    label: 'ob.input', ordered: false, maxRetransmits: 0, priority: 90,
    notes: 'unreliable-sequenced via app-level seq; loss covered by redundancy',
  },
  state: {
    label: 'ob.state', ordered: false, maxRetransmits: 0, priority: 80,
    notes: 'unreliable-sequenced via app-level seq; loss covered by delta baselines',
  },
  event: {
    label: 'ob.event', ordered: false, maxRetransmits: undefined, priority: 70,
    notes: 'reliable-unordered; receiver orders by NetEvent.tick',
  },
  bulk: {
    label: 'ob.bulk', ordered: true, maxRetransmits: undefined, priority: 10,
    notes: 'reliable-ordered, yields to everything else',
  },
} as const;

export const ALL_CHANNELS: readonly NetChannel[] = ['control', 'input', 'state', 'event', 'bulk'];

/* ------------------------------------------------------------------------- *
 * Rates and configuration
 * ------------------------------------------------------------------------- */

/**
 * The engine's fixed step (`Time.fixedDelta`) is 1/120 s. The network tick is
 * 1/60 s — exactly two engine steps. Keep this an integer ratio; if anyone
 * changes `Time.fixedDelta`, `ENGINE_STEPS_PER_NET_TICK` must stay whole.
 */
export const ENGINE_FIXED_HZ = 120;
export const NET_TICK_HZ = 60;
export const NET_TICK_DT = 1 / NET_TICK_HZ;
export const NET_TICK_MS = 1000 / NET_TICK_HZ;
export const ENGINE_STEPS_PER_NET_TICK = ENGINE_FIXED_HZ / NET_TICK_HZ; // 2

export interface NetConfig {
  /** Authoritative simulation rate. */
  tickHz: number;
  /** Snapshot broadcast rate. Must divide `tickHz` evenly. */
  snapshotHz: number;
  /** Input send rate from clients. */
  inputSendHz: number;
  /** Unacked commands repeated in every input packet (loss insurance). */
  inputRedundancy: number;
  /** Hard cap on connected clients including the host. */
  maxClients: number;
  /**
   * How far behind the newest received snapshot remote entities are rendered.
   * Must exceed one snapshot interval plus jitter, or interpolation starves.
   */
  interpDelayMs: Millis;
  /** Largest rewind the authority will perform for lag compensation. */
  maxLagCompMs: Millis;
  /** Snapshots retained by the host for delta baselines and rewind. */
  snapshotHistory: number;
  /** Input commands the host buffers per client before dropping the oldest. */
  inputBufferTicks: number;
  /** No traffic for this long => `reconnecting`, then `timeout`. */
  timeoutMs: Millis;
  pingIntervalMs: Millis;
  /** Safe payload per datagram. Anything larger risks IP fragmentation. */
  mtuBytes: number;
  /** Per-client downstream budget the snapshot writer must stay under. */
  budgetBytesPerSecond: number;
}

/**
 * Defaults. Justified with bandwidth arithmetic in `docs/NETCODE.md` §4 —
 * change these and update that table.
 */
export const DEFAULT_NET_CONFIG: Readonly<NetConfig> = {
  tickHz: NET_TICK_HZ,
  snapshotHz: 20,
  inputSendHz: NET_TICK_HZ,
  inputRedundancy: 3,
  maxClients: 16,
  interpDelayMs: 100,
  maxLagCompMs: 250,
  snapshotHistory: 64,
  inputBufferTicks: 32,
  timeoutMs: 8000,
  pingIntervalMs: 1000,
  mtuBytes: 1200,
  budgetBytesPerSecond: 12000,
} as const;

/** Small lobbies can afford a faster snapshot rate; see NETCODE.md §4. */
export const SNAPSHOT_HZ_BY_PLAYER_COUNT: readonly { readonly maxPlayers: number; readonly hz: number }[] = [
  { maxPlayers: 8, hz: 30 },
  { maxPlayers: 16, hz: 20 },
  { maxPlayers: 32, hz: 15 },
] as const;

/**
 * Execution slots for net systems, expressed against `ORDER` in
 * `src/core/Engine.ts` (INPUT 0, PHYSICS 100, PLAYER 200, WORLD 600, FX 700,
 * CAMERA 900, UI 950, RENDER 1000). Declared as literals so this file keeps
 * zero imports.
 */
export const NET_ORDER = {
  /** Drain transports, decode, apply acks. Immediately after INPUT. */
  RECEIVE: 10,
  /** Sample local input into an InputCommand. */
  SAMPLE: 20,
  /** Host applies queued client input just before PHYSICS. */
  HOST_APPLY: 90,
  /** Client rollback + replay just before PLAYER. */
  RECONCILE: 190,
  /** Remote entity interpolation, after WORLD so FX/audio see final positions. */
  INTERPOLATE: 650,
  /** Encode + flush. Last thing before RENDER. */
  SEND: 990,
} as const;

/* ------------------------------------------------------------------------- *
 * Quantization
 * ------------------------------------------------------------------------- */

/** Playable volume is a 1024 m cube centred on the origin. */
export const WORLD_HALF_EXTENT = 512;
/** Position steps per metre: 1/64 m = 15.6 mm, 16 bits per axis. */
export const POS_SCALE = 64;
export const POS_MAX_Q = 0xffff;
/** Velocity steps per m/s: 1/64 m/s over +/-512 m/s, 16 bits per axis. */
export const VEL_SCALE = 64;
export const VEL_LIMIT = 512;
/** Yaw uses the full 16-bit circle: 0.0055 deg, ~8x finer than one screen pixel. */
export const ANGLE_Q = 0x10000;
/** Pitch is clamped to +/-90 deg and quantized over 16 bits. */
export const PITCH_LIMIT = Math.PI / 2;
/** Health/armour are bytes. 0..255 covers every mode we ship. */
export const HEALTH_MAX = 255;

/* ------------------------------------------------------------------------- *
 * Input
 * ------------------------------------------------------------------------- */

/** Button bitmask carried in every `InputCommand`. Additive only. */
export const BUTTON = {
  FIRE: 1 << 0,
  ADS: 1 << 1,
  JUMP: 1 << 2,
  CROUCH: 1 << 3,
  PRONE: 1 << 4,
  SPRINT: 1 << 5,
  RELOAD: 1 << 6,
  MELEE: 1 << 7,
  USE: 1 << 8,
  GRENADE: 1 << 9,
  TACTICAL: 1 << 10,
  LEAN_LEFT: 1 << 11,
  LEAN_RIGHT: 1 << 12,
  SWITCH: 1 << 13,
} as const;
export type ButtonMask = number;

/**
 * One tick of player intent. This is the ONLY thing a client is allowed to
 * send that affects the simulation — never positions, never damage.
 *
 * Wire size when binary-packed: 13 bytes (see NETCODE.md §4).
 */
export interface InputCommand {
  /** Per-client monotonic, wraps at 16 bits. Used for reconciliation + acks. */
  seq: Sequence;
  /** The server tick the client believes it is simulating (predicted). */
  clientTick: NetTick;
  /** Duration this command covers, ms. Host clamps to [1, 2 * NET_TICK_MS]. */
  dtMs: number;
  /** Strafe intent, -1..1. */
  moveX: number;
  /** Forward intent, -1..1. */
  moveZ: number;
  /** View yaw, radians in [-PI, PI). */
  yaw: number;
  /** View pitch, radians in [-PI/2, PI/2]. */
  pitch: number;
  buttons: ButtonMask;
  /** Requested weapon slot, 0..3. The host validates ownership. */
  weaponSlot: number;
  /**
   * Monotonic count of shots the client believes it has fired. Makes firing
   * edge-triggered and idempotent under duplicate/reordered delivery — the host
   * fires `min(delta, maxRate)` shots, never one per received packet.
   */
  fireCount: number;
}

/* ------------------------------------------------------------------------- *
 * Entities and snapshots
 * ------------------------------------------------------------------------- */

export const ENTITY_KIND = {
  PLAYER: 1,
  BOT: 2,
  PROJECTILE: 3,
  GRENADE: 4,
  PICKUP: 5,
  PROP: 6,
  VEHICLE: 7,
  OBJECTIVE: 8,
  RAGDOLL: 9,
} as const;
export type EntityKind = (typeof ENTITY_KIND)[keyof typeof ENTITY_KIND];

/** Replicated boolean state. 16 bits on the wire. */
export const ENTITY_FLAG = {
  ALIVE: 1 << 0,
  CROUCH: 1 << 1,
  PRONE: 1 << 2,
  SPRINT: 1 << 3,
  ADS: 1 << 4,
  AIRBORNE: 1 << 5,
  RELOADING: 1 << 6,
  FIRING: 1 << 7,
  SLIDING: 1 << 8,
  MANTLING: 1 << 9,
  DOWNED: 1 << 10,
  INVULNERABLE: 1 << 11,
  LEAN_LEFT: 1 << 12,
  LEAN_RIGHT: 1 << 13,
} as const;

/**
 * Delta field mask. A bit set means "this field changed since the baseline and
 * the value in this record is authoritative". A bit clear means "unchanged —
 * keep the baseline value". Full/keyframe snapshots set `SNAP_FIELD.ALL`.
 */
export const SNAP_FIELD = {
  POS: 1 << 0,
  ROT: 1 << 1,
  VEL: 1 << 2,
  FLAGS: 1 << 3,
  HEALTH: 1 << 4,
  WEAPON: 1 << 5,
  ANIM: 1 << 6,
  TEAM: 1 << 7,
  OWNER: 1 << 8,
  SCORE: 1 << 9,
  ALL: 0x03ff,
} as const;

/**
 * One entity's replicated state. Fields not selected by `fields` are present
 * (so the struct can be pooled and reused without allocation) but MUST be
 * ignored by the receiver — read them from the baseline instead.
 */
export interface EntitySnapshot {
  id: EntityId;
  kind: EntityKind;
  /** Which fields in this record are meaningful. See SNAP_FIELD. */
  fields: number;
  /** Owning client, or INVALID_CLIENT for world-owned entities. */
  owner: ClientId;
  team: number;
  /** Position, metres, world space. */
  px: number; py: number; pz: number;
  /** View/facing angles, radians. */
  yaw: number; pitch: number;
  /** Linear velocity, m/s. Clients extrapolate with this between snapshots. */
  vx: number; vy: number; vz: number;
  health: number;
  armor: number;
  /** ENTITY_FLAG bitmask. */
  flags: number;
  /** Index into the weapon table. */
  weapon: number;
  /** Packed animation state: locomotion phase + upper-body action. */
  anim: number;
  score: number;
}

/**
 * The world as one client is allowed to see it at one tick. Interest management
 * means each client gets a different instance — this is a per-viewer view, not
 * a global truth object.
 */
export interface WorldSnapshot {
  tick: NetTick;
  /** Authority clock when this was produced; drives client time sync. */
  serverTimeMs: Millis;
  /** Tick this delta is relative to, or NO_BASELINE for a keyframe. */
  baselineTick: NetTick;
  entities: EntitySnapshot[];
  /** Entities that left the viewer's interest set or were destroyed. */
  removed: EntityId[];
}

/* ------------------------------------------------------------------------- *
 * Acknowledgement
 * ------------------------------------------------------------------------- */

/**
 * Rolling 33-packet acknowledgement window: `latest` plus a bitfield covering
 * the 32 sequences before it. Bit i set = `latest - (i + 1)` was received.
 * One 16-bit + one 32-bit field acks a third of a second of traffic.
 */
export interface AckState {
  /** Newest sequence seen, or -1 if nothing has arrived yet. */
  latest: Sequence;
  /** Bit i = sequence (latest - i - 1) was received. */
  bits: number;
  received: number;
  /** Sequences that fell out of the window without ever arriving. */
  lost: number;
}

/* ------------------------------------------------------------------------- *
 * Events and RPC
 * ------------------------------------------------------------------------- */

/**
 * A one-shot gameplay fact produced by the authority. Everything cosmetic
 * (tracer, impact, killfeed line, hitmarker) rides on these rather than being
 * inferred from state deltas, so clients never invent gameplay outcomes.
 *
 * `kind` SHOULD be a key of `GameEvents` in `src/core/EventBus.ts` — the client
 * event router re-emits them onto the local bus so FX/audio/HUD keep working
 * unchanged in multiplayer.
 */
export interface NetEvent {
  /** Host-assigned, monotonic. Receivers dedupe on this. */
  id: number;
  tick: NetTick;
  kind: string;
  data: unknown;
  /** BROADCAST, or a single client for private events (hitmarkers, pickups). */
  target: ClientId;
}

/** Client -> host request/response. Never used for per-tick state. */
export interface RpcRequest {
  rpcId: number;
  method: string;
  args: unknown;
}

export interface RpcResponse {
  rpcId: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/* ------------------------------------------------------------------------- *
 * Peers, stats, identity
 * ------------------------------------------------------------------------- */

export interface PeerInfo {
  id: ClientId;
  name: string;
  team: number;
  /** True for the client that currently owns the authority. */
  isHost: boolean;
  entityId: EntityId;
  pingMs: number;
  state: ConnectionState;
  /** Rank in the host-migration succession order; lower wins. */
  migrationRank: number;
}

export interface ConnectionStats {
  state: ConnectionState;
  rttMs: number;
  jitterMs: number;
  /** Fraction 0..1 over the ack window. */
  lossIn: number;
  lossOut: number;
  kbpsIn: number;
  kbpsOut: number;
  /** serverClock - localClock, ms. Add to local time to get server time. */
  clockOffsetMs: number;
  lastRecvMs: Millis;
  bufferedBytes: number;
}

export function emptyStats(): ConnectionStats {
  return {
    state: 'offline', rttMs: 0, jitterMs: 0, lossIn: 0, lossOut: 0,
    kbpsIn: 0, kbpsOut: 0, clockOffsetMs: 0, lastRecvMs: 0, bufferedBytes: 0,
  };
}

/* ------------------------------------------------------------------------- *
 * Interest management + bandwidth
 * ------------------------------------------------------------------------- */

/** Everything the relevance function is allowed to know about a viewer. */
export interface InterestView {
  clientId: ClientId;
  entityId: EntityId;
  team: number;
  x: number; y: number; z: number;
  /** Unit forward vector of the viewer's camera. */
  fx: number; fy: number; fz: number;
  /** Half-angle of the view cone, radians. */
  fovHalf: number;
}

/**
 * Relevance in [0, 1]; 0 means "do not send at all this tick".
 * Implementations must be pure and cheap — this runs
 * `clients x entities` times per snapshot.
 */
export interface InterestPolicy {
  readonly name: string;
  relevance(view: InterestView, entity: EntitySnapshot): number;
}

/** Named relevance floors so policies stay comparable across modules. */
export const RELEVANCE = {
  /** Always replicate: the viewer's own entity, objectives, the match clock. */
  CRITICAL: 1.0,
  /** In view and close. */
  HIGH: 0.75,
  /** Audible/nearby but not visible — needed for footsteps and radar. */
  MEDIUM: 0.4,
  /** Far away; send at a reduced cadence. */
  LOW: 0.1,
  /** Culled. */
  NONE: 0,
} as const;

export interface BandwidthBudget {
  /** Bytes this client may receive per second. */
  bytesPerSecond: number;
  /** Derived per-send allowance; the snapshot writer must not exceed it. */
  bytesPerSnapshot: number;
  /** Never split a snapshot beyond this many datagrams. */
  maxDatagrams: number;
}

/* ------------------------------------------------------------------------- *
 * Transport abstraction
 * ------------------------------------------------------------------------- */

/**
 * One point-to-point connection. WebRTC DataChannels, an in-process loopback
 * pair, and a future WebSocket/WebTransport link all implement this, which is
 * the seam that lets the host move off a peer without touching gameplay.
 */
export interface NetLink {
  /** Remote identity. On a client this is HOST_CLIENT_ID. */
  readonly remoteId: ClientId;
  readonly state: ConnectionState;
  /** Bytes queued in the transport; back-pressure signal for the send budget. */
  readonly bufferedBytes: number;
  send(channel: NetChannel, data: Uint8Array): void;
  close(reason: DisconnectReason): void;
  stats(): ConnectionStats;
  /** Set by the owner; called on the transport's delivery thread/task. */
  onMessage: ((channel: NetChannel, data: Uint8Array) => void) | null;
  onStateChange: ((state: ConnectionState, reason?: DisconnectReason) => void) | null;
}

/**
 * Produces `NetLink`s. A host calls `listen()`, a client calls `connect()`.
 * `loopback` is the offline/single-player and unit-test implementation and MUST
 * behave identically to `webrtc` apart from latency.
 */
export interface NetTransport {
  readonly kind: 'webrtc' | 'loopback' | 'websocket';
  /** Host side: start accepting. Resolves once ready for signalling. */
  listen?(): Promise<void>;
  /** Client side: dial the host. `token` is transport-specific signalling data. */
  connect?(token: string): Promise<NetLink>;
  /** Host side: fires for every inbound link, before the handshake. */
  onLink: ((link: NetLink) => void) | null;
  close(): void;
}

/* ------------------------------------------------------------------------- *
 * The authority boundary
 * ------------------------------------------------------------------------- */

export interface JoinInfo {
  name: string;
  /** Preferred team, or -1 to let the authority assign. */
  team: number;
  loadout: string[];
}

/**
 * THE authority boundary. Whatever runs the truth — a browser peer-host today,
 * a headless Node process tomorrow — implements exactly this, and the network
 * layer above it never learns which one it is talking to.
 *
 * Constraints that keep this portable, and which reviewers should enforce:
 *  - no `three`, no DOM, no renderer, no audio;
 *  - all randomness from a `Rand` seeded by `matchSeed`;
 *  - `step()` advances exactly one net tick and is a pure function of
 *    (previous state, queued inputs, tick) — that is what makes client
 *    prediction, server rewind and replay all agree.
 */
export interface AuthoritativeSim {
  /** Tick that has been fully simulated. */
  readonly tick: NetTick;
  /** Seed for every RNG stream in the match; replicated in JOIN_ACCEPT. */
  readonly matchSeed: number;

  addClient(id: ClientId, info: JoinInfo): EntityId;
  removeClient(id: ClientId, reason: DisconnectReason): void;

  /** Queue one validated command. May be called several times per tick. */
  queueInput(id: ClientId, cmd: InputCommand): void;

  /** Advance exactly one net tick. `dt` is always `NET_TICK_DT`. */
  step(dt: number): void;

  /** Where the viewer's camera is, for interest management. */
  viewOf(id: ClientId): InterestView | null;

  /**
   * Build this viewer's snapshot. `baselineTick` is the newest tick the client
   * has acked, or NO_BASELINE to force a keyframe.
   */
  snapshotFor(id: ClientId, baselineTick: NetTick, budget: BandwidthBudget): WorldSnapshot;

  /** Events produced since the last call. Host clears its queue. */
  drainEvents(): NetEvent[];

  /** Handle a client RPC. Must validate everything; clients are hostile. */
  handleRpc(id: ClientId, req: RpcRequest): RpcResponse;

  /**
   * Serialized full state, for host migration and late join. Must round-trip
   * through `restore()` bit-for-bit or migration desyncs.
   */
  serialize(): Uint8Array;
  restore(data: Uint8Array): void;
}

/** What the client layer needs from the local presentation/prediction side. */
export interface PredictedSim {
  /** Re-run local input from `fromTick` after the host corrects us. */
  replay(fromTick: NetTick, commands: readonly InputCommand[]): void;
  /** Overwrite locally predicted state with the authority's. */
  applyCorrection(snapshot: WorldSnapshot): void;
}

/* ------------------------------------------------------------------------- *
 * Host migration
 * ------------------------------------------------------------------------- */

export interface MigrationPlan {
  /** Ordered succession list. Index 0 takes over. */
  candidates: ClientId[];
  /** Tick at which the new host resumes simulating. */
  resumeTick: NetTick;
  /** Nonce every peer echoes so a stale host cannot re-assert authority. */
  epoch: number;
}

/* ------------------------------------------------------------------------- *
 * Diagnostics
 * ------------------------------------------------------------------------- */

export interface NetDiagnostics {
  role: NetRole;
  tick: NetTick;
  peers: PeerInfo[];
  stats: ConnectionStats;
  /** Bytes sent/received in the last second, by channel. */
  bytesByChannel: Record<NetChannel, { in: number; out: number }>;
  /** Predicted-vs-authoritative position error, metres, smoothed. */
  predictionErrorM: number;
  /** Snapshots dropped by the budget in the last second. */
  budgetDrops: number;
}
