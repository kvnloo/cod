/**
 * Collision-layer plumbing.
 *
 * Rapier encodes filtering as a single 32-bit `InteractionGroups`: the high 16
 * bits are the *membership* (what a collider is), the low 16 bits are the
 * *filter* (what it is willing to interact with). Two colliders interact iff
 *
 *     (memberA & filterB) != 0 && (memberB & filterA) != 0
 *
 * Our `LAYER` constants all fit in 16 bits, so they map straight onto the
 * membership half. Scene queries are expressed as "membership = everything,
 * filter = the caller's mask", which reduces the pair test to
 * `(colliderMembership & mask) != 0` provided every collider keeps a non-zero
 * filter — hence non-solid layers (foliage, water) still declare a filter and
 * rely on the sensor flag rather than an empty mask to avoid solid response.
 */

import { LAYER } from './types';
import type { SurfaceType } from '../core/Surfaces';
import { surface } from '../core/Surfaces';

/** Packs a membership + filter pair into Rapier's InteractionGroups word. */
export function groups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Interaction groups for a scene query restricted to `mask`. */
export function queryGroups(mask: number): number {
  return groups(0xffff, mask === 0 ? LAYER.ALL : mask);
}

/**
 * The set of layers a body on `layer` should collide with when the caller does
 * not specify one. Chosen so the common cases (props on the floor, ragdolls
 * that do not shove the player, bullets that ignore triggers) are right without
 * every call site thinking about it.
 */
export function defaultMask(layer: number): number {
  switch (layer) {
    case LAYER.STATIC:
      return LAYER.ALL;
    case LAYER.CLIP:
      return LAYER.PLAYER | LAYER.ENEMY;
    case LAYER.DYNAMIC:
      return LAYER.STATIC | LAYER.DYNAMIC | LAYER.PLAYER | LAYER.ENEMY
        | LAYER.RAGDOLL | LAYER.PROJECTILE | LAYER.GLASS | LAYER.CLIP;
    case LAYER.RAGDOLL:
      return LAYER.STATIC | LAYER.DYNAMIC | LAYER.RAGDOLL | LAYER.GLASS | LAYER.PROJECTILE;
    case LAYER.PROJECTILE:
      return LAYER.STATIC | LAYER.DYNAMIC | LAYER.GLASS | LAYER.CLIP | LAYER.ENEMY | LAYER.PLAYER;
    case LAYER.GLASS:
      return LAYER.ALL;
    case LAYER.PLAYER:
    case LAYER.ENEMY:
      return LAYER.STATIC | LAYER.DYNAMIC | LAYER.CLIP | LAYER.GLASS | LAYER.TRIGGER;
    case LAYER.TRIGGER:
      return LAYER.PLAYER | LAYER.ENEMY | LAYER.DYNAMIC;
    case LAYER.FOLIAGE:
      // Non-solid: still queryable (bullets/AI sight) but never blocks movement.
      return LAYER.PROJECTILE | LAYER.PLAYER | LAYER.ENEMY;
    case LAYER.WATER:
      return LAYER.PLAYER | LAYER.ENEMY | LAYER.DYNAMIC | LAYER.PROJECTILE;
    default:
      return LAYER.ALL;
  }
}

/** Layers that never generate a solid contact response. */
export function isSensorLayer(layer: number): boolean {
  return layer === LAYER.TRIGGER || layer === LAYER.FOLIAGE || layer === LAYER.WATER;
}

export interface PhysMaterial {
  friction: number;
  restitution: number;
  /** kg/m³ — feeds Rapier's automatic mass computation. */
  density: number;
}

const DENSITY_FALLBACK = 900;

/** Friction/restitution/density for a surface tag, used when spawning bodies. */
export function physMaterial(t: SurfaceType | undefined): PhysMaterial {
  const p = surface(t);
  return {
    friction: p.friction,
    restitution: p.restitution,
    // `density` in the surface table is a ballistic energy-loss figure that
    // happens to track real density closely enough for debris mass; clamp it so
    // a stray value cannot produce a 40-tonne splinter.
    density: Math.max(80, Math.min(DENSITY_FALLBACK * 9, p.density)),
  };
}
