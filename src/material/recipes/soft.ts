/**
 * Soft-goods archetypes: canvas tarpaulin, hessian sandbag, carpet, corrugated
 * cardboard, rubber matting, scuffed plastic, ballistic nylon and composite
 * helmet shell.
 *
 * Woven materials live or die on the weave being *legible at two scales* — the
 * thread crossings up close, the bolt-width waviness from across the room —
 * so every weave here is a real over/under height field, never a noise texture.
 */

import type { MaterialArchetype } from '../types';

const CLOTH_COMMON = /* glsl */ `
/**
 * A plain weave with per-thread thickness variation and slub defects.
 * Returns (height, warpMask, threadRandom).
 */
vec3 obCloth(vec2 uv, float count, float slub, float seed) {
  vec2 p = uv * count;
  vec2 f = fract(p);
  vec2 i = floor(p);
  float par = mod(i.x + i.y, 2.0);

  float tw = obHash13(vec3(mod(i.x, count), 0.0, seed));
  float tf = obHash13(vec3(0.0, mod(i.y, count), seed + 3.0));
  float thickW = mix(1.0 - slub, 1.0 + slub, tw);
  float thickF = mix(1.0 - slub, 1.0 + slub, tf);

  float warp = pow(sin(clamp(f.x, 0.0, 1.0) * OB_PI), 0.7) * thickW;
  float weft = pow(sin(clamp(f.y, 0.0, 1.0) * OB_PI), 0.7) * thickF;

  float h = par > 0.5 ? warp * 0.92 + weft * 0.30 : weft * 0.92 + warp * 0.30;
  float rnd = obHash13(vec3(mod(i, vec2(count)), seed + 7.0));
  return vec3(h, par, rnd);
}

/** Loose fibres pulled out of a weave — short curved strands on a wrapped grid. */
float obFuzz(vec2 uv, float count, float width, float seed, out float rnd) {
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
      if (r.z < 0.55) continue;
      float a = r.x * OB_TAU;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 c0 = g + vec2(r.y, r.z) - 0.5 - f;
      float len = mix(0.35, 0.9, r.z);
      float t = clamp(dot(-c0, dir), 0.0, len);
      float dseg = length(c0 + dir * t);
      float v = smoothstep(width, 0.0, dseg) * (1.0 - t / max(len, 1e-3) * 0.6);
      if (v > best) { best = v; rnd = r.x; }
    }
  }
  return best;
}
`;

/* ---------------------------------------------------------- canvas tarp -- */

const fabric: MaterialArchetype = {
  id: 'fabric',
  label: 'Canvas tarpaulin',
  surface: 'fabric',
  detail: 'fibre',
  doubleSided: true,
  shader: { pom: false, detailScale: 30 },
  recipe: {
    id: 'fabric',
    seed: 301,
    size: 1024,
    geometry: { tile: 1.0, depth: 0.004 },
    normalGain: 1.5,
    normalWide: 0.3,
    aoRadius: 0.02,
    aoAlbedo: 0.45,
    common: CLOTH_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  vec3 cl = obCloth(uv, 190.0, 0.30, uSeed);
  float h = 0.42 + cl.x * 0.42;

  // bolt-scale waviness and creases from being folded
  h += (obFbm(uv * 5.0, vec2(5.0), 4, 0.55, uSeed + 3.0) - 0.5) * 0.14;
  float crease = obScratches(uv, 6.0, 1.0, 10.0, 0.5, uSeed + 5.0)
               + obScratches(uv, 5.0, 4.0, 10.0, 0.5, uSeed + 7.0);
  h -= obSat(crease) * 0.14;

  // stitched seam with a raised double row
  float seam = smoothstep(0.020, 0.008, abs(fract(uv.y * 2.0) - 0.5));
  float stitch = step(0.5, fract(uv.x * 90.0)) * seam;
  h += seam * 0.10 + stitch * 0.08;

  // frayed hole
  float hole = obSplatter(uv, 5.0, 0.06, uSeed + 11.0);
  hole = smoothstep(0.45, 0.85, hole);
  h -= hole * 0.6;

  h0 = vec4(clamp(h, 0.0, 1.0), cl.y, cl.z, hole);
  h1 = vec4(seam, stitch, crease, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float par = h0.y, rnd = h0.z, hole = h0.w;
  float seam = h1.x, stitch = h1.y, crease = h1.z;

  vec3 olive = obRGB(104,  98,  70);
  vec3 faded = obRGB(142, 134, 102);
  vec3 dark  = obRGB( 62,  60,  44);

  float sun = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(olive, faded, obSat(sun * 1.2));
  // warp and weft dyed slightly differently
  col *= mix(0.94, 1.06, par);
  col *= mix(0.90, 1.10, rnd);

  // creases hold dirt, the ridges are bleached
  col = mix(col, dark, obSat(crease) * 0.35);
  col = mix(col, faded * 1.12, obSat(d.curv) * 0.25);

  float grime = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.2);
  col = mix(col, obRGB(58, 52, 40), grime * 0.45);
  float stain = obSplatter(uv, 4.0, 0.28, uSeed + 71.0);
  col = mix(col, obRGB(74, 62, 44), stain * 0.35);

  col = mix(col, obRGB(46, 44, 36), seam * 0.25);
  col = mix(col, obRGB(158, 150, 124), stitch * 0.5);
  col = mix(col, obRGB(30, 28, 24), hole * 0.85);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.90 - obSat(d.curv) * 0.10 + grime * 0.06, 0.55, 1.0);
  o.alpha = 1.0 - smoothstep(0.75, 0.95, hole);
}`,
  },
};

/* ------------------------------------------------------------- sandbag --- */

const sandbag: MaterialArchetype = {
  id: 'sandbag',
  label: 'Hessian sandbag',
  surface: 'sandbag',
  detail: 'fibre',
  shader: { pom: true, pomShadow: true, pomDepth: 0.006, detailScale: 26 },
  recipe: {
    id: 'sandbag',
    seed: 307,
    size: 1024,
    geometry: { tile: 0.55, depth: 0.008 },
    normalGain: 1.4,
    normalWide: 0.35,
    aoRadius: 0.025,
    aoAlbedo: 0.5,
    common: CLOTH_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // hessian is coarse: fewer, fatter, more irregular threads
  vec3 cl = obCloth(uv, 105.0, 0.45, uSeed);
  float h = 0.40 + cl.x * 0.46;

  // the sand inside makes the surface lumpy
  h += (obFbm(uv * 8.0, vec2(8.0), 4, 0.55, uSeed + 3.0) - 0.5) * 0.22;
  float lump = obWorleyFbm(uv * 18.0, vec2(18.0), 3, 1.0, uSeed + 5.0);
  h += (0.5 - lump) * 0.14;

  // loose fibres pulled out of the weave
  float fzRnd;
  float fuzz = obFuzz(uv, 90.0, 0.055, uSeed + 7.0, fzRnd);
  h += fuzz * 0.10;

  h0 = vec4(clamp(h, 0.0, 1.0), cl.y, cl.z, lump);
  h1 = vec4(fuzz, fzRnd, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float par = h0.y, rnd = h0.z;
  float fuzz = h1.x;

  vec3 jute  = obRGB(158, 132,  88);
  vec3 dusty = obRGB(178, 160, 124);
  vec3 wet   = obRGB( 96,  80,  56);

  float damp = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(dusty, jute, obSat(damp * 1.1));
  col = mix(col, wet, obSat(damp * 1.7 - 0.9) * 0.7);
  col *= mix(0.92, 1.08, par);
  col *= mix(0.86, 1.14, rnd);

  float grime = obSat(d.cavity * 1.7 + (1.0 - d.ao) * 1.3);
  col = mix(col, obRGB(72, 60, 42), grime * 0.5);
  // dust caked onto the top faces
  col = mix(col, obRGB(190, 176, 144), obSat(d.curv) * 0.3);
  col = mix(col, dusty * 1.1, fuzz * 0.5);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.95 + grime * 0.04 - fuzz * 0.05, 0.7, 1.0);
}`,
  },
};

/* -------------------------------------------------------------- carpet --- */

const carpet: MaterialArchetype = {
  id: 'carpet',
  label: 'Office carpet',
  surface: 'carpet',
  detail: 'fibre',
  shader: { pom: false, detailScale: 34 },
  recipe: {
    id: 'carpet',
    seed: 311,
    size: 512,
    geometry: { tile: 1.0, depth: 0.005 },
    normalGain: 1.5,
    normalWide: 0.3,
    aoRadius: 0.02,
    aoAlbedo: 0.5,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // loop pile: dense tufts on a grid, each one a rounded loop
  vec3 w = obWorleyP(uv * 260.0, vec2(260.0), 0.85, uSeed);
  float tuft = smoothstep(0.42, 0.05, w.x);
  float h = 0.42 + tuft * 0.40 * mix(0.7, 1.15, w.z);

  // pile direction / crush marks
  float crush = obFbm(uv * 4.0, vec2(4.0), 4, 0.55, uSeed + 3.0);
  h -= smoothstep(0.55, 0.85, crush) * 0.14;

  // carpet-tile seams
  float seam = smoothstep(0.012, 0.004, min(abs(fract(uv.x * 2.0) - 0.5), abs(fract(uv.y * 2.0) - 0.5)));
  h -= seam * 0.16;

  h0 = vec4(clamp(h, 0.0, 1.0), tuft, w.z, crush);
  h1 = vec4(seam, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float tuft = h0.y, id = h0.z, crush = h0.w, seam = h1.x;

  vec3 base = obRGB( 74,  76,  80);
  vec3 fleck1 = obRGB(112, 114, 118);
  vec3 fleck2 = obRGB( 48,  50,  56);
  vec3 fleck3 = obRGB( 92,  84,  70);

  vec3 col = base;
  col = mix(col, fleck1, step(0.62, id) * 0.85);
  col = mix(col, fleck2, step(0.82, id) * 0.85);
  col = mix(col, fleck3, step(0.93, id) * 0.85);
  col *= mix(0.82, 1.12, tuft);

  float traffic = smoothstep(0.5, 0.85, crush);
  col = mix(col, col * 0.78, traffic * 0.6);
  float stain = obSplatter(uv, 5.0, 0.20, uSeed + 61.0);
  col = mix(col, obRGB(52, 46, 40), stain * 0.45);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.1);
  col = mix(col, obRGB(44, 42, 40), grime * 0.4);
  col = mix(col, obRGB(36, 36, 38), seam * 0.5);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.94 - traffic * 0.08, 0.7, 1.0);
}`,
  },
};

/* ----------------------------------------------------------- cardboard --- */

const cardboard: MaterialArchetype = {
  id: 'cardboard',
  label: 'Corrugated cardboard',
  surface: 'cardboard',
  detail: 'fibre',
  shader: { pom: false, detailScale: 28 },
  recipe: {
    id: 'cardboard',
    seed: 313,
    size: 512,
    geometry: { tile: 0.8, depth: 0.004 },
    normalGain: 1.4,
    aoRadius: 0.02,
    aoAlbedo: 0.4,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // the liner is mostly flat but telegraphs the flutes underneath
  float flute = 0.5 - 0.5 * cos(fract(uv.x * 150.0) * OB_TAU);
  float h = 0.62 + flute * 0.10;
  h += (obFbm(uv * 60.0, vec2(60.0), 3, 0.5, uSeed) - 0.5) * 0.08;

  // crushed corner exposing the fluting
  float crush = smoothstep(0.62, 0.9, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 3.0));
  h -= crush * 0.24;
  h += crush * flute * 0.30;

  // torn edge and tape
  float tear = obScratches(uv, 8.0, 0.0, 14.0, 0.35, uSeed + 5.0);
  h -= tear * 0.20;
  float tape = smoothstep(0.075, 0.055, abs(uv.y - 0.5));
  h += tape * 0.06;

  // printed stencil block
  vec2 sp = (uv - vec2(0.14, 0.62)) * vec2(2.6, 7.0);
  float box = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
  float print = box * step(0.5, obValueP(vec2(sp.x * 16.0, sp.y * 3.0), vec2(16.0, 3.0), uSeed + 7.0));

  h0 = vec4(clamp(h, 0.0, 1.0), crush, flute, tape);
  h1 = vec4(tear, print, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crush = h0.y, tape = h0.w;
  float tear = h1.x, print = h1.y;

  vec3 kraft = obRGB(174, 142, 100);
  vec3 pale  = obRGB(196, 170, 130);
  vec3 damp  = obRGB(122,  96,  66);

  float fib = obFbm(uv * 90.0, vec2(90.0), 4, 0.5, uSeed + 61.0);
  vec3 col = mix(kraft, pale, fib * 0.8);
  col = mix(col, damp, smoothstep(0.55, 0.85, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 67.0)) * 0.55);
  col = mix(col, obRGB(150, 118, 80), crush * 0.4);
  col = mix(col, obRGB(208, 190, 158), tear * 0.6);

  col = mix(col, obRGB(58, 54, 50), print * 0.75);
  col = mix(col, obRGB(198, 192, 180), tape * 0.55);

  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(88, 74, 56), grime * 0.35);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.92 - tape * 0.35 - print * 0.05, 0.35, 1.0);
}`,
  },
};

/* -------------------------------------------------------------- rubber --- */

const rubber: MaterialArchetype = {
  id: 'rubber',
  label: 'Rubber matting',
  surface: 'rubber',
  detail: 'micro',
  shader: { pom: true, pomShadow: true, pomDepth: 0.005, detailScale: 30 },
  recipe: {
    id: 'rubber',
    seed: 317,
    size: 512,
    geometry: { tile: 0.9, depth: 0.008 },
    normalGain: 1.2,
    aoRadius: 0.03,
    aoAlbedo: 0.35,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // studded anti-slip matting
  vec2 p = uv * 34.0;
  vec2 f = fract(p) - 0.5;
  float stud = smoothstep(0.34, 0.24, length(f));
  float h = 0.36 + stud * 0.52;

  // moulding flash + wear
  h += (obFbm(uv * 120.0, vec2(120.0), 3, 0.5, uSeed) - 0.5) * 0.06;
  float worn = smoothstep(0.45, 0.8, obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 3.0));
  h -= stud * worn * 0.24;

  float cut = obScratches(uv, 14.0, 2.0, 24.0, 0.30, uSeed + 5.0);
  h -= cut * 0.16;

  h0 = vec4(clamp(h, 0.0, 1.0), stud, worn, cut);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float stud = h0.y, worn = h0.z, cut = h0.w;

  vec3 black = obRGB(38, 38, 40);
  vec3 grey  = obRGB(72, 72, 76);
  vec3 bloom = obRGB(112, 110, 106);   // antiozonant bloom

  vec3 col = mix(black, grey, obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 61.0) * 0.7);
  col = mix(col, bloom, obSat(d.curv * 0.9) * 0.35);
  col = mix(col, grey * 1.2, worn * stud * 0.5);
  col = mix(col, obRGB(58, 56, 54), cut * 0.6);

  float dust = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.2);
  col = mix(col, obRGB(78, 72, 62), dust * 0.35);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.82 - worn * stud * 0.28 + dust * 0.1, 0.30, 1.0);
}`,
  },
};

/* ------------------------------------------------------------- plastic --- */

const plastic: MaterialArchetype = {
  id: 'plastic',
  label: 'Scuffed ABS plastic',
  surface: 'plastic',
  detail: 'micro',
  shader: { pom: false, detailScale: 40 },
  recipe: {
    id: 'plastic',
    seed: 331,
    size: 512,
    geometry: { tile: 0.6, depth: 0.0015 },
    normalGain: 2.0,
    normalWide: 0.2,
    aoRadius: 0.015,
    aoStrength: 0.6,
    aoAlbedo: 0.2,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // spark-eroded mould texture: fine isotropic pebbling
  float pebble = obWorleyFbm(uv * 190.0, vec2(190.0), 3, 1.0, uSeed);
  float h = 0.62 + (pebble - 0.5) * 0.35;

  // parting line and ejector-pin circles
  float part = smoothstep(0.006, 0.002, abs(uv.y - 0.5));
  h += part * 0.10;
  vec2 ep = fract(uv * vec2(3.0, 2.0)) - 0.5;
  float pin = smoothstep(0.20, 0.16, length(ep));
  h -= pin * 0.05;

  float scuff = obScratches(uv, 22.0, 2.0, 26.0, 0.35, uSeed + 3.0);
  float scuff2 = obScratches(uv, 16.0, 5.0, 30.0, 0.25, uSeed + 5.0);
  h -= (scuff + scuff2 * 0.7) * 0.22;

  h0 = vec4(clamp(h, 0.0, 1.0), scuff + scuff2, pebble, part);
  h1 = vec4(pin, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float scuff = h0.y, part = h0.w;

  vec3 body = obRGB(56, 58, 62);
  body = mix(body, obRGB(74, 76, 80), obFbm(uv * 7.0, vec2(7.0), 4, 0.5, uSeed + 61.0) * 0.6);

  // scuffs stress-whiten the polymer
  vec3 col = mix(body, obRGB(146, 148, 152), obSat(scuff) * 0.55);
  col = mix(col, obRGB(96, 98, 102), part * 0.4);
  float dust = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(92, 88, 80), dust * 0.3);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.42 + obSat(scuff) * 0.30 + dust * 0.12, 0.20, 0.95);
}`,
  },
};

/* -------------------------------------------------------- ballistic nylon */

const armor: MaterialArchetype = {
  id: 'armor',
  label: 'Ballistic nylon',
  surface: 'armor',
  detail: 'fibre',
  shader: { pom: false, detailScale: 34 },
  recipe: {
    id: 'armor',
    seed: 337,
    size: 512,
    geometry: { tile: 0.5, depth: 0.003 },
    normalGain: 1.6,
    normalWide: 0.3,
    aoRadius: 0.02,
    aoAlbedo: 0.45,
    common: CLOTH_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // 1000D Cordura: a basket weave of flat, wide fibre bundles
  vec2 p = uv * 150.0;
  vec2 f = fract(p);
  vec2 i = floor(p);
  float par = mod(floor(i.x * 0.5) + floor(i.y * 0.5), 2.0);
  float warp = pow(sin(f.x * OB_PI), 0.45);
  float weft = pow(sin(f.y * OB_PI), 0.45);
  float h = 0.42 + (par > 0.5 ? warp * 0.40 + weft * 0.12 : weft * 0.40 + warp * 0.12);

  // PALS webbing rows stitched on
  float row = smoothstep(0.055, 0.030, abs(fract(uv.y * 5.0) - 0.5));
  h += row * 0.22;
  float stitch = step(0.55, fract(uv.x * 60.0)) * row;
  h += stitch * 0.06;

  h += (obFbm(uv * 6.0, vec2(6.0), 4, 0.55, uSeed) - 0.5) * 0.12;   // drape

  float scuff = obScratches(uv, 18.0, 2.0, 18.0, 0.3, uSeed + 3.0);
  h -= scuff * 0.08;

  h0 = vec4(clamp(h, 0.0, 1.0), par, row, scuff);
  h1 = vec4(stitch, obHash13(vec3(mod(i, vec2(150.0)), uSeed)), 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float par = h0.y, row = h0.z, scuff = h0.w;
  float stitch = h1.x, rnd = h1.y;

  vec3 coyote = obRGB(104,  90,  66);
  vec3 ranger = obRGB( 82,  80,  62);
  vec3 dark   = obRGB( 48,  46,  38);

  vec3 col = mix(coyote, ranger, obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 61.0) * 0.8);
  col *= mix(0.90, 1.08, par);
  col *= mix(0.92, 1.08, rnd);
  col = mix(col, dark, obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.2) * 0.5);
  col = mix(col, coyote * 1.2, obSat(d.curv) * 0.25);
  col = mix(col, obRGB(132, 118, 92), stitch * 0.5);

  float dust = obSplatter(uv, 6.0, 0.30, uSeed + 71.0);
  col = mix(col, obRGB(140, 126, 100), dust * 0.28);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.88 - scuff * 0.10 + row * 0.02, 0.6, 1.0);
}`,
  },
};

/* -------------------------------------------------------- helmet shell --- */

const helmet: MaterialArchetype = {
  id: 'helmet',
  label: 'Composite helmet shell',
  surface: 'helmet',
  detail: 'micro',
  shader: { pom: false, detailScale: 36 },
  recipe: {
    id: 'helmet',
    seed: 347,
    size: 512,
    geometry: { tile: 0.45, depth: 0.0018 },
    normalGain: 1.8,
    normalWide: 0.25,
    aoRadius: 0.015,
    aoStrength: 0.7,
    aoAlbedo: 0.25,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // aramid layup showing faintly through the paint
  vec2 p = uv * 180.0;
  vec2 f = fract(p);
  float par = mod(floor(p.x) + floor(p.y), 2.0);
  float layup = par > 0.5 ? sin(f.x * OB_PI) : sin(f.y * OB_PI);
  float h = 0.60 + layup * 0.10;

  // textured paint: coarse anti-glare grit
  float grit = obWorleyFbm(uv * 220.0, vec2(220.0), 3, 1.0, uSeed);
  h += (grit - 0.5) * 0.30;

  float chip = obSplatter(uv, 16.0, 0.10, uSeed + 3.0);
  h -= chip * 0.30;
  float scuff = obScratches(uv, 20.0, 3.0, 26.0, 0.30, uSeed + 5.0);
  h -= scuff * 0.14;

  h0 = vec4(clamp(h, 0.0, 1.0), chip, grit, scuff);
  h1 = vec4(layup, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float chip = h0.y, grit = h0.z, scuff = h0.w;

  vec3 paint = obRGB(72, 76, 66);
  paint = mix(paint, obRGB(92, 94, 82), obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 61.0) * 0.6);
  vec3 aramid = obRGB(148, 128,  76);

  float edge = obSat(d.curv);
  vec3 col = mix(paint, aramid, obSat(chip + edge * 0.3) * 0.7);
  col = mix(col, paint * 1.25, scuff * 0.4);
  col = mix(col, paint * 0.72, obSat(d.cavity * 1.4 + (1.0 - d.ao)) * 0.35);
  col *= mix(0.94, 1.06, grit);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.80 - edge * 0.14 + chip * 0.10, 0.35, 1.0);
}`,
  },
};

export const SOFT_ARCHETYPES: MaterialArchetype[] = [
  fabric, sandbag, carpet, cardboard, rubber, plastic, armor, helmet,
];
