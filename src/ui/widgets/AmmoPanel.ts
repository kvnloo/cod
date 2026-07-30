/**
 * Ammunition readout — bottom right.
 *
 *   ┌ LOW AMMO / RELOAD tag (only when there is something to say)
 *   ├ weapon name (condensed, tracked)
 *   ├ fire mode · attachment
 *   ├ magazine pips: one tick per round, spent ticks dimmed and shortened
 *   └ 24 / 210   big count, small reserve
 *
 * The counter *ticks*: each round fired punches the digit block down and it
 * springs back, and the reserve flashes when it drops below the configured
 * number of magazines. Reloading swaps the pip row for a sweeping progress bar
 * and dims the magazine count.
 *
 * This block is **tier one**. It and the health bar are the only two things a
 * player reads without looking, so it is the one element that does not step
 * back when the player aims — it steps *forward*, while the map, the feed, the
 * streaks and the score all pull away from it.
 */

import { clamp01, Ease, Envelope, motion, Spring, SPRING } from '../Anim';
import { hairWidth, measureText, text, wash } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { ADS_FADE, adsFade, lift, mixRGB, rgba, type Palette, type RGB } from '../Theme';
import { MARGIN } from '../Theme';
import { ui } from '../UiSettings';
import { bus } from '../../core/EventBus';
import type { Widget } from './Widget';

export class AmmoPanel implements Widget {
  readonly name = 'ammo';

  private readonly appear = new Spring(1, SPRING.heavy);
  private readonly swap = new Envelope(0.08, 0.05, 0.4);
  private readonly reloadPulse = new Spring(0, SPRING.snappy);
  private lowFlashT = 0;
  private lastReserve = -1;
  private warnedLow = false;
  private readonly off: Array<() => void> = [];

  constructor(private pal: () => Palette) {
    this.off.push(bus.on('weapon:switch', () => {
      this.swap.fire();
      this.appear.set(0.86);
      this.appear.to(1);
      this.appear.kick(6);
    }));
    this.off.push(bus.on('weapon:reload:start', () => {
      this.reloadPulse.set(0);
      this.reloadPulse.to(1);
      this.reloadPulse.kick(8);
    }));
    this.off.push(bus.on('weapon:reload:end', () => { this.reloadPulse.to(0); }));
  }

  update(dt: number, m: HudModel): void {
    this.appear.step(dt);
    this.swap.step(dt);
    this.reloadPulse.step(dt);
    this.lowFlashT += dt;

    // One-shot low-ammo cue when the reserve crosses the threshold downward.
    const mags = m.reserveMagazines;
    if (this.lastReserve >= 0 && m.weapon.reserve < this.lastReserve) {
      if (mags <= ui.prefs.lowAmmoMagazines && !this.warnedLow) {
        this.warnedLow = true;
        bus.emit('ui:sound', { cue: 'lowAmmo' });
      }
    }
    if (mags > ui.prefs.lowAmmoMagazines + 0.35) this.warnedLow = false;
    this.lastReserve = m.weapon.reserve;
  }

  draw(d: DrawCtx, m: HudModel): void {
    const p = this.pal();
    const s = d.s;
    const c = d.c;
    const w = m.weapon;

    const right = d.w - MARGIN * s;
    const bottom = d.h - MARGIN * s;

    // The magazine count is the one number a player parses without looking at
    // it. Aiming must not touch it — the rest of the interface steps back
    // *around* this readout, never over it.
    const alpha = adsFade(d.alpha, m.ads, ADS_FADE.vital);
    if (alpha <= 0.01) return;

    c.save();
    c.globalAlpha = alpha;

    const slide = (1 - this.appear.value) * 26 * s * motion();
    c.translate(slide, 0);

    // Active promotion, not merely "not demoted": the block grows a few per
    // cent about its bottom-right anchor as the player settles into the sights.
    // Small enough to be felt rather than noticed, and it is the readout the
    // eye is being *pushed toward* while everything else pulls back.
    if (m.ads > 0.002) {
      const k = 1 + Ease.outQuad(clamp01(m.ads)) * 0.07;
      c.translate(d.w, d.h);
      c.scale(k, k);
      c.translate(-d.w, -d.h);
    }

    /* ---------------------------------------------------- numbers ------ */
    const magEmpty = w.ammo <= 0;
    const lowMag = w.magSize > 0 && w.ammo / w.magSize <= 0.25;
    // Healthy magazine is *near-white*, not amber: at 24/30 there is nothing to
    // warn about, and an orange number here competed with the objective accent.
    // Colour only arrives as the magazine actually empties.
    const ammoColor: RGB = magEmpty
      ? p.hostile
      : lowMag
        ? mixRGB(p.warn, p.ink, clamp01((w.ammo / Math.max(1, w.magSize)) / 0.25) * 0.35)
        : lift(p.ink, 0.35);

    const punch = m.ammoTicker.punch.value;
    const bigSize = 60 * s;
    const bigY = bottom - 4 * s;

    // Corner darkening under the readout. The critic measured the ammo count at
    // 165 peak over an 81 background — 3.3:1, below the threshold for a number
    // read in peripheral vision. The digits are now near-white; this drops what
    // is *behind* them so the ratio holds over a sunlit street as well as a
    // shaded interior. It has to be a soft falloff rather than a plate: a
    // rectangle with a visible top edge is a UI box pasted on the frame.
    if (!d.cheap) {
      wash(c, right - 34 * s, bigY + 14 * s, 340 * s, 176 * s, 0.5 + 0.14 * m.ads);
    }

    const reserveMags = m.reserveMagazines;
    const lowReserve = reserveMags <= ui.prefs.lowAmmoMagazines;
    const flash = lowReserve
      ? 0.55 + 0.45 * Math.sin(this.lowFlashT * 7.4) * motion()
      : 1;
    const reserveColor = lowReserve ? p.warn : p.inkDim;

    const reserveStr = String(Math.round(m.reserveTicker.display));
    const reserveOpts = { size: 25 * s, weight: 600, family: 'cond' as const, tracking: 0.6 * s };
    const reserveW = measureText(c, reserveStr, reserveOpts);

    text(c, reserveStr, right, bigY - 3 * s, {
      ...reserveOpts, align: 'right', baseline: 'alphabetic',
      color: rgba(reserveColor, flash), shadow: Math.max(1, 1.4 * s),
    });

    const slashX = right - reserveW - 7 * s;
    text(c, '/', slashX, bigY - 3 * s, {
      size: 23 * s, weight: 400, family: 'cond', align: 'right',
      color: rgba(p.inkFaint, 0.9), shadow: Math.max(1, 1.2 * s),
    });

    // Big magazine count with the tick punch applied as a vertical offset+scale.
    const ammoStr = String(Math.round(m.ammoTicker.display));
    const px = slashX - 9 * s;
    c.save();
    c.translate(px, bigY);
    const kick = punch * 0.006;
    c.translate(0, punch * 0.16 * s);
    c.scale(1 + kick * 0.5, 1 - kick);
    text(c, ammoStr, 0, 0, {
      size: bigSize, weight: 700, family: 'cond', tracking: -0.5 * s,
      align: 'right', color: rgba(ammoColor, 1),
      shadow: Math.max(1.5, 2 * s),
      outline: 3.1,
      glow: magEmpty ? 12 * s : lowMag ? 8 * s : 0,
      glowColor: rgba(ammoColor, 0.5),
      chroma: this.swap.level > 0.02 ? this.swap.level * 2.4 * s : 0,
    });
    c.restore();

    const ammoW = measureText(c, ammoStr, { size: bigSize, weight: 700, family: 'cond', tracking: -0.5 * s });
    const blockLeft = px - ammoW;
    const blockWidth = Math.max(150 * s, right - blockLeft);

    /* --------------------------------------------------- stack up ------ */
    // Reading order bottom-up: numbers, pips, rule, fire mode, weapon name.
    const pipsY = bigY - 50 * s;      // baseline the pips grow up from
    const ruleY = bigY - 68 * s;
    const subY = bigY - 75 * s;
    const nameY = bigY - 91 * s;

    this.drawPips(d, m, right - blockWidth, pipsY, blockWidth, p);

    c.strokeStyle = rgba(p.hair, 0.2);
    c.lineWidth = hairWidth(d.dpr);
    c.beginPath();
    c.moveTo(right - blockWidth, ruleY);
    c.lineTo(right, ruleY);
    c.stroke();

    const sub = `${w.fireMode}${w.attachment ? '  ·  ' + w.attachment : ''}`;
    text(c, sub, right, subY, {
      size: 11.5 * s, weight: 500, family: 'cond', tracking: 2.8 * s,
      align: 'right', color: rgba(p.inkDim, 0.82), shadow: Math.max(1, 1 * s),
    });

    text(c, w.name, right, nameY, {
      size: 27 * s, weight: 600, family: 'cond', tracking: 2.6 * s,
      align: 'right', color: rgba(p.ink, 0.97), shadow: Math.max(1, 1.5 * s),
      chroma: this.swap.level > 0.02 ? this.swap.level * 2 * s : 0,
    });

    /* ------------------------------------------------- magazine state -- */
    // The low-ammo warning used to be painted across the middle of the screen,
    // where it sat on the sight picture for the exact seconds a player is most
    // likely to be aiming. It belongs *on* the readout it is talking about.
    if (!w.reloading && (magEmpty || lowMag)) {
      const beat = 0.62 + 0.38 * Math.sin(this.lowFlashT * (magEmpty ? 8.5 : 5)) * motion();
      const tag = magEmpty ? 'RELOAD  ·  [ R ]' : 'LOW AMMO';
      const tagCol = magEmpty ? lift(p.hostile, 0.5) : p.warn;
      // Its own row above the weapon name — right-aligned with the rest of the
      // block, so a long "AUTO · SUPPRESSED" line can never run into it.
      const tagY = nameY - 31 * s;
      const tagOpts = {
        size: 12.5 * s, weight: 700, family: 'cond' as const, tracking: 2.6 * s,
      };
      const tagW = measureText(c, tag, tagOpts);
      text(c, tag, right, tagY, {
        ...tagOpts, align: 'right',
        color: rgba(tagCol, 0.72 + 0.28 * beat), shadow: Math.max(1, 1.2 * s),
        outline: 2.6 * s,
      });
      // A rule under the tag pins it to the block rather than leaving it
      // floating above the weapon name.
      c.fillStyle = rgba(tagCol, 0.4 + 0.35 * beat);
      c.fillRect(right - tagW, tagY + 4 * s, tagW, Math.max(1, 1.4 * s));
    }

    c.restore();
  }

  private drawPips(
    d: DrawCtx, m: HudModel, x: number, y: number, width: number, p: Palette,
  ): void {
    const c = d.c;
    const s = d.s;
    const w = m.weapon;
    const mag = Math.max(1, w.magSize);

    const reloading = w.reloading;
    if (reloading) {
      // Sweep bar replaces the pips while reloading.
      const prog = clamp01(w.reloadProgress);
      const h = 4 * s;
      c.fillStyle = rgba(p.hair, 0.14);
      c.fillRect(x, y - h, width, h);
      // Weapon state is not an objective: the sweep runs in the neutral ink
      // ramp so the accent stays reserved for the mission.
      const g = c.createLinearGradient(x, 0, x + width * prog, 0);
      g.addColorStop(0, rgba(p.inkDim, 0.4));
      g.addColorStop(1, rgba(lift(p.ink, 0.4), 1));
      c.fillStyle = g;
      c.fillRect(x, y - h, width * prog, h);
      c.fillStyle = rgba(lift(p.ink, 0.7), 1);
      c.fillRect(x + width * prog - 2 * s, y - h - 1.5 * s, 2.5 * s, h + 3 * s);
      text(c, 'RELOADING', x, y - h - 6 * s, {
        size: 11 * s, weight: 600, family: 'cond', tracking: 3.4 * s,
        color: rgba(p.ink, 0.75 + 0.25 * Math.sin(d.t * 9)), baseline: 'alphabetic',
        shadow: Math.max(1, 1 * s),
      });
      return;
    }

    // One pip per round, grouped when the magazine is very large. Spent rounds
    // keep most of their height and drop to a dark track instead of shrinking to
    // dots — at 5.5 px the empty row read as a dashed rule, not a magazine.
    const group = mag > 60 ? Math.ceil(mag / 60) : 1;
    const count = Math.ceil(mag / group);
    const gap = Math.max(1.2 * s, width / count * 0.2);
    const pw = Math.max(1.8 * s, (width - gap * (count - 1)) / count);
    const full = 15 * s;
    const empty = 9 * s;
    const loaded = Math.ceil(w.ammo / group);
    const low = w.ammo / mag <= 0.25;

    // Dark trough behind the whole strip: gives the spent rounds something to be
    // spent *into*, and keeps the row readable over a bright wall.
    c.fillStyle = 'rgba(2,5,10,0.5)';
    c.fillRect(x - 1.5 * s, y - full - 1.5 * s, width + 3 * s, full + 3 * s);

    for (let i = 0; i < count; i++) {
      const lit = i < loaded;
      const px = x + i * (pw + gap);
      const h = lit ? full : empty;
      if (lit) {
        const edge = i === loaded - 1;
        const col = low ? p.warn : p.ink;
        c.fillStyle = rgba(edge ? lift(col, 0.5) : col, edge ? 1 : 0.92);
      } else {
        c.fillStyle = rgba(p.hair, 0.26);
      }
      c.fillRect(px, y - h, pw, h);
    }
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
