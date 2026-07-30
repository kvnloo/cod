/**
 * RenderSystem — owns the WebGL2 context and the HDR frame graph.
 *
 * Frame:
 *   scene index → CSM atlas → depth prepass → sky + opaque + transparent into
 *   the MRT G-buffer → view model (cleared depth) → projected decals →
 *   auto-exposure histogram → post chain → tonemap/grade/present
 *
 * Everything that touches a material in the scene goes through
 * `MaterialPatcher`, so gameplay code never has to know the G-buffer exists.
 * Individual post effects live in `./passes` and are composed here; the module
 * is imported defensively so the build still works while it is being written.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import {
  LAYERS, type DecalRequest, type DynamicLightRequest, type RenderAPI, type ScreenEffectRequest,
} from './types';
import { PASS_ORDER, type AtmosphereState, type PassContext, type RenderPass } from './Pass';
import { RenderUniforms } from './RenderUniforms';
import { MaterialPatcher, skipPatch } from './MaterialPatch';
import { SceneIndex } from './SceneIndex';
import { FrameGraph } from './FrameGraph';
import { SkySystem } from './Sky';
import { ShadowSystem } from './Shadows';
import { ExposureSystem } from './Exposure';
import { LightPool } from './LightPool';
import { DecalSystem } from './Decals';
import { bakeDecalAtlas, type DecalAtlasTextures } from './DecalAtlas';
import { registerRenderDebugScene } from './DebugScene';

/* ------------------------------------------------------------- constants -- */

const MASK_WORLD_OPAQUE = (1 << LAYERS.DEFAULT) | (1 << LAYERS.NO_REFLECT) | (1 << LAYERS.BACKDROP);
const MASK_WORLD_ALL = MASK_WORLD_OPAQUE | (1 << LAYERS.TRANSPARENT) | (1 << LAYERS.MARKER);

const TONEMAP_INDEX: Record<string, number> = { agx: 0, aces: 1, reinhard: 2, none: 3 };

/** Halton(2,3) — the standard TAA jitter sequence. */
function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const JITTER: THREE.Vector2[] = Array.from({ length: 32 }, (_, i) =>
  new THREE.Vector2(halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5));

/* --------------------------------------------------------------- GPU time -- */

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

class GpuTimer {
  private ext: TimerExt | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  lastMs = 0;

  init(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  begin(): void {
    if (!this.gl || !this.ext || this.active) return;
    const q = this.gl.createQuery();
    if (!q) return;
    try {
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.active = q;
    } catch { this.ext = null; }
  }

  end(): void {
    const gl = this.gl;
    if (!gl || !this.ext || !this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  private poll(): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0];
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;
      this.pending.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.lastMs = this.lastMs * 0.7 + (ns / 1e6) * 0.3;
      }
      gl.deleteQuery(q);
    }
    // Never let the queue grow without bound if results stop arriving.
    while (this.pending.length > 6) {
      const q = this.pending.shift();
      if (q) gl.deleteQuery(q);
    }
  }
}

/* ------------------------------------------------------------------ system -- */

export class RenderSystem implements System, RenderAPI {
  readonly name = 'render';
  readonly order = ORDER.RENDER;

  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;

  /** The first-person view model renders in its own scene with a tight near
   *  plane so the weapon never clips into world geometry. */
  readonly viewModelScene = new THREE.Scene();
  readonly viewModelCamera = new THREE.PerspectiveCamera(60, 1, 0.02, 900);
  /** View-model FOV as a fraction of the world FOV. */
  viewModelFovScale = 0.78;

  readonly uniforms = new RenderUniforms();
  readonly patcher = new MaterialPatcher(this.uniforms);
  readonly graph = new FrameGraph();
  readonly sky = new SkySystem();
  readonly shadows = new ShadowSystem();
  readonly exposure = new ExposureSystem();
  readonly lights = new LightPool();
  readonly decals = new DecalSystem();

  readonly worldIndex = new SceneIndex(this.patcher, { matId: 0.5, sun: true, aerial: true });
  readonly viewModelIndex = new SceneIndex(this.patcher, { matId: 0.85, sun: false, aerial: false });

  passes: RenderPass[] = [];
  /** False when a loaded post pass already performs exposure + tonemapping. */
  ownsTonemap = true;
  /** False when a loaded post pass owns damage/flash/concussion overlays. */
  ownsScreenFx = true;
  private postScreenEffect: ((req: ScreenEffectRequest) => void) | null = null;
  private postSetWeather: ((rain: number, fog: number, wind: number) => void) | null = null;
  /** Neutralises foreign directional lights so the sky owns the sun. */
  adoptSceneLights = true;

  private _renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private frameIndex = 0;
  private elapsed = 0;
  private timer = new GpuTimer();
  private atlas: { textures: DecalAtlasTextures; dispose(): void } | null = null;
  private captureMode = false;

  /* --- camera shake --- */
  private shakeAmount = 0;
  private shakeFreq = 22;
  private shakeDecay = 3;
  private shakeTime = 0;

  /* --- focus --- */
  private focusTarget = 10;
  private focusCurrent = 10;
  private focusManual = false;
  private focusManualTimer = 0;

  /* --- view model rig --- */
  private vmKey = new THREE.DirectionalLight(0xffffff, 1);
  private vmFill = new THREE.DirectionalLight(0x9dbcff, 0.25);
  private vmRim = new THREE.DirectionalLight(0xfff0d8, 0.5);
  private vmFromWorld = new THREE.Matrix4();

  /* --- reusable scratch --- */
  private prevViewProjection = new THREE.Matrix4();
  private viewProjection = new THREE.Matrix4();
  private viewProjectionNoJitter = new THREE.Matrix4();
  private savedCamPos = new THREE.Vector3();
  private savedCamQuat = new THREE.Quaternion();
  private savedProjection = new THREE.Matrix4();
  private jitter = new THREE.Vector2();
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler();
  private tmpColor = new THREE.Color();
  private gradeVec = new THREE.Vector4(1.05, 1.03, 0.0, 0.0);
  private borrowed: THREE.WebGLRenderTarget[] = [];
  private warnedLights = false;
  private readonly atmosphere: AtmosphereState = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 1, 1),
    skyColor: new THREE.Color(0.5, 0.6, 0.75),
    skyCube: null,
    nightFactor: 0,
    weather: 0,
    shadow: {
      atlas: null,
      matrices: this.uniforms.boCsmMatrix.value,
      tiles: this.uniforms.boCsmTile.value,
      params: this.uniforms.boCsmParams.value,
      count: 0,
      distance: 0,
      strength: 1,
    },
  };

  /* ------------------------------------------------------------- lifecycle */

  /**
   * The context is created lazily on first access so systems that initialise
   * *before* the renderer (materials, world) can still generate GPU textures.
   */
  get renderer(): THREE.WebGLRenderer {
    if (this._renderer) return this._renderer;
    const canvas = this.canvas
      ?? (document.getElementById('viewport') as HTMLCanvasElement | null)
      ?? document.createElement('canvas');
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // TAA handles AA; MSAA is done on the HDR target
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // required for harness screenshots
      failIfMajorPerformanceCaveat: false,
    });
    renderer.debug.checkShaderErrors = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;  // done in the present stage
    // three's own shadow pipeline is replaced wholesale by the CSM system.
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 1);
    renderer.info.autoReset = false;
    this._renderer = renderer;

    const gl = renderer.getContext();
    if (gl instanceof WebGL2RenderingContext) this.timer.init(gl);
    return renderer;
  }

  async init(ctx: EngineContext): Promise<void> {
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.canvas = ctx.engine.canvas;
    const renderer = this.renderer;

    const params = new URLSearchParams(globalThis.location?.search ?? '');
    this.captureMode = params.get('capture') === '1';

    this.viewModelCamera.layers.enable(LAYERS.DEFAULT);
    this.viewModelCamera.layers.enable(LAYERS.VIEW_MODEL);
    this.viewModelScene.name = 'viewmodel';
    this.viewModelScene.matrixWorldAutoUpdate = true;

    this.graph.init(renderer);
    this.sky.init(renderer, this.graph.blitter, this.uniforms, { cubeSize: 256 });
    this.shadows.init(renderer, this.uniforms);
    this.exposure.init(renderer, this.graph.blitter, !this.captureMode);
    this.lights.init(this.scene, this.viewModelScene, this.lightBudget());

    this.atlas = bakeDecalAtlas(renderer, this.graph.blitter);
    this.decals.init(renderer, this.uniforms, this.atlas.textures, settings.gfx.maxDecals);

    // View-model three-point rig: key follows the sun, fill is sky-coloured,
    // rim separates the weapon silhouette from the background.
    this.vmKey.castShadow = false;
    this.vmFill.castShadow = false;
    this.vmRim.castShadow = false;
    this.viewModelScene.add(this.vmKey, this.vmKey.target);
    this.viewModelScene.add(this.vmFill, this.vmFill.target);
    this.viewModelScene.add(this.vmRim, this.vmRim.target);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.graph.resize(size.x, size.y);

    registerRenderDebugScene(this);

    bus.on('quality:changed', () => this.applyQuality());
    this.applyQuality();

    await this.loadPasses();
    this.installDebugHandle();
  }

  /**
   * Automation handle for the capture harness. Lets a script flip one render
   * feature at a time between shots so an A/B pair isolates exactly one change —
   * the only honest way to tell whether e.g. GTAO is actually contributing.
   * Read-only from the game's point of view; nothing in the frame loop uses it.
   */
  private installDebugHandle(): void {
    (globalThis as unknown as Record<string, unknown>).__RENDER__ = {
      gfx: settings.gfx,
      passes: () => this.passes.map((p) => ({ name: p.name, order: p.order, enabled: p.enabled !== false })),
      setPass: (name: string, on: boolean) => {
        for (const p of this.passes) if (p.name === name) p.enabled = on;
      },
      set: (key: string, value: unknown) => {
        (settings.gfx as unknown as Record<string, unknown>)[key] = value;
      },
      sun: () => {
        const s = this.sky.sunIlluminance;
        const sh = this.sky.shCoefficients[0];
        return {
          sun: [s.r, s.g, s.b],
          shDc: [sh.x, sh.y, sh.z],
          ambientIntensity: this.sky.ambientIntensity,
          exposure: this.exposure.exposure,
          hours: this.sky.hours,
          sunDir: this.sky.sun.direction.toArray(),
        };
      },
    };
  }

  private lightBudget(): number {
    switch (settings.preset) {
      case 'low': return 3;
      case 'medium': return 5;
      default: return 8;
    }
  }

  private applyQuality(): void {
    const g = settings.gfx;
    this.renderer.setPixelRatio(this.pixelRatio * g.renderScale);
    this.lights.setBudget(this.lightBudget());
    this.decals.setCapacity(g.maxDecals);
    this.sky.invalidate();
    this.exposure.reset();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.graph.resize(size.x, size.y);
    for (const p of this.passes) p.resize(this.graph.width, this.graph.height);
  }

  /**
   * Post passes are owned by a sibling module that may not exist yet. The glob
   * resolves to nothing when `./passes/index.ts` is absent, so the build never
   * breaks on a missing sibling.
   */
  private async loadPasses(): Promise<void> {
    const modules = import.meta.glob('./passes/index.ts') as Record<string, () => Promise<unknown>>;
    const key = Object.keys(modules)[0];
    if (!key) return;

    let mod: Record<string, unknown>;
    try {
      mod = (await modules[key]()) as Record<string, unknown>;
    } catch (err) {
      console.warn('[render] post pass module failed to load', err);
      return;
    }

    let list: unknown = null;
    const candidates = ['createPasses', 'buildPasses', 'makePasses', 'default'];
    for (const name of candidates) {
      const fn = mod[name];
      if (typeof fn === 'function') {
        try {
          list = (fn as (r: THREE.WebGLRenderer) => unknown)(this.renderer);
        } catch {
          try { list = (fn as () => unknown)(); } catch { /* keep looking */ }
        }
        if (list) break;
      }
      if (Array.isArray(fn)) { list = fn; break; }
    }
    if (!list && Array.isArray(mod.passes)) list = mod.passes;
    if (!Array.isArray(list)) {
      console.warn('[render] ./passes/index.ts exported nothing usable');
      return;
    }

    const passes: RenderPass[] = [];
    for (const item of list as RenderPass[]) {
      if (!item || typeof item.render !== 'function' || typeof item.order !== 'number') continue;
      try {
        item.setup?.(this.renderer);
        item.resize?.(this.graph.width, this.graph.height);
        passes.push(item);
      } catch (err) {
        console.warn(`[render] pass "${item.name}" failed to set up`, err);
      }
    }
    passes.sort((a, b) => a.order - b.order);
    this.passes = passes;

    // Hand off responsibilities the effect library claims, so nothing is applied twice.
    this.ownsTonemap = !passes.some((p) => p.order >= PASS_ORDER.EXPOSURE && p.order < PASS_ORDER.SHARPEN);
    this.ownsScreenFx = !passes.some((p) => p.order >= PASS_ORDER.SCREEN_FX);
    if (!this.ownsTonemap) {
      // The tonemapper applies `settings.gfx.exposure` and would otherwise stack
      // its own eye adaptation on top of the histogram we already resolved.
      for (const p of passes) {
        const probe = p as unknown as Record<string, unknown>;
        if (typeof probe.autoExposure === 'boolean') probe.autoExposure = false;
      }
    }
    if (typeof mod.postScreenEffect === 'function') {
      this.postScreenEffect = mod.postScreenEffect as (req: ScreenEffectRequest) => void;
    }
    if (typeof mod.postSetWeather === 'function') {
      this.postSetWeather = mod.postSetWeather as (r: number, f: number, w: number) => void;
      this.postSetWeather(this.sky.rain, this.sky.fogAmount, this.sky.wind);
    }
    console.info(`[render] ${passes.length} post pass(es): ${passes.map((p) => p.name).join(', ')}`);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    const r = this.renderer;
    r.setPixelRatio(pixelRatio * settings.gfx.renderScale);
    r.setSize(width, height, false);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.graph.resize(size.x, size.y);
    this.viewModelCamera.aspect = width / Math.max(1, height);
    this.viewModelCamera.updateProjectionMatrix();
    for (const p of this.passes) p.resize(this.graph.width, this.graph.height);
  }

  /* ----------------------------------------------------------------- update */

  update(dt: number, _ctx: EngineContext): void {
    this.elapsed += dt;
    this.uniforms.boTime.value = this.elapsed;

    this.sky.update(dt, this.scene);
    this.lights.update(dt, this.camera);
    this.decals.update(dt);
    this.graph.updateScreen(dt);

    if (this.shakeAmount > 0) {
      this.shakeTime += dt;
      this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeAmount * this.shakeDecay * dt - dt * 0.01);
    }

    // Depth of field focus: gameplay overrides win for a short while, then the
    // centre-screen depth from the exposure pass takes over again.
    if (this.focusManual) {
      this.focusManualTimer -= dt;
      if (this.focusManualTimer <= 0) this.focusManual = false;
    } else {
      this.focusTarget = this.exposure.centreDepth;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.focusCurrent += (this.focusTarget - this.focusCurrent) * k;
  }

  /* ----------------------------------------------------------------- render */

  render(_ctx: EngineContext): void {
    const r = this.renderer;
    const g = settings.gfx;
    r.info.reset();
    this.timer.begin();

    const gb = this.graph.gbuffer;
    const width = gb.width;
    const height = gb.height;

    // The renderer owns the environment; anything a level set is superseded.
    if (this.scene.background !== null) this.scene.background = null;
    if (this.scene.fog !== null) this.scene.fog = null;

    this.applyShake();
    this.camera.updateMatrixWorld(true);
    this.viewModelScene.updateMatrixWorld(true);

    // --- matrices (unjittered first, then jitter for TAA)
    this.viewProjectionNoJitter.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.uniforms.boViewProjectionNoJitter.value.copy(this.viewProjectionNoJitter);
    this.uniforms.boPrevViewProjection.value.copy(this.prevViewProjection);

    this.savedProjection.copy(this.camera.projectionMatrix);
    const wantJitter = g.taa && this.hasTemporalPass();
    if (wantJitter) {
      const j = JITTER[this.frameIndex % Math.max(2, Math.min(g.taaSamples, JITTER.length))];
      this.jitter.set((j.x * 2) / width, (j.y * 2) / height);
      this.camera.projectionMatrix.elements[8] += this.jitter.x;
      this.camera.projectionMatrix.elements[9] += this.jitter.y;
    } else {
      this.jitter.set(0, 0);
    }
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);

    // --- shared uniforms
    const u = this.uniforms;
    u.boResolution.value.set(width, height);
    u.boCameraParams.value.set(this.camera.near, this.camera.far, 1 / width, 1 / height);
    u.boSceneDepth.value = this.graph.prepassDepth;
    u.boShadowStrength.value = g.shadows ? 1 : 0;
    // Cycle over 8 frames: long enough to decorrelate, short enough that TAA's
    // history window always covers a full rotation.
    u.boFrameJitter.value = wantJitter ? (this.frameIndex % 8) / 8 : 0;
    // x strength, y ray length (m), z steps, w thickness (m). The ray has to be
    // long enough to reach the ground from the base of a prop — 0.45 m only ever
    // caught the crease itself, which is why nothing looked planted.
    u.boContactParams.value.set(
      g.contactShadows ? 1.0 : 0,
      0.85, g.shadows ? 16 : 0, 0.42,
    );
    this.updateFog();

    // --- scene bookkeeping
    this.worldIndex.scan(this.scene);
    this.viewModelIndex.scan(this.viewModelScene);
    this.neutraliseForeignLights();
    this.updateViewModelRig();

    // --- 1. cascaded shadow maps
    if (g.shadows) {
      this.shadows.render(this.scene, this.camera, u.boSunDirWorld.value, this.worldIndex, {
        cascades: g.shadowCascades,
        mapSize: g.shadowMapSize,
        distance: Math.min(g.shadowDistance, this.camera.far),
        softness: g.pcssSoftness,
        lambda: 0.86,
      });
    } else {
      this.shadows.setDisabled();
    }

    // --- 2. depth prepass (drives contact shadows and projected decals)
    this.renderPrepass();

    // --- 3. sky + opaque + transparent + view model into the MRT
    this.renderMain(width, height);

    // --- 4. projected decals, composited into the HDR colour
    let sceneColor: THREE.Texture = gb.color;
    if (this.decals.count > 0) {
      const accum = this.borrow(1, true);
      if (this.decals.render(this.camera, accum)) {
        const merged = this.borrow(1, true);
        this.graph.compositeDecals(gb.color, accum.texture, merged);
        sceneColor = merged.texture;
      }
    }
    gb.color = sceneColor;

    // --- 5. auto exposure (the external tonemapper applies gfx.exposure itself)
    this.exposure.settings.manual = this.ownsTonemap ? g.exposure : 1;
    this.exposure.update(
      Math.max(1 / 240, this.elapsedDelta()), sceneColor, gb.depth,
      width, height, this.camera.near, this.camera.far,
    );

    // --- 6. post chain
    const finalTexture = this.runPasses(sceneColor, width, height);

    // --- 7. present
    this.gradeVec.set(
      g.colorGrade ? 1.055 : 1.0,
      g.colorGrade ? 1.045 : 1.0,
      g.colorGrade ? 0.006 : 0.0,
      g.colorGrade ? 0.0 : 1.0,
    );
    this.graph.present({
      input: finalTexture,
      exposure: this.exposure.exposure,
      tonemap: TONEMAP_INDEX[g.tonemap] ?? 0,
      encode: this.ownsTonemap,
      screenFx: this.ownsScreenFx,
      grade: this.gradeVec,
      vignette: this.passOwnsGrain() ? 0 : g.vignette * 0.6,
      grain: this.passOwnsGrain() ? 0 : g.filmGrain * 0.5,
      dither: this.passOwnsGrain() ? 0 : 1 / 255,
      time: this.elapsed,
    });

    // --- 8. end of frame
    this.releaseBorrowed();
    this.worldIndex.latchPrevious();
    this.viewModelIndex.latchPrevious();
    this.prevViewProjection.copy(this.viewProjectionNoJitter);
    this.camera.projectionMatrix.copy(this.savedProjection);
    this.camera.projectionMatrixInverse.copy(this.savedProjection).invert();
    this.restoreShake();
    this.frameIndex++;
    this.timer.end();
  }

  private lastElapsed = 0;
  private elapsedDelta(): number {
    const d = this.elapsed - this.lastElapsed;
    this.lastElapsed = this.elapsed;
    return d > 0 ? d : 1 / 60;
  }

  private hasTemporalPass(): boolean {
    return this.passes.some((p) => p.enabled !== false && p.order === PASS_ORDER.TAA);
  }

  private passOwnsGrain(): boolean {
    return this.passes.some((p) => p.enabled !== false && p.order >= PASS_ORDER.GRAIN);
  }

  private renderPrepass(): void {
    const r = this.renderer;
    const savedMask = this.camera.layers.mask;
    const prevOverride = this.scene.overrideMaterial;
    const prevAutoClear = r.autoClear;

    r.setRenderTarget(this.graph.prepassTarget);
    r.setViewport(0, 0, this.graph.width, this.graph.height);
    r.autoClear = false;
    r.clear(true, true, false);

    this.scene.overrideMaterial = this.depthOnly();
    this.camera.layers.mask = MASK_WORLD_OPAQUE;
    r.render(this.scene, this.camera);
    this.camera.layers.mask = savedMask;
    this.scene.overrideMaterial = prevOverride;

    // The weapon must occupy the prepass too, otherwise decals project through it.
    if (this.viewModelScene.visible && this.viewModelIndex.meshes.length > 0) {
      const vmOverride = this.viewModelScene.overrideMaterial;
      this.viewModelScene.overrideMaterial = this.depthOnly();
      r.render(this.viewModelScene, this.viewModelCamera);
      this.viewModelScene.overrideMaterial = vmOverride;
    }

    r.autoClear = prevAutoClear;
  }

  private _depthOnly: THREE.MeshDepthMaterial | null = null;
  private depthOnly(): THREE.MeshDepthMaterial {
    if (!this._depthOnly) {
      this._depthOnly = skipPatch(new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
        side: THREE.DoubleSide,
      }));
      this._depthOnly.colorWrite = false;
    }
    return this._depthOnly;
  }

  private _vmPunch: THREE.MeshDepthMaterial | null = null;
  /**
   * Stamps the far plane into the depth buffer over the view model's own
   * silhouette, and nothing else.
   *
   * The weapon must never be occluded by world geometry, which used to be
   * arranged by clearing the whole depth buffer before drawing it — but that
   * buffer is the G-buffer's depth attachment, the one every depth-driven post
   * pass reads. Clearing it made the entire world read as "far plane" to GTAO,
   * SSR, DoF, motion blur and the volumetric apply. Punching a hole exactly the
   * shape of the weapon gives the same occlusion guarantee while leaving the
   * world's depth intact everywhere else.
   */
  private vmPunch(): THREE.MeshDepthMaterial {
    if (!this._vmPunch) {
      const m = skipPatch(new THREE.MeshDepthMaterial({
        depthPacking: THREE.BasicDepthPacking,
        side: THREE.DoubleSide,
      }));
      m.colorWrite = false;
      m.depthWrite = true;
      m.depthTest = true;
      m.depthFunc = THREE.AlwaysDepth;
      m.onBeforeCompile = (shader) => {
        // Snap every vertex to the far plane; keeps early-Z and works with
        // skinning, instancing and batching because it rides on the stock chunk.
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n\tgl_Position.z = gl_Position.w;',
        );
      };
      m.customProgramCacheKey = () => 'bo-vm-punch';
      this._vmPunch = m;
    }
    return this._vmPunch;
  }

  private renderMain(width: number, height: number): void {
    const r = this.renderer;
    const gb = this.graph.gbuffer;
    const prevAutoClear = r.autoClear;
    const savedMask = this.camera.layers.mask;

    r.setRenderTarget(gb.target);
    r.setViewport(0, 0, width, height);
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);

    // Sky first: a full-screen triangle that also seeds velocity and material id.
    this.graph.blitter.blit(
      r,
      this.sky.domeFor(this.camera, this.prevViewProjection, width, height),
      gb.target,
    );

    this.camera.layers.mask = MASK_WORLD_ALL;
    r.render(this.scene, this.camera);
    this.camera.layers.mask = savedMask;

    if (this.viewModelScene.visible && this.viewModelIndex.meshes.length > 0) {
      this.viewModelCamera.fov = THREE.MathUtils.clamp(this.camera.fov * this.viewModelFovScale, 20, 110);
      this.viewModelCamera.near = this.camera.near;
      this.viewModelCamera.far = this.camera.far;
      this.viewModelCamera.updateProjectionMatrix();
      // Punch the weapon's silhouette to the far plane, then draw it normally.
      // See vmPunch(): a full depth clear here would destroy the depth buffer
      // the whole post chain depends on.
      const prevOverride = this.viewModelScene.overrideMaterial;
      this.viewModelScene.overrideMaterial = this.vmPunch();
      r.render(this.viewModelScene, this.viewModelCamera);
      this.viewModelScene.overrideMaterial = prevOverride;
      r.render(this.viewModelScene, this.viewModelCamera);
    }

    r.autoClear = prevAutoClear;
  }

  private runPasses(input: THREE.Texture, width: number, height: number): THREE.Texture {
    if (this.passes.length === 0) return input;

    const gb = this.graph.gbuffer;
    const atmo = this.atmosphere;
    atmo.sunDirection.copy(this.uniforms.boSunDirWorld.value);
    atmo.sunColor.copy(this.sky.sunIlluminance);
    atmo.skyColor.copy(this.sky.horizonColor);
    atmo.skyCube = this.uniforms.boSkyCube.value as THREE.Texture | null;
    atmo.nightFactor = this.sky.nightFactor;
    atmo.weather = THREE.MathUtils.clamp(this.sky.rain * 0.7 + this.sky.fogAmount, 0, 1);
    const csm = this.uniforms.boCsmInfo.value;
    atmo.shadow.atlas = this.uniforms.boShadowAtlas.value;
    atmo.shadow.count = csm.x;
    atmo.shadow.distance = csm.z;
    atmo.shadow.strength = this.uniforms.boShadowStrength.value;

    const ctx: PassContext = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      gbuffer: gb,
      atmosphere: atmo,
      dt: this.elapsedDelta(),
      frame: this.frameIndex,
      time: this.elapsed,
      width,
      height,
      settings: settings.gfx,
      jitter: this.jitter,
      prevViewProjection: this.prevViewProjection,
      viewProjection: this.viewProjection,
      inverseProjection: this.camera.projectionMatrixInverse,
      inverseView: this.camera.matrixWorld,
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      exposure: this.exposure.exposure,
      focusDistance: this.focusCurrent,
      borrow: (scale, half) => this.borrow(scale, half),
      blit: (material, target) => this.graph.blitter.blit(this.renderer, material, target),
    };

    let current = input;
    for (const pass of this.passes) {
      if (pass.enabled === false) continue;
      const out = this.borrow(1, true);
      let ok = false;
      try {
        ok = pass.render(ctx, current, out) !== false;
      } catch (err) {
        console.warn(`[render] pass "${pass.name}" threw; disabling`, err);
        pass.enabled = false;
        ok = false;
      }
      if (ok) current = out.texture;
    }
    return current;
  }

  private borrow(scale = 1, half = true): THREE.WebGLRenderTarget {
    const t = this.graph.pool.borrow(scale, half);
    this.borrowed.push(t);
    return t;
  }

  private releaseBorrowed(): void {
    this.borrowed.length = 0;
    this.graph.pool.releaseAll();
  }

  /* -------------------------------------------------------------- lighting */

  private updateFog(): void {
    const g = settings.gfx;
    const weather = this.sky.rain * 0.6 + this.sky.fogAmount;
    // Long-range term. The froxel volume owns the first ~180 m; this is what
    // makes 300 m read as 300 m. 0.0013/m is ~12% at 100 m, 30% at 300 m.
    const density = (0.0009 + weather * 0.009) * g.fogDensity;
    this.uniforms.boFogParams.value.set(
      density,
      0.032,                                  // height falloff (1/m)
      0.055,                                  // sun single-scatter weight
      0.76 + 0.05 * this.sky.fogAmount,       // Mie g
    );
    this.uniforms.boFogParams2.value.set(
      0,
      0.97,
      1.0,
      THREE.MathUtils.clamp(this.sky.rain * 0.5 + this.sky.fogAmount * 0.3, 0, 1),
    );
  }

  /** Ensures the sky owns the sun: any other directional light is silenced. */
  private neutraliseForeignLights(): void {
    if (!this.adoptSceneLights) return;
    const lights = this.worldIndex.directionalLights;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      if (l.intensity !== 0 || l.castShadow) {
        if (!this.warnedLights) {
          this.warnedLights = true;
          console.info('[render] scene directional light neutralised — the sky system owns the sun');
        }
        l.intensity = 0;
        l.castShadow = false;
      }
    }
  }

  private updateViewModelRig(): void {
    // vmFromWorld maps real world space into whatever space the view-model
    // camera lives in, so the rig is correct whether the weapon is authored in
    // view space (camera at identity) or world space (camera tracks the player).
    this.vmFromWorld.multiplyMatrices(this.viewModelCamera.matrixWorld, this.camera.matrixWorldInverse);

    this.tmpV.copy(this.uniforms.boSunDirWorld.value).transformDirection(this.vmFromWorld);
    this.vmKey.position.copy(this.tmpV).multiplyScalar(12);
    this.vmKey.target.position.set(0, 0, 0);
    this.vmKey.color.copy(this.sky.sunIlluminance);
    const keyLum = Math.max(this.sky.sunIlluminance.r, this.sky.sunIlluminance.g, this.sky.sunIlluminance.b);
    this.vmKey.color.multiplyScalar(keyLum > 1e-4 ? 1 / keyLum : 0);
    // Weapons are shaded by a softened key so the model reads at any hour.
    this.vmKey.intensity = keyLum * 0.55 + 0.05;

    // Fill from the sky's average irradiance, roughly opposite the key.
    const sh0 = this.sky.shCoefficients[0];
    this.tmpColor.setRGB(Math.max(sh0.x, 0), Math.max(sh0.y, 0), Math.max(sh0.z, 0));
    const fillLum = Math.max(this.tmpColor.r, this.tmpColor.g, this.tmpColor.b, 1e-5);
    this.vmFill.color.copy(this.tmpColor).multiplyScalar(1 / fillLum);
    this.vmFill.intensity = fillLum * 0.45;
    this.vmFill.position.set(-this.tmpV.x, Math.abs(this.tmpV.y) * 0.4 + 0.6, -this.tmpV.z).multiplyScalar(10);
    this.vmFill.target.position.set(0, 0, 0);

    this.vmRim.position.set(0.3, 0.5, -1).multiplyScalar(10);
    this.vmRim.target.position.set(0, 0, 0);
    this.vmRim.intensity = (keyLum * 0.28 + fillLum * 0.2);

    this.viewModelScene.environment = this.scene.environment;
    this.viewModelScene.environmentIntensity = this.sky.ambientIntensity;
    // Rotate the probe back into world orientation so reflections track the sky.
    this.tmpQ.setFromRotationMatrix(this.vmFromWorld).invert();
    this.tmpE.setFromQuaternion(this.tmpQ);
    this.viewModelScene.environmentRotation.copy(this.tmpE);
  }

  /* ----------------------------------------------------------------- shake */

  private applyShake(): void {
    this.savedCamPos.copy(this.camera.position);
    this.savedCamQuat.copy(this.camera.quaternion);
    const a = this.shakeAmount * settings.game.cameraShake;
    if (a <= 1e-5) return;

    const t = this.shakeTime * this.shakeFreq;
    // Sums of incommensurate sines: deterministic, no RNG, no visible period.
    const nx = Math.sin(t * 1.00) * 0.6 + Math.sin(t * 2.37 + 1.7) * 0.3 + Math.sin(t * 4.91 + 0.4) * 0.1;
    const ny = Math.sin(t * 1.13 + 2.1) * 0.6 + Math.sin(t * 2.71 + 0.3) * 0.3 + Math.sin(t * 5.33 + 2.9) * 0.1;
    const nz = Math.sin(t * 0.87 + 4.2) * 0.6 + Math.sin(t * 3.11 + 1.1) * 0.4;

    this.camera.position.x += nx * a;
    this.camera.position.y += ny * a;
    this.camera.position.z += nz * a * 0.4;

    this.tmpE.set(ny * a * 0.55, nx * a * 0.55, nz * a * 0.9, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpE);
    this.camera.quaternion.multiply(this.tmpQ);
  }

  private restoreShake(): void {
    this.camera.position.copy(this.savedCamPos);
    this.camera.quaternion.copy(this.savedCamQuat);
  }

  /* ------------------------------------------------------------ RenderAPI -- */

  screenEffect(req: ScreenEffectRequest): void {
    this.postScreenEffect?.(req);
    const s = this.graph.screen;
    if (req.flash) {
      s.flashAmount = Math.min(6, s.flashAmount + req.flash.intensity);
      if (req.flash.color !== undefined) s.flashColor.set(req.flash.color);
      s.flashDecay = req.flash.decay ?? 4;
    }
    if (req.damage) {
      s.damage = Math.min(1.4, s.damage + req.damage.intensity);
      if (req.damage.direction) {
        this.tmpV.copy(req.damage.direction).applyMatrix4(this.camera.matrixWorldInverse);
        const len = Math.hypot(this.tmpV.x, this.tmpV.y) || 1;
        s.damageDir.set(this.tmpV.x / len, this.tmpV.y / len);
      }
    }
    if (req.concussion) {
      s.concussion = Math.min(2, s.concussion + req.concussion.intensity);
      s.concussionDecay = 1 / Math.max(req.concussion.duration, 0.05);
    }
    if (req.spatter) {
      s.spatter = Math.min(1, s.spatter + req.spatter.intensity);
      s.spatterKind = req.spatter.kind === 'blood' ? 0 : req.spatter.kind === 'water' ? 1 : 2;
    }
  }

  addDecal(req: DecalRequest): void {
    if (settings.gfx.maxDecals <= 0) return;
    this.decals.add(req);
  }

  addDynamicLight(req: DynamicLightRequest): void {
    this.lights.add(req);
  }

  setFocusDistance(metres: number, immediate?: boolean): void {
    this.focusTarget = Math.max(0.05, metres);
    this.focusManual = true;
    this.focusManualTimer = 0.75;
    if (immediate) this.focusCurrent = this.focusTarget;
  }

  setExposureCompensation(stops: number): void {
    this.exposure.settings.compensation = THREE.MathUtils.clamp(stops, -6, 6);
  }

  addCameraShake(amount: number, frequency?: number, duration?: number): void {
    this.shakeAmount = Math.min(0.6, this.shakeAmount + amount);
    this.shakeFreq = frequency ?? 22;
    this.shakeDecay = duration ? 1 / Math.max(duration, 0.05) : 3;
    this.shakeTime = this.elapsed;
  }

  setTimeOfDay(hours: number): void {
    this.sky.setTimeOfDay(hours);
    this.exposure.reset();
  }

  setWeather(rain: number, fog: number, wind: number): void {
    this.sky.setWeather(rain, fog, wind);
    this.postSetWeather?.(rain, fog, wind);
  }

  /** Per-level ambient control so interiors are not lit like exteriors. */
  setAmbient(tint: THREE.ColorRepresentation, intensity: number): void {
    this.sky.ambientTint.set(tint);
    this.sky.ambientIntensity = Math.max(0, intensity);
    this.scene.environmentIntensity = this.sky.ambientIntensity;
  }

  stats() {
    const i = this.renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      gpuMs: this.timer.lastMs,
    };
  }

  dispose(): void {
    this.decals.dispose();
    this.lights.dispose();
    this.exposure.dispose();
    this.shadows.dispose();
    this.sky.dispose();
    this.graph.dispose();
    this.atlas?.dispose();
    for (const p of this.passes) { try { p.dispose(); } catch { /* ignore */ } }
    this._renderer?.dispose();
  }
}
