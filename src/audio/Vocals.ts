/**
 * Vocalisations and physiological feedback.
 *
 * Grunts are formant synthesis: a jittered glottal pulse train plus a breath
 * noise component driven through three parallel resonant bandpasses at the
 * formant frequencies of a vowel. Move the formants and the same machinery
 * produces "ugh", "aargh" and a dying exhale. No recorded voice, no words —
 * which is also why it never sounds like the wrong actor.
 *
 * Radio chatter uses the same source, band-limited to 300–3000 Hz, chopped into
 * syllables and topped with squelch, so AI callouts read as speech without ever
 * being intelligible enough to repeat.
 *
 * Heartbeat and tinnitus are the physiological layer. Both are injected into
 * the mixer's *bypass* node, downstream of the deafness lowpass — after a
 * flashbang the world goes muffled and quiet while your own pulse and the ring
 * in your ears stay perfectly clear, which is the entire effect.
 */

import { Rand } from '../core/Rand';
import type { SfxContext } from './Context';
import type { Mixer } from './Mixer';
import {
  SPEED_OF_SOUND, arLin, clamp, clamp01, filterNode, gainNode, lerp,
  noiseVoice, startNoise, sweep,
} from './Dsp';

let cursor = 0;

/* -------------------------------------------------------------- formants -- */

interface Vowel { f: [number, number, number]; g: [number, number, number]; bw: [number, number, number]; }

const VOWELS: Record<string, Vowel> = {
  /* "uh" — the standard impact grunt. */
  uh: { f: [640, 1190, 2390], g: [1.0, 0.5, 0.22], bw: [80, 90, 120] },
  /* "ah" — open, used for heavy damage. */
  ah: { f: [730, 1090, 2440], g: [1.0, 0.62, 0.24], bw: [90, 100, 130] },
  /* "aw" — closed, dying fall. */
  aw: { f: [570, 840, 2410], g: [1.0, 0.45, 0.16], bw: [70, 85, 130] },
  /* "eh" — effort/exertion. */
  eh: { f: [530, 1840, 2480], g: [1.0, 0.55, 0.3], bw: [65, 95, 130] },
};

export type GruntKind = 'hit' | 'heavy' | 'death' | 'effort' | 'breath' | 'enemyHit' | 'enemyDeath';

interface GruntSpec {
  vowel: keyof typeof VOWELS;
  f0: number;
  f0End: number;
  duration: number;
  attack: number;
  breath: number;
  gain: number;
  /** Vibrato/roughness on the glottal pulse. */
  jitter: number;
}

const GRUNTS: Record<GruntKind, GruntSpec> = {
  hit: { vowel: 'uh', f0: 118, f0End: 92, duration: 0.26, attack: 0.012, breath: 0.3, gain: 0.75, jitter: 0.05 },
  heavy: { vowel: 'ah', f0: 132, f0End: 88, duration: 0.52, attack: 0.02, breath: 0.42, gain: 0.95, jitter: 0.09 },
  death: { vowel: 'aw', f0: 108, f0End: 58, duration: 1.15, attack: 0.05, breath: 0.7, gain: 0.85, jitter: 0.13 },
  effort: { vowel: 'eh', f0: 126, f0End: 108, duration: 0.2, attack: 0.015, breath: 0.35, gain: 0.5, jitter: 0.04 },
  breath: { vowel: 'uh', f0: 100, f0End: 96, duration: 0.6, attack: 0.09, breath: 1.0, gain: 0.35, jitter: 0.02 },
  enemyHit: { vowel: 'ah', f0: 142, f0End: 104, duration: 0.34, attack: 0.014, breath: 0.35, gain: 0.85, jitter: 0.08 },
  enemyDeath: { vowel: 'aw', f0: 128, f0End: 62, duration: 0.95, attack: 0.04, breath: 0.65, gain: 0.9, jitter: 0.14 },
};

export interface GruntOptions {
  kind: GruntKind;
  x?: number; y?: number; z?: number;
  firstPerson?: boolean;
  /** Shifts the whole voice: 0 = large male, 1 = smaller/higher. */
  timbre?: number;
  gain?: number;
}

export function playGrunt(sfx: SfxContext, o: GruntOptions): void {
  const { ctx, pool } = sfx;
  const spec = GRUNTS[o.kind];
  const fp = !!o.firstPerson;
  const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0;
  const dist = fp ? 0 : pool.distanceTo(x, y, z);
  if (dist > 55) return;

  const rand = new Rand(`grunt:${o.kind}:${cursor++}`);
  const timbre = clamp01(o.timbre ?? rand.next() * 0.4);
  const shift = lerp(0.92, 1.28, timbre);
  const t0 = sfx.now() + (fp ? 0 : dist / SPEED_OF_SOUND);

  const voice = pool.acquire({
    bus: 'voice',
    x, y, z, spatial: !fp,
    gain: spec.gain * (o.gain ?? 1) * (fp ? 0.9 : 1),
    send: 0.4, priority: 0.75,
    refDistance: 3, rolloff: 1.15, maxDistance: 55,
  });
  if (!voice) return;

  const vowel = VOWELS[spec.vowel];
  const dur = spec.duration * (0.85 + rand.next() * 0.3);

  // Glottal source: a sawtooth is a serviceable pulse train once it is run
  // through formants, and it is one node instead of a wavetable.
  const glottis = ctx.createOscillator();
  glottis.type = 'sawtooth';
  const f0 = spec.f0 * shift;
  const f1 = spec.f0End * shift;
  sweep(glottis.frequency, t0, f0 * (0.95 + rand.next() * 0.12), f1, dur);

  // Jitter — micro-instability. Without it, a synthetic voice sounds like an
  // organ; with it, it sounds like a person straining.
  const jitter = ctx.createOscillator();
  jitter.type = 'triangle';
  jitter.frequency.value = lerp(4.5, 9.5, rand.next());
  const jGain = gainNode(ctx, f0 * spec.jitter);
  jitter.connect(jGain); jGain.connect(glottis.frequency);
  jitter.start(t0); jitter.stop(t0 + dur + 0.05);

  const source = gainNode(ctx, 1 - spec.breath * 0.4);
  glottis.connect(source);

  // Breath: noise through the same formants gives an aspirated voice.
  const breath = noiseVoice(ctx, 'pink', rand);
  const breathHp = filterNode(ctx, 'highpass', 420, 0.7);
  const breathGain = gainNode(ctx, spec.breath * 0.55);
  breath.connect(breathHp); breathHp.connect(breathGain); breathGain.connect(source);

  const out = gainNode(ctx, 0);
  for (let i = 0; i < 3; i++) {
    const f = vowel.f[i] * shift;
    const q = f / vowel.bw[i];
    const bp = filterNode(ctx, 'bandpass', f, q);
    const g = gainNode(ctx, vowel.g[i]);
    source.connect(bp); bp.connect(g); g.connect(out);
    // Formants move as the mouth closes over the sound.
    sweep(bp.frequency, t0, f * 1.06, f * 0.88, dur);
  }
  // A little direct source keeps the chest in it.
  const direct = filterNode(ctx, 'lowpass', 380, 0.8);
  const directG = gainNode(ctx, 0.28);
  source.connect(direct); direct.connect(directG); directG.connect(out);

  const shaped = filterNode(ctx, 'highpass', 110, 0.7);
  out.connect(shaped); shaped.connect(voice.input);

  const end = arLin(out.gain, t0, 1.0, spec.attack, dur);
  glottis.start(t0); glottis.stop(end + 0.05);
  startNoise(breath, t0, rand, dur + 0.1);
  breath.stop(end + 0.05);

  voice.releaseAt(end + 0.1);
}

/* --------------------------------------------------------- radio chatter -- */

export interface ChatterOptions {
  x?: number; y?: number; z?: number;
  /** 0 = calm report, 1 = shouted contact call. */
  urgency: number;
  /** Rough syllable count. */
  syllables?: number;
  /** True routes it through the player's radio instead of the world. */
  radio?: boolean;
  seed?: number;
}

/**
 * Squad callouts. Syllabic formant bursts inside a 300–3000 Hz radio band with
 * a squelch tick either side. Intelligible as *speech*, never as words.
 */
export function playChatter(sfx: SfxContext, o: ChatterOptions): void {
  const { ctx, pool } = sfx;
  const radio = !!o.radio;
  const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0;
  const dist = radio ? 0 : pool.distanceTo(x, y, z);
  if (dist > 60) return;

  const rand = new Rand(`chatter:${o.seed ?? cursor++}`);
  const urgency = clamp01(o.urgency);
  const syllables = o.syllables ?? 2 + rand.int(0, 3 + Math.round(urgency * 2));
  const t0 = sfx.now() + (radio ? 0 : dist / SPEED_OF_SOUND);

  const voice = pool.acquire({
    bus: 'voice', x, y, z, spatial: !radio,
    gain: radio ? 0.55 : lerp(0.6, 0.95, urgency),
    send: radio ? 0.05 : 0.45, priority: 0.6,
    refDistance: 4, rolloff: 1.1, maxDistance: 60,
  });
  if (!voice) return;

  const band = filterNode(ctx, 'bandpass', 1150, 0.9);
  const band2 = filterNode(ctx, 'bandpass', 1600, 1.4);
  const out = gainNode(ctx, radio ? 1.0 : 0.85);
  band.connect(band2); band2.connect(out); out.connect(voice.input);

  // Squelch open.
  if (radio) {
    const sq = noiseVoice(ctx, 'white', rand);
    const sg = gainNode(ctx, 0);
    const shp = filterNode(ctx, 'highpass', 2200, 0.7);
    sq.connect(shp); shp.connect(sg); sg.connect(out);
    const e = arLin(sg.gain, t0, 0.22, 0.002, 0.05);
    startNoise(sq, t0, rand, 0.1);
    sq.stop(e + 0.02);
  }

  let at = t0 + (radio ? 0.06 : 0);
  const baseF0 = lerp(102, 152, rand.next()) * lerp(1, 1.18, urgency);
  const vowelKeys = Object.keys(VOWELS);

  for (let s = 0; s < syllables; s++) {
    const v = VOWELS[vowelKeys[rand.int(0, vowelKeys.length - 1)]];
    const len = lerp(0.09, 0.2, rand.next()) * lerp(1.15, 0.8, urgency);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f0 = baseF0 * lerp(0.9, 1.15, rand.next());
    sweep(osc.frequency, at, f0, f0 * lerp(0.86, 1.1, rand.next()), len);
    const src = gainNode(ctx, 0.7);
    osc.connect(src);

    const noise = noiseVoice(ctx, 'pink', rand);
    const ng = gainNode(ctx, 0.3);
    noise.connect(ng); ng.connect(src);

    const syl = gainNode(ctx, 0);
    for (let i = 0; i < 3; i++) {
      const f = v.f[i] * lerp(0.95, 1.08, rand.next());
      const bp = filterNode(ctx, 'bandpass', f, f / v.bw[i]);
      const g = gainNode(ctx, v.g[i]);
      src.connect(bp); bp.connect(g); g.connect(syl);
    }
    syl.connect(band);
    const e = arLin(syl.gain, at, lerp(0.55, 1.0, rand.next()), 0.014, len);
    osc.start(at); osc.stop(e + 0.03);
    startNoise(noise, at, rand, len + 0.05);
    noise.stop(e + 0.03);

    at += len + lerp(0.02, 0.07, rand.next()) * lerp(1.2, 0.6, urgency);
  }

  // Squelch close.
  if (radio) {
    const sq = noiseVoice(ctx, 'white', rand);
    const sg = gainNode(ctx, 0);
    const shp = filterNode(ctx, 'highpass', 2600, 0.7);
    sq.connect(shp); shp.connect(sg); sg.connect(out);
    arLin(sg.gain, at + 0.03, 0.18, 0.002, 0.06);
    startNoise(sq, at + 0.03, rand, 0.12);
    sq.stop(at + 0.16);
  }

  voice.releaseAt(at + 0.35);
}

/* ------------------------------------------------------------- heartbeat -- */

/** One lub-dub. Called on a timer whose rate is driven by health and stress. */
export function playHeartbeat(sfx: SfxContext, mixer: Mixer, intensity: number): void {
  const { ctx } = sfx;
  const amt = clamp01(intensity);
  if (amt < 0.02) return;
  const t0 = sfx.now();
  const rand = new Rand(`heart:${cursor++}`);

  const out = gainNode(ctx, 0.85 * amt);
  const lp = filterNode(ctx, 'lowpass', 180, 0.9);
  out.connect(lp);
  lp.connect(mixer.bypass);

  const beat = (at: number, f0: number, f1: number, peak: number, decay: number): number => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = gainNode(ctx, 0);
    osc.connect(g); g.connect(out);
    sweep(osc.frequency, at, f0, f1, decay * 0.7);
    const e = arLin(g.gain, at, peak, 0.006, decay);
    osc.start(at); osc.stop(e + 0.02);
    // A little body noise so it is not a pure tone.
    const n = noiseVoice(ctx, 'brown', rand);
    const ng = gainNode(ctx, 0);
    const nlp = filterNode(ctx, 'lowpass', 220, 0.7);
    n.connect(nlp); nlp.connect(ng); ng.connect(out);
    arLin(ng.gain, at, peak * 0.5, 0.004, decay * 0.8);
    startNoise(n, at, rand, decay + 0.05);
    n.stop(e + 0.03);
    return e;
  };

  beat(t0, 64, 36, 0.9, 0.14);
  const end = beat(t0 + 0.21, 56, 32, 0.6, 0.11);
  // Node cleanup happens when the sources finish and the head is dropped.
  setTimeoutSafe(() => { try { out.disconnect(); } catch { /* gone */ } }, (end - t0 + 0.3) * 1000);
}

function setTimeoutSafe(fn: () => void, ms: number): void {
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(fn, ms);
}

/* -------------------------------------------------------------- tinnitus -- */

/**
 * The ring. Three slightly detuned high sines plus a narrow noise band; the
 * detuning makes them beat against each other so the tone breathes instead of
 * sitting there like a test signal. Lives for the whole session and is simply
 * turned up and down.
 */
export class Tinnitus {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private tone: GainNode;
  private noise: GainNode;
  private oscs: OscillatorNode[] = [];
  private noiseSrc: AudioBufferSourceNode | null = null;
  private started = false;
  private level = 0;

  constructor(ctx: BaseAudioContext, mixer: Mixer) {
    this.ctx = ctx;
    this.out = gainNode(ctx, 0);
    this.out.connect(mixer.bypass);
    this.tone = gainNode(ctx, 1);
    this.noise = gainNode(ctx, 0.35);
    this.tone.connect(this.out);
    this.noise.connect(this.out);
  }

  private ensure(): void {
    if (this.started) return;
    this.started = true;
    const ctx = this.ctx;
    const rand = new Rand('tinnitus');
    const partials = [4180, 4197, 5620];
    for (const f of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * (0.995 + rand.next() * 0.01);
      const g = gainNode(ctx, f > 5000 ? 0.28 : 0.5);
      o.connect(g); g.connect(this.tone);
      o.start();
      this.oscs.push(o);
    }
    const n = noiseVoice(ctx, 'white', rand, { loop: true });
    const bp = filterNode(ctx, 'bandpass', 6400, 5.5);
    n.connect(bp); bp.connect(this.noise);
    n.start();
    this.noiseSrc = n;
  }

  /** 0..1. Rises instantly, falls slowly. */
  set(amount: number): void {
    const a = clamp01(amount);
    if (a > 0.001) this.ensure();
    if (!this.started) return;
    this.level = a;
    const t = this.ctx.currentTime;
    // Perceptually the ring is loudest right after the blast and then settles.
    this.out.gain.setTargetAtTime(Math.pow(a, 1.4) * 0.16, t, a > this.level ? 0.03 : 0.35);
  }

  get amount(): number { return this.level; }

  dispose(): void {
    for (const o of this.oscs) { try { o.stop(); o.disconnect(); } catch { /* closed */ } }
    try { this.noiseSrc?.stop(); this.noiseSrc?.disconnect(); } catch { /* closed */ }
    try { this.out.disconnect(); } catch { /* closed */ }
  }
}

/** Sharp ear-ringing onset: the whistle right after a flashbang detonates. */
export function playFlashbangOnset(sfx: SfxContext, mixer: Mixer, intensity: number): void {
  const { ctx } = sfx;
  const amt = clamp01(intensity);
  const t0 = sfx.now();
  const rand = new Rand(`flash:${cursor++}`);

  const out = gainNode(ctx, 0);
  out.connect(mixer.bypass);

  // A descending whistle that resolves into the steady ring.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const og = gainNode(ctx, 0.7);
  osc.connect(og); og.connect(out);
  sweep(osc.frequency, t0, 9200, 4400, 0.5);
  osc.start(t0); osc.stop(t0 + 1.6);

  const noise = noiseVoice(ctx, 'white', rand, { loop: true });
  const bp = filterNode(ctx, 'bandpass', 7200, 2.4);
  const ng = gainNode(ctx, 0.35);
  noise.connect(bp); bp.connect(ng); ng.connect(out);
  noise.start(t0);
  noise.stop(t0 + 1.6);

  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(0.22 * amt, t0 + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
  setTimeoutSafe(() => { try { out.disconnect(); } catch { /* gone */ } }, 1900);
}
