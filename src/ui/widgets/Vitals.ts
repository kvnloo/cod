/**
 * Bottom-left stack: killstreak slots, equipment counts, health.
 *
 * The health bar keeps a "ghost" of recently lost health that drains a beat
 * later, so a burst of damage reads as a distinct event rather than a jump. When
 * regeneration starts the bar gains a travelling highlight. Killstreak tiles fill
 * a progress arc as score accrues and flare — glow, chromatic edge, a sweep — the
 * moment they become available.
 */

import { clamp01, Ease, lerp, motion, Spring, SPRING } from '../Anim';
import { chamferPath, corners, hairWidth, meter, panel, text } from '../Draw';
import type { DrawCtx } from '../Draw';
import { equipmentGlyph, streakGlyph, type EquipmentGlyph, type StreakGlyph } from '../Glyphs';
import type { HudModel } from '../Model';
import { lift, mixRGB, rgba, type Palette, type RGB } from '../Theme';
import { MARGIN } from '../Theme';
import type { Widget } from './Widget';

const EQUIP_GLYPH: Record<string, EquipmentGlyph> = {
  FRAG: 'frag', SEMTEX: 'frag', THERMITE: 'frag',
  FLASH: 'flash', STUN: 'stun', SMOKE: 'smoke',
  TROPHY: 'trophy', CLAYMORE: 'claymore', AMMO: 'ammo', 'AMMO BOX': 'ammo',
};

const STREAK_GLYPH: Record<string, StreakGlyph> = {
  UAV: 'uav', 'COUNTER UAV': 'cuav', CUAV: 'cuav',
  'CLUSTER STRIKE': 'cluster', CLUSTER: 'cluster',
  AIRSTRIKE: 'airstrike', 'PRECISION AIRSTRIKE': 'airstrike',
  'ATTACK HELI': 'chopper', CHOPPER: 'chopper', 'SENTRY GUN': 'sentry',
};

export class Vitals implements Widget {
  readonly name = 'vitals';

  private readonly slide = new Spring(1, SPRING.heavy);
  private readonly readyPulse: Spring[] = [];
  private t = 0;

  constructor(private pal: () => Palette) {
    for (let i = 0; i < 4; i++) this.readyPulse.push(new Spring(0, SPRING.pop));
  }

  update(dt: number, m: HudModel): void {
    this.t += dt;
    this.slide.step(dt);
    for (let i = 0; i < m.streaks.length && i < this.readyPulse.length; i++) {
      const s = m.streaks[i];
      const sp = this.readyPulse[i];
      sp.to(s.ready ? 1 : 0);
      if (s.flash > 0.98) sp.kick(22);
      sp.step(dt);
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const left = MARGIN * s;
    const bottom = d.h - MARGIN * s;
    const alpha = d.alpha * (1 - m.ads * 0.5);
    if (alpha <= 0.01) return;

    c.save();
    c.globalAlpha = alpha;
    c.translate(-(1 - this.slide.value) * 28 * s * motion(), 0);

    /* ------------------------------------------------------ health ----- */
    const barW = 258 * s;
    const barH = 8 * s;
    const barY = bottom - barH;
    const frac = m.healthBar.value;
    const col: RGB = frac > 0.55
      ? mixRGB(p.warn, p.good, clamp01((frac - 0.55) / 0.45))
      : mixRGB(p.hostile, p.warn, clamp01(frac / 0.55));

    meter(c, left, barY, barW, barH, frac, col, {
      segments: 4, track: p.hair, glow: 8 * s, ghost: m.healthGhost,
    });

    // Frame + end caps.
    c.strokeStyle = rgba(p.hair, 0.28);
    c.lineWidth = hairWidth(d.dpr);
    c.strokeRect(left - 0.5, barY - 0.5, barW + 1, barH + 1);
    c.fillStyle = rgba(p.hair, 0.42);
    c.fillRect(left - 2.5 * s, barY - 1.5 * s, 1.6 * s, barH + 3 * s);
    c.fillRect(left + barW + 1 * s, barY - 1.5 * s, 1.6 * s, barH + 3 * s);

    // Regeneration highlight travelling along the filled portion.
    if (m.regenerating && frac < 1) {
      const sweep = (this.t * 0.55) % 1;
      const x = left + barW * frac * sweep;
      const g = c.createLinearGradient(x - 22 * s, 0, x + 22 * s, 0);
      g.addColorStop(0, rgba(p.good, 0));
      g.addColorStop(0.5, rgba(lift(p.good, 0.5), 0.55));
      g.addColorStop(1, rgba(p.good, 0));
      c.fillStyle = g;
      c.fillRect(left, barY, barW * frac, barH);
    }

    text(c, String(Math.round(m.health)), left + barW + 9 * s, barY + barH + 0.5 * s, {
      size: 15 * s, weight: 600, family: 'cond', tracking: 0.6 * s,
      color: rgba(frac < 0.35 ? p.hostile : p.inkDim, 0.95), shadow: Math.max(1, 1.2 * s),
    });

    text(c, m.regenerating ? 'REGENERATING' : 'VITALS', left, barY - 6 * s, {
      size: 10 * s, weight: 600, family: 'cond', tracking: 3.4 * s,
      color: rgba(m.regenerating ? p.good : p.inkFaint, m.regenerating ? 0.9 : 0.7),
      shadow: Math.max(1, 1 * s),
    });

    /* --------------------------------------------------- equipment ----- */
    const eqY = barY - 26 * s;
    this.drawEquipment(d, m, left, eqY, p);

    /* --------------------------------------------------- killstreaks --- */
    // Tiles are 36 design-px tall and grow downward from ksY, so leave the
    // equipment row clear above the health bar.
    const ksY = eqY - 62 * s;
    this.drawStreaks(d, m, left, ksY, p);

    c.restore();
  }

  private drawEquipment(d: DrawCtx, m: HudModel, x: number, y: number, p: Palette): void {
    const c = d.c;
    const s = d.s;
    const e = m.equipment;
    const items: Array<{ name: string; count: number; key: string }> = [
      { name: e.lethalName, count: e.lethal, key: 'G' },
      { name: e.tacticalName, count: e.tactical, key: 'T' },
      { name: e.fieldName, count: e.field, key: 'F' },
    ];

    const cell = 62 * s;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const cx = x + i * cell + cell * 0.33;
      const empty = it.count <= 0;
      const gl = EQUIP_GLYPH[it.name] ?? 'frag';
      const tint = empty ? p.inkFaint : p.ink;
      const gy = y - 15 * s;

      c.save();
      c.globalAlpha *= empty ? 0.4 : 1;
      // Contact shadow so glyphs read on bright ground.
      c.save();
      c.translate(1.4 * s, 1.6 * s);
      equipmentGlyph(c, gl, cx, gy, 32 * s, 'rgba(0,3,7,0.75)');
      c.restore();
      equipmentGlyph(c, gl, cx, gy, 32 * s, rgba(tint, 0.96));

      if (!empty) {
        text(c, `×${it.count}`, cx + 19 * s, gy + 9 * s, {
          size: 15 * s, weight: 700, family: 'cond',
          color: rgba(it.count > 1 ? p.ink : p.inkDim, 0.95),
          shadow: Math.max(1, 1.3 * s),
        });
      }
      text(c, it.key, cx - 19 * s, gy - 8 * s, {
        size: 10 * s, weight: 700, family: 'mono', color: rgba(p.inkFaint, 0.9),
        align: 'center', shadow: 1,
      });
      c.restore();
    }
  }

  private drawStreaks(d: DrawCtx, m: HudModel, x: number, y: number, p: Palette): void {
    const c = d.c;
    const s = d.s;
    const tileW = 62 * s;
    const tileH = 36 * s;
    const gap = 6 * s;

    for (let i = 0; i < m.streaks.length; i++) {
      const st = m.streaks[i];
      const pulse = this.readyPulse[i]?.value ?? 0;
      const tx = x + i * (tileW + gap);
      const ty = y;
      const ready = st.ready;
      const flare = st.flash;

      const fill: RGB = ready ? p.accent : p.panel;
      c.save();

      // Tile
      chamferPath(c, tx, ty, tileW, tileH, 6 * s);
      const g = c.createLinearGradient(tx, ty, tx, ty + tileH);
      if (ready) {
        g.addColorStop(0, rgba(fill, 0.22 + 0.16 * pulse));
        g.addColorStop(1, rgba(fill, 0.06));
      } else {
        g.addColorStop(0, rgba(p.panel, 0.6));
        g.addColorStop(1, rgba(p.panel, 0.34));
      }
      c.fillStyle = g;
      c.fill();
      c.lineWidth = hairWidth(d.dpr);
      c.strokeStyle = rgba(ready ? p.accent : p.hair, ready ? 0.65 : 0.2);
      c.stroke();

      if (ready) {
        c.lineWidth = Math.max(1, 1.1 * s);
        c.strokeStyle = rgba(lift(p.accent, 0.3), 0.5 + 0.4 * Math.sin(this.t * 3.4 + i));
        corners(c, tx, ty, tileW, tileH, 7 * s);
      }

      // Glyph
      const gl = STREAK_GLYPH[st.name] ?? 'uav';
      const gx = tx + tileW * 0.32;
      const gy = ty + tileH * 0.46;
      c.save();
      c.globalAlpha *= ready ? 1 : 0.5;
      streakGlyph(c, gl, gx, gy, 26 * s, rgba(ready ? lift(p.accent, 0.35) : p.ink, 1));
      c.restore();

      // Label + progress
      text(c, st.short, tx + tileW - 5 * s, ty + tileH - 5 * s, {
        size: 10.5 * s, weight: 700, family: 'cond', tracking: 1.4 * s, align: 'right',
        color: rgba(ready ? p.accent : p.inkDim, ready ? 1 : 0.7),
      });

      if (!ready) {
        const pw = tileW - 10 * s;
        c.fillStyle = rgba(p.hair, 0.16);
        c.fillRect(tx + 5 * s, ty + tileH - 3.5 * s, pw, 1.8 * s);
        c.fillStyle = rgba(p.ink, 0.55);
        c.fillRect(tx + 5 * s, ty + tileH - 3.5 * s, pw * clamp01(st.progress), 1.8 * s);
      } else if (st.charges > 1) {
        text(c, `×${st.charges}`, tx + tileW - 5 * s, ty + 12 * s, {
          size: 11 * s, weight: 700, family: 'cond', align: 'right',
          color: rgba(lift(p.accent, 0.4), 1),
        });
      }

      // Ready flare: an expanding outline that fires once on arrival.
      if (flare > 0.01) {
        const t = 1 - flare;
        const grow = Ease.outQuart(t) * 14 * s * motion();
        c.globalAlpha *= flare;
        c.lineWidth = Math.max(1, (2.2 - t * 1.4) * s);
        c.strokeStyle = rgba(lift(p.accent, 0.5), 0.9);
        chamferPath(c, tx - grow, ty - grow, tileW + grow * 2, tileH + grow * 2, 6 * s + grow);
        c.stroke();
      }

      c.restore();
    }

    // Section rule + label
    text(c, 'KILLSTREAKS', x, y - 6 * s, {
      size: 9.5 * s, weight: 600, family: 'cond', tracking: 3.6 * s,
      color: rgba(p.inkFaint, 0.7), shadow: Math.max(1, 1 * s),
    });
  }
}
