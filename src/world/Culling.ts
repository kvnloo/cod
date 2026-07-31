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
import { SHADOW_VISIBLE } from '../render/SceneIndex';
import type { MatKey } from './MatCatalog';
import type { PropCluster } from './props/Scatter';

const CELL = 24;

/**
 * Visibility policy. `on` is the shipping path; the rest exist so a capture
 * script can A/B what culling costs the image without recompiling.
 *
 * - `on`        — cells, frustum and distance LOD, off-screen casters still
 *                 published to the shadow atlas. The shipping path.
 * - `legacy`    — as `on`, but a frustum-culled object stops casting, which is
 *                 what the level did before. Kept so the cost of that bug is
 *                 one A/B rather than one rebuild.
 * - `noFrustum` — distance LOD only. Isolates the frustum term.
 * - `off`       — everything visible. Reference frame.
 */
export type CullMode = 'on' | 'legacy' | 'noFrustum' | 'off';

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
  /** Hidden from the main camera but still handed to the shadow atlas. */
  shadowOnlyObjects = 0;

  mode: CullMode = 'on';

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

  /**
   * Rejects what the main camera cannot see, and — separately — publishes what
   * the *sun* can still see.
   *
   * These are not the same set, and conflating them is what made the level look
   * unlit. `visible = false` is the only signal the renderer's scene walk has,
   * and it makes an object disappear from the shadow atlas as well as from the
   * frame. An object behind the camera that throws a shadow across the plaza in
   * front of it is exactly the case a frustum test gets wrong: it is irrelevant
   * to the colour pass and load-bearing for the depth pass, and hiding it opens
   * a false sunlit strip that pops shut when the player turns around.
   *
   * So the frustum term now only decides `visible`. The distance term decides
   * both, because a prop that is too far to draw is too far to shadow — the
   * failure mode there is a shadow with no object under it. Anything the
   * frustum alone rejected is flagged `SHADOW_VISIBLE`, and `SceneIndex` shows
   * it for the duration of the shadow passes only; three's own per-cascade
   * frustum cull then throws away whatever no cascade can see, which is the
   * test that was wanted in the first place.
   */
  update(camera: THREE.PerspectiveCamera): void {
    if (this.dirty) this.rebuildCells();
    camera.updateMatrixWorld();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    camera.getWorldPosition(this.camPos);

    const lodScale = 1 + settings.gfx.lodBias * 0.25;
    const draw = settings.gfx.drawDistance;
    // Past the last cascade nothing reaches the atlas anyway, so there is no
    // point un-hiding it.
    const shadowFar = Math.min(settings.gfx.shadowDistance, draw);
    const useFrustum = this.mode === 'on' || this.mode === 'legacy';
    const forceAll = this.mode === 'off';
    const publishCasters = this.mode !== 'legacy';
    let visible = 0;
    let visibleCells = 0;
    let shadowOnly = 0;

    for (const cell of this.cells.values()) {
      this.sphere.center.copy(cell.centre);
      this.sphere.radius = cell.radius;
      const cellVisible = forceAll || !useFrustum || this.frustum.intersectsSphere(this.sphere);

      for (const it of cell.items) {
        if (it.always) {
          it.object.visible = true;
          setShadowVisible(it.object, false);
          if (cellVisible) visible++;
          continue;
        }
        const d = this.camPos.distanceTo(it.centre) - it.radius;
        const inRange = forceAll || d <= Math.min(it.maxDistance * lodScale, draw);
        if (!inRange) {
          it.object.visible = false;
          setShadowVisible(it.object, false);
          continue;
        }
        let on = cellVisible;
        if (on && useFrustum) {
          this.sphere.center.copy(it.centre);
          this.sphere.radius = it.radius;
          on = this.frustum.intersectsSphere(this.sphere);
        }
        it.object.visible = on;
        if (on) { visible++; setShadowVisible(it.object, false); continue; }
        // Off-screen but in range: hand it to the shadow pass.
        const casts = publishCasters && it.object.castShadow === true && d <= shadowFar;
        setShadowVisible(it.object, casts);
        if (casts) shadowOnly++;
      }
      if (cellVisible) visibleCells++;
    }
    this.visibleObjects = visible;
    this.visibleCells = visibleCells;
    this.shadowOnlyObjects = shadowOnly;
  }

  /** Makes everything visible again — used before a physics or nav rebuild. */
  showAll(): void {
    for (const c of this.cullables) {
      c.object.visible = true;
      setShadowVisible(c.object, false);
    }
  }

  clear(): void {
    for (const c of this.cullables) setShadowVisible(c.object, false);
    this.cullables.length = 0;
    this.cells.clear();
    this.dirty = true;
  }
}

/** Writes the shadow-atlas override flag, avoiding pointless userData churn. */
function setShadowVisible(o: THREE.Object3D, on: boolean): void {
  const ud = o.userData as { [SHADOW_VISIBLE]?: boolean };
  if (on) ud[SHADOW_VISIBLE] = true;
  else if (ud[SHADOW_VISIBLE]) ud[SHADOW_VISIBLE] = false;
}
