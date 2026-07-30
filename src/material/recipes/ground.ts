/**
 * Ground archetypes: dry dirt, sand, gravel bed, dead grass, wet mud, snow
 * and ice.
 *
 * Ground is what the player stares at while sprinting, so it gets the most
 * height-field detail per texel: real pebbles that cast their own AO, ripples
 * that catch grazing light, and wetness that changes roughness rather than
 * just tint.
 */

import type { MaterialArchetype } from '../types';

const GROUND_COMMON = /* glsl */ `
/** Scattered blade/twig segments on a wrapped grid. Returns coverage 0..1. */
float obBlades(vec2 uv, float count, float width, float seed, out float rnd) {
  vec2 p = uv * count;
  vec2 i = floor(p);
  vec2 f = fract(p) - 0.5;
  float best = 0.0;
  rnd = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, vec2(count));
      vec3 r = obHash33(vec3(cell, seed));
      float a = r.x * OB_TAU;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 c0 = g + vec2(r.y, r.z) - 0.5 - f;
      float len = mix(0.5, 1.4, r.z);
      float t = clamp(dot(-c0, dir), 0.0, len);
      float dseg = length(c0 + dir * t);
      float w = width * mix(0.6, 1.5, r.y);
      float v = smoothstep(w, 0.0, dseg) * (1.0 - t / max(len, 1e-3) * 0.55);
      if (v > best) { best = v; rnd = r.x; }
    }
  }
  return best;
}

/** Packed rounded pebbles: height dome + per-stone id. */
vec3 obPebbles(vec2 uv, float count, float jitter, float seed) {
  vec3 w = obWorleyP(uv * count, vec2(count), jitter, seed);
  float r = mix(0.30, 0.52, w.z);
  float dome = smoothstep(r, 0.0, w.x);
  return vec3(sqrt(max(dome, 0.0)), w.z, w.y - w.x);
}
`;

/* ------------------------------------------------------------------ dirt -- */

const dirt: MaterialArchetype = {
  id: 'dirt',
  label: 'Dry dirt',
  surface: 'dirt',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.02, detailScale: 14, triplanar: true },
  recipe: {
    id: 'dirt',
    seed: 201,
    size: 1024,
    geometry: { tile: 2.0, depth: 0.03 },
    normalGain: 1.0,
    normalWide: 0.45,
    aoRadius: 0.045,
    aoAlbedo: 0.5,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // broad undulation + compacted clods
  float h = 0.52 + (obFbm(uv * 4.0, vec2(4.0), 5, 0.55, uSeed) - 0.5) * 0.34;
  float clod = obWorleyFbm(uv * 40.0, vec2(40.0), 3, 1.0, uSeed + 3.0);
  h += (0.5 - clod) * 0.20;

  // small stones pressed into the surface
  vec3 peb = obPebbles(uv, 70.0, 1.0, uSeed + 7.0);
  float stone = peb.x * step(0.55, peb.y);
  h += stone * 0.16;
  vec3 peb2 = obPebbles(uv, 240.0, 1.0, uSeed + 11.0);
  float grit = peb2.x * step(0.40, peb2.y);
  h += grit * 0.06;

  // dried mud cracks
  float crack = obCracks(uv, vec2(1.0), 7.0, 0.030, uSeed + 13.0);
  h -= crack * 0.28;

  // scuff marks and a boot print or two
  float scuff = obScratches(uv, 12.0, 2.0, 12.0, 0.35, uSeed + 17.0);
  h -= scuff * 0.08;

  // organic debris
  float twigRnd;
  float twig = obBlades(uv, 22.0, 0.06, uSeed + 19.0, twigRnd);

  h0 = vec4(clamp(h, 0.0, 1.0), stone, peb.y, crack);
  h1 = vec4(grit, twig, twigRnd, clod);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float stone = h0.y, stoneId = h0.z, crack = h0.w;
  float grit = h1.x, twig = h1.y, twigRnd = h1.z;

  vec3 lightSoil = obRGB(134, 110,  80);
  vec3 midSoil   = obRGB( 96,  76,  54);
  vec3 darkSoil  = obRGB( 58,  45,  33);

  float damp = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(lightSoil, midSoil, obSat(damp * 1.2));
  col = mix(col, darkSoil, obSat(damp * 1.6 - 0.6));

  // dust film sits on the raised, dry parts
  float dust = obSat(d.curv * 0.8 + d.height * 0.7);
  col = mix(col, obRGB(158, 140, 110), dust * 0.35);

  // pebbles are grey/tan and individually varied
  vec3 stoneCol = mix(obRGB(146, 140, 128), obRGB(112, 100, 88), stoneId);
  stoneCol = mix(stoneCol, obRGB(96, 84, 70), step(0.82, stoneId));
  col = mix(col, stoneCol, obSat(stone * 1.2) * 0.8);
  col = mix(col, obRGB(150, 144, 132), grit * 0.35);

  // cracks and hollows are darker and damper
  col = mix(col, darkSoil * 0.75, crack * 0.7);
  float shade = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.1);
  col = mix(col, darkSoil * 0.8, shade * 0.5);

  // dead twigs / straw
  vec3 twigCol = mix(obRGB(126, 106, 68), obRGB(88, 74, 50), twigRnd);
  col = mix(col, twigCol, obSat(twig * 1.4) * 0.75);

  float speck = obValueP(uv * 520.0, vec2(520.0), uSeed + 5.0);
  col *= mix(0.90, 1.10, speck);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.97 - stone * 0.14 - grit * 0.05;
  rough -= obSat(damp * 1.6 - 0.9) * 0.12;
  o.rough = clamp(rough, 0.45, 1.0);
}`,
  },
};

/* ------------------------------------------------------------------ sand -- */

const sand: MaterialArchetype = {
  id: 'sand',
  label: 'Sand',
  surface: 'sand',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.016, detailScale: 20, triplanar: true },
  recipe: {
    id: 'sand',
    seed: 211,
    size: 1024,
    geometry: { tile: 2.4, depth: 0.025 },
    normalGain: 0.9,
    normalWide: 0.5,
    aoRadius: 0.05,
    aoAlbedo: 0.45,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // wind ripples: a sheared, sharpened wave train with a warped crest line
  vec2 w = obWarp(uv * vec2(3.0, 3.0), vec2(3.0), 0.45, uSeed);
  float ripple = obFbm(w * vec2(1.0, 9.0), vec2(3.0, 27.0), 3, 0.5, uSeed + 3.0);
  ripple = pow(obSat(ripple * 1.35 - 0.15), 1.2);
  float h = 0.42 + ripple * 0.46;

  // large dune undulation
  h += (obFbm(uv * 2.0, vec2(2.0), 4, 0.55, uSeed + 7.0) - 0.5) * 0.26;

  // scattered shell fragments and stones
  vec3 peb = obPebbles(uv, 150.0, 1.0, uSeed + 11.0);
  float shell = peb.x * step(0.88, peb.y);
  h += shell * 0.10;

  // footprints and vehicle scuffs
  vec3 fp = obWorleyP(uv * 6.0, vec2(6.0), 1.0, uSeed + 13.0);
  float print = smoothstep(0.22, 0.05, fp.x) * step(0.80, fp.z);
  h -= print * 0.22;

  // grain-level micro relief
  float grain = obValueP(uv * 320.0, vec2(320.0), uSeed + 17.0);
  h += (grain - 0.5) * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), ripple, peb.y, print);
  h1 = vec4(shell, grain, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float ripple = h0.y, print = h0.w, shell = h1.x, grain = h1.y;

  vec3 pale = obRGB(214, 192, 152);
  vec3 warm = obRGB(186, 158, 114);
  vec3 damp = obRGB(126, 104,  74);

  float mix1 = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(warm, pale, obSat(mix1 * 1.1 + ripple * 0.4));

  // wet/compacted sand in the footprints
  col = mix(col, damp, print * 0.6);
  float shade = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.0);
  col = mix(col, warm * 0.72, shade * 0.4);

  // individual quartz grains sparkle
  float spark = step(0.986, obValueP(uv * 900.0, vec2(900.0), uSeed + 23.0));
  col = mix(col, obRGB(238, 232, 216), spark * 0.6);
  col *= mix(0.93, 1.08, grain);

  col = mix(col, obRGB(226, 220, 206), shell * 0.7);

  // darker mineral streaks
  float mineral = obFbm(uv * 12.0, vec2(12.0), 4, 0.5, uSeed + 71.0);
  col = mix(col, obRGB(120, 100, 82), smoothstep(0.66, 0.86, mineral) * 0.3);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.94 - spark * 0.5;
  rough = mix(rough, 0.70, print * 0.5);
  o.rough = clamp(rough, 0.30, 1.0);
}`,
  },
};

/* ---------------------------------------------------------------- gravel -- */

const gravel: MaterialArchetype = {
  id: 'gravel',
  label: 'Gravel bed',
  surface: 'gravel',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.026, detailScale: 16, triplanar: true },
  recipe: {
    id: 'gravel',
    seed: 223,
    size: 1024,
    geometry: { tile: 1.6, depth: 0.045 },
    normalGain: 0.85,
    normalWide: 0.4,
    aoRadius: 0.05,
    aoAlbedo: 0.55,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // three overlapping stone sizes so the bed reads as packed, not tiled
  vec3 a = obPebbles(uv, 26.0, 1.0, uSeed);
  vec3 b = obPebbles(uv, 46.0, 1.0, uSeed + 5.0);
  vec3 c = obPebbles(uv, 88.0, 1.0, uSeed + 11.0);

  float ha = a.x * mix(0.75, 1.0, a.y);
  float hb = b.x * mix(0.55, 0.85, b.y);
  float hc = c.x * mix(0.35, 0.60, c.y);

  float h = 0.20;
  float id = 0.0;
  if (ha >= hb && ha >= hc) { h += ha * 0.80; id = a.y; }
  else if (hb >= hc)        { h += hb * 0.80; id = b.y + 0.33; }
  else                      { h += hc * 0.80; id = c.y + 0.66; }
  h = max(h, 0.20 + max(max(ha, hb), hc) * 0.80);

  // fines packed between the stones
  float fines = obFbm(uv * 160.0, vec2(160.0), 4, 0.5, uSeed + 17.0);
  h += fines * 0.06;

  // faceting on the individual stones
  float facet = obRidged(uv * 300.0, vec2(300.0), 3, 0.5, uSeed + 19.0);
  h += (facet - 0.5) * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), max(max(ha, hb), hc), fract(id), fines);
  h1 = vec4(ha, hb, hc, facet);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float top = h0.y, id = h0.z, fines = h0.w, facet = h1.w;

  // a real gravel bed is four or five rock types mixed together
  vec3 grey  = obRGB(146, 143, 136);
  vec3 dark  = obRGB( 84,  82,  80);
  vec3 tan   = obRGB(158, 138, 108);
  vec3 pink  = obRGB(150, 118, 104);
  vec3 white = obRGB(196, 194, 186);

  vec3 col = grey;
  col = mix(col, dark,  smoothstep(0.18, 0.34, id) * step(id, 0.42));
  col = mix(col, tan,   smoothstep(0.42, 0.56, id) * step(id, 0.64));
  col = mix(col, pink,  smoothstep(0.64, 0.74, id) * step(id, 0.82));
  col = mix(col, white, smoothstep(0.86, 0.96, id));
  col *= mix(0.80, 1.16, facet);

  // dust and fines in the gaps
  vec3 finesCol = obRGB(118, 108,  92);
  col = mix(finesCol, col, obSat(top * 1.6));
  col = mix(col, finesCol * 0.8, obSat(d.cavity * 1.7 + (1.0 - d.ao) * 1.2) * 0.55);

  float speck = obValueP(uv * 640.0, vec2(640.0), uSeed + 5.0);
  col *= mix(0.90, 1.10, speck);

  // wet patches
  float wet = smoothstep(0.62, 0.86, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 71.0));
  col = mix(col, col * 0.62, wet * 0.6);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.90 - facet * 0.10;
  rough = mix(rough, 0.34, wet * 0.7);
  rough += fines * 0.06;
  o.rough = clamp(rough, 0.22, 1.0);
}`,
  },
};

/* ----------------------------------------------------------------- grass -- */

const grass: MaterialArchetype = {
  id: 'grass',
  label: 'Dry grass',
  surface: 'grass',
  detail: 'organic',
  shader: { pom: false, detailScale: 14, triplanar: true },
  recipe: {
    id: 'grass',
    seed: 227,
    size: 1024,
    geometry: { tile: 1.5, depth: 0.02 },
    normalGain: 0.9,
    normalWide: 0.4,
    aoRadius: 0.04,
    aoAlbedo: 0.55,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float soilH = 0.30 + (obFbm(uv * 5.0, vec2(5.0), 4, 0.55, uSeed) - 0.5) * 0.22;

  float r1, r2, r3;
  float b1 = obBlades(uv, 26.0, 0.075, uSeed + 3.0, r1);
  float b2 = obBlades(uv, 44.0, 0.050, uSeed + 7.0, r2);
  float b3 = obBlades(uv, 70.0, 0.035, uSeed + 11.0, r3);

  float cover = obSat(b1 * 1.1 + b2 * 0.8 + b3 * 0.6);
  // thinning patches where the soil shows through
  float thinning = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 13.0);
  cover *= smoothstep(0.30, 0.62, thinning + 0.25);

  float h = soilH + cover * 0.55;
  h += (obValueP(uv * 200.0, vec2(200.0), uSeed + 17.0) - 0.5) * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), cover, r1, thinning);
  h1 = vec4(b1, b2, b3, r2);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float cover = h0.y, r1 = h0.z, thinning = h0.w;
  float b1 = h1.x, b2 = h1.y, r2 = h1.w;

  vec3 soil = obRGB(76, 62, 44);
  vec3 dead = obRGB(158, 138,  86);
  vec3 straw= obRGB(184, 166, 112);
  vec3 green= obRGB( 96, 110,  56);
  vec3 deep = obRGB( 58,  70,  36);

  // colour per blade so the mat is not uniform
  vec3 blade = mix(dead, straw, r1);
  blade = mix(blade, green, smoothstep(0.55, 0.85, r2));
  blade = mix(blade, deep, smoothstep(0.85, 1.0, r2));

  vec3 col = mix(soil, blade, obSat(cover * 1.25));
  // shadow inside the mat
  col = mix(col, deep * 0.55, obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.3) * 0.55);
  // sun-bleached tips
  float tips = obSat(d.curv * 0.9) * cover;
  col = mix(col, straw * 1.15, tips * 0.35);

  col = mix(col, soil * 0.9, smoothstep(0.45, 0.15, thinning) * 0.6);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.92 - tips * 0.12, 0.55, 1.0);
}`,
  },
};

/* ------------------------------------------------------------------- mud -- */

const mud: MaterialArchetype = {
  id: 'mud',
  label: 'Wet mud',
  surface: 'mud',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.02, detailScale: 14, triplanar: true },
  recipe: {
    id: 'mud',
    seed: 229,
    size: 1024,
    geometry: { tile: 2.2, depth: 0.03 },
    normalGain: 1.0,
    normalWide: 0.5,
    aoRadius: 0.05,
    aoAlbedo: 0.5,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.55 + (obFbm(uv * 3.0, vec2(3.0), 5, 0.55, uSeed) - 0.5) * 0.40;

  // vehicle ruts: two parallel troughs with a churned crest between
  float rut = smoothstep(0.10, 0.02, abs(fract(uv.x * 2.0) - 0.30))
            + smoothstep(0.10, 0.02, abs(fract(uv.x * 2.0) - 0.70));
  rut *= smoothstep(0.15, 0.5, obFbm(uv * vec2(2.0, 6.0), vec2(2.0, 6.0), 3, 0.5, uSeed + 3.0) + 0.3);
  h -= rut * 0.26;

  // tread bars stamped into the mud
  float tread = smoothstep(0.55, 0.75, obValueP(uv * vec2(6.0, 40.0), vec2(6.0, 40.0), uSeed + 5.0)) * rut;
  h += tread * 0.10;

  // boot prints
  vec3 fp = obWorleyP(uv * 8.0, vec2(8.0), 1.0, uSeed + 7.0);
  float print = smoothstep(0.20, 0.04, fp.x) * step(0.72, fp.z);
  h -= print * 0.28;

  // churned clods and small stones
  float clod = obWorleyFbm(uv * 55.0, vec2(55.0), 3, 1.0, uSeed + 11.0);
  h += (0.5 - clod) * 0.16;
  vec3 peb = obPebbles(uv, 190.0, 1.0, uSeed + 13.0);
  h += peb.x * step(0.80, peb.y) * 0.08;

  // water pools in the low ground: everything below waterline is flat
  float water = smoothstep(0.40, 0.34, h);
  h = mix(h, 0.37, water * 0.85);

  h0 = vec4(clamp(h, 0.0, 1.0), water, print, rut);
  h1 = vec4(clod, tread, peb.y, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float water = h0.y, print = h0.z, rut = h0.w;

  vec3 dryMud = obRGB(112,  94,  70);
  vec3 wetMud = obRGB( 62,  50,  38);
  vec3 pool   = obRGB( 38,  34,  30);

  float damp = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(dryMud, wetMud, obSat(damp * 1.2 + rut * 0.5));
  col = mix(col, wetMud * 0.85, print * 0.7);
  col = mix(col, pool, water * 0.85);

  float shade = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.2);
  col = mix(col, wetMud * 0.7, shade * 0.5);

  float speck = obValueP(uv * 460.0, vec2(460.0), uSeed + 5.0);
  col *= mix(0.92, 1.08, speck);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.86 - obSat(damp - 0.4) * 0.25;
  rough = mix(rough, 0.06, water);
  rough = mix(rough, 0.42, print * 0.4);
  o.rough = clamp(rough, 0.04, 1.0);
}`,
  },
};

/* ------------------------------------------------------------------ snow -- */

const snow: MaterialArchetype = {
  id: 'snow',
  label: 'Trodden snow',
  surface: 'snow',
  detail: 'micro',
  shader: { pom: true, pomDepth: 0.02, detailScale: 18, triplanar: true },
  recipe: {
    id: 'snow',
    seed: 233,
    size: 512,
    geometry: { tile: 2.0, depth: 0.03 },
    normalGain: 0.8,
    normalWide: 0.55,
    aoRadius: 0.05,
    aoAlbedo: 0.25,
    common: GROUND_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.60 + (obFbm(uv * 3.0, vec2(3.0), 5, 0.55, uSeed) - 0.5) * 0.30;
  // wind-sculpted sastrugi
  float sast = obRidged(obWarp(uv * vec2(2.0, 5.0), vec2(2.0, 5.0), 0.35, uSeed + 3.0), vec2(2.0, 5.0), 3, 0.5, uSeed + 5.0);
  h += (sast - 0.5) * 0.16;

  vec3 fp = obWorleyP(uv * 7.0, vec2(7.0), 1.0, uSeed + 7.0);
  float print = smoothstep(0.20, 0.03, fp.x) * step(0.62, fp.z);
  h -= print * 0.34;

  float crust = obValueP(uv * 240.0, vec2(240.0), uSeed + 11.0);
  h += (crust - 0.5) * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), print, crust, sast);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float print = h0.y, crust = h0.z;

  vec3 fresh = obRGB(214, 220, 230);
  vec3 packed = obRGB(172, 180, 194);
  vec3 dirty = obRGB(150, 148, 144);

  vec3 col = mix(fresh, packed, print * 0.7);
  float grit = obSplatter(uv, 8.0, 0.22, uSeed + 61.0) * print;
  col = mix(col, dirty, grit * 0.5);
  col = mix(col, packed * 0.92, obSat(d.cavity * 1.2 + (1.0 - d.ao) * 0.8) * 0.35);

  float spark = step(0.992, obValueP(uv * 1100.0, vec2(1100.0), uSeed + 71.0));
  col = mix(col, vec3(0.92), spark * 0.7);
  col *= mix(0.97, 1.03, crust);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.72 - spark * 0.55 + print * 0.10, 0.12, 1.0);
}`,
  },
};

/* ------------------------------------------------------------------- ice -- */

const ice: MaterialArchetype = {
  id: 'ice',
  label: 'Frozen puddle',
  surface: 'ice',
  detail: 'micro',
  shader: { pom: false, detailScale: 26, triplanar: true },
  recipe: {
    id: 'ice',
    seed: 239,
    size: 512,
    geometry: { tile: 1.6, depth: 0.006 },
    normalGain: 1.4,
    aoRadius: 0.02,
    aoStrength: 0.6,
    aoAlbedo: 0.2,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.70 + (obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed) - 0.5) * 0.14;
  float crack = obCracks(uv, vec2(1.0), 5.0, 0.024, uSeed + 3.0)
              + obCracks(uv, vec2(1.0), 11.0, 0.016, uSeed + 5.0) * 0.6;
  h -= obSat(crack) * 0.28;
  // trapped air feathers
  float feather = obRidged(uv * 24.0, vec2(24.0), 4, 0.5, uSeed + 7.0);
  h += (feather - 0.5) * 0.06;
  // scuffed skate/boot marks
  float scuff = obScratches(uv, 20.0, 3.0, 20.0, 0.4, uSeed + 11.0);
  h -= scuff * 0.10;
  h0 = vec4(clamp(h, 0.0, 1.0), obSat(crack), feather, scuff);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crack = h0.y, feather = h0.z, scuff = h0.w;
  vec3 clear = obRGB(126, 148, 158);
  vec3 milky = obRGB(196, 210, 216);
  vec3 col = mix(clear, milky, obSat(feather * 1.2));
  col = mix(col, obRGB(228, 236, 240), crack * 0.7);
  col = mix(col, obRGB(90, 104, 110), obSat(d.cavity) * 0.4);
  col = mix(col, milky, scuff * 0.5);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.08 + crack * 0.35 + scuff * 0.35 + feather * 0.06, 0.03, 0.85);
}`,
  },
};

export const GROUND_ARCHETYPES: MaterialArchetype[] = [
  dirt, sand, gravel, grass, mud, snow, ice,
];
