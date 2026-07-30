/**
 * Interface sounds.
 *
 * Deliberately tiny, dry and consistent: every UI element is built from the
 * same two primitives (a filtered click and a short shaped tone) so the whole
 * front end sounds like one instrument. Hit feedback is the exception — it has
 * to cut through a firefight, so it is bright, extremely short, and on its own
 * bus that barely ducks.
 */

import { Rand } from '../core/Rand';
import type { SfxContext } from './Context';
import {
  arLin, clamp01, filterNode, gainNode, lerp, noiseVoice, startNoise, sweep,
} from './Dsp';

export type UiSound =
  | 'hover' | 'select' | 'back' | 'error' | 'notify'
  | 'hitmarker' | 'hitmarkerHead' | 'hitmarkerArmor' | 'kill'
  | 'killstreak' | 'objective' | 'lowAmmo' | 'pickup' | 'countdown';

let cursor = 0;

interface Blip { hz: number; to?: number; at: number; dur: number; gain: number; type: OscillatorType }

const TONES: Partial<Record<UiSound, Blip[]>> = {
  hover: [{ hz: 2400, at: 0, dur: 0.02, gain: 0.16, type: 'triangle' }],
  select: [
    { hz: 900, at: 0, dur: 0.035, gain: 0.3, type: 'triangle' },
    { hz: 1800, at: 0.012, dur: 0.05, gain: 0.18, type: 'sine' },
  ],
  back: [
    { hz: 1400, at: 0, dur: 0.04, gain: 0.24, type: 'triangle' },
    { hz: 700, at: 0.035, dur: 0.06, gain: 0.2, type: 'triangle' },
  ],
  error: [{ hz: 190, to: 140, at: 0, dur: 0.16, gain: 0.3, type: 'square' }],
  notify: [
    { hz: 1320, at: 0, dur: 0.08, gain: 0.2, type: 'sine' },
    { hz: 1980, at: 0.06, dur: 0.12, gain: 0.16, type: 'sine' },
  ],
  hitmarker: [{ hz: 2650, at: 0, dur: 0.022, gain: 0.34, type: 'square' }],
  hitmarkerHead: [
    { hz: 3200, at: 0, dur: 0.02, gain: 0.36, type: 'square' },
    { hz: 4300, at: 0.026, dur: 0.026, gain: 0.3, type: 'square' },
  ],
  hitmarkerArmor: [{ hz: 1750, to: 1400, at: 0, dur: 0.04, gain: 0.32, type: 'sawtooth' }],
  kill: [
    { hz: 1046, at: 0, dur: 0.07, gain: 0.28, type: 'triangle' },
    { hz: 1568, at: 0.05, dur: 0.1, gain: 0.24, type: 'triangle' },
  ],
  killstreak: [
    { hz: 523, at: 0, dur: 0.12, gain: 0.26, type: 'triangle' },
    { hz: 784, at: 0.09, dur: 0.13, gain: 0.24, type: 'triangle' },
    { hz: 1046, at: 0.18, dur: 0.3, gain: 0.28, type: 'triangle' },
  ],
  objective: [
    { hz: 392, at: 0, dur: 0.22, gain: 0.24, type: 'sine' },
    { hz: 587, at: 0.14, dur: 0.34, gain: 0.2, type: 'sine' },
  ],
  lowAmmo: [{ hz: 2200, to: 1600, at: 0, dur: 0.05, gain: 0.2, type: 'square' }],
  pickup: [
    { hz: 1320, at: 0, dur: 0.05, gain: 0.22, type: 'sine' },
    { hz: 1760, at: 0.04, dur: 0.09, gain: 0.2, type: 'sine' },
  ],
  countdown: [{ hz: 880, at: 0, dur: 0.09, gain: 0.26, type: 'square' }],
};

/** Which sounds get a noise click layered under the tone, and how bright. */
const CLICKS: Partial<Record<UiSound, { hz: number; q: number; gain: number; dur: number }>> = {
  hover: { hz: 6000, q: 2.5, gain: 0.06, dur: 0.008 },
  select: { hz: 4200, q: 1.6, gain: 0.16, dur: 0.014 },
  back: { hz: 3000, q: 1.6, gain: 0.12, dur: 0.014 },
  error: { hz: 900, q: 1.2, gain: 0.14, dur: 0.03 },
  hitmarker: { hz: 5200, q: 2.0, gain: 0.2, dur: 0.008 },
  hitmarkerHead: { hz: 7000, q: 2.2, gain: 0.22, dur: 0.008 },
  hitmarkerArmor: { hz: 3200, q: 1.4, gain: 0.24, dur: 0.016 },
  kill: { hz: 5000, q: 1.8, gain: 0.14, dur: 0.01 },
  pickup: { hz: 4600, q: 2.0, gain: 0.1, dur: 0.01 },
};

export function playUi(sfx: SfxContext, sound: UiSound, gain = 1): void {
  const { ctx, pool } = sfx;
  const rand = new Rand(`ui:${sound}:${cursor++}`);
  const voice = pool.acquire({
    bus: 'ui', spatial: false, gain,
    send: sound === 'killstreak' || sound === 'objective' ? 0.3 : 0.02,
    priority: 0.95,
    pan: 0,
  });
  if (!voice) return;
  const t0 = sfx.now();
  let end = t0 + 0.05;

  const tones = TONES[sound] ?? TONES.select!;
  for (const b of tones) {
    const osc = ctx.createOscillator();
    osc.type = b.type;
    const g = gainNode(ctx, 0);
    // Keep square/saw blips from being harsh on headphones.
    const lp = filterNode(ctx, 'lowpass', b.type === 'sine' ? 20000 : 7200, 0.7);
    osc.connect(lp); lp.connect(g); g.connect(voice.input);
    if (b.to) sweep(osc.frequency, t0 + b.at, b.hz, b.to, b.dur);
    else osc.frequency.setValueAtTime(b.hz, t0 + b.at);
    const e = arLin(g.gain, t0 + b.at, b.gain, 0.0015, b.dur);
    osc.start(t0 + b.at); osc.stop(e + 0.02);
    end = Math.max(end, e);
  }

  const c = CLICKS[sound];
  if (c) {
    const src = noiseVoice(ctx, 'white', rand);
    const bp = filterNode(ctx, 'bandpass', c.hz, c.q);
    const g = gainNode(ctx, 0);
    src.connect(bp); bp.connect(g); g.connect(voice.input);
    const e = arLin(g.gain, t0, c.gain, 0.0004, c.dur);
    startNoise(src, t0, rand, c.dur + 0.02);
    src.stop(e + 0.02);
    end = Math.max(end, e);
  }

  voice.releaseAt(end + 0.06);
}

/** Hitmarker chosen from the damage result. */
export function playHitmarker(sfx: SfxContext, headshot: boolean, killed: boolean, armor: boolean): void {
  if (killed) { playUi(sfx, 'kill', 1); return; }
  if (headshot) { playUi(sfx, 'hitmarkerHead', 1); return; }
  if (armor) { playUi(sfx, 'hitmarkerArmor', 1); return; }
  playUi(sfx, 'hitmarker', 1);
}

/**
 * Score/reward flourish whose pitch rises with the streak count — a cheap way
 * to make the tenth kill feel different from the second.
 */
export function playReward(sfx: SfxContext, count: number): void {
  const { ctx, pool } = sfx;
  const voice = pool.acquire({ bus: 'ui', spatial: false, gain: 1, send: 0.35, priority: 0.95 });
  if (!voice) return;
  const t0 = sfx.now();
  const rand = new Rand(`reward:${count}`);
  const root = 392 * Math.pow(2, clamp01(count / 12) * 0.58);
  const steps = [0, 4, 7, 12];
  let end = t0;
  for (let i = 0; i < steps.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = i === steps.length - 1 ? 'triangle' : 'sine';
    osc.frequency.value = root * Math.pow(2, steps[i] / 12);
    const g = gainNode(ctx, 0);
    osc.connect(g); g.connect(voice.input);
    const at = t0 + i * 0.075;
    const e = arLin(g.gain, at, lerp(0.16, 0.26, i / steps.length), 0.004, i === steps.length - 1 ? 0.5 : 0.12);
    osc.start(at); osc.stop(e + 0.02);
    end = Math.max(end, e);
  }
  void rand;
  voice.releaseAt(end + 0.1);
}
