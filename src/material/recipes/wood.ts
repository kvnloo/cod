/**
 * Timber archetypes: painted plank cladding, bare weathered boards, plywood
 * sheet and a stencilled packing crate.
 *
 * Wood is the one surface where getting the *anisotropy* right matters more
 * than the noise: the grain has to run along the board, the ring spacing has
 * to vary per board, splits have to follow the grain and paint has to fail
 * along it too.
 */

import type { MaterialArchetype } from '../types';

const WOOD_COMMON = /* glsl */ `
/**
 * Growth rings for one board.
 *   local — uv inside the board (x across, y along)
 *   rnd   — per-board randoms
 *   guv   — global uv, used for the tiling warp/fibre noise
 */
float obWoodRings(vec2 local, vec3 rnd, vec2 guv, float seed) {
  float freq = mix(9.0, 22.0, rnd.x);
  float pith = (rnd.y - 0.5) * 2.2;
  float x = (local.x - 0.5 + pith) * freq;
  float warp = (obFbm(guv * vec2(6.0, 2.0), vec2(6.0, 2.0), 4, 0.55, seed) - 0.5) * 2.6;
  float warp2 = (obFbm(guv * vec2(24.0, 4.0), vec2(24.0, 4.0), 3, 0.5, seed + 7.0) - 0.5) * 0.7;
  float rings = abs(fract(x + warp + warp2) * 2.0 - 1.0);
  return pow(rings, 1.7);
}

/** Long fibrous streaking that runs with the grain. */
float obWoodFibre(vec2 guv, float along, float across, float seed) {
  float a = obValueP(guv * vec2(across, along), vec2(across, along), seed);
  float b = obValueP(guv * vec2(across * 3.0, along * 2.0), vec2(across * 3.0, along * 2.0), seed + 3.0);
  return a * 0.62 + b * 0.38;
}

/** A knot: circular ring compression around a dark core. */
float obWoodKnot(vec2 local, vec3 rnd, out float core) {
  vec2 kp = vec2(mix(0.25, 0.75, rnd.x), mix(0.15, 0.85, rnd.y));
  vec2 dvec = (local - kp) * vec2(1.0, 0.42);
  float r = length(dvec);
  core = smoothstep(0.055, 0.018, r);
  float halo = smoothstep(0.20, 0.05, r);
  return halo;
}
`;

/* -------------------------------------------------------- painted planks -- */

const woodPainted: MaterialArchetype = {
  id: 'wood',
  label: 'Painted plank cladding',
  surface: 'wood',
  detail: 'fibre',
  shader: { pom: true, pomShadow: true, pomDepth: 0.010, detailScale: 18 },
  recipe: {
    id: 'wood',
    seed: 151,
    size: 1024,
    geometry: { tile: 1.8, depth: 0.014 },
    normalGain: 1.1,
    normalWide: 0.45,
    aoRadius: 0.04,
    aoAlbedo: 0.42,
    common: WOOD_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obPlanks(uv, vec2(6.0, 2.0), 0.5, uSeed);
  float dx = min(c.local.x, 1.0 - c.local.x);
  float dy = min(c.local.y, 1.0 - c.local.y);
  float gapX = smoothstep(0.030, 0.075, dx);
  float gapY = smoothstep(0.006, 0.020, dy);
  float face = min(gapX, gapY);

  // boards cup and sit at slightly different depths
  float cup = (1.0 - pow(abs(c.local.x - 0.5) * 2.0, 2.0)) * (c.rnd.x - 0.5) * 0.10;
  float h = mix(0.16, 0.78 + (c.rnd.y - 0.5) * 0.10 + cup, face);

  float rings = obWoodRings(c.local, c.rnd, uv, uSeed + 3.0);
  float fibre = obWoodFibre(uv, 260.0, 22.0, uSeed + 5.0);
  h += (rings * 0.5 + fibre * 0.5 - 0.5) * 0.10 * face;

  float knotCore;
  float knot = obWoodKnot(c.local, c.rnd, knotCore) * step(0.45, c.rnd.z);
  h -= knotCore * 0.16 * face;
  h += knot * 0.03 * face;

  // splits that follow the grain, and nail heads
  float split = obScratches(uv, 22.0, 0.0, 34.0, 0.22, uSeed + 11.0);
  h -= split * 0.22 * face;
  vec2 nf = fract(vec2(c.local.x * 1.0, uv.y * 8.0) + vec2(0.5, 0.0)) - 0.5;
  float nail = smoothstep(0.10, 0.03, length(nf * vec2(2.4, 1.0))) * face;
  h -= nail * 0.10;

  // paint film: sits proud, flakes off at the edges and over knots
  float flakeN = obFbm(uv * 9.0, vec2(9.0), 5, 0.55, uSeed + 17.0);
  float weather = obSat(1.0 - uv.y * 1.2);
  float paint = smoothstep(0.56, 0.40, flakeN + weather * 0.28);
  paint = smoothstep(0.18, 0.62, obSat(paint - knotCore));
  paint *= face;
  h += paint * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), paint, c.rnd.x, face);
  h1 = vec4(rings, knot + knotCore, split, fibre);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float paint = h0.y, face = h0.w;
  float rings = h1.x, knot = h1.y, split = h1.z, fibre = h1.w;

  float edge = obSat(d.curv * 1.3);
  paint = smoothstep(0.15, 0.55, obSat(paint - edge * 0.45));

  // bare timber underneath: pale sapwood with darker latewood rings
  vec3 early = obRGB(178, 148, 106);
  vec3 late  = obRGB(126,  94,  62);
  vec3 bare = mix(early, late, obSat(rings * 0.85 + fibre * 0.3));
  bare = mix(bare, obRGB(88, 66, 46), knot * 0.7);
  // grey out where the weather gets at it
  float grey = obSat(1.0 - paint) * obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 61.0);
  bare = mix(bare, obRGB(140, 133, 122), grey * 0.55);

  vec3 paintCol = obRGB(178, 172, 158);
  paintCol = mix(paintCol, obRGB(150, 146, 136), obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 67.0) * 0.7);
  // chalking: the film goes powdery and lighter where the sun hits
  paintCol = mix(paintCol, paintCol * 1.18 + 0.02, obSat(uv.y) * 0.4);

  vec3 col = mix(bare, paintCol, paint);
  col = mix(col, obRGB(52, 42, 32), split * 0.6);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.1);
  col = mix(col, obRGB(58, 50, 40), grime * 0.5);
  float streak = obStreaks(uv, 24.0, 0.4, uSeed + 71.0);
  col = mix(col, obRGB(76, 66, 52), streak * 0.28);
  // moss creeping out of the board gaps
  float moss = obSat(d.cavity * 2.0) * obSplatter(uv, 6.0, 0.30, uSeed + 79.0);
  col = mix(col, obRGB(70, 80, 52), moss * 0.35);

  col = mix(col, obRGB(30, 26, 22), (1.0 - face) * 0.55);

  o.albedo = col;
  o.metal = 0.0;
  float rough = mix(0.94, 0.62, paint);
  rough += split * 0.06 + grime * 0.08 - edge * 0.08;
  o.rough = clamp(rough, 0.35, 1.0);
}`,
  },
};

/* --------------------------------------------------------- bare weathered -- */

const woodBare: MaterialArchetype = {
  id: 'woodThin',
  label: 'Weathered bare board',
  surface: 'woodThin',
  detail: 'fibre',
  shader: { pom: true, pomDepth: 0.008, detailScale: 20 },
  recipe: {
    id: 'woodThin',
    seed: 157,
    size: 1024,
    geometry: { tile: 1.5, depth: 0.010 },
    normalGain: 1.2,
    normalWide: 0.4,
    aoRadius: 0.032,
    aoAlbedo: 0.4,
    common: WOOD_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obPlanks(uv, vec2(4.0, 2.0), 0.37, uSeed);
  float dx = min(c.local.x, 1.0 - c.local.x);
  float face = smoothstep(0.020, 0.055, dx);

  float rings = obWoodRings(c.local, c.rnd, uv, uSeed + 3.0);
  float fibre = obWoodFibre(uv, 320.0, 18.0, uSeed + 5.0);
  float h = mix(0.20, 0.74 + (c.rnd.y - 0.5) * 0.08, face);

  // weathered timber erodes: the soft earlywood washes out, latewood stands proud
  h += (rings - 0.45) * 0.22 * face;
  h += (fibre - 0.5) * 0.10 * face;

  float knotCore;
  float knot = obWoodKnot(c.local, c.rnd, knotCore) * step(0.35, c.rnd.z);
  h += knot * 0.05 * face;
  h -= knotCore * 0.24 * face;

  float split = obScratches(uv, 18.0, 0.0, 40.0, 0.35, uSeed + 11.0);
  float check = obScratches(uv, 46.0, 0.0, 60.0, 0.5, uSeed + 13.0);
  h -= (split * 0.30 + check * 0.10) * face;

  h0 = vec4(clamp(h, 0.0, 1.0), split, c.rnd.x, face);
  h1 = vec4(rings, knot + knotCore, check, fibre);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float split = h0.y, face = h0.w;
  float rings = h1.x, knot = h1.y, fibre = h1.w;

  vec3 silver = obRGB(150, 144, 132);
  vec3 warm   = obRGB(146, 116,  82);
  vec3 dark   = obRGB( 92,  72,  54);

  float exposure = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(warm, silver, obSat(exposure * 1.3 - 0.05));
  col = mix(col, dark, obSat(rings * 0.8) * 0.45);
  col = mix(col, obRGB(70, 54, 40), knot * 0.7);
  col *= mix(0.90, 1.10, fibre);

  col = mix(col, obRGB(48, 40, 32), split * 0.65);

  float grime = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.1);
  col = mix(col, obRGB(56, 50, 42), grime * 0.5);
  float moss = obSat(d.cavity * 1.8) * obSplatter(uv, 7.0, 0.28, uSeed + 71.0);
  col = mix(col, obRGB(72, 82, 54), moss * 0.35);
  col = mix(col, obRGB(26, 22, 18), (1.0 - face) * 0.6);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.95 - obSat(rings) * 0.05 + grime * 0.05, 0.55, 1.0);
}`,
  },
};

/* --------------------------------------------------------------- plywood -- */

const plywood: MaterialArchetype = {
  id: 'plywood',
  label: 'Plywood sheet',
  surface: 'plywood',
  detail: 'fibre',
  shader: { triplanar: false, pom: false, detailScale: 22 },
  recipe: {
    id: 'plywood',
    seed: 163,
    size: 1024,
    geometry: { tile: 2.44, depth: 0.006 },
    normalGain: 1.3,
    aoRadius: 0.03,
    aoAlbedo: 0.35,
    common: WOOD_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // rotary-cut veneer: broad cathedral figure running the length of the sheet
  vec2 w = obWarp(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 0.85, uSeed);
  float fig = obFbm(w * vec2(2.0, 6.0), vec2(6.0, 6.0), 4, 0.55, uSeed + 3.0);
  float rings = abs(fract(fig * 7.0) * 2.0 - 1.0);
  rings = pow(rings, 1.5);
  float fibre = obWoodFibre(uv, 420.0, 14.0, uSeed + 5.0);

  float h = 0.70 + (rings - 0.5) * 0.10 + (fibre - 0.5) * 0.12;

  // football patches where defects were cut out and plugged
  vec3 pt = obWorleyP(uv * 6.0, vec2(6.0), 1.0, uSeed + 11.0);
  float plug = smoothstep(0.24, 0.16, pt.x) * step(0.80, pt.z);
  h += plug * 0.05;

  // delaminated corner and edge splinters
  float edgeD = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float edge = smoothstep(0.05, 0.0, edgeD);
  float splint = obScratches(uv, 60.0, 0.0, 50.0, 0.5, uSeed + 13.0) * edge;
  h -= splint * 0.35;

  // surface dings
  float ding = obSplatter(uv, 12.0, 0.10, uSeed + 17.0);
  h -= ding * 0.22;

  // stencilled grade stamp keeps it from looking like a noise field
  vec2 sp = (uv - vec2(0.16, 0.72)) * vec2(3.4, 12.0);
  float stampBox = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
  float stamp = stampBox * step(0.45, obValueP(vec2(sp.x * 22.0, sp.y * 4.0), vec2(22.0, 4.0), uSeed + 19.0));

  h0 = vec4(clamp(h, 0.0, 1.0), plug, rings, edge);
  h1 = vec4(fibre, splint, ding, stamp);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float plug = h0.y, rings = h0.z, edge = h0.w;
  float fibre = h1.x, splint = h1.y, ding = h1.z, stamp = h1.w;

  vec3 pale = obRGB(206, 176, 128);
  vec3 mid  = obRGB(178, 142,  96);
  vec3 deep = obRGB(140, 104,  66);

  vec3 col = mix(pale, mid, obSat(rings * 0.9));
  col = mix(col, deep, obSat(rings * rings * 1.2) * 0.6);
  col *= mix(0.92, 1.08, fibre);

  // glue line showing at the delaminated edges
  col = mix(col, obRGB(120, 96, 70), splint * 0.6);
  col = mix(col, obRGB(196, 170, 132), plug * 0.55);
  col = mix(col, obRGB(150, 118, 82), ding * 0.5);

  // ink stamp
  col = mix(col, obRGB(52, 62, 84), stamp * 0.75);

  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 0.9);
  col = mix(col, obRGB(84, 70, 54), grime * 0.4);
  col = mix(col, obRGB(96, 84, 66), edge * 0.35);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.88 + splint * 0.08 - stamp * 0.08 + grime * 0.05, 0.5, 1.0);
}`,
  },
};

/* ----------------------------------------------------------------- crate -- */

const crate: MaterialArchetype = {
  id: 'crate',
  label: 'Packing crate',
  surface: 'crate',
  detail: 'fibre',
  shader: { triplanar: false, pom: true, pomShadow: true, pomDepth: 0.012, detailScale: 18 },
  recipe: {
    id: 'crate',
    seed: 167,
    size: 1024,
    geometry: { tile: 0.9, depth: 0.016 },
    normalGain: 1.05,
    normalWide: 0.45,
    aoRadius: 0.04,
    aoAlbedo: 0.45,
    common: WOOD_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // horizontal slats with a vertical batten frame
  ObCell c = obPlanks(uv.yx, vec2(5.0, 2.0), 0.4, uSeed);
  float dy = min(c.local.x, 1.0 - c.local.x);
  float slat = smoothstep(0.020, 0.060, dy);

  float bx = abs(fract(uv.x * 2.0 + 0.5) - 0.5) * 2.0;
  float batten = smoothstep(0.80, 0.66, bx);
  float frameY = smoothstep(0.86, 0.74, abs(uv.y - 0.5) * 2.0);
  float frame = max(batten, 1.0 - frameY);

  float h = mix(0.22, 0.68 + (c.rnd.y - 0.5) * 0.08, slat);
  h = max(h, frame * 0.90);

  float rings = obWoodRings(c.local.yx, c.rnd, uv, uSeed + 3.0);
  float fibre = obWoodFibre(uv.yx, 220.0, 26.0, uSeed + 5.0);
  h += (rings * 0.5 + fibre * 0.5 - 0.5) * 0.09;

  float split = obScratches(uv.yx, 26.0, 0.0, 36.0, 0.25, uSeed + 11.0);
  h -= split * 0.20;

  // nails through the battens
  vec2 nf = fract(uv * vec2(2.0, 10.0) + vec2(0.5, 0.5)) - 0.5;
  float nail = smoothstep(0.14, 0.05, length(nf * vec2(1.0, 2.4))) * batten;
  h -= nail * 0.10;

  // scuffed corners
  float edgeD = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float edge = smoothstep(0.06, 0.0, edgeD);
  h -= edge * obSplatter(uv, 26.0, 0.4, uSeed + 13.0) * 0.2;

  // stencil block: a bold shipping mark
  vec2 sp = (uv - vec2(0.22, 0.30)) * vec2(2.0, 5.0);
  float box = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
  float glyph = step(0.52, obValueP(vec2(sp.x * 14.0, sp.y * 3.0), vec2(14.0, 3.0), uSeed + 17.0));
  float stencil = box * glyph * slat;
  // hazard chevrons along the bottom rail
  float chev = obHazardStripes(uv, 9.0, 0.5) * smoothstep(0.16, 0.10, uv.y);

  h0 = vec4(clamp(h, 0.0, 1.0), stencil, c.rnd.x, slat);
  h1 = vec4(rings, split, nail, chev);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float stencil = h0.y, slat = h0.w;
  float rings = h1.x, split = h1.y, nail = h1.z, chev = h1.w;

  vec3 pale = obRGB(190, 158, 112);
  vec3 mid  = obRGB(158, 124,  84);
  vec3 deep = obRGB(112,  84,  56);

  vec3 col = mix(pale, mid, obSat(rings * 0.9));
  col = mix(col, deep, obSat(rings * rings) * 0.5);
  col *= mix(0.90, 1.10, obValueP(uv * 400.0, vec2(400.0), uSeed + 5.0));

  col = mix(col, obRGB(60, 46, 34), split * 0.6);
  col = mix(col, obRGB(96, 96, 100), nail * 0.8);

  // black stencil ink, worn where the wood is proud
  float inkWear = obSat(d.curv * 0.8 + 0.35);
  col = mix(col, obRGB(38, 36, 34), stencil * (1.0 - inkWear * 0.45) * 0.85);
  col = mix(col, obRGB(178, 138, 34), chev * 0.55 * slat);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(64, 54, 42), grime * 0.45);
  col = mix(col, obRGB(24, 20, 16), (1.0 - slat) * 0.35);

  o.albedo = col;
  o.metal = nail * 0.6;
  o.rough = clamp(0.90 + split * 0.05 - nail * 0.35 - stencil * 0.06 + grime * 0.05, 0.30, 1.0);
}`,
  },
};

export const WOOD_ARCHETYPES: MaterialArchetype[] = [woodPainted, woodBare, plywood, crate];
