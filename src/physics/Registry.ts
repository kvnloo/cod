/**
 * Collider → gameplay metadata registry.
 *
 * Rapier colliders carry no user data of their own, so every collider we create
 * gets a record here keyed by its handle. The record is what turns a raw
 * time-of-impact into a fully populated {@link RayHit}: owning `Object3D`,
 * surface tag, entity id and hit zone.
 *
 * Merged static geometry (many world meshes baked into one trimesh, which is the
 * only way to keep the collider count sane) stores a sorted table of triangle
 * ranges instead. Rapier reports the triangle index as the hit `featureId`, so a
 * binary search recovers the original mesh and surface per triangle — merging
 * costs us nothing in fidelity.
 */

import type * as THREE from 'three';
import type { SurfaceType } from '../core/Surfaces';
import type { HitZone } from './types';

export interface TriRange {
  /** First triangle index owned by this source mesh. */
  start: number;
  /** One past the last triangle index. */
  end: number;
  object: THREE.Object3D | null;
  surface: SurfaceType;
  entityId: number;
}

export interface ColliderRecord {
  /** Rapier collider handle. */
  handle: number;
  /** Our `BodyHandle.id`, or -1 for raw static scene colliders. */
  bodyId: number;
  object: THREE.Object3D | null;
  surface: SurfaceType;
  entityId: number;
  zone: HitZone;
  layer: number;
  /** Non-null for merged trimeshes: per-triangle provenance, sorted by `start`. */
  ranges: TriRange[] | null;
  /** Ragdoll id when this collider is a ragdoll limb, else -1. */
  ragdollId: number;
  /** Marks debris/glass shards so the budget can reclaim them. */
  debris: boolean;
}

/** Resolved provenance for one hit. Reused; never retained by callers. */
export interface Provenance {
  object: THREE.Object3D | null;
  surface: SurfaceType;
  entityId: number;
  zone: HitZone;
  bodyId: number;
}

export class ColliderRegistry {
  private byHandle = new Map<number, ColliderRecord>();
  private scratch: Provenance = {
    object: null, surface: 'concrete', entityId: -1, zone: 'none', bodyId: -1,
  };

  get size(): number { return this.byHandle.size; }

  add(rec: ColliderRecord): ColliderRecord {
    this.byHandle.set(rec.handle, rec);
    return rec;
  }

  get(handle: number): ColliderRecord | undefined {
    return this.byHandle.get(handle);
  }

  remove(handle: number): void {
    this.byHandle.delete(handle);
  }

  clear(): void {
    this.byHandle.clear();
  }

  forEach(fn: (rec: ColliderRecord) => void): void {
    for (const rec of this.byHandle.values()) fn(rec);
  }

  /**
   * Provenance of a hit on `handle`. `featureId` selects the source mesh inside a
   * merged trimesh; pass `undefined` for primitive shapes.
   *
   * The returned object is a shared scratch — copy what you need out of it.
   */
  resolve(handle: number, featureId?: number): Provenance {
    const s = this.scratch;
    const rec = this.byHandle.get(handle);
    if (!rec) {
      s.object = null; s.surface = 'concrete'; s.entityId = -1; s.zone = 'none'; s.bodyId = -1;
      return s;
    }
    s.object = rec.object;
    s.surface = rec.surface;
    s.entityId = rec.entityId;
    s.zone = rec.zone;
    s.bodyId = rec.bodyId;

    const ranges = rec.ranges;
    if (ranges && featureId !== undefined && featureId >= 0) {
      const r = findRange(ranges, featureId);
      if (r) {
        s.object = r.object;
        s.surface = r.surface;
        if (r.entityId >= 0) s.entityId = r.entityId;
      }
    }
    return s;
  }
}

/** Binary search over a sorted, non-overlapping triangle range table. */
export function findRange(ranges: TriRange[], tri: number): TriRange | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (tri < r.start) hi = mid - 1;
    else if (tri >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}
