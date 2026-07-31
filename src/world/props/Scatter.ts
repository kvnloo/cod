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
import { setBlendWeights } from '../../material/MaterialShaders';
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

const DISTRICT = 48;
/**
 * A bucket has to earn its draw calls.
 *
 * Bucketing exists so the culling system can reject a district that is behind
 * the camera — worth it for the thousand-odd pieces of rubble, pointless for a
 * prop with four placements on the whole map, where it just multiplies one
 * instanced draw into four. Anything under this count is folded into a single
 * map-wide bucket; the dense scatters keep their spatial split.
 */
const MERGE_BELOW = 12;

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
  private geometryFor(id: string, cat: MatCatalog): { key: MatKey; geo: THREE.BufferGeometry }[] {
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
      const geo = mesher.build();
      // Grounding: props are authored sitting on y = 0, so the blend layer can
      // be driven straight off local height. Dirt splashes up the bottom
      // ~18 cm of anything that stands on the street, which is what stops a
      // crate reading as a clean box dropped on to the pavement.
      if (cat.blends(key)) {
        setBlendWeights(geo, (_x, y) => 1 - THREE.MathUtils.smoothstep(y, 0.015, 0.19));
      }
      out.push({ key, geo });
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
      const parts = this.geometryFor(id, cat);
      if (!parts.length) continue;

      // Bucket by district, then fold the sparse ones together.
      const buckets = new Map<string, Placement[]>();
      for (const p of list) {
        const key = `${Math.floor(p.x / DISTRICT)},${Math.floor(p.z / DISTRICT)}`;
        let b = buckets.get(key);
        if (!b) { b = []; buckets.set(key, b); }
        b.push(p);
      }
      const spare: Placement[] = [];
      for (const [key, b] of buckets) {
        if (b.length >= MERGE_BELOW) continue;
        for (const p of b) spare.push(p);
        buckets.delete(key);
      }
      if (spare.length) buckets.set('all', spare);

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
          mesh.castShadow = castsShadow(def, cat.isAlphaCard(part.key));
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

/**
 * Sun elevation the shadow budget is authored against, as a tangent.
 *
 * The level's hero hour puts the sun at 32.4°, so an object's shadow reaches
 * `height / tan(32.4°)` = height × 1.57 across the ground. Using the tangent
 * rather than the height directly is the point: the same 12 cm brick that is
 * pointless at noon throws 19 cm in the afternoon, which is twenty near-cascade
 * texels and unmistakably a brick.
 */
const SHADOW_TAN = 0.635;

/**
 * Minimum ground-projected shadow length worth an atlas draw, in metres.
 *
 * 12 cm is roughly a fist at 3 m, and comfortably above the 0.9 / 2.0 / 4.9 cm
 * texel footprints of the first three cascades. The old gate was `height ≥ 0.55
 * || radius ≥ 0.7`, which excluded **2185 of 3978 instances** — every piece of
 * rubble, every concrete chunk, every tyre, jerry can and toolbox on the map —
 * so the ground under the debris fields came back one flat unbroken value and
 * the props read as decals printed on it.
 */
const MIN_SHADOW = 0.12;

/**
 * Does this prop earn a place in the shadow atlas?
 *
 * Two exclusions survive, and both are about correctness rather than cost:
 *
 *  - **Alpha cards.** The shadow pass runs a single `overrideMaterial`, so there
 *    is no per-material alpha test in it. Foliage and grates would cast their
 *    quad, not their cut-out — a black rectangle under every bush.
 *  - **Flat ground decals.** `noShadow` props under 10 cm tall (manhole covers,
 *    drifted paper, glass shards) lie *on* the surface that would receive the
 *    shadow. They project nothing and self-shadow into acne.
 *
 * A `noShadow` prop that stands *up* is not ground clutter and does cast — razor
 * wire is the one that reaches the frame, and its shadow is real geometry, not a
 * card. (Ivy and window flower boxes carry the flag too but are foliage, so the
 * alpha rule above already holds them back.) Census after this change: **3325 of
 * 3978 instances cast, up from 1793**; the 653 that do not are 342 flat ground
 * decals and 311 alpha-cut cards, and closing that last gap needs an alpha-test
 * in the shadow depth material, not a threshold here.
 */
function castsShadow(def: PropDef, alphaCard: boolean): boolean {
  if (alphaCard) return false;
  if (def.noShadow && def.height < 0.10) return false;
  // Height only: a flat plate lying on the ground projects its own footprint,
  // which is coincident with the surface receiving it and shows as nothing but
  // acne. Planar radius does not lengthen a shadow, it just widens it.
  return def.height / SHADOW_TAN >= MIN_SHADOW;
}

/** Small clutter stops being worth a draw call long before big props do. */
function relevanceDistance(def: PropDef): number {
  const size = Math.max(def.radius * 2, def.height);
  if (size < 0.5) return 32;
  if (size < 1.0) return 55;
  if (size < 2.0) return 95;
  return 200;
}
