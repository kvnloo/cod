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
  /** World displacement contributed by a moving platform under the feet. */
  platformDelta?: Vector3;
  /** Yaw the platform rotated by this step, radians. Add it to the view yaw. */
  platformYaw?: number;
}

export interface CharacterController {
  radius: number;
  height: number;
  setHeight(h: number): void;
  /** Collide-and-slide move with step-up, slope limits and ground snapping. */
  move(position: Vector3, motion: Vector3, dt: number, out: CharacterMoveResult): Vector3;
  dispose(): void;
  /** True when a capsule `h` tall would fit at `position` — gate standing up. */
  canSetHeight?(h: number, position: Vector3): boolean;
  /** Hard-sets the position, clearing ground/platform state. */
  teleport?(position: Vector3): void;
  /** Maximum walkable slope in degrees. */
  slopeLimit?: number;
  /** Obstacle height traversed without leaving the ground, metres. */
  stepHeight?: number;
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

/* ---------------------------------------------------------------- extensions */
/* Everything below is additive: the core `PhysicsAPI` above is unchanged, these
 * are the richer services the Rapier backend also provides. Consumers should
 * import them from here so the backend stays swappable. */

/** Result of walking a scene graph and baking static colliders out of it. */
export interface StaticBuildResult {
  colliders: number;
  triangles: number;
  merged: number;
  ms: number;
}

export interface DebrisOptions {
  /** Number of chunks to produce. Clamped by the debris budget. */
  count?: number;
  /** Chunk size in metres; defaults to a fraction of the source bounds. */
  size?: number;
  surface?: SurfaceType;
  /** Velocity inherited from the parent object. */
  inherit?: Vector3;
  /** Outward speed imparted by the impact, m/s. */
  speed?: number;
  /** Seconds before the chunk fades and despawns. */
  lifetime?: number;
  /** Deterministic seed; derived from the impact point when omitted. */
  seed?: number;
  /** Parent to attach the debris meshes to. Defaults to the physics scene root. */
  parent?: Object3D | null;
}

export interface GlassShatterOptions {
  /** Impact point in world space. */
  point: Vector3;
  /** Direction the projectile was travelling. */
  direction: Vector3;
  /** Radial shard count. */
  shards?: number;
  seed?: number;
  /** Energy of the hit — drives how far the shards are thrown. */
  power?: number;
}

/** A live ragdoll, driven by the solver and used to pose a skinned mesh. */
export interface RagdollHandle {
  readonly id: number;
  /** Body count. */
  readonly bones: number;
  /** Copies the simulated pose onto the rig this ragdoll was created from. */
  syncToRig(): void;
  /** World transform of one ragdoll segment. */
  segmentTransform(index: number, outPos: Vector3, outRot: Quaternion): void;
  applyImpulse(zone: HitZone, impulse: Vector3): void;
  /** True once every segment has come to rest. */
  readonly settled: boolean;
  remove(): void;
}

export interface RagdollOptions {
  /** Root object whose bones will be driven; may be null for physics-only. */
  root?: Object3D | null;
  /**
   * Live bone objects from the character rig, keyed by canonical bone name.
   * When present the ragdoll drives them every frame via `syncToRig()`.
   */
  bones?: Record<string, Object3D | null>;
  /** World bone transforms, used when live bone objects are unavailable. */
  pose?: Record<string, { position: [number, number, number]; rotation: [number, number, number, number] }>;
  /** Total mass of the character in kg. */
  mass?: number;
  entityId?: number;
  /** Velocity the character had when it died. */
  velocity?: Vector3;
  /** Extra solver iterations; raise for hero deaths, lower for crowd deaths. */
  quality?: number;
}

export interface ProjectileOptions {
  position: Vector3;
  velocity: Vector3;
  radius?: number;
  mass?: number;
  restitution?: number;
  friction?: number;
  /** Rolling resistance; higher settles a grenade faster. */
  rollingFriction?: number;
  /** Scene object slaved to the body transform. */
  object?: Object3D | null;
  entityId?: number;
  surface?: SurfaceType;
  /** Extra layers the projectile should collide with. */
  mask?: number;
}

export interface TrajectoryResult {
  /** Number of points written into the caller's buffer. */
  count: number;
  /** Index of the first bounce, or -1. */
  firstBounce: number;
  /** Total simulated time covered. */
  time: number;
}

