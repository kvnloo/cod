/**
 * KILL CONFIRMED — a kill is a promise, the tag is the payment.
 *
 * Every death drops a dog tag at the body. Picking up an enemy tag confirms the
 * kill and is the only thing that moves the scoreboard; picking up a friendly
 * tag denies the enemy their point and pays the player score instead. That one
 * rule is what turns every trade into a second fight over the same three metres
 * of floor, so the tags are a first-class replicable entity rather than a
 * cosmetic pickup.
 */

import * as THREE from 'three';
import { DogTagField, type DogTag, type TagOutcome } from '../Objectives';
import { TeamMode, type ModeOrder, type RosterEntry } from './TeamMode';
import type { MatchHost } from './Mode';
import type { Team } from '../types';
import { otherTeam } from './ModeDefs';

export class KillConfirmedMode extends TeamMode {
  readonly tags: DogTagField;
  private confirmed = { friendly: 0, hostile: 0 };
  private denied = { friendly: 0, hostile: 0 };
  private readonly _t = new THREE.Vector3();

  constructor() {
    super('kc');
    const o = this.def.objective;
    this.tags = new DogTagField(o.tagRadius, o.tagLifetime);
  }

  protected override buildObjectives(host: MatchHost): void {
    this.tags.clear();
    this.tags.onResolved = (tag, by, outcome) => this.onTag(host, tag, by, outcome);
  }

  protected override onRoundStart(_host: MatchHost): void {
    this.tags.clear();
  }

  /**
   * The tag field is not an `Objective`, so the mode steps it. It reads the
   * same presence probe every team objective does, through a minimal world
   * view — the mode owns the probe, so this stays honest on a client too.
   */
  protected override onLive(dt: number, host: MatchHost): void {
    this.tags.step(dt, {
      emit: host.emit,
      playerPosition: host.playerPosition(),
      playerAlive: this.playerAlive(),
      playerInteracting: false,
      hostilesWithin: (c, r) => host.combat.countWithin(c, r),
      addMarker: () => { },
      now: host.matchTime,
      presence: (c, r, out) => this.presence(c, r, out),
    });
  }

  /** Somebody died — drop their tag where they fell. */
  protected override onOperatorDown(host: MatchHost, team: Team, byPlayer: boolean, e: RosterEntry | null): void {
    if (e) this._t.set(e.x, e.y, e.z);
    else {
      const p = team === 'friendly' ? host.playerPosition() : null;
      if (p) this._t.copy(p);
      else this._t.set(0, host.groundAt(0, 0, 0), 0);
    }
    this.tags.drop(team, this._t.x, this._t.y, this._t.z);
    host.log.record(host.tick, 'tagDrop', team === 'friendly' ? 1 : 2, this.tags.tags.length);
    if (team === 'hostile' && !byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
  }

  private onTag(host: MatchHost, tag: DogTag, by: Team, outcome: TagOutcome): void {
    if (outcome === 'expire') return;
    if (outcome === 'confirm') {
      this.confirmed[by]++;
      this.addTeamScore(host, by, this.def.score.perConfirm);
      if (by === 'friendly') {
        host.scoring.addScore(this.def.score.playerObjectiveScore, 'Confirmed');
        host.emit('hud:announce', { key: 'kc-confirm', text: 'CONFIRMED', priority: 4 });
      }
    } else {
      this.denied[by]++;
      this.addTeamScore(host, by, this.def.score.perDeny);
      if (by === 'friendly') {
        host.scoring.addScore(Math.round(this.def.score.playerObjectiveScore * 0.6), 'Denied');
        host.emit('hud:announce', { key: 'kc-deny', text: 'DENIED', priority: 3 });
      }
    }
    host.log.record(host.tick, outcome === 'confirm' ? 'tagConfirm' : 'tagDeny',
      by === 'friendly' ? 1 : 2, tag.netId);
  }

  /** Bots break off to the nearest tag that is worth something to their side. */
  protected override orderFor(host: MatchHost, e: RosterEntry): ModeOrder | null {
    if (this.tags.tags.length === 0) return null;
    if (!host.combat.enemyPosition(e.id, this._p)) return null;
    let best: DogTag | null = null;
    let bestD = Infinity;
    for (const t of this.tags.tags) {
      const dx = t.x - this._p.x;
      const dz = t.z - this._p.z;
      const d = dx * dx + dz * dz;
      // A confirm is worth more than a deny, so weight enemy tags nearer.
      const weight = t.owner === otherTeam(e.team) ? 1 : 2.2;
      if (d * weight < bestD) { bestD = d * weight; best = t; }
    }
    if (!best) return null;
    this._t.set(best.x, best.y, best.z);
    return this.order(e, 'collect', this._t, this.def.objective.tagRadius, 0.85);
  }

  stats(): { confirmed: { friendly: number; hostile: number }; denied: { friendly: number; hostile: number }; live: number } {
    return { confirmed: { ...this.confirmed }, denied: { ...this.denied }, live: this.tags.tags.length };
  }
}
