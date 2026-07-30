/**
 * Grounding — the vertex-blend masks that stop the level looking pasted
 * together.
 *
 * Two of the seven tells on the visual bar are really the same problem: nothing
 * darkens where two surfaces meet, and every surface is one uniform material.
 * Both are answered here, at build time, with a weight written into the
 * geometry's colour attribute:
 *
 *  - **Ground** (asphalt, cobbles, pavement) blends toward `dirt` wherever
 *    something vertical meets it: wall bases, kerb lines, crater rims, the
 *    trackbed. Real streets have a wedge of silt banked against every wall.
 *  - **Facades** blend toward the masonry behind the render. Blown plaster
 *    concentrates at the base (rising damp and splash), around shell damage and
 *    along ragged edges — never uniformly, which is the whole point.
 *
 * The noise here is a hash lattice rather than `Rand`: the mask has to be a
 * *function of position*, evaluated independently per vertex by several callers,
 * so a sequential stream would give a different answer every time.
 */

import { CRATERS, groundHeightAt } from './Terrain';
import { distanceToBuildings } from '../Layout';

/* ------------------------------------------------------------- lattice -- */

function hash3(i: number, j: number, k: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x85ebca6b) ^ Math.imul(k | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function fade(t: number): number { return t * t * (3 - 2 * t); }

/** Trilinear value noise in [0,1]. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz ? zf : 1 - zf;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? yf : 1 - yf;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? xf : 1 - xf;
        acc += hash3(xi + dx, yi + dy, zi + dz) * wx * wy * wz;
      }
    }
  }
  return acc;
}

/** Two-octave fractal value noise in [0,1]. */
export function fbm3(x: number, y: number, z: number): number {
  return noise3(x, y, z) * 0.66 + noise3(x * 2.17 + 11.3, y * 2.17 + 5.1, z * 2.17 - 7.7) * 0.34;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/* ---------------------------------------------------------------- ground */

/**
 * Silt / spoil weight for a point on the street surface.
 *
 * Peaks against building walls, along the crater rims where the sub-base was
 * thrown out, and in the low spots the undulation makes. Broken up by noise at
 * two scales so the transition never reads as an offset outline of the
 * footprint.
 */
export function groundGrime(x: number, z: number): number {
  const d = distanceToBuildings(x, z);

  // Banked against every facade: a hard inner half-metre, feathering out to
  // ~1.8 m. Wider than that and it stops being a wedge of silt and starts
  // being a mud street.
  let w = smooth(1.8, 0.05, d) * 0.9;

  // Crater ejecta: a narrow collar of thrown sub-base just outside the lip.
  for (let i = 0; i < CRATERS.length; i++) {
    const c = CRATERS[i];
    const r = Math.hypot(x - c.x, z - c.z) / c.radius;
    if (r > 1.45) continue;
    const ring = smooth(0.62, 0.9, r) * smooth(1.42, 0.98, r);
    w = Math.max(w, ring * (c.dirt ? 0.95 : 0.6));
  }

  // Water and silt collect in the hollows.
  const y = groundHeightAt(x, z);
  w = Math.max(w, smooth(-0.02, -0.11, y) * 0.5);

  // Break the outline: patchy at 3 m, grainy at 0.7 m.
  const patch = fbm3(x * 0.33, 0, z * 0.33);
  const grain = noise3(x * 1.4, 0, z * 1.4);
  w *= 0.25 + 1.2 * patch;
  w += (grain - 0.5) * 0.2;
  return Math.max(0, Math.min(1, w));
}

/* --------------------------------------------------------------- facades */

/**
 * Blown-render / grime weight for a point on a facade.
 *
 * `baseY` is the level the wall stands on, so an interior partition on the
 * first floor gets its own splash zone rather than inheriting the street's.
 */
export function facadeDamage(x: number, y: number, z: number, baseY = 0): number {
  const h = y - baseY;

  // Raw field: a bias that rises toward the base (rising damp and splash always
  // take the render off there first), plus metre-scale patches, plus a fine
  // grain that makes every edge ragged.
  const patch = fbm3(x * 0.22, y * 0.17, z * 0.22);
  const grain = noise3(x * 2.6, y * 2.6, z * 2.6);
  const raw = patch
    + smooth(1.6, 0.15, h) * 0.30
    + (grain - 0.5) * 0.22;

  // Thresholded, *not* ramped.
  //
  // A continuous weight is the wrong answer here: the blend is height-aware, so
  // at any mid weight the substrate wins inside every hairline crack and the
  // wall ends up veined like marble. Render either has fallen off a patch or it
  // has not — so the mask is pushed to the ends with a narrow transition, which
  // gives hard-edged patches with a ragged outline, exactly like real spalled
  // stucco.
  return smooth(0.545, 0.635, raw);
}

/**
 * The same idea for a wall that stands on the raised terrace or an upper floor:
 * a curried variant so callers can pass it straight to `Chunk.emit`.
 */
export function facadeDamageAt(baseY: number): (x: number, y: number, z: number) => number {
  return (x, y, z) => facadeDamage(x, y, z, baseY);
}
