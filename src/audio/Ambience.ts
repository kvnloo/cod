/**
 * Procedural ambience bed and adaptive tension score.
 *
 * The bed is continuous synthesis — wind through modulated bandpasses, a city
 * rumble floor, HVAC when indoors, and a sparse event layer (traffic swells,
 * birds, insects, distant gunfire) driven by a look-ahead scheduler. Nothing
 * loops audibly because nothing is a loop: the modulators are mutually prime
 * LFOs and the events are drawn from a seeded stream.
 *
 * The score sits on top and answers combat. Tension is a single 0..1 parameter
 * that opens a drone's filter, raises a pulse's rate, and brings in percussion —
 * so the music tracks the fight without a composer having authored transitions.
 */

import { Rand } from '../core/Rand';
import type { SfxContext } from './Context';
import {
  arLin, clamp, clamp01, filterNode, gainNode, lerp, noiseVoice, startNoise, sweep,
} from './Dsp';

/** Callback the audio system supplies so distant gunfire uses the real synth. */
export type DistantShotFn = (x: number, y: number, z: number, weaponId: string) => void;

interface LfoPair { osc: OscillatorNode; gain: GainNode; }

function lfo(ctx: BaseAudioContext, hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine'): LfoPair {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  const g = gainNode(ctx, depth);
  osc.connect(g);
  g.connect(target);
  return { osc, gain: g };
}

export interface AmbienceOptions {
  cheap?: boolean;
  onDistantShot?: DistantShotFn;
}

export class Ambience {
  private sfx: SfxContext;
  private ctx: BaseAudioContext;
  private rand: Rand;
  private cheap: boolean;
  private onDistantShot: DistantShotFn | undefined;

  /* beds */
  private ambRoot: GainNode;
  private musRoot: GainNode;
  private windGain: GainNode;
  private cityGain: GainNode;
  private interiorGain: GainNode;
  private eventGain: GainNode;

  private sources: AudioScheduledSourceNode[] = [];
  private started = false;

  /* state */
  private tension = 0;
  private tensionTarget = 0;
  private interior = 0;
  private hour = 10;
  private outdoors = 1;

  /* schedulers */
  private nextTraffic = 0;
  private nextBird = 0;
  private nextDistantFire = 0;
  private nextInsect = 0;
  private nextBeat = 0;
  private beatIndex = 0;

  /* music nodes */
  private droneGain: GainNode;
  private droneFilter: BiquadFilterNode;
  private droneOscs: OscillatorNode[] = [];
  private pulseGain: GainNode;
  private percGain: GainNode;

  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;

  constructor(sfx: SfxContext, o: AmbienceOptions = {}) {
    this.sfx = sfx;
    this.ctx = sfx.ctx;
    this.rand = new Rand('ambience');
    this.cheap = !!o.cheap;
    this.onDistantShot = o.onDistantShot;

    const ctx = this.ctx;
    this.ambRoot = gainNode(ctx, 1);
    this.ambRoot.connect(sfx.mixer.bus('ambience'));
    this.musRoot = gainNode(ctx, 1);
    this.musRoot.connect(sfx.mixer.bus('music'));

    this.windGain = gainNode(ctx, 0.34);
    this.cityGain = gainNode(ctx, 0.32);
    this.interiorGain = gainNode(ctx, 0);
    this.eventGain = gainNode(ctx, 0.5);
    this.windGain.connect(this.ambRoot);
    this.cityGain.connect(this.ambRoot);
    this.interiorGain.connect(this.ambRoot);
    this.eventGain.connect(this.ambRoot);

    this.droneGain = gainNode(ctx, 0);
    this.droneFilter = filterNode(ctx, 'lowpass', 260, 2.2);
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.musRoot);
    this.pulseGain = gainNode(ctx, 0.62);
    this.pulseGain.connect(this.musRoot);
    this.percGain = gainNode(ctx, 0);
    this.percGain.connect(this.musRoot);
  }

  /* ------------------------------------------------------------- startup -- */

  start(): void {
    if (this.started) return;
    this.started = true;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const rand = this.rand;

    /* --- wind: two decorrelated layers, panned wide ---------------------- */
    const windLayers = this.cheap ? 1 : 2;
    for (let i = 0; i < windLayers; i++) {
      const src = noiseVoice(ctx, i === 0 ? 'brown' : 'pink', rand, { loop: true });
      const bp = filterNode(ctx, 'bandpass', i === 0 ? 380 : 1250, i === 0 ? 0.85 : 1.6);
      const g = gainNode(ctx, i === 0 ? 0.5 : 0.22);
      const pan = ctx.createStereoPanner();
      pan.pan.value = i === 0 ? -0.55 : 0.6;
      src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(this.windGain);
      // Mutually prime modulation rates: the gust pattern never repeats.
      const f = lfo(ctx, i === 0 ? 0.037 : 0.053, i === 0 ? 210 : 640, bp.frequency);
      const a = lfo(ctx, i === 0 ? 0.023 : 0.031, i === 0 ? 0.26 : 0.14, g.gain, 'triangle');
      const b = lfo(ctx, i === 0 ? 0.0091 : 0.0071, i === 0 ? 0.18 : 0.1, g.gain, 'sine');
      f.osc.start(t0); a.osc.start(t0); b.osc.start(t0);
      this.sources.push(src, f.osc, a.osc, b.osc);
      startNoise(src, t0, rand);
    }

    /* --- city floor: sub-100 Hz traffic rumble --------------------------- */
    {
      const src = noiseVoice(ctx, 'brown', rand, { loop: true });
      const lp = filterNode(ctx, 'lowpass', 105, 0.7);
      const hp = filterNode(ctx, 'highpass', 32, 0.7);
      const g = gainNode(ctx, 0.55);
      src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(this.cityGain);
      const m = lfo(ctx, 0.017, 0.2, g.gain, 'sine');
      m.osc.start(t0);
      this.sources.push(src, m.osc);
      startNoise(src, t0, rand);

      // A distant, permanently-present mid wash: the sound of a city being
      // somewhere over there.
      const src2 = noiseVoice(ctx, 'pink', rand, { loop: true });
      const bp = filterNode(ctx, 'bandpass', 520, 0.6);
      const lp2 = filterNode(ctx, 'lowpass', 1400, 0.7);
      const g2 = gainNode(ctx, 0.12);
      src2.connect(bp); bp.connect(lp2); lp2.connect(g2); g2.connect(this.cityGain);
      const m2 = lfo(ctx, 0.0113, 0.06, g2.gain, 'triangle');
      m2.osc.start(t0);
      this.sources.push(src2, m2.osc);
      startNoise(src2, t0, rand);
    }

    /* --- interior: HVAC hum + duct hiss ---------------------------------- */
    if (!this.cheap) {
      const hum = ctx.createOscillator();
      hum.type = 'sine';
      hum.frequency.value = 49.7;
      const hum2 = ctx.createOscillator();
      hum2.type = 'sine';
      hum2.frequency.value = 99.4;
      const hg = gainNode(ctx, 0.22);
      const hg2 = gainNode(ctx, 0.09);
      hum.connect(hg); hg.connect(this.interiorGain);
      hum2.connect(hg2); hg2.connect(this.interiorGain);
      hum.start(t0); hum2.start(t0);

      const duct = noiseVoice(ctx, 'pink', rand, { loop: true });
      const bp = filterNode(ctx, 'bandpass', 2100, 0.8);
      const g = gainNode(ctx, 0.09);
      duct.connect(bp); bp.connect(g); g.connect(this.interiorGain);
      const m = lfo(ctx, 0.041, 320, bp.frequency);
      m.osc.start(t0);
      this.sources.push(hum, hum2, duct, m.osc);
      startNoise(duct, t0, rand);
    }

    /* --- score drone ------------------------------------------------------ */
    {
      // Root D1 with a fifth and a detuned octave — a wide, unresolved bed.
      const freqs = [36.7, 55.0, 73.4, 73.9];
      for (let i = 0; i < freqs.length; i++) {
        const o = ctx.createOscillator();
        o.type = i < 2 ? 'sawtooth' : 'triangle';
        o.frequency.value = freqs[i];
        const g = gainNode(ctx, i < 2 ? 0.34 : 0.2);
        o.connect(g); g.connect(this.droneFilter);
        // Slow, mutually prime detune keeps the stack alive.
        const d = lfo(ctx, 0.019 + i * 0.007, 2.4 + i * 0.8, o.detune, 'sine');
        d.osc.start(t0);
        o.start(t0);
        this.droneOscs.push(o);
        this.sources.push(o, d.osc);
      }
      // A noise layer under the drone gives it grit without muddying pitch.
      const n = noiseVoice(ctx, 'brown', rand, { loop: true });
      const nlp = filterNode(ctx, 'lowpass', 160, 0.8);
      const ng = gainNode(ctx, 0.35);
      n.connect(nlp); nlp.connect(ng); ng.connect(this.droneFilter);
      this.sources.push(n);
      startNoise(n, t0, rand);
    }

    const now = t0;
    this.nextTraffic = now + 4 + rand.next() * 6;
    this.nextBird = now + 2 + rand.next() * 5;
    this.nextDistantFire = now + 9 + rand.next() * 12;
    this.nextInsect = now + 3 + rand.next() * 6;
    this.nextBeat = now + 0.5;
  }

  /* -------------------------------------------------------------- control -- */

  setTension(v: number): void { this.tensionTarget = clamp01(v); }
  get tensionValue(): number { return this.tension; }
  /** 0 = fully outdoors, 1 = fully enclosed. */
  setInterior(v: number): void { this.interior = clamp01(v); }
  setTimeOfDay(hour: number): void { this.hour = ((hour % 24) + 24) % 24; }

  setListener(x: number, y: number, z: number): void {
    this.listenerX = x; this.listenerY = y; this.listenerZ = z;
  }

  /** Immediate combat spike; decays back down on its own. */
  bumpTension(amount: number): void {
    this.tensionTarget = clamp01(Math.max(this.tensionTarget, this.tension + amount));
  }

  /* --------------------------------------------------------------- update -- */

  update(dt: number): void {
    if (!this.started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = ctx.currentTime;

    // Tension rises fast and bleeds off slowly, like adrenaline.
    const rising = this.tensionTarget > this.tension;
    const rate = rising ? 3.2 : 0.085;
    this.tension += (this.tensionTarget - this.tension) * clamp01(rate * dt);
    if (!rising) this.tensionTarget = Math.max(0, this.tensionTarget - 0.028 * dt);

    /* --- bed balance ---------------------------------------------------- */
    this.outdoors = 1 - this.interior;
    const night = clamp01(Math.cos((this.hour / 24) * Math.PI * 2) * 0.5 + 0.5);
    this.windGain.gain.setTargetAtTime(lerp(0.62, 0.12, this.interior) * lerp(1, 0.72, night), t, 0.9);
    this.cityGain.gain.setTargetAtTime(lerp(0.5, 0.26, this.interior) * lerp(1, 0.68, night), t, 0.9);
    this.interiorGain.gain.setTargetAtTime(this.interior * 0.85, t, 0.9);
    this.eventGain.gain.setTargetAtTime(lerp(0.8, 0.35, this.interior), t, 0.6);

    /* --- score ------------------------------------------------------------ */
    const ten = this.tension;
    this.droneGain.gain.setTargetAtTime(lerp(0.06, 0.42, Math.pow(ten, 0.7)), t, 0.6);
    this.droneFilter.frequency.setTargetAtTime(lerp(150, 1500, Math.pow(ten, 1.3)), t, 0.5);
    this.droneFilter.Q.setTargetAtTime(lerp(1.4, 4.5, ten), t, 0.5);
    this.percGain.gain.setTargetAtTime(clamp01((ten - 0.28) / 0.72) * 0.6, t, 0.4);
    for (let i = 0; i < this.droneOscs.length; i++) {
      // The stack widens as things get worse.
      this.droneOscs[i].detune.setTargetAtTime((i - 1.5) * lerp(3, 22, ten), t, 0.7);
    }

    /* --- look-ahead event scheduling ------------------------------------- */
    const horizon = now + 0.75;

    while (this.nextTraffic < horizon) {
      this.scheduleTraffic(this.nextTraffic);
      this.nextTraffic += lerp(7, 17, this.rand.next()) * lerp(1, 1.8, this.interior);
    }
    while (this.nextBird < horizon) {
      if (night < 0.35 && this.tension < 0.4 && this.outdoors > 0.4) this.scheduleBird(this.nextBird);
      this.nextBird += lerp(3.5, 11, this.rand.next());
    }
    while (this.nextInsect < horizon) {
      if (night > 0.55 && this.outdoors > 0.4) this.scheduleInsect(this.nextInsect);
      this.nextInsect += lerp(4, 13, this.rand.next());
    }
    while (this.nextDistantFire < horizon) {
      this.scheduleDistantFire();
      this.nextDistantFire += lerp(8, 26, this.rand.next()) * lerp(1.9, 0.6, this.tension);
    }

    const bpm = lerp(56, 128, Math.pow(ten, 0.85));
    const beat = 60 / bpm;
    while (this.nextBeat < horizon) {
      this.scheduleBeat(this.nextBeat, this.beatIndex++);
      this.nextBeat += beat;
    }
  }

  /* --------------------------------------------------------------- events -- */

  private scheduleTraffic(at: number): void {
    const ctx = this.ctx;
    const rand = this.rand;
    const src = noiseVoice(ctx, 'brown', rand);
    const bp = filterNode(ctx, 'bandpass', lerp(180, 620, rand.next()), 1.1);
    const lp = filterNode(ctx, 'lowpass', 900, 0.7);
    const g = gainNode(ctx, 0);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand.signed() * 0.85;
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(pan); pan.connect(this.eventGain);
    const dur = lerp(1.8, 4.5, rand.next());
    // A vehicle passing: the band opens then closes, and the pan drifts.
    sweep(bp.frequency, at, 220, 520, dur * 0.5);
    sweep(bp.frequency, at + dur * 0.5, 520, 180, dur * 0.5);
    pan.pan.setValueAtTime(pan.pan.value, at);
    pan.pan.linearRampToValueAtTime(-pan.pan.value * 0.7, at + dur);
    const e = arLin(g.gain, at, lerp(0.1, 0.3, rand.next()), dur * 0.42, dur * 0.62);
    startNoise(src, at, rand, dur + 0.3);
    src.stop(e + 0.1);

    // Occasional horn, far off.
    if (rand.bool(0.12)) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = lerp(210, 330, rand.next());
      const og = gainNode(ctx, 0);
      const olp = filterNode(ctx, 'lowpass', 1400, 0.8);
      o.connect(olp); olp.connect(og); og.connect(pan);
      const hAt = at + dur * 0.35;
      const he = arLin(og.gain, hAt, 0.05, 0.03, lerp(0.25, 0.7, rand.next()));
      o.start(hAt); o.stop(he + 0.05);
    }
  }

  private scheduleBird(at: number): void {
    const ctx = this.ctx;
    const rand = this.rand;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand.signed() * 0.9;
    pan.connect(this.eventGain);
    const notes = 2 + rand.int(0, 4);
    let t = at;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = gainNode(ctx, 0);
      // FM gives the chirp its metallic edge without a wavetable.
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = lerp(90, 300, rand.next());
      const modGain = gainNode(ctx, lerp(120, 900, rand.next()));
      mod.connect(modGain); modGain.connect(o.frequency);
      o.connect(g); g.connect(pan);
      const f0 = lerp(2600, 5200, rand.next());
      const len = lerp(0.045, 0.13, rand.next());
      sweep(o.frequency, t, f0, f0 * lerp(0.6, 1.7, rand.next()), len);
      const e = arLin(g.gain, t, lerp(0.03, 0.085, rand.next()), 0.006, len);
      o.start(t); o.stop(e + 0.02);
      mod.start(t); mod.stop(e + 0.02);
      t += len + lerp(0.03, 0.11, rand.next());
    }
  }

  private scheduleInsect(at: number): void {
    const ctx = this.ctx;
    const rand = this.rand;
    // Cricket: a fast pulsed band, three or four chirps.
    const src = noiseVoice(ctx, 'white', rand);
    const bp = filterNode(ctx, 'bandpass', lerp(4200, 6400, rand.next()), 22);
    const g = gainNode(ctx, 0);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand.signed() * 0.95;
    src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(this.eventGain);
    const pulses = 3 + rand.int(0, 2);
    const amp = lerp(0.018, 0.045, rand.next());
    for (let i = 0; i < pulses; i++) {
      arLin(g.gain, at + i * 0.075, amp, 0.004, 0.035);
    }
    startNoise(src, at, rand, pulses * 0.08 + 0.1);
    src.stop(at + pulses * 0.08 + 0.15);
  }

  private scheduleDistantFire(): void {
    if (!this.onDistantShot) return;
    const rand = this.rand;
    // Somewhere 150–420 m away, at ground level, in a random direction.
    const a = rand.next() * Math.PI * 2;
    const d = lerp(150, 420, rand.next());
    const x = this.listenerX + Math.cos(a) * d;
    const z = this.listenerZ + Math.sin(a) * d;
    const y = this.listenerY + lerp(-2, 6, rand.next());
    const weapons = ['ar', 'ar', 'smg', 'lmg', 'sniper'];
    const id = weapons[rand.int(0, weapons.length - 1)];
    const burst = id === 'sniper' ? 1 : 2 + rand.int(0, 5);
    for (let i = 0; i < burst; i++) {
      const delay = i * lerp(0.075, 0.13, rand.next());
      setTimeoutSafe(() => this.onDistantShot?.(x, y, z, id), delay * 1000);
    }
  }

  /* ------------------------------------------------------------ percussion -- */

  private scheduleBeat(at: number, index: number): void {
    const ten = this.tension;
    if (ten < 0.06) return;
    const ctx = this.ctx;
    const rand = this.rand;
    const bar = index % 8;

    // Downbeat: a low, filtered thump. Always present once tension exists.
    if (bar % 4 === 0) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = gainNode(ctx, 0);
      const sat = filterNode(ctx, 'lowpass', 220, 0.9);
      o.connect(sat); sat.connect(g); g.connect(this.pulseGain);
      sweep(o.frequency, at, lerp(78, 120, ten), 34, 0.09);
      const e = arLin(g.gain, at, lerp(0.12, 0.42, ten), 0.003, lerp(0.14, 0.3, ten));
      o.start(at); o.stop(e + 0.02);
    }

    // Off-beat metallic tick once things get serious.
    if (ten > 0.3 && bar % 2 === 1) {
      const src = noiseVoice(ctx, 'white', rand);
      const bp = filterNode(ctx, 'bandpass', lerp(3200, 6800, rand.next()), 6);
      const g = gainNode(ctx, 0);
      src.connect(bp); bp.connect(g); g.connect(this.percGain);
      const e = arLin(g.gain, at, lerp(0.05, 0.16, ten) * (bar === 5 ? 1.5 : 1), 0.001, 0.045);
      startNoise(src, at, rand, 0.1);
      src.stop(e + 0.02);
    }

    // A rising riser into every fourth bar at high tension.
    if (ten > 0.62 && bar === 6) {
      const src = noiseVoice(ctx, 'pink', rand);
      const bp = filterNode(ctx, 'bandpass', 400, 3);
      const g = gainNode(ctx, 0);
      src.connect(bp); bp.connect(g); g.connect(this.percGain);
      const dur = 60 / lerp(56, 128, ten) * 2;
      sweep(bp.frequency, at, 420, 4200, dur);
      const e = arLin(g.gain, at, 0.14 * ten, dur * 0.85, dur * 0.2);
      startNoise(src, at, rand, dur + 0.2);
      src.stop(e + 0.05);
    }
  }

  /** One-shot musical accent, e.g. on a kill or a death. */
  stinger(kind: 'kill' | 'death' | 'objective'): void {
    const ctx = this.ctx;
    const rand = this.rand;
    const at = ctx.currentTime + 0.01;
    const roots: Record<string, number[]> = {
      kill: [146.8, 220.0, 293.7],
      death: [98.0, 116.5, 146.8],
      objective: [130.8, 196.0, 261.6],
    };
    const set = roots[kind];
    const long = kind === 'death';
    for (let i = 0; i < set.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'triangle';
      o.frequency.value = set[i];
      const g = gainNode(ctx, 0);
      const lp = filterNode(ctx, 'lowpass', long ? 900 : 2200, 1.2);
      o.connect(lp); lp.connect(g); g.connect(this.musRoot);
      if (long) sweep(o.frequency, at, set[i], set[i] * 0.86, 2.4);
      const e = arLin(g.gain, at, 0.16 - i * 0.03, long ? 0.12 : 0.01, long ? 2.6 : 0.85);
      o.start(at); o.stop(e + 0.05);
    }
    void rand;
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.ambRoot.gain.setTargetAtTime(0, t, 0.4);
    this.musRoot.gain.setTargetAtTime(0, t, 0.4);
    for (const s of this.sources) { try { s.stop(t + 1.2); } catch { /* not started */ } }
  }

  dispose(): void {
    for (const s of this.sources) { try { s.stop(); s.disconnect(); } catch { /* closed */ } }
    this.sources.length = 0;
    try { this.ambRoot.disconnect(); this.musRoot.disconnect(); } catch { /* closed */ }
  }
}

function setTimeoutSafe(fn: () => void, ms: number): void {
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(fn, ms);
}
