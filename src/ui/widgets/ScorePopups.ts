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
import { hairWidth, measureText, plate, text, wash } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { sightRadius } from '../Sight';
import { ADS_FADE, adsFade, lift, rgba, type Palette, type RGB } from '../Theme';
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
    // Score tick audio is owned by Audio on `score:add` (pickup). Emitting `xp`
    // here double-fired the kill-confirm sandwich with hitKill from HitMarkers.
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
    // The centre column below the reticle belongs to the interaction prompt.
    // XP lands in its own column right of centre and stacks downward — the same
    // separation shipped titles use so a capture prompt and a kill reward can
    // coexist in one frame without piling up on each other.
    // Held at least a sight radius clear of centre so the column never creeps
    // onto the optic when the player aims (the exclusion widens with ADS).
    const stackX = cx + Math.max(172 * s, sightRadius(d, m) + 46 * s);
    const stackY = d.h * 0.565;
    // Rows must clear the 22px type with room to breathe; at 19 they collided
    // whenever two events landed inside the spring's settle time.
    const rowH = 27 * s;

    const tallyX = cx;
    const tallyY = d.h - MARGIN * s - 6 * s;

    /* ------------------------------------------------------- popups --- */
    // One shared wash under the whole stack rather than one per row, so the
    // darkening does not double up where rows overlap mid-animation.
    let liveRows = 0;
    for (let i = 0; i < CAPACITY; i++) if (this.pool[i].active && this.pool[i].age <= this.pool[i].hold) liveRows++;
    if (liveRows > 0 && !d.cheap) {
      c.save();
      c.globalAlpha = d.alpha * 0.9;
      wash(c, stackX, stackY + (liveRows - 1) * rowH * 0.5 - 4 * s,
        170 * s, (24 + liveRows * rowH / s * 0.5) * s, 0.42);
      c.restore();
    }

    c.save();
    for (let i = 0; i < CAPACITY; i++) {
      const q = this.pool[i];
      if (!q.active) continue;

      const flying = q.age > q.hold;
      const ft = flying ? clamp01((q.age - q.hold) / q.flight) : 0;
      const ease = Ease.inOutCubic(ft);

      const sx = stackX;
      const sy = stackY + q.slot.value * rowH;
      // Quadratic path bowing outward before converging on the tally.
      const midX = lerp(sx, tallyX, 0.5) + 110 * s * motion();
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

      // Score is the loudest thing on a busy frame precisely because it is the
      // least urgent — it costs nothing to miss one. *Every* award runs in the
      // neutral ramp, including killstreak-tier ones: a "+300" in the accent
      // stacked directly above a "+150" in white made the hue look arbitrary,
      // and the accent has to mean "objective" and nothing else. A reward is
      // told apart by value and weight instead — brighter, larger, and haloed
      // in the accent rather than filled with it.
      const tint: RGB = lift(p.ink, q.reward ? 0.42 : 0.2);
      c.save();
      c.globalAlpha = alpha;
      c.translate(x, y);
      c.scale(scale, scale);

      // Two fixed columns hinged on the centre line: the amount is right-aligned
      // into the left column and the reason left-aligned into the right one, so
      // a stack of "+25 HIT / +150 HEADSHOT" lines up on the digits the way a
      // shipped feed does instead of centring each row independently.
      const amountStr = `+${q.amount}`;
      const aOpts = {
        size: (q.reward ? 25 : 20) * s, weight: 700, family: 'cond' as const, tracking: 0.4 * s,
      };
      const lOpts = { size: 11 * s, weight: 600, family: 'cond' as const, tracking: 2.6 * s };
      const hinge = 6 * s;

      text(c, amountStr, -hinge, 0, {
        ...aOpts, align: 'right', color: rgba(tint, q.reward ? 1 : 0.92),
        shadow: Math.max(1, 1.3 * s), outline: 2.6 * s,
        glow: q.reward ? 16 * s : 0, glowColor: rgba(p.accent, 0.55),
      });
      if (q.label) {
        text(c, q.label, hinge, -1.5 * s, {
          ...lOpts, color: rgba(q.reward ? lift(p.ink, 0.2) : p.inkDim, q.reward ? 0.95 : 0.86),
          shadow: Math.max(1, 1 * s), outline: 2.2 * s,
        });
      }
      c.restore();
    }
    c.restore();

    /* -------------------------------------------------------- tally --- */
    const punch = this.tallyPunch.value;
    c.save();
    c.globalAlpha = adsFade(d.alpha, m.ads, ADS_FADE.ambient);
    c.translate(tallyX, tallyY);
    c.scale(1 + punch * 0.004, 1 + punch * 0.004);

    const scoreStr = String(Math.round(m.xp.display));
    const sOpts = { size: 22 * s, weight: 700, family: 'cond' as const, tracking: 1.6 * s };
    const w = measureText(c, scoreStr, sOpts);
    text(c, scoreStr, w / 2, 0, {
      ...sOpts, align: 'right', color: rgba(p.ink, 0.95),
      shadow: Math.max(1, 1.3 * s), outline: 2.6 * s,
    });
    text(c, 'SCORE', -w / 2 - 8 * s, -1 * s, {
      size: 10.5 * s, weight: 600, family: 'cond', tracking: 3.4 * s, align: 'right',
      color: rgba(p.inkDim, 0.8), shadow: Math.max(1, 1 * s), outline: 2 * s,
    });
    c.strokeStyle = rgba(p.hair, 0.26);
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
