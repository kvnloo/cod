/**
 * Metal archetypes: painted-and-rusted steel plate, corrugated galvanised
 * sheet, diamond tread plate, brushed aluminium, walkway grating and painted
 * pipework.
 *
 * The thing that makes procedural metal convincing is *layering*: bare steel
 * underneath, an oxide film on top of it, then paint on top of that — and the
 * paint fails first at convex edges, the rust blooms from the pits, and both
 * run downhill. All three layers here are driven from the same height field.
 */

import type { MaterialArchetype } from '../types';

/** Shared rust palette + a helper that layers oxide over bare steel. */
const RUST_COMMON = /* glsl */ `
vec3 obSteel() { return obRGB(108, 112, 118); }

/** Oxide colour ramp: fresh orange → dark scale → black pitting. */
vec3 obRustRamp(float t) {
  vec3 a = obRGB(178, 104, 46);
  vec3 b = obRGB(126, 62, 30);
  vec3 c = obRGB(78, 44, 30);
  vec3 d = obRGB(46, 30, 24);
  vec3 col = mix(a, b, obSat(t * 2.0));
  col = mix(col, c, obSat(t * 2.0 - 1.0));
  return mix(col, d, obSat(t * 3.0 - 2.0));
}
`;

/* ------------------------------------------------- painted rusted steel -- */

const steelPainted: MaterialArchetype = {
  id: 'metal',
  label: 'Painted steel, rusted',
  surface: 'metal',
  detail: 'metal',
  shader: { pom: false, detailScale: 20 },
  recipe: {
    id: 'metal',
    seed: 101,
    size: 1024,
    geometry: { tile: 2.0, depth: 0.008 },
    normalGain: 1.4,
    aoRadius: 0.028,
    aoAlbedo: 0.35,
    common: RUST_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // rolled plate: broad, gentle oil-canning
  float h = 0.60 + (obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed) - 0.5) * 0.16;

  // panel joints and a lapped weld bead
  ObCell p = obPanels(uv, vec2(2.0, 2.0), 3, uSeed + 3.0);
  vec2 dv = min(p.local, 1.0 - p.local) * p.size;
  float dm = min(dv.x, dv.y);
  float joint = smoothstep(0.010, 0.002, dm);
  float bead = smoothstep(0.020, 0.010, dm) * (1.0 - joint);
  h -= joint * 0.22;
  h += bead * 0.06 * (0.6 + 0.8 * obValueP(uv * 90.0, vec2(90.0), uSeed + 5.0));

  // rivet line along the joints
  vec2 rp = uv * vec2(24.0, 24.0);
  vec2 rf = fract(rp) - 0.5;
  float rivet = smoothstep(0.30, 0.14, length(rf)) * smoothstep(0.016, 0.005, dm);
  h += rivet * 0.20;

  // impact dents
  vec3 dn = obWorleyP(uv * 9.0, vec2(9.0), 1.0, uSeed + 11.0);
  float dent = smoothstep(0.34, 0.0, dn.x) * step(0.72, dn.z);
  h -= dent * 0.16;

  // rust blooms: they eat into the plate and are lumpy
  float rustN = obFbm(obWarp(uv * 5.0, vec2(5.0), 0.55, uSeed + 17.0), vec2(5.0), 5, 0.55, uSeed + 19.0);
  float rust = obSat(smoothstep(0.46, 0.72, rustN) + obStreaks(uv, 18.0, 0.55, uSeed + 23.0) * 0.6);
  float scale = obWorleyFbm(uv * 240.0, vec2(240.0), 3, 1.0, uSeed + 29.0);
  h += rust * (scale - 0.45) * 0.16;
  vec3 pit = obWorleyP(uv * 420.0, vec2(420.0), 1.0, uSeed + 31.0);
  h -= smoothstep(0.26, 0.0, pit.x) * step(0.52, pit.z) * rust * 0.20;

  // paint chips: the paint film sits proud, so its edge is a real step
  float chipN = obFbm(obWarp(uv * 12.0, vec2(12.0), 0.55, uSeed + 38.0), vec2(12.0), 6, 0.55, uSeed + 37.0);
  chipN = mix(chipN, obFbm(uv * 48.0, vec2(48.0), 3, 0.5, uSeed + 39.0), 0.22);
  float paint = smoothstep(0.56, 0.44, chipN);
  paint = obSat(paint - rust * 1.4);
  paint *= 1.0 - obScratches(uv, 18.0, 1.0, 18.0, 0.5, uSeed + 41.0) * 0.9;
  paint = smoothstep(0.20, 0.62, paint);
  h += paint * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), rust, paint, joint);
  h1 = vec4(rivet, dent, scale, bead);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float rust = h0.y;
  float paint = h0.z;
  float joint = h0.w;
  float scale = h1.z;

  // paint fails on convex edges first
  float edge = obSat(d.curv * 1.4);
  paint = smoothstep(0.15, 0.55, obSat(paint - edge * 0.55));

  vec3 paintCol = obRGB(56, 70, 62);                       // faded industrial green
  paintCol = mix(paintCol, obRGB(78, 92, 84), obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 61.0) * 0.7);
  float chalk = obSat(1.0 - d.cavity) * obFbm(uv * 9.0, vec2(9.0), 3, 0.5, uSeed + 67.0);
  paintCol = mix(paintCol, paintCol * 1.28 + 0.03, chalk * 0.4);

  vec3 steel = obSteel() * mix(0.78, 1.05, obValueP(uv * 300.0, vec2(300.0), uSeed + 7.0));
  vec3 rustCol = obRustRamp(obSat(scale * 0.8 + obFbm(uv * 24.0, vec2(24.0), 4, 0.5, uSeed + 71.0) * 0.5));

  float rustAmt = obSat(rust * 1.15 + edge * 0.25 * (1.0 - paint));
  vec3 col = mix(steel, paintCol, paint);
  col = mix(col, rustCol, rustAmt * (1.0 - paint * 0.55));

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(48, 44, 38), grime * 0.45);
  col = mix(col, obRGB(38, 36, 34), joint * 0.5);

  float scratch = obScratches(uv, 26.0, 3.0, 26.0, 0.4, uSeed + 83.0);
  col = mix(col, steel * 1.15, scratch * (1.0 - rustAmt) * 0.5);

  o.albedo = col;
  // bare + scratched steel is metallic; paint and rust are not
  o.metal = obSat((1.0 - paint) * (1.0 - rustAmt) + scratch * 0.5 * (1.0 - rustAmt));
  float rough = mix(0.60, 0.88, rustAmt);
  rough = mix(rough, 0.74, paint);
  rough = mix(rough, 0.38, scratch * (1.0 - rustAmt) * 0.8);
  rough += grime * 0.12;
  o.rough = clamp(rough, 0.12, 1.0);
}`,
  },
};

/* ---------------------------------------------------- corrugated sheet -- */

const corrugated: MaterialArchetype = {
  id: 'metalThin',
  label: 'Corrugated galvanised',
  surface: 'metalThin',
  detail: 'metal',
  shader: { pom: true, pomShadow: true, pomDepth: 0.03, detailScale: 18 },
  recipe: {
    id: 'metalThin',
    seed: 113,
    size: 1024,
    geometry: { tile: 2.4, depth: 0.05 },
    normalGain: 0.8,
    normalWide: 0.55,
    aoRadius: 0.05,
    aoAlbedo: 0.4,
    common: RUST_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float rib = obCorrugate(uv.x, 7.0, 0.22);
  float h = 0.30 + rib * 0.62;

  // sheet buckle and dents
  h += (obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed) - 0.5) * 0.10;
  vec3 dn = obWorleyP(uv * 7.0, vec2(7.0), 1.0, uSeed + 11.0);
  float dent = smoothstep(0.30, 0.0, dn.x) * step(0.70, dn.z);
  h -= dent * 0.16;

  // fixing screws on the rib crowns
  vec2 sp = uv * vec2(7.0, 6.0);
  vec2 sf = fract(sp + vec2(0.5, 0.0)) - 0.5;
  float screw = smoothstep(0.22, 0.08, length(sf * vec2(1.0, 1.0))) * smoothstep(0.55, 0.85, rib);
  h -= screw * 0.10;

  // rust perforation along the bottom edge and around the screws
  float wet = obSat(1.0 - uv.y * 1.6) + screw * 0.8;
  float rustN = obFbm(obWarp(uv * 6.0, vec2(6.0), 0.6, uSeed + 17.0), vec2(6.0), 5, 0.55, uSeed + 19.0);
  float rust = obSat(smoothstep(0.52, 0.74, rustN + wet * 0.35));
  float scale = obWorleyFbm(uv * 260.0, vec2(260.0), 3, 1.0, uSeed + 29.0);
  h += rust * (scale - 0.5) * 0.12;
  float hole = obSplatter(uv, 14.0, 0.09, uSeed + 31.0) * smoothstep(0.55, 0.95, rust);
  h -= hole * 0.6;

  h0 = vec4(clamp(h, 0.0, 1.0), rust, rib, screw);
  h1 = vec4(scale, hole, dent, wet);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float rust = h0.y, rib = h0.z, screw = h0.w;
  float scale = h1.x, hole = h1.y;

  // spangled hot-dip galvanising: big crystalline grains
  vec3 zinc = obRGB(168, 174, 178);
  vec3 spangle = obWorleyP(uv * 26.0, vec2(26.0), 1.0, uSeed + 41.0).zzz;
  zinc *= mix(0.82, 1.14, spangle.x);
  zinc = mix(zinc, obRGB(140, 148, 152), obFbm(uv * 40.0, vec2(40.0), 4, 0.5, uSeed + 43.0) * 0.5);

  vec3 rustCol = obRustRamp(obSat(scale * 0.8 + obFbm(uv * 30.0, vec2(30.0), 4, 0.5, uSeed + 47.0) * 0.5));
  vec3 col = mix(zinc, rustCol, obSat(rust * 1.1));
  col = mix(col, obRGB(28, 22, 18), hole * 0.9);

  // rust bleed streaks running down from the screws
  float bleed = obStreaks(uv, 20.0, 0.45, uSeed + 53.0);
  col = mix(col, obRustRamp(0.25), bleed * 0.4 * obSat(rust + 0.3));

  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 0.9);
  col = mix(col, obRGB(52, 50, 46), grime * 0.4);
  col = mix(col, obRGB(64, 62, 58), screw * 0.4);

  o.albedo = col;
  o.metal = obSat((1.0 - rust) * 0.95 + 0.05);
  float rough = mix(0.34, 0.88, obSat(rust * 1.2));
  rough += grime * 0.12 - rib * 0.03;
  o.rough = clamp(rough, 0.16, 1.0);
  o.ao = 1.0 - hole * 0.5;
}`,
  },
};

/* -------------------------------------------------------- diamond plate -- */

const diamondPlate: MaterialArchetype = {
  id: 'diamondPlate',
  label: 'Diamond tread plate',
  surface: 'metal',
  detail: 'metal',
  shader: { pom: true, pomShadow: true, pomDepth: 0.004, detailScale: 22 },
  recipe: {
    id: 'diamondPlate',
    seed: 127,
    size: 1024,
    geometry: { tile: 1.2, depth: 0.006 },
    normalGain: 1.0,
    normalWide: 0.4,
    aoRadius: 0.028,
    aoAlbedo: 0.4,
    common: RUST_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float tread = obDiamondPlate(uv, 15.0, uSeed);
  float h = 0.42 + tread * 0.50;
  h += (obFbm(uv * 60.0, vec2(60.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.05;
  h += (obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 7.0) - 0.5) * 0.08;

  // traffic wear flattens the treads in a path across the plate
  float path = obFbm(uv * vec2(2.0, 3.0), vec2(2.0, 3.0), 4, 0.55, uSeed + 11.0);
  float worn = smoothstep(0.42, 0.72, path);
  h -= tread * worn * 0.22;

  float rustN = obFbm(uv * 7.0, vec2(7.0), 4, 0.5, uSeed + 17.0);
  float rust = obSat(smoothstep(0.58, 0.80, rustN) * (1.0 - worn * 0.7));
  vec3 pit = obWorleyP(uv * 400.0, vec2(400.0), 1.0, uSeed + 23.0);
  h -= smoothstep(0.24, 0.0, pit.x) * step(0.6, pit.z) * rust * 0.20;

  h0 = vec4(clamp(h, 0.0, 1.0), rust, tread, worn);
  h1 = vec4(path, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float rust = h0.y, tread = h0.z, worn = h0.w;

  vec3 steel = obSteel() * mix(0.78, 1.06, obValueP(uv * 340.0, vec2(340.0), uSeed + 5.0));
  vec3 polish = obRGB(196, 198, 202);
  vec3 rustCol = obRustRamp(obSat(obFbm(uv * 34.0, vec2(34.0), 4, 0.5, uSeed + 31.0)));

  float edge = obSat(d.curv);
  vec3 col = steel;
  col = mix(col, polish, obSat(worn * tread + edge * 0.5) * 0.55);
  col = mix(col, rustCol, rust * 0.85);

  float grime = obSat(d.cavity * 1.8 + (1.0 - d.ao) * 1.2);
  col = mix(col, obRGB(40, 38, 34), grime * 0.55);

  float scratch = obScratches(uv, 30.0, 2.0, 30.0, 0.45, uSeed + 41.0);
  col = mix(col, polish, scratch * (1.0 - rust) * 0.5);

  o.albedo = col;
  o.metal = obSat(1.0 - rust * 0.85);
  float rough = mix(0.58, 0.30, obSat(worn * tread + edge * 0.4));
  rough = mix(rough, 0.85, rust);
  rough += grime * 0.15;
  rough -= scratch * 0.12;
  o.rough = clamp(rough, 0.10, 1.0);
}`,
  },
};

/* ---------------------------------------------------- brushed aluminium -- */

const brushedAluminium: MaterialArchetype = {
  id: 'aluminium',
  label: 'Brushed aluminium',
  surface: 'metal',
  detail: 'metal',
  shader: { pom: false, detailScale: 40 },
  recipe: {
    id: 'aluminium',
    seed: 131,
    size: 1024,
    geometry: { tile: 1.0, depth: 0.0016 },
    normalGain: 2.2,
    normalWide: 0.15,
    aoRadius: 0.012,
    aoStrength: 0.5,
    aoAlbedo: 0.15,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // brushing runs along X: high frequency across, low along
  float brush = obBrushed(uv, 8.0, 1400.0, uSeed);
  float h = 0.55 + (brush - 0.5) * 0.55;

  // panel edge chamfer + fixing holes
  vec2 dv = min(uv, 1.0 - uv);
  float dm = min(dv.x, dv.y);
  h += smoothstep(0.02, 0.05, dm) * 0.06;

  float scratch = obScratches(uv, 14.0, 0.0, 24.0, 0.35, uSeed + 7.0);
  float scratch2 = obScratches(uv, 9.0, 5.0, 30.0, 0.25, uSeed + 11.0);
  h -= (scratch + scratch2 * 0.7) * 0.30;

  vec3 dn = obWorleyP(uv * 14.0, vec2(14.0), 1.0, uSeed + 13.0);
  float dent = smoothstep(0.20, 0.0, dn.x) * step(0.86, dn.z);
  h -= dent * 0.20;

  h0 = vec4(clamp(h, 0.0, 1.0), scratch + scratch2, brush, dent);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float scratch = h0.y, brush = h0.z;

  vec3 al = obRGB(196, 198, 200);
  al *= mix(0.90, 1.06, brush);
  al = mix(al, obRGB(172, 176, 182), obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 61.0) * 0.5);

  // oxide haze and fingerprints in the corners
  float haze = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 0.8);
  vec3 col = mix(al, obRGB(150, 152, 154), haze * 0.35);
  col = mix(col, obRGB(214, 216, 218), scratch * 0.5);

  o.albedo = col;
  o.metal = 1.0;
  float rough = 0.40 + (1.0 - brush) * 0.16 + haze * 0.18;
  rough += scratch * 0.18;
  o.rough = clamp(rough, 0.22, 0.85);
}`,
  },
};

/* ---------------------------------------------------------------- grate -- */

const grate: MaterialArchetype = {
  id: 'grate',
  label: 'Walkway grating',
  surface: 'grate',
  detail: 'metal',
  doubleSided: true,
  shader: { pom: false, alphaFromMap: true, detailScale: 18 },
  recipe: {
    id: 'grate',
    seed: 137,
    size: 1024,
    geometry: { tile: 1.0, depth: 0.012 },
    normalGain: 1.0,
    aoRadius: 0.03,
    aoAlbedo: 0.4,
    common: RUST_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // load bars every 1/8, cross rods every 1/4 — the classic bar grating
  float bx = abs(fract(uv.x * 24.0) - 0.5) * 2.0;
  float by = abs(fract(uv.y * 10.0 + 0.5) - 0.5) * 2.0;
  float bar = smoothstep(0.44, 0.28, bx);
  float rod = smoothstep(0.34, 0.20, by);
  float solid = max(bar, rod * 0.9);

  float h = 0.10 + bar * 0.75 + rod * 0.30;
  h += (obFbm(uv * 70.0, vec2(70.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.05 * solid;

  float rustN = obFbm(uv * 8.0, vec2(8.0), 4, 0.5, uSeed + 11.0);
  float rust = obSat(smoothstep(0.48, 0.74, rustN));
  h -= obSplatter(uv, 20.0, 0.14, uSeed + 13.0) * rust * 0.20 * solid;

  h0 = vec4(clamp(h, 0.0, 1.0), rust, solid, bar);
  h1 = vec4(rod, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float rust = h0.y, solid = h0.z, bar = h0.w;

  vec3 steel = obSteel() * 0.82 * mix(0.82, 1.08, obValueP(uv * 260.0, vec2(260.0), uSeed + 5.0));
  vec3 rustCol = obRustRamp(obSat(obFbm(uv * 28.0, vec2(28.0), 4, 0.5, uSeed + 17.0)));

  float edge = obSat(d.curv);
  vec3 col = mix(steel, rustCol, rust * 0.9);
  col = mix(col, obRGB(198, 200, 204), edge * (1.0 - rust) * 0.5);   // polished tread edges

  float grime = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.2);
  col = mix(col, obRGB(34, 32, 30), grime * 0.6);

  o.albedo = col;
  o.metal = obSat(1.0 - rust * 0.8);
  o.rough = clamp(mix(0.40, 0.88, rust) - edge * 0.14 + grime * 0.1, 0.14, 1.0);
  o.alpha = smoothstep(0.35, 0.60, solid);
  o.ao = mix(0.55, 1.0, obSat(bar + h1.x));
}`,
  },
};

/* ----------------------------------------------------------------- pipe -- */

const pipe: MaterialArchetype = {
  id: 'pipe',
  label: 'Painted pipework',
  surface: 'pipe',
  detail: 'metal',
  shader: { pom: false, detailScale: 26 },
  recipe: {
    id: 'pipe',
    seed: 139,
    size: 512,
    geometry: { tile: 1.0, depth: 0.006 },
    normalGain: 1.3,
    aoRadius: 0.03,
    aoAlbedo: 0.35,
    common: RUST_COMMON,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.62 + (obFbm(uv * 8.0, vec2(8.0), 4, 0.5, uSeed) - 0.5) * 0.10;

  // flange / clamp bands running around the pipe
  float band = smoothstep(0.055, 0.035, abs(fract(uv.y * 3.0) - 0.5));
  h += band * 0.22;
  vec2 bf = fract(uv * vec2(10.0, 3.0)) - 0.5;
  float bolt = smoothstep(0.26, 0.12, length(bf)) * band;
  h += bolt * 0.16;

  float rustN = obFbm(obWarp(uv * 6.0, vec2(6.0), 0.5, uSeed + 11.0), vec2(6.0), 4, 0.5, uSeed + 13.0);
  float rust = obSat(smoothstep(0.52, 0.76, rustN) + band * 0.35 * step(0.5, rustN));
  h += rust * (obWorleyFbm(uv * 260.0, vec2(260.0), 3, 1.0, uSeed + 17.0) - 0.5) * 0.12;

  float chip = obFbm(uv * 14.0, vec2(14.0), 4, 0.5, uSeed + 19.0);
  float paint = smoothstep(0.60, 0.46, chip);
  paint = smoothstep(0.18, 0.60, obSat(paint - rust * 1.4));
  h += paint * 0.05;

  h0 = vec4(clamp(h, 0.0, 1.0), rust, paint, band);
  h1 = vec4(bolt, 0.0, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float rust = h0.y, paint = h0.z, band = h0.w;
  float edge = obSat(d.curv * 1.3);
  paint = smoothstep(0.15, 0.55, obSat(paint - edge * 0.5));

  vec3 paintCol = obRGB(158, 142, 62);            // safety yellow, gone chalky
  paintCol = mix(paintCol, obRGB(120, 112, 74), obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 61.0) * 0.7);
  vec3 steel = obSteel() * 0.9;
  vec3 rustCol = obRustRamp(obSat(obFbm(uv * 30.0, vec2(30.0), 4, 0.5, uSeed + 67.0)));

  vec3 col = mix(steel, paintCol, paint);
  col = mix(col, rustCol, obSat(rust * 1.1) * (1.0 - paint * 0.5));
  col = mix(col, obRGB(70, 68, 64), band * 0.25);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(44, 40, 36), grime * 0.45);

  o.albedo = col;
  o.metal = obSat((1.0 - paint) * (1.0 - rust));
  o.rough = clamp(mix(0.44, 0.88, rust) * (1.0 - paint * 0.2) + paint * 0.12 + grime * 0.1, 0.14, 1.0);
}`,
  },
};

export const METAL_ARCHETYPES: MaterialArchetype[] = [
  steelPainted, corrugated, diamondPlate, brushedAluminium, grate, pipe,
];
