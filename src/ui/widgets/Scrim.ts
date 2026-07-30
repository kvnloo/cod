/**
 * HUD safe-area scrim.
 *
 * A very slight darkening at the top and bottom edges and in the corners. It is
 * almost invisible on its own, but it is what lets thin near-white type survive a
 * blown-out sky or a white wall without resorting to heavy boxes behind every
 * element — the same trick every shipped shooter uses.
 *
 * Six full-screen gradient fills per frame is the single most expensive thing the
 * overlay could do, so the whole thing is baked into an offscreen canvas and
 * re-baked only when the viewport or the HUD scale changes; the per-frame cost is
 * one `drawImage`. It scales back while aiming down sights so the scrim never
 * fights the sight picture.
 */

import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import type { Widget } from './Widget';

export class Scrim implements Widget {
  readonly name = 'scrim';

  private cache: HTMLCanvasElement | null = null;
  private signature = '';

  update(_dt: number, _m: HudModel): void { /* stateless */ }

  draw(d: DrawCtx, m: HudModel): void {
    const a = d.alpha * (1 - m.ads * 0.55);
    if (a <= 0.01) return;

    const sig = `${d.w}x${d.h}x${d.s.toFixed(2)}x${d.cheap ? 1 : 0}`;
    if (sig !== this.signature || !this.cache) {
      this.signature = sig;
      this.bake(d);
    }
    const cv = this.cache;
    if (!cv) return;

    const c = d.c;
    c.save();
    c.globalAlpha = a;
    c.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, d.w, d.h);
    c.restore();
  }

  /** Renders the scrim once at half resolution — it is all soft gradients. */
  private bake(d: DrawCtx): void {
    const scale = 0.5;
    const w = Math.max(2, Math.round(d.w * scale));
    const h = Math.max(2, Math.round(d.h * scale));
    const cv = this.cache ?? document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    this.cache = cv;
    const c = cv.getContext('2d');
    if (!c) return;

    c.clearRect(0, 0, w, h);
    const s = d.s * scale;

    // Golden hour puts a near-white sky at the top of frame and a sunlit stone
    // street at the bottom, so both bands have to carry real weight. The curve
    // is deliberately biased to the outer third — the middle of the frame, where
    // the player is actually looking, is left alone.
    const topH = 190 * s;
    const top = c.createLinearGradient(0, 0, 0, topH);
    top.addColorStop(0, 'rgba(2,5,9,0.58)');
    top.addColorStop(0.34, 'rgba(2,5,9,0.26)');
    top.addColorStop(0.7, 'rgba(2,5,9,0.07)');
    top.addColorStop(1, 'rgba(2,5,9,0)');
    c.fillStyle = top;
    c.fillRect(0, 0, w, topH);

    const botH = 250 * s;
    const bot = c.createLinearGradient(0, h - botH, 0, h);
    bot.addColorStop(0, 'rgba(2,5,9,0)');
    bot.addColorStop(0.32, 'rgba(2,5,9,0.09)');
    bot.addColorStop(0.68, 'rgba(2,5,9,0.30)');
    bot.addColorStop(1, 'rgba(2,5,9,0.62)');
    c.fillStyle = bot;
    c.fillRect(0, h - botH, w, botH);

    // Corner pools under the four HUD clusters. The low preset keeps the two
    // edge gradients and skips these.
    if (d.cheap) return;
    const r = Math.min(w, h) * 0.46;
    const pool = (x: number, y: number, strength: number): void => {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(2,5,9,${strength})`);
      g.addColorStop(0.55, `rgba(2,5,9,${(strength * 0.4).toFixed(3)})`);
      g.addColorStop(1, 'rgba(2,5,9,0)');
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    };
    pool(0, 0, 0.34);
    pool(w, 0, 0.30);
    pool(0, h, 0.38);
    pool(w, h, 0.40);
  }
}
