/**
 * Candidate scoring and the hard vetoes.
 *
 * Scoring is two-phase by design. The cheap phase runs over every candidate
 * with no visibility queries at all; the expensive phase runs line-of-sight
 * only on the handful of candidates that survived. On a 200-point map with a
 * 6v6 roster that is ~150 ray queries per spawn instead of ~2,400, which is the
 * difference between "spawn selection is free" and "spawn selection hitches".
 *
 * The vetoes are absolute and come first:
 *
 *   • never inside `minEnemyDistance` of a live enemy
 *   • never inside a live enemy's view cone with line of sight
 *   • never inside the muzzle corridor of an enemy who is shooting
 *   • never inside a hazard (grenade, fire, inbound strike)
 *   • never on a point another grant has reserved
 *
 * They are relaxed in tiers only when *every* candidate fails, and the tier
 * that produced the answer is reported so the metrics can tell "good spawn"
 * from "least-bad spawn".
 */

import {
  angleDelta, bell, clamp, distXZ, rayDistanceXZ, saturate, yawTo,
} from './Math';
import type { InfluenceField } from './InfluenceField';
import type { SpawnPolicy } from './Policies';
import type { SpawnZones } from './SpawnZones';
import {
  emptyTerms,
  type RandomSource, type SpawnActor, type SpawnLos, type SpawnObjective,
  type SpawnPoint, type SpawnRequestSpec, type SpawnScoreTerms, type SpawnTeam,
  type SpawnVeto, type SpawnWorldState,
} from './types';

/** Eye height used for visibility tests. */
export const EYE_HEIGHT = 1.6;
/** Chest height of a freshly spawned body — a knee-high wall should hide it. */
export const CHEST_HEIGHT = 1.1;
/** Beyond this an enemy's line of sight stops mattering at all. */
const LOS_SOFT_RANGE = 95;

export interface ScoreContext {
  state: SpawnWorldState;
  policy: SpawnPolicy;
  field: InfluenceField;
  zones: SpawnZones;
  los: SpawnLos | null;
  req: SpawnRequestSpec;
  rand: RandomSource;
}

/**
 * Relaxation tiers.
 * 0 — every veto. 1 — drop visibility vetoes, keep proximity/hazard.
 * 2 — keep only a hard floor on enemy distance and hazards.
 * 3 — nothing is vetoed; the selector is choosing the least-bad option.
 */
export type RelaxTier = 0 | 1 | 2 | 3;

export class SpawnScorer {
  /** Filled by `score()`. */
  readonly terms: SpawnScoreTerms = emptyTerms();
  veto: SpawnVeto = 'none';
  nearestEnemy = Infinity;
  enemyLos = false;
  total = 0;
  safety = 0;

  private ctx: ScoreContext | null = null;
  private readonly enemies: SpawnActor[] = [];
  private readonly allies: SpawnActor[] = [];
  private target: SpawnObjective | null = null;
  private team: SpawnTeam = 'friendly';
  private teamSign = 1;
  private halfFovCos = 0;
  private readonly rayScratch = new Float64Array(1);

  /** Caches the per-request view of the world. Call once per request. */
  begin(ctx: ScoreContext): void {
    this.ctx = ctx;
    this.team = ctx.req.team;
    this.teamSign = this.team === 'hostile' ? -1 : 1;
    this.enemies.length = 0;
    this.allies.length = 0;
    for (const a of ctx.state.actors) {
      if (!a.alive) continue;
      if (a.id === ctx.req.actorId) continue;
      if (a.team === 'neutral') continue;
      if (a.team === this.team) this.allies.push(a);
      else this.enemies.push(a);
    }
    this.halfFovCos = Math.cos((ctx.policy.weights.viewConeDeg * Math.PI) / 180);
    this.target = ctx.policy.objectiveDriven ? this.pickObjective(ctx) : null;
  }

  /** The objective this spawn should be steered toward. */
  get objective(): SpawnObjective | null { return this.target; }
  get enemyCount(): number { return this.enemies.length; }
  get allyCount(): number { return this.allies.length; }

  /**
   * Which objective a spawning player should be pointed at: whatever is
   * contested, else whatever the team does not hold, else the nearest held one
   * (defence). This is the bit that makes Domination spawns feel intentional
   * rather than random.
   */
  private pickObjective(ctx: ScoreContext): SpawnObjective | null {
    let best: SpawnObjective | null = null;
    let bestScore = -Infinity;
    for (const o of ctx.state.objectives) {
      let s = (o.weight ?? 1) * 10;
      if (o.contested) s += 40;
      else if (o.owner === 'neutral') s += 25;
      else if (o.owner !== this.team) s += 18;
      else s += 5;
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return best;
  }

  /**
   * Scores one candidate. Returns `-Infinity` and sets `veto` when the point is
   * rejected. `useLos` gates the expensive visibility work.
   */
  score(p: SpawnPoint, useLos: boolean, tier: RelaxTier): number {
    const ctx = this.ctx;
    this.veto = 'none';
    this.nearestEnemy = Infinity;
    this.enemyLos = false;
    this.total = -Infinity;
    this.safety = 0;
    const t = this.terms;
    t.enemyDistance = 0; t.enemyLos = 0; t.friendly = 0; t.deaths = 0;
    t.objective = 0; t.reuse = 0; t.territory = 0; t.band = 0; t.cover = 0; t.jitter = 0;
    if (!ctx) return -Infinity;

    const { state, policy, req } = ctx;
    const w = policy.weights;
    const now = state.now;

    /* ------------------------------------------------- structural filters -- */
    if (!p.enabled) { this.veto = 'disabled'; return -Infinity; }
    if (req.zone !== undefined && req.zone >= 0 && p.zone !== req.zone) {
      this.veto = 'zone'; return -Infinity;
    }
    if (req.owner && p.owner !== req.owner && p.owner !== 'neutral') {
      this.veto = 'team'; return -Infinity;
    }
    if (tier < 2 && policy.requireOwnedPoints && p.owner !== this.team && p.owner !== 'neutral') {
      this.veto = 'team'; return -Infinity;
    }
    if (req.filter && !req.filter(p)) { this.veto = 'filter'; return -Infinity; }
    if (p.reservedUntil > now) { this.veto = 'reserved'; return -Infinity; }

    /* ---------------------------------------------------------- hazards --- */
    for (const h of state.hazards) {
      if (h.expires < now) continue;
      const d = distXZ(p.position, h.position);
      if (d < h.radius + w.hazardMargin) { this.veto = 'hazard'; return -Infinity; }
    }

    /* ------------------------------------------------------- enemy tests -- */
    const minDist = tier === 0 ? w.minEnemyDistance
      : tier === 1 ? w.minEnemyDistance * 0.6
        : tier === 2 ? w.minEnemyDistance * 0.3 : 0;
    const checkVisibility = tier === 0;
    let losCount = 0;
    const px = p.position.x, pz = p.position.z;
    const chestY = p.position.y + CHEST_HEIGHT;

    for (const e of this.enemies) {
      const d = distXZ(p.position, e.position);
      // A two-storey separation is real cover; count it as extra distance.
      const dy = Math.abs(e.position.y - p.position.y);
      const effective = Math.sqrt(d * d + dy * dy * 2.25);
      if (effective < this.nearestEnemy) this.nearestEnemy = effective;
      if (effective < minDist) { this.veto = 'enemy-near'; return -Infinity; }
      if (!useLos || d > LOS_SOFT_RANGE) continue;

      /* Decide whether this enemy needs a visibility query at all. */
      let coneHit = false;
      if (checkVisibility && d < w.viewConeRange) {
        const bearing = yawTo(e.position, p.position);
        coneHit = Math.cos(angleDelta(bearing, e.yaw)) >= this.halfFovCos;
      }
      let fireHit = false;
      if (checkVisibility && e.firing && d < w.lineOfFireRange) {
        const perp = rayDistanceXZ(e.position.x, e.position.z, e.yaw, px, pz, this.rayScratch);
        const along = this.rayScratch[0];
        fireHit = perp < w.lineOfFireWidth && along > 1.5 && along < w.lineOfFireRange;
      }
      const visible = this.lineOfSight(e, chestY, px, p.position.y, pz);
      if (!visible) continue;
      if (checkVisibility && coneHit) { this.veto = 'view-cone'; return -Infinity; }
      if (checkVisibility && fireHit) { this.veto = 'line-of-fire'; return -Infinity; }
      if (checkVisibility && effective < w.losVetoRange) { this.veto = 'enemy-los'; return -Infinity; }
      this.enemyLos = true;
      losCount++;
    }

    /* ---------------------------------------------------------- observers -- */
    if (useLos) {
      for (const o of state.observers) {
        const d = distXZ(p.position, o.position);
        if (d > o.range || d < 0.001) continue;
        const dx = (px - o.position.x) / d, dz = (pz - o.position.z) / d;
        if (dx * o.dir.x + dz * o.dir.z < o.cosHalfFov) continue;
        if (!this.segmentClear(o.position.x, o.position.y + EYE_HEIGHT, o.position.z, px, chestY, pz)) continue;
        if (o.hard && tier === 0) { this.veto = 'observed'; return -Infinity; }
        losCount += 1;
      }
    }

    /* --------------------------------------------------------- soft terms -- */
    let score = 0;

    // Separation from the nearest enemy — the dominant term.
    if (this.enemies.length > 0) {
      const floor = w.minEnemyDistance * 0.5;
      const span = Math.max(1, w.idealEnemyDistance - floor);
      t.enemyDistance = w.enemyDistance * saturate((this.nearestEnemy - floor) / span);
    } else {
      t.enemyDistance = w.enemyDistance;
    }
    score += t.enemyDistance;

    if (losCount > 0) {
      t.enemyLos = -w.enemyLos * saturate(losCount / 2);
      score += t.enemyLos;
    }

    // Friendly mass: spawning onto your team is safe and reads as a squad.
    if (this.allies.length > 0) {
      let nearestAlly = Infinity;
      for (const a of this.allies) {
        const d = distXZ(p.position, a.position);
        if (d < nearestAlly) nearestAlly = d;
      }
      t.friendly = w.friendly * bell(nearestAlly, w.friendlyIdeal, w.friendlySigma);
      score += t.friendly;
    }

    // Recent deaths here. `p.deaths` is already time-decayed by the director.
    if (p.deaths > 0) {
      t.deaths = -w.deaths * saturate(p.deaths / 3);
      score += t.deaths;
    }

    // Objective pull.
    if (this.target) {
      const d = distXZ(p.position, this.target.position);
      const want = this.target.contested ? 34 : 20;
      const reach = Math.max(20, w.objectiveRange);
      const near = bell(d, want, reach * 0.5);
      t.objective = w.objective * near;
      score += t.objective;
    }

    // Reuse cooldown.
    const since = now - p.lastUsed;
    if (since < w.reuseCooldown) {
      t.reuse = -w.reuse * (1 - since / Math.max(0.001, w.reuseCooldown));
      score += t.reuse;
    }

    // Territory: half from the raw influence field, half from the zone verdict.
    if (w.territory > 0) {
      const net = ctx.field.ready ? ctx.field.sample(px, pz) * this.teamSign : 0;
      const zone = ctx.zones.get(p.zone);
      const suit = zone ? ctx.zones.suitability(zone, this.team, now) : 0.5;
      t.territory = w.territory * (0.5 * clamp(net, -1, 1) + 0.5 * (suit * 2 - 1));
      score += t.territory;
    }

    // Optional PvE distance band around a reference point.
    if (req.band) {
      const b = req.band;
      const d = distXZ(p.position, b.origin);
      let band = bell(d, b.ideal, Math.max(4, b.ideal * 0.55));
      if (d < b.min) band -= (1 - d / Math.max(0.001, b.min)) * 1.5;
      if (d > b.max) band -= ((d - b.max) / Math.max(1, b.max)) * 0.8;
      t.band = (b.weight || w.band) * band;
      score += t.band;
    }

    t.cover = w.cover * (p.cover - p.openness * 0.5);
    score += t.cover;

    t.jitter = ctx.rand.range(-w.jitter, w.jitter);
    score += t.jitter;

    this.total = score;
    this.safety = saturate(
      0.6 * saturate(this.nearestEnemy / Math.max(1, w.idealEnemyDistance))
      + (this.enemyLos ? 0 : 0.25)
      + 0.15 * (1 - saturate(p.deaths / 3)),
    );
    return score;
  }

  /** LOS from an enemy's eye to a spawned body's chest. */
  private lineOfSight(e: SpawnActor, chestY: number, px: number, py: number, pz: number): boolean {
    void py;
    return this.segmentClear(
      e.position.x, e.position.y + EYE_HEIGHT, e.position.z, px, chestY, pz,
    );
  }

  private segmentClear(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  ): boolean {
    const los = this.ctx?.los;
    // No world knowledge: assume the worst, exactly as the old selector did.
    if (!los) return true;
    return los.lineOfSight(ax, ay, az, bx, by, bz);
  }
}
