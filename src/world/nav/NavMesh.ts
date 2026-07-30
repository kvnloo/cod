/**
 * Navmesh construction: regions → convex polygons → connectivity, plus the
 * derived tactical data the AI needs (cover points and traversal links).
 *
 * Polygons are axis-aligned rectangles produced by greedy-meshing each region's
 * cells. Rectangles are a deliberate choice over general convex polys: portals
 * between two rectangles are exact, the funnel algorithm is trivially correct on
 * them, and point-in-polygon becomes two comparisons — which matters when the
 * AI is doing hundreds of `nearestPoly` queries a second.
 */

import * as THREE from 'three';
import type { CompactField } from './Heightfield';
import { DIR_X, DIR_Z } from './Heightfield';

export interface NavPoly {
  id: number;
  region: number;
  /** Cell-grid bounds, inclusive. */
  i0: number; j0: number; i1: number; j1: number;
  /** World bounds. */
  x0: number; z0: number; x1: number; z1: number;
  y: number;
  yMin: number; yMax: number;
  centre: THREE.Vector3;
  area: number;
  links: NavLink[];
}

export interface NavLink {
  /** Destination polygon. */
  to: number;
  /** Portal endpoints in world space. */
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  cost: number;
  kind: 'walk' | 'vault' | 'drop' | 'climb';
}

export interface CoverPoint {
  position: THREE.Vector3;
  /** Points away from the cover surface, i.e. toward the exposed side. */
  normal: THREE.Vector3;
  height: 'low' | 'high';
  /** Polygon the point stands on. */
  poly: number;
}

export interface TraversalLink {
  from: THREE.Vector3;
  to: THREE.Vector3;
  kind: 'vault' | 'drop' | 'climb';
  cost: number;
}

export interface NavMeshData {
  polys: NavPoly[];
  cover: CoverPoint[];
  links: TraversalLink[];
  /** cell index → poly id, -1 when the cell was discarded. */
  cellPoly: Int32Array;
  field: CompactField;
  buildMs: number;
  stats: { regions: number; polys: number; cells: number; cover: number; links: number };
}

const MIN_REGION_CELLS = 6;

export function buildNavMesh(field: CompactField): NavMeshData {
  const t0 = performance.now();
  const regionCount = growRegions(field);
  const cellPoly = new Int32Array(field.count).fill(-1);
  const polys = buildPolygons(field, regionCount, cellPoly);
  connect(field, polys, cellPoly);
  const cover = buildCover(field, cellPoly, polys);
  const links = buildTraversalLinks(field, cellPoly, polys);

  return {
    polys, cover, links, cellPoly, field,
    buildMs: performance.now() - t0,
    stats: {
      regions: regionCount, polys: polys.length, cells: field.count,
      cover: cover.length, links: links.length,
    },
  };
}

/* --------------------------------------------------------------- regions -- */

function growRegions(field: CompactField): number {
  const region = field.region;
  region.fill(0);
  let next = 1;
  const stack: number[] = [];
  const members: number[] = [];

  for (let seed = 0; seed < field.count; seed++) {
    if (region[seed] !== 0 || !field.walkable[seed]) continue;
    const id = next++;
    stack.length = 0;
    members.length = 0;
    stack.push(seed);
    region[seed] = id;
    while (stack.length) {
      const c = stack.pop() as number;
      members.push(c);
      for (let d = 0; d < 4; d++) {
        const nc = field.con[c * 4 + d];
        if (nc < 0 || region[nc] !== 0) continue;
        region[nc] = id;
        stack.push(nc);
      }
    }
    if (members.length < MIN_REGION_CELLS) {
      for (const c of members) { region[c] = 0; field.walkable[c] = 0; }
      next--;
    }
  }
  return next - 1;
}

/* -------------------------------------------------------------- polygons -- */

function buildPolygons(field: CompactField, regionCount: number, cellPoly: Int32Array): NavPoly[] {
  const polys: NavPoly[] = [];
  const byRegion = new Map<number, number[]>();
  for (let c = 0; c < field.count; c++) {
    const r = field.region[c];
    if (r === 0) continue;
    let list = byRegion.get(r);
    if (!list) { list = []; byRegion.set(r, list); }
    list.push(c);
  }

  const cs = field.cfg.cs;
  for (const [region, cells] of byRegion) {
    // Bounding grid rect for this region so the working map stays small.
    let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
    for (const c of cells) {
      i0 = Math.min(i0, field.ci[c]); i1 = Math.max(i1, field.ci[c]);
      j0 = Math.min(j0, field.cj[c]); j1 = Math.max(j1, field.cj[c]);
    }
    const rw = i1 - i0 + 1;
    const rh = j1 - j0 + 1;
    const map = new Int32Array(rw * rh).fill(-1);
    for (const c of cells) {
      const li = field.ci[c] - i0, lj = field.cj[c] - j0;
      // A region can only own one cell per column; the first wins.
      if (map[lj * rw + li] < 0) map[lj * rw + li] = c;
    }
    const used = new Uint8Array(rw * rh);

    for (let lj = 0; lj < rh; lj++) {
      for (let li = 0; li < rw; li++) {
        if (map[lj * rw + li] < 0 || used[lj * rw + li]) continue;
        // Extend right, then down, while the rectangle stays inside the region
        // and its floor stays within a step of the seed's.
        const baseY = field.y[map[lj * rw + li]];
        let ri = li;
        while (ri + 1 < rw) {
          const c = map[lj * rw + ri + 1];
          if (c < 0 || used[lj * rw + ri + 1]) break;
          if (Math.abs(field.y[c] - baseY) > 0.55) break;
          ri++;
        }
        let rj = lj;
        outer: while (rj + 1 < rh) {
          for (let k = li; k <= ri; k++) {
            const c = map[(rj + 1) * rw + k];
            if (c < 0 || used[(rj + 1) * rw + k]) break outer;
            if (Math.abs(field.y[c] - baseY) > 0.55) break outer;
          }
          rj++;
        }

        const id = polys.length;
        let ySum = 0, yMin = Infinity, yMax = -Infinity, n = 0;
        for (let b = lj; b <= rj; b++) {
          for (let a = li; a <= ri; a++) {
            used[b * rw + a] = 1;
            const c = map[b * rw + a];
            cellPoly[c] = id;
            ySum += field.y[c];
            yMin = Math.min(yMin, field.y[c]);
            yMax = Math.max(yMax, field.y[c]);
            n++;
          }
        }
        const gi0 = i0 + li, gi1 = i0 + ri, gj0 = j0 + lj, gj1 = j0 + rj;
        const x0 = field.cfg.minX + gi0 * cs;
        const x1 = field.cfg.minX + (gi1 + 1) * cs;
        const z0 = field.cfg.minZ + gj0 * cs;
        const z1 = field.cfg.minZ + (gj1 + 1) * cs;
        const y = ySum / n;
        polys.push({
          id, region, i0: gi0, j0: gj0, i1: gi1, j1: gj1,
          x0, z0, x1, z1, y, yMin, yMax,
          centre: new THREE.Vector3((x0 + x1) * 0.5, y, (z0 + z1) * 0.5),
          area: (x1 - x0) * (z1 - z0),
          links: [],
        });
      }
    }
  }
  return polys;
}

/* ---------------------------------------------------------- connectivity -- */

function connect(field: CompactField, polys: NavPoly[], cellPoly: Int32Array): void {
  interface Acc { min: number; max: number; yA: number; yB: number; }
  const acc = new Map<number, Acc>();
  const cs = field.cfg.cs;

  for (let c = 0; c < field.count; c++) {
    const pa = cellPoly[c];
    if (pa < 0) continue;
    for (let d = 0; d < 4; d++) {
      const nc = field.con[c * 4 + d];
      if (nc < 0) continue;
      const pb = cellPoly[nc];
      if (pb < 0 || pb === pa) continue;
      const key = pa * 100000 + pb;
      // The portal runs along the shared cell edge; accumulate its extent.
      const horizontal = DIR_X[d] !== 0;
      const along = horizontal ? field.cj[c] : field.ci[c];
      const lo = (horizontal ? field.cfg.minZ : field.cfg.minX) + along * cs;
      const hi = lo + cs;
      const existing = acc.get(key);
      if (existing) {
        existing.min = Math.min(existing.min, lo);
        existing.max = Math.max(existing.max, hi);
      } else {
        acc.set(key, { min: lo, max: hi, yA: field.y[c], yB: field.y[nc] });
      }
    }
  }

  for (const [key, a] of acc) {
    const pa = Math.floor(key / 100000);
    const pb = key % 100000;
    const A = polys[pa], B = polys[pb];
    if (!A || !B) continue;
    // The shared edge lies on whichever axis the two rectangles abut.
    let ax: number, az: number, bx: number, bz: number;
    const shareX = Math.abs(A.x1 - B.x0) < 1e-4 || Math.abs(B.x1 - A.x0) < 1e-4;
    if (shareX) {
      const x = Math.abs(A.x1 - B.x0) < 1e-4 ? A.x1 : A.x0;
      ax = x; bx = x; az = a.min; bz = a.max;
    } else {
      const z = Math.abs(A.z1 - B.z0) < 1e-4 ? A.z1 : A.z0;
      az = z; bz = z; ax = a.min; bx = a.max;
    }
    const y = (a.yA + a.yB) * 0.5;
    A.links.push({
      to: pb, ax, az, ay: y, bx, bz, by: y,
      cost: A.centre.distanceTo(B.centre), kind: 'walk',
    });
  }
}

/* ----------------------------------------------------------------- cover -- */

const DIAG_X = [1, 1, -1, -1];
const DIAG_Z = [1, -1, 1, -1];

function buildCover(field: CompactField, cellPoly: Int32Array, polys: NavPoly[]): CoverPoint[] {
  const out: CoverPoint[] = [];
  const cs = field.cfg.cs;
  const spacingCells = Math.max(1, Math.round(1.5 / cs));
  const claimed = new Set<number>();

  for (let c = 0; c < field.count; c++) {
    const p = cellPoly[c];
    if (p < 0) continue;
    const i = field.ci[c], j = field.cj[c];
    const y = field.y[c];

    for (let d = 0; d < 8; d++) {
      const dx = d < 4 ? DIR_X[d] : DIAG_X[d - 4];
      const dz = d < 4 ? DIR_Z[d] : DIAG_Z[d - 4];
      // Orthogonal directions with an existing link are open ground.
      if (d < 4 && field.con[c * 4 + d] >= 0) continue;
      const ni = i + dx, nj = j + dz;
      if (ni < 0 || nj < 0 || ni >= field.w || nj >= field.h) continue;
      if (d >= 4 && field.nearestCell(ni, nj, y, field.cfg.agentClimb) >= 0) continue;

      const top = field.obstacleTop(ni, nj, y);
      if (!isFinite(top)) continue;
      const h = top - y;
      if (h < 0.7 || h > 2.6) continue;
      const height: CoverPoint['height'] = h >= 1.35 ? 'high' : 'low';

      // Spatial thinning so cover reads as a set of positions, not a carpet.
      const key = (Math.floor(i / spacingCells) * 4096 + Math.floor(j / spacingCells)) * 8
        + (height === 'high' ? 1 : 0) * 4 + (d & 3);
      if (claimed.has(key)) continue;
      claimed.add(key);

      const len = Math.hypot(dx, dz);
      out.push({
        position: new THREE.Vector3(
          field.worldX(i) - (dx / len) * cs * 0.35,
          y,
          field.worldZ(j) - (dz / len) * cs * 0.35,
        ),
        normal: new THREE.Vector3(-dx / len, 0, -dz / len),
        height,
        poly: p,
      });
    }
  }
  void polys;
  return out;
}

/* ------------------------------------------------------- traversal links -- */

function buildTraversalLinks(field: CompactField, cellPoly: Int32Array, polys: NavPoly[]): TraversalLink[] {
  const links: TraversalLink[] = [];
  const seen = new Set<number>();
  const cs = field.cfg.cs;
  const vaultCells = Math.max(1, Math.round(1.0 / cs));

  for (let c = 0; c < field.count; c++) {
    const pa = cellPoly[c];
    if (pa < 0) continue;
    const i = field.ci[c], j = field.cj[c], y = field.y[c];

    for (let d = 0; d < 4; d++) {
      if (field.con[c * 4 + d] >= 0) continue;
      const dx = DIR_X[d], dz = DIR_Z[d];

      // --- vault: a low obstacle with walkable ground on the far side
      const oi = i + dx, oj = j + dz;
      const top = field.obstacleTop(oi, oj, y);
      if (isFinite(top) && top - y <= 1.25 && top - y >= 0.35) {
        for (let step = vaultCells; step <= vaultCells + 2; step++) {
          const ti = i + dx * (step + 1), tj = j + dz * (step + 1);
          const tc = field.nearestCell(ti, tj, y, 1.1);
          if (tc < 0) continue;
          const pb = cellPoly[tc];
          if (pb < 0 || pb === pa) break;
          const key = Math.min(pa, pb) * 100000 + Math.max(pa, pb);
          if (seen.has(key)) break;
          seen.add(key);
          links.push({
            from: new THREE.Vector3(field.worldX(i), y, field.worldZ(j)),
            to: new THREE.Vector3(field.worldX(ti), field.y[tc], field.worldZ(tj)),
            kind: 'vault',
            cost: step * cs + 1.4,
          });
          const A = polys[pa], B = polys[pb];
          if (A && B) {
            const px = (field.worldX(i) + field.worldX(ti)) * 0.5;
            const pz = (field.worldZ(j) + field.worldZ(tj)) * 0.5;
            A.links.push({ to: pb, ax: px, az: pz, ay: y, bx: px, bz: pz, by: y, cost: step * cs + 2.2, kind: 'vault' });
            B.links.push({ to: pa, ax: px, az: pz, ay: y, bx: px, bz: pz, by: y, cost: step * cs + 2.2, kind: 'vault' });
          }
          break;
        }
      }

      // --- drop: a ledge with walkable ground well below
      const below = lowerCell(field, oi, oj, y);
      if (below >= 0) {
        const pb = cellPoly[below];
        const drop = y - field.y[below];
        if (pb >= 0 && pb !== pa && drop > field.cfg.agentClimb && drop <= 3.6) {
          const key = 500000 + Math.min(pa, pb) * 100000 + Math.max(pa, pb);
          if (!seen.has(key)) {
            seen.add(key);
            links.push({
              from: new THREE.Vector3(field.worldX(i), y, field.worldZ(j)),
              to: new THREE.Vector3(field.worldX(oi), field.y[below], field.worldZ(oj)),
              kind: 'drop',
              cost: drop * 0.6 + 1.0,
            });
            const A = polys[pa];
            if (A) {
              A.links.push({
                to: pb,
                ax: field.worldX(oi), az: field.worldZ(oj), ay: field.y[below],
                bx: field.worldX(oi), bz: field.worldZ(oj), by: field.y[below],
                cost: drop * 0.6 + 2.0, kind: 'drop',
              });
            }
          }
        }
      }
    }
  }
  return links;
}

function lowerCell(field: CompactField, i: number, j: number, y: number): number {
  if (i < 0 || j < 0 || i >= field.w || j >= field.h) return -1;
  const col = j * field.w + i;
  const start = field.colStart[col];
  const n = field.colCount[col];
  let best = -1;
  for (let k = 0; k < n; k++) {
    const c = start + k;
    if (!field.walkable[c]) continue;
    if (field.y[c] >= y - 1e-3) continue;
    if (best < 0 || field.y[c] > field.y[best]) best = c;
  }
  return best;
}
