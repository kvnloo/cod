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
      // Pushed out and slimmed right down from the original: a shipped
      // indicator is a thin chevron of arc sitting *outside* the action, not a
      // slab of red across the midground. Radius scales with the shorter screen
      // axis so it keeps the same relationship to the reticle at any aspect.
      const ref = Math.min(d.w, d.h);
      const baseR = ref * 0.225 + h.strength * 12 * d.s;
      const drift = Ease.outCubic(t) * 16 * d.s * motion();
      const rInner = baseR + drift;
      const thickness = (5 + h.strength * 4) * d.s * (0.8 + bloom * 0.3);
      const half = (0.15 + h.strength * 0.05) * (0.78 + bloom * 0.3);

      const hot = lift(p.hostile, 0.45 * clamp01(bloom - 0.4));

      c.save();
      c.globalAlpha = a;

      // Angular taper: three nested wedges narrowing as they brighten. Cheaper
      // and crisper than a conic gradient, and it gives the arc real points at
      // both ends instead of a chopped-off slab.
      const rings: Array<[number, number]> = [[1.0, 0.2], [0.74, 0.34], [0.44, 0.5]];
      for (const [spanK, alphaK] of rings) {
        wedgePath(c, cx, cy, rInner, rInner + thickness, ang - half * spanK, ang + half * spanK);
        c.fillStyle = rgba(p.hostile, alphaK);
        c.fill();
      }

      // Bright inner lip — the edge nearest the player is what the eye catches.
      c.strokeStyle = rgba(hot, 0.95 * fade);
      c.lineWidth = Math.max(1.2, 1.7 * d.s);
      c.lineCap = 'round';
      c.beginPath();
      c.arc(cx, cy, rInner + 0.6 * d.s, ang - half * 0.66, ang + half * 0.66);
      c.stroke();
      c.lineCap = 'butt';

      // Inward pip on the apex axis, between the arc and the reticle. It points
      // *at* the source, which is what turns a curved stroke into a direction.
      // (An outward barb was tried first and read as a hook on the arc's end.)
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      const pr = rInner - 7 * d.s;
      const pip = 4.2 * d.s;
      c.fillStyle = rgba(hot, 0.85 * fade);
      c.beginPath();
      c.moveTo(cx + nx * (pr + pip), cy + ny * (pr + pip));
      c.lineTo(cx + nx * (pr - pip * 0.5) - ny * pip * 0.72, cy + ny * (pr - pip * 0.5) + nx * pip * 0.72);
      c.lineTo(cx + nx * (pr - pip * 0.5) + ny * pip * 0.72, cy + ny * (pr - pip * 0.5) - nx * pip * 0.72);
      c.closePath();
      c.fill();

      // Dark keyline behind the whole arc so it survives a bright wall.
      c.globalCompositeOperation = 'destination-over';
      wedgePath(c, cx, cy, rInner - 1.6 * d.s, rInner + thickness + 1.6 * d.s,
        ang - half - 0.012, ang + half + 0.012);
      c.fillStyle = 'rgba(2,4,8,0.5)';
      c.fill();
      c.globalCompositeOperation = 'source-over';

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
