/**
 * Public shapes for the material module.
 *
 * Other systems only ever need `MaterialSystem.get(surface, opts)`, but level
 * and prop code can reach for archetype ids directly when it wants a specific
 * look ('brickPainted' vs 'brick') or a second blend layer.
 */

import type * as THREE from 'three';
import type { SurfaceType } from '../core/Surfaces';
import type { ForgeRecipe } from './TextureForge';
import type { ShaderExtensionConfig } from './MaterialShaders';

/** Which shared high-frequency detail layer an archetype uses up close. */
export type DetailKind = 'none' | 'micro' | 'grit' | 'fibre' | 'metal' | 'organic';

export interface MaterialArchetype {
  /** Stable id used as the registry key. */
  id: string;
  /** Human label for the debug grid. */
  label: string;
  /** Gameplay surface this archetype represents. */
  surface: SurfaceType;
  recipe: ForgeRecipe;
  detail?: DetailKind;
  /** Multiplied into the map values; leave at 1 unless the archetype needs it. */
  roughness?: number;
  metalness?: number;
  /** Base colour multiplier applied on top of the albedo map. */
  color?: number;
  transparent?: boolean;
  opacity?: number;
  doubleSided?: boolean;
  /** Default shader-extension overrides for this archetype. */
  shader?: Partial<ShaderExtensionConfig>;
  /** Animated emissive behaviour, if any. */
  emissive?: EmissiveKind;
}

export type EmissiveKind =
  | 'none'
  | 'fluorescent'      // long tube, 100 Hz ripple + failing-ballast stutter
  | 'strobe'           // rotating hazard beacon
  | 'monitor'          // CRT/LCD with scanlines and refresh roll
  | 'hotMetal'         // blackbody glow driven by the height field
  | 'emergency'        // steady red exit / bulkhead lamp
  | 'sodium';          // warm street lamp

export interface MaterialOptions {
  /** World-space texel density in metres per texture repeat. */
  scale?: number;
  tint?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  /** 0..1 grime/wear overlay strength. */
  wear?: number;
  /** Use triplanar projection instead of mesh UVs. */
  triplanar?: boolean;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  doubleSided?: boolean;

  /* --- extended options (safe to omit) --- */
  /** Explicit archetype id, overriding the surface's default. */
  archetype?: string;
  /** Enable parallax occlusion mapping (defaults to the archetype's choice). */
  pom?: boolean;
  /** Enable the instanced `obVar` variation attribute path. */
  instanced?: boolean;
  /** Blend to a second archetype using vertex colour red. */
  blendWith?: string;
  /** Metres per repeat of the blend layer. */
  blendScale?: number;
  /** Hue rotation in turns, and saturation multiplier. */
  hue?: number;
  saturation?: number;
  /** Force the detail layer on/off. */
  detail?: boolean;
  /** Render-order / depth overrides for decals and glass. */
  depthWrite?: boolean;
  /** Flat colour fallback used before the GPU textures exist. */
  fallbackColor?: number;
}

export interface WarmupProgress {
  done: number;
  total: number;
  current: string;
}
