/**
 * Physics contract.
 *
 * Ballistics, the player controller and AI all query the world through this
 * interface, never through Rapier directly. That keeps the backend swappable and
 * lets consumers be written before the backend exists.
 */

import type { Object3D, Vector3, Quaternion } from 'three';
import type { SurfaceType } from '../core/Surfaces';

/** Bitmask collision layers. */
export const LAYER = {
  STATIC: 1 << 0,      // level geometry
  DYNAMIC: 1 << 1,     // physics props, debris
  PLAYER: 1 << 2,
  ENEMY: 1 << 3,
  RAGDOLL: 1 << 4,
  PROJECTILE: 1 << 5,
  TRIGGER: 1 << 6,
  GLASS: 1 << 7,
  WATER: 1 << 8,
  CLIP: 1 << 9,        // invisible player-blocking volumes
  FOLIAGE: 1 << 10,
  ALL: 0xffff,
} as const;

/** Everything a bullet should collide with. */
export const MASK_BULLET = LAYER.STATIC | LAYER.DYNAMIC | LAYER.ENEMY | LAYER.PLAYER | LAYER.GLASS | LAYER.RAGDOLL;
/** Everything that blocks line of sight for AI. */
export const MASK_SIGHT = LAYER.STATIC | LAYER.DYNAMIC | LAYER.GLASS;
/** Everything that blocks movement. */
export const MASK_MOVE = LAYER.STATIC | LAYER.DYNAMIC | LAYER.CLIP;

export interface RayHit {
  hit: boolean;
  /** World-space hit point. */
  point: Vector3;
  /** World-space surface normal, facing the ray origin. */
  normal: Vector3;
  distance: number;
  surface: SurfaceType;
  /** Owning scene object, when the collider was created from one. */
  object: Object3D | null;
  /** Entity id if the collider belongs to a gameplay entity, else -1. */
  entityId: number;
  /** Body handle for impulse application. */
  bodyHandle: number;
  /** Hit zone for characters: head / chest / limb / none. */
  zone: HitZone;
  /** True when the collider is a back-face (used for exit wounds). */
  backface: boolean;
}

export type HitZone = 'head' | 'neck' | 'chest' | 'stomach' | 'arm' | 'leg' | 'none';

export interface BodyDesc {
  kind: 'static' | 'dynamic' | 'kinematic';
  shape:
  | { type: 'box'; half: [number, number, number] }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'cylinder'; radius: number; halfHeight: number }
  | { type: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | { type: 'convex'; vertices: Float32Array }
  | { type: 'heightfield'; rows: number; cols: number; heights: Float32Array; scale: [number, number, number] };
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  layer?: number;
  mask?: number;
  ccd?: boolean;
  sensor?: boolean;
  surface?: SurfaceType;
  /** Scene object kept in sync with the body transform. */
  object?: Object3D;
  entityId?: number;
  zone?: HitZone;
  /** Bodies below this speed for 0.5s are put to sleep. */
  sleepThreshold?: number;
}

export interface BodyHandle {
  readonly id: number;
  readonly desc: BodyDesc;
  getPosition(out: Vector3): Vector3;
  getRotation(out: Quaternion): Quaternion;
  setTransform(p: Vector3, q: Quaternion): void;
  setLinearVelocity(v: Vector3): void;
  getLinearVelocity(out: Vector3): Vector3;
  applyImpulse(impulse: Vector3, atPoint?: Vector3): void;
  applyTorqueImpulse(t: Vector3): void;
  wake(): void;
  setEnabled(on: boolean): void;
  remove(): void;
}

export interface CharacterMoveResult {
  /** Translation actually applied after collide-and-slide. */
  applied: Vector3;
  grounded: boolean;
  /** Slope normal under the feet, when grounded. */
  groundNormal: Vector3;
  groundSurface: SurfaceType;
  /** True when a wall stopped horizontal motion this step. */
  blocked: boolean;
  /** Surface hit head-first, used to cancel upward velocity. */
  ceiling: boolean;
  /** Speed lost to collisions this step, for landing/impact audio. */
  impactSpeed: number;
}

export interface CharacterController {
  radius: number;
  height: number;
  setHeight(h: number): void;
  /** Collide-and-slide move with step-up, slope limits and ground snapping. */
  move(position: Vector3, motion: Vector3, dt: number, out: CharacterMoveResult): Vector3;
  dispose(): void;
}

export interface OverlapResult {
  entityId: number;
  bodyHandle: number;
  object: Object3D | null;
  distance: number;
}

export interface PhysicsAPI {
  readonly ready: boolean;
  /** Single closest hit along a ray. `out` is reused; do not retain it. */
  raycast(origin: Vector3, dir: Vector3, maxDist: number, mask: number, out: RayHit, ignoreEntity?: number): RayHit;
  /** All hits along a ray, sorted by distance — needed for wall penetration. */
  raycastAll(origin: Vector3, dir: Vector3, maxDist: number, mask: number, out: RayHit[], max?: number, ignoreEntity?: number): number;
  /** Swept sphere; used for grenade prediction and thick projectiles. */
  spherecast(origin: Vector3, dir: Vector3, radius: number, maxDist: number, mask: number, out: RayHit): RayHit;
  /** Everything whose collider overlaps a sphere — explosion damage queries. */
  overlapSphere(center: Vector3, radius: number, mask: number, out: OverlapResult[], max?: number): number;
  /** Unobstructed line of sight between two points. */
  lineOfSight(from: Vector3, to: Vector3, mask?: number, ignoreEntity?: number): boolean;

  addBody(desc: BodyDesc): BodyHandle;
  removeBody(handle: BodyHandle): void;
  createCharacter(radius: number, height: number, layer?: number): CharacterController;

  /** Radial impulse applied to every dynamic body in range. */
  applyExplosion(center: Vector3, radius: number, power: number): void;

  /** Debug: number of active bodies. */
  stats(): { bodies: number; active: number; contacts: number; stepMs: number };
}
