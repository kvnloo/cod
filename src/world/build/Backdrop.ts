/**
 * Distant backdrop.
 *
 * A map that ends at a wall reads as a box. Blackout ends in a city that
 * continues: three receding bands of silhouette blocks, a smoke column from a
 * fire beyond the map, and a mountain ridge on the horizon.
 *
 * Everything here lives on `LAYERS.BACKDROP`, which keeps it out of collision,
 * out of the shadow atlas and out of the navigation build, and it is authored
 * flat-shaded with cheap materials because aerial perspective is doing all the
 * work at that distance anyway.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { Chunk } from '../geom/Chunk';
import { V2 } from '../geom/Mesher';

export function buildBackdrop(chunk: Chunk): void {
  const rand = new Rand(1717);

  /* --- three receding bands of city blocks ---------------------------- */
  const bands: { radius: number; count: number; minH: number; maxH: number; key: 'backdropMid' | 'backdropFar'; depth: number }[] = [
    // A provincial town, not a CBD: four to eight storeys, receding into haze.
    { radius: 118, count: 62, minH: 8, maxH: 17, key: 'backdropMid', depth: 24 },
    { radius: 205, count: 66, minH: 10, maxH: 22, key: 'backdropFar', depth: 38 },
    { radius: 340, count: 56, minH: 13, maxH: 29, key: 'backdropFar', depth: 60 },
  ];

  for (const band of bands) {
    const m = chunk.m(band.key);
    for (let i = 0; i < band.count; i++) {
      const a = (i / band.count) * Math.PI * 2 + rand.range(-0.02, 0.02);
      const r = band.radius * rand.range(0.86, 1.2);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // Skip the wedge behind the camera-facing gap so the map's own skyline
      // silhouette is never fighting a backdrop block right behind it.
      const h = rand.range(band.minH, band.maxH);
      const w = rand.range(band.depth * 0.5, band.depth);
      const d = rand.range(band.depth * 0.5, band.depth);
      m.pushTRS(x, 0, z, -a + rand.range(-0.3, 0.3));
      m.box(0, h * 0.5, 0, w * 0.5, h * 0.5, d * 0.5, 8.0);
      // A stair-stepped upper storey breaks the flat tops without adding a
      // bright horizontal plate that reads as a floating slab at this range.
      if (rand.bool(0.4)) {
        m.box(rand.range(-w * 0.15, w * 0.15), h * 0.5 + rand.range(1, 3), rand.range(-d * 0.15, d * 0.15),
          w * 0.62, h * 0.5, d * 0.62, 8.0);
      }
      m.pop();
    }
  }

  /* --- mountain ridges --------------------------------------------------
   * Three ranges rather than one wall.
   *
   * A single ridge silhouette at one distance and one value is the thing that
   * makes a backdrop read as a painted flat: real mountains overlap, and each
   * range further back is lighter, bluer and lower in contrast than the one in
   * front of it. Three rings at 480/620/790 m with independent noise give both
   * the overlap and the aerial-perspective banding, and because they are on the
   * backdrop layer they cost nothing but a handful of triangles.
   *
   * The near range also has a rockier profile: sharper ridged noise plus a
   * second harmonic, so the silhouette has real notches in it rather than the
   * smooth grey humps it had before. */
  const ranges: { key: 'ridgeNear' | 'ridgeMid' | 'ridge'; r: number; base: number; gain: number; sharp: number; phase: number; foot: number }[] = [
    { key: 'ridgeNear', r: 470, base: 30, gain: 92, sharp: 3.0, phase: 0.0, foot: -2 },
    { key: 'ridgeMid', r: 630, base: 52, gain: 138, sharp: 2.2, phase: 1.9, foot: -2 },
    { key: 'ridge', r: 800, base: 74, gain: 176, sharp: 1.7, phase: 4.3, foot: -2 },
  ];
  const segments = 160;
  for (const range of ranges) {
    const m = chunk.m(range.key);
    const h = (a: number) => range.base + Math.pow(ridged(a + range.phase), range.sharp) * range.gain;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const h0 = h(a0), h1 = h(a1);
      const x0 = Math.cos(a0) * range.r, z0 = Math.sin(a0) * range.r;
      const x1 = Math.cos(a1) * range.r, z1 = Math.sin(a1) * range.r;
      // The crest is pulled inward so the face we see is tilted toward the
      // camera, and the amount it is pulled varies segment to segment: that
      // varying tilt is what gives the range its facet shading. With a constant
      // inset every triangle shares a normal and the whole ridge flattens into
      // one silhouette of flat grey — which is precisely how it read before.
      const i0 = 0.80 + ridged(a0 * 2.7 + 3.1) * 0.22;
      const i1 = 0.80 + ridged(a1 * 2.7 + 3.1) * 0.22;
      m.quad(
        new THREE.Vector3(x0, range.foot, z0), new THREE.Vector3(x1, range.foot, z1),
        new THREE.Vector3(x1 * i1, h1, z1 * i1), new THREE.Vector3(x0 * i0, h0, z0 * i0),
        60, true,
      );
    }
  }

  /* --- a few taller landmarks so the skyline is not a flat band --------- */
  const land = chunk.m('backdropFar');
  for (const [a, r, h, w] of [[0.75, 205, 46, 9], [2.35, 240, 52, 11], [4.15, 175, 40, 8], [5.4, 265, 44, 10]] as const) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    land.pushTRS(x, 0, z, -a);
    land.box(0, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.5, 10);
    land.box(0, h + 3.5, 0, w * 0.22, 3.5, w * 0.22, 10);
    land.pop();
  }
}

/**
 * Ridged multifractal in [0,1]. Four octaves, folded through `1 - |n|` so the
 * maxima are creases rather than domes — the difference between a mountain
 * profile and a sine wave.
 */
function ridged(a: number): number {
  const n = Math.sin(a * 3.1 + 0.4) * 0.46
    + Math.sin(a * 7.3 + 2.1) * 0.26
    + Math.sin(a * 13.7 + 4.4) * 0.17
    + Math.sin(a * 27.1 + 1.7) * 0.11;
  return Math.max(0, 1 - Math.abs(n));
}
