/**
 * HudModel — the HUD's read-only view of the game.
 *
 * Everything here is derived from bus events plus the engine context (camera
 * transform, input edges). The HUD never calls into another system: if gameplay
 * is absent, the model simply keeps its defaults and the HUD still renders, which
 * is what makes the `?debug=ui` test bed possible.
 *
 * A weapon system, if one is registered, is read through a structural interface
 * as a *non-authoritative* mirror so the ammo counter stays exact even for state
 * changes that predate the HUD (initial magazine, weapon swaps in flight).
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { bus } from '../core/EventBus';
import { clamp01, damp, Spring, SPRING, Ticker } from './Anim';
import type { UiObjectiveMarker } from './UiEvents';

export type FireMode = 'AUTO' | 'SEMI' | 'BURST' | 'PUMP' | 'BOLT';

export interface WeaponView {
  id: string;
  name: string;
  /** Short class tag driving the killfeed glyph. */
  kind: WeaponKind;
  fireMode: FireMode;
  ammo: number;
  magSize: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  ads: boolean;
  attachment: string;
}

export type WeaponKind =
  | 'ar' | 'smg' | 'lmg' | 'sniper' | 'shotgun' | 'pistol'
  | 'launcher' | 'grenade' | 'knife' | 'turret' | 'explosion';

export interface StreakSlot {
  name: string;
  short: string;
  cost: number;
  progress: number;
  ready: boolean;
  charges: number;
  /** Animation state. */
  flash: number;
}

export interface EquipmentView {
  lethal: number;
  lethalName: string;
  tactical: number;
  tacticalName: string;
  field: number;
  fieldName: string;
  fieldCharge: number;
}

export interface MatchView {
  mode: string;
  label: string;
  timeLeft: number;
  running: boolean;
  scoreFriendly: number;
  scoreHostile: number;
  scoreLimit: number;
}

/** Structural view of whatever weapon system happens to be registered. */
interface WeaponMirror {
  current?: {
    id?: string; name?: string; ammo?: number; magSize?: number;
    reserve?: number; ads?: boolean; reloading?: boolean; rpm?: number;
  };
}

/** Structural view of the player system, for health only. */
interface PlayerMirror {
  health?: number;
  maxHealth?: number;
  alive?: boolean;
}

const FORWARD = new THREE.Vector3();

export class HudModel {
  /* --- vitals ------------------------------------------------------- */
  health = 100;
  maxHealth = 100;
  /** Smoothed bar value so damage drains rather than snaps. */
  readonly healthBar = new Spring(1, SPRING.tight);
  /** Lags behind `healthBar` to leave a "recently lost" ghost. */
  healthGhost = 1;
  regenerating = false;
  alive = true;
  timeSinceDamage = 99;
  armor = 0;
  maxArmor = 0;

  /* --- weapon ------------------------------------------------------- */
  readonly weapon: WeaponView = {
    id: 'ar_vector', name: 'VKR-7', kind: 'ar', fireMode: 'AUTO',
    ammo: 30, magSize: 30, reserve: 210, reloading: false, reloadProgress: 0,
    ads: false, attachment: 'SUPPRESSED',
  };
  readonly ammoTicker = new Ticker(30, 220);
  readonly reserveTicker = new Ticker(210, 400);
  /** 0..1 blend into the aimed-down-sights pose. */
  ads = 0;
  lastFireAt = -99;
  fireRate = 720;

  /* --- equipment / streaks ------------------------------------------ */
  readonly equipment: EquipmentView = {
    lethal: 1, lethalName: 'FRAG',
    tactical: 2, tacticalName: 'FLASH',
    field: 1, fieldName: 'TROPHY', fieldCharge: 1,
  };
  readonly streaks: StreakSlot[] = [
    { name: 'UAV', short: 'UAV', cost: 3, progress: 0, ready: false, charges: 0, flash: 0 },
    { name: 'COUNTER UAV', short: 'CUAV', cost: 5, progress: 0, ready: false, charges: 0, flash: 0 },
    { name: 'CLUSTER STRIKE', short: 'CLST', cost: 7, progress: 0, ready: false, charges: 0, flash: 0 },
  ];


  /* --- objectives / match ------------------------------------------- */
  readonly objectives = new Map<string, UiObjectiveMarker>();
  readonly match: MatchView = {
    mode: 'domination', label: 'SECURE THE UPLINK',
    timeLeft: 420, running: true, scoreFriendly: 0, scoreHostile: 0, scoreLimit: 200,
  };
  score = 0;
  readonly xp = new Ticker(0, 900);
  killStreakCount = 0;

  /* --- player transform --------------------------------------------- */
  readonly position = new THREE.Vector3();
  /** Live camera, for widgets that project world points to the overlay. */
  camera: THREE.PerspectiveCamera | null = null;
  /** Compass bearing in degrees, 0 = north (−Z), increasing clockwise. */
  bearing = 0;
  pitch = 0;
  /** Horizontal speed in m/s, smoothed. */
  speed = 0;
  moveState = 'idle';
  sprinting = false;
  crouched = false;
  airborne = false;

  /* --- reticle ------------------------------------------------------ */
  /** Total crosshair opening 0..1 from movement, fire and stance. */
  readonly spread = new Spring(0.12, { stiffness: 130, damping: 0.85 });
  /** Recoil-only component, decays fast. */
  recoil = 0;

  /* --- flags -------------------------------------------------------- */
  /**
   * When false the model stops mirroring gameplay systems and is driven purely
   * by bus events. Debug scenes disable the gameplay systems and set this false
   * so the HUD can be posed into any state.
   */
  syncMirrors = true;

  scoreboardOpen = false;
  menuOpen = false;
  paused = false;
  gameOver = false;
  gameWin = false;

  private readonly prevPos = new THREE.Vector3();
  private prevPosValid = false;
  private weapons: WeaponMirror | null = null;
  private player: PlayerMirror | null = null;
  private disposers: Array<() => void> = [];
  private reloadStartedAt = -1;
  private reloadDuration = 2.1;
  private elapsed = 0;

  /* ------------------------------------------------------------------ */

  attach(ctx: EngineContext): void {
    const w = ctx.engine.tryGet<System & WeaponMirror>('weapons');
    this.weapons = w ?? null;
    const p = ctx.engine.tryGet<System & PlayerMirror>('player');
    this.player = p ?? null;
    this.subscribe();
    this.syncFromMirrors(true);
  }

  private subscribe(): void {
    const d = this.disposers;

    d.push(bus.on('player:health', (e) => {
      this.health = e.health;
      this.maxHealth = e.max || 100;
      this.regenerating = e.regen;
      if (!e.regen) this.timeSinceDamage = 0;
      this.healthBar.to(clamp01(this.health / this.maxHealth));
    }));

    d.push(bus.on('damage:taken', () => { this.timeSinceDamage = 0; }));

    d.push(bus.on('player:spawn', () => {
      this.alive = true;
      this.health = this.maxHealth;
      this.healthBar.set(1);
      this.healthGhost = 1;
      this.prevPosValid = false;
    }));

    d.push(bus.on('entity:death', (e) => {
      if (e.name === 'player' || e.id === 1) this.alive = false;
    }));

    d.push(bus.on('player:move:state', (e) => {
      this.moveState = e.state;
      this.sprinting = e.state === 'sprint' || e.state === 'sprinting';
      this.crouched = e.state === 'crouch' || e.state === 'crouching' || e.state === 'slide';
      this.airborne = e.state === 'air' || e.state === 'jump' || e.state === 'falling';
    }));

    d.push(bus.on('weapon:fire', () => {
      this.lastFireAt = this.elapsed;
      this.recoil = Math.min(1, this.recoil + 0.34);
      if (!this.weapons) {
        this.weapon.ammo = Math.max(0, this.weapon.ammo - 1);
      }
    }));

    d.push(bus.on('weapon:ads', (e) => { this.weapon.ads = e.active; }));

    d.push(bus.on('weapon:reload:start', () => {
      this.weapon.reloading = true;
      this.reloadStartedAt = this.elapsed;
    }));

    d.push(bus.on('weapon:reload:end', () => {
      this.weapon.reloading = false;
      this.weapon.reloadProgress = 1;
      this.reloadStartedAt = -1;
      if (!this.weapons) {
        const need = this.weapon.magSize - this.weapon.ammo;
        const take = Math.min(need, this.weapon.reserve);
        this.weapon.ammo += take;
        this.weapon.reserve -= take;
      }
    }));

    d.push(bus.on('weapon:switch', (e) => {
      this.weapon.id = e.to;
      this.weapon.reloading = false;
      this.reloadStartedAt = -1;
    }));

    d.push(bus.on('score:add', (e) => {
      this.score += e.amount;
      this.xp.set(this.score);
    }));

    d.push(bus.on('killstreak:earned', (e) => {
      const slot = this.streaks.find((s) => s.name === e.name.toUpperCase());
      if (slot) { slot.ready = true; slot.charges = Math.max(1, slot.charges + 1); slot.progress = 1; slot.flash = 1; }
    }));

    d.push(bus.on('ui:killstreak', (e) => {
      const slot = this.streaks[e.slot];
      if (!slot) return;
      slot.name = e.name.toUpperCase();
      slot.short = shortStreakName(e.name);
      const becameReady = e.ready && !slot.ready;
      slot.progress = clamp01(e.progress);
      slot.ready = e.ready;
      slot.charges = e.charges ?? (e.ready ? 1 : 0);
      if (becameReady) slot.flash = 1;
    }));

    d.push(bus.on('ui:equipment', (e) => {
      this.equipment.lethal = e.lethal;
      this.equipment.tactical = e.tactical;
      this.equipment.field = e.field;
      if (e.fieldName) this.equipment.fieldName = e.fieldName.toUpperCase();
    }));

    d.push(bus.on('ui:objective', (e) => {
      if (e.marker) this.objectives.set(e.marker.id, e.marker);
      else if (e.id) this.objectives.delete(e.id);
      else this.objectives.clear();
    }));

    d.push(bus.on('game:over', (e) => {
      this.gameOver = true;
      this.gameWin = e.win;
      this.match.running = false;
    }));

    d.push(bus.on('game:pause', (e) => { this.paused = e.paused; }));

    d.push(bus.on('game:start', (e) => {
      this.gameOver = false;
      this.match.mode = e.mode;
      this.match.running = true;
    }));
  }

  /* ------------------------------------------------------------------ */

  /** Pulls authoritative numbers from gameplay systems when they exist. */
  private syncFromMirrors(force: boolean): void {
    if (!this.syncMirrors) return;
    const cur = this.weapons?.current;
    if (cur) {
      if (typeof cur.name === 'string') this.weapon.name = cur.name.toUpperCase();
      if (typeof cur.id === 'string') this.weapon.id = cur.id;
      if (typeof cur.ammo === 'number') this.weapon.ammo = cur.ammo;
      if (typeof cur.magSize === 'number') this.weapon.magSize = cur.magSize;
      if (typeof cur.reserve === 'number') this.weapon.reserve = cur.reserve;
      if (typeof cur.reloading === 'boolean') this.weapon.reloading = cur.reloading;
      if (typeof cur.ads === 'boolean') this.weapon.ads = cur.ads;
      if (typeof cur.rpm === 'number' && cur.rpm > 0) this.fireRate = cur.rpm;
      if (typeof cur.id === 'string') this.weapon.kind = classifyWeapon(cur.id);
    }
    const p = this.player;
    if (p) {
      if (typeof p.health === 'number') this.health = p.health;
      if (typeof p.maxHealth === 'number' && p.maxHealth > 0) this.maxHealth = p.maxHealth;
      if (typeof p.alive === 'boolean') this.alive = p.alive;
      if (force) this.healthBar.set(clamp01(this.health / this.maxHealth));
    }
  }

  update(dt: number, ctx: EngineContext): void {
    this.elapsed += dt;
    this.syncFromMirrors(false);

    /* --- transform, bearing, speed ---------------------------------- */
    const cam = ctx.camera;
    this.camera = cam;
    cam.getWorldDirection(FORWARD);
    this.bearing = (Math.atan2(FORWARD.x, -FORWARD.z) * 180) / Math.PI;
    if (this.bearing < 0) this.bearing += 360;
    this.pitch = Math.asin(Math.max(-1, Math.min(1, FORWARD.y)));

    if (this.prevPosValid && dt > 0) {
      const dx = cam.position.x - this.prevPos.x;
      const dz = cam.position.z - this.prevPos.z;
      const inst = Math.sqrt(dx * dx + dz * dz) / dt;
      this.speed = damp(this.speed, Math.min(inst, 14), 9, dt);
    }
    this.prevPos.copy(cam.position);
    this.prevPosValid = true;
    this.position.copy(cam.position);

    /* --- health ------------------------------------------------------ */
    this.timeSinceDamage += dt;
    const frac = clamp01(this.health / this.maxHealth);
    this.healthBar.to(frac);
    this.healthBar.step(dt);
    this.healthGhost = this.healthGhost > this.healthBar.value
      ? Math.max(this.healthBar.value, this.healthGhost - dt * (this.timeSinceDamage > 0.7 ? 0.55 : 0))
      : this.healthBar.value;

    /* --- weapon ------------------------------------------------------ */
    this.ads = damp(this.ads, this.weapon.ads ? 1 : 0, this.weapon.ads ? 13 : 16, dt);
    if (this.ads < 0.002) this.ads = 0;
    if (this.reloadStartedAt >= 0) {
      this.weapon.reloadProgress = clamp01((this.elapsed - this.reloadStartedAt) / this.reloadDuration);
    }
    this.ammoTicker.set(this.weapon.ammo);
    this.reserveTicker.set(this.weapon.reserve);
    this.ammoTicker.step(dt);
    this.reserveTicker.step(dt);
    this.xp.step(dt);

    /* --- reticle spread ---------------------------------------------- */
    this.recoil = Math.max(0, this.recoil - dt * (this.recoil > 0.5 ? 3.4 : 2.1));
    const moveTerm = clamp01(this.speed / 6.2) * (this.sprinting ? 1.25 : 1);
    const stanceTerm = this.crouched ? -0.06 : 0;
    const airTerm = this.airborne ? 0.42 : 0;
    const adsTerm = -this.ads * 0.62;
    const target = clamp01(0.1 + moveTerm * 0.42 + airTerm + stanceTerm + adsTerm + this.recoil * 0.55);
    this.spread.to(target);
    this.spread.step(dt);

    /* --- streak flashes ---------------------------------------------- */
    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i];
      if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 0.55);
    }

    /* --- match clock -------------------------------------------------- */
    if (this.match.running && this.match.timeLeft > 0) {
      this.match.timeLeft = Math.max(0, this.match.timeLeft - dt);
    }
  }

  /** Reserve magazines remaining, used by the low-ammo warning. */
  get reserveMagazines(): number {
    return this.weapon.magSize > 0 ? this.weapon.reserve / this.weapon.magSize : 0;
  }

  get healthFraction(): number {
    return clamp01(this.health / this.maxHealth);
  }

  /** 0 above the critical threshold, ramping to 1 at death's door. */
  get criticalAmount(): number {
    const f = this.healthFraction;
    const threshold = 0.34;
    return f >= threshold ? 0 : 1 - f / threshold;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

/**
 * Compact tile label for a killstreak: "UAV" → UAV, "COUNTER UAV" → CUAV,
 * "CLUSTER STRIKE" → CLST. Naive truncation produces "COUN", which looks broken.
 */
export function shortStreakName(name: string): string {
  const words = name.toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 4);
  const last = words[words.length - 1];
  if (last.length <= 4) {
    return words.slice(0, -1).map((w) => w[0]).join('') + last;
  }
  return words[0].slice(0, 2) + last.slice(0, 2);
}

/** Maps a weapon id to the glyph family used by the killfeed. */
export function classifyWeapon(id: string): WeaponKind {
  const s = id.toLowerCase();
  if (s.startsWith('smg') || s.includes('_smg') || s.includes('mp')) return 'smg';
  if (s.startsWith('lmg') || s.includes('_lmg')) return 'lmg';
  if (s.startsWith('sn') || s.includes('sniper') || s.includes('bolt')) return 'sniper';
  if (s.startsWith('sg') || s.includes('shotgun')) return 'shotgun';
  if (s.startsWith('pi') || s.includes('pistol') || s.includes('sidearm')) return 'pistol';
  if (s.includes('launcher') || s.includes('rpg') || s.includes('rocket')) return 'launcher';
  if (s.includes('grenade') || s.includes('frag') || s.includes('semtex')) return 'grenade';
  if (s.includes('knife') || s.includes('melee')) return 'knife';
  if (s.includes('turret') || s.includes('sentry')) return 'turret';
  if (s.includes('explos') || s.includes('c4') || s.includes('mine')) return 'explosion';
  return 'ar';
}
