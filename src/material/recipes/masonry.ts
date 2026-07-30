/**
 * Masonry archetypes: concrete, asphalt, brick, stone, plaster, ceramic tile
 * and acoustic ceiling panel.
 *
 * Every recipe follows the same discipline that makes procedural surfaces read
 * as photoscanned rather than "noisy":
 *
 *   1. build a real height field first (layout + damage + micro relief),
 *   2. let the forge derive normal / AO / curvature from it,
 *   3. drive the albedo *from those* — grime lands where the AO is dark, wear
 *      lands where the curvature is convex, streaks obey gravity.
 *
 * Scale discipline matters as much as the noise: a 1K map over a 2 m tile has
 * 2 mm texels, so the base maps carry the 5 mm → 50 cm band and everything
 * finer is left to the shared runtime detail layer. Getting that split wrong is
 * what makes procedural surfaces look like foam or like plastic.
 */

import type { MaterialArchetype } from '../types';

/* ------------------------------------------------------------- concrete -- */

const concrete: MaterialArchetype = {
  id: 'concrete',
  label: 'Worn concrete',
  surface: 'concrete',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.008, detailScale: 26, triplanarSharpness: 6 },
  recipe: {
    id: 'concrete',
    seed: 11,
    size: 1024,
    geometry: { tile: 2.0, depth: 0.010 },
    normalGain: 1.5,
    normalWide: 0.4,
    aoRadius: 0.03,
    aoAlbedo: 0.4,
    curvature: 1.0,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Large-scale waviness left by the pour and the power float.
  float base = obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed);
  float h = 0.72 + (base - 0.5) * 0.10;

  // Trowel sweeps — shallow arcs about the size of a hand.
  vec2 sw = obWarp(uv * 6.0, vec2(6.0), 0.75, uSeed + 2.0);
  float swirl = obFbm(sw, vec2(6.0), 3, 0.5, uSeed + 3.0);
  h += (swirl - 0.5) * 0.07;

  // Sand fraction: right at the texel limit, tiny amplitude.
  float grain = obWorleyFbm(uv * 300.0, vec2(300.0), 2, 1.0, uSeed + 5.0);
  h += (0.5 - grain) * 0.06;

  // Entrained-air pinholes, 1-3 mm.
  vec3 wa = obWorleyP(uv * 240.0, vec2(240.0), 1.0, uSeed + 11.0);
  float pin = smoothstep(0.28, 0.04, wa.x) * step(0.58, wa.z);
  h -= pin * 0.13;

  // The occasional real blow hole, 6-10 mm.
  vec3 wb = obWorleyP(uv * 58.0, vec2(58.0), 1.0, uSeed + 21.0);
  float blow = smoothstep(0.12, 0.02, wb.x) * step(0.93, wb.z);
  h -= blow * 0.26;

  // A worn patch where the laitance is gone and the aggregate shows.
  float wearMask = smoothstep(0.56, 0.80, obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 31.0));
  vec3 ag = obWorleyP(uv * 120.0, vec2(120.0), 1.0, uSeed + 41.0);
  float agg = smoothstep(0.34, 0.08, ag.x) * step(0.52, ag.z) * wearMask;
  h += agg * 0.055;

  // Formwork board seams and tie-rod plugs.
  float seam = smoothstep(0.010, 0.0, abs(fract(uv.y * 2.0) - 0.5));
  vec2 tf = fract(uv * vec2(3.0, 2.0) + 0.5) - 0.5;
  float tie = smoothstep(0.050, 0.018, length(tf));
  h -= seam * 0.05 + tie * 0.09;

  // One or two structural cracks plus a faint crazing network.
  float crack = obCracks(uv, vec2(1.0), 3.0, 0.013, uSeed + 7.0);
  crack *= smoothstep(0.55, 0.80, obFbm(uv * 1.0, vec2(1.0), 3, 0.5, uSeed + 8.0));
  float hair  = obCracks(uv, vec2(1.0), 9.0, 0.005, uSeed + 9.0);
  hair *= smoothstep(0.60, 0.85, obFbm(uv * 2.0, vec2(2.0), 3, 0.5, uSeed + 10.0));
  h -= crack * 0.45 + hair * 0.10;

  // A spalled area where the skin has broken off.
  float spall = smoothstep(0.66, 0.84, obFbm(uv * 2.0, vec2(2.0), 4, 0.5, uSeed + 51.0));
  h -= spall * 0.14;
  h += spall * (grain - 0.5) * 0.10;

  h0 = vec4(clamp(h, 0.0, 1.0), pin + blow, ag.z, obSat(crack + hair * 0.5));
  h1 = vec4(agg, seam + tie, spall, base);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crack = h0.w;
  float agg = h1.x;
  float spall = h1.z;

  vec3 pale = obRGB(160, 158, 151);
  vec3 mid  = obRGB(120, 119, 114);
  vec3 dark = obRGB( 82,  81,  78);

  // Broad tonal patches. This is the single most important cue that a surface
  // was cast rather than generated: real concrete is never one value.
  float t1 = obFbm(uv * 2.0, vec2(2.0), 4, 0.6, uSeed + 61.0);
  float t2 = obFbm(uv * 7.0, vec2(7.0), 4, 0.5, uSeed + 71.0);
  vec3 col = mix(dark, pale, obSat(t1 * 1.5 - 0.25));
  col = mix(col, mid, obSat(t2 * 1.3 - 0.15) * 0.55);

  // Cement fines + exposed sand.
  float speck = obValueP(uv * 640.0, vec2(640.0), uSeed + 5.0);
  col *= mix(0.90, 1.10, speck);
  col = mix(col, obRGB(172, 164, 148) * mix(0.55, 1.20, h0.z), agg * 0.65);
  col = mix(col, obRGB(146, 143, 136), spall * 0.45);

  // Rain washing down the face, and the dirt line at the bottom.
  float streak = obStreaks(uv, 14.0, 0.75, uSeed + 91.0);
  col = mix(col, obRGB(70, 66, 58), streak * 0.40);
  float skirt = obSat(1.0 - uv.y * 2.4) * obFbm(uv * 5.0, vec2(5.0), 3, 0.5, uSeed + 95.0);
  col = mix(col, obRGB(62, 57, 48), skirt * 0.45);

  // Grime in every cavity the tracer found.
  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.3);
  grime *= mix(0.45, 1.4, obFbm(uv * 5.0, vec2(5.0), 3, 0.5, uSeed + 81.0));
  col = mix(col, obRGB(56, 51, 43), obSat(grime) * 0.6);

  col = mix(col, obRGB(44, 42, 39), crack * 0.8);

  // Efflorescence - pale salt bloom, mostly near the seams.
  float bloom = smoothstep(0.64, 0.86, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 101.0));
  col = mix(col, obRGB(184, 182, 176), bloom * 0.28);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.94 - agg * 0.05 + grime * 0.04 - obSat(d.curv) * 0.10;
  rough -= bloom * 0.04;
  o.rough = clamp(rough, 0.42, 1.0);
  o.ao = 1.0 - crack * 0.2;
}`,
  },
};

/* --------------------------------------------------------------- asphalt -- */

const asphalt: MaterialArchetype = {
  id: 'asphalt',
  label: 'Cracked asphalt',
  surface: 'asphalt',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.006, detailScale: 30 },
  recipe: {
    id: 'asphalt',
    seed: 23,
    size: 1024,
    geometry: { tile: 2.5, depth: 0.008 },
    normalGain: 1.6,
    normalWide: 0.35,
    aoRadius: 0.022,
    aoAlbedo: 0.45,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Aggregate bed: 6-10 mm chippings held in bitumen.
  vec3 stone = obWorleyP(uv * 200.0, vec2(200.0), 1.0, uSeed);
  float chip = smoothstep(0.44, 0.06, stone.x);
  float h = 0.56 + chip * 0.20 * mix(0.4, 1.0, stone.z);
  vec3 fines = obWorleyP(uv * 460.0, vec2(460.0), 1.0, uSeed + 3.0);
  h += smoothstep(0.40, 0.05, fines.x) * 0.05;
  h += (obFbm(uv * 5.0, vec2(5.0), 4, 0.55, uSeed + 13.0) - 0.5) * 0.16;

  // Ravelling - chippings plucked out by traffic.
  float ravel = obSplatter(uv, 26.0, 0.14, uSeed + 41.0);
  h -= ravel * 0.22;

  // Alligator cracking, gated so most of the tile is intact, plus one seam.
  float crack = obCracks(uv, vec2(1.0), 20.0, 0.014, uSeed + 7.0);
  crack *= smoothstep(0.52, 0.82, obFbm(uv * 2.0, vec2(2.0), 3, 0.5, uSeed + 17.0));
  float seam = obCracks(uv, vec2(1.0), 4.0, 0.016, uSeed + 27.0);
  seam *= smoothstep(0.60, 0.86, obFbm(uv * 1.0, vec2(1.0), 3, 0.5, uSeed + 29.0));
  h -= crack * 0.16 + seam * 0.14;

  // Tar poured over the seam: a raised, glossy, slightly domed ribbon.
  float tar = smoothstep(0.25, 0.70, seam);
  h += tar * 0.18;

  float line = 0.0;

  h0 = vec4(clamp(h, 0.0, 1.0), ravel, stone.z, obSat(crack + seam));
  h1 = vec4(tar, line, chip, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float tar = h1.x;
  float line = h1.y;
  float chip = h1.z;
  float crack = h0.w;

  vec3 fresh = obRGB(34, 34, 36);
  vec3 aged  = obRGB(92, 91, 88);

  // Sun-bleached in the open, still black where it is sheltered.
  float bleach = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 71.0);
  vec3 col = mix(fresh, aged, obSat(bleach * 1.35 - 0.15));

  // Exposed chippings: individual grey/tan stones.
  vec3 chipCol = mix(obRGB(120, 117, 112), obRGB(164, 156, 144), h0.z);
  chipCol = mix(chipCol, obRGB(108, 96, 88), step(0.84, h0.z));
  col = mix(col, chipCol, obSat(chip * 1.15) * obSat(bleach + 0.3) * 0.8);

  float speck = obValueP(uv * 620.0, vec2(620.0), uSeed + 5.0);
  col *= mix(0.90, 1.10, speck);

  col = mix(col, obRGB(24, 23, 24), tar * 0.92);
  col = mix(col, obRGB(22, 21, 20), crack * 0.75);

  // Road marking, worn thin over the aggregate crowns.
  float wear = obFbm(uv * 16.0, vec2(16.0), 4, 0.5, uSeed + 91.0);
  float paint = obSat(line * smoothstep(0.28, 0.60, wear + d.height * 0.4));
  col = mix(col, obRGB(212, 209, 196), paint);

  // Oil staining down the wheel path.
  float oil = obSplatter(uv, 5.0, 0.20, uSeed + 131.0);
  col = mix(col, col * vec3(0.40, 0.42, 0.46), oil * 0.65);

  float grime = obSat(d.cavity * 1.3 + (1.0 - d.ao) * 0.9);
  col = mix(col, obRGB(56, 52, 46), grime * 0.35);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.96 - chip * 0.10;
  rough = mix(rough, 0.28, tar * 0.85);
  rough = mix(rough, 0.82, paint);
  rough = mix(rough, 0.38, oil * 0.55);
  o.rough = clamp(rough, 0.20, 1.0);
  o.ao = 1.0 - crack * 0.2;
}`,
  },
};

/* ----------------------------------------------------------------- brick -- */

const brick: MaterialArchetype = {
  id: 'brick',
  label: 'Weathered brick',
  surface: 'brick',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.012, detailScale: 26 },
  recipe: {
    id: 'brick',
    seed: 37,
    size: 1024,
    geometry: { tile: 1.8, depth: 0.011 },
    normalGain: 1.05,
    normalWide: 0.45,
    aoRadius: 0.04,
    aoAlbedo: 0.55,
    common: /* glsl */ `
const vec2 BRICK_COUNT = vec2(8.0, 24.0);
`,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obBrick(uv, BRICK_COUNT, 0.5, 0.05, uSeed);

  // Distance to the joint, corrected so the mortar line is the same physical
  // width on both axes (bricks are three times wider than they are tall).
  vec2 dv = min(c.local, 1.0 - c.local);
  float dm = min(dv.x * 3.0, dv.y);
  float face = smoothstep(0.10, 0.24, dm);

  // Each brick sits a little proud and very slightly domed; some are set back.
  float proud = mix(0.68, 0.92, c.rnd.x);
  float dome = 1.0 - pow(max(abs(c.local.x - 0.5), abs(c.local.y - 0.5)) * 2.0, 6.0);
  float h = mix(0.24, proud, face) + dome * 0.02 * face;

  // Face texture: sandy extrusion drag marks and fine pocking.
  float grain = obFbm(uv * vec2(60.0, 180.0), vec2(60.0, 180.0), 4, 0.5, uSeed + 3.0);
  h += (grain - 0.5) * 0.05 * face;
  vec3 pk = obWorleyP(uv * 380.0, vec2(380.0), 1.0, uSeed + 17.0);
  h -= smoothstep(0.30, 0.02, pk.x) * step(0.62, pk.z) * 0.06 * face;

  // Spalled arrises on the older bricks.
  float chip = obSplatter(uv, 40.0, 0.18, uSeed + 29.0) * step(0.5, c.rnd.y);
  h -= chip * 0.18 * face;

  // Mortar: coarse, sandy, and crumbled out in places.
  float mortarN = obFbm(uv * 200.0, vec2(200.0), 4, 0.5, uSeed + 41.0);
  float crumble = obSplatter(uv, 24.0, 0.32, uSeed + 53.0);
  h += (1.0 - face) * ((mortarN - 0.5) * 0.10 - crumble * 0.16);

  h0 = vec4(clamp(h, 0.0, 1.0), 1.0 - face, c.rnd.x, face);
  h1 = vec4(c.rnd.y, c.rnd.z, chip, mortarN);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float face = h0.w;
  float r0 = h0.z, r1 = h1.x, r2 = h1.y;
  float chip = h1.z;
  float mortarN = h1.w;

  // A real wall is three or four clay batches mixed through each other, with a
  // wide value spread - that spread is what makes brickwork read as brickwork.
  vec3 clayA = obRGB(142,  66,  46);
  vec3 clayB = obRGB( 96,  46,  38);
  vec3 clayC = obRGB(172, 108,  76);
  vec3 clayD = obRGB( 72,  46,  42);
  vec3 clayE = obRGB(122,  84,  62);

  vec3 brickCol = mix(clayA, clayB, r1);
  brickCol = mix(brickCol, clayC, smoothstep(0.55, 0.90, r0));
  brickCol = mix(brickCol, clayD, smoothstep(0.70, 1.00, r2));
  brickCol = mix(brickCol, clayE, smoothstep(0.86, 1.00, r1));
  brickCol *= mix(0.72, 1.22, r2);

  // Within-brick mottling and flashed (over-fired) faces.
  float mott = obFbm(uv * vec2(50.0, 150.0), vec2(50.0, 150.0), 4, 0.55, uSeed + 61.0);
  brickCol *= mix(0.84, 1.14, mott);
  float flash = smoothstep(0.78, 1.0, r0) * smoothstep(0.35, 0.75, mott);
  brickCol = mix(brickCol, obRGB(60, 46, 46), flash * 0.6);

  brickCol = mix(brickCol, obRGB(178, 112, 82), chip * 0.65);

  vec3 mortarCol = mix(obRGB(112, 108, 99), obRGB(76, 72, 66), mortarN);
  float sand = obValueP(uv * 600.0, vec2(600.0), uSeed + 7.0);
  mortarCol *= mix(0.86, 1.14, sand);

  vec3 col = mix(mortarCol, brickCol, face);

  // Grime: heavier in the joints, and washing down from every course.
  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.35);
  float dirtN = obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 71.0);
  col = mix(col, obRGB(48, 43, 36), obSat(grime * mix(0.45, 1.4, dirtN)) * 0.55);

  float streak = obStreaks(uv, 22.0, 0.6, uSeed + 83.0);
  col = mix(col, obRGB(62, 55, 46), streak * 0.38);

  // Efflorescence and lichen, both of which follow the mortar.
  float salt = obSplatter(uv, 8.0, 0.18, uSeed + 97.0) * (1.0 - face * 0.65);
  col = mix(col, obRGB(190, 188, 180), salt * 0.35);
  float moss = obSat(d.cavity * 1.6) * obSplatter(uv, 5.0, 0.30, uSeed + 113.0);
  col = mix(col, obRGB(66, 74, 48), moss * 0.35);

  float edge = obSat(d.curv) * face;
  col = mix(col, col * 1.18, edge * 0.25);

  o.albedo = col;
  o.metal = 0.0;
  float rough = mix(0.97, 0.84, face);
  rough += mott * 0.04 - edge * 0.08;
  o.rough = clamp(rough, 0.45, 1.0);
}`,
  },
};

/* ----------------------------------------------------------------- stone -- */

const stone: MaterialArchetype = {
  id: 'stone',
  label: 'Cut stone block',
  surface: 'stone',
  detail: 'grit',
  shader: { pom: true, pomShadow: true, pomDepth: 0.016 },
  recipe: {
    id: 'stone',
    seed: 53,
    size: 1024,
    geometry: { tile: 2.4, depth: 0.022 },
    normalGain: 1.0,
    normalWide: 0.5,
    aoRadius: 0.045,
    aoAlbedo: 0.55,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obBrick(uv, vec2(4.0, 7.0), 0.5, 0.14, uSeed);
  vec2 dv = min(c.local, 1.0 - c.local);
  float dm = min(dv.x * 1.7, dv.y);
  float face = smoothstep(0.035, 0.09, dm);

  // Rough-hewn face: chisel facets from ridged noise, at hand scale.
  float facet = obRidged(uv * 22.0, vec2(22.0), 4, 0.5, uSeed + 11.0);
  float pocks = obWorleyFbm(uv * 90.0, vec2(90.0), 3, 1.0, uSeed + 23.0);
  float h = mix(0.20, mix(0.68, 0.94, c.rnd.x), face);
  h += (facet - 0.5) * 0.14 * face;
  h -= pocks * 0.07 * face;
  vec3 pit = obWorleyP(uv * 330.0, vec2(330.0), 1.0, uSeed + 27.0);
  h -= smoothstep(0.30, 0.03, pit.x) * step(0.55, pit.z) * 0.05 * face;

  float chip = obSplatter(uv, 22.0, 0.16, uSeed + 31.0);
  h -= chip * 0.20 * face;

  float mortarN = obFbm(uv * 160.0, vec2(160.0), 4, 0.5, uSeed + 43.0);
  h += (1.0 - face) * (mortarN - 0.5) * 0.10;

  h0 = vec4(clamp(h, 0.0, 1.0), 1.0 - face, c.rnd.x, face);
  h1 = vec4(facet, pocks, chip, c.rnd.y);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float face = h0.w;
  float facet = h1.x;

  vec3 lime  = obRGB(158, 153, 140);
  vec3 grey  = obRGB(112, 111, 106);
  vec3 warm  = obRGB(142, 130, 108);

  vec3 col = mix(grey, lime, obSat(h0.z * 0.85 + facet * 0.4));
  col = mix(col, warm, obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 61.0) * 0.5);

  float vein = obRidged(uv * 9.0, vec2(9.0), 4, 0.5, uSeed + 71.0);
  col = mix(col, obRGB(178, 174, 164), smoothstep(0.74, 0.96, vein) * 0.35 * face);

  float grain = obValueP(uv * 520.0, vec2(520.0), uSeed + 3.0);
  col *= mix(0.90, 1.10, grain);

  vec3 mortarCol = obRGB(128, 124, 114) * mix(0.85, 1.1, obValueP(uv * 400.0, vec2(400.0), uSeed + 9.0));
  col = mix(mortarCol, col, face);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.25);
  col = mix(col, obRGB(48, 46, 40), grime * 0.6);
  float moss = obSat(d.cavity * 1.8) * obSplatter(uv, 6.0, 0.34, uSeed + 101.0);
  col = mix(col, obRGB(62, 72, 46), moss * 0.45);
  float streak = obStreaks(uv, 16.0, 0.6, uSeed + 113.0);
  col = mix(col, obRGB(70, 66, 58), streak * 0.32);

  float edge = obSat(d.curv) * face;
  col = mix(col, col * 1.22, edge * 0.30);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(mix(0.96, 0.82, face) - edge * 0.12 + facet * 0.05, 0.42, 1.0);
}`,
  },
};

/* --------------------------------------------------------------- plaster -- */

const plaster: MaterialArchetype = {
  id: 'plaster',
  label: 'Stained plaster',
  surface: 'plaster',
  detail: 'micro',
  shader: { pom: false, detailScale: 34 },
  recipe: {
    id: 'plaster',
    seed: 67,
    size: 1024,
    geometry: { tile: 2.2, depth: 0.005 },
    normalGain: 2.0,
    normalWide: 0.4,
    aoRadius: 0.02,
    aoAlbedo: 0.3,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Trowel sweeps: long, low, overlapping arcs.
  vec2 w = obWarp(uv * 5.0, vec2(5.0), 0.6, uSeed);
  float trowel = obFbm(w * vec2(1.0, 2.0), vec2(5.0, 10.0), 4, 0.55, uSeed + 3.0);
  float h = 0.70 + (trowel - 0.5) * 0.16;
  h += (obFbm(uv * 60.0, vec2(60.0), 3, 0.5, uSeed + 13.0) - 0.5) * 0.05;

  // Crazing over the whole face, plus a couple of real cracks.
  float hair = obCracks(uv, vec2(1.0), 16.0, 0.007, uSeed + 23.0);
  hair *= smoothstep(0.50, 0.80, obFbm(uv * 3.0, vec2(3.0), 3, 0.5, uSeed + 24.0));
  float crack = obCracks(uv, vec2(1.0), 3.0, 0.012, uSeed + 31.0);
  crack *= smoothstep(0.62, 0.86, obFbm(uv * 1.0, vec2(1.0), 3, 0.5, uSeed + 32.0));
  h -= hair * 0.05 + crack * 0.30;

  // Blown plaster: a patch fallen away, exposing a coarser substrate.
  float blow = smoothstep(0.66, 0.82, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 41.0));
  h -= blow * 0.45;
  h += blow * (obFbm(uv * 130.0, vec2(130.0), 3, 0.5, uSeed + 47.0) - 0.5) * 0.18;

  // Nail pops and filled screw heads.
  vec3 pop = obWorleyP(uv * 14.0, vec2(14.0), 1.0, uSeed + 53.0);
  float dimple = smoothstep(0.09, 0.0, pop.x) * step(0.90, pop.z);
  h -= dimple * 0.16;

  h0 = vec4(clamp(h, 0.0, 1.0), blow, hair, crack);
  h1 = vec4(trowel, blow, dimple, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float hair = h0.z, crack = h0.w, blow = h1.y;

  vec3 paint = obRGB(190, 185, 172);
  vec3 aged  = obRGB(158, 149, 130);
  vec3 sub   = obRGB(124, 117, 104);

  float aging = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(paint, aged, obSat(aging * 1.3 - 0.15));

  // Nicotine / smoke wash rising up the wall.
  float smoke = obSat(uv.y * 1.3 - 0.15) * obFbm(uv * 4.0, vec2(4.0), 3, 0.5, uSeed + 67.0);
  col = mix(col, obRGB(150, 132, 100), smoke * 0.32);

  // Water ingress: a hard tide line with a soft, darker centre.
  float water = obFbm(obWarp(uv * 3.0, vec2(3.0), 0.6, uSeed + 71.0), vec2(3.0), 4, 0.5, uSeed + 73.0);
  float tide = smoothstep(0.50, 0.545, water) - smoothstep(0.60, 0.66, water);
  col = mix(col, obRGB(132, 114, 84), smoothstep(0.50, 0.68, water) * 0.4);
  col = mix(col, obRGB(102, 86, 60), tide * 0.6);

  col = mix(col, sub * mix(0.85, 1.1, obValueP(uv * 320.0, vec2(320.0), uSeed + 5.0)), blow);

  col = mix(col, obRGB(120, 114, 102), hair * 0.30);
  col = mix(col, obRGB(62, 58, 51), crack * 0.65);

  // Black mould in the damp.
  float mould = obSplatter(uv, 9.0, 0.24, uSeed + 101.0) * smoothstep(0.45, 0.75, water);
  col = mix(col, obRGB(38, 40, 36), mould * 0.6);

  float grime = obSat(d.cavity * 1.3 + (1.0 - d.ao) * 1.0);
  col = mix(col, obRGB(78, 73, 64), grime * 0.4);

  float speck = obValueP(uv * 420.0, vec2(420.0), uSeed + 11.0);
  col *= mix(0.95, 1.05, speck);

  o.albedo = col;
  o.metal = 0.0;
  float rough = 0.88 + hair * 0.05 + blow * 0.08;
  rough = mix(rough, 0.68, smoothstep(0.5, 0.7, water) * 0.5);
  o.rough = clamp(rough, 0.45, 1.0);
  o.ao = 1.0 - crack * 0.2;
}`,
  },
};

/* ------------------------------------------------------------------ tile -- */

const tile: MaterialArchetype = {
  id: 'tile',
  label: 'Ceramic tile',
  surface: 'tile',
  detail: 'micro',
  shader: { pom: true, pomShadow: true, pomDepth: 0.004, detailScale: 40 },
  recipe: {
    id: 'tile',
    seed: 79,
    size: 1024,
    geometry: { tile: 1.2, depth: 0.005 },
    normalGain: 1.5,
    normalWide: 0.5,
    aoRadius: 0.025,
    aoAlbedo: 0.45,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obGrid(uv, vec2(8.0), uSeed);
  vec2 dv = min(c.local, 1.0 - c.local);
  float dm = min(dv.x, dv.y);
  float face = smoothstep(0.026, 0.055, dm);

  // Each tile is laid a hair off level.
  float tilt = (c.rnd.x - 0.5) * 0.05 + (c.local.x - 0.5) * (c.rnd.y - 0.5) * 0.04;
  float h = mix(0.34, 0.88 + tilt, face);

  // The glaze is nearly flat, with a faint orange peel.
  h += (obFbm(uv * 220.0, vec2(220.0), 3, 0.5, uSeed + 7.0) - 0.5) * 0.025 * face;

  // Chipped corners, and one or two cracked tiles.
  float chip = obSplatter(uv, 46.0, 0.10, uSeed + 17.0);
  h -= chip * 0.30 * face;
  float broken = step(0.94, c.rnd.z);
  float crack = obCracks(uv, vec2(1.0), 14.0, 0.012, uSeed + 23.0) * broken;
  h -= crack * 0.38;

  // Grout: recessed, coarse, sometimes missing.
  float groutN = obFbm(uv * 280.0, vec2(280.0), 4, 0.5, uSeed + 29.0);
  h += (1.0 - face) * ((groutN - 0.5) * 0.10 - obSplatter(uv, 30.0, 0.24, uSeed + 31.0) * 0.14);

  h0 = vec4(clamp(h, 0.0, 1.0), 1.0 - face, c.rnd.x, face);
  h1 = vec4(chip, crack, groutN, c.rnd.z);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float face = h0.w;
  float chip = h1.x, crack = h1.y, groutN = h1.z, cr = h1.w;

  // Institutional off-white with a batch-to-batch drift.
  vec3 glaze = obRGB(196, 198, 193) * mix(0.90, 1.05, h0.z);
  glaze = mix(glaze, obRGB(172, 182, 182), step(0.70, cr) * 0.7);

  float dirtN = obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 61.0);
  vec3 grout = mix(obRGB(146, 140, 128), obRGB(88, 81, 70), obSat(dirtN * 1.4));
  grout *= mix(0.86, 1.12, groutN);

  vec3 col = mix(grout, glaze, face);

  col = mix(col, obRGB(188, 168, 144), chip * 0.85);
  col = mix(col, obRGB(52, 50, 46), crack * 0.8);

  float grime = obSat(d.cavity * 1.6 + (1.0 - d.ao) * 1.3);
  col = mix(col, obRGB(64, 58, 48), grime * 0.55);

  float scuff = obScratches(uv, 34.0, 1.0, 26.0, 0.35, uSeed + 71.0);
  col = mix(col, col * 0.88, scuff * face * 0.5);

  o.albedo = col;
  o.metal = 0.0;
  float rough = mix(0.94, 0.12, face);
  rough = mix(rough, 0.58, chip);
  rough += scuff * face * 0.28 + grime * 0.12;
  o.rough = clamp(rough, 0.07, 1.0);
}`,
  },
};

/* --------------------------------------------------------- ceiling panel -- */

const ceilingPanel: MaterialArchetype = {
  id: 'ceilingPanel',
  label: 'Acoustic ceiling',
  surface: 'plaster',
  detail: 'micro',
  shader: { pom: false, detailScale: 30 },
  recipe: {
    id: 'ceilingPanel',
    seed: 83,
    size: 1024,
    geometry: { tile: 1.22, depth: 0.010 },
    normalGain: 1.3,
    aoRadius: 0.03,
    aoAlbedo: 0.4,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  ObCell c = obGrid(uv, vec2(2.0), uSeed);
  vec2 dv = min(c.local, 1.0 - c.local);
  float dm = min(dv.x, dv.y);
  float rail = smoothstep(0.028, 0.014, dm);
  float face = 1.0 - rail;

  float sag = (1.0 - pow(max(abs(c.local.x - 0.5), abs(c.local.y - 0.5)) * 2.0, 2.5)) * mix(0.0, 0.09, c.rnd.x);
  float h = 0.58 - sag * face + rail * 0.30;

  // Fissured mineral-fibre face.
  float fis = obRidged(obWarp(uv * 44.0, vec2(44.0), 0.6, uSeed + 3.0), vec2(44.0), 4, 0.55, uSeed + 5.0);
  h -= smoothstep(0.55, 0.95, fis) * 0.11 * face;
  vec3 pin = obWorleyP(uv * 300.0, vec2(300.0), 1.0, uSeed + 11.0);
  h -= smoothstep(0.22, 0.0, pin.x) * step(0.42, pin.z) * 0.09 * face;

  h0 = vec4(clamp(h, 0.0, 1.0), rail, c.rnd.x, face);
  h1 = vec4(fis, sag, c.rnd.y, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float face = h0.w, rail = h0.y;

  vec3 panel = obRGB(202, 200, 191) * mix(0.90, 1.03, h0.z);
  vec3 bar   = obRGB(178, 178, 176);

  // Water staining - the signature of a suspended ceiling.
  float w = obFbm(obWarp(uv * 4.0, vec2(4.0), 0.7, uSeed + 61.0), vec2(4.0), 4, 0.5, uSeed + 63.0);
  float stain = smoothstep(0.50, 0.66, w);
  float ring = smoothstep(0.495, 0.515, w) - smoothstep(0.56, 0.60, w);
  panel = mix(panel, obRGB(160, 138, 96), stain * 0.65);
  panel = mix(panel, obRGB(128, 102, 62), ring * 0.7);

  float dust = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.0);
  panel = mix(panel, obRGB(112, 108, 98), dust * 0.45);

  vec3 col = mix(bar, panel, face);
  col = mix(col, obRGB(138, 136, 130), rail * 0.35);

  o.albedo = col;
  o.metal = rail * 0.4;
  o.rough = clamp(mix(0.38, 0.95, face) + stain * 0.03, 0.25, 1.0);
}`,
  },
};

export const MASONRY_ARCHETYPES: MaterialArchetype[] = [
  concrete, asphalt, brick, stone, plaster, tile, ceilingPanel,
];
