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

interface Hooked {
  [PREV]?: THREE.Matrix4;
  [HOOKED]?: boolean;
}

export class SceneIndex {
  readonly meshes: THREE.Mesh[] = [];
  readonly nonCasters: THREE.Object3D[] = [];
  readonly pointLights: THREE.PointLight[] = [];
  readonly directionalLights: THREE.DirectionalLight[] = [];
  readonly hemisphereLights: THREE.HemisphereLight[] = [];

  private hiddenCount = 0;

  constructor(private patcher: MaterialPatcher, private patchOptions: PatchOptions = {}) { }

  /** Rebuilds the index. Cheap: one traversal, no allocations in steady state. */
  scan(root: THREE.Object3D): void {
    this.meshes.length = 0;
    this.nonCasters.length = 0;
    this.pointLights.length = 0;
    this.directionalLights.length = 0;
    this.hemisphereLights.length = 0;
    this.visit(root);
  }

  private visit(o: THREE.Object3D): void {
    if (!o.visible) return;

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

  /** Temporarily hides everything that must not appear in the shadow atlas. */
  hideNonCasters(): void {
    const list = this.nonCasters;
    this.hiddenCount = list.length;
    for (let i = 0; i < list.length; i++) list[i].visible = false;
  }

  restoreNonCasters(): void {
    const list = this.nonCasters;
    for (let i = 0; i < this.hiddenCount; i++) list[i].visible = true;
    this.hiddenCount = 0;
  }
}
