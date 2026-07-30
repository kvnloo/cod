/**
 * Directional damage indicators.
 *
 * Each hit stores the *world* bearing of its source, so the wedge keeps pointing
 * at the attacker while the player turns — the single detail that makes these
 * useful rather than decorative. Hits from a similar bearing merge into the
 * existing wedge and re-bloom instead of stacking into mush.
 *
 * Motion: bloom (scale + brightness overshoot) on arrival, then a long decay
 * with a slight outward drift.
 */

import * as THREE from 'three';
import { bus } from '../../core/EventBus';
import { clamp01, Ease, motion, Spring } from '../Anim';
import type { DrawCtx } from '../Draw';
import { wedgePath } from '../Draw';
import type { HudModel } from '../Model';
import { lift, rgba, type Palette } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

interface Hit {
  active: boolean;
  /** World bearing in radians, 0 = north (−Z), clockwise. */
  bearing: number;
  strength: number;
  age: number;
  life: number;
  bloom: Spring;
}

const CAPACITY = 8;
const MERGE_RADIANS = 0.42;

export class DamageIndicators implements Widget {
  readonly name = 'damage-indicators';

  private readonly pool: Hit[] = [];
  private readonly off: Array<() => void> = [];
  private readonly tmp = new THREE.Vector3();

  constructor(private pal: () => Palette) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        active: false, bearing: 0, strength: 0, age: 0, life: 1.6,
        bloom: new Spring(0, { stiffness: 300, damping: 0.55 }),
      });
    }
    this.off.push(bus.on('damage:taken', (e) => {
      this.tmp.copy(e.fromDirection);
      // Near-vertical damage (fall damage, airburst above) has no useful bearing.
      const horiz = Math.hypot(this.tmp.x, this.tmp.z);
      if (horiz < 0.12) return;
      const bearing = Math.atan2(this.tmp.x, -this.tmp.z);
      this.add(bearing, clamp01(e.amount / 45));
    }));
  }

  /** Public so the debug scene and scripted sequences can stage indicators. */
  add(bearingRadians: number, strength01: number): void {
    let slot: Hit | null = null;
    let oldest = this.pool[0];
    for (let i = 0; i < CAPACITY; i++) {
      const h = this.pool[i];
      if (h.active && Math.abs(angleDiff(h.bearing, bearingRadians)) < MERGE_RADIANS) { slot = h; break; }
      if (!h.active) { if (!slot) slot = h; }
      if (h.age > oldest.age) oldest = h;
    }
    const h = slot ?? oldest;
    h.active = true;
    h.bearing = bearingRadians;
    h.strength = Math.max(h.age < 0.25 ? h.strength : 0, clamp01(strength01));
    h.age = 0;
    h.life = 1.35 + h.strength * 0.65;
    h.bloom.set(0.25);
    h.bloom.to(1);
    h.bloom.kick(16);
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.pool[i].active = false;
  }

  update(dt: number, _m: HudModel): void {
    for (let i = 0; i < CAPACITY; i++) {
      const h = this.pool[i];
      if (!h.active) continue;
      h.age += dt;
      h.bloom.step(dt);
      if (h.age >= h.life) h.active = false;
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    if (!ui.prefs.damageIndicators) return;
    const c = d.c;
    const p = this.pal();
    const cx = d.w / 2;
    const cy = d.h / 2;
    const playerBearing = (m.bearing * Math.PI) / 180;

    for (let i = 0; i < CAPACITY; i++) {
      const h = this.pool[i];
      if (!h.active) continue;

      const t = clamp01(h.age / h.life);
      const fade = t < 0.18 ? 1 : 1 - Ease.inQuad((t - 0.18) / 0.82);
      const a = fade * d.alpha * (0.55 + 0.45 * h.strength);
      if (a <= 0.005) continue;

      // Screen-relative angle: 0 points up, positive is clockwise.
      const rel = angleDiff(playerBearing, h.bearing);
      const ang = rel - Math.PI / 2; // canvas angles start at +X

      const bloom = h.bloom.value;
      const baseR = (128 + h.strength * 14) * d.s;
      const drift = Ease.outCubic(t) * 18 * d.s * motion();
      const rInner = baseR + drift;
      const thickness = (13 + h.strength * 10) * d.s * (0.72 + bloom * 0.34);
      const half = (0.235 + h.strength * 0.075) * (0.72 + bloom * 0.36);

      const hot = lift(p.hostile, 0.4 * clamp01(bloom - 0.55));

      c.save();
      c.globalAlpha = a;

      // Soft outer haze so the wedge sits in the frame rather than on it.
      const grad = c.createRadialGradient(cx, cy, rInner - thickness * 0.4, cx, cy, rInner + thickness * 2.4);
      grad.addColorStop(0, rgba(p.hostile, 0.42));
      grad.addColorStop(1, rgba(p.hostile, 0));
      wedgePath(c, cx, cy, rInner - thickness * 0.4, rInner + thickness * 2.4, ang - half * 1.5, ang + half * 1.5);
      c.fillStyle = grad;
      c.fill();

      // Core wedge: brightest at the inner edge, falling away outward.
      const core = c.createLinearGradient(
        cx + Math.cos(ang) * rInner, cy + Math.sin(ang) * rInner,
        cx + Math.cos(ang) * (rInner + thickness), cy + Math.sin(ang) * (rInner + thickness),
      );
      core.addColorStop(0, rgba(hot, 1));
      core.addColorStop(0.45, rgba(p.hostile, 0.72));
      core.addColorStop(1, rgba(p.hostile, 0.05));
      wedgePath(c, cx, cy, rInner, rInner + thickness, ang - half, ang + half);
      c.fillStyle = core;
      c.fill();

      // Hard inner arc + tapered tips: this is what makes it read as a pointer
      // rather than a smear.
      c.strokeStyle = rgba(lift(p.hostile, 0.62), 0.95 * fade);
      c.lineWidth = Math.max(1.4, 2.1 * d.s);
      c.lineCap = 'round';
      c.beginPath();
      c.arc(cx, cy, rInner - 1.2 * d.s, ang - half * 0.92, ang + half * 0.92);
      c.stroke();
      c.lineCap = 'butt';

      // Centre tick pointing straight at the source.
      c.strokeStyle = rgba(lift(p.hostile, 0.75), 0.9 * fade);
      c.lineWidth = Math.max(1.2, 1.8 * d.s);
      c.beginPath();
      c.moveTo(cx + Math.cos(ang) * (rInner - 8 * d.s), cy + Math.sin(ang) * (rInner - 8 * d.s));
      c.lineTo(cx + Math.cos(ang) * (rInner - 2 * d.s), cy + Math.sin(ang) * (rInner - 2 * d.s));
      c.stroke();

      c.restore();
    }
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}

function angleDiff(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
