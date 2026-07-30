/**
 * SEARCH AND DESTROY — one life, two sites, first to five rounds.
 *
 * Everything that makes S&D feel different from the rest of the playlist is a
 * consequence of two definition flags: `respawn.enabled = false` and
 * `rounds.enabled = true`. The base `TeamMode` therefore stops queueing
 * respawns, wipes and re-seeds both rosters at the head of each round, and
 * absorbs the player's final death instead of ending the match — the player
 * spectates until the round resolves.
 *
 * The round can end five ways, and the mode reports which:
 *   • the charge detonates            → attackers
 *   • the charge is defused           → defenders
 *   • the attackers are wiped, no bomb→ defenders
 *   • the defenders are wiped, no bomb→ attackers
 *   • the clock expires               → defenders (the fuse suspends the clock)
 *
 * Sides swap after `rounds.halftimeAfter` rounds; scores stay with the team.
 */

import * as THREE from 'three';
import { BombSiteObjective } from '../Objectives';
import { TeamMode, type ModeOrder, type RosterEntry, type RoundWinner } from './TeamMode';
import type { MatchHost } from './Mode';
import type { Team } from '../types';

export class SearchAndDestroyMode extends TeamMode {
  private bombs: BombSiteObjective[] = [];
  private armed: BombSiteObjective | null = null;
  private resolved: { winner: RoundWinner; reason: string } | null = null;
  /** Plants and defuses over the whole match — reported by the verifier. */
  plants = 0;
  defuses = 0;
  detonations = 0;

  constructor() { super('snd'); }

  protected override buildObjectives(host: MatchHost): void {
    this.bombs.length = 0;
    const o = this.def.objective;
    for (let i = 0; i < this.sites.length; i++) {
      const b = new BombSiteObjective(i, this.sites[i], o.radius, o.plantTime, o.fuse, o.defuseTime);
      b.onPlanted = (site) => this.onPlanted(host, site);
      b.onDefused = (site) => this.onDefused(host, site);
      b.onDetonated = (site) => this.onDetonated(host, site);
      this.bombs.push(b);
      host.addObjective(b);
    }
  }

  protected override onRoundStart(host: MatchHost): void {
    this.armed = null;
    this.resolved = null;
    for (const b of this.bombs) b.arm(this.attackers);
    host.banner(
      this.playerAttacking ? 'ATTACK' : 'DEFEND',
      this.playerAttacking ? 'Plant the charge' : 'Deny the sites',
      'objective', 3,
    );
  }

  protected override onSidesSwapped(host: MatchHost): void {
    host.emit('hud:announce', { key: 'snd-half', text: 'HALFTIME — SIDES SWITCHED', priority: 8 });
    for (const b of this.bombs) b.arm(this.attackers);
  }

  /* ---------------------------------------------------------- bomb events -- */

  private onPlanted(host: MatchHost, site: BombSiteObjective): void {
    this.armed = site;
    this.plants++;
    host.log.record(host.tick, 'bombPlant', site.site.charCodeAt(0), this.round);
    if (this.attackers === 'friendly') {
      host.scoring.addScore(this.def.score.playerObjectiveScore, 'Bomb Planted');
    }
    host.emit('hud:announce', {
      key: 'snd-plant',
      text: this.attackers === 'friendly' ? 'CHARGE PLANTED' : 'CHARGE PLANTED — DEFUSE',
      priority: 9,
    });
  }

  private onDefused(host: MatchHost, site: BombSiteObjective): void {
    this.defuses++;
    host.log.record(host.tick, 'bombDefuse', site.site.charCodeAt(0), this.round);
    if (this.defenders === 'friendly') {
      host.scoring.addScore(this.def.score.playerObjectiveScore, 'Bomb Defused');
    }
    this.resolved = { winner: this.defenders, reason: `Charge defused at site ${site.site}` };
  }

  private onDetonated(host: MatchHost, site: BombSiteObjective): void {
    this.detonations++;
    host.log.record(host.tick, 'bombBoom', site.site.charCodeAt(0), this.round);
    this.resolved = { winner: this.attackers, reason: `Charge detonated at site ${site.site}` };
  }

  /* ------------------------------------------------------------- verdicts -- */

  protected override evaluate(_host: MatchHost): { winner: RoundWinner; reason: string } | null {
    if (this.resolved) return this.resolved;

    const att = this.aliveCount(this.attackers);
    const def = this.aliveCount(this.defenders);
    const bombLive = this.armed !== null && this.armed.phase !== 'defused';

    if (!bombLive) {
      if (att === 0) return { winner: this.defenders, reason: 'Attackers eliminated' };
      if (def === 0) return { winner: this.attackers, reason: 'Defenders eliminated' };
    } else if (def === 0) {
      // Nobody left to defuse — let the fuse run out rather than short-circuit,
      // so the killcam and the detonation FX still get their beat.
      return null;
    }
    return null;
  }

  /** The fuse suspends the round clock: a live charge is decided by the fuse. */
  protected override onTimeExpired(_host: MatchHost): { winner: RoundWinner; reason: string } | null {
    if (this.armed && (this.armed.phase === 'armed' || this.armed.phase === 'defusing')) {
      // A live charge suspends the round clock: hand the fuse back and play on.
      this.clock = this.armed.fuseLeft + 1;
      return null;
    }
    return { winner: this.defenders, reason: 'Time expired — sites held' };
  }

  protected override onOperatorDown(host: MatchHost, team: Team, byPlayer: boolean, _e: RosterEntry | null): void {
    if (team === 'hostile' && !byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
  }

  /* -------------------------------------------------------------- orders -- */

  protected override orderFor(host: MatchHost, e: RosterEntry): ModeOrder | null {
    const attacking = e.team === this.attackers;
    if (this.armed && this.armed.position) {
      return this.order(
        e, attacking ? 'defend' : 'defuse',
        this.armed.position, this.armed.radius, 1,
      );
    }
    if (this.bombs.length === 0) return null;
    if (!host.combat.enemyPosition(e.id, this._p)) this._p.set(e.x, e.y, e.z);
    let target = this.bombs[0];
    let bestD = Infinity;
    for (const b of this.bombs) {
      if (!b.position) continue;
      const d = b.position.distanceToSquared(this._p);
      if (d < bestD) { bestD = d; target = b; }
    }
    return target.position
      ? this.order(e, attacking ? 'plant' : 'defend', target.position, target.radius, 0.9)
      : null;
  }

  /** Live bomb state for the HUD. */
  bombState(): { phase: string; site: string; fuse: number; bar: number; attacking: boolean } {
    const b = this.armed ?? this.bombs[0];
    return {
      phase: b?.phase ?? 'idle',
      site: b?.site ?? '-',
      fuse: b?.fuseLeft ?? 0,
      bar: b?.bar ?? 0,
      attacking: this.playerAttacking,
    };
  }

  sites3d(): readonly THREE.Vector3[] { return this.sites; }
}
