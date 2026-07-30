/**
 * Rig builder — turns a pile of `BufferGeometry` into an animatable weapon.
 *
 * The problem this solves: a detailed weapon is ~40 distinct components, and
 * 40 draw calls for the object that is on screen 100% of the time is not
 * acceptable. But a single merged mesh cannot animate a magazine drop or a
 * bolt cycle.
 *
 * So geometry is declared against *named parts*. Everything inside a part is
 * merged per material at build time, giving one draw call per (part, material)
 * pair — typically 10–16 for a whole weapon — while each part keeps its own
 * transform node with a real pivot, which is what the reload and cycling
 * animations drive.
 *
 * Parts may be nested (`bolt` under `receiver`), and pivots are declared in
 * weapon-local space; the builder converts them to parent-relative offsets and
 * rebases the geometry so local rotation happens about the right axis.
 */

import * as THREE from 'three';
import type { MaterialKey } from '../types';
import type { MaterialSpace, WeaponMaterials } from '../WeaponMaterials';
import { merge, projectUV, triangleCount } from './Geo';
import { WEAPON_TEXEL_SCALE } from '../WeaponMaterials';

interface PartSpec {
  name: string;
  parent: string | null;
  /** Pivot in weapon-local space. */
  pivot: THREE.Vector3;
  geos: Map<MaterialKey, THREE.BufferGeometry[]>;
}

export interface WeaponRig {
  root: THREE.Group;
  /** Every named transform node, keyed by part name. */
  nodes: Map<string, THREE.Group>;
  /** Named points of interest in weapon-local space (muzzle, sight, …). */
  points: Map<string, THREE.Vector3>;
  meshes: THREE.Mesh[];
  triangles: number;
  drawCalls: number;
  node(name: string): THREE.Group | null;
  point(name: string): THREE.Vector3 | null;
  /** Rest transform of every node, for animation to blend back to. */
  rest: Map<string, THREE.Vector3>;
  dispose(): void;
}

export class RigBuilder {
  /**
   * Diagnostic: emit one mesh per submitted geometry instead of merging.
   * Set from the debug scene so a stray polygon can be traced to the exact
   * `add()` that produced it. Never true in a shipping build.
   */
  static debugSplit = false;

  private parts: PartSpec[] = [];
  private byName = new Map<string, PartSpec>();
  private current: PartSpec;
  private points = new Map<string, THREE.Vector3>();

  constructor(private mats: WeaponMaterials, private space: MaterialSpace = 'view') {
    this.current = this.declare('root', null, [0, 0, 0]);
  }

  /** Declares (or re-selects) a part and makes it current. */
  part(name: string, pivot: [number, number, number] = [0, 0, 0], parent = 'root'): this {
    const existing = this.byName.get(name);
    if (existing) { this.current = existing; return this; }
    this.current = this.declare(name, name === 'root' ? null : parent, pivot);
    return this;
  }

  /** Re-selects an already-declared part without changing its pivot. */
  use(name: string): this {
    const p = this.byName.get(name);
    if (p) this.current = p;
    return this;
  }

  private declare(name: string, parent: string | null, pivot: [number, number, number]): PartSpec {
    const spec: PartSpec = {
      name, parent,
      pivot: new THREE.Vector3(pivot[0], pivot[1], pivot[2]),
      geos: new Map(),
    };
    this.parts.push(spec);
    this.byName.set(name, spec);
    return spec;
  }

  /** Adds geometry (already positioned in weapon-local space) to the current part. */
  add(geo: THREE.BufferGeometry, material: MaterialKey): this {
    let list = this.current.geos.get(material);
    if (!list) { list = []; this.current.geos.set(material, list); }
    list.push(geo);
    return this;
  }

  /** Adds several geometries sharing one material. */
  addAll(geos: readonly THREE.BufferGeometry[], material: MaterialKey): this {
    for (const g of geos) this.add(g, material);
    return this;
  }

  /** Records a point of interest in weapon-local space. */
  point(name: string, p: readonly [number, number, number]): this {
    this.points.set(name, new THREE.Vector3(p[0], p[1], p[2]));
    return this;
  }

  hasPart(name: string): boolean { return this.byName.has(name); }

  build(name: string): WeaponRig {
    const root = new THREE.Group();
    root.name = name;
    const nodes = new Map<string, THREE.Group>();
    const rest = new Map<string, THREE.Vector3>();
    const meshes: THREE.Mesh[] = [];
    let triangles = 0;

    nodes.set('root', root);
    rest.set('root', new THREE.Vector3());

    // Absolute pivots first so children can subtract their parent's.
    const abs = new Map<string, THREE.Vector3>();
    for (const p of this.parts) abs.set(p.name, p.pivot);

    for (const spec of this.parts) {
      let node = spec.name === 'root' ? root : nodes.get(spec.name);
      if (!node) {
        node = new THREE.Group();
        node.name = spec.name;
        nodes.set(spec.name, node);
      }
      if (spec.name !== 'root') {
        const parentPivot = spec.parent ? abs.get(spec.parent) ?? new THREE.Vector3() : new THREE.Vector3();
        node.position.copy(spec.pivot).sub(parentPivot);
        rest.set(spec.name, node.position.clone());
      }

      for (const [key, list] of spec.geos) {
        if (list.length === 0) continue;
        if (RigBuilder.debugSplit) {
          for (let i = 0; i < list.length; i++) {
            const gi = merge([list[i]]);
            gi.translate(-spec.pivot.x, -spec.pivot.y, -spec.pivot.z);
            projectUV(gi, WEAPON_TEXEL_SCALE);
            gi.computeBoundingSphere();
            const mi = new THREE.Mesh(gi, this.mats.get(key, this.space));
            mi.name = `${spec.name}:${key}:${i}`;
            mi.frustumCulled = false;
            triangles += triangleCount(gi);
            node.add(mi);
            meshes.push(mi);
            list[i].dispose();
          }
          continue;
        }
        const g = merge(list);
        g.translate(-spec.pivot.x, -spec.pivot.y, -spec.pivot.z);
        projectUV(g, WEAPON_TEXEL_SCALE);
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.mats.get(key, this.space));
        mesh.name = `${spec.name}:${key}`;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        triangles += triangleCount(g);
        node.add(mesh);
        meshes.push(mesh);
        for (const geo of list) geo.dispose();
      }
    }

    // Parent nodes after they all exist so declaration order does not matter.
    for (const spec of this.parts) {
      if (spec.name === 'root' || !spec.parent) continue;
      const node = nodes.get(spec.name)!;
      const parent = nodes.get(spec.parent) ?? root;
      parent.add(node);
    }

    const points = this.points;
    const rig: WeaponRig = {
      root, nodes, points, meshes, triangles,
      drawCalls: meshes.length,
      node: (n) => nodes.get(n) ?? null,
      point: (n) => points.get(n) ?? null,
      rest,
      dispose: () => {
        for (const m of meshes) m.geometry.dispose();
        meshes.length = 0;
        root.clear();
      },
    };
    return rig;
  }
}
