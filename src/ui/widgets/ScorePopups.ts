/**
 * XP / score popups and the running tally.
 *
 * A scoring event pops in just below the reticle, joins a stack that pushes the
 * older entries down, holds, then *flies out* along a quadratic path into the
 * bottom-centre tally while shrinking — and the tally ticks up as it lands. The
 * flight is what ties cause (the kill) to effect (the score), and it is the piece
 * most browser HUDs skip.
 */

import { bus } from '../../core/EventBus';
import { clamp01, Ease, lerp, motion, motionTime, Spring, SPRING } from '../Anim';
import { hairWidth, measureText, text } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { lift, rgba, type Palette, type RGB } from '../Theme';
import { MARGIN } from '../Theme';
import type { Widget } from './Widget';

interface Popup {
  amount: number;
  label: string;
  age: number;
  /** Seconds spent in the stack before flying out. */
  hold: number;
  flight: number;
  slot: Spring;
  index: number;
  active: boolean;
  reward: boolean;
}

const CAPACITY = 10;
const FLIGHT = 0.62;

export class ScorePopups implements Widget {
  readonly name = 'score-popups';

  private readonly pool: Popup[] = [];
  private cursor = 0;
  private readonly off: Array<() => void> = [];
  private readonly tallyPunch = new Spring(0, SPRING.pop);
  private live: Popup[] = [];

  constructor(private pal: () => Palette) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        amount: 0, label: '', age: 0, hold: 1.05, flight: FLIGHT,
        slot: new Spring(0, SPRING.snappy), index: 0, active: false, reward: false,
      });
    }
    this.off.push(bus.on('score:add', (e) => this.add(e.amount, e.reason)));
  }

  add(amount: number, reason: string): void {
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;
    p.amount = amount;
    p.label = reason.toUpperCase();
    p.age = 0;
    p.hold = motionTime(1.05);
    p.active = true;
    p.reward = amount >= 250;
    p.slot.set(-1);
    p.slot.to(0);
    p.slot.kick(10);
    // Rebuild the live list newest-first and reassign stack slots.
    this.live = this.pool.filter((q) => q.active);
    this.live.sort((a, b) => a.age - b.age);
    for (let i = 0; i < this.live.length; i++) {
      this.live[i].index = i;
      if (this.live[i] !== p) this.live[i].slot.to(i);
    }
    this.tallyPunch.kick(18);
    bus.emit('ui:sound', { cue: 'xp' });
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.pool[i].active = false;
    this.live.length = 0;
  }

  update(dt: number, _m: HudModel): void {
    this.tallyPunch.to(0);
    this.tallyPunch.step(dt);
    let dirty = false;
    for (let i = 0; i < CAPACITY; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      p.age += dt;
      p.slot.step(dt);
      if (p.age >= p.hold + p.flight) { p.active = false; dirty = true; }
    }
    if (dirty) {
      this.live = this.pool.filter((q) => q.active);
      this.live.sort((a, b) => a.age - b.age);
      for (let i = 0; i < this.live.length; i++) {
        this.live[i].index = i;
        this.live[i].slot.to(i);
      }
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const cx = d.w / 2;
    const stackY = d.h * 0.712;
    const rowH = 19 * s;

    const tallyX = cx;
    const tallyY = d.h - MARGIN * s - 6 * s;

    /* ------------------------------------------------------- popups --- */
    c.save();
    for (let i = 0; i < CAPACITY; i++) {
      const q = this.pool[i];
      if (!q.active) continue;

      const flying = q.age > q.hold;
      const ft = flying ? clamp01((q.age - q.hold) / q.flight) : 0;
      const ease = Ease.inOutCubic(ft);

      const sx = cx;
      const sy = stackY + q.slot.value * rowH;
      // Quadratic path bowing outward before converging on the tally.
      const midX = lerp(sx, tallyX, 0.5) + 128 * s * motion();
      const midY = lerp(sy, tallyY, 0.5) - 10 * s;
      const x = flying
        ? (1 - ease) * (1 - ease) * sx + 2 * (1 - ease) * ease * midX + ease * ease * tallyX
        : sx;
      const y = flying
        ? (1 - ease) * (1 - ease) * sy + 2 * (1 - ease) * ease * midY + ease * ease * tallyY
        : sy;

      const appear = clamp01(q.age / motionTime(0.16));
      const scale = flying ? lerp(1, 0.52, ease) : lerp(0.7, 1, Ease.outBack(appear));
      const alpha = (flying ? 1 - Ease.inQuad(ft) : Ease.outQuad(appear)) * d.alpha;
      if (alpha <= 0.005) continue;

      const tint: RGB = q.reward ? p.accent : lift(p.accent, 0.25);
      c.save();
      c.globalAlpha = alpha;
      c.translate(x, y);
      c.scale(scale, scale);

      const amountStr = `+${q.amount}`;
      const aOpts = { size: 21 * s, weight: 700, family: 'cond' as const, tracking: 0.8 * s };
      const lOpts = { size: 11.5 * s, weight: 600, family: 'cond' as const, tracking: 3 * s };
      const aw = measureText(c, amountStr, aOpts);
      const lw = q.label ? measureText(c, q.label, lOpts) : 0;
      const gap = q.label ? 9 * s : 0;
      const total = aw + gap + lw;

      text(c, amountStr, -total / 2, 0, {
        ...aOpts, color: rgba(tint, 1), shadow: Math.max(1, 1.4 * s),
        glow: q.reward ? 12 * s : 0, glowColor: rgba(tint, 0.5),
      });
      if (q.label) {
        text(c, q.label, -total / 2 + aw + gap, -1 * s, {
          ...lOpts, color: rgba(p.inkDim, 0.92), shadow: Math.max(1, 1.1 * s),
        });
      }
      c.restore();
    }
    c.restore();

    /* -------------------------------------------------------- tally --- */
    const punch = this.tallyPunch.value;
    c.save();
    c.globalAlpha = d.alpha * (1 - m.ads * 0.45);
    c.translate(tallyX, tallyY);
    c.scale(1 + punch * 0.004, 1 + punch * 0.004);

    const scoreStr = String(Math.round(m.xp.display));
    const sOpts = { size: 22 * s, weight: 700, family: 'cond' as const, tracking: 1.6 * s };
    const w = measureText(c, scoreStr, sOpts);
    text(c, scoreStr, w / 2, 0, {
      ...sOpts, align: 'right', color: rgba(p.ink, 0.95), shadow: Math.max(1, 1.4 * s),
    });
    text(c, 'SCORE', -w / 2 - 8 * s, -1 * s, {
      size: 10.5 * s, weight: 600, family: 'cond', tracking: 3.4 * s, align: 'right',
      color: rgba(p.inkFaint, 0.85), shadow: Math.max(1, 1 * s),
    });
    c.strokeStyle = rgba(p.hair, 0.22);
    c.lineWidth = hairWidth(d.dpr);
    c.beginPath();
    c.moveTo(-w / 2 - 78 * s, 5 * s);
    c.lineTo(w / 2 + 12 * s, 5 * s);
    c.stroke();
    c.restore();
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
