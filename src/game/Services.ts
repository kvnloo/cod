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

export function resolveServices(ctx: EngineContext, rng: Rand): GameServices {
  const e = ctx.engine;
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
