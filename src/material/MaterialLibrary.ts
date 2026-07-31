/**
 * MaterialSystem — procedural PBR material authoring and the material registry.
 *
 * Every texture in the game is rendered on the GPU at load time (there are no
 * binary assets), so this module owns the surface look of the entire game:
 * albedo / normal+height / AO+roughness+metalness stacks, a shared detail
 * layer, triplanar projection, parallax occlusion mapping, per-instance
 * variation and animated emissives.
 *
 * ## Ordering note
 *
 * `MaterialSystem.order` is below `RenderSystem.order`, so this system is
 * initialised *before* the WebGL context exists. `get()` therefore always
 * returns a usable material immediately — a flat, correctly-tinted
 * `MeshStandardMaterial` — and upgrades it in place the moment the renderer
 * appears (on `game:ready`, which fires at the end of `Engine.init`). Callers
 * never have to await anything.
 *
 * ## Usage
 *
 *   const mat = materials.get('concrete', { scale: 3, triplanar: true });
 *   const crateMat = materials.get('crate', { instanced: true });
 *   applyInstanceVariation(geo, 200, () => rand.next());
 *   const ground = materials.get('dirt', { blendWith: 'gravel' });
 *   setBlendWeights(geo, (x, y, z) => noise(x, z));
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { SurfaceType } from '../core/Surfaces';

import { FORGE_QUALITY, TextureForge, type PbrTextureSet } from './TextureForge';
import { DetailMaps } from './DetailMaps';
import {
  EMISSIVE_MODES, extendStandardMaterial, materialUniforms,
  type ShaderExtensionConfig,
} from './MaterialShaders';
import type { EmissiveKind, MaterialArchetype, MaterialOptions, WarmupProgress } from './types';

import { MASONRY_ARCHETYPES } from './recipes/masonry';
import { METAL_ARCHETYPES } from './recipes/metals';
import { WOOD_ARCHETYPES } from './recipes/wood';
import { GROUND_ARCHETYPES } from './recipes/ground';
import { SOFT_ARCHETYPES } from './recipes/soft';
import { MISC_ARCHETYPES } from './recipes/misc';

export type { MaterialOptions } from './types';
export { applyInstanceVariation, setBlendWeights, materialUniforms } from './MaterialShaders';
export type { PbrTextureSet } from './TextureForge';

/* ------------------------------------------------------------- registry -- */

const ALL_ARCHETYPES: MaterialArchetype[] = [
  ...MASONRY_ARCHETYPES,
  ...METAL_ARCHETYPES,
  ...WOOD_ARCHETYPES,
  ...GROUND_ARCHETYPES,
  ...SOFT_ARCHETYPES,
  ...MISC_ARCHETYPES,
];

/** Default archetype for each gameplay surface tag. */
const SURFACE_DEFAULT: Record<SurfaceType, string> = {
  concrete: 'concrete', asphalt: 'asphalt', brick: 'brick', stone: 'stone',
  plaster: 'plaster', tile: 'tile',
  metal: 'metal', metalThin: 'metalThin', grate: 'grate', pipe: 'pipe',
  wood: 'wood', woodThin: 'woodThin', plywood: 'plywood', crate: 'crate',
  dirt: 'dirt', sand: 'sand', gravel: 'gravel', grass: 'grass', mud: 'mud',
  glass: 'glass', glassThick: 'glassThick',
  water: 'puddle', puddle: 'puddle',
  fabric: 'fabric', sandbag: 'sandbag', carpet: 'carpet', cardboard: 'cardboard',
  flesh: 'flesh', armor: 'armor', helmet: 'helmet',
  rubber: 'rubber', plastic: 'plastic', foliage: 'foliage',
  snow: 'snow', ice: 'ice',
};

/** Flat colours used before the GPU textures exist, and by the 'low' fallback. */
const FALLBACK_TINT: Record<string, number> = {
  concrete: 0x8e8b84, asphalt: 0x3b3c3e, brick: 0x7d4235, stone: 0x8a8880,
  plaster: 0xbdb6a8, tile: 0xb2b5b3, ceilingPanel: 0xcbc9c2,
  metal: 0x6c7a72, metalThin: 0x9aa0a4, diamondPlate: 0x8a8d92,
  aluminium: 0xb6b9bc, grate: 0x53565a, pipe: 0x8a7e46,
  wood: 0x9c968a, woodThin: 0x8a7a63, plywood: 0xb2905f, crate: 0x9c7a4e,
  dirt: 0x5f4f3a, sand: 0xbca47c, gravel: 0x7a7770, grass: 0x6b6c40,
  mud: 0x4a3e2f, snow: 0xdde4ee, ice: 0x7f949c,
  fabric: 0x6b6650, sandbag: 0x9a8158, carpet: 0x4a4c50, cardboard: 0xa88c62,
  rubber: 0x2c2c2e, plastic: 0x3c3e42, armor: 0x635840, helmet: 0x4a4d42,
  glass: 0xb6c8c8, glassThick: 0xa8bab4, puddle: 0x232628,
  foliage: 0x465c2c, flesh: 0xb08a72,
  monitor: 0x0a1a16, fluorescent: 0xe2e8dc, strobe: 0xd4682a, hotMetal: 0x3a3230,
};

/**
 * Archetypes that must not receive the world-space macro/ground layers:
 * characters and foliage move (so a world-space stain would swim across them),
 * and glass / emissive panels are not diffuse surfaces at all.
 */
const NO_WORLD_LAYERS = new Set([
  'glass', 'glassThick', 'puddle', 'foliage', 'flesh', 'armor', 'helmet',
  'monitor', 'fluorescent', 'strobe', 'hotMetal', 'ice',
]);

/** Archetypes that get the splash-back dirt band at the foot of a wall. */
const GROUND_BAND: Record<string, number> = {
  concrete: 0.55, brick: 0.50, stone: 0.52, plaster: 0.62, tile: 0.45,
  metal: 0.40, metalThin: 0.40, aluminium: 0.32, grate: 0.30, pipe: 0.35,
  diamondPlate: 0.30,
  wood: 0.48, woodThin: 0.48, plywood: 0.50, crate: 0.42,
  fabric: 0.35, sandbag: 0.30, cardboard: 0.55, rubber: 0.28, plastic: 0.35,
};

/** Per-family macro variation: wavelengths in metres, albedo + roughness gain. */
const MACRO_DEFAULT: Record<string, [number, number, number, number]> = {
  plaster: [5.0, 16, 0.185, 0.10],
  concrete: [6.0, 19, 0.150, 0.09],
  brick: [7.0, 21, 0.135, 0.07],
  stone: [6.0, 18, 0.140, 0.08],
  tile: [5.0, 15, 0.070, 0.05],
  asphalt: [9.0, 28, 0.115, 0.06],
  ceilingPanel: [4.0, 12, 0.060, 0.04],
  dirt: [6.0, 18, 0.130, 0.06],
  sand: [7.0, 20, 0.100, 0.05],
  gravel: [5.5, 16, 0.115, 0.06],
  grass: [5.0, 15, 0.140, 0.05],
  mud: [5.5, 17, 0.125, 0.05],
  snow: [8.0, 24, 0.055, 0.04],
  // A 12 m tram body tiles its 1.4 m paint-and-rust map nine times, and the
  // blotch that reads so well on one panel becomes a stripe pattern along the
  // whole flank. A strong metre-scale drift is the only thing that hides it.
  metal: [4.5, 13.0, 0.170, 0.10],
  metalThin: [4.0, 12.0, 0.150, 0.09],
  diamondPlate: [3.0, 9.0, 0.110, 0.08],
  aluminium: [3.0, 9.0, 0.080, 0.06],
  pipe: [3.0, 9.0, 0.120, 0.08],
  grate: [3.0, 9.0, 0.090, 0.07],
  // Same story for a floor tiling one plank layout every metre.
  wood: [4.0, 12.0, 0.165, 0.09],
  woodThin: [3.4, 10.0, 0.170, 0.09],
  plywood: [3.6, 11.0, 0.140, 0.08],
  crate: [2.4, 7.0, 0.120, 0.08],
  fabric: [3.0, 9.0, 0.110, 0.06],
  sandbag: [2.6, 8.0, 0.120, 0.06],
  rubber: [3.0, 9.0, 0.080, 0.05],
  plastic: [3.0, 9.0, 0.090, 0.06],
  cardboard: [2.6, 8.0, 0.130, 0.07],
  carpet: [3.6, 11.0, 0.110, 0.06],
};
const MACRO_FALLBACK: [number, number, number, number] = [6.0, 18, 0.075, 0.05];

/**
 * Masonry lattices, mirroring the `obBrick()` call inside each recipe:
 * `[blocksAcross, coursesUp, perCourseJitter, recipeSeed]`.
 *
 * `obBrick` wraps its per-block random with `mod(id, counts)`, so a baked map
 * holds only `across × up` distinct blocks and repeats them once per tile. At
 * cobble scale that is the same 28 setts every 55 cm, unbroken across the whole
 * square — the single loudest "printed grid" tell in the build. The shader
 * re-derives this lattice from world position and hashes the *unwrapped* id, so
 * every block in the level gets its own tone.
 *
 * Kept here rather than in the recipe because the recipes are shared with other
 * packages this wave. If a recipe's lattice ever changes, the mismatch degrades
 * gracefully: the tint rolls off at cell edges, so a misfit lands in the mortar.
 */
const CELL_LATTICE: Record<string, [number, number, number, number]> = {
  stone: [4, 7, 0.14, 53],
  brick: [8, 24, 0.05, 37],
};

/**
 * World-space story layers: [patch, damp, traffic, metalWash].
 *
 * A tiling base map physically cannot say "this bay was resurfaced", "this
 * corner never dries out", "this is where the wheels run" — every one of those
 * is a fact about *position in the world*, so it has to live in the shader.
 * Without them the ground plane holds a single value for sixty metres, which is
 * the first thing a stranger picks the real game out on.
 *
 * Ground families get the full set. Vertical families still get patches (a
 * facade is rendered in bays and repaired in patches) but almost no damp,
 * because the gravity terms are gated on an up-facing normal anyway.
 */
const SURF_LAYERS: Record<string, [number, number, number, number]> = {
  concrete: [0.95, 0.48, 0.80, 0],
  asphalt: [1.00, 0.55, 0.95, 0],
  stone: [0.90, 0.48, 0.75, 0],
  brick: [0.70, 0.45, 0.30, 0],
  plaster: [0.90, 0.30, 0.15, 0],
  tile: [0.55, 0.60, 0.55, 0],
  ceilingPanel: [0.35, 0.10, 0.05, 0],
  dirt: [0.70, 0.62, 0.70, 0],
  sand: [0.55, 0.60, 0.55, 0],
  gravel: [0.70, 0.60, 0.65, 0],
  grass: [0.55, 0.60, 0.35, 0],
  mud: [0.60, 0.85, 0.75, 0],
  snow: [0.40, 0.45, 0.60, 0],
  metal: [0.45, 0.35, 0.40, 0.95],
  metalThin: [0.40, 0.30, 0.30, 0.80],
  diamondPlate: [0.35, 0.30, 0.45, 0.85],
  aluminium: [0.25, 0.20, 0.30, 0.55],
  grate: [0.30, 0.25, 0.35, 0.70],
  pipe: [0.35, 0.30, 0.25, 0.60],
  wood: [0.55, 0.45, 0.35, 0],
  woodThin: [0.55, 0.45, 0.35, 0],
  plywood: [0.50, 0.45, 0.30, 0],
  crate: [0.45, 0.35, 0.25, 0],
  cardboard: [0.45, 0.40, 0.20, 0],
  rubber: [0.30, 0.30, 0.35, 0],
  plastic: [0.35, 0.30, 0.25, 0],
  fabric: [0.40, 0.30, 0.20, 0],
  sandbag: [0.40, 0.35, 0.20, 0],
  carpet: [0.40, 0.30, 0.25, 0],
};
const SURF_FALLBACK: [number, number, number, number] = [0.35, 0.25, 0.20, 0];

const EMISSIVE_DEFAULT: Record<EmissiveKind, { gain: number; rate: number; temp: number }> = {
  none: { gain: 1, rate: 1, temp: 1 },
  fluorescent: { gain: 3.4, rate: 1, temp: 1 },
  strobe: { gain: 5.5, rate: 1.15, temp: 1 },
  monitor: { gain: 2.2, rate: 1, temp: 1 },
  hotMetal: { gain: 1.0, rate: 1, temp: 0.85 },
  emergency: { gain: 3.0, rate: 1, temp: 1 },
  sodium: { gain: 4.0, rate: 1, temp: 1 },
};

/* --------------------------------------------------------------- system -- */

interface PendingUpgrade {
  material: THREE.MeshStandardMaterial;
  archetype: MaterialArchetype;
  opts: MaterialOptions;
}

export class MaterialSystem implements System {
  readonly name = 'materials';
  readonly order = ORDER.WORLD - 50;

  /** Every registered archetype, keyed by id. */
  readonly archetypes = new Map<string, MaterialArchetype>();

  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private textures = new Map<string, PbrTextureSet>();
  private pending: PendingUpgrade[] = [];
  private animated: THREE.MeshStandardMaterial[] = [];
  private forge: TextureForge | null = null;
  private details: DetailMaps | null = null;
  private engine: EngineContext['engine'] | null = null;
  private time = 0;
  private ready = false;
  private detailEnabled = true;

  constructor() {
    for (const a of ALL_ARCHETYPES) this.archetypes.set(a.id, a);
  }

  /* --------------------------------------------------------------- init -- */

  init(ctx: EngineContext): void {
    this.engine = ctx.engine;
    // RenderSystem initialises after us, so hook the end of engine boot.
    bus.on('game:ready', () => { void this.bringUp(); });
    bus.on('quality:changed', () => this.applyQuality());
    // If the renderer somehow already exists (debug harness), come up now.
    if (this.resolveRenderer()) void this.bringUp();
  }

  private resolveRenderer(): THREE.WebGLRenderer | null {
    const render = this.engine?.tryGet<System & { renderer?: THREE.WebGLRenderer }>('render');
    return render?.renderer ?? null;
  }

  /** Creates the forge and upgrades everything requested before the GPU existed. */
  private bringUp(): void {
    if (this.ready) return;
    const renderer = this.resolveRenderer();
    if (!renderer) return;
    this.ready = true;
    this.forge = new TextureForge(renderer);
    this.forge.quality = FORGE_QUALITY[settings.preset] ?? FORGE_QUALITY.high;
    this.forge.quality = { ...this.forge.quality, anisotropy: this.maxAnisotropy(renderer) };
    this.details = new DetailMaps(this.forge);

    // Shader errors are silent in a production build; turn checking on for the
    // forge passes only, so a broken recipe shows up in the capture log.
    const prevCheck = renderer.debug.checkShaderErrors;
    renderer.debug.checkShaderErrors = true;
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) this.upgrade(p.material, p.archetype, p.opts);
    renderer.debug.checkShaderErrors = prevCheck;
  }

  private maxAnisotropy(renderer: THREE.WebGLRenderer): number {
    return Math.min(settings.gfx.anisotropy, renderer.capabilities.getMaxAnisotropy());
  }

  private applyQuality(): void {
    const renderer = this.resolveRenderer();
    if (!this.forge || !renderer) return;
    this.forge.setAnisotropy(this.maxAnisotropy(renderer));
    // Texture resolution is baked at generation time; a preset change only
    // affects archetypes generated from here on.
    const q = FORGE_QUALITY[settings.preset] ?? FORGE_QUALITY.high;
    this.forge.quality = { ...q, anisotropy: this.maxAnisotropy(renderer) };
    this.detailEnabled = settings.preset !== 'low';
  }

  /* ------------------------------------------------------------ textures -- */

  /** Generates (and caches) the PBR stack for an archetype id. */
  texturesFor(id: string): PbrTextureSet | null {
    const cached = this.textures.get(id);
    if (cached) return cached;
    const arch = this.archetypes.get(id);
    if (!arch || !this.forge) return null;
    const set = this.forge.generate(arch.recipe);
    this.textures.set(id, set);
    return set;
  }

  /**
   * Pre-generates a set of archetypes. Yields to the browser between each one
   * so the boot screen can paint a progress bar.
   */
  async warmup(ids?: string[], onProgress?: (p: WarmupProgress) => void): Promise<void> {
    if (!this.ready) this.bringUp();
    if (!this.forge) return;
    const list = ids ?? [...this.archetypes.keys()];
    const renderer = this.resolveRenderer();
    const prevCheck = renderer ? renderer.debug.checkShaderErrors : false;
    if (renderer) renderer.debug.checkShaderErrors = true;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      onProgress?.({ done: i, total: list.length, current: id });
      this.texturesFor(id);
      if ((i & 3) === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (renderer) renderer.debug.checkShaderErrors = prevCheck;
    onProgress?.({ done: list.length, total: list.length, current: 'done' });
  }

  /* ----------------------------------------------------------- materials -- */

  /** Returns (and caches) a material for a surface archetype. */
  get(surface: SurfaceType, opts: MaterialOptions = {}): THREE.Material {
    return this.getStandard(surface, opts);
  }

  getStandard(surface: SurfaceType, opts: MaterialOptions = {}): THREE.MeshStandardMaterial {
    const id = opts.archetype ?? SURFACE_DEFAULT[surface] ?? 'concrete';
    return this.material(id, opts, surface);
  }

  /** Returns (and caches) a material for an explicit archetype id. */
  material(id: string, opts: MaterialOptions = {}, surface?: SurfaceType): THREE.MeshStandardMaterial {
    const arch = this.archetypes.get(id);
    const key = `${id}|${stableKey(opts)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const tag = surface ?? arch?.surface ?? 'concrete';
    const mat = new THREE.MeshStandardMaterial({
      color: opts.tint ?? 0xffffff,
      roughness: 1,
      metalness: 1,
      side: (opts.doubleSided ?? arch?.doubleSided) ? THREE.DoubleSide : THREE.FrontSide,
      transparent: opts.transparent ?? arch?.transparent ?? false,
      opacity: opts.opacity ?? arch?.opacity ?? 1,
      depthWrite: opts.depthWrite ?? true,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    });
    mat.name = key;
    mat.userData.surface = tag;
    mat.userData.archetype = id;

    if (!arch) {
      mat.color.set(opts.tint ?? FALLBACK_TINT[id] ?? 0x8a8a8a);
      mat.roughness = opts.roughness ?? 0.85;
      mat.metalness = opts.metalness ?? 0;
      this.cache.set(key, mat);
      return mat;
    }

    if (this.forge) {
      this.upgrade(mat, arch, opts);
    } else {
      // Flat stand-in until the GPU exists.
      mat.color.set(opts.tint ?? opts.fallbackColor ?? FALLBACK_TINT[id] ?? 0x8a8a8a);
      mat.roughness = opts.roughness ?? 0.88;
      mat.metalness = opts.metalness ?? (arch.metalness ?? 0);
      this.pending.push({ material: mat, archetype: arch, opts });
    }

    this.cache.set(key, mat);
    return mat;
  }

  /** Attaches the generated textures + shader extension to an existing material. */
  private upgrade(mat: THREE.MeshStandardMaterial, arch: MaterialArchetype, opts: MaterialOptions): void {
    const set = this.texturesFor(arch.id);
    if (!set) return;

    mat.map = set.albedo;
    mat.normalMap = set.normal;
    mat.roughnessMap = set.orm;
    mat.metalnessMap = set.orm;
    mat.aoMap = set.orm;
    mat.aoMapIntensity = 1;
    mat.normalScale.set(1, 1);
    mat.color.set(opts.tint ?? arch.color ?? 0xffffff);
    mat.roughness = opts.roughness ?? arch.roughness ?? 1;
    mat.metalness = opts.metalness ?? arch.metalness ?? 1;

    const tile = opts.scale ?? set.tile;
    const triplanar = opts.triplanar ?? arch.shader?.triplanar ?? true;

    // In UV mode the texture transform does the tiling; in triplanar mode the
    // shader derives UVs from world position, so the transform stays identity.
    const repeat = triplanar ? 1 : 1;
    for (const t of [set.albedo, set.normal, set.orm]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
    }

    const emissiveKind: EmissiveKind = arch.emissive ?? 'none';
    if (emissiveKind !== 'none') {
      mat.emissive.set(opts.emissive ?? 0xffffff);
      mat.emissiveIntensity = opts.emissiveIntensity ?? EMISSIVE_DEFAULT[emissiveKind].gain;
      mat.toneMapped = true;
      if (this.animated.indexOf(mat) < 0) this.animated.push(mat);
    }

    const blendSet = opts.blendWith ? this.texturesFor(opts.blendWith) : null;
    if (blendSet) mat.vertexColors = true;

    const detailKind = arch.detail ?? 'micro';
    const wantDetail = (opts.detail ?? this.detailEnabled) && detailKind !== 'none';
    const detailMap = wantDetail ? this.details?.get(detailKind) ?? null : null;

    const alphaFromMap = arch.shader?.alphaFromMap ?? false;
    if (alphaFromMap) {
      if (arch.transparent) { mat.transparent = true; }
      else { mat.alphaTest = 0.45; }
    }

    // World-space layers: macro breakup everywhere it makes sense, plus the
    // splash-back band that grounds vertical surfaces against the floor.
    const worldLayers = !NO_WORLD_LAYERS.has(arch.id) && emissiveKind === 'none';
    let macro = arch.shader?.macro ?? null;
    if (!macro && worldLayers) {
      const m = MACRO_DEFAULT[arch.id] ?? MACRO_FALLBACK;
      macro = new THREE.Vector4(1 / m[0], 1 / m[1], m[2], m[3]);
    }
    let groundBand = arch.shader?.ground ?? null;
    if (!groundBand && worldLayers) {
      const g = GROUND_BAND[arch.id];
      if (g) groundBand = new THREE.Vector3(0, 0.85, g);
    }
    // The story layers cost about a dozen extra 3D noise fetches per fragment,
    // which is nothing on a discrete GPU and is not free on an integrated one,
    // so the low preset keeps the macro drift and drops the rest.
    let surfaceLayers: THREE.Vector4 | null = null;
    if (worldLayers && settings.preset !== 'low') {
      const s = SURF_LAYERS[arch.id] ?? SURF_FALLBACK;
      surfaceLayers = new THREE.Vector4(s[0], s[1], s[2], s[3]);
    }
    const lat = worldLayers && settings.preset !== 'low' ? CELL_LATTICE[arch.id] : undefined;
    const cellLattice = lat ? new THREE.Vector4(lat[0], lat[1], lat[2], lat[3]) : null;

    const cfg: ShaderExtensionConfig = {
      tile,
      triplanar,
      triplanarSharpness: arch.shader?.triplanarSharpness ?? 6,
      detail: !!detailMap,
      detailMap,
      // `obDetUv` is already world position divided by `tile`, so multiplying by
      // `repeatsPerMetre * tile` makes the shader's own division cancel and the
      // layer land at a fixed density in *metres*, independent of world scale.
      //
      // The old expression divided the authored figure by `tile` a second time,
      // so detail frequency scaled as 1/tile²: cobble (recipe tile 2.4 squeezed
      // to 0.55) came out at 43 repeats/m — 0.7 mm features, an order of
      // magnitude under a pixel at 1 m — so its grit layer mipped to flat grey
      // and contributed nothing but aliasing, while plasterCream (tile 4.2) came
      // out at 1.68/m, near DC. Both are now inside the 4-8 repeats/m band that
      // puts the detail map's own cells at a legible 3-25 mm.
      detailScale: detailRepeatsPerMetre(arch) * tile,
      detailStrength: arch.shader?.detailStrength,
      // A long, lazy cross-fade. The old 4-14 m window put the whole
      // transition inside the part of the ground the player is looking at, so
      // there was a readable arc on the street where the grain stopped.
      detailFade: arch.shader?.detailFade ?? new THREE.Vector2(7, 26),
      pom: (opts.pom ?? arch.shader?.pom ?? false) && settings.preset !== 'low',
      pomDepth: arch.shader?.pomDepth ?? set.depth,
      pomShadow: (arch.shader?.pomShadow ?? false) && (settings.preset === 'ultra' || settings.preset === 'cinematic'),
      pomMinSteps: 8,
      pomMaxSteps: settings.preset === 'cinematic' ? 40 : 24,
      instanceVariation: opts.instanced ?? false,
      blend: blendSet,
      blendTile: opts.blendScale ?? blendSet?.tile,
      wear: opts.wear ?? 0,
      specularAA: true,
      normalFadeDistance: 9,
      macro,
      surface: surfaceLayers,
      ground: groundBand,
      cellTone: cellLattice,
      alphaFromMap,
      uvVariation: arch.shader?.uvVariation ?? false,
      emissiveMode: EMISSIVE_MODES[emissiveKind],
    };

    const u = extendStandardMaterial(mat, cfg);
    u.obHueSat.value.set(opts.hue ?? 0, opts.saturation ?? 1);
    const em = EMISSIVE_DEFAULT[emissiveKind];
    u.obEmissive.value.set(1, em.rate, hash01(arch.id) * 10, em.temp);
    mat.needsUpdate = true;
  }

  /* ------------------------------------------------------------- runtime -- */

  update(dt: number): void {
    if (!this.animated.length) return;
    this.time += dt;
    for (const m of this.animated) {
      const u = materialUniforms(m);
      if (u) u.obTime.value = this.time;
    }
  }

  /** Sets the heat level of every hot-metal material, 0..1. */
  setHeat(value: number): void {
    for (const m of this.animated) {
      if (m.userData.archetype !== 'hotMetal') continue;
      const u = materialUniforms(m);
      if (u) u.obEmissive.value.w = value;
    }
  }

  /** Every archetype id in the registry, for the debug grid and tooling. */
  listArchetypes(): MaterialArchetype[] {
    return [...this.archetypes.values()];
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.details?.dispose();
    this.forge?.dispose();
    this.forge = null;
    this.animated.length = 0;
    this.pending.length = 0;
    this.ready = false;
  }
}

/* ---------------------------------------------------------------- utils -- */

/**
 * Detail-layer density in repeats per metre.
 *
 * Archetypes author `shader.detailScale` as "repeats per base-map tile", which
 * is a texel-space number and says nothing about how big the grain is in the
 * world. Reinterpreting it as a *relative* density and clamping to 4-8 per
 * metre is what keeps the layer legible: the detail maps put their own cells at
 * 6-150 per repeat, so 4/m gives features from 1.7 mm to 4 cm and 8/m gives
 * 0.8 mm to 2 cm. Below 4 the layer is a low-frequency stain; above 8 it is
 * under a pixel at 1 m and mips straight back to grey.
 */
const DETAIL_RPM_MIN = 4.0;
const DETAIL_RPM_MAX = 8.0;

function detailRepeatsPerMetre(arch: MaterialArchetype): number {
  const authored = arch.shader?.detailScale ?? 12;
  return Math.min(DETAIL_RPM_MAX, Math.max(DETAIL_RPM_MIN, authored * 0.22));
}

function stableKey(o: MaterialOptions): string {
  const keys = Object.keys(o).sort();
  let s = '';
  for (const k of keys) {
    const v = (o as unknown as Record<string, unknown>)[k];
    if (v === undefined) continue;
    s += `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)};`;
  }
  return s;
}

function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/* Registering the debug scene is a side effect of importing the module that
 * main.ts already imports, which is what lets this subsystem own its own
 * visual verification without touching shared files. */
import './DebugScene';
