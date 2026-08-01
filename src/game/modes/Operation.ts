/**
 * OPERATION — wave survival crossed with objectives.
 *
 * The loop is: a wave of escalating composition spawns and must be cleared;
 * every third wave layers a timed objective on top of the fighting; between
 * waves a short buy phase lets the player convert cash into staying power. Three
 * lives, twelve waves, and a final extraction that has to be held.
 *
 * The mode itself is a script — the pressure curve, the spawn hiding and the
 * archetype escalation all come from the shared director.
 */

import * as THREE from 'three';
import { input } from '../../core/Input';
import { ARCHETYPES } from '../Archetypes';
import { KILLSTREAK_DEFS } from '../Killstreaks';
import {
  DefuseObjective, EliminateObjective, ExtractObjective, HoldZoneObjective,
  PlantObjective, type Objective,
} from '../Objectives';
import { GameMode, type MatchHost, type ModeOffer } from './Mode';
import type { DirectorSnapshot, KillstreakId } from '../types';
import type { KillContext } from '../Scoring';

const TOTAL_WAVES = 12;
const WARMUP = 8;
const INTERMISSION = 6;
const LIVES = 3;

type Stage = 'warmup' | 'wave' | 'cleared' | 'intermission' | 'extract' | 'over';

export class OperationMode extends GameMode {
  readonly id = 'operation' as const;
  readonly name = 'Operation';

  livesLeft = LIVES;
  private stage: Stage = 'warmup';
  private stageTimer = WARMUP;
  private waveKills = 0;
  private waveTarget = 0;
  private waveObjective: Objective | null = null;
  private offers: ModeOffer[] = [];
  private announcedLow = false;
  private readonly _p = new THREE.Vector3();

  constructor() {
    super();
    this.waveTotal = TOTAL_WAVES;
    this.timeLimit = -1;
  }

  start(host: MatchHost): void {
    this.livesLeft = LIVES;
    this.stage = 'warmup';
    this.stageTimer = WARMUP;
    this.wave = 0;

    const d = host.director.config;
    d.minPressure = 2.5;
    d.maxPressure = 8;
    d.eliteBias = 1;
    d.spawnMin = 20;
    d.spawnIdeal = 34;
    d.spawnMax = 74;
    d.spawnIntervalSlow = 3.2;
    d.spawnIntervalFast = 0.5;
    d.pacing = true;
    d.faction = 'militia';

    const lc = host.lifecycle.config;
    lc.respawnDelay = 3.5;
    lc.allowLastStand = true;
    lc.respawnEnabled = true;
    lc.regenDelay = 4.6;
    lc.regenRate = 30;

    host.setPhase('warmup');
    host.banner('OPERATION BLACKOUT', 'Hostiles inbound — prepare positions', 'objective', 4);
    host.countdown(WARMUP, 'FIRST WAVE');
    host.services.actors?.setCombatEnabled?.(false);
  }

  fixedUpdate(dt: number, host: MatchHost): void {
    switch (this.stage) {
      case 'warmup': this.stepWarmup(dt, host); break;
      case 'wave': this.stepWave(dt, host); break;
      case 'cleared': this.stepCleared(dt, host); break;
      case 'intermission': this.stepIntermission(dt, host); break;
      case 'extract': this.stepExtract(dt, host); break;
      case 'over': break;
    }
  }

  /* ---------------------------------------------------------------- warmup */

  private stepWarmup(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    host.countdown(Math.max(0, this.stageTimer), 'FIRST WAVE');
    if (this.stageTimer <= 0) this.beginWave(host, 1);
  }

  /* ------------------------------------------------------------------ wave */

  private beginWave(host: MatchHost, index: number): void {
    this.wave = index;
    this.waveKills = 0;
    this.waveTarget = waveSize(index);
    this.waveLabel = waveName(index);
    this.stage = 'wave';
    host.setPhase('live');
    host.services.actors?.setCombatEnabled?.(true);

    const threat = Math.min(1, (index - 1) / (TOTAL_WAVES - 2));
    host.director.enabled = true;
    host.director.beginWave(index, this.waveTarget, threat);
    host.log.record(host.tick, 'wave', index, this.waveTarget);

    host.emit('wave:start', {
      index, total: TOTAL_WAVES, label: this.waveLabel, enemies: this.waveTarget,
    });
    host.banner(`WAVE ${index}`, this.waveLabel, 'wave', 3.2);

    /* every third wave carries an objective */
    if (index % 3 === 0) this.spawnWaveObjective(host, index);
    else this.waveObjective = null;
  }

  private spawnWaveObjective(host: MatchHost, index: number): void {
    const player = host.playerPosition();
    const anchor = this._p.copy(player ?? new THREE.Vector3());
    const node = host.director.graph.furthestFrom(player ? [player] : []);
    const site = node ? node.position.clone() : anchor.clone();
    site.y = host.groundAt(site.x, site.z, site.y);

    let obj: Objective;
    switch (Math.floor(index / 3) % 3) {
      case 1:
        obj = new HoldZoneObjective(site, 7.5, 30, 'SECURE THE UPLINK');
        break;
      case 2:
        obj = new PlantObjective(site, 3.2, 6, 'PLANT THE BREACHING CHARGE');
        break;
      default:
        obj = new DefuseObjective(site, 3.2, 75, 8, 'DEFUSE THE IED');
        obj.critical = true;
        break;
    }
    this.waveObjective = obj;
    host.addObjective(obj);
  }

  private stepWave(dt: number, host: MatchHost): void {
    const director = host.director;
    const remaining = director.remaining + director.aliveCount;
    const objectiveDone = !this.waveObjective || this.waveObjective.done;

    if (remaining <= 0 && objectiveDone) {
      this.stage = 'cleared';
      this.stageTimer = 0.9;
      director.enabled = false;
      const bonus = 250 + this.wave * 120;
      host.scoring.addScore(bonus, `Wave ${this.wave} Cleared`);
      host.addCash(180 + this.wave * 55, 'Wave bonus');
      host.emit('wave:cleared', { index: this.wave, bonus, nextIn: INTERMISSION });
      host.log.record(host.tick, 'waveClear', this.wave, host.scoring.state.score);
      host.banner(`WAVE ${this.wave} CLEARED`, this.wave >= TOTAL_WAVES ? 'Prepare for exfil' : 'Resupply', 'reward', 3);
    }
    void dt;
  }

  private stepCleared(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    // Skip the post-clear beat once it has registered (~0.4 s).
    if (this.stageTimer < 0.5 && input.held('jump')) this.stageTimer = 0;
    if (this.stageTimer > 0) return;
    if (this.wave >= TOTAL_WAVES) { this.beginExtract(host); return; }
    this.beginIntermission(host);
  }

  /* ---------------------------------------------------------- intermission */

  private beginIntermission(host: MatchHost): void {
    this.stage = 'intermission';
    this.stageTimer = INTERMISSION;
    host.setPhase('intermission');
    host.services.actors?.setCombatEnabled?.(false);
    this.offers = this.rollOffers(host);
    host.setOffers(this.offers);
    host.banner('RESUPPLY', 'Press [1][2][3] to buy · hold SPACE to skip', 'objective', 2.8);
  }

  private stepIntermission(dt: number, host: MatchHost): void {
    this.stageTimer -= dt;
    // Space (jump) after 0.5 s skips the buy stretch — longest *forced* non-combat
    // is cleared(0.9)+0.5 ≈ 1.4 s; full intermission is 6 s and skippable (cat F).
    if (this.stageTimer < INTERMISSION - 0.5 && input.held('jump')) {
      this.stageTimer = 0;
    }
    host.countdown(Math.max(0, this.stageTimer), `WAVE ${this.wave + 1}`);
    // Refresh affordability so the HUD greys out what the player cannot buy.
    for (const o of this.offers) o.affordable = host.cash >= o.cost;
    if (this.stageTimer <= 0) this.beginWave(host, this.wave + 1);
  }

  override onBuy(host: MatchHost, slot: number): void {
    if (this.stage !== 'intermission') return;
    const offer = this.offers[slot];
    if (!offer || offer.cost > host.cash) {
      host.emit('hud:announce', { key: 'buy-fail', text: 'INSUFFICIENT FUNDS', priority: 1 });
      return;
    }
    host.spendCash(offer.cost);
    offer.apply(host);
    this.offers.splice(slot, 1);
    host.setOffers(this.offers);
    host.log.record(host.tick, 'buy', slot, offer.cost);
    // Buying ends the stretch once the rack is empty — no dead wait.
    if (this.offers.length === 0) this.stageTimer = Math.min(this.stageTimer, 1.2);
  }

  /** Three deterministic offers drawn from a weighted catalogue. */
  private rollOffers(host: MatchHost): ModeOffer[] {
    const pool: ModeOffer[] = [
      {
        id: 'armor', name: 'Plate Carrier', detail: 'Restore full health', cost: 400,
        kind: 'armor', affordable: false,
        apply: (h) => {
          const p = h.services.player;
          if (p?.heal) p.heal(p.maxHealth);
          h.banner('ARMOUR REPLACED', '', 'reward', 1.8);
        },
      },
      {
        id: 'ammo', name: 'Ammo Resupply', detail: 'Refill reserve ammunition', cost: 250,
        kind: 'ammo', affordable: false,
        apply: (h) => {
          h.emit('weapon:resupply', undefined);
          h.banner('AMMO RESTOCKED', 'Magazines and reserves refilled', 'reward', 1.8);
        },
      },
      {
        id: 'ks_uav', name: KILLSTREAK_DEFS.uav.name, detail: KILLSTREAK_DEFS.uav.description, cost: 700,
        kind: 'killstreak', affordable: false,
        apply: (h) => h.killstreaks.grant('uav'),
      },
      {
        id: 'ks_sentry', name: KILLSTREAK_DEFS.sentry.name, detail: KILLSTREAK_DEFS.sentry.description, cost: 1500,
        kind: 'killstreak', affordable: false,
        apply: (h) => h.killstreaks.grant('sentry'),
      },
      {
        id: 'ks_airstrike', name: KILLSTREAK_DEFS.airstrike.name, detail: KILLSTREAK_DEFS.airstrike.description, cost: 1800,
        kind: 'killstreak', affordable: false,
        apply: (h) => h.killstreaks.grant('airstrike'),
      },
      {
        id: 'ks_carepackage', name: KILLSTREAK_DEFS.carepackage.name, detail: KILLSTREAK_DEFS.carepackage.description, cost: 900,
        kind: 'killstreak', affordable: false,
        apply: (h) => h.killstreaks.grant('carepackage'),
      },
      {
        id: 'atc_reflex', name: 'Reflex Sight', detail: 'Faster target acquisition', cost: 800,
        kind: 'attachment', affordable: false,
        apply: (h) => {
          h.emit('weapon:attach', { attachmentId: 'optic_reddot' });
          h.banner('REFLEX SIGHT FITTED', 'Optic mounted — ADS handling updated', 'reward', 1.8);
        },
      },
      {
        id: 'atc_extmag', name: 'Extended Magazine', detail: '+50% magazine capacity', cost: 950,
        kind: 'attachment', affordable: false,
        apply: (h) => {
          h.emit('weapon:attach', { attachmentId: 'mag_extended' });
          h.banner('EXTENDED MAGAZINE FITTED', 'Capacity +50%', 'reward', 1.8);
        },
      },
    ];

    // Always offer armour and ammo, then two random upgrades — a familiar and
    // readable shape for a between-round shop.
    const staples = pool.slice(0, 2);
    const rest = host.rng.shuffle(pool.slice(2));
    const offers = [...staples, ...rest.slice(0, 2)];
    for (const o of offers) o.affordable = host.cash >= o.cost;
    return offers;
  }

  /* --------------------------------------------------------------- extract */

  private beginExtract(host: MatchHost): void {
    this.stage = 'extract';
    host.setPhase('live');
    host.services.actors?.setCombatEnabled?.(true);
    this.waveLabel = 'EXFILTRATION';

    const player = host.playerPosition();
    const node = host.director.graph.furthestFrom(player ? [player] : []);
    const zone = node ? node.position.clone() : new THREE.Vector3();
    zone.y = host.groundAt(zone.x, zone.z, zone.y);

    const obj = new ExtractObjective(zone, 8.5, 35, 'REACH THE LZ');
    obj.critical = true;
    this.waveObjective = obj;
    host.addObjective(obj);

    // Endless pressure during exfil — this is the finale.
    host.director.enabled = true;
    host.director.beginWave(TOTAL_WAVES + 1, -1, 1);
    host.director.config.maxPressure = 11;
    host.banner('EXFIL INBOUND', 'Reach the landing zone and hold', 'alert', 4);
  }

  private stepExtract(_dt: number, host: MatchHost): void {
    if (!this.waveObjective) return;
    if (this.waveObjective.state === 'complete') {
      this.stage = 'over';
      host.finish(true);
    } else if (this.waveObjective.state === 'failed') {
      this.stage = 'over';
      host.finish(false);
    }
  }

  /* ---------------------------------------------------------------- events */

  override onPlayerKill(host: MatchHost, ctx: KillContext, _victimId: number): void {
    this.waveKills++;
    const prof = ARCHETYPES[ctx.archetype as keyof typeof ARCHETYPES];
    host.addCash(prof ? prof.cash : 60, 'Kill');
  }

  override onPlayerDeath(host: MatchHost): void {
    this.livesLeft--;
    host.log.record(host.tick, 'death', this.livesLeft, 0);
    if (this.livesLeft <= 0) {
      this.stage = 'over';
      host.lifecycle.config.respawnEnabled = false;
      host.finish(false);
    } else {
      host.banner('OPERATOR DOWN', `${this.livesLeft} ${this.livesLeft === 1 ? 'life' : 'lives'} remaining`, 'alert', 3);
    }
  }

  override onObjectiveFailed(host: MatchHost, objective: Objective): void {
    if (objective.critical) {
      this.stage = 'over';
      host.finish(false);
    }
  }

  override onObjectiveComplete(host: MatchHost, objective: Objective): void {
    host.addCash(450, 'Objective');
    void objective;
  }

  override decorate(s: DirectorSnapshot): void {
    s.wave = this.wave;
    s.waveTotal = TOTAL_WAVES;
    s.waveLabel = this.stage === 'extract' ? 'EXFILTRATION' : this.waveLabel;
    s.enemiesRemaining = Math.max(0, this.waveTarget - this.waveKills);
    s.scoreLimit = 0;
    s.teamScore = this.livesLeft;
  }

  /** Announce once when the operator is in real trouble. */
  noteLowHealth(host: MatchHost, frac: number): void {
    if (frac < 0.25 && !this.announcedLow) {
      this.announcedLow = true;
      host.emit('hud:announce', { key: 'low', text: 'CRITICAL', priority: 4 });
    } else if (frac > 0.6) this.announcedLow = false;
  }

  override end(host: MatchHost, win: boolean): void {
    host.director.enabled = false;
    void win;
  }
}

/** Wave sizes ramp fast early, then flatten so late waves are about quality. */
function waveSize(index: number): number {
  return Math.round(5 + index * 2.6 + Math.pow(index, 1.35) * 0.8);
}

function waveName(index: number): string {
  const names = [
    'PROBING ATTACK', 'SECOND ELEMENT', 'ASSAULT ELEMENT', 'BREACHERS',
    'MARKSMAN SUPPORT', 'HEAVY WEAPONS', 'COMBINED ARMS', 'SHOCK TROOPS',
    'ELITE CADRE', 'ARMOURED PUSH', 'FINAL ASSAULT', 'LAST STAND',
  ];
  return names[Math.min(names.length - 1, index - 1)];
}
