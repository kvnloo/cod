/**
 * Weapon report synthesis — the layered AAA formula.
 *
 * A modern shooter's gunshot is never one sound. It is four, mixed by distance:
 *
 * 1. **Crack** — an N-wave: a 2-4 ms broadband burst whose bandpass sweeps down
 *    an octave and a half while it decays, hit hard with asymmetric saturation.
 *    This is 90 % of the "close and dangerous" impression and almost none of the
 *    energy that survives 100 m of air.
 * 2. **Body** — the muzzle blast: filtered brown noise plus a sine dropping from
 *    ~160 Hz to ~45 Hz. This is the chest thump, and it is what you still hear
 *    across a map.
 * 3. **Mech** — the action cycling: bolt, spring, ejector. Baked modal buffers
 *    scheduled a few tens of milliseconds behind the shot. Inaudible past ~15 m,
 *    which is exactly why first-person weapons feel mechanical and enemy weapons
 *    do not.
 * 4. **Tail** — the report convolved with the environment. Close in, this is the
 *    shared reverb-zone send. Far out, a dedicated per-distance impulse whose
 *    length and colour come from the zone, so a rifle across a street canyon
 *    gives the characteristic *crack — BOOM — roooaaar*.
 *
 * Distance also drives structure, not just volume: the propagation delay
 * (d/343 s) is real, the crack fades faster than the body, the mech layer dies
 * almost immediately, and everything above a few kHz is eaten by the air
 * absorption filter in the voice strip.
 */

import { Rand } from '../core/Rand';
import { settings } from '../core/Settings';
import type { SfxContext } from './Context';
import type { ImpulseId } from './types';
import type { Mixer } from './Mixer';
import { buildWeaponTailImpulse } from './Impulses';
import {
  SPEED_OF_SOUND, arLin, asymCurve, clamp, clamp01, filterNode,
  gainNode, lerp, noiseVoice, shaperNode, softClipCurve, startNoise, sweep,
} from './Dsp';

/* ------------------------------------------------------------- profiles -- */

export type WeaponFamily = 'ar' | 'smg' | 'lmg' | 'sniper' | 'shotgun' | 'pistol' | 'launcher';

export interface MechEvent {
  at: number;
  kind: 'light' | 'heavy' | 'spring' | 'latch' | 'bolt';
  gain: number;
  rate: number;
}

export interface WeaponAudioProfile {
  id: string;
  family: WeaponFamily;
  /** Overall linear trim. */
  gain: number;
  /** Metres at which the report is still worth spawning a voice for. */
  range: number;

  crackHz: number;
  crackSweep: number;
  crackQ: number;
  crackDecay: number;
  crackGain: number;
  crackDrive: number;

  bodyFrom: number;
  bodyTo: number;
  bodyGlide: number;
  bodyDecay: number;
  bodyGain: number;
  bodyTone: number;

  subHz: number;
  subDecay: number;
  subGain: number;

  punchHz: number;
  punchQ: number;
  punchDecay: number;
  punchGain: number;

  mech: MechEvent[];
  tailGain: number;
  tailTone: number;
  /** Extra HF emphasis, 1 = neutral. */
  brightness: number;
  /** Rounds fired per trigger pull (shotgun pellets read as one broader blast). */
  spread: number;
}

function profile(o: Partial<WeaponAudioProfile> & Pick<WeaponAudioProfile, 'id' | 'family'>): WeaponAudioProfile {
  return {
    gain: 1, range: 320,
    crackHz: 3100, crackSweep: 0.34, crackQ: 1.5, crackDecay: 0.036, crackGain: 1.0, crackDrive: 3.2,
    bodyFrom: 168, bodyTo: 50, bodyGlide: 0.05, bodyDecay: 0.115, bodyGain: 0.95, bodyTone: 900,
    subHz: 46, subDecay: 0.16, subGain: 0.5,
    punchHz: 720, punchQ: 1.15, punchDecay: 0.055, punchGain: 0.62,
    mech: [
      { at: 0.026, kind: 'light', gain: 0.42, rate: 1.0 },
      { at: 0.051, kind: 'spring', gain: 0.24, rate: 1.05 },
    ],
    tailGain: 0.85, tailTone: 2600, brightness: 1, spread: 1,
    ...o,
  };
}

export const WEAPON_PROFILES: Record<string, WeaponAudioProfile> = {
  /* 5.56 assault rifle — the reference weapon. Punchy, mid-forward. */
  ar: profile({
    id: 'ar', family: 'ar', gain: 1.0, range: 360,
  }),

  /* 9 mm SMG — fast, bright, small body. */
  smg: profile({
    id: 'smg', family: 'smg', gain: 0.86, range: 260,
    crackHz: 4700, crackSweep: 0.4, crackQ: 1.9, crackDecay: 0.022, crackGain: 0.98, crackDrive: 2.7,
    bodyFrom: 215, bodyTo: 72, bodyGlide: 0.035, bodyDecay: 0.072, bodyGain: 0.72, bodyTone: 1150,
    subHz: 58, subDecay: 0.1, subGain: 0.26,
    punchHz: 980, punchQ: 1.3, punchDecay: 0.04, punchGain: 0.56,
    mech: [
      { at: 0.019, kind: 'light', gain: 0.5, rate: 1.15 },
      { at: 0.037, kind: 'spring', gain: 0.3, rate: 1.2 },
    ],
    tailGain: 0.6, tailTone: 3100, brightness: 1.15,
  }),

  /* 7.62 belt-fed — deep, heavy, long tail. */
  lmg: profile({
    id: 'lmg', family: 'lmg', gain: 1.12, range: 440,
    crackHz: 1850, crackSweep: 0.26, crackQ: 1.15, crackDecay: 0.056, crackGain: 0.78, crackDrive: 3.4,
    bodyFrom: 142, bodyTo: 39, bodyGlide: 0.07, bodyDecay: 0.19, bodyGain: 1.28, bodyTone: 610,
    subHz: 34, subDecay: 0.26, subGain: 0.9,
    punchHz: 560, punchQ: 1.0, punchDecay: 0.075, punchGain: 0.72,
    mech: [
      { at: 0.03, kind: 'heavy', gain: 0.42, rate: 0.92 },
      { at: 0.058, kind: 'bolt', gain: 0.3, rate: 0.95 },
    ],
    tailGain: 0.95, tailTone: 1900, brightness: 0.84,
  }),

  /* .338 bolt gun — enormous, long, and the crack carries a long way. */
  sniper: profile({
    id: 'sniper', family: 'sniper', gain: 1.3, range: 700,
    crackHz: 2750, crackSweep: 0.3, crackQ: 1.25, crackDecay: 0.07, crackGain: 1.55, crackDrive: 4.6,
    bodyFrom: 124, bodyTo: 33, bodyGlide: 0.095, bodyDecay: 0.33, bodyGain: 1.25, bodyTone: 700,
    subHz: 30, subDecay: 0.44, subGain: 1.05,
    punchHz: 540, punchQ: 1.0, punchDecay: 0.11, punchGain: 0.95,
    mech: [{ at: 0.045, kind: 'bolt', gain: 0.22, rate: 0.85 }],
    tailGain: 2.3, tailTone: 2000, brightness: 0.92,
  }),

  /* 12-gauge — broad, low, no crack to speak of. */
  shotgun: profile({
    id: 'shotgun', family: 'shotgun', gain: 1.18, range: 300,
    crackHz: 2050, crackSweep: 0.66, crackQ: 0.65, crackDecay: 0.045, crackGain: 1.2, crackDrive: 4.1,
    bodyFrom: 172, bodyTo: 40, bodyGlide: 0.055, bodyDecay: 0.15, bodyGain: 1.3, bodyTone: 900,
    subHz: 42, subDecay: 0.18, subGain: 0.8,
    punchHz: 640, punchQ: 0.55, punchDecay: 0.065, punchGain: 1.1,
    mech: [
      { at: 0.19, kind: 'latch', gain: 0.4, rate: 0.9 },
      { at: 0.3, kind: 'heavy', gain: 0.45, rate: 0.85 },
    ],
    tailGain: 0.72, tailTone: 2200, brightness: 0.98, spread: 2.0,
  }),

  /* 9 mm sidearm — sharp and small. */
  pistol: profile({
    id: 'pistol', family: 'pistol', gain: 0.8, range: 240,
    crackHz: 3050, crackSweep: 0.38, crackQ: 1.45, crackDecay: 0.032, crackGain: 0.9, crackDrive: 2.5,
    bodyFrom: 205, bodyTo: 64, bodyGlide: 0.04, bodyDecay: 0.085, bodyGain: 0.7, bodyTone: 1050,
    subHz: 55, subDecay: 0.11, subGain: 0.3,
    punchHz: 740, punchQ: 1.1, punchDecay: 0.05, punchGain: 0.66,
    mech: [
      { at: 0.024, kind: 'light', gain: 0.55, rate: 1.1 },
      { at: 0.048, kind: 'latch', gain: 0.35, rate: 1.0 },
    ],
    tailGain: 0.58, tailTone: 3000, brightness: 1.08,
  }),

  /* Tube launcher — mostly whoosh and pressure, no crack. */
  launcher: profile({
    id: 'launcher', family: 'launcher', gain: 1.1, range: 420,
    crackHz: 1200, crackSweep: 0.7, crackQ: 0.7, crackDecay: 0.12, crackGain: 0.55, crackDrive: 2.0,
    bodyFrom: 110, bodyTo: 28, bodyGlide: 0.16, bodyDecay: 0.4, bodyGain: 1.2, bodyTone: 540,
    subHz: 28, subDecay: 0.5, subGain: 0.9,
    punchHz: 380, punchQ: 0.7, punchDecay: 0.18, punchGain: 0.7,
    mech: [{ at: 0.07, kind: 'heavy', gain: 0.3, rate: 0.8 }],
    tailGain: 1.3, tailTone: 1500, brightness: 0.8,
  }),
};

const idCache = new Map<string, WeaponAudioProfile>();

/**
 * Maps whatever id the weapon module ends up using onto an acoustic family.
 * Deliberately fuzzy: audio must not break when weapons are renamed.
 */
export function profileFor(weaponId: string): WeaponAudioProfile {
  const cached = idCache.get(weaponId);
  if (cached) return cached;
  const id = weaponId.toLowerCase();
  let p = WEAPON_PROFILES.ar;
  if (/sniper|bolt|dmr|marksman|barrett|awp|\bsr\b|_sr|^sr_/.test(id)) p = WEAPON_PROFILES.sniper;
  else if (/shotgun|shot|pump|buck|\bsg\b|_sg|^sg_/.test(id)) p = WEAPON_PROFILES.shotgun;
  else if (/lmg|mg_|_mg|machinegun|saw|belt/.test(id)) p = WEAPON_PROFILES.lmg;
  else if (/smg|mp5|mp7|uzi|vector|pdw/.test(id)) p = WEAPON_PROFILES.smg;
  else if (/pistol|hand|glock|revolver|deagle|\bp\d/.test(id)) p = WEAPON_PROFILES.pistol;
  else if (/launch|rpg|rocket|grenade_l|gl_/.test(id)) p = WEAPON_PROFILES.launcher;
  else if (/rifle|ar_|_ar|carbine|ak|m4|scar/.test(id)) p = WEAPON_PROFILES.ar;
  idCache.set(weaponId, p);
  return p;
}

/* ------------------------------------------------------------ tail rack -- */

const TAIL_BUCKETS = [55, 130, 260, 480];

/**
 * Shared convolution tails for distant gunfire.
 *
 * One convolver per distance bucket rather than one per shot: the impulse for
 * a bucket is the zone response stretched and darkened for that range, so a
 * shot 200 m away gets a genuinely longer, duller tail than one at 60 m without
 * paying for a convolver per trigger pull.
 */
export class WeaponTailRack {
  private ctx: BaseAudioContext;
  private convolvers: ConvolverNode[] = [];
  private inputs: GainNode[] = [];
  private ir: ImpulseId | null = null;
  private disabled: boolean;

  constructor(ctx: BaseAudioContext, mixer: Mixer, disabled = false) {
    this.ctx = ctx;
    this.disabled = disabled;
    if (disabled) return;
    for (let i = 0; i < TAIL_BUCKETS.length; i++) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const g = gainNode(ctx, 1);
      g.connect(conv);
      conv.connect(mixer.bus('weapon'));
      this.convolvers.push(conv);
      this.inputs.push(g);
    }
  }

  /** Rebuilds the impulses when the listener's acoustic zone changes. */
  setImpulse(id: ImpulseId): void {
    if (this.disabled || id === this.ir) return;
    this.ir = id;
    for (let i = 0; i < TAIL_BUCKETS.length; i++) {
      this.convolvers[i].buffer = buildWeaponTailImpulse(this.ctx, id, TAIL_BUCKETS[i]);
    }
  }

  /** Send node for a given distance, or null when tails are disabled. */
  inputFor(distance: number): GainNode | null {
    if (this.disabled) return null;
    let i = 0;
    while (i < TAIL_BUCKETS.length - 1 && distance > TAIL_BUCKETS[i]) i++;
    return this.inputs[i];
  }

  dispose(): void {
    for (const g of this.inputs) { try { g.disconnect(); } catch { /* closed */ } }
    for (const c of this.convolvers) { try { c.disconnect(); } catch { /* closed */ } }
    this.inputs.length = 0;
    this.convolvers.length = 0;
  }
}

/* --------------------------------------------------------------- report -- */

export interface ShotOptions {
  weaponId: string;
  x: number; y: number; z: number;
  /** True for the local player's own weapon: no propagation delay, more mech. */
  firstPerson?: boolean;
  suppressed?: boolean;
  /** Index within a burst; used for round-robin variation. */
  shotIndex?: number;
  /** Extra gain, e.g. quieter AI weapons at long range. */
  gain?: number;
  /** Pre-computed occlusion, 0..1. */
  occlusion?: number;
}

export interface WeaponSoundState {
  /** Last trigger time per weapon, for the "first shot is bigger" rule. */
  lastShot: Map<string, number>;
  tails: WeaponTailRack;
}

export function createWeaponState(ctx: BaseAudioContext, mixer: Mixer, cheap: boolean): WeaponSoundState {
  return { lastShot: new Map(), tails: new WeaponTailRack(ctx, mixer, cheap) };
}

/**
 * Fires one report. Returns the scheduled end time, or 0 when the shot was
 * culled (out of range or no voice available).
 */
export function playShot(sfx: SfxContext, state: WeaponSoundState, o: ShotOptions): number {
  const p = profileFor(o.weaponId);
  const { ctx, pool, bank } = sfx;
  const fp = !!o.firstPerson;
  const dist = fp ? 0 : pool.distanceTo(o.x, o.y, o.z);
  if (dist > p.range) return 0;

  const rand = new Rand(`shot:${o.weaponId}:${o.shotIndex ?? 0}:${Math.round(dist * 7)}`);
  const now = sfx.now();
  // Sound is slow. A rifle 200 m away is heard 0.58 s after its muzzle flash.
  const t0 = now + (fp ? 0 : dist / SPEED_OF_SOUND);

  const closeness = clamp01(1 - dist / 42);
  const far = 1 - closeness;
  const suppressed = !!o.suppressed;

  // The first round out of a cold weapon reads louder and rounder than the
  // twentieth of a burst — a small trick that stops full-auto from flattening.
  const last = state.lastShot.get(o.weaponId) ?? -10;
  const firstOfBurst = t0 - last > 0.34;
  state.lastShot.set(o.weaponId, t0);
  const burstTrim = firstOfBurst ? 1.14 : 1.0;

  const voice = pool.acquire({
    bus: 'weapon',
    x: o.x, y: o.y, z: o.z,
    spatial: !fp,
    gain: p.gain * (o.gain ?? 1) * burstTrim * (suppressed ? 0.36 : 1) * (fp ? 0.72 : 1),
    send: (suppressed ? 0.09 : 0.34) * p.tailGain,
    priority: fp ? 1 : 0.82,
    refDistance: fp ? 1 : 4.5,
    rolloff: 0.92,
    maxDistance: p.range,
    occlusion: o.occlusion,
    airDistance: dist,
  });
  if (!voice) return 0;

  const dest = voice.input;
  const brightness = p.brightness * (suppressed ? 0.55 : 1);
  let endsAt = t0 + 0.25;

  /* --- 1. crack --------------------------------------------------------- */
  {
    const gainAmt = suppressed
      ? p.crackGain * 0.5
      : p.crackGain * 1.75 * (0.07 + 0.93 * Math.pow(closeness, 1.25)) * (fp ? 1.08 : 1);
    if (gainAmt > 0.004) {
      const src = noiseVoice(ctx, suppressed ? 'pink' : 'white', rand);
      const bp = filterNode(ctx, 'bandpass', p.crackHz * brightness, p.crackQ);
      const drive = shaperNode(ctx, asymCurve(p.crackDrive), sfx.cheap ? 'none' : '2x');
      const hp = filterNode(ctx, 'highpass', suppressed ? 700 : 460, 0.7);
      const g = gainNode(ctx, 0);
      src.connect(bp); bp.connect(drive); drive.connect(hp); hp.connect(g); g.connect(dest);

      const decay = p.crackDecay * (suppressed ? 1.5 : 1) * (1 + far * 0.55);
      // The sweep is the whole trick: the band falls an octave and a half in a
      // few milliseconds, which is what the ear reads as a supersonic snap.
      sweep(bp.frequency, t0, p.crackHz * brightness * (1 + p.crackSweep),
        p.crackHz * brightness * (1 - p.crackSweep * 0.55), decay * 0.9);
      const end = arLin(g.gain, t0, gainAmt, 0.0009, decay);
      startNoise(src, t0, rand, decay + 0.05);
      src.stop(end + 0.02);
      endsAt = Math.max(endsAt, end);
    }
  }

  /* --- 2. body / muzzle blast ------------------------------------------- */
  {
    const bodyGain = p.bodyGain * (suppressed ? 0.42 : 0.82) * (0.5 + 0.5 * closeness);
    const decay = p.bodyDecay * (1 + dist / 130) * (suppressed ? 0.7 : 1);

    const src = noiseVoice(ctx, 'brown', rand);
    const lp = filterNode(ctx, 'lowpass', p.bodyTone, 1.05);
    // Brown noise is −6 dB/oct: without this highpass the layer is dominated by
    // 20-60 Hz rumble that no speaker reproduces and that eats every dB of
    // headroom the limiter has.
    const hp = filterNode(ctx, 'highpass', 92, 0.72);
    const drive = shaperNode(ctx, softClipCurve(suppressed ? 1.4 : 2.4), sfx.cheap ? 'none' : '2x');
    const g = gainNode(ctx, 0);
    src.connect(lp); lp.connect(hp); hp.connect(drive); drive.connect(g); g.connect(dest);
    sweep(lp.frequency, t0, p.bodyTone * (suppressed ? 0.6 : 1.9), Math.max(90, p.bodyTone * 0.34), p.bodyGlide * 3);
    const end = arLin(g.gain, t0, bodyGain, 0.0022, decay);
    startNoise(src, t0, rand, decay + 0.08);
    src.stop(end + 0.03);
    endsAt = Math.max(endsAt, end);

    // Pitched sub: the sine drop that gives the shot a definite note under the
    // noise, and the only part of it a small speaker will ever reproduce.
    if (p.subGain > 0.02) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const og = gainNode(ctx, 0);
      osc.connect(og); og.connect(dest);
      const from = p.bodyFrom * (suppressed ? 0.75 : 1);
      sweep(osc.frequency, t0, from, p.bodyTo, p.bodyGlide * 2.2);
      const subEnd = arLin(og.gain, t0, p.subGain * (suppressed ? 0.4 : 0.72) * (0.45 + 0.55 * closeness),
        0.0016, p.subDecay * (1 + far * 0.6));
      osc.start(t0);
      osc.stop(subEnd + 0.02);
      endsAt = Math.max(endsAt, subEnd);
    }
  }

  /* --- 3. punch / mid --------------------------------------------------- */
  if (!sfx.cheap && p.punchGain > 0.02) {
    const src = noiseVoice(ctx, 'pink', rand);
    const bp = filterNode(ctx, 'bandpass', p.punchHz, p.punchQ / p.spread);
    const g = gainNode(ctx, 0);
    src.connect(bp); bp.connect(g); g.connect(dest);
    const amt = p.punchGain * (suppressed ? 0.5 : 1.6) * Math.pow(clamp01(closeness + 0.22), 0.7);
    const end = arLin(g.gain, t0, amt, 0.0018, p.punchDecay * (1 + far * 0.8));
    startNoise(src, t0, rand, p.punchDecay + 0.05);
    src.stop(end + 0.02);
    endsAt = Math.max(endsAt, end);
  }

  /* --- 4. mech ---------------------------------------------------------- */
  {
    // Action noise is quiet and close-range; suppressed weapons are almost all
    // mech, which is exactly why they sound "mechanical" rather than "quiet".
    const mechScale = suppressed
      ? (fp ? 1.5 : 1.1) * Math.pow(clamp01(1 - dist / 34), 1.2)
      : (fp ? 1.0 : 0.75) * Math.pow(clamp01(1 - dist / 20), 2.1);
    if (mechScale > 0.02) {
      for (const m of p.mech) {
        const buf = bank.mech(m.kind, rand.int(0, 3));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = m.rate * (0.94 + rand.next() * 0.12);
        const g = gainNode(ctx, m.gain * mechScale * 0.85);
        const hp = filterNode(ctx, 'highpass', 300, 0.7);
        src.connect(hp); hp.connect(g); g.connect(dest);
        const at = t0 + m.at * (0.9 + rand.next() * 0.2);
        src.start(at);
        endsAt = Math.max(endsAt, at + buf.duration);
      }
    }
  }

  /* --- 5. distance tail ------------------------------------------------- */
  if (!suppressed && !sfx.cheap) {
    const tailIn = state.tails.inputFor(dist);
    // The tail bypasses the voice strip, so it has to reproduce the strip's
    // physics itself: distance attenuation (softened, because reverb falls off
    // more slowly than the direct path) and occlusion. Without the first, a
    // rifle 300 m away is as loud as one at 5 m — the tail simply never gets
    // quieter. Without the second, a shot fired through a wall still fills the
    // street with reverb.
    const tailRef = fp ? 1 : 4.5;
    const dryAtten = tailRef / Math.max(tailRef, tailRef + 0.92 * (dist - tailRef));
    const tailAmt = p.tailGain * (0.1 + 0.95 * far) * sfx.reverb.activeWet * 0.75
      * Math.pow(dryAtten, 0.55)
      * lerp(1, 0.15, clamp01(voice.occl));
    if (tailIn && tailAmt > 0.01) {
      const src = noiseVoice(ctx, 'brown', rand);
      const lp = filterNode(ctx, 'lowpass', clamp(p.tailTone * (1 - far * 0.55), 320, 6000), 0.8);
      const hp = filterNode(ctx, 'highpass', 60, 0.6);
      const g = gainNode(ctx, 0);
      src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(tailIn);
      // Far shots have a slower attack: the tail is the room answering, and the
      // room takes time to fill.
      const attack = lerp(0.002, 0.03, far);
      const decay = clamp(sfx.reverb.tailSeconds(dist) * 0.4, 0.08, 0.9);
      const end = arLin(g.gain, t0, tailAmt, attack, decay);
      startNoise(src, t0, rand, decay + 0.1);
      src.stop(end + 0.05);
      // The tail's nodes hang off the shared rack, not off this voice, so the
      // voice must NOT be held open for the length of the reverb. Doing so
      // pinned ~15 voices per second of automatic fire against the budget for
      // no audible benefit.
      endsAt = Math.max(endsAt, end);
    }
  }

  /* --- 6. mix reaction --------------------------------------------------- */
  if (!suppressed) {
    const depth = lerp(9, 1.5, clamp01(dist / 26)) * (fp ? 1 : 0.7);
    if (depth > 1.6) {
      sfx.mixer.duck({ depthDb: depth, attack: 0.006, hold: 0.035, release: 0.22, source: 'weapon' });
    }
  }

  voice.releaseAt(endsAt + 0.12);
  return endsAt;
}

/* ------------------------------------------------------- supersonic pass -- */

export interface WhizzOptions {
  /** Point on the bullet's path closest to the listener. */
  x: number; y: number; z: number;
  /** Unit direction of travel. */
  dx: number; dy: number; dz: number;
  /** Perpendicular miss distance, metres. */
  miss: number;
  /** Muzzle velocity, m/s. */
  speed: number;
  /** Delay before the bullet reaches its closest approach. */
  delay?: number;
}

/**
 * Bullet crack-and-whizz as it passes the listener, with real Doppler.
 *
 * Two components: the ballistic crack (a broadband snap, only for supersonic
 * rounds) and the whizz — a narrow band whose centre frequency is swept by the
 * Doppler factor as the round goes from approaching to receding. The sweep is
 * scheduled with the actual geometry, so a round that misses by half a metre
 * whips past and one that misses by ten metres sighs.
 */
export function playWhizzBy(sfx: SfxContext, o: WhizzOptions): void {
  const { ctx, pool } = sfx;
  const miss = Math.max(0.25, o.miss);
  if (miss > 14) return;
  const rand = new Rand(`whizz:${Math.round(o.x * 13)}:${Math.round(o.z * 7)}:${Math.round(miss * 31)}`);
  const t0 = sfx.now() + (o.delay ?? 0);
  const near = clamp01(1 - miss / 14);

  const voice = pool.acquire({
    bus: 'impact',
    x: o.x, y: o.y, z: o.z,
    gain: 0.55 * (0.25 + 0.75 * near * near),
    send: 0.2,
    priority: 0.55,
    refDistance: 2,
    rolloff: 1.6,
    maxDistance: 40,
  });
  if (!voice) return;
  const dest = voice.input;

  // Time for the shockwave cone to sweep past: miss distance / lateral speed.
  const passTime = clamp(miss / Math.max(60, o.speed * 0.35), 0.012, 0.24);

  /* ballistic crack — only supersonic rounds have one */
  if (o.speed > 345) {
    const src = noiseVoice(ctx, 'white', rand);
    const bp = filterNode(ctx, 'bandpass', 2600, 1.1);
    const drive = shaperNode(ctx, asymCurve(3.4), sfx.cheap ? 'none' : '2x');
    const g = gainNode(ctx, 0);
    src.connect(bp); bp.connect(drive); drive.connect(g); g.connect(dest);
    sweep(bp.frequency, t0, 5200 * (0.6 + near * 0.6), 900, 0.02);
    const end = arLin(g.gain, t0, 0.9 * near, 0.0006, 0.022 + miss * 0.004);
    startNoise(src, t0, rand, 0.09);
    src.stop(end + 0.03);
  }

  /* whizz with Doppler */
  {
    const src = noiseVoice(ctx, 'pink', rand);
    const bp = filterNode(ctx, 'bandpass', 1800, 5.5);
    const g = gainNode(ctx, 0);
    src.connect(bp); bp.connect(g); g.connect(dest);

    const base = lerp(1500, 3200, rand.next()) * lerp(0.8, 1.25, near);
    // Approaching: +v/c compression. Receding: −v/c. The audible swoop.
    const closing = clamp(o.speed / SPEED_OF_SOUND, 0.2, 2.4);
    const fHigh = base * (1 + closing * 0.42);
    const fLow = base / (1 + closing * 0.42);
    bp.frequency.setValueAtTime(fHigh, t0);
    bp.frequency.exponentialRampToValueAtTime(base, t0 + passTime * 0.5);
    bp.frequency.exponentialRampToValueAtTime(fLow, t0 + passTime * 1.7);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.55 * near + 0.03, t0 + passTime * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + passTime * 2.4);
    startNoise(src, t0, rand, passTime * 3);
    src.stop(t0 + passTime * 2.6);
    voice.releaseAt(t0 + passTime * 2.8);
  }
}

/* --------------------------------------------------------------- extras -- */

/** Trigger click on an empty chamber. */
export function playDryFire(sfx: SfxContext, weaponId: string, firstPerson: boolean, x = 0, y = 0, z = 0): void {
  const p = profileFor(weaponId);
  const rand = new Rand(`dry:${weaponId}:${Math.round(sfx.now() * 60)}`);
  const voice = sfx.pool.acquire({
    bus: 'foley',
    x, y, z, spatial: !firstPerson,
    gain: 0.85, send: 0.3, priority: 0.7, refDistance: 2, maxDistance: 30,
  });
  if (!voice) return;
  const t0 = sfx.now();
  const buf = sfx.bank.mech(p.family === 'sniper' || p.family === 'lmg' ? 'heavy' : 'latch', rand.int(0, 3));
  const src = sfx.ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 1.08 + rand.next() * 0.12;
  const g = gainNode(sfx.ctx, 0.9);
  const hp = filterNode(sfx.ctx, 'highpass', 420, 0.7);
  src.connect(hp); hp.connect(g); g.connect(voice.input);
  src.start(t0);
  // Hammer fall, then the light spring return a moment later.
  const b2 = sfx.bank.mech('spring', rand.int(0, 3));
  const s2 = sfx.ctx.createBufferSource();
  s2.buffer = b2;
  s2.playbackRate.value = 1.3;
  const g2 = gainNode(sfx.ctx, 0.28);
  s2.connect(g2); g2.connect(voice.input);
  s2.start(t0 + 0.032);
  voice.releaseAt(t0 + Math.max(buf.duration, 0.032 + b2.duration) + 0.05);
}

/** Convenience for tools: which families exist. */
export const WEAPON_FAMILIES = Object.keys(WEAPON_PROFILES);

/** Gain trim applied to AI weapons so the player's gun stays dominant. */
export function aiWeaponTrim(): number {
  return settings.preset === 'low' ? 0.8 : 0.9;
}
