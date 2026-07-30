/**
 * The spawn director: influence map + zones + scorer + metrics, behind one
 * host-authoritative entry point.
 *
 * Lifecycle per match:
 *
 * ```ts
 * const dir = new SpawnDirector({ rand, los, policy: 'tdm' });
 * dir.setPoints(points);            // once, when the level publishes spawns
 * dir.update(state, dt);            // every tick: refresh territory
 * const d = dir.request({ actorId, team, now });   // on respawn
 * dir.noteDeath(actorId, pos, now); // on death — feeds the influence memory
 * dir.metrics.report();             // spawn-death rate, the scoreboard
 * ```
 *
 * Selection is two-phase (cheap score everything, expensive score the short
 * list) and tiered (relax vetoes only when nothing survives), so a request is
 * bounded work and *always* returns something a body can stand on. There is no
 * code path that returns "no spawn" while candidates exist — a match that
 * cannot place a player is worse than a match that places one badly.
 */

import { distXZ } from './Math';
import { InfluenceField } from './InfluenceField';
import { defaultWeights, policyFor, type SpawnPolicy, type SpawnWeights } from './Policies';
import { SpawnMetrics } from './SpawnMetrics';
import { SpawnScorer, type RelaxTier } from './SpawnScorer';
import { SpawnZones } from './SpawnZones';
import { LocalAuthority, grantFrom, requestMsgFrom, type SpawnAuthority, type SpawnGrant } from './Authority';
import {
  boundsOf, emptyDecision, emptyTerms, emptyWorldState,
  type RandomSource, type SpawnDecision, type SpawnLos, type SpawnPoint,
  type SpawnPolicyId, type SpawnRequestSpec, type SpawnTeam, type SpawnVeto,
  type SpawnWorldState, type Vec3,
} from './types';

/** Candidates that survive the cheap pass and get a visibility test. */
const SHORTLIST = 18;
/** Territory/zone refresh rate. Ownership is a slow signal; 5 Hz is plenty. */
const REFRESH_HZ = 5;

export interface SpawnDirectorOptions {
  rand: RandomSource;
  los?: SpawnLos | null;
  policy?: SpawnPolicyId | SpawnPolicy;
  authority?: SpawnAuthority;
  /** Candidates given a visibility test per request. */
  shortlist?: number;
}

interface Shortlisted { index: number; score: number }

export class SpawnDirector {
  readonly field = new InfluenceField();
  readonly zones = new SpawnZones();
  readonly metrics = new SpawnMetrics();
  readonly scorer = new SpawnScorer();

  policy: SpawnPolicy;
  los: SpawnLos | null;
  authority: SpawnAuthority;
  rand: RandomSource;
  shortlist: number;

  /** All candidates. Owned by the director once `setPoints` is called. */
  points: SpawnPoint[] = [];

  /** Last world state handed to `update`; requests score against it. */
  state: SpawnWorldState = emptyWorldState();

  private seq = 0;
  private refreshAccum = 0;
  private lastDecay = 0;
  private readonly byId = new Map<number, SpawnPoint>();
  private readonly short: Shortlisted[] = [];
  private readonly vetoTally: Partial<Record<SpawnVeto, number>> = {};
  private grantUnsub: (() => void) | null = null;
  private pendingClientSeq = 0;
  /** Team of the request being resolved; used by the fallback helpers. */
  private lastTeam: SpawnTeam = 'friendly';

  constructor(opts: SpawnDirectorOptions) {
    this.rand = opts.rand;
    this.los = opts.los ?? null;
    this.authority = opts.authority ?? new LocalAuthority();
    this.shortlist = opts.shortlist ?? SHORTLIST;
    const p = opts.policy ?? 'tdm';
    this.policy = typeof p === 'string' ? policyFor(p) : p;
    this.applyPolicy();
  }

  get weights(): SpawnWeights { return this.policy.weights; }
  get isHost(): boolean { return this.authority.isHost; }

  /* ------------------------------------------------------------- set-up -- */

  setPolicy(p: SpawnPolicyId | SpawnPolicy): void {
    this.policy = typeof p === 'string' ? policyFor(p) : p;
    this.applyPolicy();
  }

  private applyPolicy(): void {
    this.zones.frozen = this.policy.fixedTeamZones;
    this.metrics.window = this.policy.weights.earlyDeathWindow;
    if (this.policy.aggressiveFlip) {
      this.zones.config.dwell = 1.2;
      this.zones.config.enterThreshold = 0.16;
    } else {
      this.zones.config.dwell = 2.4;
      this.zones.config.enterThreshold = 0.22;
    }
  }

  setLos(los: SpawnLos | null): void { this.los = los; }

  /** Replaces the candidate set and rebuilds zones and the influence grid. */
  setPoints(points: SpawnPoint[]): void {
    this.points = points;
    this.byId.clear();
    for (const p of points) this.byId.set(p.id, p);
    this.zones.build(points);
    this.field.resize(boundsOf(points, 10));
    this.zones.reset(0);
  }

  pointById(id: number): SpawnPoint | null { return this.byId.get(id) ?? null; }

  /** Clears per-round memory: reservations, cooldowns, death heat, territory. */
  reset(now = 0): void {
    for (const p of this.points) {
      p.lastUsed = -1e9;
      p.lastUsedBy = -1;
      p.deaths = 0;
      p.lastDeath = -1e9;
      p.reservedUntil = -1e9;
      p.enabled = true;
    }
    this.field.reset();
    this.zones.reset(now);
    this.metrics.reset();
    this.refreshAccum = 0;
    this.lastDecay = now;
    this.seq = 0;
  }

  /* ------------------------------------------------------------- runtime -- */

  /**
   * Advances territory and memory. Cheap enough to call every fixed step; the
   * expensive parts are internally rate-limited to `REFRESH_HZ`.
   */
  update(state: SpawnWorldState, dt: number): void {
    this.state = state;
    this.refreshAccum += dt;
    const period = 1 / REFRESH_HZ;
    if (this.refreshAccum < period) return;
    const step = this.refreshAccum;
    this.refreshAccum = 0;

    this.field.refresh(state, step);
    this.zones.update(this.field, state, step);

    // Death heat decays so a killzone from two minutes ago is not still steering
    // spawns; the half-life is long enough to survive a single firefight.
    const hl = this.policy.weights.deathHalfLife;
    const elapsed = Math.max(0, state.now - this.lastDecay);
    if (elapsed > 0.001) {
      const k = Math.pow(0.5, elapsed / Math.max(1, hl));
      for (const p of this.points) if (p.deaths > 0.001) p.deaths *= k;
      this.lastDecay = state.now;
    }
  }

  /* ------------------------------------------------------------ requests -- */

  /**
   * Asks for a spawn. On the host this resolves immediately; on a client it
   * forwards the request and returns a `pending` decision the caller must not
   * act on — the body appears when `applyGrant` fires.
   */
  request(req: SpawnRequestSpec, state?: SpawnWorldState): SpawnDecision {
    if (state) this.state = state;
    if (!this.authority.isHost) {
      this.authority.sendSpawnRequest?.(requestMsgFrom(req, this.pendingClientSeq++));
      const d = emptyDecision();
      d.outcome = 'pending';
      return d;
    }
    return this.resolve(req);
  }

  /**
   * Round-start spawn for a whole team. Each grant reserves its point, so the
   * squad is spread rather than stacked, and S&D's fixed pads are handed out in
   * a deterministic order.
   */
  requestGroup(reqs: readonly SpawnRequestSpec[], state?: SpawnWorldState): SpawnDecision[] {
    if (state) this.state = state;
    const out: SpawnDecision[] = [];
    for (const r of reqs) out.push(this.request(r));
    return out;
  }

  /** Host-side selection. Always returns; `outcome` says how hard it had to try. */
  private resolve(req: SpawnRequestSpec): SpawnDecision {
    const decision = emptyDecision();
    decision.considered = this.points.length;
    if (this.points.length === 0) return decision;

    const now = req.now;
    this.state.now = now;
    this.lastTeam = req.team;
    this.scorer.begin({
      state: this.state,
      policy: this.policy,
      field: this.field,
      zones: this.zones,
      los: this.los,
      req,
      rand: this.rand,
    });

    for (const k of Object.keys(this.vetoTally)) delete this.vetoTally[k as SpawnVeto];

    const tiers: RelaxTier[] = [0, 1, 2, 3];
    let chosen: SpawnPoint | null = null;
    let chosenTier: RelaxTier = 0;
    let bestScore = -Infinity;
    const terms = emptyTerms();
    let bestNearest = Infinity;
    let bestLos = false;
    let bestSafety = 0;
    let vetoed = 0;

    for (const tier of tiers) {
      /* --- phase 1: cheap score, no visibility queries --- */
      this.short.length = 0;
      let rejected = 0;
      for (let i = 0; i < this.points.length; i++) {
        const s = this.scorer.score(this.points[i], false, tier);
        if (s === -Infinity) {
          rejected++;
          if (tier === 0) this.tallyVeto(this.scorer.veto);
          continue;
        }
        this.insertShort(i, s);
      }
      if (tier === 0) vetoed = rejected;
      if (this.short.length === 0) continue;

      /* --- phase 2: full score with visibility on the short list --- */
      let best = -Infinity;
      let bestIndex = -1;
      for (const c of this.short) {
        const s = this.scorer.score(this.points[c.index], true, tier);
        if (s === -Infinity) {
          if (tier === 0) this.tallyVeto(this.scorer.veto);
          continue;
        }
        if (s > best) {
          best = s;
          bestIndex = c.index;
          bestNearest = this.scorer.nearestEnemy;
          bestLos = this.scorer.enemyLos;
          bestSafety = this.scorer.safety;
          Object.assign(terms, this.scorer.terms);
        }
      }
      if (bestIndex >= 0) {
        chosen = this.points[bestIndex];
        chosenTier = tier;
        bestScore = best;
        break;
      }
    }

    /* --- last resort: whatever is furthest from the nearest enemy --- */
    if (!chosen) {
      chosen = this.furthestFromEnemies();
      chosenTier = 3;
      if (chosen) {
        bestNearest = this.nearestEnemyDistance(chosen.position);
        bestLos = false;
        bestSafety = 0;
        bestScore = 0;
      }
    }

    decision.vetoed = vetoed;
    decision.topVeto = this.topVeto();
    for (const kind of Object.keys(this.vetoTally) as SpawnVeto[]) {
      this.metrics.noteVeto(kind, this.vetoTally[kind] ?? 0);
    }
    if (!chosen) return decision;

    decision.ok = true;
    decision.pointId = chosen.id;
    decision.position = { x: chosen.position.x, y: chosen.position.y, z: chosen.position.z };
    decision.yaw = this.facing(chosen);
    decision.score = bestScore;
    decision.safety = bestSafety;
    decision.enemyDistance = bestNearest;
    decision.enemyLos = bestLos;
    decision.outcome = chosenTier === 0 ? 'best' : chosenTier < 3 ? 'relaxed' : 'forced';
    decision.terms = terms;
    decision.seq = ++this.seq;

    this.commit(req.actorId, decision, now);
    this.authority.broadcastGrant?.(grantFrom(decision, req.actorId, this.authority.tick));
    return decision;
  }

  /**
   * Marks a point used and records the grant. Called automatically by
   * `resolve`, and by clients when a grant arrives from the host.
   */
  commit(actorId: number, decision: SpawnDecision, now: number): void {
    const p = this.pointById(decision.pointId);
    if (p) {
      p.lastUsed = now;
      p.lastUsedBy = actorId;
      p.reservedUntil = now + this.policy.weights.reservation;
      this.zones.noteGrant(p.zone);
    }
    this.metrics.noteSpawn(actorId, p ? p.zone : -1, decision, now);
  }

  /** Client-side application of a host grant. */
  applyGrant(grant: SpawnGrant, now: number): SpawnDecision {
    const d = emptyDecision();
    d.ok = grant.pointId >= 0;
    d.pointId = grant.pointId;
    d.position = { x: grant.x, y: grant.y, z: grant.z };
    d.yaw = grant.yaw;
    d.outcome = 'best';
    d.seq = grant.seq;
    this.commit(grant.actorId, d, now);
    return d;
  }

  /** Subscribes to host grants. Returns an unsubscribe. */
  listenForGrants(cb: (grant: SpawnGrant) => void): () => void {
    this.grantUnsub?.();
    this.grantUnsub = this.authority.onGrant?.(cb) ?? null;
    return () => { this.grantUnsub?.(); this.grantUnsub = null; };
  }

  /* -------------------------------------------------------------- deaths -- */

  /**
   * Records a death. Two things happen: the metric learns whether the victim's
   * spawn killed them, and the point set remembers where people die so the
   * influence map routes future spawns around it.
   */
  noteDeath(actorId: number, position: Vec3, now: number, killer = -1): void {
    const rec = this.metrics.noteDeath(actorId, now, killer);
    const radius = this.policy.weights.deathRadius;
    for (const p of this.points) {
      const d = distXZ(p.position, position);
      if (d > radius) continue;
      p.deaths += 1 - d / radius;
      p.lastDeath = now;
    }
    if (rec && this.metrics.isEarlyDeath(rec) && rec.zone >= 0) {
      this.zones.noteEarlyDeath(rec.zone, now);
    }
  }

  /** Actor left without dying (round end, disconnect). */
  noteRetire(actorId: number): void { this.metrics.noteRetire(actorId); }

  /* ------------------------------------------------------------- helpers -- */

  /** Faces the spawn toward the fight: the objective, else the enemy mass. */
  private facing(p: SpawnPoint): number {
    const obj = this.scorer.objective;
    if (obj) return Math.atan2(obj.position.x - p.position.x, obj.position.z - p.position.z);
    let cx = 0, cz = 0, n = 0;
    for (const a of this.state.actors) {
      if (!a.alive || a.team === 'neutral' || a.team === this.lastTeam) continue;
      cx += a.position.x; cz += a.position.z; n++;
    }
    if (n === 0) return p.yaw;
    return Math.atan2(cx / n - p.position.x, cz / n - p.position.z);
  }

  private nearestEnemyDistance(p: Vec3): number {
    let best = Infinity;
    for (const a of this.state.actors) {
      if (!a.alive || a.team === 'neutral' || a.team === this.lastTeam) continue;
      const d = distXZ(p, a.position);
      if (d < best) best = d;
    }
    return best;
  }

  private furthestFromEnemies(): SpawnPoint | null {
    let best: SpawnPoint | null = null;
    let bestD = -Infinity;
    for (const p of this.points) {
      if (!p.enabled) continue;
      const d = this.nearestEnemyDistance(p.position);
      const score = (Number.isFinite(d) ? d : 1000) - (p.deaths * 4);
      if (score > bestD) { bestD = score; best = p; }
    }
    return best;
  }

  /** Insertion into a fixed-size best-N list; no sort, no allocation. */
  private insertShort(index: number, score: number): void {
    const list = this.short;
    if (list.length < this.shortlist) {
      list.push({ index, score });
      for (let i = list.length - 1; i > 0 && list[i].score > list[i - 1].score; i--) {
        const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t;
      }
      return;
    }
    const last = list[list.length - 1];
    if (score <= last.score) return;
    last.index = index;
    last.score = score;
    for (let i = list.length - 1; i > 0 && list[i].score > list[i - 1].score; i--) {
      const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t;
    }
  }

  private tallyVeto(kind: SpawnVeto): void {
    if (kind === 'none') return;
    this.vetoTally[kind] = (this.vetoTally[kind] ?? 0) + 1;
  }

  private topVeto(): SpawnVeto {
    let best: SpawnVeto = 'none';
    let bestN = 0;
    for (const k of Object.keys(this.vetoTally) as SpawnVeto[]) {
      const n = this.vetoTally[k] ?? 0;
      if (n > bestN) { bestN = n; best = k; }
    }
    return best;
  }

  /** Default weights, exposed so callers can build a tuned policy. */
  static defaultWeights(): SpawnWeights { return defaultWeights(); }
}
