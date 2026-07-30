/**
 * The sight picture.
 *
 * One rule, enforced in one place: **nothing but the reticle may occupy the
 * optic's aperture.** A damage number painted on the target you are shooting, or
 * a "RELOAD" prompt sitting on the glass of a red dot, is the single loudest tell
 * that an interface was laid out in screen percentages rather than around a
 * weapon.
 *
 * The aperture is modelled as a circle on the screen centre — the sight line
 * lands on centre when aimed, and the view model's optic is centred on it. Its
 * radius grows as the player aims: at the hip the exclusion is just enough to
 * keep type off the reticle and the front post, and down the sights it widens to
 * cover the whole glass plus the housing ring around it.
 *
 * Widgets ask for one of three things:
 *
 *   `sightRadius`     the live exclusion radius, in CSS px
 *   `belowSightY` /   a baseline clear of the aperture, for centre-column type
 *   `aboveSightY`     that would otherwise sit on the glass
 *   `pushOutOfSight`  the nearest point outside the aperture, for world-anchored
 *                     marks that must stay glued to their target
 */

import { clamp01, lerp } from './Anim';
import type { DrawCtx } from './Draw';
import type { HudModel } from './Model';

/**
 * Exclusion radius in design px at the hip and at full ADS.
 *
 * The hip figure clears the reticle's outer arms at rest plus the front sight
 * post; the ADS figure is measured off the optic's outer housing, not the glass,
 * so a number pushed to the boundary lands fully outside the ring rather than
 * kissing it.
 */
export const SIGHT_R_HIP = 96;
export const SIGHT_R_ADS = 142;

/** Live exclusion radius in CSS px. */
export function sightRadius(d: DrawCtx, m: HudModel): number {
  return lerp(SIGHT_R_HIP, SIGHT_R_ADS, clamp01(m.ads)) * d.s;
}

/**
 * Lowest of `preferred` and the first baseline clear of the aperture — so a
 * centre-column element keeps its authored position at the hip and is pushed
 * down only as far as aiming actually requires.
 */
export function belowSightY(d: DrawCtx, m: HudModel, gap = 30, preferred = 0): number {
  const y = d.h / 2 + sightRadius(d, m) + gap * d.s;
  return preferred > y ? preferred : y;
}

/** The mirror of `belowSightY`, for type that lives above the reticle. */
export function aboveSightY(d: DrawCtx, m: HudModel, gap = 30, preferred = Infinity): number {
  const y = d.h / 2 - sightRadius(d, m) - gap * d.s;
  return preferred < y ? preferred : y;
}

/** Scratch tuple — `pushOutOfSight` runs per mark, per frame. */
const OUT: [number, number] = [0, 0];

/**
 * Nearest point outside the aperture, along the ray from screen centre through
 * (x, y). Points already outside are returned untouched, so a number only moves
 * when it would have landed on the glass — and it moves *away from the reticle*,
 * which keeps it associated with the target it belongs to.
 */
export function pushOutOfSight(
  d: DrawCtx, m: HudModel, x: number, y: number, pad = 0,
): readonly [number, number] {
  const cx = d.w * 0.5;
  const cy = d.h * 0.5;
  const r = sightRadius(d, m) + pad * d.s;
  let dx = x - cx;
  let dy = y - cy;
  let len = Math.sqrt(dx * dx + dy * dy);
  if (len >= r) {
    OUT[0] = x;
    OUT[1] = y;
    return OUT;
  }
  // Dead centre has no direction to push along; up-left is the quietest corner
  // of a right-handed first-person frame (the weapon occupies the lower right).
  if (len < 0.001) { dx = -0.7; dy = -0.72; len = 1; }
  OUT[0] = cx + (dx / len) * r;
  OUT[1] = cy + (dy / len) * r;
  return OUT;
}
