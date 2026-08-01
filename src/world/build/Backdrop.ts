/**
 * Distant backdrop.
 *
 * A map that ends at a wall reads as a box. Blackout ends in a city that
 * continues: receding bands of silhouette blocks, a smoke column from a fire
 * beyond the map, and mountain ranges on the horizon.
 *
 * Everything here lives on `LAYERS.BACKDROP`, which keeps it out of collision,
 * out of the shadow atlas and out of the navigation build, and it is authored
 * with cheap materials because aerial perspective is doing all the work at that
 * distance anyway.
 *
 * The two rules that stop a backdrop reading as a bar chart:
 *
 *  1. **Never place on a lattice.** Angular position, radius, size and yaw are
 *     all independently jittered, and the height distribution is heavy-tailed
 *     (`pow(u, 2.4)`) so most blocks are low and a handful spike — which is
 *     what a real town profile looks like. Even spacing plus a uniform height
 *     range is exactly a bar chart.
 *  2. **Roofs are the silhouette.** At 200 m the walls are one flat value and
 *     the only thing the eye reads is the top edge, so every block gets one of
 *     five roof treatments (pitch, hip, parapet-and-setback, tower, mansard)
 *     plus stacks and tanks. Flat-topped extrusions are what make it read as
 *     an extruded footprint map.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { Chunk } from '../geom/Chunk';
import type { Mesher } from '../geom/Mesher';
import { noise3 } from './Grounding';

type BackdropKey = 'backdropMid' | 'backdropFar' | 'ridgeNear' | 'ridgeMid' | 'ridge';

export function buildBackdrop(chunk: Chunk): void {
  const rand = new Rand(1717);

  /* --- receding bands of city blocks ----------------------------------
   *
   * **A backdrop must sit below the sky it is cut out against.** Value, not
   * detail, is what makes a distant mass recede: measured against this level's
   * horizon sky (display ≈172 on `overview`), the three bands used to land at
   * 135 / 143 / 146 with individual sunlit faces reaching 219 — brighter than
   * the sky behind them — so the whole city advanced instead of receding and
   * the upper third of the establishing shot read as polystyrene.
   *
   * Two things are being asked of the numbers below, and they pull in the same
   * direction:
   *
   *  1. **Each band lands at a distinct fraction of sky** — roughly 0.6 at
   *     150 m, 0.75 at 250 m, 0.85 at 400 m, never above 1.0. Aerial
   *     perspective already lifts the far bands, so the albedo ramp has to run
   *     the *other* way: the near band gets the darkest keys in the catalogue
   *     and the far band the lightest, and the two effects compose into a
   *     monotonic ramp instead of cancelling.
   *  2. **The mass has internal value structure.** Backdrop blocks are on
   *     `LAYERS.BACKDROP` and therefore never shadow each other, which is why a
   *     hundred of them read as one flat cut-out. `baseDark` paints the bottom
   *     of every block in the darkest key in two steps, standing in for the
   *     mutual shadowing a real district has at street level — and that is also
   *     what pulls the near band's mean down without touching the roofline,
   *     where all the silhouette information lives.
   */
  const bands: {
    r0: number; r1: number; count: number; minH: number; maxH: number;
    keys: BackdropKey[]; minW: number; maxW: number; glaze: boolean;
    /** Fraction of the block height painted as street-level shadow. */
    baseDark: number;
    /** Storey-band depth as a fraction of the storey. */
    bandGain: number;
  }[] = [
    // A provincial town, not a CBD: three to eight storeys, receding into haze.
    //
    // `keys` is the fix for the loudest backdrop tell: every block used to be
    // drawn in one flat material, so a hundred blocks were a hundred cut-outs
    // of exactly the same value and the whole band read as a bar chart. Real
    // districts are built of half a dozen renders and brick tones, and value
    // difference between neighbours is what makes a mass read as buildings.
    // The first band starts at 118 m, not 98. A 20 m block 50 m past the map
    // edge is close enough to read as a wall rather than as a silhouette, and
    // a backdrop material has no window, no eaves and no downpipe to survive
    // that. Pushed out, aerial perspective does its job and the band reads as
    // the next district.
    { r0: 118, r1: 180, count: 100, minH: 6, maxH: 16, minW: 9, maxW: 23, glaze: true,
      baseDark: 0.46, bandGain: 0.50,
      keys: ['ridgeMid', 'ridgeMid', 'backdropFar', 'ridgeMid', 'backdropFar'] },
    { r0: 190, r1: 298, count: 112, minH: 7, maxH: 24, minW: 13, maxW: 37, glaze: true,
      baseDark: 0.34, bandGain: 0.42,
      keys: ['ridgeMid', 'backdropFar', 'backdropFar', 'ridge', 'ridgeMid'] },
    { r0: 306, r1: 404, count: 88, minH: 9, maxH: 32, minW: 18, maxW: 56, glaze: true,
      baseDark: 0.18, bandGain: 0.34,
      keys: ['backdropFar', 'ridge', 'backdropFar', 'backdropMid'] },
  ];

  /**
   * Window / shadow-gap ribbons and street-level shadow. `ridgeNear` is the
   * darkest key in the catalogue and is otherwise only used by the near
   * mountain range, so it doubles as the backdrop's void.
   *
   * **`VOID_KEY` must never appear in a band's `keys`.** `chunk.m()` returns
   * one shared `Mesher` per key and `Mesher.push()` *multiplies into* the
   * current transform, so a block whose body key equalled the void key got the
   * same placement matrix applied twice: `R·p + p`, which for the blocks whose
   * angle is near π collapses to the origin. The symptom is a 30 m untextured
   * slab standing in the middle of the square on top of the tram. The guard
   * below is belt and braces — the key lists above already exclude it.
   */
  const VOID_KEY: BackdropKey = 'ridgeNear';
  const voidM = chunk.m(VOID_KEY);

  for (const band of bands) {
    for (let i = 0; i < band.count; i++) {
      // Free angle, not i/count. Regular angular spacing at three fixed radii
      // is what produced the rows-of-identical-bars read.
      const a = rand.range(0, Math.PI * 2);
      const r = band.r0 + (band.r1 - band.r0) * Math.pow(rand.next(), 0.7);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // Heavy-tailed heights: mostly low stock, occasional spike.
      let h = band.minH + (band.maxH - band.minH) * Math.pow(rand.next(), 2.4);
      if (rand.bool(0.06)) h *= rand.range(1.5, 2.2);
      const w = rand.range(band.minW, band.maxW);
      const d = rand.range(band.minW, band.maxW) * rand.range(0.55, 1.0);
      // Blocks face the street grid of their own district, not the camera.
      const yaw = -a + rand.range(-0.9, 0.9);
      const key = band.keys[rand.int(0, band.keys.length - 1)];
      const m = chunk.m(key);
      const vm = key === VOID_KEY ? m : voidM;   // see the note on VOID_KEY
      m.pushTRS(x, 0, z, yaw);
      if (vm !== m) vm.pushTRS(x, 0, z, yaw);
      cityBlock(m, vm, w, d, h, rand, band.glaze, band.baseDark, band.bandGain);
      if (vm !== m) vm.pop();
      m.pop();
    }
  }

  /* --- mountain ranges --------------------------------------------------
   * Three ranges rather than one wall, each built as a parametric surface
   * (angle × slope) rather than a single ring of quads.
   *
   * The old version was one quad per segment from the foot straight to the
   * crest: 160 enormous flat triangles, which is why the near range read as
   * folded paper with one hard origami crease down each peak. Sampling the
   * surface on a grid and computing normals from the parameterisation gives
   * smooth flanks, gullies between the spurs, and a silhouette with real
   * notches — and the whole thing is still only a few thousand triangles on a
   * layer that never casts a shadow. */
  const ranges: (RangeDef & { key: 'ridgeNear' | 'ridgeMid' | 'ridge' })[] = [
    // Broken foothills in front of the main range. One ridgeline on the horizon
    // is a cutout; two ridgelines that cross each other read as distance.
    { key: 'ridgeNear', rFoot: 372, rCrest: 452, base: 4, gain: 44, sharp: 1.35, phase: 6.1, segments: 300, rows: 9 },
    { key: 'ridgeNear', rFoot: 430, rCrest: 540, base: 22, gain: 104, sharp: 1.9, phase: 0.0, segments: 320, rows: 13 },
    { key: 'ridgeMid', rFoot: 560, rCrest: 700, base: 44, gain: 150, sharp: 1.7, phase: 1.9, segments: 288, rows: 12 },
    { key: 'ridge', rFoot: 720, rCrest: 900, base: 66, gain: 194, sharp: 1.5, phase: 4.3, segments: 256, rows: 10 },
  ];
  for (const range of ranges) buildRidge(chunk.m(range.key), range);

  /* --- a few taller landmarks so the skyline is not a flat band --------- */
  const land = chunk.m('backdropFar');
  const marks: [number, number, number, number, number][] = [
    // angle, radius, height, width, kind
    [0.75, 205, 46, 9, 0], [2.35, 240, 52, 11, 1], [4.15, 175, 40, 8, 2],
    [5.4, 265, 44, 10, 0], [3.35, 150, 33, 7, 2], [1.15, 310, 58, 13, 1],
  ];
  for (const [a, r, h, w, kind] of marks) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    land.pushTRS(x, 0, z, -a + 0.4);
    land.box(0, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.5, 10);
    // The lower third sits in the district around it, same as every block.
    voidM.pushTRS(x, 0, z, -a + 0.4);
    voidM.box(0, h * 0.17, 0, w * 0.5 + 0.05, h * 0.17, w * 0.5 + 0.05, 8);
    voidM.pop();
    if (kind === 0) {
      // Water tower / silo pair.
      land.box(0, h + 3.5, 0, w * 0.22, 3.5, w * 0.22, 10);
      land.box(w * 0.34, h + 1.2, 0, w * 0.16, 1.2, w * 0.16, 10);
    } else if (kind === 1) {
      // Church: stepped belfry under a spire.
      land.box(0, h + 2.2, 0, w * 0.34, 2.2, w * 0.34, 10);
      spire(land, w * 0.3, h + 4.4, w * 0.9);
    } else {
      // Chimney with a shoulder.
      land.box(0, h + 6, 0, w * 0.17, 6, w * 0.17, 10);
      land.box(0, h + 12.4, 0, w * 0.21, 0.5, w * 0.21, 10);
    }
    land.pop();
  }

  /* --- low industrial sheds hugging the near band ----------------------
   * These sit at 72–128 m: nearer than anything else out here, so they are the
   * darkest thing on the far side of the map edge and the first rung of the
   * value ladder. `backdropMid` is the *lightest* key in the catalogue and put
   * them at the top of it instead. */
  const shedKeys: BackdropKey[] = ['ridgeMid', 'ridgeMid', 'backdropFar', 'ridgeMid', 'backdropFar'];
  for (let i = 0; i < 34; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(72, 128);
    const w = rand.range(12, 30), d = rand.range(9, 20);
    const h = rand.range(4.0, 8.0);
    const shed = chunk.m(shedKeys[rand.int(0, shedKeys.length - 1)]);
    shed.pushTRS(Math.cos(a) * r, 0, Math.sin(a) * r, -a + rand.range(-1.2, 1.2));
    shed.box(0, h * 0.5, 0, w * 0.5, h * 0.5, d * 0.5, 8);
    gable(shed, w * 0.5, d * 0.5, h, rand.range(1.2, 2.6));
    shed.pop();
    // Yard wall / loading bank along the foot, in the darkest key.
    voidM.pushTRS(Math.cos(a) * r, 0, Math.sin(a) * r, -a + rand.range(-1.2, 1.2));
    voidM.box(0, h * 0.16, 0, w * 0.5 + 0.08, h * 0.16, d * 0.5 + 0.08, 6);
    voidM.pop();
  }
}

/* ------------------------------------------------------------- massing -- */

/**
 * One backdrop block: a body plus one of five roof treatments and a little
 * rooftop clutter. Everything is proportional to the block so a 6 m shed and a
 * 34 m slab both read correctly.
 */
function cityBlock(
  m: Mesher, voidM: Mesher, w: number, d: number, h: number, rand: Rand,
  glaze: boolean, baseDark = 0, bandGain = 0.35,
): void {
  const hw = w * 0.5, hd = d * 0.5;
  m.box(0, h * 0.5, 0, hw, h * 0.5, hd, 8.0);

  /* Street-level shadow, in two steps. Nothing on `LAYERS.BACKDROP` casts or
   * receives a shadow, so without this every block is lit top to bottom by the
   * same key and a hundred of them average out to one flat value. Two steps
   * rather than one gradient because at 150 m the eye is reading a *value
   * boundary*, and one at 20% of the height plus one at 45% gives the mass a
   * base, a body and a roofline. */
  if (baseDark > 0.01) {
    const h0 = h * baseDark * 0.42;
    const h1 = h * baseDark;
    voidM.box(0, h0 * 0.5, 0, hw + 0.06, h0 * 0.5, hd + 0.06, 6.0);
    voidM.box(0, (h0 + h1) * 0.5, 0, hw + 0.03, (h1 - h0) * 0.5, hd + 0.03, 6.0);
  }

  // Massing. A single extruded rectangle is the bar-chart primitive; a real
  // block is a main range plus a lower back wing, a corner infill of a
  // different height, or a setback top. Two extra masses per block is all it
  // takes for the silhouette to stop being a rectangle.
  if (rand.bool(0.62)) {
    const ww = hw * rand.range(0.35, 0.85);
    const wd = hd * rand.range(0.45, 1.15);
    const wh = h * rand.range(0.38, 0.82);
    const sx = (rand.bool() ? 1 : -1) * (hw + ww * rand.range(0.55, 0.95));
    const sz = rand.range(-hd * 0.4, hd * 0.4);
    m.box(sx, wh * 0.5, sz, ww, wh * 0.5, wd, 8.0);
    if (rand.bool(0.5)) m.box(sx, wh + 0.3, sz, ww * 1.04, 0.3, wd * 1.04, 8.0);
  }
  if (rand.bool(0.4)) {
    // A taller end bay. Kept narrow and only a storey or two over the main
    // range: a full-width mass at 1.4× the height is a second bar on the chart.
    const ww = hw * rand.range(0.28, 0.55);
    const wd = hd * rand.range(0.3, 0.7);
    const wh = h + rand.range(2.2, 6.5);
    m.box(rand.range(-hw * 0.4, hw * 0.4), wh * 0.5,
      (rand.bool() ? 1 : -1) * (hd - wd * rand.range(0.1, 0.6)), ww, wh * 0.5, wd, 8.0);
  }

  // Glazing bands. At 120–270 m a facade is not read as individual windows, it
  // is read as horizontal value banding — a dark ribbon per storey against the
  // render. A blank slab of one value is the thing that says "untextured box".
  if (glaze && h > 5) {
    const storey = rand.range(3.0, 3.9);
    const n = Math.min(9, Math.floor((h - 1.2) / storey));
    const sill = rand.range(0.9, 1.35);
    for (let s = 0; s < n; s++) {
      const y = 1.0 + s * storey + sill;
      const bh = storey * bandGain * rand.range(0.8, 1.2);
      if (y + bh > h - 0.4) break;
      // Slightly proud of the wall so it never z-fights; dark, so it reads as
      // the shadow inside a reveal rather than as a projecting band.
      voidM.box(0, y + bh * 0.5, 0, hw + 0.05, bh * 0.5, hd - hd * 0.14, 4.0);
      voidM.box(0, y + bh * 0.5, 0, hw - hw * 0.14, bh * 0.5, hd + 0.05, 4.0);
    }
  }

  const roll = rand.next();
  if (roll < 0.32) {
    // Pitched roof along the long axis. Rise is set off the *span* being
    // covered at a believable 30–40°, not off the block's overall size — a
    // 12 m ridge on a 30 m block reads as a circus tent.
    gable(m, hw, hd, h, Math.min(hd * rand.range(0.5, 0.75), 5.5));
  } else if (roll < 0.50) {
    // Hipped roof: a truncated pyramid, the commonest provincial profile.
    hip(m, hw, hd, h, Math.min(Math.min(hw, hd) * rand.range(0.4, 0.7), 5.0), rand.range(0.2, 0.5));
  } else if (roll < 0.74) {
    // Parapet with a setback attic storey.
    const p = rand.range(0.5, 1.1);
    m.box(0, h + p * 0.5, 0, hw * 1.03, p * 0.5, hd * 1.03, 8.0);
    if (rand.bool(0.75)) {
      const sh = rand.range(1.6, 4.5);
      const k = rand.range(0.5, 0.78);
      m.box(rand.range(-hw * 0.2, hw * 0.2), h + sh * 0.5, rand.range(-hd * 0.2, hd * 0.2),
        hw * k, sh * 0.5, hd * k, 8.0);
    }
  } else if (roll < 0.85) {
    // Corner tower with a spire — the thing that makes a skyline a skyline.
    const tw = Math.min(Math.min(hw, hd) * rand.range(0.22, 0.4), 3.6);
    const th = h * rand.range(0.28, 0.55) + 3;
    const tx = (hw - tw) * (rand.bool() ? 1 : -1) * rand.range(0.3, 0.95);
    const tz = (hd - tw) * (rand.bool() ? 1 : -1) * rand.range(0.3, 0.95);
    m.box(tx, h + th * 0.5, tz, tw, th * 0.5, tw, 8.0);
    m.pushTRS(tx, 0, tz);
    spire(m, tw * 1.05, h + th, tw * rand.range(1.6, 2.6));
    m.pop();
    m.box(0, h + 0.35, 0, hw * 1.02, 0.35, hd * 1.02, 8.0);
  } else {
    // Mansard: a shallow slope stopped by a flat deck.
    const s = Math.min(hw, hd) * rand.range(0.25, 0.4);
    const rise = s * rand.range(0.9, 1.4);
    m.quad(
      new THREE.Vector3(-hw, h, -hd), new THREE.Vector3(hw, h, -hd),
      new THREE.Vector3(hw - s, h + rise, -hd + s), new THREE.Vector3(-hw + s, h + rise, -hd + s), 9,
    );
    m.quad(
      new THREE.Vector3(hw, h, hd), new THREE.Vector3(-hw, h, hd),
      new THREE.Vector3(-hw + s, h + rise, hd - s), new THREE.Vector3(hw - s, h + rise, hd - s), 9,
    );
    m.quad(
      new THREE.Vector3(hw, h, -hd), new THREE.Vector3(hw, h, hd),
      new THREE.Vector3(hw - s, h + rise, hd - s), new THREE.Vector3(hw - s, h + rise, -hd + s), 9,
    );
    m.quad(
      new THREE.Vector3(-hw, h, hd), new THREE.Vector3(-hw, h, -hd),
      new THREE.Vector3(-hw + s, h + rise, -hd + s), new THREE.Vector3(-hw + s, h + rise, hd - s), 9,
    );
    m.box(0, h + rise, 0, hw - s, 0.12, hd - s, 8.0);
  }

  // Stacks, lift housings and tanks. Three or four per block is the difference
  // between a roofline and a straight edge.
  const stacks = rand.int(1, 4);
  for (let i = 0; i < stacks; i++) {
    const sx = rand.range(-hw * 0.8, hw * 0.8);
    const sz = rand.range(-hd * 0.8, hd * 0.8);
    const sh = rand.range(1.0, 3.4);
    const sw = rand.range(0.35, 1.15);
    m.box(sx, h + sh * 0.5, sz, sw, sh * 0.5, sw * rand.range(0.6, 1.4), 6.0);
  }
}

/** Two slopes meeting on a ridge along X, plus the gable triangles. */
function gable(m: Mesher, hw: number, hd: number, y: number, rise: number): void {
  const A = new THREE.Vector3(-hw, y, -hd), B = new THREE.Vector3(hw, y, -hd);
  const C = new THREE.Vector3(hw, y, hd), D = new THREE.Vector3(-hw, y, hd);
  const R0 = new THREE.Vector3(-hw, y + rise, 0), R1 = new THREE.Vector3(hw, y + rise, 0);
  m.quad(A, B, R1, R0, 9);
  m.quad(C, D, R0, R1, 9);
  tri(m, B, C, R1);
  tri(m, D, A, R0);
}

/** Truncated pyramid: four slopes to a flat ridge deck. */
function hip(m: Mesher, hw: number, hd: number, y: number, rise: number, k: number): void {
  const tw = hw * k, td = hd * k;
  const A = new THREE.Vector3(-hw, y, -hd), B = new THREE.Vector3(hw, y, -hd);
  const C = new THREE.Vector3(hw, y, hd), D = new THREE.Vector3(-hw, y, hd);
  const a = new THREE.Vector3(-tw, y + rise, -td), b = new THREE.Vector3(tw, y + rise, -td);
  const c = new THREE.Vector3(tw, y + rise, td), d = new THREE.Vector3(-tw, y + rise, td);
  m.quad(A, B, b, a, 9);
  m.quad(B, C, c, b, 9);
  m.quad(C, D, d, c, 9);
  m.quad(D, A, a, d, 9);
  m.quad(a, b, c, d, 9);
}

/** Four-sided spire rising from a square base at `y`. */
function spire(m: Mesher, halfW: number, y: number, height: number): void {
  const apex = new THREE.Vector3(0, y + height, 0);
  const p = [
    new THREE.Vector3(-halfW, y, -halfW), new THREE.Vector3(halfW, y, -halfW),
    new THREE.Vector3(halfW, y, halfW), new THREE.Vector3(-halfW, y, halfW),
  ];
  for (let i = 0; i < 4; i++) tri(m, p[i], p[(i + 1) % 4], apex);
}

function tri(m: Mesher, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
  const e1 = new THREE.Vector3().subVectors(b, a);
  const e2 = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  const ia = m.vertex(a.x, a.y, a.z, n.x, n.y, n.z, 0, 0);
  const ib = m.vertex(b.x, b.y, b.z, n.x, n.y, n.z, 1, 0);
  const ic = m.vertex(c.x, c.y, c.z, n.x, n.y, n.z, 0.5, 1);
  m.tri(ia, ib, ic);
}

/* ----------------------------------------------------------- mountains -- */

interface RangeDef {
  /** Radius of the foot (nearest the map) and of the crest line. */
  rFoot: number; rCrest: number;
  base: number; gain: number; sharp: number; phase: number;
  segments: number; rows: number;
}

/**
 * A mountain range as a parametric surface over (angle, slope).
 *
 * `t` runs 0 at the foot to 1 at the crest, and the crest is *further* from the
 * map than the foot, so the flank we see rises away from the camera and its
 * normal points back at us and upward. The old version ran a single quad from
 * foot to crest with the crest pulled *inward*, which both overhung the viewer
 * and gave every peak one enormous flat triangle either side of a hard crease —
 * the origami read.
 *
 * The crest line carries five octaves of ridged noise; a second field of spurs
 * that fades out at the crest puts gullies down the flanks; and the plan is
 * lobed so the range does not sit on a circle.
 */
function buildRidge(m: Mesher, def: RangeDef): void {
  const { segments, rows } = def;
  const seed = def.phase;

  const crest = (a: number): number => {
    // A massif envelope: whole sectors of the range are low saddles and whole
    // sectors are high massifs. Without it every peak reaches the same altitude
    // and the horizon is a row of identical paper triangles.
    const massif = 0.20 + 0.80 * Math.pow(ringNoise(a, 0.62, seed + 17.3), 1.25);
    const rid = Math.max(0, (ringRidge(a, seed) - 0.40) / 0.60);
    return def.base + Math.pow(rid, def.sharp) * def.gain * massif;
  };

  const radiusAt = (a: number, t: number): number => {
    // The plan is not a circle: the foot wanders in and out by ~12%, and it
    // wanders differently at the crest, so ridgelines are not radial spokes.
    const lobeFoot = 1 + (ringNoise(a, 1.1, seed + 2.7) - 0.5) * 0.24;
    const lobeCrest = 1 + (ringNoise(a, 2.3, seed + 9.1) - 0.5) * 0.18;
    const lobe = lobeFoot + (lobeCrest - lobeFoot) * t;
    return (def.rFoot + (def.rCrest - def.rFoot) * t) * lobe;
  };

  const heightAt = (a: number, t: number): number => {
    const c = crest(a);
    // S-curve flank: the toe eases out into the plain and the crest rounds.
    const prof = t * t * (3 - 2 * t);
    const belly = Math.sin(Math.PI * t);
    // Spurs and gullies. The first two vary with angle only — those are the
    // long ridges that run down off a summit. The last two vary with angle AND
    // slope, and they are the whole point: the old surface was ruled between
    // foot and crest, so every flank was a dead-straight line in space and the
    // range read as folded paper with one crease per peak.
    const spur = (ringRidge(a * 1.0 + 3.1, seed + 5.5) - 0.5) * def.gain * 0.26 * belly
      + (ringNoise(a, 14.0, seed + 21.7) - 0.5) * def.gain * 0.11 * belly;
    const wob = (noise3(Math.cos(a) * 7.5 + seed, t * 3.1, Math.sin(a) * 7.5 - seed) - 0.5)
      * def.gain * 0.17 * belly
      + (noise3(Math.cos(a) * 21.0 - seed, t * 7.3 + 4.4, Math.sin(a) * 21.0 + seed) - 0.5)
      * def.gain * 0.055 * belly;
    return -14 + (c + 14) * prof + spur + wob;
  };

  // Build the position grid first, then take normals from its own neighbours:
  // one field evaluation per vertex instead of three, and normals that follow
  // the displaced surface exactly rather than an idealised parameterisation.
  const px: number[][] = [], py: number[][] = [], pz: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const rx: number[] = [], ry: number[] = [], rz: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const r = radiusAt(a, t);
      rx.push(Math.cos(a) * r);
      ry.push(heightAt(a, t));
      rz.push(Math.sin(a) * r);
    }
    // Seam: the last column must be exactly the first.
    rx[segments] = rx[0]; ry[segments] = ry[0]; rz[segments] = rz[0];
    px.push(rx); py.push(ry); pz.push(rz);
  }

  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const n = new THREE.Vector3();
  const rowsIdx: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    const row: number[] = [];
    const jm = Math.max(0, j - 1), jp = Math.min(rows, j + 1);
    for (let i = 0; i <= segments; i++) {
      const im = (i - 1 + segments) % segments, ip = (i + 1) % segments;
      du.set(px[j][ip] - px[j][im], py[j][ip] - py[j][im], pz[j][ip] - pz[j][im]);
      dv.set(px[jp][i] - px[jm][i], py[jp][i] - py[jm][i], pz[jp][i] - pz[jm][i]);
      n.crossVectors(du, dv).normalize();
      if (!Number.isFinite(n.x) || n.lengthSq() < 0.5) n.set(0, 1, 0);
      if (n.y < 0) n.negate();
      row.push(m.vertex(px[j][i], py[j][i], pz[j][i], n.x, n.y, n.z,
        (i / segments) * 40, (j / rows) * 8));
    }
    rowsIdx.push(row);
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segments; i++) {
      m.quadIdx(rowsIdx[j][i], rowsIdx[j][i + 1], rowsIdx[j + 1][i + 1], rowsIdx[j + 1][i]);
    }
  }
}

/**
 * Value noise sampled on a circle of radius `freq`, so it wraps seamlessly at
 * a = 2π and has none of the visible periodicity of a sum of sines.
 */
function ringNoise(a: number, freq: number, seed: number): number {
  return noise3(Math.cos(a) * freq + seed * 3.7, seed * 1.93, Math.sin(a) * freq - seed * 2.3);
}

/**
 * Ridged multifractal around a ring, in roughly [0,1]. Folded through
 * `1 - |n|` so the maxima are creases rather than domes — the difference
 * between a mountain profile and a sine wave.
 */
function ringRidge(a: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, f = 1.7;
  for (let o = 0; o < 5; o++) {
    const v = ringNoise(a, f, seed + o * 4.13) * 2 - 1;
    sum += (1 - Math.abs(v)) * amp;
    norm += amp;
    amp *= 0.53;
    f *= 2.11;
  }
  return sum / norm;
}
