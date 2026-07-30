/**
 * Canvas plotting for the audio debug scene.
 *
 * Everything audio produces is invisible, so this module makes it visible:
 * waveform envelopes, log-frequency spectrograms, spectrum overlays and metric
 * tables, drawn into canvases that become textures on planes in the debug
 * scene. That is what makes a screenshot a real verification of a sound.
 */

import type { SoundMetrics, Spectrogram } from './Analysis';
import { spectrogram } from './Analysis';

export const PANEL_W = 1024;
export const PANEL_H = 576;

const BG = '#0a0d11';
const PANEL = '#10151c';
const GRID = '#1e2836';
const AXIS = '#43536a';
const TEXT = '#c9d6e5';
const DIM = '#7c8da0';
const ACCENT = '#f0a63c';
const GOOD = '#4ad07a';
const BAD = '#ff5a5a';

/** Perceptually-ordered ramp for spectrogram magnitude (dark → hot). */
function magma(t: number): [number, number, number] {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  // Piecewise fit of the magma colormap — five anchors, linear between.
  const stops: Array<[number, number, number, number]> = [
    [0.0, 6, 6, 16],
    [0.25, 60, 20, 90],
    [0.5, 140, 40, 100],
    [0.72, 220, 82, 71],
    [0.88, 250, 160, 70],
    [1.0, 252, 253, 191],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const f = (x - a[0]) / (b[0] - a[0]);
      return [
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
        Math.round(a[3] + (b[3] - a[3]) * f),
      ];
    }
  }
  return [252, 253, 191];
}

export function newCanvas(w = PANEL_W, h = PANEL_H): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ------------------------------------------------------------- waveform -- */

export function drawWaveform(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  data: Float32Array, sampleRate: number, colour = ACCENT,
): void {
  g.fillStyle = PANEL;
  roundRect(g, x, y, w, h, 4); g.fill();

  // Auto-scale. An impulse response normalised to unit energy peaks 30 dB below
  // full scale; drawn against a fixed ±1 axis it is a flat line, which tells the
  // reader nothing. The gain applied is printed so the plot stays honest.
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  const scale = peak > 1e-6 && peak < 0.85 ? 0.92 / peak : 1;

  // Grid: amplitude lines at 0, ±0.5, ±1 and a time ruler every 100 ms.
  g.strokeStyle = GRID; g.lineWidth = 1;
  g.beginPath();
  for (const a of [-1, -0.5, 0, 0.5, 1]) {
    const yy = Math.round(y + h * 0.5 - a * h * 0.47) + 0.5;
    g.moveTo(x, yy); g.lineTo(x + w, yy);
  }
  const dur = data.length / sampleRate;
  const step = dur > 2.5 ? 0.5 : dur > 0.8 ? 0.2 : 0.05;
  for (let t = step; t < dur; t += step) {
    const xx = Math.round(x + (t / dur) * w) + 0.5;
    g.moveTo(xx, y); g.lineTo(xx, y + h);
  }
  g.stroke();

  g.strokeStyle = AXIS; g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, Math.round(y + h * 0.5) + 0.5); g.lineTo(x + w, Math.round(y + h * 0.5) + 0.5);
  g.stroke();

  // Min/max envelope per column: honest at any zoom level.
  g.fillStyle = colour;
  const n = data.length;
  for (let px = 0; px < w; px++) {
    const i0 = Math.floor((px / w) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / w) * n));
    let lo = 0, hi = 0;
    for (let i = i0; i < i1 && i < n; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const yTop = y + h * 0.5 - hi * scale * h * 0.47;
    const yBot = y + h * 0.5 - lo * scale * h * 0.47;
    g.fillRect(x + px, yTop, 1, Math.max(1, yBot - yTop));
  }

  // Linear amplitude alone hides everything a transient does after its first
  // millisecond: a steel impact whose ring is 35 dB under its contact click
  // draws as a single spike and an empty box. Overlaying the envelope on a
  // 60 dB scale makes the decay visible for any crest factor.
  {
    const tau = Math.exp(-1 / (0.004 * sampleRate));
    let env = 0;
    const halfH = h * 0.47;
    g.strokeStyle = 'rgba(120,200,255,0.55)';
    g.lineWidth = 1.25;
    g.beginPath();
    let px = 0;
    let colMax = 0;
    const perPx = n / w;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(data[i]);
      env = a > env ? a : a + tau * (env - a);
      if (env > colMax) colMax = env;
      if (i >= (px + 1) * perPx) {
        const db = 20 * Math.log10(Math.max(1e-7, colMax / Math.max(1e-7, peak)));
        const t = Math.max(0, 1 + db / 60);
        const yy = y + h * 0.5 - t * halfH;
        if (px === 0) g.moveTo(x + px, yy); else g.lineTo(x + px, yy);
        px++;
        colMax = 0;
      }
    }
    g.stroke();
  }

  g.fillStyle = DIM;
  g.font = '12px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'left';
  g.fillText(
    scale > 1.001 ? `waveform ×${scale.toFixed(1)}  ·  blue = envelope, 60 dB scale`
      : 'waveform  ·  blue = envelope, 60 dB scale',
    x + 8, y + 16,
  );
  g.textAlign = 'right';
  g.fillText(`${dur.toFixed(2)} s`, x + w - 8, y + 16);
  g.textAlign = 'left';
}

/* ---------------------------------------------------------- spectrogram -- */

export function drawSpectrogram(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  data: Float32Array, sampleRate: number, spec?: Spectrogram,
): void {
  const sg = spec ?? spectrogram(data, sampleRate, 1024, 256, Math.max(64, w | 0));
  const img = g.createImageData(w, h);
  const px = img.data;
  const fMin = 40, fMax = Math.min(20000, sampleRate * 0.5);
  const logMin = Math.log(fMin), logMax = Math.log(fMax);
  const range = Math.max(1e-3, sg.maxDb - sg.minDb);

  for (let j = 0; j < h; j++) {
    // Top of the panel is the top of the spectrum.
    const f = Math.exp(logMin + ((h - 1 - j) / (h - 1)) * (logMax - logMin));
    const binF = f / sg.binHz;
    const b0 = Math.floor(binF);
    const frac = binF - b0;
    for (let i = 0; i < w; i++) {
      const frameF = (i / (w - 1)) * (sg.frames - 1);
      const f0 = Math.floor(frameF);
      const f1 = Math.min(sg.frames - 1, f0 + 1);
      const ff = frameF - f0;
      const idx0 = f0 * sg.bins + Math.min(sg.bins - 1, b0);
      const idx1 = f1 * sg.bins + Math.min(sg.bins - 1, b0);
      const idx0b = f0 * sg.bins + Math.min(sg.bins - 1, b0 + 1);
      const idx1b = f1 * sg.bins + Math.min(sg.bins - 1, b0 + 1);
      const a = sg.data[idx0] * (1 - frac) + sg.data[idx0b] * frac;
      const b = sg.data[idx1] * (1 - frac) + sg.data[idx1b] * frac;
      const db = a * (1 - ff) + b * ff;
      const t = (db - sg.minDb) / range;
      const [r, gg, bb] = magma(t);
      const o = (j * w + i) * 4;
      px[o] = r; px[o + 1] = gg; px[o + 2] = bb; px[o + 3] = 255;
    }
  }
  g.putImageData(img, x, y);

  // Frequency gridlines with labels.
  g.strokeStyle = 'rgba(180,200,225,0.16)';
  g.fillStyle = 'rgba(200,215,235,0.85)';
  g.font = '11px ui-monospace, Menlo, Consolas, monospace';
  g.lineWidth = 1;
  for (const f of [100, 500, 1000, 5000, 10000]) {
    if (f >= fMax) continue;
    const t = (Math.log(f) - logMin) / (logMax - logMin);
    const yy = Math.round(y + (1 - t) * h) + 0.5;
    g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 4, yy - 3);
  }
  g.strokeStyle = AXIS;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = DIM;
  g.textAlign = 'right';
  g.fillText('spectrogram (log Hz)', x + w - 6, y + 14);
  g.textAlign = 'left';
}

/* ------------------------------------------------------ spectrum curves -- */

export interface SpectrumSeries {
  label: string;
  colour: string;
  /** Magnitude per bin. */
  mag: Float32Array;
  binHz: number;
}

export function drawSpectrumOverlay(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  series: SpectrumSeries[], title: string,
): void {
  g.fillStyle = PANEL;
  roundRect(g, x, y, w, h, 4); g.fill();

  const fMin = 40, fMax = 18000;
  const logMin = Math.log(fMin), logMax = Math.log(fMax);
  const dbMin = -78, dbMax = 0;

  g.strokeStyle = GRID; g.lineWidth = 1;
  g.font = '11px ui-monospace, Menlo, Consolas, monospace';
  g.fillStyle = DIM;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const t = (Math.log(f) - logMin) / (logMax - logMin);
    const xx = Math.round(x + t * w) + 0.5;
    g.beginPath(); g.moveTo(xx, y); g.lineTo(xx, y + h); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xx + 3, y + h - 5);
  }
  for (let db = 0; db >= dbMin; db -= 12) {
    const t = (db - dbMin) / (dbMax - dbMin);
    const yy = Math.round(y + (1 - t) * h) + 0.5;
    g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
    g.fillText(`${db}`, x + 3, yy - 3);
  }

  for (const s of series) {
    // Normalise each curve to its own peak so shape, not level, is compared.
    let peak = 1e-9;
    for (let i = 1; i < s.mag.length; i++) peak = Math.max(peak, s.mag[i]);
    g.strokeStyle = s.colour;
    g.lineWidth = 2;
    g.beginPath();
    let started = false;
    for (let px = 0; px < w; px++) {
      const f = Math.exp(logMin + (px / (w - 1)) * (logMax - logMin));
      const bin = f / s.binHz;
      const b0 = Math.max(1, Math.min(s.mag.length - 2, Math.floor(bin)));
      // Average a small neighbourhood so the curve reads as a spectral envelope.
      const span = Math.max(1, Math.round(b0 * 0.06));
      let acc = 0, cnt = 0;
      for (let b = b0 - span; b <= b0 + span; b++) {
        if (b < 1 || b >= s.mag.length) continue;
        acc += s.mag[b]; cnt++;
      }
      const m = cnt > 0 ? acc / cnt : 1e-9;
      const db = 20 * Math.log10(Math.max(1e-9, m / peak));
      const t = (Math.max(dbMin, db) - dbMin) / (dbMax - dbMin);
      const yy = y + (1 - t) * h;
      if (!started) { g.moveTo(x + px, yy); started = true; } else g.lineTo(x + px, yy);
    }
    g.stroke();
  }

  // Legend.
  g.font = '13px ui-monospace, Menlo, Consolas, monospace';
  let ly = y + 18;
  for (const s of series) {
    g.fillStyle = s.colour;
    g.fillRect(x + w - 150, ly - 9, 12, 12);
    g.fillStyle = TEXT;
    g.fillText(s.label, x + w - 132, ly + 2);
    ly += 18;
  }
  g.fillStyle = DIM;
  g.font = '12px ui-monospace, Menlo, Consolas, monospace';
  g.fillText(title, x + 8, y + h - 20);
}

/* ---------------------------------------------------------- full panels -- */

export interface PanelInfo {
  title: string;
  subtitle?: string;
  metrics: SoundMetrics;
  notes?: string[];
  status?: 'pass' | 'fail' | 'info';
}

const METRIC_ROWS: Array<[string, (m: SoundMetrics) => string]> = [
  ['peak', (m) => `${m.peakDb.toFixed(1)} dBFS`],
  ['rms', (m) => `${m.rmsDb.toFixed(1)} dBFS`],
  ['crest', (m) => `${m.crestDb.toFixed(1)} dB`],
  ['centroid', (m) => `${m.centroid.toFixed(0)} Hz`],
  ['rolloff85', (m) => `${m.rolloff85.toFixed(0)} Hz`],
  ['flatness', (m) => m.flatness.toFixed(3)],
  ['lo/mid/hi', (m) => `${(m.lowRatio * 100).toFixed(0)}/${(m.midRatio * 100).toFixed(0)}/${(m.highRatio * 100).toFixed(0)}%`],
  ['onset', (m) => `${(m.onset * 1000).toFixed(1)} ms`],
  ['attack', (m) => `${(m.attack * 1000).toFixed(1)} ms`],
  ['decay60', (m) => `${(m.decay60 * 1000).toFixed(0)} ms`],
  ['span', (m) => `${(m.span * 1000).toFixed(0)} ms`],
  ['zcr', (m) => `${m.zcr.toFixed(0)} /s`],
  ['stereo r', (m) => m.stereoCorrelation.toFixed(3)],
];

export function drawSoundPanel(
  canvas: HTMLCanvasElement, data: Float32Array, sampleRate: number, info: PanelInfo,
): void {
  const g = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);

  /* header */
  g.fillStyle = '#161d27';
  g.fillRect(0, 0, W, 44);
  g.fillStyle = TEXT;
  g.font = '600 22px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'middle';
  g.fillText(info.title, 14, 23);
  if (info.subtitle) {
    // Measure with the *title* font, then switch — measuring afterwards puts
    // the subtitle on top of the title.
    const tw = g.measureText(info.title).width;
    g.font = '15px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = DIM;
    g.fillText(info.subtitle, 24 + tw, 23);
  }
  if (info.status && info.status !== 'info') {
    g.fillStyle = info.status === 'pass' ? GOOD : BAD;
    g.font = '600 16px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'right';
    g.fillText(info.status.toUpperCase(), W - 14, 23);
    g.textAlign = 'left';
  }

  const pad = 10;
  const waveH = 150;
  const specH = 210;
  drawWaveform(g, pad, 54, W - pad * 2, waveH, data, sampleRate);
  drawSpectrogram(g, pad, 54 + waveH + 8, W - pad * 2, specH, data, sampleRate);

  /* metric table */
  const top = 54 + waveH + specH + 18;
  g.font = '14px ui-monospace, Menlo, Consolas, monospace';
  const cols = 4;
  const colW = (W - pad * 2) / cols;
  for (let i = 0; i < METRIC_ROWS.length; i++) {
    const [label, fmt] = METRIC_ROWS[i];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = pad + c * colW;
    const y = top + r * 20 + 8;
    g.fillStyle = DIM;
    g.fillText(label, x, y);
    g.fillStyle = TEXT;
    g.fillText(fmt(info.metrics), x + 96, y);
  }

  if (info.notes?.length) {
    g.font = '13px ui-monospace, Menlo, Consolas, monospace';
    let y = top + Math.ceil(METRIC_ROWS.length / cols) * 20 + 14;
    for (const nline of info.notes) {
      g.fillStyle = nline.startsWith('FAIL') ? BAD : nline.startsWith('OK') ? GOOD : DIM;
      g.fillText(nline, pad, y);
      y += 17;
    }
  }

  g.strokeStyle = '#243044';
  g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);
  g.textBaseline = 'alphabetic';
}

/** Panel whose body is an arbitrary custom draw (overlays, tables, curves). */
export function drawCustomPanel(
  canvas: HTMLCanvasElement, title: string, subtitle: string,
  body: (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void,
  status?: 'pass' | 'fail' | 'info',
): void {
  const g = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#161d27';
  g.fillRect(0, 0, W, 44);
  g.fillStyle = TEXT;
  g.font = '600 22px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'middle';
  g.fillText(title, 14, 23);
  if (subtitle) {
    const tw = g.measureText(title).width;
    g.font = '15px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = DIM;
    g.fillText(subtitle, 24 + tw, 23);
  }
  if (status && status !== 'info') {
    g.fillStyle = status === 'pass' ? GOOD : BAD;
    g.font = '600 16px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'right';
    g.fillText(status.toUpperCase(), W - 14, 23);
    g.textAlign = 'left';
  }
  g.textBaseline = 'alphabetic';
  body(g, 10, 54, W - 20, H - 64);
  g.strokeStyle = '#243044';
  g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);
}

/* ------------------------------------------------------------ XY curves -- */

export interface XySeries {
  label: string;
  colour: string;
  points: Array<[number, number]>;
}

export function drawXy(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  series: XySeries[], xLabel: string, yLabel: string, logX = false,
): void {
  g.fillStyle = PANEL;
  roundRect(g, x, y, w, h, 4); g.fill();

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    for (const [px, py] of s.points) {
      xMin = Math.min(xMin, px); xMax = Math.max(xMax, px);
      yMin = Math.min(yMin, py); yMax = Math.max(yMax, py);
    }
  }
  if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }
  if (logX) { xMin = Math.max(1e-3, xMin); }
  const pad = (yMax - yMin) * 0.12 + 1e-6;
  yMin -= pad; yMax += pad;

  const mapX = (v: number): number => {
    const t = logX
      ? (Math.log(Math.max(1e-3, v)) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin) || 1)
      : (v - xMin) / (xMax - xMin || 1);
    return x + 46 + t * (w - 60);
  };
  const mapY = (v: number): number => y + h - 30 - ((v - yMin) / (yMax - yMin || 1)) * (h - 46);

  g.strokeStyle = GRID; g.lineWidth = 1;
  g.font = '12px ui-monospace, Menlo, Consolas, monospace';
  g.fillStyle = DIM;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    const yy = Math.round(mapY(v)) + 0.5;
    g.beginPath(); g.moveTo(x + 44, yy); g.lineTo(x + w - 10, yy); g.stroke();
    g.fillText(v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0), x + 4, yy - 3);
  }

  for (const s of series) {
    g.strokeStyle = s.colour; g.lineWidth = 2.5;
    g.beginPath();
    s.points.forEach(([px, py], i) => {
      const cx = mapX(px), cy = mapY(py);
      if (i === 0) g.moveTo(cx, cy); else g.lineTo(cx, cy);
    });
    g.stroke();
    g.fillStyle = s.colour;
    for (const [px, py] of s.points) {
      g.beginPath(); g.arc(mapX(px), mapY(py), 4, 0, Math.PI * 2); g.fill();
    }
  }

  // Axis labels + legend.
  g.fillStyle = DIM;
  g.font = '13px ui-monospace, Menlo, Consolas, monospace';
  g.fillText(xLabel, x + w - 10 - g.measureText(xLabel).width, y + h - 8);
  // Sits under the top gridline label rather than on top of it.
  g.fillText(yLabel, x + 6, y + h - 8);
  let ly = y + 22;
  for (const s of series) {
    g.fillStyle = s.colour;
    g.fillRect(x + w - 190, ly - 9, 12, 12);
    g.fillStyle = TEXT;
    g.fillText(s.label, x + w - 172, ly + 2);
    ly += 18;
  }
}

/* ------------------------------------------------------ assertion table -- */

export function drawAssertionTable(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  rows: Array<{ name: string; pass: boolean; detail: string }>,
): void {
  g.fillStyle = PANEL;
  roundRect(g, x, y, w, h, 4); g.fill();
  const rowH = Math.min(28, (h - 16) / Math.max(1, rows.length));
  const fontPx = Math.min(16, Math.max(10, rowH - 8));
  g.font = `${fontPx}px ui-monospace, Menlo, Consolas, monospace`;

  // Size the name column to the longest label so nothing collides, and clamp it
  // so a single verbose assertion cannot squeeze every detail off the panel.
  let nameW = 0;
  for (const r of rows) nameW = Math.max(nameW, g.measureText(r.name).width);
  const nameX = x + 62;
  const detailX = Math.min(nameX + nameW + 18, x + w * 0.62);
  const detailW = x + w - 10 - detailX;

  const fit = (text: string): string => {
    if (g.measureText(text).width <= detailW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.measureText(`${text.slice(0, mid)}…`).width <= detailW) lo = mid; else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  };

  let yy = y + 10 + rowH * 0.7;
  for (const r of rows) {
    g.fillStyle = r.pass ? 'rgba(74,208,122,0.10)' : 'rgba(255,90,90,0.14)';
    g.fillRect(x + 4, yy - rowH * 0.72, w - 8, rowH - 3);
    g.fillStyle = r.pass ? GOOD : BAD;
    g.fillText(r.pass ? 'PASS' : 'FAIL', x + 10, yy);
    g.fillStyle = TEXT;
    g.fillText(r.name, nameX, yy);
    g.fillStyle = DIM;
    g.fillText(fit(r.detail), detailX, yy);
    yy += rowH;
  }
}

export { BG, TEXT, DIM, ACCENT, GOOD, BAD };
