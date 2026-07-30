/**
 * Ports — the seams between the authority and everything replaceable.
 *
 * These are *structural* interfaces on purpose. Another module (the transport
 * agent's WebRTC link, the replication agent's binary snapshot writer, the sim
 * agent's real movement code) satisfies a port simply by having the right shape;
 * nothing here needs to import their files, and nothing there needs to import
 * this one. That is what lets eight people build this concurrently, and it is
 * also what lets the host move off a peer onto a dedicated server later: the
 * dedicated server swaps the transport port and changes nothing else.
 */

import type {
  ClientId, EntityState, HostToClient, InputCommand, NetEvent, PeerId,
  RosterEntry, Snapshot, Tick, WorldState,
} from './types';

/** Reliability class for a send. Maps to ordered/reliable vs unordered/unreliable DataChannels. */
export type Channel = 'reliable' | 'unreliable';

/**
 * The only thing the host knows about the network.
 *
 * Implementations: `LoopbackTransport` (tests, single-process), a WebRTC
 * DataChannel pair (peer host), a WebSocket/UDP relay (dedicated server). The
 * authority never learns which.
 */
export interface Transport {
  /** This process's transport address. */
  readonly localId: PeerId;
  /** Currently connected peers, excluding self. */
  peers(): readonly PeerId[];
  send(to: PeerId, data: Uint8Array, channel: Channel): void;
  broadcast(data: Uint8Array, channel: Channel): void;
  /** Returns an unsubscribe function. */
  onMessage(cb: (from: PeerId, data: Uint8Array, channel: Channel) => void): () => void;
  onPeerJoin(cb: (peer: PeerId) => void): () => void;
  onPeerLeave(cb: (peer: PeerId, reason: string) => void): () => void;
  /** Bytes sent since open — used for the bandwidth budget report. */
  readonly bytesSent: number;
  readonly bytesReceived: number;
  close(): void;
}

/** Message <-> bytes. Swap in the protocol agent's binary codec without touching the host. */
export interface Codec {
  readonly name: string;
  encode(msg: unknown): Uint8Array;
  decode(data: Uint8Array): unknown;
}

/**
 * Snapshot construction: interest management, delta compression, bandwidth budget.
 * Kept behind a port so a smarter replication layer can replace it wholesale.
 */
export interface SnapshotWriter {
  /** Called once per accepted client. */
  addClient(clientId: ClientId): void;
  removeClient(clientId: ClientId): void;
  /** Client told us it applied this snapshot; future deltas may use it as a baseline. */
  acknowledge(clientId: ClientId, tick: Tick): void;
  /** Force the next snapshot for this client to be a keyframe (post-migration, post-join). */
  invalidate(clientId: ClientId): void;
  /**
   * Build one client's view of the world. Must be pure w.r.t. `state` — the host
   * calls this for every client against the same state object.
   */
  build(
    state: WorldState,
    clientId: ClientId,
    events: readonly NetEvent[],
    serverTimeMs: number,
    roster: readonly RosterEntry[] | undefined,
  ): Snapshot;
  /** Rolling per-client byte estimate, for diagnostics. */
  bytesFor(clientId: ClientId): number;
}

/**
 * The authority's own capabilities, handed to the stepper.
 *
 * Every irreversible decision — who spawns, who dies, who gets the kill credit —
 * goes through here rather than being written straight into the entity table.
 * That keeps one ledger, on the host, in one place, and it means a gameplay
 * module can be dropped in without also inheriting the authority's bookkeeping.
 */
export interface SimOps {
  readonly tick: Tick;
  /** Record an authoritative fact for replication (hit, kill, sound, pickup…). */
  emit(kind: string, a: number, b: number, x: number, y: number, z: number, n: number, s?: string): void;
  /** Apply damage. Returns true if this call killed the target. */
  damage(targetId: number, amount: number, byEntityId: number, headshot: boolean): boolean;
  spawn(kind: number, owner: ClientId): EntityState;
  despawn(id: number): void;
}

/**
 * The deterministic gameplay step.
 *
 * The authority owns *when* this runs, the entity table, spawn/despawn and the
 * damage ledger. The stepper owns *how* an entity moves and what a trigger pull
 * means. Splitting it this way is what lets the real gameplay code (movement
 * state machine, ballistics) be dropped in later without rewriting the host loop.
 *
 * Contract: given identical `state`, `commands` and `tick`, `step` must produce
 * identical output on every machine. No `Math.random`, no wall-clock, no floats
 * read from the DOM.
 */
export interface SimStepper {
  readonly name: string;
  /** Fixed step in seconds. The authority ticks at 1/dt. */
  readonly dt: number;
  /** Called when the authority creates a player entity, to place and equip it. */
  spawnPlayer?(state: WorldState, ent: EntityState, rand: RandomStream): void;
  /** Advance the world exactly one tick. */
  step(state: WorldState, commands: ReadonlyMap<ClientId, InputCommand>, rand: RandomStream, ops: SimOps): void;
}

/** Minimal deterministic RNG surface — `src/core/Rand.ts` satisfies it structurally. */
export interface RandomStream {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  signed(): number;
  bool(p?: number): boolean;
}

/**
 * Optional observer for host-side gameplay facts. `NetSystem` uses this to
 * re-emit authoritative events onto the local `bus`, so FX/audio/HUD light up on
 * the host exactly as they do on a client.
 */
export interface AuthorityObserver {
  onEvent?(ev: NetEvent): void;
  onPlayerJoin?(clientId: ClientId, stableId: string, name: string): void;
  onPlayerLeave?(clientId: ClientId, reason: string): void;
  onTick?(tick: Tick, state: WorldState): void;
  /** Fired when this authority sends anything, for bandwidth accounting/tests. */
  onSend?(to: PeerId, msg: HostToClient, bytes: number): void;
}
