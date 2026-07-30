/**
 * Authoritative-simulation value types.
 *
 * Everything in `src/net/host/` is deliberately free of Three.js, Rapier and DOM
 * references. The host loop is plain data + math so the *exact same code* can run
 * in a browser peer, in a headless Node process, or on a dedicated server. If you
 * are tempted to `import * as THREE` in this directory, don't — put it in
 * `src/net/NetSystem.ts` instead, which is the browser-side glue.
 */

/** Transport-level address of a peer (WebRTC connection id, socket id, …). */
export type PeerId = string;

/**
 * Persistent player identity. Survives host migration and reconnects; this is the
 * key an entity is re-bound to when the match changes host. Must be stable for the
 * lifetime of a match and comparable with `<` (election is lexicographic).
 */
export type StableId = string;

/** Compact per-match slot, 1..N. Assigned once by the first host, then part of world state. */
export type ClientId = number;

export type Tick = number;

/** Button bitfield in {@link InputCommand}. */
export const BTN = {
  FIRE: 1 << 0,
  ADS: 1 << 1,
  JUMP: 1 << 2,
  CROUCH: 1 << 3,
  SPRINT: 1 << 4,
  RELOAD: 1 << 5,
  USE: 1 << 6,
  MELEE: 1 << 7,
} as const;

/**
 * One client's intent for exactly one simulation tick.
 *
 * Clients send *these*, never positions. A command is idempotent w.r.t. its tick:
 * the host applies the command whose `tick` matches, and re-sends of the same tick
 * are dropped. That is what makes redundant resend (loss recovery) safe.
 */
export interface InputCommand {
  /** Simulation tick this command is for, in host tick-space. */
  tick: Tick;
  /** Monotonic per-client sequence, used for duplicate rejection and loss stats. */
  seq: number;
  /** Local-space move axes, [-1..1]. */
  moveX: number;
  moveZ: number;
  /** Absolute view angles in radians. The host trusts view angles, not position. */
  yaw: number;
  pitch: number;
  /** {@link BTN} bitfield. */
  buttons: number;
}

export function emptyCommand(tick: Tick, seq = 0): InputCommand {
  return { tick, seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
}

/** Entity kinds the authority can own. Numeric so snapshots stay compact. */
export const ENT = {
  PLAYER: 0,
  PROJECTILE: 1,
  PICKUP: 2,
  OBJECTIVE: 3,
} as const;

export type EntityKind = (typeof ENT)[keyof typeof ENT];

/**
 * The authoritative per-entity record. Flat and fixed-shape on purpose: delta
 * compression works off a field index table, and checkpoints serialise by field
 * order rather than by key.
 */
export interface EntityState {
  id: number;
  kind: number;
  /** Owning client slot, or 0 for world-owned entities. */
  owner: ClientId;
  team: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  health: number;
  armor: number;
  /** Weapon/definition index — meaning is the game layer's business. */
  weapon: number;
  ammo: number;
  /** Free bitfield: crouched, sprinting, dead, invulnerable … */
  flags: number;
  /** Tick at which a dead player respawns; 0 when not pending. */
  respawnTick: number;
  /** Earliest tick this entity may fire again. Replicated so clients can predict it. */
  nextFireTick: number;
}

/** Field order used by delta compression and checkpoint serialisation. */
export const ENTITY_FIELDS = [
  'kind', 'owner', 'team',
  'px', 'py', 'pz',
  'vx', 'vy', 'vz',
  'yaw', 'pitch',
  'health', 'armor',
  'weapon', 'ammo', 'flags', 'respawnTick', 'nextFireTick',
] as const;

export type EntityField = (typeof ENTITY_FIELDS)[number];

export const ENTITY_FLAG = {
  DEAD: 1 << 0,
  CROUCH: 1 << 1,
  SPRINT: 1 << 2,
  AIRBORNE: 1 << 3,
  FIRING: 1 << 4,
  INVULN: 1 << 5,
} as const;

export function newEntity(id: number, kind: number, owner: ClientId = 0): EntityState {
  return {
    id, kind, owner, team: 0,
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    health: 100, armor: 0,
    weapon: 0, ammo: 30, flags: 0, respawnTick: 0, nextFireTick: 0,
  };
}

/** A client as the *authority* knows it. This is world state, not connection state. */
export interface PlayerSlot {
  clientId: ClientId;
  stableId: StableId;
  name: string;
  team: number;
  entityId: number;
  score: number;
  kills: number;
  deaths: number;
  /** Last input tick the host has consumed for this client (for client reconciliation). */
  lastAckedInputTick: Tick;
  /** True while a transport connection exists. Slots persist through brief drops. */
  connected: boolean;
  /** Tick this slot was last seen alive; used to reap ghosts. */
  lastSeenTick: Tick;
}

/**
 * The complete authoritative state of the match.
 *
 * Anything not in here does not survive host migration — that is the rule that
 * keeps migration honest. If a game system stashes truth in a private field, it
 * will be lost the moment the host's laptop closes.
 */
export interface WorldState {
  tick: Tick;
  /** Match seed. Combined with `tick` it fully determines every RNG draw. */
  seed: number;
  /** Host term. Increments on every migration; clients reject stale epochs. */
  epoch: number;
  nextEntityId: number;
  nextClientId: ClientId;
  entities: Map<number, EntityState>;
  players: Map<ClientId, PlayerSlot>;
  /** Game-mode scratch owned by the game layer; must be JSON-clonable. */
  mode: Record<string, number | string | boolean>;
}

export function createWorldState(seed: number): WorldState {
  return {
    tick: 0, seed, epoch: 1,
    nextEntityId: 1, nextClientId: 1,
    entities: new Map(), players: new Map(), mode: {},
  };
}

/**
 * Authoritative gameplay events produced by a tick. These are *facts*, replicated
 * reliably so clients can play FX/audio/HUD for things they could not predict.
 */
export interface NetEvent {
  tick: Tick;
  kind: string;
  /** Entity the event is about (shooter, victim, …). */
  a: number;
  b: number;
  x: number; y: number; z: number;
  n: number;
  s?: string;
}

/** Per-entity delta: only the fields that changed since the client's baseline. */
export interface EntityDelta {
  id: number;
  /** Bitmask over {@link ENTITY_FIELDS}. 0 means "still here, unchanged". */
  mask: number;
  values: number[];
}

/** What the host sends a client each snapshot tick. */
export interface Snapshot {
  epoch: number;
  tick: Tick;
  /** Tick this delta is relative to, or -1 for a keyframe (full state). */
  baseTick: Tick;
  /** Last input tick from this client the host has consumed. */
  ackInputTick: Tick;
  /** Host tick-space time the input was consumed, for RTT-free clock sync. */
  serverTimeMs: number;
  updates: EntityDelta[];
  removed: number[];
  events: NetEvent[];
  /** Sent on keyframes and whenever the roster changes; drives migration. */
  roster?: RosterEntry[];
}

/** Public view of a peer, used for host election and the scoreboard. */
export interface RosterEntry {
  clientId: ClientId;
  stableId: StableId;
  peerId: PeerId;
  name: string;
  team: number;
  connected: boolean;
  /** Round-trip time in ms as measured by the host. */
  rttMs: number;
  /** Highest checkpoint tick this peer has acknowledged holding. */
  checkpointTick: Tick;
  /** True if this peer is capable of hosting (has full state + is not a spectator). */
  hostCapable: boolean;
}

/**
 * A complete, serialisable copy of authoritative state.
 *
 * Continuously mirrored to every host-capable peer *before* it is needed. You
 * cannot pull state out of a host that has already vanished, so the only workable
 * design is a warm standby: every candidate already holds a recent checkpoint.
 */
export interface HostCheckpoint {
  epoch: number;
  tick: Tick;
  seed: number;
  nextEntityId: number;
  nextClientId: ClientId;
  entities: EntityState[];
  players: PlayerSlot[];
  mode: Record<string, number | string | boolean>;
  roster: RosterEntry[];
  /** FNV-1a over the serialised body; guards against a corrupt standby. */
  checksum: number;
}

/* ------------------------------------------------------------------ */
/* Wire messages                                                       */
/* ------------------------------------------------------------------ */

export const PROTOCOL_VERSION = 1;

export type ClientToHost =
  | { t: 'join'; v: number; stableId: StableId; name: string; epoch: number; resumeClientId?: ClientId }
  | { t: 'input'; clientId: ClientId; cmds: InputCommand[]; ackTick: Tick; ackCheckpoint: Tick }
  | { t: 'ping'; id: number; clientMs: number }
  | { t: 'bye'; clientId: ClientId };

export type HostToClient =
  | {
      t: 'welcome'; v: number; epoch: number; hostStableId: StableId; clientId: ClientId;
      tickRate: number; tick: Tick; seed: number; snapshot: Snapshot;
    }
  | { t: 'reject'; reason: string }
  | { t: 'snapshot'; s: Snapshot }
  | { t: 'checkpoint'; cp: HostCheckpoint }
  | { t: 'pong'; id: number; clientMs: number; hostMs: number; tick: Tick }
  | { t: 'heartbeat'; epoch: number; tick: Tick; hostStableId: StableId }
  /** New host claiming a term. Clients re-handshake against this. */
  | { t: 'hostAnnounce'; epoch: number; hostStableId: StableId; tick: Tick }
  /** Graceful handoff: the outgoing host names its successor and flushes state. */
  | { t: 'hostHandoff'; epoch: number; successor: StableId; cp: HostCheckpoint };

export type NetMessage = ClientToHost | HostToClient;

/** Cheap, stable hash used for checkpoint checksums. Not cryptographic. */
export function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
