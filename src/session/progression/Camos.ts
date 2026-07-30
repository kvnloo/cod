/**
 * Camouflage tracks.
 *
 * Camos are not a separate system — every camo is the *reward* of a challenge,
 * so the same engine that advances "250 headshots" advances "Urban". What lives
 * here is the definition of the ladder and the mastery rules that read other
 * camos rather than raw stats.
 *
 * Ladder shape (the one shipped shooters converged on):
 *   base ×7   → per-weapon stat grinds, unlocked in any order
 *   Gold      → every base camo on that weapon
 *   Platinum  → Gold on every weapon of that class
 *   Obsidian  → Platinum on every class
 */

import type { CamoDef, ChallengeStat, WeaponClassId } from './types';

export interface CamoTemplate extends CamoDef {
  /** Per-weapon stat and goal for base camos; ignored for mastery camos. */
  stat: ChallengeStat;
  goal: number;
  xp: number;
}

export const BASE_CAMOS: readonly CamoTemplate[] = [
  {
    id: 'woodland', name: 'Woodland', kind: 'base', tint: '#4a5a38',
    description: 'Get {goal} kills with this weapon.',
    stat: 'kills', goal: 25, xp: 500,
  },
  {
    id: 'urban', name: 'Urban', kind: 'base', tint: '#6b6f74',
    description: 'Get {goal} headshot kills with this weapon.',
    stat: 'headshots', goal: 20, xp: 750,
  },
  {
    id: 'desert', name: 'Desert', kind: 'base', tint: '#b5975c',
    description: 'Get {goal} kills with this weapon.',
    stat: 'kills', goal: 80, xp: 1000,
  },
  {
    id: 'arctic', name: 'Arctic', kind: 'base', tint: '#d5dde4',
    description: 'Get {goal} longshot kills with this weapon.',
    stat: 'longshots', goal: 15, xp: 1250,
  },
  {
    id: 'tiger', name: 'Tiger', kind: 'base', tint: '#c8802a',
    description: 'Get {goal} hipfire kills with this weapon.',
    stat: 'hipfireKills', goal: 30, xp: 1250,
  },
  {
    id: 'digital', name: 'Digital', kind: 'base', tint: '#2f4f63',
    description: 'Get {goal} kills while on a killstreak of 3 or more.',
    stat: 'killstreakKills', goal: 25, xp: 1500,
  },
  {
    id: 'crimson', name: 'Crimson', kind: 'base', tint: '#8c2230',
    description: 'Get {goal} multikills with this weapon.',
    stat: 'multikills', goal: 20, xp: 2000,
  },
];

export const MASTERY_CAMOS: readonly CamoDef[] = [
  {
    id: 'gold', name: 'Gold', kind: 'mastery', tint: '#d8b24a',
    description: 'Unlock every base camo for this weapon.',
  },
  {
    id: 'platinum', name: 'Platinum', kind: 'mastery', tint: '#cfd6e0',
    description: 'Unlock Gold on every weapon in this class.',
  },
  {
    id: 'obsidian', name: 'Obsidian', kind: 'mastery', tint: '#16181c',
    description: 'Unlock Platinum on every weapon class.',
  },
];

export const ALL_CAMOS: readonly CamoDef[] = [...BASE_CAMOS, ...MASTERY_CAMOS];

const CAMO_BY_ID = new Map<string, CamoDef>(ALL_CAMOS.map((c) => [c.id, c]));

export function camoDef(id: string): CamoDef | null { return CAMO_BY_ID.get(id) ?? null; }

export const BASE_CAMO_IDS: readonly string[] = BASE_CAMOS.map((c) => c.id);

/** XP for a mastery camo — these are the big, memorable ones. */
export const MASTERY_XP: Readonly<Record<string, number>> = {
  gold: 5000,
  platinum: 10000,
  obsidian: 25000,
};

/** Ordered camo list for a weapon's armoury page. */
export function camoLadder(): CamoDef[] { return [...BASE_CAMOS, ...MASTERY_CAMOS]; }

export interface MasteryView {
  weapon: string;
  cls: WeaponClassId;
  base: number;
  baseTotal: number;
  gold: boolean;
  platinum: boolean;
  obsidian: boolean;
}
