/**
 * Compass strip — top centre.
 *
 * Three stacked rows inside one feathered strip:
 *
 *   objective markers   ride the strip at their true bearing, pinning to the
 *                       edge with a direction chevron when out of the window
 *   cardinal labels     N / NE / E …, majors heavier than inter-cardinals
 *   tick rule           minor every 5°, major every 15°
 *
 * A 140° window onto the heading circle. The strip is composited through a small
 * offscreen canvas so its ends can be feathered with a real alpha mask rather
 * than faked with a gradient painted over the game image.
 */

import { damp } from '../Anim';
import { chevronPath, fadeMaskH, text } from '../Draw';
import type { DrawCtx } from '../Draw';
import { objectiveMarker } from '../Glyphs';
import type { HudModel } from '../Model';
import { FONT_COND, lift, rgba, type Palette } from '../Theme';
import { LAYOUT, MARGIN } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

const SPAN_DEG = 140;

const CARDINALS: Array<[number, string, number]> = [
  [0, 'N', 2], [45, 'NE', 1], [90, 'E', 2], [135, 'SE', 1],
  [180, 'S', 2], [225, 'SW', 1], [270, 'W', 2], [315, 'NW', 1],
];

/* Row positions in design px, measured from the top of the strip. */
const ROW_MARKER = 12;
const ROW_LABEL = 42;   // text baseline
const ROW_TICK_TOP = 48;
const ROW_TICK_BASE = 62;

export class Compass implements Widget {
  readonly name = 'compass';

  private strip: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private smoothBearing = 0;
  private initialised = false;

  constructor(private pal: () => Palette) {
    this.strip = document.createElement('canvas');
    const c = this.strip.getContext('2d');
    if (!c) throw new Error('[ui] 2D context unavailable for compass strip');
    this.sctx = c;
  }

  update(dt: number, m: HudModel): void {
    if (!this.initialised) { this.smoothBearing = m.bearing; this.initialised = true; return; }
    // Unwrap so the needle never spins the long way round.
    let diff = m.bearing - this.smoothBearing;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    this.smoothBearing = damp(this.smoothBearing, this.smoothBearing + diff, 26, dt);
    if (this.smoothBearing < 0) this.smoothBearing += 360;
    if (this.smoothBearing >= 360) this.smoothBearing -= 360;
  }

  draw(d: DrawCtx, m: HudModel): void {
    if (!ui.prefs.showCompass) return;
    const p = this.pal();
    const s = d.s;
    const w = LAYOUT.compassWidth * s;
    const h = LAYOUT.compassHeight * s;
    const x = Math.round(d.w / 2 - w / 2);
    const y = Math.round(MARGIN * s * 0.42);

    const alpha = d.alpha * (1 - m.ads * 0.55);
    if (alpha <= 0.01) return;

    /* ------------------------------------------------ offscreen strip -- */
    const bw = Math.ceil(w * d.dpr);
    const bh = Math.ceil(h * d.dpr);
    if (this.strip.width !== bw || this.strip.height !== bh) {
      this.strip.width = bw;
      this.strip.height = bh;
    }
    const c = this.sctx;
    c.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const pxPerDeg = w / SPAN_DEG;
    const bearing = this.smoothBearing;
    const midX = w / 2;
    const tickBase = ROW_TICK_BASE * s;
    const tickTop = ROW_TICK_TOP * s;

    /* --- ticks ------------------------------------------------------- */
    const start = Math.floor((bearing - SPAN_DEG / 2) / 5) * 5;
    for (let deg = start; deg <= bearing + SPAN_DEG / 2 + 5; deg += 5) {
      const off = shortestDeg(bearing, deg) * pxPerDeg;
      const px = midX + off;
      if (px < -8 || px > w + 8) continue;
      const norm = ((deg % 360) + 360) % 360;
      if (norm % 45 === 0) continue; // cardinals draw their own, heavier tick
      const major = norm % 15 === 0;
      c.strokeStyle = rgba(p.ink, major ? 0.72 : 0.4);
      c.lineWidth = Math.max(1, (major ? 1.6 : 1.1) * s);
      c.beginPath();
      c.moveTo(px, tickBase);
      c.lineTo(px, major ? tickTop : tickBase - (tickBase - tickTop) * 0.5);
      c.stroke();
    }

    /* --- cardinals --------------------------------------------------- */
    for (const [deg, label, weight] of CARDINALS) {
      const off = shortestDeg(bearing, deg) * pxPerDeg;
      const px = midX + off;
      if (px < -40 || px > w + 40) continue;
      const major = weight === 2;
      c.strokeStyle = rgba(p.ink, major ? 0.95 : 0.62);
      c.lineWidth = Math.max(1, (major ? 2.2 : 1.5) * s);
      c.beginPath();
      c.moveTo(px, tickBase);
      c.lineTo(px, tickTop - (major ? 3 : 0) * s);
      c.stroke();
      text(c, label, px, ROW_LABEL * s, {
        size: (major ? 19 : 13.5) * s, weight: major ? 700 : 600, family: 'cond',
        tracking: 1.6 * s, align: 'center',
        color: rgba(major ? p.ink : p.inkDim, major ? 1 : 0.88),
        shadow: Math.max(1, 1.4 * s),
      });
    }

    /* --- objective bearings ------------------------------------------ */
    for (const obj of m.objectives.values()) {
      if (!obj.position) continue;
      const dx = obj.position.x - m.position.x;
      const dz = obj.position.z - m.position.z;
      const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
      const rel = shortestDeg(bearing, deg);
      const limit = SPAN_DEG / 2 - 7;
      const clamped = Math.max(-limit, Math.min(limit, rel));
      const px = midX + clamped * pxPerDeg;
      const offscreen = Math.abs(rel) > limit;
      const tint = obj.kind === 'hostile' ? p.hostile : obj.kind === 'friendly' ? p.friendly : p.accent;
      objectiveMarker(
        c, px, ROW_MARKER * s, 9 * s, rgba(tint, offscreen ? 0.78 : 1), obj.label,
        obj.progress ?? 0, !offscreen, `700 ${(11.5 * s).toFixed(1)}px ${FONT_COND}`,
      );
      if (offscreen) {
        c.fillStyle = rgba(tint, 0.92);
        chevronPath(c, px + (rel > 0 ? 14 : -14) * s, ROW_MARKER * s, 11 * s, 7 * s, rel > 0 ? 0 : Math.PI);
        c.fill();
      }
    }

    fadeMaskH(c, 0, 0, w, h, w * 0.13);

    /* ------------------------------------------------------ composite -- */
    const g = d.c;
    g.save();
    g.globalAlpha = alpha;

    // Baseline rule under the whole strip.
    const grad = g.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, rgba(p.hair, 0));
    grad.addColorStop(0.5, rgba(p.hair, 0.55));
    grad.addColorStop(1, rgba(p.hair, 0));
    g.fillStyle = grad;
    g.fillRect(x, y + tickBase, w, Math.max(1.2, 1.4 * s));

    g.drawImage(this.strip, 0, 0, bw, bh, x, y, w, h);

    /* ------------------------------------------------- centre marker -- */
    const cx = d.w / 2;
    g.fillStyle = 'rgba(2,5,10,0.9)';
    chevronPath(g, cx, y + tickBase - 5 * s, 19 * s, 10 * s, Math.PI / 2);
    g.fill();
    g.fillStyle = rgba(lift(p.ink, 0.45), 1);
    chevronPath(g, cx, y + tickBase - 5.5 * s, 15 * s, 8 * s, Math.PI / 2);
    g.fill();

    const bstr = String(Math.round(bearing) % 360).padStart(3, '0');
    text(g, bstr, cx, y + tickBase + 19 * s, {
      size: 16 * s, weight: 600, family: 'mono', tracking: 1.8 * s, align: 'center',
      color: rgba(p.ink, 0.97), shadow: Math.max(1, 1.4 * s),
    });

    g.restore();
  }
}

/** Signed shortest difference between two headings, in degrees. */
function shortestDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
