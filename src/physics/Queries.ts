/**
 * Scene queries.
 *
 * Everything ballistics, AI perception and gameplay ask of the world funnels
 * through here. The contract is that result objects are caller-owned and reused,
 * so a full-auto weapon tracing eight penetration layers per shot allocates
 * nothing per frame on our side.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { OverlapResult, RayHit } from './types';
import { MASK_SIGHT } from './types';
import { queryGroups } from './Layers';
import type { ColliderRegistry } from './Registry';

export interface QueryHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
}

const rayScratch = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
const rp = { x: 0, y: 0, z: 0 };
const rv = { x: 0, y: 0, z: 0 };
const rq = { x: 0, y: 0, z: 0, w: 1 };
const vDir = new THREE.Vector3();
const vTmp = new THREE.Vector3();

export function makeRayHit(): RayHit {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete', object: null, entityId: -1,
    bodyHandle: -1, zone: 'none', backface: false,
  };
}

export function clearHit(out: RayHit): RayHit {
  out.hit = false;
  out.distance = Infinity;
  out.entityId = -1;
  out.object = null;
  out.bodyHandle = -1;
  out.zone = 'none';
  out.backface = false;
  out.surface = 'concrete';
  return out;
}

export class QueryEngine {
  private balls = new Map<number, RAPIER.Ball>();
  /** Raised while a query is running so predicates can see the exclusion. */
  private ignoreEntity = -1;

  constructor(private host: QueryHost) { }

  private predicate = (collider: RAPIER.Collider): boolean => {
    if (this.ignoreEntity < 0) return true;
    return this.host.registry.resolve(collider.handle).entityId !== this.ignoreEntity;
  };

  private ball(radius: number): RAPIER.Ball {
    // Quantise so a spray of near-identical radii does not thrash the cache.
    const key = Math.max(0.005, Math.round(radius * 1000) / 1000);
    let b = this.balls.get(key);
    if (!b) { b = new RAPIER.Ball(key); this.balls.set(key, b); }
    return b;
  }

  /* --------------------------------------------------------------- raycast -- */

  raycast(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: RayHit, ignoreEntity = -1,
  ): RayHit {
    clearHit(out);
    const len = dir.length();
    if (len < 1e-9 || !(maxDist > 0)) return out;
    vDir.copy(dir).multiplyScalar(1 / len);

    rayScratch.origin.x = origin.x; rayScratch.origin.y = origin.y; rayScratch.origin.z = origin.z;
    rayScratch.dir.x = vDir.x; rayScratch.dir.y = vDir.y; rayScratch.dir.z = vDir.z;

    this.ignoreEntity = ignoreEntity;
    const hit = this.host.world.castRayAndGetNormal(
      rayScratch, maxDist, false, undefined, queryGroups(mask), undefined, undefined,
      ignoreEntity >= 0 ? this.predicate : undefined,
    );
    this.ignoreEntity = -1;
    if (!hit) return out;

    this.fillHit(out, hit.collider.handle, hit.timeOfImpact, hit.normal, hit.featureId, origin, vDir);
    return out;
  }

  raycastAll(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: RayHit[], max = 8, ignoreEntity = -1,
  ): number {
    const len = dir.length();
    if (len < 1e-9 || !(maxDist > 0) || max <= 0) return 0;
    vDir.copy(dir).multiplyScalar(1 / len);

    rayScratch.origin.x = origin.x; rayScratch.origin.y = origin.y; rayScratch.origin.z = origin.z;
    rayScratch.dir.x = vDir.x; rayScratch.dir.y = vDir.y; rayScratch.dir.z = vDir.z;

    let n = 0;
    this.ignoreEntity = ignoreEntity;
    this.host.world.intersectionsWithRay(
      rayScratch, maxDist, false,
      (isect) => {
        if (n >= max) return false;
        if (!out[n]) out[n] = makeRayHit();
        this.fillHit(out[n], isect.collider.handle, isect.timeOfImpact, isect.normal, isect.featureId, origin, vDir);
        n++;
        return n < max;
      },
      undefined, queryGroups(mask), undefined, undefined,
      ignoreEntity >= 0 ? this.predicate : undefined,
    );
    this.ignoreEntity = -1;

    // Rapier does not promise ordering; wall penetration absolutely needs it.
    // Insertion sort over references — n is tiny and this allocates nothing.
    for (let i = 1; i < n; i++) {
      const cur = out[i];
      let j = i - 1;
      while (j >= 0 && out[j].distance > cur.distance) { out[j + 1] = out[j]; j--; }
      out[j + 1] = cur;
    }
    return n;
  }

  /* ------------------------------------------------------------ shape casts -- */

  spherecast(
    origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number,
    mask: number, out: RayHit, ignoreEntity = -1,
  ): RayHit {
    clearHit(out);
    const len = dir.length();
    if (len < 1e-9 || !(maxDist > 0)) return out;
    vDir.copy(dir).multiplyScalar(1 / len);

    rp.x = origin.x; rp.y = origin.y; rp.z = origin.z;
    rv.x = vDir.x; rv.y = vDir.y; rv.z = vDir.z;

    this.ignoreEntity = ignoreEntity;
    const hit = this.host.world.castShape(
      rp, rq, rv, this.ball(radius), 0, maxDist, false,
      undefined, queryGroups(mask), undefined, undefined,
      ignoreEntity >= 0 ? this.predicate : undefined,
    );
    this.ignoreEntity = -1;
    if (!hit) return out;

    out.hit = true;
    out.distance = hit.time_of_impact;

    // Rapier reports witness points in each shape's own local frame, which is
    // fiddly to reconstruct. For a ball the contact point is exact anyway:
    // it is the swept centre pushed back along the contact normal by `radius`.
    out.normal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
    const nl = out.normal.length();
    if (nl < 1e-6) out.normal.copy(vDir).negate();
    else {
      out.normal.multiplyScalar(1 / nl);
      if (out.normal.dot(vDir) > 0) out.normal.negate();
    }
    out.point.copy(origin)
      .addScaledVector(vDir, hit.time_of_impact)
      .addScaledVector(out.normal, -radius);

    const prov = this.host.registry.resolve(hit.collider.handle);
    out.surface = prov.surface;
    out.object = prov.object;
    out.entityId = prov.entityId;
    out.zone = prov.zone;
    out.bodyHandle = prov.bodyId;
    out.backface = false;
    return out;
  }

  overlapSphere(
    center: THREE.Vector3, radius: number, mask: number, out: OverlapResult[], max = 32,
  ): number {
    let n = 0;
    rp.x = center.x; rp.y = center.y; rp.z = center.z;
    this.host.world.intersectionsWithShape(
      rp, rq, this.ball(radius),
      (collider) => {
        if (n >= max) return false;
        const prov = this.host.registry.resolve(collider.handle);
        let dist = 0;
        const proj = collider.projectPoint(rp, true);
        if (proj) {
          vTmp.set(proj.point.x, proj.point.y, proj.point.z).sub(center);
          dist = proj.isInside ? 0 : vTmp.length();
        }
        const slot = out[n] ?? (out[n] = { entityId: -1, bodyHandle: -1, object: null, distance: 0 });
        slot.entityId = prov.entityId;
        slot.bodyHandle = prov.bodyId;
        slot.object = prov.object;
        slot.distance = dist;
        n++;
        return n < max;
      },
      undefined, queryGroups(mask),
    );
    return n;
  }

  lineOfSight(
    from: THREE.Vector3, to: THREE.Vector3, mask = MASK_SIGHT, ignoreEntity = -1,
  ): boolean {
    vTmp.copy(to).sub(from);
    const dist = vTmp.length();
    if (dist < 1e-5) return true;
    vTmp.multiplyScalar(1 / dist);

    rayScratch.origin.x = from.x; rayScratch.origin.y = from.y; rayScratch.origin.z = from.z;
    rayScratch.dir.x = vTmp.x; rayScratch.dir.y = vTmp.y; rayScratch.dir.z = vTmp.z;

    this.ignoreEntity = ignoreEntity;
    const hit = this.host.world.castRay(
      rayScratch, dist - 1e-3, true, undefined, queryGroups(mask), undefined, undefined,
      ignoreEntity >= 0 ? this.predicate : undefined,
    );
    this.ignoreEntity = -1;
    return hit === null;
  }

  /* ------------------------------------------------------------------ util -- */

  private fillHit(
    out: RayHit, handle: number, toi: number, normal: { x: number; y: number; z: number },
    featureId: number | undefined, origin: THREE.Vector3, unitDir: THREE.Vector3,
  ): void {
    out.hit = true;
    out.distance = toi;
    out.point.copy(origin).addScaledVector(unitDir, toi);

    out.normal.set(normal.x, normal.y, normal.z);
    const nl = out.normal.length();
    if (nl < 1e-6) {
      out.normal.copy(unitDir).negate();
      out.backface = false;
    } else {
      out.normal.multiplyScalar(1 / nl);
      // A normal pointing along the ray means we came out of the surface's back
      // face — exactly the signal exit wounds and penetration need.
      out.backface = out.normal.dot(unitDir) > 0;
      if (out.backface) out.normal.negate();
    }

    const prov = this.host.registry.resolve(handle, featureId);
    out.surface = prov.surface;
    out.object = prov.object;
    out.entityId = prov.entityId;
    out.zone = prov.zone;
    out.bodyHandle = prov.bodyId;
  }
}
