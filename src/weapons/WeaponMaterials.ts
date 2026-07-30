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

/**
 * Metres of weapon covered by one texture repeat. Matches `projectUV`.
 *
 * Tuned against the *repeat* rather than the density: at 0.10 m a 40 cm
 * receiver shows the same square four times and the eye finds the loop
 * immediately. 0.15 m still gives ~7 k texels per metre from a 1024² map —
 * about two texels per screen pixel at first-person range — while cutting the
 * visible repetition almost in half. The rest of the repeat is broken by the
 * object-space finish variation injected in `wearShader` below.
 */
export const WEAPON_TEXEL_SCALE = 0.15;

/* ----------------------------------------------------------- shared GLSL */

const COMMON = /* glsl */ `
/** Bright bare steel revealed where a finish has worn through. */
vec3 obBareSteel(vec2 uv, float seed) {
  return obRGB(150, 154, 160) * mix(0.95, 1.05, obValueP(uv * 190.0, vec2(190.0), seed));
}
/** Tool marks left by a broach or a lathe: fine, directional, never uniform. */
float obToolMarks(vec2 uv, float freq, float seed) {
  float a = obValueP(vec2(uv.x * freq, uv.y * 6.0), vec2(freq, 6.0), seed);
  float b = obValueP(vec2(uv.x * freq * 2.7, uv.y * 11.0), vec2(freq * 2.7, 11.0), seed + 3.0);
  return a * 0.62 + b * 0.38;
}
`;

/* --------------------------------------------------------- wear injection */

/**
 * Mesh-derived wear, injected into every weapon material.
 *
 * The forge can only produce *statistical* wear: scratches and blotches that
 * land where the noise put them. Real wear is a property of the object — the
 * finish is rubbed through on the chamfers and proud corners that get handled,
 * carbon and oil collect in the inside corners, and the moment either of those
 * stops following the model's actual edges the weapon reads as a texture
 * wrapped round a shape rather than a machined thing.
 *
 * `bakeWear` measures both off the mesh into `aWear`; this shader spends it:
 *
 *   • convex edges lift toward bare metal, get smoother and more metallic —
 *     which is what makes a chamfer *catch* the key light,
 *   • concave corners darken and roughen,
 *   • a low-frequency object-space field varies the finish over the length of
 *     the weapon, so the 15 cm texture repeat stops reading as a repeat.
 *
 * All four are per-material uniforms, so one program serves the whole armoury.
 */
const WEAR_PARS = /* glsl */ `
varying vec2 vObWear;
varying vec3 vObLocal;
uniform vec4 obWear;       // x edge albedo, y edge roughness, z cavity dark, w cavity rough
uniform vec3 obEdgeColor;  // bare metal under the finish
uniform vec3 obVar;        // x albedo variation, y roughness variation, z edge metalness
float obWHash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
float obWNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(obWHash(i + vec3(0,0,0)), obWHash(i + vec3(1,0,0)), f.x);
  float b = mix(obWHash(i + vec3(0,1,0)), obWHash(i + vec3(1,1,0)), f.x);
  float c = mix(obWHash(i + vec3(0,0,1)), obWHash(i + vec3(1,0,1)), f.x);
  float d = mix(obWHash(i + vec3(0,1,1)), obWHash(i + vec3(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float obFinishField() {
  return obWNoise(vObLocal * 7.0) * 0.62 + obWNoise(vObLocal * 23.0) * 0.38;
}
`;

const WEAR_VERTEX_PARS = /* glsl */ `
attribute vec2 aWear;
varying vec2 vObWear;
varying vec3 vObLocal;
`;

const WEAR_VERTEX_BODY = /* glsl */ `
  vObWear = aWear;
  vObLocal = position;
`;

const WEAR_ALBEDO = /* glsl */ `
  float obE = clamp(vObWear.x, 0.0, 1.0);
  float obC = clamp(vObWear.y, 0.0, 1.0);
  float obV = obFinishField();
  diffuseColor.rgb *= 1.0 + (obV - 0.5) * obVar.x;
  diffuseColor.rgb = mix(diffuseColor.rgb, obEdgeColor, obE * obWear.x);
  diffuseColor.rgb *= 1.0 - obC * obWear.z;
`;

const WEAR_ROUGH = /* glsl */ `
  roughnessFactor = clamp(
    roughnessFactor + (obFinishField() - 0.5) * obVar.y
      - clamp(vObWear.x, 0.0, 1.0) * obWear.y
      + clamp(vObWear.y, 0.0, 1.0) * obWear.w,
    0.025, 1.0);
`;

const WEAR_METAL = /* glsl */ `
  metalnessFactor = clamp(metalnessFactor + clamp(vObWear.x, 0.0, 1.0) * obVar.z, 0.0, 1.0);
`;

/* --------------------------------------------------------------- recipes */

const phosphate: ForgeRecipe = {
  id: 'wpn_phosphate',
  seed: 811,
  size: 1024,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00030 },
  normalGain: 1.00,
  normalWide: 0.55,
  aoRadius: 0.030,
  aoStrength: 0.50,
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
  float h = 0.48 + (form - 0.5) * 0.22;

  // Cast/forged orange peel.
  h += (obFbm(uv * 30.0, vec2(30.0), 3, 0.5, uSeed + 13.0) - 0.5) * 0.09;

  // Manganese phosphate crystals: fine enough that the mip chain turns them
  // into roughness rather than into speckle. Anything coarser than this aliases
  // into the mottled "camouflage" look that reads instantly as procedural.
  float crys = obWorleyFbm(uv * 150.0, vec2(150.0), 2, 1.0, uSeed);
  h += (crys - 0.5) * 0.055;

  // Broaching marks under the finish, running along the part.
  float tool = obToolMarks(uv, 105.0, uSeed + 11.0);
  h += (tool - 0.5) * 0.035;

  // Burnished patches where the weapon is handled and holstered.
  float rub = obFbm(obWarp(uv * 3.2, vec2(3.2), 0.5, uSeed + 17.0), vec2(3.2), 4, 0.55, uSeed + 19.0);
  float worn = smoothstep(0.58, 0.90, rub);
  h += worn * 0.035;

  // Isolated impact dings.
  vec3 dn = obWorleyP(uv * 9.0, vec2(9.0), 1.0, uSeed + 23.0);
  float ding = smoothstep(0.20, 0.0, dn.x) * step(0.93, dn.z);
  h -= ding * 0.22;

  float scratch = obScratches(uv, 14.0, 1.2, 26.0, 0.16, uSeed + 29.0);
  h -= scratch * 0.12;

  h0 = vec4(clamp(h, 0.0, 1.0), worn, scratch, ding);
  h1 = vec4(crys, tool, form, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float worn = h0.y, scratch = h0.z, ding = h0.w;
  float crys = h1.x, form = h1.z;

  // Parkerising is a very dark, slightly warm grey. The old value (sRGB 66)
  // was roughly twice as bright as the real thing, which is why the receiver
  // read as concrete: a gun is *dark*, and everything you see on it is
  // specular, not diffuse.
  vec3 park = obRGB(43, 43, 41);
  park = mix(park, obRGB(47, 47, 45), obSat(crys * 1.2 - 0.15) * 0.45);
  park = mix(park, obRGB(39, 39, 39), obSat(1.0 - crys * 1.5) * 0.45);
  park = mix(park, obRGB(50, 47, 42), obSat(form * 1.1 - 0.30) * 0.45);

  vec3 steel = obBareSteel(uv, uSeed + 37.0);

  // Texture-space wear is deliberately restrained now: the mesh-derived edge
  // mask injected by installWear owns the chamfers, and doubling up produced
  // wear everywhere, which is the same thing as wear nowhere.
  float bare = obSat(worn * 0.16 + scratch * 0.80);
  bare = smoothstep(0.55, 0.97, bare) * 0.32;

  vec3 col = mix(park, steel, bare);
  // Oil and carbon collect in the low spots.
  float grime = obSat(d.cavity * 0.20 + (1.0 - d.ao) * 1.1);
  col = mix(col, obRGB(26, 26, 25), grime * 0.34);
  col = mix(col, obRGB(60, 61, 62), ding * 0.45);

  o.albedo = col;
  o.metal = 0.96;
  // Parkerising is matte but not chalky; 0.78 killed every highlight the
  // three-point rig could have put on the receiver. Kept smooth at fine
  // scales for the reason spelled out in the aluminium recipe.
  float rough = 0.55 + (form - 0.5) * 0.16;
  rough = mix(rough, 0.62, worn * 0.30);
  rough -= bare * 0.34;
  o.rough = clamp(rough, 0.22, 0.82);
}`,
};

const blued: ForgeRecipe = {
  id: 'wpn_blued',
  seed: 823,
  size: 1024,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00013 },
  normalGain: 0.85,
  normalWide: 0.6,
  aoRadius: 0.022,
  aoStrength: 0.34,
  aoAlbedo: 0.10,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Draw-polished before bluing: long, very fine directional lines over a
  // gently undulating polished surface.
  float form = obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 3.0);
  float polish = obBrushed(vec2(uv.y, uv.x), 4.0, 150.0, uSeed);
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

  // Cold bluing is black-blue with a cool cast; it reads as *dark* with a hard
  // specular streak, never as mid-grey.
  vec3 blue = obRGB(27, 29, 35);
  blue = mix(blue, obRGB(44, 48, 58), obSat(polish * 1.1 - 0.1));
  blue = mix(blue, obRGB(19, 20, 25), obSat(1.0 - form * 1.3) * 0.6);

  vec3 steel = obBareSteel(uv, uSeed + 43.0);
  float bare = smoothstep(0.56, 0.97, obSat(worn * 0.18 + scratch * 0.92)) * 0.28;

  vec3 col = mix(blue, steel, bare);
  float grime = obSat(d.cavity * 0.18 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(18, 18, 19), grime * 0.30);
  col = mix(col, obRGB(66, 68, 72), ding * 0.5);

  o.albedo = col;
  o.metal = 1.0;
  float rough = 0.26 + (form - 0.5) * 0.10;
  rough = mix(rough, 0.40, worn * 0.4);
  rough -= bare * 0.16;
  o.rough = clamp(rough, 0.10, 0.62);
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

  vec3 peb = obWorleyP(uv * 130.0, vec2(130.0), 1.0, uSeed);
  float grain = 1.0 - smoothstep(0.0, 0.46, peb.x);
  h += grain * 0.16;
  h += (obFbm(uv * 165.0, vec2(165.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.06;

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

  // Glass-filled nylon furniture: a genuinely dark charcoal. The old 46 grey
  // was reading as unpainted plastic model kit.
  vec3 base = obRGB(31, 31, 33);
  base = mix(base, obRGB(24, 24, 26), obSat(1.0 - grain * 1.2));
  base = mix(base, obRGB(39, 39, 41), flow * 0.28 + obSat(form - 0.5) * 0.22);

  // Stress whitening on scuffs; never metallic, never shiny.
  float edge = obSat(d.curv * 0.42);
  float white = obSat(scuff * 1.1 + edge * 0.26 + gouge * 0.8);
  vec3 col = mix(base, obRGB(86, 86, 88), smoothstep(0.28, 0.96, white) * 0.50);

  float grime = obSat(d.cavity * 0.7 + (1.0 - d.ao) * 0.9);
  col = mix(col, obRGB(20, 19, 19), grime * 0.30);

  o.albedo = col;
  o.metal = 0.0;
  // Matte plastic with a slight sheen: the tops of the mould grain polish up
  // from handling, the valleys stay dead. That split is what stops polymer
  // reading as either rubber or as painted metal.
  float rough = mix(0.70, 0.48, grain);
  rough = mix(rough, 0.40, edge * 0.5);
  rough += grime * 0.08 + scuff * 0.06;
  o.rough = clamp(rough, 0.30, 0.90);
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
  vec3 peb = obWorleyP(uv * 62.0, vec2(62.0), 1.0, uSeed);
  float pebble = 1.0 - smoothstep(0.0, 0.52, peb.x);
  float h = 0.38 + pebble * 0.42 + (form - 0.5) * 0.14;
  h += (obFbm(uv * 95.0, vec2(95.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.06;
  float wear = smoothstep(0.55, 0.88, obFbm(uv * 2.8, vec2(2.8), 4, 0.55, uSeed + 7.0));
  h -= pebble * wear * 0.30;
  h0 = vec4(clamp(h, 0.0, 1.0), pebble, wear, 0.0);
  h1 = vec4(form, 0.0, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float pebble = h0.y, wear = h0.z;
  vec3 col = obRGB(21, 21, 22);
  col = mix(col, obRGB(31, 31, 32), pebble * 0.55);
  // Polished by the palm where it is actually gripped — the sheen is what
  // separates a rubber over-mould from flat black paint.
  col = mix(col, obRGB(38, 37, 36), wear * 0.40);
  float grime = obSat(d.cavity * 1.2 + (1.0 - d.ao) * 0.8);
  col = mix(col, obRGB(14, 14, 14), grime * 0.5);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.93 - wear * 0.30 - obSat(d.curv) * 0.06, 0.52, 0.99);
}`,
};

const alu: ForgeRecipe = {
  id: 'wpn_alu',
  seed: 863,
  size: 1024,
  geometry: { tile: WEAPON_TEXEL_SCALE, depth: 0.00013 },
  normalGain: 0.85,
  normalWide: 0.6,
  aoRadius: 0.024,
  aoStrength: 0.32,
  aoAlbedo: 0.12,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float form = obFbm(uv * 8.0, vec2(8.0), 4, 0.5, uSeed + 5.0);
  // Bead blast before anodising: isotropic dimples, no direction at all.
  vec3 bead = obWorleyP(uv * 140.0, vec2(140.0), 1.0, uSeed);
  float dimple = 1.0 - smoothstep(0.0, 0.42, bead.x);
  float h = 0.50 + (form - 0.5) * 0.18 + (dimple - 0.4) * 0.12;
  float tool = obToolMarks(uv, 90.0, uSeed + 9.0);
  h += (tool - 0.5) * 0.05;
  float scratch = obScratches(uv, 12.0, 2.0, 22.0, 0.16, uSeed + 13.0);
  h -= scratch * 0.18;
  h0 = vec4(clamp(h, 0.0, 1.0), scratch, dimple, tool);
  h1 = vec4(form, 0.0, 0.0, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float scratch = h0.y, dimple = h0.z;
  float form = h1.x;
  // Type III hard anodising over 7075: near black with a faint blue cast.
  vec3 anod = obRGB(30, 31, 33);
  anod = mix(anod, obRGB(34, 35, 37), dimple * 0.10);
  anod = mix(anod, obRGB(29, 30, 32), obSat(1.0 - form * 1.3) * 0.55);
  vec3 bright = obRGB(140, 143, 147);
  float bare = smoothstep(0.60, 0.98, obSat(scratch * 0.88)) * 0.16;
  vec3 col = mix(anod, bright, bare);
  float grime = obSat(d.cavity * 0.18 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(22, 22, 22), grime * 0.26);
  o.albedo = col;
  o.metal = 0.92;
  // Roughness is the one channel that must stay smooth. A metal's appearance
  // *is* the environment probe, and per-texel roughness picks a different mip
  // of that probe for every texel — which is how a bead-blasted receiver ends
  // up wearing the colours of the room as speckled camouflage. Variation here
  // is macro (the 8-cycle form field) plus the scratches, and nothing finer.
  o.rough = clamp(0.40 + (form - 0.5) * 0.13 - bare * 0.55, 0.16, 0.72);
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
  phosphate: { color: 0x2b2b29, rough: 0.55, metal: 0.95 },
  blued: { color: 0x1b1c21, rough: 0.24, metal: 1.0 },
  polymer: { color: 0x1f1f21, rough: 0.62, metal: 0.0 },
  polymerTan: { color: 0x6b5c42, rough: 0.62, metal: 0.0 },
  rubber: { color: 0x151516, rough: 0.92, metal: 0.0 },
  alu: { color: 0x242527, rough: 0.40, metal: 0.9 },
  wood: { color: 0x4a2d19, rough: 0.48, metal: 0.0 },
  brass: { color: 0x8f6b2c, rough: 0.28, metal: 1.0 },
  glass: { color: 0x0d1418, rough: 0.06, metal: 0.0 },
  lens: { color: 0x081418, rough: 0.03, metal: 0.0 },
  black: { color: 0x1c1d1f, rough: 0.42, metal: 0.85 },
};

/**
 * Which forge recipe backs each material key, and any colour multiplier.
 *
 * `black` is an *optic body*: hard-anodised aluminium, not plastic. Routing it
 * through the polymer recipe with a lightening tint was what made every sight
 * on every gun read as a grey plastic prop.
 */
const SOURCE: Record<MaterialKey, { recipe: string | null; tint: number }> = {
  phosphate: { recipe: 'phosphate', tint: 0xffffff },
  blued: { recipe: 'blued', tint: 0xffffff },
  polymer: { recipe: 'polymer', tint: 0xffffff },
  polymerTan: { recipe: 'polymer', tint: 0xd8b884 },
  rubber: { recipe: 'rubber', tint: 0xffffff },
  alu: { recipe: 'alu', tint: 0xffffff },
  wood: { recipe: 'wood', tint: 0xffffff },
  brass: { recipe: 'blued', tint: 0xe8ae52 },
  black: { recipe: 'alu', tint: 0x9aa0a4 },
  glass: { recipe: null, tint: 0xffffff },
  lens: { recipe: null, tint: 0xffffff },
};

/* --------------------------------------------------- per-surface wear tune */

interface WearTune {
  /** How far a convex edge lifts toward bare metal, 0..1. */
  edge: number;
  /** Roughness removed on that edge — a worn chamfer is *polished*. */
  edgeRough: number;
  /** How much a crevice darkens with oil and carbon. */
  cavity: number;
  /** Roughness added in that crevice. */
  cavityRough: number;
  /** Colour the finish wears through to. */
  bare: number;
  /** Amplitude of the object-space finish variation on albedo. */
  varAlbedo: number;
  /** …and on roughness. */
  varRough: number;
  /** Metalness gained on a worn edge. */
  edgeMetal: number;
  /**
   * Normal-map gain.
   *
   * A first-person weapon is viewed at 25 cm, where one texel of a 1024² map
   * covers several screen pixels — the texture is *magnified*, not minified,
   * and every texel of micro-normal becomes a visible speckle. On a metal that
   * speckle samples the environment probe per texel and the receiver picks up
   * the colour of whatever is behind the player. Smooth finishes therefore run
   * a deliberately weak normal; the form comes from the geometry.
   */
  normal: number;
}

const WEAR: Record<MaterialKey, WearTune> = {
  // Parkerising is thin and wears through on every handled corner.
  phosphate: { edge: 0.62, edgeRough: 0.26, cavity: 0.34, cavityRough: 0.10, bare: 0xa9adb4, varAlbedo: 0.16, varRough: 0.10, edgeMetal: 0.08, normal: 0.80 },
  blued: { edge: 0.50, edgeRough: 0.10, cavity: 0.32, cavityRough: 0.10, bare: 0x9fa4ad, varAlbedo: 0.14, varRough: 0.07, edgeMetal: 0.0, normal: 0.60 },
  alu: { edge: 0.46, edgeRough: 0.16, cavity: 0.30, cavityRough: 0.10, bare: 0xa8acb2, varAlbedo: 0.14, varRough: 0.08, edgeMetal: 0.10, normal: 0.55 },
  black: { edge: 0.34, edgeRough: 0.14, cavity: 0.34, cavityRough: 0.10, bare: 0x8e939a, varAlbedo: 0.12, varRough: 0.08, edgeMetal: 0.10, normal: 0.55 },
  // Polymer does not go metallic; it stress-whitens and polishes.
  polymer: { edge: 0.30, edgeRough: 0.20, cavity: 0.32, cavityRough: 0.08, bare: 0x6e6f72, varAlbedo: 0.14, varRough: 0.12, edgeMetal: 0.0, normal: 1.0 },
  polymerTan: { edge: 0.28, edgeRough: 0.20, cavity: 0.34, cavityRough: 0.08, bare: 0x8d8264, varAlbedo: 0.16, varRough: 0.12, edgeMetal: 0.0, normal: 1.0 },
  rubber: { edge: 0.22, edgeRough: 0.26, cavity: 0.38, cavityRough: 0.04, bare: 0x4a4a4b, varAlbedo: 0.10, varRough: 0.10, edgeMetal: 0.0, normal: 1.0 },
  wood: { edge: 0.34, edgeRough: 0.14, cavity: 0.38, cavityRough: 0.12, bare: 0xa07a4c, varAlbedo: 0.18, varRough: 0.12, edgeMetal: 0.0, normal: 0.95 },
  brass: { edge: 0.40, edgeRough: 0.14, cavity: 0.30, cavityRough: 0.10, bare: 0xf0d08a, varAlbedo: 0.10, varRough: 0.06, edgeMetal: 0.0, normal: 0.65 },
  glass: { edge: 0, edgeRough: 0, cavity: 0, cavityRough: 0, bare: 0xffffff, varAlbedo: 0, varRough: 0, edgeMetal: 0, normal: 1.0 },
  lens: { edge: 0, edgeRough: 0, cavity: 0, cavityRough: 0, bare: 0xffffff, varAlbedo: 0, varRough: 0, edgeMetal: 0, normal: 1.0 },
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
    if (key !== 'glass' && key !== 'lens') this.installWear(key, mat);
    this.cache.set(id, mat);
    if (this.forge) this.upgradeOne(key, mat);
    return mat;
  }

  /**
   * Installs the mesh-driven wear shader on a material.
   *
   * The renderer's own patcher chains onto whatever `onBeforeCompile` it finds,
   * so this can be set up once here and never thought about again. The
   * `OB_WEAPON` define is load-bearing: three's program cache keys on
   * `material.defines`, and without it the patcher's constant cache key would
   * happily hand a weapon material a world material's compiled program.
   */
  private installWear(key: MaterialKey, mat: THREE.MeshStandardMaterial): void {
    const t = WEAR[key];
    const u = {
      obWear: { value: new THREE.Vector4(t.edge, t.edgeRough, t.cavity, t.cavityRough) },
      obEdgeColor: { value: new THREE.Color(t.bare) },
      obVar: { value: new THREE.Vector3(t.varAlbedo, t.varRough, t.edgeMetal) },
    };
    mat.defines = { ...(mat.defines ?? {}), OB_WEAPON: '' };
    mat.userData.obWearUniforms = u;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = `${WEAR_VERTEX_PARS}\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${WEAR_VERTEX_BODY}`,
      );
      shader.fragmentShader = `${WEAR_PARS}\n${shader.fragmentShader}`
        .replace('#include <map_fragment>', `#include <map_fragment>\n${WEAR_ALBEDO}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${WEAR_ROUGH}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${WEAR_METAL}`);
    };
  }

  /** Convenience accessor for world-space meshes (grenades, dropped weapons). */
  world(key: MaterialKey): THREE.MeshStandardMaterial { return this.get(key, 'world'); }

  private makeGlass(key: MaterialKey): THREE.MeshStandardMaterial {
    // You look *through* an optic. The previous lens was 62% opaque, which
    // turned every sight into a milky disc you could not aim with — the exact
    // opposite of what the part is for. Real coated glass passes almost
    // everything and shows itself only in the AR coating's tinted sheen, so
    // the opacity goes down and the environment specular carries the read.
    const m = new THREE.MeshStandardMaterial({
      color: key === 'lens' ? 0x12313d : 0x0a1014,
      roughness: 0.03,
      metalness: 0.0,
      transparent: true,
      opacity: key === 'lens' ? 0.13 : 0.26,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    m.envMapIntensity = key === 'lens' ? 2.6 : 1.8;
    m.emissive = new THREE.Color(key === 'lens' ? 0x04141b : 0x000000);
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
    mat.normalScale.set(WEAR[key].normal, WEAR[key].normal);
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
