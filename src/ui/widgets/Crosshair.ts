/**
 * Dynamic reticle.
 *
 * Four strokes whose inner gap tracks the weapon's effective spread: movement,
 * airborne state, stance and per-shot recoil all push it open, aiming down sights
 * collapses it to nothing. A separate spring handles the per-shot kick so the
 * bloom is a punch rather than a ramp.
 *
 * Every stroke is drawn twice — a dark 1px-wider under-stroke first — so the
 * reticle stays readable against a bright sky or a white wall without resorting
 * to an outline shader.
 */

import { bus } from '../../core/EventBus';
import { settings } from '../../core/Settings';
import { clamp01, damp, Ease, Envelope, Spring, SPRING } from '../Anim';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { lift, rgba, type Palette, type RGB } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

const CROSSHAIR_TINT: Record<string, RGB> = {
  default: [0xe6, 0xee, 0xfa],
  accent: [0xff, 0xc2, 0x4b],
  green: [0x63, 0xe6, 0xa8],
  cyan: [0x5c, 0xe1, 0xff],
  magenta: [0xff, 0x6a, 0xd5],
};

export class Crosshair implements Widget {
  readonly name = 'crosshair';

  /** Per-shot bloom, on top of the model's slower spread spring. */
  private readonly kick = new Spring(0, { stiffness: 260, damping: 0.62 });
  /** Fires when a shot lands, briefly brightening the reticle. */
  private readonly flash = new Envelope(0.02, 0.02, 0.16, Ease.outQuart, Ease.outQuad);
  /** Fires when the player is hit, snapping the reticle wide for a beat. */
  private readonly shock_ = new Envelope(0.05, 0.02, 0.4, Ease.outQuart, Ease.outCubic);
  private hidden = 0;
  private readonly off: Array<() => void> = [];

  constructor(private pal: () => Palette) {
    this.off.push(bus.on('weapon:fire', () => { this.kick.kick(9.5); }));
    this.off.push(bus.on('hud:hitmarker', () => { this.flash.fire(); }));
    this.off.push(bus.on('damage:taken', () => { this.shock_.fire(); }));
  }

  /** Fires the "you were hit" reticle punch without a bus round trip. */
  shock(): void { this.shock_.fire(); }

  update(dt: number, m: HudModel): void {
    this.kick.to(0);
    this.kick.step(dt);
    this.flash.step(dt);
    this.shock_.step(dt);
    // Sprinting and menus hide the reticle entirely.
    const wantHidden = m.sprinting || m.menuOpen || !m.alive ? 1 : 0;
    this.hidden = damp(this.hidden, wantHidden, 14, dt);
  }

  draw(d: DrawCtx, m: HudModel): void {
    const style = settings.game.crosshairStyle;
    if (style === 'none') return;

    const p = this.pal();
    const s = d.s;
    const cx = d.w / 2;
    const cy = d.h / 2;

    // Aiming down sights fades the reticle out; the weapon's own sight takes over.
    const adsFade = 1 - Ease.outQuad(clamp01(m.ads * 1.25));
    const vis = adsFade * (1 - this.hidden) * d.alpha;
    if (vis <= 0.004) return;

    const tint = CROSSHAIR_TINT[ui.prefs.crosshairColor] ?? CROSSHAIR_TINT.default;
    const hot = this.flash.level;
    const color = rgba(tint, 0.86 + 0.14 * hot);

    const dot = ui.prefs.centreDot || style === 'dot';

    if (style === 'dot') {
      this.drawDot(d, cx, cy, s, tint, vis, hot);
      return;
    }

    const spreadAmount = style === 'cross'
      ? 0.1
      : clamp01(m.spread.value + Math.max(0, this.kick.value) * 0.05 + this.shock_.level * 0.5);

    // Bigger travel between rest and full bloom than the original 4.6→28: the
    // brief says the reticle must *visibly* open with movement, and a 3 px
    // difference at 1080p is not visible.
    const gap = (4.2 + spreadAmount * 42) * s;
    const len = (11 + spreadAmount * 9 + hot * 2.2) * s;
    const thick = Math.max(1.4, 2.35 * s);

    const c = d.c;
    c.save();
    c.globalAlpha = vis;
    c.lineCap = 'butt';

    // Dark under-stroke, wide and opaque enough to survive a sunlit stone
    // street — this is the whole reason the reticle stays readable without a
    // shader.
    c.strokeStyle = 'rgba(1,3,7,0.78)';
    c.lineWidth = thick + Math.max(2, 2.4 * s);
    strokeArms(c, cx, cy, gap, len);

    c.strokeStyle = color;
    c.lineWidth = thick;
    strokeArms(c, cx, cy, gap, len);

    // A hot inner nub on each arm sells the "energy" of the reticle when firing.
    if (hot > 0.01) {
      c.globalAlpha = vis * hot * 0.85;
      // Lifted toward white, never *to* it — the visual bar bans a pure #fff
      // pixel anywhere in the interface, hot states included.
      c.strokeStyle = rgba(lift(tint, 0.55), 1);
      c.lineWidth = thick;
      strokeArms(c, cx, cy, gap, len * 0.5);
      c.globalAlpha = vis;
    }

    if (dot) this.drawDot(d, cx, cy, s, tint, vis, hot);

    // Damage shock briefly draws an outer ring so a hit reads even mid-fight.
    const shock = this.shock_.level;
    if (shock > 0.01) {
      c.globalAlpha = vis * shock * 0.5;
      c.strokeStyle = rgba(p.hostile, 1);
      c.lineWidth = Math.max(1, 1.2 * s);
      c.beginPath();
      c.arc(cx, cy, gap + len + (10 + (1 - shock) * 16) * s, 0, Math.PI * 2);
      c.stroke();
    }

    c.restore();
  }

  private drawDot(
    d: DrawCtx, cx: number, cy: number, s: number, tint: RGB, vis: number, hot: number,
  ): void {
    const c = d.c;
    const r = Math.max(0.9, (1.15 + hot * 0.5) * s);
    c.save();
    c.globalAlpha = vis;
    c.fillStyle = 'rgba(0,3,7,0.7)';
    c.beginPath();
    c.arc(cx, cy, r + Math.max(1, 0.9 * s), 0, Math.PI * 2);
    c.fill();
    c.fillStyle = rgba(tint, 1);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}

function strokeArms(
  c: CanvasRenderingContext2D, cx: number, cy: number, gap: number, len: number,
): void {
  c.beginPath();
  c.moveTo(cx, cy - gap); c.lineTo(cx, cy - gap - len);
  c.moveTo(cx, cy + gap); c.lineTo(cx, cy + gap + len);
  c.moveTo(cx - gap, cy); c.lineTo(cx - gap - len, cy);
  c.moveTo(cx + gap, cy); c.lineTo(cx + gap + len, cy);
  c.stroke();
}
