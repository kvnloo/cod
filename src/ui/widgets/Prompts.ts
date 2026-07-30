/**
 * Contextual prompts.
 *
 *  · interaction prompt with a hold progress ring driven by the real `use` action
 *  · reload prompt when the magazine runs dry
 *  · low-ammo warning
 *  · "you are down" / spectate line
 *
 * The hold ring is the piece with teeth: it reads `input.held('use')` directly,
 * accumulates against the prompt's own duration, snaps back with a spring if the
 * player lets go early, and emits a completion cue on the bus. Gameplay only has
 * to publish the prompt and listen for the completion.
 */

import { bus } from '../../core/EventBus';
import { input } from '../../core/Input';
import { clamp01, damp, Ease, Envelope, motion, Spring, SPRING } from '../Anim';
import { chamferPath, hairWidth, measureText, text, wash } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { aboveSightY, belowSightY } from '../Sight';
import { lift, rgba, type Palette } from '../Theme';
import type { UiPromptRequest } from '../UiEvents';
import type { Widget } from './Widget';

export class Prompts implements Widget {
  readonly name = 'prompts';

  private prompt: UiPromptRequest | null = null;
  private progress = 0;
  private readonly appear = new Spring(0, SPRING.snappy);
  private readonly complete = new Envelope(0.05, 0.06, 0.42);
  private readonly off: Array<() => void> = [];
  private t = 0;
  /** Seconds of decay suppression after an external `setProgress`. */
  private externalHold = 0;

  constructor(private pal: () => Palette) {
    this.off.push(bus.on('ui:prompt', (e) => this.show(e.prompt)));
  }

  show(prompt: UiPromptRequest | null): void {
    if (!prompt) { this.prompt = null; this.appear.to(0); return; }
    if (this.prompt?.id !== prompt.id) this.progress = 0;
    this.prompt = prompt;
    this.appear.to(1);
    this.appear.kick(7);
  }

  /**
   * Externally driven progress, for holds simulated by gameplay or posed by a
   * capture. Suppresses the auto-rewind for a beat so the value survives the
   * frames that follow the call.
   */
  setProgress(v: number): void {
    this.progress = clamp01(v);
    this.externalHold = 0.75;
  }

  update(dt: number, m: HudModel): void {
    this.t += dt;
    this.appear.to(this.prompt && !m.menuOpen ? 1 : 0);
    this.appear.step(dt);
    this.complete.step(dt);

    if (this.externalHold > 0) this.externalHold = Math.max(0, this.externalHold - dt);

    const p = this.prompt;
    if (p && p.hold && p.hold > 0) {
      if (input.held('use')) {
        this.externalHold = 0;
        this.progress += dt / p.hold;
        if (this.progress >= 1) {
          this.progress = 1;
          this.complete.fire();
          bus.emit('ui:sound', { cue: 'promptComplete' });
          this.prompt = null;
          this.appear.to(0);
        }
      } else if (this.externalHold <= 0) {
        // Releasing early rewinds rather than snapping to zero.
        this.progress = damp(this.progress, 0, 6.5, dt);
        if (this.progress < 0.002) this.progress = 0;
      }
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const cx = d.w / 2;

    /* --------------------------------------------- interaction prompt -- */
    const vis = this.appear.value;
    if (vis > 0.004 && this.prompt) {
      const q = this.prompt;
      // Authored position at the hip, pushed clear of the optic as the player
      // aims. A key cap and a hold ring painted on the glass of a sight is the
      // loudest possible "laid out in screen percentages" tell.
      const y = belowSightY(d, m, 26, d.h * 0.605)
        + (1 - Ease.outBack(clamp01(vis))) * 12 * s * motion();
      const r = 17 * s;

      c.save();
      c.globalAlpha = d.alpha * clamp01(vis);

      // Local darkening so the cap, the ring and both text rows read against a
      // sunlit street without any of them needing a solid box.
      if (!d.cheap) wash(c, cx, y + 16 * s, 190 * s, 62 * s, 0.42);

      // Key cap.
      const capR = r * 0.72;
      chamferPath(c, cx - capR, y - capR, capR * 2, capR * 2, 4 * s);
      c.fillStyle = 'rgba(6,10,16,0.72)';
      c.fill();
      c.lineWidth = Math.max(1, 1.2 * s);
      c.strokeStyle = rgba(p.ink, 0.7);
      c.stroke();
      text(c, q.key ?? 'F', cx, y + capR * 0.42, {
        size: 16 * s, weight: 700, family: 'cond', align: 'center',
        color: rgba(p.ink, 1),
      });

      // Hold ring.
      if (q.hold && q.hold > 0) {
        c.lineWidth = Math.max(1.6, 2.6 * s);
        c.strokeStyle = rgba(p.hair, 0.22);
        c.beginPath();
        c.arc(cx, y, r, 0, Math.PI * 2);
        c.stroke();

        if (this.progress > 0.001) {
          // An interaction is not an objective. The ring runs in the neutral
          // ink ramp; only the marker that says *where the objective is* keeps
          // the accent.
          c.strokeStyle = rgba(lift(p.ink, 0.4), 1);
          c.lineCap = 'round';
          c.beginPath();
          c.arc(cx, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.progress);
          c.stroke();
          c.lineCap = 'butt';
          // Leading dot.
          const a = -Math.PI / 2 + Math.PI * 2 * this.progress;
          c.fillStyle = rgba(lift(p.ink, 0.7), 1);
          c.beginPath();
          c.arc(cx + Math.cos(a) * r, y + Math.sin(a) * r, 2.4 * s, 0, Math.PI * 2);
          c.fill();
        }
      }

      // Label + detail.
      text(c, q.label.toUpperCase(), cx, y + r + 20 * s, {
        size: 15 * s, weight: 600, family: 'cond', tracking: 4.2 * s, align: 'center',
        color: rgba(p.ink, 0.96), shadow: Math.max(1, 1.3 * s),
      });
      if (q.detail) {
        text(c, q.detail.toUpperCase(), cx, y + r + 35 * s, {
          size: 11 * s, weight: 600, family: 'cond', tracking: 3 * s, align: 'center',
          color: rgba(p.inkDim, 0.9), outline: 2 * s,
        });
      }
      c.restore();
    }

    // Completion flash.
    const done = this.complete.level;
    if (done > 0.01) {
      c.save();
      c.globalAlpha = d.alpha * done;
      c.strokeStyle = rgba(lift(p.ink, 0.5), 1);
      c.lineWidth = Math.max(1, 2 * s * done);
      c.beginPath();
      c.arc(cx, belowSightY(d, m, 26, d.h * 0.605), (17 + (1 - done) * 26) * s, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    /* ------------------------------------------------------- reload ---- */
    // There is deliberately nothing here.
    //
    // A dry magazine used to print "RELOAD / [ R ]" in the centre column. Even
    // pushed clear of the aperture by `aboveSightY` it still landed a third of
    // the way up the frame, dead centre, on the one axis a player is looking
    // down — and it said exactly what the ammunition readout was already
    // saying two hundred pixels away in the corner, in red, flashing, next to
    // a "0". Two prompts for one fact, one of them in the sight line.
    //
    // The corner tag is the whole cue now (see `AmmoPanel`). Nothing in this
    // widget draws in the centre column except the interaction prompt, which
    // is anchored below the aperture and only appears when the player is
    // standing next to something they can use.

    /* ------------------------------------------------------- downed ---- */
    if (!m.alive) {
      c.save();
      c.globalAlpha = d.alpha;
      text(c, 'YOU ARE DOWN', cx, d.h * 0.5, {
        size: 34 * s, weight: 700, family: 'cond', tracking: 9 * s, align: 'center',
        color: rgba(p.hostile, 0.95), shadow: Math.max(1.4, 2 * s),
        glow: 18 * s, glowColor: rgba(p.hostile, 0.4),
      });
      c.restore();
    }
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
