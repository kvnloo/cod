/**
 * Weapon progression tracks.
 *
 * Ids here are the *real* ones from `src/weapons/Catalog.ts` and
 * `src/weapons/Attachments.ts`. They are written as plain strings rather than
 * imported so this module stays free of the weapon system's runtime graph (and
 * so it keeps compiling while that module is being reworked by another team).
 * `tools/session-prog.mjs` cross-checks every id against the live catalogue, so
 * a drift is caught by the verifier rather than at runtime.
 *
 * The rank gate decides *whether you may equip the weapon at all*; the weapon
 * level decides *what you may bolt onto it*. Both are queried through
 * `Progression.canEquip` / `Progression.canAttach`.
 */

import { WEAPON_MAX_LEVEL } from './Curves';
import type { WeaponClassId, WeaponTrackDef, WeaponUnlockDef } from './types';

interface WeaponSeed {
  id: string;
  name: string;
  cls: WeaponClassId;
  rank: number;
  /** Metres past which a kill counts as a longshot for this weapon. */
  longshot: number;
}

/** Eight weapons, one per class — matches `WEAPONS` in the catalogue. */
const WEAPON_SEEDS: readonly WeaponSeed[] = [
  { id: 'ar_vkr7', name: 'VKR-7', cls: 'assault', rank: 1, longshot: 48 },
  { id: 'pi_sidewinder', name: 'Sidewinder .45', cls: 'pistol', rank: 1, longshot: 26 },
  { id: 'smg_hornet', name: 'Hornet MP', cls: 'smg', rank: 3, longshot: 28 },
  { id: 'sg_breaker', name: 'Breaker 12', cls: 'shotgun', rank: 7, longshot: 16 },
  { id: 'dmr_kestrel', name: 'Kestrel MK14', cls: 'marksman', rank: 12, longshot: 68 },
  { id: 'lmg_vulcan', name: 'Vulcan-9', cls: 'lmg', rank: 18, longshot: 55 },
  { id: 'sr_longbow', name: 'Longbow M700', cls: 'sniper', rank: 24, longshot: 85 },
  { id: 'lch_ravager', name: 'Ravager RPG', cls: 'launcher', rank: 32, longshot: 60 },
];

interface ScheduleEntry {
  level: number;
  id: string;
  name: string;
  slot: string;
  classes: readonly WeaponClassId[] | 'all';
}

/**
 * The attachment unlock ladder, shared by every weapon and filtered by class
 * legality — the same `classes` restrictions the attachment definitions carry.
 * A weapon that cannot mount an entry simply skips that level, so a shotgun's
 * ladder is shorter and therefore denser in the levels it does have.
 */
const SCHEDULE: readonly ScheduleEntry[] = [
  { level: 2, id: 'optic_reddot', name: 'RD-2 Reflex', slot: 'optic', classes: 'all' },
  { level: 4, id: 'mag_extended', name: 'Extended Mag', slot: 'magazine', classes: 'all' },
  { level: 6, id: 'under_grip', name: 'Vertical Grip', slot: 'underbarrel', classes: 'all' },
  { level: 8, id: 'muzzle_flash', name: 'Flash Hider', slot: 'muzzle', classes: 'all' },
  { level: 10, id: 'stock_light', name: 'Skeleton Stock', slot: 'stock', classes: 'all' },
  { level: 12, id: 'optic_holo', name: 'HS-1 Holographic', slot: 'optic', classes: 'all' },
  { level: 13, id: 'under_bipod', name: 'Folding Bipod', slot: 'underbarrel', classes: ['lmg', 'sniper', 'marksman'] },
  { level: 14, id: 'laser_visible', name: 'Tactical Laser', slot: 'laser', classes: 'all' },
  { level: 16, id: 'muzzle_comp', name: 'Compensator', slot: 'muzzle', classes: 'all' },
  { level: 18, id: 'under_angled', name: 'Angled Grip', slot: 'underbarrel', classes: 'all' },
  { level: 19, id: 'stock_none', name: 'No Stock', slot: 'stock', classes: ['smg', 'assault', 'shotgun'] },
  { level: 20, id: 'mag_quick', name: 'Quickdraw Mag', slot: 'magazine', classes: 'all' },
  { level: 22, id: 'stock_heavy', name: 'Precision Stock', slot: 'stock', classes: 'all' },
  { level: 24, id: 'optic_acog', name: 'TA-4 Combat Scope', slot: 'optic', classes: ['assault', 'marksman', 'lmg', 'sniper'] },
  { level: 25, id: 'muzzle_brake', name: 'Muzzle Brake', slot: 'muzzle', classes: ['sniper', 'marksman', 'lmg', 'shotgun'] },
  { level: 26, id: 'mag_drum', name: 'Drum Mag', slot: 'magazine', classes: ['assault', 'smg', 'lmg'] },
  { level: 28, id: 'muzzle_suppressor', name: 'Suppressor', slot: 'muzzle', classes: 'all' },
  { level: 30, id: 'optic_sniper', name: 'LR-9 Variable Scope', slot: 'optic', classes: ['sniper', 'marksman'] },
];

/** Always available on every weapon, no level required. */
export const DEFAULT_ATTACHMENTS: readonly string[] = ['optic_irons'];

function unlocksFor(cls: WeaponClassId): WeaponUnlockDef[] {
  const out: WeaponUnlockDef[] = [];
  for (const e of SCHEDULE) {
    if (e.classes !== 'all' && !e.classes.includes(cls)) continue;
    out.push({ id: e.id, name: e.name, slot: e.slot, level: e.level });
  }
  return out;
}

export const WEAPON_TRACKS: readonly WeaponTrackDef[] = WEAPON_SEEDS.map((s) => ({
  id: s.id,
  name: s.name,
  cls: s.cls,
  rank: s.rank,
  maxLevel: WEAPON_MAX_LEVEL,
  longshot: s.longshot,
  unlocks: unlocksFor(s.cls),
}));

const BY_ID = new Map<string, WeaponTrackDef>(WEAPON_TRACKS.map((t) => [t.id, t]));

export function weaponTrack(id: string): WeaponTrackDef | null {
  return BY_ID.get(id) ?? null;
}

export function isTrackedWeapon(id: string): boolean { return BY_ID.has(id); }

export function weaponTracksOfClass(cls: WeaponClassId): WeaponTrackDef[] {
  return WEAPON_TRACKS.filter((t) => t.cls === cls);
}

/** Longshot threshold for a weapon; a sane default for anything untracked. */
export function longshotRange(weaponId: string): number {
  return BY_ID.get(weaponId)?.longshot ?? 50;
}

/** Attachments a weapon has earned at `level`, plus the always-on defaults. */
export function attachmentsAtLevel(weaponId: string, level: number): string[] {
  const t = BY_ID.get(weaponId);
  if (!t) return [...DEFAULT_ATTACHMENTS];
  const out = [...DEFAULT_ATTACHMENTS];
  for (const u of t.unlocks) if (u.level <= level) out.push(u.id);
  return out;
}

/** Attachments crossed by levelling from `before` to `after` (exclusive/inclusive). */
export function attachmentsBetween(weaponId: string, before: number, after: number): WeaponUnlockDef[] {
  const t = BY_ID.get(weaponId);
  if (!t || after <= before) return [];
  return t.unlocks.filter((u) => u.level > before && u.level <= after);
}

/* ------------------------------------------------------------ weapon XP -- */

/**
 * Weapon XP table. Deliberately smaller numbers than player XP so the two bars
 * never look interchangeable, and weighted so *using the weapon well* levels it
 * faster than farming kills with a killstreak.
 */
export const WXP = {
  kill: 55,
  headshotBonus: 30,
  longshotBonus: 25,
  pointblankBonus: 12,
  hipfireBonus: 10,
  assist: 14,
  /** Kills scored by a killstreak still credit the held weapon, but weakly. */
  killstreakKill: 12,
  multikillStep: 20,
  streakStep: 8,
  /** Per point of damage dealt, rounded at the end of the match. */
  damage: 0.12,
  /** Flat award for finishing a match with the weapon equipped. */
  matchComplete: 90,
  matchWinBonus: 60,
} as const;

/** Weapon XP for one kill, given the classification already computed. */
export function weaponXpForKill(k: {
  headshot: boolean; longshot: boolean; pointblank: boolean;
  hipfire: boolean; byKillstreak: boolean; streak: number;
}): number {
  if (k.byKillstreak) return WXP.killstreakKill;
  let xp = WXP.kill;
  if (k.headshot) xp += WXP.headshotBonus;
  if (k.longshot) xp += WXP.longshotBonus;
  if (k.pointblank) xp += WXP.pointblankBonus;
  if (k.hipfire) xp += WXP.hipfireBonus;
  if (k.streak >= 3) xp += WXP.streakStep * Math.min(6, Math.floor(k.streak / 3));
  return Math.round(xp);
}
