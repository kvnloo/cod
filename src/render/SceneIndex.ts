/**
 * Per-frame scene walk.
 *
 * Other subsystems add and remove objects freely; the renderer discovers them
 * here and takes care of the three things it needs from every mesh: the
 * material must carry the G-buffer injection, the object must publish its
 * previous world matrix for the velocity buffer, and shadow casters must be
 * separable from non-casters.
 *
 * The walk allocates nothing after the first few frames — arrays are reused and
 * per-object state lives in `userData` behind private keys.
 */

import * as THREE from 'three';
import type { MaterialPatcher, PatchOptions } from './MaterialPatch';

const PREV = '__boPrevMatrix';
const HOOKED = '__boHooked';

/**
 * `userData` flag meaning "hidden from the colour pass, but the sun can still
 * see it".
 *
 * Visibility culling and shadow casting are different questions with the same
 * answer slot: `Object3D.visible` gates both the colour pass and the shadow
 * atlas, so anything a main-camera frustum test rejects silently stops casting.
 * Whoever hides an object sets this flag when the object should still occlude
 * the sun; the index collects those separately and shows them for the duration
 * of the shadow passes.
 */
export const SHADOW_VISIBLE = '__boShadowVisible';

interface Hooked {
  [PREV]?: THREE.Matrix4;
  [HOOKED]?: boolean;
  [SHADOW_VISIBLE]?: boolean;
}

export class SceneIndex {
  readonly meshes: THREE.Mesh[] = [];
  readonly nonCasters: THREE.Object3D[] = [];
  /** Culled from the colour pass, still required by the shadow atlas. */
  readonly shadowOnly: THREE.Object3D[] = [];
  readonly pointLights: THREE.PointLight[] = [];
  readonly directionalLights: THREE.DirectionalLight[] = [];
  readonly hemisphereLights: THREE.HemisphereLight[] = [];

  private hiddenCount = 0;
  private shownCount = 0;

  constructor(private patcher: MaterialPatcher, private patchOptions: PatchOptions = {}) { }

  /** Rebuilds the index. Cheap: one traversal, no allocations in steady state. */
  scan(root: THREE.Object3D): void {
    this.meshes.length = 0;
    this.nonCasters.length = 0;
    this.shadowOnly.length = 0;
    this.pointLights.length = 0;
    this.directionalLights.length = 0;
    this.hemisphereLights.length = 0;
    this.visit(root);
  }

  private visit(o: THREE.Object3D): void {
    if (!o.visible) {
      // Hidden, but flagged as still occluding the sun. Collected here and shown
      // for the shadow passes only; the subtree below it stays hidden, because
      // the flag is written per drawable by whoever did the hiding.
      if ((o.userData as Hooked)[SHADOW_VISIBLE] === true) this.shadowOnly.push(o);
      return;
    }

    const mesh = o as THREE.Mesh;
    if (mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
      this.meshes.push(mesh);
      this.ensureHooked(mesh);
      if (mesh.castShadow !== true) this.nonCasters.push(mesh);
    } else {
      const l = o as THREE.Light;
      if (l.isLight) {
        if ((l as THREE.PointLight).isPointLight) this.pointLights.push(l as THREE.PointLight);
        else if ((l as THREE.DirectionalLight).isDirectionalLight) this.directionalLights.push(l as THREE.DirectionalLight);
        else if ((l as THREE.HemisphereLight).isHemisphereLight) this.hemisphereLights.push(l as THREE.HemisphereLight);
      }
    }

    const kids = o.children;
    for (let i = 0; i < kids.length; i++) this.visit(kids[i]);
  }

  private ensureHooked(mesh: THREE.Mesh): void {
    const ud = mesh.userData as Hooked;
    const mats = mesh.material;

    if (Array.isArray(mats)) {
      for (let i = 0; i < mats.length; i++) this.patcher.patch(mats[i], this.patchOptions);
    } else if (mats) {
      this.patcher.patch(mats, this.patchOptions);
    }

    if (ud[HOOKED]) return;
    ud[HOOKED] = true;
    ud[PREV] = new THREE.Matrix4().copy(mesh.matrixWorld);

    const previous = mesh.onBeforeRender;
    const patcher = this.patcher;
    mesh.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      previous.call(this, renderer, scene, camera, geometry, material, group);
      const prev = (this.userData as Hooked)[PREV];
      if (prev) patcher.setPrevMatrix(material, prev);
    };
  }

  /** Latches this frame's transforms so next frame can compute velocity. */
  latchPrevious(): void {
    const list = this.meshes;
    for (let i = 0; i < list.length; i++) {
      const ud = list[i].userData as Hooked;
      ud[PREV]?.copy(list[i].matrixWorld);
    }
  }

  /**
   * Swaps the scene graph into its shadow-pass configuration: non-casters out,
   * off-screen casters in. Paired with `restoreNonCasters`, which must be called
   * before anything else reads `visible`.
   */
  hideNonCasters(): void {
    const hide = this.nonCasters;
    this.hiddenCount = hide.length;
    for (let i = 0; i < hide.length; i++) hide[i].visible = false;
    const show = this.shadowOnly;
    this.shownCount = show.length;
    for (let i = 0; i < show.length; i++) show[i].visible = true;
  }

  restoreNonCasters(): void {
    const hide = this.nonCasters;
    for (let i = 0; i < this.hiddenCount; i++) hide[i].visible = true;
    this.hiddenCount = 0;
    const show = this.shadowOnly;
    for (let i = 0; i < this.shownCount; i++) show[i].visible = false;
    this.shownCount = 0;
  }
}
