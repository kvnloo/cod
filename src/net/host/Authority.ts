/**
 * The authority: the only place in the codebase where gameplay truth is decided.
 *
 * Shape of the loop, once per fixed tick:
 *
 *   drain input queues  →  resolve respawns  →  step the simulation
 *   →  apply damage/spawn/despawn decisions  →  publish a snapshot per client
 *
 * Three design choices are load-bearing:
 *
 *  * **Clients send commands, never state.** A client's message can only ever say
 *    "at tick T I held these buttons and looked this way". Positions, hits and
 *    deaths are computed here. A malicious client can lie about its intent, which
 *    is bounded, but never about the outcome.
 *
 *  * **Input is queue-drained, not tick-matched.** The host pops exactly one
 *    command per client per tick from a small jitter buffer. This tolerates clock
 *    drift and reordering, and — because the queue is capped — it stops a client
 *    from banking commands and then spending them all at once to move at 4×.
 *
 *  * **No transport, no DOM, no Three.js in here.** `AuthorityCore` is the same
 *    object whether it runs inside a browser peer or a headless Node process.
 *    Moving the host to a dedicated server is a transport swap, not a rewrite.
 */

import type {
  AuthorityObserver, RandomStream, SimOps, SimStepper, SnapshotWriter,
} from './ports';
import { DeltaSnapshotWriter } from './SnapshotWriter';
import { ArenaSim } from './DefaultSim';
import { TickRand, RNG_SALT } from './TickRand';
import { exportCheckpoint, importCheckpoint } from './Checkpoint';
import {
  BTN, ENT, ENTITY_FLAG, createWorldState, newEntity,
  type ClientId, type EntityState, type HostCheckpoint, type InputCommand,
  type NetEvent, type PeerId, type PlayerSlot, type RosterEntry, type Snapshot,
  type StableId, type Tick, type WorldState,
} from './types';

export interface AuthorityConfig {
  /** Simulation and snapshot rate in Hz. */
  tickRate: number;
  /** Match seed. Every RNG draw on every peer derives from this plus the tick. */
  seed: number;
  /** Max commands a client may have buffered. Above this the oldest are dropped. */
  maxInputBuffer: number;
  /** Ticks a dead player waits before respawning. */
  respawnTicks: number;
  /** Ticks a disconnected slot is kept before its entity is despawned. */
  slotGraceTicks: number;
  /** Ticks between full-state checkpoints broadcast to standby hosts. */
  checkpointIntervalTicks: number;
  /** Most ticks a single `advance()` may run, so a stalled tab cannot spiral. */
  maxCatchUpTicks: number;
  /** Friendly fire off when teams are non-zero. */
  friendlyFire: boolean;
}

export const DEFAULT_AUTHORITY_CONFIG: AuthorityConfig = {
  tickRate: 30,
  seed: 1337,
  maxInputBuffer: 12,
  respawnTicks: 90,
  slotGraceTicks: 300,
  checkpointIntervalTicks: 60,
  maxCatchUpTicks: 8,
  friendlyFire: false,
};

/**
 * What a host *is*, from the outside. `PeerHost` implements it over WebRTC; a
 * dedicated server implements it over sockets; both wrap the same
 * {@link AuthorityCore}. Anything that talks to "the server" codes against this.
 */
export interface Authority {
  readonly kind: 'peer-host' | 'dedicated' | 'offline';
  readonly hostStableId: StableId;
  readonly tickRate: number;
  readonly tick: Tick;
  readonly epoch: number;
  readonly running: boolean;
  /** The host's own player slot in peer-host mode; 0 for a dedicated server. */
  readonly localClientId: ClientId;
  readonly state: Readonly<WorldState>;
  start(): void;
  stop(): void;
  /** Advance by wall-clock seconds. Returns the number of ticks simulated. */
  advance(dtSeconds: number): number;
  /** Queue the host's own player input (peer-host only). */
  submitLocalInput(cmd: InputCommand): void;
  roster(): RosterEntry[];
  exportCheckpoint(): HostCheckpoint;
  dispose(): void;
}

/** Connection-side facts the authority needs for the roster and for migration. */
interface ConnInfo {
  peerId: PeerId;
  rttMs: number;
  checkpointTick: Tick;
  hostCapable: boolean;
}

interface InputQueue {
  cmds: InputCommand[];
  lastAcceptedTick: Tick;
  last: InputCommand;
  starved: number;
  received: number;
  dropped: number;
}

export interface AuthorityStats {
  tick: Tick;
  ticksSimulated: number;
  inputsReceived: number;
  inputsDropped: number;
  inputStarvation: number;
  snapshotsBuilt: number;
  eventsEmitted: number;
}

/**
 * Transport-free host loop. Owns the world; owns every decision about it.
 */
export class AuthorityCore implements SimOps {
  readonly config: AuthorityConfig;
  readonly sim: SimStepper;
  readonly writer: SnapshotWriter;

  state: WorldState;
  private queues = new Map<ClientId, InputQueue>();
  private conns = new Map<ClientId, ConnInfo>();
  private byStable = new Map<StableId, ClientId>();
  private pending: NetEvent[] = [];
  private rand: TickRand;
  private accumulator = 0;
  private observers: AuthorityObserver[] = [];

  readonly stats: AuthorityStats = {
    tick: 0, ticksSimulated: 0, inputsReceived: 0, inputsDropped: 0,
    inputStarvation: 0, snapshotsBuilt: 0, eventsEmitted: 0,
  };

  constructor(config: Partial<AuthorityConfig> = {}, sim?: SimStepper, writer?: SnapshotWriter) {
    this.config = { ...DEFAULT_AUTHORITY_CONFIG, ...config };
    this.sim = sim ?? new ArenaSim(this.config.tickRate);
    this.writer = writer ?? new DeltaSnapshotWriter();
    this.state = createWorldState(this.config.seed);
    this.rand = new TickRand(this.config.seed);
  }

  /* -------------------------------------------------- lifecycle ---- */

  get tick(): Tick { return this.state.tick; }
  get epoch(): number { return this.state.epoch; }
  get dt(): number { return 1 / this.config.tickRate; }
  get serverTimeMs(): number { return this.state.tick * this.dt * 1000; }

  observe(o: AuthorityObserver): () => void {
    this.observers.push(o);
    return () => {
      const i = this.observers.indexOf(o);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /**
   * Adopt authoritative state produced by a previous host and open a new term.
   * Every client's delta baseline is thrown away — the new host has no idea what
   * the old one had actually delivered, so the first snapshot of a term is always
   * a keyframe.
   */
  resumeFrom(cp: HostCheckpoint, newEpoch: number): void {
    this.state = importCheckpoint(cp);
    this.state.epoch = newEpoch;
    this.rand.setSeed(this.state.seed);
    this.accumulator = 0;
    this.queues.clear();
    this.conns.clear();
    this.byStable.clear();
    this.pending.length = 0;
    for (const slot of this.state.players.values()) {
      this.byStable.set(slot.stableId, slot.clientId);
      // Nobody is connected until they re-handshake with us.
      slot.connected = false;
      this.writer.removeClient(slot.clientId);
    }
    for (const r of cp.roster) {
      const slot = this.state.players.get(r.clientId);
      if (!slot) continue;
      this.conns.set(r.clientId, {
        peerId: r.peerId, rttMs: r.rttMs, checkpointTick: r.checkpointTick,
        hostCapable: r.hostCapable,
      });
    }
  }

  /* ----------------------------------------------------- clients ---- */

  /**
   * Admit a client. If `stableId` is already known the existing slot — entity,
   * score, team — is reused. That single rule is what makes both reconnection and
   * host migration non-events for the player.
   */
  admit(stableId: StableId, name: string, peerId: PeerId, hostCapable = true): ClientId {
    let clientId = this.byStable.get(stableId);
    if (clientId !== undefined && this.state.players.has(clientId)) {
      const slot = this.state.players.get(clientId)!;
      slot.connected = true;
      slot.name = name;
      slot.lastSeenTick = this.state.tick;
      if (!this.state.entities.has(slot.entityId)) slot.entityId = this.createPlayerEntity(clientId, slot.team).id;
      this.conns.set(clientId, { peerId, rttMs: 0, checkpointTick: -1, hostCapable });
      this.ensureQueue(clientId);
      this.writer.addClient(clientId);
      this.writer.invalidate(clientId);
      for (const o of this.observers) o.onPlayerJoin?.(clientId, stableId, name);
      return clientId;
    }

    clientId = this.state.nextClientId++;
    const team = this.pickTeam();
    const ent = this.createPlayerEntity(clientId, team);
    const slot: PlayerSlot = {
      clientId, stableId, name, team, entityId: ent.id,
      score: 0, kills: 0, deaths: 0,
      lastAckedInputTick: -1, connected: true, lastSeenTick: this.state.tick,
    };
    this.state.players.set(clientId, slot);
    this.byStable.set(stableId, clientId);
    this.conns.set(clientId, { peerId, rttMs: 0, checkpointTick: -1, hostCapable });
    this.ensureQueue(clientId);
    this.writer.addClient(clientId);
    this.emit('join', ent.id, clientId, ent.px, ent.py, ent.pz, team, name);
    for (const o of this.observers) o.onPlayerJoin?.(clientId, stableId, name);
    return clientId;
  }

  /** Mark a client disconnected. The slot survives `slotGraceTicks` so a blip does not cost a match. */
  drop(clientId: ClientId, reason = 'left'): void {
    const slot = this.state.players.get(clientId);
    if (!slot) return;
    slot.connected = false;
    slot.lastSeenTick = this.state.tick;
    this.conns.delete(clientId);
    this.queues.delete(clientId);
    this.writer.removeClient(clientId);
    this.emit('leave', slot.entityId, clientId, 0, 0, 0, 0, reason);
    for (const o of this.observers) o.onPlayerLeave?.(clientId, reason);
  }

  clientIdForStable(stableId: StableId): ClientId | undefined {
    return this.byStable.get(stableId);
  }

  slot(clientId: ClientId): PlayerSlot | undefined { return this.state.players.get(clientId); }

  setConnInfo(clientId: ClientId, patch: Partial<ConnInfo>): void {
    const c = this.conns.get(clientId);
    if (!c) return;
    if (patch.rttMs !== undefined) c.rttMs = patch.rttMs;
    if (patch.checkpointTick !== undefined) c.checkpointTick = Math.max(c.checkpointTick, patch.checkpointTick);
    if (patch.hostCapable !== undefined) c.hostCapable = patch.hostCapable;
    if (patch.peerId !== undefined) c.peerId = patch.peerId;
  }

  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const slot of [...this.state.players.values()].sort((a, b) => a.clientId - b.clientId)) {
      const c = this.conns.get(slot.clientId);
      out.push({
        clientId: slot.clientId,
        stableId: slot.stableId,
        peerId: c?.peerId ?? '',
        name: slot.name,
        team: slot.team,
        connected: slot.connected,
        rttMs: c?.rttMs ?? 0,
        checkpointTick: c?.checkpointTick ?? -1,
        hostCapable: c?.hostCapable ?? false,
      });
    }
    return out;
  }

  /* ------------------------------------------------------- input ---- */

  /**
   * Accept a batch of commands. Batches are redundant by design (a client resends
   * its last few commands every packet), so duplicates are expected and cheap to
   * reject; that is the loss-recovery mechanism, not a bug.
   */
  submitInput(clientId: ClientId, cmds: readonly InputCommand[]): void {
    const q = this.queues.get(clientId);
    if (!q) return;
    for (const cmd of cmds) {
      if (!isSaneCommand(cmd)) { q.dropped++; continue; }
      if (cmd.tick <= q.lastAcceptedTick) continue; // duplicate resend — normal
      q.lastAcceptedTick = cmd.tick;
      q.cmds.push(sanitise(cmd));
      q.received++;
      this.stats.inputsReceived++;
    }
    q.cmds.sort((a, b) => a.tick - b.tick);
    // Cap the buffer: a client that hoards commands and releases them in a burst
    // would otherwise get several ticks of movement in one host tick.
    while (q.cmds.length > this.config.maxInputBuffer) {
      q.cmds.shift();
      q.dropped++;
      this.stats.inputsDropped++;
    }
  }

  /* ------------------------------------------------------- loop ----- */

  /** Advance the simulation by wall-clock seconds. Returns ticks simulated. */
  advance(dtSeconds: number): number {
    const step = this.dt;
    this.accumulator += Math.max(0, Math.min(dtSeconds, 1));
    let ran = 0;
    while (this.accumulator >= step && ran < this.config.maxCatchUpTicks) {
      this.accumulator -= step;
      this.stepOnce();
      ran++;
    }
    if (ran >= this.config.maxCatchUpTicks) this.accumulator = 0;
    return ran;
  }

  /** Run exactly one authoritative tick. Deterministic given (state, inputs). */
  stepOnce(): void {
    const state = this.state;
    const tick = state.tick;

    // 1. drain one command per client
    const commands = new Map<ClientId, InputCommand>();
    for (const [clientId, q] of this.queues) {
      const next = q.cmds.shift();
      if (next) {
        q.last = next;
        commands.set(clientId, next);
        const slot = state.players.get(clientId);
        if (slot) { slot.lastAckedInputTick = next.tick; slot.lastSeenTick = tick; }
      } else {
        // Starved: repeat the last look direction and movement but drop the
        // edge-triggered buttons, so a dropped packet cannot hold the trigger.
        q.starved++;
        this.stats.inputStarvation++;
        const held: InputCommand = {
          ...q.last, tick: q.last.tick,
          buttons: q.last.buttons & ~(BTN.FIRE | BTN.JUMP | BTN.RELOAD | BTN.USE | BTN.MELEE),
        };
        commands.set(clientId, held);
      }
    }

    // 2. respawns — the authority's call, never the client's
    //
    // The stream is derived per *entity*, not shared across the loop. Sharing one
    // stream made the spawn point depend on `state.players` iteration order, so
    // two players respawning on the same tick swapped spawn points on a host that
    // had imported its state from a checkpoint (sorted) versus one that had built
    // it by admission (insertion order). Proved in tools/net-sim.mjs §1d.
    for (const slot of this.state.players.values()) {
      const e = state.entities.get(slot.entityId);
      if (!e) continue;
      if ((e.flags & ENTITY_FLAG.DEAD) !== 0 && e.respawnTick > 0 && tick >= e.respawnTick) {
        this.sim.spawnPlayer?.(state, e, this.rand.at(tick, `${RNG_SALT.SPAWN}:${e.id}`));
        e.flags &= ~ENTITY_FLAG.DEAD;
        e.respawnTick = 0;
        this.emit('respawn', e.id, slot.clientId, e.px, e.py, e.pz, 0);
      }
    }

    // 3. gameplay
    this.sim.step(state, commands, this.rand.at(tick, RNG_SALT.SIM), this);

    // 4. reap slots whose owner has been gone too long
    for (const slot of [...this.state.players.values()]) {
      if (slot.connected) continue;
      if (tick - slot.lastSeenTick < this.config.slotGraceTicks) continue;
      this.state.entities.delete(slot.entityId);
      this.state.players.delete(slot.clientId);
      this.byStable.delete(slot.stableId);
      this.emit('reap', slot.entityId, slot.clientId, 0, 0, 0, 0);
    }

    state.tick = tick + 1;
    this.stats.tick = state.tick;
    this.stats.ticksSimulated++;
    for (const o of this.observers) o.onTick?.(state.tick, state);
  }

  /* --------------------------------------------------- SimOps ------ */

  emit(kind: string, a: number, b: number, x: number, y: number, z: number, n: number, s?: string): void {
    const ev: NetEvent = { tick: this.state.tick, kind, a, b, x, y, z, n, s };
    this.pending.push(ev);
    this.stats.eventsEmitted++;
    for (const o of this.observers) o.onEvent?.(ev);
  }

  damage(targetId: number, amount: number, byEntityId: number, headshot: boolean): boolean {
    const t = this.state.entities.get(targetId);
    if (!t || amount <= 0) return false;
    if ((t.flags & (ENTITY_FLAG.DEAD | ENTITY_FLAG.INVULN)) !== 0) return false;

    const src = this.state.entities.get(byEntityId);
    if (!this.config.friendlyFire && src && src.id !== t.id && src.team !== 0 && src.team === t.team) return false;

    // Health and armour replicate as integers (FIELD_SCALE 1), so the authority
    // keeps them integral. Otherwise the host holds 88.6 and every client
    // reconstructs 89 — a permanent, silent disagreement about who is alive.
    // Any connecting hit does at least one point.
    let remaining = Math.max(1, Math.round(amount));
    if (t.armor > 0) {
      const absorbed = Math.min(t.armor, Math.floor(remaining * 0.5));
      t.armor -= absorbed;
      remaining -= absorbed;
    }
    t.health -= remaining;
    this.emit('hit', byEntityId, t.id, t.px, t.py, t.pz, remaining, headshot ? 'head' : undefined);

    if (t.health > 0) return false;

    t.health = 0;
    t.flags |= ENTITY_FLAG.DEAD;
    t.respawnTick = this.state.tick + this.config.respawnTicks;
    t.vx = t.vy = t.vz = 0;

    const victim = this.slotForEntity(t.id);
    const killer = src ? this.slotForEntity(src.id) : undefined;
    if (victim) victim.deaths++;
    if (killer && killer !== victim) { killer.kills++; killer.score += headshot ? 150 : 100; }
    else if (killer === victim && victim) victim.score -= 50;
    this.emit('kill', src?.id ?? 0, t.id, t.px, t.py, t.pz, headshot ? 1 : 0,
      `${killer?.name ?? 'world'}>${victim?.name ?? '?'}`);
    return true;
  }

  spawn(kind: number, owner: ClientId): EntityState {
    const e = newEntity(this.state.nextEntityId++, kind, owner);
    this.state.entities.set(e.id, e);
    return e;
  }

  despawn(id: number): void { this.state.entities.delete(id); }

  /* ------------------------------------------------ replication ---- */

  /** Build (and consume nothing) one client's snapshot for the current tick. */
  snapshotFor(clientId: ClientId, includeRoster: boolean): Snapshot {
    this.stats.snapshotsBuilt++;
    return this.writer.build(
      this.state, clientId, this.pending, this.serverTimeMs,
      includeRoster ? this.roster() : undefined,
    );
  }

  /** Call once after every client's snapshot for this tick has been built. */
  flushEvents(): void { this.pending.length = 0; }

  pendingEvents(): readonly NetEvent[] { return this.pending; }

  acknowledge(clientId: ClientId, snapshotTick: Tick): void {
    this.writer.acknowledge(clientId, snapshotTick);
  }

  exportCheckpoint(): HostCheckpoint {
    return exportCheckpoint(this.state, this.roster());
  }

  /* ---------------------------------------------------- helpers ---- */

  private ensureQueue(clientId: ClientId): void {
    if (this.queues.has(clientId)) return;
    this.queues.set(clientId, {
      cmds: [], lastAcceptedTick: -1,
      last: { tick: -1, seq: -1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 },
      starved: 0, received: 0, dropped: 0,
    });
  }

  private createPlayerEntity(owner: ClientId, team: number): EntityState {
    const e = this.spawn(ENT.PLAYER, owner);
    e.team = team;
    // Salt with the entity id. `at()` re-seeds, so salting with the tick alone
    // gave every player admitted on the same tick the *identical* spawn point —
    // the whole lobby stacked on one spot at match start. Proved in
    // tools/net-sim.mjs §1e.
    this.sim.spawnPlayer?.(
      this.state, e,
      this.rand.at(this.state.tick, `${RNG_SALT.SPAWN}:${e.id}`) as RandomStream,
    );
    return e;
  }

  private slotForEntity(entityId: number): PlayerSlot | undefined {
    for (const slot of this.state.players.values()) if (slot.entityId === entityId) return slot;
    return undefined;
  }

  /** Balance teams deterministically. Team 0 means free-for-all. */
  private pickTeam(): number {
    let a = 0, b = 0;
    for (const s of this.state.players.values()) {
      if (s.team === 1) a++; else if (s.team === 2) b++;
    }
    return a <= b ? 1 : 2;
  }

  inputHealth(clientId: ClientId): { queued: number; starved: number; dropped: number; received: number } {
    const q = this.queues.get(clientId);
    return q
      ? { queued: q.cmds.length, starved: q.starved, dropped: q.dropped, received: q.received }
      : { queued: 0, starved: 0, dropped: 0, received: 0 };
  }
}

/** Reject nonsense before it reaches the simulation. */
function isSaneCommand(c: InputCommand): boolean {
  return !!c
    && Number.isFinite(c.tick) && c.tick >= 0
    && Number.isFinite(c.moveX) && Number.isFinite(c.moveZ)
    && Number.isFinite(c.yaw) && Number.isFinite(c.pitch)
    && Number.isInteger(c.buttons);
}

function sanitise(c: InputCommand): InputCommand {
  const clamp = (v: number, l: number, h: number) => (v < l ? l : v > h ? h : v);
  return {
    tick: c.tick | 0,
    seq: c.seq | 0,
    moveX: clamp(c.moveX, -1, 1),
    moveZ: clamp(c.moveZ, -1, 1),
    yaw: wrapAngle(c.yaw),
    pitch: clamp(c.pitch, -1.55, 1.55),
    buttons: c.buttons & 0xffff,
  };
}

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let v = a % twoPi;
  if (v > Math.PI) v -= twoPi;
  if (v < -Math.PI) v += twoPi;
  return v;
}
