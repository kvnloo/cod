/**
 * The sample bank — except there are no samples.
 *
 * Everything a real engine would stream off disk (bullet impacts per material,
 * footsteps per surface and gait, shell casings, glass shards, cloth and gear
 * foley, debris beds) is *modal-synthesised* here at load time into
 * `AudioBuffer`s. A short noise burst excites a bank of high-Q resonators whose
 * frequencies and Q come from a description of the material; that is what makes
 * steel ring inharmonically for 300 ms, wood thud and die, glass shimmer, and
 * sand do nothing but hiss.
 *
 * Baking rather than synthesising live matters for a shooter: a firefight
 * triggers dozens of impacts a second and each one becomes a single
 * `AudioBufferSourceNode` with a random variant, playback rate and start
 * offset — effectively free — instead of a dozen live filters.
 */

import { Rand } from '../core/Rand';
import { SURFACES, type SurfaceType } from '../core/Surfaces';
import {
  Biquad, type F32, type HitSpec, type NoiseKind, clamp, fadeIn, fadeOut,
  fillNoise, normalise, renderHit, saturate, transientShape,
} from './Dsp';

/* --------------------------------------------------------- material map -- */

export type ImpactMaterial =
  | 'concrete' | 'stone' | 'tile' | 'plaster'
  | 'metal' | 'metalThin' | 'grate'
  | 'wood' | 'crate' | 'cardboard'
  | 'dirt' | 'sand' | 'gravel' | 'grass' | 'mud' | 'snow' | 'ice'
  | 'glass' | 'water'
  | 'fabric' | 'flesh' | 'armor' | 'rubber' | 'plastic' | 'foliage';

const SURFACE_TO_IMPACT: Record<SurfaceType, ImpactMaterial> = {
  concrete: 'concrete', asphalt: 'concrete', brick: 'concrete', stone: 'stone',
  plaster: 'plaster', tile: 'tile',
  metal: 'metal', metalThin: 'metalThin', grate: 'grate', pipe: 'metal',
  wood: 'wood', woodThin: 'wood', plywood: 'wood', crate: 'crate',
  dirt: 'dirt', sand: 'sand', gravel: 'gravel', grass: 'grass', mud: 'mud',
  snow: 'snow', ice: 'ice',
  glass: 'glass', glassThick: 'glass',
  water: 'water', puddle: 'water',
  fabric: 'fabric', sandbag: 'sand', carpet: 'fabric', cardboard: 'cardboard',
  flesh: 'flesh', armor: 'armor', helmet: 'armor',
  rubber: 'rubber', plastic: 'plastic', foliage: 'foliage',
};

export function impactMaterialFor(surface: string): ImpactMaterial {
  return SURFACE_TO_IMPACT[surface as SurfaceType] ?? 'concrete';
}

/* --------------------------------------------------------- impact specs -- */

function hit(o: Partial<HitSpec> & Pick<HitSpec, 'seconds' | 'modes'>): HitSpec {
  return {
    excite: 0.0022, exciteTone: 9000, exciteKind: 'white',
    bodyGain: 0.8, bodyLp: 1200, bodyHp: 0, bodyDecay: 0.05,
    clickGain: 0.5, clickTone: 7000, attack: 1.35,
    ...o,
  };
}

const IMPACT_SPECS: Record<ImpactMaterial, HitSpec> = {
  /* Masonry: a dusty crack with a short mid ring and a shower of grit. */
  concrete: hit({
    seconds: 0.42,
    modes: [
      { freq: 780, q: 22, gain: 0.55 }, { freq: 1520, q: 26, gain: 0.7 },
      { freq: 2740, q: 20, gain: 0.5 }, { freq: 4360, q: 14, gain: 0.3 },
    ],
    excite: 0.0026, exciteTone: 11000,
    bodyGain: 1.15, bodyLp: 780, bodyDecay: 0.055, clickGain: 0.72, clickTone: 9000,
    grains: { count: 12, spread: 0.16, gain: 0.16, hz: 3600, q: 26, decay: 0.02 },
    drive: 1.25,
  }),
  stone: hit({
    seconds: 0.4,
    modes: [
      { freq: 940, q: 42, gain: 0.6 }, { freq: 1870, q: 48, gain: 0.7 },
      { freq: 3410, q: 38, gain: 0.45 }, { freq: 5900, q: 22, gain: 0.24 },
    ],
    bodyGain: 0.9, bodyLp: 900, bodyDecay: 0.04, clickGain: 0.85, clickTone: 11000,
    grains: { count: 10, spread: 0.14, gain: 0.14, hz: 4200, q: 34, decay: 0.018 },
    drive: 1.3,
  }),
  plaster: hit({
    seconds: 0.3,
    modes: [{ freq: 620, q: 14, gain: 0.5 }, { freq: 1340, q: 12, gain: 0.35 }],
    excite: 0.0034, exciteTone: 5200, exciteKind: 'pink',
    bodyGain: 1.3, bodyLp: 900, bodyDecay: 0.06, clickGain: 0.3, clickTone: 4200,
    grains: { count: 14, spread: 0.2, gain: 0.13, hz: 2400, q: 16, decay: 0.025 },
  }),
  tile: hit({
    seconds: 0.7,
    modes: [
      { freq: 2380, q: 340, gain: 0.7 }, { freq: 3960, q: 300, gain: 0.55 },
      { freq: 5720, q: 240, gain: 0.36 }, { freq: 7810, q: 180, gain: 0.2 },
    ],
    bodyGain: 0.55, bodyLp: 1400, bodyDecay: 0.03, clickGain: 0.9, clickTone: 13000,
    grains: { count: 9, spread: 0.26, gain: 0.18, hz: 5200, q: 220, decay: 0.05 },
  }),

  /* Steel: long inharmonic ring plus spark sizzle. */
  metal: hit({
    seconds: 0.95,
    modes: [
      { freq: 1120, q: 520, gain: 0.62 }, { freq: 1873, q: 640, gain: 0.72 },
      { freq: 2790, q: 700, gain: 0.5 }, { freq: 4310, q: 560, gain: 0.36 },
      { freq: 6120, q: 420, gain: 0.18 }, { freq: 8640, q: 300, gain: 0.09 },
    ],
    excite: 0.0016, exciteTone: 13000,
    bodyGain: 0.48, bodyLp: 1600, bodyDecay: 0.02, clickGain: 0.9, clickTone: 13500,
    drive: 1.45, attack: 1.7,
  }),
  metalThin: hit({
    seconds: 0.75,
    modes: [
      { freq: 1640, q: 260, gain: 0.6 }, { freq: 2910, q: 320, gain: 0.72 },
      { freq: 4720, q: 300, gain: 0.52 }, { freq: 7180, q: 220, gain: 0.3 },
      { freq: 10400, q: 160, gain: 0.16 },
    ],
    excite: 0.0011, exciteTone: 17000,
    bodyGain: 0.28, bodyLp: 2200, bodyDecay: 0.014, clickGain: 1.0, clickTone: 17000,
    drive: 1.8, attack: 1.8,
  }),
  grate: hit({
    seconds: 0.85,
    modes: [
      { freq: 1330, q: 180, gain: 0.5 }, { freq: 2460, q: 240, gain: 0.62 },
      { freq: 3980, q: 260, gain: 0.5 }, { freq: 6640, q: 200, gain: 0.3 },
    ],
    excite: 0.0016, exciteTone: 14000,
    bodyGain: 0.3, bodyLp: 1800, bodyDecay: 0.02, clickGain: 0.85, clickTone: 15000,
    grains: { count: 6, spread: 0.22, gain: 0.2, hz: 3400, q: 180, decay: 0.06 },
    drive: 1.5,
  }),

  /* Timber: low resonance that dies almost immediately, plus splinters. */
  wood: hit({
    seconds: 0.4,
    modes: [
      { freq: 318, q: 58, gain: 0.62 }, { freq: 642, q: 46, gain: 0.5 },
      { freq: 1184, q: 32, gain: 0.36 }, { freq: 2310, q: 22, gain: 0.22 },
    ],
    excite: 0.0026, exciteTone: 7000,
    bodyGain: 1.0, bodyLp: 1500, bodyDecay: 0.045, clickGain: 0.62, clickTone: 8500,
    grains: { count: 7, spread: 0.13, gain: 0.13, hz: 2600, q: 40, decay: 0.03 },
    drive: 1.2,
  }),
  crate: hit({
    seconds: 0.5,
    modes: [
      { freq: 176, q: 42, gain: 0.75 }, { freq: 388, q: 38, gain: 0.55 },
      { freq: 812, q: 26, gain: 0.36 }, { freq: 1640, q: 18, gain: 0.2 },
    ],
    excite: 0.003, exciteTone: 6000,
    bodyGain: 1.2, bodyLp: 1100, bodyDecay: 0.06, clickGain: 0.55, clickTone: 7000,
    grains: { count: 9, spread: 0.18, gain: 0.14, hz: 2200, q: 30, decay: 0.04 },
  }),
  cardboard: hit({
    seconds: 0.26,
    modes: [{ freq: 214, q: 24, gain: 0.6 }, { freq: 486, q: 18, gain: 0.4 }],
    excite: 0.0035, exciteTone: 4200, exciteKind: 'pink',
    bodyGain: 1.1, bodyLp: 2400, bodyDecay: 0.035, clickGain: 0.35, clickTone: 5200,
    grains: { count: 8, spread: 0.1, gain: 0.12, hz: 3800, q: 12, decay: 0.02 },
  }),

  /* Ground: no resonance at all, only a filtered puff and scattered grit. */
  dirt: hit({
    seconds: 0.3,
    modes: [{ freq: 210, q: 8, gain: 0.5 }],
    excite: 0.0055, exciteTone: 2400, exciteKind: 'pink',
    bodyGain: 1.5, bodyLp: 720, bodyDecay: 0.06, clickGain: 0.18, clickTone: 2600,
    grains: { count: 10, spread: 0.14, gain: 0.1, hz: 1800, q: 8, decay: 0.03 },
    attack: 1.1,
  }),
  mud: hit({
    seconds: 0.3,
    modes: [{ freq: 150, q: 6, gain: 0.6 }],
    excite: 0.007, exciteTone: 1300, exciteKind: 'pink',
    bodyGain: 1.6, bodyLp: 460, bodyDecay: 0.08, clickGain: 0.1, clickTone: 1500,
    attack: 1.0,
  }),
  sand: hit({
    seconds: 0.34,
    modes: [],
    excite: 0.008, exciteTone: 5200, exciteKind: 'pink',
    bodyGain: 1.6, bodyLp: 3200, bodyHp: 340, bodyDecay: 0.085, clickGain: 0.06, clickTone: 4000,
    grains: { count: 22, spread: 0.2, gain: 0.07, hz: 5200, q: 6, decay: 0.02 },
    attack: 0.9,
  }),
  gravel: hit({
    seconds: 0.45,
    modes: [{ freq: 640, q: 26, gain: 0.35 }, { freq: 1420, q: 22, gain: 0.28 }],
    excite: 0.004, exciteTone: 6200,
    bodyGain: 1.2, bodyLp: 1400, bodyDecay: 0.05, clickGain: 0.4, clickTone: 7000,
    grains: { count: 26, spread: 0.28, gain: 0.2, hz: 3200, q: 30, decay: 0.024 },
  }),
  grass: hit({
    seconds: 0.26,
    modes: [],
    excite: 0.006, exciteTone: 8500, exciteKind: 'pink',
    bodyGain: 1.4, bodyLp: 6500, bodyHp: 700, bodyDecay: 0.05, clickGain: 0.08, clickTone: 6000,
    grains: { count: 16, spread: 0.14, gain: 0.07, hz: 6500, q: 5, decay: 0.02 },
    attack: 0.95,
  }),
  snow: hit({
    seconds: 0.32,
    modes: [],
    excite: 0.0065, exciteTone: 4200, exciteKind: 'pink',
    bodyGain: 1.5, bodyLp: 2600, bodyHp: 260, bodyDecay: 0.07, clickGain: 0.14, clickTone: 5200,
    grains: { count: 20, spread: 0.16, gain: 0.11, hz: 4200, q: 14, decay: 0.016 },
    attack: 1.05,
  }),
  ice: hit({
    seconds: 0.6,
    modes: [
      { freq: 2210, q: 620, gain: 0.6 }, { freq: 3740, q: 520, gain: 0.45 },
      { freq: 5610, q: 400, gain: 0.3 },
    ],
    excite: 0.0015, exciteTone: 14000,
    bodyGain: 0.6, bodyLp: 1900, bodyDecay: 0.028, clickGain: 0.9, clickTone: 14000,
    grains: { count: 8, spread: 0.22, gain: 0.16, hz: 6200, q: 300, decay: 0.05 },
  }),

  /* Glass: long bright shimmer with a shower of shards. */
  glass: hit({
    seconds: 1.1,
    modes: [
      { freq: 3120, q: 1400, gain: 0.4 }, { freq: 4610, q: 1700, gain: 0.62 },
      { freq: 6240, q: 1500, gain: 0.6 }, { freq: 8130, q: 1200, gain: 0.46 },
      { freq: 10620, q: 900, gain: 0.3 },
    ],
    excite: 0.0008, exciteTone: 19000,
    bodyGain: 0.18, bodyLp: 3200, bodyDecay: 0.01, clickGain: 0.95, clickTone: 19000,
    grains: { count: 22, spread: 0.55, gain: 0.26, hz: 8200, q: 700, decay: 0.09 },
    attack: 1.5,
  }),

  /* Water: broadband splash; the bubble is added live as a pitch sweep. */
  water: hit({
    seconds: 0.5,
    modes: [{ freq: 480, q: 16, gain: 0.3 }],
    excite: 0.005, exciteTone: 7200, exciteKind: 'pink',
    bodyGain: 1.5, bodyLp: 4200, bodyHp: 220, bodyDecay: 0.1, clickGain: 0.3, clickTone: 6000,
    grains: { count: 14, spread: 0.22, gain: 0.1, hz: 2600, q: 20, decay: 0.03 },
    attack: 1.15,
  }),

  /* Soft targets. */
  fabric: hit({
    seconds: 0.24,
    modes: [{ freq: 180, q: 10, gain: 0.5 }],
    excite: 0.005, exciteTone: 3200, exciteKind: 'pink',
    bodyGain: 1.4, bodyLp: 900, bodyDecay: 0.04, clickGain: 0.12, clickTone: 3600,
    grains: { count: 10, spread: 0.1, gain: 0.06, hz: 4800, q: 5, decay: 0.02 },
    attack: 1.0,
  }),
  flesh: hit({
    seconds: 0.3,
    modes: [{ freq: 128, q: 9, gain: 0.85 }, { freq: 296, q: 7, gain: 0.4 }],
    excite: 0.0045, exciteTone: 1900, exciteKind: 'pink',
    bodyGain: 1.7, bodyLp: 520, bodyDecay: 0.055, clickGain: 0.28, clickTone: 2600,
    grains: { count: 8, spread: 0.09, gain: 0.09, hz: 900, q: 7, decay: 0.03 },
    drive: 1.4, attack: 1.25,
  }),
  armor: hit({
    seconds: 0.55,
    modes: [
      { freq: 880, q: 96, gain: 0.6 }, { freq: 1610, q: 82, gain: 0.5 },
      { freq: 2940, q: 60, gain: 0.34 }, { freq: 4800, q: 40, gain: 0.18 },
    ],
    excite: 0.0018, exciteTone: 11000,
    bodyGain: 0.9, bodyLp: 700, bodyDecay: 0.035, clickGain: 0.8, clickTone: 12000,
    drive: 1.5, attack: 1.5,
  }),
  rubber: hit({
    seconds: 0.24,
    modes: [{ freq: 138, q: 14, gain: 0.7 }, { freq: 302, q: 10, gain: 0.32 }],
    excite: 0.004, exciteTone: 2200,
    bodyGain: 1.25, bodyLp: 560, bodyDecay: 0.036, clickGain: 0.24, clickTone: 3200,
  }),
  plastic: hit({
    seconds: 0.38,
    modes: [
      { freq: 1720, q: 140, gain: 0.62 }, { freq: 3260, q: 110, gain: 0.44 },
      { freq: 5410, q: 80, gain: 0.24 },
    ],
    excite: 0.0016, exciteTone: 12000,
    bodyGain: 0.75, bodyLp: 1500, bodyDecay: 0.028, clickGain: 0.75, clickTone: 12000,
    drive: 1.3,
  }),
  foliage: hit({
    seconds: 0.26,
    modes: [],
    excite: 0.0075, exciteTone: 11000, exciteKind: 'pink',
    bodyGain: 1.3, bodyLp: 9000, bodyHp: 1100, bodyDecay: 0.06, clickGain: 0.05, clickTone: 8000,
    grains: { count: 20, spread: 0.16, gain: 0.08, hz: 7200, q: 6, decay: 0.018 },
    attack: 0.9,
  }),
};

/* ------------------------------------------------------- footstep specs -- */

export interface FootstepSpec {
  /** Heel strike. */
  heel: HitSpec;
  /** Toe/roll-off, quieter and brighter, this many seconds later. */
  toeDelay: number;
  toeGain: number;
  /** Extra surface scatter after the strike. */
  scatter?: { count: number; spread: number; gain: number; hz: number; q: number; decay: number };
  seconds: number;
}

function foot(heel: Partial<HitSpec> & Pick<HitSpec, 'seconds' | 'modes'>, o: Partial<FootstepSpec> = {}): FootstepSpec {
  return {
    heel: hit(heel),
    toeDelay: o.toeDelay ?? 0.036,
    toeGain: o.toeGain ?? 0.4,
    scatter: o.scatter,
    seconds: o.seconds ?? 0.45,
  };
}

const FOOTSTEP_SPECS: Record<string, FootstepSpec> = {
  concrete: foot({
    seconds: 0.3,
    modes: [{ freq: 620, q: 28, gain: 0.4 }, { freq: 1480, q: 22, gain: 0.32 }, { freq: 2900, q: 14, gain: 0.16 }],
    excite: 0.004, exciteTone: 7000,
    bodyGain: 1.3, bodyLp: 620, bodyDecay: 0.045, clickGain: 0.42, clickTone: 8000,
  }, { scatter: { count: 5, spread: 0.07, gain: 0.06, hz: 3600, q: 22, decay: 0.014 } }),
  tile: foot({
    seconds: 0.42,
    modes: [{ freq: 1980, q: 240, gain: 0.5 }, { freq: 3420, q: 200, gain: 0.34 }, { freq: 5200, q: 150, gain: 0.18 }],
    excite: 0.0022, exciteTone: 12000,
    bodyGain: 0.9, bodyLp: 900, bodyDecay: 0.03, clickGain: 0.72, clickTone: 12000,
  }),
  metal: foot({
    seconds: 0.7,
    modes: [
      { freq: 720, q: 200, gain: 0.5 }, { freq: 1380, q: 260, gain: 0.55 },
      { freq: 2470, q: 240, gain: 0.4 }, { freq: 4150, q: 180, gain: 0.22 },
    ],
    excite: 0.0022, exciteTone: 12000,
    bodyGain: 0.6, bodyLp: 800, bodyDecay: 0.03, clickGain: 0.8, clickTone: 13000,
    drive: 1.4,
  }, { toeGain: 0.45 }),
  wood: foot({
    seconds: 0.36,
    modes: [{ freq: 246, q: 46, gain: 0.72 }, { freq: 512, q: 34, gain: 0.45 }, { freq: 1010, q: 24, gain: 0.26 }],
    excite: 0.0035, exciteTone: 5600,
    bodyGain: 1.15, bodyLp: 1100, bodyDecay: 0.05, clickGain: 0.5, clickTone: 7000,
  }),
  dirt: foot({
    seconds: 0.3,
    modes: [{ freq: 190, q: 7, gain: 0.4 }],
    excite: 0.0075, exciteTone: 2200, exciteKind: 'pink',
    bodyGain: 1.5, bodyLp: 700, bodyDecay: 0.055, clickGain: 0.12, clickTone: 2600,
  }, { scatter: { count: 9, spread: 0.1, gain: 0.07, hz: 2000, q: 7, decay: 0.02 }, toeGain: 0.5 }),
  mud: foot({
    seconds: 0.36,
    modes: [{ freq: 132, q: 6, gain: 0.55 }],
    excite: 0.011, exciteTone: 1100, exciteKind: 'pink',
    bodyGain: 1.7, bodyLp: 420, bodyDecay: 0.075, clickGain: 0.08, clickTone: 1400,
  }, { toeDelay: 0.055, toeGain: 0.7 }),
  sand: foot({
    seconds: 0.34,
    modes: [],
    excite: 0.012, exciteTone: 4800, exciteKind: 'pink',
    bodyGain: 1.6, bodyLp: 3000, bodyHp: 300, bodyDecay: 0.075, clickGain: 0.04, clickTone: 3600,
  }, { scatter: { count: 18, spread: 0.13, gain: 0.06, hz: 5000, q: 5, decay: 0.018 }, toeGain: 0.6 }),
  gravel: foot({
    seconds: 0.46,
    modes: [{ freq: 560, q: 22, gain: 0.24 }, { freq: 2900, q: 60, gain: 0.2 }],
    excite: 0.0035, exciteTone: 9000,
    bodyGain: 0.9, bodyLp: 2600, bodyDecay: 0.04, clickGain: 0.45, clickTone: 9000,
  }, { scatter: { count: 28, spread: 0.22, gain: 0.3, hz: 5200, q: 40, decay: 0.02 }, toeGain: 0.55 }),
  grass: foot({
    seconds: 0.28,
    modes: [],
    excite: 0.009, exciteTone: 8000, exciteKind: 'pink',
    bodyGain: 1.4, bodyLp: 6000, bodyHp: 620, bodyDecay: 0.05, clickGain: 0.06, clickTone: 5600,
  }, { scatter: { count: 14, spread: 0.12, gain: 0.06, hz: 6200, q: 5, decay: 0.018 }, toeGain: 0.6 }),
  snow: foot({
    seconds: 0.36,
    modes: [],
    excite: 0.011, exciteTone: 2100, exciteKind: 'pink',
    bodyGain: 1.7, bodyLp: 1500, bodyHp: 190, bodyDecay: 0.08, clickGain: 0.06, clickTone: 2600,
  }, { scatter: { count: 22, spread: 0.15, gain: 0.09, hz: 2200, q: 11, decay: 0.016 }, toeGain: 0.62 }),
  ice: foot({
    seconds: 0.5,
    modes: [{ freq: 1980, q: 480, gain: 0.42 }, { freq: 3390, q: 380, gain: 0.28 }],
    excite: 0.0026, exciteTone: 12000,
    bodyGain: 0.9, bodyLp: 1500, bodyDecay: 0.03, clickGain: 0.6, clickTone: 12000,
  }),
  water: foot({
    seconds: 0.5,
    modes: [{ freq: 420, q: 14, gain: 0.25 }],
    excite: 0.009, exciteTone: 6200, exciteKind: 'pink',
    bodyGain: 1.5, bodyLp: 3800, bodyHp: 180, bodyDecay: 0.1, clickGain: 0.2, clickTone: 5200,
  }, { scatter: { count: 12, spread: 0.18, gain: 0.09, hz: 2400, q: 18, decay: 0.028 }, toeDelay: 0.05, toeGain: 0.7 }),
  fabric: foot({
    seconds: 0.26,
    modes: [{ freq: 165, q: 9, gain: 0.4 }],
    excite: 0.007, exciteTone: 3000, exciteKind: 'pink',
    bodyGain: 1.35, bodyLp: 800, bodyDecay: 0.04, clickGain: 0.08, clickTone: 3400,
  }, { toeGain: 0.5 }),
  carpet: foot({
    seconds: 0.24,
    modes: [{ freq: 148, q: 8, gain: 0.42 }],
    excite: 0.008, exciteTone: 2400, exciteKind: 'pink',
    bodyGain: 1.4, bodyLp: 640, bodyDecay: 0.04, clickGain: 0.06, clickTone: 2800,
  }, { toeGain: 0.45 }),
  flesh: foot({
    seconds: 0.28,
    modes: [{ freq: 120, q: 8, gain: 0.7 }],
    excite: 0.005, exciteTone: 1800, exciteKind: 'pink',
    bodyGain: 1.6, bodyLp: 500, bodyDecay: 0.05, clickGain: 0.18, clickTone: 2400,
  }),
  rubber: foot({
    seconds: 0.26,
    modes: [{ freq: 142, q: 13, gain: 0.6 }, { freq: 318, q: 9, gain: 0.28 }],
    excite: 0.0045, exciteTone: 2400,
    bodyGain: 1.2, bodyLp: 560, bodyDecay: 0.035, clickGain: 0.2, clickTone: 3200,
  }),
  plastic: foot({
    seconds: 0.34,
    modes: [{ freq: 1420, q: 110, gain: 0.5 }, { freq: 2810, q: 90, gain: 0.3 }],
    excite: 0.0022, exciteTone: 10000,
    bodyGain: 0.85, bodyLp: 1200, bodyDecay: 0.03, clickGain: 0.6, clickTone: 11000,
  }),
};

export function footstepBankFor(surface: string): string {
  const s = SURFACES[surface as SurfaceType];
  const bank = s?.footstep ?? 'concrete';
  return FOOTSTEP_SPECS[bank] ? bank : 'concrete';
}

/* ------------------------------------------------------------- renderers -- */

function renderFootstep(sampleRate: number, spec: FootstepSpec, rand: Rand): F32 {
  const n = Math.ceil(spec.seconds * sampleRate);
  const out = new Float32Array(n);

  const heel = renderHit(sampleRate, { ...spec.heel, seconds: Math.min(spec.seconds, spec.heel.seconds) }, rand);
  for (let i = 0; i < heel.length && i < n; i++) out[i] += heel[i];

  // The toe roll-off: same material, lighter and brighter.
  const toe = renderHit(sampleRate, {
    ...spec.heel,
    seconds: Math.min(spec.seconds * 0.6, spec.heel.seconds * 0.75),
    excite: spec.heel.excite * 0.7,
    exciteTone: spec.heel.exciteTone * 1.25,
    bodyGain: spec.heel.bodyGain * 0.55,
    clickGain: spec.heel.clickGain * 0.7,
  }, rand);
  const off = Math.floor(spec.toeDelay * (0.8 + rand.next() * 0.45) * sampleRate);
  for (let i = 0; i < toe.length && off + i < n; i++) out[off + i] += toe[i] * spec.toeGain;

  // Loose surface scatter continues after the foot has landed.
  if (spec.scatter) {
    const g = spec.scatter;
    const bq = new Biquad();
    for (let k = 0; k < g.count; k++) {
      const at = off + Math.floor(rand.next() * rand.next() * g.spread * sampleRate);
      if (at >= n - 4) continue;
      const len = Math.min(n - at, Math.ceil(g.decay * sampleRate));
      bq.set('bandpass', sampleRate, g.hz * (0.5 + rand.next() * 1.6), g.q).reset();
      const amp = g.gain * Math.sqrt(g.q) * 0.25 * (0.3 + rand.next() * 0.7);
      for (let i = 0; i < len; i++) out[at + i] += bq.process(i < 3 ? rand.signed() : 0) * amp;
    }
  }

  normalise(out, 0.95);
  fadeOut(out, Math.ceil(0.01 * sampleRate));
  return out;
}

export interface ClothSpec {
  seconds: number;
  /** Band the rustle sits in. */
  hz: number;
  q: number;
  /** Number of overlapping swells. */
  swells: number;
  /** Metallic gear ticks (buckles, sling swivels, magazines). */
  ticks: number;
  tickHz: number;
  gain: number;
  kind: NoiseKind;
}

function renderCloth(sampleRate: number, spec: ClothSpec, rand: Rand): F32 {
  const n = Math.ceil(spec.seconds * sampleRate);
  const out = new Float32Array(n);
  const noise = new Float32Array(n);
  fillNoise(noise, spec.kind, rand, 1);

  const bp = new Biquad();
  for (let s = 0; s < spec.swells; s++) {
    bp.set('bandpass', sampleRate, spec.hz * (0.6 + rand.next() * 1.1), spec.q).reset();
    const start = Math.floor(rand.next() * 0.45 * n);
    const len = Math.floor((0.25 + rand.next() * 0.6) * (n - start));
    const amp = (0.4 + rand.next() * 0.6) / spec.swells;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / len;
      // Asymmetric swell: quick in, slow out — cloth dragging over cloth.
      const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.65)), 1.6);
      out[start + i] += bp.process(noise[start + i]) * env * amp;
    }
  }

  const tick = new Biquad();
  for (let k = 0; k < spec.ticks; k++) {
    const at = Math.floor(rand.next() * (n - 1200));
    if (at < 0) continue;
    tick.set('bandpass', sampleRate, spec.tickHz * (0.7 + rand.next() * 0.9), 220).reset();
    const amp = 0.18 + rand.next() * 0.3;
    const len = Math.min(n - at, Math.ceil(0.08 * sampleRate));
    for (let i = 0; i < len; i++) out[at + i] += tick.process(i < 2 ? rand.signed() : 0) * amp;
  }

  normalise(out, spec.gain);
  fadeIn(out, 32);
  fadeOut(out, Math.ceil(0.02 * sampleRate));
  return out;
}

/** A dense bed of small rubble hits, used as the source for granular debris. */
function renderDebrisBed(sampleRate: number, seconds: number, rand: Rand): F32 {
  const n = Math.ceil(seconds * sampleRate);
  const out = new Float32Array(n);
  const bq = new Biquad();
  const count = Math.floor(seconds * 240);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rand.next() * (n - 2000));
    const hz = 320 + rand.next() * rand.next() * 5200;
    bq.set('bandpass', sampleRate, hz, 24 + rand.next() * 90).reset();
    const amp = 0.25 + rand.next() * 0.75;
    const len = Math.min(n - at, Math.ceil((0.01 + rand.next() * 0.06) * sampleRate));
    for (let i = 0; i < len; i++) out[at + i] += bq.process(i < 3 ? rand.signed() : 0) * amp;
  }
  saturate(out, 1.2);
  normalise(out, 0.9);
  return out;
}

/* ---------------------------------------------------------------- bank -- */

export interface BankOptions {
  /** Variants per entry. */
  variants?: number;
  /** Shortens every buffer; the `low` preset uses 0.6. */
  lengthScale?: number;
}

export class SoundBank {
  private ctx: BaseAudioContext;
  private cache = new Map<string, AudioBuffer>();
  private variants: number;
  private lengthScale: number;

  constructor(ctx: BaseAudioContext, o: BankOptions = {}) {
    this.ctx = ctx;
    this.variants = Math.max(1, o.variants ?? 4);
    this.lengthScale = o.lengthScale ?? 1;
  }

  get size(): number { return this.cache.size; }
  get variantCount(): number { return this.variants; }

  private store(key: string, data: F32): AudioBuffer {
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data, 0);
    this.cache.set(key, buf);
    return buf;
  }

  private scaled(spec: HitSpec): HitSpec {
    if (this.lengthScale === 1) return spec;
    return { ...spec, seconds: Math.max(0.06, spec.seconds * this.lengthScale) };
  }

  /** Bullet/physics impact for a material. `v` selects a variant. */
  impact(material: ImpactMaterial, v: number): AudioBuffer {
    const idx = ((v % this.variants) + this.variants) % this.variants;
    const key = `imp:${material}:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const spec = IMPACT_SPECS[material] ?? IMPACT_SPECS.concrete;
    const rand = new Rand(`impact:${material}:${idx}`);
    return this.store(key, renderHit(this.ctx.sampleRate, this.scaled(spec), rand));
  }

  /** Footstep for a surface bank. */
  footstep(bank: string, v: number): AudioBuffer {
    const idx = ((v % this.variants) + this.variants) % this.variants;
    const key = `foot:${bank}:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const spec = FOOTSTEP_SPECS[bank] ?? FOOTSTEP_SPECS.concrete;
    const rand = new Rand(`foot:${bank}:${idx}`);
    const scaled: FootstepSpec = this.lengthScale === 1 ? spec : {
      ...spec, seconds: spec.seconds * this.lengthScale,
      heel: this.scaled(spec.heel),
    };
    return this.store(key, renderFootstep(this.ctx.sampleRate, scaled, rand));
  }

  /** A single brass casing bounce. */
  casing(v: number): AudioBuffer {
    const idx = v % 6;
    const key = `case:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand(`casing:${idx}`);
    const spec = hit({
      seconds: 0.34 * this.lengthScale,
      modes: [
        { freq: 2380 + idx * 90, q: 700, gain: 0.6 },
        { freq: 3910 + idx * 130, q: 820, gain: 0.72 },
        { freq: 5640 + idx * 180, q: 700, gain: 0.5 },
        { freq: 8120 + idx * 240, q: 520, gain: 0.3 },
        { freq: 11300, q: 340, gain: 0.14 },
      ],
      excite: 0.0007, exciteTone: 18000,
      bodyGain: 0.14, bodyLp: 3000, bodyDecay: 0.008, clickGain: 0.9, clickTone: 17000,
      drive: 1.4, attack: 1.7,
    });
    return this.store(key, renderHit(this.ctx.sampleRate, spec, rand));
  }

  /** The metallic "spang" that starts a ricochet, before the whine. */
  ricochetSpang(v: number): AudioBuffer {
    const idx = v % 4;
    const key = `ric:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand(`ricochet:${idx}`);
    const spec = hit({
      seconds: 0.5 * this.lengthScale,
      modes: [
        { freq: 1860 + idx * 120, q: 420, gain: 0.55 },
        { freq: 3240 + idx * 210, q: 520, gain: 0.7 },
        { freq: 5180 + idx * 320, q: 460, gain: 0.5 },
        { freq: 7920, q: 320, gain: 0.28 },
      ],
      excite: 0.0012, exciteTone: 16000,
      bodyGain: 0.3, bodyLp: 2200, bodyDecay: 0.016, clickGain: 1.0, clickTone: 16000,
      drive: 1.9, attack: 1.9,
    });
    return this.store(key, renderHit(this.ctx.sampleRate, spec, rand));
  }

  /** Falling glass shards after a pane breaks. */
  glassShard(v: number): AudioBuffer {
    const idx = v % 4;
    const key = `shard:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand(`shard:${idx}`);
    const spec = hit({
      seconds: 0.55 * this.lengthScale,
      modes: [
        { freq: 4200 + idx * 400, q: 900, gain: 0.6 },
        { freq: 6700 + idx * 520, q: 800, gain: 0.45 },
        { freq: 9400, q: 620, gain: 0.24 },
      ],
      excite: 0.0007, exciteTone: 18000,
      bodyGain: 0.1, bodyLp: 3000, bodyDecay: 0.006, clickGain: 0.9, clickTone: 18000,
      attack: 1.6,
    });
    return this.store(key, renderHit(this.ctx.sampleRate, spec, rand));
  }

  /** Cloth/gear rustle. `weight` 0 = light shirt, 1 = full plate carrier. */
  cloth(weight: number, v: number): AudioBuffer {
    const idx = v % this.variants;
    const w = clamp(weight, 0, 1);
    const bucket = w < 0.34 ? 0 : w < 0.67 ? 1 : 2;
    const key = `cloth:${bucket}:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand(`cloth:${bucket}:${idx}`);
    const spec: ClothSpec = {
      seconds: (0.34 + bucket * 0.12) * this.lengthScale,
      hz: 3600 - bucket * 900,
      q: 1.1 + bucket * 0.5,
      swells: 2 + bucket,
      ticks: bucket,
      tickHz: 4200,
      gain: 0.55 + bucket * 0.15,
      kind: 'pink',
    };
    return this.store(key, renderCloth(this.ctx.sampleRate, spec, rand));
  }

  /** Metallic gear/weapon handling tick used across reload and switch stages. */
  mech(profile: 'light' | 'heavy' | 'spring' | 'latch' | 'bolt', v: number): AudioBuffer {
    const idx = v % this.variants;
    const key = `mech:${profile}:${idx}`;
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand(`mech:${profile}:${idx}`);
    const table: Record<string, HitSpec> = {
      light: hit({
        seconds: 0.2,
        modes: [
          { freq: 2900, q: 300, gain: 0.6 }, { freq: 4700, q: 340, gain: 0.5 },
          { freq: 7300, q: 260, gain: 0.28 },
        ],
        excite: 0.0008, exciteTone: 16000,
        bodyGain: 0.16, bodyLp: 2600, bodyDecay: 0.01, clickGain: 0.9, clickTone: 16000,
        drive: 1.5, attack: 1.8,
      }),
      heavy: hit({
        seconds: 0.34,
        modes: [
          { freq: 620, q: 160, gain: 0.7 }, { freq: 1180, q: 200, gain: 0.55 },
          { freq: 2240, q: 220, gain: 0.4 }, { freq: 3900, q: 160, gain: 0.2 },
        ],
        excite: 0.0022, exciteTone: 9000,
        bodyGain: 0.85, bodyLp: 620, bodyDecay: 0.03, clickGain: 0.8, clickTone: 11000,
        drive: 1.6, attack: 1.6,
      }),
      spring: hit({
        seconds: 0.4,
        modes: [
          { freq: 1450, q: 800, gain: 0.5 }, { freq: 2170, q: 900, gain: 0.42 },
          { freq: 3310, q: 760, gain: 0.3 }, { freq: 5020, q: 600, gain: 0.18 },
        ],
        excite: 0.0016, exciteTone: 13000,
        bodyGain: 0.12, bodyLp: 2400, bodyDecay: 0.012, clickGain: 0.55, clickTone: 13000,
        attack: 1.4,
      }),
      latch: hit({
        seconds: 0.24,
        modes: [
          { freq: 1780, q: 240, gain: 0.66 }, { freq: 3120, q: 280, gain: 0.5 },
          { freq: 5400, q: 200, gain: 0.26 },
        ],
        excite: 0.001, exciteTone: 15000,
        bodyGain: 0.4, bodyLp: 1400, bodyDecay: 0.016, clickGain: 0.95, clickTone: 15000,
        drive: 1.7, attack: 1.9,
      }),
      bolt: hit({
        seconds: 0.42,
        modes: [
          { freq: 420, q: 120, gain: 0.72 }, { freq: 860, q: 180, gain: 0.6 },
          { freq: 1690, q: 220, gain: 0.45 }, { freq: 3080, q: 180, gain: 0.28 },
          { freq: 5400, q: 120, gain: 0.14 },
        ],
        excite: 0.0026, exciteTone: 11000,
        bodyGain: 0.95, bodyLp: 540, bodyDecay: 0.035, clickGain: 0.9, clickTone: 13000,
        drive: 1.8, attack: 1.7,
      }),
    };
    return this.store(key, renderHit(this.ctx.sampleRate, this.scaled(table[profile]), rand));
  }

  /** Long bed of rubble hits, played granularly for debris showers. */
  debrisBed(): AudioBuffer {
    const key = 'debris';
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand('debris-bed');
    return this.store(key, renderDebrisBed(this.ctx.sampleRate, 1.6 * this.lengthScale, rand));
  }

  /** Shared crackle bed for fire and burning debris. */
  crackleBed(): AudioBuffer {
    const key = 'crackle';
    const hitBuf = this.cache.get(key);
    if (hitBuf) return hitBuf;
    const rand = new Rand('crackle-bed');
    const sr = this.ctx.sampleRate;
    const n = Math.ceil(2.0 * this.lengthScale * sr);
    const out = new Float32Array(n);
    const bq = new Biquad();
    for (let k = 0; k < 900; k++) {
      const at = Math.floor(rand.next() * (n - 800));
      bq.set('bandpass', sr, 900 + rand.next() * rand.next() * 7000, 40 + rand.next() * 200).reset();
      const amp = 0.15 + rand.next() * rand.next() * 0.85;
      const len = Math.min(n - at, Math.ceil((0.004 + rand.next() * 0.02) * sr));
      for (let i = 0; i < len; i++) out[at + i] += bq.process(i < 2 ? rand.signed() : 0) * amp;
    }
    normalise(out, 0.85);
    transientShape(out, sr, 1.4, 0.9);
    return this.store(key, out);
  }

  /**
   * Warms the common set so the first firefight does not hitch. Everything
   * else is built on demand and cached forever.
   */
  warmup(): { built: number; ms: number } {
    const t0 = (globalThis.performance?.now?.() ?? 0);
    const materials: ImpactMaterial[] = [
      'concrete', 'metal', 'metalThin', 'wood', 'dirt', 'gravel', 'sand', 'grass',
      'glass', 'flesh', 'fabric', 'armor', 'plastic', 'water', 'foliage',
    ];
    for (const m of materials) for (let v = 0; v < this.variants; v++) this.impact(m, v);
    for (const b of ['concrete', 'dirt', 'gravel', 'metal', 'wood', 'grass', 'sand']) {
      for (let v = 0; v < this.variants; v++) this.footstep(b, v);
    }
    for (let v = 0; v < 6; v++) this.casing(v);
    for (let v = 0; v < 4; v++) this.ricochetSpang(v);
    for (const p of ['light', 'heavy', 'spring', 'latch', 'bolt'] as const) {
      for (let v = 0; v < this.variants; v++) this.mech(p, v);
    }
    for (let w = 0; w < 3; w++) for (let v = 0; v < this.variants; v++) this.cloth(w / 2, v);
    this.debrisBed();
    this.crackleBed();
    const ms = (globalThis.performance?.now?.() ?? 0) - t0;
    return { built: this.cache.size, ms };
  }

  /** Builds absolutely everything — used by the offline verification pass. */
  warmupAll(): void {
    this.warmup();
    for (const m of Object.keys(IMPACT_SPECS) as ImpactMaterial[]) {
      for (let v = 0; v < this.variants; v++) this.impact(m, v);
    }
    for (const b of Object.keys(FOOTSTEP_SPECS)) {
      for (let v = 0; v < this.variants; v++) this.footstep(b, v);
    }
    for (let v = 0; v < 4; v++) this.glassShard(v);
  }

  dispose(): void { this.cache.clear(); }
}

/**
 * The dry material response, with no mixer, panner or reverb in the way.
 *
 * Claims like "steel rings and sand does not" are properties of the *material*,
 * so the bench measures them here rather than through a reverberant mix where
 * every material inherits the same tail.
 */
export function renderImpactMaterial(sampleRate: number, material: ImpactMaterial, variant = 0): F32 {
  const spec = IMPACT_SPECS[material] ?? IMPACT_SPECS.concrete;
  return renderHit(sampleRate, spec, new Rand(`impact:${material}:${variant}`));
}

export const IMPACT_MATERIALS = Object.keys(IMPACT_SPECS) as ImpactMaterial[];
export const FOOTSTEP_BANKS = Object.keys(FOOTSTEP_SPECS);
