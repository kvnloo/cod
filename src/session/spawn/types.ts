/**
 * Spawn system contracts.
 *
 * The whole module is deliberately free of `three` and of any engine import so
 * it can run headlessly in the benchmark, inside a worker, or on a dedicated
 * host that has no renderer. Positions are plain `{x,y,z}` — a `THREE.Vector3`
 * satisfies `Vec3` structurally, so the game-layer adapter in
 * `src/game/Spawns.ts` passes its vectors straight through with no copying.
 *
 * Authority: every decision in here is *host* logic. A client never picks its
 * own spawn; it asks (`SpawnAuthority.sendSpawnRequest`) and displays what it is
 * granted. See `Authority.ts`.
 */

/** Anything with x/y/z. `THREE.Vector3` is assignable to this. */
export interface Vec3 { x: number; y: number; z: number }

/** Matches `Team` in `src/game/types.ts`, plus a neutral bucket for map data. */
export type SpawnTeam = 'friendly' | 'hostile' | 'neutral';

/** Which spawn ruleset is in force. Modes map onto these, not the reverse. */
export type SpawnPolicyId = 'tdm' | 'domination' | 'sd' | 'hardpoint' | 'pve';

/* -------------------------------------------------------------- map data -- */

/**
 * One candidate spawn location. The runtime fields (`lastUsed`, `deaths`, …)
 * live on the point itself so the influence map has memory between requests —
 * that memory is what stops the selector handing out the same doorway to a
 * whole wave, and what lets a killzone bleed out of the candidate set.
 */
export interface SpawnPoint {
  id: number;
  /** Feet position on standable ground. */
  position: Vec3;
  /** Facing to spawn with, radians (atan2(x, z) convention, as the world uses). */
  yaw: number;
  /** Static team ownership. S&D honours it hard; TDM ignores it. */
  owner: SpawnTeam;
  /** Zone this point belongs to. Assigned by `SpawnZones`. */
  zone: number;
  /** 0..1 how exposed the point is. High = long sightlines onto it. */
  openness: number;
  /** 0..1 how much cover is within a couple of metres. */
  cover: number;
  /** Match time of the last grant, seconds. -1e9 when never used. */
  lastUsed: number;
  /** Actor the last grant went to. */
  lastUsedBy: number;
  /** Time-decayed count of deaths that happened on/near this point. */
  deaths: number;
  /** Match time of the most recent nearby death. */
  lastDeath: number;
  /** Host-side reservation so two simultaneous grants cannot collide. */
  reservedUntil: number;
  /** Cleared by the mode when a point is destroyed/blocked. */
  enabled: boolean;
}

/* ------------------------------------------------------------ world state -- */

/** A live combatant as far as the spawn selector is concerned. */
export interface SpawnActor {
  id: number;
  team: SpawnTeam;
  /** Feet position. */
  position: Vec3;
  /** Facing, radians, same convention as `SpawnPoint.yaw`. */
  yaw: number;
  alive: boolean;
  /** True while shooting — widens the line-of-fire veto corridor. */
  firing?: boolean;
  /** Horizontal speed, m/s. Fast movers get a bigger danger radius. */
  speed?: number;
}

/** A grenade, fire, gas cloud or inbound strike. Hard veto inside the radius. */
export interface SpawnHazard {
  position: Vec3;
  radius: number;
  /** Match time the hazard stops mattering. */
  expires: number;
  kind: string;
}

/** A flag, bomb site or hardpoint the spawner may be steered toward. */
export interface SpawnObjective {
  id: string;
  position: Vec3;
  radius: number;
  /** Who currently holds it. */
  owner: SpawnTeam;
  /** True while both teams are inside it. */
  contested?: boolean;
  /** Relative pull, 1 = normal. */
  weight?: number;
}

/**
 * A point of view a spawn must not appear inside — the local player's camera in
 * PvE, or a killcam. Distinct from enemy actors because it is not a combatant.
 */
export interface SpawnObserver {
  position: Vec3;
  /** Normalised look direction. */
  dir: Vec3;
  /** cos(halfFov). */
  cosHalfFov: number;
  range: number;
  /** True = hard veto, false = heavy penalty. */
  hard: boolean;
}

/** Everything a spawn request is scored against. Rebuilt (cheaply) per tick. */
export interface SpawnWorldState {
  /** Match time, seconds. */
  now: number;
  actors: readonly SpawnActor[];
  hazards: readonly SpawnHazard[];
  objectives: readonly SpawnObjective[];
  observers: readonly SpawnObserver[];
}

export function emptyWorldState(): SpawnWorldState {
  return { now: 0, actors: [], hazards: [], objectives: [], observers: [] };
}

/* --------------------------------------------------------------- requests -- */

/** Optional distance band relative to a reference point (PvE pressure control). */
export interface SpawnBand {
  origin: Vec3;
  ideal: number;
  min: number;
  max: number;
  /** Score weight for the band term. */
  weight: number;
}

export interface SpawnRequestSpec {
  actorId: number;
  team: SpawnTeam;
  /** Match time of the request. */
  now: number;
  /** 'player' spawns get stricter vetoes than bots — a bad player spawn costs more. */
  kind?: 'player' | 'bot';
  /** Restrict to one zone (S&D round start, squad spawn). */
  zone?: number;
  /** Restrict to points with this owner tag. */
  owner?: SpawnTeam;
  /** PvE distance band around a reference position. */
  band?: SpawnBand;
  /** Extra per-request filter, e.g. the legacy `team` node filter. */
  filter?: (p: SpawnPoint) => boolean;
  /** Deterministic per-request seed for tie-break jitter. */
  seed?: number;
}

/* ---------------------------------------------------------------- results -- */

export type SpawnVeto =
  | 'none'
  | 'disabled'
  | 'team'
  | 'zone'
  | 'zone-locked'
  | 'reserved'
  | 'hazard'
  | 'enemy-near'
  | 'view-cone'
  | 'line-of-fire'
  | 'enemy-los'
  | 'observed'
  | 'filter';

export const VETO_KINDS: readonly SpawnVeto[] = [
  'disabled', 'team', 'zone', 'zone-locked', 'reserved', 'hazard',
  'enemy-near', 'view-cone', 'line-of-fire', 'enemy-los', 'observed', 'filter',
];

/** Per-term breakdown of a score, kept for the debug view and telemetry. */
export interface SpawnScoreTerms {
  enemyDistance: number;
  enemyLos: number;
  friendly: number;
  deaths: number;
  objective: number;
  reuse: number;
  territory: number;
  band: number;
  cover: number;
  jitter: number;
}

export function emptyTerms(): SpawnScoreTerms {
  return {
    enemyDistance: 0, enemyLos: 0, friendly: 0, deaths: 0, objective: 0,
    reuse: 0, territory: 0, band: 0, cover: 0, jitter: 0,
  };
}

export type SpawnOutcome = 'best' | 'relaxed' | 'forced' | 'none' | 'pending';

export interface SpawnDecision {
  ok: boolean;
  /** -1 when nothing could be granted. */
  pointId: number;
  position: Vec3;
  yaw: number;
  score: number;
  /** 0..1 predicted safety, from the winning score. Useful for telemetry/HUD. */
  safety: number;
  outcome: SpawnOutcome;
  /** Distance to the nearest live enemy at the moment of the grant. */
  enemyDistance: number;
  /** True when an enemy had line of sight to the granted point. */
  enemyLos: boolean;
  considered: number;
  vetoed: number;
  /** Which veto killed the most candidates this request. */
  topVeto: SpawnVeto;
  terms: SpawnScoreTerms;
  /** Host sequence number; replicated to clients so grants are idempotent. */
  seq: number;
}

export function emptyDecision(): SpawnDecision {
  return {
    ok: false, pointId: -1, position: { x: 0, y: 0, z: 0 }, yaw: 0, score: 0,
    safety: 0, outcome: 'none', enemyDistance: Infinity, enemyLos: false,
    considered: 0, vetoed: 0, topVeto: 'none', terms: emptyTerms(), seq: 0,
  };
}

/* -------------------------------------------------------------- providers -- */

/**
 * Visibility oracle. Numeric so the hot loop never allocates a vector.
 * Backed by `PhysicsAPI.lineOfSight` in game, by an AABB sweep in the sim.
 */
export interface SpawnLos {
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** Optional ground probe; returns `fallback` when unknown. */
  groundAt?(x: number, z: number, fallback: number): number;
}

/** Structurally satisfied by `src/core/Rand.ts`'s `Rand`. */
export interface RandomSource {
  next(): number;
  range(min: number, max: number): number;
  u32(): number;
}

/** Axis-aligned play-space bounds. */
export interface SpawnBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function boundsOf(points: readonly SpawnPoint[], pad = 8): SpawnBounds {
  const b: SpawnBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
  for (const p of points) {
    if (p.position.x < b.minX) b.minX = p.position.x;
    if (p.position.y < b.minY) b.minY = p.position.y;
    if (p.position.z < b.minZ) b.minZ = p.position.z;
    if (p.position.x > b.maxX) b.maxX = p.position.x;
    if (p.position.y > b.maxY) b.maxY = p.position.y;
    if (p.position.z > b.maxZ) b.maxZ = p.position.z;
  }
  if (!Number.isFinite(b.minX)) {
    return { minX: -32, minY: -2, minZ: -32, maxX: 32, maxY: 16, maxZ: 32 };
  }
  b.minX -= pad; b.minZ -= pad; b.maxX += pad; b.maxZ += pad;
  b.minY -= 2; b.maxY += 8;
  return b;
}

/** Convenience constructor for a candidate with sane runtime defaults. */
export function makePoint(
  id: number, position: Vec3, yaw = 0, owner: SpawnTeam = 'neutral',
  openness = 0.5, cover = 0.5,
): SpawnPoint {
  return {
    id, position, yaw, owner, zone: -1, openness, cover,
    lastUsed: -1e9, lastUsedBy: -1, deaths: 0, lastDeath: -1e9,
    reservedUntil: -1e9, enabled: true,
  };
}
