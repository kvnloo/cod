/**
 * HARDPOINT — one zone at a time, sixty seconds each, 250 to win.
 *
 * The whole mode is a single `HardpointObjective` that owns the rotation, so
 * the HUD and the netcode see one stable entity whose position moves rather
 * than a create/destroy churn every minute. Points tick once a second to
 * whichever team is alone on the hill; two teams on it locks the score, which
 * is what makes a contested hill worth dying on.
 *
 * Spawn policy anchors on the *next* hill rather than the current one, so a
 * team that just lost the zone comes back with a rotation to fight for instead
 * of feeding into a held point.
 */

import * as THREE from 'three';
import { HardpointObjective } from '../Objectives';
import { TeamMode, type ModeOrder, type RosterEntry } from './TeamMode';
import type { MatchHost } from './Mode';
import type { Team } from '../types';

export class HardpointMode extends TeamMode {
  private hill: HardpointObjective | null = null;
  private tickAccum = 0;
  private hillsRotated = 0;

  constructor() { super('hardpoint'); }

  protected override buildObjectives(host: MatchHost): void {
    const o = this.def.objective;
    const h = new HardpointObjective(this.sites.slice(), o.radius, o.rotateEvery, o.rotateEvery);
    h.onRotate = () => {
      this.hillsRotated++;
      host.log.record(host.tick, 'hillRotate', h.hill, this.hillsRotated);
    };
    this.hill = h;
    host.addObjective(h);
  }

  /** Hills that have come and gone — reported by the mode verifier. */
  get rotations(): number { return this.hillsRotated; }

  protected override ownedSite(team: Team): THREE.Vector3 | null {
    const h = this.hill;
    if (!h || !h.position) return null;
    // Own the hill → spawn behind it. Do not own it → head for the next one.
    if (h.owner === team) return h.position;
    return this.sites[(h.hill + 1) % Math.max(1, this.sites.length)] ?? h.position;
  }

  protected override onLive(dt: number, host: MatchHost): void {
    const h = this.hill;
    if (!h) return;
    const period = this.def.score.tickPeriod;
    this.tickAccum += dt;
    while (this.tickAccum >= period) {
      this.tickAccum -= period;
      if (h.locked || h.owner === 'neutral') continue;
      this.addTeamScore(host, h.owner, this.def.score.perObjectiveTick);
      if (h.owner === 'friendly') {
        host.scoring.addScore(this.def.score.playerObjectiveScore * 0.2, 'Hardpoint');
      }
    }
  }

  protected override onOperatorDown(host: MatchHost, team: Team, byPlayer: boolean, _e: RosterEntry | null): void {
    if (team === 'hostile' && !byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
  }

  protected override orderFor(_host: MatchHost, e: RosterEntry): ModeOrder | null {
    const h = this.hill;
    if (!h || !h.position) return null;
    const kind = h.owner === e.team ? 'defend' : 'capture';
    // Late in a hill's life, half the team should pre-rotate to the next one.
    if (h.nextIn < 8 && this.sites.length > 1 && (e.slot & 1) === 1) {
      const next = this.sites[(h.hill + 1) % this.sites.length];
      return this.order(e, 'capture', next, h.radius, 0.75);
    }
    return this.order(e, kind, h.position, h.radius, 0.95);
  }

  /** Live hill readout for the HUD. */
  hillState(): { index: number; owner: string; contested: boolean; nextIn: number; total: number } {
    const h = this.hill;
    return {
      index: h?.hill ?? 0,
      owner: h?.owner ?? 'neutral',
      contested: h?.locked ?? false,
      nextIn: h?.nextIn ?? 0,
      total: this.sites.length,
    };
  }
}
