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
import { V2, V3, type Mesher } from '../geom/Mesher';

export interface Crater {
  x: number; z: number; radius: number; depth: number;
  /** Exposes sub-base: dirt and rubble inside the bowl. */
  dirt?: boolean;
}

/** Shell craters, authored so they break sightlines rather than block routes. */
export const CRATERS: Crater[] = [
  { x: -4.5, z: -14.0, radius: 3.4, depth: 0.88, dirt: true },
  { x: 6.5, z: -2.0, radius: 4.2, depth: 1.02, dirt: true },
  { x: -2.0, z: 11.5, radius: 2.8, depth: 0.70, dirt: true },
  { x: 9.0, z: -25.0, radius: 2.4, depth: 0.54 },
  { x: -10.5, z: 4.0, radius: 2.1, depth: 0.46 },
  { x: -30.0, z: -14.0, radius: 2.6, depth: 0.62, dirt: true },
  { x: 30.5, z: 2.5, radius: 3.0, depth: 0.74, dirt: true },
  { x: 30.0, z: -35.0, radius: 2.2, depth: 0.48 },
  { x: -30.5, z: 26.0, radius: 2.7, depth: 0.60 },
  { x: 2.0, z: 30.5, radius: 2.5, depth: 0.52 },
];

/* ------------------------------------------------------- level changes -- */

/**
 * The square is a *raised plaza*, not paint on the road surface.
 *
 * The whole playable area used to be one plane at y ≈ 0 with asphalt, cobble
 * and dirt painted on to it, and the single loudest tell in the wide shots was
 * that nothing anywhere had a vertical edge. A real setted square is a kerbed
 * island: the paving stands one kerb height above the carriageway, and the
 * tram runs down a sunken lane through the middle of it with a granite kerb on
 * each side. That gives the map three continuous 50 m shadow lines through the
 * hero sightline and a real step everywhere the surfaces change.
 *
 * 0.145 m is a kerb, not a wall — it is the standard 15 cm the visual bar asks
 * for, and it stays under the character controller's step height.
 */
export const PLAZA = {
  x0: SQUARE.x0 - 1.5, x1: SQUARE.x1 + 1.5,
  z0: SQUARE.z0 - 1.5, z1: SQUARE.z1 + 1.5,
  /** Half-width of the tram carriageway cut through the plaza. */
  trackHalf: 3.6,
  lift: 0.145,
  /** Width of the height-field transition, hidden behind the kerb face. */
  ramp: 0.42,
} as const;

function edge01(d: number): number {
  return d <= 0 ? 0 : d >= PLAZA.ramp ? 1 : d / PLAZA.ramp;
}

/** Height added by the raised plaza at (x,z). Zero everywhere else. */
export function plazaLift(x: number, z: number, footDist = footprintDistance(x, z)): number {
  const inside = edge01(x - PLAZA.x0) * edge01(PLAZA.x1 - x)
    * edge01(z - PLAZA.z0) * edge01(PLAZA.z1 - z)
    // Never lift under a pavement ring: the plaza kerb line then falls exactly
    // where the shopfront pavement already ends, so the two read as one
    // continuous footway rather than two steps 40 cm apart.
    * edge01(footDist - 2.35);
  if (inside <= 0) return 0;
  // The tram carriageway stays at street level all the way through.
  const lane = 1 - edge01(Math.abs(x) - PLAZA.trackHalf);
  return PLAZA.lift * inside * (1 - lane);
}

/** Distance to the nearest building footprint edge; 0 when inside one. */
function footprintDistance(x: number, z: number): number {
  let best = Infinity;
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    const dx = Math.max(f.x0 - x, 0, x - f.x1);
    const dz = Math.max(f.z0 - z, 0, z - f.z1);
    const d = dx === 0 && dz === 0 ? 0 : Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Gutter: a shallow dished channel against each kerb line of the two flanking
 * streets. Streets drain somewhere, and a 6 cm dish running the length of a
 * lane is a continuous highlight/shadow pair that a flat plane cannot give.
 */
function gutter(d: number, half: number): number {
  const t = Math.abs(d);
  const g = half - 0.55;
  if (t < g - 0.5 || t > half) return 0;
  const k = Math.max(0, 1 - Math.abs(t - g) / 0.5);
  return -0.055 * k * k * (3 - 2 * k);
}

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
    if (d > 1.55) continue;
    // Exponent below 1 holds the depth out toward the rim and then drops it
    // fast, which is the profile a shell actually leaves: a flattish floor of
    // spoil and a steep wall. The old 1.25 gave a saucer you could read
    // straight through.
    const bowl = -c.depth * Math.pow(Math.max(0, 1 - d * d), 0.72);
    const lipT = (d - 1.0) * 5.0;
    const lip = c.depth * 0.20 * Math.exp(-lipT * lipT);
    y += bowl + lip;
  }
  // Long-wavelength fall across the site, plus two finer octaves. A block of a
  // real town has the best part of a metre of relief across it; this is the
  // slow part of it, damped to nothing against every building so the facades
  // stay planted on their plinths.
  const fd = footprintDistance(x, z);
  const relief = 0.30 * Math.sin(x * 0.031 + 0.7) * Math.cos(z * 0.026 - 1.1)
    + 0.16 * Math.sin(x * 0.058 - z * 0.047 + 2.3)
    + 0.055 * Math.sin(x * 0.21 + 1.3) * Math.cos(z * 0.17);
  y += relief * plinthMask(fd);
  y += 0.02 * Math.sin(x * 0.63 + z * 0.41) + 0.013 * Math.cos(x * 1.13 - z * 0.87);
  // Road camber and kerb-side gutters: streets crown toward their centre-lines
  // and dish out again against the kerb.
  y += camber(x - LANE.aX, LANE.aHalf) + camber(x - LANE.cX, LANE.cHalf)
    + camber(z - LANE.northZ, LANE.northHalf) + camber(z - LANE.southZ, LANE.southHalf);
  y += gutter(x - LANE.aX, LANE.aHalf) + gutter(x - LANE.cX, LANE.cHalf)
    + gutter(z - LANE.northZ, LANE.northHalf) + gutter(z - LANE.southZ, LANE.southHalf);
  y += plazaLift(x, z, fd);
  return y;
}

/**
 * Fades the long-wavelength relief out near any building so walls that are
 * authored from y = 0 never end up floating or buried. Full strength past
 * ~6 m from a facade, zero inside the pavement ring.
 */
function plinthMask(footDist: number): number {
  const t = Math.max(0, Math.min(1, (footDist - 2.6) / 3.4));
  return t * t * (3 - 2 * t);
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

  /* --- granite kerbs -------------------------------------------------
   * The plaza is raised, so its edge is a real course of kerbstones with a
   * vertical face, not a painted line. Three runs matter:
   *
   *  - the north and south ends of the square, where nothing else edges it;
   *  - both sides of the tram carriageway, which puts two continuous 56 m
   *    granite lines straight down the hero sightline — the single biggest
   *    change to the ground read;
   *  - the two flanking streets, where the kerb sits against the gutter.
   *
   * The long east/west sides are already edged by the shopfront pavements, so
   * a kerb there would be a second step 40 cm from the first. */
  const kerbStone = chunk.m('setts');
  const zTrack0 = PLAZA.z0, zTrack1 = PLAZA.z1;
  // `out` points at the low side: for the west kerb of the carriageway that is
  // +x, for the east kerb −x.
  kerbAlongZ(kerbStone, -PLAZA.trackHalf, zTrack0, zTrack1, 1);
  kerbAlongZ(kerbStone, PLAZA.trackHalf, zTrack0, zTrack1, -1);
  for (const [zLine, out] of [[PLAZA.z0, -1], [PLAZA.z1, 1]] as const) {
    kerbAlongX(kerbStone, PLAZA.x0, -PLAZA.trackHalf - 0.2, zLine, out);
    kerbAlongX(kerbStone, PLAZA.trackHalf + 0.2, PLAZA.x1, zLine, out);
  }
  // Corner returns so the plaza edge turns rather than stopping in mid-air.
  for (const sx of [-1, 1] as const) {
    kerbAlongZ(kerbStone, sx * (PLAZA.x1 - 0.02), PLAZA.z0, PLAZA.z0 + 2.6, sx);
    kerbAlongZ(kerbStone, sx * (PLAZA.x1 - 0.02), PLAZA.z1 - 2.6, PLAZA.z1, sx);
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
   * A burnt collar just outside the lip, plus a handful of narrow radial
   * fingers thrown downwind.
   *
   * This used to run from 0.84r out to 2.7r with a ragged sinusoidal edge —
   * a near-black disc eleven metres across around the big crater, which is
   * what drew the scalloped "amoeba" outlines cutting across the cobbles in
   * every wide shot. Soot from a shell is a collar a metre or two wide with
   * streaks; it is not a lake. */
  const scorch = chunk.m('scorch');
  for (const c of CRATERS) {
    const n = 30;
    const rIn = c.radius * 0.92;
    const spread = Math.min(c.radius * 0.45, 1.5);
    const p = (ax: number, r: number) => {
      const x = c.x + Math.cos(ax) * r, z = c.z + Math.sin(ax) * r;
      return V3(x, groundHeightAt(x, z) + 0.052, z);
    };
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const kA = 0.35 + 0.65 * Math.abs(Math.sin(a0 * 3.7 + c.x));
      const kB = 0.35 + 0.65 * Math.abs(Math.sin(a1 * 3.7 + c.x));
      scorch.quad(p(a0, rIn), p(a1, rIn), p(a1, rIn + spread * kB), p(a0, rIn + spread * kA), 3.0, false);
    }
    // Four narrow streaks of soot thrown clear of the collar.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + c.x * 0.7;
      const half = 0.10 + 0.05 * ((i * 7 + c.z) % 1);
      const len = c.radius * (1.5 + 0.9 * ((i * 13 + c.x) % 1));
      scorch.quad(
        p(a - half, rIn), p(a + half, rIn),
        p(a + half * 0.35, rIn + len), p(a - half * 0.35, rIn + len), 3.0, false);
    }
  }

  /* --- crater rim: displaced paving and ejecta -------------------------
   * A shell does not paint a disc on the road, it lifts the paving. Every
   * crater gets a ring of slabs tipped up out of the ground on the lip, spoil
   * mounded between them and a scatter of thrown blocks outside — which is
   * what gives the hole a silhouette against the horizon instead of reading
   * as a stain you could walk across. */
  const slab = chunk.m('setts');
  const spoil = chunk.m('dirt');
  const lump = chunk.m('concreteDark');
  for (const c of CRATERS) {
    const rr = new Rand(`crater:${c.x}:${c.z}`);
    const ring = Math.round(9 + c.radius * 3.4);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + rr.range(-0.16, 0.16);
      const r = c.radius * rr.range(0.94, 1.12);
      const px = c.x + Math.cos(a) * r, pz = c.z + Math.sin(a) * r;
      const py = groundHeightAt(px, pz);
      if (rr.bool(0.58)) {
        // A flag of paving levered up on its outer edge and left leaning: the
        // hinge stays in the ground, so it reads as *displaced* paving rather
        // than as a piece of wall someone stood on end.
        const tilt = rr.range(0.45, 1.05);
        const w = rr.range(0.20, 0.40), t = rr.range(0.035, 0.065);
        slab.pushTRS(px, py - 0.03, pz, a + Math.PI / 2 + rr.range(-0.35, 0.35), -tilt, rr.range(-0.3, 0.3));
        slab.box(0, w * 0.5, 0, w * 0.62, w * 0.55, t, 0.4);
        slab.pop();
      } else {
        // Mound of thrown sub-base — wide and low, not a potato.
        const s = rr.range(0.34, 0.7);
        spoil.pushTRS(px, py - 0.06, pz, rr.range(0, 6.28), 0, 0, 1, 0.34, 1);
        spoil.lump(s, 8, 4, (k) => {
          const v = Math.sin((k + i) * 12.9898) * 43758.5;
          return 0.5 + 0.42 * (v - Math.floor(v));
        }, 0.9);
        spoil.pop();
      }
    }
    // Blocks thrown clear.
    const thrown = Math.round(4 + c.radius * 1.6);
    for (let i = 0; i < thrown; i++) {
      const a = rr.range(0, Math.PI * 2);
      const r = c.radius * rr.range(1.15, 2.0);
      const px = c.x + Math.cos(a) * r, pz = c.z + Math.sin(a) * r;
      if (insideAnyFootprint(px, pz, 0.4)) continue;
      const py = groundHeightAt(px, pz);
      const s = rr.range(0.09, 0.24);
      lump.pushTRS(px, py + s * 0.42, pz, rr.range(0, 6.28), rr.range(-0.5, 0.5), rr.range(-0.5, 0.5));
      lump.box(0, 0, 0, s, s * rr.range(0.4, 0.8), s * rr.range(0.6, 1.3), 0.5);
      lump.pop();
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
  // Bed follows the ground exactly: sampled per corner, so no gaps. It runs the
  // full width of the sunken carriageway so the lane between the two kerb lines
  // reads as one dark granite strip rather than a stripe of setts floating in
  // the cobbles.
  bed.grid(-PLAZA.trackHalf + 0.1, trackZ0, PLAZA.trackHalf - 0.1, trackZ1,
    9, Math.round((trackZ1 - trackZ0) / 1.3),
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

/* ------------------------------------------------------------- kerbing -- */

const KERB_TOP = 0.055;
const KERB_W = 0.30;

/** Kerb run along Z at constant x. `out` is +1/−1: the low (road) side. */
function kerbAlongZ(m: Mesher, x: number, z0: number, z1: number, out: -1 | 1): void {
  const step = 1.15;
  for (let z = z0; z < z1 - 1e-3; z += step) {
    const ze = Math.min(z + step, z1);
    const zm = (z + ze) * 0.5;
    const top = groundHeightAt(x - out * 0.5, zm) + KERB_TOP;
    const bot = groundHeightAt(x + out * 0.6, zm) - 0.34;
    const a = x - out * KERB_W, b = x + out * 0.05;
    m.boxMinMax(Math.min(a, b), bot, z, Math.max(a, b), top, ze, 1.0);
  }
}

/** Kerb run along X at constant z. `out` is +1/−1: the low (road) side. */
function kerbAlongX(m: Mesher, x0: number, x1: number, z: number, out: -1 | 1): void {
  const step = 1.15;
  for (let x = x0; x < x1 - 1e-3; x += step) {
    const xe = Math.min(x + step, x1);
    const xm = (x + xe) * 0.5;
    const top = groundHeightAt(xm, z - out * 0.5) + KERB_TOP;
    const bot = groundHeightAt(xm, z + out * 0.6) - 0.34;
    const a = z - out * KERB_W, b = z + out * 0.05;
    m.boxMinMax(x, bot, Math.min(a, b), xe, top, Math.max(a, b), 1.0);
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
