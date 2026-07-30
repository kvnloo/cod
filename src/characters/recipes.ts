/**
 * Procedural PBR recipes for character kit, written against the material
 * module's `TextureForge`.
 *
 * Five families cover a soldier: skin, uniform cloth, load-bearing nylon, hard
 * kit (helmet shell, pads, boots, gloves) and metal. Each is generated once and
 * shared by every character wearing it; per-character colour comes from vertex
 * tints multiplied into these albedos, which is why the camo here is authored
 * as *value* structure with a neutral-ish palette rather than a saturated one.
 *
 * The height pass carries the cloth folds, weave and stitching that the derive
 * pass turns into a normal map — that is where the wrinkles asked for by the
 * brief come from, and they are real geometry in the height field rather than a
 * noise overlay, so AO and curvature land in the right places automatically.
 */

import * as THREE from 'three';
import type { ForgeRecipe } from '../material';

/* ------------------------------------------------------------------ shared */

const COMMON = /* glsl */ `
/** Plain weave with per-thread thickness jitter. Returns (height, parity, rnd). */
vec3 chWeave(vec2 uv, float count, float slub, float seed) {
  vec2 p = uv * count;
  vec2 f = fract(p);
  vec2 i = floor(p);
  float par = mod(i.x + i.y, 2.0);
  float tw = obHash13(vec3(mod(i.x, count), 0.0, seed));
  float tf = obHash13(vec3(0.0, mod(i.y, count), seed + 3.0));
  float warp = pow(sin(clamp(f.x, 0.0, 1.0) * OB_PI), 0.75) * mix(1.0 - slub, 1.0 + slub, tw);
  float weft = pow(sin(clamp(f.y, 0.0, 1.0) * OB_PI), 0.75) * mix(1.0 - slub, 1.0 + slub, tf);
  float h = par > 0.5 ? warp * 0.92 + weft * 0.30 : weft * 0.92 + warp * 0.30;
  return vec3(h, par, obHash13(vec3(mod(i, vec2(count)), seed + 7.0)));
}

/** Ripstop reinforcement grid: a heavier thread every 'cells' repeats. */
float chRipstop(vec2 uv, float cells) {
  vec2 g = abs(fract(uv * cells) - 0.5) * 2.0;
  return max(smoothstep(0.80, 1.0, g.x), smoothstep(0.80, 1.0, g.y));
}

/** Soft cloth folds: warped ridged noise, elongated along one axis. */
float chFolds(vec2 uv, float scale, float seed) {
  vec2 p = obWarp(uv * scale, vec2(scale), 0.42, seed);
  float r = obRidged(p, vec2(scale), 4, 0.55, seed);
  return r;
}

/** Straight stitch line: returns (line, stitchDots). */
vec2 chStitch(float d, float pitch, float uAlong) {
  float line = smoothstep(0.018, 0.004, abs(d));
  float dots = step(0.45, fract(uAlong * pitch)) * line;
  return vec2(line, dots);
}
`;

/* -------------------------------------------------------------------- skin */

export const SKIN_RECIPE: ForgeRecipe = {
  id: 'chSkin',
  seed: 811,
  size: 1024,
  geometry: { tile: 0.36, depth: 0.0009 },
  normalGain: 1.1,
  normalWide: 0.42,
  aoRadius: 0.018,
  aoAlbedo: 0.30,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Pores: dense worley pits with a size distribution.
  vec3 w = obWorleyP(uv * 150.0, vec2(150.0), 1.0, uSeed);
  float pore = 1.0 - smoothstep(0.0, mix(0.16, 0.42, w.z), w.x);
  pore *= step(0.30, w.z);

  // Fine skin cell network (the diamond micro-relief real skin has).
  vec3 cell = obVoronoiEdgeP(obWarp(uv * 60.0, vec2(60.0), 0.35, uSeed + 4.0), vec2(60.0), 1.0, uSeed + 4.0);
  float lines = 1.0 - smoothstep(0.0, 0.10, cell.x);

  // Larger wrinkles and a little slackness.
  float wrinkle = chFolds(uv, 9.0, uSeed + 11.0);
  float slack = obFbm(uv * 5.0, vec2(5.0), 4, 0.55, uSeed + 17.0);

  float h = 0.58 + slack * 0.14 - lines * 0.055 - pore * 0.10 + wrinkle * 0.06;

  // Stubble: short follicles, only in the beard band of the atlas (v < 0.45).
  float beard = smoothstep(0.52, 0.30, uv.y);
  vec3 st = obWorleyP(uv * 240.0, vec2(240.0), 1.0, uSeed + 29.0);
  float stub = (1.0 - smoothstep(0.0, 0.22, st.x)) * step(0.55, st.z) * beard;
  h += stub * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), pore, w.z, stub);
  h1 = vec4(lines, wrinkle, slack, beard);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float pore = h0.y, rnd = h0.z, stub = h0.w;
  float lines = h1.x, wrinkle = h1.y, slack = h1.z;

  // A neutral mid tone: the per-character skin colour arrives as a vertex tint.
  // Near-neutral: the character's tone arrives as a vertex tint, so a warm
  // base here would double up and turn everyone orange.
  vec3 base = obRGB(198, 186, 178);
  vec3 deep = obRGB(158, 138, 130);
  vec3 flush = obRGB(206, 168, 158);

  float blotch = obFbm(uv * 7.0, vec2(7.0), 4, 0.55, uSeed + 41.0);
  vec3 col = mix(base, flush, obSat((blotch - 0.45) * 1.9));
  col = mix(col, deep, obSat(d.cavity * 0.8 + lines * 0.35));
  col *= mix(0.94, 1.05, rnd);

  // Pores read as tiny darker points, not as noise.
  col *= 1.0 - pore * 0.16;
  // Stubble.
  col = mix(col, obRGB(58, 44, 38), obSat(stub * 1.6));

  // Grime and camo paint smear on the cheekbones.
  float grime = obFbm(uv * 3.0, vec2(3.0), 4, 0.6, uSeed + 55.0);
  col = mix(col, col * obRGB(126, 120, 104) * 1.6, obSat((grime - 0.62) * 2.2) * 0.45);

  o.albedo = col;
  // Skin is glossier on the high points (nose, brow) and matte in the creases.
  o.rough = clamp(0.62 - d.curv * 0.10 + lines * 0.10 - slack * 0.05 + stub * 0.12, 0.32, 0.85);
  o.metal = 0.0;
  o.ao = mix(1.0, 0.88, wrinkle);
}`,
};

/* ------------------------------------------------------------------- cloth */

export interface CamoPalette {
  /** Four sRGB colours, base first. Values in 0..1. */
  colors: [number[], number[], number[], number[]];
  /** 0 = organic blotches, 1 = hard-edged / digital. */
  hardness: number;
  /** Pattern scale in repeats per texture tile. */
  scale: number;
}

export const CAMO: Record<string, CamoPalette> = {
  // Faded multicam-ish: the tint does the colour work, this does the structure.
  arid: {
    colors: [[0.80, 0.74, 0.60], [0.62, 0.56, 0.42], [0.44, 0.40, 0.30], [0.30, 0.28, 0.22]],
    hardness: 0.15, scale: 3.6,
  },
  woodland: {
    colors: [[0.56, 0.58, 0.44], [0.42, 0.46, 0.34], [0.28, 0.32, 0.24], [0.20, 0.22, 0.18]],
    hardness: 0.25, scale: 3.4,
  },
  urban: {
    colors: [[0.62, 0.63, 0.62], [0.46, 0.47, 0.47], [0.30, 0.31, 0.32], [0.19, 0.20, 0.21]],
    hardness: 0.75, scale: 4.6,
  },
  plain: {
    colors: [[0.60, 0.58, 0.52], [0.54, 0.52, 0.47], [0.48, 0.46, 0.42], [0.42, 0.41, 0.38]],
    hardness: 0.0, scale: 2.6,
  },
};

export function clothRecipe(id: string, palette: CamoPalette, seed: number): ForgeRecipe {
  return {
    id,
    seed,
    size: 1024,
    geometry: { tile: 0.46, depth: 0.0022 },
    normalGain: 1.15,
    normalWide: 0.34,
    aoRadius: 0.026,
    aoAlbedo: 0.30,
    common: COMMON,
    uniforms: {
      uCamo0: { value: new THREE.Vector3(...palette.colors[0]) },
      uCamo1: { value: new THREE.Vector3(...palette.colors[1]) },
      uCamo2: { value: new THREE.Vector3(...palette.colors[2]) },
      uCamo3: { value: new THREE.Vector3(...palette.colors[3]) },
      uHard: { value: palette.hardness },
      uScale: { value: palette.scale },
    },
    height: /* glsl */ `
uniform float uHard;
uniform float uScale;
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  vec3 w = chWeave(uv, 240.0, 0.26, uSeed);
  float rip = chRipstop(uv, 60.0);
  float h = 0.44 + w.x * 0.24 + rip * 0.10;

  // Folds: big soft drape plus tight creases where fabric bunches.
  float drape = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 3.0) - 0.5;
  float crease = chFolds(uv, 13.0, uSeed + 9.0);
  float tight  = chFolds(uv, 31.0, uSeed + 21.0);
  h += drape * 0.16 + crease * 0.10 + tight * 0.045;

  // Seams: a raised double row with stitching either side.
  vec2 sv = chStitch(fract(uv.y * 2.0) - 0.5, 120.0, uv.x);
  vec2 sh = chStitch(fract(uv.x * 3.0) - 0.5, 120.0, uv.y);
  float seam = max(sv.x, sh.x);
  float stitch = max(sv.y, sh.y);
  h += seam * 0.075 + stitch * 0.055;

  // Wear: thin threadbare patches.
  float bare = obSat((obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 33.0) - 0.66) * 3.0);
  h -= bare * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), w.y, w.z, bare);
  h1 = vec4(seam, stitch, crease, rip);
}`,
    shade: /* glsl */ `
uniform vec3 uCamo0;
uniform vec3 uCamo1;
uniform vec3 uCamo2;
uniform vec3 uCamo3;
uniform float uHard;
uniform float uScale;

/** Layered camo: warped fbm thresholds, soft or hard edged. */
vec3 chCamo(vec2 uv, out float shapeId) {
  float sc = uScale;
  vec2 p0 = obWarp(uv * sc, vec2(sc), mix(0.55, 0.12, uHard), uSeed + 61.0);
  float n0 = obFbm(p0, vec2(sc), 4, 0.55, uSeed + 61.0);
  vec2 p1 = obWarp(uv * sc * 2.05 + 3.7, vec2(sc * 2.05), mix(0.45, 0.10, uHard), uSeed + 71.0);
  float n1 = obFbm(p1, vec2(sc * 2.05), 4, 0.5, uSeed + 71.0);
  vec2 p2 = obWarp(uv * sc * 4.3 + 9.1, vec2(sc * 4.3), 0.3, uSeed + 83.0);
  float n2 = obFbm(p2, vec2(sc * 4.3), 3, 0.5, uSeed + 83.0);

  // Digital patterns quantise the blend to a pixel grid.
  float px = mix(0.0, 1.0, uHard);
  if (px > 0.5) {
    vec2 q = floor(uv * 128.0) / 128.0;
    n0 = obFbm(obWarp(q * sc, vec2(sc), 0.12, uSeed + 61.0), vec2(sc), 4, 0.55, uSeed + 61.0);
    n1 = obFbm(obWarp(q * sc * 2.05 + 3.7, vec2(sc * 2.05), 0.1, uSeed + 71.0), vec2(sc * 2.05), 4, 0.5, uSeed + 71.0);
    n2 = obFbm(obWarp(q * sc * 4.3 + 9.1, vec2(sc * 4.3), 0.1, uSeed + 83.0), vec2(sc * 4.3), 3, 0.5, uSeed + 83.0);
  }

  float edge = mix(0.055, 0.006, uHard);
  float m1 = smoothstep(0.50 - edge, 0.50 + edge, n0);
  float m2 = smoothstep(0.58 - edge, 0.58 + edge, n1) * m1;
  float m3 = smoothstep(0.66 - edge, 0.66 + edge, n2);

  vec3 c = obSrgbToLinear(uCamo0);
  c = mix(c, obSrgbToLinear(uCamo1), m1);
  c = mix(c, obSrgbToLinear(uCamo2), m2);
  c = mix(c, obSrgbToLinear(uCamo3), m3 * 0.85);
  shapeId = m1 + m2 + m3;
  return c;
}

void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float par = h0.y, rnd = h0.z, bare = h0.w;
  float seam = h1.x, stitch = h1.y, crease = h1.z, rip = h1.w;

  float shape;
  vec3 col = chCamo(uv, shape);

  // Thread-level variation: warp and weft take dye slightly differently.
  col *= mix(0.95, 1.06, par);
  col *= mix(0.90, 1.08, rnd);
  // Ripstop threads are a shade lighter — they are a different denier.
  col *= 1.0 + rip * 0.06;

  // Sun bleaching on the high points, dirt in the folds.
  col *= mix(0.86, 1.10, obSat(d.curv * 0.5 + 0.5));
  vec3 dirt = obRGB(96, 86, 68);
  col = mix(col, dirt * 0.9, obSat(d.cavity * 1.15) * 0.42);

  // Sweat/grease darkening in broad patches.
  float sweat = obSat((obFbm(uv * 2.4, vec2(2.4), 4, 0.6, uSeed + 91.0) - 0.60) * 2.6);
  col *= 1.0 - sweat * 0.22;

  // Stitching is a contrasting thread.
  col = mix(col, col * 0.62 + obRGB(40, 36, 30) * 0.5, stitch * 0.7);

  o.albedo = col;
  o.rough = clamp(0.90 - crease * 0.05 + bare * 0.06 - seam * 0.04 + sweat * 0.05, 0.55, 1.0);
  o.metal = 0.0;
  o.ao = mix(1.0, 0.9, crease);
}`,
  };
}

/* -------------------------------------------------------------------- gear */

export function gearRecipe(id: string, seed: number): ForgeRecipe {
  return {
    id,
    seed,
    size: 512,
    geometry: { tile: 0.30, depth: 0.0016 },
    normalGain: 1.25,
    normalWide: 0.3,
    aoRadius: 0.03,
    aoAlbedo: 0.32,
    common: COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Heavy 1000D cordura: coarse weave with pronounced thread bundles.
  vec3 w = chWeave(uv, 160.0, 0.32, uSeed);
  float h = 0.42 + w.x * 0.30;

  // MOLLE: horizontal webbing rows every 1/4 tile, stitched in columns.
  float rowT = fract(uv.y * 4.0);
  float row = smoothstep(0.06, 0.14, rowT) * smoothstep(0.74, 0.62, rowT);
  float rowEdge = smoothstep(0.10, 0.06, abs(rowT - 0.10)) + smoothstep(0.10, 0.06, abs(rowT - 0.68));
  h += row * 0.16 + rowEdge * 0.05;

  // Bar-tack columns holding the webbing down.
  float colT = fract(uv.x * 8.0);
  float tack = smoothstep(0.10, 0.02, abs(colT - 0.5)) * row;
  h -= tack * 0.13;

  // Edge binding tape along the top of the tile.
  float bind = smoothstep(0.030, 0.012, abs(fract(uv.y) - 0.02));
  h += bind * 0.10;

  float stitch = step(0.5, fract(uv.x * 90.0)) * (row * 0.5 + bind);
  h += stitch * 0.04;

  float scuff = obSat((obFbm(uv * 7.0, vec2(7.0), 4, 0.5, uSeed + 13.0) - 0.6) * 3.0);
  h -= scuff * 0.04;

  h0 = vec4(clamp(h, 0.0, 1.0), w.y, w.z, scuff);
  h1 = vec4(row, tack, stitch, bind);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float par = h0.y, rnd = h0.z, scuff = h0.w;
  float row = h1.x, tack = h1.y, stitch = h1.z, bind = h1.w;

  vec3 base = obRGB(150, 140, 118);
  vec3 dark = obRGB(96, 90, 78);

  vec3 col = mix(base, dark, obSat(d.cavity * 1.1));
  col *= mix(0.94, 1.07, par);
  col *= mix(0.88, 1.10, rnd);
  // Webbing rows are a slightly different bolt of the same colour.
  col *= 1.0 + row * 0.05 - tack * 0.10;
  col = mix(col, col * 0.70, bind * 0.6);
  col = mix(col, obRGB(58, 54, 46) * 1.2, stitch * 0.5);

  // Dust ground into the weave, and polished sheen where it rubs.
  float dust = obFbm(uv * 3.2, vec2(3.2), 4, 0.6, uSeed + 27.0);
  col = mix(col, obRGB(122, 110, 90) * 0.85, obSat((dust - 0.5) * 1.6) * 0.35);
  col *= 1.0 - scuff * 0.18;

  o.albedo = col;
  o.rough = clamp(0.92 - scuff * 0.20 - row * 0.03, 0.5, 1.0);
  o.metal = 0.0;
  o.ao = mix(1.0, 0.86, row);
}`,
  };
}

/* -------------------------------------------------------------------- hard */

export const HARD_RECIPE: ForgeRecipe = {
  id: 'chHard',
  seed: 617,
  size: 512,
  geometry: { tile: 0.26, depth: 0.0016 },
  normalGain: 1.1,
  normalWide: 0.35,
  aoRadius: 0.02,
  aoAlbedo: 0.28,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Textured polymer / composite shell: orange-peel plus a coarse aggregate.
  float peel = obFbm(uv * 90.0, vec2(90.0), 3, 0.5, uSeed);
  vec3 grit = obWorleyP(uv * 46.0, vec2(46.0), 1.0, uSeed + 5.0);
  float bump = (1.0 - smoothstep(0.0, 0.30, grit.x)) * step(0.42, grit.z);

  float h = 0.52 + (peel - 0.5) * 0.16 + bump * 0.10;

  // Moulding lines and a rubber tread band (boots reuse this material).
  float tread = smoothstep(0.42, 0.5, fract(uv.y * 9.0)) * smoothstep(0.92, 0.84, fract(uv.y * 9.0));
  float treadGate = step(0.72, uv.x);
  h += tread * treadGate * 0.22;

  // Leather grain for gloves: fine crazing.
  vec3 crz = obVoronoiEdgeP(obWarp(uv * 130.0, vec2(130.0), 0.4, uSeed + 8.0), vec2(130.0), 1.0, uSeed + 8.0);
  float grain = 1.0 - smoothstep(0.0, 0.09, crz.x);
  h -= grain * 0.05;

  float scratch = obScratches(uv, 5.0, 1.6, 12.0, 0.55, uSeed + 15.0);
  h -= scratch * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), bump, grit.z, scratch);
  h1 = vec4(peel, grain, tread * treadGate, 0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float bump = h0.y, rnd = h0.z, scratch = h0.w;
  float peel = h1.x, grain = h1.y, tread = h1.z;

  vec3 base = obRGB(126, 124, 118);
  vec3 col = base * mix(0.86, 1.10, peel);
  col *= mix(0.92, 1.06, rnd);
  col = mix(col, base * 0.62, obSat(d.cavity * 1.2) * 0.7);
  col = mix(col, base * 0.72, grain * 0.35);

  // Edge wear: paint rubbed off the convex edges down to a lighter substrate.
  float edge = obSat(d.curv * 1.6);
  vec3 substrate = obRGB(178, 172, 160);
  col = mix(col, substrate, edge * 0.35 + scratch * 0.30);

  // Dust settled in the texture.
  float dust = obFbm(uv * 4.0, vec2(4.0), 4, 0.6, uSeed + 37.0);
  col = mix(col, obRGB(150, 140, 120), obSat((dust - 0.55) * 2.0) * 0.28);

  o.albedo = col;
  // Matte shell, glossier where it has been rubbed smooth, grippy on tread.
  o.rough = clamp(0.74 - edge * 0.22 - scratch * 0.10 + tread * 0.14 + bump * 0.06, 0.22, 0.98);
  o.metal = 0.0;
  o.ao = mix(1.0, 0.9, bump);
}`,
};

/* ------------------------------------------------------------------- metal */

export const METAL_RECIPE: ForgeRecipe = {
  id: 'chMetal',
  seed: 409,
  size: 512,
  geometry: { tile: 0.18, depth: 0.0009 },
  normalGain: 1.2,
  normalWide: 0.3,
  aoRadius: 0.016,
  aoAlbedo: 0.25,
  common: COMMON,
  height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float brush = obBrushed(uv, 260.0, 8.0, uSeed);
  float h = 0.55 + (brush - 0.5) * 0.10;
  float scratch = obScratches(uv, 7.0, 0.5, 16.0, 0.6, uSeed + 3.0);
  h -= scratch * 0.06;
  float dent = obSat((obFbm(uv * 12.0, vec2(12.0), 3, 0.5, uSeed + 9.0) - 0.62) * 3.0);
  h -= dent * 0.09;
  h0 = vec4(clamp(h, 0.0, 1.0), brush, dent, scratch);
  h1 = vec4(0.0);
}`,
  shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float brush = h0.y, dent = h0.z, scratch = h0.w;
  vec3 base = obRGB(148, 148, 152);
  vec3 col = base * mix(0.80, 1.12, brush);
  // Anodised black finish worn through to bright metal on the edges.
  vec3 anod = obRGB(52, 52, 55);
  float worn = obSat(d.curv * 1.8) * 0.6 + scratch * 0.8;
  col = mix(anod, col, clamp(worn, 0.0, 1.0));
  col = mix(col, anod * 0.7, obSat(d.cavity) * 0.6);

  o.albedo = col;
  o.rough = clamp(0.44 - worn * 0.16 + dent * 0.10 + (1.0 - brush) * 0.08, 0.12, 0.8);
  o.metal = clamp(0.55 + worn * 0.45 - dent * 0.2, 0.2, 1.0);
  o.ao = 1.0;
}`,
};

/* ------------------------------------------------------- micro detail layer */

/**
 * The shared close-range detail map. RG is a tangent-space normal, B modulates
 * albedo and A modulates roughness — the layout `MaterialShaders` expects.
 * Without this, cloth turns to plastic inside two metres.
 */
export const DETAIL_FRAGMENT = /* glsl */ `
void main() {
  vec2 uv = vUv;
  vec3 w = obWorleyP(uv * 120.0, vec2(120.0), 1.0, 7.0);
  float fibre = 1.0 - smoothstep(0.0, 0.30, w.x);
  vec2 weave = obWeave(uv, 90.0, 3.0);
  float h = weave.x * 0.6 + fibre * 0.4;
  float e = 1.0 / uSize;
  vec2 wx = obWeave(uv + vec2(e, 0.0), 90.0, 3.0);
  vec2 wy = obWeave(uv + vec2(0.0, e), 90.0, 3.0);
  vec3 fx = obWorleyP((uv + vec2(e, 0.0)) * 120.0, vec2(120.0), 1.0, 7.0);
  vec3 fy = obWorleyP((uv + vec2(0.0, e)) * 120.0, vec2(120.0), 1.0, 7.0);
  float hx = wx.x * 0.6 + (1.0 - smoothstep(0.0, 0.30, fx.x)) * 0.4;
  float hy = wy.x * 0.6 + (1.0 - smoothstep(0.0, 0.30, fy.x)) * 0.4;
  vec2 n = vec2(h - hx, h - hy) * 12.0;
  float grain = obFbm(uv * 40.0, vec2(40.0), 3, 0.5, 19.0);
  oCol = vec4(clamp(n * 0.5 + 0.5, 0.0, 1.0), clamp(0.5 + (grain - 0.5) * 0.7, 0.0, 1.0), clamp(0.5 + (h - 0.5) * 0.6, 0.0, 1.0));
}`;
