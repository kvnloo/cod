/**
 * Hit markers.
 *
 * Four kinds, each with its own silhouette, colour and audio cue so the player
 * can read the outcome of a shot without looking away from the target:
 *
 *   normal   thin diagonal ticks, near-white
 *   armour   diagonal ticks bracketed by two arcs, steel blue
 *   critical heavier, brighter ticks plus two axis ticks — same hue as a body
 *            shot, read apart by weight and silhouette rather than by colour
 *   kill     heavy X plus an expanding rotated square, hostile red
 *
 * The critical marker used to be amber. Sitting dead centre on the reticle it
 * was the single most prominent amber element on the screen, competing directly
 * with the objective marker it shared a hue with. A shipped shooter spends
 * *value* here — a crit is a bigger, hotter white — and keeps colour for the one
 * outcome that changes what you do next: the kill.
 *
 * Motion: each marker punches out from 55% scale with a spring, holds, then
 * decays. Markers stack — a burst that kills produces the normal marker still
 * fading beneath the kill marker, which is exactly what a shipped title does.
 */

import { bus } from '../../core/EventBus';
import { clamp01, Ease, motion, Spring } from '../Anim';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { lift, rgba, type Palette, type RGB } from '../Theme';
import type { Widget } from './Widget';

type MarkerKind = 'normal' | 'armor' | 'crit' | 'kill';

interface Marker {
  active: boolean;
  kind: MarkerKind;
  age: number;
  life: number;
  scale: Spring;
  rot: number;
  seed: number;
}

const CAPACITY = 10;

export class HitMarkers implements Widget {
  readonly name = 'hitmarkers';

  private readonly pool: Marker[] = [];
  private cursor = 0;
  private readonly off: Array<() => void> = [];

  constructor(private pal: () => Palette) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        active: false, kind: 'normal', age: 0, life: 0.5,
        scale: new Spring(1, { stiffness: 420, damping: 0.5 }), rot: 0, seed: i,
      });
    }
    this.off.push(bus.on('hud:hitmarker', (e) => {
      const kind: MarkerKind = e.killed ? 'kill' : e.headshot ? 'crit' : e.armor ? 'armor' : 'normal';
      this.spawn(kind);
    }));
  }

  /** Public so debug scenes and other systems can stage a marker. */
  spawn(kind: MarkerKind): void {
    const m = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;
    m.active = true;
    m.kind = kind;
    m.age = 0;
    m.life = kind === 'kill' ? 0.72 : kind === 'crit' ? 0.55 : 0.42;
    m.scale.set(0.52);
    m.scale.to(1);
    m.scale.kick(kind === 'kill' ? 7 : 4.5);
    m.rot = kind === 'kill' ? 0 : 0;
    bus.emit('ui:sound', {
      cue: kind === 'kill' ? 'hitKill' : kind === 'crit' ? 'hitCrit' : kind === 'armor' ? 'hitArmor' : 'hit',
    });
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.pool[i].active = false;
  }

  update(dt: number, _m: HudModel): void {
    for (let i = 0; i < CAPACITY; i++) {
      const k = this.pool[i];
      if (!k.active) continue;
      k.age += dt;
      k.scale.step(dt);
      if (k.age >= k.life) k.active = false;
    }
  }

  draw(d: DrawCtx, _m: HudModel): void {
    const p = this.pal();
    const cx = d.w / 2;
    const cy = d.h / 2;
    const c = d.c;

    for (let i = 0; i < CAPACITY; i++) {
      const k = this.pool[i];
      if (!k.active) continue;
      const t = clamp01(k.age / k.life);
      // Full opacity for the first third, then a fast falloff.
      const fade = t < 0.34 ? 1 : 1 - Ease.inCubic((t - 0.34) / 0.66);
      const a = fade * d.alpha;
      if (a <= 0.004) continue;

      c.save();
      c.translate(cx, cy);
      c.globalAlpha = a;
      const sc = k.scale.value * d.s;
      switch (k.kind) {
        case 'normal': drawTicks(c, sc, 5.5, 12.5, 2.0, rgba([0xef, 0xf5, 0xff], 1)); break;
        case 'armor': drawArmor(c, sc, p, a); break;
        case 'crit': drawCrit(c, sc, p, t); break;
        case 'kill': drawKill(c, sc, p, t); break;
      }
      c.restore();
    }
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}

/* --------------------------------------------------------------- shapes -- */

function drawTicks(
  c: CanvasRenderingContext2D, s: number, r0: number, r1: number, thick: number, color: string,
): void {
  c.lineCap = 'butt';
  c.strokeStyle = 'rgba(1,3,7,0.8)';
  c.lineWidth = thick * s + 2.6;
  tickPath(c, s, r0, r1);
  c.stroke();
  c.strokeStyle = color;
  c.lineWidth = thick * s;
  tickPath(c, s, r0, r1);
  c.stroke();
}

function tickPath(c: CanvasRenderingContext2D, s: number, r0: number, r1: number): void {
  const k = Math.SQRT1_2;
  c.beginPath();
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sy = i < 2 ? -1 : 1;
    c.moveTo(sx * r0 * k * s, sy * r0 * k * s);
    c.lineTo(sx * r1 * k * s, sy * r1 * k * s);
  }
}

function drawArmor(c: CanvasRenderingContext2D, s: number, p: Palette, a: number): void {
  drawTicks(c, s, 5.5, 12.0, 2.2, rgba(lift(p.friendly, 0.35), 1));
  c.strokeStyle = rgba(p.friendly, 0.85 * a + 0.15);
  c.lineWidth = 1.9 * s;
  c.lineCap = 'butt';
  c.beginPath();
  c.arc(0, 0, 14.5 * s, -Math.PI * 0.82, -Math.PI * 0.68);
  c.arc(0, 0, 14.5 * s, Math.PI * 0.18, Math.PI * 0.32);
  c.stroke();
  c.beginPath();
  c.arc(0, 0, 14.5 * s, -Math.PI * 0.32, -Math.PI * 0.18);
  c.arc(0, 0, 14.5 * s, Math.PI * 0.68, Math.PI * 0.82);
  c.stroke();
}

function drawCrit(c: CanvasRenderingContext2D, s: number, p: Palette, t: number): void {
  const hot = lift(p.ink, 0.6);
  drawTicks(c, s, 5.0, 13.5, 2.7, rgba(hot, 1));
  // Four short axis ticks distinguish a crit from a body shot at a glance —
  // these carry the read, not a ring. The full circle the original drew sat
  // right on top of the reticle and looked like a stray HUD element.
  c.strokeStyle = 'rgba(1,3,7,0.75)';
  c.lineWidth = 3.4 * s;
  axisTicks(c, s);
  c.strokeStyle = rgba(hot, 0.95);
  c.lineWidth = 1.9 * s;
  axisTicks(c, s);
  // A brief arc pair rather than a closed ring: it reads as a flourish that
  // leaves, and it is gone inside 250 ms.
  if (t < 0.45) {
    const k = 1 - t / 0.45;
    const ringR = (14 + Ease.outCubic(t) * 7) * s;
    c.strokeStyle = rgba(p.ink, k * 0.8);
    c.lineWidth = Math.max(1, 1.4 * s);
    c.beginPath();
    c.arc(0, 0, ringR, -Math.PI * 0.42, -Math.PI * 0.08);
    c.arc(0, 0, ringR, Math.PI * 0.58, Math.PI * 0.92);
    c.stroke();
  }
}

function axisTicks(c: CanvasRenderingContext2D, s: number): void {
  c.beginPath();
  c.moveTo(0, -16.5 * s); c.lineTo(0, -21 * s);
  c.moveTo(0, 16.5 * s); c.lineTo(0, 21 * s);
  c.stroke();
}

function drawKill(c: CanvasRenderingContext2D, s: number, p: Palette, t: number): void {
  const hot: RGB = lift(p.hostile, 0.28);
  drawTicks(c, s, 4.5, 15.0, 3.1, rgba(hot, 1));

  // Expanding rotated square — the "confirmed" flourish.
  const grow = Ease.outQuart(t);
  const r = (10 + grow * 16 * motion()) * s;
  const rot = Math.PI / 4 + grow * 0.24 * motion();
  c.save();
  c.rotate(rot);
  c.strokeStyle = rgba(p.hostile, (1 - Ease.inQuad(t)) * 0.95);
  c.lineWidth = Math.max(1, (2.4 - grow * 1.4) * s);
  c.strokeRect(-r, -r, r * 2, r * 2);
  c.restore();

  if (t < 0.4) {
    c.globalAlpha *= 1 - t / 0.4;
    c.fillStyle = rgba(p.hostile, 0.16);
    c.beginPath();
    c.arc(0, 0, 20 * s, 0, Math.PI * 2);
    c.fill();
  }
}
