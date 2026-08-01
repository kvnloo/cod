/**
 * Capability resolution.
 *
 * Turns an `EngineContext` into the narrow bridges the match logic consumes.
 * Every bridge is optional and duck-typed: a missing or stub system yields
 * `null` and the match falls back to something it owns. `GameServices` is also
 * the seam the deterministic self-test injects mocks through, which is why no
 * file below `Match.ts` ever touches `engine`, `bus` or `THREE.Scene` directly.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { bus } from '../core/EventBus';
import type { EventKey, GameEvents } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { HitZone, PhysicsAPI, RayHit } from '../physics/types';
import type { RenderAPI } from '../render/types';
import { Rand } from '../core/Rand';
import { ARCHETYPES } from './Archetypes';
import type {
  ActorAPI, Archetype, DamageOpts, PlayerBridge, SpawnRequest, WorldBridge,
} from './types';
import './events';

export type Emitter = <K extends EventKey>(key: K, payload: GameEvents[K]) => void;

/** Everything the match needs from the outside. All of it is optional. */
export interface GameServices {
  /** Scene root the director may parent gameplay props to; null in headless tests. */
  scene: THREE.Object3D | null;
  /** Live camera, used for out-of-view spawn tests and strike marking. */
  camera: THREE.PerspectiveCamera | null;
  player: PlayerBridge | null;
  actors: ActorAPI | null;
  world: WorldBridge | null;
  physics: PhysicsAPI | null;
  render: RenderAPI | null;
  emit: Emitter;
  rng: Rand;
  /** Wall-clock-independent match clock owner; the director advances it. */
  setTimeScale: (scale: number) => void;
  getTimeScale: () => number;
  /**
   * The meta layer around the match — session flow, lobby, loadout,
   * matchmaking. Optional on purpose: a match that ignores it behaves exactly
   * as it did before the session layer existed.
   */
  meta?: MetaServices;
}

/* ------------------------------------------------------------ meta layer -- */

/*
 * `src/session/` sits *around* the match, not under it, so nothing here imports
 * it: every bridge below is structural and resolved at runtime. That keeps the
 * dependency arrow pointing one way (session → game) and means the match layer
 * still compiles, runs and self-tests with the whole session layer deleted.
 *
 * Accessors are functions, not fields, because these read live state — a
 * snapshot taken at resolve time would be a lie one frame later.
 */

/** `src/session/SessionSystem.ts` as the match layer sees it: read + request. */
export interface SessionBridge {
  /** Current `FlowState` id, e.g. `'lobby' | 'live' | 'afterAction'`. */
  state(): string;
  isHost(): boolean;
  online(): boolean;
  /**
   * Ask the session to advance. On the host this applies; on a client it is
   * forwarded upstream. Never assume it took effect — read `state()` after.
   */
  request(event: string, reason?: string): void;
}

/** `src/session/lobby/LobbySystem.ts`: who is here and what they voted for. */
export interface LobbyBridge {
  /** `'forming' | 'ready' | 'loading' | 'in-match' | 'post-match'`. */
  phase(): string;
  members(): ReadonlyArray<{ id: string; name: string; team: string; bot: boolean }>;
  /** The launch order the lobby last published, or null. */
  launch(): { modeId: string; mapId: string; seed: number } | null;
}

/**
 * The loadout module has two faces and a build may install either or both:
 * `LoadoutBook` is the client's saved classes (`current()`), `LoadoutService` is
 * the host's grant authority (`activeFor` / `notifySpawn`). Halves that are not
 * installed answer emptily rather than being absent, so callers never branch.
 */
export interface LoadoutBridge {
  /** Name of the local player's selected class, `''` with no book. */
  activeName(): string;
  /** The grant a player spawns with, null with no host authority. */
  activeFor(playerId: number): object | null;
  notifySpawn(playerId: number): object | null;
}

/** `src/session/matchmaking/Service.ts`: are we still looking, and for whom. */
export interface MatchmakingBridge {
  /** `'idle' | 'searching' | 'found' | 'joining' | 'in-match'`. */
  state(): string;
  waited(): number;
  roster(): object | null;
}

/**
 * Everything the meta layer offers the match, all of it optional.
 *
 * `spawns` and `replay` are deliberately opaque: `src/game/Spawns.ts` and
 * `src/game/Replay.ts` remain the game-facing owners of those concerns, and
 * `src/session/spawn` / `src/session/replay` are the deeper libraries they may
 * defer to. The registry exists so they can *find* each other, not so the match
 * can drive them.
 */
export interface MetaServices {
  session: SessionBridge | null;
  lobby: LobbyBridge | null;
  loadout: LoadoutBridge | null;
  matchmaking: MatchmakingBridge | null;
  spawns: object | null;
  replay: object | null;
}

export const NO_META: MetaServices = {
  session: null, lobby: null, loadout: null, matchmaking: null, spawns: null, replay: null,
};

interface MaybeSession {
  flow?: { state?: unknown };
  isHost?: unknown;
  online?: unknown;
  request?: unknown;
}

export function asSessionBridge(sys: unknown): SessionBridge | null {
  const s = sys as MaybeSession | undefined;
  if (!s || !s.flow || typeof s.flow.state !== 'string' || !isFn(s.request)) return null;
  const live = sys as { flow: { state: string }; isHost: boolean; online: boolean;
    request: (e: string, r?: string) => void; };
  return {
    state: () => live.flow.state,
    isHost: () => live.isHost !== false,
    online: () => live.online === true,
    request: (event, reason) => { live.request(event, reason); },
  };
}

interface MaybeLobby {
  session?: { state?: unknown };
  lastLaunch?: unknown;
}

export function asLobbyBridge(sys: unknown): LobbyBridge | null {
  const l = sys as MaybeLobby | undefined;
  if (!l || !l.session || !('state' in l.session)) return null;
  const live = sys as {
    session: {
      state: {
        phase: string;
        members: Array<{ id: string; team: string; profile?: { name?: string; bot?: boolean } }>;
      } | null;
    };
    lastLaunch: { modeId: string; mapId: string; seed: number } | null;
  };
  return {
    phase: () => live.session.state?.phase ?? 'forming',
    members: () => (live.session.state?.members ?? []).map((m) => ({
      id: m.id,
      name: m.profile?.name ?? m.id,
      team: m.team,
      bot: m.profile?.bot === true,
    })),
    launch: () => {
      const cfg = live.lastLaunch;
      if (!cfg || typeof cfg.modeId !== 'string' || typeof cfg.seed !== 'number') return null;
      return { modeId: cfg.modeId, mapId: cfg.mapId, seed: cfg.seed };
    },
  };
}

export function asLoadoutBridge(sys: unknown): LoadoutBridge | null {
  const l = sys as { activeFor?: unknown; notifySpawn?: unknown; current?: unknown } | undefined;
  if (!l) return null;
  const hasService = isFn(l.activeFor) && isFn(l.notifySpawn);
  const hasBook = isFn(l.current);
  if (!hasService && !hasBook) return null;
  const live = sys as {
    activeFor?: (id: number) => object | null;
    notifySpawn?: (id: number) => object | null;
    current?: () => { name?: string };
  };
  return {
    activeName: () => {
      if (!hasBook) return '';
      try { return live.current!()?.name ?? ''; } catch { return ''; }
    },
    activeFor: (id) => (hasService ? live.activeFor!(id) ?? null : null),
    // A grant can legitimately fail (nothing pending, invalid class); the match
    // must keep spawning people either way.
    notifySpawn: (id) => {
      if (!hasService) return null;
      try { return live.notifySpawn!(id) ?? null; } catch { return null; }
    },
  };
}

export function asMatchmakingBridge(sys: unknown): MatchmakingBridge | null {
  const m = sys as { snapshot?: unknown } | undefined;
  if (!m || !isFn(m.snapshot)) return null;
  const live = sys as { snapshot: () => { state?: string; waited?: number; roster?: object | null } };
  return {
    state: () => live.snapshot().state ?? 'idle',
    waited: () => live.snapshot().waited ?? 0,
    roster: () => live.snapshot().roster ?? null,
  };
}

/**
 * Resolves whatever of the meta layer this build actually registered. Every
 * lookup is optional, so a capture run — which registers none of it — gets
 * `NO_META` and the single-player match runs exactly as it always has.
 */
export function resolveMetaServices(ctx: EngineContext): MetaServices {
  const e = ctx.engine;
  const session = e.tryGet('session');
  /*
   * Most of the meta layer is not made of `System`s — a `MatchmakingService` or
   * a `LoadoutBook` has no frame to consume — so it never appears in the engine
   * registry. `SessionSystem.subsystems` is where installation records them,
   * and it is the fallback for every lookup below.
   */
  const subs = (session as unknown as { subsystems?: Record<string, unknown> } | undefined)
    ?.subsystems ?? {};
  return {
    session: asSessionBridge(session),
    lobby: asLobbyBridge(e.tryGet('lobby') ?? subs.lobby),
    loadout: asLoadoutBridge(e.tryGet('loadout') ?? subs.loadout),
    matchmaking: asMatchmakingBridge(e.tryGet('matchmaking') ?? subs.matchmaking),
    spawns: (e.tryGet('spawns') as object | undefined) ?? (subs.spawns as object) ?? null,
    replay: (e.tryGet('replay') as object | undefined) ?? (subs.replay as object) ?? null,
  };
}

interface MaybePlayer {
  position?: unknown; health?: unknown; maxHealth?: unknown; alive?: unknown;
  entityId?: unknown; spawnAt?: unknown; revive?: unknown; heal?: unknown; applyDamage?: unknown;
}

function isFn(v: unknown): v is (...args: never[]) => unknown { return typeof v === 'function'; }

/** A player system qualifies when it can report a position and be respawned. */
export function asPlayerBridge(sys: System | undefined): PlayerBridge | null {
  if (!sys) return null;
  const p = sys as unknown as MaybePlayer;
  if (!(p.position instanceof THREE.Vector3)) return null;
  if (typeof p.health !== 'number' || typeof p.alive !== 'boolean') return null;
  if (!isFn(p.spawnAt)) return null;
  return sys as unknown as PlayerBridge;
}

interface MaybeActors {
  spawnCombatant?: unknown; despawnCombatant?: unknown; isCombatantAlive?: unknown;
  combatantPosition?: unknown; damageCombatant?: unknown;
}

/**
 * Resolves the actor backend.
 *
 * Two shapes qualify. A system that already speaks `ActorAPI` natively is used
 * as-is (the deterministic self-test injects one). Otherwise we look for the
 * shape of `src/ai/AI.ts` and wrap it — see `AIActorBridge` for why the five
 * methods live here rather than on `AISystem` itself.
 */
export function asActorAPI(sys: System | undefined, emit?: Emitter): ActorAPI | null {
  if (!sys) return null;
  const a = sys as unknown as MaybeActors;
  if (isFn(a.spawnCombatant) && isFn(a.despawnCombatant)
    && isFn(a.isCombatantAlive) && isFn(a.combatantPosition) && isFn(a.damageCombatant)) {
    return sys as unknown as ActorAPI;
  }
  const ai = asAISystem(sys);
  return ai ? new AIActorBridge(ai, emit ?? ((k, p) => bus.emit(k, p))) : null;
}

/* ------------------------------------------------------------- AI bridge -- */

/*
 * `src/ai/` is a peer module, not a dependency: nothing below `Match.ts` may
 * import it, and the AI must keep compiling with the whole game layer deleted.
 * So the bridge describes what it needs structurally and probes for it at
 * runtime, exactly like `asPlayerBridge` / `asPhysics` above. If the AI module
 * changes shape, `asAISystem` returns null and the director falls back to
 * `BotFallback` — the same graceful degradation every other bridge has.
 */

interface AICombatLike {
  ammo: number;
  suppression: number;
  shotsFired: number;
  shotsHit: number;
  lastReaction: number;
  reactionStartedAt: number;
  readonly skill: number;
  setSkill(scale: number): void;
}

interface AIPerceptionLike {
  awareness: number;
  readonly state: string;
  readonly hasLOS: boolean;
}

interface AIAgentLike {
  readonly id: number;
  readonly entityId: number;
  readonly bodyYaw: number;
  readonly alive: boolean;
  health: number;
  maxHealth: number;
  readonly height: number;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly loadout: Archetype;
  readonly combat: AICombatLike;
  readonly perception: AIPerceptionLike;
  readonly squad: { readonly id: number } | null;
  character: { object: THREE.Object3D } | null;
  combatEnabled: boolean;
  frozen: boolean;
  applyDamage(
    amount: number, fromDirection: THREE.Vector3, zone: HitZone, byPlayer: boolean,
    point?: THREE.Vector3,
  ): boolean;
  claimBusEcho(amount: number, killed: boolean): void;
  setAggression(a: number): void;
  noticeThreat(position: THREE.Vector3, awareness?: number): void;
  alertTo(position: THREE.Vector3, confidence?: number): void;
  dispose(): void;
}

interface AISystemLike {
  readonly agents: AIAgentLike[];
  readonly cover: { readonly points: ReadonlyArray<unknown> };
  /** `snap` always writes `out`; the boolean says whether it found a nav cell. */
  readonly nav: { snap(p: THREE.Vector3, out: THREE.Vector3): boolean };
  readonly squads: { create(): { readonly id: number } };
  readonly now: number;
  readonly aliveAgents: number;
  /** Whatever the AI is currently fighting; null before the player resolves. */
  readonly target: { readonly position: THREE.Vector3; readonly alive: boolean } | null;
  physics: PhysicsAPI | null;
  spawn(opts: Record<string, unknown>): AIAgentLike;
  byEntity(entityId: number): AIAgentLike | null;
  clear(): void;
}

function asAISystem(sys: System | undefined): AISystemLike | null {
  const a = sys as unknown as Partial<AISystemLike> | undefined;
  if (!a) return null;
  if (!Array.isArray(a.agents) || !isFn(a.spawn) || !isFn(a.byEntity) || !isFn(a.clear)) return null;
  if (!a.cover || !a.nav || !a.squads) return null;
  return a as AISystemLike;
}

/** Bodies linger this long before the agent is disposed. Matches `BotFallback`. */
const CORPSE_LINGER = 14;

/** Concurrent live agents by quality preset — the AI module has no cap of its own. */
const MAX_AGENTS_BY_PRESET: Record<string, number> = {
  low: 8, medium: 14, high: 20, ultra: 24, cinematic: 28,
};

/** Squad size the bridge groups spawns into. Four is a fireteam. */
const SQUAD_SIZE = 4;
/** Spawns further apart than this in time or space start a new squad. */
const SQUAD_WINDOW_SEC = 12;
const SQUAD_RADIUS_M = 34;

/**
 * A director-facing handle onto one `Agent`.
 *
 * `position` is reported at the **feet**, because that is what every existing
 * consumer of `combatantPosition` assumes (`Match.explode` adds 0.9 to reach
 * the chest, markers sit on the ground). `Agent.position` is the capsule
 * centre, so the getter rebases it. It writes into a per-view scratch vector
 * and returns it, which keeps the read live and allocation-free.
 */
class AIBotView {
  readonly team = 'hostile' as const;
  /** Spawn-time accuracy scalar, kept so a later global scale composes with it. */
  spawnAccuracy = 1;
  /** Sim time this agent was first observed dead, or -1. */
  diedAt = -1;
  private readonly feet = new THREE.Vector3();

  constructor(readonly agent: AIAgentLike) { }

  get id(): number { return this.agent.entityId; }
  get alive(): boolean { return this.agent.alive; }
  get health(): number { return this.agent.health; }
  get maxHealth(): number { return this.agent.maxHealth; }
  get height(): number { return this.agent.height; }
  get archetype(): Archetype { return this.agent.loadout; }
  get char(): { object: THREE.Object3D } | null { return this.agent.character; }
  get position(): THREE.Vector3 {
    const a = this.agent;
    return this.feet.set(a.position.x, a.position.y - a.height * 0.5, a.position.z);
  }
}

/**
 * The five `ActorAPI` methods `AISystem` does not have, implemented against it.
 *
 * They live here rather than on `AISystem` for the reason stated at the top of
 * this file: the dependency arrow points game → ai, never the other way, and
 * the AI module is meant to compile and run with `src/game/` deleted. Spawning,
 * despawning, difficulty scalars and damage arbitration are *match* concerns;
 * perception, cover and fire control are *AI* concerns. This is the seam.
 *
 * Everything the director could previously do to `BotFallback` it can do here:
 * the class deliberately keeps `bots`, `hurt`, `liveCount`, `clear`,
 * `setFrozen` and `accuracyScale` so the debug scenes and the playtest harness
 * see the same surface whichever backend is installed.
 */
export class AIActorBridge implements ActorAPI {
  /** Live + recently-dead handles, in spawn order. The harness reads this. */
  readonly bots: AIBotView[] = [];
  private readonly byId = new Map<number, AIBotView>();
  accuracyScale = 1;
  combatEnabled = true;
  frozen = false;
  capacity: number;
  /** Counted so a refusal shows up in a report instead of vanishing. */
  refusedFriendly = 0;
  refusedCapacity = 0;

  private squadId = -1;
  private squadCount = 0;
  private squadTag = '';
  private squadAt = -1e9;
  private readonly squadAnchor = new THREE.Vector3();

  private readonly _v = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();

  constructor(readonly ai: AISystemLike, private emit: Emitter) {
    this.capacity = MAX_AGENTS_BY_PRESET[settings.preset] ?? 20;
  }

  /* ---------------------------------------------------------- ActorAPI -- */

  spawnCombatant(req: SpawnRequest): number {
    /*
     * The AI module has no team model — every agent's target is the player —
     * so a "friendly" agent would be a squadmate that shoots you. Refusing is
     * the only honest answer until `AISystem` grows teams; the director treats
     * -1 as "could not spawn" and carries on.
     */
    if (req.team !== 'hostile') {
      if (this.refusedFriendly === 0) {
        console.warn('[game] the AI backend has no team model; friendly combatant '
          + 'spawns are refused rather than fielded as enemies that shoot you');
      }
      this.refusedFriendly++;
      return -1;
    }
    if (this.liveCount() >= this.capacity) { this.refusedCapacity++; return -1; }

    const profile = ARCHETYPES[req.archetype];
    const squad = this.squadFor(req);

    // Drop the spawn onto the navigation grid so nobody starts inside geometry.
    this._v.copy(req.position);
    try { this.ai.nav.snap(this._v, this._d); } catch { this._d.copy(this._v); }
    if (!Number.isFinite(this._d.x)) this._d.copy(this._v);

    let agent: AIAgentLike;
    try {
      agent = this.ai.spawn({
        position: this._d.clone(),
        yaw: req.yaw,
        loadout: req.archetype,
        faction: req.faction === 'player' ? 'militia' : req.faction,
        squadId: squad,
        seed: req.seed,
        health: profile.health * Math.max(0.1, req.health),
        name: req.tag || profile.name,
      });
    } catch (err) {
      console.warn('[game] ai spawn failed', err);
      return -1;
    }

    const view = new AIBotView(agent);
    view.spawnAccuracy = Math.max(0.05, req.accuracy);
    agent.combat.setSkill(view.spawnAccuracy * this.accuracyScale);
    agent.setAggression(req.aggression);
    agent.combatEnabled = this.combatEnabled;
    agent.frozen = this.frozen;
    /*
     * Point him at the fight. Nothing about the spawn request says which way
     * the action is, and an agent whose authored yaw happens to face away from
     * the player can never acquire — see `Agent.noticeThreat`.
     */
    const threat = this.ai.target;
    if (threat && threat.alive) agent.noticeThreat(threat.position);

    this.bots.push(view);
    this.byId.set(view.id, view);
    return view.id;
  }

  despawnCombatant(id: number): void {
    const v = this.byId.get(id);
    if (!v) return;
    this.retire(v);
  }

  isCombatantAlive(id: number): boolean {
    return this.byId.get(id)?.alive === true;
  }

  combatantPosition(id: number, out: THREE.Vector3): boolean {
    const v = this.byId.get(id);
    if (!v) return false;
    out.copy(v.position);
    return true;
  }

  damageCombatant(id: number, amount: number, opts: DamageOpts): boolean {
    const v = this.byId.get(id);
    if (!v || !v.alive) return false;
    const killed = this.hurt(v, amount, opts);
    /*
     * Ballistics publishes `damage:dealt` for the rounds it resolves; a direct
     * hit (sentry, airstrike, scripted) has nobody else to publish for it, so
     * the score and the killfeed would never see it.
     */
    this.emit('damage:dealt', {
      targetId: id, amount, headshot: !!opts.headshot, killed,
      point: (opts.point ?? v.position).clone(), fromPlayer: opts.fromPlayer !== false,
    });
    return killed;
  }

  setAccuracyScale(scale: number): void {
    this.accuracyScale = Math.max(0, scale);
    for (const v of this.bots) {
      if (v.alive) v.agent.combat.setSkill(v.spawnAccuracy * this.accuracyScale);
    }
  }

  setCombatEnabled(on: boolean): void {
    this.combatEnabled = on;
    for (const v of this.bots) v.agent.combatEnabled = on;
  }

  setFrozen(on: boolean): void {
    this.frozen = on;
    for (const v of this.bots) v.agent.frozen = on;
  }

  listCombatants(out: number[]): number {
    out.length = 0;
    for (const v of this.bots) if (v.alive) out.push(v.id);
    return out.length;
  }

  /* ------------------------------------------------------------- damage -- */

  /**
   * The single point every enemy health change goes through — the weapon
   * system's `DamageResolver`, explosions, killstreaks and scripted damage all
   * land here. `claimBusEcho` then swallows the `damage:dealt` echo so the AI
   * module's own listener cannot apply the same hit twice; see
   * `Agent.claimBusEcho`.
   */
  hurt(v: AIBotView, amount: number, opts: DamageOpts): boolean {
    const a = v.agent;
    if (!a.alive) return false;
    const applied = Math.max(0, amount);
    this._d.copy(opts.direction ?? UP_AXIS);
    if (this._d.lengthSq() < 1e-8) this._d.copy(UP_AXIS);
    // A caller that resolved a real per-zone collider knows better than the
    // headshot boolean; fall back to it only when no zone was supplied.
    const zone = (opts.zone && opts.zone !== 'none')
      ? opts.zone as HitZone
      : (opts.headshot ? 'head' : 'chest');
    const killed = a.applyDamage(applied, this._d, zone, opts.fromPlayer !== false, opts.point);
    a.claimBusEcho(applied, killed);
    if (killed && v.diedAt < 0) v.diedAt = this.ai.now;
    return killed;
  }

  /** O(1) handle lookup — the damage resolver runs this on every round. */
  viewOf(id: number): AIBotView | undefined { return this.byId.get(id); }

  /** True when this archetype should read as armoured in the hitmarker. */
  isArmored(id: number): boolean {
    return this.byId.get(id)?.archetype === 'juggernaut';
  }

  /**
   * Body metrics for one live combatant, so a damage model that does not own
   * the body can still place hit zones on it.
   *
   * The out-param is described structurally rather than imported: this is an
   * *optional* rendezvous point with whatever combat model the game layer ends
   * up with, and the bridge must keep compiling whether or not that model
   * exists yet.
   */
  combatantInfo(id: number, out: CombatantInfoLike): boolean {
    const v = this.byId.get(id);
    if (!v) return false;
    const profile = ARCHETYPES[v.archetype];
    out.archetype = v.archetype;
    out.team = 'hostile';
    out.alive = v.alive;
    out.health = v.health;
    out.maxHealth = v.maxHealth;
    out.position.copy(v.position);
    out.yaw = v.agent.bodyYaw;
    out.height = v.height;
    out.radius = profile.radius;
    return true;
  }

  /* -------------------------------------------------------------- query -- */

  liveCount(): number {
    let n = 0;
    for (const v of this.bots) if (v.alive) n++;
    return n;
  }

  hostilesWithin(center: THREE.Vector3, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (const v of this.bots) {
      if (!v.alive) continue;
      if (v.position.distanceToSquared(center) <= r2) n++;
    }
    return n;
  }

  nearest(p: THREE.Vector3, team: string, maxDist: number): number {
    if (team !== 'hostile') return -1;
    let best = -1;
    let bestD = maxDist * maxDist;
    for (const v of this.bots) {
      if (!v.alive) continue;
      const d = v.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = v.id; }
    }
    return best;
  }

  /* ------------------------------------------------------------- upkeep -- */

  /**
   * Retires corpses.
   *
   * `AISystem.agents` is append-only — it keeps the dead so their ragdolls
   * survive — which over a long match turns into an unbounded array walked
   * every fixed step. The director owns spawn lifetime, so it owns the reaping
   * too. Called from `GameDirector.fixedUpdate`, i.e. after `ORDER.AI` has
   * finished iterating the array this step.
   */
  reap(): void {
    const now = this.ai.now;
    for (let i = this.bots.length - 1; i >= 0; i--) {
      const v = this.bots[i];
      if (v.alive) continue;
      if (v.diedAt < 0) { v.diedAt = now; continue; }
      if (now - v.diedAt < CORPSE_LINGER) continue;
      this.retire(v);
    }
  }

  private retire(v: AIBotView): void {
    const i = this.bots.indexOf(v);
    if (i >= 0) this.bots.splice(i, 1);
    this.byId.delete(v.id);
    const list = this.ai.agents;
    const j = list.indexOf(v.agent);
    if (j >= 0) list.splice(j, 1);
    v.agent.character?.object.removeFromParent();
    try { v.agent.dispose(); } catch { /* a half-built agent must still unlink */ }
  }

  clear(): void {
    this.bots.length = 0;
    this.byId.clear();
    this.squadId = -1;
    this.squadCount = 0;
    this.ai.clear();
  }

  dispose(): void { this.clear(); }

  /* -------------------------------------------------------------- squads -- */

  /**
   * Groups spawns into fireteams.
   *
   * `SpawnRequest` has no squad field — the director thinks in engagement
   * points, not formations — so the bridge infers one: consecutive spawns that
   * share a tag, land within `SQUAD_RADIUS_M` of the first, and arrive inside
   * `SQUAD_WINDOW_SEC` join the same squad, up to `SQUAD_SIZE`. That is what
   * turns `src/ai/Squad.ts` on: bounding advances, move-token arbitration and
   * shared contact reports all key off squad membership.
   */
  private squadFor(req: SpawnRequest): number {
    const now = this.ai.now;
    const stale = now - this.squadAt > SQUAD_WINDOW_SEC;
    const far = this.squadAnchor.distanceToSquared(req.position) > SQUAD_RADIUS_M * SQUAD_RADIUS_M;
    if (this.squadId < 0 || this.squadCount >= SQUAD_SIZE || stale || far || this.squadTag !== req.tag) {
      this.squadId = this.ai.squads.create().id;
      this.squadCount = 0;
      this.squadTag = req.tag;
      this.squadAnchor.copy(req.position);
    }
    this.squadCount++;
    this.squadAt = now;
    return this.squadId;
  }

  /* --------------------------------------------------------------- debug -- */

  /** JSON-serialisable state for scripted verification. */
  snapshot(): unknown {
    return {
      backend: 'ai',
      live: this.liveCount(),
      tracked: this.bots.length,
      capacity: this.capacity,
      accuracyScale: this.accuracyScale,
      combatEnabled: this.combatEnabled,
      coverPoints: this.ai.cover.points.length,
      refusedFriendly: this.refusedFriendly,
      refusedCapacity: this.refusedCapacity,
      agents: this.bots.map((v) => ({
        id: v.id, agentId: v.agent.id, alive: v.alive,
        archetype: v.archetype, hp: Math.round(v.health), max: Math.round(v.maxHealth),
        squad: v.agent.squad ? v.agent.squad.id : -1,
        state: v.agent.perception.state,
        awareness: +v.agent.perception.awareness.toFixed(3),
        hasLOS: v.agent.perception.hasLOS,
        suppression: +v.agent.combat.suppression.toFixed(2),
        shots: v.agent.combat.shotsFired, hits: v.agent.combat.shotsHit,
        reactionMs: Math.round(v.agent.combat.lastReaction * 1000),
        skill: +v.agent.combat.skill.toFixed(3),
        pos: [+v.position.x.toFixed(2), +v.position.y.toFixed(2), +v.position.z.toFixed(2)],
      })),
    };
  }
}

/** Structural view of `CombatantInfo`; see `AIActorBridge.combatantInfo`. */
interface CombatantInfoLike {
  archetype: Archetype;
  team: string;
  alive: boolean;
  health: number;
  maxHealth: number;
  position: THREE.Vector3;
  yaw: number;
  height: number;
  radius: number;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

export function asWorldBridge(sys: System | undefined): WorldBridge | null {
  if (!sys) return null;
  const w = sys as unknown as WorldBridge;
  if (!Array.isArray(w.spawns) && !(w.bounds instanceof THREE.Box3)) return null;
  return w;
}

function asPhysics(sys: System | undefined): PhysicsAPI | null {
  if (!sys) return null;
  const p = sys as unknown as { raycast?: unknown; lineOfSight?: unknown };
  return isFn(p.raycast) && isFn(p.lineOfSight) ? (sys as unknown as PhysicsAPI) : null;
}

function asRender(sys: System | undefined): RenderAPI | null {
  if (!sys) return null;
  const r = sys as unknown as { screenEffect?: unknown; addDynamicLight?: unknown };
  return isFn(r.screenEffect) && isFn(r.addDynamicLight) ? (sys as unknown as RenderAPI) : null;
}

/* ---------------------------------------------------------- installation -- */

let sessionArmed = false;

/**
 * Stands the session layer up, once, on `game:ready`.
 *
 * Two details are load-bearing:
 *
 * 1. **Deferred to `game:ready`.** `Engine.init()` walks `this.systems` with
 *    `for…of` while we are inside `GameDirector.init`, and `Engine.add` pushes
 *    *and re-sorts* that same array — which can make the loop revisit or skip a
 *    system. `game:ready` fires after the loop, so adding there is safe.
 *    `init` is then called by hand because the engine will not run its pass
 *    again.
 * 2. **Dynamic import.** `src/session` sits around the match, not under it. A
 *    static import would invert that and drag the whole meta layer into every
 *    headless game test; the dynamic one keeps `src/game` standalone and lets
 *    the bundler split it out.
 *
 * Failure is never fatal. If the session layer is missing, throws, or is simply
 * not wanted, the game runs exactly as it did before it existed — which is the
 * whole reason single player cannot regress.
 */
export function armSessionLayer(ctx: EngineContext): void {
  if (sessionArmed) return;
  sessionArmed = true;
  const off = bus.on('game:ready', () => {
    off();
    void (async () => {
      try {
        const mod = await import('../session/SessionSystem');
        const session = mod.installSession(ctx.engine, {});
        session.init(ctx);
        (globalThis as unknown as { __BLACKOUT_SESSION__?: unknown }).__BLACKOUT_SESSION__ = session;
      } catch (err) {
        console.warn('[services] session layer not installed:', err);
      }
    })();
  });
}

export function resolveServices(ctx: EngineContext, rng: Rand): GameServices {
  const e = ctx.engine;
  armSessionLayer(ctx);
  return {
    scene: ctx.scene,
    camera: ctx.camera,
    player: asPlayerBridge(e.tryGet('player')),
    actors: asActorAPI(e.tryGet('ai'), (key, payload) => bus.emit(key, payload)),
    world: asWorldBridge(e.tryGet('world')),
    physics: asPhysics(e.tryGet('physics')),
    render: asRender(e.tryGet('render')),
    emit: (key, payload) => bus.emit(key, payload),
    rng,
    setTimeScale: (s) => { ctx.time.scale = s; },
    getTimeScale: () => ctx.time.scale,
    meta: resolveMetaServices(ctx),
  };
}

/** A services bundle with nothing attached — the base for headless tests. */
export function headlessServices(rng: Rand, emit?: Emitter): GameServices {
  let scale = 1;
  return {
    scene: null,
    camera: null,
    player: null,
    actors: null,
    world: null,
    physics: null,
    render: null,
    emit: emit ?? (() => { }),
    rng,
    setTimeScale: (s) => { scale = s; },
    getTimeScale: () => scale,
    meta: NO_META,
  };
}

/* ------------------------------------------------------------- ray scratch -- */

/** Shared, reusable ray result so queries never allocate in a hot path. */
export function makeRayHit(): RayHit {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity,
    surface: 'concrete',
    object: null,
    entityId: -1,
    bodyHandle: -1,
    zone: 'none',
    backface: false,
  };
}
