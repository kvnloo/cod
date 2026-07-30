/**
 * Recoil.
 *
 * Two things are deliberately separated here, because conflating them is the
 * single most common reason a shooter feels wrong:
 *
 *  - **Actual recoil** moves the aim point. It is the pattern the player has to
 *    learn and fight, and only the unrecovered fraction of it persists.
 *  - **Visual recoil** moves the view model and shakes the camera. It sells the
 *    violence of the shot and is fully recovered, so it never costs accuracy.
 *
 * The pattern itself is authored per weapon as a pair of per-shot impulse
 * arrays. Walking off the end of the array repeats the last entry, which is
 * exactly how a real spray behaves: a shaped climb that settles into noise.
 */

import type { Rand } from '../core/Rand';
import type { RecoilPattern, WeaponDef } from './types';

export interface RecoilContext {
  ads: boolean;
  crouched: boolean;
  prone: boolean;
  /** Multiplier from attachments. */
  scale: number;
  horizontalScale: number;
}

export interface RecoilImpulse {
  /** Degrees of camera pitch, positive is up. */
  pitch: number;
  /** Degrees of camera yaw, positive is right. */
  yaw: number;
  /** Fraction of the kick the camera recovers by itself. */
  recover: number;
}

export class RecoilState {
  /** Index into the authored pattern. */
  index = 0;
  private sinceShot = 999;

  reset(): void { this.index = 0; this.sinceShot = 999; }

  /** Call every fixed step; resets the pattern after a pause in fire. */
  tick(dt: number, pattern: RecoilPattern): void {
    this.sinceShot += dt;
    if (this.sinceShot > pattern.resetTime && this.index !== 0) this.index = 0;
  }

  /**
   * Advances the pattern one shot and returns the camera impulse in degrees.
   * Deterministic for a given RNG stream, so capture runs reproduce sprays
   * exactly.
   */
  next(def: WeaponDef, ctx: RecoilContext, rand: Rand, out: RecoilImpulse): RecoilImpulse {
    const p = def.recoil;
    this.sinceShot = 0;

    const vi = Math.min(this.index, p.vertical.length - 1);
    const hi = Math.min(this.index, p.horizontal.length - 1);
    let v = p.vertical[vi];
    let h = p.horizontal[hi];

    // Jitter is normal-distributed: most shots land on the pattern, a few do
    // not, which is what stops a learned spray from being a laser.
    v += rand.normal() * p.verticalJitter;
    h += rand.normal() * p.horizontalJitter;

    if (this.index === 0) { v *= p.firstShot; h *= p.firstShot; }

    let scale = ctx.scale;
    if (ctx.ads) scale *= p.adsScale;
    if (ctx.prone) scale *= p.crouchScale * 0.82;
    else if (ctx.crouched) scale *= p.crouchScale;

    out.pitch = v * scale;
    out.yaw = h * scale * (ctx.horizontalScale / Math.max(1e-3, ctx.scale));
    out.recover = p.recoverFraction;
    this.index++;
    return out;
  }
}
