/**
 * Killfeed — top right.
 *
 * `KILLER  ⟨weapon glyph⟩  VICTIM`, right-aligned, newest at the top. Rows the
 * player is involved in get a tinted plate and a brighter name so they can be
 * picked out at a glance. Entries slide in from the right on a spring, push the
 * stack down, hold, then fade and collapse — the collapse is animated, which is
 * what stops the feed from feeling like a debug log.
 */

import { bus } from '../../core/EventBus';
import { clamp01, Ease, motion, Spring, SPRING } from '../Anim';
import { hairWidth, measureText, text } from '../Draw';
import type { DrawCtx } from '../Draw';
import { headshotGlyph, weaponGlyph } from '../Glyphs';
import type { HudModel, WeaponKind } from '../Model';
import { classifyWeapon } from '../Model';
import { lift, rgba, type Palette } from '../Theme';
import { MARGIN } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

export interface KillfeedRecord {
  killer: string;
  victim: string;
  weapon: WeaponKind;
  headshot: boolean;
  killerIsPlayer: boolean;
  victimIsPlayer: boolean;
  /** Killer was on the player's team. */
  friendlyKiller?: boolean;
}

interface Row extends KillfeedRecord {
  age: number;
  alive: boolean;
  slide: Spring;
  height: Spring;
  y: Spring;
}

const LIFETIME = 6.5;
const FADE = 0.55;
const MAX_ROWS = 6;

export class Killfeed implements Widget {
  readonly name = 'killfeed';

  private rows: Row[] = [];
  private readonly off: Array<() => void> = [];
  /** Name shown for the local player in feed entries. */
  playerName = 'YOU';

  constructor(private pal: () => Palette) {
    this.off.push(bus.on('entity:death', (e) => {
      if (e.name === 'player' || e.id === 1) return; // player deaths come from damage:taken
      this.push({
        killer: e.byPlayer ? this.playerName : 'HOSTILE',
        victim: (e.name || 'ENEMY').toUpperCase(),
        weapon: 'ar',
        headshot: e.headshot,
        killerIsPlayer: e.byPlayer,
        victimIsPlayer: false,
        friendlyKiller: e.byPlayer,
      });
    }));
    this.off.push(bus.on('weapon:switch', () => { /* keeps weapon glyph in sync */ }));
  }

  /** Public entry point — game modes push fully-formed records here. */
  push(rec: KillfeedRecord): void {
    const row: Row = {
      ...rec,
      killer: rec.killer.toUpperCase(),
      victim: rec.victim.toUpperCase(),
      age: 0,
      alive: true,
      slide: new Spring(1, SPRING.snappy),
      height: new Spring(0, SPRING.snappy),
      y: new Spring(0, { stiffness: 190, damping: 0.85 }),
    };
    row.slide.to(0);
    row.height.to(1);
    this.rows.unshift(row);
    // Retire the oldest rows immediately rather than letting the list grow.
    for (let i = MAX_ROWS; i < this.rows.length; i++) this.rows[i].alive = false;
  }

  /** Convenience for gameplay that only knows a weapon id. */
  pushKill(killer: string, victim: string, weaponId: string, headshot: boolean, byPlayer: boolean): void {
    this.push({
      killer, victim, weapon: classifyWeapon(weaponId), headshot,
      killerIsPlayer: byPlayer, victimIsPlayer: false, friendlyKiller: byPlayer,
    });
  }

  /** Drops every row immediately (shot setup / round reset). */
  clear(): void { this.rows.length = 0; }

  update(dt: number, _m: HudModel): void {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      r.age += dt;
      if (r.alive && r.age > LIFETIME) r.alive = false;
      if (!r.alive) {
        r.height.to(0);
        r.slide.to(0.4);
      }
      r.y.to(i);
      r.slide.step(dt);
      r.height.step(dt);
      r.y.step(dt);
    }
    // Drop rows once their collapse animation has finished.
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (!r.alive && r.height.value < 0.02) this.rows.splice(i, 1);
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    if (!ui.prefs.showKillfeed || this.rows.length === 0) return;
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const right = d.w - MARGIN * s;
    const top = MARGIN * s * 0.72 + 4 * s;
    const rowH = 23 * s;

    const alpha = d.alpha * (1 - m.ads * 0.4);
    if (alpha <= 0.01) return;

    c.save();
    c.globalAlpha = alpha;

    for (const r of this.rows) {
      const collapse = r.height.value;
      if (collapse <= 0.01) continue;
      const fadeOut = r.alive ? 1 : clamp01(collapse);
      const fadeIn = clamp01(collapse * 1.6);
      const a = fadeIn * fadeOut * (r.alive && r.age > LIFETIME - FADE
        ? 1 - (r.age - (LIFETIME - FADE)) / FADE : 1);
      if (a <= 0.01) continue;

      const y = top + r.y.value * rowH + rowH * 0.68;
      const dx = r.slide.value * 46 * s * motion();

      c.save();
      c.globalAlpha = alpha * a;
      c.translate(dx, 0);

      const highlight = r.killerIsPlayer || r.victimIsPlayer;
      const nameSize = 14.5 * s;
      const nameOpts = { size: nameSize, weight: 600, family: 'cond' as const, tracking: 1.5 * s };

      const victimColor = r.victimIsPlayer ? p.friendly : p.hostile;
      const killerColor = r.killerIsPlayer ? p.accent : r.friendlyKiller ? p.friendly : p.hostile;

      const victimW = measureText(c, r.victim, nameOpts);
      const glyphW = 30 * s;
      const gap = 9 * s;
      const hsW = r.headshot ? 15 * s : 0;
      const killerW = measureText(c, r.killer, nameOpts);
      const totalW = killerW + gap + glyphW + hsW + gap + victimW;
      const left = right - totalW;

      if (highlight) {
        const g = c.createLinearGradient(left - 10 * s, 0, right + 4 * s, 0);
        g.addColorStop(0, rgba(r.killerIsPlayer ? p.accent : p.hostile, 0));
        g.addColorStop(1, rgba(r.killerIsPlayer ? p.accent : p.hostile, 0.16));
        c.fillStyle = g;
        c.fillRect(left - 10 * s, y - rowH * 0.72, totalW + 14 * s, rowH * 0.9);
        c.fillStyle = rgba(r.killerIsPlayer ? p.accent : p.hostile, 0.8);
        c.fillRect(right + 2 * s, y - rowH * 0.72, 2 * s, rowH * 0.9);
      }

      text(c, r.killer, left, y, {
        ...nameOpts, color: rgba(killerColor, highlight ? 1 : 0.92),
        shadow: Math.max(1, 1.2 * s),
      });

      const gx = left + killerW + gap + glyphW / 2;
      c.save();
      c.translate(1 * s, 1.2 * s);
      weaponGlyph(c, r.weapon, gx, y - nameSize * 0.32, glyphW, 'rgba(0,3,7,0.7)');
      c.restore();
      weaponGlyph(c, r.weapon, gx, y - nameSize * 0.32, glyphW, rgba(lift(p.ink, 0.15), 0.95));

      if (r.headshot) {
        headshotGlyph(c, gx + glyphW / 2 + hsW * 0.45, y - nameSize * 0.32, 6.2 * s, rgba(p.accent, 1));
      }

      text(c, r.victim, right, y, {
        ...nameOpts, align: 'right', color: rgba(victimColor, highlight ? 1 : 0.92),
        shadow: Math.max(1, 1.2 * s),
      });

      c.restore();
    }

    c.restore();
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
