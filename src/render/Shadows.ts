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
 *
 * ## Two depth materials, not one
 *
 * The atlas is drawn with `scene.overrideMaterial`, which is the cheapest thing
 * a depth pass can do: one program, one uniform block, no per-mesh state. It is
 * also blind to alpha, so every alpha-cut card in the level — foliage, ivy,
 * bar grating, chainlink — used to be *excluded from casting altogether*
 * (`Scatter.ts` / `Chunk.ts` both zero `castShadow` for them) because the
 * alternative was a solid black quad under every bush and a plywood panel where
 * a wire fence should be.
 *
 * So the fast path stays exactly as it was, and alpha-cut geometry opts out of
 * it. three's `Material.allowOverride` flag lets one material refuse the scene
 * override, so each alpha-cut material gets a matching depth variant that
 * reproduces its own alpha lookup — triplanar or uv, with the same per-instance
 * jitter — and discards below the same threshold.
 *
 * On the shipped level that is 17 meshes carrying 299 instances paying one
 * texture fetch and a discard, against ~1475 atlas draws that pay nothing. The
 * measured price is +61 draws and +4% of atlas draw time; what it buys is a
 * chainlink fence that throws a mesh pattern and a bush that throws dapple.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';
import { materialUniforms } from '../material/MaterialShaders';
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

/** Debug/API rounding — keep cascade dumps compact and stable across frames. */
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

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
  /**
   * Cap how many cascade tiles are re-submitted this call. `0` / omitted =
   * all cascades (showcase / ultra). Adaptive high uses `1` so a multi-
   * cascade atlas never owns a single wall frame.
   */
  maxCascadesThisFrame?: number;
  /**
   * Soft CPU budget in ms for this rebuild. When > 0, stop after finishing
   * the cascade that crossed the budget and resume from the next tile on a
   * later call. `0` / omitted = no budget.
   */
  maxMs?: number;
}

/* --------------------------------------------------------- alpha casters -- */

/**
 * Sun elevation the caster budget is authored against, as a tangent.
 *
 * Mirrors `SHADOW_TAN` / `MIN_SHADOW` in `src/world/props/Scatter.ts`, which is
 * where the same test is applied to solid props. It is duplicated rather than
 * imported because the two live in different packages and the renderer must not
 * depend on the level's prop tables — but the numbers must agree, or a bush
 * would be adopted here on a rule the brick beside it fails.
 *
 * The level's hero hour puts the sun at 32.4°, so an object throws
 * `height / tan(32.4°)` across the ground. 12 cm of projected shadow is the
 * floor worth an atlas draw: comfortably above the 0.9 / 2.0 / 4.9 cm texel
 * footprints of the first three cascades, and about a fist at 3 m.
 */
const SHADOW_TAN = 0.635;
const MIN_SHADOW = 0.12;
/** 7.6 cm. Below this a card is lying on the surface that receives its shadow. */
const MIN_CASTER_HEIGHT = MIN_SHADOW * SHADOW_TAN;

/** Frames between full scene walks looking for newly built alpha-cut geometry. */
const RESCAN_INTERVAL = 90;

/** How many instances of a cluster are measured for the height gate. */
const HEIGHT_SAMPLES = 64;

/** One adopted alpha-cut caster and the state needed to put it back. */
interface AlphaCaster {
  mesh: THREE.Mesh;
  /** Alpha-tested depth variant of `source`, shared by every mesh using it. */
  depth: THREE.Material;
  /** The mesh's own material, restored the moment the atlas is done. */
  source: THREE.Material;
  /** `castShadow` as the level authored it, restored if the path is disabled. */
  authored: boolean;
  /** Tallest instance, world space, metres. */
  height: number;
}

const ALPHA_VERT_PARS = /* glsl */ `
#ifdef OBS_TRIPLANAR
  varying vec3 vObsWorld;
  varying vec3 vObsNormal;
#endif
#ifdef OBS_INSTANCE_VAR
  attribute vec4 obVar;
  varying float vObsVar;
#endif
`;

const ALPHA_VERT_BODY = /* glsl */ `
#ifdef OBS_TRIPLANAR
  {
    vec4 obsP = vec4(transformed, 1.0);
    vec3 obsN = normal;
    #ifdef USE_INSTANCING
      obsP = instanceMatrix * obsP;
      obsN = mat3(instanceMatrix) * obsN;
    #endif
    vObsWorld = (modelMatrix * obsP).xyz;
    vObsNormal = normalize(mat3(modelMatrix) * obsN);
  }
#endif
#ifdef OBS_INSTANCE_VAR
  vObsVar = obVar.w;
#endif
`;

const ALPHA_FRAG_PARS = /* glsl */ `
#ifdef OBS_TRIPLANAR
  varying vec3 vObsWorld;
  varying vec3 vObsNormal;
  uniform float obTileScale;
  uniform float obTriSharp;
#endif
#ifdef OBS_INSTANCE_VAR
  varying float vObsVar;
#endif
`;

/**
 * The cut-out, evaluated exactly the way the lit material evaluates it.
 *
 * `MaterialShaders.ts` puts the mask in the albedo map's alpha channel and
 * reads it through whichever mapping the archetype uses: world-space triplanar
 * for grating, plain uv for foliage cards, both offset by the per-instance
 * jitter in `obVar.w`. Sampling it any other way would put a shadow on the
 * ground that does not match the object standing over it, which is worse than
 * no shadow — so this block is a transcription, not an approximation.
 */
const ALPHA_FRAG_TEST = /* glsl */ `
#ifdef USE_ALPHATEST
  {
    #ifdef OBS_INSTANCE_VAR
      float obsJ = vObsVar;
    #else
      float obsJ = 0.0;
    #endif
    #ifdef OBS_TRIPLANAR
      vec3 obsN = normalize(vObsNormal);
      vec3 obsW = pow(abs(obsN), vec3(obTriSharp));
      obsW /= (obsW.x + obsW.y + obsW.z + 1e-5);
      vec3 obsS = sign(obsN + vec3(1e-6));
      vec3 obsP = vObsWorld * obTileScale + obsJ;
      float obsA =
          texture2D(map, vec2(-obsP.z * obsS.x, obsP.y)).a * obsW.x
        + texture2D(map, vec2( obsP.x, -obsP.z * obsS.y)).a * obsW.y
        + texture2D(map, vec2( obsP.x * obsS.z, obsP.y)).a * obsW.z;
    #else
      float obsA = texture2D(map, vMapUv + obsJ).a;
    #endif
    if (obsA < alphaTest) discard;
  }
#endif
`;

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
  private readonly origin = new THREE.Vector3(0, 0, 0);
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly lightBasis = new THREE.Matrix4();
  private readonly lightBasisInv = new THREE.Matrix4();
  private readonly invProj = new THREE.Matrix4();
  private readonly instM = new THREE.Matrix4();
  private readonly instBox = new THREE.Box3();

  /* --- alpha-cut casters */
  private alphaWanted = true;
  private alphaActive = false;
  /** Debug-only: adopt the cards but cast them through the opaque fast path. */
  private alphaSolid = false;
  private alphaCasters: AlphaCaster[] = [];
  /** Alpha-cut geometry the height gate turned down, kept for the census. */
  private alphaRejected: { name: string; height: number; instances: number }[] = [];
  private readonly alphaRecords = new WeakMap<THREE.Mesh, AlphaCaster>();
  private readonly alphaDepthCache = new WeakMap<THREE.Material, THREE.Material | null>();
  private readonly alphaHeights = new WeakMap<THREE.Mesh, number>();
  private readonly alphaOwned: THREE.Material[] = [];
  private frame = 0;
  private lastCalls = 0;
  private lastTriangles = 0;
  /** Draw calls and triangles attributed to each cascade of the last build. */
  private readonly cascadeCalls: number[] = [0, 0, 0, 0];
  private readonly cascadeTris: number[] = [0, 0, 0, 0];
  /** Next cascade tile to refresh when the caller time-slices the atlas. */
  private nextCascade = 0;
  private readonly auditFrustum = new THREE.Frustum();
  private readonly auditSphere = new THREE.Sphere();
  private rescanMs = 0;
  private rescans = 0;
  private last: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    sunDir: THREE.Vector3;
    index: SceneIndex;
    cfg: ShadowConfig;
  } | null = null;

  init(renderer: THREE.WebGLRenderer, uniforms: RenderUniforms): void {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.depthMaterial = skipPatch(new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      side: THREE.DoubleSide,
    }));
    this.depthMaterial.colorWrite = false;
    this.installDebugHandle();

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
    this.nextCascade = 0;

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

    this.last = { scene, camera, sunDir, index, cfg };
    this.syncAlphaCasters(scene);

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
    this.lightBasis.lookAt(this.origin, this.tmpV, this.up);
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
    // Full-atlas clear only when every cascade will be rewritten this call.
    // Time-sliced updates clear per-tile so sibling cascades keep last frame.
    const willSlice = (cfg.maxCascadesThisFrame && cfg.maxCascadesThisFrame > 0
      && cfg.maxCascadesThisFrame < count) || (cfg.maxMs && cfg.maxMs > 0 && count > 1);
    if (!willSlice) {
      renderer.clear(true, true, false);
    }

    scene.overrideMaterial = this.depthMaterial;
    scene.background = null;
    index.hideNonCasters();
    this.bindAlphaCasters();

    const callsBefore = renderer.info.render.calls;
    const trisBefore = renderer.info.render.triangles;

    // Always refit + publish every cascade's matrices so a time-sliced tile
    // still samples against an up-to-date light frustum for the other bands
    // (their depth remains last frame's, which is the whole point of slicing).
    let prevSplit = near;
    for (let i = 0; i < count; i++) {
      const c = this.cascades[i];
      c.near = prevSplit;
      // Overlap slightly so the blend band always has valid data in both maps.
      c.far = splits[i] * 1.04;
      this.fitCascade(c, camera, sunDir);
      prevSplit = splits[i];
      this.publish(i, c, splits[i]);
    }

    const maxN = cfg.maxCascadesThisFrame && cfg.maxCascadesThisFrame > 0
      ? Math.min(count, Math.round(cfg.maxCascadesThisFrame))
      : count;
    const budgetMs = cfg.maxMs && cfg.maxMs > 0 ? cfg.maxMs : 0;
    const tBuild = budgetMs > 0 ? performance.now() : 0;
    let drawn = 0;
    let start = count <= 1 ? 0 : (this.nextCascade % count);

    for (let n = 0; n < maxN; n++) {
      const i = (start + n) % count;
      const c = this.cascades[i];
      const px = Math.round(c.tile.x * this.atlasWidth);
      const py = Math.round(c.tile.y * this.atlasHeight);
      renderer.setViewport(px, py, this.mapSize, this.mapSize);
      renderer.setScissor(px, py, this.mapSize, this.mapSize);
      renderer.setScissorTest(true);
      // Per-tile clear only when the full atlas was not cleared above (slice).
      if (willSlice) renderer.clear(true, true, false);
      const cc = renderer.info.render.calls;
      const ct = renderer.info.render.triangles;
      renderer.render(scene, c.camera);
      this.cascadeCalls[i] = renderer.info.render.calls - cc;
      this.cascadeTris[i] = renderer.info.render.triangles - ct;
      drawn++;
      this.nextCascade = (i + 1) % count;
      if (budgetMs > 0 && (performance.now() - tBuild) >= budgetMs) break;
    }
    void drawn;

    this.lastCalls = renderer.info.render.calls - callsBefore;
    this.lastTriangles = renderer.info.render.triangles - trisBefore;

    this.unbindAlphaCasters();
    index.restoreNonCasters();
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.atlasWidth, this.atlasHeight);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    // Sun angular radius: 0.265° physically (tan = 0.00463). `softness` opens it
    // up a little so the penumbra grows visibly with occluder height without
    // needing a 16k map, but only to ~0.6° — roughly twice the real sun.
    //
    // The previous 4.5x opening put the penumbra of a lamppost at 17 cm and of a
    // roofline at over half a metre. Combined with the old 10 cm filter floor
    // that turned every shadow in the level into a soft grey field with no
    // readable edge, which is exactly what "it is daylight and nothing casts a
    // shadow" describes.
    const angular = 0.0047 * (1 + 1.2 * THREE.MathUtils.clamp(cfg.softness, 0, 1));
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
    //
    // `lightBasis` is the light *camera's* world matrix (its columns are the
    // shadow map's X/Y/Z axes in world space), so world -> light space is the
    // inverse. Snapping with `lightBasis` instead quantised along the transposed
    // axes: a perfectly valid grid, just not the one the shadow texels sit on,
    // so the map still crawled by a fraction of a texel every frame and every
    // shadow edge shimmered under TAA.
    const texelsPerUnit = this.mapSize / (radius * 2);
    this.tmpV.copy(this.centre).applyMatrix4(this.lightBasisInv);
    this.tmpV.x = Math.floor(this.tmpV.x * texelsPerUnit) / texelsPerUnit;
    this.tmpV.y = Math.floor(this.tmpV.y * texelsPerUnit) / texelsPerUnit;
    this.tmpV.applyMatrix4(this.lightBasis);
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

  /* ------------------------------------------------------- alpha casters -- */

  /**
   * Keeps the adopted-caster list in step with the scene.
   *
   * A full walk is cheap (one `traverse`, a `WeakMap` hit per mesh) but not
   * free, and the set only changes when the world builds or a district streams
   * in, so it runs on a slow cadence. Measured on the shipped level: 0.075-0.09
   * ms per walk in steady state, once every 30 frames — 0.003 ms/frame, against
   * an atlas that costs 5.1 ms.
   *
   * It has to be a walk of the whole graph rather than of `SceneIndex.meshes`: a
   * bush that has never once been inside the main camera's frustum is exactly
   * the bush whose shadow should already be lying across the plaza when the
   * player turns round.
   */
  private syncAlphaCasters(scene: THREE.Scene): void {
    // Alpha-cut casters cost ~60 extra atlas draws and a material swap per mesh.
    // Keep them on ultra/cinematic where the player opted into uncapped cost;
    // high/medium already struggle on CPU submit of the solid casters alone.
    const want = this.alphaWanted
      && (settings.preset === 'ultra' || settings.preset === 'cinematic');
    if (!want) {
      if (this.alphaActive) this.releaseAlphaCasters();
      this.frame = 0;
      return;
    }
    const due = !this.alphaActive || this.frame % RESCAN_INTERVAL === 0;
    this.frame++;
    if (!due) return;
    this.alphaActive = true;
    const t0 = performance.now();

    const found = this.alphaCasters;
    found.length = 0;
    this.alphaRejected.length = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const source = mesh.material;
      if (!source || Array.isArray(source)) return;
      const depth = this.alphaDepthFor(source);
      if (!depth) return;

      let height = this.alphaHeights.get(mesh);
      if (height === undefined) {
        height = this.casterHeight(mesh);
        this.alphaHeights.set(mesh, height);
      }
      // Flat ground furniture — drain grates, floor plates — lies *on* the
      // surface that would receive its shadow. It projects nothing and
      // self-shadows into acne, so it stays out however cheap the test is.
      if (height < MIN_CASTER_HEIGHT) {
        const inst = mesh as THREE.InstancedMesh;
        this.alphaRejected.push({
          name: mesh.name,
          height: Math.round(height * 1000) / 1000,
          instances: inst.isInstancedMesh === true ? inst.count : 1,
        });
        return;
      }

      let rec = this.alphaRecords.get(mesh);
      if (!rec) {
        rec = { mesh, depth, source, authored: mesh.castShadow === true, height };
        this.alphaRecords.set(mesh, rec);
      } else {
        rec.depth = depth;
        rec.source = source;
        rec.height = height;
      }
      // Culling reads `castShadow` to decide whether an off-screen object is
      // still worth publishing to the atlas, so the adoption has to be visible
      // there and not only inside this file.
      mesh.castShadow = true;
      found.push(rec);
    });
    this.rescanMs = performance.now() - t0;
    this.rescans++;
  }

  /** Hands every adopted mesh back to the level exactly as it was authored. */
  private releaseAlphaCasters(): void {
    for (let i = 0; i < this.alphaCasters.length; i++) {
      const c = this.alphaCasters[i];
      c.mesh.material = c.source;
      c.mesh.castShadow = c.authored;
    }
    this.alphaCasters.length = 0;
    this.alphaActive = false;
  }

  private bindAlphaCasters(): void {
    if (this.alphaSolid) return;
    const list = this.alphaCasters;
    for (let i = 0; i < list.length; i++) list[i].mesh.material = list[i].depth;
  }

  private unbindAlphaCasters(): void {
    if (this.alphaSolid) return;
    const list = this.alphaCasters;
    for (let i = 0; i < list.length; i++) list[i].mesh.material = list[i].source;
  }

  /**
   * The alpha-tested depth variant of a material, or null if it does not need
   * one. Cached per source material — three shares the compiled program across
   * every material with the same define set, so the whole level costs at most
   * one extra program per mapping mode.
   */
  private alphaDepthFor(source: THREE.Material): THREE.Material | null {
    const hit = this.alphaDepthCache.get(source);
    if (hit !== undefined) return hit;

    const std = source as THREE.MeshStandardMaterial;
    // Transparent materials (glass) are not cut-outs: they have no threshold to
    // test against, and they are excluded from casting on purpose.
    if (!(std.alphaTest > 0) || std.transparent === true) {
      this.alphaDepthCache.set(source, null);
      return null;
    }
    // Textures are generated on the GPU at boot; a material seen before its
    // maps exist is not a permanent negative, so it is deliberately not cached.
    const map = std.map;
    if (!map) return null;

    const defines = (std.defines ?? {}) as Record<string, string>;
    const triplanar = defines.OB_TRIPLANAR === '1';
    const instanceVar = defines.OB_INSTANCE_VAR === '1';
    const u = materialUniforms(std);
    // Two mappings this pass cannot reproduce, and would rather refuse than
    // approximate — a shadow whose holes are in different places from the
    // object's own holes is worse than no shadow at all:
    //
    //  - `OB_UV_VARY` recovers a per-panel id from screen-space derivatives of
    //    the uv, which a depth-only pass does not have the same view of.
    //  - a material extended without its uniform block has no tile scale, so the
    //    triplanar lookup has no world frequency to sample at.
    //
    // Nothing in the shipped catalogue hits either: the only `uvVariation`
    // material with an alpha channel is glass, which is transparent and excluded
    // above. (`OB_POM` is not refused — it displaces the uv by at most the
    // material's own height scale, well under a shadow texel.)
    if (defines.OB_UV_VARY === '1' || (triplanar && !u)) {
      this.alphaDepthCache.set(source, null);
      return null;
    }

    const mat = skipPatch(new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      side: THREE.DoubleSide,
      alphaTest: std.alphaTest,
      map,
    }));
    mat.colorWrite = false;
    // The one line that makes this possible: `scene.overrideMaterial` is what
    // the opaque fast path is built on, and this material declines it.
    mat.allowOverride = false;
    mat.name = `csm:alpha:${std.name || 'material'}`;

    const defs: Record<string, string> = {};
    if (triplanar) defs.OBS_TRIPLANAR = '1';
    if (instanceVar) defs.OBS_INSTANCE_VAR = '1';
    mat.defines = defs;

    mat.onBeforeCompile = (shader) => {
      if (u) {
        shader.uniforms.obTileScale = u.obTileScale;
        shader.uniforms.obTriSharp = u.obTriSharp;
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${ALPHA_VERT_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${ALPHA_VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${ALPHA_FRAG_PARS}`)
        // The stock chunk samples the albedo map a second time, at the uv the
        // triplanar path does not use, to build a colour this pass never writes.
        .replace('#include <map_fragment>', '')
        .replace('#include <alphatest_fragment>', ALPHA_FRAG_TEST);
    };
    const key = `csm-alpha|${triplanar ? 'tri' : 'uv'}|${instanceVar ? 'var' : 'flat'}`;
    mat.customProgramCacheKey = () => key;

    this.alphaOwned.push(mat);
    this.alphaDepthCache.set(source, mat);
    return mat;
  }

  /**
   * World-space height of the tallest instance, which is what decides whether
   * this thing projects anything on to the ground.
   *
   * Planar radius is deliberately not consulted: a wide flat plate does not
   * lengthen a shadow, it only widens one that is already coincident with the
   * floor underneath it.
   */
  private casterHeight(mesh: THREE.Mesh): number {
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return 0;

    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh === true && inst.count > 0) {
      let best = 0;
      const step = Math.max(1, Math.ceil(inst.count / HEIGHT_SAMPLES));
      for (let i = 0; i < inst.count; i += step) {
        inst.getMatrixAt(i, this.instM);
        this.instM.premultiply(mesh.matrixWorld);
        this.instBox.copy(bb).applyMatrix4(this.instM);
        best = Math.max(best, this.instBox.max.y - this.instBox.min.y);
      }
      return best;
    }
    this.instBox.copy(bb).applyMatrix4(mesh.matrixWorld);
    return this.instBox.max.y - this.instBox.min.y;
  }

  /**
   * Automation handle, mirroring `__RENDER__`. Nothing in the frame loop reads
   * it; it exists so an acceptance script can A/B the alpha path against the
   * exact build it is grading instead of against a different one.
   */
  private installDebugHandle(): void {
    (globalThis as unknown as Record<string, unknown>).__SHADOWS__ = {
      /**
       * `true` ships. `false` is the pre-wave behaviour (cards excluded from
       * the atlas). `'solid'` adopts them but casts them through the opaque
       * override — the black-rectangle-under-every-bush failure this whole
       * path exists to avoid, kept renderable so the A/B can show it.
       */
      setAlpha: (mode: boolean | string) => {
        this.alphaSolid = mode === 'solid';
        this.alphaWanted = mode !== false;
      },
      state: () => ({
        wanted: this.alphaWanted,
        solid: this.alphaSolid,
        active: this.alphaActive,
        meshes: this.alphaCasters.length,
        instances: this.alphaCasters.reduce((n, c) => {
          const inst = c.mesh as THREE.InstancedMesh;
          return n + (inst.isInstancedMesh === true ? inst.count : 1);
        }, 0),
        rejected: this.alphaRejected.slice(),
        atlasCalls: this.lastCalls,
        atlasTriangles: this.lastTriangles,
        rescanMs: this.rescanMs,
        rescans: this.rescans,
        rescanInterval: RESCAN_INTERVAL,
      }),
      census: () => this.alphaCasters.map((c) => {
        const inst = c.mesh as THREE.InstancedMesh;
        this.instBox.setFromObject(c.mesh);
        const r3 = (v: number) => Math.round(v * 100) / 100;
        return {
          name: c.mesh.name,
          material: c.source.name,
          instances: inst.isInstancedMesh === true ? inst.count : 1,
          height: Math.round(c.height * 1000) / 1000,
          triplanar: ((c.depth.defines ?? {}) as Record<string, string>).OBS_TRIPLANAR === '1',
          visible: c.mesh.visible,
          box: [
            r3(this.instBox.min.x), r3(this.instBox.min.y), r3(this.instBox.min.z),
            r3(this.instBox.max.x), r3(this.instBox.max.y), r3(this.instBox.max.z),
          ],
        };
      }),
      /** World positions of every instance of the adopted meshes matching `q`. */
      locate: (q: string) => {
        const out: { name: string; at: number[] }[] = [];
        for (const c of this.alphaCasters) {
          if (!c.mesh.name.includes(q)) continue;
          const inst = c.mesh as THREE.InstancedMesh;
          const n = inst.isInstancedMesh === true ? inst.count : 1;
          for (let i = 0; i < n; i++) {
            if (inst.isInstancedMesh === true) {
              inst.getMatrixAt(i, this.instM);
              this.instM.premultiply(c.mesh.matrixWorld);
            } else {
              this.instM.copy(c.mesh.matrixWorld);
            }
            this.tmpV.setFromMatrixPosition(this.instM);
            out.push({
              name: c.mesh.name,
              at: [
                Math.round(this.tmpV.x * 100) / 100,
                Math.round(this.tmpV.y * 100) / 100,
                Math.round(this.tmpV.z * 100) / 100,
              ],
            });
          }
        }
        return out;
      },
      bench: (iters?: number, cfg?: Partial<ShadowConfig>) => this.bench(iters ?? 40, cfg),
      audit: (q?: string) => this.audit(q),
      cascades: () => this.cascades.slice(0, this.cascadeCount).map((c, i) => ({
        i,
        near: round2(c.near),
        far: round2(c.far),
        radius: round2(c.radius),
        texel: round3(c.radius * 2 / this.mapSize),
        centre: [
          round2(c.camera.position.x),
          round2(c.camera.position.y),
          round2(c.camera.position.z),
        ],
        calls: this.cascadeCalls[i],
        triangles: this.cascadeTris[i],
      })),
    };
  }

  /**
   * Answers "what actually reaches the atlas, and from which cascade" without
   * a GPU readback.
   *
   * The whole bearing-dependency class of bug lives between three predicates —
   * `visible` at atlas time, `castShadow`, and each cascade's own frustum test —
   * and every one of them is a CPU-side fact. This replays the exact scene state
   * the depth passes see (`hideNonCasters` + the alpha binding), walks the graph
   * the same way three's `projectObject` does, and reports per mesh which
   * cascades would draw it. A caster that shows here and still throws nothing is
   * a shading bug; one that does not show is a visibility bug, and the two have
   * never once had the same fix.
   */
  private audit(query?: string): unknown {
    const l = this.last;
    if (!l) return null;
    l.index.hideNonCasters();
    this.bindAlphaCasters();

    const count = this.cascadeCount;
    const frustums: THREE.Frustum[] = [];
    for (let i = 0; i < count; i++) {
      const cam = this.cascades[i].camera;
      const f = new THREE.Frustum();
      f.setFromProjectionMatrix(this.tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      frustums.push(f);
    }

    const perCascade = new Array(count).fill(0);
    const hits: { name: string; cascades: number[]; instances: number; centre: number[]; radius: number }[] = [];
    let casters = 0;
    let hidden = 0;
    let noCast = 0;

    const walk = (o: THREE.Object3D): void => {
      if (!o.visible) { hidden++; return; }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh === true) {
        if (mesh.castShadow !== true) noCast++;
        else if (l.camera.layers.test(mesh.layers) || mesh.layers.test(this.cascades[0].camera.layers)) {
          casters++;
          const inst = mesh as THREE.InstancedMesh;
          const bs = inst.isInstancedMesh === true
            ? (inst.boundingSphere ?? (inst.computeBoundingSphere(), inst.boundingSphere))
            : (mesh.geometry.boundingSphere ?? (mesh.geometry.computeBoundingSphere(), mesh.geometry.boundingSphere));
          const seen: number[] = [];
          if (bs) {
            this.auditSphere.copy(bs).applyMatrix4(mesh.matrixWorld);
            for (let i = 0; i < count; i++) {
              const on = mesh.frustumCulled === false || frustums[i].intersectsSphere(this.auditSphere);
              if (on) { seen.push(i); perCascade[i]++; }
            }
          }
          if (query === undefined || mesh.name.includes(query)) {
            hits.push({
              name: mesh.name,
              cascades: seen,
              instances: inst.isInstancedMesh === true ? inst.count : 1,
              centre: [
                round2(this.auditSphere.center.x),
                round2(this.auditSphere.center.y),
                round2(this.auditSphere.center.z),
              ],
              radius: round2(this.auditSphere.radius),
            });
          }
        }
      }
      const kids = o.children;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(l.scene);

    this.unbindAlphaCasters();
    l.index.restoreNonCasters();
    return { casters, hidden, noCast, perCascade, drawn: this.cascadeCalls.slice(0, count), hits };
  }

  /**
   * Times the atlas on its own.
   *
   * Frame time cannot answer "what did this cost the shadow pass" — the atlas is
   * a few percent of it. This re-renders the atlas `iters` times from the last
   * frame's arguments and blocks on `finish()`, so the number returned is submit
   * plus GPU for the depth passes and nothing else.
   */
  private bench(iters: number, override?: Partial<ShadowConfig>): unknown {
    const l = this.last;
    if (!l) return null;
    const gl = this.renderer.getContext();
    const cfg = override ? { ...l.cfg, ...override } : l.cfg;
    const once = (n: number) => {
      const calls = this.renderer.info.render.calls;
      const tris = this.renderer.info.render.triangles;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) this.render(l.scene, l.camera, l.sunDir, l.index, cfg);
      gl.finish();
      const ms = (performance.now() - t0) / n;
      return {
        ms,
        calls: (this.renderer.info.render.calls - calls) / n,
        triangles: (this.renderer.info.render.triangles - tris) / n,
      };
    };
    once(Math.min(10, iters));
    return once(iters);
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
    this.releaseAlphaCasters();
    for (const m of this.alphaOwned) m.dispose();
    this.alphaOwned.length = 0;
    this.last = null;
    this.target?.dispose();
    this.depthTexture?.dispose();
    this.depthMaterial.dispose();
  }
}
