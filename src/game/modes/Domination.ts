/**
 * DOMINATION — three flags, 200 points, sides swap at 100.
 *
 * Score is a metronome, not an event: every `tickPeriod` seconds each team
 * banks one point per flag it holds, which is what makes a two-flag lead feel
 * like a slow strangle rather than a scoreline. Kills are worth nothing.
 *
 * Spawning is the other half of the mode. `SpawnRules.kind = 'objective'`
 * anchors each team's respawn band on a flag it already owns, and the wave
 * respawn timer in the definition stops a three-flag team from trickling
 * bodies into the same doorway one at a time.
 */

import * as THREE from 'three';
import { CaptureZoneObjective } from '../Objectives';
import { TeamMode, type ModeOrder, type RosterEntry } from './TeamMode';
import type { MatchHost } from './Mode';
import type { Team } from '../types';

export class DominationMode extends TeamMode {
  private zones: CaptureZoneObjective[] = [];
  private tickAccum = 0;

  constructor() { super('dom'); }

  protected override buildObjectives(host: MatchHost): void {
    this.zones.length = 0;
    const o = this.def.objective;
    for (let i = 0; i < this.sites.length; i++) {
      const z = new CaptureZoneObjective(i, this.sites[i], o.radius, o.captureTime);
      z.onCaptured = (zone, by, from) => this.onFlagTaken(host, zone, by, from);
      this.zones.push(z);
      host.addObjective(z);
    }
  }

  /** Flags this team owns, for the HUD and the spawn anchor. */
  owned(team: Team): number {
    let n = 0;
    for (const z of this.zones) if (z.owner === team) n++;
    return n;
  }

  protected override ownedSite(team: Team): THREE.Vector3 | null {
    // Prefer a flag we hold that the enemy is not standing on.
    let fallback: THREE.Vector3 | null = null;
    for (const z of this.zones) {
      if (z.owner !== team || !z.position) continue;
      fallback ??= z.position;
      if (!z.contested) return z.position;
    }
    return fallback;
  }

  private onFlagTaken(host: MatchHost, z: CaptureZoneObjective, by: Team, from: Team | 'neutral'): void {
    host.log.record(host.tick, 'flagTaken', z.index, by === 'friendly' ? 1 : 2);
    host.emit('hud:announce', {
      key: `dom-${z.index}`,
      text: by === 'friendly' ? `${z.letter} CAPTURED` : `${z.letter} LOST`,
      priority: 6,
    });
    host.banner(
      by === 'friendly' ? `FLAG ${z.letter} CAPTURED` : `FLAG ${z.letter} LOST`,
      `${this.owned('friendly')} of ${this.zones.length} held`,
      by === 'friendly' ? 'reward' : 'alert', 2.6,
    );
    if (by === 'friendly') {
      host.scoring.addScore(this.def.score.playerObjectiveScore, 'Capture');
    }
    this.addTeamScore(host, by, this.def.score.perCapture);
    void from;
  }

  protected override onLive(dt: number, host: MatchHost): void {
    const period = this.def.score.tickPeriod;
    this.tickAccum += dt;
    while (this.tickAccum >= period) {
      this.tickAccum -= period;
      const us = this.owned('friendly');
      const them = this.owned('hostile');
      if (us > 0) this.addTeamScore(host, 'friendly', this.def.score.perObjectiveTick * us);
      if (them > 0) this.addTeamScore(host, 'hostile', this.def.score.perObjectiveTick * them);
    }
  }

  protected override onOperatorDown(host: MatchHost, team: Team, byPlayer: boolean, _e: RosterEntry | null): void {
    // Kills do not score in Domination, but an assist still pays the player.
    if (team === 'hostile' && !byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
  }

  /**
   * Bots go for the flag that swings the game: the nearest one the team does
   * not already hold, falling back to defending the least safe flag it does.
   */
  protected override orderFor(host: MatchHost, e: RosterEntry): ModeOrder | null {
    if (!host.combat.enemyPosition(e.id, this._p)) return null;
    let target: CaptureZoneObjective | null = null;
    let bestD = Infinity;
    for (const z of this.zones) {
      if (!z.position || z.owner === e.team) continue;
      const d = z.position.distanceToSquared(this._p);
      if (d < bestD) { bestD = d; target = z; }
    }
    if (target?.position) {
      return this.order(e, 'capture', target.position, target.radius, 0.9);
    }
    // Everything is ours: hold whichever flag the enemy is closest to.
    let defend: CaptureZoneObjective | null = null;
    let worst = -1;
    for (const z of this.zones) {
      if (!z.position) continue;
      const pressure = z.contested ? 2 : 1;
      if (pressure > worst) { worst = pressure; defend = z; }
    }
    return defend?.position ? this.order(e, 'defend', defend.position, defend.radius, 0.6) : null;
  }

  /** Flag ownership for the HUD, in A/B/C order. */
  flagStates(): ReadonlyArray<{ letter: string; owner: string; progress: number; contested: boolean }> {
    return this.zones.map((z) => ({
      letter: z.letter, owner: z.owner, progress: z.capture, contested: z.contested,
    }));
  }

  protected override onSidesSwapped(host: MatchHost): void {
    // Sides trade ends; the flags themselves keep their owners.
    host.emit('hud:announce', { key: 'dom-half', text: 'HALFTIME', priority: 8 });
  }
}
