/**
 * RenderSystem — owns the WebGL2 context and the HDR frame graph.
 *
 * Pipeline (ultra):
 *   depth+normal+velocity prepass → CSM shadows → opaque HDR → volumetrics
 *   → SSAO → SSR → transparent → TAA resolve → motion blur → DoF → bloom
 *   → exposure/tonemap/grade → CAS sharpen → grain/vignette/aberration → view model
 *
 * Individual passes live in `./passes` and are composed by `FrameGraph`.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import { LAYERS, type DecalRequest, type DynamicLightRequest, type RenderAPI, type ScreenEffectRequest } from './types';

export class RenderSystem implements System, RenderAPI {
  readonly name = 'render';
  readonly order = ORDER.RENDER;

  renderer!: THREE.WebGLRenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;

  /** The first-person view model renders in its own scene with a tight near plane
   *  so the weapon never clips into world geometry. */
  readonly viewModelScene = new THREE.Scene();
  readonly viewModelCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

  private canvas!: HTMLCanvasElement;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private gpuTimer: { ext: unknown; queries: WebGLQuery[]; lastMs: number } | null = null;

  init(ctx: EngineContext): void {
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.canvas = ctx.engine.canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,           // TAA handles AA; MSAA is done on the HDR target
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // required for harness screenshots
      failIfMajorPerformanceCaveat: false,
    });
    renderer.debug.checkShaderErrors = import.meta.env?.DEV ?? true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // done in the post chain
    renderer.shadowMap.enabled = settings.gfx.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.viewModelCamera.layers.set(LAYERS.VIEW_MODEL);
    this.viewModelScene.matrixWorldAutoUpdate = true;

    bus.on('quality:changed', () => this.applyQuality());
    this.applyQuality();
  }

  private applyQuality(): void {
    const g = settings.gfx;
    this.renderer.shadowMap.enabled = g.shadows;
    this.renderer.setPixelRatio(this.pixelRatio * g.renderScale);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio * settings.gfx.renderScale);
    this.renderer.setSize(width, height, false);
    this.viewModelCamera.aspect = width / Math.max(1, height);
    this.viewModelCamera.updateProjectionMatrix();
  }

  render(_ctx: EngineContext): void {
    const r = this.renderer;
    r.info.reset();
    r.render(this.scene, this.camera);
    // View model composited on top with a cleared depth buffer.
    r.autoClear = false;
    r.clearDepth();
    this.viewModelCamera.fov = this.camera.fov * 0.82;
    this.viewModelCamera.updateProjectionMatrix();
    r.render(this.viewModelScene, this.viewModelCamera);
    r.autoClear = true;
  }

  /* ------------------------------------------------------------ RenderAPI -- */

  screenEffect(_req: ScreenEffectRequest): void { /* implemented by the post stack */ }
  addDecal(_req: DecalRequest): void { /* implemented by DecalSystem */ }
  addDynamicLight(_req: DynamicLightRequest): void { /* implemented by LightPool */ }
  setFocusDistance(_m: number, _immediate?: boolean): void { }
  setExposureCompensation(_stops: number): void { }
  addCameraShake(_a: number, _f?: number, _d?: number): void { }
  setTimeOfDay(_h: number): void { }
  setWeather(_rain: number, _fog: number, _wind: number): void { }

  stats() {
    const i = this.renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      gpuMs: this.gpuTimer?.lastMs ?? 0,
    };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
