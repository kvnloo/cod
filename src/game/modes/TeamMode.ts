/**
 * TeamMode — the rules engine every multiplayer mode is built from.
 *
 * This is the generalisation of what `TeamDeathmatch` already did well: a bot
 * roster with per-team respawn queues, an anti-spawn-trap selector that swaps
 * threats and allies depending on who is spawning, and a match clock. Every
 * number it uses comes out of a `ModeDef`, so Domination and Search & Destroy
 * differ by data plus a handful of overridden hooks rather than by a fork of
 * the whole thing.
 *
 * AUTHORITY. The host runs this. A client should construct the same mode with
 * `authority = false`: `fixedUpdate` then only advances presentation timers and
 * lets `applyState()` push the host's truth in. Nothing here mutates shared
 * state on a client, and nothing here imports `src/net`.
 *
 * INTERFACES OWED BY OTHER LAYERS (defined narrowly here, coded against, not
 * blocked on):
 *   • `orders()` — per-bot objective intent. The AI layer should read it each
 *     tick and steer its agents; until it does, an actor backend that only
 *     shoots still produces a finishable match.
 *   • `MatchRunner.reportKill(killer, victim)` — kill attribution. Two-team
 *     modes can infer the scoring side from the victim's team, free-for-all
 *     cannot, so whoever knows the killer should call it.
 */

import * as THREE from 'three';
import { defaultQuery, type SpawnQuery } from '../Spawns';
import { GameMode, type MatchHost } from './Mode';
import { modeDef, otherTeam, type ModeDef, type ModeId } from './ModeDefs';
import type { Archetype, DirectorSnapshot, GameModeId, Team } from '../types';
import type { TeamPresence } from '../Objectives';

/* ------------------------------------------------------------- contracts -- */

export type OrderKind =
  | 'capture' | 'defend' | 'plant' | 'defuse' | 'collect' | 'hunt' | 'roam';

/** One bot's objective intent. Consumed by the AI layer; allocation-stable. */
export interface ModeOrder {
  id: number;
  team: Team;
  kind: OrderKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1; higher wins when an agent is juggling goals. */
  priority: number;
}

export interface RosterEntry {
  id: number;
  team: Team;
  /** Stable 0-based index — the FFA scoreboard row, and the wire slot. */
  slot: number;
  archetype: Archetype;
  alive: boolean;
  respawnIn: number;
  /** Per-operator score; only free-for-all reads it. */
  score: number;
  kills: number;
  deaths: number;
  name: string;
  /** Last known world position, refreshed every live tick. Kill Confirmed
   *  needs it because the body is already gone by the time the death lands. */
  x: number;
  y: number;
  z: number;
}

export type Stage = 'warmup' | 'freeze' | 'live' | 'roundend' | 'done';
export type RoundWinner = Team | 'draw';

export interface RoundRecord {
  index: number;
  winner: RoundWinner;
  /** Why the round ended — shown on the round-report and in tooling. */
  reason: string;
  seconds: number;
  friendlyRounds: number;
  hostileRounds: number;
}

/** Everything a scoreboard, killcam or netcode snapshot needs from the mode. */
export interface ModeState {
  id: ModeId;
  stage: Stage;
  round: number;
  roundsFriendly: number;
  roundsHostile: number;
  scoreFriendly: number;
  scoreHostile: number;
  scoreLimit: number;
  clock: number;
  overtime: boolean;
  sidesSwapped: boolean;
  /** Which side the player's team is attacking on, for bomb modes. */
  playerAttacking: boolean;
}

const BOT_NAMES = [
  'HAWK', 'VIPER', 'ECHO', 'RAVEN', 'GHOST', 'NOMAD', 'SABLE', 'ORION',
  'WRAITH', 'TALON', 'CIPHER', 'ATLAS', 'RONIN', 'JACKAL', 'VECTOR', 'ONYX',
];

const BOT_LOADOUTS: readonly Archetype[] = ['rifleman', 'rifleman', 'smg', 'lmg'];

export abstract class TeamMode extends GameMode {
  readonly def: ModeDef;
  /** False on a client: the state machine becomes display-only. */
  authority = true;

  protected host!: MatchHost;
  protected stage: Stage = 'warmup';
  protected stageTimer = 0;
  /** Seconds left on the round (or match) clock. */
  protected clock = 0;
  protected round = 1;
  protected roundsFriendly = 0;
  protected roundsHostile = 0;
  protected overtime = false;
  protected sidesSwapped = false;
  protected readonly history: RoundRecord[] = [];
  /** Set once the match is over; read by tooling. */
  endReason = '';

  protected roster: RosterEntry[] = [];
  private byId = new Map<number, RosterEntry>();
  private waveTimer = 0;
  private orderList: ModeOrder[] = [];
  private slotSeq = 0;

  /* scratch */
  private query: SpawnQuery = defaultQuery();
  private threats: THREE.Vector3[] = [];
  private allies: THREE.Vector3[] = [];
  private pool: THREE.Vector3[] = [];
  private poolCursor = 0;
  protected readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Vector3();
  protected sites: THREE.Vector3[] = [];
  protected homes: Record<Team, THREE.Vector3> = {
    friendly: new THREE.Vector3(),
    hostile: new THREE.Vector3(),
  };

  constructor(id: ModeId) {
    super();
    this.def = modeDef(id);
    this.scoreLimit = this.def.scoreLimit;
    this.timeLimit = this.def.timeLimit;
    this.waveTotal = this.def.rounds.enabled ? this.def.rounds.maxRounds : 0;
  }

  /** See the note on `GameMode.id`: the honest id is `modeId`. */
  get id(): GameModeId { return this.def.id as GameModeId; }
  get modeId(): ModeId { return this.def.id; }
  get name(): string { return this.def.name; }

  /* ================================================================ boot == */

  start(host: MatchHost): void {
    this.host = host;
    this.roster.length = 0;
    this.byId.clear();
    this.history.length = 0;
    this.slotSeq = 0;
    this.teamScore = 0;
    this.enemyScore = 0;
    this.round = 1;
    this.roundsFriendly = 0;
    this.roundsHostile = 0;
    this.overtime = false;
    this.sidesSwapped = false;
    this.endReason = '';
    this.wave = 1;
    this.waveLabel = this.def.name.toUpperCase();

    this.configureDirector(host);
    this.configureLifecycle(host);
    this.installPresence(host);
    this.layoutSites(host);
    this.buildObjectives(host);

    this.stage = 'warmup';
    this.stageTimer = this.def.warmup;
    this.clock = this.roundLength();

    host.setPhase('warmup');
    host.banner(this.def.name.toUpperCase(), this.def.blurb, 'objective', 3.6);
    host.countdown(this.def.warmup, 'MATCH START');
    host.services.actors?.setCombatEnabled?.(false);
    host.log.record(host.tick, 'modeStart', this.def.scoreLimit, this.def.rounds.maxRounds);
  }

  protected configureDirector(host: MatchHost): void {
    const d = host.director.config;
    const size = this.def.teams.teamSize;
    d.pacing = false;
    d.flat = 0.72;
    // Bodies are the mode's business; the director only backfills to keep the
    // enemy team at strength when the actor backend loses somebody.
    d.minPressure = size - 1;
    d.maxPressure = size + 1;
    d.eliteBias = this.def.eliteBias;
    d.spawnMin = 24;
    d.spawnIdeal = this.def.spawn.idealDistance;
    d.spawnMax = this.def.spawn.maxDistance;
    d.spawnIntervalSlow = 2.4;
    d.spawnIntervalFast = 1.2;
    d.faction = 'pmc';
    // The roster owns the population in every multiplayer mode, so the pacing
    // director never spawns on its own here. It is still stepped (it prunes the
    // live census and answers `enemyPositions`) — it just does not reinforce.
    host.director.enabled = false;
  }

  protected configureLifecycle(host: MatchHost): void {
    const r = this.def.respawn;
    const lc = host.lifecycle.config;
    lc.respawnDelay = r.delay;
    lc.allowLastStand = false;
    lc.respawnEnabled = r.enabled;
    lc.regenDelay = r.regenDelay;
    lc.regenRate = r.regenRate;
  }

  /** Gives every team objective the team-occupancy probe it needs. */
  private installPresence(host: MatchHost): void {
    host.setPresenceProbe((c, radius, out) => this.presence(c, radius, out));
  }

  /**
   * Places `objective.count` sites on the spawn graph, greedily taking the
   * nodes that are furthest apart. Deterministic: the graph is seeded and the
   * traversal is index-ordered.
   */
  protected layoutSites(host: MatchHost): void {
    this.sites.length = 0;
    const want = this.def.objective.count;
    const nodes = host.director.graph.nodes;
    if (want > 0 && nodes.length > 0) {
      const spread = this.def.objective.siteSpread;
      // Seed with the node furthest from the centroid so the set is anchored.
      const centre = new THREE.Vector3();
      for (const n of nodes) centre.add(n.position);
      centre.multiplyScalar(1 / nodes.length);
      let seed = nodes[0];
      let seedD = -1;
      for (const n of nodes) {
        const d = n.position.distanceToSquared(centre);
        if (d > seedD) { seedD = d; seed = n; }
      }
      this.sites.push(seed.position.clone());
      for (let pass = 0; pass < 2 && this.sites.length < want; pass++) {
        const min = spread * (pass === 0 ? 1 : 0.45);
        for (const n of nodes) {
          if (this.sites.length >= want) break;
          let ok = true;
          for (const s of this.sites) {
            if (s.distanceTo(n.position) < min) { ok = false; break; }
          }
          if (ok) this.sites.push(n.position.clone());
        }
      }
    }
    // A ring fallback keeps every mode playable on a world with no graph.
    let ring = 0;
    while (this.sites.length < want) {
      const a = (ring / Math.max(1, want)) * Math.PI * 2;
      this.sites.push(new THREE.Vector3(Math.cos(a) * 28, 0, Math.sin(a) * 28));
      ring++;
    }
    for (const s of this.sites) s.y = host.groundAt(s.x, s.z, s.y);

    this.pickHomes(host);
  }

  /** The two most distant spawn nodes become the team start pads. */
  protected pickHomes(host: MatchHost): void {
    const nodes = host.director.graph.nodes;
    if (nodes.length < 2) {
      this.homes.friendly.set(-24, 0, 0);
      this.homes.hostile.set(24, 0, 0);
    } else {
      let a = nodes[0].position, b = nodes[1].position, best = -1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const d = nodes[i].position.distanceToSquared(nodes[j].position);
          if (d > best) { best = d; a = nodes[i].position; b = nodes[j].position; }
        }
      }
      this.homes.friendly.copy(a);
      this.homes.hostile.copy(b);
    }
    this.homes.friendly.y = host.groundAt(this.homes.friendly.x, this.homes.friendly.z, this.homes.friendly.y);
    this.homes.hostile.y = host.groundAt(this.homes.hostile.x, this.homes.hostile.z, this.homes.hostile.y);
  }

  /** Subclass hook: push the mode's objective entities onto the host. */
  protected buildObjectives(_host: MatchHost): void { }

  /* ============================================================== update == */

  fixedUpdate(dt: number, host: MatchHost): void {
    this.host = host;
    if (!this.authority) { this.decorateClock(dt); return; }

    switch (this.stage) {
      case 'warmup': this.tickWarmup(dt, host); break;
      case 'freeze': this.tickFreeze(dt, host); break;
      case 'live': this.tickLive(dt, host); break;
      case 'roundend': this.tickRoundEnd(dt, host); break;
      case 'done': break;
    }
  }

  private decorateClock(dt: number): void { this.clock = Math.max(0, this.clock - dt); }

  private tickWarmup(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    host.countdown(Math.max(0, this.stageTimer), 'MATCH START');
    if (this.stageTimer > 0) return;
    this.beginRound(host, 1);
  }

  private tickFreeze(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    host.countdown(Math.max(0, this.stageTimer), this.def.rounds.enabled ? `ROUND ${this.round}` : 'FIGHT');
    this.tickRespawns(dt, host);
    if (this.stageTimer > 0) return;
    this.stage = 'live';
    host.setPhase('live');
    host.services.actors?.setCombatEnabled?.(true);
    host.banner('FIGHT', this.def.rounds.enabled ? `Round ${this.round}` : '', 'wave', 1.6);
    this.onRoundLive(host);
  }

  private tickLive(dt: number, host: MatchHost): void {
    this.clock -= dt;
    this.tickRespawns(dt, host);
    this.backfill(host);
    this.buildOrders(host);
    this.onLive(dt, host);

    const verdict = this.evaluate(host);
    if (verdict) { this.resolveRound(host, verdict.winner, verdict.reason); return; }

    if (this.clock <= 0) {
      const timeout = this.onTimeExpired(host);
      // null means the mode extended the clock — a live bomb fuse suspends the
      // round timer rather than ending the round on it.
      if (timeout) this.resolveRound(host, timeout.winner, timeout.reason);
    }
  }

  private tickRoundEnd(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    if (this.stageTimer > 0) return;
    this.nextRound(host);
  }

  /* ---------------------------------------------------------- round flow -- */

  /** False for modes with no clock at all — nothing ships like that today. */
  protected get timed(): boolean {
    return this.def.rounds.enabled || this.def.timeLimit > 0;
  }

  protected roundLength(): number {
    return this.def.rounds.enabled ? this.def.rounds.roundTime
      : this.def.timeLimit > 0 ? this.def.timeLimit : Number.MAX_SAFE_INTEGER;
  }

  protected beginRound(host: MatchHost, index: number): void {
    this.round = index;
    this.wave = index;
    this.clock = this.roundLength();
    this.stage = 'freeze';
    this.stageTimer = this.def.rounds.enabled ? this.def.rounds.freezeTime : 0.01;

    host.setPhase('live');
    host.director.beginWave(index, 0, 0.35);
    host.director.threat = 0.3;
    host.services.actors?.setCombatEnabled?.(false);

    // Round-based modes wipe and re-seed both teams; score modes only top up.
    if (this.def.rounds.enabled || index === 1) this.resetRoster(host);
    this.respawnPlayer(host, true);
    this.onRoundStart(host);
    host.log.record(host.tick, 'roundStart', index, this.sidesSwapped ? 1 : 0);
  }

  /** Ends the current round and either advances or finishes the match. */
  protected resolveRound(host: MatchHost, winner: RoundWinner, reason: string): void {
    if (this.stage === 'roundend' || this.stage === 'done') return;
    const elapsed = Math.max(0, this.roundLength() - Math.max(0, this.clock));

    if (this.def.rounds.enabled) {
      if (winner === 'friendly') this.roundsFriendly++;
      else if (winner === 'hostile') this.roundsHostile++;
      this.teamScore = this.roundsFriendly;
      this.enemyScore = this.roundsHostile;
    }
    this.history.push({
      index: this.round, winner, reason, seconds: elapsed,
      friendlyRounds: this.roundsFriendly, hostileRounds: this.roundsHostile,
    });
    host.log.record(host.tick, 'roundEnd', this.round, winner === 'friendly' ? 1 : winner === 'hostile' ? 2 : 0);
    this.onRoundEnd(host, winner, reason);

    const done = this.matchVerdict(winner, reason);
    if (done) {
      this.stage = 'done';
      this.endReason = done.reason;
      host.banner(
        done.win ? 'VICTORY' : done.draw ? 'DRAW' : 'DEFEAT',
        done.reason, 'result', 5,
      );
      host.finish(done.win);
      return;
    }

    // A score mode that survived `matchVerdict` is level on the clock and has
    // just been granted sudden death — go straight there, no intermission.
    if (!this.def.rounds.enabled) { this.enterOvertime(host); return; }

    this.stage = 'roundend';
    this.stageTimer = this.def.rounds.intermission;
    host.setPhase('intermission');
    host.services.actors?.setCombatEnabled?.(false);
    host.banner(
      winner === 'friendly' ? 'ROUND WON' : winner === 'hostile' ? 'ROUND LOST' : 'ROUND DRAWN',
      `${this.roundsFriendly} — ${this.roundsHostile}   ${reason}`, 'result', 4,
    );
  }

  private nextRound(host: MatchHost): void {
    const r = this.def.rounds;
    const played = this.roundsFriendly + this.roundsHostile;
    if (r.enabled && this.def.teams.swapSidesAtHalf && r.halftimeAfter > 0 && played === r.halftimeAfter) {
      this.swapSides(host, 'HALFTIME');
    }
    this.beginRound(host, this.round + 1);
  }

  /**
   * Halftime. The teams keep their scores and trade roles — in a bomb mode that
   * is attack/defence, in a flag mode it is which end of the map you spawn on.
   */
  protected swapSides(host: MatchHost, title: string): void {
    this.sidesSwapped = !this.sidesSwapped;
    const h = this.homes.friendly.clone();
    this.homes.friendly.copy(this.homes.hostile);
    this.homes.hostile.copy(h);
    host.banner(title, this.def.teams.swapSidesAtHalf ? 'Sides switched' : '', 'alert', 4);
    host.log.record(host.tick, 'swapSides', this.round, this.sidesSwapped ? 1 : 0);
    this.onSidesSwapped(host);
  }

  /** True when the player's team is the attacking side this round. */
  get playerAttacking(): boolean { return !this.sidesSwapped; }
  protected get attackers(): Team { return this.sidesSwapped ? 'hostile' : 'friendly'; }
  protected get defenders(): Team { return this.sidesSwapped ? 'friendly' : 'hostile'; }

  /**
   * Is the match over? Returns null to play on.
   * Score modes end on the limit or the clock; round modes on the round tally,
   * with overtime rounds granted when the tally is level at `maxRounds`.
   */
  protected matchVerdict(
    _winner: RoundWinner, _reason: string,
  ): { win: boolean; draw: boolean; reason: string } | null {
    const r = this.def.rounds;
    if (this.def.win === 'rounds') {
      if (this.roundsFriendly >= r.roundsToWin) {
        return { win: true, draw: false, reason: `Won ${this.roundsFriendly}–${this.roundsHostile} on rounds` };
      }
      if (this.roundsHostile >= r.roundsToWin) {
        return { win: false, draw: false, reason: `Lost ${this.roundsFriendly}–${this.roundsHostile} on rounds` };
      }
      const played = this.roundsFriendly + this.roundsHostile;
      const cap = r.maxRounds + (this.overtime ? r.overtimeRounds : 0);
      if (played >= r.maxRounds && this.roundsFriendly === this.roundsHostile
        && !this.overtime && r.overtimeRounds > 0) {
        this.overtime = true;
        return null;
      }
      if (played >= cap) {
        const win = this.roundsFriendly > this.roundsHostile;
        const draw = this.roundsFriendly === this.roundsHostile;
        return {
          win, draw,
          reason: draw ? `Drawn ${this.roundsFriendly}–${this.roundsHostile} at the round cap`
            : `${win ? 'Won' : 'Lost'} ${this.roundsFriendly}–${this.roundsHostile} at the round cap`,
        };
      }
      return null;
    }

    // Score modes run exactly one "round"; reaching here means it ended.
    if (this.teamScore >= this.scoreLimit) {
      return { win: true, draw: false, reason: `Reached the score limit ${this.teamScore}–${this.enemyScore}` };
    }
    if (this.enemyScore >= this.scoreLimit) {
      return { win: false, draw: false, reason: `Enemy reached the score limit ${this.teamScore}–${this.enemyScore}` };
    }
    if (this.teamScore === this.enemyScore && this.def.overtime.enabled && !this.overtime) {
      this.overtime = true;
      return null;
    }
    const win = this.teamScore > this.enemyScore;
    const draw = this.teamScore === this.enemyScore;
    const how = this.overtime ? 'Overtime' : 'Time expired';
    return {
      win, draw,
      reason: draw ? `${how} level at ${this.teamScore}`
        : `${how} ${this.teamScore}–${this.enemyScore}`,
    };
  }

  /** Score modes: the "next round" is sudden-death overtime. */
  private startOvertime(host: MatchHost): void {
    this.overtime = true;
    this.clock = this.def.overtime.seconds > 0 ? this.def.overtime.seconds : 60;
    this.stage = 'live';
    host.setPhase('live');
    host.director.enabled = true;
    host.services.actors?.setCombatEnabled?.(true);
    host.banner('OVERTIME', 'Next score wins', 'alert', 4);
    host.log.record(host.tick, 'overtime', this.round, 0);
  }

  /* ------------------------------------------------------------- verdicts -- */

  /**
   * Called every live tick. Return a winner to end the round immediately.
   * The base implementation handles score limits and, for score modes without
   * rounds, sudden-death overtime.
   */
  protected evaluate(host: MatchHost): { winner: RoundWinner; reason: string } | null {
    void host;
    if (this.def.win === 'score') {
      if (this.overtime) {
        // Sudden death: any lead ends it.
        if (this.teamScore !== this.enemyScore) {
          return {
            winner: this.teamScore > this.enemyScore ? 'friendly' : 'hostile',
            reason: `Overtime decided it ${this.teamScore}–${this.enemyScore}`,
          };
        }
        return null;
      }
      if (this.teamScore >= this.scoreLimit) return { winner: 'friendly', reason: 'Score limit' };
      if (this.enemyScore >= this.scoreLimit) return { winner: 'hostile', reason: 'Score limit' };
    }
    return null;
  }

  /**
   * Round clock hit zero. Round modes usually award it to the defenders.
   * Return null to keep playing after extending `this.clock` yourself.
   */
  protected onTimeExpired(_host: MatchHost): { winner: RoundWinner; reason: string } | null {
    if (this.def.win === 'score') {
      const w: RoundWinner = this.teamScore === this.enemyScore ? 'draw'
        : this.teamScore > this.enemyScore ? 'friendly' : 'hostile';
      return { winner: w, reason: 'Time expired' };
    }
    return { winner: this.defenders, reason: 'Time expired' };
  }

  /* ------------------------------------------------------------- subclass -- */

  protected onRoundStart(_host: MatchHost): void { }
  protected onRoundLive(_host: MatchHost): void { }
  protected onRoundEnd(_host: MatchHost, _w: RoundWinner, _reason: string): void { }
  protected onSidesSwapped(_host: MatchHost): void { }
  protected onLive(_dt: number, _host: MatchHost): void { }

  /* ================================================================ bots == */

  protected teamSizeFor(team: Team): number {
    const s = this.def.teams.teamSize;
    if (this.def.teams.teams === 1) return team === 'hostile' ? s - 1 : 0;
    return team === 'friendly' ? s - 1 : s;   // the player fills a friendly slot
  }

  protected resetRoster(host: MatchHost): void {
    for (const e of this.roster) {
      if (e.id >= 0) host.services.actors?.despawnCombatant(e.id);
    }
    this.roster.length = 0;
    this.byId.clear();
    this.slotSeq = 0;
    const teamsToFill: Team[] = this.def.teams.teams === 1 ? ['hostile'] : ['friendly', 'hostile'];
    for (const team of teamsToFill) {
      const n = this.teamSizeFor(team);
      for (let i = 0; i < n; i++) this.addBot(host, team);
    }
    this.waveTimer = this.def.respawn.wave;
  }

  private addBot(host: MatchHost, team: Team): RosterEntry {
    const slot = this.slotSeq++;
    const e: RosterEntry = {
      id: -1, team, slot,
      archetype: host.rng.pick(BOT_LOADOUTS as Archetype[]),
      alive: false, respawnIn: 0, score: 0, kills: 0, deaths: 0, x: 0, y: 0, z: 0,
      name: BOT_NAMES[slot % BOT_NAMES.length] + (slot >= BOT_NAMES.length ? String(1 + (slot / BOT_NAMES.length | 0)) : ''),
    };
    this.roster.push(e);
    this.spawnBot(host, e);
    return e;
  }

  protected spawnBot(host: MatchHost, e: RosterEntry): void {
    const yaw = this.pickSpawnFor(host, e.team, this._p);
    const id = host.director.spawnScripted(e.archetype, this._p, yaw, e.team, `mode:${this.def.id}`);
    if (e.id >= 0) this.byId.delete(e.id);
    e.id = id;
    e.alive = id >= 0;
    e.respawnIn = 0;
    if (id >= 0) {
      this.byId.set(id, e);
      host.log.record(host.tick, e.team === 'friendly' ? 'squadSpawn' : 'enemySpawn', id, e.slot);
    }
  }

  /** Individual or wave respawns, whichever the definition asks for. */
  private tickRespawns(dt: number, host: MatchHost): void {
    const r = this.def.respawn;
    if (!r.enabled) return;
    if (r.wave > 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        this.waveTimer = r.wave;
        for (const e of this.roster) if (!e.alive) this.spawnBot(host, e);
      }
      return;
    }
    for (const e of this.roster) {
      if (e.alive) continue;
      e.respawnIn -= dt;
      if (e.respawnIn <= 0) this.spawnBot(host, e);
    }
  }

  /**
   * Refreshes every live body's cached position and re-queues any bot whose
   * entity vanished without a death event ever reaching us.
   */
  private backfill(host: MatchHost): void {
    const actors = host.services.actors;
    if (!actors) return;
    for (const e of this.roster) {
      if (!e.alive || e.id < 0) continue;
      if (host.combat.enemyPosition(e.id, this._q)) {
        e.x = this._q.x; e.y = this._q.y; e.z = this._q.z;
      }
      if (!actors.isCombatantAlive(e.id)) {
        e.alive = false;
        e.respawnIn = this.def.respawn.botDelay;
        this.byId.delete(e.id);
        e.id = -1;
      }
    }
  }

  protected entryFor(id: number): RosterEntry | undefined { return this.byId.get(id); }

  protected aliveCount(team: Team): number {
    let n = 0;
    for (const e of this.roster) if (e.alive && e.team === team) n++;
    if (team === 'friendly' && this.playerAlive()) n++;
    return n;
  }

  protected playerAlive(): boolean {
    const p = this.host?.services.player;
    return !!p && p.alive;
  }

  /* --------------------------------------------------------------- spawns -- */

  private borrow(): THREE.Vector3 {
    if (this.poolCursor >= this.pool.length) this.pool.push(new THREE.Vector3());
    return this.pool[this.poolCursor++];
  }

  /** Live positions of a team, into the given array. Player counts as friendly. */
  private gather(host: MatchHost, team: Team, out: THREE.Vector3[]): void {
    out.length = 0;
    for (const e of this.roster) {
      if (!e.alive || e.id < 0 || e.team !== team) continue;
      const v = this.borrow();
      if (host.combat.enemyPosition(e.id, v)) out.push(v);
    }
    if (team === 'friendly') {
      const p = host.playerPosition();
      if (p && this.playerAlive()) out.push(this.borrow().copy(p));
    }
  }

  /**
   * The one spawn selector, parameterised by `SpawnRules`. Threats and allies
   * swap roles depending on who is spawning, so neither team can camp the
   * other's pads, and each policy moves the reference point:
   *   contested → the enemy centroid, spawn away from it
   *   objective → the nearest friendly-held site
   *   home/fixed → the team's start pad
   *   scatter  → maximum separation from every live body
   */
  pickSpawnFor(host: MatchHost, team: Team, out: THREE.Vector3): number {
    const rules = this.def.spawn;
    const q = this.query;
    this.poolCursor = 0;
    this.gather(host, otherTeam(team), this.threats);
    this.gather(host, team, this.allies);

    if (this.def.teams.teams === 1) {
      // Free-for-all: everybody is a threat, nobody is an ally.
      this.gather(host, 'hostile', this.threats);
      const p = host.playerPosition();
      if (p && this.playerAlive()) this.threats.push(this.borrow().copy(p));
      this.allies.length = 0;
    }

    if (rules.kind === 'scatter') {
      const node = host.director.graph.furthestFrom(this.threats);
      if (node) {
        host.director.graph.markUsed(node, host.matchTime);
        out.copy(node.position);
        out.y = host.groundAt(out.x, out.z, out.y) + 0.05;
        return node.yaw;
      }
    }

    const anchor = this.spawnAnchor(host, team, rules.kind);
    q.viewOrigin.copy(anchor);
    q.viewDir.set(0, 0, -1);
    q.viewCos = 2;                      // never constrain team spawns by a cone
    q.idealDistance = rules.kind === 'fixed' || rules.kind === 'home' ? 6 : rules.idealDistance;
    q.minDistance = rules.minDistance;
    q.maxDistance = rules.maxDistance;
    q.threats = this.threats;
    q.allies = this.allies;
    q.requireHidden = rules.requireHidden;
    q.now = host.matchTime;
    q.team = 'any';
    q.cooldown = rules.cooldown;

    const node = host.director.graph.pick(q, host.services.physics, host.rng);
    if (!node) {
      out.copy(anchor);
      out.y = host.groundAt(out.x, out.z, out.y) + 0.05;
      return 0;
    }
    host.director.graph.markUsed(node, host.matchTime);
    out.copy(node.position);
    out.y = host.groundAt(out.x, out.z, out.y) + 0.05;
    return node.yaw;
  }

  /** Where the distance band is measured from, per policy. */
  protected spawnAnchor(host: MatchHost, team: Team, kind: string): THREE.Vector3 {
    if (kind === 'fixed' || kind === 'home') return this.homes[team];
    if (kind === 'objective') {
      const held = this.ownedSite(team);
      if (held) return held;
      return this.homes[team];
    }
    // contested: the enemy centroid, so the band pushes us away from them.
    const list = this.threats;
    if (list.length === 0) return this.homes[team];
    this._q.set(0, 0, 0);
    for (const v of list) this._q.add(v);
    return this._q.multiplyScalar(1 / list.length);
  }

  /** Subclass hook: a site this team currently owns, for objective spawning. */
  protected ownedSite(_team: Team): THREE.Vector3 | null { return null; }

  /** The player respawns under exactly the same rules as their bots. */
  override pickPlayerSpawn(host: MatchHost, out: THREE.Vector3): number | null {
    if (!this.authority) return null;
    return this.pickSpawnFor(host, 'friendly', out);
  }

  protected respawnPlayer(host: MatchHost, force: boolean): void {
    const player = host.services.player;
    if (!player) return;
    if (!force && player.alive) return;
    const yaw = this.pickSpawnFor(host, 'friendly', this._p);
    host.lifecycle.reset();
    host.lifecycle.newLife();
    player.spawnAt(this._p, yaw);
  }

  /* ----------------------------------------------------------- occupancy -- */

  /** The probe every team objective reads. Player counts on `friendly`. */
  presence(center: THREE.Vector3, radius: number, out: TeamPresence): void {
    out.friendly = 0;
    out.hostile = 0;
    const host = this.host;
    if (!host) return;
    const r2 = radius * radius;
    for (const e of this.roster) {
      if (!e.alive || e.id < 0) continue;
      if (!host.combat.enemyPosition(e.id, this._q)) continue;
      const dx = this._q.x - center.x;
      const dz = this._q.z - center.z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(this._q.y - center.y) > 6) continue;
      if (e.team === 'friendly') out.friendly++; else out.hostile++;
    }
    const p = host.playerPosition();
    if (p && this.playerAlive()) {
      const dx = p.x - center.x;
      const dz = p.z - center.z;
      if (dx * dx + dz * dz <= r2 && Math.abs(p.y - center.y) <= 6) out.friendly++;
    }
  }

  /* -------------------------------------------------------------- orders -- */

  /** Per-bot objective intent for the AI layer. Rebuilt in place each tick. */
  orders(): readonly ModeOrder[] { return this.orderList; }

  private buildOrders(host: MatchHost): void {
    this.orderList.length = 0;
    for (const e of this.roster) {
      if (!e.alive || e.id < 0) continue;
      const o = this.orderFor(host, e);
      if (o) this.orderList.push(o);
    }
  }

  /** Subclass hook. Returning null means "no objective intent, go fight". */
  protected orderFor(_host: MatchHost, _e: RosterEntry): ModeOrder | null { return null; }

  protected order(e: RosterEntry, kind: OrderKind, p: THREE.Vector3, radius: number, priority: number): ModeOrder {
    return { id: e.id, team: e.team, kind, x: p.x, y: p.y, z: p.z, radius, priority };
  }

  /* -------------------------------------------------------------- events -- */

  override onEntityDeath(host: MatchHost, id: number, byPlayer: boolean): void {
    const e = this.byId.get(id);
    if (e) {
      e.alive = false;
      e.deaths++;
      e.respawnIn = this.def.respawn.botDelay;
      this.byId.delete(id);
      e.id = -1;
      this.onOperatorDown(host, e.team, byPlayer, e, id);
    } else {
      // A body the director owns rather than the roster (killstreak spawn,
      // backfill). Treat it as a hostile loss so the score still moves.
      this.onOperatorDown(host, 'hostile', byPlayer, null, id);
    }
  }

  override onPlayerDeath(host: MatchHost): void {
    const id = host.services.player?.entityId ?? -1;
    this.onOperatorDown(host, 'friendly', false, null, id);
  }

  /**
   * True when the mode swallowed the player's final death (round-based modes
   * play on with the player spectating). `MatchRunner` ends the match when this
   * returns false.
   */
  override onFinalDeath(_host: MatchHost): boolean {
    return this.def.rounds.enabled && this.stage !== 'done';
  }

  /**
   * Kill attribution from a layer that knows the killer. Two-team modes do not
   * need it; free-for-all does.
   */
  override onKillAttributed(host: MatchHost, killerId: number, victimId: number): void {
    void host; void killerId; void victimId;
  }

  /**
   * One operator died. `team` is the side that *lost* the body; `victimId` is
   * the entity id it had, which is how a mode correlates a kill report with a
   * death.
   */
  protected onOperatorDown(
    _host: MatchHost, _team: Team, _byPlayer: boolean, _e: RosterEntry | null, _victimId: number,
  ): void { }

  /* ------------------------------------------------------------ scoring -- */

  protected addTeamScore(host: MatchHost, team: Team, amount: number): void {
    if (amount === 0) return;
    if (team === 'friendly') this.teamScore += amount; else this.enemyScore += amount;
    host.log.record(host.tick, team === 'friendly' ? 'scoreUs' : 'scoreThem', amount,
      team === 'friendly' ? this.teamScore : this.enemyScore);
    if (this.def.win === 'score' && !this.overtime) {
      const half = this.scoreLimit * 0.5;
      if (this.def.teams.swapSidesAtHalf && !this.sidesSwapped
        && (this.teamScore >= half || this.enemyScore >= half)) {
        this.swapSides(host, 'HALFTIME');
      }
    }
  }

  /* ------------------------------------------------------------ snapshot -- */

  /** Everything a scoreboard / netcode snapshot needs. Allocation-free. */
  private _state: ModeState = {
    id: 'tdm', stage: 'warmup', round: 1, roundsFriendly: 0, roundsHostile: 0,
    scoreFriendly: 0, scoreHostile: 0, scoreLimit: 0, clock: 0,
    overtime: false, sidesSwapped: false, playerAttacking: true,
  };

  state(): ModeState {
    const s = this._state;
    s.id = this.def.id;
    s.stage = this.stage;
    s.round = this.round;
    s.roundsFriendly = this.roundsFriendly;
    s.roundsHostile = this.roundsHostile;
    s.scoreFriendly = this.teamScore;
    s.scoreHostile = this.enemyScore;
    s.scoreLimit = this.scoreLimit;
    s.clock = Math.max(0, this.clock);
    s.overtime = this.overtime;
    s.sidesSwapped = this.sidesSwapped;
    s.playerAttacking = this.playerAttacking;
    return s;
  }

  /** Client-side application of the host's mode state. */
  applyState(s: ModeState): void {
    this.stage = s.stage;
    this.round = s.round;
    this.roundsFriendly = s.roundsFriendly;
    this.roundsHostile = s.roundsHostile;
    this.teamScore = s.scoreFriendly;
    this.enemyScore = s.scoreHostile;
    this.clock = s.clock;
    this.overtime = s.overtime;
    this.sidesSwapped = s.sidesSwapped;
  }

  rounds(): readonly RoundRecord[] { return this.history; }

  override decorate(s: DirectorSnapshot): void {
    s.teamScore = this.teamScore;
    s.enemyScore = this.enemyScore;
    s.scoreLimit = this.scoreLimit;
    s.timeRemaining = this.timed ? Math.max(0, this.clock) : -1;
    s.wave = this.round;
    s.waveTotal = this.def.rounds.enabled ? this.def.rounds.maxRounds : 0;
    s.waveLabel = this.overtime ? `${this.def.short} · OVERTIME`
      : this.def.rounds.enabled ? `${this.def.short} · ROUND ${this.round}`
        : this.def.name.toUpperCase();
    s.enemiesRemaining = 0;
    s.enemiesAlive = this.aliveCount('hostile');
  }

  override end(host: MatchHost, win: boolean): void {
    this.stage = 'done';
    host.director.enabled = false;
    if (!this.endReason) {
      this.endReason = win ? `Won ${this.teamScore}–${this.enemyScore}` : `Lost ${this.teamScore}–${this.enemyScore}`;
    }
  }

  /** Score modes drop into sudden death instead of finishing on a level clock. */
  protected enterOvertime(host: MatchHost): void { this.startOvertime(host); }
}
