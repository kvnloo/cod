/**
 * TEAM DEATHMATCH — 6 v 6 against bots.
 *
 * The interesting problem in TDM is not the scoring, it is the spawning. Every
 * respawn (player and bot) is routed through the shared spawn selector with the
 * live enemy set as *threats* and the live squad as *allies*, plus a node reuse
 * cooldown, so the classic failure mode — one team parking on the other team's
 * pads — cannot establish itself. The director runs flat (no build-up/peak
 * cycle) because in TDM the pacing comes from the players.
 */

import * as THREE from 'three';
import { defaultQuery } from '../Spawns';
import { GameMode, type MatchHost } from './Mode';
import type { Archetype, DirectorSnapshot } from '../types';
import type { KillContext } from '../Scoring';

const SQUAD_SIZE = 5;          // plus the player
const ENEMY_TEAM_SIZE = 6;
const SCORE_LIMIT = 75;
const TIME_LIMIT = 600;
const WARMUP = 6;
const BOT_RESPAWN = 5.5;

interface Squaddie {
  id: number;
  respawnIn: number;
  archetype: Archetype;
}

export class TeamDeathmatchMode extends GameMode {
  readonly id = 'tdm' as const;
  readonly name = 'Team Deathmatch';

  private squad: Squaddie[] = [];
  private warmupTimer = WARMUP;
  private started = false;
  private clock = TIME_LIMIT;
  private query = defaultQuery();
  private threats: THREE.Vector3[] = [];
  private allies: THREE.Vector3[] = [];
  private readonly _p = new THREE.Vector3();
  private pool: THREE.Vector3[] = [];
  private poolCursor = 0;
  private announcedLead = 0;

  /** Recycled vectors for the spawn query; the cursor resets on every pick. */
  private borrow(): THREE.Vector3 {
    if (this.poolCursor >= this.pool.length) this.pool.push(new THREE.Vector3());
    return this.pool[this.poolCursor++];
  }

  constructor() {
    super();
    this.scoreLimit = SCORE_LIMIT;
    this.timeLimit = TIME_LIMIT;
    this.waveTotal = 0;
  }

  start(host: MatchHost): void {
    this.squad.length = 0;
    this.teamScore = 0;
    this.enemyScore = 0;
    this.clock = TIME_LIMIT;
    this.warmupTimer = WARMUP;
    this.started = false;
    this.waveLabel = 'TEAM DEATHMATCH';

    const d = host.director.config;
    d.pacing = false;
    d.flat = 0.72;
    // Pressure is expressed in engagement points; six riflemen ≈ six points.
    d.minPressure = ENEMY_TEAM_SIZE - 1;
    d.maxPressure = ENEMY_TEAM_SIZE + 1;
    d.eliteBias = 0.45;
    d.spawnMin = 26;
    d.spawnIdeal = 44;
    d.spawnMax = 95;
    d.spawnIntervalSlow = 2.2;
    d.spawnIntervalFast = 1.1;
    d.faction = 'pmc';

    const lc = host.lifecycle.config;
    lc.respawnDelay = 5;
    lc.allowLastStand = false;
    lc.respawnEnabled = true;
    lc.regenDelay = 4.0;
    lc.regenRate = 36;

    host.setPhase('warmup');
    host.banner('TEAM DEATHMATCH', `First to ${SCORE_LIMIT}`, 'objective', 3.6);
    host.countdown(WARMUP, 'MATCH START');
    host.services.actors?.setCombatEnabled?.(false);
  }

  fixedUpdate(dt: number, host: MatchHost): void {
    if (!this.started) {
      this.warmupTimer -= dt;
      host.countdown(Math.max(0, this.warmupTimer), 'MATCH START');
      if (this.warmupTimer > 0) return;
      this.started = true;
      host.setPhase('live');
      host.services.actors?.setCombatEnabled?.(true);
      host.director.enabled = true;
      host.director.beginWave(1, -1, 0.35);
      host.banner('FIGHT', '', 'wave', 1.6);
      host.log.record(host.tick, 'tdmStart', 0, 0);
      this.fillSquad(host, true);
      return;
    }

    /* --- match clock --- */
    this.clock -= dt;
    if (this.clock <= 0) {
      host.finish(this.teamScore >= this.enemyScore);
      return;
    }

    /* --- squad respawns --- */
    for (const s of this.squad) {
      if (s.id >= 0) continue;
      s.respawnIn -= dt;
      if (s.respawnIn <= 0) this.spawnSquaddie(host, s);
    }
    if (this.squad.length < SQUAD_SIZE) this.fillSquad(host, false);

    /* --- escalate slightly as the match matures so it does not go stale --- */
    const progress = 1 - this.clock / TIME_LIMIT;
    host.director.threat = 0.25 + progress * 0.45;

    /* --- close-game announcer --- */
    const lead = this.teamScore - this.enemyScore;
    if (this.teamScore >= SCORE_LIMIT - 5 && this.announcedLead !== 1) {
      this.announcedLead = 1;
      host.emit('hud:announce', { key: 'tdm-close', text: 'MATCH POINT', priority: 5 });
    } else if (this.enemyScore >= SCORE_LIMIT - 5 && this.announcedLead !== -1) {
      this.announcedLead = -1;
      host.emit('hud:announce', { key: 'tdm-losing', text: 'LOSING', priority: 5 });
    }
    void lead;
  }

  /* --------------------------------------------------------------- squad -- */

  private fillSquad(host: MatchHost, immediate: boolean): void {
    while (this.squad.length < SQUAD_SIZE) {
      const s: Squaddie = {
        id: -1,
        respawnIn: immediate ? 0 : host.rng.range(1, BOT_RESPAWN),
        archetype: host.rng.pick(['rifleman', 'rifleman', 'smg', 'lmg'] as Archetype[]),
      };
      this.squad.push(s);
      if (immediate) this.spawnSquaddie(host, s);
    }
  }

  private spawnSquaddie(host: MatchHost, s: Squaddie): void {
    const yaw = this.pickTeamSpawn(host, this._p, 'friendly');
    const id = host.director.spawnScripted(s.archetype, this._p, yaw, 'friendly', 'squad');
    s.id = id;
    s.respawnIn = BOT_RESPAWN;
    if (id >= 0) host.log.record(host.tick, 'squadSpawn', id, 0);
  }

  /**
   * Shared anti-spawn-trap selection. Threats and allies swap roles depending
   * on which team is spawning, and the node cooldown keeps a whole team from
   * funnelling out of one pad.
   */
  private pickTeamSpawn(host: MatchHost, out: THREE.Vector3, team: 'friendly' | 'hostile'): number {
    const q = this.query;
    const player = host.playerPosition();
    this.poolCursor = 0;

    const enemyCount = host.director.enemyPositions(this.threats);
    this.threats.length = enemyCount;
    this.allies.length = 0;
    for (const s of this.squad) {
      if (s.id < 0) continue;
      const v = this.borrow();
      if (host.combat.enemyPosition(s.id, v)) this.allies.push(v);
    }
    if (player) this.allies.push(this.borrow().copy(player));

    if (team === 'friendly') {
      q.viewOrigin.copy(player ?? out.set(0, 1.6, 0));
      q.threats = this.threats;
      q.allies = this.allies;
      q.idealDistance = 22;
      q.minDistance = 8;
      q.maxDistance = 70;
      q.requireHidden = false;
    } else {
      q.viewOrigin.copy(player ?? out.set(0, 1.6, 0));
      q.threats = this.allies;
      q.allies = this.threats;
      q.idealDistance = 48;
      q.minDistance = 28;
      q.maxDistance = 100;
      q.requireHidden = true;
    }
    q.viewDir.set(0, 0, -1);
    q.viewCos = 2; // never treat the cone as a constraint for team spawns
    q.now = host.matchTime;
    q.team = 'any';
    q.cooldown = 11;

    const node = host.director.graph.pick(q, host.services.physics, host.rng);
    if (!node) { out.set(0, 0, 0); return 0; }
    host.director.graph.markUsed(node, host.matchTime);
    out.copy(node.position);
    out.y = host.groundAt(out.x, out.z, out.y);
    return node.yaw;
  }

  /* -------------------------------------------------------------- events -- */

  override onPlayerKill(host: MatchHost, ctx: KillContext, _victimId: number): void {
    void ctx;
    void host;
  }

  override onEntityDeath(host: MatchHost, id: number, byPlayer: boolean): void {
    const mate = this.squad.find((s) => s.id === id);
    if (mate) {
      mate.id = -1;
      mate.respawnIn = BOT_RESPAWN;
      this.enemyScore++;
      host.log.record(host.tick, 'squadDown', id, this.enemyScore);
    } else {
      this.teamScore++;
      if (!byPlayer) host.scoring.addScore(25, 'Team Kill Assist');
      host.log.record(host.tick, 'hostileDown', id, this.teamScore);
    }
    this.checkWin(host);
  }

  override onPlayerDeath(host: MatchHost): void {
    this.enemyScore++;
    host.log.record(host.tick, 'playerDown', 0, this.enemyScore);
    this.checkWin(host);
  }

  private checkWin(host: MatchHost): void {
    if (this.teamScore >= SCORE_LIMIT) host.finish(true);
    else if (this.enemyScore >= SCORE_LIMIT) host.finish(false);
  }

  override decorate(s: DirectorSnapshot): void {
    s.teamScore = this.teamScore;
    s.enemyScore = this.enemyScore;
    s.scoreLimit = SCORE_LIMIT;
    s.timeRemaining = Math.max(0, this.clock);
    s.waveLabel = this.waveLabel;
    s.enemiesRemaining = 0;
  }

  override end(host: MatchHost, win: boolean): void {
    host.director.enabled = false;
    void win;
  }
}
