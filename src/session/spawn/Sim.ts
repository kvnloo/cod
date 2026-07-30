/**
 * Headless spawn benchmark.
 *
 * A 6v6 bot match on a synthetic three-lane map, run at 10 Hz with a combat
 * model whose only job is to be *causally honest about spawns*: whoever
 * acquires a target first starts doing damage first, so a body that appears
 * inside someone's line of sight at 15 m dies, and a body that appears behind
 * cover at 45 m does not. That is what makes "died within three seconds of
 * spawning" a real measurement rather than a coin flip.
 *
 * The same match is played by three selectors on the same map with the same
 * seed:
 *
 *   • `influence` — this module's `SpawnDirector`
 *   • `baseline`  — the previous implementation, verbatim, from `Baseline.ts`
 *   • `random`    — uniform choice, the control that says how much either of
 *                   the other two is actually doing
 *
 * `tools/session-spawn.mjs` runs the sweep and prints the comparison.
 */

import { Rand } from '../../core/Rand';
import { baselinePick, baselineQuery, type BaselineQuery } from './Baseline';
import { influenceSnapshot, type InfluenceSnapshot } from './DebugField';
import { clamp, distXZ, segmentHitsBox } from './Math';
import { SpawnMetrics, type SpawnQualityReport } from './SpawnMetrics';
import { SpawnDirector } from './SpawnDirector';
import {
  emptyDecision, makePoint,
  type SpawnActor, type SpawnDecision, type SpawnHazard, type SpawnLos,
  type SpawnObjective, type SpawnPoint, type SpawnTeam, type SpawnWorldState, type Vec3,
} from './types';

export type Selector = 'influence' | 'baseline' | 'random';
export type SimMode = 'tdm' | 'domination' | 'sd';

export interface SimOptions {
  seed: number;
  mode: SimMode;
  selector: Selector;
  /** Simulated seconds. */
  duration: number;
  /** Players per team. */
  teamSize: number;
  /** Simulation step, seconds. */
  dt: number;
  /** Seconds a dead bot waits before requesting a spawn (not used in S&D). */
  respawnDelay: number;
  /** Collect spawn/death positions for the ASCII heat maps. */
  collectHeat: boolean;
}

export function defaultSimOptions(): SimOptions {
  return {
    seed: 1337,
    mode: 'tdm',
    selector: 'influence',
    duration: 480,
    teamSize: 6,
    dt: 0.1,
    respawnDelay: 5,
    collectHeat: false,
  };
}

export interface SimResult {
  mode: SimMode;
  selector: Selector;
  seed: number;
  duration: number;
  report: SpawnQualityReport;
  kills: number;
  /** Grants closer than the hard minimum distance to a live enemy. */
  spawnsInsideMinDistance: number;
  /** Grants an enemy could see the instant they happened. */
  spawnsWithEnemyLos: number;
  /** 5th percentile of distance-to-nearest-enemy at spawn. */
  p05EnemyDistance: number;
  /** Total time spent choosing spawns, milliseconds. */
  selectMs: number;
  /** Mean per-request selection cost, milliseconds. */
  meanSelectMs: number;
  outcomes: Record<string, number>;
  /** Only present for the influence selector. */
  influence: InfluenceSnapshot | null;
  spawnPositions: Array<{ x: number; z: number }>;
  deathPositions: Array<{ x: number; z: number }>;
}

/* ------------------------------------------------------------------ world -- */

interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

const MAP_HALF = 62;
const BOX_HEIGHT = 8;

/**
 * A deterministic checkerboard of blocks with two long walls cut through it —
 * enough occlusion for line-of-sight to matter and enough open lanes for a bad
 * spawn to be punished.
 */
export class SimWorld implements SpawnLos {
  readonly boxes: Box[] = [];

  constructor() {
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        if (((i + j) & 1) !== 0) continue;
        const cx = i * 20, cz = j * 20;
        this.boxes.push({
          minX: cx - 6, minY: 0, minZ: cz - 6,
          maxX: cx + 6, maxY: BOX_HEIGHT, maxZ: cz + 6,
        });
      }
    }
    // Two long walls create asymmetric sightlines so the map is not a perfect
    // grid — perfect grids make every spawn equally good and hide bugs.
    this.boxes.push({ minX: -52, minY: 0, minZ: 9, maxX: -12, maxY: 4.5, maxZ: 11 });
    this.boxes.push({ minX: 12, minY: 0, minZ: -11, maxX: 52, maxY: 4.5, maxZ: -9 });
  }

  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    for (const b of this.boxes) {
      if (segmentHitsBox(ax, ay, az, bx, by, bz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ)) {
        return false;
      }
    }
    return true;
  }

  groundAt(_x: number, _z: number, fallback: number): number { return fallback; }

  /** True when a capsule of `margin` at (x,z) would intersect a block. */
  blocked(x: number, z: number, margin = 0.6): boolean {
    if (Math.abs(x) > MAP_HALF || Math.abs(z) > MAP_HALF) return true;
    for (const b of this.boxes) {
      if (x > b.minX - margin && x < b.maxX + margin && z > b.minZ - margin && z < b.maxZ + margin) {
        return true;
      }
    }
    return false;
  }

  /** Fraction of 8 horizontal probes that reach 25 m unobstructed. */
  openness(x: number, y: number, z: number): number {
    let open = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const tx = x + Math.sin(a) * 25, tz = z + Math.cos(a) * 25;
      if (this.lineOfSight(x, y + 1.6, z, tx, y + 1.6, tz)) open++;
    }
    return open / 8;
  }
}

/** Lattice of candidates over the map, skipping anything inside geometry. */
export function buildSimPoints(world: SimWorld, step = 7): SpawnPoint[] {
  const points: SpawnPoint[] = [];
  let id = 0;
  for (let x = -56; x <= 56; x += step) {
    for (let z = -56; z <= 56; z += step) {
      if (world.blocked(x, z, 1.4)) continue;
      const openness = world.openness(x, 0, z);
      const owner: SpawnTeam = x < -18 ? 'friendly' : x > 18 ? 'hostile' : 'neutral';
      const p = makePoint(id++, { x, y: 0, z }, Math.atan2(-x, -z), owner, openness, 1 - openness);
      points.push(p);
    }
  }
  return points;
}

/* ----------------------------------------------------------------- actors -- */

interface SimPlayer extends SpawnActor {
  position: Vec3;
  health: number;
  respawnAt: number;
  spawnedAt: number;
  targetId: number;
  aimTime: number;
  lastDamagedBy: number;
  lastDamageAt: number;
  goalX: number;
  goalZ: number;
}

interface Flag {
  id: string;
  x: number;
  z: number;
  radius: number;
  owner: SpawnTeam;
  progress: number;
}

const FLAG_SITES: ReadonlyArray<{ id: string; x: number; z: number }> = [
  { id: 'A', x: -30, z: 30 },
  { id: 'B', x: 0, z: -20 },
  { id: 'C', x: 30, z: -30 },
];

const BOMB_SITE = { id: 'BOMB', x: 30, z: 30, radius: 7 };

/* -------------------------------------------------------------------- sim -- */

export function runSpawnSim(partial: Partial<SimOptions> = {}): SimResult {
  const opts: SimOptions = { ...defaultSimOptions(), ...partial };
  const world = new SimWorld();
  const points = buildSimPoints(world);
  const rand = new Rand(opts.seed);
  const combatRand = new Rand(opts.seed ^ 0x5eed);

  const director = new SpawnDirector({
    rand,
    los: world,
    policy: opts.mode === 'sd' ? 'sd' : opts.mode === 'domination' ? 'domination' : 'tdm',
  });
  director.setPoints(points);
  director.reset(0);

  const metrics = new SpawnMetrics();
  metrics.window = 3;
  metrics.capacity = 100000;

  /* --- roster --- */
  const players: SimPlayer[] = [];
  for (let t = 0; t < 2; t++) {
    const team: SpawnTeam = t === 0 ? 'friendly' : 'hostile';
    for (let i = 0; i < opts.teamSize; i++) {
      players.push({
        id: t * 100 + i,
        team,
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        alive: false,
        firing: false,
        speed: 0,
        health: 100,
        respawnAt: 0,
        spawnedAt: -1e9,
        targetId: -1,
        aimTime: 0,
        lastDamagedBy: -1,
        lastDamageAt: -1e9,
        goalX: 0,
        goalZ: 0,
      });
    }
  }

  const flags: Flag[] = FLAG_SITES.map((f) => ({
    id: f.id, x: f.x, z: f.z, radius: 8, owner: 'neutral', progress: 0,
  }));

  const objectives: SpawnObjective[] = [];
  const hazards: SpawnHazard[] = [];
  const state: SpawnWorldState = {
    now: 0, actors: players, hazards, objectives, observers: [],
  };

  const spawnPositions: Array<{ x: number; z: number }> = [];
  const deathPositions: Array<{ x: number; z: number }> = [];
  const outcomes: Record<string, number> = { best: 0, relaxed: 0, forced: 0, none: 0, pending: 0 };
  const enemyDistances: number[] = [];
  let kills = 0;
  let insideMin = 0;
  let withLos = 0;
  let selectMs = 0;
  let selectCount = 0;

  const bq: BaselineQuery = baselineQuery();
  const scratchThreats: Vec3[] = [];
  const scratchAllies: Vec3[] = [];

  /* --- helpers --- */

  const liveEnemiesOf = (team: SpawnTeam, out: Vec3[]): Vec3[] => {
    out.length = 0;
    for (const p of players) if (p.alive && p.team !== team) out.push(p.position);
    return out;
  };
  const liveAlliesOf = (team: SpawnTeam, out: Vec3[]): Vec3[] => {
    out.length = 0;
    for (const p of players) if (p.alive && p.team === team) out.push(p.position);
    return out;
  };

  /** Observed truth about a granted point, computed identically for every selector. */
  const describe = (pos: Vec3, team: SpawnTeam): { dist: number; los: boolean } => {
    let dist = Infinity;
    let los = false;
    for (const e of players) {
      if (!e.alive || e.team === team) continue;
      const d = distXZ(pos, e.position);
      if (d < dist) dist = d;
      if (!los && d < 95
        && world.lineOfSight(e.position.x, e.position.y + 1.6, e.position.z, pos.x, pos.y + 1.1, pos.z)) {
        los = true;
      }
    }
    return { dist, los };
  };

  const pickBaseline = (p: SimPlayer, now: number): SpawnPoint | null => {
    // Faithful reproduction of the old TeamDeathmatch friendly-spawn query.
    liveEnemiesOf(p.team, scratchThreats);
    liveAlliesOf(p.team, scratchAllies);
    let ox = 0, oz = 0, n = 0;
    for (const a of scratchAllies) { ox += a.x; oz += a.z; n++; }
    bq.viewOrigin = { x: n > 0 ? ox / n : 0, y: 1.6, z: n > 0 ? oz / n : 0 };
    bq.viewDir = { x: 0, y: 0, z: -1 };
    bq.viewCos = 2;
    bq.idealDistance = 22;
    bq.minDistance = 8;
    bq.maxDistance = 70;
    bq.threats = scratchThreats;
    bq.allies = scratchAllies;
    bq.now = now;
    bq.requireHidden = false;
    bq.cooldown = 11;
    return baselinePick(points, bq, world, rand);
  };

  const pickRandom = (): SpawnPoint => points[Math.floor(rand.next() * points.length)];

  /** Places `p` at a chosen point and records the grant. */
  const place = (p: SimPlayer, now: number, decision: SpawnDecision): void => {
    p.position.x = decision.position.x;
    p.position.y = decision.position.y;
    p.position.z = decision.position.z;
    p.yaw = decision.yaw;
    p.alive = true;
    p.health = 100;
    p.spawnedAt = now;
    p.targetId = -1;
    p.aimTime = 0;
    p.firing = false;
    p.lastDamagedBy = -1;
    const truth = describe(p.position, p.team);
    decision.enemyDistance = truth.dist;
    decision.enemyLos = truth.los;
    enemyDistances.push(Number.isFinite(truth.dist) ? truth.dist : 200);
    if (Number.isFinite(truth.dist) && truth.dist < 18) insideMin++;
    if (truth.los) withLos++;
    outcomes[decision.outcome] = (outcomes[decision.outcome] ?? 0) + 1;
    const zone = director.pointById(decision.pointId)?.zone ?? -1;
    metrics.noteSpawn(p.id, zone, decision, now);
    if (opts.collectHeat) spawnPositions.push({ x: p.position.x, z: p.position.z });
  };

  const spawn = (p: SimPlayer, now: number): void => {
    state.now = now;
    const t0 = performanceNow();
    let decision: SpawnDecision;
    if (opts.selector === 'influence') {
      decision = director.request({ actorId: p.id, team: p.team, now, kind: 'bot' }, state);
    } else {
      const point = opts.selector === 'baseline' ? pickBaseline(p, now) : pickRandom();
      decision = emptyDecision();
      if (point) {
        decision.ok = true;
        decision.pointId = point.id;
        decision.position = { x: point.position.x, y: point.position.y, z: point.position.z };
        decision.yaw = point.yaw;
        decision.outcome = 'best';
        point.lastUsed = now;
      }
    }
    selectMs += performanceNow() - t0;
    selectCount++;
    if (!decision.ok) { p.respawnAt = now + 1; return; }
    place(p, now, decision);
  };

  const kill = (victim: SimPlayer, killerId: number, now: number): void => {
    victim.alive = false;
    victim.firing = false;
    victim.respawnAt = now + opts.respawnDelay;
    kills++;
    if (opts.collectHeat) deathPositions.push({ x: victim.position.x, z: victim.position.z });
    metrics.noteDeath(victim.id, now, killerId);
    if (opts.selector === 'influence') director.noteDeath(victim.id, victim.position, now, killerId);
  };

  /* --- movement --- */

  const goalFor = (p: SimPlayer): void => {
    if (opts.mode === 'domination') {
      let best: Flag | null = null;
      let bestD = Infinity;
      for (const f of flags) {
        const d = distXZ(p.position, { x: f.x, y: 0, z: f.z });
        const wanted = f.owner === p.team ? d * 2.2 : d;
        if (wanted < bestD) { bestD = wanted; best = f; }
      }
      if (best) { p.goalX = best.x; p.goalZ = best.z; return; }
    }
    if (opts.mode === 'sd') {
      // Attackers push the site, defenders orbit it.
      const push = p.team === 'friendly';
      p.goalX = BOMB_SITE.x + (push ? 0 : 12);
      p.goalZ = BOMB_SITE.z + (push ? 0 : -12);
      return;
    }
    // TDM: walk toward the enemy centre of mass — this is what builds a front
    // line, and what produces spawn traps when the selector is bad.
    let cx = 0, cz = 0, n = 0;
    for (const e of players) {
      if (!e.alive || e.team === p.team) continue;
      cx += e.position.x; cz += e.position.z; n++;
    }
    if (n === 0) { p.goalX = 0; p.goalZ = 0; return; }
    p.goalX = cx / n; p.goalZ = cz / n;
  };

  const move = (p: SimPlayer, dt: number): void => {
    const dx = p.goalX - p.position.x, dz = p.goalZ - p.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.5) { p.speed = 0; return; }
    const speed = 4.6;
    const baseYaw = Math.atan2(dx / len, dz / len);
    // Try straight on, then progressively wider detours around geometry.
    for (const off of [0, 0.5, -0.5, 1.1, -1.1, 1.9, -1.9, 2.6]) {
      const yaw = baseYaw + off;
      const nx = p.position.x + Math.sin(yaw) * speed * dt;
      const nz = p.position.z + Math.cos(yaw) * speed * dt;
      if (world.blocked(nx, nz, 0.8)) continue;
      p.position.x = nx;
      p.position.z = nz;
      p.speed = speed;
      return;
    }
    p.speed = 0;
  };

  /* --- combat --- */

  const dpsAt = (d: number): number => {
    if (d < 12) return 62;
    if (d > 70) return 0;
    return clamp(62 - (d - 12) * 0.72, 12, 62);
  };

  const combat = (now: number, dt: number): void => {
    for (const p of players) {
      if (!p.alive) continue;
      /* acquire */
      let best: SimPlayer | null = null;
      let bestD = Infinity;
      for (const e of players) {
        if (!e.alive || e.team === p.team) continue;
        const d = distXZ(p.position, e.position);
        if (d > 70 || d >= bestD) continue;
        if (!world.lineOfSight(
          p.position.x, p.position.y + 1.6, p.position.z,
          e.position.x, e.position.y + 1.2, e.position.z,
        )) continue;
        best = e; bestD = d;
      }
      if (!best) {
        p.targetId = -1;
        p.aimTime = 0;
        p.firing = false;
        continue;
      }
      if (p.targetId !== best.id) { p.targetId = best.id; p.aimTime = 0; }
      p.aimTime += dt;
      p.yaw = Math.atan2(best.position.x - p.position.x, best.position.z - p.position.z);
      // Reaction time: whoever saw the other first shoots first. A body that
      // materialises in an enemy's sightline loses this race by construction.
      if (p.aimTime < 0.28) { p.firing = false; continue; }
      p.firing = true;
      const accuracy = 0.55 + 0.35 * combatRand.next();
      const dmg = dpsAt(bestD) * dt * accuracy;
      best.health -= dmg;
      best.lastDamagedBy = p.id;
      best.lastDamageAt = now;
      if (best.health <= 0) kill(best, p.id, now);
    }
  };

  const regen = (now: number, dt: number): void => {
    for (const p of players) {
      if (!p.alive || p.health >= 100) continue;
      if (now - p.lastDamageAt < 4) continue;
      p.health = Math.min(100, p.health + 32 * dt);
    }
  };

  /* --- objectives --- */

  const updateFlags = (dt: number): void => {
    objectives.length = 0;
    for (const f of flags) {
      let friendly = 0, hostile = 0;
      for (const p of players) {
        if (!p.alive) continue;
        if (distXZ(p.position, { x: f.x, y: 0, z: f.z }) > f.radius) continue;
        if (p.team === 'friendly') friendly++; else hostile++;
      }
      const contested = friendly > 0 && hostile > 0;
      if (!contested && friendly > 0) f.progress = clamp(f.progress + dt * 0.5 * friendly, -1, 1);
      else if (!contested && hostile > 0) f.progress = clamp(f.progress - dt * 0.5 * hostile, -1, 1);
      if (f.progress >= 1) f.owner = 'friendly';
      else if (f.progress <= -1) f.owner = 'hostile';
      objectives.push({
        id: f.id, position: { x: f.x, y: 0, z: f.z }, radius: f.radius,
        owner: f.owner, contested, weight: 1,
      });
    }
  };

  const bombObjective = (): void => {
    objectives.length = 0;
    objectives.push({
      id: BOMB_SITE.id,
      position: { x: BOMB_SITE.x, y: 0, z: BOMB_SITE.z },
      radius: BOMB_SITE.radius,
      owner: 'neutral',
      contested: false,
      weight: 1,
    });
  };

  /* --- round handling (S&D) --- */

  let roundEndsAt = 0;
  const startRound = (now: number): void => {
    for (const p of players) {
      p.alive = false;
      metrics.noteRetire(p.id);
    }
    director.reset(now);
    state.now = now;
    if (opts.selector === 'influence') {
      const reqs = players.map((p) => ({ actorId: p.id, team: p.team, now, kind: 'bot' as const }));
      const t0 = performanceNow();
      const decisions = director.requestGroup(reqs, state);
      selectMs += performanceNow() - t0;
      selectCount += reqs.length;
      for (let i = 0; i < players.length; i++) {
        if (decisions[i].ok) place(players[i], now, decisions[i]);
      }
    } else {
      for (const p of players) spawn(p, now);
    }
    roundEndsAt = now + 100;
  };

  /* --- main loop --- */

  const dt = opts.dt;
  const steps = Math.ceil(opts.duration / dt);
  if (opts.mode === 'sd') startRound(0);

  for (let step = 0; step < steps; step++) {
    const now = step * dt;
    state.now = now;

    if (opts.mode === 'sd') {
      const friendlyAlive = players.some((p) => p.team === 'friendly' && p.alive);
      const hostileAlive = players.some((p) => p.team === 'hostile' && p.alive);
      if (!friendlyAlive || !hostileAlive || now >= roundEndsAt) {
        startRound(now);
        continue;
      }
      bombObjective();
    } else {
      for (const p of players) {
        if (p.alive || now < p.respawnAt) continue;
        spawn(p, now);
      }
      if (opts.mode === 'domination') updateFlags(dt);
    }

    for (const p of players) {
      if (!p.alive) continue;
      goalFor(p);
      move(p, dt);
    }
    combat(now, dt);
    regen(now, dt);
    director.update(state, dt);
  }

  const sortedDist = enemyDistances.slice().sort((a, b) => a - b);
  const p05 = sortedDist.length > 0 ? sortedDist[Math.floor(sortedDist.length * 0.05)] : 0;

  return {
    mode: opts.mode,
    selector: opts.selector,
    seed: opts.seed,
    duration: opts.duration,
    report: metrics.report(opts.duration, 6),
    kills,
    spawnsInsideMinDistance: insideMin,
    spawnsWithEnemyLos: withLos,
    p05EnemyDistance: p05,
    selectMs,
    meanSelectMs: selectCount > 0 ? selectMs / selectCount : 0,
    outcomes,
    influence: opts.selector === 'influence' ? influenceSnapshot(director.field) : null,
    spawnPositions,
    deathPositions,
  };
}

/** `performance.now()` where it exists, `Date.now()` where it does not. */
function performanceNow(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
