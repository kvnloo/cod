/**
 * Weapon surface library.
 *
 * The environment material system is built around triplanar world-space
 * projection, which is exactly wrong for an object that moves with the camera:
 * the texture would swim across the receiver as you walk. Weapons therefore
 * get their own small set of forge recipes, sampled through *object-space* UVs
 * that `mesh/Geo.projectUV` bakes at build time. One texel density everywhere,
 * zero swimming, and no authored UVs.
 *
 * Six surfaces cover a whole armoury:
 *
 *   phosphate  parkerised steel — matte, crystalline, the default receiver
 *   blued      polished blue-black steel — barrels, slides, bolts
 *   polymer    injection-moulded furniture — stipple, mould flow, scuffs
 *   rubber     over-moulded grip — deep matte, fine pebble
 *   alu        hard-anodised aluminium — bead-blasted, wears bright
 *   wood       oiled walnut — open pore, satin varnish
 *
 * Everything is generated on the GPU at boot from `TextureForge`; there are no
 * image files anywhere in this module.
 */

import * as THREE from 'three';
import { FORGE_QUALITY, TextureForge, type ForgeRecipe, type PbrTextureSet } from '../material';
import { settings } from '../core/Settings';
import type { MaterialKey } from './types';

/** Metres of weapon covered by one texture repeat. Matches `projectUV`. */
export const WEAPON_TEXEL_SCALE = 0.10;

/* ----------------------------------------------------------- shared GLSL */

const COMMON = /* glsl */ `
/** Bright bare steel revealed where a finish has worn through. */
vec3 obBareSteel(vec2 uv, float seed) {
  return obRGB(168, 172, 178) * mix(0.86, 1.10, obValueP(uv * 340.0, vec2(340.0), seed));
}
/** Tool marks left by a broach or a lathe: fine, directional, never uniform. */
float obToolMarks(vec2 uv, float freq, float seed) {
  float a = obValueP(vec2(uv.x * freq, uv.y * 6.0), vec2(freq, 6.0), seed);
  float b = obValueP(vec2(uv.x * freq * 2.7, uv.y * 11.0), vec2(freq * 2.7, 11.0), seed + 3.0);
  return a * 0.62 + b * 0.38;
}
`;

/* --------------------------------------------------------------- recipes */

const phosphate: ForgeRecipe = {
  id: 'wpn_phosphate',
  seed: 811,
  size: 1024,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00060 },
  normalGain: 1.25,
  normalWide: 0.45,
  aoRadius: 0.030,
  aoStrength: 0.7,
  aoAlbedo: 0.16,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // The height field is dominated by *macro* form — cast texture, sink marks,
  // handling wear — because everything downstream (AO, curvature, the wear
  // masks) is derived from it. A field made of nothing but micro-crystals
  // produces micro-curvature everywhere, which reads as white noise once the
  // mip chain averages it.
  float form = obFbm(uv * 7.0, vec2(7.0), 5, 0.55, uSeed);
  float h = 0.46 + (form - 0.5) * 0.44;

  // Cast/forged orange peel.
  h += (obFbm(uv * 26.0, vec2(26.0), 3, 0.5, uSeed + 13.0) - 0.5) * 0.13;

  // Manganese phosphate crystals: a fine, low-amplitude grain on top.
  float crys = obWorleyFbm(uv * 120.0, vec2(120.0), 2, 1.0, uSeed);
  h += (crys - 0.5) * 0.10;

  // Broaching marks under the finish, running along the part.
  float tool = obToolMarks(uv, 90.0, uSeed + 11.0);
  h += (tool - 0.5) * 0.05;

  // Burnished patches where the weapon is handled and holstered.
  float rub = obFbm(obWarp(uv * 3.2, vec2(3.2), 0.5, uSeed + 17.0), vec2(3.2), 4, 0.55, uSeed + 19.0);
  float worn = smoothstep(0.52, 0.86, rub);
  h += worn * 0.05;

  // Isolated impact dings.
  vec3 dn = obWorleyP(uv * 9.0, vec2(9.0), 1.0, uSeed + 23.0);
  float ding = smoothstep(0.20, 0.0, dn.x) * step(0.90, dn.z);
  h -= ding * 0.26;

  float scratch = obScratches(uv, 14.0, 1.2, 26.0, 0.20, uSeed + 29.0);
  h -= scratch * 0.14;

  h0 = vec4(clamp(h, 0.0, 1.0), worn, scratch, ding);
  h1 = vec4(crys, tool, form, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float worn = h0.y, scratch = h0.z, ding = h0.w;
  float crys = h1.x, form = h1.z;

  // Parkerising is a very dark grey with a faint green-brown cast.
  vec3 park = obRGB(66, 67, 63);
  park = mix(park, obRGB(86, 86, 78), obSat(crys * 1.2 - 0.15));
  park = mix(park, obRGB(48, 49, 49), obSat(1.0 - crys * 1.5));
  park = mix(park, obRGB(76, 72, 62), obSat(form * 1.1 - 0.15) * 0.7);

  vec3 steel = obBareSteel(uv, uSeed + 37.0);

  // Wear comes from macro handling patches and scratches. Curvature gets only
  // a light touch: it is the finest-scale signal in the whole stack and it is
  // the first thing to alias.
  float edge = obSat(d.curv * 0.55);
  float bare = obSat(worn * 0.30 + edge * 0.22 + scratch * 0.85);
  bare = smoothstep(0.34, 0.86, bare) * 0.72;

  vec3 col = mix(park, steel, bare);
  // Oil and carbon collect in the low spots.
  float grime = obSat(d.cavity * 1.3 + (1.0 - d.ao) * 0.8);
  col = mix(col, obRGB(36, 36, 34), grime * 0.40);
  col = mix(col, obRGB(44, 45, 45), ding * 0.4);

  o.albedo = col;
  o.metal = mix(0.88, 1.0, bare);
  float rough = mix(0.78, 0.34, bare);
  rough = mix(rough, 0.68, worn * 0.35);
  rough += grime * 0.08;
  o.rough = clamp(rough, 0.22, 0.95);
}`,
};

const blued: ForgeRecipe = {
  id: 'wpn_blued',
  seed: 823,
  size: 512,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00028 },
  normalGain: 1.1,
  normalWide: 0.5,
  aoRadius: 0.022,
  aoStrength: 0.5,
  aoAlbedo: 0.10,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Draw-polished before bluing: long, very fine directional lines over a
  // gently undulating polished surface.
  float form = obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 3.0);
  float polish = obBrushed(vec2(uv.y, uv.x), 4.0, 260.0, uSeed);
  float h = 0.52 + (form - 0.5) * 0.30 + (polish - 0.5) * 0.20;

  float scratch = obScratches(uv, 10.0, 0.4, 30.0, 0.16, uSeed + 11.0);
  h -= scratch * 0.30;

  vec3 dn = obWorleyP(uv * 11.0, vec2(11.0), 1.0, uSeed + 17.0);
  float ding = smoothstep(0.15, 0.0, dn.x) * step(0.93, dn.z);
  h -= ding * 0.28;

  // Holster wear: broad, soft regions where the blue has thinned.
  float rub = obFbm(obWarp(uv * 2.6, vec2(2.6), 0.6, uSeed + 23.0), vec2(2.6), 4, 0.55, uSeed + 29.0);
  float worn = smoothstep(0.58, 0.88, rub);

  h0 = vec4(clamp(h, 0.0, 1.0), worn, scratch, ding);
  h1 = vec4(polish, form, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float worn = h0.y, scratch = h0.z, ding = h0.w;
  float polish = h1.x, form = h1.y;

  vec3 blue = obRGB(36, 38, 46);
  blue = mix(blue, obRGB(56, 61, 74), obSat(polish * 1.1 - 0.1));
  blue = mix(blue, obRGB(25, 27, 33), obSat(1.0 - form * 1.3) * 0.6);

  vec3 steel = obBareSteel(uv, uSeed + 43.0);
  float edge = obSat(d.curv * 0.5);
  float bare = smoothstep(0.36, 0.90, obSat(worn * 0.34 + edge * 0.20 + scratch * 1.0)) * 0.60;

  vec3 col = mix(blue, steel, bare);
  float grime = obSat(d.cavity * 1.1 + (1.0 - d.ao) * 0.7);
  col = mix(col, obRGB(27, 27, 27), grime * 0.32);
  col = mix(col, obRGB(52, 54, 58), ding * 0.45);

  o.albedo = col;
  o.metal = 1.0;
  float rough = mix(0.28, 0.16, bare);
  rough = mix(rough, 0.44, worn * 0.4);
  rough += grime * 0.08;
  o.rough = clamp(rough, 0.10, 0.68);
}`,
};

const polymer: ForgeRecipe = {
  id: 'wpn_polymer',
  seed: 839,
  size: 1024,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00075 },
  normalGain: 1.15,
  normalWide: 0.5,
  aoRadius: 0.030,
  aoStrength: 0.75,
  aoAlbedo: 0.18,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Injection-moulded furniture: a soft macro form from the tool, plus the
  // spark-eroded pebble grain that gives polymer its characteristic tooth.
  float form = obFbm(uv * 5.0, vec2(5.0), 4, 0.55, uSeed + 31.0);
  float h = 0.48 + (form - 0.5) * 0.26;

  vec3 peb = obWorleyP(uv * 64.0, vec2(64.0), 1.0, uSeed);
  float grain = 1.0 - smoothstep(0.0, 0.46, peb.x);
  h += grain * 0.26;
  h += (obFbm(uv * 180.0, vec2(180.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.09;

  // Flow lines from the gate.
  float flow = obFbm(obWarp(uv * vec2(2.0, 6.0), vec2(2.0, 6.0), 0.35, uSeed + 7.0), vec2(2.0, 6.0), 4, 0.5, uSeed + 11.0);
  h += (flow - 0.5) * 0.10;

  // Scuffs and gouges: polymer stress-whitens where it is dragged.
  float scuff = obScratches(uv, 11.0, 1.6, 18.0, 0.24, uSeed + 13.0);
  h -= scuff * 0.16;
  vec3 dn = obWorleyP(uv * 8.0, vec2(8.0), 1.0, uSeed + 17.0);
  float gouge = smoothstep(0.18, 0.0, dn.x) * step(0.90, dn.z);
  h -= gouge * 0.28;

  h0 = vec4(clamp(h, 0.0, 1.0), scuff, gouge, grain);
  h1 = vec4(flow, form, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float scuff = h0.y, gouge = h0.z, grain = h0.w;
  float flow = h1.x, form = h1.y;

  vec3 base = obRGB(46, 47, 49);
  base = mix(base, obRGB(35, 36, 38), obSat(1.0 - grain * 1.2));
  base = mix(base, obRGB(59, 59, 61), flow * 0.30 + obSat(form - 0.5) * 0.3);

  // Stress whitening on scuffs; never metallic, never shiny.
  float edge = obSat(d.curv * 0.45);
  float white = obSat(scuff * 1.1 + edge * 0.30 + gouge * 0.8);
  vec3 col = mix(base, obRGB(104, 105, 108), smoothstep(0.22, 0.95, white) * 0.55);

  float grime = obSat(d.cavity * 1.2 + (1.0 - d.ao) * 0.8);
  col = mix(col, obRGB(30, 29, 29), grime * 0.32);

  o.albedo = col;
  o.metal = 0.0;
  float rough = mix(0.74, 0.58, grain);
  rough = mix(rough, 0.46, edge * 0.5);
  rough += grime * 0.08 + scuff * 0.08;
  o.rough = clamp(rough, 0.34, 0.94);
}`,
};

const rubber: ForgeRecipe = {
  id: 'wpn_rubber',
  seed: 853,
  size: 512,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00110 },
  normalGain: 1.0,
  normalWide: 0.55,
  aoRadius: 0.034,
  aoStrength: 0.8,
  aoAlbedo: 0.22,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float form = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 21.0);
  vec3 peb = obWorleyP(uv * 34.0, vec2(34.0), 1.0, uSeed);
  float pebble = 1.0 - smoothstep(0.0, 0.52, peb.x);
  float h = 0.38 + pebble * 0.42 + (form - 0.5) * 0.16;
  h += (obFbm(uv * 130.0, vec2(130.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.07;
  float wear = smoothstep(0.55, 0.88, obFbm(uv * 2.8, vec2(2.8), 4, 0.55, uSeed + 7.0));
  h -= pebble * wear * 0.30;
  h0 = vec4(clamp(h, 0.0, 1.0), pebble, wear, 0.0);
  h1 = vec4(form, 0.0, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float pebble = h0.y, wear = h0.z;
  vec3 col = obRGB(31, 31, 32);
  col = mix(col, obRGB(45, 45, 46), pebble * 0.55);
  col = mix(col, obRGB(55, 54, 52), wear * 0.35);
  float grime = obSat(d.cavity * 1.2 + (1.0 - d.ao) * 0.8);
  col = mix(col, obRGB(22, 21, 21), grime * 0.45);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.94 - wear * 0.18 - obSat(d.curv) * 0.05, 0.62, 0.99);
}`,
};

const alu: ForgeRecipe = {
  id: 'wpn_alu',
  seed: 863,
  size: 512,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00034 },
  normalGain: 1.1,
  normalWide: 0.5,
  aoRadius: 0.024,
  aoStrength: 0.55,
  aoAlbedo: 0.12,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float form = obFbm(uv * 8.0, vec2(8.0), 4, 0.5, uSeed + 5.0);
  // Bead blast before anodising: isotropic dimples, no direction at all.
  vec3 bead = obWorleyP(uv * 150.0, vec2(150.0), 1.0, uSeed);
  float dimple = 1.0 - smoothstep(0.0, 0.42, bead.x);
  float h = 0.50 + (form - 0.5) * 0.26 + (dimple - 0.4) * 0.20;
  float tool = obToolMarks(uv, 70.0, uSeed + 9.0);
  h += (tool - 0.5) * 0.06;
  float scratch = obScratches(uv, 12.0, 2.0, 22.0, 0.18, uSeed + 13.0);
  h -= scratch * 0.22;
  h0 = vec4(clamp(h, 0.0, 1.0), scratch, dimple, tool);
  h1 = vec4(form, 0.0, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float scratch = h0.y, dimple = h0.z;
  float form = h1.x;
  vec3 anod = obRGB(54, 55, 57);
  anod = mix(anod, obRGB(70, 71, 73), dimple * 0.45);
  anod = mix(anod, obRGB(43, 44, 46), obSat(1.0 - form * 1.3) * 0.55);
  vec3 bright = obRGB(176, 178, 182);
  float edge = obSat(d.curv * 0.5);
  float bare = smoothstep(0.38, 0.92, obSat(edge * 0.28 + scratch * 1.1)) * 0.55;
  vec3 col = mix(anod, bright, bare);
  float grime = obSat(d.cavity * 1.1 + (1.0 - d.ao) * 0.7);
  col = mix(col, obRGB(34, 34, 33), grime * 0.30);
  o.albedo = col;
  o.metal = mix(0.80, 1.0, bare);
  o.rough = clamp(mix(0.50, 0.24, bare) + grime * 0.08, 0.20, 0.82);
}`,
};

const wood: ForgeRecipe = {
  id: 'wpn_wood',
  seed: 877,
  size: 512,
  geometry: { tile: WEAPON_TEXEL_SCALE * 2.6, depth: 0.00055 },
  normalGain: 1.1,
  normalWide: 0.5,
  aoRadius: 0.028,
  aoAlbedo: 0.16,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Growth rings stretched hard along the grain direction.
  vec2 p = obWarp(vec2(uv.x * 7.0, uv.y * 0.8), vec2(7.0, 0.8), 0.5, uSeed);
  float rings = obFbm(p, vec2(7.0, 0.8), 5, 0.55, uSeed + 3.0);
  float grain = abs(fract(rings * 4.0) - 0.5) * 2.0;
  float h = 0.56 + (1.0 - grain) * 0.18;

  // Open pores: short dashes running along the grain.
  float pore = obScratches(vec2(uv.y, uv.x), 40.0, 0.2, 26.0, 0.45, uSeed + 7.0);
  h -= pore * 0.22;
  h += (obFbm(uv * 70.0, vec2(70.0), 3, 0.5, uSeed + 11.0) - 0.5) * 0.06;

  vec3 dn = obWorleyP(uv * 7.0, vec2(7.0), 1.0, uSeed + 17.0);
  float ding = smoothstep(0.16, 0.0, dn.x) * step(0.88, dn.z);
  h -= ding * 0.26;

  h0 = vec4(clamp(h, 0.0, 1.0), grain, pore, ding);
  h1 = vec4(rings, 0.0, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float grain = h0.y, pore = h0.z, ding = h0.w;
  float rings = h1.x;

  vec3 light = obRGB(118, 76, 44);
  vec3 dark = obRGB(64, 37, 21);
  vec3 col = mix(light, dark, obSat(1.0 - grain));
  col = mix(col, obRGB(45, 26, 15), pore * 0.65);
  col = mix(col, obRGB(88, 54, 30), obSat(rings * 1.2 - 0.2) * 0.35);

  float grime = obSat(d.cavity * 1.2 + (1.0 - d.ao) * 0.8);
  col = mix(col, obRGB(30, 19, 12), grime * 0.38);
  col = mix(col, obRGB(138, 98, 62), ding * 0.35);

  o.albedo = col;
  o.metal = 0.0;
  // Satin oil finish: shiny on the flats, dull inside the pores.
  o.rough = clamp(0.44 + pore * 0.30 + grime * 0.10, 0.26, 0.92);
}`,
};

const RECIPES: Record<string, ForgeRecipe> = {
  phosphate, blued, polymer, rubber, alu, wood,
};

/** Flat stand-ins used before the GPU exists and on the `low` preset. */
const FALLBACK: Record<MaterialKey, { color: number; rough: number; metal: number }> = {
  phosphate: { color: 0x3a3b39, rough: 0.68, metal: 0.9 },
  blued: { color: 0x1e2026, rough: 0.28, metal: 1.0 },
  polymer: { color: 0x2b2c2e, rough: 0.62, metal: 0.0 },
  polymerTan: { color: 0x6f6047, rough: 0.62, metal: 0.0 },
  rubber: { color: 0x1d1d1e, rough: 0.92, metal: 0.0 },
  alu: { color: 0x38393c, rough: 0.46, metal: 0.85 },
  wood: { color: 0x5c3a22, rough: 0.48, metal: 0.0 },
  brass: { color: 0xa8813a, rough: 0.30, metal: 1.0 },
  glass: { color: 0x0d1418, rough: 0.06, metal: 0.0 },
  lens: { color: 0x0a1c26, rough: 0.04, metal: 0.0 },
  black: { color: 0x232426, rough: 0.55, metal: 0.2 },
};

/** Which forge recipe backs each material key, and any colour multiplier. */
const SOURCE: Record<MaterialKey, { recipe: string | null; tint: number }> = {
  phosphate: { recipe: 'phosphate', tint: 0xffffff },
  blued: { recipe: 'blued', tint: 0xffffff },
  polymer: { recipe: 'polymer', tint: 0xffffff },
  polymerTan: { recipe: 'polymer', tint: 0xa08a63 },
  rubber: { recipe: 'rubber', tint: 0xffffff },
  alu: { recipe: 'alu', tint: 0xffffff },
  wood: { recipe: 'wood', tint: 0xffffff },
  brass: { recipe: 'blued', tint: 0xd8a24c },
  black: { recipe: 'polymer', tint: 0x8a8c90 },
  glass: { recipe: null, tint: 0xffffff },
  lens: { recipe: null, tint: 0xffffff },
};

/* ---------------------------------------------------------------- system */

/**
 * Which scene a material instance belongs to.
 *
 * This distinction is not cosmetic. The renderer patches every material it
 * finds, and it scans the world scene before the view-model scene — so a
 * material shared between a dropped grenade and the first-person weapon would
 * be compiled with world-space sun and aerial perspective and then used in
 * view space, where neither means anything. Keeping two instances per surface
 * costs one extra program and removes the whole class of bug.
 */
export type MaterialSpace = 'view' | 'world';

export class WeaponMaterials {
  private forge: TextureForge | null = null;
  private sets = new Map<string, PbrTextureSet>();
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private upgraded = false;

  /** True once the GPU textures are attached. */
  get ready(): boolean { return this.upgraded; }

  /** Returns a shared material for a key; safe to call before the GPU exists. */
  get(key: MaterialKey, space: MaterialSpace = 'view'): THREE.MeshStandardMaterial {
    const id = `${key}|${space}`;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const fb = FALLBACK[key];
    const mat = key === 'glass' || key === 'lens'
      ? this.makeGlass(key)
      : new THREE.MeshStandardMaterial({
        color: fb.color,
        roughness: fb.rough,
        metalness: fb.metal,
        envMapIntensity: 1.0,
      });
    mat.name = `weapon:${key}:${space}`;
    mat.userData.surface = key === 'wood' ? 'wood' : key === 'polymer' || key === 'polymerTan' ? 'plastic' : 'metal';
    this.cache.set(id, mat);
    if (this.forge) this.upgradeOne(key, mat);
    return mat;
  }

  /** Convenience accessor for world-space meshes (grenades, dropped weapons). */
  world(key: MaterialKey): THREE.MeshStandardMaterial { return this.get(key, 'world'); }

  private makeGlass(key: MaterialKey): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: key === 'lens' ? 0x0e2b38 : 0x0a1014,
      roughness: 0.045,
      metalness: 0.0,
      transparent: true,
      opacity: key === 'lens' ? 0.62 : 0.42,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    // A lens is mostly a coated mirror: a strong environment tint sells it far
    // better than physically-correct transmission, and costs nothing.
    m.envMapIntensity = key === 'lens' ? 2.6 : 1.6;
    m.emissive = new THREE.Color(key === 'lens' ? 0x061a22 : 0x000000);
    return m;
  }

  /** Builds the forge and upgrades every material created so far. */
  bringUp(renderer: THREE.WebGLRenderer): void {
    if (this.forge) return;
    this.forge = new TextureForge(renderer);
    const q = FORGE_QUALITY[settings.preset] ?? FORGE_QUALITY.high;
    this.forge.quality = {
      ...q,
      anisotropy: Math.min(settings.gfx.anisotropy, renderer.capabilities.getMaxAnisotropy()),
    };
    const prev = renderer.debug.checkShaderErrors;
    renderer.debug.checkShaderErrors = true;
    for (const [id, mat] of this.cache) this.upgradeOne(id.split('|')[0] as MaterialKey, mat);
    renderer.debug.checkShaderErrors = prev;
    this.upgraded = true;
  }

  /** Generates every recipe up front so the first draw is never a texture pop. */
  warmup(renderer: THREE.WebGLRenderer): void {
    this.bringUp(renderer);
    for (const id of Object.keys(RECIPES)) this.textures(id);
  }

  private textures(id: string): PbrTextureSet | null {
    const have = this.sets.get(id);
    if (have) return have;
    const recipe = RECIPES[id];
    if (!recipe || !this.forge) return null;
    const set = this.forge.generate(recipe);
    for (const t of [set.albedo, set.normal, set.orm]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1, 1);
    }
    this.sets.set(id, set);
    return set;
  }

  private upgradeOne(key: MaterialKey, mat: THREE.MeshStandardMaterial): void {
    const src = SOURCE[key];
    if (!src.recipe) return;
    const set = this.textures(src.recipe);
    if (!set) return;
    mat.map = set.albedo;
    mat.normalMap = set.normal;
    mat.roughnessMap = set.orm;
    mat.metalnessMap = set.orm;
    mat.aoMap = set.orm;
    mat.aoMapIntensity = 0.7;
    mat.normalScale.set(1, 1);
    mat.color.setHex(src.tint);
    mat.roughness = 1;
    mat.metalness = 1;
    if (key === 'polymer' || key === 'polymerTan' || key === 'rubber' || key === 'wood' || key === 'black') {
      // The ORM's metal channel is authored at 0 for these, but keep the
      // multiplier honest so a future recipe change cannot make furniture shiny.
      mat.metalness = key === 'black' ? 0.35 : 1;
    }
    mat.needsUpdate = true;
  }

  dispose(): void {
    for (const s of this.sets.values()) s.dispose();
    this.sets.clear();
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    this.forge?.dispose();
    this.forge = null;
    this.upgraded = false;
  }
}
