/**
 * Prop instancing and spatial bucketing.
 *
 * Placements are collected across the whole level, bucketed into districts and
 * emitted as one `InstancedMesh` per (prop, material, district). Bucketing is
 * what makes culling worthwhile: a district that is behind the camera costs
 * nothing, and small props drop out entirely past their relevance distance.
 *
 * Per-instance variation (hue, roughness, wear, UV offset) rides on the shared
 * `obVar` attribute the material library provides, so a hundred crates are a
 * hundred slightly different crates.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import { applyInstanceVariation } from '../../material/MaterialLibrary';
import { tagSurface } from '../../core/Surfaces';
import type { MatCatalog, MatKey } from '../MatCatalog';
import { Chunk } from '../geom/Chunk';
import { propDef, type PropDef } from './Props';

export interface Placement {
  id: string;
  x: number; y: number; z: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  scale?: number;
}

export interface PropCluster {
  id: string;
  meshes: THREE.InstancedMesh[];
  centre: THREE.Vector3;
  radius: number;
  cullDistance: number;
  def: PropDef;
  /** World matrices of every instance — used by the nav voxeliser. */
  matrices: THREE.Matrix4[];
}

const DISTRICT = 38;

export class PropScatter {
  private placements = new Map<string, Placement[]>();
  private geometries = new Map<string, { key: MatKey; geo: THREE.BufferGeometry }[]>();
  private rand = new Rand(90210);

  place(p: Placement): void {
    if (!propDef(p.id)) return;
    let list = this.placements.get(p.id);
    if (!list) { list = []; this.placements.set(p.id, list); }
    list.push(p);
  }

  get count(): number {
    let n = 0;
    for (const l of this.placements.values()) n += l.length;
    return n;
  }

  /** Builds (and caches) the per-material geometry for one prop id. */
  private geometryFor(id: string): { key: MatKey; geo: THREE.BufferGeometry }[] {
    const cached = this.geometries.get(id);
    if (cached) return cached;
    const def = propDef(id);
    if (!def) return [];
    const chunk = new Chunk();
    def.build(chunk, new Rand(`prop:${id}`));
    const out: { key: MatKey; geo: THREE.BufferGeometry }[] = [];
    for (const key of chunk.keys) {
      const mesher = chunk.m(key);
      if (mesher.empty) continue;
      out.push({ key, geo: mesher.build() });
    }
    this.geometries.set(id, out);
    return out;
  }

  /**
   * Emits every placement into `parent`, grouped by district so the culling
   * system has something coarse to switch off.
   */
  build(parent: THREE.Object3D, cat: MatCatalog): PropCluster[] {
    const clusters: PropCluster[] = [];
    const m4 = new THREE.Matrix4();
    const euler = new THREE.Euler();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const [id, list] of this.placements) {
      const def = propDef(id);
      if (!def) continue;
      const parts = this.geometryFor(id);
      if (!parts.length) continue;

      // Bucket by district.
      const buckets = new Map<string, Placement[]>();
      for (const p of list) {
        const key = `${Math.floor(p.x / DISTRICT)},${Math.floor(p.z / DISTRICT)}`;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(p);
      }

      // obVar must cover the largest bucket; geometries are shared.
      let maxCount = 0;
      for (const b of buckets.values()) maxCount = Math.max(maxCount, b.length);
      for (const part of parts) {
        if (!part.geo.getAttribute('obVar')) {
          applyInstanceVariation(part.geo, Math.max(1, maxCount), () => this.rand.next());
        }
      }

      for (const [bucketKey, items] of buckets) {
        const matrices: THREE.Matrix4[] = [];
        const box = new THREE.Box3();
        for (const p of items) {
          euler.set(p.pitch ?? 0, p.yaw ?? 0, p.roll ?? 0, 'YXZ');
          quat.setFromEuler(euler);
          pos.set(p.x, p.y, p.z);
          const s = p.scale ?? 1;
          scl.set(s, s, s);
          matrices.push(new THREE.Matrix4().compose(pos, quat, scl));
          box.expandByPoint(pos);
        }
        box.expandByScalar(def.radius * 1.25 + def.height * 0.5);
        const centre = box.getCenter(new THREE.Vector3());
        const radius = box.getSize(new THREE.Vector3()).length() * 0.5;

        const meshes: THREE.InstancedMesh[] = [];
        for (const part of parts) {
          const mesh = new THREE.InstancedMesh(part.geo, cat.get(part.key), items.length);
          mesh.name = `prop:${id}:${part.key}:${bucketKey}`;
          for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
          mesh.instanceMatrix.needsUpdate = true;
          // Ground clutter is drawn once per shadow cascade as well as in the
          // main pass; below about half a metre it contributes nothing a
          // cascade can resolve, so it is excluded from shadow casting.
          const big = def.height >= 0.55 || def.radius >= 0.7;
          mesh.castShadow = big && !def.noShadow && !cat.isAlphaCard(part.key);
          mesh.receiveShadow = true;
          mesh.frustumCulled = true;
          tagSurface(mesh, cat.surface(part.key));
          const ud = mesh.userData as Record<string, unknown>;
          ud.collideWhenHidden = true;
          ud.navIgnore = true; // nav uses the cluster matrices instead
          if (def.collide === 'none' || part.key === 'foliage' || part.key === 'foliageDry') {
            ud.noCollide = true;
          }
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          parent.add(mesh);
          meshes.push(mesh);
          void m4;
        }

        clusters.push({
          id, meshes, centre, radius, def, matrices,
          cullDistance: def.lodDistance ?? relevanceDistance(def),
        });
      }
    }
    return clusters;
  }

  dispose(): void {
    for (const parts of this.geometries.values()) for (const p of parts) p.geo.dispose();
    this.geometries.clear();
    this.placements.clear();
  }
}

/** Small clutter stops being worth a draw call long before big props do. */
function relevanceDistance(def: PropDef): number {
  const size = Math.max(def.radius * 2, def.height);
  if (size < 0.5) return 32;
  if (size < 1.0) return 55;
  if (size < 2.0) return 95;
  return 200;
}
