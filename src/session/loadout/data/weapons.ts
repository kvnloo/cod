/**
 * Weapon meta the loadout layer owns: unlock rank and the one-line role the
 * armoury prints under the name.
 *
 * The *stats* stay where they belong — `src/weapons/Catalog.ts` — and this
 * table is keyed by the ids in it. `assertWeaponMetaCoverage()` fails loudly if
 * the catalogue grows a weapon nobody gave a rank to, so a new gun cannot
 * silently ship as either locked forever or free at rank 1.
 */

import { WEAPONS } from '../../../weapons/Catalog';

export interface WeaponMeta {
  /** Rank the weapon unlocks at. 0 = starting weapon. */
  minRank: number;
  /** Short role line for the armoury. */
  role: string;
}

export const WEAPON_META: Record<string, WeaponMeta> = {
  ar_vkr7: { minRank: 0, role: 'Balanced 5.56 platform. The measuring stick.' },
  pi_sidewinder: { minRank: 0, role: 'Fast-handling sidearm. Never the wrong answer up close.' },
  smg_hornet: { minRank: 2, role: 'Highest cyclic rate in the armoury. Owns the first ten metres.' },
  sg_breaker: { minRank: 5, role: 'Pump twelve-gauge. One-shot inside seven metres.' },
  dmr_kestrel: { minRank: 9, role: 'Semi-auto marksman rifle. Two-shot to sixty metres.' },
  lmg_vulcan: { minRank: 14, role: 'Belt-fed suppression. A hundred rounds of area denial.' },
  sr_longbow: { minRank: 20, role: 'Bolt-action .338. Upper-chest one-shot at any range.' },
  lch_ravager: { minRank: 30, role: 'Single-shot launcher. Anti-vehicle, anti-killstreak.' },
};

const DEFAULT_META: WeaponMeta = { minRank: 0, role: '' };

export function weaponMeta(id: string): WeaponMeta {
  return WEAPON_META[id] ?? DEFAULT_META;
}

export function weaponMinRank(id: string): number {
  return weaponMeta(id).minRank;
}

/** Catalogue ids with no meta entry. Empty is the only acceptable answer. */
export function assertWeaponMetaCoverage(): string[] {
  return WEAPONS.filter((w) => !WEAPON_META[w.id]).map((w) => w.id);
}
