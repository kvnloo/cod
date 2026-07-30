/**
 * Canvas 2D drawing helpers shared by every HUD widget.
 *
 * The house style is: 1-device-pixel hairlines, chamfered (not rounded) corners,
 * condensed uppercase type with generous tracking, a dark contact shadow under
 * everything so the HUD survives a bright sky, and an optional chromatic fringe
 * on emphasised elements.
 *
 * Nothing here allocates per call beyond the odd string, and colour strings come
 * from the memoised helpers in Theme.
 */

import { FONT_COND, FONT_MONO, FONT_SANS, rgba, type RGB } from './Theme';

export type FontFamily = 'cond' | 'sans' | 'mono';

export interface DrawCtx {
  c: CanvasRenderingContext2D;
  /** CSS pixel width / height of the overlay. */
  w: number;
  h: number;
  /** Design-pixel → CSS-pixel scale (viewport size × user hudScale). */
  s: number;
  /** Device pixel ratio of the backing store. */
  dpr: number;
  /** Seconds since HUD start. */
  t: number;
  /** Frame delta. */
  dt: number;
  /** Global HUD opacity multiplier. */
  alpha: number;
  /** True when the cheap path should be taken (low quality preset). */
  cheap: boolean;
}

const FAMILY: Record<FontFamily, string> = {
  cond: FONT_COND,
  sans: FONT_SANS,
  mono: FONT_MONO,
};

/* ---------------------------------------------------------------- text ---- */

let letterSpacingSupported: boolean | null = null;

function supportsLetterSpacing(c: CanvasRenderingContext2D): boolean {
  if (letterSpacingSupported === null) {
    letterSpacingSupported = 'letterSpacing' in c;
  }
  return letterSpacingSupported;
}

export interface TextOptions {
  size: number;
  weight?: number;
  family?: FontFamily;
  /** Letter spacing in the same units as `size`. */
  tracking?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  color?: string;
  /** Dark contact shadow offset in px; 0 disables. */
  shadow?: number;
  /** Outer glow radius in px. */
  glow?: number;
  glowColor?: string;
  /** Chromatic fringe strength in px; adds red/cyan ghosts behind the glyphs. */
  chroma?: number;
  alpha?: number;
  /** Horizontal squeeze applied when the condensed webfont is unavailable. */
  condense?: number;
}

export function setFont(
  c: CanvasRenderingContext2D, size: number, weight = 600, family: FontFamily = 'cond',
): void {
  c.font = `${weight} ${size.toFixed(1)}px ${FAMILY[family]}`;
}

/** Measures a string with the same options `text()` would use. */
export function measureText(c: CanvasRenderingContext2D, str: string, o: TextOptions): number {
  setFont(c, o.size, o.weight ?? 600, o.family ?? 'cond');
  const track = o.tracking ?? 0;
  if (track && supportsLetterSpacing(c)) {
    c.letterSpacing = `${track.toFixed(2)}px`;
    const w = c.measureText(str).width;
    c.letterSpacing = '0px';
    return w;
  }
  const w = c.measureText(str).width;
  return track ? w + track * Math.max(0, str.length - 1) : w;
}

/**
 * Draws a run of text. Returns the advance width.
 *
 * Tracking uses the native `letterSpacing` when available and falls back to
 * manual per-glyph placement so the look is identical in older engines.
 */
export function text(
  c: CanvasRenderingContext2D, str: string, x: number, y: number, o: TextOptions,
): number {
  const weight = o.weight ?? 600;
  const family = o.family ?? 'cond';
  const track = o.tracking ?? 0;
  const align = o.align ?? 'left';
  const alpha = o.alpha ?? 1;
  if (alpha <= 0.002 || !str) return 0;

  setFont(c, o.size, weight, family);
  c.textBaseline = o.baseline ?? 'alphabetic';

  const native = track === 0 || supportsLetterSpacing(c);
  if (native && track !== 0) c.letterSpacing = `${track.toFixed(2)}px`;

  const width = native
    ? c.measureText(str).width
    : c.measureText(str).width + track * Math.max(0, str.length - 1);

  let ox = x;
  if (align === 'center') ox = x - width / 2;
  else if (align === 'right' || align === 'end') ox = x - width;

  const prevAlpha = c.globalAlpha;
  c.globalAlpha = prevAlpha * alpha;
  c.textAlign = 'left';

  const paint = (fill: string, dx: number, dy: number, blur: number, blurColor?: string): void => {
    c.fillStyle = fill;
    if (blur > 0) {
      c.shadowColor = blurColor ?? fill;
      c.shadowBlur = blur;
      c.shadowOffsetX = 0;
      c.shadowOffsetY = 0;
    }
    if (native) {
      c.fillText(str, ox + dx, y + dy);
    } else {
      let px = ox + dx;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        c.fillText(ch, px, y + dy);
        px += c.measureText(ch).width + track;
      }
    }
    if (blur > 0) { c.shadowBlur = 0; c.shadowColor = 'transparent'; }
  };

  const color = o.color ?? '#dce6f4';

  if (o.shadow) {
    const prev = c.globalAlpha;
    c.globalAlpha = prev * 0.62;
    paint('rgba(0,2,5,0.95)', o.shadow, o.shadow, 0);
    c.globalAlpha = prev;
  }
  if (o.chroma) {
    const prev = c.globalAlpha;
    c.globalAlpha = prev * 0.5;
    paint('rgba(255,60,90,1)', -o.chroma, 0, 0);
    paint('rgba(60,220,255,1)', o.chroma, 0, 0);
    c.globalAlpha = prev;
  }
  if (o.glow) paint(o.glowColor ?? color, 0, 0, o.glow, o.glowColor ?? color);
  paint(color, 0, 0, 0);

  if (native && track !== 0) c.letterSpacing = '0px';
  c.globalAlpha = prevAlpha;
  return width;
}

/* --------------------------------------------------------------- paths ---- */

/** Crisp 1-device-pixel line width in CSS units. */
export function hairWidth(dpr: number): number {
  return 1 / Math.max(1, dpr);
}

/** Aligns a coordinate so a stroke of `lw` lands on whole device pixels. */
export function snap(v: number, dpr: number, lw: number): number {
  const d = Math.max(1, dpr);
  const half = ((lw * d) % 2) / 2;
  return (Math.round(v * d - half) + half) / d;
}

export function line(
  c: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number,
): void {
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
}

/** Rectangle with cut (chamfered) corners — the module's signature frame shape. */
export function chamferPath(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cut: number,
  corners: [boolean, boolean, boolean, boolean] = [true, true, true, true],
): void {
  const k = Math.min(cut, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + (corners[0] ? k : 0), y);
  c.lineTo(x + w - (corners[1] ? k : 0), y);
  if (corners[1]) c.lineTo(x + w, y + k);
  c.lineTo(x + w, y + h - (corners[2] ? k : 0));
  if (corners[2]) c.lineTo(x + w - k, y + h);
  c.lineTo(x + (corners[3] ? k : 0), y + h);
  if (corners[3]) c.lineTo(x, y + h - k);
  c.lineTo(x, y + (corners[0] ? k : 0));
  if (corners[0]) c.closePath();
  else c.closePath();
}

export function roundRectPath(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const k = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + k, y);
  c.arcTo(x + w, y, x + w, y + h, k);
  c.arcTo(x + w, y + h, x, y + h, k);
  c.arcTo(x, y + h, x, y, k);
  c.arcTo(x, y, x + w, y, k);
  c.closePath();
}

/** Four corner brackets — reads as "targeting frame" without boxing the content in. */
export function corners(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, len: number,
): void {
  c.beginPath();
  c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y);
  c.moveTo(x + w - len, y); c.lineTo(x + w, y); c.lineTo(x + w, y + len);
  c.moveTo(x + w, y + h - len); c.lineTo(x + w, y + h); c.lineTo(x + w - len, y + h);
  c.moveTo(x + len, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - len);
  c.stroke();
}

export function diamondPath(
  c: CanvasRenderingContext2D, x: number, y: number, r: number,
): void {
  c.beginPath();
  c.moveTo(x, y - r);
  c.lineTo(x + r, y);
  c.lineTo(x, y + r);
  c.lineTo(x - r, y);
  c.closePath();
}

export function trianglePath(
  c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number,
): void {
  c.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = rot - Math.PI / 2 + (i * Math.PI * 2) / 3;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
}

/** Chevron pointing along `rot`, centred on (x,y). */
export function chevronPath(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rot: number,
): void {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const pt = (lx: number, ly: number): [number, number] => [
    x + lx * cos - ly * sin,
    y + lx * sin + ly * cos,
  ];
  const a = pt(h / 2, 0);
  const b = pt(-h / 2, -w / 2);
  const d = pt(-h / 2, w / 2);
  c.beginPath();
  c.moveTo(b[0], b[1]);
  c.lineTo(a[0], a[1]);
  c.lineTo(d[0], d[1]);
}

/** Annular wedge (a slice of a ring) centred at (cx,cy). */
export function wedgePath(
  c: CanvasRenderingContext2D, cx: number, cy: number,
  rInner: number, rOuter: number, a0: number, a1: number,
): void {
  c.beginPath();
  c.arc(cx, cy, rOuter, a0, a1, false);
  c.arc(cx, cy, rInner, a1, a0, true);
  c.closePath();
}

/* --------------------------------------------------------------- fills ---- */

/** Panel background with the house gradient + hairline + optional corner brackets. */
export function panel(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  o: {
    cut?: number; fill?: RGB; fillAlpha?: number; hair?: RGB; hairAlpha?: number;
    dpr?: number; bracket?: number; bracketColor?: string;
  } = {},
): void {
  const cut = o.cut ?? 8;
  const fill = o.fill ?? ([0x08, 0x0c, 0x12] as RGB);
  const g = c.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, rgba(fill, (o.fillAlpha ?? 0.52) * 1.05));
  g.addColorStop(1, rgba(fill, (o.fillAlpha ?? 0.52) * 0.72));
  chamferPath(c, x, y, w, h, cut);
  c.fillStyle = g;
  c.fill();
  if (o.hair) {
    c.lineWidth = hairWidth(o.dpr ?? 1);
    c.strokeStyle = rgba(o.hair, o.hairAlpha ?? 0.22);
    c.stroke();
  }
  if (o.bracket) {
    c.lineWidth = Math.max(1, (o.dpr ?? 1) > 1 ? 1.2 : 1);
    c.strokeStyle = o.bracketColor ?? rgba(o.hair ?? fill, 0.55);
    corners(c, x, y, w, h, o.bracket);
  }
}

/** Horizontal gradient fade used to mask strip edges (compass, killfeed). */
export function fadeMaskH(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, edge: number,
): void {
  const g = c.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(Math.min(0.49, edge / w), 'rgba(0,0,0,1)');
  g.addColorStop(Math.max(0.51, 1 - edge / w), 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  const prev = c.globalCompositeOperation;
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  c.globalCompositeOperation = prev;
}

/** Segmented bar (health, progress) with a hot leading edge. */
export function meter(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  value01: number, color: RGB, o: { segments?: number; track?: RGB; glow?: number; ghost?: number } = {},
): void {
  const v = value01 < 0 ? 0 : value01 > 1 ? 1 : value01;
  const track = o.track ?? ([0x9d, 0xb2, 0xcc] as RGB);
  c.fillStyle = rgba(track, 0.13);
  c.fillRect(x, y, w, h);

  if (o.ghost !== undefined && o.ghost > v) {
    c.fillStyle = rgba(color, 0.2);
    c.fillRect(x + w * v, y, w * (o.ghost - v), h);
  }

  if (v > 0) {
    const g = c.createLinearGradient(x, y, x + w * v, y);
    g.addColorStop(0, rgba(color, 0.72));
    g.addColorStop(1, rgba(color, 1));
    c.fillStyle = g;
    c.fillRect(x, y, w * v, h);
    if (o.glow) {
      c.shadowColor = rgba(color, 0.8);
      c.shadowBlur = o.glow;
      c.fillRect(x + w * v - Math.min(3, w * v), y, Math.min(3, w * v), h);
      c.shadowBlur = 0;
      c.shadowColor = 'transparent';
    }
  }

  const segs = o.segments ?? 0;
  if (segs > 1) {
    c.fillStyle = 'rgba(0,3,7,0.85)';
    for (let i = 1; i < segs; i++) {
      c.fillRect(x + (w * i) / segs - 0.5, y, 1, h);
    }
  }
}

/* ------------------------------------------------------------- shadows ---- */

export function withGlow(
  c: CanvasRenderingContext2D, color: string, blur: number, fn: () => void,
): void {
  c.shadowColor = color;
  c.shadowBlur = blur;
  fn();
  c.shadowBlur = 0;
  c.shadowColor = 'transparent';
}

/* --------------------------------------------------------------- misc ----- */

/** Formats an integer with a fixed minimum width, space padded. */
export function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Formats mm:ss. */
export function clockString(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
