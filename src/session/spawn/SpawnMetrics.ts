/**
 * Spawn quality measurement.
 *
 * The whole system is judged by one number: **what fraction of spawns end in a
 * death within three seconds?** Everything else — separation, line of sight,
 * territory — is a means to moving that number. So it is measured here, in the
 * runtime, not only in the offline benchmark: a live match reports the same
 * statistic the harness prints, which is what makes tuning honest.
 *
 * Secondary numbers exist because the headline rate alone can be gamed by
 * spawning everyone in a corner: mean distance to the nearest enemy, the share
 * of spawns an enemy could see, and the veto histogram together say *why* the
 * rate is what it is.
 */

import type { SpawnDecision, SpawnVeto } from './types';
import { VETO_KINDS } from './types';

export interface SpawnRecord {
  actorId: number;
  pointId: number;
  zone: number;
  at: number;
  x: number;
  z: number;
  enemyDistance: number;
  enemyLos: boolean;
  outcome: SpawnDecision['outcome'];
  safety: number;
  /** Seconds survived, or -1 while still alive. */
  survived: number;
  /** Actor that killed them, or -1. */
  killer: number;
}

export interface SpawnQualityReport {
  spawns: number;
  deaths: number;
  /** Spawns old enough to have been judged — the rate's denominator. */
  measured: number;
  /** Deaths within the early window / spawns that had time to be measured. */
  earlyDeathRate: number;
  earlyDeaths: number;
  /** Deaths within half the early window — the truly indefensible ones. */
  instantDeathRate: number;
  meanEnemyDistance: number;
  minEnemyDistance: number;
  /** Share of grants where an enemy had line of sight to the point. */
  losRate: number;
  meanSurvival: number;
  medianSurvival: number;
  /** Share of grants that needed a relaxed tier. */
  relaxedRate: number;
  forcedRate: number;
  failedRate: number;
  meanSafety: number;
  /** Worst outcomes, shortest survival first. */
  worst: SpawnRecord[];
  vetoes: Record<string, number>;
  /** Mean candidates examined per request. */
  meanConsidered: number;
}

export class SpawnMetrics {
  /** Window that defines a "spawn death", seconds. */
  window = 3;
  /** Cap on retained records; oldest are dropped. */
  capacity = 4096;

  readonly records: SpawnRecord[] = [];
  private live = new Map<number, SpawnRecord>();
  private vetoCounts: Record<string, number> = {};
  private consideredTotal = 0;
  private requests = 0;

  constructor() { this.resetVetoes(); }

  reset(): void {
    this.records.length = 0;
    this.live.clear();
    this.resetVetoes();
    this.consideredTotal = 0;
    this.requests = 0;
  }

  private resetVetoes(): void {
    this.vetoCounts = {};
    for (const k of VETO_KINDS) this.vetoCounts[k] = 0;
  }

  /** Called for every granted spawn. */
  noteSpawn(actorId: number, zone: number, decision: SpawnDecision, now: number): SpawnRecord {
    const rec: SpawnRecord = {
      actorId,
      pointId: decision.pointId,
      zone,
      at: now,
      x: decision.position.x,
      z: decision.position.z,
      enemyDistance: decision.enemyDistance,
      enemyLos: decision.enemyLos,
      outcome: decision.outcome,
      safety: decision.safety,
      survived: -1,
      killer: -1,
    };
    this.records.push(rec);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    this.live.set(actorId, rec);
    this.requests++;
    this.consideredTotal += decision.considered;
    return rec;
  }

  /** Called for every death of an actor that this system spawned. */
  noteDeath(actorId: number, now: number, killer = -1): SpawnRecord | null {
    const rec = this.live.get(actorId);
    if (!rec) return null;
    rec.survived = Math.max(0, now - rec.at);
    rec.killer = killer;
    this.live.delete(actorId);
    return rec;
  }

  /** Called when an actor leaves without dying (round end, disconnect). */
  noteRetire(actorId: number): void {
    this.live.delete(actorId);
  }

  noteVeto(kind: SpawnVeto, count = 1): void {
    if (kind === 'none') return;
    this.vetoCounts[kind] = (this.vetoCounts[kind] ?? 0) + count;
  }

  /** True when the record counts as a spawn death. */
  isEarlyDeath(rec: SpawnRecord): boolean {
    return rec.survived >= 0 && rec.survived <= this.window;
  }

  report(now = Infinity, worstCount = 5): SpawnQualityReport {
    const r: SpawnQualityReport = {
      spawns: this.records.length,
      deaths: 0,
      measured: 0,
      earlyDeathRate: 0,
      earlyDeaths: 0,
      instantDeathRate: 0,
      meanEnemyDistance: 0,
      minEnemyDistance: Infinity,
      losRate: 0,
      meanSurvival: 0,
      medianSurvival: 0,
      relaxedRate: 0,
      forcedRate: 0,
      failedRate: 0,
      meanSafety: 0,
      worst: [],
      vetoes: { ...this.vetoCounts },
      meanConsidered: this.requests > 0 ? this.consideredTotal / this.requests : 0,
    };
    if (this.records.length === 0) {
      r.minEnemyDistance = 0;
      return r;
    }

    let distSum = 0, distCount = 0, losCount = 0, safetySum = 0;
    let survSum = 0, instant = 0, measurable = 0;
    const survivals: number[] = [];
    for (const rec of this.records) {
      if (Number.isFinite(rec.enemyDistance)) {
        distSum += rec.enemyDistance;
        distCount++;
        if (rec.enemyDistance < r.minEnemyDistance) r.minEnemyDistance = rec.enemyDistance;
      }
      if (rec.enemyLos) losCount++;
      safetySum += rec.safety;
      if (rec.outcome === 'relaxed') r.relaxedRate++;
      else if (rec.outcome === 'forced') r.forcedRate++;
      else if (rec.outcome === 'none') r.failedRate++;

      if (rec.survived >= 0) {
        r.deaths++;
        survSum += rec.survived;
        survivals.push(rec.survived);
        if (rec.survived <= this.window) r.earlyDeaths++;
        if (rec.survived <= this.window * 0.5) instant++;
        measurable++;
      } else if (now - rec.at >= this.window) {
        // Survived past the window: counts in the denominator, not the numerator.
        measurable++;
      }
    }

    const n = this.records.length;
    r.meanEnemyDistance = distCount > 0 ? distSum / distCount : 0;
    if (!Number.isFinite(r.minEnemyDistance)) r.minEnemyDistance = 0;
    r.losRate = losCount / n;
    r.meanSafety = safetySum / n;
    r.relaxedRate /= n;
    r.forcedRate /= n;
    r.failedRate /= n;
    r.measured = measurable;
    r.earlyDeathRate = measurable > 0 ? r.earlyDeaths / measurable : 0;
    r.instantDeathRate = measurable > 0 ? instant / measurable : 0;
    r.meanSurvival = survivals.length > 0 ? survSum / survivals.length : 0;
    if (survivals.length > 0) {
      const sorted = survivals.slice().sort((a, b) => a - b);
      r.medianSurvival = sorted[Math.floor(sorted.length / 2)];
    }

    r.worst = this.records
      .filter((rec) => rec.survived >= 0)
      .sort((a, b) => a.survived - b.survived || a.enemyDistance - b.enemyDistance)
      .slice(0, worstCount);
    return r;
  }
}
