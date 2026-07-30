/**
 * TEAM DEATHMATCH — 6 v 6 against bots, first to 75.
 *
 * The interesting problem in TDM was never the scoring, it was the spawning:
 * every respawn (player and bot) goes through the shared selector with the live
 * enemy set as *threats* and the live squad as *allies*, plus a node reuse
 * cooldown, so the classic failure mode — one team parking on the other team's
 * pads — cannot establish itself.
 *
 * That selector, the roster and the respawn queues were general enough to be
 * every mode's, so they now live in `TeamMode` and TDM is what remains once the
 * shared parts are lifted out: kills score, nothing else does. The numbers are
 * unchanged (75 kills, ten minutes, five squadmates plus the player).
 */

import { TeamMode, type RosterEntry } from './TeamMode';
import { otherTeam } from './ModeDefs';
import type { MatchHost } from './Mode';
import type { Team } from '../types';

export class TeamDeathmatchMode extends TeamMode {
  private announcedLead = 0;

  constructor() { super('tdm'); }

  /** Whoever did not lose the body scores. */
  protected override onOperatorDown(host: MatchHost, team: Team, byPlayer: boolean, e: RosterEntry | null): void {
    this.addTeamScore(host, otherTeam(team), this.def.score.perKill);
    if (team === 'hostile' && !byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
    host.log.record(
      host.tick, team === 'friendly' ? 'squadDown' : 'hostileDown',
      e?.slot ?? -1, team === 'friendly' ? this.enemyScore : this.teamScore,
    );
  }

  /** Match-point / losing callout, once each. */
  protected override onLive(_dt: number, host: MatchHost): void {
    const near = this.scoreLimit - 5;
    if (this.teamScore >= near && this.announcedLead !== 1) {
      this.announcedLead = 1;
      host.emit('hud:announce', { key: 'tdm-close', text: 'MATCH POINT', priority: 5 });
    } else if (this.enemyScore >= near && this.announcedLead !== -1) {
      this.announcedLead = -1;
      host.emit('hud:announce', { key: 'tdm-losing', text: 'LOSING', priority: 5 });
    }
  }
}
