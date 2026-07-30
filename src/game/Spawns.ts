/**
 * Spawn point graph and selection.
 *
 * Two very different queries share one node set:
 *
 *   • **enemy spawns** must be *out of sight* — a soldier that pops into
 *     existence in the player's crosshair destroys the illusion instantly — and
 *     inside a distance band that keeps pressure on without teleporting fights
 *     into the player's lap.
 *   • **player/friendly respawns** must avoid spawn-trapping: no line of sight
 *     from a living hostile, a hard minimum separation, a bias toward friendly
 *     mass, and a cooldown so two players never share a pad.
 *
 * Nodes come from the level when it publishes them and are synthesised on a
 * deterministic lattice otherwise, so the director works against a grey-box.
 */

import * as THREE from 'three';
import type { Rand } from '../core/Rand';
import type { PhysicsAPI } from '../physics/types';
import { MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeRayHit } from './Services';
import type { WorldBridge } from './types';

export interface SpawnNode {
  id: number;
  position: THREE.Vector3;
  yaw: number;
  team: 'player' | 'enemy' | 'neutral';
  /** Match time this node was last used, seconds. */
  lastUsed: number;
  /** Cheap openness metric 0..1 from the build-time probe — open nodes are safer. */
  openness: number;
}

export interface SpawnQuery {
  /** Where the threat is coming from (usually the player's eye). */
  viewOrigin: THREE.Vector3;
  /** Normalised view direction. */
  viewDir: THREE.Vector3;
  /** cos(halfFov) — nodes inside this cone with line of sight are "visible". */
  viewCos: number;
  /** Ideal distance from `viewOrigin`, metres. */
  idealDistance: number;
  minDistance: number;
  maxDistance: number;
  /** Positions of live hostiles relative to the spawner. */
  threats: readonly THREE.Vector3[];
  /** Positions of live allies relative to the spawner. */
  allies: readonly THREE.Vector3[];
  /** Current match time, used for the reuse cooldown. */
  now: number;
  /** Node team filter. */
  team: 'player' | 'enemy' | 'neutral' | 'any';
  /** Reject visible nodes outright rather than just penalising them. */
  requireHidden: boolean;
  /** Seconds a node stays "hot" after being used. */
  cooldown: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export function defaultQuery(): SpawnQuery {
  return {
    viewOrigin: new THREE.Vector3(),
    viewDir: new THREE.Vector3(0, 0, -1),
    viewCos: Math.cos(THREE.MathUtils.degToRad(62)),
    idealDistance: 34,
    minDistance: 16,
    maxDistance: 78,
    threats: [],
    allies: [],
    now: 0,
    team: 'any',
    requireHidden: false,
    cooldown: 9,
  };
}

export class SpawnGraph {
  readonly nodes: SpawnNode[] = [];
  readonly bounds = new THREE.Box3(new THREE.Vector3(-60, -2, -60), new THREE.Vector3(60, 30, 60));
  /** Ground height used when no physics backend is available. */
  groundY = 0;

  private ray = makeRayHit();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _down = new THREE.Vector3(0, -1, 0);

  /**
   * Builds the node set. Level-published spawns are always kept; a lattice is
   * added underneath them until there are enough nodes for the selector to have
   * real choices.
   */
  build(world: WorldBridge | null, physics: PhysicsAPI | null, rng: Rand, minNodes = 28): void {
    this.nodes.length = 0;
    if (world?.bounds) this.bounds.copy(world.bounds);

    let id = 0;
    for (const s of world?.spawns ?? []) {
      this.nodes.push({
        id: id++,
        position: s.position.clone(),
        yaw: s.yaw,
        team: s.team,
        lastUsed: -999,
        openness: 1,
      });
    }
    // Cover points make excellent enemy entry positions — they are, by
    // construction, places a soldier can stand and be shot at from.
    for (const c of world?.cover ?? []) {
      if (this.nodes.length >= minNodes * 2) break;
      this._v.copy(c.position).addScaledVector(c.normal, -0.6);
      this.nodes.push({
        id: id++,
        position: this._v.clone(),
        yaw: Math.atan2(c.normal.x, c.normal.z),
        team: 'enemy',
        lastUsed: -999,
        openness: c.height === 'high' ? 0.5 : 0.8,
      });
    }

    if (this.nodes.length < minNodes) {
      const size = this._v.copy(this.bounds.max).sub(this.bounds.min);
      const cx = (this.bounds.min.x + this.bounds.max.x) * 0.5;
      const cz = (this.bounds.min.z + this.bounds.max.z) * 0.5;
      const rx = Math.max(8, size.x * 0.42);
      const rz = Math.max(8, size.z * 0.42);
      // Two concentric rings + jitter: cheap, deterministic, and gives the
      // selector both close-pressure and flanking options.
      const rings = [0.55, 0.92];
      const perRing = Math.ceil((minNodes - this.nodes.length) / rings.length);
      for (const t of rings) {
        for (let i = 0; i < perRing; i++) {
          const a = (i / perRing) * Math.PI * 2 + rng.range(-0.06, 0.06) + t;
          const x = cx + Math.cos(a) * rx * t * rng.range(0.9, 1.05);
          const z = cz + Math.sin(a) * rz * t * rng.range(0.9, 1.05);
          const y = this.probeGround(x, z, physics);
          if (y === null) continue;
          this.nodes.push({
            id: id++,
            position: new THREE.Vector3(x, y, z),
            yaw: Math.atan2(cx - x, cz - z),
            team: 'enemy',
            lastUsed: -999,
            openness: t,
          });
        }
      }
    }

    if (this.nodes.length === 0) {
      // Absolute last resort so the director always has somewhere to put an actor.
      this.nodes.push({
        id: 0, position: new THREE.Vector3(0, this.groundY, 0), yaw: 0,
        team: 'neutral', lastUsed: -999, openness: 1,
      });
    }
  }

  /** Drops a vertical probe to find standable ground; null when there is none. */
  private probeGround(x: number, z: number, physics: PhysicsAPI | null): number | null {
    if (!physics?.ready) return this.groundY;
    this._w.set(x, this.bounds.max.y * 0.5 + 6, z);
    const hit = physics.raycast(this._w, this._down, 90, MASK_MOVE, this.ray);
    if (!hit.hit) return null;
    if (hit.normal.dot(UP) < 0.55) return null; // too steep to stand on
    return hit.point.y;
  }

  markUsed(node: SpawnNode, now: number): void {
    node.lastUsed = now;
  }

  /**
   * Scores every candidate and returns the best. Never returns null once the
   * graph has nodes: the query constraints are soft so a bad situation still
   * produces the least-bad spawn.
   */
  pick(q: SpawnQuery, physics: PhysicsAPI | null, rng: Rand): SpawnNode | null {
    if (this.nodes.length === 0) return null;
    let best: SpawnNode | null = null;
    let bestScore = -Infinity;
    let bestHidden: SpawnNode | null = null;
    let bestHiddenScore = -Infinity;

    for (const n of this.nodes) {
      if (q.team !== 'any' && n.team !== q.team && n.team !== 'neutral') continue;

      const d = this._v.copy(n.position).sub(q.viewOrigin).length();
      if (d > q.maxDistance * 1.6) continue;

      let score = 0;

      /* distance band — a soft bell around the ideal engagement range */
      const band = Math.abs(d - q.idealDistance) / Math.max(1, q.idealDistance);
      score += 30 * Math.exp(-band * band * 2.2);
      if (d < q.minDistance) score -= 60 * (1 - d / Math.max(0.001, q.minDistance));
      if (d > q.maxDistance) score -= 24 * ((d - q.maxDistance) / Math.max(1, q.maxDistance));

      /* visibility — the dominant term for enemy spawns */
      const visible = this.isVisible(n.position, q, physics);
      if (visible) score -= 85;

      /* threat proximity: a spawn inside a hostile's lap is a spawn trap */
      let nearestThreat = Infinity;
      let threatLos = false;
      for (const t of q.threats) {
        const td = n.position.distanceTo(t);
        if (td < nearestThreat) nearestThreat = td;
        if (!threatLos && td < 42 && this.hasLineOfSight(n.position, t, physics)) threatLos = true;
      }
      if (nearestThreat < 24) score -= 55 * (1 - nearestThreat / 24);
      if (threatLos) score -= 45;

      /* friendly mass: respawning next to a squadmate feels safe and reads well */
      let nearestAlly = Infinity;
      for (const a of q.allies) nearestAlly = Math.min(nearestAlly, n.position.distanceTo(a));
      if (nearestAlly < 30) score += 14 * (1 - nearestAlly / 30);

      /* reuse cooldown so a wave does not stream out of one doorway */
      const since = q.now - n.lastUsed;
      if (since < q.cooldown) score -= 40 * (1 - since / q.cooldown);

      score += n.openness * 4;
      score += rng.range(-3.5, 3.5); // deterministic tie-break jitter

      if (score > bestScore) { bestScore = score; best = n; }
      if (!visible && !threatLos && score > bestHiddenScore) { bestHiddenScore = score; bestHidden = n; }
    }

    if (q.requireHidden && bestHidden) return bestHidden;
    return best ?? bestHidden;
  }

  /** True when `p` is inside the view cone *and* actually unoccluded. */
  isVisible(p: THREE.Vector3, q: SpawnQuery, physics: PhysicsAPI | null): boolean {
    this._v.copy(p).sub(q.viewOrigin);
    const dist = this._v.length();
    if (dist < 0.001) return true;
    this._v.multiplyScalar(1 / dist);
    if (this._v.dot(q.viewDir) < q.viewCos) return false;
    if (dist > 140) return false;
    // Aim at chest height so a node behind a knee-high wall still counts as hidden.
    this._w.copy(p); this._w.y += 1.1;
    return this.hasLineOfSight(q.viewOrigin, this._w, physics);
  }

  private hasLineOfSight(a: THREE.Vector3, b: THREE.Vector3, physics: PhysicsAPI | null): boolean {
    if (!physics?.ready) return true; // no world knowledge — assume the worst
    return physics.lineOfSight(a, b, MASK_SIGHT);
  }

  /** Nearest node to a point, used to place objectives on reachable ground. */
  nearest(p: THREE.Vector3): SpawnNode | null {
    let best: SpawnNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = n.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** Node furthest from every supplied position — good for extraction points. */
  furthestFrom(points: readonly THREE.Vector3[]): SpawnNode | null {
    let best: SpawnNode | null = null;
    let bestD = -Infinity;
    for (const n of this.nodes) {
      let d = Infinity;
      for (const p of points) d = Math.min(d, n.position.distanceToSquared(p));
      if (d === Infinity) d = 0;
      if (d > bestD) { bestD = d; best = n; }
    }
    return best;
  }
}
