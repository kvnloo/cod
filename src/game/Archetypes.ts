/**
 * Enemy archetype table and the escalation curve that decides which of them the
 * director is allowed to field.
 *
 * The pressure curve of a wave shooter comes almost entirely from *composition*,
 * not from raw counts: a rifleman is a target, a shotgunner is a timer, a sniper
 * is a positional constraint, and a juggernaut is a problem the player has to
 * solve with resources. `pickArchetype` is where that escalation is expressed.
 */

import type { Rand } from '../core/Rand';
import type { Archetype, ArchetypeProfile } from './types';

export const ARCHETYPES: Record<Archetype, ArchetypeProfile> = {
  rifleman: {
    id: 'rifleman', name: 'Rifleman', health: 100, range: 34, rpm: 640, damage: 11,
    accuracy: 0.19, speed: 3.4, score: 100, cash: 60, weight: 1, radius: 0.34, height: 1.78,
  },
  smg: {
    id: 'smg', name: 'Assaulter', health: 85, range: 20, rpm: 840, damage: 8,
    accuracy: 0.17, speed: 4.6, score: 110, cash: 65, weight: 1, radius: 0.33, height: 1.76,
  },
  shotgun: {
    id: 'shotgun', name: 'Breacher', health: 130, range: 11, rpm: 90, damage: 44,
    accuracy: 0.30, speed: 4.9, score: 150, cash: 90, weight: 1.35, radius: 0.36, height: 1.8,
  },
  sniper: {
    id: 'sniper', name: 'Marksman', health: 90, range: 88, rpm: 44, damage: 55,
    accuracy: 0.42, speed: 2.5, score: 200, cash: 120, weight: 1.5, radius: 0.32, height: 1.79,
  },
  lmg: {
    id: 'lmg', name: 'Gunner', health: 160, range: 44, rpm: 700, damage: 12,
    accuracy: 0.15, speed: 2.6, score: 180, cash: 110, weight: 1.5, radius: 0.38, height: 1.82,
  },
  juggernaut: {
    id: 'juggernaut', name: 'Juggernaut', health: 900, range: 26, rpm: 560, damage: 16,
    accuracy: 0.22, speed: 2.1, score: 750, cash: 450, weight: 4, radius: 0.55, height: 1.95,
  },
};

export const ARCHETYPE_ORDER: readonly Archetype[] = [
  'rifleman', 'smg', 'shotgun', 'sniper', 'lmg', 'juggernaut',
];

/** Threat level at which each archetype starts appearing, and how fast it ramps. */
interface Ramp { start: number; gain: number; cap: number; }

const RAMPS: Record<Archetype, Ramp> = {
  rifleman: { start: 0.00, gain: 1.0, cap: 1.0 },
  smg: { start: 0.08, gain: 1.6, cap: 0.95 },
  shotgun: { start: 0.20, gain: 1.5, cap: 0.75 },
  sniper: { start: 0.34, gain: 1.2, cap: 0.55 },
  lmg: { start: 0.48, gain: 1.3, cap: 0.60 },
  juggernaut: { start: 0.72, gain: 1.1, cap: 0.30 },
};

/** Hard concurrency caps — two juggernauts is a boss fight, four is a wall. */
export const CONCURRENCY_CAP: Partial<Record<Archetype, number>> = {
  juggernaut: 2,
  sniper: 3,
  lmg: 4,
};

export interface ThreatContext {
  /** 0..1 overall escalation. */
  threat: number;
  /** Live count per archetype, so caps can be honoured. */
  live: Readonly<Record<Archetype, number>>;
  /** Multiplier applied to the juggernaut/sniper weights by the mode. */
  eliteBias: number;
}

/**
 * Weighted pick honouring the ramp curve and concurrency caps. Deterministic
 * for a given `rng` stream.
 */
export function pickArchetype(ctx: ThreatContext, rng: Rand): Archetype {
  const weights: number[] = [];
  let total = 0;
  for (const id of ARCHETYPE_ORDER) {
    const r = RAMPS[id];
    let w = 0;
    if (ctx.threat >= r.start) {
      w = Math.min(r.cap, (ctx.threat - r.start) * r.gain + (id === 'rifleman' ? 1 : 0.05));
    }
    if (id === 'rifleman') w = Math.max(0.35, 1.15 - ctx.threat * 0.75); // never fully vanishes
    if (id === 'juggernaut' || id === 'sniper') w *= ctx.eliteBias;
    const cap = CONCURRENCY_CAP[id];
    if (cap !== undefined && (ctx.live[id] ?? 0) >= cap) w = 0;
    weights.push(w);
    total += w;
  }
  if (total <= 0) return 'rifleman';
  let r = rng.next() * total;
  for (let i = 0; i < ARCHETYPE_ORDER.length; i++) {
    r -= weights[i];
    if (r <= 0) return ARCHETYPE_ORDER[i];
  }
  return 'rifleman';
}

export function emptyLiveCounts(): Record<Archetype, number> {
  return { rifleman: 0, smg: 0, shotgun: 0, sniper: 0, lmg: 0, juggernaut: 0 };
}

/** Health/accuracy scaling applied on top of the base profile as a match runs. */
export function difficultyScalars(threat: number, waveIndex: number): { health: number; accuracy: number; aggression: number } {
  return {
    health: 1 + threat * 0.55 + waveIndex * 0.035,
    accuracy: 0.72 + threat * 0.5,
    aggression: 0.35 + threat * 0.6,
  };
}
