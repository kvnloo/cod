/**
 * FIREFIGHT — a short scripted push through the level.
 *
 * This is the campaign-flavoured mode: a chain of authored beats, each with its
 * own waypoint, objective marker, hand-placed enemy set and radio line. Enemy
 * placements are *scripted* — positions are derived deterministically from the
 * beat's anchor node rather than requested from the pacing director — so the
 * encounter plays the same way every run, which is what makes a set piece a set
 * piece.
 *
 * The beat chain is generated from the level's own spawn graph at match start,
 * so it works on any map without hand-authored coordinates.
 */

import * as THREE from 'three';
import {
  DefuseObjective, EliminateObjective, ExtractObjective, HoldZoneObjective,
  ReachObjective, type Objective,
} from '../Objectives';
import { GameMode, type MatchHost } from './Mode';
import type { Archetype, DirectorSnapshot } from '../types';
import type { KillContext } from '../Scoring';

type BeatKind = 'advance' | 'clear' | 'hold' | 'defuse' | 'exfil';

interface BeatSpec {
  kind: BeatKind;
  label: string;
  hint: string;
  /** Radio line played when the beat opens. */
  voice: string;
  /** Enemies placed around the beat anchor when it opens. */
  placements: Array<{ archetype: Archetype; range: number; angle: number }>;
}

/** The script. Ranges/angles are relative to each beat's anchor node. */
const SCRIPT: readonly BeatSpec[] = [
  {
    kind: 'advance', label: 'PUSH TO THE COURTYARD',
    hint: 'Move up on the marker', voice: 'Move up, stay on me.',
    placements: [
      { archetype: 'rifleman', range: 13, angle: 0.4 },
      { archetype: 'rifleman', range: 15, angle: -0.6 },
    ],
  },
  {
    kind: 'clear', label: 'CLEAR THE COURTYARD',
    hint: 'Neutralise all contacts', voice: 'Contact front! Multiple hostiles!',
    placements: [
      { archetype: 'rifleman', range: 12, angle: 0.0 },
      { archetype: 'smg', range: 9, angle: 1.3 },
      { archetype: 'smg', range: 10, angle: -1.2 },
      { archetype: 'shotgun', range: 7, angle: 2.6 },
      { archetype: 'sniper', range: 34, angle: 0.25 },
    ],
  },
  {
    kind: 'hold', label: 'HOLD THE INTERSECTION',
    hint: 'Deny the crossing until the convoy passes', voice: 'Hold this position — convoy is thirty seconds out.',
    placements: [
      { archetype: 'rifleman', range: 22, angle: 0.9 },
      { archetype: 'rifleman', range: 24, angle: -0.9 },
      { archetype: 'lmg', range: 27, angle: 0.1 },
      { archetype: 'smg', range: 16, angle: 2.2 },
    ],
  },
  {
    kind: 'defuse', label: 'DEFUSE THE CHARGE',
    hint: 'The bridge is wired — cut it', voice: 'They rigged the span! Get on that charge!',
    placements: [
      { archetype: 'shotgun', range: 8, angle: 1.9 },
      { archetype: 'rifleman', range: 18, angle: -0.3 },
      { archetype: 'rifleman', range: 20, angle: 0.7 },
      { archetype: 'sniper', range: 40, angle: -0.5 },
    ],
  },
  {
    kind: 'exfil', label: 'EXFIL',
    hint: 'Reach the LZ and hold for pickup', voice: 'Bird is inbound. Get to the LZ!',
    placements: [
      { archetype: 'juggernaut', range: 26, angle: 0.2 },
      { archetype: 'lmg', range: 21, angle: 1.4 },
      { archetype: 'smg', range: 15, angle: -1.6 },
      { archetype: 'rifleman', range: 24, angle: 2.9 },
      { archetype: 'rifleman', range: 28, angle: -2.4 },
    ],
  },
];

export class FirefightMode extends GameMode {
  readonly id = 'firefight' as const;
  readonly name = 'Firefight';

  private beat = -1;
  private anchors: THREE.Vector3[] = [];
  private objective: Objective | null = null;
  private beatEnemies: number[] = [];
  private transitionTimer = 0;
  private startTimer = 5;
  private started = false;
  private readonly _p = new THREE.Vector3();
  private killsThisBeat = 0;

  constructor() {
    super();
    this.waveTotal = SCRIPT.length;
    this.timeLimit = -1;
  }

  start(host: MatchHost): void {
    this.beat = -1;
    this.started = false;
    this.startTimer = 5;
    this.objective = null;
    this.beatEnemies.length = 0;
    this.waveLabel = 'INSERTION';

    const d = host.director.config;
    // Scripted placements do the work; the director only trickles pressure so a
    // slow player is not left in silence.
    d.pacing = true;
    d.minPressure = 0.5;
    d.maxPressure = 3;
    d.eliteBias = 0.5;
    d.spawnMin = 26;
    d.spawnIdeal = 46;
    d.spawnMax = 90;
    d.spawnIntervalSlow = 7;
    d.spawnIntervalFast = 3.2;
    d.faction = 'spetsnaz';

    const lc = host.lifecycle.config;
    lc.respawnDelay = 4;
    lc.allowLastStand = true;
    lc.respawnEnabled = true;
    lc.regenDelay = 3.6;
    lc.regenRate = 38;

    this.buildRoute(host);

    host.setPhase('warmup');
    host.banner('FIREFIGHT', 'Task Force Blackout · Grid 41-North', 'objective', 4);
    host.emit('ai:voice', { id: -1, line: 'Blackout Actual, we are feet dry. Moving to the first waypoint.' });
    host.services.actors?.setCombatEnabled?.(false);
  }

  /**
   * Picks a chain of anchors: start near the player, then walk outward taking
   * the furthest node from everything chosen so far. That produces a route that
   * crosses the level instead of doubling back.
   */
  private buildRoute(host: MatchHost): void {
    this.anchors.length = 0;
    const chosen: THREE.Vector3[] = [];
    const start = host.playerPosition();
    if (start) chosen.push(start.clone());

    for (let i = 0; i < SCRIPT.length; i++) {
      const node = host.director.graph.furthestFrom(chosen);
      if (!node) break;
      const p = node.position.clone();
      p.y = host.groundAt(p.x, p.z, p.y);
      this.anchors.push(p);
      chosen.push(p);
    }
    while (this.anchors.length < SCRIPT.length) {
      this.anchors.push(this.anchors[this.anchors.length - 1]?.clone() ?? new THREE.Vector3());
    }
  }

  fixedUpdate(dt: number, host: MatchHost): void {
    if (!this.started) {
      this.startTimer -= dt;
      host.countdown(Math.max(0, this.startTimer), 'MOVE OUT');
      if (this.startTimer <= 0) {
        this.started = true;
        host.setPhase('live');
        host.services.actors?.setCombatEnabled?.(true);
        host.director.enabled = true;
        host.director.beginWave(1, -1, 0.3);
        this.advance(host);
      }
      return;
    }

    if (this.transitionTimer > 0) {
      this.transitionTimer -= dt;
      if (this.transitionTimer <= 0) this.advance(host);
      return;
    }

    const obj = this.objective;
    if (!obj) return;

    // "Clear" beats finish when the scripted set is dead, not on a timer.
    if (obj instanceof EliminateObjective) {
      const alive = this.countBeatEnemies(host);
      if (alive === 0 && obj.state === 'active') obj.notifyKill();
    }

    if (obj.state === 'complete') {
      this.objective = null;
      host.scoring.addScore(300, 'Beat Complete');
      this.transitionTimer = 2.2;
      if (this.beat + 1 >= SCRIPT.length) {
        host.finish(true);
        this.transitionTimer = 0;
      }
    } else if (obj.state === 'failed') {
      this.objective = null;
      host.finish(false);
    }
  }

  private advance(host: MatchHost): void {
    this.beat++;
    if (this.beat >= SCRIPT.length) { host.finish(true); return; }

    const spec = SCRIPT[this.beat];
    const anchor = this.anchors[this.beat] ?? new THREE.Vector3();
    this.wave = this.beat + 1;
    this.waveLabel = spec.label;
    this.killsThisBeat = 0;
    host.log.record(host.tick, 'beat', this.beat, 0);

    /* --- objective --- */
    let obj: Objective;
    switch (spec.kind) {
      case 'advance':
        obj = new ReachObjective(anchor, 5.5, spec.label, spec.hint);
        break;
      case 'clear':
        obj = new EliminateObjective(spec.placements.length, spec.label);
        obj.position = anchor.clone();
        obj.radius = 9;
        break;
      case 'hold':
        obj = new HoldZoneObjective(anchor, 8, 30, spec.label);
        break;
      case 'defuse':
        obj = new DefuseObjective(anchor, 3.4, 90, 8, spec.label);
        obj.critical = true;
        break;
      default:
        obj = new ExtractObjective(anchor, 8.5, 30, spec.label);
        obj.critical = true;
        break;
    }
    obj.hint = spec.hint;
    this.objective = obj;
    host.addObjective(obj);

    /* --- scripted placements --- */
    this.beatEnemies.length = 0;
    const player = host.playerPosition();
    const baseAngle = player
      ? Math.atan2(anchor.x - player.x, anchor.z - player.z)
      : 0;
    for (const p of spec.placements) {
      const a = baseAngle + p.angle;
      this._p.set(
        anchor.x + Math.sin(a) * p.range,
        anchor.y,
        anchor.z + Math.cos(a) * p.range,
      );
      this._p.y = host.groundAt(this._p.x, this._p.z, anchor.y);
      const yaw = Math.atan2(anchor.x - this._p.x, anchor.z - this._p.z);
      const id = host.director.spawnScripted(p.archetype, this._p, yaw, 'hostile', `beat${this.beat}`);
      if (id >= 0) this.beatEnemies.push(id);
    }

    host.emit('ai:voice', { id: -1, line: spec.voice });
    host.banner(spec.label, spec.hint, 'objective', 3.4);
  }

  private countBeatEnemies(host: MatchHost): number {
    const actors = host.services.actors;
    if (!actors) return 0;
    let n = 0;
    for (const id of this.beatEnemies) if (actors.isCombatantAlive(id)) n++;
    return n;
  }

  override onPlayerKill(_host: MatchHost, _ctx: KillContext, victimId: number): void {
    if (this.beatEnemies.includes(victimId)) this.killsThisBeat++;
    const obj = this.objective;
    if (obj instanceof EliminateObjective) obj.notifyKill();
  }

  override onPlayerDeath(host: MatchHost): void {
    host.emit('ai:voice', { id: -1, line: 'Operator down! Get back in the fight!' });
  }

  override onObjectiveFailed(host: MatchHost, objective: Objective): void {
    if (objective.critical) host.finish(false);
  }

  override decorate(s: DirectorSnapshot): void {
    s.wave = Math.max(1, this.beat + 1);
    s.waveTotal = SCRIPT.length;
    s.waveLabel = this.waveLabel;
    s.enemiesRemaining = Math.max(0, this.beatEnemies.length - this.killsThisBeat);
    s.scoreLimit = 0;
  }

  override end(host: MatchHost, win: boolean): void {
    host.director.enabled = false;
    host.emit('ai:voice', {
      id: -1,
      line: win ? 'All stations, Blackout is clear. Good work.' : 'We are overrun. Falling back.',
    });
  }
}
