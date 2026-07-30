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
import type { PhysicsAPI, RayHit } from '../physics/types';
import type { RenderAPI } from '../render/types';
import { Rand } from '../core/Rand';
import type { ActorAPI, PlayerBridge, WorldBridge } from './types';
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

/** The AI system qualifies only when it implements the full spawn/damage surface. */
export function asActorAPI(sys: System | undefined): ActorAPI | null {
  if (!sys) return null;
  const a = sys as unknown as MaybeActors;
  if (!isFn(a.spawnCombatant) || !isFn(a.despawnCombatant)) return null;
  if (!isFn(a.isCombatantAlive) || !isFn(a.combatantPosition) || !isFn(a.damageCombatant)) return null;
  return sys as unknown as ActorAPI;
}

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
    actors: asActorAPI(e.tryGet('ai')),
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
