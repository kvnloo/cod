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

  /* --- mountain ridge -------------------------------------------------- */
  const ridge = chunk.m('ridge');
  const R = 620;
  const segments = 128;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(V2(Math.cos(a) * R, Math.sin(a) * R));
  }
  // A ring of peaks: two octaves of ridged noise around the horizon.
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const h0 = ridgeHeight(a0);
    const h1 = ridgeHeight(a1);
    const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R;
    const x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
    const inset = 0.86;
    ridge.quad(
      new THREE.Vector3(x0, -2, z0), new THREE.Vector3(x1, -2, z1),
      new THREE.Vector3(x1 * inset, h1, z1 * inset), new THREE.Vector3(x0 * inset, h0, z0 * inset),
      60, true,
    );
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

function ridgeHeight(a: number): number {
  const n = Math.sin(a * 3.1 + 0.4) * 0.5 + Math.sin(a * 7.3 + 2.1) * 0.28 + Math.sin(a * 13.7 + 4.4) * 0.14;
  const ridged = 1 - Math.abs(n);
  return 55 + Math.pow(ridged, 2.2) * 150;
}
