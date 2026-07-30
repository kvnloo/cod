/**
 * Voxelisation: scene triangles → a solid span heightfield → a compact
 * multi-layer walkable field.
 *
 * This is the Recast pipeline in miniature, and it is the right one: rasterising
 * the actual rendered geometry means the navmesh can never disagree with what
 * the player collides against, and span layering means a three-storey building
 * with a walkable roof produces four independent floors in the same columns —
 * something a single heightmap cannot express.
 *
 *   1. Every triangle is clipped to each cell column it crosses; the clipped
 *      polygon's min/max Y becomes a solid span, flagged walkable when the
 *      triangle normal is within the slope limit.
 *   2. Spans in a column are merged bottom-up.
 *   3. A walkable span's top becomes a *cell* when the gap to the span above it
 *      clears the agent's height.
 *   4. Cells are linked to their four neighbours when the step between them is
 *      within the climb limit, then eroded by the agent radius.
 */

import * as THREE from 'three';

export interface NavConfig {
  minX: number; minZ: number; maxX: number; maxZ: number;
  minY: number; maxY: number;
  /** Horizontal cell size, metres. */
  cs: number;
  /** Vertical merge tolerance, metres. */
  ch: number;
  agentHeight: number;
  agentRadius: number;
  agentClimb: number;
  /** cos of the maximum walkable slope. */
  slopeCos: number;
}

export const DEFAULT_NAV_CONFIG: NavConfig = {
  minX: -56, minZ: -56, maxX: 56, maxZ: 56,
  minY: -4, maxY: 26,
  cs: 0.4,
  ch: 0.16,
  agentHeight: 1.85,
  agentRadius: 0.42,
  agentClimb: 0.46,
  slopeCos: Math.cos(48 * Math.PI / 180),
};

const AREA_WALKABLE = 1;
const AREA_SOLID = 0;

/* ------------------------------------------------------- solid heightfield */

export class SolidHeightfield {
  readonly w: number;
  readonly h: number;
  readonly cfg: NavConfig;
  /** Head index of each column's span list, or -1. */
  private start: Int32Array;
  private smin: Float32Array;
  private smax: Float32Array;
  private snext: Int32Array;
  private sarea: Uint8Array;
  private count = 0;
  private capacity: number;

  constructor(cfg: NavConfig) {
    this.cfg = cfg;
    this.w = Math.max(1, Math.ceil((cfg.maxX - cfg.minX) / cfg.cs));
    this.h = Math.max(1, Math.ceil((cfg.maxZ - cfg.minZ) / cfg.cs));
    this.start = new Int32Array(this.w * this.h).fill(-1);
    this.capacity = this.w * this.h * 2;
    this.smin = new Float32Array(this.capacity);
    this.smax = new Float32Array(this.capacity);
    this.snext = new Int32Array(this.capacity);
    this.sarea = new Uint8Array(this.capacity);
  }

  get spanCount(): number { return this.count; }

  private grow(): void {
    const cap = this.capacity * 2;
    const smin = new Float32Array(cap); smin.set(this.smin);
    const smax = new Float32Array(cap); smax.set(this.smax);
    const snext = new Int32Array(cap); snext.set(this.snext);
    const sarea = new Uint8Array(cap); sarea.set(this.sarea);
    this.smin = smin; this.smax = smax; this.snext = snext; this.sarea = sarea;
    this.capacity = cap;
  }

  /** Inserts a span into a column, merging with anything it touches. */
  addSpan(i: number, j: number, y0: number, y1: number, area: number): void {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const ch = this.cfg.ch;
    const col = j * this.w + i;

    if (this.count >= this.capacity) this.grow();
    let idx = this.count++;
    this.smin[idx] = y0; this.smax[idx] = y1; this.sarea[idx] = area; this.snext[idx] = -1;

    let prev = -1;
    let cur = this.start[col];
    while (cur !== -1) {
      if (this.smin[cur] > this.smax[idx] + ch) break;               // above, no touch
      if (this.smax[cur] + ch < this.smin[idx]) { prev = cur; cur = this.snext[cur]; continue; }
      // merge
      if (this.smin[cur] < this.smin[idx]) this.smin[idx] = this.smin[cur];
      if (this.smax[cur] > this.smax[idx]) {
        // The higher surface wins the walkability flag when the tops are close.
        if (Math.abs(this.smax[cur] - this.smax[idx]) <= ch) {
          this.sarea[idx] = Math.max(this.sarea[idx], this.sarea[cur]);
        } else {
          this.sarea[idx] = this.sarea[cur];
        }
        this.smax[idx] = this.smax[cur];
      } else if (Math.abs(this.smax[cur] - this.smax[idx]) <= ch) {
        this.sarea[idx] = Math.max(this.sarea[idx], this.sarea[cur]);
      }
      const next = this.snext[cur];
      if (prev === -1) this.start[col] = next; else this.snext[prev] = next;
      cur = next;
    }
    this.snext[idx] = cur;
    if (prev === -1) this.start[col] = idx; else this.snext[prev] = idx;
  }

  columnHead(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return this.start[j * this.w + i];
  }
  spanMin(s: number): number { return this.smin[s]; }
  spanMax(s: number): number { return this.smax[s]; }
  spanArea(s: number): number { return this.sarea[s]; }
  spanNext(s: number): number { return this.snext[s]; }

  /**
   * Top of the first solid span in column (i,j) that spans `y`, or -Infinity.
   * Used by cover generation to measure how tall an obstacle is.
   */
  obstacleTopAt(i: number, j: number, y: number): number {
    let s = this.columnHead(i, j);
    let best = -Infinity;
    while (s !== -1) {
      if (this.smax[s] > y + 0.05 && this.smin[s] <= y + 0.35) best = Math.max(best, this.smax[s]);
      s = this.snext[s];
    }
    return best;
  }
}

/* ------------------------------------------------------------ rasteriser -- */

const polyA: number[] = new Array(24);
const polyB: number[] = new Array(24);

/** Clips `poly` (n verts, xyz triples) to `axis <= / >= limit`. */
function clipAxis(src: number[], n: number, out: number[], axis: number, limit: number, keepAbove: boolean): number {
  let m = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = src[i * 3 + axis];
    const vj = src[j * 3 + axis];
    const ini = keepAbove ? vi >= limit : vi <= limit;
    const inj = keepAbove ? vj >= limit : vj <= limit;
    if (ini !== inj) {
      const t = (limit - vj) / (vi - vj);
      out[m * 3 + 0] = src[j * 3 + 0] + (src[i * 3 + 0] - src[j * 3 + 0]) * t;
      out[m * 3 + 1] = src[j * 3 + 1] + (src[i * 3 + 1] - src[j * 3 + 1]) * t;
      out[m * 3 + 2] = src[j * 3 + 2] + (src[i * 3 + 2] - src[j * 3 + 2]) * t;
      m++;
    }
    if (ini) {
      out[m * 3 + 0] = src[i * 3 + 0];
      out[m * 3 + 1] = src[i * 3 + 1];
      out[m * 3 + 2] = src[i * 3 + 2];
      m++;
    }
  }
  return m;
}

export class Rasteriser {
  private buf1: number[] = new Array(48);
  private buf2: number[] = new Array(48);

  constructor(private hf: SolidHeightfield) { }

  triangle(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    const cfg = this.hf.cfg;
    const cs = cfg.cs;

    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    if (maxY < cfg.minY || minY > cfg.maxY) return;
    if (maxX < cfg.minX || minX > cfg.maxX || maxZ < cfg.minZ || minZ > cfg.maxZ) return;

    // Face normal decides walkability.
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) return;
    const area = (ny / nl) >= cfg.slopeCos ? AREA_WALKABLE : AREA_SOLID;

    const i0 = Math.max(0, Math.floor((minX - cfg.minX) / cs));
    const i1 = Math.min(this.hf.w - 1, Math.floor((maxX - cfg.minX) / cs));
    const j0 = Math.max(0, Math.floor((minZ - cfg.minZ) / cs));
    const j1 = Math.min(this.hf.h - 1, Math.floor((maxZ - cfg.minZ) / cs));
    if (i1 < i0 || j1 < j0) return;

    // Fast path: the whole triangle falls in one column.
    if (i0 === i1 && j0 === j1) {
      this.hf.addSpan(i0, j0, Math.max(minY, cfg.minY), Math.min(maxY, cfg.maxY), area);
      return;
    }

    for (let j = j0; j <= j1; j++) {
      const z0 = cfg.minZ + j * cs;
      const z1 = z0 + cs;
      for (let i = i0; i <= i1; i++) {
        const x0 = cfg.minX + i * cs;
        const x1 = x0 + cs;
        const p = this.buf1;
        p[0] = ax; p[1] = ay; p[2] = az;
        p[3] = bx; p[4] = by; p[5] = bz;
        p[6] = cx; p[7] = cy; p[8] = cz;
        let n = 3;
        n = clipAxis(p, n, this.buf2, 0, x0, true); if (n < 3) continue;
        n = clipAxis(this.buf2, n, this.buf1, 0, x1, false); if (n < 3) continue;
        n = clipAxis(this.buf1, n, this.buf2, 2, z0, true); if (n < 3) continue;
        n = clipAxis(this.buf2, n, this.buf1, 2, z1, false); if (n < 3) continue;
        let ymin = Infinity, ymax = -Infinity;
        for (let k = 0; k < n; k++) {
          const y = this.buf1[k * 3 + 1];
          if (y < ymin) ymin = y;
          if (y > ymax) ymax = y;
        }
        if (ymax < cfg.minY || ymin > cfg.maxY) continue;
        this.hf.addSpan(i, j, Math.max(ymin, cfg.minY), Math.min(ymax, cfg.maxY), area);
      }
    }
  }
}

/* ---------------------------------------------------- compact heightfield -- */

export const DIR_X = [1, 0, -1, 0];
export const DIR_Z = [0, 1, 0, -1];

/** Multi-layer walkable cells with 4-neighbour links, eroded by agent radius. */
export class CompactField {
  readonly w: number;
  readonly h: number;
  readonly cfg: NavConfig;
  /** First cell index of each column, and how many cells the column has. */
  readonly colStart: Int32Array;
  readonly colCount: Uint8Array;
  /** Per-cell data. */
  y: Float32Array;
  ceiling: Float32Array;
  con: Int32Array;        // 4 per cell, cell index or -1
  region: Int32Array;
  dist: Uint16Array;
  walkable: Uint8Array;
  ci: Int32Array;         // column i
  cj: Int32Array;         // column j
  count = 0;

  constructor(private hf: SolidHeightfield) {
    this.w = hf.w; this.h = hf.h; this.cfg = hf.cfg;
    this.colStart = new Int32Array(this.w * this.h);
    this.colCount = new Uint8Array(this.w * this.h);

    // pass 1: count
    let total = 0;
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        let s = hf.columnHead(i, j);
        let n = 0;
        while (s !== -1) {
          const next = hf.spanNext(s);
          if (hf.spanArea(s) === AREA_WALKABLE) {
            const top = hf.spanMax(s);
            const ceil = next === -1 ? this.cfg.maxY + 50 : hf.spanMin(next);
            if (ceil - top >= this.cfg.agentHeight) n++;
          }
          s = next;
        }
        this.colStart[j * this.w + i] = total;
        this.colCount[j * this.w + i] = Math.min(255, n);
        total += Math.min(255, n);
      }
    }
    this.count = total;
    this.y = new Float32Array(total);
    this.ceiling = new Float32Array(total);
    this.con = new Int32Array(total * 4).fill(-1);
    this.region = new Int32Array(total).fill(0);
    this.dist = new Uint16Array(total);
    this.walkable = new Uint8Array(total).fill(1);
    this.ci = new Int32Array(total);
    this.cj = new Int32Array(total);

    // pass 2: fill
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const col = j * this.w + i;
        let idx = this.colStart[col];
        const limit = idx + this.colCount[col];
        let s = hf.columnHead(i, j);
        while (s !== -1 && idx < limit) {
          const next = hf.spanNext(s);
          if (hf.spanArea(s) === AREA_WALKABLE) {
            const top = hf.spanMax(s);
            const ceil = next === -1 ? this.cfg.maxY + 50 : hf.spanMin(next);
            if (ceil - top >= this.cfg.agentHeight) {
              this.y[idx] = top;
              this.ceiling[idx] = ceil;
              this.ci[idx] = i;
              this.cj[idx] = j;
              idx++;
            }
          }
          s = next;
        }
      }
    }

    this.link();
    this.erode();
  }

  cellAt(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    const col = j * this.w + i;
    if (k >= this.colCount[col]) return -1;
    return this.colStart[col] + k;
  }

  /** Cell in column (i,j) whose floor is nearest `y`, or -1. */
  nearestCell(i: number, j: number, y: number, tolerance = 1.5): number {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    const col = j * this.w + i;
    const start = this.colStart[col];
    const n = this.colCount[col];
    let best = -1, bestD = tolerance;
    for (let k = 0; k < n; k++) {
      const c = start + k;
      const d = Math.abs(this.y[c] - y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  private link(): void {
    const climb = this.cfg.agentClimb;
    const agentH = this.cfg.agentHeight;
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const col = j * this.w + i;
        const start = this.colStart[col];
        const n = this.colCount[col];
        for (let k = 0; k < n; k++) {
          const c = start + k;
          for (let d = 0; d < 4; d++) {
            const ni = i + DIR_X[d], nj = j + DIR_Z[d];
            if (ni < 0 || nj < 0 || ni >= this.w || nj >= this.h) continue;
            const ncol = nj * this.w + ni;
            const nstart = this.colStart[ncol];
            const nn = this.colCount[ncol];
            let best = -1, bestD = climb + 1e-4;
            for (let m = 0; m < nn; m++) {
              const nc = nstart + m;
              const dy = Math.abs(this.y[nc] - this.y[c]);
              if (dy > bestD) continue;
              // Both ends must keep the agent's headroom over the step.
              const top = Math.max(this.y[nc], this.y[c]);
              if (Math.min(this.ceiling[nc], this.ceiling[c]) - top < agentH) continue;
              bestD = dy; best = nc;
            }
            this.con[c * 4 + d] = best;
          }
        }
      }
    }
  }

  /**
   * Chamfer distance to the nearest border cell, then clear anything the agent
   * cannot physically fit in.
   */
  private erode(): void {
    const n = this.count;
    const D = this.dist;
    D.fill(0xffff);
    // border seeds
    for (let c = 0; c < n; c++) {
      let border = false;
      for (let d = 0; d < 4; d++) if (this.con[c * 4 + d] < 0) { border = true; break; }
      if (border) D[c] = 0;
    }
    // forward pass (−x, −z) then backward (+x, +z); 4-connected chamfer with
    // diagonal steps approximated through the two orthogonal neighbours.
    for (let pass = 0; pass < 2; pass++) {
      const order = pass === 0 ? 1 : -1;
      const from = pass === 0 ? 0 : n - 1;
      const to = pass === 0 ? n : -1;
      for (let c = from; c !== to; c += order) {
        for (let d = 0; d < 4; d++) {
          const nc = this.con[c * 4 + d];
          if (nc < 0) continue;
          const v = D[nc] + 2;
          if (v < D[c]) D[c] = v;
        }
      }
    }
    const minDist = Math.max(0, (this.cfg.agentRadius / this.cfg.cs) * 2 - 0.5);
    for (let c = 0; c < n; c++) {
      if (D[c] < minDist) this.walkable[c] = 0;
    }
    // Drop links into cleared cells so region growing never crosses them.
    for (let c = 0; c < n; c++) {
      if (!this.walkable[c]) { for (let d = 0; d < 4; d++) this.con[c * 4 + d] = -1; continue; }
      for (let d = 0; d < 4; d++) {
        const nc = this.con[c * 4 + d];
        if (nc >= 0 && !this.walkable[nc]) this.con[c * 4 + d] = -1;
      }
    }
  }

  /** Top of the obstruction in column (i,j) that blocks a walker standing at `y`. */
  obstacleTop(i: number, j: number, y: number): number {
    return this.hf.obstacleTopAt(i, j, y);
  }

  worldX(i: number): number { return this.cfg.minX + (i + 0.5) * this.cfg.cs; }
  worldZ(j: number): number { return this.cfg.minZ + (j + 0.5) * this.cfg.cs; }
  gridI(x: number): number { return Math.floor((x - this.cfg.minX) / this.cfg.cs); }
  gridJ(z: number): number { return Math.floor((z - this.cfg.minZ) / this.cfg.cs); }
}

/* -------------------------------------------------------- scene sampling -- */

const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * Feeds every collidable mesh under `root` into the rasteriser. Instanced
 * meshes contribute their per-instance bounding boxes, exactly matching the
 * cuboid colliders the physics backend bakes for them.
 */
export function rasteriseScene(root: THREE.Object3D, ras: Rasteriser): number {
  let tris = 0;
  root.updateWorldMatrix(true, true);

  const visit = (obj: THREE.Object3D): void => {
    const ud = obj.userData as Record<string, unknown>;
    if (ud.navIgnoreSubtree === true) return;
    if ((obj.layers.mask & 1) === 0) return;      // backdrop / view model
    if (ud.noCollide === true || ud.collide === false) {
      // still recurse: children may collide
    } else if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const visible = mesh.visible || ud.collideWhenHidden === true;
      if (visible && ud.navIgnore !== true) {
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
          tris += instancedBoxes(mesh as THREE.InstancedMesh, ras);
        } else {
          tris += meshTriangles(mesh, ras);
        }
      }
    }
    for (const child of obj.children) visit(child);
  };
  visit(root);
  return tris;
}

function meshTriangles(mesh: THREE.Mesh, ras: Rasteriser): number {
  const geo = mesh.geometry;
  const pos = geo?.attributes?.position as THREE.BufferAttribute | undefined;
  if (!pos) return 0;
  const index = geo.index;
  const m = mesh.matrixWorld;
  const e = m.elements;
  const px = pos.array as ArrayLike<number>;
  const tri = (a: number, b: number, c: number) => {
    const ax = px[a * 3], ay = px[a * 3 + 1], az = px[a * 3 + 2];
    const bx = px[b * 3], by = px[b * 3 + 1], bz = px[b * 3 + 2];
    const cx = px[c * 3], cy = px[c * 3 + 1], cz = px[c * 3 + 2];
    ras.triangle(
      e[0] * ax + e[4] * ay + e[8] * az + e[12],
      e[1] * ax + e[5] * ay + e[9] * az + e[13],
      e[2] * ax + e[6] * ay + e[10] * az + e[14],
      e[0] * bx + e[4] * by + e[8] * bz + e[12],
      e[1] * bx + e[5] * by + e[9] * bz + e[13],
      e[2] * bx + e[6] * by + e[10] * bz + e[14],
      e[0] * cx + e[4] * cy + e[8] * cz + e[12],
      e[1] * cx + e[5] * cy + e[9] * cz + e[13],
      e[2] * cx + e[6] * cy + e[10] * cz + e[14],
    );
  };
  let n = 0;
  if (index) {
    const ia = index.array as ArrayLike<number>;
    for (let i = 0; i + 2 < index.count; i += 3) { tri(ia[i], ia[i + 1], ia[i + 2]); n++; }
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) { tri(i, i + 1, i + 2); n++; }
  }
  return n;
}

// Corner bits: 1 = +x, 2 = +z, 4 = +y. Winding is chosen so the top faces
// resolve to +Y normals — that is what makes an instanced prop's lid walkable
// and its underside not.
const BOX_TRIS: [number, number, number][] = [
  [0, 1, 2], [1, 3, 2],   // −Y
  [4, 6, 5], [5, 6, 7],   // +Y
  [0, 1, 4], [1, 5, 4],   // −Z
  [2, 6, 3], [3, 6, 7],   // +Z
  [0, 4, 2], [2, 4, 6],   // −X
  [1, 3, 5], [3, 7, 5],   // +X
];

function instancedBoxes(mesh: THREE.InstancedMesh, ras: Rasteriser): number {
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return 0;
  _box.copy(bb);
  const corners: THREE.Vector3[] = [];
  for (let k = 0; k < 8; k++) {
    corners.push(new THREE.Vector3(
      k & 1 ? _box.max.x : _box.min.x,
      k & 4 ? _box.max.y : _box.min.y,
      k & 2 ? _box.max.z : _box.min.z,
    ));
  }
  const world: THREE.Vector3[] = corners.map(() => new THREE.Vector3());
  let n = 0;
  const limit = Math.min(mesh.count, 8192);
  for (let i = 0; i < limit; i++) {
    mesh.getMatrixAt(i, _m);
    _m.premultiply(mesh.matrixWorld);
    for (let k = 0; k < 8; k++) world[k].copy(corners[k]).applyMatrix4(_m);
    for (const [a, b, c] of BOX_TRIS) {
      ras.triangle(
        world[a].x, world[a].y, world[a].z,
        world[b].x, world[b].y, world[b].z,
        world[c].x, world[c].y, world[c].z,
      );
      n++;
    }
  }
  void _v;
  return n;
}
