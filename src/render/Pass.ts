/**
 * Post-processing pass contract + shared frame resources.
 *
 * `RenderSystem` owns the G-buffer, the HDR target and the ping-pong chain;
 * individual effects live in `./passes` and only see this interface. That split
 * lets the frame graph and the effect library evolve independently.
 *
 * ## G-buffer layout (MRT, written by the opaque prepass)
 *   RT0  rgba16f  scene colour (HDR, linear, pre-exposure)
 *   RT1  rgba16f  view-space normal (xyz) + roughness (w)
 *   RT2  rg16f    screen-space velocity (pixels/frame, unjittered)
 *   RT3  rgba8    metalness (r) + AO (g) + material id (b) + emissive mask (a)
 *   D    depth24  hardware depth
 */

import type * as THREE from 'three';
import type { GfxSettings } from '../core/Settings';

export interface GBuffer {
  /** MRT target holding colour/normal/velocity/material. */
  target: THREE.WebGLRenderTarget;
  color: THREE.Texture;
  normalRoughness: THREE.Texture;
  velocity: THREE.Texture;
  material: THREE.Texture;
  depth: THREE.DepthTexture;
  width: number;
  height: number;
}

/**
 * Sky/atmosphere state resolved by `SkySystem` for the current frame.
 *
 * Post passes must not reach into the sky system directly, but several of them
 * (volumetrics above all) are wrong unless their in-scatter colour tracks the
 * time of day. The renderer publishes this snapshot once per frame.
 */
export interface AtmosphereState {
  /** Unit vector from the world toward the dominant celestial light. */
  sunDirection: THREE.Vector3;
  /** Illuminance of that light, renderer linear units. */
  sunColor: THREE.Color;
  /** Mean sky radiance near the horizon — the colour distance recedes toward. */
  skyColor: THREE.Color;
  /** Filtered environment cubemap (mip 0 = sharp sky). */
  skyCube: THREE.Texture | null;
  /** 0 at day, 1 at full night. */
  nightFactor: number;
  /** Combined weather amount, 0..1 (rain + fog). */
  weather: number;
  /** Cascaded sun shadows, so participating media can be shadowed too. */
  shadow: SunShadowState;
}

/**
 * The cascaded shadow atlas and its transforms.
 *
 * `ShadowSystem` replaces three's shadow pipeline wholesale, which means a pass
 * that goes looking for `DirectionalLight.shadow.map` finds nothing. Anything
 * that needs sun visibility — volumetric god rays above all — reads this.
 */
export interface SunShadowState {
  atlas: THREE.Texture | null;
  /** World -> cascade [0,1]^3, one per cascade. */
  matrices: THREE.Matrix4[];
  /** Atlas tile: xy offset, zw scale. */
  tiles: THREE.Vector4[];
  /** x worldExtent(m), y zRange(m), z texelWorld(m), w splitFar(view m). */
  params: THREE.Vector4[];
  count: number;
  /** Beyond this view distance the cascades hold nothing. */
  distance: number;
  strength: number;
}

export interface PassContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  gbuffer: GBuffer;
  atmosphere: AtmosphereState;
  /** Frame delta in seconds. */
  dt: number;
  /** Monotonically increasing frame index — drives temporal sample sequences. */
  frame: number;
  /** Seconds since start; for animated noise. */
  time: number;
  /** Render-target size in pixels (may differ from canvas size via renderScale). */
  width: number;
  height: number;
  settings: GfxSettings;

  /** Sub-pixel jitter applied to the projection this frame, in NDC. */
  jitter: THREE.Vector2;
  /** Previous frame's view-projection, for reprojection. */
  prevViewProjection: THREE.Matrix4;
  viewProjection: THREE.Matrix4;
  inverseProjection: THREE.Matrix4;
  inverseView: THREE.Matrix4;
  cameraNear: number;
  cameraFar: number;

  /** Exposure multiplier resolved by auto-exposure this frame. */
  exposure: number;
  /** Distance in metres the DoF should focus on. */
  focusDistance: number;

  /** Borrow a full-size scratch target of the given format. Returned automatically
   *  at end of frame — never hold across frames. */
  borrow(scale?: number, half?: boolean): THREE.WebGLRenderTarget;
  /** Renders a full-screen triangle with `material` into `target` (null = screen). */
  blit(material: THREE.Material, target: THREE.WebGLRenderTarget | null): void;
}

export interface RenderPass {
  readonly name: string;
  enabled: boolean;
  /** Passes run in ascending order; see PASS_ORDER. */
  readonly order: number;
  /** Called once with the renderer available. */
  setup(renderer: THREE.WebGLRenderer): void;
  resize(width: number, height: number): void;
  /**
   * Reads `input` and writes the result to `output`.
   * Return `false` to signal "no-op this frame" so the graph can skip the copy.
   */
  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean;
  dispose(): void;
}

/** Canonical post-chain ordering. */
export const PASS_ORDER = {
  AO: 100,             // consumed by lighting, applied to the HDR buffer
  SSR: 200,
  VOLUMETRICS: 300,
  TAA: 400,            // resolves jitter; everything after is temporally stable
  MOTION_BLUR: 500,
  DOF: 600,
  BLOOM: 700,
  LENS: 750,           // dirt, flare, streaks
  EXPOSURE: 800,       // histogram readback + tonemap + grade
  SHARPEN: 900,        // CAS after tonemap
  GRAIN: 950,          // grain, vignette, chromatic aberration, dither
  SCREEN_FX: 980,      // damage vignette, flashbang, concussion
} as const;
