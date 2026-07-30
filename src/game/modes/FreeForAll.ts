/**
 * FREE-FOR-ALL — eight operators, thirty kills, no friends.
 *
 * The interesting problem here is attribution. In a two-team mode the scoring
 * side falls out of the victim's team; in FFA it does not, so the mode wants
 * `MatchRunner.reportKill(killer, victim)` from whichever layer actually knows
 * who fired — the AI system today, the authoritative host once `src/net` lands.
 * Until that call arrives it falls back to nearest-live-shooter attribution,
 * which is deterministic (index-ordered, seeded tie-break) and good enough to
 * keep the scoreboard honest for bot-vs-bot fights.
 *
 * The other FFA-specific rule is spawning: `SpawnRules.kind = 'scatter'` treats
 * every other body as a threat, because in this mode every other body is.
 */

import * as THREE from 'three';
import { TeamMode, type ModeOrder, type RosterEntry } from './TeamMode';
import type { MatchHost } from './Mode';
import type { Team } from '../types';

export interface FfaStanding {
  slot: number;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  isPlayer: boolean;
}

export class FreeForAllMode extends TeamMode {
  private playerScore = 0;
  private playerKills = 0;
  private playerDeaths = 0;
  private leaderSlot = -1;
  private readonly _v = new THREE.Vector3();

  constructor() { super('ffa'); }

  /* --------------------------------------------------------- attribution -- */

  /**
   * Called by whoever knows the shooter — ideally immediately *before* the
   * lethal damage lands, which is the order an authoritative host naturally
   * produces. Late or missing calls fall through to nearest-live attribution.
   */
  override onKillAttributed(host: MatchHost, killerId: number, victimId: number): void {
    if (killerId === victimId) return;
    void host;
    this.pendingKiller.set(victimId, killerId);
    if (this.pendingKiller.size > 64) {
      const first = this.pendingKiller.keys().next();
      if (!first.done) this.pendingKiller.delete(first.value);
    }
  }

  private pendingKiller = new Map<number, number>();

  private isPlayerEntity(host: MatchHost, id: number): boolean {
    const p = host.services.player;
    return !!p && p.entityId === id;
  }

  // Player kills are attributed through `onOperatorDown`, which already knows
  // `byPlayer`; only bot-on-bot kills need `onKillAttributed`.

  protected override onOperatorDown(
    host: MatchHost, team: Team, byPlayer: boolean, e: RosterEntry | null, victimId: number,
  ): void {
    if (e === null) { this.playerDeaths++; this.pendingKiller.delete(victimId); return; }
    void team;

    const reported = this.pendingKiller.get(victimId);
    this.pendingKiller.delete(victimId);
    if (reported !== undefined) {
      const killer = this.entryFor(reported);
      if (killer) { this.creditBot(host, killer); return; }
      if (this.isPlayerEntity(host, reported)) { this.creditPlayer(host); return; }
    }
    if (byPlayer) { this.creditPlayer(host); return; }
    // Bot-on-bot with no attribution call: nearest live operator takes it.
    const killer = this.nearestLive(host, e);
    if (killer) this.creditBot(host, killer);
  }

  private creditPlayer(host: MatchHost): void {
    this.playerKills++;
    this.playerScore += this.def.score.perKill;
    this.teamScore = this.playerScore;
    this.refreshLeader(host);
  }

  private creditBot(host: MatchHost, e: RosterEntry): void {
    e.kills++;
    e.score += this.def.score.perKill;
    this.refreshLeader(host);
  }

  /** Deterministic fallback: closest live operator to the body, lowest slot wins ties. */
  private nearestLive(host: MatchHost, victim: RosterEntry | null): RosterEntry | null {
    if (!victim) return null;
    this._v.set(victim.x, victim.y, victim.z);
    let best: RosterEntry | null = null;
    let bestD = Infinity;
    for (const e of this.roster) {
      if (!e.alive || e.id < 0 || e === victim) continue;
      const dx = e.x - this._v.x;
      const dz = e.z - this._v.z;
      const d = dx * dx + dz * dz;
      if (d < bestD - 1e-6) { bestD = d; best = e; }
    }
    void host;
    return best;
  }

  private refreshLeader(host: MatchHost): void {
    let topScore = this.playerScore;
    let topSlot = -1;
    for (const e of this.roster) {
      if (e.score > topScore) { topScore = e.score; topSlot = e.slot; }
    }
    this.enemyScore = 0;
    for (const e of this.roster) if (e.score > this.enemyScore) this.enemyScore = e.score;
    this.teamScore = this.playerScore;
    if (topSlot !== this.leaderSlot) {
      this.leaderSlot = topSlot;
      host.emit('hud:announce', {
        key: 'ffa-lead',
        text: topSlot === -1 ? 'YOU HAVE THE LEAD' : 'YOU LOST THE LEAD',
        priority: 5,
      });
    }
  }

  /* ------------------------------------------------------------- verdicts -- */

  protected override evaluate(host: MatchHost): { winner: 'friendly' | 'hostile' | 'draw'; reason: string } | null {
    if (this.playerScore >= this.scoreLimit) {
      return { winner: 'friendly', reason: `${this.scoreLimit} kills` };
    }
    for (const e of this.roster) {
      if (e.score >= this.scoreLimit) {
        return { winner: 'hostile', reason: `${e.name} reached ${this.scoreLimit}` };
      }
    }
    return super.evaluate(host);
  }

  /* -------------------------------------------------------------- orders -- */

  protected override orderFor(_host: MatchHost, e: RosterEntry): ModeOrder | null {
    // Nothing to capture; the order layer just names the hunt so the AI knows
    // it is free to roam rather than hold ground.
    this._v.set(e.x, e.y, e.z);
    return this.order(e, 'hunt', this._v, 0, 0.3);
  }

  /** Full scoreboard, highest score first, deterministic on ties by slot. */
  standings(): FfaStanding[] {
    const rows: FfaStanding[] = [{
      slot: -1, name: 'YOU', score: this.playerScore,
      kills: this.playerKills, deaths: this.playerDeaths, isPlayer: true,
    }];
    for (const e of this.roster) {
      rows.push({ slot: e.slot, name: e.name, score: e.score, kills: e.kills, deaths: e.deaths, isPlayer: false });
    }
    rows.sort((a, b) => (b.score - a.score) || (a.slot - b.slot));
    return rows;
  }

  /** Where the player finished, 1-based. */
  placement(): number {
    return this.standings().findIndex((r) => r.isPlayer) + 1;
  }
}
