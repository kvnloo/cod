/**
 * MaterialSystem — procedural PBR material + texture authoring.
 *
 * Every texture in the game is generated on the GPU at load time (no binary
 * assets), so this module is where the surface look of the entire game lives:
 * albedo/normal/roughness/metalness/AO/height stacks with detail layers,
 * triplanar blending and per-instance wear.
 *
 * STUB: returns flat lambert-ish standard materials keyed by name.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import type { SurfaceType } from '../core/Surfaces';

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
  doubleSided?: boolean;
}

export class MaterialSystem implements System {
  readonly name = 'materials';
  readonly order = ORDER.WORLD - 50;

  private cache = new Map<string, THREE.Material>();
  private renderer!: THREE.WebGLRenderer;

  async init(ctx: EngineContext): Promise<void> {
    const render = ctx.engine.tryGet<System & { renderer: THREE.WebGLRenderer }>('render');
    if (render) this.renderer = render.renderer;
  }

  /** Returns (and caches) a material for a surface archetype. */
  get(surface: SurfaceType, opts: MaterialOptions = {}): THREE.Material {
    const key = surface + JSON.stringify(opts);
    let m = this.cache.get(key);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({
      color: opts.tint ?? DEFAULT_TINT[surface] ?? 0x8a8a8a,
      roughness: opts.roughness ?? 0.85,
      metalness: opts.metalness ?? (surface.startsWith('metal') ? 1 : 0),
      side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: opts.transparent ?? false,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    m.userData.surface = surface;
    this.cache.set(key, m);
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}

const DEFAULT_TINT: Partial<Record<SurfaceType, number>> = {
  concrete: 0x9a978f, asphalt: 0x3c3d40, brick: 0x8a4c3a, stone: 0x8d8b85,
  plaster: 0xc9c3b6, tile: 0xb9bcbd, metal: 0x8d9096, metalThin: 0x7d8288,
  wood: 0x8a6742, plywood: 0xb9925c, crate: 0x9c7845, dirt: 0x6b5a45,
  sand: 0xbfa87d, gravel: 0x77736c, grass: 0x4e6b3a, glass: 0x9fc4d8,
  fabric: 0x6d6455, sandbag: 0x94815e, snow: 0xe8eef5, foliage: 0x3f5c2c,
};
