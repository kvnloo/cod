/**
 * Chunk — a batched geometry accumulator keyed by material.
 *
 * Level code writes into `chunk.m('brick')`, `chunk.m('glass')` and so on, and
 * one `emit()` turns the whole thing into one mesh per material. A building with
 * three hundred boxes across six materials becomes six draw calls.
 *
 * Everything emitted here is tagged for the rest of the engine:
 *  - `tagSurface()` so ballistics/decals/audio know what was hit,
 *  - `collideWhenHidden` so the physics static bake still sees geometry the
 *    culling system has switched off,
 *  - shadow flags chosen per material (alpha cards and glass do not cast).
 */

import * as THREE from 'three';
import { setBlendWeights } from '../../material/MaterialShaders';
import { tagSurface } from '../../core/Surfaces';
import { LAYERS } from '../../render/types';
import type { MatCatalog, MatKey } from '../MatCatalog';
import { Mesher } from './Mesher';

export interface EmitOptions {
  name?: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Skip physics collider generation for everything in this chunk. */
  noCollide?: boolean;
  /** Force a render layer (backdrop geometry, markers). */
  layer?: number;
  /** Extra userData merged onto every emitted mesh. */
  userData?: Record<string, unknown>;
  /** Exclude from navigation voxelisation (decoration that must not block AI). */
  navIgnore?: boolean;
  /**
   * Second-layer weight for blended materials, evaluated per world-space vertex.
   * Returns 0 for "pure base material", 1 for "fully the blend layer" — blown
   * render showing masonry, or dirt banked against a wall. Keys that do not
   * blend ignore it; keys that do blend get a zero attribute when it is absent,
   * which is what keeps the shader's `vColor` defined everywhere.
   */
  blend?: (x: number, y: number, z: number, key: MatKey) => number;
}

export class Chunk {
  private meshers = new Map<MatKey, Mesher>();

  /** The mesher for a material key, created on first use. */
  m(key: MatKey): Mesher {
    let mesher = this.meshers.get(key);
    if (!mesher) { mesher = new Mesher(); this.meshers.set(key, mesher); }
    return mesher;
  }

  get keys(): MatKey[] { return [...this.meshers.keys()]; }

  get triangles(): number {
    let n = 0;
    for (const mesher of this.meshers.values()) n += mesher.triangleCount;
    return n;
  }

  /** Builds one mesh per material and parents them to `target`. */
  emit(target: THREE.Object3D, cat: MatCatalog, opts: EmitOptions = {}): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, mesher] of this.meshers) {
      if (mesher.empty) continue;
      const geo = mesher.build();
      if (cat.blends(key)) {
        const fn = opts.blend;
        setBlendWeights(geo, fn ? (x, y, z) => fn(x, y, z, key) : () => 0);
      }
      const mesh = new THREE.Mesh(geo, cat.get(key));
      mesh.name = `${opts.name ?? 'chunk'}:${key}`;
      const alpha = cat.isAlphaCard(key);
      const transparent = cat.isTransparent(key);
      mesh.castShadow = opts.castShadow ?? (!transparent);
      mesh.receiveShadow = opts.receiveShadow ?? true;
      if (alpha) mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (opts.layer !== undefined) mesh.layers.set(opts.layer);
      tagSurface(mesh, cat.surface(key));
      const ud = mesh.userData as Record<string, unknown>;
      ud.collideWhenHidden = true;
      ud.matKey = key;
      if (opts.noCollide) ud.noCollide = true;
      if (opts.navIgnore) ud.navIgnore = true;
      if (opts.userData) Object.assign(ud, opts.userData);
      target.add(mesh);
      out.push(mesh);
    }
    return out;
  }

  clear(): void {
    this.meshers.clear();
  }
}

/** Convenience: a group that will hold one building / one district of props. */
export function makeGroup(name: string, layer = LAYERS.DEFAULT): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  if (layer !== LAYERS.DEFAULT) g.layers.set(layer);
  return g;
}

/**
 * A named collection of chunks — one per building, one per boundary run, one
 * per set piece.
 *
 * Batching *everything* into one mesh per material would give the smallest
 * possible draw count and the worst possible culling: a single mesh spanning
 * the whole map can never be rejected. Splitting per structure keeps the draw
 * count in the low hundreds while giving the culling system objects whose
 * bounding spheres are actually meaningful.
 */
export class ChunkSet {
  readonly entries: { name: string; chunk: Chunk }[] = [];
  private index = new Map<string, Chunk>();

  get(name: string): Chunk {
    let c = this.index.get(name);
    if (!c) {
      c = new Chunk();
      this.index.set(name, c);
      this.entries.push({ name, chunk: c });
    }
    return c;
  }

  get triangles(): number {
    let n = 0;
    for (const e of this.entries) n += e.chunk.triangles;
    return n;
  }

  /** Emits one group per named chunk under `parent`. */
  emitAll(parent: THREE.Object3D, cat: MatCatalog, opts: EmitOptions = {}): THREE.Group[] {
    const groups: THREE.Group[] = [];
    for (const { name, chunk } of this.entries) {
      const group = new THREE.Group();
      group.name = name;
      if (opts.layer !== undefined) group.layers.set(opts.layer);
      chunk.emit(group, cat, { ...opts, name });
      if (group.children.length === 0) continue;
      group.matrixAutoUpdate = false;
      group.updateMatrix();
      parent.add(group);
      groups.push(group);
    }
    return groups;
  }
}
