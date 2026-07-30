/**
 * Low-health feedback.
 *
 * Three cooperating layers:
 *   1. a request to the render API (`screenEffect({ damage })`) so the engine's
 *      own post chain does the heavy lifting when it is available;
 *   2. a CSS `mix-blend-mode: saturation` plate over the viewport, which
 *      genuinely desaturates the rendered frame from the overlay without needing
 *      a new render pass;
 *   3. a canvas vignette that pulses on a two-beat heartbeat rhythm, plus a
 *      short red flash on each hit.
 *
 * All three scale with the same `criticalAmount` so they read as one effect, and
 * all three are skipped entirely when the accessibility option is off.
 */

import { bus } from '../../core/EventBus';
import { clamp01, damp, Ease, Envelope, motion } from '../Anim';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import type { RenderAPI } from '../../render/types';
import { rgba, type Palette } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

export class Vignette implements Widget {
  readonly name = 'vignette';

  private readonly hitFlash = new Envelope(0.02, 0.04, 0.42);
  private t = 0;
  private lastRequest = 0;
  /**
   * Smoothed in JS rather than with a CSS transition: the capture harness pumps
   * simulation frames without advancing wall-clock time, and a CSS transition
   * would never run.
   */
  private desatAmount = 0;
  private readonly off: Array<() => void> = [];

  constructor(
    private pal: () => Palette,
    private render: () => RenderAPI | null,
    private desat: HTMLElement | null,
  ) {
    this.off.push(bus.on('damage:taken', () => this.hitFlash.fire()));
  }

  /** Fires the red edge flash directly (debug scenes, scripted damage). */
  flash(): void { this.hitFlash.fire(); }

  update(dt: number, m: HudModel): void {
    this.t += dt;
    this.hitFlash.step(dt);

    const crit = ui.prefs.lowHealthEffects ? m.criticalAmount : 0;

    // Ask the renderer for the authoritative damage vignette. Requests
    // accumulate per frame in the render system, so send it every frame while
    // critical and let it decay naturally otherwise.
    if (crit > 0.01) {
      const api = this.render();
      const beat = heartbeat(this.t);
      api?.screenEffect({ damage: { intensity: Math.min(0.85, crit * (0.42 + 0.28 * beat)) } });
      this.lastRequest = crit;
    } else if (this.lastRequest > 0) {
      this.lastRequest = 0;
    }

    // Desaturation plate.
    const target = crit > 0.01 ? Math.min(0.72, crit * 0.8) : 0;
    this.desatAmount = damp(this.desatAmount, target, 6.5, dt);
    if (this.desatAmount < 0.002) this.desatAmount = 0;
    if (this.desat) {
      const want = this.desatAmount.toFixed(3);
      if (this.desat.style.opacity !== want) this.desat.style.opacity = want;
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    const crit = ui.prefs.lowHealthEffects ? m.criticalAmount : 0;
    const flash = this.hitFlash.level;
    if (crit <= 0.005 && flash <= 0.005) return;

    const p = this.pal();
    const c = d.c;
    const cx = d.w / 2;
    const cy = d.h / 2;
    const outer = Math.hypot(cx, cy);

    c.save();

    if (crit > 0.005) {
      const beat = heartbeat(this.t) * motion();
      const intensity = clamp01(crit) * (0.34 + 0.3 * beat);
      const inner = outer * (0.30 - crit * 0.1 - beat * 0.045);
      const g = c.createRadialGradient(cx, cy, inner, cx, cy, outer);
      g.addColorStop(0, rgba(p.hostile, 0));
      g.addColorStop(0.55, rgba(p.hostile, intensity * 0.20));
      g.addColorStop(1, rgba(p.hostile, intensity * 0.78));
      c.fillStyle = g;
      c.fillRect(0, 0, d.w, d.h);

      // Darkening at the very edge keeps it from looking like a red filter.
      const dark = c.createRadialGradient(cx, cy, outer * 0.42, cx, cy, outer);
      dark.addColorStop(0, 'rgba(0,0,0,0)');
      dark.addColorStop(1, `rgba(2,0,0,${(0.34 * crit).toFixed(3)})`);
      c.fillStyle = dark;
      c.fillRect(0, 0, d.w, d.h);
    }

    if (flash > 0.005) {
      const g = c.createRadialGradient(cx, cy, outer * 0.18, cx, cy, outer);
      g.addColorStop(0, rgba(p.hostile, 0));
      g.addColorStop(1, rgba(p.hostile, Ease.outQuad(flash) * 0.42));
      c.fillStyle = g;
      c.fillRect(0, 0, d.w, d.h);
    }

    c.restore();
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    if (this.desat) this.desat.style.opacity = '0';
  }
}

/** Two-beat cardiac rhythm in [0,1], period ≈ 1.05 s. */
function heartbeat(t: number): number {
  const x = (t % 1.05) / 1.05;
  const a = Math.exp(-Math.pow((x - 0.08) / 0.055, 2));
  const b = 0.62 * Math.exp(-Math.pow((x - 0.26) / 0.07, 2));
  return clamp01(a + b);
}
