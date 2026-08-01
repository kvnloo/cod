/**
 * Spread — how far from the crosshair a round can actually go.
 *
 * Modelled as a cone half-angle in degrees assembled from four independent
 * contributions, because that is how a player reasons about it: a base stance
 * value, a movement penalty, an airborne penalty, and bloom from sustained
 * fire. Attachments scale the first two.
 *
 * First-shot accuracy is explicit: a settled ADS shot from a weapon with
 * `firstShotAccurate` goes exactly where the sights point, with no random cone
 * at all. Without that guarantee, precision weapons feel broken.
 */

import type { Rand } from '../core/Rand';
import type { SpreadProfile, WeaponDef } from './types';

export interface SpreadContext {
  /** 0..1 aim blend. */
  ads: number;
  /** 0..1 normalised horizontal speed. */
  speed01: number;
  grounded: boolean;
  crouched: boolean;
  prone: boolean;
  /** Multipliers from attachments. */
  hipScale: number;
  adsScale: number;
  bloomScale: number;
}

export class SpreadState {
  /** Accumulated bloom in degrees. */
  bloom = 0;
  /** Shots fired without releasing the trigger. */
  burst = 0;
  private sinceShot = 999;

  reset(): void { this.bloom = 0; this.burst = 0; this.sinceShot = 999; }

  /**
   * `holdTime` is how long after a shot bloom stops growing but has not yet
   * started to decay — it must be at least one refire interval, or the decay
   * runs *between* rounds of sustained fire and the gun gets more accurate the
   * longer you hold the trigger. The old fixed 0.06 s was shorter than a 720 rpm
   * cycle (0.083 s), so bloom was effectively dead code on every automatic
   * weapon in the catalogue: 0.10°/shot of growth against 0.093°/shot of decay.
   * The weapon system passes `refireInterval × 1.35`.
   */
  tick(dt: number, p: SpreadProfile, holdTime = 0.06): void {
    this.sinceShot += dt;
    if (this.bloom > 0 && this.sinceShot > holdTime) {
      this.bloom = Math.max(0, this.bloom - p.bloomDecay * dt);
    }
    if (this.sinceShot > 0.35) this.burst = 0;
  }

  /**
   * Bloom accumulates the same amount whatever the stance; `bloomAdsScale` is
   * applied where it belongs, at the point bloom reaches the *cone* (see
   * `cone`). Scaling it on the way in instead meant a magazine that started
   * hip-fired and finished aimed carried hip-sized bloom into the sights, and
   * one that did the reverse was rewarded for it.
   */
  onShot(p: SpreadProfile, ctx: SpreadContext): void {
    this.sinceShot = 0;
    this.burst++;
    this.bloom = Math.min(p.bloomMax, this.bloom + p.bloomPerShot * ctx.bloomScale);
  }

  /** Cone half-angle in degrees for the next shot. */
  cone(def: WeaponDef, ctx: SpreadContext): number {
    const p = def.spread;
    const base = p.hip * ctx.hipScale;
    const aimed = p.ads * ctx.adsScale;
    let s = base + (aimed - base) * ctx.ads;

    const moveBase = p.moving + (p.movingAds - p.moving) * ctx.ads;
    s += moveBase * ctx.speed01;
    if (!ctx.grounded) s += p.jumping * (1 - ctx.ads * 0.4);
    if (ctx.prone) s *= p.crouchScale * 0.8;
    else if (ctx.crouched) s *= p.crouchScale;

    // Aiming suppresses bloom rather than preventing it: a good gun barely
    // blooms down the sights (0.35× on the rifles) but a 30-round burst still
    // opens up, which is what makes controlled pairs beat holding the trigger.
    s += this.bloom * (1 - ctx.ads * (1 - p.bloomAdsScale));

    // First-shot accuracy: settled, aimed, stationary and not mid-burst.
    if (
      p.firstShotAccurate && this.burst === 0 && ctx.ads > 0.92
      && ctx.grounded && ctx.speed01 < 0.06
    ) return 0;

    return Math.max(0, s);
  }

  /**
   * Rotates `dir` inside the cone. Uses a square-root radial distribution so
   * the density is uniform over the disc rather than clustered at the centre —
   * a clustered cone reads as "sometimes it just misses", which feels unfair.
   */
  static apply(dir: { x: number; y: number; z: number }, coneDeg: number, rand: Rand,
    right: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): void {
    if (coneDeg <= 1e-4) return;
    const tan = Math.tan((coneDeg * Math.PI) / 180);
    const r = Math.sqrt(rand.next()) * tan;
    const a = rand.next() * Math.PI * 2;
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    dir.x += right.x * dx + up.x * dy;
    dir.y += right.y * dx + up.y * dy;
    dir.z += right.z * dx + up.z * dy;
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir.x /= l; dir.y /= l; dir.z /= l;
  }
}
