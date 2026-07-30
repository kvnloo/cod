/**
 * Visibility: cell-based rejection, frustum culling and distance LOD.
 *
 * Three.js already frustum-culls per mesh, but it does so *after* walking the
 * whole graph and it cannot know that a mesh is irrelevant because it is a
 * window frame 90 m away. This system does three things that matter at level
 * scale:
 *
 *  1. **Cells.** Cullables are bucketed into 24 m cells; one sphere test rejects
 *     everything in a cell that is behind the camera.
 *  2. **Detail LOD.** Meshes made of detail materials — window frames, glazing,
 *     railings, downpipes, gutters — switch off past their relevance distance.
 *     The building's masonry silhouette is untouched, so nothing pops in the
 *     outline; only the trim that is sub-pixel at that range disappears.
 *  3. **Prop relevance.** Small instanced clutter drops out entirely with
 *     distance, which is where most of the draw-call saving comes from.
 *
 * Everything hidden here is still baked into physics (`collideWhenHidden`) and
 * into the navmesh, so gameplay never notices.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';
import type { MatKey } from './MatCatalog';
import type { PropCluster } from './props/Scatter';

const CELL = 24;

/** Materials that only exist as trim; invisible in silhouette past ~60 m. */
const DETAIL_KEYS = new Set<MatKey>([
  'woodPaint', 'glass', 'glassDirty', 'grate', 'pipe', 'alu', 'copper',
  'canvasRed', 'canvasGreen', 'canvasCream', 'signGlow', 'lampWarm', 'fluoro',
]);

export interface Cullable {
  object: THREE.Object3D;
  centre: THREE.Vector3;
  radius: number;
  maxDistance: number;
  /** Never hidden; used for the ground plane and the backdrop. */
  always?: boolean;
}

interface Cell {
  key: string;
  centre: THREE.Vector3;
  radius: number;
  items: Cullable[];
}

export class WorldCulling {
  private cullables: Cullable[] = [];
  private cells = new Map<string, Cell>();
  private frustum = new THREE.Frustum();
  private matrix = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private camPos = new THREE.Vector3();
  private dirty = true;

  /** Live counters for the perf overlay. */
  visibleObjects = 0;
  totalObjects = 0;
  visibleCells = 0;

  add(c: Cullable): void {
    this.cullables.push(c);
    this.dirty = true;
  }

  /** Registers every mesh of a building group, splitting shell from trim. */
  addBuilding(group: THREE.Object3D): void {
    const box = new THREE.Box3();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      mesh.geometry.computeBoundingSphere();
      const bs = mesh.geometry.boundingSphere;
      if (!bs) return;
      const key = (mesh.userData as { matKey?: MatKey }).matKey;
      const detail = key !== undefined && DETAIL_KEYS.has(key);
      // Trim never casts a shadow anyone can resolve, and it is drawn once per
      // cascade if it does. Dropping it from the shadow passes is worth more
      // than the LOD switch itself.
      if (detail) mesh.castShadow = false;
      this.add({
        object: mesh,
        centre: bs.center.clone().applyMatrix4(mesh.matrixWorld),
        radius: bs.radius * 1.02,
        maxDistance: detail ? 46 : 1000,
      });
      box.expandByPoint(bs.center);
    });
  }

  addPropCluster(cluster: PropCluster): void {
    for (const mesh of cluster.meshes) {
      this.add({
        object: mesh,
        centre: cluster.centre.clone(),
        radius: cluster.radius,
        maxDistance: cluster.cullDistance,
      });
    }
  }

  private rebuildCells(): void {
    this.cells.clear();
    for (const c of this.cullables) {
      const key = `${Math.floor(c.centre.x / CELL)},${Math.floor(c.centre.z / CELL)}`;
      let cell = this.cells.get(key);
      if (!cell) {
        cell = { key, centre: new THREE.Vector3(), radius: 0, items: [] };
        this.cells.set(key, cell);
      }
      cell.items.push(c);
    }
    for (const cell of this.cells.values()) {
      const box = new THREE.Box3();
      for (const it of cell.items) {
        box.expandByPoint(it.centre.clone().addScalar(it.radius));
        box.expandByPoint(it.centre.clone().addScalar(-it.radius));
      }
      box.getCenter(cell.centre);
      cell.radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    }
    this.totalObjects = this.cullables.length;
    this.dirty = false;
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (this.dirty) this.rebuildCells();
    camera.updateMatrixWorld();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    camera.getWorldPosition(this.camPos);

    const lodScale = 1 + settings.gfx.lodBias * 0.25;
    const draw = settings.gfx.drawDistance;
    let visible = 0;
    let visibleCells = 0;

    for (const cell of this.cells.values()) {
      this.sphere.center.copy(cell.centre);
      this.sphere.radius = cell.radius;
      const cellVisible = this.frustum.intersectsSphere(this.sphere);
      if (!cellVisible) {
        for (const it of cell.items) if (!it.always) it.object.visible = false;
        continue;
      }
      visibleCells++;
      for (const it of cell.items) {
        if (it.always) { it.object.visible = true; visible++; continue; }
        const d = this.camPos.distanceTo(it.centre) - it.radius;
        if (d > Math.min(it.maxDistance * lodScale, draw)) { it.object.visible = false; continue; }
        this.sphere.center.copy(it.centre);
        this.sphere.radius = it.radius;
        const on = this.frustum.intersectsSphere(this.sphere);
        it.object.visible = on;
        if (on) visible++;
      }
    }
    this.visibleObjects = visible;
    this.visibleCells = visibleCells;
  }

  /** Makes everything visible again — used before a physics or nav rebuild. */
  showAll(): void {
    for (const c of this.cullables) c.object.visible = true;
  }

  clear(): void {
    this.cullables.length = 0;
    this.cells.clear();
    this.dirty = true;
  }
}
