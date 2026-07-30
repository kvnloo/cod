/**
 * Procedural impulse responses.
 *
 * Every reverb in the game is convolution, and every impulse response is
 * generated here from a physical description of the space — there is not a
 * single recorded IR in the repository.
 *
 * The recipe is the one used by commercial algorithmic-to-convolution tools:
 *
 *   predelay  → the gap while sound travels to the nearest wall
 *   early     → discrete image-source reflections, panned, individually damped
 *   diffuse   → *velvet noise* (sparse ±1 impulses) split into four octave-ish
 *               bands, each decaying at its own RT60 so highs die before lows,
 *               which is the single biggest cue that a space is real
 *   flutter   → a periodic tap train for parallel hard walls (concrete
 *               corridors, stairwells) — the "pew" you hear in a car park
 *
 * Velvet noise rather than plain Gaussian noise matters: at low densities it
 * gives the airy, uncrowded tail of an open field, and at high densities it is
 * indistinguishable from noise but never has the "static hiss" quality that
 * naive exp*noise IRs suffer from.
 */

import { Rand } from '../core/Rand';
import { Biquad, clamp, lerp, type F32 } from './Dsp';
import type { ImpulseId, ImpulseSpec } from './types';

export const IMPULSE_SPECS: Record<ImpulseId, ImpulseSpec> = {
  /* A cluttered 5×4 m interior: fast, bright-ish, strong early energy. */
  smallRoom: {
    id: 'smallRoom',
    rt60: 0.42, predelay: 0.004,
    bandDecay: [1.25, 1.0, 0.72, 0.42],
    early: [
      [0.0052, 0.72, -0.55], [0.0071, 0.61, 0.48], [0.0104, 0.5, 0.15],
      [0.0138, 0.42, -0.3], [0.0181, 0.34, 0.62], [0.0233, 0.27, -0.18],
      [0.0296, 0.21, 0.34], [0.0371, 0.16, -0.44],
    ],
    density: 0.75, wet: 0.42, flutter: 0, width: 0.65, tone: 8200,
  },

  /* A big vaulted hall — long, dense, dark. */
  largeHall: {
    id: 'largeHall',
    rt60: 2.45, predelay: 0.026,
    bandDecay: [1.35, 1.1, 0.7, 0.36],
    early: [
      [0.0272, 0.55, -0.7], [0.0361, 0.5, 0.66], [0.0455, 0.44, -0.22],
      [0.0588, 0.4, 0.3], [0.0723, 0.34, 0.75], [0.0912, 0.28, -0.62],
      [0.1140, 0.22, 0.1], [0.1395, 0.17, -0.38], [0.1712, 0.13, 0.52],
    ],
    density: 1.0, wet: 0.55, flutter: 0, width: 0.92, tone: 5200,
  },

  /* Two façades 18 m apart: hard slap-backs, mid-heavy, wide. */
  streetCanyon: {
    id: 'streetCanyon',
    rt60: 1.55, predelay: 0.016,
    bandDecay: [1.15, 1.05, 0.68, 0.3],
    early: [
      [0.0175, 0.66, -0.85], [0.0348, 0.56, 0.85], [0.0525, 0.46, -0.62],
      [0.0701, 0.38, 0.6], [0.0880, 0.3, -0.4], [0.1055, 0.24, 0.4],
      [0.1410, 0.16, -0.25], [0.1760, 0.11, 0.25],
    ],
    density: 0.55, wet: 0.5, flutter: 0.0352, width: 1.0, tone: 4200,
  },

  /* Bare concrete interior — bright, ringy, obvious flutter. */
  indoorConcrete: {
    id: 'indoorConcrete',
    rt60: 1.25, predelay: 0.007,
    bandDecay: [1.1, 1.15, 1.0, 0.72],
    early: [
      [0.0079, 0.78, -0.45], [0.0121, 0.68, 0.5], [0.0164, 0.6, -0.2],
      [0.0221, 0.52, 0.35], [0.0293, 0.44, -0.55], [0.0378, 0.36, 0.25],
      [0.0492, 0.28, 0.6], [0.0637, 0.22, -0.35],
    ],
    density: 0.85, wet: 0.6, flutter: 0.0121, width: 0.7, tone: 9500,
  },

  /* Open ground: barely any reverb, but a long, quiet terrain wash. */
  openField: {
    id: 'openField',
    rt60: 1.05, predelay: 0.012,
    bandDecay: [1.4, 0.9, 0.42, 0.18],
    early: [
      [0.0132, 0.24, 0.0], [0.0431, 0.15, -0.5], [0.0794, 0.11, 0.55],
      [0.1382, 0.08, -0.3], [0.2210, 0.05, 0.35],
    ],
    density: 0.22, wet: 0.24, flutter: 0, width: 1.0, tone: 2600,
  },

  /* Long pipe/underpass: extreme flutter, huge low end, no highs. */
  tunnel: {
    id: 'tunnel',
    rt60: 2.1, predelay: 0.009,
    bandDecay: [1.45, 1.2, 0.66, 0.24],
    early: [
      [0.0093, 0.8, -0.3], [0.0186, 0.7, 0.3], [0.0279, 0.62, -0.25],
      [0.0372, 0.55, 0.25], [0.0558, 0.44, -0.15], [0.0744, 0.35, 0.15],
      [0.1116, 0.24, 0.0],
    ],
    density: 0.65, wet: 0.68, flutter: 0.0093, width: 0.45, tone: 3400,
  },

  /* Tight vertical shaft — very audible comb, narrow image. */
  stairwell: {
    id: 'stairwell',
    rt60: 1.65, predelay: 0.005,
    bandDecay: [1.05, 1.2, 1.05, 0.6],
    early: [
      [0.0061, 0.82, -0.35], [0.0093, 0.72, 0.4], [0.0143, 0.63, -0.15],
      [0.0201, 0.55, 0.25], [0.0272, 0.47, 0.5], [0.0361, 0.38, -0.5],
      [0.0472, 0.3, 0.2],
    ],
    density: 0.8, wet: 0.62, flutter: 0.0061, width: 0.5, tone: 8800,
  },
};

export const IMPULSE_IDS: ImpulseId[] = Object.keys(IMPULSE_SPECS) as ImpulseId[];

/* -------------------------------------------------------- velvet noise -- */

/**
 * Velvet noise: exactly one ±1 impulse per `sr/density` sample window, placed
 * at a random position inside it. Perceptually smooth, spectrally flat, and
 * sparse enough to stay transparent.
 */
function velvet(out: Float32Array, sampleRate: number, impulsesPerSecond: number, rand: Rand): void {
  const period = Math.max(2, Math.round(sampleRate / Math.max(20, impulsesPerSecond)));
  for (let base = 0; base < out.length; base += period) {
    const i = base + Math.floor(rand.next() * period);
    if (i < out.length) out[i] = rand.bool() ? 1 : -1;
  }
}

const BAND_EDGES = [260, 1150, 4200];

/** Splits `src` into four bands, decays each at its own rate, sums into `dst`. */
function bandedDecay(
  dst: Float32Array, src: Float32Array, sampleRate: number,
  rt60: number, bandDecay: [number, number, number, number],
): void {
  const n = src.length;
  const scratch = new Float32Array(n);
  for (let b = 0; b < 4; b++) {
    scratch.set(src);
    if (b > 0) {
      new Biquad().set('highpass', sampleRate, BAND_EDGES[b - 1], 0.7071).run(scratch);
      new Biquad().set('highpass', sampleRate, BAND_EDGES[b - 1], 0.7071).run(scratch);
    }
    if (b < 3) {
      new Biquad().set('lowpass', sampleRate, BAND_EDGES[b], 0.7071).run(scratch);
      new Biquad().set('lowpass', sampleRate, BAND_EDGES[b], 0.7071).run(scratch);
    }
    const t60 = Math.max(0.03, rt60 * bandDecay[b]);
    const k = -6.9078 / (t60 * sampleRate);
    for (let i = 0; i < n; i++) dst[i] += scratch[i] * Math.exp(k * i);
  }
}

export interface ImpulseRenderOptions {
  /** Scale the whole response length; `low` quality uses 0.5. */
  lengthScale?: number;
  /** Scale tail density; `low` quality uses 0.45. */
  densityScale?: number;
  seed?: number;
}

/**
 * Renders one stereo impulse response as raw channel data.
 *
 * Exported separately from {@link buildImpulse} so the analysis/debug pass can
 * measure IRs without needing an `AudioContext`.
 */
export function renderImpulse(
  sampleRate: number, spec: ImpulseSpec, opts: ImpulseRenderOptions = {},
): [F32, F32] {
  const lengthScale = opts.lengthScale ?? 1;
  const densityScale = opts.densityScale ?? 1;
  const rand = new Rand(`ir:${spec.id}:${opts.seed ?? 0}`);

  const seconds = spec.predelay + spec.rt60 * 1.12 * lengthScale + 0.05;
  const n = Math.ceil(seconds * sampleRate);
  const pre = Math.floor(spec.predelay * sampleRate);

  const channels: [F32, F32] = [new Float32Array(n), new Float32Array(n)];

  /* --- diffuse tail --------------------------------------------------- */
  const impulsesPerSecond = lerp(340, 6200, spec.density) * densityScale;
  const tailLen = n - pre;
  const raw = new Float32Array(tailLen);
  const tail = new Float32Array(tailLen);

  for (let c = 0; c < 2; c++) {
    raw.fill(0);
    tail.fill(0);
    velvet(raw, sampleRate, impulsesPerSecond, rand);
    bandedDecay(tail, raw, sampleRate, spec.rt60 * lengthScale, spec.bandDecay);

    // Build-up: real rooms take a few ms to go fully diffuse.
    const build = Math.max(1, Math.floor(0.012 * sampleRate));
    for (let i = 0; i < build && i < tailLen; i++) tail[i] *= i / build;

    const dst = channels[c];
    const w = c === 0 ? 1 : 1; // width applied below by cross-mixing
    for (let i = 0; i < tailLen; i++) dst[pre + i] += tail[i] * w;
  }

  // Stereo width: collapse toward mono when the space is narrow.
  if (spec.width < 0.999) {
    const w = clamp(spec.width, 0, 1);
    const a = channels[0], b = channels[1];
    for (let i = 0; i < n; i++) {
      const m = (a[i] + b[i]) * 0.5;
      const s = (a[i] - b[i]) * 0.5 * w;
      a[i] = m + s;
      b[i] = m - s;
    }
  }

  /* --- discrete early reflections ------------------------------------- */
  const erScratch = new Float32Array(n);
  for (const [time, gain, pan] of spec.early) {
    const at = pre + Math.floor(time * lengthScale * sampleRate);
    if (at >= n - 8) continue;
    // Each reflection is a short filtered burst, not a naked click: real walls
    // scatter, and a naked click sounds like a digital artefact.
    const burst = Math.max(3, Math.floor(0.0016 * sampleRate));
    erScratch.fill(0, at, Math.min(n, at + burst + 4));
    for (let i = 0; i < burst; i++) erScratch[at + i] = rand.signed() * (1 - i / burst);
    erScratch[at] += 1.4;
    const wall = new Biquad().set('lowpass', sampleRate, lerp(2600, 11000, gain), 0.8);
    const lo = clamp(1 - pan, 0, 2) * 0.5 + 0.0;
    const hi = clamp(1 + pan, 0, 2) * 0.5 + 0.0;
    for (let i = 0; i < burst + 4 && at + i < n; i++) {
      const v = wall.process(erScratch[at + i]) * gain;
      channels[0][at + i] += v * Math.sqrt(lo);
      channels[1][at + i] += v * Math.sqrt(hi);
    }
  }

  /* --- flutter echo ---------------------------------------------------- */
  if (spec.flutter > 0) {
    const period = Math.floor(spec.flutter * sampleRate);
    const taps = Math.min(64, Math.floor((n - pre) / Math.max(1, period)));
    const decay = Math.exp(-6.9078 * spec.flutter / (spec.rt60 * 0.72));
    let g = 0.5;
    for (let t = 1; t < taps; t++) {
      g *= decay;
      if (g < 0.0015) break;
      const at = pre + t * period;
      if (at >= n - 4) break;
      const s = rand.bool() ? 1 : -1;
      const side = t & 1 ? 1 : -1;
      channels[0][at] += g * s * (side > 0 ? 1 : 0.6);
      channels[1][at] += g * s * (side > 0 ? 0.6 : 1);
      channels[0][at + 1] += g * s * 0.4;
      channels[1][at + 1] += g * s * 0.4;
    }
  }

  /* --- global tone + normalisation ------------------------------------- */
  for (let c = 0; c < 2; c++) {
    const d = channels[c];
    new Biquad().set('lowpass', sampleRate, spec.tone, 0.62).run(d);
    new Biquad().set('highpass', sampleRate, 42, 0.7).run(d);
  }

  // Energy-normalise so swapping IRs does not change perceived wet level.
  //
  // The target matters enormously: for a noise-like input the convolver's
  // output RMS is the input RMS times sqrt(sum h[n]^2), so an IR carrying an
  // energy of E multiplies the send by sqrt(E). Unity energy therefore means
  // "wet is as loud as dry", and the send gains alone decide the wet/dry
  // balance. Getting this wrong by a factor of the sample rate — which is the
  // natural mistake, because normalising to a *duration* feels right — buries
  // every sound under a wall of reverb.
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = channels[c];
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  const targetEnergy = 0.5;
  const g = energy > 1e-9 ? Math.sqrt(targetEnergy / energy) : 1;
  for (let c = 0; c < 2; c++) {
    const d = channels[c];
    for (let i = 0; i < n; i++) d[i] *= g;
    // Guard the very tail against a discontinuity.
    const fade = Math.min(n, Math.floor(0.02 * sampleRate));
    for (let i = 0; i < fade; i++) d[n - fade + i] *= 1 - i / fade;
  }

  return channels;
}

/** Renders a spec straight into an `AudioBuffer` for a `ConvolverNode`. */
export function buildImpulse(
  ctx: BaseAudioContext, id: ImpulseId, opts: ImpulseRenderOptions = {},
): AudioBuffer {
  const spec = IMPULSE_SPECS[id];
  const [l, r] = renderImpulse(ctx.sampleRate, spec, opts);
  const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
  buf.copyToChannel(l, 0);
  buf.copyToChannel(r, 1);
  return buf;
}

/**
 * Short "tail shaper" IR for weapon reports — a compressed version of the zone
 * response used as a per-shot send so distant gunfire keeps its own tail even
 * when the global reverb bus is quiet.
 */
export function buildWeaponTailImpulse(
  ctx: BaseAudioContext, id: ImpulseId, distance: number,
): AudioBuffer {
  const base = IMPULSE_SPECS[id];
  const stretch = clamp(1 + distance / 90, 1, 2.6);
  const spec: ImpulseSpec = {
    ...base,
    rt60: base.rt60 * stretch,
    predelay: base.predelay + clamp(distance / 2400, 0, 0.05),
    tone: clamp(base.tone * (1 - distance / 420), 700, base.tone),
    density: clamp(base.density * 1.15, 0, 1),
  };
  const [l, r] = renderImpulse(ctx.sampleRate, spec, { seed: 7 });
  const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
  buf.copyToChannel(l, 0);
  buf.copyToChannel(r, 1);
  return buf;
}
