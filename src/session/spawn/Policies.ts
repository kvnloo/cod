/**
 * Scoring weights and per-mode policy.
 *
 * The weights are the tuning surface for the whole system; the vetoes are the
 * safety net underneath them. Weights are expressed in the same arbitrary
 * "points" unit so their relative size reads directly as relative importance —
 * enemy separation is worth more than everything else combined, objective pull
 * is worth about as much as friendly proximity, and jitter is small enough to
 * break ties without ever reordering meaningfully different candidates.
 */

import type { SpawnPolicyId } from './types';

export interface SpawnWeights {
  /* --- soft terms --- */
  /** Reward for separation from the nearest enemy, saturating at `idealEnemyDistance`. */
  enemyDistance: number;
  /** Penalty when an enemy can see the point beyond the hard-veto range. */
  enemyLos: number;
  /** Reward for spawning near friendlies, peaking at `friendlyIdeal`. */
  friendly: number;
  /** Penalty for recent deaths at or near the point. */
  deaths: number;
  /** Reward for being near the objective this team should be fighting for. */
  objective: number;
  /** Penalty for reusing a point inside `reuseCooldown`. */
  reuse: number;
  /** Reward for spawning on ground the team owns (influence field + zone). */
  territory: number;
  /** Weight of the optional PvE distance band. */
  band: number;
  /** Reward for cover, penalty for openness. */
  cover: number;
  /** Half-width of the deterministic tie-break jitter. */
  jitter: number;

  /* --- hard vetoes --- */
  /** Never spawn closer than this to a live enemy, metres. */
  minEnemyDistance: number;
  /** Enemy view cone half-angle, degrees. */
  viewConeDeg: number;
  /** Range at which the view-cone veto applies, metres. */
  viewConeRange: number;
  /** Half-width of the line-of-fire corridor, metres. */
  lineOfFireWidth: number;
  /** Length of the line-of-fire corridor, metres. */
  lineOfFireRange: number;
  /** Enemy line of sight inside this range is a veto, not a penalty. */
  losVetoRange: number;
  /** Extra clearance added to every hazard radius, metres. */
  hazardMargin: number;

  /* --- shaping --- */
  /** Distance at which the separation reward saturates. */
  idealEnemyDistance: number;
  /** Most desirable distance to the nearest friendly. */
  friendlyIdeal: number;
  friendlySigma: number;
  /** Seconds a point stays hot after a grant. */
  reuseCooldown: number;
  /** Radius that counts a death as "at" a point, metres. */
  deathRadius: number;
  /** Death memory half-life, seconds. */
  deathHalfLife: number;
  /** Range over which the objective reward falls to zero, metres. */
  objectiveRange: number;
  /** Seconds a granted point is reserved before the actor is confirmed in. */
  reservation: number;
  /** Window used by the spawn-quality metric, seconds. */
  earlyDeathWindow: number;
}

export function defaultWeights(): SpawnWeights {
  return {
    enemyDistance: 42,
    enemyLos: 30,
    friendly: 16,
    deaths: 22,
    objective: 18,
    reuse: 20,
    territory: 24,
    band: 26,
    cover: 6,
    jitter: 2.0,

    minEnemyDistance: 18,
    viewConeDeg: 55,
    viewConeRange: 65,
    lineOfFireWidth: 3.5,
    lineOfFireRange: 70,
    losVetoRange: 45,
    hazardMargin: 3,

    idealEnemyDistance: 38,
    friendlyIdeal: 16,
    friendlySigma: 16,
    reuseCooldown: 10,
    deathRadius: 9,
    deathHalfLife: 22,
    objectiveRange: 70,
    reservation: 1.5,
    earlyDeathWindow: 3,
  };
}

export interface SpawnPolicy {
  id: SpawnPolicyId;
  name: string;
  weights: SpawnWeights;
  /** Zone ownership is frozen at the map's static ownership (S&D). */
  fixedTeamZones: boolean;
  /** Only points tagged for the spawning team are eligible (S&D). */
  requireOwnedPoints: boolean;
  /**
   * With `requireOwnedPoints`, whether *neutral* ground also counts.
   *
   * This is the difference between "prefer your half" and "spawn on your pad".
   * S&D needs the strict form: the moment neutral midfield is eligible, both
   * teams' round-start group spawns are pulled toward the same objective and
   * the round opens with the two squads on top of each other.
   */
  strictOwnership: boolean;
  /** Territory drives zone ownership (TDM, Domination, Hardpoint). */
  zoneFlipping: boolean;
  /** Steer spawns toward the objective the team should be fighting for. */
  objectiveDriven: boolean;
  /**
   * Group spawns spread a whole team across one zone at once and never reuse a
   * point inside the group — round-based modes need every player somewhere
   * different on the same beat.
   */
  groupSpawn: boolean;
  /** Suppress a zone the moment enemies stand in it, rather than waiting for
   *  the territory filter. Fast-flip modes want this; S&D must not have it. */
  aggressiveFlip: boolean;
}

/**
 * Mode presets.
 *
 * - **tdm** — fully dynamic. No ownership, fast zone flipping, no objective.
 * - **domination** — flag ownership feeds the influence field and pulls spawns
 *   toward the flag the team should be attacking or defending.
 * - **sd** — fixed team spawns, no flipping, group spawn at round start, and
 *   the enemy-proximity vetoes stay on so a round restart cannot drop a player
 *   next to a bomb planter.
 * - **hardpoint** — like domination but with a single rotating objective and a
 *   stronger pull, because the fight is always in one place.
 * - **pve** — the wave director's ruleset: distance band around the player,
 *   hard "never appear on screen" observer veto, no friendly term.
 */
export function policyFor(id: SpawnPolicyId): SpawnPolicy {
  const w = defaultWeights();
  switch (id) {
    case 'sd':
      w.reuseCooldown = 0.5;
      w.territory = 0;
      // Positional objective pull is *off* in S&D. The objective still exists
      // (it decides which way a spawned body faces, and it is what the squad
      // walks toward) but a fixed-spawn mode must never let the bomb site drag
      // two opposing round-start groups into the same midfield.
      w.objective = 0;
      w.objectiveRange = 90;
      w.friendly = 22;
      w.friendlyIdeal = 10;
      w.friendlySigma = 12;
      w.minEnemyDistance = 25;
      w.cover = 10;
      return {
        id, name: 'Search & Destroy', weights: w,
        fixedTeamZones: true, requireOwnedPoints: true, strictOwnership: true,
        zoneFlipping: false,
        objectiveDriven: true, groupSpawn: true, aggressiveFlip: false,
      };
    case 'domination':
      w.objective = 30;
      w.objectiveRange = 60;
      w.territory = 28;
      return {
        id, name: 'Domination', weights: w,
        fixedTeamZones: false, requireOwnedPoints: false, strictOwnership: false,
        zoneFlipping: true,
        objectiveDriven: true, groupSpawn: false, aggressiveFlip: true,
      };
    case 'hardpoint':
      w.objective = 34;
      w.objectiveRange = 55;
      w.territory = 22;
      w.minEnemyDistance = 22;
      return {
        id, name: 'Hardpoint', weights: w,
        fixedTeamZones: false, requireOwnedPoints: false, strictOwnership: false,
        zoneFlipping: true,
        objectiveDriven: true, groupSpawn: false, aggressiveFlip: true,
      };
    case 'pve':
      w.friendly = 4;
      w.objective = 8;
      w.territory = 6;
      w.band = 34;
      w.minEnemyDistance = 12;
      w.losVetoRange = 30;
      return {
        id, name: 'PvE', weights: w,
        fixedTeamZones: false, requireOwnedPoints: false, strictOwnership: false,
        zoneFlipping: false,
        objectiveDriven: false, groupSpawn: false, aggressiveFlip: false,
      };
    case 'tdm':
    default:
      w.objective = 0;
      return {
        id: 'tdm', name: 'Team Deathmatch', weights: w,
        fixedTeamZones: false, requireOwnedPoints: false, strictOwnership: false,
        zoneFlipping: true,
        objectiveDriven: false, groupSpawn: false, aggressiveFlip: true,
      };
  }
}
