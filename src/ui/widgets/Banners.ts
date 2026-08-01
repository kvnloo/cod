/**
 * Centre-screen announcements: objective banners, killstreak flourishes,
 * elimination confirmations and transient notifications.
 *
 * The banner choreography is deliberately layered — a wipe opens from the centre,
 * the rule expands past the type and settles back, the title arrives with a
 * chromatic edge that resolves over ~180 ms, and the whole block drifts up a few
 * pixels as it leaves. Cheap to run, and it is the difference between "text
 * appeared" and "the game told me something".
 */

import { bus } from '../../core/EventBus';
import { clamp01, Ease, motion, motionTime } from '../Anim';
import { hairWidth, measureText, text, wash } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { aboveSightY } from '../Sight';
import { lift, rgba, type Palette, type RGB } from '../Theme';
import type { Widget } from './Widget';

type BannerKind = 'objective' | 'warn' | 'reward';

interface Banner {
  title: string;
  sub: string;
  kind: BannerKind;
  age: number;
  life: number;
}

interface Flourish {
  title: string;
  sub: string;
  age: number;
  life: number;
  tint: RGB;
}

interface Toast {
  text: string;
  kind: 'info' | 'warn' | 'reward';
  age: number;
  life: number;
}

export class Banners implements Widget {
  readonly name = 'banners';

  private queue: Banner[] = [];
  private current: Banner | null = null;
  private flourishes: Flourish[] = [];
  private toasts: Toast[] = [];
  private readonly off: Array<() => void> = [];

  constructor(private pal: () => Palette) {
    // Gameplay emits `hud:banner` (BannerView); UI also accepts `ui:banner`.
    // Without the gameplay bridge, centre banners never appear in a real match.
    const mapKind = (k?: string): BannerKind => {
      if (k === 'reward') return 'reward';
      if (k === 'alert' || k === 'result' || k === 'warn') return 'warn';
      return 'objective';
    };
    this.off.push(bus.on('ui:banner', (e) => {
      this.banner(e.title, e.sub ?? '', e.kind ?? 'objective');
    }));
    this.off.push(bus.on('hud:banner', (e) => {
      this.banner(e.title, e.subtitle ?? '', mapKind(e.kind), e.ttl);
    }));
    this.off.push(bus.on('killstreak:earned', (e) => {
      this.banner(e.name.toUpperCase(), 'KILLSTREAK READY', 'reward');
      bus.emit('ui:sound', { cue: 'streakReady' });
    }));
    this.off.push(bus.on('entity:death', (e) => {
      if (!e.byPlayer) return;
      this.flourish(e.headshot ? 'HEADSHOT' : 'ENEMY DOWN', e.headshot ? 'CRITICAL HIT' : '');
    }));
    this.off.push(bus.on('notify', (e) => {
      this.toasts.push({ text: e.text.toUpperCase(), kind: e.kind ?? 'info', age: 0, life: 3.2 });
      if (this.toasts.length > 4) this.toasts.shift();
    }));
    this.off.push(bus.on('game:over', (e) => {
      this.banner(e.win ? 'VICTORY' : 'DEFEAT', e.win ? 'OBJECTIVE SECURED' : 'MISSION FAILED',
        e.win ? 'reward' : 'warn');
    }));
  }

  banner(title: string, sub = '', kind: BannerKind = 'objective', ttl?: number): void {
    const life = motionTime(ttl && ttl > 0 ? ttl : 3.4);
    this.queue.push({ title, sub, kind, age: 0, life });
    bus.emit('ui:sound', { cue: 'objective' });
  }

  flourish(title: string, sub = ''): void {
    const p = this.pal();
    // Kill confirmations are near-white, always. A critical hit is told apart by
    // its second line and its heavier glow, not by wearing the objective hue.
    this.flourishes.push({
      title, sub, age: 0, life: motionTime(1.5),
      tint: sub === 'CRITICAL HIT' ? lift(p.ink, 0.35) : p.ink,
    });
    if (this.flourishes.length > 3) this.flourishes.shift();
  }

  clear(): void {
    this.queue.length = 0;
    this.current = null;
    this.flourishes.length = 0;
    this.toasts.length = 0;
  }

  update(dt: number, _m: HudModel): void {
    if (!this.current && this.queue.length) this.current = this.queue.shift() ?? null;
    if (this.current) {
      this.current.age += dt;
      if (this.current.age >= this.current.life) this.current = null;
    }
    for (let i = this.flourishes.length - 1; i >= 0; i--) {
      const f = this.flourishes[i];
      f.age += dt;
      if (f.age >= f.life) this.flourishes.splice(i, 1);
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.age += dt;
      if (t.age >= t.life) this.toasts.splice(i, 1);
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    this.drawBanner(d);
    this.drawFlourishes(d, m);
    this.drawToasts(d);
  }

  /* ------------------------------------------------------------ banner -- */

  private drawBanner(d: DrawCtx): void {
    const b = this.current;
    if (!b) return;
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const t = b.age / b.life;

    const inT = clamp01(b.age / motionTime(0.42));
    const outT = clamp01((b.age - (b.life - motionTime(0.5))) / motionTime(0.5));
    const a = Ease.outQuart(inT) * (1 - Ease.inCubic(outT)) * d.alpha;
    if (a <= 0.005) return;

    const tint: RGB = b.kind === 'reward' ? p.accent : b.kind === 'warn' ? p.hostile : p.accent;
    const cx = d.w / 2;
    const cy = d.h * 0.235 - Ease.outCubic(outT) * 14 * s * motion();

    c.save();
    c.globalAlpha = a;

    const titleSize = 34 * s;
    const titleOpts = {
      size: titleSize, weight: 700, family: 'cond' as const, tracking: 6 * s,
      align: 'center' as const,
    };
    const tw = measureText(c, b.title, titleOpts);
    const ruleW = Math.max(tw + 70 * s, 260 * s);

    // Backing wash so the banner survives a busy scene. Wide and shallow: the
    // earlier tight ellipse read as a dark smudge stuck to the sky. Spreading
    // the same total darkening over twice the width makes it read as haze.
    if (!d.cheap) {
      wash(c, cx, cy - titleSize * 0.16, ruleW * 1.25, titleSize * 1.75, 0.44);
    }

    // Rules that overshoot then settle.
    const grow = Ease.outQuint(inT) * (1 + (1 - Ease.outQuart(inT)) * 0.22 * motion());
    const half = (ruleW / 2) * grow;
    c.strokeStyle = rgba(tint, 0.75);
    c.lineWidth = Math.max(1, 1.4 * s);
    c.beginPath();
    c.moveTo(cx - half, cy + 12 * s);
    c.lineTo(cx + half, cy + 12 * s);
    c.stroke();
    c.strokeStyle = rgba(tint, 0.28);
    c.lineWidth = hairWidth(d.dpr);
    c.beginPath();
    c.moveTo(cx - half * 0.82, cy - titleSize * 0.86);
    c.lineTo(cx + half * 0.82, cy - titleSize * 0.86);
    c.stroke();

    // End caps.
    c.fillStyle = rgba(tint, 0.9);
    c.fillRect(cx - half - 1 * s, cy + 8 * s, 2.2 * s, 9 * s);
    c.fillRect(cx + half - 1.2 * s, cy + 8 * s, 2.2 * s, 9 * s);

    // The headline is near-white and the *rules* carry the semantic hue. A
    // 34 px objective title painted solid amber is a block of accent the size
    // of a paragraph — the colour says "objective" just as clearly from a pair
    // of hairlines, and the type stays the brightest thing rather than the
    // most saturated.
    // A reward headline used to be painted solid accent, which put a 34 px
    // block of amber on screen at the exact moment the amber score popup and
    // the amber tile flare also fired — three clusters of the same hue for one
    // event. The headline is now near-white for every kind except an outright
    // warning; the rules, the end caps and the glow carry the semantic.
    const titleInk: RGB = b.kind === 'warn' ? lift(tint, 0.25) : lift(p.ink, 0.3);
    text(c, b.title, cx, cy, {
      ...titleOpts,
      color: rgba(titleInk, 1),
      shadow: Math.max(1.4, 2 * s),
      glow: b.kind === 'reward' ? 16 * s : 7 * s,
      glowColor: rgba(tint, 0.45),
      chroma: (1 - Ease.outQuart(clamp01(inT * 1.5))) * 5 * s,
    });

    if (b.sub) {
      text(c, b.sub, cx, cy + 34 * s, {
        size: 15 * s, weight: 600, family: 'cond', tracking: 5.5 * s, align: 'center',
        color: rgba(p.ink, 0.9), shadow: Math.max(1.2, 1.6 * s),
        alpha: Ease.outQuart(clamp01((inT - 0.25) / 0.75)),
      });
    }

    c.restore();
    void t;
  }

  /* --------------------------------------------------------- flourish --- */

  private drawFlourishes(d: DrawCtx, m: HudModel): void {
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const cx = d.w / 2;
    // The confirmation row rides above the optic and climbs further as the
    // player aims, so "HEADSHOT / CRITICAL HIT" never lands on the housing of
    // the sight it is reporting on.
    const baseY = aboveSightY(d, m, 72, d.h * 0.395);

    for (let i = 0; i < this.flourishes.length; i++) {
      const f = this.flourishes[i];
      const t = clamp01(f.age / f.life);
      const inT = clamp01(f.age / motionTime(0.16));
      const a = Ease.outQuart(inT) * (1 - Ease.inCubic(clamp01((t - 0.55) / 0.45))) * d.alpha;
      if (a <= 0.005) continue;

      const rise = Ease.outQuint(inT) * 1 - t * 10 * s * motion();
      const cy = baseY - i * 22 * s + rise;

      c.save();
      c.globalAlpha = a;
      const size = 19 * s;
      const opts = {
        size, weight: 700, family: 'cond' as const, tracking: 6.5 * s, align: 'center' as const,
      };
      const w = measureText(c, f.title, opts);

      if (!d.cheap) wash(c, cx, cy - size * 0.3, w * 0.75 + 120 * s, 34 * s, 0.5);

      // Expanding hairlines either side of the type.
      const g = Ease.outQuint(inT);
      c.strokeStyle = rgba(f.tint, 0.55 * a);
      c.lineWidth = hairWidth(d.dpr) * 1.5;
      c.beginPath();
      c.moveTo(cx - w / 2 - 10 * s, cy - size * 0.32);
      c.lineTo(cx - w / 2 - 10 * s - 34 * s * g, cy - size * 0.32);
      c.moveTo(cx + w / 2 + 10 * s, cy - size * 0.32);
      c.lineTo(cx + w / 2 + 10 * s + 34 * s * g, cy - size * 0.32);
      c.stroke();

      text(c, f.title, cx, cy, {
        ...opts, color: rgba(lift(f.tint, 0.2), 1), shadow: Math.max(1, 1.6 * s),
        glow: 12 * s, glowColor: rgba(f.tint, 0.4),
        chroma: (1 - g) * 3.5 * s,
      });
      if (f.sub) {
        text(c, f.sub, cx, cy + 14 * s, {
          size: 10 * s, weight: 600, family: 'cond', tracking: 4 * s, align: 'center',
          color: rgba(p.inkDim, 0.85),
        });
      }
      c.restore();
    }
  }

  /* ----------------------------------------------------------- toasts --- */

  private drawToasts(d: DrawCtx): void {
    if (!this.toasts.length) return;
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const cx = d.w / 2;
    const baseY = d.h * 0.30;

    c.save();
    for (let i = 0; i < this.toasts.length; i++) {
      const t = this.toasts[i];
      const k = clamp01(t.age / t.life);
      const inT = clamp01(t.age / motionTime(0.24));
      const a = Ease.outQuart(inT) * (1 - Ease.inQuad(clamp01((k - 0.7) / 0.3))) * d.alpha;
      if (a <= 0.005) continue;
      const tint = t.kind === 'reward' ? p.accent : t.kind === 'warn' ? p.hostile : p.inkDim;
      c.globalAlpha = a;
      text(c, t.text, cx, baseY + i * 18 * s + (1 - Ease.outQuart(inT)) * 8 * s * motion(), {
        size: 12.5 * s, weight: 600, family: 'cond', tracking: 3.6 * s, align: 'center',
        color: rgba(tint, 0.95), shadow: Math.max(1, 1.2 * s),
      });
    }
    c.restore();
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
