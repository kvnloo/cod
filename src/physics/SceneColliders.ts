/**
 * Scene graph → static colliders.
 *
 * The world module authors level geometry as Three.js meshes; this walks that
 * graph and bakes collision out of it, so level designers never hand-author a
 * collision mesh.
 *
 * Two things make it fast enough to run on a full level:
 *
 *  - **Primitive recovery.** A `BoxGeometry` becomes a Rapier cuboid, a
 *    `PlaneGeometry` a thin slab, spheres/cylinders/capsules likewise. Analytic
 *    shapes are an order of magnitude cheaper to query than triangle soup and
 *    give exact normals, which matters enormously for the character controller.
 *  - **Merging.** Everything left over is welded into one trimesh per
 *    (surface, layer) group. Rapier reports the triangle index as the hit
 *    `featureId`, so a sorted range table still recovers the exact source mesh —
 *    merging costs nothing in fidelity but collapses hundreds of colliders into
 *    a handful of BVHs.
 *
 * Opt-outs, read from `userData`: `noCollide`/`collide:false`, `physicsShape`
 * (`'box' | 'trimesh' | 'none'`), `physicsLayer`, `surface`, `entityId`.
 * Objects excluded from render layer 0 (view models, backdrops, markers) are
 * skipped automatically.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { SurfaceType } from '../core/Surfaces';
import { readSurface, surface as surfaceProps } from '../core/Surfaces';
import type { StaticBuildResult } from './types';
import { LAYER } from './types';
import { groups, defaultMask, isSensorLayer } from './Layers';
import type { ColliderRegistry, TriRange } from './Registry';

export interface StaticHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
}

interface MergeGroup {
  surface: SurfaceType;
  layer: number;
  positions: number[];
  indices: number[];
  ranges: TriRange[];
  triCount: number;
}

const mat = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const v = new THREE.Vector3();
const box = new THREE.Box3();

/** Triangles beyond this in one merged group start a new collider/BVH. */
const MAX_TRIS_PER_GROUP = 60_000;

export class SceneColliderBuilder {
  /** Colliders created by the last build, so a rebuild can retire them. */
  private created: RAPIER.Collider[] = [];
  private seen = new Set<string>();

  constructor(private host: StaticHost) { }

  get colliderCount(): number { return this.created.length; }

  /** Drops every collider this builder owns. */
  clear(): void {
    const world = this.host.world;
    for (const c of this.created) {
      this.host.registry.remove(c.handle);
      if (world.colliders.contains(c.handle)) world.removeCollider(c, false);
    }
    this.created.length = 0;
    this.seen.clear();
  }

  /**
   * Bakes colliders for every collidable mesh under `root`. Idempotent: objects
   * already baked by a previous call are skipped, so this can be re-run after
   * the world streams in more geometry.
   */
  build(root: THREE.Object3D): StaticBuildResult {
    const t0 = performance.now();
    const merges = new Map<string, MergeGroup>();
    let colliders = 0;
    let triangles = 0;

    root.updateWorldMatrix(true, true);
    this.walk(root, merges, (n) => { colliders += n; });

    // Flush merge groups into trimesh colliders.
    let merged = 0;
    for (const g of merges.values()) {
      if (g.indices.length < 3) continue;
      const c = this.createTrimesh(g);
      if (c) { colliders++; merged++; triangles += g.triCount; }
    }

    return { colliders, triangles, merged, ms: performance.now() - t0 };
  }

  /* ------------------------------------------------------------------ walk -- */

  private walk(obj: THREE.Object3D, merges: Map<string, MergeGroup>, count: (n: number) => void): void {
    const ud = obj.userData as Record<string, unknown>;
    if (ud.noCollide === true || ud.collide === false) return;
    if (ud.physicsSkipSubtree === true) return;
    // Anything invisible to the default render layer is presentation-only.
    if ((obj.layers.mask & 1) === 0) return;

    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      if (mesh.visible || ud.collideWhenHidden === true) {
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
          count(this.addInstanced(mesh as THREE.InstancedMesh));
        } else {
          count(this.addMesh(mesh, merges));
        }
      }
    }

    for (let i = 0; i < obj.children.length; i++) this.walk(obj.children[i], merges, count);
  }

  private tagOf(obj: THREE.Object3D): SurfaceType {
    const ud = obj.userData as Record<string, unknown>;
    if (typeof ud.surface === 'string') return ud.surface as SurfaceType;
    const mesh = obj as THREE.Mesh;
    const m = mesh.material;
    if (m && !Array.isArray(m) && typeof m.userData?.surface === 'string') {
      return m.userData.surface as SurfaceType;
    }
    // Inherit from an ancestor group so a whole building can be tagged once.
    let p = obj.parent;
    while (p) {
      const s = (p.userData as Record<string, unknown>).surface;
      if (typeof s === 'string') return s as SurfaceType;
      p = p.parent;
    }
    return readSurface(obj);
  }

  private layerOf(obj: THREE.Object3D, tag: SurfaceType): number {
    const ud = obj.userData as Record<string, unknown>;
    if (typeof ud.physicsLayer === 'number') return ud.physicsLayer;
    if (tag === 'glass' || tag === 'glassThick') return LAYER.GLASS;
    if (tag === 'foliage') return LAYER.FOLIAGE;
    if (tag === 'water') return LAYER.WATER;
    return LAYER.STATIC;
  }

  /* ------------------------------------------------------------------ mesh -- */

  private addMesh(mesh: THREE.Mesh, merges: Map<string, MergeGroup>): number {
    if (this.seen.has(mesh.uuid)) return 0;
    const geo = mesh.geometry;
    if (!geo || !geo.attributes.position) return 0;

    const ud = mesh.userData as Record<string, unknown>;
    const override = ud.physicsShape;
    if (override === 'none') return 0;

    const tag = this.tagOf(mesh);
    const layer = this.layerOf(mesh, tag);
    const entityId = typeof ud.entityId === 'number' ? ud.entityId : -1;

    mesh.updateWorldMatrix(true, false);
    mat.copy(mesh.matrixWorld);
    mat.decompose(pos, quat, scl);

    this.seen.add(mesh.uuid);

    if (override !== 'trimesh') {
      const desc = this.primitiveFor(geo, pos, quat, scl, override === 'box');
      if (desc) {
        this.finishCollider(desc, mesh, tag, layer, entityId, null);
        return 1;
      }
    }

    // Triangle soup → merge queue.
    const key = `${tag}|${layer}|${entityId >= 0 ? entityId : ''}`;
    let g = merges.get(key);
    if (!g || g.triCount > MAX_TRIS_PER_GROUP) {
      // Retire a full group under a unique key so it is still flushed, then
      // start a fresh one so no single BVH grows unbounded.
      if (g) merges.set(`${key}#${merges.size}`, g);
      g = { surface: tag, layer, positions: [], indices: [], ranges: [], triCount: 0 };
      merges.set(key, g);
    }
    appendGeometry(g, geo, mesh.matrixWorld, mesh, tag, entityId);
    return 0;
  }

  /** Recovers an analytic shape from a parametric geometry, or null. */
  private primitiveFor(
    geo: THREE.BufferGeometry, p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3,
    forceBox: boolean,
  ): RAPIER.ColliderDesc | null {
    const type = geo.type;
    const params = (geo as unknown as { parameters?: Record<string, number> }).parameters;

    if (!forceBox && params) {
      if (type === 'BoxGeometry') {
        const d = RAPIER.ColliderDesc.cuboid(
          Math.abs(params.width * s.x) * 0.5,
          Math.abs(params.height * s.y) * 0.5,
          Math.abs(params.depth * s.z) * 0.5,
        );
        return d.setTranslation(p.x, p.y, p.z).setRotation(q);
      }
      if (type === 'PlaneGeometry') {
        // A plane is a zero-thickness quad in local XY facing +Z; give it a
        // 10 cm slab downward so the character has something to stand on.
        const hx = Math.abs(params.width * s.x) * 0.5;
        const hy = Math.abs(params.height * s.y) * 0.5;
        const t = 0.1;
        v.set(0, 0, -t).applyQuaternion(q);
        const d = RAPIER.ColliderDesc.cuboid(hx, hy, t);
        return d.setTranslation(p.x + v.x, p.y + v.y, p.z + v.z).setRotation(q);
      }
      if (type === 'SphereGeometry' || type === 'IcosahedronGeometry' || type === 'DodecahedronGeometry') {
        const r = params.radius * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
        return RAPIER.ColliderDesc.ball(r).setTranslation(p.x, p.y, p.z).setRotation(q);
      }
      if (type === 'CylinderGeometry' && params.radiusTop === params.radiusBottom) {
        const r = params.radiusTop * Math.max(Math.abs(s.x), Math.abs(s.z));
        const hh = params.height * Math.abs(s.y) * 0.5;
        return RAPIER.ColliderDesc.cylinder(hh, r).setTranslation(p.x, p.y, p.z).setRotation(q);
      }
      if (type === 'CapsuleGeometry') {
        const r = params.radius * Math.max(Math.abs(s.x), Math.abs(s.z));
        const hh = params.height * Math.abs(s.y) * 0.5;
        return RAPIER.ColliderDesc.capsule(Math.max(0.01, hh), r)
          .setTranslation(p.x, p.y, p.z).setRotation(q);
      }
    }

    if (forceBox) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) return null;
      bb.getCenter(v);
      const hx = Math.abs((bb.max.x - bb.min.x) * s.x) * 0.5;
      const hy = Math.abs((bb.max.y - bb.min.y) * s.y) * 0.5;
      const hz = Math.abs((bb.max.z - bb.min.z) * s.z) * 0.5;
      v.multiply(s).applyQuaternion(q).add(p);
      return RAPIER.ColliderDesc.cuboid(Math.max(1e-3, hx), Math.max(1e-3, hy), Math.max(1e-3, hz))
        .setTranslation(v.x, v.y, v.z).setRotation(q);
    }
    return null;
  }

  /** One cuboid per instance — trimeshes per instance would be ruinous. */
  private addInstanced(mesh: THREE.InstancedMesh): number {
    if (this.seen.has(mesh.uuid)) return 0;
    this.seen.add(mesh.uuid);
    const geo = mesh.geometry;
    if (!geo) return 0;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return 0;
    box.copy(bb);

    const tag = this.tagOf(mesh);
    const layer = this.layerOf(mesh, tag);
    const ud = mesh.userData as Record<string, unknown>;
    const entityId = typeof ud.entityId === 'number' ? ud.entityId : -1;
    const limit = Math.min(mesh.count, 4096);

    let made = 0;
    for (let i = 0; i < limit; i++) {
      mesh.getMatrixAt(i, mat);
      mat.premultiply(mesh.matrixWorld);
      mat.decompose(pos, quat, scl);
      const hx = Math.abs((box.max.x - box.min.x) * scl.x) * 0.5;
      const hy = Math.abs((box.max.y - box.min.y) * scl.y) * 0.5;
      const hz = Math.abs((box.max.z - box.min.z) * scl.z) * 0.5;
      if (hx < 1e-4 || hy < 1e-4 || hz < 1e-4) continue;
      box.getCenter(v);
      v.multiply(scl).applyQuaternion(quat).add(pos);
      const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(v.x, v.y, v.z).setRotation(quat);
      this.finishCollider(d, mesh, tag, layer, entityId, null);
      made++;
    }
    return made;
  }

  /* --------------------------------------------------------------- creation -- */

  private createTrimesh(g: MergeGroup): RAPIER.Collider | null {
    const verts = new Float32Array(g.positions);
    const idx = new Uint32Array(g.indices);
    let desc: RAPIER.ColliderDesc;
    try {
      desc = RAPIER.ColliderDesc.trimesh(
        verts, idx,
        RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES,
      );
    } catch (err) {
      console.warn('[physics] trimesh build failed', err);
      return null;
    }
    g.ranges.sort((a, b) => a.start - b.start);
    return this.finishCollider(desc, null, g.surface, g.layer, -1, g.ranges);
  }

  private finishCollider(
    desc: RAPIER.ColliderDesc, object: THREE.Object3D | null, tag: SurfaceType,
    layer: number, entityId: number, ranges: TriRange[] | null,
  ): RAPIER.Collider {
    const props = surfaceProps(tag);
    desc.setFriction(props.friction);
    desc.setRestitution(props.restitution);
    desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
    desc.setCollisionGroups(groups(layer, defaultMask(layer)));
    desc.setSensor(isSensorLayer(layer));
    const collider = this.host.world.createCollider(desc);
    this.created.push(collider);
    this.host.registry.add({
      handle: collider.handle,
      bodyId: -1,
      object,
      surface: tag,
      entityId,
      zone: 'none',
      layer,
      ranges,
      ragdollId: -1,
      debris: false,
    });
    return collider;
  }
}

/* --------------------------------------------------------------- geometry -- */

const tv = new THREE.Vector3();

/** Appends a transformed copy of `geo` into a merge group. */
function appendGeometry(
  g: MergeGroup, geo: THREE.BufferGeometry, matrix: THREE.Matrix4,
  object: THREE.Object3D, tag: SurfaceType, entityId: number,
): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const base = g.positions.length / 3;
  const start = g.triCount;

  for (let i = 0; i < posAttr.count; i++) {
    tv.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
    g.positions.push(tv.x, tv.y, tv.z);
  }

  const index = geo.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      g.indices.push(
        base + index.getX(i),
        base + index.getX(i + 1),
        base + index.getX(i + 2),
      );
    }
    g.triCount += Math.floor(index.count / 3);
  } else {
    for (let i = 0; i + 2 < posAttr.count; i += 3) {
      g.indices.push(base + i, base + i + 1, base + i + 2);
    }
    g.triCount += Math.floor(posAttr.count / 3);
  }

  if (g.triCount > start) {
    g.ranges.push({ start, end: g.triCount, object, surface: tag, entityId });
  }
}

/**
 * Extracts a world-space, de-indexed triangle soup from a mesh. Used by the
 * destruction system to fracture a mesh and by callers that need raw geometry.
 */
export function extractTriangles(mesh: THREE.Mesh, out?: { positions: number[]; indices: number[] }): {
  positions: number[]; indices: number[];
} {
  const res = out ?? { positions: [], indices: [] };
  res.positions.length = 0;
  res.indices.length = 0;
  const geo = mesh.geometry;
  const posAttr = geo?.attributes.position as THREE.BufferAttribute | undefined;
  if (!posAttr) return res;
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < posAttr.count; i++) {
    tv.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    res.positions.push(tv.x, tv.y, tv.z);
  }
  const index = geo.index;
  if (index) {
    for (let i = 0; i < index.count; i++) res.indices.push(index.getX(i));
  } else {
    for (let i = 0; i < posAttr.count; i++) res.indices.push(i);
  }
  return res;
}
