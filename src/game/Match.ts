/**
 * MatchRunner — the match state machine and the hub every other piece plugs
 * into.
 *
 *   idle → warmup → live ⇄ intermission → ending → ended
 *
 * It owns the director, scoring, killstreaks, lifecycle, objectives and the
 * replay log, implements `MatchHost` for modes and `CombatBridge` for
 * killstreaks, and publishes one mutable snapshot per frame for the HUD.
 *
 * Crucially it takes *no* engine dependency: everything comes in through
 * `GameServices`, which is what lets the deterministic self-test drive a full
 * round with mock services and assert every transition.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import { Director } from './Director';
import { Killstreaks } from './Killstreaks';
import { Lifecycle } from './Lifecycle';
import { MatchLog, REPLAY_VERSION, saveReplay } from './Replay';
import { Progression, XP, rankName } from './Progression';
import { Scoring, type KillContext } from './Scoring';
import { defaultQuery, type SpawnQuery } from './Spawns';
import { ARCHETYPES } from './Archetypes';
import type { CombatBridge } from './Combat';
import type { Emitter, GameServices } from './Services';
import type { Objective, ObjectiveWorld } from './Objectives';
import { GameMode, type MatchHost, type ModeOffer } from './modes/Mode';
import { OperationMode } from './modes/Operation';
import { TeamDeathmatchMode } from './modes/TeamDeathmatch';
import { FirefightMode } from './modes/Firefight';
import { MASK_MOVE } from '../physics/types';
import { makeRayHit } from './Services';
import type {
  BannerView, DirectorSnapshot, GameModeId, KillstreakId, MatchPhase, MatchSummary,
  ObjectiveView, UnlockDef,
} from './types';

export type MatchCommand =
  | 'activateKillstreak' | 'cycleKillstreak' | 'confirmMark' | 'cancelMark'
  | 'buy1' | 'buy2' | 'buy3' | 'restart';

/** Damage the player must have dealt to a victim to earn an assist. */
const ASSIST_THRESHOLD = 25;

export class MatchRunner implements MatchHost, CombatBridge {
  readonly director: Director;
  readonly scoring: Scoring;
  readonly killstreaks: Killstreaks;
  readonly lifecycle: Lifecycle;
  readonly progression: Progression;
  readonly log = new MatchLog();
  readonly combat: CombatBridge = this;

  mode: GameMode = new OperationMode();
  phase: MatchPhase = 'idle';
  phaseTime = 0;
  matchTime = 0;
  tick = 0;
  seed = 1337;
  cash = 0;
  summary: MatchSummary | null = null;

  rng: Rand;
  readonly emit: Emitter;

  private objectiveList: Objective[] = [];
  private activeBanner: BannerView | null = null;
  private offers: ModeOffer[] = [];
  private paused = false;
  private interacting = false;
  private creditSource = 'player';
  private playerDamage = new Map<number, number>();
  private ownsFallback = false;
  private wins = false;
  private endTimer = 0;
  private matchStartedAt = 0;
  private lastStreakId: KillstreakId | null = null;
  private lastStreakNeeded = -1;

  private snap: DirectorSnapshot = blankSnapshot();
  private objectiveViews: ObjectiveView[] = [];
  private unsubs: Array<() => void> = [];
  private query: SpawnQuery = defaultQuery();
  private threatBuf: THREE.Vector3[] = [];
  private ray = makeRayHit();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Vector3();
  private readonly _down = new THREE.Vector3(0, -1, 0);
  private readonly _up = new THREE.Vector3(0, 1, 0);

  private objectiveWorld: ObjectiveWorld;

  constructor(public services: GameServices, ownsFallback = false) {
    this.rng = services.rng;
    this.emit = services.emit;
    this.ownsFallback = ownsFallback;
    this.progression = new Progression(this.emit);
    this.scoring = new Scoring(this.emit, this.progression);
    this.director = new Director(services, this.rng);
    this.killstreaks = new Killstreaks(services, this, this.rng);
    this.lifecycle = new Lifecycle(services, this.emit);

    this.objectiveWorld = {
      emit: this.emit,
      playerPosition: null,
      playerAlive: false,
      playerInteracting: false,
      hostilesWithin: (c, r) => this.countWithin(c, r),
      addMarker: (o) => { this.services.scene?.add(o); },
      now: 0,
    };

    this.lifecycle.pickSpawn = (out) => this.pickPlayerSpawn(out);
    this.lifecycle.onFinalDeath = () => this.finish(false);
  }

  /** Marks that this runner created the fallback combat sim. */
  setOwnsFallback(v: boolean): void { this.ownsFallback = v; }

  /* ------------------------------------------------------------ lifecycle -- */

  attachBus(on: <K extends keyof import('../core/EventBus').GameEvents>(
    key: K, fn: (p: import('../core/EventBus').GameEvents[K]) => void) => () => void): void {
    this.unsubs.push(on('entity:death', (e) => this.onEntityDeath(e.id, e.name, e.byPlayer, e.headshot, e.point)));
    this.unsubs.push(on('damage:dealt', (e) => this.onDamageDealt(e.targetId, e.amount, e.fromPlayer)));
    this.unsubs.push(on('damage:taken', () => this.lifecycle.notifyDamaged()));
    this.unsubs.push(on('weapon:fire', () => this.scoring.registerShot()));
  }

  detachBus(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /** Boots a match. The seed makes the whole round reproducible. */
  start(modeId: GameModeId, seed?: number): void {
    this.seed = seed ?? this.seed;
    this.rng = new Rand(this.seed);
    this.services.rng = this.rng;
    this.director.setRng(this.rng);
    this.killstreaks.setRng(this.rng);

    this.mode = makeMode(modeId);
    this.phase = 'idle';
    this.phaseTime = 0;
    this.matchTime = 0;
    this.tick = 0;
    this.cash = 500;
    this.summary = null;
    this.wins = false;
    this.endTimer = 0;
    this.paused = false;
    this.activeBanner = null;
    this.offers = [];
    this.playerDamage.clear();
    this.lastStreakId = null;
    this.lastStreakNeeded = -1;

    this.log.reset();
    this.log.record(0, 'seed', this.seed, REPLAY_VERSION);
    this.log.record(0, 'mode', modeIndex(modeId), 0);

    this.progression.load();
    this.progression.beginMatch(modeId);
    this.scoring.reset();
    this.killstreaks.reset();
    this.lifecycle.reset();
    this.director.reset();
    this.director.buildGraph();
    this.clearObjectives();

    this.services.setTimeScale(1);
    this.emit('game:start', { mode: modeId });
    this.mode.start(this);
    this.matchStartedAt = 0;
    this.publishSnapshot();
  }

  setPhase(phase: MatchPhase): void {
    if (phase === this.phase) return;
    const previous = this.phase;
    this.phase = phase;
    this.phaseTime = 0;
    this.log.record(this.tick, 'phase', phaseIndex(phase), phaseIndex(previous));
    this.emit('match:state', {
      mode: this.mode.id, phase, previous, time: this.matchTime,
    });
  }

  /* --------------------------------------------------------------- update -- */

  fixedUpdate(dt: number): void {
    if (this.paused || this.phase === 'idle') return;
    this.tick++;
    this.phaseTime += dt;
    if (this.phase === 'live') this.matchTime += dt;

    /* objective world view refresh */
    const player = this.services.player;
    this.objectiveWorld.playerPosition = player ? player.position : null;
    this.objectiveWorld.playerAlive = player ? player.alive : false;
    this.objectiveWorld.playerInteracting = this.interacting;
    this.objectiveWorld.now = this.matchTime;

    this.scoring.fixedUpdate(dt);
    this.lifecycle.fixedUpdate(dt);
    this.director.fixedUpdate(dt);
    this.killstreaks.fixedUpdate(dt, player ? player.position : null, this.interacting);

    for (let i = this.objectiveList.length - 1; i >= 0; i--) {
      const o = this.objectiveList[i];
      const before = o.state;
      o.step(dt, this.objectiveWorld);
      if (before === 'active' && o.state !== 'active') this.onObjectiveResolved(o);
      if (o.done && this.matchTime - (o as unknown as { _resolvedAt?: number })._resolvedAt! > 4) {
        o.dispose();
        this.objectiveList.splice(i, 1);
      }
    }

    if (this.phase === 'ending') {
      this.endTimer -= dt;
      if (this.endTimer <= 0) this.setPhase('ended');
    } else if (this.phase !== 'ended') {
      this.mode.fixedUpdate(dt, this);
    }

    if (this.activeBanner) {
      this.activeBanner.ttl -= dt;
      if (this.activeBanner.ttl <= 0) this.activeBanner = null;
    }

    /* killstreak progress readout — only when it actually moves */
    const next = this.killstreaks.nextReward(this.scoring.streakPool);
    if (next.id !== this.lastStreakId || next.needed !== this.lastStreakNeeded) {
      this.lastStreakId = next.id;
      this.lastStreakNeeded = next.needed;
      this.scoring.publishStreakProgress(next.id, next.needed);
    }
  }

  /** Presentation-rate work: marking trace and the HUD snapshot. */
  update(_dt: number): void {
    if (this.killstreaks.marking) this.killstreaks.updateMarking(this.services.camera);
    this.publishSnapshot();
  }

  /* ------------------------------------------------------------- commands -- */

  command(cmd: MatchCommand): void {
    const player = this.services.player;
    switch (cmd) {
      case 'activateKillstreak':
        this.killstreaks.activate(player ? player.position : null, this.playerYaw());
        break;
      case 'cycleKillstreak': this.killstreaks.cycleSelection(); break;
      case 'confirmMark': this.killstreaks.confirmMark(); break;
      case 'cancelMark': this.killstreaks.cancelMark(); break;
      case 'buy1': this.mode.onBuy(this, 0); break;
      case 'buy2': this.mode.onBuy(this, 1); break;
      case 'buy3': this.mode.onBuy(this, 2); break;
      case 'restart': this.start(this.mode.id, this.seed); break;
    }
  }

  setInteracting(v: boolean): void { this.interacting = v; }

  setPaused(v: boolean): void {
    if (this.paused === v) return;
    this.paused = v;
    this.services.setTimeScale(v ? 0 : 1);
    this.emit('game:pause', { paused: v });
  }

  get isPaused(): boolean { return this.paused; }

  private playerYaw(): number {
    const cam = this.services.camera;
    if (!cam) return 0;
    this._p.set(0, 0, -1).applyQuaternion(cam.quaternion);
    return Math.atan2(this._p.x, this._p.z);
  }

  /* --------------------------------------------------------------- events -- */

  private onDamageDealt(targetId: number, amount: number, fromPlayer: boolean): void {
    if (fromPlayer) {
      this.scoring.registerHit();
      if (this.creditSource === 'player') {
        this.playerDamage.set(targetId, (this.playerDamage.get(targetId) ?? 0) + amount);
      }
    }
  }

  private onEntityDeath(
    id: number, name: string, byPlayer: boolean, headshot: boolean, point: THREE.Vector3,
  ): void {
    const player = this.services.player;
    if (name === 'player' || (player && id === player.entityId)) {
      this.handlePlayerDeath();
      return;
    }

    const archetype = this.director.archetypeOf(id);
    const hostile = archetype !== null;
    this.log.record(this.tick, hostile ? 'kill' : 'allyDown', id, byPlayer ? 1 : 0);

    if (hostile && (byPlayer || this.creditSource !== 'player')) {
      const dist = player ? player.position.distanceTo(point) : 0;
      const profile = ARCHETYPES[archetype];
      const ctx: KillContext = {
        headshot,
        distance: dist,
        source: this.creditSource,
        archetype,
        score: profile.score,
      };
      this.scoring.playerKill(ctx);
      const granted = this.killstreaks.onStreak(this.scoring.streakPool);
      if (granted.length) this.log.record(this.tick, 'streak', granted.length, this.scoring.streakPool);
      this.mode.onPlayerKill(this, ctx, id);
    } else if (hostile) {
      // Somebody else finished it — an assist if the player softened it up.
      const dealt = this.playerDamage.get(id) ?? 0;
      if (dealt >= ASSIST_THRESHOLD) this.scoring.assist();
    }

    this.playerDamage.delete(id);
    this.mode.onEntityDeath(this, id, byPlayer);
  }

  private handlePlayerDeath(): void {
    const converted = this.lifecycle.onPlayerDeath();
    if (converted) return;
    this.scoring.playerDeath();
    this.killstreaks.onDeath();
    this.emit('player:killed', { by: 'hostile', distance: 0, headshot: false });
    this.mode.onPlayerDeath(this);
  }

  private onObjectiveResolved(o: Objective): void {
    (o as unknown as { _resolvedAt: number })._resolvedAt = this.matchTime;
    if (o.state === 'complete') {
      this.scoring.addScore(o.score, o.label);
      this.progression.award(XP.objectiveComplete, 'Objectives');
      this.log.record(this.tick, 'objDone', o.score, 0);
      this.mode.onObjectiveComplete(this, o);
    } else {
      this.log.record(this.tick, 'objFail', 0, 0);
      this.mode.onObjectiveFailed(this, o);
    }
  }

  /* ---------------------------------------------------------- MatchHost -- */

  addObjective(objective: Objective): void {
    objective.activate(this.objectiveWorld);
    (objective as unknown as { _resolvedAt: number })._resolvedAt = Infinity;
    this.objectiveList.push(objective);
  }

  objectives(): readonly Objective[] { return this.objectiveList; }

  clearObjectives(): void {
    for (const o of this.objectiveList) o.dispose();
    this.objectiveList.length = 0;
  }

  banner(title: string, subtitle: string, kind: BannerView['kind'], ttl = 3): void {
    this.activeBanner = { title, subtitle, kind, ttl };
    this.emit('hud:banner', this.activeBanner);
  }

  countdown(seconds: number, label: string): void {
    this.emit('match:countdown', { seconds, label });
  }

  addCash(amount: number, reason: string): void {
    this.cash += amount;
    this.emit('cash:change', { cash: this.cash, delta: amount, reason });
  }

  spendCash(amount: number): boolean {
    if (this.cash < amount) return false;
    this.cash -= amount;
    this.emit('cash:change', { cash: this.cash, delta: -amount, reason: 'Purchase' });
    return true;
  }

  setOffers(offers: ModeOffer[]): void {
    this.offers = offers;
    this.emit('hud:offers', {
      offers, cash: this.cash, secondsLeft: Math.max(0, this.phaseTime),
    });
  }

  playerPosition(): THREE.Vector3 | null {
    return this.services.player ? this.services.player.position : null;
  }

  /**
   * Player respawn selection: away from live hostiles, out of their line of
   * sight, on a node that has not just been used.
   */
  pickPlayerSpawn(out: THREE.Vector3): number {
    const q = this.query;
    const player = this.services.player;
    q.viewOrigin.copy(player ? player.position : this._p.set(0, 1.6, 0));
    q.viewDir.set(0, 0, -1);
    q.viewCos = 2;               // no cone constraint for player spawns
    q.idealDistance = 34;
    q.minDistance = 20;
    q.maxDistance = 110;
    const n = this.director.enemyPositions(this.threatBuf);
    this.threatBuf.length = n;
    q.threats = this.threatBuf;
    q.allies = EMPTY_VECS;
    q.now = this.matchTime;
    q.team = 'any';
    q.requireHidden = true;
    q.cooldown = 12;

    const node = this.director.graph.pick(q, this.services.physics, this.rng);
    if (!node) {
      out.set(0, this.groundAt(0, 0, 0) + 0.1, 0);
      return 0;
    }
    this.director.graph.markUsed(node, this.matchTime);
    out.copy(node.position);
    out.y = this.groundAt(out.x, out.z, out.y) + 0.05;
    this.log.record(this.tick, 'respawn', node.id, 0);
    return node.yaw;
  }

  /* --------------------------------------------------------- CombatBridge -- */

  damage(
    id: number, amount: number, source: string,
    point?: THREE.Vector3, direction?: THREE.Vector3,
  ): boolean {
    const prev = this.creditSource;
    this.creditSource = source;
    let killed = false;
    const payload = {
      id, amount, headshot: false, fromPlayer: true, source,
      point: point ?? null, direction: direction ?? null,
      applied: false, killed: false,
    };
    this.emit('ai:damage:request', payload);
    if (payload.applied) killed = payload.killed;
    else {
      killed = this.services.actors?.damageCombatant(id, amount, {
        point, direction, fromPlayer: true, source,
      }) ?? false;
    }
    this.creditSource = prev;
    return killed;
  }

  explode(center: THREE.Vector3, radius: number, power: number, source: string): void {
    const prev = this.creditSource;
    this.creditSource = source;
    // One entry point: publish for FX/audio, then apply damage — but only when
    // the actor backend does not already answer the `explosion` event itself.
    this.emit('explosion', { point: center.clone(), radius, power, kind: source });
    if (!this.ownsFallback) {
      const actors = this.services.actors;
      if (actors) {
        for (const e of this.director.live.slice()) {
          if (!actors.combatantPosition(e.id, this._q)) continue;
          this._q.y += 0.9;
          const d = this._q.distanceTo(center);
          if (d > radius) continue;
          const falloff = 1 - d / radius;
          actors.damageCombatant(e.id, power * falloff * falloff, {
            point: this._q, fromPlayer: true, source,
          });
        }
      }
    }
    this.creditSource = prev;
  }

  nearestEnemy(from: THREE.Vector3, maxDist: number, out?: THREE.Vector3): number {
    return this.director.nearestEnemy(from, maxDist, out);
  }

  enemyPosition(id: number, out: THREE.Vector3): boolean {
    return this.services.actors?.combatantPosition(id, out) ?? false;
  }

  enemyPositions(out: THREE.Vector3[]): number {
    return this.director.enemyPositions(out);
  }

  countWithin(center: THREE.Vector3, radius: number): number {
    return this.director.countWithin(center, radius);
  }

  /**
   * Ground height under a point. Probed from just above head height first so a
   * street-level query can never latch onto a rooftop, then from high up as a
   * fallback for elevated ground.
   */
  groundAt(x: number, z: number, fallback: number): number {
    const physics = this.services.physics;
    if (!physics?.ready) return fallback;
    this._p.set(x, fallback + 2.6, z);
    let hit = physics.raycast(this._p, this._down, 9, MASK_MOVE, this.ray);
    if (hit.hit && hit.normal.dot(this._up) > 0.4) return hit.point.y;
    this._p.set(x, fallback + 40, z);
    hit = physics.raycast(this._p, this._down, 90, MASK_MOVE, this.ray);
    if (hit.hit && hit.normal.dot(this._up) > 0.4) return hit.point.y;
    return fallback;
  }

  /* ------------------------------------------------------------- finishing -- */

  finish(win: boolean): void {
    if (this.phase === 'ending' || this.phase === 'ended') return;
    this.wins = win;
    this.setPhase('ending');
    this.endTimer = 4.5;
    this.director.enabled = false;
    this.services.actors?.setCombatEnabled?.(false);
    this.killstreaks.clearDeployed();
    this.mode.end(this, win);
    this.log.record(this.tick, 'finish', win ? 1 : 0, this.scoring.state.score);

    this.summary = this.buildSummary(win);
    this.emit('match:summary', this.summary);
    this.emit('game:over', { win, score: this.scoring.state.score });
    this.banner(win ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED', this.mode.name, 'result', 6);
    saveReplay({
      seed: this.seed, mode: this.mode.id, version: REPLAY_VERSION,
      hash: this.log.hash(), ticks: this.tick,
    });
  }

  private buildSummary(win: boolean): MatchSummary {
    const s = this.scoring.state;
    const objectivesDone = this.objectiveList.filter((o) => o.state === 'complete').length;
    const rankBefore = this.progression.rank;

    const summary: MatchSummary = {
      mode: this.mode.id,
      modeName: this.mode.name,
      win,
      durationSec: this.matchTime - this.matchStartedAt,
      score: s.score,
      kills: s.kills,
      deaths: s.deaths,
      headshots: s.headshots,
      assists: s.assists,
      bestStreak: s.bestStreak,
      wavesCleared: this.mode.wave,
      objectivesComplete: objectivesDone,
      accuracy: this.scoring.accuracy,
      xpEarned: 0,
      rankBefore,
      rankAfter: rankBefore,
      rankName: rankName(rankBefore),
      xpIntoRank: 0,
      xpForNext: 1,
      unlocked: [],
      rows: [],
      seed: this.seed,
      replayHash: this.log.hash(),
    };

    const unlocked: UnlockDef[] = this.progression.commit(win, {
      kills: s.kills, deaths: s.deaths, headshots: s.headshots, assists: s.assists,
      bestStreak: s.bestStreak, wavesCleared: this.mode.wave,
      objectives: objectivesDone, timePlayed: this.matchTime,
      killstreaksUsed: this.killstreaks.killstreaksUsed,
    });
    this.progression.decorateSummary(summary, unlocked);

    summary.rows = [
      { label: 'Score', value: String(s.score) },
      { label: 'Kills', value: String(s.kills) },
      { label: 'Deaths', value: String(s.deaths) },
      { label: 'K/D', value: (s.deaths ? s.kills / s.deaths : s.kills).toFixed(2) },
      { label: 'Headshots', value: String(s.headshots) },
      { label: 'Assists', value: String(s.assists) },
      { label: 'Best Streak', value: String(s.bestStreak) },
      { label: 'Accuracy', value: `${(this.scoring.accuracy * 100).toFixed(0)}%` },
      { label: 'Objectives', value: String(objectivesDone) },
      { label: 'Time', value: formatClock(this.matchTime) },
      ...this.progression.ledgerRows().map((r) => ({ label: r.label, value: `+${r.xp}`, xp: r.xp })),
    ];
    return summary;
  }

  /* -------------------------------------------------------------- snapshot -- */

  /**
   * One mutable snapshot, reused every frame. Consumers must read it, not
   * retain it — that keeps the HUD path allocation-free.
   */
  snapshot(): DirectorSnapshot {
    const s = this.snap;
    const player = this.services.player;
    const st = this.scoring.state;
    const prog = this.progression.progressInRank();

    s.mode = this.mode.id;
    s.modeName = this.mode.name;
    s.phase = this.phase;
    s.phaseTime = this.phaseTime;
    s.matchTime = this.matchTime;
    s.timeRemaining = this.mode.timeLimit > 0 ? Math.max(0, this.mode.timeLimit - this.matchTime) : -1;

    s.wave = this.mode.wave;
    s.waveTotal = this.mode.waveTotal;
    s.waveLabel = this.mode.waveLabel;
    s.enemiesRemaining = Math.max(0, this.director.remaining);
    s.enemiesAlive = this.director.aliveCount;

    s.score = st.score;
    s.teamScore = this.mode.teamScore;
    s.enemyScore = this.mode.enemyScore;
    s.scoreLimit = this.mode.scoreLimit;

    s.kills = st.kills;
    s.deaths = st.deaths;
    s.headshots = st.headshots;
    s.assists = st.assists;
    s.streak = st.streak;
    s.bestStreak = st.bestStreak;
    s.cash = this.cash;
    s.intensity = this.director.intensity;

    s.health = player ? player.health : 0;
    s.maxHealth = player ? player.maxHealth : 100;
    s.downed = this.lifecycle.downed;
    s.downedRemaining = this.lifecycle.downedRemaining;
    s.respawnIn = this.lifecycle.state === 'dead' ? Math.max(0, this.lifecycle.respawnRemaining) : -1;

    s.rank = this.progression.rank;
    s.rankName = rankName(this.progression.rank);
    s.xp = this.progression.xp;
    s.xpIntoRank = prog.into;
    s.xpForNext = prog.needed;

    this.objectiveViews.length = 0;
    for (const o of this.objectiveList) this.objectiveViews.push(o.view());
    s.objectives = this.objectiveViews;
    s.killstreaks = this.killstreaks.views();
    s.banner = this.activeBanner;
    s.contacts = this.killstreaks.contacts;
    s.offers = this.offers;
    s.summary = this.summary;
    s.markingStrike = this.killstreaks.marking;

    this.mode.decorate(s);
    return s;
  }

  private publishSnapshot(): void {
    this.emit('hud:snapshot', this.snapshot());
  }

  dispose(): void {
    this.detachBus();
    this.clearObjectives();
    this.killstreaks.dispose();
    this.director.clear();
  }
}

const EMPTY_VECS: readonly THREE.Vector3[] = [];

function makeMode(id: GameModeId): GameMode {
  switch (id) {
    case 'tdm': return new TeamDeathmatchMode();
    case 'firefight': return new FirefightMode();
    default: return new OperationMode();
  }
}

function modeIndex(id: GameModeId): number {
  return id === 'operation' ? 0 : id === 'tdm' ? 1 : 2;
}

function phaseIndex(p: MatchPhase): number {
  return ['idle', 'warmup', 'live', 'intermission', 'ending', 'ended'].indexOf(p);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function blankSnapshot(): DirectorSnapshot {
  return {
    mode: 'operation', modeName: 'Operation', phase: 'idle', phaseTime: 0,
    matchTime: 0, timeRemaining: -1,
    wave: 0, waveTotal: 0, waveLabel: '', enemiesRemaining: 0, enemiesAlive: 0,
    score: 0, teamScore: 0, enemyScore: 0, scoreLimit: 0,
    kills: 0, deaths: 0, headshots: 0, assists: 0, streak: 0, bestStreak: 0,
    cash: 0, intensity: 0,
    health: 100, maxHealth: 100, downed: false, downedRemaining: 0, respawnIn: -1,
    rank: 1, rankName: 'Recruit', xp: 0, xpIntoRank: 0, xpForNext: 1,
    objectives: [], killstreaks: [], banner: null, contacts: [], offers: [],
    summary: null, markingStrike: false,
  };
}
