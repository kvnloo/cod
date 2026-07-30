/**
 * Navigation.
 *
 * The world module is expected to publish a navmesh service
 * (`findPath` / `nearestPoly` / `coverNear`). It may not exist yet, and while it
 * is being written it may change shape, so this file:
 *
 *   1. probes for it structurally at runtime and uses whatever is there,
 *   2. falls back to a **sampled navigation grid** it builds itself out of
 *      physics queries, which is a real A* over real geometry rather than a
 *      straight-line stub,
 *   3. falls back again to a straight line if physics is not up either.
 *
 * The sampled grid is worth the code: it means the AI paths correctly around
 * cover in the test bed today, and it keeps working as a safety net in any level
 * whose nav data failed to build. It costs one downward ray and one upward
 * sphere-cast per cell, once, at level load.
 */

import * as THREE from 'three';
import type { PhysicsAPI, RayHit } from '../physics/types';
import { MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeHit } from './Util';
import type { NavLike } from './types';

/* ------------------------------------------------------------------ scratch */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _hit: RayHit = makeHit();

/** Walkability flags. */
const CELL_BLOCKED = 0;
const CELL_WALK = 1;

export interface NavGridOptions {
  /** Cell size in metres. Enlarged automatically if the area is huge. */
  cell?: number;
  /** Radius of the agent the grid is built for. */
  agentRadius?: number;
  /** Standing height of the agent the grid is built for. */
  agentHeight?: number;
  /** Maximum height difference between neighbouring cells that can be walked. */
  stepHeight?: number;
  /** Steepest floor that still counts as walkable, degrees. */
  slopeLimit?: number;
  /** Hard cap on cell count; the cell size grows until it fits. */
  maxCells?: number;
}

/**
 * A dense 2.5-D walkability grid with A*, string pulling and corner clearance.
 *
 * One floor height per column: this is a shooter arena, not a multi-storey
 * simulation. Bridges and catwalks resolve to whatever surface the downward ray
 * found first, which is the upper deck — good enough for the fallback, and the
 * real navmesh takes over the moment the world module ships one.
 */
export class NavGrid {
  readonly min = new THREE.Vector3();
  cell = 0.7;
  nx = 0;
  nz = 0;
  agentRadius = 0.36;
  agentHeight = 1.8;
  stepHeight = 0.5;
  slopeLimit = 47;

  flags = new Uint8Array(0);
  floor = new Float32Array(0);
  /** Cells to the nearest blocked cell, capped at 7. Drives corner clearance. */
  clearance = new Uint8Array(0);

  /* A* working set — allocated once, generation-stamped instead of cleared. */
  private gScore = new Float32Array(0);
  private fScore = new Float32Array(0);
  private cameFrom = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint8Array(0);
  private generation = 0;
  private heap = new Int32Array(0);
  private heapLen = 0;

  buildMs = 0;
  walkableCells = 0;

  /** Samples the physics world into a grid. Returns walkable cell count. */
  build(physics: PhysicsAPI, bounds: THREE.Box3, opts: NavGridOptions = {}): number {
    const t0 = (globalThis.performance?.now?.() ?? 0);
    this.agentRadius = opts.agentRadius ?? this.agentRadius;
    this.agentHeight = opts.agentHeight ?? this.agentHeight;
    this.stepHeight = opts.stepHeight ?? this.stepHeight;
    this.slopeLimit = opts.slopeLimit ?? this.slopeLimit;

    const sx = Math.max(1, bounds.max.x - bounds.min.x);
    const sz = Math.max(1, bounds.max.z - bounds.min.z);
    const maxCells = opts.maxCells ?? 26000;
    let cell = opts.cell ?? 0.7;
    while ((sx / cell) * (sz / cell) > maxCells) cell *= 1.25;
    this.cell = cell;
    this.nx = Math.max(2, Math.ceil(sx / cell));
    this.nz = Math.max(2, Math.ceil(sz / cell));
    this.min.set(bounds.min.x, bounds.min.y, bounds.min.z);

    const n = this.nx * this.nz;
    this.flags = new Uint8Array(n);
    this.floor = new Float32Array(n);
    this.clearance = new Uint8Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint8Array(n);
    this.heap = new Int32Array(n + 1);
    this.generation = 0;

    const top = bounds.max.y + 0.5;
    const probeLen = Math.max(2, bounds.max.y - bounds.min.y + 1.0);
    const cosSlope = Math.cos(THREE.MathUtils.degToRad(this.slopeLimit));
    const clearRadius = Math.max(0.12, this.agentRadius * 0.82);
    const clearRise = Math.max(0.2, this.agentHeight - clearRadius * 2 - 0.06);

    let walkable = 0;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const i = iz * this.nx + ix;
        const cx = this.min.x + (ix + 0.5) * cell;
        const cz = this.min.z + (iz + 0.5) * cell;

        _v0.set(cx, top, cz);
        physics.raycast(_v0, _down, probeLen, MASK_MOVE, _hit);
        if (!_hit.hit || _hit.normal.y < cosSlope) { this.flags[i] = CELL_BLOCKED; continue; }

        const fy = _hit.point.y;
        this.floor[i] = fy;

        // Head room: sphere-cast a body-width capsule's worth of space upward.
        _v0.set(cx, fy + clearRadius + 0.04, cz);
        physics.spherecast(_v0, _up, clearRadius, clearRise, MASK_MOVE, _hit);
        if (_hit.hit) { this.flags[i] = CELL_BLOCKED; continue; }

        this.flags[i] = CELL_WALK;
        walkable++;
      }
    }

    this.computeClearance();
    this.walkableCells = walkable;
    this.buildMs = (globalThis.performance?.now?.() ?? 0) - t0;
    return walkable;
  }

  /** Chebyshev distance transform from blocked cells, capped at 7. */
  private computeClearance(): void {
    const { nx, nz, flags, clearance } = this;
    const n = nx * nz;
    for (let i = 0; i < n; i++) clearance[i] = flags[i] === CELL_WALK ? 7 : 0;
    // Two sweeps of a chamfer transform.
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (clearance[i] === 0) continue;
        let best = 7;
        if (ix > 0) best = Math.min(best, clearance[i - 1] + 1);
        if (iz > 0) best = Math.min(best, clearance[i - nx] + 1);
        if (ix > 0 && iz > 0) best = Math.min(best, clearance[i - nx - 1] + 1);
        if (ix < nx - 1 && iz > 0) best = Math.min(best, clearance[i - nx + 1] + 1);
        clearance[i] = Math.min(clearance[i], best);
      }
    }
    for (let iz = nz - 1; iz >= 0; iz--) {
      for (let ix = nx - 1; ix >= 0; ix--) {
        const i = iz * nx + ix;
        if (clearance[i] === 0) continue;
        let best = clearance[i];
        if (ix < nx - 1) best = Math.min(best, clearance[i + 1] + 1);
        if (iz < nz - 1) best = Math.min(best, clearance[i + nx] + 1);
        if (ix < nx - 1 && iz < nz - 1) best = Math.min(best, clearance[i + nx + 1] + 1);
        if (ix > 0 && iz < nz - 1) best = Math.min(best, clearance[i + nx - 1] + 1);
        clearance[i] = best;
      }
    }
  }

  get ready(): boolean { return this.nx > 0 && this.walkableCells > 0; }

  cellX(x: number): number { return Math.floor((x - this.min.x) / this.cell); }
  cellZ(z: number): number { return Math.floor((z - this.min.z) / this.cell); }
  inside(ix: number, iz: number): boolean {
    return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz;
  }
  indexAt(x: number, z: number): number {
    const ix = this.cellX(x), iz = this.cellZ(z);
    return this.inside(ix, iz) ? iz * this.nx + ix : -1;
  }
  centre(i: number, out: THREE.Vector3): THREE.Vector3 {
    const ix = i % this.nx, iz = (i / this.nx) | 0;
    return out.set(
      this.min.x + (ix + 0.5) * this.cell,
      this.floor[i],
      this.min.z + (iz + 0.5) * this.cell,
    );
  }

  walkable(i: number): boolean { return i >= 0 && this.flags[i] === CELL_WALK; }

  /** Nearest walkable cell to `p` within `maxRing` cells; -1 when none. */
  nearest(p: THREE.Vector3, maxRing = 6): number {
    const ix = this.cellX(p.x), iz = this.cellZ(p.z);
    if (this.inside(ix, iz)) {
      const i = iz * this.nx + ix;
      if (this.flags[i] === CELL_WALK && Math.abs(this.floor[i] - p.y) < 3.0) return i;
    }
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= maxRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const jx = ix + dx, jz = iz + dz;
          if (!this.inside(jx, jz)) continue;
          const j = jz * this.nx + jx;
          if (this.flags[j] !== CELL_WALK) continue;
          const cx = this.min.x + (jx + 0.5) * this.cell - p.x;
          const cz = this.min.z + (jz + 0.5) * this.cell - p.z;
          const cy = (this.floor[j] - p.y) * 1.6;
          const d = cx * cx + cz * cz + cy * cy;
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** Snaps a point onto the grid floor. Returns false when off-mesh. */
  snap(p: THREE.Vector3, out: THREE.Vector3): boolean {
    const i = this.nearest(p, 8);
    if (i < 0) { out.copy(p); return false; }
    this.centre(i, out);
    return true;
  }

  /**
   * Supercover walk test between two world points. Every cell the segment
   * touches must be walkable and within one step of its predecessor.
   */
  lineOfWalk(a: THREE.Vector3, b: THREE.Vector3, minClearance = 0): boolean {
    const cell = this.cell;
    let x0 = this.cellX(a.x), z0 = this.cellZ(a.z);
    const x1 = this.cellX(b.x), z1 = this.cellZ(b.z);
    if (!this.inside(x0, z0) || !this.inside(x1, z1)) return false;
    let i = z0 * this.nx + x0;
    if (this.flags[i] !== CELL_WALK) return false;

    const dx = b.x - a.x, dz = b.z - a.z;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const invDz = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
    const bx = this.min.x + (x0 + (stepX > 0 ? 1 : 0)) * cell;
    const bz = this.min.z + (z0 + (stepZ > 0 ? 1 : 0)) * cell;
    let tMaxX = dx !== 0 ? Math.abs(bx - a.x) * invDx : Infinity;
    let tMaxZ = dz !== 0 ? Math.abs(bz - a.z) * invDz : Infinity;
    const tDeltaX = cell * invDx;
    const tDeltaZ = cell * invDz;

    let guard = this.nx + this.nz + 4;
    let prevFloor = this.floor[i];
    while (guard-- > 0) {
      if (x0 === x1 && z0 === z1) return true;
      if (tMaxX < tMaxZ) { x0 += stepX; tMaxX += tDeltaX; }
      else { z0 += stepZ; tMaxZ += tDeltaZ; }
      if (!this.inside(x0, z0)) return false;
      i = z0 * this.nx + x0;
      if (this.flags[i] !== CELL_WALK) return false;
      if (this.clearance[i] < minClearance) return false;
      if (Math.abs(this.floor[i] - prevFloor) > this.stepHeight) return false;
      prevFloor = this.floor[i];
    }
    return false;
  }

  /* ----------------------------------------------------------------- A* --- */

  /**
   * 8-connected A* with a clearance penalty so agents do not scrape walls.
   * Returns the number of raw waypoints written to `out` (0 = no path).
   */
  search(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3[], maxNodes = 4200): number {
    const start = this.nearest(from, 8);
    const goal = this.nearest(to, 10);
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      pushPoint(out, 0, this.centre(start, _v0));
      return 1;
    }

    const gen = ++this.generation;
    const { nx, nz, flags, floor, clearance, gScore, fScore, cameFrom, stamp, closed } = this;
    this.heapLen = 0;

    stamp[start] = gen; gScore[start] = 0; cameFrom[start] = -1; closed[start] = 0;
    fScore[start] = this.heuristic(start, goal);
    this.heapPush(start);

    let expanded = 0;
    let found = false;
    while (this.heapLen > 0 && expanded < maxNodes) {
      const cur = this.heapPop();
      if (cur === goal) { found = true; break; }
      if (closed[cur] === 1 && stamp[cur] === gen) continue;
      closed[cur] = 1;
      expanded++;

      const cx = cur % nx, cz = (cur / nx) | 0;
      const cf = floor[cur];
      for (let k = 0; k < 8; k++) {
        const dx = NEIGH[k * 2], dz = NEIGH[k * 2 + 1];
        const jx = cx + dx, jz = cz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const j = jz * nx + jx;
        if (flags[j] !== CELL_WALK) continue;
        if (Math.abs(floor[j] - cf) > this.stepHeight) continue;
        // No cutting corners diagonally through a wall.
        if (dx !== 0 && dz !== 0) {
          if (flags[cz * nx + jx] !== CELL_WALK) continue;
          if (flags[jz * nx + cx] !== CELL_WALK) continue;
        }
        const base = (dx !== 0 && dz !== 0) ? 1.41421356 : 1;
        // Hug-the-wall penalty: 1 cell of clearance is expensive, 2 mildly so.
        const c = clearance[j];
        const penalty = c <= 1 ? 0.85 : c === 2 ? 0.3 : 0;
        const rise = Math.abs(floor[j] - cf) * 1.4;
        const tentative = gScore[cur] + (base + penalty + rise) * this.cell;

        if (stamp[j] !== gen) {
          stamp[j] = gen; closed[j] = 0; gScore[j] = Infinity;
        }
        if (tentative < gScore[j]) {
          gScore[j] = tentative;
          cameFrom[j] = cur;
          fScore[j] = tentative + this.heuristic(j, goal);
          closed[j] = 0;
          this.heapPush(j);
        }
      }
    }

    if (!found) {
      // Best-effort: walk back from the closed node nearest the goal.
      let best = -1, bestF = Infinity;
      for (let i = 0; i < flags.length; i++) {
        if (stamp[i] !== gen || closed[i] !== 1) continue;
        const h = this.heuristic(i, goal);
        if (h < bestF) { bestF = h; best = i; }
      }
      if (best < 0) return 0;
      return this.reconstruct(best, out);
    }
    return this.reconstruct(goal, out);
  }

  private reconstruct(node: number, out: THREE.Vector3[]): number {
    // Walk back, then reverse in place.
    let n = 0;
    let cur = node;
    let guard = 4096;
    while (cur >= 0 && guard-- > 0) {
      pushPoint(out, n++, this.centre(cur, _v0));
      cur = this.cameFrom[cur];
    }
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return n;
  }

  private heuristic(a: number, b: number): number {
    const ax = a % this.nx, az = (a / this.nx) | 0;
    const bx = b % this.nx, bz = (b / this.nx) | 0;
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    // Octile.
    return (Math.max(dx, dz) + 0.41421356 * Math.min(dx, dz)) * this.cell;
  }

  private heapPush(node: number): void {
    const h = this.heap, f = this.fScore;
    let i = this.heapLen++;
    h[i] = node;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (f[h[parent]] <= f[h[i]]) break;
      const t = h[parent]; h[parent] = h[i]; h[i] = t;
      i = parent;
    }
  }

  private heapPop(): number {
    const h = this.heap, f = this.fScore;
    const top = h[0];
    this.heapLen--;
    if (this.heapLen > 0) {
      h[0] = h[this.heapLen];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.heapLen && f[h[l]] < f[h[m]]) m = l;
        if (r < this.heapLen && f[h[r]] < f[h[m]]) m = r;
        if (m === i) break;
        const t = h[m]; h[m] = h[i]; h[i] = t;
        i = m;
      }
    }
    return top;
  }
}

const NEIGH = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

function pushPoint(out: THREE.Vector3[], i: number, p: THREE.Vector3): void {
  if (!out[i]) out[i] = new THREE.Vector3();
  out[i].copy(p);
}

/* ------------------------------------------------------------ nav service -- */

/**
 * The façade the rest of the AI talks to. Prefers the world module's navmesh,
 * falls back to the sampled grid, then to a straight line.
 */
export class NavService {
  external: NavLike | null = null;
  grid: NavGrid | null = null;
  physics: PhysicsAPI | null = null;
  /** Where the fallback grid was built, for gizmos. */
  bounds = new THREE.Box3();

  private extPath: THREE.Vector3[] = [];
  private raw: THREE.Vector3[] = [];
  private smoothScratch: THREE.Vector3[] = [];
  /** A* calls this frame; the system budget throttles them. */
  searches = 0;
  /** Times the external navmesh threw. It is dropped after a few. */
  private externalFailures = 0;

  attach(physics: PhysicsAPI | null): void { this.physics = physics; }

  /**
   * Duck-types whatever the world module published. Called every few seconds
   * while `external` is null so a navmesh that finishes building late is picked
   * up without a restart.
   */
  probeExternal(world: unknown): boolean {
    if (this.externalFailures >= 2) return false;
    if (!world || typeof world !== 'object') return false;
    const holder = world as Record<string, unknown>;
    const candidates = [holder.nav, holder.navmesh, holder.navMesh, holder.navigation, world];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const n = c as NavLike;
      if (typeof n.findPath !== 'function') continue;
      if (n.ready === false) continue;
      this.external = n;
      return true;
    }
    return false;
  }

  get usingExternal(): boolean { return this.external !== null; }

  buildFallback(bounds: THREE.Box3, opts: NavGridOptions = {}): NavGrid | null {
    if (!this.physics || !this.physics.ready) return null;
    const grid = new NavGrid();
    this.bounds.copy(bounds);
    grid.build(this.physics, bounds, opts);
    this.grid = grid.ready ? grid : null;
    return this.grid;
  }

  /**
   * Fills `out` with a smoothed path from `from` to `to`. Returns the point
   * count; 0 means "no route", in which case callers should steer straight at
   * the goal and rely on local avoidance.
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3[]): number {
    this.searches++;
    const ext = this.external;
    if (ext && typeof ext.findPath === 'function') {
      // The world module's navmesh is another team's live code. If it throws —
      // a signature we guessed wrong, a half-built mesh — the AI must keep
      // pathing, not die. Two strikes and we fall back to our own grid for good.
      try {
        const res = ext.findPath(from, to, this.extPath);
        let n = 0;
        if (typeof res === 'number') n = Math.min(res, this.extPath.length);
        else if (Array.isArray(res)) {
          n = res.length;
          for (let i = 0; i < n; i++) pushPoint(this.extPath, i, res[i]);
        }
        if (n > 0) {
          for (let i = 0; i < n; i++) pushPoint(out, i, this.extPath[i]);
          return n;
        }
        // External nav said "no route" — fall through to the grid rather than
        // stranding the agent.
      } catch (err) {
        this.externalFailures++;
        if (this.externalFailures <= 1) {
          console.warn('[ai] world navmesh findPath threw; using the sampled grid', err);
        }
        if (this.externalFailures >= 2) this.external = null;
      }
    }

    const grid = this.grid;
    if (grid && grid.ready) {
      const n = grid.search(from, to, this.raw);
      if (n > 0) return this.smooth(grid, from, n, out);
    }

    pushPoint(out, 0, to);
    return 1;
  }

  /**
   * String-pulls the raw cell path, then pushes each surviving corner away from
   * nearby geometry so agents round corners instead of scraping them.
   */
  private smooth(grid: NavGrid, from: THREE.Vector3, count: number, out: THREE.Vector3[]): number {
    const raw = this.raw;
    const tmp = this.smoothScratch;
    let n = 0;
    pushPoint(tmp, n++, from);
    let i = 0;
    let guard = count + 4;
    while (i < count - 1 && guard-- > 0) {
      let j = count - 1;
      for (; j > i + 1; j--) {
        if (grid.lineOfWalk(tmp[n - 1], raw[j])) break;
      }
      pushPoint(tmp, n++, raw[j]);
      i = j;
    }
    if (n === 1) pushPoint(tmp, n++, raw[count - 1]);

    // Corner clearance: nudge intermediate waypoints toward open space.
    for (let k = 0; k < n; k++) {
      const p = tmp[k];
      if (k > 0 && k < n - 1) this.pushOffWalls(grid, p);
      pushPoint(out, k, p);
    }
    return n;
  }

  private pushOffWalls(grid: NavGrid, p: THREE.Vector3): void {
    const i = grid.indexAt(p.x, p.z);
    if (i < 0 || grid.clearance[i] > 2) return;
    const ix = i % grid.nx, iz = (i / grid.nx) | 0;
    let ax = 0, az = 0;
    for (let k = 0; k < 8; k++) {
      const jx = ix + NEIGH[k * 2], jz = iz + NEIGH[k * 2 + 1];
      if (!grid.inside(jx, jz) || grid.flags[jz * grid.nx + jx] !== CELL_WALK) {
        ax -= NEIGH[k * 2];
        az -= NEIGH[k * 2 + 1];
      }
    }
    const len = Math.hypot(ax, az);
    if (len < 1e-4) return;
    const push = Math.min(grid.cell * 0.55, 0.42);
    p.x += (ax / len) * push;
    p.z += (az / len) * push;
  }

  /** True when a straight walk between two points is possible. */
  canWalk(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const grid = this.grid;
    if (grid && grid.ready) return grid.lineOfWalk(a, b);
    const phys = this.physics;
    if (!phys) return true;
    _v0.copy(a); _v0.y += 0.9;
    _v1.copy(b); _v1.y += 0.9;
    return phys.lineOfSight(_v0, _v1, MASK_MOVE);
  }

  /** Snaps to navigable ground. Falls back to a downward physics probe. */
  snap(p: THREE.Vector3, out: THREE.Vector3): boolean {
    const grid = this.grid;
    if (grid && grid.ready && grid.snap(p, out)) return true;
    const phys = this.physics;
    if (phys && phys.ready) {
      _v0.copy(p); _v0.y += 1.6;
      phys.raycast(_v0, _down, 12, MASK_MOVE, _hit);
      if (_hit.hit) { out.copy(_hit.point); return true; }
    }
    out.copy(p);
    return false;
  }

  /** Ground height under a point, or the point's own y when unknown. */
  groundY(p: THREE.Vector3): number {
    const grid = this.grid;
    if (grid && grid.ready) {
      const i = grid.indexAt(p.x, p.z);
      if (i >= 0 && grid.flags[i] === CELL_WALK) return grid.floor[i];
    }
    const phys = this.physics;
    if (phys && phys.ready) {
      _v0.copy(p); _v0.y += 1.4;
      phys.raycast(_v0, _down, 10, MASK_MOVE, _hit);
      if (_hit.hit) return _hit.point.y;
    }
    return p.y;
  }

  /**
   * Random navigable point in an annulus around `centre`. Used for search
   * behaviour and for flank waypoint generation.
   */
  wander(
    centre: THREE.Vector3, minR: number, maxR: number, rand: () => number,
    out: THREE.Vector3,
  ): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rand() * Math.PI * 2;
      const r = minR + rand() * (maxR - minR);
      _v2.set(centre.x + Math.cos(a) * r, centre.y, centre.z + Math.sin(a) * r);
      if (this.snap(_v2, out)) return true;
    }
    out.copy(centre);
    return false;
  }

  /** Clear line for shooting, honouring physics when it is up. */
  visible(from: THREE.Vector3, to: THREE.Vector3, ignoreEntity = -1): boolean {
    const phys = this.physics;
    if (!phys || !phys.ready) return true;
    return phys.lineOfSight(from, to, MASK_SIGHT, ignoreEntity);
  }
}
