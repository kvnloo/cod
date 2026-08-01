/**
 * Impacts, ricochets, casings, explosions and grenades.
 *
 * Bullet impacts and casings are baked modal buffers (see `Bank.ts`) played
 * with per-hit variation; explosions are live graphs because their *structure*
 * changes with distance, not just their level.
 */

import { Rand } from '../core/Rand';
import { SURFACES, type SurfaceType } from '../core/Surfaces';
import type { SfxContext } from './Context';
import { impactMaterialFor } from './Bank';
import {
  SPEED_OF_SOUND, arLin, asymCurve, clamp, clamp01, filterNode, foldCurve,
  gainNode, granular, lerp, noiseVoice, shaperNode, softClipCurve, startNoise, sweep,
} from './Dsp';

let variantCursor = 0;

/**
 * Propagation delay for impact SFX. Inside the near-field bubble (own gun +
 * point-blank hits) delay is forced to 0 so audio lands on the same frame as
 * the visual (cat C). Beyond that, real speed-of-sound travel is kept.
 */
function impactTravelDelay(dist: number): number {
  if (dist <= 5) return 0;
  return dist / SPEED_OF_SOUND;
}

/* -------------------------------------------------------------- impacts -- */

export interface ImpactOptions {
  x: number; y: number; z: number;
  surface: string;
  /** Projectile energy in joules; a rifle round is ~1700 J. */
  energy: number;
  /** Set for hits that penetrated — adds the exit "through" component. */
  penetrated?: boolean;
  occlusion?: number;
}

export function playImpact(sfx: SfxContext, o: ImpactOptions): void {
  const { ctx, pool, bank } = sfx;
  const material = impactMaterialFor(o.surface);
  const props = SURFACES[o.surface as SurfaceType];
  const dist = pool.distanceTo(o.x, o.y, o.z);
  if (dist > 95) return;

  const rand = new Rand(`impact:${variantCursor++}:${Math.round(o.x * 11)}`);
  const t0 = sfx.now() + impactTravelDelay(dist);
  const power = clamp01(o.energy / 1800);

  const voice = pool.acquire({
    bus: 'impact',
    x: o.x, y: o.y, z: o.z,
    gain: lerp(0.42, 1.05, power),
    send: 0.26,
    priority: 0.45,
    refDistance: 2.2,
    rolloff: 1.25,
    maxDistance: 95,
    occlusion: o.occlusion,
  });
  if (!voice) return;

  const buf = bank.impact(material, rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Harder hits read as bigger, so pitch them down slightly.
  src.playbackRate.value = lerp(1.22, 0.86, power) * (0.94 + rand.next() * 0.12);
  const g = gainNode(ctx, 1);
  src.connect(g);

  // Hard, reflective materials keep their highs; soft ones do not.
  const reflect = props?.reflectivity ?? 0.6;
  const tone = filterNode(ctx, 'highshelf', 2600, 0.7, lerp(-7, 3.5, reflect));
  g.connect(tone); tone.connect(voice.input);
  src.start(t0);

  let end = t0 + buf.duration / src.playbackRate.value;

  // Sub thump for heavy rounds hitting solid mass — the part you feel.
  if (power > 0.35 && (props?.density ?? 1000) > 600) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const og = gainNode(ctx, 0);
    osc.connect(og); og.connect(voice.input);
    sweep(osc.frequency, t0, lerp(120, 190, rand.next()), 42, 0.05);
    const e = arLin(og.gain, t0, 0.3 * power, 0.0015, 0.07);
    osc.start(t0); osc.stop(e + 0.02);
    end = Math.max(end, e);
  }

  // A round punching through adds a second, duller hit on the far face.
  if (o.penetrated) {
    const s2 = ctx.createBufferSource();
    s2.buffer = buf;
    s2.playbackRate.value = src.playbackRate.value * 0.78;
    const g2 = gainNode(ctx, 0.42);
    const lp = filterNode(ctx, 'lowpass', 1400, 0.8);
    s2.connect(lp); lp.connect(g2); g2.connect(voice.input);
    const at = t0 + 0.012 + rand.next() * 0.01;
    s2.start(at);
    end = Math.max(end, at + buf.duration);
  }

  voice.releaseAt(end + 0.08);
}

/* ------------------------------------------------------------ ricochets -- */

export interface RicochetOptions {
  x: number; y: number; z: number;
  energy: number;
  /** Direction the deflected round left in; used for the whine's Doppler. */
  dx?: number; dy?: number; dz?: number;
}

/**
 * The spang plus the whine. The whine is a narrow resonant band whose centre
 * frequency falls and wobbles as the tumbling round spins away — the wobble
 * rate itself slows down, which is what makes it read as *tumbling* rather than
 * as a synthesiser sweep.
 */
export function playRicochet(sfx: SfxContext, o: RicochetOptions): void {
  const { ctx, pool, bank } = sfx;
  const dist = pool.distanceTo(o.x, o.y, o.z);
  if (dist > 80) return;
  const rand = new Rand(`ric:${variantCursor++}`);
  const t0 = sfx.now() + impactTravelDelay(dist);
  const power = clamp01(o.energy / 1600);

  const voice = pool.acquire({
    bus: 'impact',
    x: o.x, y: o.y, z: o.z,
    gain: lerp(0.5, 0.95, power),
    send: 0.34,
    priority: 0.5,
    refDistance: 3,
    rolloff: 1.1,
    maxDistance: 80,
  });
  if (!voice) return;

  const spang = bank.ricochetSpang(rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = spang;
  src.playbackRate.value = 0.88 + rand.next() * 0.35;
  const g = gainNode(ctx, 1);
  src.connect(g); g.connect(voice.input);
  src.start(t0);

  // The whine.
  const dur = lerp(0.28, 0.72, rand.next()) * lerp(0.7, 1.25, power);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const bp = filterNode(ctx, 'bandpass', 2400, 9);
  const og = gainNode(ctx, 0);
  osc.connect(bp); bp.connect(og); og.connect(voice.input);

  const f0 = lerp(1500, 3400, rand.next());
  const f1 = f0 * lerp(0.28, 0.5, rand.next());
  sweep(osc.frequency, t0 + 0.006, f0, f1, dur);
  sweep(bp.frequency, t0 + 0.006, f0 * 1.05, f1 * 1.15, dur);

  // Tumble wobble: an LFO on the pitch that itself slows down.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const lfoGain = gainNode(ctx, f0 * 0.09);
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
  sweep(lfo.frequency, t0, lerp(38, 72, rand.next()), lerp(8, 16, rand.next()), dur);
  lfoGain.gain.setValueAtTime(f0 * 0.09, t0);
  lfoGain.gain.exponentialRampToValueAtTime(f0 * 0.008, t0 + dur);
  lfo.start(t0); lfo.stop(t0 + dur + 0.05);

  const end = arLin(og.gain, t0 + 0.004, 0.3 * lerp(0.6, 1.2, power), 0.008, dur);
  osc.start(t0); osc.stop(end + 0.03);

  voice.releaseAt(Math.max(end, t0 + spang.duration) + 0.1);
}

/* -------------------------------------------------------------- casings -- */

export interface CasingOptions {
  x: number; y: number; z: number;
  surface: string;
  /** 0 = 9 mm, 1 = .50 — drives pitch and how long it rattles. */
  size?: number;
  /** Extra delay before the first bounce (flight time from the ejection port). */
  delay?: number;
}

/**
 * A shell hitting the ground: three to five bounces with a geometrically
 * shrinking interval and a final skitter. On soft ground it is one dull tap.
 */
export function playCasing(sfx: SfxContext, o: CasingOptions): void {
  const { ctx, pool, bank } = sfx;
  const dist = pool.distanceTo(o.x, o.y, o.z);
  if (dist > 26) return;
  const props = SURFACES[o.surface as SurfaceType];
  const hard = clamp01((props?.reflectivity ?? 0.6) * 1.15);
  const rand = new Rand(`casing:${variantCursor++}`);
  const size = clamp01(o.size ?? 0.25);

  const voice = pool.acquire({
    bus: 'foley',
    x: o.x, y: o.y, z: o.z,
    gain: lerp(0.5, 0.95, hard) * lerp(0.8, 1.1, size),
    send: 0.24,
    priority: 0.18,
    refDistance: 1.6,
    rolloff: 1.5,
    maxDistance: 26,
  });
  if (!voice) return;

  const t0 = sfx.now() + (o.delay ?? 0);
  const bounces = hard > 0.4 ? 3 + rand.int(0, 2) : 1;
  let at = t0;
  let gap = 0.055 + rand.next() * 0.05;
  let amp = 1;
  let end = t0;

  for (let i = 0; i < bounces; i++) {
    const metal = bank.casing(rand.int(0, 5));
    const src = ctx.createBufferSource();
    src.buffer = metal;
    src.playbackRate.value = lerp(1.35, 0.85, size) * (0.92 + rand.next() * 0.2) * (1 + i * 0.05);
    const g = gainNode(ctx, amp * lerp(0.35, 1, hard));
    // Soft ground swallows the ring entirely.
    const lp = filterNode(ctx, 'lowpass', lerp(1100, 18000, hard), 0.7);
    src.connect(lp); lp.connect(g); g.connect(voice.input);
    src.start(at);
    end = at + metal.duration;
    at += gap;
    gap *= 0.62;
    amp *= 0.52;
  }

  // Final skitter — the shell rolling to a stop.
  if (hard > 0.55 && rand.bool(0.6)) {
    const bed = bank.debrisBed();
    const gg = gainNode(ctx, 0.12);
    gg.connect(voice.input);
    end = Math.max(end, granular(ctx, bed, gg, at, {
      count: 5, spread: 0.22, length: 0.03, rateMin: 1.6, rateMax: 2.6,
      gain: 0.5, pan: 0.3,
    }, rand));
  }

  voice.releaseAt(end + 0.1);
}

/* ------------------------------------------------------------ explosions -- */

export interface ExplosionOptions {
  x: number; y: number; z: number;
  /** Blast radius in metres; drives size, not volume. */
  radius: number;
  /** 0..1-ish scalar of destructive power. */
  power: number;
  kind?: string;
}

/**
 * Explosion with distance-dependent character.
 *
 * Close: an ignition crack, a saturated broadband core sweeping down two
 * decades, a sub thump you feel, a debris shower and a long rumble.
 * Far: no crack at all, a slow-attack dull thud arriving a second later, and a
 * rumble that outlives the blast by seconds — most of what you hear at 300 m is
 * the terrain answering, not the charge.
 */
export function playExplosion(sfx: SfxContext, o: ExplosionOptions): void {
  const { ctx, pool, bank } = sfx;
  const dist = pool.distanceTo(o.x, o.y, o.z);
  const size = clamp(o.radius / 6, 0.4, 3.2);
  const power = clamp(o.power, 0.2, 4);
  if (dist > 620) return;

  const rand = new Rand(`boom:${variantCursor++}:${Math.round(o.radius * 10)}`);
  const t0 = sfx.now() + dist / SPEED_OF_SOUND;
  const near = clamp01(1 - dist / 55);
  const far = 1 - near;

  const voice = pool.acquire({
    bus: 'explosion',
    x: o.x, y: o.y, z: o.z,
    gain: clamp(0.9 * power * size, 0.2, 3.0),
    send: 0.6,
    priority: 1.0,
    refDistance: 12,
    rolloff: 0.62,
    maxDistance: 620,
    airDistance: dist,
  });
  if (!voice) return;
  const dest = voice.input;
  let end = t0 + 0.5;

  /* --- ignition crack (near only) --------------------------------------- */
  if (near > 0.08 && !sfx.cheap) {
    const src = noiseVoice(ctx, 'white', rand);
    const bp = filterNode(ctx, 'bandpass', 3400, 1.0);
    const drive = shaperNode(ctx, foldCurve(1.8), '2x');
    const g = gainNode(ctx, 0);
    src.connect(bp); bp.connect(drive); drive.connect(g); g.connect(dest);
    sweep(bp.frequency, t0, 6200, 900, 0.03);
    const e = arLin(g.gain, t0, 0.85 * near, 0.0008, 0.045);
    startNoise(src, t0, rand, 0.12);
    src.stop(e + 0.03);
    end = Math.max(end, e);
  }

  /* --- blast core -------------------------------------------------------- */
  {
    const src = noiseVoice(ctx, 'brown', rand);
    const lp = filterNode(ctx, 'lowpass', 2400, 1.2);
    const drive = shaperNode(ctx, softClipCurve(lerp(1.6, 3.4, near)), sfx.cheap ? 'none' : '2x');
    const g = gainNode(ctx, 0);
    src.connect(lp); lp.connect(drive); drive.connect(g); g.connect(dest);
    // Two decades of downward sweep in a fifth of a second is the blast.
    sweep(lp.frequency, t0, lerp(900, 2800, near) / size, lerp(70, 130, far) / size, 0.22 * size);
    const attack = lerp(0.0025, 0.05, far);
    const decay = lerp(0.35, 0.9, far) * size;
    const e = arLin(g.gain, t0, lerp(0.75, 1.05, near), attack, decay);
    startNoise(src, t0, rand, decay + 0.2);
    src.stop(e + 0.05);
    end = Math.max(end, e);
  }

  /* --- sub thump --------------------------------------------------------- */
  {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const og = gainNode(ctx, 0);
    const sat = shaperNode(ctx, softClipCurve(1.5), 'none');
    osc.connect(sat); sat.connect(og); og.connect(dest);
    sweep(osc.frequency, t0, lerp(88, 130, near) / size, 22 / Math.min(size, 1.6), 0.38 * size);
    const e = arLin(og.gain, t0, lerp(0.55, 0.95, near) * power, lerp(0.004, 0.05, far), lerp(0.75, 1.5, far) * size);
    osc.start(t0); osc.stop(e + 0.05);
    end = Math.max(end, e);
  }

  /* --- debris shower ----------------------------------------------------- */
  if (near > 0.05 && !sfx.cheap) {
    const bed = bank.debrisBed();
    const dg = gainNode(ctx, 0.55 * near * size);
    const hp = filterNode(ctx, 'highpass', 260, 0.7);
    dg.connect(hp); hp.connect(dest);
    const e = granular(ctx, bed, dg, t0 + 0.06, {
      count: Math.round(lerp(8, 34, near * size / 2)),
      spread: 1.1 * size, length: 0.075, lengthJitter: 0.6,
      rateMin: 0.55, rateMax: 1.9, gain: 0.9, pan: 0.55,
      shape: (t) => Math.pow(1 - t, 1.4),
    }, rand);
    end = Math.max(end, e);
  }

  /* --- rumble tail ------------------------------------------------------- */
  {
    const src = noiseVoice(ctx, 'brown', rand);
    const lp = filterNode(ctx, 'lowpass', lerp(700, 180, far), 0.8);
    const hp = filterNode(ctx, 'highpass', 34, 0.6);
    const g = gainNode(ctx, 0);
    src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(dest);
    const decay = lerp(1.0, 3.2, far) * size;
    const e = arLin(g.gain, t0 + 0.02, lerp(0.24, 0.6, far) * power, lerp(0.05, 0.35, far), decay);
    startNoise(src, t0, rand, decay + 0.4);
    src.stop(e + 0.1);
    end = Math.max(end, e);
  }

  /* --- mix reaction ------------------------------------------------------ */
  const depth = lerp(22, 2, clamp01(dist / 90));
  sfx.mixer.duck({
    depthDb: depth, attack: 0.008, hold: lerp(0.32, 0.05, clamp01(dist / 90)),
    release: lerp(1.6, 0.35, clamp01(dist / 90)), source: 'explosion',
  });

  voice.releaseAt(end + 0.2);
}

/* -------------------------------------------------------------- grenades -- */

export function playGrenadePin(sfx: SfxContext, x: number, y: number, z: number, firstPerson: boolean): void {
  const { ctx, bank, pool } = sfx;
  const rand = new Rand(`pin:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !firstPerson,
    gain: 0.85, send: 0.3, priority: 0.6, refDistance: 2, maxDistance: 24,
  });
  if (!voice) return;
  const t0 = sfx.now();
  // Spoon flying off, then the lever springing.
  const a = bank.mech('latch', rand.int(0, 3));
  const s1 = ctx.createBufferSource();
  s1.buffer = a; s1.playbackRate.value = 1.35 + rand.next() * 0.2;
  const g1 = gainNode(ctx, 0.75);
  s1.connect(g1); g1.connect(voice.input);
  s1.start(t0);

  const b = bank.mech('spring', rand.int(0, 3));
  const s2 = ctx.createBufferSource();
  s2.buffer = b; s2.playbackRate.value = 1.5;
  const g2 = gainNode(ctx, 0.5);
  s2.connect(g2); g2.connect(voice.input);
  s2.start(t0 + 0.055);
  voice.releaseAt(t0 + 0.055 + b.duration + 0.05);
}

export function playGrenadeBounce(
  sfx: SfxContext, x: number, y: number, z: number, surface: string, impulse: number,
): void {
  const { ctx, bank, pool } = sfx;
  const dist = pool.distanceTo(x, y, z);
  if (dist > 40) return;
  const rand = new Rand(`bounce:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'foley', x, y, z,
    gain: clamp(0.35 + impulse * 0.5, 0.2, 1), send: 0.45,
    priority: 0.4, refDistance: 2.5, maxDistance: 40,
  });
  if (!voice) return;
  const t0 = sfx.now() + dist / SPEED_OF_SOUND;

  // Metal shell hitting a surface: the shell's own ring plus the surface's.
  const shell = bank.mech('heavy', rand.int(0, 3));
  const s1 = ctx.createBufferSource();
  s1.buffer = shell;
  s1.playbackRate.value = 1.5 + rand.next() * 0.3;
  const g1 = gainNode(ctx, 0.5);
  const hp = filterNode(ctx, 'highpass', 300, 0.7);
  s1.connect(hp); hp.connect(g1); g1.connect(voice.input);
  s1.start(t0);

  const surf = bank.impact(impactMaterialFor(surface), rand.int(0, 3));
  const s2 = ctx.createBufferSource();
  s2.buffer = surf;
  s2.playbackRate.value = 0.72 + rand.next() * 0.16;
  const g2 = gainNode(ctx, 0.45);
  s2.connect(g2); g2.connect(voice.input);
  s2.start(t0);

  voice.releaseAt(t0 + Math.max(shell.duration, surf.duration) + 0.08);
}

/* -------------------------------------------------------- glass shatter -- */

export function playGlassShatter(sfx: SfxContext, x: number, y: number, z: number, size: number): void {
  const { ctx, bank, pool } = sfx;
  const dist = pool.distanceTo(x, y, z);
  if (dist > 70) return;
  const rand = new Rand(`glass:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'impact', x, y, z,
    gain: clamp(0.6 + size * 0.4, 0.3, 1.2), send: 0.6,
    priority: 0.6, refDistance: 3, maxDistance: 70,
  });
  if (!voice) return;
  const t0 = sfx.now() + dist / SPEED_OF_SOUND;

  const crack = bank.impact('glass', rand.int(0, 3));
  const s = ctx.createBufferSource();
  s.buffer = crack;
  s.playbackRate.value = lerp(1.2, 0.8, clamp01(size));
  const g = gainNode(ctx, 1);
  s.connect(g); g.connect(voice.input);
  s.start(t0);

  // The shower: shards raining for up to a second and a half.
  let end = t0 + crack.duration;
  const shards = Math.round(lerp(6, 20, clamp01(size)));
  for (let i = 0; i < shards; i++) {
    const buf = bank.glassShard(rand.int(0, 3));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.75 + rand.next() * 0.9;
    const sg = gainNode(ctx, (0.1 + rand.next() * 0.28) * (1 - i / (shards * 1.4)));
    src.connect(sg); sg.connect(voice.input);
    const at = t0 + 0.05 + rand.next() * rand.next() * 1.25;
    src.start(at);
    end = Math.max(end, at + buf.duration);
  }
  voice.releaseAt(end + 0.1);
}

/* ---------------------------------------------------- physics collisions -- */

export function playPhysicsImpact(
  sfx: SfxContext, x: number, y: number, z: number, impulse: number, material: string,
): void {
  const { ctx, bank, pool } = sfx;
  const dist = pool.distanceTo(x, y, z);
  if (dist > 55) return;
  const strength = clamp01((impulse - 200) / 2600);
  const rand = new Rand(`phys:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'impact', x, y, z,
    gain: lerp(0.28, 0.9, strength), send: 0.4,
    priority: 0.28, refDistance: 2.5, rolloff: 1.3, maxDistance: 55,
  });
  if (!voice) return;
  const t0 = sfx.now() + dist / SPEED_OF_SOUND;
  const buf = bank.impact(impactMaterialFor(material), rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = lerp(1.15, 0.68, strength) * (0.94 + rand.next() * 0.12);
  const g = gainNode(ctx, 1);
  const lp = filterNode(ctx, 'lowpass', lerp(3400, 16000, strength), 0.7);
  src.connect(lp); lp.connect(g); g.connect(voice.input);
  src.start(t0);
  voice.releaseAt(t0 + buf.duration / src.playbackRate.value + 0.08);
}

/* ------------------------------------------------------------ bullet fly -- */

/** Water entry: splash plus a rising bubble. */
export function playWaterEntry(sfx: SfxContext, x: number, y: number, z: number, energy: number): void {
  const { ctx, bank, pool } = sfx;
  const dist = pool.distanceTo(x, y, z);
  if (dist > 50) return;
  const rand = new Rand(`water:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'impact', x, y, z,
    gain: clamp(0.35 + energy / 2400, 0.25, 1), send: 0.45,
    priority: 0.35, refDistance: 2.5, maxDistance: 50,
  });
  if (!voice) return;
  const t0 = sfx.now() + dist / SPEED_OF_SOUND;

  const buf = bank.impact('water', rand.int(0, 3));
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = 0.9 + rand.next() * 0.35;
  const g = gainNode(ctx, 1);
  s.connect(g); g.connect(voice.input);
  s.start(t0);

  // The bubble: a sine that rises in pitch as it shrinks and surfaces.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const og = gainNode(ctx, 0);
  osc.connect(og); og.connect(voice.input);
  const f0 = lerp(320, 900, rand.next());
  sweep(osc.frequency, t0 + 0.01, f0, f0 * lerp(1.6, 3.2, rand.next()), 0.09);
  const e = arLin(og.gain, t0 + 0.01, 0.22, 0.004, 0.085);
  osc.start(t0); osc.stop(e + 0.02);

  voice.releaseAt(Math.max(e, t0 + buf.duration) + 0.08);
}

/** Small cloth/flesh "thwack" for a body hit, layered over the flesh impact. */
export function playFleshHit(sfx: SfxContext, x: number, y: number, z: number, headshot: boolean): void {
  const { ctx, bank, pool } = sfx;
  const dist = pool.distanceTo(x, y, z);
  if (dist > 60) return;
  const rand = new Rand(`flesh:${variantCursor++}`);
  const voice = pool.acquire({
    bus: 'impact', x, y, z,
    gain: headshot ? 1.05 : 0.8, send: 0.35,
    priority: 0.7, refDistance: 2.5, maxDistance: 60,
  });
  if (!voice) return;
  const t0 = sfx.now() + impactTravelDelay(dist);

  const buf = bank.impact('flesh', rand.int(0, 3));
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = headshot ? 1.25 : 0.92 + rand.next() * 0.16;
  const g = gainNode(ctx, 1);
  const drive = shaperNode(ctx, asymCurve(headshot ? 2.6 : 1.6), sfx.cheap ? 'none' : '2x');
  s.connect(drive); drive.connect(g); g.connect(voice.input);
  s.start(t0);

  // Headshots add a bright crack over the wet thud.
  if (headshot) {
    const src = noiseVoice(ctx, 'white', rand);
    const bp = filterNode(ctx, 'bandpass', 2800, 1.6);
    const cg = gainNode(ctx, 0);
    src.connect(bp); bp.connect(cg); cg.connect(voice.input);
    sweep(bp.frequency, t0, 4200, 1400, 0.02);
    const e = arLin(cg.gain, t0, 0.45, 0.0008, 0.035);
    startNoise(src, t0, rand, 0.08);
    src.stop(e + 0.02);
  }
  voice.releaseAt(t0 + buf.duration + 0.1);
}
