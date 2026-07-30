/**
 * Cascaded shadow maps with PCSS soft shadows.
 *
 * Four cascades packed into one depth atlas, split with the practical
 * (logarithmic/uniform blend) scheme. Each cascade is fitted to the bounding
 * *sphere* of its frustum slice — the radius is then invariant under camera
 * rotation — and the light-space origin is snapped to whole texels so shadows
 * do not crawl when the player walks or turns.
 *
 * Filtering is a real PCSS: a blocker search estimates the average occluder
 * depth, the penumbra width follows from the sun's angular size, and the PCF
 * kernel widens to match. Bias is normal-offset plus slope-scaled, both scaled
 * by the cascade's world texel size so cascade 0 is tight and cascade 3 is
 * forgiving.
 */

import * as THREE from 'three';
import { skipPatch } from './MaterialPatch';
import type { RenderUniforms } from './RenderUniforms';
import { CSM_MAX } from './RenderUniforms';
import type { SceneIndex } from './SceneIndex';

const BIAS_MATRIX = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

interface Cascade {
  camera: THREE.OrthographicCamera;
  near: number;
  far: number;
  radius: number;
  tile: THREE.Vector4;
}

export interface ShadowConfig {
  cascades: number;
  mapSize: number;
  distance: number;
  softness: number;
  lambda: number;
}

export class ShadowSystem {
  private renderer!: THREE.WebGLRenderer;
  private uniforms!: RenderUniforms;

  private target: THREE.WebGLRenderTarget | null = null;
  private depthTexture: THREE.DepthTexture | null = null;
  private depthMaterial!: THREE.MeshDepthMaterial;

  private cascades: Cascade[] = [];
  private atlasWidth = 0;
  private atlasHeight = 0;
  private cascadeCount = 0;
  private mapSize = 0;

  /** Scratch — never allocate inside the frame. */
  private readonly corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  private readonly centre = new THREE.Vector3();
  private readonly lightPos = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly lightBasis = new THREE.Matrix4();
  private readonly lightBasisInv = new THREE.Matrix4();
  private readonly invProj = new THREE.Matrix4();

  init(renderer: THREE.WebGLRenderer, uniforms: RenderUniforms): void {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.depthMaterial = skipPatch(new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      side: THREE.DoubleSide,
    }));
    this.depthMaterial.colorWrite = false;

    for (let i = 0; i < CSM_MAX; i++) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      cam.layers.set(0);
      cam.matrixAutoUpdate = false;
      this.cascades.push({
        camera: cam, near: 0.1, far: 10, radius: 1, tile: new THREE.Vector4(),
      });
    }
  }

  /** (Re)allocates the atlas when the cascade count or resolution changes. */
  configure(cfg: ShadowConfig): void {
    const count = THREE.MathUtils.clamp(Math.round(cfg.cascades), 1, CSM_MAX);
    const size = Math.max(256, Math.round(cfg.mapSize));
    const cols = count > 1 ? 2 : 1;
    const rows = count > 2 ? 2 : 1;
    const w = size * cols;
    const h = size * rows;

    if (this.target && this.atlasWidth === w && this.atlasHeight === h && this.cascadeCount === count) {
      return;
    }

    this.target?.dispose();
    this.depthTexture?.dispose();

    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = 'csm:depth';

    const target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      generateMipmaps: false,
    });
    target.texture.name = 'csm:dummy';

    this.target = target;
    this.depthTexture = depth;
    this.atlasWidth = w;
    this.atlasHeight = h;
    this.cascadeCount = count;
    this.mapSize = size;

    for (let i = 0; i < count; i++) {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      this.cascades[i].tile.set(
        (cx * size) / w, (cy * size) / h,
        size / w, size / h,
      );
    }

    this.uniforms.boShadowAtlas.value = depth;
  }

  get atlas(): THREE.Texture | null { return this.depthTexture; }

  /** Disables shadows entirely (the `shadows: false` preset). */
  setDisabled(): void {
    this.uniforms.boCsmInfo.value.x = 0;
  }

  /**
   * Fits the cascades to the camera and renders the atlas.
   * `sunDir` points *from the world toward* the light.
   */
  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    sunDir: THREE.Vector3,
    index: SceneIndex,
    cfg: ShadowConfig,
  ): void {
    this.configure(cfg);
    const target = this.target;
    if (!target) return;

    const count = this.cascadeCount;
    const near = camera.near;
    const far = Math.min(cfg.distance, camera.far);
    const lambda = cfg.lambda;

    // --- practical split scheme
    const splits: number[] = [];
    for (let i = 1; i <= count; i++) {
      const p = i / count;
      const log = near * Math.pow(far / near, p);
      const uni = near + (far - near) * p;
      splits.push(lambda * log + (1 - lambda) * uni);
    }

    // Cached inverse projection for frustum-corner reconstruction.
    this.invProj.copy(camera.projectionMatrix).invert();

    // --- light basis (rotation only) used for texel snapping
    this.up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.995) this.up.set(0, 0, 1);
    this.tmpV.copy(sunDir).multiplyScalar(-1);
    this.lightBasis.lookAt(new THREE.Vector3(0, 0, 0), this.tmpV, this.up);
    this.lightBasisInv.copy(this.lightBasis).invert();

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;

    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.atlasWidth, this.atlasHeight);
    renderer.autoClear = false;
    renderer.clear(true, true, false);

    scene.overrideMaterial = this.depthMaterial;
    scene.background = null;
    index.hideNonCasters();

    let prevSplit = near;
    for (let i = 0; i < count; i++) {
      const c = this.cascades[i];
      c.near = prevSplit;
      // Overlap slightly so the blend band always has valid data in both maps.
      c.far = splits[i] * 1.04;
      this.fitCascade(c, camera, sunDir);
      prevSplit = splits[i];

      const px = Math.round(c.tile.x * this.atlasWidth);
      const py = Math.round(c.tile.y * this.atlasHeight);
      renderer.setViewport(px, py, this.mapSize, this.mapSize);
      renderer.setScissor(px, py, this.mapSize, this.mapSize);
      renderer.setScissorTest(true);
      renderer.render(scene, c.camera);

      this.publish(i, c, splits[i]);
    }

    index.restoreNonCasters();
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.atlasWidth, this.atlasHeight);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    // Sun angular radius: 0.27° physically; `softness` opens it up so shadows
    // read as soft on screen without needing a 16k shadow map.
    const angular = 0.0047 * (1 + 11 * THREE.MathUtils.clamp(cfg.softness, 0, 1));
    const info = this.uniforms.boCsmInfo.value;
    info.set(count, Math.tan(angular), far, this.mapSize);
  }

  /** Builds one cascade's orthographic camera, texel-snapped. */
  private fitCascade(c: Cascade, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3): void {
    const corners = this.corners;
    let k = 0;
    for (let ix = -1; ix <= 1; ix += 2) {
      for (let iy = -1; iy <= 1; iy += 2) {
        for (let iz = 0; iz < 2; iz++) {
          const depth = iz === 0 ? c.near : c.far;
          // NDC -> view: use the inverse projection at z = -depth.
          const v = corners[k++];
          v.set(ix, iy, -1).applyMatrix4(this.invProj);
          // v is now on the near plane in view space; scale the ray to `depth`.
          v.multiplyScalar(depth / Math.max(1e-6, -v.z));
          v.applyMatrix4(camera.matrixWorld);
        }
      }
    }

    this.centre.set(0, 0, 0);
    for (let i = 0; i < 8; i++) this.centre.add(corners[i]);
    this.centre.multiplyScalar(1 / 8);

    let radius = 0;
    for (let i = 0; i < 8; i++) radius = Math.max(radius, this.centre.distanceTo(corners[i]));
    // Quantise the radius too, otherwise floating-point jitter in the frustum
    // corners resizes the ortho box by fractions of a texel every frame.
    radius = Math.ceil(radius * 16) / 16;
    c.radius = radius;

    // --- texel snapping in light space
    const texelsPerUnit = this.mapSize / (radius * 2);
    this.tmpV.copy(this.centre).applyMatrix4(this.lightBasis);
    this.tmpV.x = Math.floor(this.tmpV.x * texelsPerUnit) / texelsPerUnit;
    this.tmpV.y = Math.floor(this.tmpV.y * texelsPerUnit) / texelsPerUnit;
    this.tmpV.applyMatrix4(this.lightBasisInv);
    this.centre.copy(this.tmpV);

    // Pull the light back far enough that casters behind the slice still write.
    const back = radius + 60;
    this.lightPos.copy(sunDir).multiplyScalar(back).add(this.centre);

    const cam = c.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.05;
    cam.far = back + radius;
    cam.updateProjectionMatrix();

    this.tmpM.lookAt(this.lightPos, this.centre, this.up);
    cam.matrixWorld.copy(this.tmpM);
    cam.matrixWorld.setPosition(this.lightPos);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.matrix.copy(cam.matrixWorld);
    cam.matrixWorldNeedsUpdate = false;
  }

  private publish(i: number, c: Cascade, splitFar: number): void {
    const u = this.uniforms;
    const m = u.boCsmMatrix.value[i];
    m.multiplyMatrices(c.camera.projectionMatrix, c.camera.matrixWorldInverse);
    m.premultiply(BIAS_MATRIX);
    u.boCsmTile.value[i].copy(c.tile);
    const extent = c.radius * 2;
    u.boCsmParams.value[i].set(
      extent,
      c.camera.far - c.camera.near,
      extent / this.mapSize,
      splitFar,
    );
  }

  dispose(): void {
    this.target?.dispose();
    this.depthTexture?.dispose();
    this.depthMaterial.dispose();
  }
}
