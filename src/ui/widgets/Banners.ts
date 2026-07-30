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
import { hairWidth, measureText, text } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
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
    this.off.push(bus.on('ui:banner', (e) => {
      this.banner(e.title, e.sub ?? '', e.kind ?? 'objective');
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

  banner(title: string, sub = '', kind: BannerKind = 'objective'): void {
    this.queue.push({ title, sub, kind, age: 0, life: motionTime(3.4) });
    bus.emit('ui:sound', { cue: 'objective' });
  }

  flourish(title: string, sub = ''): void {
    const p = this.pal();
    this.flourishes.push({
      title, sub, age: 0, life: motionTime(1.5),
      tint: sub === 'CRITICAL HIT' ? p.accent : p.ink,
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
    this.drawFlourishes(d);
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

    const tint: RGB = b.kind === 'reward' ? p.accent : b.kind === 'warn' ? p.hostile : p.ink;
    const cx = d.w / 2;
    const cy = d.h * 0.235 - Ease.outCubic(outT) * 14 * s * motion();

    c.save();
    c.globalAlpha = a;

    const titleSize = 40 * s;
    const titleOpts = {
      size: titleSize, weight: 700, family: 'cond' as const, tracking: 7 * s,
      align: 'center' as const,
    };
    const tw = measureText(c, b.title, titleOpts);
    const ruleW = Math.max(tw + 70 * s, 260 * s);

    // Backing wash so the banner survives a busy scene. Elliptical so there is
    // no hard rectangle edge floating over the frame.
    c.save();
    c.translate(cx, cy - titleSize * 0.18);
    c.scale(ruleW, titleSize * 1.15);
    const wash = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    wash.addColorStop(0, 'rgba(4,7,12,0.62)');
    wash.addColorStop(0.55, 'rgba(4,7,12,0.42)');
    wash.addColorStop(1, 'rgba(4,7,12,0)');
    c.fillStyle = wash;
    c.beginPath();
    c.arc(0, 0, 1, 0, Math.PI * 2);
    c.fill();
    c.restore();

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

    text(c, b.title, cx, cy, {
      ...titleOpts,
      color: rgba(lift(tint, 0.25), 1),
      shadow: Math.max(1.4, 2 * s),
      glow: b.kind === 'reward' ? 20 * s : 10 * s,
      glowColor: rgba(tint, 0.45),
      chroma: (1 - Ease.outQuart(clamp01(inT * 1.5))) * 5 * s,
    });

    if (b.sub) {
      text(c, b.sub, cx, cy + 40 * s, {
        size: 15 * s, weight: 600, family: 'cond', tracking: 5.5 * s, align: 'center',
        color: rgba(p.ink, 0.9), shadow: Math.max(1.2, 1.6 * s),
        alpha: Ease.outQuart(clamp01((inT - 0.25) / 0.75)),
      });
    }

    c.restore();
    void t;
  }

  /* --------------------------------------------------------- flourish --- */

  private drawFlourishes(d: DrawCtx): void {
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const cx = d.w / 2;

    for (let i = 0; i < this.flourishes.length; i++) {
      const f = this.flourishes[i];
      const t = clamp01(f.age / f.life);
      const inT = clamp01(f.age / motionTime(0.16));
      const a = Ease.outQuart(inT) * (1 - Ease.inCubic(clamp01((t - 0.55) / 0.45))) * d.alpha;
      if (a <= 0.005) continue;

      const rise = Ease.outQuint(inT) * 1 - t * 10 * s * motion();
      const cy = d.h * 0.395 - i * 22 * s + rise;

      c.save();
      c.globalAlpha = a;
      const size = 19 * s;
      const opts = {
        size, weight: 700, family: 'cond' as const, tracking: 6.5 * s, align: 'center' as const,
      };
      const w = measureText(c, f.title, opts);

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
