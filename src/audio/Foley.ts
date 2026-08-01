/**
 * Movement and weapon-handling foley.
 *
 * Footsteps are the sound a player hears more than any other, so they get the
 * full treatment: per-surface modal buffers, a heel/toe pair baked in, gait
 * driving level *and* spectrum (a sprint is not a loud walk — it is a harder,
 * brighter, later-peaking strike), plus a gear layer whose weight depends on
 * how fast you are moving. Left/right alternation shifts pitch and pan slightly
 * so a run never sounds like a metronome.
 */

import { Rand } from '../core/Rand';
import { SURFACES, type SurfaceType } from '../core/Surfaces';
import type { SfxContext } from './Context';
import type { Gait } from './types';
import { footstepBankFor } from './Bank';
import { profileFor, type WeaponFamily } from './WeaponSounds';
import { weaponDef } from '../weapons/Catalog';
import {
  SPEED_OF_SOUND, arLin, clamp, clamp01, filterNode, gainNode, lerp,
  noiseVoice, startNoise, sweep,
} from './Dsp';

let cursor = 0;

/* ------------------------------------------------------------- footsteps -- */

export interface FootstepOptions {
  x: number; y: number; z: number;
  surface: string;
  gait: Gait;
  /** The local player's own feet: head-locked, quieter, more gear. */
  firstPerson?: boolean;
  /** Alternates 0/1 so left and right differ. */
  foot?: number;
  occlusion?: number;
}

const GAIT_GAIN: Record<Gait, number> = {
  prone: 0.28, crouch: 0.42, walk: 0.72, run: 1.0, sprint: 1.28,
};
const GAIT_TONE: Record<Gait, number> = {
  prone: 0.55, crouch: 0.7, walk: 0.9, run: 1.0, sprint: 1.18,
};
const GAIT_RATE: Record<Gait, number> = {
  prone: 0.86, crouch: 0.95, walk: 1.0, run: 1.02, sprint: 1.06,
};

export function playFootstep(sfx: SfxContext, o: FootstepOptions): void {
  const { ctx, pool, bank } = sfx;
  const fp = !!o.firstPerson;
  const dist = fp ? 0 : pool.distanceTo(o.x, o.y, o.z);
  if (dist > 34) return;

  const rand = new Rand(`step:${cursor++}`);
  const bankId = footstepBankFor(o.surface);
  const props = SURFACES[o.surface as SurfaceType];
  const t0 = sfx.now() + (fp ? 0 : dist / SPEED_OF_SOUND);
  const foot = (o.foot ?? cursor) & 1;

  const voice = pool.acquire({
    bus: 'foley',
    x: o.x, y: o.y, z: o.z,
    spatial: !fp,
    gain: GAIT_GAIN[o.gait] * (fp ? 0.62 : 1),
    send: 0.26,
    priority: fp ? 0.5 : 0.3,
    refDistance: 1.8,
    rolloff: 1.45,
    maxDistance: 34,
    occlusion: o.occlusion,
    pan: fp ? (foot ? 0.16 : -0.16) : 0,
  });
  if (!voice) return;

  const buf = bank.footstep(bankId, rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = GAIT_RATE[o.gait] * (foot ? 1.035 : 0.965) * (0.96 + rand.next() * 0.09);
  const g = gainNode(ctx, 1);
  const tone = filterNode(ctx, 'highshelf', 2200, 0.7,
    lerp(-9, 4.5, clamp01((props?.reflectivity ?? 0.5) * GAIT_TONE[o.gait])));
  src.connect(tone); tone.connect(g); g.connect(voice.input);
  src.start(t0);
  let end = t0 + buf.duration / src.playbackRate.value;

  // Gear moves with the body, not the foot — it lands a beat late. It has to
  // stay short and well under the strike: at a sprint cadence a long rustle
  // overlaps the next step and the whole run turns to mush.
  const gearAmt = (fp ? 0.5 : 0.35) * GAIT_GAIN[o.gait];
  if (gearAmt > 0.2) {
    const cloth = bank.cloth(0.32, rand.int(0, 3));
    const cs = ctx.createBufferSource();
    cs.buffer = cloth;
    cs.playbackRate.value = 1.55 + rand.next() * 0.6;
    const cg = gainNode(ctx, gearAmt * 0.13);
    cs.connect(cg); cg.connect(voice.input);
    const at = t0 + 0.02 + rand.next() * 0.03;
    cs.start(at);
    end = Math.max(end, at + cloth.duration);
  }

  voice.releaseAt(end + 0.06);
}

/* --------------------------------------------------------------- landing -- */

export function playLanding(
  sfx: SfxContext, x: number, y: number, z: number, surface: string,
  force: number, firstPerson: boolean,
): void {
  const { ctx, pool, bank } = sfx;
  const fp = firstPerson;
  const dist = fp ? 0 : pool.distanceTo(x, y, z);
  if (dist > 50) return;
  const rand = new Rand(`land:${cursor++}`);
  const heavy = clamp01((force - 3) / 14);
  const t0 = sfx.now() + (fp ? 0 : dist / SPEED_OF_SOUND);

  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !fp,
    gain: lerp(0.6, 1.35, heavy) * (fp ? 0.85 : 1),
    send: 0.3, priority: 0.65, refDistance: 2.2, rolloff: 1.3, maxDistance: 50,
  });
  if (!voice) return;

  const buf = bank.footstep(footstepBankFor(surface), rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = lerp(0.92, 0.66, heavy);
  const g = gainNode(ctx, lerp(1.0, 1.5, heavy));
  src.connect(g); g.connect(voice.input);
  src.start(t0);
  let end = t0 + buf.duration / src.playbackRate.value;

  // Boots + knees + a body's worth of gear arriving at once.
  const cloth = bank.cloth(1, rand.int(0, 3));
  const cs = ctx.createBufferSource();
  cs.buffer = cloth;
  cs.playbackRate.value = 1.15 + rand.next() * 0.25;
  const cg = gainNode(ctx, lerp(0.16, 0.34, heavy));
  cs.connect(cg); cg.connect(voice.input);
  cs.start(t0 + 0.012);
  end = Math.max(end, t0 + 0.012 + cloth.duration);

  // The thump you feel through the floor.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const og = gainNode(ctx, 0);
  osc.connect(og); og.connect(voice.input);
  sweep(osc.frequency, t0, lerp(82, 112, heavy), 34, 0.1);
  const e = arLin(og.gain, t0, lerp(0.4, 1.15, heavy), 0.002, lerp(0.14, 0.32, heavy));
  osc.start(t0); osc.stop(e + 0.02);

  voice.releaseAt(Math.max(end, e) + 0.08);
}

/* ----------------------------------------------------------------- slide -- */

export interface SlideHandle {
  stop(): void;
}

/**
 * A slide is a continuous scrape: broadband noise through a resonant band that
 * opens as speed builds and closes as it bleeds off. Held open until `stop()`.
 */
export function playSlide(
  sfx: SfxContext, x: number, y: number, z: number, surface: string, firstPerson: boolean,
): SlideHandle {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`slide:${cursor++}`);
  const props = SURFACES[surface as SurfaceType];
  const bright = clamp01(props?.reflectivity ?? 0.6);

  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !firstPerson,
    gain: 0.7, send: 0.4, priority: 0.75, track: true,
    refDistance: 2.5, rolloff: 1.2, maxDistance: 40,
  });
  if (!voice) return { stop: () => { /* culled */ } };

  const t0 = sfx.now();
  const src = noiseVoice(ctx, 'pink', rand, { loop: true });
  const bp = filterNode(ctx, 'bandpass', lerp(700, 2600, bright), 1.4);
  const lp = filterNode(ctx, 'lowpass', lerp(2600, 9000, bright), 0.8);
  const g = gainNode(ctx, 0);
  src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(voice.input);

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.55, t0 + 0.06);
  // Friction slowly wins.
  g.gain.setTargetAtTime(0.24, t0 + 0.06, 0.55);
  sweep(bp.frequency, t0, lerp(900, 3400, bright), lerp(420, 1200, bright), 1.1);
  startNoise(src, t0, rand);

  // A little gear rattle riding on top.
  const cloth = bank.cloth(0.8, rand.int(0, 3));
  const cs = ctx.createBufferSource();
  cs.buffer = cloth; cs.loop = true;
  cs.playbackRate.value = 0.7;
  const cg = gainNode(ctx, 0.16);
  cs.connect(cg); cg.connect(voice.input);
  cs.start(t0);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      const t = sfx.now();
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      cg.gain.setTargetAtTime(0, t, 0.05);
      try { src.stop(t + 0.2); cs.stop(t + 0.2); } catch { /* already stopped */ }
      voice.releaseAt(t + 0.25);
    },
  };
}

/* ---------------------------------------------------------------- mantle -- */

export function playMantle(sfx: SfxContext, x: number, y: number, z: number, firstPerson: boolean): void {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`mantle:${cursor++}`);
  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !firstPerson,
    gain: 0.95, send: 0.4, priority: 0.7, refDistance: 2, maxDistance: 30,
  });
  if (!voice) return;
  const t0 = sfx.now();

  // Palm slap on the ledge.
  const slap = bank.impact('fabric', rand.int(0, 3));
  const s1 = ctx.createBufferSource();
  s1.buffer = slap; s1.playbackRate.value = 0.85 + rand.next() * 0.2;
  const g1 = gainNode(ctx, 0.75);
  s1.connect(g1); g1.connect(voice.input);
  s1.start(t0);

  // Then the whole body dragging over it.
  const cloth = bank.cloth(1, rand.int(0, 3));
  const s2 = ctx.createBufferSource();
  s2.buffer = cloth; s2.playbackRate.value = 0.68;
  const g2 = gainNode(ctx, 0.7);
  s2.connect(g2); g2.connect(voice.input);
  s2.start(t0 + 0.05);

  // Boot scuff on the wall.
  const scuff = noiseVoice(ctx, 'pink', rand);
  const bp = filterNode(ctx, 'bandpass', 1600, 1.3);
  const sg = gainNode(ctx, 0);
  scuff.connect(bp); bp.connect(sg); sg.connect(voice.input);
  sweep(bp.frequency, t0 + 0.16, 2400, 900, 0.22);
  const e = arLin(sg.gain, t0 + 0.16, 0.3, 0.03, 0.24);
  startNoise(scuff, t0 + 0.16, rand, 0.35);
  scuff.stop(e + 0.05);

  voice.releaseAt(Math.max(e, t0 + 0.05 + cloth.duration) + 0.1);
}

/* ------------------------------------------------------------ gear/cloth -- */

export function playGearRustle(
  sfx: SfxContext, x: number, y: number, z: number, intensity: number, firstPerson: boolean,
): void {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`gear:${cursor++}`);
  const amt = clamp01(intensity);
  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !firstPerson,
    gain: lerp(0.18, 0.6, amt) * (firstPerson ? 0.9 : 0.7),
    send: 0.3, priority: 0.14, refDistance: 1.6, rolloff: 1.7, maxDistance: 18,
    pan: firstPerson ? rand.signed() * 0.25 : 0,
  });
  if (!voice) return;
  const t0 = sfx.now();
  const cloth = bank.cloth(amt, rand.int(0, 3));
  const src = ctx.createBufferSource();
  src.buffer = cloth;
  src.playbackRate.value = 0.8 + rand.next() * 0.5;
  const g = gainNode(ctx, 1);
  src.connect(g); g.connect(voice.input);
  src.start(t0);
  voice.releaseAt(t0 + cloth.duration / src.playbackRate.value + 0.05);
}

/* -------------------------------------------------------- weapon handling -- */

interface ReloadStage {
  /** Fraction of the total reload. */
  at: number;
  kind: 'light' | 'heavy' | 'spring' | 'latch' | 'bolt';
  gain: number;
  rate: number;
  cloth?: number;
}

/** Per-family reload choreography. `empty` adds the bolt release at the end. */
const RELOAD_STAGES: Record<WeaponFamily, { seconds: number; tactical: ReloadStage[]; empty: ReloadStage[] }> = {
  ar: {
    seconds: 2.1,
    tactical: [
      { at: 0.06, kind: 'latch', gain: 0.55, rate: 1.1, cloth: 0.4 },
      { at: 0.2, kind: 'heavy', gain: 0.5, rate: 1.0 },
      { at: 0.55, kind: 'heavy', gain: 0.72, rate: 0.92, cloth: 0.6 },
      { at: 0.72, kind: 'latch', gain: 0.5, rate: 1.05 },
      { at: 0.9, kind: 'light', gain: 0.35, rate: 1.2 },
    ],
    empty: [
      { at: 0.05, kind: 'latch', gain: 0.55, rate: 1.1, cloth: 0.4 },
      { at: 0.17, kind: 'heavy', gain: 0.55, rate: 0.98 },
      { at: 0.5, kind: 'heavy', gain: 0.75, rate: 0.9, cloth: 0.6 },
      { at: 0.66, kind: 'latch', gain: 0.5, rate: 1.05 },
      { at: 0.84, kind: 'bolt', gain: 0.85, rate: 0.95 },
      { at: 0.93, kind: 'spring', gain: 0.4, rate: 1.1 },
    ],
  },
  smg: {
    seconds: 1.75,
    tactical: [
      { at: 0.07, kind: 'latch', gain: 0.5, rate: 1.25, cloth: 0.35 },
      { at: 0.22, kind: 'light', gain: 0.5, rate: 1.15 },
      { at: 0.56, kind: 'heavy', gain: 0.62, rate: 1.1, cloth: 0.5 },
      { at: 0.78, kind: 'latch', gain: 0.45, rate: 1.2 },
    ],
    empty: [
      { at: 0.06, kind: 'latch', gain: 0.5, rate: 1.25, cloth: 0.35 },
      { at: 0.2, kind: 'light', gain: 0.5, rate: 1.15 },
      { at: 0.52, kind: 'heavy', gain: 0.65, rate: 1.1, cloth: 0.5 },
      { at: 0.72, kind: 'latch', gain: 0.45, rate: 1.2 },
      { at: 0.87, kind: 'bolt', gain: 0.75, rate: 1.15 },
    ],
  },
  lmg: {
    seconds: 3.4,
    tactical: [
      { at: 0.05, kind: 'latch', gain: 0.6, rate: 0.85, cloth: 0.5 },
      { at: 0.2, kind: 'heavy', gain: 0.7, rate: 0.8 },
      { at: 0.45, kind: 'spring', gain: 0.5, rate: 0.7, cloth: 0.8 },
      { at: 0.68, kind: 'heavy', gain: 0.8, rate: 0.78 },
      { at: 0.86, kind: 'bolt', gain: 0.85, rate: 0.8 },
    ],
    empty: [
      { at: 0.05, kind: 'latch', gain: 0.6, rate: 0.85, cloth: 0.5 },
      { at: 0.19, kind: 'heavy', gain: 0.72, rate: 0.8 },
      { at: 0.42, kind: 'spring', gain: 0.52, rate: 0.7, cloth: 0.8 },
      { at: 0.64, kind: 'heavy', gain: 0.82, rate: 0.78 },
      { at: 0.83, kind: 'bolt', gain: 0.9, rate: 0.78 },
      { at: 0.94, kind: 'latch', gain: 0.45, rate: 0.9 },
    ],
  },
  sniper: {
    seconds: 2.9,
    tactical: [
      { at: 0.07, kind: 'latch', gain: 0.5, rate: 0.9, cloth: 0.5 },
      { at: 0.24, kind: 'heavy', gain: 0.6, rate: 0.82 },
      { at: 0.58, kind: 'heavy', gain: 0.75, rate: 0.8, cloth: 0.7 },
      { at: 0.8, kind: 'bolt', gain: 0.8, rate: 0.82 },
    ],
    empty: [
      { at: 0.06, kind: 'latch', gain: 0.5, rate: 0.9, cloth: 0.5 },
      { at: 0.22, kind: 'heavy', gain: 0.6, rate: 0.82 },
      { at: 0.54, kind: 'heavy', gain: 0.78, rate: 0.8, cloth: 0.7 },
      { at: 0.75, kind: 'bolt', gain: 0.85, rate: 0.8 },
      { at: 0.9, kind: 'spring', gain: 0.4, rate: 0.9 },
    ],
  },
  shotgun: {
    // Shell-by-shell: the stage list is looped by the caller's shell count.
    seconds: 3.0,
    tactical: [
      { at: 0.08, kind: 'latch', gain: 0.5, rate: 0.95, cloth: 0.5 },
      { at: 0.3, kind: 'heavy', gain: 0.5, rate: 1.0 },
      { at: 0.5, kind: 'heavy', gain: 0.5, rate: 0.98 },
      { at: 0.7, kind: 'heavy', gain: 0.5, rate: 1.02 },
      { at: 0.9, kind: 'bolt', gain: 0.7, rate: 0.9 },
    ],
    empty: [
      { at: 0.06, kind: 'latch', gain: 0.5, rate: 0.95, cloth: 0.5 },
      { at: 0.26, kind: 'heavy', gain: 0.5, rate: 1.0 },
      { at: 0.44, kind: 'heavy', gain: 0.5, rate: 0.98 },
      { at: 0.62, kind: 'heavy', gain: 0.5, rate: 1.02 },
      { at: 0.8, kind: 'heavy', gain: 0.5, rate: 0.96 },
      { at: 0.94, kind: 'bolt', gain: 0.75, rate: 0.9 },
    ],
  },
  pistol: {
    seconds: 1.5,
    tactical: [
      { at: 0.08, kind: 'latch', gain: 0.5, rate: 1.3, cloth: 0.3 },
      { at: 0.26, kind: 'light', gain: 0.5, rate: 1.25 },
      { at: 0.6, kind: 'heavy', gain: 0.6, rate: 1.2, cloth: 0.4 },
      { at: 0.84, kind: 'latch', gain: 0.45, rate: 1.3 },
    ],
    empty: [
      { at: 0.07, kind: 'latch', gain: 0.5, rate: 1.3, cloth: 0.3 },
      { at: 0.24, kind: 'light', gain: 0.5, rate: 1.25 },
      { at: 0.56, kind: 'heavy', gain: 0.62, rate: 1.2, cloth: 0.4 },
      { at: 0.78, kind: 'latch', gain: 0.45, rate: 1.3 },
      { at: 0.9, kind: 'spring', gain: 0.5, rate: 1.4 },
    ],
  },
  launcher: {
    seconds: 3.2,
    tactical: [
      { at: 0.1, kind: 'latch', gain: 0.5, rate: 0.8, cloth: 0.6 },
      { at: 0.42, kind: 'heavy', gain: 0.7, rate: 0.7, cloth: 0.9 },
      { at: 0.8, kind: 'latch', gain: 0.6, rate: 0.75 },
    ],
    empty: [
      { at: 0.1, kind: 'latch', gain: 0.5, rate: 0.8, cloth: 0.6 },
      { at: 0.4, kind: 'heavy', gain: 0.7, rate: 0.7, cloth: 0.9 },
      { at: 0.76, kind: 'latch', gain: 0.6, rate: 0.75 },
      { at: 0.9, kind: 'spring', gain: 0.4, rate: 0.85 },
    ],
  },
};

export interface ReloadHandle {
  cancel(): void;
  readonly endsAt: number;
}

/**
 * Schedules the whole reload as one timed sequence. Every stage is a real
 * mechanical event (mag catch, magazine out, magazine in, bolt release) with
 * cloth between them, which is what makes reloads read as choreography rather
 * than as a sound effect.
 */
/**
 * Build reload stage times from the weapon's ReloadProfile so audio beats land
 * on the same fractions the view-model animates (cat C AV sync).
 */
function stagesFromReloadProfile(
  weaponId: string, tactical: boolean, family: WeaponFamily,
): { seconds: number; stages: ReloadStage[] } {
  const table = RELOAD_STAGES[family];
  let def: ReturnType<typeof weaponDef> | null = null;
  try { def = weaponDef(weaponId); } catch { def = null; }
  if (!def?.reload) {
    return { seconds: table.seconds, stages: tactical ? table.tactical : table.empty };
  }
  const r = def.reload;
  const seconds = tactical ? r.tactical : r.empty;
  // Per-shell guns still use the family loop choreography.
  if (r.perShell !== undefined || seconds <= 0) {
    return { seconds: table.seconds, stages: tactical ? table.tactical : table.empty };
  }
  const stages: ReloadStage[] = [
    { at: Math.max(0.02, r.magOut * 0.55), kind: 'latch', gain: 0.55, rate: 1.1, cloth: 0.4 },
    { at: r.magOut, kind: 'heavy', gain: 0.55, rate: 1.0 },
    { at: r.magIn, kind: 'heavy', gain: 0.72, rate: 0.95, cloth: 0.55 },
    { at: r.magSeat, kind: 'latch', gain: 0.5, rate: 1.05 },
  ];
  if (!tactical && r.boltRelease > 0) {
    stages.push({ at: r.boltRelease, kind: 'bolt', gain: 0.85, rate: 0.95 });
    stages.push({
      at: Math.min(0.97, r.boltRelease + 0.08),
      kind: 'spring', gain: 0.4, rate: 1.1,
    });
  } else {
    stages.push({
      at: Math.min(0.95, Math.max(r.magSeat + 0.06, r.addAmmoAt + 0.05)),
      kind: 'light', gain: 0.35, rate: 1.15,
    });
  }
  return { seconds: Math.max(0.2, seconds), stages };
}

export function playReload(
  sfx: SfxContext, weaponId: string, tactical: boolean, firstPerson: boolean,
  x = 0, y = 0, z = 0,
  /** Wall-clock duration matching the view-model (includes reloadScale). */
  durationSeconds?: number,
): ReloadHandle {
  const { ctx, pool, bank } = sfx;
  const p = profileFor(weaponId);
  const { seconds: baseTotal, stages } = stagesFromReloadProfile(weaponId, tactical, p.family);
  // Attachment reloadScale (and empty vs tac) stretches the view-model; stages
  // are fractions of that same total so audio beats stay lockstep with pose.
  const total = durationSeconds != null && durationSeconds > 0.05 ? durationSeconds : baseTotal;
  const rand = new Rand(`reload:${weaponId}:${cursor++}`);

  const voice = pool.acquire({
    bus: 'foley', x, y, z, spatial: !firstPerson,
    gain: firstPerson ? 1.0 : 0.7, send: 0.35, priority: 0.85,
    refDistance: 2, rolloff: 1.5, maxDistance: 28,
  });
  if (!voice) return { cancel: () => { /* culled */ }, endsAt: 0 };

  const t0 = sfx.now();
  const sources: AudioScheduledSourceNode[] = [];
  let end = t0;

  for (const st of stages) {
    const buf = bank.mech(st.kind, rand.int(0, 3));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = st.rate * (0.96 + rand.next() * 0.08);
    const g = gainNode(ctx, st.gain);
    const hp = filterNode(ctx, 'highpass', firstPerson ? 180 : 320, 0.7);
    src.connect(hp); hp.connect(g); g.connect(voice.input);
    const at = t0 + st.at * total;
    src.start(at);
    sources.push(src);
    end = Math.max(end, at + buf.duration);

    if (st.cloth) {
      const cloth = bank.cloth(st.cloth, rand.int(0, 3));
      const cs = ctx.createBufferSource();
      cs.buffer = cloth;
      cs.playbackRate.value = 0.85 + rand.next() * 0.3;
      const cg = gainNode(ctx, st.cloth * 0.4);
      cs.connect(cg); cg.connect(voice.input);
      const cat = at - 0.04 - rand.next() * 0.06;
      cs.start(Math.max(t0, cat));
      sources.push(cs);
      end = Math.max(end, cat + cloth.duration);
    }
  }

  voice.releaseAt(end + 0.15);
  let cancelled = false;
  return {
    endsAt: end,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      const now = sfx.now();
      for (const s of sources) { try { s.stop(now); } catch { /* not started */ } }
      voice.releaseAt(now + 0.05);
    },
  };
}

/** Holster the old weapon, raise the new one. */
export function playWeaponSwitch(sfx: SfxContext, fromId: string | null, toId: string): void {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`switch:${toId}:${cursor++}`);
  const voice = pool.acquire({
    bus: 'foley', gain: 0.9, send: 0.3, priority: 0.8, spatial: false,
  });
  if (!voice) return;
  const t0 = sfx.now();
  const toP = profileFor(toId);
  const heavy = toP.family === 'lmg' || toP.family === 'sniper' || toP.family === 'launcher';

  // Holster: cloth drag plus a sling swivel.
  if (fromId) {
    const cloth = bank.cloth(0.8, rand.int(0, 3));
    const cs = ctx.createBufferSource();
    cs.buffer = cloth; cs.playbackRate.value = 1.1;
    const cg = gainNode(ctx, 0.3);
    cs.connect(cg); cg.connect(voice.input);
    cs.start(t0);
    const sw = bank.mech('spring', rand.int(0, 3));
    const ss = ctx.createBufferSource();
    ss.buffer = sw; ss.playbackRate.value = 1.4;
    const sg = gainNode(ctx, 0.22);
    ss.connect(sg); sg.connect(voice.input);
    ss.start(t0 + 0.08);
  }

  // Raise: cloth, then the receiver settling into the shoulder.
  const cloth2 = bank.cloth(1, rand.int(0, 3));
  const c2 = ctx.createBufferSource();
  c2.buffer = cloth2; c2.playbackRate.value = 1.25;
  const g2 = gainNode(ctx, 0.32);
  c2.connect(g2); g2.connect(voice.input);
  c2.start(t0 + 0.22);

  const clack = bank.mech(heavy ? 'bolt' : 'heavy', rand.int(0, 3));
  const s3 = ctx.createBufferSource();
  s3.buffer = clack;
  s3.playbackRate.value = heavy ? 0.85 : 1.05;
  const g3 = gainNode(ctx, 0.8);
  s3.connect(g3); g3.connect(voice.input);
  s3.start(t0 + 0.34);

  voice.releaseAt(t0 + 0.34 + clack.duration + 0.15);
}

/** Shouldering / lowering the weapon. Subtle by design. */
export function playAds(sfx: SfxContext, active: boolean, weaponId: string): void {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`ads:${active ? 1 : 0}:${cursor++}`);
  const voice = pool.acquire({
    bus: 'foley', gain: 0.55, send: 0.2, priority: 0.45, spatial: false,
  });
  if (!voice) return;
  const t0 = sfx.now();
  const cloth = bank.cloth(active ? 0.7 : 0.4, rand.int(0, 3));
  const cs = ctx.createBufferSource();
  cs.buffer = cloth;
  cs.playbackRate.value = active ? 1.35 : 1.1;
  const cg = gainNode(ctx, active ? 0.5 : 0.36);
  cs.connect(cg); cg.connect(voice.input);
  cs.start(t0);

  const tick = bank.mech('light', rand.int(0, 3));
  const ts = ctx.createBufferSource();
  ts.buffer = tick;
  ts.playbackRate.value = active ? 1.5 : 1.2;
  const tg = gainNode(ctx, active ? 0.18 : 0.1);
  const hp = filterNode(ctx, 'highpass', 900, 0.7);
  ts.connect(hp); hp.connect(tg); tg.connect(voice.input);
  ts.start(t0 + (active ? 0.06 : 0.03));

  void profileFor(weaponId);
  voice.releaseAt(t0 + 0.4);
}

/** Weapon overheat: the barrel ticking and hissing. */
export function playOverheat(sfx: SfxContext, heat: number): void {
  const { ctx, pool, bank } = sfx;
  const rand = new Rand(`heat:${cursor++}`);
  const voice = pool.acquire({
    bus: 'foley', gain: clamp(heat, 0.2, 1) * 0.7, send: 0.25,
    priority: 0.3, spatial: false,
  });
  if (!voice) return;
  const t0 = sfx.now();
  const src = noiseVoice(ctx, 'white', rand);
  const bp = filterNode(ctx, 'bandpass', 5200, 2.2);
  const g = gainNode(ctx, 0);
  src.connect(bp); bp.connect(g); g.connect(voice.input);
  const e = arLin(g.gain, t0, 0.22 * heat, 0.05, 0.5);
  startNoise(src, t0, rand, 0.7);
  src.stop(e + 0.05);

  // Metal contracting: sparse high ticks.
  for (let i = 0; i < 3; i++) {
    const buf = bank.mech('light', rand.int(0, 3));
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = 1.6 + rand.next() * 0.6;
    const sg = gainNode(ctx, 0.1 + rand.next() * 0.12);
    s.connect(sg); sg.connect(voice.input);
    s.start(t0 + 0.1 + rand.next() * 0.45);
  }
  voice.releaseAt(e + 0.4);
}
