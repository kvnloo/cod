/**
 * Cover.
 *
 * A cover point is a place to *stand*, plus the fact that something solid is
 * between that place and where the shooting is coming from. Which means cover is
 * not a property of the point — it is a property of the point **and the current
 * threat direction**, which is why every score here is recomputed against the
 * live threat rather than baked at level build time.
 *
 * Sources, in order of preference:
 *   1. `world.nav.coverNear()` / `world.cover` — hand placed or navmesh derived,
 *   2. points harvested from the fallback nav grid's wall-adjacent cells,
 *   3. a runtime probe around the agent when neither exists.
 *
 * Scoring rewards a spot that (a) actually blocks the threat, (b) offers a peek
 * from at least one side, (c) is reachable, (d) is not where a squadmate already
 * is, and — for advancing — (e) is closer to the enemy than where we stand now.
 */

import * as THREE from 'three';
import type { PhysicsAPI, RayHit } from '../physics/types';
import { MASK_SIGHT } from '../physics/types';
import { makeHit, clamp01, falloff } from './Util';
import type { NavGrid, NavService } from './Nav';
import type { WorldCoverLike } from './types';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _hit: RayHit = makeHit();

/** Eye height when standing behind high cover. */
const EYE_HIGH = 1.58;
/** Eye height when crouched behind low cover. */
const EYE_LOW = 1.06;
/** How far the agent leans sideways to peek. */
export const PEEK_OFFSET = 0.62;

export interface CoverPoint {
  id: number;
  /** Where the agent stands. */
  readonly position: THREE.Vector3;
  /** Unit vector pointing away from the obstacle, into the open. */
  readonly normal: THREE.Vector3;
  height: 'low' | 'high';
  /** Height of the obstacle above the floor, metres. */
  obstacleHeight: number;
  /** Agent id that owns this spot, or -1. */
  occupant: number;
  /** Time (sim seconds) the reservation lapses. */
  reservedUntil: number;
  lastUsed: number;
  /** Set by the most recent evaluation — for gizmos. */
  debugScore: number;
  debugProtected: boolean;
}

export interface CoverQuery {
  /** Who is asking. */
  agentId: number;
  from: THREE.Vector3;
  threat: THREE.Vector3;
  /** Preferred distance to the threat. */
  idealRange: number;
  /** Reject anything further than this from `from`. */
  maxTravel: number;
  /** > 0 rewards closing the distance, < 0 rewards backing off. */
  advanceBias: number;
  /** Rewards points to the side of the threat's facing. */
  flankBias: number;
  /** Rewards points that can shoot back. */
  peekWeight: number;
  now: number;
}

export interface CoverResult {
  point: CoverPoint | null;
  score: number;
  protectedFromThreat: boolean;
  canPeekLeft: boolean;
  canPeekRight: boolean;
}

export class CoverSystem {
  points: CoverPoint[] = [];
  private buckets = new Map<number, number[]>();
  private bucketSize = 5;
  private nextId = 1;
  physics: PhysicsAPI | null = null;
  /** Scratch results so `query` allocates nothing. */
  private readonly result: CoverResult = {
    point: null, score: -Infinity, protectedFromThreat: false,
    canPeekLeft: false, canPeekRight: false,
  };
  private candidates: CoverPoint[] = [];
  private probePoints: CoverPoint[] = [];

  constructor() {
    for (let i = 0; i < 12; i++) this.probePoints.push(this.makePoint());
  }

  private makePoint(): CoverPoint {
    return {
      id: this.nextId++,
      position: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 0, 1),
      height: 'high',
      obstacleHeight: 1.6,
      occupant: -1,
      reservedUntil: -1,
      lastUsed: -1e9,
      debugScore: 0,
      debugProtected: false,
    };
  }

  clear(): void {
    this.points.length = 0;
    this.buckets.clear();
  }

  /** Adds a point, rejecting anything too close to an existing one. */
  add(position: THREE.Vector3, normal: THREE.Vector3, height: 'low' | 'high', obstacleHeight: number, minSpacing = 1.05): CoverPoint | null {
    if (minSpacing > 0 && this.hasNear(position, minSpacing)) return null;
    const p = this.makePoint();
    p.position.copy(position);
    p.normal.copy(normal).normalize();
    p.height = height;
    p.obstacleHeight = obstacleHeight;
    this.points.push(p);
    this.bucketOf(position).push(this.points.length - 1);
    return p;
  }

  private key(x: number, z: number): number {
    const ix = Math.floor(x / this.bucketSize) + 512;
    const iz = Math.floor(z / this.bucketSize) + 512;
    return ix * 1024 + iz;
  }

  private bucketOf(p: THREE.Vector3): number[] {
    const k = this.key(p.x, p.z);
    let b = this.buckets.get(k);
    if (!b) { b = []; this.buckets.set(k, b); }
    return b;
  }

  private hasNear(p: THREE.Vector3, radius: number): boolean {
    const r2 = radius * radius;
    const ix = Math.floor(p.x / this.bucketSize);
    const iz = Math.floor(p.z / this.bucketSize);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = this.buckets.get(((ix + dx) + 512) * 1024 + (iz + dz) + 512);
        if (!b) continue;
        for (const idx of b) {
          if (this.points[idx].position.distanceToSquared(p) < r2) return true;
        }
      }
    }
    return false;
  }

  /** Collects candidate points within `radius`, appending to `out`. */
  near(p: THREE.Vector3, radius: number, out: CoverPoint[]): number {
    out.length = 0;
    const r2 = radius * radius;
    const span = Math.ceil(radius / this.bucketSize);
    const ix = Math.floor(p.x / this.bucketSize);
    const iz = Math.floor(p.z / this.bucketSize);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const b = this.buckets.get(((ix + dx) + 512) * 1024 + (iz + dz) + 512);
        if (!b) continue;
        for (const idx of b) {
          const c = this.points[idx];
          if (c.position.distanceToSquared(p) <= r2) out.push(c);
        }
      }
    }
    return out.length;
  }

  /* ---------------------------------------------------------- ingestion --- */

  /** Takes hand-authored cover from the world module. */
  ingestWorld(list: readonly WorldCoverLike[]): number {
    let n = 0;
    for (const c of list) {
      if (!c || !c.position || !c.normal) continue;
      const h = c.height ?? 'high';
      if (this.add(c.position, c.normal, h, h === 'low' ? 1.05 : 1.75, 0.6)) n++;
    }
    return n;
  }

  /** Asks a navmesh service for cover, duck-typing whatever it returns. */
  ingestNav(nav: NavService, centre: THREE.Vector3, radius: number): number {
    const ext = nav.external;
    if (!ext || typeof ext.coverNear !== 'function') return 0;
    const bucket: unknown[] = [];
    let res: unknown;
    try {
      res = ext.coverNear(centre, radius, bucket);
    } catch (err) {
      console.warn('[ai] world coverNear threw; harvesting cover from the nav grid', err);
      return 0;
    }
    const list = Array.isArray(res) ? res : bucket;
    let n = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Partial<WorldCoverLike> & { pos?: THREE.Vector3; dir?: THREE.Vector3 };
      const pos = o.position ?? o.pos;
      const nrm = o.normal ?? o.dir;
      if (!pos || !nrm) continue;
      const h = o.height ?? 'high';
      if (this.add(pos, nrm, h, h === 'low' ? 1.05 : 1.75, 0.6)) n++;
    }
    return n;
  }

  /**
   * Harvests cover from the sampled nav grid: every walkable cell that touches
   * an obstacle is a candidate, classified by how tall that obstacle is.
   */
  generateFromGrid(grid: NavGrid, physics: PhysicsAPI, budget = 420): number {
    const { nx, nz, flags, floor, clearance, cell } = grid;
    let made = 0;
    // Coarse stride keeps the point set even and the cost bounded on big maps.
    for (let iz = 1; iz < nz - 1 && made < budget; iz++) {
      for (let ix = 1; ix < nx - 1 && made < budget; ix++) {
        const i = iz * nx + ix;
        if (flags[i] !== 1 || clearance[i] !== 1) continue;

        // Outward normal = away from the blocked neighbours.
        let ax = 0, az = 0, blocked = 0;
        for (let k = 0; k < 8; k++) {
          const dx = NEIGH8[k * 2], dz = NEIGH8[k * 2 + 1];
          const j = (iz + dz) * nx + (ix + dx);
          if (flags[j] === 1) continue;
          ax -= dx; az -= dz; blocked++;
        }
        if (blocked === 0 || blocked > 5) continue;
        const len = Math.hypot(ax, az);
        if (len < 1e-4) continue;
        _v0.set(ax / len, 0, az / len);

        const fy = floor[i];
        _v1.set(grid.min.x + (ix + 0.5) * cell, fy, grid.min.z + (iz + 0.5) * cell);

        // How tall is the thing we would be hiding behind? Probe at knee, chest
        // and head height straight into it.
        _v2.copy(_v0).negate();
        const reach = cell * 1.9;
        _v1.y = fy + 0.45;
        physics.raycast(_v1, _v2, reach, MASK_SIGHT, _hit);
        if (!_hit.hit) continue;               // ledge or pit, not cover
        _v1.y = fy + 1.15;
        physics.raycast(_v1, _v2, reach, MASK_SIGHT, _hit);
        const chest = _hit.hit;
        _v1.y = fy + 1.72;
        physics.raycast(_v1, _v2, reach, MASK_SIGHT, _hit);
        const head = _hit.hit;

        _v1.y = fy;
        const height: 'low' | 'high' = head ? 'high' : 'low';
        const obstacleHeight = head ? 2.0 : chest ? 1.35 : 0.85;
        // Stand a touch off the wall so the capsule is not fighting it.
        _v1.addScaledVector(_v0, Math.min(0.28, cell * 0.35));
        if (this.add(_v1, _v0, height, obstacleHeight, Math.max(1.0, cell * 1.4))) made++;
      }
    }
    return made;
  }

  /* ---------------------------------------------------------- selection --- */

  /**
   * Runtime probe used when no static cover exists nearby: fans out around the
   * agent, keeps directions where geometry blocks the threat.
   */
  probeAround(from: THREE.Vector3, threat: THREE.Vector3, nav: NavService, radius = 5.5): number {
    const physics = this.physics;
    if (!physics || !physics.ready) return 0;
    let n = 0;
    for (let k = 0; k < 12 && n < this.probePoints.length; k++) {
      const a = (k / 12) * Math.PI * 2;
      _v0.set(from.x + Math.cos(a) * radius, from.y, from.z + Math.sin(a) * radius);
      if (!nav.snap(_v0, _v1)) continue;
      _v1.y += 1.0;
      _v2.copy(threat); _v2.y += 1.5;
      if (physics.lineOfSight(_v1, _v2, MASK_SIGHT)) continue;  // no protection
      _v1.y -= 1.0;
      const p = this.probePoints[n++];
      p.position.copy(_v1);
      p.normal.copy(_v2).sub(_v1).setY(0).normalize().negate();
      p.height = 'high';
      p.obstacleHeight = 1.7;
      p.occupant = -1;
      p.reservedUntil = -1;
    }
    this.probeCount = n;
    return n;
  }
  private probeCount = 0;

  /**
   * Picks the best cover for a query. Returns a shared result object — copy what
   * you need out of it before the next call.
   */
  query(q: CoverQuery, useProbes = false): CoverResult {
    const r = this.result;
    r.point = null; r.score = -Infinity;
    r.protectedFromThreat = false; r.canPeekLeft = false; r.canPeekRight = false;

    let list: CoverPoint[];
    if (useProbes) {
      this.probeView.length = 0;
      for (let i = 0; i < this.probeCount; i++) this.probeView.push(this.probePoints[i]);
      list = this.probeView;
    } else {
      this.near(q.from, q.maxTravel, this.candidates);
      list = this.candidates;
    }
    if (list.length === 0) return r;

    // Cheap pre-rank so the expensive ray tests only run on plausible spots.
    let evaluated = 0;
    const maxEvaluate = 10;
    // Sort by a cheap heuristic. Entries come from a pool so this allocates
    // nothing after the first few frames.
    const order = this.order;
    let used = 0;
    order.length = 0;
    for (const c of list) {
      if (c.occupant >= 0 && c.occupant !== q.agentId && c.reservedUntil > q.now) continue;
      const travel = c.position.distanceTo(q.from);
      if (travel > q.maxTravel) continue;
      const toThreat = c.position.distanceTo(q.threat);
      if (toThreat < 3.0) continue;                      // do not run onto his muzzle
      _v0.copy(q.threat).sub(c.position).setY(0);
      const dist = _v0.length() || 1;
      _v0.multiplyScalar(1 / dist);
      // Normal must point at least somewhat away from the threat.
      const facing = c.normal.dot(_v0);
      if (facing > 0.45) continue;                       // wall is behind us
      const rangeScore = 1 - Math.abs(toThreat - q.idealRange) / Math.max(8, q.idealRange);
      const travelScore = falloff(travel, 1.5, q.maxTravel);
      const advance = (q.from.distanceTo(q.threat) - toThreat) * q.advanceBias * 0.09;
      const slot = this.entryPool[used] ?? (this.entryPool[used] = { c, pre: 0 });
      used++;
      slot.c = c;
      slot.pre = rangeScore * 0.8 + travelScore * 0.9 + advance - facing * 0.5;
      order.push(slot);
    }
    if (order.length === 0) return r;
    order.sort(byPre);

    for (const entry of order) {
      if (evaluated >= maxEvaluate) break;
      evaluated++;
      const c = entry.c;
      const score = this.evaluate(c, q);
      c.debugScore = score;
      if (score > r.score) {
        r.score = score;
        r.point = c;
        r.protectedFromThreat = this.lastProtected;
        r.canPeekLeft = this.lastPeekL;
        r.canPeekRight = this.lastPeekR;
      }
    }
    return r;
  }
  private order: Array<{ c: CoverPoint; pre: number }> = [];
  private entryPool: Array<{ c: CoverPoint; pre: number }> = [];
  private probeView: CoverPoint[] = [];
  private lastProtected = false;
  private lastPeekL = false;
  private lastPeekR = false;

  /** Full evaluation of one point, including the ray tests. */
  evaluate(c: CoverPoint, q: CoverQuery): number {
    const physics = this.physics;
    const eyeY = c.height === 'low' ? EYE_LOW : EYE_HIGH;
    _v1.copy(c.position); _v1.y += eyeY;
    _v2.copy(q.threat); _v2.y += 1.5;

    let protectedFrom = true;
    if (physics && physics.ready) protectedFrom = !physics.lineOfSight(_v1, _v2, MASK_SIGHT);
    this.lastProtected = protectedFrom;
    c.debugProtected = protectedFrom;

    // Peek tests: step out sideways and see whether we get a shot.
    _v0.copy(q.threat).sub(c.position).setY(0).normalize();
    _right.set(_v0.z, 0, -_v0.x);
    let peekL = false, peekR = false;
    if (physics && physics.ready) {
      _v1.copy(c.position).addScaledVector(_right, PEEK_OFFSET);
      _v1.y += EYE_HIGH;
      peekL = physics.lineOfSight(_v1, _v2, MASK_SIGHT);
      _v1.copy(c.position).addScaledVector(_right, -PEEK_OFFSET);
      _v1.y += EYE_HIGH;
      peekR = physics.lineOfSight(_v1, _v2, MASK_SIGHT);
      if (!peekL && !peekR && c.height === 'low') {
        // Low cover: you can always pop straight up over it.
        _v1.copy(c.position); _v1.y += EYE_HIGH;
        peekL = peekR = physics.lineOfSight(_v1, _v2, MASK_SIGHT);
      }
    } else {
      peekL = peekR = true;
    }
    this.lastPeekL = peekL;
    this.lastPeekR = peekR;

    const travel = c.position.distanceTo(q.from);
    const toThreat = c.position.distanceTo(q.threat);

    let score = 0;
    score += protectedFrom ? 2.4 : -1.8;
    score += (peekL || peekR) ? q.peekWeight : -q.peekWeight * 0.75;
    score += (peekL && peekR) ? 0.25 : 0;                       // two exits is better
    score += 1.5 * falloff(travel, 1.0, q.maxTravel);
    score += 1.1 * (1 - clamp01(Math.abs(toThreat - q.idealRange) / Math.max(6, q.idealRange)));
    score += q.advanceBias * clamp01((q.from.distanceTo(q.threat) - toThreat) / 12) * 1.6;

    // Flanking: reward points off the axis the threat is currently facing.
    if (q.flankBias !== 0) {
      _v0.copy(q.from).sub(q.threat).setY(0).normalize();
      _v1.copy(c.position).sub(q.threat).setY(0).normalize();
      const swing = 1 - clamp01(_v0.dot(_v1) * 0.5 + 0.5);
      score += q.flankBias * swing * 2.2;
    }

    // High cover is safer; low cover shoots better. Slight preference for high.
    score += c.height === 'high' ? 0.22 : 0.08;
    // Freshness: do not oscillate back to a spot we just left.
    if (q.now - c.lastUsed < 6) score -= 0.9;
    if (c.occupant >= 0 && c.occupant !== q.agentId) score -= 3;
    return score;
  }

  /** Reserves a point for an agent. Returns false when someone else holds it. */
  reserve(c: CoverPoint, agentId: number, now: number, seconds = 20): boolean {
    if (c.occupant >= 0 && c.occupant !== agentId && c.reservedUntil > now) return false;
    c.occupant = agentId;
    c.reservedUntil = now + seconds;
    return true;
  }

  release(c: CoverPoint, agentId: number, now: number): void {
    if (c.occupant !== agentId) return;
    c.occupant = -1;
    c.reservedUntil = -1;
    c.lastUsed = now;
  }

  /** Drops stale reservations from dead agents. */
  tick(now: number, isAlive: (id: number) => boolean): void {
    for (const c of this.points) {
      if (c.occupant < 0) continue;
      if (c.reservedUntil < now || !isAlive(c.occupant)) {
        c.occupant = -1;
        c.reservedUntil = -1;
      }
    }
  }
}

const NEIGH8 = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
function byPre(a: { pre: number }, b: { pre: number }): number { return b.pre - a.pre; }
