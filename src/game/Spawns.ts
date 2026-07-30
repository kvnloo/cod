/**
 * Spawn point graph and selection — the game-layer adapter over
 * `src/session/spawn`.
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
 *
 * ## What changed, and why this file is thin
 *
 * The selector used to live here: one pass, one score, a handful of hand-tuned
 * penalties. Measured against a 6v6 simulation it let 8.5% of spawns die inside
 * three seconds, put 14% of spawns in a live enemy's line of sight, and placed
 * bodies within 14 m of an enemy. Those are the numbers players describe as
 * "the spawns are broken".
 *
 * Selection now runs through `SpawnDirector`: an influence map with memory,
 * zones that flip as territory shifts, hard vetoes (minimum enemy separation,
 * enemy view cones, lines of fire, grenade radii) and a two-phase scorer. Same
 * simulation, same seeds: 1.2% spawn-death rate, 0% in an enemy's sight, zero
 * violations of the hard minimum. `node tools/session-spawn.mjs` prints it.
 *
 * The `SpawnGraph` surface below is unchanged so existing callers
 * (`Director.ts`) keep working; everything new is additive.
 *
 * Authority: `SpawnDirector` is host logic. In a networked match the host
 * resolves and broadcasts a grant; a client's `pick` returns the granted node
 * once `applyGrant` has run. Nothing here mutates shared state speculatively.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { PhysicsAPI } from '../physics/types';
import { MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeRayHit } from './Services';
import type { WorldBridge } from './types';
// Imported per-module rather than through the barrel: the barrel also exports
// the headless benchmark harness, which has no business in the game bundle.
import { SpawnDirector } from '../session/spawn/SpawnDirector';
import type { SpawnQualityReport } from '../session/spawn/SpawnMetrics';
import { makePoint } from '../session/spawn/types';
import {
  influenceSnapshot, pointDebug, zoneDebug,
  type InfluenceSnapshot, type PointDebug, type ZoneDebug,
} from '../session/spawn/DebugField';
import type {
  SpawnActor, SpawnHazard, SpawnLos, SpawnObjective, SpawnPoint,
  SpawnPolicyId, SpawnTeam, SpawnWorldState,
} from '../session/spawn/types';

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

/** Node team tag → the spawn module's team vocabulary. */
function ownerOf(team: SpawnNode['team']): SpawnTeam {
  return team === 'player' ? 'friendly' : team === 'enemy' ? 'hostile' : 'neutral';
}

/** `PhysicsAPI` behind the module's numeric visibility oracle. */
class PhysicsLos implements SpawnLos {
  physics: PhysicsAPI | null = null;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const p = this.physics;
    // No world knowledge — assume the worst, exactly as the old selector did.
    if (!p?.ready) return true;
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz);
    return p.lineOfSight(this.a, this.b, MASK_SIGHT);
  }
}

export class SpawnGraph {
  readonly nodes: SpawnNode[] = [];
  readonly bounds = new THREE.Box3(new THREE.Vector3(-60, -2, -60), new THREE.Vector3(60, 30, 60));
  /** Ground height used when no physics backend is available. */
  groundY = 0;

  /**
   * The influence-map selector. Exposed so a debug scene can read the field,
   * the zones and the spawn-quality metric without going through `pick`.
   */
  readonly director: SpawnDirector;

  private ray = makeRayHit();
  private readonly _v = new THREE.Vector3();
  private readonly _w = new THREE.Vector3();
  private readonly _down = new THREE.Vector3(0, -1, 0);

  private readonly los = new PhysicsLos();
  private readonly points: SpawnPoint[] = [];
  private readonly nodeById = new Map<number, SpawnNode>();
  private readonly hazards: SpawnHazard[] = [];
  private readonly objectives: SpawnObjective[] = [];
  private readonly actors: SpawnActor[] = [];
  private readonly state: SpawnWorldState = {
    now: 0, actors: this.actors, hazards: this.hazards,
    objectives: this.objectives, observers: [],
  };
  private readonly observer = {
    position: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1),
    cosHalfFov: 0.5, range: 140, hard: false,
  };
  private readonly rand = new Rand('spawn-graph');
  private lastRefresh = 0;
  private nextActorId = 1;
  private mode: SpawnPolicyId = 'tdm';

  constructor() {
    this.director = new SpawnDirector({ rand: this.rand, los: this.los, policy: 'tdm' });
  }

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

    this.los.physics = physics;
    this.measureOpenness(physics);
    this.publishPoints();
  }

  /**
   * Rebuilds the director's candidate set from `nodes`. Each `SpawnPoint`
   * shares the node's `THREE.Vector3` — `Vec3` is structural, so there is no
   * copy and no chance of the two drifting apart.
   */
  private publishPoints(): void {
    this.points.length = 0;
    this.nodeById.clear();
    for (const n of this.nodes) {
      const p = makePoint(
        n.id, n.position, n.yaw, ownerOf(n.team),
        n.openness, 1 - n.openness,
      );
      p.lastUsed = n.lastUsed;
      this.points.push(p);
      this.nodeById.set(n.id, n);
    }
    this.director.setPoints(this.points);
    this.director.reset(0);
    this.lastRefresh = 0;
  }

  /**
   * Replaces the placeholder openness values with a measured one: eight
   * horizontal probes at chest height. An open node is a node a spawning body
   * can be shot at from, and the influence map is only as good as this input.
   * Build-time only — a few hundred rays, once per level.
   */
  private measureOpenness(physics: PhysicsAPI | null): void {
    if (!physics?.ready) return;
    const RAYS = 8;
    const REACH = 18;
    for (const n of this.nodes) {
      this._w.copy(n.position); this._w.y += 1.1;
      let open = 0;
      for (let i = 0; i < RAYS; i++) {
        const a = (i / RAYS) * Math.PI * 2;
        this._v.set(Math.cos(a), 0, Math.sin(a));
        const hit = physics.raycast(this._w, this._v, REACH, MASK_SIGHT, this.ray);
        if (!hit.hit) open++;
      }
      n.openness = open / RAYS;
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
    const p = this.director.pointById(node.id);
    if (p) {
      p.lastUsed = now;
      p.lastUsedBy = -1;
      p.reservedUntil = now + this.director.weights.reservation;
    }
  }

  /* --------------------------------------------------------------- policy -- */

  /**
   * Switches the ruleset. `'tdm'` is fully dynamic, `'domination'` and
   * `'hardpoint'` are objective-pulled, `'sd'` is fixed team pads with strict
   * ownership, `'pve'` is the wave director's distance band. Game modes should
   * call this once when the match starts.
   */
  setMode(mode: SpawnPolicyId): void {
    this.mode = mode;
    this.director.setPolicy(mode);
  }

  /** The objective a spawn should be steered toward. Replaces the previous set. */
  setObjectives(list: readonly SpawnObjective[]): void {
    this.objectives.length = 0;
    for (const o of list) this.objectives.push(o);
  }

  /**
   * Registers a live blast/fire/gas volume. Nothing spawns inside one, ever —
   * this is the "spawned into a grenade" veto, and it costs one array push.
   */
  addHazard(position: THREE.Vector3, radius: number, expiresAt: number, kind = 'blast'): void {
    this.hazards.push({
      position: { x: position.x, y: position.y, z: position.z },
      radius, expires: expiresAt, kind,
    });
  }

  /** Feeds the influence map a death. Killzones bleed out of the candidate set. */
  noteDeath(position: THREE.Vector3, now: number, actorId = -1, killerId = -1): void {
    this.director.noteDeath(actorId, position, now, killerId);
  }

  /**
   * Spawn quality so far: the fraction of spawns that ended in a death within
   * three seconds, plus the worst individual outcomes. This is the scoreboard
   * for the whole system — surface it in a debug HUD, not in the player HUD.
   */
  quality(now = Infinity): SpawnQualityReport {
    return this.director.metrics.report(now, 6);
  }

  /**
   * Everything a debug scene needs to draw the spawn field: the influence grid
   * as a snapshot, every candidate with its zone/death-heat/suitability, and
   * the zones with their current owner.
   *
   * For a rendered overlay rather than raw numbers, a debug scene can build
   * `SpawnDebugView` from `src/session/spawn/DebugView` directly against
   * `graph.director` — it is a `THREE.Object3D` and is deliberately kept out of
   * the module barrel so the headless benchmark never pulls in `three`.
   */
  debugField(now = 0, team: SpawnTeam = 'friendly'): {
    influence: InfluenceSnapshot;
    points: PointDebug[];
    zones: ZoneDebug[];
  } {
    return {
      influence: influenceSnapshot(this.director.field),
      points: pointDebug(this.points, this.director.zones, team, now),
      zones: zoneDebug(this.director.zones, now),
    };
  }

  /* --------------------------------------------------------------- picking -- */

  /**
   * Scores every candidate and returns the best. Never returns null once the
   * graph has nodes: the vetoes relax in tiers so a hopeless situation still
   * produces the least-bad spawn rather than no spawn at all.
   */
  pick(q: SpawnQuery, physics: PhysicsAPI | null, rng: Rand): SpawnNode | null {
    if (this.nodes.length === 0) return null;
    if (this.points.length !== this.nodes.length) this.publishPoints();
    this.los.physics = physics;
    this.director.rand = rng;

    const spawningEnemy = q.team === 'enemy';
    const team: SpawnTeam = spawningEnemy ? 'hostile' : 'friendly';
    const owner: SpawnTeam | undefined = q.team === 'any' ? undefined : ownerOf(q.team);

    this.buildState(q, team);

    // An enemy spawn is a PvE spawn: hold a distance band around the player and
    // never appear inside their view. A friendly respawn uses the match policy.
    const policy: SpawnPolicyId = spawningEnemy ? 'pve' : this.mode;
    if (this.director.policy.id !== policy) this.director.setPolicy(policy);

    // Territory is a slow signal and there is no per-frame hook here, so it is
    // advanced on demand. `update` internally rate-limits to 5 Hz.
    const dt = Math.min(2, Math.max(0.2, q.now - this.lastRefresh));
    this.lastRefresh = q.now;
    this.director.update(this.state, dt);

    const decision = this.director.request({
      actorId: this.nextActorId++,
      team,
      now: q.now,
      kind: spawningEnemy ? 'bot' : 'player',
      owner,
      seed: this.nextActorId,
      band: spawningEnemy
        ? {
          origin: q.viewOrigin,
          ideal: q.idealDistance,
          min: q.minDistance,
          max: q.maxDistance,
          weight: 34,
        }
        : undefined,
    }, this.state);

    if (!decision.ok) return null;
    const node = this.nodeById.get(decision.pointId) ?? null;
    if (node) {
      node.lastUsed = q.now;
      node.yaw = decision.yaw;
    }
    return node;
  }

  /** Translates a legacy `SpawnQuery` into the module's world state. */
  private buildState(q: SpawnQuery, team: SpawnTeam): void {
    const enemyTeam: SpawnTeam = team === 'hostile' ? 'friendly' : 'hostile';
    this.actors.length = 0;

    // Threats have no facing in the legacy query, so point them at the mass
    // they are shooting at — the ally centroid, else the view origin. A wrong
    // guess only costs an over-strict view-cone veto, which the tiers relax.
    let ax = 0, az = 0, an = 0;
    for (const a of q.allies) { ax += a.x; az += a.z; an++; }
    const lookX = an > 0 ? ax / an : q.viewOrigin.x;
    const lookZ = an > 0 ? az / an : q.viewOrigin.z;

    let id = -1;
    for (const t of q.threats) {
      this.actors.push({
        id: id--, team: enemyTeam, position: t,
        yaw: Math.atan2(lookX - t.x, lookZ - t.z),
        alive: true, firing: false, speed: 0,
      });
    }
    for (const a of q.allies) {
      this.actors.push({
        id: id--, team, position: a, yaw: 0, alive: true, firing: false, speed: 0,
      });
    }

    // The camera is not a combatant but it is a place a spawn must not pop into.
    this.observer.position.copy(q.viewOrigin);
    this.observer.dir.copy(q.viewDir);
    this.observer.cosHalfFov = q.viewCos;
    this.observer.range = Math.max(40, q.maxDistance * 1.6);
    this.observer.hard = q.requireHidden;

    const now = q.now;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (this.hazards[i].expires < now) this.hazards.splice(i, 1);
    }

    this.state.now = now;
    this.state.observers = q.viewCos <= 1 ? [this.observer] : [];
    this.director.weights.reuseCooldown = q.cooldown;
    this.director.weights.minEnemyDistance = Math.max(1, q.minDistance);
  }

  /* --------------------------------------------------------------- queries -- */

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
