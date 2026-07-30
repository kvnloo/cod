/**
 * Navmesh queries: A* over polygons, funnel string-pulling, ground snapping,
 * navigation raycasts and tactical cover selection.
 *
 * This is the surface the AI module consumes. Everything is allocation-light in
 * the steady state — the open list, the came-from table and the corridor buffer
 * are all reused between queries, and the only allocations a caller sees are the
 * `Vector3`s in the returned path (into a caller-supplied array when given).
 */

import * as THREE from 'three';
import type { CoverPoint, NavLink, NavMeshData, NavPoly } from './NavMesh';

export interface PathResult {
  /** Straightened waypoints, including the start and the goal. */
  points: THREE.Vector3[];
  /** Polygon corridor the path runs through. */
  corridor: number[];
  /** True when the goal polygon was reached; false means a partial path. */
  complete: boolean;
  length: number;
}

export interface CoverQuery {
  /** Maximum distance from `pos` to consider. */
  radius?: number;
  /** Prefer cover that also breaks line of sight to this point. */
  threat?: THREE.Vector3;
  /** Only 'high' cover (stand and shoot) or only 'low' (crouch). */
  height?: 'low' | 'high';
  /** Reject cover closer than this to the threat. */
  minThreatDistance?: number;
  /** Result count. */
  max?: number;
}

export interface ScoredCover {
  point: CoverPoint;
  score: number;
}

const HEAP_INIT = 1024;

export class NavQuery {
  private g: Float32Array;
  private f: Float32Array;
  private cameFrom: Int32Array;
  private closed: Int32Array;
  private stamp: Int32Array;
  private currentStamp = 0;
  private heap: Int32Array;
  private heapKey: Float32Array;
  private heapSize = 0;
  private corridor: number[] = [];
  private portalsL: number[] = [];
  private portalsR: number[] = [];
  private portalsY: number[] = [];
  private coverScratch: ScoredCover[] = [];

  constructor(readonly data: NavMeshData) {
    const n = data.polys.length;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.heap = new Int32Array(Math.max(HEAP_INIT, n * 2));
    this.heapKey = new Float32Array(Math.max(HEAP_INIT, n * 2));
  }

  get polyCount(): number { return this.data.polys.length; }
  get coverCount(): number { return this.data.cover.length; }

  /* ------------------------------------------------------------ lookups -- */

  /** Polygon directly under/over a world point, or -1. */
  polyAt(x: number, y: number, z: number, tolerance = 2.0): number {
    const f = this.data.field;
    const i = f.gridI(x), j = f.gridJ(z);
    const c = f.nearestCell(i, j, y, tolerance);
    if (c < 0) return -1;
    return this.data.cellPoly[c];
  }

  /**
   * Nearest polygon to a world point, searching outward in rings. Used whenever
   * an agent or a query point might be slightly off the mesh.
   */
  nearestPoly(p: THREE.Vector3, maxRadius = 6): number {
    const direct = this.polyAt(p.x, p.y, p.z, 2.0);
    if (direct >= 0) return direct;
    const f = this.data.field;
    const cs = f.cfg.cs;
    const rings = Math.max(1, Math.ceil(maxRadius / cs));
    const ci = f.gridI(p.x), cj = f.gridJ(p.z);
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= rings; r++) {
      for (let d = -r; d <= r; d++) {
        for (const [i, j] of [
          [ci + d, cj - r], [ci + d, cj + r], [ci - r, cj + d], [ci + r, cj + d],
        ] as const) {
          const c = f.nearestCell(i, j, p.y, 4.0);
          if (c < 0) continue;
          const poly = this.data.cellPoly[c];
          if (poly < 0) continue;
          const dx = f.worldX(i) - p.x, dz = f.worldZ(j) - p.z, dy = f.y[c] - p.y;
          const dist = dx * dx + dz * dz + dy * dy * 0.5;
          if (dist < bestD) { bestD = dist; best = poly; }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** Snaps a point on to the mesh surface; returns false when off-mesh. */
  snap(p: THREE.Vector3, out: THREE.Vector3, maxRadius = 4): boolean {
    const poly = this.nearestPoly(p, maxRadius);
    if (poly < 0) return false;
    const q = this.data.polys[poly];
    out.set(
      THREE.MathUtils.clamp(p.x, q.x0 + 0.05, q.x1 - 0.05),
      q.y,
      THREE.MathUtils.clamp(p.z, q.z0 + 0.05, q.z1 - 0.05),
    );
    return true;
  }

  /** Height of the navigable floor under a point, or NaN. */
  floorAt(x: number, y: number, z: number): number {
    const p = this.polyAt(x, y, z, 3.0);
    return p >= 0 ? this.data.polys[p].y : NaN;
  }

  /* ---------------------------------------------------------------- A* -- */

  findPath(from: THREE.Vector3, to: THREE.Vector3, out?: PathResult): PathResult {
    const result: PathResult = out ?? { points: [], corridor: [], complete: false, length: 0 };
    result.points.length = 0;
    result.corridor.length = 0;
    result.complete = false;
    result.length = 0;

    const startPoly = this.nearestPoly(from, 6);
    const goalPoly = this.nearestPoly(to, 8);
    if (startPoly < 0 || goalPoly < 0) return result;
    if (startPoly === goalPoly) {
      result.points.push(from.clone(), to.clone());
      result.corridor.push(startPoly);
      result.complete = true;
      result.length = from.distanceTo(to);
      return result;
    }

    const polys = this.data.polys;
    const goal = polys[goalPoly].centre;
    this.currentStamp++;
    const s = this.currentStamp;
    this.heapSize = 0;

    this.stamp[startPoly] = s;
    this.g[startPoly] = 0;
    this.f[startPoly] = polys[startPoly].centre.distanceTo(goal);
    this.cameFrom[startPoly] = -1;
    this.push(startPoly, this.f[startPoly]);

    let found = false;
    let bestPartial = startPoly;
    let bestPartialH = this.f[startPoly];
    let guard = 0;
    const guardLimit = polys.length * 4 + 512;

    while (this.heapSize > 0 && guard++ < guardLimit) {
      const cur = this.pop();
      if (this.closed[cur] === s) continue;   // stale duplicate from a re-push
      this.closed[cur] = s;
      if (cur === goalPoly) { found = true; break; }
      const p = polys[cur];
      const h = p.centre.distanceTo(goal);
      if (h < bestPartialH) { bestPartialH = h; bestPartial = cur; }

      for (const link of p.links) {
        const nb = link.to;
        const tentative = this.g[cur] + link.cost;
        if (this.stamp[nb] !== s) {
          this.stamp[nb] = s;
          this.g[nb] = Infinity;
          this.cameFrom[nb] = -1;
        }
        if (tentative >= this.g[nb]) continue;
        this.g[nb] = tentative;
        this.f[nb] = tentative + polys[nb].centre.distanceTo(goal);
        this.cameFrom[nb] = cur;
        this.push(nb, this.f[nb]);
      }
    }

    const endPoly = found ? goalPoly : bestPartial;
    // Rebuild the corridor.
    this.corridor.length = 0;
    let c = endPoly;
    while (c >= 0) {
      this.corridor.push(c);
      if (c === startPoly) break;
      c = this.cameFrom[c];
    }
    this.corridor.reverse();
    for (const id of this.corridor) result.corridor.push(id);
    result.complete = found;

    const goalPoint = found ? to : polys[endPoly].centre;
    this.funnel(from, goalPoint, result.points);
    this.simplify(result.points);
    for (let i = 1; i < result.points.length; i++) {
      result.length += result.points[i].distanceTo(result.points[i - 1]);
    }
    return result;
  }

  /**
   * Greedy line-of-walk simplification.
   *
   * The funnel is only optimal within its corridor, and a corridor built from
   * small axis-aligned rectangles meanders. Skipping any waypoint that can be
   * walked past in a straight line pulls the path taut and removes the
   * staircase artefacts rectangles produce on diagonals.
   */
  private simplify(points: THREE.Vector3[]): void {
    if (points.length < 3) return;
    const out: THREE.Vector3[] = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      let best = i + 1;
      for (let j = points.length - 1; j > i + 1; j--) {
        if (this.raycastNav(points[i], points[j])) { best = j; break; }
      }
      out.push(points[best]);
      i = best;
    }
    points.length = 0;
    for (const p of out) points.push(p);
  }

  /* -------------------------------------------------------------- funnel */

  /**
   * The "simple stupid funnel" string-pull over the corridor's portals. This is
   * what turns a chain of polygon centres into a path that hugs corners the way
   * a person would.
   */
  private funnel(start: THREE.Vector3, end: THREE.Vector3, out: THREE.Vector3[]): void {
    const polys = this.data.polys;
    const L = this.portalsL, R = this.portalsR, Y = this.portalsY;
    L.length = 0; R.length = 0; Y.length = 0;

    L.push(start.x, start.z); R.push(start.x, start.z); Y.push(start.y);
    for (let i = 0; i + 1 < this.corridor.length; i++) {
      const a = polys[this.corridor[i]];
      const bId = this.corridor[i + 1];
      // Two polygons can be joined by both a walk portal and a point-width
      // vault/drop link. Always string-pull through the widest one — a
      // zero-width portal pins the path to a single point and produces a
      // visible dog-leg.
      let link: NavLink | null = null;
      let widest = -1;
      for (const candidate of a.links) {
        if (candidate.to !== bId) continue;
        const w = Math.hypot(candidate.bx - candidate.ax, candidate.bz - candidate.az);
        if (w > widest) { widest = w; link = candidate; }
      }
      if (!link) continue;
      // Order the portal endpoints left/right relative to the travel direction.
      //
      // The comparisons below use Recast's signed-area convention, in which the
      // "left" funnel side is the one with a *negative* 2D cross product against
      // the travel direction. Getting this backwards does not fail loudly — the
      // funnel simply never closes (a straight line through walls) or closes on
      // the wrong side every step (a violent zig-zag).
      const dirX = polys[bId].centre.x - a.centre.x;
      const dirZ = polys[bId].centre.z - a.centre.z;
      const cross = (link.ax - a.centre.x) * dirZ - (link.az - a.centre.z) * dirX;
      if (cross < 0) {
        L.push(link.bx, link.bz); R.push(link.ax, link.az);
      } else {
        L.push(link.ax, link.az); R.push(link.bx, link.bz);
      }
      Y.push((link.ay + link.by) * 0.5);
    }
    L.push(end.x, end.z); R.push(end.x, end.z); Y.push(end.y);

    const n = Y.length;
    let apexX = L[0], apexZ = L[1], apexY = Y[0];
    let leftX = L[0], leftZ = L[1];
    let rightX = R[0], rightZ = R[1];
    let apexIndex = 0, leftIndex = 0, rightIndex = 0;

    out.push(new THREE.Vector3(apexX, apexY, apexZ));

    for (let i = 1; i < n; i++) {
      const lx = L[i * 2], lz = L[i * 2 + 1];
      const rx = R[i * 2], rz = R[i * 2 + 1];

      // right side
      if (tri(apexX, apexZ, rightX, rightZ, rx, rz) <= 0) {
        if (near(apexX, apexZ, rightX, rightZ)) {
          rightX = rx; rightZ = rz; rightIndex = i;
        } else if (tri(apexX, apexZ, leftX, leftZ, rx, rz) > 0) {
          rightX = rx; rightZ = rz; rightIndex = i;
        } else {
          // right crosses left: the left point becomes a corner
          out.push(new THREE.Vector3(leftX, Y[leftIndex], leftZ));
          apexX = leftX; apexZ = leftZ; apexY = Y[leftIndex]; apexIndex = leftIndex;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftIndex = apexIndex; rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
      // left side
      if (tri(apexX, apexZ, leftX, leftZ, lx, lz) >= 0) {
        if (near(apexX, apexZ, leftX, leftZ)) {
          leftX = lx; leftZ = lz; leftIndex = i;
        } else if (tri(apexX, apexZ, rightX, rightZ, lx, lz) < 0) {
          leftX = lx; leftZ = lz; leftIndex = i;
        } else {
          out.push(new THREE.Vector3(rightX, Y[rightIndex], rightZ));
          apexX = rightX; apexZ = rightZ; apexY = Y[rightIndex]; apexIndex = rightIndex;
          leftX = apexX; leftZ = apexZ; rightX = apexX; rightZ = apexZ;
          leftIndex = apexIndex; rightIndex = apexIndex;
          i = apexIndex;
          continue;
        }
      }
    }
    void apexY;
    const last = out[out.length - 1];
    if (!last || last.distanceToSquared(end) > 1e-6) out.push(end.clone());
  }

  /* ------------------------------------------------------------- raycast */

  /**
   * Walks the mesh from `from` toward `to`, stopping at the first point that
   * leaves the navigable surface. Cheap line-of-walk test for the AI.
   */
  raycastNav(from: THREE.Vector3, to: THREE.Vector3, hit?: THREE.Vector3): boolean {
    const f = this.data.field;
    const step = f.cfg.cs * 0.8;
    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return true;
    const steps = Math.ceil(dist / step);
    let lastY = from.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      const poly = this.polyAt(x, lastY, z, 1.2);
      if (poly < 0) {
        if (hit) {
          const back = (s - 1) / steps;
          hit.set(from.x + dx * back, lastY, from.z + dz * back);
        }
        return false;
      }
      lastY = this.data.polys[poly].y;
    }
    if (hit) hit.copy(to);
    return true;
  }

  /* ---------------------------------------------------------------- cover */

  /**
   * Ranked cover near a position. Scoring rewards being close to the agent,
   * facing the threat with the obstacle in between, and standing cover over
   * crouch cover when the query does not pin it.
   */
  coverNear(pos: THREE.Vector3, q: CoverQuery = {}): ScoredCover[] {
    const radius = q.radius ?? 14;
    const r2 = radius * radius;
    const max = q.max ?? 8;
    const out = this.coverScratch;
    out.length = 0;

    for (const point of this.data.cover) {
      if (q.height && point.height !== q.height) continue;
      const d2 = point.position.distanceToSquared(pos);
      if (d2 > r2) continue;
      let score = 1 - Math.sqrt(d2) / radius;
      if (q.threat) {
        const tx = q.threat.x - point.position.x;
        const tz = q.threat.z - point.position.z;
        const tl = Math.hypot(tx, tz) || 1;
        // The cover's normal points at the exposed side; we want the obstacle
        // between the agent and the threat, i.e. the normal facing the threat.
        const facing = (point.normal.x * tx + point.normal.z * tz) / tl;
        if (facing < 0.15) continue;
        score += facing * 1.4;
        const threatDist = Math.hypot(tx, tz);
        if (q.minThreatDistance && threatDist < q.minThreatDistance) continue;
        score += THREE.MathUtils.clamp(threatDist / 40, 0, 0.6);
      }
      if (!q.height) score += point.height === 'high' ? 0.35 : 0;
      out.push({ point, score });
    }
    out.sort((a, b) => b.score - a.score);
    if (out.length > max) out.length = max;
    return out;
  }

  /* ------------------------------------------------------------ heap ops */

  /**
   * Lazy-deletion binary heap: a decreased key is pushed as a duplicate and the
   * stale copy is skipped on pop. Avoids an O(n) index search per relaxation.
   */
  private push(poly: number, key: number): void {
    if (this.heapSize >= this.heap.length) {
      const bigger = new Int32Array(this.heap.length * 2);
      bigger.set(this.heap);
      this.heap = bigger;
      const biggerKey = new Float32Array(this.heapKey.length * 2);
      biggerKey.set(this.heapKey);
      this.heapKey = biggerKey;
    }
    this.heap[this.heapSize] = poly;
    this.heapKey[this.heapSize] = key;
    this.siftUp(this.heapSize++);
  }

  private pop(): number {
    const top = this.heap[0];
    this.heapSize--;
    if (this.heapSize > 0) {
      this.heap[0] = this.heap[this.heapSize];
      this.heapKey[0] = this.heapKey[this.heapSize];
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const h = this.heap, k = this.heapKey;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent] <= k[i]) break;
      const t = h[parent]; h[parent] = h[i]; h[i] = t;
      const tk = k[parent]; k[parent] = k[i]; k[i] = tk;
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const h = this.heap, k = this.heapKey;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let best = i;
      if (l < this.heapSize && k[l] < k[best]) best = l;
      if (r < this.heapSize && k[r] < k[best]) best = r;
      if (best === i) break;
      const t = h[best]; h[best] = h[i]; h[i] = t;
      const tk = k[best]; k[best] = k[i]; k[i] = tk;
      i = best;
    }
  }
}

function tri(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function near(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz < 1e-8;
}

/** Debug visualisation of the navmesh, cover points and traversal links. */
export function navDebugMesh(data: NavMeshData): THREE.Group {
  const group = new THREE.Group();
  group.name = 'nav-debug';

  const pos: number[] = [];
  const col: number[] = [];
  const colour = new THREE.Color();
  for (const p of data.polys) {
    colour.setHSL((p.region * 0.137) % 1, 0.65, 0.55);
    const y = p.y + 0.05;
    const quad: [number, number][] = [[p.x0, p.z0], [p.x1, p.z0], [p.x1, p.z1], [p.x0, p.z1]];
    const order = [0, 1, 2, 0, 2, 3];
    for (const k of order) {
      pos.push(quad[k][0], y, quad[k][1]);
      col.push(colour.r, colour.g, colour.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.noCollide = true;
  mesh.userData.navIgnore = true;
  group.add(mesh);

  // Cover markers: an upright bar leaning along the cover normal.
  const lines: number[] = [];
  const lineCol: number[] = [];
  for (const c of data.cover) {
    const h = c.height === 'high' ? 1.5 : 0.85;
    lines.push(c.position.x, c.position.y + 0.05, c.position.z);
    lines.push(c.position.x + c.normal.x * 0.4, c.position.y + h, c.position.z + c.normal.z * 0.4);
    const r = c.height === 'high' ? 1 : 0.2;
    const g = c.height === 'high' ? 0.25 : 0.9;
    lineCol.push(r, g, 0.2, r, g, 0.2);
  }
  for (const l of data.links) {
    lines.push(l.from.x, l.from.y + 0.1, l.from.z, l.to.x, l.to.y + 0.1, l.to.z);
    const c = l.kind === 'vault' ? [0.2, 0.6, 1] : [1, 0.85, 0.1];
    lineCol.push(c[0], c[1], c[2], c[0], c[1], c[2]);
  }
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
  lgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lineCol), 3));
  const lseg = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true }));
  lseg.userData.noCollide = true;
  lseg.userData.navIgnore = true;
  group.add(lseg);

  return group;
}
