/**
 * Synthesis toolkit.
 *
 * Two worlds live here and they are deliberately separated:
 *
 *  1. **Offline/JS DSP** — plain `Float32Array` rendering: noise generators,
 *     RBJ biquads, modal resonator banks, transient shaping. Used to bake the
 *     "sample bank" (impacts, casings, footsteps, glass, gear) at load time.
 *     Deterministic, seeded, and free at playback time.
 *
 *  2. **Web Audio graph helpers** — node factories, envelope automation,
 *     waveshaper curves, comb/allpass builders, multi-band compression,
 *     granular scheduling. Used for anything whose *structure* changes per
 *     instance (weapon shots at different distances, explosions, ambience).
 *
 * Everything is written against `BaseAudioContext` so the exact same synthesis
 * code renders in a live `AudioContext` and in an `OfflineAudioContext` for the
 * numeric verification pass.
 */

import { Rand } from '../core/Rand';

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ math -- */

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(1e-9, g));
}
/** Speed of sound at 15 °C, m/s. Propagation delay = distance / this. */
export const SPEED_OF_SOUND = 343;

/**
 * Air absorption expressed as a one-pole cutoff. Real absorption is
 * frequency- and humidity-dependent; this fits the audible result over 0..500 m
 * with a single lowpass, which is what shipped engines do.
 */
export function airAbsorptionHz(distance: number): number {
  const d = Math.max(0, distance);
  return clamp(21000 / (1 + (d * d) / 700), 220, 21000);
}

/* --------------------------------------------------------------- biquads -- */

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch' | 'lowshelf' | 'highshelf';

/**
 * Direct-form-I RBJ biquad in double precision. Used for offline buffer
 * rendering; high-Q resonators (Q in the thousands) are stable here in a way
 * `BiquadFilterNode` is not, because the node clamps Q at 1000.
 */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  set(kind: BiquadKind, sampleRate: number, freq: number, q: number, gainDb = 0): this {
    const f0 = clamp(freq, 5, sampleRate * 0.49);
    const w0 = TAU * f0 / sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const Q = Math.max(1e-4, q);
    const alpha = sw / (2 * Q);
    const A = Math.pow(10, gainDb / 40);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    switch (kind) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s);
        b1 = 2 * A * ((A - 1) - (A + 1) * cw);
        b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s;
        a1 = -2 * ((A - 1) + (A + 1) * cw);
        a2 = (A + 1) + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s);
        b1 = -2 * A * ((A - 1) + (A + 1) * cw);
        b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s;
        a1 = 2 * ((A - 1) - (A + 1) * cw);
        a2 = (A + 1) - (A - 1) * cw - s;
        break;
      }
    }

    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
    return this;
  }

  reset(): this {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  /** In-place filter of a whole block. */
  run(data: Float32Array): void {
    for (let i = 0; i < data.length; i++) data[i] = this.process(data[i]);
  }
}

/** Leaky integrator / one-pole lowpass, handy for envelope followers. */
export class OnePole {
  private y = 0;
  private a = 0;
  set(sampleRate: number, hz: number): this {
    this.a = Math.exp(-TAU * clamp(hz, 0.01, sampleRate * 0.45) / sampleRate);
    return this;
  }
  /** Time-constant form; `tau` in seconds. */
  setTau(sampleRate: number, tau: number): this {
    this.a = Math.exp(-1 / Math.max(1e-6, tau * sampleRate));
    return this;
  }
  reset(v = 0): this { this.y = v; return this; }
  process(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }
}

/* ------------------------------------------------------------ noise fills -- */

export type NoiseKind = 'white' | 'pink' | 'brown' | 'blue' | 'violet';

export function fillWhite(out: Float32Array, rand: Rand, gain = 1): void {
  for (let i = 0; i < out.length; i++) out[i] = rand.signed() * gain;
}

/** Paul Kellet's refined pink-noise filter — flat −3 dB/oct to well under 20 Hz. */
export function fillPink(out: Float32Array, rand: Rand, gain = 1): void {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const g = gain * 0.108;
  for (let i = 0; i < out.length; i++) {
    const w = rand.signed();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * g;
    b6 = w * 0.115926;
  }
}

/** Leaky-integrated white — −6 dB/oct. The bottom end of every explosion. */
export function fillBrown(out: Float32Array, rand: Rand, gain = 1): void {
  let last = 0;
  const g = gain * 3.2;
  for (let i = 0; i < out.length; i++) {
    const w = rand.signed();
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * g;
  }
}

/** Differentiated white — +6 dB/oct. Air, sizzle, glass shimmer. */
export function fillViolet(out: Float32Array, rand: Rand, gain = 1): void {
  let prev = 0;
  const g = gain * 0.5;
  for (let i = 0; i < out.length; i++) {
    const w = rand.signed();
    out[i] = (w - prev) * g;
    prev = w;
  }
}

/** +3 dB/oct — halfway between white and violet. */
export function fillBlue(out: Float32Array, rand: Rand, gain = 1): void {
  fillPink(out, rand, 1);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = (v - prev) * 9 * gain;
    prev = v;
  }
}

export function fillNoise(out: Float32Array, kind: NoiseKind, rand: Rand, gain = 1): void {
  switch (kind) {
    case 'white': fillWhite(out, rand, gain); break;
    case 'pink': fillPink(out, rand, gain); break;
    case 'brown': fillBrown(out, rand, gain); break;
    case 'blue': fillBlue(out, rand, gain); break;
    case 'violet': fillViolet(out, rand, gain); break;
  }
}

/* --------------------------------------------------------- buffer helpers -- */

export function peakOf(data: Float32Array): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, data.length));
}

export function normalise(data: Float32Array, target = 1): void {
  const p = peakOf(data);
  if (p < 1e-9) return;
  const g = target / p;
  for (let i = 0; i < data.length; i++) data[i] *= g;
}

export function fadeIn(data: Float32Array, samples: number): void {
  const n = Math.min(samples, data.length);
  for (let i = 0; i < n; i++) data[i] *= i / n;
}

export function fadeOut(data: Float32Array, samples: number): void {
  const n = Math.min(samples, data.length);
  const start = data.length - n;
  for (let i = 0; i < n; i++) data[start + i] *= 1 - i / n;
}

/**
 * Transient shaper. Two envelope followers (fast + slow); where the fast one
 * outruns the slow one we are in an attack, so `attackGain` applies, otherwise
 * `sustainGain` does. This is what turns a flabby noise burst into a *crack*.
 */
export function transientShape(
  data: Float32Array, sampleRate: number,
  attackGain: number, sustainGain: number, fastTau = 0.0012, slowTau = 0.045,
): void {
  const fast = new OnePole().setTau(sampleRate, fastTau);
  const slow = new OnePole().setTau(sampleRate, slowTau);
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    const f = fast.process(a);
    const s = slow.process(a);
    const t = clamp01((f - s) / (s + 1e-4));
    data[i] *= lerp(sustainGain, attackGain, t);
  }
}

/** Soft saturation applied directly to a rendered buffer. */
export function saturate(data: Float32Array, drive: number): void {
  const d = Math.max(1e-3, drive);
  const norm = 1 / Math.tanh(d);
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * d) * norm;
}

/* ------------------------------------------------- modal / resonant hits -- */

export interface ModeSpec {
  freq: number;
  /** Resonator Q. T60 ≈ 6.91·Q/(π·f). Q=200 @3 kHz ≈ 150 ms ring. */
  q: number;
  gain: number;
}

export interface HitSpec {
  seconds: number;
  /** Resonant partials — the material's "voice". */
  modes: ModeSpec[];
  /** Excitation burst length in seconds (how hard/soft the strike is). */
  excite: number;
  /** Lowpass on the excitation — a soft mallet vs. a steel pick. */
  exciteTone: number;
  exciteKind: NoiseKind;
  /** Broadband non-resonant thump mixed under the modes. */
  bodyGain: number;
  bodyLp: number;
  bodyHp: number;
  bodyDecay: number;
  /** Sharp initial click level (the very first millisecond). */
  clickGain: number;
  clickTone: number;
  /** Scattered grains: gravel, glass shards, debris rattle. */
  grains?: { count: number; spread: number; gain: number; hz: number; q: number; decay: number };
  /** Post drive. */
  drive?: number;
  /** Transient emphasis applied after summing. */
  attack?: number;
}

/**
 * Renders one impact/material hit into a mono Float32Array.
 *
 * A short noise burst excites a parallel bank of high-Q resonators; the modes
 * give the material identity (metal rings inharmonically, wood thuds, glass
 * shimmers) and the broadband body gives the weight. This is physical modelling
 * on a budget and it is why these read as *materials* rather than as noise.
 */
export function renderHit(sampleRate: number, spec: HitSpec, rand: Rand): Float32Array {
  const n = Math.max(16, Math.ceil(spec.seconds * sampleRate));
  const ex = new Float32Array(n);
  const exN = Math.max(2, Math.ceil(spec.excite * sampleRate));
  const tmp = new Float32Array(exN);
  fillNoise(tmp, spec.exciteKind, rand, 1);
  const tau = spec.excite * 0.32;
  for (let i = 0; i < exN; i++) {
    ex[i] = tmp[i] * Math.exp(-(i / sampleRate) / Math.max(1e-5, tau));
  }
  new Biquad().set('lowpass', sampleRate, spec.exciteTone, 0.72).run(ex);

  const out = new Float32Array(n);

  // Resonant partials.
  const bq = new Biquad();
  for (const m of spec.modes) {
    if (m.freq >= sampleRate * 0.48) continue;
    bq.set('bandpass', sampleRate, m.freq, m.q).reset();
    const g = m.gain;
    for (let i = 0; i < n; i++) out[i] += bq.process(ex[i]) * g;
  }

  // Broadband body.
  if (spec.bodyGain > 0) {
    const body = new Float32Array(n);
    body.set(ex.subarray(0, Math.min(exN, n)));
    new Biquad().set('lowpass', sampleRate, spec.bodyLp, 0.9).run(body);
    if (spec.bodyHp > 20) new Biquad().set('highpass', sampleRate, spec.bodyHp, 0.7).run(body);
    const bd = Math.max(1e-4, spec.bodyDecay);
    for (let i = 0; i < n; i++) out[i] += body[i] * spec.bodyGain * Math.exp(-(i / sampleRate) / bd);
  }

  // Initial click — the "contact" before the material responds.
  if (spec.clickGain > 0) {
    const clickN = Math.min(n, Math.ceil(0.0025 * sampleRate));
    const click = new Float32Array(clickN);
    fillWhite(click, rand, 1);
    new Biquad().set('lowpass', sampleRate, spec.clickTone, 0.6).run(click);
    for (let i = 0; i < clickN; i++) {
      out[i] += click[i] * spec.clickGain * Math.exp(-(i / clickN) * 7);
    }
  }

  // Scattered grains — gravel skitter, glass shards, debris patter.
  if (spec.grains && spec.grains.count > 0) {
    const g = spec.grains;
    const gq = new Biquad();
    for (let k = 0; k < g.count; k++) {
      const at = Math.floor(rand.next() * rand.next() * g.spread * sampleRate);
      if (at >= n - 4) continue;
      const len = Math.min(n - at, Math.ceil(g.decay * sampleRate));
      const hz = g.hz * (0.55 + rand.next() * 1.5);
      gq.set('bandpass', sampleRate, hz, g.q).reset();
      const amp = g.gain * (0.25 + rand.next() * 0.75) * (1 - at / (g.spread * sampleRate + 1));
      let prev = rand.signed();
      for (let i = 0; i < len; i++) {
        const drive = i < 3 ? prev : 0;
        out[at + i] += gq.process(drive) * amp;
      }
    }
  }

  if (spec.attack !== undefined && spec.attack !== 1) {
    transientShape(out, sampleRate, spec.attack, 1);
  }
  if (spec.drive && spec.drive > 1) saturate(out, spec.drive);

  normalise(out, 0.985);
  fadeIn(out, 2);
  fadeOut(out, Math.min(n >> 2, Math.ceil(0.006 * sampleRate)));
  return out;
}

/* ------------------------------------------------------- Web Audio nodes -- */

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function filterNode(
  ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7071, gainDb = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate * 0.49);
  f.Q.value = clamp(q, 0.0001, 1000);
  f.gain.value = gainDb;
  return f;
}

export function shaperNode(ctx: BaseAudioContext, curve: Float32Array, oversample: OverSampleType = '2x'): WaveShaperNode {
  const w = ctx.createWaveShaper();
  w.curve = curve;
  w.oversample = oversample;
  return w;
}

export function delayNode(ctx: BaseAudioContext, seconds: number, max = 2): DelayNode {
  const d = ctx.createDelay(Math.max(max, seconds + 0.01));
  d.delayTime.value = seconds;
  return d;
}

/* --------------------------------------------------- waveshaping curves -- */

const curveCache = new Map<string, Float32Array>();

function cachedCurve(key: string, build: (out: Float32Array, n: number) => void, n = 4096): Float32Array {
  const hit = curveCache.get(key);
  if (hit) return hit;
  const out = new Float32Array(n);
  build(out, n);
  curveCache.set(key, out);
  return out;
}

/** Symmetric tanh saturation — odd harmonics, the "loud" curve. */
export function softClipCurve(drive: number): Float32Array {
  return cachedCurve(`soft:${drive.toFixed(3)}`, (out, n) => {
    const norm = 1 / Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      out[i] = Math.tanh(x * drive) * norm;
    }
  });
}

/** Asymmetric drive — adds even harmonics, reads as "speaker being pushed". */
export function asymCurve(drive: number): Float32Array {
  return cachedCurve(`asym:${drive.toFixed(3)}`, (out, n) => {
    const up = 1 / Math.tanh(drive);
    const dn = 1 / Math.tanh(drive * 0.55);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      out[i] = x >= 0 ? Math.tanh(x * drive) * up : Math.tanh(x * drive * 0.55) * dn;
    }
  });
}

/** Wavefolder — violent, metallic. Used sparingly on explosion cores. */
export function foldCurve(amount: number): Float32Array {
  return cachedCurve(`fold:${amount.toFixed(3)}`, (out, n) => {
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * amount;
      let y = x;
      for (let k = 0; k < 4; k++) {
        if (y > 1) y = 2 - y; else if (y < -1) y = -2 - y; else break;
      }
      out[i] = y;
    }
  });
}

/** Brickwall-ish safety clip that stays clean until it has to work. */
export function limitCurve(): Float32Array {
  return cachedCurve('limit', (out, n) => {
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a < 0.7 ? a : 0.7 + (1 - Math.exp(-(a - 0.7) * 3.2)) * 0.3;
      out[i] = Math.sign(x) * Math.min(y, 0.999);
    }
  });
}

/* ----------------------------------------------------- envelope helpers -- */

const FLOOR = 1e-4;

/** Attack/decay burst. `peak` is linear gain. */
export function ar(
  p: AudioParam, t0: number, peak: number, attack: number, decay: number, floor = FLOOR,
): number {
  const a = Math.max(0.0004, attack);
  const d = Math.max(0.002, decay);
  p.setValueAtTime(floor, t0);
  p.exponentialRampToValueAtTime(Math.max(peak, floor * 2), t0 + a);
  p.exponentialRampToValueAtTime(floor, t0 + a + d);
  return t0 + a + d;
}

/** Attack/decay with a linear attack — punchier than the exponential form. */
export function arLin(
  p: AudioParam, t0: number, peak: number, attack: number, decay: number, floor = FLOOR,
): number {
  const a = Math.max(0.0002, attack);
  const d = Math.max(0.002, decay);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(Math.max(peak, floor), t0 + a);
  p.exponentialRampToValueAtTime(floor, t0 + a + d);
  return t0 + a + d;
}

/** Full ADSR with an explicit note length. */
export function adsr(
  p: AudioParam, t0: number, peak: number,
  attack: number, decay: number, sustain: number, hold: number, release: number,
): number {
  p.setValueAtTime(FLOOR, t0);
  p.exponentialRampToValueAtTime(Math.max(peak, FLOOR * 2), t0 + attack);
  p.exponentialRampToValueAtTime(Math.max(peak * sustain, FLOOR * 2), t0 + attack + decay);
  const end = t0 + attack + decay + hold;
  p.setValueAtTime(Math.max(peak * sustain, FLOOR * 2), end);
  p.exponentialRampToValueAtTime(FLOOR, end + release);
  return end + release;
}

/** Exponential glide between two values — the pitch drop that makes a "crack". */
export function sweep(p: AudioParam, t0: number, from: number, to: number, time: number): void {
  p.setValueAtTime(Math.max(1, from), t0);
  p.exponentialRampToValueAtTime(Math.max(1, to), t0 + Math.max(0.0005, time));
}

/* ------------------------------------------------------ shared buffers -- */

interface CtxBuffers {
  noise: Map<string, AudioBuffer>;
  custom: Map<string, AudioBuffer>;
}
const bufferCache = new WeakMap<BaseAudioContext, CtxBuffers>();

function slot(ctx: BaseAudioContext): CtxBuffers {
  let s = bufferCache.get(ctx);
  if (!s) { s = { noise: new Map(), custom: new Map() }; bufferCache.set(ctx, s); }
  return s;
}

/** A long shared noise bed. Playback starts at a random offset per voice. */
export function noiseBuffer(ctx: BaseAudioContext, kind: NoiseKind, seconds = 3, seed = 0x5eed): AudioBuffer {
  const key = `${kind}:${seconds}:${seed}`;
  const s = slot(ctx);
  const hit = s.noise.get(key);
  if (hit) return hit;
  const n = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const rand = new Rand(seed ^ 0x9e37);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    fillNoise(data, kind, rand, 1);
    // Keep the two channels decorrelated but level-matched.
    normalise(data, 0.9);
  }
  s.noise.set(key, buf);
  return buf;
}

/** Registers/looks up a procedurally built buffer under a stable key. */
export function cacheBuffer(ctx: BaseAudioContext, key: string, build: () => AudioBuffer): AudioBuffer {
  const s = slot(ctx);
  const hit = s.custom.get(key);
  if (hit) return hit;
  const buf = build();
  s.custom.set(key, buf);
  return buf;
}

/** Wraps mono `Float32Array`s into an `AudioBuffer`. */
export function toAudioBuffer(ctx: BaseAudioContext, channels: Float32Array[], sampleRate?: number): AudioBuffer {
  const n = channels[0].length;
  const buf = ctx.createBuffer(channels.length, n, sampleRate ?? ctx.sampleRate);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return buf;
}

export interface SourceOptions {
  rate?: number;
  detune?: number;
  offset?: number;
  loop?: boolean;
  duration?: number;
}

export function bufferSource(ctx: BaseAudioContext, buf: AudioBuffer, o: SourceOptions = {}): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (o.rate !== undefined) src.playbackRate.value = o.rate;
  if (o.detune !== undefined) src.detune.value = o.detune;
  if (o.loop) { src.loop = true; }
  return src;
}

/** A noise voice: shared bed, random start offset, optional pitch shift. */
export function noiseVoice(
  ctx: BaseAudioContext, kind: NoiseKind, rand: Rand, o: SourceOptions = {},
): AudioBufferSourceNode {
  const buf = noiseBuffer(ctx, kind, 3);
  const src = bufferSource(ctx, buf, o);
  if (o.loop) {
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;
  }
  return src;
}

/** Starts a noise voice at a random offset so repeats never phase-lock. */
export function startNoise(src: AudioBufferSourceNode, when: number, rand: Rand, duration?: number): void {
  const buf = src.buffer!;
  const off = rand.next() * Math.max(0.01, buf.duration - (duration ?? 0.25) - 0.01);
  if (duration !== undefined && !src.loop) src.start(when, off, duration);
  else src.start(when, off);
}

/* ----------------------------------------------- comb / allpass / bodies -- */

export interface CombNodes {
  input: GainNode;
  output: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  damping: BiquadFilterNode;
}

/**
 * Feedback comb with in-loop damping. The Web Audio graph enforces a
 * one-render-quantum minimum in any cycle, so the usable fundamental tops out
 * around 340 Hz — fine for flutter echo and body resonance, not for metallic
 * ring (that is what {@link renderHit} is for).
 */
export function comb(ctx: BaseAudioContext, seconds: number, feedback: number, dampHz: number): CombNodes {
  const input = gainNode(ctx, 1);
  const output = gainNode(ctx, 1);
  const delay = delayNode(ctx, seconds, Math.max(0.5, seconds * 2));
  const fb = gainNode(ctx, clamp(feedback, 0, 0.98));
  const damp = filterNode(ctx, 'lowpass', dampHz, 0.7);
  input.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  delay.connect(output);
  return { input, output, delay, feedback: fb, damping: damp };
}

/** Schroeder allpass — diffusion without colouration. */
export function allpass(ctx: BaseAudioContext, seconds: number, g: number): { input: GainNode; output: GainNode } {
  const input = gainNode(ctx, 1);
  const output = gainNode(ctx, 1);
  const d = delayNode(ctx, seconds, Math.max(0.2, seconds * 2));
  const ff = gainNode(ctx, -g);
  const fb = gainNode(ctx, g);
  input.connect(ff); ff.connect(output);
  input.connect(d);
  d.connect(fb); fb.connect(d);
  d.connect(output);
  return { input, output };
}

/**
 * Parallel resonator bank as live nodes. Cheaper than convolution for adding a
 * "body" to a live source (e.g. a barrel resonance on a weapon).
 */
export function resonatorBank(
  ctx: BaseAudioContext, modes: ModeSpec[],
): { input: GainNode; output: GainNode } {
  const input = gainNode(ctx, 1);
  const output = gainNode(ctx, 1);
  for (const m of modes) {
    const f = filterNode(ctx, 'bandpass', m.freq, clamp(m.q, 0.1, 1000));
    const g = gainNode(ctx, m.gain);
    input.connect(f); f.connect(g); g.connect(output);
  }
  return { input, output };
}

/* -------------------------------------------------- dynamics processing -- */

export interface CompressorOptions {
  threshold?: number;
  knee?: number;
  ratio?: number;
  attack?: number;
  release?: number;
  makeup?: number;
}

export function compressor(ctx: BaseAudioContext, o: CompressorOptions = {}): { input: DynamicsCompressorNode; output: GainNode } {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = o.threshold ?? -18;
  c.knee.value = o.knee ?? 8;
  c.ratio.value = o.ratio ?? 4;
  c.attack.value = o.attack ?? 0.004;
  c.release.value = o.release ?? 0.14;
  const g = gainNode(ctx, o.makeup ?? 1);
  c.connect(g);
  return { input: c, output: g };
}

export interface BandSpec {
  /** Upper crossover in Hz; the last band should use Infinity. */
  hi: number;
  comp: CompressorOptions;
}

/**
 * Multi-band compressor built from Linkwitz-Riley-ish crossovers (two cascaded
 * Butterworth sections per edge). The master bus uses it to keep gunfire from
 * eating the low end and to stop bright transients from pumping the whole mix.
 */
export function multibandCompressor(
  ctx: BaseAudioContext, bands: BandSpec[],
): { input: GainNode; output: GainNode } {
  const input = gainNode(ctx, 1);
  const output = gainNode(ctx, 1);
  let lowEdge = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    let head: AudioNode = input;
    if (lowEdge > 0) {
      const h1 = filterNode(ctx, 'highpass', lowEdge, 0.7071);
      const h2 = filterNode(ctx, 'highpass', lowEdge, 0.7071);
      head.connect(h1); h1.connect(h2); head = h2;
    }
    if (Number.isFinite(b.hi)) {
      const l1 = filterNode(ctx, 'lowpass', b.hi, 0.7071);
      const l2 = filterNode(ctx, 'lowpass', b.hi, 0.7071);
      head.connect(l1); l1.connect(l2); head = l2;
    }
    const c = compressor(ctx, b.comp);
    head.connect(c.input);
    c.output.connect(output);
    lowEdge = b.hi;
  }
  return { input, output };
}

/* ------------------------------------------------------------- granular -- */

export interface GrainOptions {
  count: number;
  /** Total spread of grain onsets, seconds. */
  spread: number;
  /** Grain length, seconds. */
  length: number;
  lengthJitter?: number;
  /** Playback-rate range. */
  rateMin?: number;
  rateMax?: number;
  gain?: number;
  /** Amplitude curve across the cloud, 0..1 → gain multiplier. */
  shape?: (t01: number) => number;
  /** Random stereo spread, 0..1. */
  pan?: number;
}

/**
 * Granular playback of a generated buffer. Used for debris showers, shell
 * casings scattering, crowd/rubble textures and the crackle inside explosions.
 */
export function granular(
  ctx: BaseAudioContext, buffer: AudioBuffer, dest: AudioNode,
  when: number, o: GrainOptions, rand: Rand,
): number {
  const shape = o.shape ?? ((t: number) => 1 - t);
  const g0 = o.gain ?? 1;
  let end = when;
  for (let i = 0; i < o.count; i++) {
    const t01 = o.count > 1 ? i / (o.count - 1) : 0;
    const jitter = rand.next();
    const at = when + (t01 * 0.7 + jitter * 0.3) * o.spread;
    const len = Math.max(0.004, o.length * (1 + (rand.signed() * (o.lengthJitter ?? 0.5))));
    const rate = lerp(o.rateMin ?? 0.8, o.rateMax ?? 1.6, rand.next());
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = gainNode(ctx, 0);
    src.connect(g);
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = rand.signed() * o.pan;
      g.connect(p); p.connect(dest);
    } else {
      g.connect(dest);
    }
    const amp = g0 * shape(t01) * (0.45 + rand.next() * 0.55);
    arLin(g.gain, at, amp, len * 0.18, len * 0.82);
    const off = rand.next() * Math.max(0.001, buffer.duration - len * rate - 0.001);
    src.start(at, off, len * rate + 0.01);
    end = Math.max(end, at + len + 0.02);
  }
  return end;
}

/* -------------------------------------------------------------- utility -- */

/** Disconnects a whole one-shot subgraph head so it can be collected. */
export function disconnectLater(node: AudioNode): void {
  try { node.disconnect(); } catch { /* already gone */ }
}

/** Cheap deterministic hash for per-instance seeds. */
export function seedFrom(...parts: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = typeof p === 'number' ? p.toFixed(3) : p;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}
