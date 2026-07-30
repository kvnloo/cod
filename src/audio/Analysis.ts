/**
 * Offline analysis.
 *
 * Screenshots cannot verify audio, so this module provides the substitute: an
 * FFT, a spectrogram, and a set of numeric descriptors (peak, RMS, crest,
 * spectral centroid, rolloff, band split, attack time, RT60-style decay) that
 * the debug scene asserts on and plots. "Each weapon is spectrally distinct" is
 * a claim you can *measure*, and this is what measures it.
 */

/* ------------------------------------------------------------------ fft -- */

/** In-place iterative radix-2 Cooley-Tukey. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + half], bi = im[i + j + half];
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        re[i + j] = ar + vr; im[i + j] = ai + vi;
        re[i + j + half] = ar - vr; im[i + j + half] = ai - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hannCache = new Map<number, Float32Array>();
export function hann(n: number): Float32Array {
  const hit = hannCache.get(n);
  if (hit) return hit;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, w);
  return w;
}

/** Magnitude spectrum of one windowed frame. Returns `size/2` bins. */
export function frameSpectrum(data: Float32Array, offset: number, size: number, out?: Float32Array): Float32Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const w = hann(size);
  for (let i = 0; i < size; i++) {
    const k = offset + i;
    re[i] = (k < data.length ? data[k] : 0) * w[i];
  }
  fft(re, im);
  const bins = size >> 1;
  const mag = out && out.length === bins ? out : new Float32Array(bins);
  for (let i = 0; i < bins; i++) mag[i] = Math.hypot(re[i], im[i]) / (size * 0.5);
  return mag;
}

/* -------------------------------------------------------------- metrics -- */

export interface SoundMetrics {
  samples: number;
  duration: number;
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  /** Peak / RMS in dB — how transient the sound is. */
  crestDb: number;
  /** Energy-weighted mean frequency, Hz. */
  centroid: number;
  /** Frequency below which 85 % of the energy lies, Hz. */
  rolloff85: number;
  /** Geometric/arithmetic mean ratio — 0 tonal, 1 noise-like. */
  flatness: number;
  /** Fraction of energy below 250 Hz / 250-2000 / above 2000. */
  lowRatio: number;
  midRatio: number;
  highRatio: number;
  /** Seconds from the start of the buffer to the peak. */
  attack: number;
  /** Seconds from the peak until the envelope falls 60 dB. */
  decay60: number;
  /** Seconds until the envelope first exceeds −40 dBFS — propagation delay. */
  onset: number;
  /**
   * Seconds between the first and last time the envelope is within 34 dB of
   * the peak. A single hit has a tiny span; a reload sequence has a long one,
   * which is how "this is choreography, not one sound" gets measured.
   */
  span: number;
  /** Number of zero crossings per second. */
  zcr: number;
  /** −1..1 correlation between channels; 1 is mono, 0 is fully decorrelated. */
  stereoCorrelation: number;
  clipped: boolean;
}

function envelope(data: Float32Array, sampleRate: number, tau = 0.006): Float32Array {
  const a = Math.exp(-1 / (tau * sampleRate));
  const env = new Float32Array(data.length);
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    const x = Math.abs(data[i]);
    y = x > y ? x : x + a * (y - x);
    env[i] = y;
  }
  return env;
}

export function analyse(
  mono: Float32Array, sampleRate: number, left?: Float32Array, right?: Float32Array,
): SoundMetrics {
  const n = mono.length;
  let peak = 0, sum = 0, zc = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = mono[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
    if ((v >= 0) !== (prev >= 0)) zc++;
    prev = v;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));

  // Spectrum: average frames weighted by frame energy so quiet tail frames do
  // not drag the centroid around.
  const size = 2048;
  const hop = 512;
  const bins = size >> 1;
  const acc = new Float64Array(bins);
  let frames = 0;
  let totalWeight = 0;
  const scratch = new Float32Array(bins);
  for (let off = 0; off + size <= n; off += hop) {
    const mag = frameSpectrum(mono, off, size, scratch);
    let e = 0;
    for (let i = 0; i < bins; i++) e += mag[i] * mag[i];
    if (e < 1e-12) continue;
    const w = Math.sqrt(e);
    for (let i = 0; i < bins; i++) acc[i] += mag[i] * w;
    totalWeight += w;
    frames++;
  }
  if (totalWeight > 0) for (let i = 0; i < bins; i++) acc[i] /= totalWeight;
  if (frames === 0 && n >= 64) {
    // Signal shorter than one frame: analyse whatever there is.
    const pad = new Float32Array(size);
    pad.set(mono.subarray(0, Math.min(n, size)));
    const mag = frameSpectrum(pad, 0, size);
    for (let i = 0; i < bins; i++) acc[i] = mag[i];
  }

  const binHz = sampleRate / size;
  let sMag = 0, sFreq = 0, logSum = 0, nz = 0;
  let low = 0, mid = 0, high = 0;
  for (let i = 1; i < bins; i++) {
    const m = acc[i];
    const f = i * binHz;
    sMag += m;
    sFreq += m * f;
    if (m > 1e-12) { logSum += Math.log(m); nz++; }
    const e = m * m;
    if (f < 250) low += e; else if (f < 2000) mid += e; else high += e;
  }
  const centroid = sMag > 1e-12 ? sFreq / sMag : 0;
  const arith = sMag / Math.max(1, bins - 1);
  const geo = nz > 0 ? Math.exp(logSum / nz) : 0;
  const flatness = arith > 1e-12 ? Math.min(1, geo / arith) : 0;

  let cum = 0;
  const target = sMag * 0.85;
  let rolloff = 0;
  for (let i = 1; i < bins; i++) {
    cum += acc[i];
    if (cum >= target) { rolloff = i * binHz; break; }
  }

  const bandTotal = low + mid + high;
  const env = envelope(mono, sampleRate);
  let peakIdx = 0;
  for (let i = 0; i < n; i++) if (env[i] > env[peakIdx]) peakIdx = i;
  const envPeak = env[peakIdx] || 1e-9;

  let decayIdx = n - 1;
  const floorV = envPeak * 0.001; // −60 dB
  for (let i = peakIdx; i < n; i++) {
    if (env[i] <= floorV) { decayIdx = i; break; }
  }
  let onsetIdx = 0;
  const onsetV = envPeak * 0.01; // −40 dB relative
  for (let i = 0; i < n; i++) {
    if (env[i] >= onsetV) { onsetIdx = i; break; }
  }

  const spanV = envPeak * 0.02; // −34 dB relative
  let spanFirst = -1, spanLast = -1;
  for (let i = 0; i < n; i++) {
    if (env[i] >= spanV) { if (spanFirst < 0) spanFirst = i; spanLast = i; }
  }

  // Correlation must be between the two channels, not between the mono sum and
  // one channel — the latter is inflated by construction and would report every
  // stereo field as narrower than it is.
  let corr = 1;
  if (left && right && left.length === n && right.length === n) {
    let ll = 0, rr = 0, lr = 0;
    for (let i = 0; i < n; i++) {
      ll += left[i] * left[i];
      rr += right[i] * right[i];
      lr += left[i] * right[i];
    }
    corr = ll > 1e-12 && rr > 1e-12 ? lr / Math.sqrt(ll * rr) : 1;
  }

  let clipped = false;
  for (let i = 0; i < n; i++) if (Math.abs(mono[i]) >= 0.999) { clipped = true; break; }

  const db = (v: number): number => 20 * Math.log10(Math.max(1e-9, v));
  return {
    samples: n,
    duration: n / sampleRate,
    peak, peakDb: db(peak),
    rms, rmsDb: db(rms),
    crestDb: db(peak) - db(rms),
    centroid,
    rolloff85: rolloff,
    flatness,
    lowRatio: bandTotal > 0 ? low / bandTotal : 0,
    midRatio: bandTotal > 0 ? mid / bandTotal : 0,
    highRatio: bandTotal > 0 ? high / bandTotal : 0,
    attack: peakIdx / sampleRate,
    decay60: Math.max(0, (decayIdx - peakIdx) / sampleRate),
    onset: onsetIdx / sampleRate,
    span: spanFirst >= 0 ? (spanLast - spanFirst) / sampleRate : 0,
    zcr: (zc * sampleRate) / Math.max(1, n),
    stereoCorrelation: corr,
    clipped,
  };
}

/* ---------------------------------------------------------- spectrogram -- */

export interface Spectrogram {
  frames: number;
  bins: number;
  /** dBFS magnitudes, row-major [frame][bin]. */
  data: Float32Array;
  hopSeconds: number;
  binHz: number;
  minDb: number;
  maxDb: number;
}

export function spectrogram(
  data: Float32Array, sampleRate: number, size = 1024, hop = 256, maxFrames = 512,
): Spectrogram {
  const bins = size >> 1;
  const total = Math.max(1, Math.floor((data.length - size) / hop) + 1);
  const stride = Math.max(1, Math.ceil(total / maxFrames));
  const frames = Math.max(1, Math.ceil(total / stride));
  const out = new Float32Array(frames * bins);
  const scratch = new Float32Array(bins);
  let maxDb = -200;
  for (let f = 0; f < frames; f++) {
    const off = f * stride * hop;
    const mag = frameSpectrum(data, off, size, scratch);
    for (let b = 0; b < bins; b++) {
      const db = 20 * Math.log10(Math.max(1e-9, mag[b]));
      out[f * bins + b] = db;
      if (db > maxDb) maxDb = db;
    }
  }
  return {
    frames, bins, data: out,
    hopSeconds: (stride * hop) / sampleRate,
    binHz: sampleRate / size,
    minDb: maxDb - 78,
    maxDb,
  };
}

/* ---------------------------------------------------------- IR analysis -- */

/**
 * Schroeder backward integration: the standard way to get a reverberation time
 * out of an impulse response. Fits the −5 → −35 dB slope and extrapolates.
 */
export function estimateRt60(ir: Float32Array, sampleRate: number): number {
  const n = ir.length;
  const energy = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i--) energy[i] = energy[i + 1] + ir[i] * ir[i];
  const total = energy[0];
  if (total <= 1e-12) return 0;
  let i5 = -1, i35 = -1;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(Math.max(1e-15, energy[i] / total));
    if (i5 < 0 && db <= -5) i5 = i;
    if (i35 < 0 && db <= -35) { i35 = i; break; }
  }
  if (i5 < 0 || i35 < 0 || i35 <= i5) return n / sampleRate;
  return ((i35 - i5) / sampleRate) * 2;
}

/** Time to the first sample above a threshold — the predelay of a response. */
export function firstArrival(ir: Float32Array, sampleRate: number, threshold = 0.02): number {
  let peak = 0;
  for (let i = 0; i < ir.length; i++) peak = Math.max(peak, Math.abs(ir[i]));
  const t = peak * threshold;
  for (let i = 0; i < ir.length; i++) if (Math.abs(ir[i]) >= t) return i / sampleRate;
  return 0;
}

/* --------------------------------------------------------------- render -- */

/**
 * Renders a synthesis callback into a buffer with an `OfflineAudioContext`.
 * Returns the raw channels so callers can analyse without a live context.
 */
export interface RenderTick {
  /** Seconds between callbacks during rendering. */
  interval: number;
  fn: (elapsed: number) => void;
}

export async function renderOffline(
  seconds: number, sampleRate: number,
  build: (ctx: OfflineAudioContext) => void | Promise<void>,
  channels = 2,
  tick?: RenderTick,
): Promise<{ left: Float32Array; right: Float32Array; mono: Float32Array; sampleRate: number }> {
  const frames = Math.max(128, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(channels, frames, sampleRate);
  await build(ctx);

  // Look-ahead schedulers (ambience, music) need the render clock to advance
  // before they will queue the next window, so drive them through suspend().
  if (tick) {
    const suspendable = ctx as OfflineAudioContext & {
      suspend?(when: number): Promise<void>;
      resume?(): Promise<void>;
    };
    if (typeof suspendable.suspend === 'function') {
      for (let t = tick.interval; t < seconds; t += tick.interval) {
        const at = t;
        void suspendable.suspend(at).then(() => {
          try { tick.fn(tick.interval); } catch { /* scheduler hiccup is not fatal */ }
          void suspendable.resume?.();
        });
      }
    }
  }

  const buf = await ctx.startRendering();
  const left = new Float32Array(buf.length);
  buf.copyFromChannel(left, 0);
  const right = new Float32Array(buf.length);
  if (buf.numberOfChannels > 1) buf.copyFromChannel(right, 1);
  else right.set(left);
  const mono = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) mono[i] = (left[i] + right[i]) * 0.5;
  return { left, right, mono, sampleRate };
}

/* ------------------------------------------------------------ assertions -- */

export interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

export function assert(name: string, condition: boolean, detail: string): Assertion {
  return { name, pass: condition, detail };
}

export function assertBetween(name: string, value: number, lo: number, hi: number, unit = ''): Assertion {
  const pass = value >= lo && value <= hi;
  return {
    name, pass,
    detail: `${value.toFixed(value < 10 ? 3 : 0)}${unit} ∈ [${lo}${unit}, ${hi}${unit}]`,
  };
}

export function assertOrder(name: string, values: Array<{ label: string; v: number }>): Assertion {
  let pass = true;
  for (let i = 1; i < values.length; i++) if (values[i].v <= values[i - 1].v) pass = false;
  return {
    name, pass,
    detail: values.map((x) => `${x.label}=${x.v < 10 ? x.v.toFixed(3) : x.v.toFixed(0)}`).join(' < '),
  };
}
