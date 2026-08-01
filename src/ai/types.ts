/**
 * AI module contracts.
 *
 * Everything in here is data: difficulty curves, weapon archetypes, the shapes
 * the rest of the game uses to talk to the AI. Behaviour lives elsewhere.
 *
 * Two deliberate choices:
 *
 *  - Difficulty scales *reaction time and aim error*, never health. A veteran
 *    enemy dies to the same two bullets as a recruit; he simply finds you faster
 *    and stops missing sooner. Health-scaling difficulty is the single most
 *    reliable way to make a shooter feel bad.
 *  - Everything the AI needs from other modules is described structurally
 *    (`TargetLike`, `NavLike`, `CharacterLike`) so this module compiles and runs
 *    against modules that do not exist yet.
 */

import type * as THREE from 'three';
import type { CharacterLoadout } from '../characters/types';

/* ------------------------------------------------------------- difficulty -- */

export type Difficulty = 'recruit' | 'regular' | 'hardened' | 'veteran';

export interface DifficultyProfile {
  /** Seconds between acquiring a target and the first shot leaving the barrel. */
  reactionTime: number;
  /** ± jitter on the reaction, so a squad never fires as one machine. */
  reactionJitter: number;
  /** Angular aim error at the moment of acquisition, radians. */
  aimErrorStart: number;
  /** Time constant of the exponential convergence of that error, seconds. */
  aimConverge: number;
  /** Floor the error converges to — never zero, or they are inhumanly perfect. */
  aimErrorFloor: number;
  /** Shots at the start of an engagement that are aimed deliberately wide. */
  missFirstShots: number;
  /** Multiplier on outgoing damage. */
  damageScale: number;
  /** 0..1 — how readily they leave cover and push. */
  aggression: number;
  /** 0..1 — resistance to suppression. */
  nerve: number;
  /** 0..1 — probability of taking a grenade opportunity when one appears. */
  grenadeChance: number;
  /** Scales the pause between bursts. Lower = more sustained pressure. */
  burstGapScale: number;
  /** Extra multiplier on how fast awareness fills. */
  perceptionScale: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  recruit: {
    reactionTime: 0.85, reactionJitter: 0.30, aimErrorStart: 0.115, aimConverge: 2.6,
    aimErrorFloor: 0.030, missFirstShots: 4, damageScale: 0.62, aggression: 0.35,
    nerve: 0.35, grenadeChance: 0.10, burstGapScale: 1.45, perceptionScale: 0.72,
  },
  regular: {
    reactionTime: 0.58, reactionJitter: 0.22, aimErrorStart: 0.085, aimConverge: 1.7,
    aimErrorFloor: 0.019, missFirstShots: 3, damageScale: 0.85, aggression: 0.55,
    nerve: 0.55, grenadeChance: 0.22, burstGapScale: 1.15, perceptionScale: 1.0,
  },
  hardened: {
    reactionTime: 0.40, reactionJitter: 0.15, aimErrorStart: 0.062, aimConverge: 1.15,
    aimErrorFloor: 0.012, missFirstShots: 2, damageScale: 1.0, aggression: 0.72,
    nerve: 0.72, grenadeChance: 0.34, burstGapScale: 0.95, perceptionScale: 1.18,
  },
  veteran: {
    reactionTime: 0.27, reactionJitter: 0.09, aimErrorStart: 0.044, aimConverge: 0.75,
    aimErrorFloor: 0.0075, missFirstShots: 1, damageScale: 1.15, aggression: 0.88,
    nerve: 0.88, grenadeChance: 0.46, burstGapScale: 0.8, perceptionScale: 1.35,
  },
};

/* ----------------------------------------------------------------- weapons -- */

export interface AIWeaponSpec {
  id: string;
  rpm: number;
  magSize: number;
  /** Damage per bullet at ideal range, before difficulty scaling. */
  damage: number;
  /** Applied on head/neck hits (see CombatController.resolveShot). */
  headshotMult: number;
  /** Damage falls off linearly from `rangeIdeal` to `rangeMax`, down to 40%. */
  rangeIdeal: number;
  rangeMax: number;
  /** Inherent mechanical spread, radians (added to the aim error). */
  spread: number;
  burstMin: number;
  burstMax: number;
  /** Seconds between bursts, before difficulty scaling. */
  burstGapMin: number;
  burstGapMax: number;
  reloadTime: number;
  /** Pellets per trigger pull (shotguns). */
  pellets: number;
  /** Extra suppression this weapon inflicts on whoever it is shooting at. */
  suppressionPower: number;
}

const W = (
  id: string, rpm: number, magSize: number, damage: number, rangeIdeal: number,
  rangeMax: number, spread: number, burstMin: number, burstMax: number,
  burstGapMin: number, burstGapMax: number, reloadTime: number,
  pellets = 1, headshotMult = 2.2, suppressionPower = 1,
): AIWeaponSpec => ({
  id, rpm, magSize, damage, headshotMult, rangeIdeal, rangeMax, spread,
  burstMin, burstMax, burstGapMin, burstGapMax, reloadTime, pellets,
  suppressionPower,
});

export const AI_WEAPONS: Record<CharacterLoadout, AIWeaponSpec> = {
  rifleman: W('ai_ar', 640, 30, 17, 34, 90, 0.010, 3, 6, 0.42, 0.95, 2.4),
  smg: W('ai_smg', 820, 32, 12, 18, 48, 0.016, 4, 9, 0.30, 0.72, 2.1, 1, 1.9, 1.15),
  shotgun: W('ai_shotgun', 90, 6, 11, 9, 22, 0.045, 1, 2, 0.65, 1.25, 3.4, 8, 1.5, 0.9),
  sniper: W('ai_dmr', 60, 8, 46, 70, 180, 0.004, 1, 1, 1.35, 2.4, 3.0, 1, 2.6, 1.5),
  lmg: W('ai_lmg', 720, 100, 15, 42, 110, 0.014, 8, 16, 0.55, 1.1, 5.2, 1, 1.8, 1.8),
  juggernaut: W('ai_jug', 700, 60, 19, 28, 70, 0.013, 6, 12, 0.5, 0.9, 4.4, 1, 1.6, 1.6),
};

/* ------------------------------------------------------------------ target -- */

/**
 * What the AI needs to know about whatever it is fighting. The player system
 * satisfies this structurally; so does a static stand-in in the test bed.
 */
export interface TargetLike {
  readonly entityId: number;
  /** True when damage should be routed to the player via `damage:taken`. */
  readonly isPlayer: boolean;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly alive: boolean;
  /** Eye height above `position` (which is the capsule centre). */
  readonly eyeOffset: number;
  /** Capsule half-height and radius, for the hit solve. */
  readonly height: number;
  readonly radius: number;
  /** 0 = standing, 1 = fully crouched/prone. Shrinks the hittable volume. */
  readonly crouch: number;
  /** Set for one tick when the target fires — a huge perception cue. */
  readonly firedAt: number;
  /** Which way the target is looking; used for flank scoring. */
  readonly facing: THREE.Vector3;
}

/* -------------------------------------------------------------------- nav -- */

/**
 * Structural view of whatever navigation service the world module publishes.
 * Every method is optional: the adapter probes for what exists and falls back to
 * its own sampled grid for anything missing.
 */
export interface NavLike {
  findPath?(
    from: THREE.Vector3, to: THREE.Vector3, out?: THREE.Vector3[],
  ): number | THREE.Vector3[] | null;
  nearestPoly?(p: THREE.Vector3, out?: THREE.Vector3, maxDist?: number): unknown;
  /** Cover points near a position; shape is duck-typed on arrival. */
  coverNear?(
    p: THREE.Vector3, radius: number, out?: unknown[],
  ): number | unknown[] | null;
  /** Nav-mesh raycast — cheaper and more reliable than a physics linecast. */
  raycast?(from: THREE.Vector3, to: THREE.Vector3, out?: THREE.Vector3): unknown;
  /** Off-mesh links (vault / jump-down) the world author placed. */
  links?: ReadonlyArray<NavLinkLike>;
  readonly ready?: boolean;
}

export interface NavLinkLike {
  from: THREE.Vector3;
  to: THREE.Vector3;
  kind?: string;
  bidirectional?: boolean;
}

/** Cover point shape the world module is expected to publish. */
export interface WorldCoverLike {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  height?: 'low' | 'high';
}

/* --------------------------------------------------------------- callouts -- */

/** Canonical callout lines. Audio maps these to synthesised VO. */
export const VO = {
  contact: 'Contact!',
  reloading: 'Reloading!',
  coverMe: 'Cover me!',
  flankLeft: 'Flanking left!',
  flankRight: 'Flanking right!',
  grenade: 'Grenade!',
  fragOut: 'Frag out!',
  moving: 'Moving!',
  suppressing: 'Suppressing!',
  pushing: 'Push up!',
  manDown: 'Man down!',
  lostHim: 'Lost him!',
  searching: 'Spread out, find him!',
  behindCover: "He's behind cover!",
  fallingBack: 'Falling back!',
  hit: "I'm hit!",
  spotted: 'Over there!',
  reloaded: 'Back in!',
} as const;

export type VoiceLine = (typeof VO)[keyof typeof VO];

/* ------------------------------------------------------------------- misc -- */

export type SquadRole = 'anchor' | 'flanker' | 'suppressor' | 'support';
export type Stance = 'stand' | 'crouch' | 'prone';
export type AlertState = 'idle' | 'suspicious' | 'searching' | 'combat';

/** Numeric alert level published on the bus (`ai:alert`). */
export const ALERT_LEVEL: Record<AlertState, number> = {
  idle: 0, suspicious: 1, searching: 2, combat: 3,
};

export interface SoundStimulus {
  position: THREE.Vector3;
  /** Loudness in "metres it carries in the open". */
  loudness: number;
  kind: 'gunfire' | 'explosion' | 'footstep' | 'impact' | 'voice' | 'movement';
  /** True when the sound came from the AI's current enemy. */
  fromTarget: boolean;
  /** Entity that made it, or -1. */
  sourceId: number;
}

export interface AgentSpawnOptions {
  position: THREE.Vector3;
  yaw?: number;
  loadout?: CharacterLoadout;
  faction?: 'militia' | 'pmc' | 'spetsnaz';
  difficulty?: Difficulty;
  /** Squad to join; a new one is made when omitted. */
  squadId?: number;
  seed?: number;
  health?: number;
  name?: string;
  /** Patrol loop in world space. Two or more points make the agent walk it. */
  patrol?: THREE.Vector3[];
  /** Start already aware of the target. */
  alerted?: boolean;
  role?: SquadRole;
}
