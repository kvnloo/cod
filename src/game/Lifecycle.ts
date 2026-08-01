/**
 * Player lifecycle: health regeneration, last stand, death and respawn.
 *
 * The death beat is the one every shooter gets judged on, so it is staged
 * properly: a hard hit of slow motion that eases back to real time, a respawn
 * clock that runs in *unscaled* seconds so the slow-mo does not stretch it, a
 * spawn choice that will not drop the player back into the muzzle that just
 * killed them, and — in survival modes — a last-stand window where the fight is
 * still winnable.
 *
 * Regeneration is the classic curve: a fixed no-damage delay, then a ramp-in,
 * with the rate biased so the first sliver of health comes back fastest. If the
 * player system is already regenerating on its own the director detects it on
 * the first tick and stands down rather than double-healing.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Emitter } from './Services';
import type { GameServices } from './Services';

export type LifeState = 'alive' | 'downed' | 'dead' | 'respawning';

export interface LifecycleConfig {
  /** Seconds from death to respawn. */
  respawnDelay: number;
  /** Survival modes give one last stand per life. */
  allowLastStand: boolean;
  /** Seconds to bleed out while downed. */
  bleedout: number;
  /** Seconds without damage that self-revives from a last stand. */
  reviveAfter: number;
  /** Health restored on self-revive. */
  reviveHealth: number;
  /** Health the player is left with when entering last stand. */
  downedHealth: number;
  slowMoScale: number;
  slowMoDuration: number;
  regenDelay: number;
  regenRate: number;
  /** false ends the match on death instead of respawning. */
  respawnEnabled: boolean;
}

export function defaultLifecycle(): LifecycleConfig {
  return {
    respawnDelay: 5,
    allowLastStand: false,
    bleedout: 14,
    reviveAfter: 7,
    reviveHealth: 45,
    downedHealth: 18,
    slowMoScale: 0.32,
    slowMoDuration: 1.5,
    regenDelay: 4.2,
    regenRate: 32,
    respawnEnabled: true,
  };
}

/** Presentation clock scale written by Lifecycle hitstop; sim ignores it. */
let presentClockScale = 1;

/** View-model / HUD presentation dt multiplier (1 = real time, ~0 = frozen). */
export function getPresentScale(): number { return presentClockScale; }

export class Lifecycle {
  config: LifecycleConfig = defaultLifecycle();
  state: LifeState = 'alive';

  respawnRemaining = 0;
  downedRemaining = 0;
  /** Seconds since the last damage event, unscaled. */
  sinceDamage = 999;
  /** Set once we detect that something else already heals the player. */
  externalRegen = false;

  /**
   * Presentation-only hitstop remaining, in real/sim seconds of the lifecycle
   * clock. Never fed into `setTimeScale` — authoritative fixed steps keep
   * running at full rate while the view model freezes.
   */
  hitstopRemaining = 0;
  /** Last authored hitstop pulse duration (for Category B probes). */
  lastHitstopDuration = 0;
  /** Presentation scale while hitstop is active (0..1). */
  presentScale = 1;

  /** Filled by the owner: chooses a respawn transform. Returns the yaw. */
  pickSpawn: ((out: THREE.Vector3) => number) | null = null;
  /** Called when the player runs out of lives in a no-respawn mode. */
  onFinalDeath: (() => void) | null = null;
  onRespawn: ((point: THREE.Vector3, yaw: number) => void) | null = null;

  private slowMoTimer = 0;
  private downedPublish = 0;
  private lastHealth = -1;
  private healedThisTick = false;
  private lastStandUsed = false;
  private readonly _p = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3(0, 1, 0);
  private readonly off: Array<() => void> = [];

  /** Kill / headshot / heavy-hit freeze windows (presentation only). */
  private static readonly HITSTOP_KILL = 0.055;
  private static readonly HITSTOP_HEAD = 0.038;
  private static readonly HITSTOP_HEAVY = 0.028;
  private static readonly HITSTOP_SCALE = 0.12;

  constructor(private services: GameServices, private emit: Emitter) {
    // Own the juice bus edges so hitstop does not require Match wiring.
    this.off.push(bus.on('hud:hitmarker', (e) => {
      if (e.killed) this.pulseHitstop('kill');
      else if (e.headshot) this.pulseHitstop('headshot');
    }));
    this.off.push(bus.on('damage:dealt', (e) => {
      if (e.fromPlayer && !e.killed && !e.headshot && e.amount >= 45) {
        this.pulseHitstop('heavy');
      }
    }));
  }

  /** Brief presentation freeze. Does **not** touch authoritative time scale. */
  pulseHitstop(kind: 'kill' | 'headshot' | 'heavy'): void {
    const d = kind === 'kill' ? Lifecycle.HITSTOP_KILL
      : kind === 'headshot' ? Lifecycle.HITSTOP_HEAD
        : Lifecycle.HITSTOP_HEAVY;
    if (d >= this.hitstopRemaining) {
      this.hitstopRemaining = d;
      this.lastHitstopDuration = d;
    }
    this.presentScale = Lifecycle.HITSTOP_SCALE;
    presentClockScale = this.presentScale;
  }

  reset(): void {
    this.state = 'alive';
    this.respawnRemaining = 0;
    this.downedRemaining = 0;
    this.sinceDamage = 999;
    this.slowMoTimer = 0;
    this.lastHealth = -1;
    this.lastStandUsed = false;
    this.hitstopRemaining = 0;
    this.presentScale = 1;
    presentClockScale = 1;
    this.services.setTimeScale(1);
  }

  /** Fresh life — clears the once-per-life last stand. */
  newLife(): void {
    this.lastStandUsed = false;
    this.sinceDamage = 999;
  }

  notifyDamaged(): void {
    this.sinceDamage = 0;
    if (this.state === 'downed') this.downedRemaining = Math.min(this.downedRemaining, this.config.bleedout * 0.55);
  }

  /**
   * Handles the player's death event. Returns true when it was converted into a
   * last stand rather than a real death.
   */
  onPlayerDeath(): boolean {
    const player = this.services.player;
    if (this.state === 'dead' || this.state === 'respawning') return false;

    if (this.config.allowLastStand && !this.lastStandUsed && this.state === 'alive' && player?.revive) {
      this.lastStandUsed = true;
      this.state = 'downed';
      this.downedRemaining = this.config.bleedout;
      player.revive();
      // Leave the player on their last sliver of health rather than at full.
      const drop = player.maxHealth - this.config.downedHealth;
      player.applyDamage?.(drop, this._dir, false);
      this.sinceDamage = 0;
      this.emit('player:downed', { bleedout: this.config.bleedout });
      this.emit('hud:banner', {
        title: 'LAST STAND', subtitle: 'Break contact and hold on', kind: 'alert', ttl: 3,
      });
      this.services.render?.screenEffect({ damage: { intensity: 0.9 } });
      return true;
    }

    this.enterDeath();
    return false;
  }

  private enterDeath(): void {
    this.state = 'dead';
    this.respawnRemaining = this.config.respawnDelay;
    // Presentation-only death juice. Never write Time.scale here: Engine multiplies
    // fixedDelta by scale, so a 0.32 death slow-mo stretched sim TTD/bleedout and
    // every other fixed-step clock. Screen damage + a short presentation timer
    // keep the beat without touching the authoritative step.
    this.slowMoTimer = this.config.slowMoDuration;
    this.services.setTimeScale(1);
    this.services.render?.screenEffect({ damage: { intensity: 1 } });
    this.services.render?.screenEffect({
      flash: { intensity: 0.35, color: 0xff2200, decay: this.config.slowMoDuration * 0.55 },
    } as never);
    this.emit('player:respawn:timer', {
      seconds: this.respawnRemaining, total: this.config.respawnDelay,
    });
    if (!this.config.respawnEnabled) {
      this.emit('hud:banner', { title: 'YOU ARE DOWN', subtitle: '', kind: 'result', ttl: 4 });
    }
  }

  fixedUpdate(dt: number): void {
    // `dt` is already the fixed step; keep all lifecycle clocks on unscaled sim time.
    const real = dt;
    this.sinceDamage += real;

    /* --- presentation hitstop (never setTimeScale) --- */
    if (this.hitstopRemaining > 0) {
      this.hitstopRemaining = Math.max(0, this.hitstopRemaining - real);
      if (this.hitstopRemaining <= 0) {
        this.presentScale = 1;
        presentClockScale = 1;
      } else {
        this.presentScale = Lifecycle.HITSTOP_SCALE;
        presentClockScale = this.presentScale;
      }
    }

    /* --- presentation death beat (no Time.scale) --- */
    if (this.slowMoTimer > 0) {
      this.slowMoTimer -= real;
      if (this.slowMoTimer <= 0) {
        this.slowMoTimer = 0;
        this.services.setTimeScale(1);
      }
    }

    const player = this.services.player;
    if (player) this.detectExternalRegen(player.health);

    switch (this.state) {
      case 'alive': this.stepAlive(real); break;
      case 'downed': this.stepDowned(real); break;
      case 'dead': this.stepDead(real); break;
      case 'respawning': break;
    }
  }

  private stepAlive(dt: number): void {
    const player = this.services.player;
    if (!player || this.externalRegen) return;
    if (player.health >= player.maxHealth || !player.heal) return;
    if (this.sinceDamage < this.config.regenDelay) return;

    // Ramp in over 0.55 s, then bias the rate so the first sliver returns fast.
    const ramp = THREE.MathUtils.clamp((this.sinceDamage - this.config.regenDelay) / 0.55, 0, 1);
    const frac = player.health / Math.max(1, player.maxHealth);
    const rate = this.config.regenRate * ramp * (0.6 + 0.55 * (1 - frac));
    player.heal(rate * dt);
    this.healedThisTick = true;
  }

  private stepDowned(dt: number): void {
    const player = this.services.player;
    this.downedRemaining -= dt;
    this.downedPublish -= dt;
    if (this.downedPublish <= 0) {
      this.downedPublish = 0.2;
      this.emit('player:downed', { bleedout: Math.max(0, this.downedRemaining) });
    }

    if (this.sinceDamage >= this.config.reviveAfter) {
      this.state = 'alive';
      this.downedRemaining = 0;
      if (player) {
        const need = this.config.reviveHealth - player.health;
        if (need > 0) player.heal?.(need);
      }
      this.emit('player:revived', { health: this.config.reviveHealth });
      this.emit('hud:banner', { title: 'BACK IN THE FIGHT', subtitle: '', kind: 'reward', ttl: 2.2 });
      return;
    }
    if (this.downedRemaining <= 0) {
      if (player?.applyDamage) player.applyDamage(9999, this._dir, true);
      else this.enterDeath();
    }
  }

  private stepDead(dt: number): void {
    if (!this.config.respawnEnabled) {
      this.state = 'respawning';
      this.onFinalDeath?.();
      return;
    }
    this.respawnRemaining -= dt;
    this.downedPublish -= dt;
    if (this.downedPublish <= 0) {
      this.downedPublish = 0.2;
      this.emit('player:respawn:timer', {
        seconds: Math.max(0, this.respawnRemaining), total: this.config.respawnDelay,
      });
    }
    if (this.respawnRemaining > 0) return;
    this.respawn();
  }

  respawn(): void {
    const player = this.services.player;
    this.services.setTimeScale(1);
    this.slowMoTimer = 0;
    this.hitstopRemaining = 0;
    this.presentScale = 1;
    presentClockScale = 1;
    if (!player) { this.state = 'alive'; return; }

    const yaw = this.pickSpawn ? this.pickSpawn(this._p) : 0;
    if (!this.pickSpawn) this._p.copy(player.position);
    player.spawnAt(this._p, yaw);
    this.state = 'alive';
    this.newLife();
    this.emit('player:respawn', { point: this._p.clone(), yaw });
    this.onRespawn?.(this._p, yaw);
  }

  /**
   * If the player's health climbs without us touching it, some other system is
   * regenerating. Detect once and never fight it.
   */
  private detectExternalRegen(health: number): void {
    if (this.externalRegen) { this.lastHealth = health; return; }
    if (this.lastHealth >= 0 && health > this.lastHealth + 0.001 && !this.healedThisTick) {
      this.externalRegen = true;
    }
    this.healedThisTick = false;
    this.lastHealth = health;
  }

  get alive(): boolean { return this.state === 'alive' || this.state === 'downed'; }
  get downed(): boolean { return this.state === 'downed'; }
}
