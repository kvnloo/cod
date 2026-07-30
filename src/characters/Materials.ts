/**
 * Character material library.
 *
 * Five materials clothe every soldier in the game — skin, uniform cloth,
 * load-bearing nylon, hard kit and metal — and they are shared by every
 * instance. Per-character colour lives in the mesh's vertex tint, so a squad of
 * eight costs eight geometries but only five materials and five texture sets
 * per faction family.
 *
 * Textures are generated on the GPU through the material module's public
 * `TextureForge`; nothing is loaded from disk. If the renderer is not available
 * (unit tests, headless construction) every material degrades to a sensible
 * flat colour rather than throwing, so geometry work can proceed without a GL
 * context.
 */

import * as THREE from 'three';
import {
  TextureForge, FORGE_QUALITY, extendStandardMaterial,
  type PbrTextureSet, type ForgeRecipe, type ShaderExtensionConfig,
} from '../material';
import { settings } from '../core/Settings';
import type { CharacterFaction } from './types';
import { SLOT, SLOT_COUNT, type SlotId } from './geom/Builder';
import {
  CAMO, DETAIL_FRAGMENT, HARD_RECIPE, METAL_RECIPE, SKIN_RECIPE,
  clothRecipe, gearRecipe,
} from './recipes';

/** Which camo family each faction wears. */
const FACTION_CAMO: Record<CharacterFaction, string> = {
  militia: 'woodland',
  pmc: 'arid',
  spetsnaz: 'urban',
  player: 'plain',
};

const FALLBACK: number[] = [0xb08a72, 0x8a8468, 0x6d6552, 0x5c5b56, 0x9a9a9e];

/**
 * Micro-detail strength per slot, as (normal, albedo, roughness).
 *
 * Cloth and nylon need a strong fibre normal — at a metre, a uniform without
 * one is a painted surface — while skin wants almost none (pores are already in
 * its own height field) and polymer wants a whisper of orange peel.
 */
const DETAIL_STRENGTH: THREE.Vector3[] = [
  new THREE.Vector3(0.20, 0.07, 0.06),   // skin
  new THREE.Vector3(0.62, 0.13, 0.16),   // cloth
  new THREE.Vector3(0.58, 0.12, 0.15),   // gear
  new THREE.Vector3(0.30, 0.08, 0.10),   // hard
  new THREE.Vector3(0.22, 0.06, 0.07),   // metal
];
const DETAIL_FADE = new THREE.Vector2(1.4, 5.0);

export class CharacterMaterials {
  private forge: TextureForge | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private sets = new Map<string, PbrTextureSet>();
  private detailMap: THREE.Texture | null = null;
  private pending: { mat: THREE.MeshStandardMaterial; recipe: ForgeRecipe; slot: SlotId }[] = [];

  /** True once a GL context has been supplied and textures can be generated. */
  get ready(): boolean { return this.forge !== null; }

  /** Attaches a renderer; any materials created before this are upgraded. */
  attach(renderer: THREE.WebGLRenderer): void {
    if (this.forge) return;
    this.renderer = renderer;
    this.forge = new TextureForge(renderer);
    const q = FORGE_QUALITY[settings.preset] ?? FORGE_QUALITY.high;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.forge.quality = { ...q, anisotropy: Math.min(q.anisotropy, maxAniso) };
    for (const p of this.pending) this.upgrade(p.mat, p.recipe, p.slot);
    this.pending.length = 0;
  }

  /** Recipe for a slot, specialised for a faction where it matters. */
  private recipeFor(slot: SlotId, faction: CharacterFaction): ForgeRecipe {
    switch (slot) {
      case SLOT.SKIN: return SKIN_RECIPE;
      case SLOT.CLOTH: {
        const key = FACTION_CAMO[faction] ?? 'plain';
        return clothRecipe(`chCloth_${key}`, CAMO[key] ?? CAMO.plain, 1201 + key.length * 37);
      }
      case SLOT.GEAR: return gearRecipe('chGear', 907);
      case SLOT.HARD: return HARD_RECIPE;
      default: return METAL_RECIPE;
    }
  }

  private keyFor(slot: SlotId, faction: CharacterFaction): string {
    return slot === SLOT.CLOTH ? `cloth:${FACTION_CAMO[faction] ?? 'plain'}` : `slot:${slot}`;
  }

  /** The material for one slot of one faction. Cached and shared. */
  get(slot: SlotId, faction: CharacterFaction): THREE.MeshStandardMaterial {
    const key = this.keyFor(slot, faction);
    const cached = this.materials.get(key);
    if (cached) return cached;

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
      metalness: slot === SLOT.METAL ? 1 : 0,
      side: THREE.FrontSide,
    });
    mat.name = `character:${key}`;
    mat.userData.surface = slot === SLOT.SKIN ? 'flesh' : slot === SLOT.METAL ? 'metal' : 'fabric';

    const recipe = this.recipeFor(slot, faction);
    if (this.forge) this.upgrade(mat, recipe, slot);
    else {
      mat.color.setHex(FALLBACK[slot]).convertSRGBToLinear();
      mat.roughness = 0.85;
      this.pending.push({ mat, recipe, slot });
    }

    this.materials.set(key, mat);
    return mat;
  }

  /** Every material a character needs, indexed by slot. */
  all(faction: CharacterFaction): THREE.MeshStandardMaterial[] {
    const out: THREE.MeshStandardMaterial[] = [];
    for (let s = 0; s < SLOT_COUNT; s++) out.push(this.get(s as SlotId, faction));
    return out;
  }

  /** Pre-generates every texture set a faction list needs. */
  async warm(factions: readonly CharacterFaction[]): Promise<void> {
    for (const f of factions) {
      for (let s = 0; s < SLOT_COUNT; s++) {
        this.get(s as SlotId, f);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  private textures(recipe: ForgeRecipe): PbrTextureSet | null {
    if (!this.forge) return null;
    const cached = this.sets.get(recipe.id);
    if (cached) return cached;
    const prev = this.renderer ? this.renderer.debug.checkShaderErrors : false;
    if (this.renderer) this.renderer.debug.checkShaderErrors = true;
    const set = this.forge.generate(recipe);
    if (this.renderer) this.renderer.debug.checkShaderErrors = prev;
    this.sets.set(recipe.id, set);
    return set;
  }

  private detail(): THREE.Texture | null {
    if (!this.forge) return null;
    if (this.detailMap) return this.detailMap;
    this.detailMap = this.forge.generateSingle({
      id: 'chDetail', size: 512, fragment: DETAIL_FRAGMENT, srgb: false,
    });
    return this.detailMap;
  }

  private upgrade(mat: THREE.MeshStandardMaterial, recipe: ForgeRecipe, slot: SlotId): void {
    const set = this.textures(recipe);
    if (!set) return;
    mat.map = set.albedo;
    mat.normalMap = set.normal;
    mat.roughnessMap = set.orm;
    mat.metalnessMap = set.orm;
    mat.aoMap = set.orm;
    mat.aoMapIntensity = 1;
    mat.color.setRGB(1, 1, 1);
    mat.roughness = 1;
    mat.metalness = 1;
    mat.normalScale.set(1, 1);
    // A soldier is a small, self-shadowing object made almost entirely of
    // vertical surfaces, so the sky probe is nearly all the fill he ever gets.
    // Under-weighting it is what sends the shadow side of a face to black while
    // the ground beside him still reads.
    mat.envMapIntensity = slot === SLOT.SKIN ? 1.6 : 1.35;
    for (const t of [set.albedo, set.normal, set.orm]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1, 1);
    }

    const wantDetail = settings.preset !== 'low';
    const detailMap = wantDetail ? this.detail() : null;
    const cfg: ShaderExtensionConfig = {
      tile: 1,
      triplanar: false,
      detail: !!detailMap,
      detailMap,
      // UVs are authored in tile units, so this is "repeats of the micro layer
      // inside one texture repeat" — about one weave cell every 2 cm.
      detailScale: slot === SLOT.SKIN ? 9 : slot === SLOT.METAL ? 6 : 14,
      detailStrength: DETAIL_STRENGTH[slot] ?? DETAIL_STRENGTH[1],
      detailFade: DETAIL_FADE,
      pom: false,
      instanceVariation: false,
      wear: 0,
      specularAA: true,
      normalFadeDistance: 9,
    };
    extendStandardMaterial(mat, cfg);
    mat.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const s of this.sets.values()) s.dispose();
    this.sets.clear();
    this.forge?.dispose();
    this.forge = null;
  }
}
