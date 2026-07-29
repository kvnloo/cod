/**
 * Renderer contract.
 *
 * The renderer owns the WebGL context, the HDR frame graph and every screen-space
 * effect. Gameplay talks to it only through this narrow surface — mostly to push
 * transient camera/lens effects and to register lights and decals.
 */

import type * as THREE from 'three';

export interface ScreenEffectRequest {
  /** Additive blend flash, e.g. muzzle bloom or flashbang. */
  flash?: { intensity: number; color?: THREE.ColorRepresentation; decay?: number };
  /** Radial blood/damage vignette. */
  damage?: { intensity: number; direction?: THREE.Vector3 };
  /** Concussion — chromatic aberration + blur + ringing. */
  concussion?: { intensity: number; duration: number };
  /** Lens wetness (rain, blood spatter on the "lens"). */
  spatter?: { intensity: number; kind: 'blood' | 'water' | 'dirt' };
}

export interface DecalRequest {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** Optional tangent hint so decals align with, e.g., a bullet's travel. */
  up?: THREE.Vector3;
  size: number;
  /** Atlas group: matches `SurfaceProps.decal`. */
  group: string;
  /** Index within the group, or -1 to pick at random. */
  variant?: number;
  rotation?: number;
  /** Seconds before fading out; Infinity to persist for the level. */
  lifetime?: number;
  /** Optional parent for decals on moving objects. */
  parent?: THREE.Object3D | null;
  colorTint?: THREE.ColorRepresentation;
  /** Extra emissive for glowing/hot impacts. */
  emissive?: number;
}

export interface DynamicLightRequest {
  position: THREE.Vector3;
  color: THREE.ColorRepresentation;
  /** Peak intensity in candela-ish units. */
  intensity: number;
  radius: number;
  /** Seconds; the light removes itself when elapsed. */
  lifetime: number;
  /** Falloff curve applied over the lifetime. */
  decay?: 'linear' | 'exp' | 'flicker' | 'flash';
  castShadow?: boolean;
}

export interface RenderAPI {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Separate camera+scene layer used for the first-person view model. */
  readonly viewModelScene: THREE.Scene;
  readonly viewModelCamera: THREE.PerspectiveCamera;

  /** Requests a transient full-screen effect; multiple requests accumulate. */
  screenEffect(req: ScreenEffectRequest): void;
  /** Places a projected decal. Oldest decals are recycled past the budget. */
  addDecal(req: DecalRequest): void;
  /** Adds a short-lived point light (muzzle flash, explosion, tracer glow). */
  addDynamicLight(req: DynamicLightRequest): void;
  /** Overrides the focus distance for depth of field, in metres. */
  setFocusDistance(metres: number, immediate?: boolean): void;
  /** Sets exposure compensation in stops, e.g. −0.5 when ADS. */
  setExposureCompensation(stops: number): void;
  /** Camera shake in world units; decays automatically. */
  addCameraShake(amount: number, frequency?: number, duration?: number): void;

  /** Environment control for time of day / weather. */
  setTimeOfDay(hours: number): void;
  setWeather(rain: number, fog: number, wind: number): void;

  /** Per-frame renderer statistics for the perf HUD and harness. */
  stats(): {
    drawCalls: number; triangles: number; programs: number;
    textures: number; geometries: number; gpuMs: number;
  };
}

/** Shared render layers. Objects must be assigned exactly one of these. */
export const LAYERS = {
  DEFAULT: 0,
  VIEW_MODEL: 1,
  /** Excluded from reflections/shadow to save cost. */
  NO_REFLECT: 2,
  /** Sky dome / distant backdrop. */
  BACKDROP: 3,
  /** Transparent pass — rendered after opaque + SSR. */
  TRANSPARENT: 4,
  /** UI/world-space markers. */
  MARKER: 5,
} as const;
