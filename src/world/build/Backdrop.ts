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

export function buildBackdrop(chunk: Chunk): void {
  const rand = new Rand(1717);

  /* --- receding bands of city blocks ---------------------------------- */
  const bands: {
    r0: number; r1: number; count: number; minH: number; maxH: number;
    key: 'backdropMid' | 'backdropFar'; minW: number; maxW: number;
  }[] = [
    // A provincial town, not a CBD: three to eight storeys, receding into haze.
    { r0: 98, r1: 158, count: 96, minH: 6.5, maxH: 21, key: 'backdropMid', minW: 11, maxW: 30 },
    { r0: 168, r1: 268, count: 104, minH: 8, maxH: 27, key: 'backdropFar', minW: 15, maxW: 44 },
    { r0: 285, r1: 388, count: 84, minH: 11, maxH: 34, key: 'backdropFar', minW: 22, maxW: 66 },
  ];

  for (const band of bands) {
    const m = chunk.m(band.key);
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
      m.pushTRS(x, 0, z, yaw);
      cityBlock(m, w, d, h, rand);
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
    { key: 'ridgeNear', rFoot: 400, rCrest: 500, base: 26, gain: 96, sharp: 2.6, phase: 0.0, segments: 320, rows: 8 },
    { key: 'ridgeMid', rFoot: 528, rCrest: 660, base: 48, gain: 142, sharp: 2.0, phase: 1.9, segments: 280, rows: 7 },
    { key: 'ridge', rFoot: 680, rCrest: 850, base: 70, gain: 182, sharp: 1.6, phase: 4.3, segments: 240, rows: 6 },
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

  /* --- low industrial sheds hugging the near band ---------------------- */
  const shed = chunk.m('backdropMid');
  for (let i = 0; i < 26; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(88, 132);
    const w = rand.range(14, 34), d = rand.range(9, 20);
    const h = rand.range(4.5, 8.5);
    shed.pushTRS(Math.cos(a) * r, 0, Math.sin(a) * r, -a + rand.range(-1.2, 1.2));
    shed.box(0, h * 0.5, 0, w * 0.5, h * 0.5, d * 0.5, 8);
    gable(shed, w * 0.5, d * 0.5, h, rand.range(1.2, 2.6));
    shed.pop();
  }
}

/* ------------------------------------------------------------- massing -- */

/**
 * One backdrop block: a body plus one of five roof treatments and a little
 * rooftop clutter. Everything is proportional to the block so a 6 m shed and a
 * 34 m slab both read correctly.
 */
function cityBlock(m: Mesher, w: number, d: number, h: number, rand: Rand): void {
  const hw = w * 0.5, hd = d * 0.5;
  m.box(0, h * 0.5, 0, hw, h * 0.5, hd, 8.0);

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
  const crest = (a: number): number =>
    def.base + Math.pow(ridged(a + def.phase), def.sharp) * def.gain;

  const radiusAt = (a: number, t: number): number => {
    const lobe = 1 + (ridged(a * 1.7 + def.phase * 2.1) - 0.4) * 0.08;
    return (def.rFoot + (def.rCrest - def.rFoot) * t) * lobe;
  };
  const heightAt = (a: number, t: number): number => {
    const c = crest(a);
    // S-curve flank: the toe eases out into the plain and the crest rounds.
    const prof = t * t * (3 - 2 * t);
    // Spur/gully field, strongest at mid-slope, gone at the skyline.
    const spur = (ridged(a * 5.9 + 1.7) - 0.45) * def.gain * 0.22 * Math.sin(Math.PI * t)
      + (ridged(a * 11.3 + 4.9) - 0.45) * def.gain * 0.09 * Math.sin(Math.PI * t);
    return -14 + (c + 14) * prof + spur;
  };

  const pt = (a: number, t: number, out: THREE.Vector3): THREE.Vector3 => {
    const r = radiusAt(a, t);
    return out.set(Math.cos(a) * r, heightAt(a, t), Math.sin(a) * r);
  };

  const p = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const n = new THREE.Vector3();
  const rowsIdx: number[][] = [];
  const da = ((Math.PI * 2) / segments) * 0.5;
  const dt = (1 / rows) * 0.5;

  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const row: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pt(a, t, p);
      pt(a + da, t, pa);
      pt(a, Math.min(1, t + dt), pb);
      du.subVectors(pa, p);
      dv.subVectors(pb, p);
      n.crossVectors(du, dv).normalize();
      if (n.y < 0) n.negate();
      row.push(m.vertex(p.x, p.y, p.z, n.x, n.y, n.z, (i / segments) * 40, t * 8));
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
 * Ridged multifractal in [0,1]. Five octaves, folded through `1 - |n|` so the
 * maxima are creases rather than domes — the difference between a mountain
 * profile and a sine wave.
 */
function ridged(a: number): number {
  const n = Math.sin(a * 3.1 + 0.4) * 0.42
    + Math.sin(a * 7.3 + 2.1) * 0.24
    + Math.sin(a * 13.7 + 4.4) * 0.16
    + Math.sin(a * 27.1 + 1.7) * 0.11
    + Math.sin(a * 49.3 + 5.9) * 0.07;
  return Math.max(0, 1 - Math.abs(n));
}
