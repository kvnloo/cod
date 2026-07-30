/**
 * Ground: streets, the cobbled square, pavements and kerbs, shell craters,
 * tram rails, verges and standing water.
 *
 * All ground layers sample one shared height field, so a crater deforms the
 * asphalt, the cobbles and the puddle in it consistently and nothing floats.
 *
 * Pavements are unioned on a grid before they are meshed — a dozen buildings'
 * expanded footprints overlap heavily, and coplanar overlapping slabs are the
 * classic source of z-fighting in a level built from rectangles.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { Chunk } from '../geom/Chunk';
import { FOOTPRINTS, LANE, MAP, SQUARE } from '../Layout';
import { V2, V3 } from '../geom/Mesher';

export interface Crater {
  x: number; z: number; radius: number; depth: number;
  /** Exposes sub-base: dirt and rubble inside the bowl. */
  dirt?: boolean;
}

/** Shell craters, authored so they break sightlines rather than block routes. */
export const CRATERS: Crater[] = [
  { x: -4.5, z: -14.0, radius: 3.4, depth: 0.62, dirt: true },
  { x: 6.5, z: -2.0, radius: 4.2, depth: 0.78, dirt: true },
  { x: -2.0, z: 11.5, radius: 2.8, depth: 0.48, dirt: true },
  { x: 9.0, z: -25.0, radius: 2.4, depth: 0.42 },
  { x: -10.5, z: 4.0, radius: 2.1, depth: 0.36 },
  { x: -30.0, z: -14.0, radius: 2.6, depth: 0.44, dirt: true },
  { x: 30.5, z: 2.5, radius: 3.0, depth: 0.52, dirt: true },
  { x: 30.0, z: -35.0, radius: 2.2, depth: 0.38 },
  { x: -30.5, z: 26.0, radius: 2.7, depth: 0.46 },
  { x: 2.0, z: 30.5, radius: 2.5, depth: 0.4 },
];

/** Standing water — the map's only mirror surfaces, so they earn their keep. */
export const PUDDLES: { x: number; z: number; rx: number; rz: number }[] = [
  { x: -4.5, z: -14.0, rx: 2.1, rz: 1.7 },
  { x: 6.5, z: -2.0, rx: 2.6, rz: 2.2 },
  { x: -2.0, z: 11.5, rx: 1.6, rz: 1.3 },
  { x: -30.0, z: -14.0, rx: 1.6, rz: 1.4 },
  { x: 30.5, z: 2.5, rx: 1.9, rz: 1.5 },
  { x: -12.0, z: -26.0, rx: 2.2, rz: 1.2 },
  { x: 13.5, z: 8.0, rx: 1.8, rz: 2.4 },
  { x: -29.5, z: 8.5, rx: 2.4, rz: 1.4 },
  { x: 29.0, z: -20.0, rx: 1.5, rz: 2.0 },
];

/** Shared ground height field. Cheap enough to call per vertex and per query. */
export function groundHeightAt(x: number, z: number): number {
  let y = 0;
  for (let i = 0; i < CRATERS.length; i++) {
    const c = CRATERS[i];
    const d = Math.hypot(x - c.x, z - c.z) / c.radius;
    if (d > 1.45) continue;
    const bowl = -c.depth * Math.pow(Math.max(0, 1 - d * d), 1.25);
    const lipT = (d - 0.94) * 4.2;
    const lip = c.depth * 0.32 * Math.exp(-lipT * lipT);
    y += bowl + lip;
  }
  // Very low-amplitude undulation so long tarmac never reads as a flat plane.
  y += 0.035 * Math.sin(x * 0.21 + 1.3) * Math.cos(z * 0.17)
    + 0.018 * Math.sin(x * 0.63 + z * 0.41)
    + 0.012 * Math.cos(x * 1.13 - z * 0.87);
  // Road camber: streets crown slightly toward their centre-lines.
  y += camber(x - LANE.aX, LANE.aHalf) + camber(x - LANE.cX, LANE.cHalf)
    + camber(z - LANE.northZ, LANE.northHalf) + camber(z - LANE.southZ, LANE.southHalf);
  return y;
}

function camber(d: number, half: number): number {
  const t = Math.abs(d) / half;
  return t < 1 ? 0.055 * (1 - t * t) : 0;
}

/* ------------------------------------------------------------ grid union -- */

interface Rect { x0: number; z0: number; x1: number; z1: number; }

/**
 * Rasterises overlapping rectangles on to a grid and greedy-meshes the union
 * back into non-overlapping rectangles.
 */
function gridUnion(rects: Rect[], cell: number, bounds: Rect): { rects: Rect[]; occupied: Uint8Array; w: number; h: number } {
  const w = Math.ceil((bounds.x1 - bounds.x0) / cell);
  const h = Math.ceil((bounds.z1 - bounds.z0) / cell);
  const occ = new Uint8Array(w * h);
  for (const r of rects) {
    const i0 = Math.max(0, Math.floor((r.x0 - bounds.x0) / cell));
    const i1 = Math.min(w - 1, Math.ceil((r.x1 - bounds.x0) / cell) - 1);
    const j0 = Math.max(0, Math.floor((r.z0 - bounds.z0) / cell));
    const j1 = Math.min(h - 1, Math.ceil((r.z1 - bounds.z0) / cell) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) occ[j * w + i] = 1;
  }

  const used = new Uint8Array(w * h);
  const out: Rect[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!occ[j * w + i] || used[j * w + i]) continue;
      let i1 = i;
      while (i1 + 1 < w && occ[j * w + i1 + 1] && !used[j * w + i1 + 1]) i1++;
      let j1 = j;
      outer: while (j1 + 1 < h) {
        for (let k = i; k <= i1; k++) {
          if (!occ[(j1 + 1) * w + k] || used[(j1 + 1) * w + k]) break outer;
        }
        j1++;
      }
      for (let b = j; b <= j1; b++) for (let a = i; a <= i1; a++) used[b * w + a] = 1;
      out.push({
        x0: bounds.x0 + i * cell, z0: bounds.z0 + j * cell,
        x1: bounds.x0 + (i1 + 1) * cell, z1: bounds.z0 + (j1 + 1) * cell,
      });
    }
  }
  return { rects: out, occupied: occ, w, h };
}

/* --------------------------------------------------------------- terrain -- */

export const PAVEMENT_Y = 0.155;
/** Interior ground-floor slabs sit here, clear of the street surface. */
export const INTERIOR_FLOOR_Y = 0.16;

export function buildTerrain(chunk: Chunk): void {
  const rand = new Rand(5101);
  const R = MAP.half + 4;

  /* --- base street surface over the whole map ------------------------- */
  // 0.75 m cells: the resolution is set by the *blend mask*, not the height
  // field — a metre-wide wedge of silt against a wall needs three or four
  // vertices across it to read as a wedge rather than a step.
  chunk.m('asphalt').grid(-R, -R, R, R, Math.round(R * 2 / 0.75), Math.round(R * 2 / 0.75), groundHeightAt, 3.0);

  /* --- cobbled square, laid over the asphalt --------------------------
   * Overlays are raised in millimetre steps rather than sharing a plane: a
   * 24-bit depth buffer at 100 m resolves about 3 cm, and coplanar ground
   * layers are the classic source of shimmering seams at range. */
  const cob = chunk.m('cobble');
  cob.grid(
    SQUARE.x0 - 1.5, SQUARE.z0 - 1.5, SQUARE.x1 + 1.5, SQUARE.z1 + 1.5,
    Math.round((SQUARE.x1 - SQUARE.x0 + 3) / 0.85), Math.round((SQUARE.z1 - SQUARE.z0 + 3) / 0.85),
    (x, z) => groundHeightAt(x, z) + 0.045, 0.8,
  );

  /* --- granite edging around the square -------------------------------
   * The cobbles used to end on a bare straight line against the tarmac: a
   * 30 m seam running diagonally through the hero shot with nothing to explain
   * it. Every real setted square is contained by a course of kerbstones, and a
   * 30 cm dark band both hides the join and gives the ground plane a drawn
   * edge to read against. */
  const edge = chunk.m('setts');
  const ex0 = SQUARE.x0 - 1.5, ex1 = SQUARE.x1 + 1.5;
  const ez0 = SQUARE.z0 - 1.5, ez1 = SQUARE.z1 + 1.5;
  const band = 0.34;
  for (const [ax, az, bx, bz] of [
    [ex0 - band, ez0 - band, ex1 + band, ez0], [ex0 - band, ez1, ex1 + band, ez1 + band],
    [ex0 - band, ez0, ex0, ez1], [ex1, ez0, ex1 + band, ez1],
  ] as const) {
    edge.grid(ax, az, bx, bz,
      Math.max(1, Math.round((bx - ax) / 1.4)), Math.max(1, Math.round((bz - az) / 1.4)),
      (x, z) => groundHeightAt(x, z) + 0.05, 0.7);
  }

  /* --- worn asphalt patches: break the uniform tarmac ----------------- */
  const worn = chunk.m('asphaltWorn');
  for (let i = 0; i < 26; i++) {
    const cx = rand.range(-50, 50);
    const cz = rand.range(-50, 50);
    if (insideAnyFootprint(cx, cz, 1.5)) continue;
    if (inSquare(cx, cz, 4)) continue;      // the square is cobbled, not tarmac
    const rx = rand.range(1.6, 5.5), rz = rand.range(1.6, 5.5);
    worn.grid(cx - rx, cz - rz, cx + rx, cz + rz, 3, 3, (x, z) => groundHeightAt(x, z) + 0.02, 3.0);
  }

  /* --- gravel / dirt in the craters ----------------------------------- */
  const dirt = chunk.m('dirt');
  const grav = chunk.m('gravel');
  for (const c of CRATERS) {
    if (!c.dirt) continue;
    // Only the bowl itself, and only where the paving is actually gone.
    //
    // This used to run to the full crater radius with a −0.35 m drop outside
    // 0.92, which drew a hard-edged orange disc on top of the cobbles with a
    // visible sunburst of skirt triangles around it. The transition from paving
    // to exposed sub-base is now the ground's own vertex blend; the mesh only
    // covers the part that is genuinely dirt.
    const r = c.radius * 0.86;
    const n = Math.max(10, Math.round(c.radius * 5));
    dirt.grid(c.x - r, c.z - r, c.x + r, c.z + r, n, n,
      (x, z) => {
        // Always clear of the paving until the very rim, then a fast plunge
        // under it. A flat shelf a few millimetres *below* the cobbles let them
        // punch back through in a scale pattern around the whole bowl.
        const d = Math.hypot(x - c.x, z - c.z) / r;
        const t = Math.max(0, (d - 0.78) / 0.22);
        return groundHeightAt(x, z) + 0.075 - t * t * 1.1;
      }, 2.2);
  }
  for (let i = 0; i < 14; i++) {
    const cx = rand.range(-48, 48), cz = rand.range(-48, 48);
    if (insideAnyFootprint(cx, cz, 2.0)) continue;
    const rx = rand.range(1.2, 3.4), rz = rand.range(1.2, 3.4);
    grav.grid(cx - rx, cz - rz, cx + rx, cz + rz, 3, 3, (x, z) => groundHeightAt(x, z) + (inSquare(cx, cz, 2) ? 0.058 : 0.03), 1.6);
  }

  /* --- blast scorch ----------------------------------------------------
   * Every crater gets a burnt collar and a few radial fingers of soot thrown
   * downwind. This is the cheapest damage-storytelling there is: a shell hole
   * with clean paving around it reads as a dent, not as a detonation. */
  const scorch = chunk.m('scorch');
  for (const c of CRATERS) {
    const spread = c.radius * 1.9;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const rIn = c.radius * 0.84;
      // Ragged outer edge — a clean disc of soot is worse than none.
      const kA = 0.55 + 0.45 * Math.abs(Math.sin(a0 * 2.3 + c.x));
      const kB = 0.55 + 0.45 * Math.abs(Math.sin(a1 * 2.3 + c.x));
      const rA = rIn + spread * kA, rB = rIn + spread * kB;
      const p = (ax: number, r: number) => {
        const x = c.x + Math.cos(ax) * r, z = c.z + Math.sin(ax) * r;
        return V3(x, groundHeightAt(x, z) + 0.052, z);
      };
      scorch.quad(p(a0, rIn), p(a1, rIn), p(a1, rB), p(a0, rA), 3.0, false);
    }
  }

  /* --- pavements and kerbs -------------------------------------------- */
  const pave: Rect[] = [];
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    pave.push({ x0: f.x0 - 2.2, z0: f.z0 - 2.2, x1: f.x1 + 2.2, z1: f.z1 + 2.2 });
  }
  const bounds: Rect = { x0: -R, z0: -R, x1: R, z1: R };
  const cell = 0.55;
  const union = gridUnion(pave, cell, bounds);
  // Clear everything inside a building footprint: the pavement is a ring, so it
  // never fights with the interior floor slab a few centimetres above it.
  clearFootprints(union, cell, bounds, 0.2);
  const pv = chunk.m('pavement');
  for (const r of union.rects) {
    const nx = Math.max(1, Math.round((r.x1 - r.x0) / 1.0));
    const nz = Math.max(1, Math.round((r.z1 - r.z0) / 1.0));
    pv.grid(r.x0, r.z0, r.x1, r.z1, nx, nz, (x, z) => groundHeightAt(x, z) + PAVEMENT_Y, 1.35);
  }
  /* --- pavement breakup ------------------------------------------------
   * A concrete slab material tiling across a 20 m alley reads as one
   * featureless cream plane no matter how good the tile is — there is nothing
   * at the metre scale for the eye to lock on to. Patches of ground-in grit and
   * silt laid *over* the pavement (a few millimetres proud, so they never
   * z-fight it) give it that scale, and they land where traffic and water
   * actually put them: against the kerb line and in the service alleys. */
  const grit = chunk.m('gravel');
  const silt = chunk.m('dirt');
  for (let i = 0; i < 46; i++) {
    const cx = rand.range(-50, 50), cz = rand.range(-50, 50);
    const d = distanceToFootprints(cx, cz);
    if (d < 0.4 || d > 2.4) continue;               // only on the pavement ring
    const rx = rand.range(0.9, 2.8), rz = rand.range(0.9, 2.8);
    const m = rand.bool(0.55) ? grit : silt;
    m.grid(cx - rx, cz - rz, cx + rx, cz + rz, 3, 3,
      (x, z) => groundHeightAt(x, z) + PAVEMENT_Y + 0.006, 1.5);
  }

  // Kerb along every outward-facing cell edge of the union.
  const kb = chunk.m('kerb');
  const { occupied, w, h } = union;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : occupied[j * w + i]);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!occupied[j * w + i]) continue;
      const x0 = bounds.x0 + i * cell, z0 = bounds.z0 + j * cell;
      const x1 = x0 + cell, z1 = z0 + cell;
      const y = groundHeightAt((x0 + x1) * 0.5, (z0 + z1) * 0.5);
      if (!at(i - 1, j)) kb.boxMinMax(x0 - 0.11, y - 0.3, z0, x0 + 0.03, y + PAVEMENT_Y + 0.01, z1, 1.1);
      if (!at(i + 1, j)) kb.boxMinMax(x1 - 0.03, y - 0.3, z0, x1 + 0.11, y + PAVEMENT_Y + 0.01, z1, 1.1);
      if (!at(i, j - 1)) kb.boxMinMax(x0, y - 0.3, z0 - 0.11, x1, y + PAVEMENT_Y + 0.01, z0 + 0.03, 1.1);
      if (!at(i, j + 1)) kb.boxMinMax(x0, y - 0.3, z1 - 0.03, x1, y + PAVEMENT_Y + 0.01, z1 + 0.11, 1.1);
    }
  }

  /* --- tram track ------------------------------------------------------
   * Street tramway, not a railway: grooved rail set flush into a bed of dark
   * granite setts, the way every Eastern-European town square carries its
   * tracks. Sleepers are buried and stay buried — the earlier version laid them
   * *on* the cobbles at one sampled height, which floated them over the camber
   * and the crater lips and read as untextured placeholder bars.
   *
   * The only exposed timber is where the blast lifted the paving: one short
   * run of ripped-up track beside the crater, which is storytelling rather
   * than an accident. */
  const bed = chunk.m('setts');
  const rail = chunk.m('steel');
  const trackZ0 = SQUARE.z0 - 2, trackZ1 = SQUARE.z1 + 24;
  const gauge = 1.55;
  // Bed follows the ground exactly: sampled per corner, so no gaps.
  bed.grid(-2.35, trackZ0, 2.35, trackZ1, 6, Math.round((trackZ1 - trackZ0) / 1.3),
    (x, z) => groundHeightAt(x, z) + 0.048, 0.85);
  for (const rx of [-gauge, gauge]) {
    for (let z = trackZ0; z < trackZ1; z += 1.5) {
      const zEnd = Math.min(z + 1.5, trackZ1);
      // Bottom from the lower end, top from the higher one: the rail is welded
      // continuous, so consecutive segments must overlap rather than step.
      const ya = groundHeightAt(rx, z) + 0.048;
      const yb = groundHeightAt(rx, zEnd) + 0.048;
      const lo = Math.min(ya, yb) - 0.05;
      const hi = Math.max(ya, yb) + 0.014;
      // Head and groove lip: two thin ribbons either side of the flangeway.
      for (const off of [-0.032, 0.032]) {
        rail.boxMinMax(rx + off - 0.017, lo, z, rx + off + 0.017, hi, zEnd, 0.6);
      }
    }
  }
  // Ripped-up section: blast-lifted paving, exposed sleepers and bent rail.
  const tie = chunk.m('wood');
  const ballast = chunk.m('gravel');
  const ripZ0 = -12.5, ripZ1 = -5.5;
  ballast.grid(-2.5, ripZ0, 2.5, ripZ1, 4, 8, (x, z) => groundHeightAt(x, z) + 0.055, 1.4);
  for (let z = ripZ0 + 0.4; z < ripZ1; z += 0.72) {
    const lean = ((z * 7.3) % 1) - 0.5;
    const lift = Math.max(0, 0.16 - Math.abs(z + 9) * 0.03);
    tie.pushTRS(0, groundHeightAt(0, z) + 0.06 + lift, z, lean * 0.22, 0, lean * 0.14);
    tie.box(0, 0.055, 0, 1.28, 0.055, 0.1, 1.0);
    tie.pop();
  }

  /* --- faded road markings -------------------------------------------- */
  const paint = chunk.m('stoneTrim');
  for (const [lx, z0, z1] of [[LANE.aX, -52, 52], [LANE.cX, -52, 52]] as const) {
    for (let z = z0; z < z1; z += 4.5) {
      if (insideAnyFootprint(lx, z, 0.5)) continue;
      const y = groundHeightAt(lx, z + 1.1);
      paint.boxMinMax(lx - 0.07, y + 0.012, z, lx + 0.07, y + 0.028, z + 2.2, 2.0);
    }
  }

  /* --- verges: dry grass at the base of the boundary ruins ------------- */
  const grass = chunk.m('grass');
  for (const [ax, az, bx, bz] of [
    [-52, -52, 52, -49], [-52, 49, 52, 52], [-52, -49, -49, 49], [49, -49, 52, 49],
  ] as const) {
    grass.grid(ax, az, bx, bz, Math.max(1, Math.round((bx - ax) / 3)), Math.max(1, Math.round((bz - az) / 3)),
      (x, z) => groundHeightAt(x, z) + 0.05, 2.2);
  }

  /* --- standing water --------------------------------------------------*/
  const water = chunk.m('puddle');
  for (const p of PUDDLES) {
    const n = 6;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const k = 0.82 + 0.18 * Math.sin(a * 3 + p.x);
      pts.push(V2(p.x + Math.cos(a) * p.rx * k, p.z + Math.sin(a) * p.rz * k));
    }
    const y = lowestIn(p.x, p.z, Math.max(p.rx, p.rz)) + 0.025;
    water.extrude(pts, y - 0.02, y, 2.4, true, false, false);
    void n;
  }
}

/** True when (x,z) is inside the cobbled square, with a margin. */
function inSquare(x: number, z: number, margin: number): boolean {
  return x > SQUARE.x0 - 1.5 - margin && x < SQUARE.x1 + 1.5 + margin
    && z > SQUARE.z0 - 1.5 - margin && z < SQUARE.z1 + 1.5 + margin;
}

function clearFootprints(
  union: { rects: Rect[]; occupied: Uint8Array; w: number; h: number },
  cell: number, bounds: Rect, inset: number,
): void {
  const kept: Rect[] = [];
  for (const r of union.rects) {
    for (const k in FOOTPRINTS) {
      const f = FOOTPRINTS[k];
      // Split the rect around the footprint by clipping; rects that end up
      // fully inside a footprint are dropped.
      if (r.x0 >= f.x0 + inset && r.x1 <= f.x1 - inset && r.z0 >= f.z0 + inset && r.z1 <= f.z1 - inset) {
        r.x1 = r.x0; // mark as empty
        break;
      }
    }
    if (r.x1 - r.x0 > 1e-4 && r.z1 - r.z0 > 1e-4) kept.push(r);
  }
  union.rects.length = 0;
  for (const r of kept) union.rects.push(r);
  // Also clear the occupancy grid so kerbs are not generated inside buildings.
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    const i0 = Math.max(0, Math.ceil((f.x0 + inset - bounds.x0) / cell));
    const i1 = Math.min(union.w - 1, Math.floor((f.x1 - inset - bounds.x0) / cell) - 1);
    const j0 = Math.max(0, Math.ceil((f.z0 + inset - bounds.z0) / cell));
    const j1 = Math.min(union.h - 1, Math.floor((f.z1 - inset - bounds.z0) / cell) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) union.occupied[j * union.w + i] = 0;
  }
}

function lowestIn(x: number, z: number, r: number): number {
  let lo = Infinity;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const h = groundHeightAt(x + Math.cos(a) * r * 0.6, z + Math.sin(a) * r * 0.6);
    if (h < lo) lo = h;
  }
  return Math.min(lo, groundHeightAt(x, z));
}

/** Distance from the nearest building footprint edge (0 when inside one). */
function distanceToFootprints(x: number, z: number): number {
  let best = Infinity;
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    const dx = Math.max(f.x0 - x, 0, x - f.x1);
    const dz = Math.max(f.z0 - z, 0, z - f.z1);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

function insideAnyFootprint(x: number, z: number, margin: number): boolean {
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    if (x > f.x0 - margin && x < f.x1 + margin && z > f.z0 - margin && z < f.z1 + margin) return true;
  }
  return false;
}
