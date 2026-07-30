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

  // Entrained-air pinholes. These have to be *sparse*: sub-millimetre pores
  // belong to the detail layer, and a dense field of 8 mm dimples in the base
  // map is what makes procedural concrete read as expanded polystyrene.
  vec3 wa = obWorleyP(uv * 160.0, vec2(160.0), 1.0, uSeed + 11.0);
  float pin = smoothstep(0.20, 0.03, wa.x) * step(0.885, wa.z);
  h -= pin * 0.10;

  // The occasional real blow hole, 6-10 mm.
  vec3 wb = obWorleyP(uv * 58.0, vec2(58.0), 1.0, uSeed + 21.0);
  float blow = smoothstep(0.12, 0.02, wb.x) * step(0.965, wb.z);
  h -= blow * 0.24;

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

  // A narrow palette. Cast concrete does vary batch to batch, but over one
  // pour it is a few percent — the wide light/dark spread that reads so well
  // on a swatch turns into camouflage the moment the texture tiles across a
  // facade. Large-scale tonal drift is the shader's world-space macro layer.
  vec3 pale = obRGB(146, 144, 138);
  vec3 mid  = obRGB(128, 126, 121);
  vec3 dark = obRGB(110, 108, 104);

  float t1 = obFbm(uv * 2.0, vec2(2.0), 4, 0.6, uSeed + 61.0);
  float t2 = obFbm(uv * 7.0, vec2(7.0), 4, 0.5, uSeed + 71.0);
  vec3 col = mix(dark, pale, obSat(t1 * 1.35 - 0.18));
  col = mix(col, mid, obSat(t2 * 1.3 - 0.15) * 0.5);

  // Cement fines + exposed sand.
  float speck = obValueP(uv * 640.0, vec2(640.0), uSeed + 5.0);
  col *= mix(0.93, 1.07, speck);
  col = mix(col, obRGB(158, 152, 140) * mix(0.80, 1.14, h0.z), agg * 0.55);
  col = mix(col, obRGB(142, 139, 133), spall * 0.40);

  // Rain washing down the face. No uv.y skirt: the dirt line at the foot of a
  // wall is a *world-space* feature and lives in the shader's ground band —
  // baked into the tile it would repeat as a horizontal stripe every 2 m.
  float streak = obStreaks(uv, 14.0, 0.55, uSeed + 91.0);
  col = mix(col, obRGB(96, 90, 80), streak * 0.30);

  // Grime in every cavity the tracer found.
  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.3);
  grime *= mix(0.45, 1.4, obFbm(uv * 5.0, vec2(5.0), 3, 0.5, uSeed + 81.0));
  col = mix(col, obRGB(84, 78, 68), obSat(grime) * 0.5);

  col = mix(col, obRGB(52, 50, 46), crack * 0.75);

  // Efflorescence - pale salt bloom, mostly near the seams.
  float bloom = smoothstep(0.68, 0.90, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 101.0));
  col = mix(col, obRGB(178, 176, 170), bloom * 0.20);

  o.albedo = col;
  o.metal = 0.0;
  // Roughness does the heavy lifting: the power-floated skin is smoother than
  // the exposed aggregate, the wash lanes are polished, the grime is matte.
  float rough = 0.86 + (t2 - 0.5) * 0.16;
  rough += agg * 0.09 + grime * 0.07 + spall * 0.06;
  rough -= obSat(d.curv) * 0.12 + bloom * 0.05 + streak * 0.10;
  o.rough = clamp(rough, 0.38, 1.0);
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

  vec3 fresh = obRGB(52, 52, 54);
  vec3 aged  = obRGB(88, 87, 84);

  // Sun-bleached in the open, still black where it is sheltered.
  float bleach = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 71.0);
  vec3 col = mix(fresh, aged, obSat(bleach * 1.25 - 0.10));

  // Exposed chippings: individual grey/tan stones.
  vec3 chipCol = mix(obRGB(118, 115, 110), obRGB(150, 144, 134), h0.z);
  chipCol = mix(chipCol, obRGB(104, 95, 88), step(0.84, h0.z));
  col = mix(col, chipCol, obSat(chip * 1.15) * obSat(bleach + 0.3) * 0.75);

  float speck = obValueP(uv * 620.0, vec2(620.0), uSeed + 5.0);
  col *= mix(0.93, 1.07, speck);

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
  // Traffic polishes the aggregate crowns and leaves the hollows matte, so a
  // wet-looking sheen appears exactly along the wheel paths at low sun.
  float rough = 0.94 - chip * 0.14 + (1.0 - bleach) * 0.06;
  rough -= obSat(d.curv) * 0.14;
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
    normalWide: 0.28,
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
  // The arris of every brick is struck differently — a uniform bevel width is
  // what makes procedural brickwork read as an extruded grid.
  // Real brick keeps a flat face right up to a 2-4 mm arris; a 10 mm bevel on
  // every brick turns a wall into a tray of extruded blocks.
  float bev0 = 0.052 + c.rnd.z * 0.030;
  float face = smoothstep(bev0, bev0 + 0.028 + c.rnd.y * 0.030, dm);

  // Each brick sits a little proud, slightly domed, and — crucially — laid at
  // its own tiny angle, so no two arrises catch the sun identically.
  float proud = mix(0.66, 0.94, c.rnd.x);
  float dome = 1.0 - pow(max(abs(c.local.x - 0.5), abs(c.local.y - 0.5)) * 2.0, 6.0);
  float tilt = (c.local.y - 0.5) * (c.rnd.y - 0.5) * 0.16
             + (c.local.x - 0.5) * (c.rnd.z - 0.5) * 0.10;
  float h = mix(0.24, proud + tilt, face) + dome * 0.02 * face;

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

  // Three clay batches mixed through each other. Brick genuinely does vary
  // brick to brick, but only about ±12% in value — the four-stop spread that
  // looks lively on a single course turns into a chequerboard on a facade.
  vec3 clayA = obRGB(134,  74,  56);
  vec3 clayB = obRGB(112,  60,  48);
  vec3 clayC = obRGB(150,  94,  70);

  vec3 brickCol = mix(clayA, clayB, r1);
  brickCol = mix(brickCol, clayC, smoothstep(0.58, 0.92, r0));
  brickCol *= mix(0.83, 1.15, r2);
  brickCol = obHueShift(brickCol, (r1 - 0.5) * 0.018);

  // Within-brick mottling and flashed (over-fired) faces.
  float mott = obFbm(uv * vec2(50.0, 150.0), vec2(50.0, 150.0), 4, 0.55, uSeed + 61.0);
  brickCol *= mix(0.90, 1.09, mott);
  float flash = smoothstep(0.86, 1.0, r0) * smoothstep(0.45, 0.80, mott);
  brickCol = mix(brickCol, obRGB(86, 62, 58), flash * 0.45);

  brickCol = mix(brickCol, obRGB(168, 116, 92), chip * 0.6);

  vec3 mortarCol = mix(obRGB(128, 123, 113), obRGB(102, 98, 90), mortarN);
  float sand = obValueP(uv * 600.0, vec2(600.0), uSeed + 7.0);
  mortarCol *= mix(0.91, 1.09, sand);

  vec3 col = mix(mortarCol, brickCol, face);

  // Grime: heavier in the joints, and washing down from every course.
  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao) * 1.35);
  float dirtN = obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 71.0);
  col = mix(col, obRGB(72, 62, 52), obSat(grime * mix(0.45, 1.4, dirtN)) * 0.42);

  float streak = obStreaks(uv, 22.0, 0.45, uSeed + 83.0);
  col = mix(col, obRGB(86, 76, 64), streak * 0.26);

  // Efflorescence and lichen, both of which follow the mortar.
  float salt = obSplatter(uv, 8.0, 0.18, uSeed + 97.0) * (1.0 - face * 0.65);
  col = mix(col, obRGB(184, 182, 174), salt * 0.24);
  float moss = obSat(d.cavity * 1.6) * obSplatter(uv, 5.0, 0.30, uSeed + 113.0);
  col = mix(col, obRGB(84, 88, 66), moss * 0.22);

  float edge = obSat(d.curv) * face;
  col = mix(col, col * 1.12, edge * 0.25);

  o.albedo = col;
  o.metal = 0.0;
  // Fired brick faces have a faint vitrified sheen; mortar is dead matte and
  // the joints hold dirt, so the roughness map alone reads as brickwork.
  float rough = mix(0.97, 0.78, face);
  rough += mott * 0.07 + grime * 0.06 - edge * 0.10 - flash * 0.10;
  o.rough = clamp(rough, 0.40, 1.0);
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
  // Blocks sit at genuinely different depths. A 0.68-0.94 spread gives a wall
  // of identical bricks; a setted street needs some stones pushed right down
  // into the bedding and others standing proud enough to trip on.
  float h = mix(0.20, mix(0.50, 1.00, c.rnd.x), face);
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
  float r1 = h1.w;

  // One quarry, one bed — but a *worn* one. Keeping block-to-block variation
  // down to a hint of warmth is right for fresh ashlar and completely wrong for
  // a setted street, where a handful of stones are near-black basalt, a handful
  // are bleached, and the rest are somewhere between. Sixty metres of paving in
  // one value is the single loudest tell in the build, and this is where the
  // stone half of it lives.
  vec3 lime  = obRGB(147, 143, 133);
  vec3 grey  = obRGB(125, 123, 118);
  vec3 warm  = obRGB(146, 137, 121);
  vec3 dark  = obRGB( 74,  72,  70);
  vec3 bleach= obRGB(178, 174, 164);

  vec3 col = mix(grey, lime, obSat(h0.z * 0.85 + facet * 0.4));
  col = mix(col, warm, obFbm(uv * 6.0, vec2(6.0), 4, 0.5, uSeed + 61.0) * 0.42);
  // A handful of the stones are a visibly different rock. Kept to a handful:
  // at a third of the blocks it stops reading as a quarry mix and starts
  // reading as a randomly coloured tile grid.
  col = mix(col, dark, smoothstep(0.85, 0.97, r1) * 0.38 * face);
  col = mix(col, bleach, smoothstep(0.93, 1.00, h0.z) * 0.30 * face);
  // Per-block value drift on top, so no two adjacent stones match.
  col *= mix(0.87, 1.13, fract(h0.z * 3.7 + r1 * 1.9));

  float vein = obRidged(uv * 9.0, vec2(9.0), 4, 0.5, uSeed + 71.0);
  col = mix(col, obRGB(165, 161, 152), smoothstep(0.74, 0.96, vein) * 0.28 * face);

  float grain = obValueP(uv * 520.0, vec2(520.0), uSeed + 3.0);
  col *= mix(0.93, 1.07, grain);

  vec3 mortarCol = obRGB(136, 132, 122) * mix(0.90, 1.08, obValueP(uv * 400.0, vec2(400.0), uSeed + 9.0));
  col = mix(mortarCol, col, face);

  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao) * 1.25);
  col = mix(col, obRGB(74, 71, 63), grime * 0.48);
  float moss = obSat(d.cavity * 1.8) * obSplatter(uv, 6.0, 0.34, uSeed + 101.0);
  col = mix(col, obRGB(80, 88, 62), moss * 0.28);
  float streak = obStreaks(uv, 16.0, 0.45, uSeed + 113.0);
  col = mix(col, obRGB(92, 88, 78), streak * 0.24);

  float edge = obSat(d.curv) * face;
  col = mix(col, col * 1.13, edge * 0.30);

  o.albedo = col;
  o.metal = 0.0;
  // Chisel facets polish where hands and weather have touched them; the pocked
  // hollows stay matte, so raking light picks out the tooling. Traffic has
  // burnished a third of the stones nearly smooth, which is what makes a setted
  // street glitter unevenly under a low sun instead of reading as one mat.
  float rough = mix(0.97, 0.80, face);
  rough += facet * 0.10 + grime * 0.06 - edge * 0.16 - vein * 0.05;
  rough -= smoothstep(0.60, 0.96, fract(r1 * 5.3 + h0.z * 2.1)) * 0.20 * face;
  o.rough = clamp(rough, 0.18, 1.0);
}`,
  },
};

/* --------------------------------------------------------------- plaster -- */

const plaster: MaterialArchetype = {
  id: 'plaster',
  label: 'Painted lime render',
  surface: 'plaster',
  detail: 'micro',
  shader: { pom: false, detailScale: 30 },
  recipe: {
    id: 'plaster',
    seed: 67,
    size: 1024,
    geometry: { tile: 2.2, depth: 0.012 },
    normalGain: 1.4,
    normalWide: 0.30,
    aoRadius: 0.024,
    aoAlbedo: 0.35,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // Float coat: long, low arcs left by the plasterer's hawk. Kept shallow —
  // a wavy wall reads as clay, not render.
  vec2 w = obWarp(uv * 4.0, vec2(4.0), 0.55, uSeed);
  float trowel = obFbm(w * vec2(1.0, 2.0), vec2(4.0, 8.0), 4, 0.55, uSeed + 3.0);
  float h = 0.74 + (trowel - 0.5) * 0.085;

  // Sand fraction of the render: 1-3 mm domes at this tile, plus a finer
  // fraction right at the texel limit. This band is what the eye reads as
  // "mineral" rather than "plastic"; everything below it is the detail layer.
  // Kept small and mostly *directional*: a limewashed render is a smooth
  // surface with a little tooth, and isotropic domes of any real amplitude
  // boil into speckle the moment the sun rakes along the wall.
  vec3 sand = obWorleyP(uv * 150.0, vec2(150.0), 1.0, uSeed + 9.0);
  float grain = smoothstep(0.58, 0.14, sand.x) * mix(0.40, 1.0, sand.z);
  h += grain * 0.012;
  float drag = obValueP(vec2(uv.x * 44.0, uv.y * 130.0), vec2(44.0, 130.0), uSeed + 13.0);
  h += (drag - 0.5) * 0.011;
  float fines = obValueP(uv * 420.0, vec2(420.0), uSeed + 17.0);
  h += (fines - 0.5) * 0.009;

  // Crazing across the whole face plus one or two real settlement cracks.
  float hair = obCracks(uv, vec2(1.0), 15.0, 0.006, uSeed + 23.0);
  hair *= smoothstep(0.46, 0.78, obFbm(uv * 3.0, vec2(3.0), 3, 0.5, uSeed + 24.0));
  float crack = obCracks(uv, vec2(1.0), 3.0, 0.011, uSeed + 31.0);
  crack *= smoothstep(0.66, 0.88, obFbm(uv * 1.0, vec2(1.0), 3, 0.5, uSeed + 32.0));
  h -= hair * 0.06 + crack * 0.34;

  // Paint peel. The lifting lip stands proud and the exposed render sits a
  // hair lower — that ~1 mm ridge is the entire read at grazing light, and it
  // costs the albedo nothing. Gated by a wide mask so only part of any wall
  // has let go: peel everywhere reads as a pattern, not as damage.
  float peelF = obFbm(obWarp(uv * 5.0, vec2(5.0), 0.30, uSeed + 37.0), vec2(5.0), 4, 0.5, uSeed + 39.0);
  float peelGate = smoothstep(0.44, 0.70, obFbm(uv * 2.0, vec2(2.0), 3, 0.5, uSeed + 38.0));
  float peel = smoothstep(0.615, 0.665, peelF) * peelGate;
  float lip  = (smoothstep(0.585, 0.622, peelF) - smoothstep(0.655, 0.700, peelF)) * peelGate;
  h += lip * 0.042 - peel * 0.040;

  // One small patch where the render itself has come away.
  float blow = smoothstep(0.745, 0.815, obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 41.0));
  h -= blow * 0.34;
  h += blow * (obWorleyFbm(uv * 90.0, vec2(90.0), 2, 1.0, uSeed + 47.0) - 0.5) * 0.15;

  // Small-arms pocking, with the raised rim of ejected render around it.
  vec3 pk = obWorleyP(uv * 9.0, vec2(9.0), 1.0, uSeed + 59.0);
  float pockGate = step(0.845, pk.z);
  float pock = smoothstep(0.075, 0.012, pk.x) * pockGate;
  float rim = (smoothstep(0.115, 0.082, pk.x) - smoothstep(0.078, 0.062, pk.x)) * pockGate;
  h -= pock * 0.28;
  h += rim * 0.045;

  // Filled screw heads and nail pops.
  vec3 pop = obWorleyP(uv * 13.0, vec2(13.0), 1.0, uSeed + 53.0);
  float dimple = smoothstep(0.072, 0.0, pop.x) * step(0.915, pop.z);
  h -= dimple * 0.10;

  h0 = vec4(clamp(h, 0.0, 1.0), blow, hair, crack);
  h1 = vec4(trowel, peel, obSat(pock + rim * 0.4), grain);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float blow = h0.y, hair = h0.z, crack = h0.w;
  float trowel = h1.x, peel = h1.y, pock = h1.z, grain = h1.w;

  // Limewash over render. The entire painted range spans about eight percent
  // of value: the look of this wall lives in the normal and roughness maps.
  // Anything wider than this and a facade reads as camouflage.
  vec3 paintA = obRGB(199, 194, 181);
  vec3 paintB = obRGB(185, 179, 166);
  vec3 render = obRGB(176, 169, 155);
  vec3 sub    = obRGB(152, 143, 129);

  float aging = obFbm(uv * 3.0, vec2(3.0), 4, 0.55, uSeed + 61.0);
  vec3 col = mix(paintA, paintB, obSat(aging * 1.15 - 0.08));

  // Paint film thins on the trowel ridges before it lets go altogether.
  col = mix(col, render, obSat(peel) * 0.85 + obSat(d.curv) * 0.10);
  col = mix(col, sub * mix(0.93, 1.07, grain), blow * 0.85);

  // Fresh render behind a bullet strike is paler than the weathered face.
  col = mix(col, obRGB(208, 202, 188), obSat(pock) * 0.65);

  // Dirt only goes where dirt physically goes: crevices, cracks, and the
  // lee side of every trowel ridge.
  float cav = obSat(d.cavity * 1.25 + (1.0 - d.ao) * 0.9);
  col = mix(col, obRGB(122, 115, 102), cav * 0.42);
  col = mix(col, obRGB(102, 96, 85), hair * 0.24);
  col = mix(col, obRGB(64, 60, 53), crack * 0.55);

  // Short local drips under the pocks and peel edges. Deliberately *not* a
  // uv.y gradient: a gradient over the tile bands at every texture repeat,
  // which is exactly the horizontal striping that gives procedural walls away.
  float drip = obStreaks(uv, 26.0, 0.22, uSeed + 83.0);
  drip *= smoothstep(0.35, 0.75, obFbm(uv * 4.0, vec2(4.0), 3, 0.5, uSeed + 87.0));
  col = mix(col, col * vec3(0.80, 0.78, 0.74), drip * 0.55);

  // Rain-washed lanes are slightly *cleaner* than the field around them.
  float wash = obStreaks(uv, 11.0, 0.30, uSeed + 91.0);
  col = mix(col, col * 1.05, wash * 0.4);

  float speck = obValueP(uv * 460.0, vec2(460.0), uSeed + 11.0);
  col *= mix(0.965, 1.035, speck);

  o.albedo = col;
  o.metal = 0.0;

  // Roughness carries the story the albedo no longer does: paint keeps a faint
  // sheen, bare render and blown patches are dead matte, drips rougher still.
  float rough = 0.70 + (trowel - 0.5) * 0.12;
  rough = mix(rough, 0.94, obSat(peel));
  rough = mix(rough, 0.97, blow);
  rough = mix(rough, 0.93, obSat(pock));
  rough += cav * 0.10 + drip * 0.08 + hair * 0.05 - wash * 0.05;
  o.rough = clamp(rough, 0.40, 1.0);
  o.ao = 1.0 - crack * 0.25 - hair * 0.06;
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
