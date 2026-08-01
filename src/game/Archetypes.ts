/**
 * Enemy archetype table and the escalation curve that decides which of them the
 * director is allowed to field.
 *
 * The pressure curve of a wave shooter comes almost entirely from *composition*,
 * not from raw counts: a rifleman is a target, a shotgunner is a timer, a sniper
 * is a positional constraint, and a juggernaut is a problem the player has to
 * solve with resources. `pickArchetype` is where that escalation is expressed.
 *
 * ## The two numbers that matter
 *
 * Every profile below carries both halves of a firefight:
 *
 *  - **`health` + `armor`** decide how long the *player's* gun takes. Health
 *    here is the denominator of the whole TTK table in `Combat.ts`: a rifleman
 *    is 200 HP, roughly double a Call of Duty body, which is what buys the
 *    doubled time-to-kill the brief asks for now that Apex movement carries the
 *    skill expression. Armour is per-zone, so it slows body shots without ever
 *    making a headshot pointless.
 *  - **`damage` × `rpm` × `accuracy`, checked against `dps`** decide how long
 *    *the enemy* takes. `dps` is the authored target — damage per second one of
 *    these should land on a stationary, unarmoured 100 HP player at its
 *    preferred range — and `assertLethality()` proves the other three
 *    reproduce it. That is the direct answer to "after getting downed i would
 *    just get shot at for 60s without dying": lethality is now a number this
 *    file decides, not something that emerges from a coin flip.
 */

import type { Rand } from '../core/Rand';
import { combat } from './Combat';
import type { Archetype, ArchetypeProfile, ZoneTable } from './types';

/* --------------------------------------------------------------- armour -- */

/** Bare flesh. The reference body every published TTK figure is quoted against. */
const NO_ARMOR: ZoneTable = {
  head: 1, neck: 1, chest: 1, stomach: 1, arm: 1, leg: 1, none: 1,
};

/** A plate carrier: front and back plates, nothing over the limbs or the head. */
const PLATE_CARRIER: ZoneTable = {
  head: 1, neck: 1, chest: 0.88, stomach: 0.94, arm: 1, leg: 1, none: 1,
};

const BREACHER_ARMOR: ZoneTable = {
  head: 1, neck: 1, chest: 0.85, stomach: 0.92, arm: 0.96, leg: 1, none: 1,
};

/**
 * A juggernaut suit. Heavy everywhere and heaviest over the chest, but the
 * visor is only 0.85 — so the answer to a juggernaut is aim, not ammunition.
 * A VKR-7 needs 47 chest rounds and 15 headshots to bring one down.
 */
const JUGGERNAUT_SUIT: ZoneTable = {
  head: 0.85, neck: 0.60, chest: 0.50, stomach: 0.55, arm: 0.62, leg: 0.66, none: 0.55,
};

/* ------------------------------------------------------------- the table -- */

export const ARCHETYPES: Record<Archetype, ArchetypeProfile> = {
  rifleman: {
    id: 'rifleman', name: 'Rifleman', health: 200, range: 34, rpm: 640, damage: 14,
    accuracy: 0.28, speed: 3.4, score: 100, cash: 60, weight: 1, radius: 0.34, height: 1.78,
    armor: NO_ARMOR, dps: 22.95, reactionMs: 380, burstMin: 3, burstMax: 6,
  },
  smg: {
    id: 'smg', name: 'Assaulter', health: 165, range: 20, rpm: 840, damage: 10,
    accuracy: 0.26, speed: 4.6, score: 110, cash: 65, weight: 1, radius: 0.33, height: 1.76,
    armor: NO_ARMOR, dps: 21.63, reactionMs: 300, burstMin: 5, burstMax: 9,
  },
  shotgun: {
    id: 'shotgun', name: 'Breacher', health: 250, range: 11, rpm: 90, damage: 46,
    accuracy: 0.36, speed: 4.9, score: 150, cash: 90, weight: 1.35, radius: 0.36, height: 1.8,
    armor: BREACHER_ARMOR, dps: 16.54, reactionMs: 340, burstMin: 1, burstMax: 1,
  },
  sniper: {
    id: 'sniper', name: 'Marksman', health: 175, range: 88, rpm: 44, damage: 58,
    accuracy: 0.48, speed: 2.5, score: 200, cash: 120, weight: 1.5, radius: 0.32, height: 1.79,
    armor: NO_ARMOR, dps: 16.46, reactionMs: 620, burstMin: 1, burstMax: 1,
  },
  lmg: {
    id: 'lmg', name: 'Gunner', health: 300, range: 44, rpm: 700, damage: 12,
    accuracy: 0.23, speed: 2.6, score: 180, cash: 110, weight: 1.5, radius: 0.38, height: 1.82,
    armor: PLATE_CARRIER, dps: 21.83, reactionMs: 460, burstMin: 8, burstMax: 16,
  },
  juggernaut: {
    id: 'juggernaut', name: 'Juggernaut', health: 750, range: 26, rpm: 560, damage: 17,
    accuracy: 0.26, speed: 2.1, score: 750, cash: 450, weight: 4, radius: 0.55, height: 1.95,
    armor: JUGGERNAUT_SUIT, dps: 30.03, reactionMs: 520, burstMin: 10, burstMax: 20,
  },
};

/*
 * Publish the table into the combat model. This import is also the reason
 * `Combat.ts` reaches the bundle at all: every other reference to it in the
 * program is `import type`, and those are erased at build time.
 */
combat.registerProfiles(ARCHETYPES, () => assertLethality());

export const ARCHETYPE_ORDER: readonly Archetype[] = [
  'rifleman', 'smg', 'shotgun', 'sniper', 'lmg', 'juggernaut',
];

/* ----------------------------------------------------------- lethality -- */

/**
 * The engagement cadence the `dps` column is calibrated against.
 *
 * One cycle is `burst` rounds at the archetype's rate of fire, then a pause.
 * Sustained rounds per second is `burst / (burst / roundsPerSecond + pause)`.
 *
 * This is deliberately written as *authored intent* rather than as a model of
 * any particular actor backend. Two of them exist in this build — the AI
 * tactical stack and the fallback sim — and they arrive at a hit rate by
 * completely different means (a converging aim cone versus a probability
 * roll). What they must agree on is the outcome: the damage per second a
 * player standing in the open actually feels. That number is the design
 * decision, and it lives here.
 */
export const FIRE_CADENCE = {
  /** Mean seconds between bursts at nominal aggression. */
  meanBurstPause: 1.075,
  /** `pause` is divided by this at aggression 1, multiplied at aggression 0. */
  aggressionPauseScale: 0.84,
} as const;

/**
 * Fraction of its rounds each archetype is expected to land on a stationary
 * player at its preferred range, once its aim has settled.
 *
 * This is the skill dial, and it is where difficulty belongs — not in health.
 * A marksman lands three quarters of what he fires because he takes one shot
 * every two and a half seconds to do it; a gunner lands a third because he is
 * suppressing, and his damage per second comes from volume instead.
 */
export const HIT_FRACTION: Record<Archetype, number> = {
  rifleman: 0.62,
  smg: 0.55,
  shotgun: 0.70,
  sniper: 0.75,
  lmg: 0.35,
  juggernaut: 0.34,
};

/** Sustained rounds per second across a burst-and-pause cycle. */
export function sustainedRps(id: Archetype): number {
  const p = ARCHETYPES[id];
  const burst = (p.burstMin + p.burstMax) / 2;
  const rps = p.rpm / 60;
  const pause = FIRE_CADENCE.meanBurstPause / FIRE_CADENCE.aggressionPauseScale;
  return burst / (burst / rps + pause);
}

/**
 * Expected damage per second at the preferred range, from cadence × hit
 * fraction × damage. This is the identity the `dps` column records, and
 * `assertLethality` is the proof that the two agree.
 */
export function lethality(id: Archetype): number {
  return sustainedRps(id) * HIT_FRACTION[id] * ARCHETYPES[id].damage;
}

/** Seconds for `count` of these to remove `health` from a player, at range. */
export function timeToDieSec(id: Archetype, count: number, health = 100): number {
  const dps = lethality(id) * Math.max(1, count);
  return dps <= 0 ? Infinity : health / dps;
}

/**
 * Proves every profile's `damage`, `rpm` and burst cadence reproduce its
 * authored `dps`. Returns the rows that drifted more than `tolerance`; an
 * empty array is a pass. Cheap, and called by the verification probe rather
 * than by anything in the hot path.
 */
export function assertLethality(tolerance = 0.03): Array<{ id: Archetype; want: number; got: number }> {
  const bad: Array<{ id: Archetype; want: number; got: number }> = [];
  for (const id of ARCHETYPE_ORDER) {
    const got = lethality(id);
    const want = ARCHETYPES[id].dps;
    if (Math.abs(got - want) / Math.max(1e-3, want) > tolerance) {
      bad.push({ id, want, got: +got.toFixed(3) });
    }
  }
  return bad;
}

/* ------------------------------------------------------------ escalation -- */

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

/**
 * Health/accuracy scaling applied on top of the base profile as a match runs.
 *
 * Health scaling is now almost flat — 1.00 to about 1.16 across a whole match.
 * That is a deliberate reversal: the old curve reached 1.9×, which meant the
 * authored TTK table was only true on wave one and every later wave silently
 * turned into a bullet-sponge fight. Call of Duty has never scaled enemy
 * health, and for the same reason: a shooter's difficulty has to come from
 * *pressure* — more bodies, better angles, tighter aim — because that is what
 * the player can answer with skill. So the escalation is pushed into accuracy
 * and aggression, and health is left alone.
 */
export function difficultyScalars(threat: number, waveIndex: number): { health: number; accuracy: number; aggression: number } {
  return {
    health: 1 + threat * 0.10 + waveIndex * 0.006,
    accuracy: 0.85 + threat * 0.35,
    aggression: 0.40 + threat * 0.55,
  };
}
