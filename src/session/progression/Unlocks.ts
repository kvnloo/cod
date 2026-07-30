/**
 * Unlock gating — the single place the loadout/armoury UI should ask
 * "may the player use this?".
 *
 * Three independent gates stack:
 *
 *   1. **Rank** gates weapons, perks and killstreaks (`UNLOCKS`).
 *   2. **Weapon level** gates attachments (`WEAPON_TRACKS`), per weapon.
 *   3. **Extra unlocks** are anything granted outside the curve — care-package
 *      rewards, challenge rewards, purchases in Operation.
 *
 * `UNLOCKS` keeps its historical ids (`ar_vector`, `atc_reflex`, …) because the
 * menu mock-ups and the Operation buy menu already reference them. The *real*
 * catalogue ids from `src/weapons/` are gated by `WEAPON_TRACKS[].rank`, and
 * `LEGACY_ALIAS` bridges the two so a query with either id answers correctly.
 */

import { attachmentsAtLevel, weaponTrack, WEAPON_TRACKS } from './WeaponTracks';
import type { UnlockDef } from '../../game/types';

/**
 * Rank unlock table. Weapons gate on rank; attachments gate on rank and are
 * scoped to a parent weapon so the armoury UI can group them.
 */
export const UNLOCKS: readonly UnlockDef[] = [
  { id: 'ar_vector', name: 'VKR-7 Assault Rifle', kind: 'weapon', rank: 1 },
  { id: 'smg_wasp', name: 'WASP-9 SMG', kind: 'weapon', rank: 2 },
  { id: 'atc_reflex', name: 'Reflex Sight', kind: 'attachment', rank: 3, parent: 'ar_vector' },
  { id: 'perk_scavenger', name: 'Scavenger', kind: 'perk', rank: 4 },
  { id: 'sg_breach', name: 'BR-12 Breacher', kind: 'weapon', rank: 5 },
  { id: 'atc_foregrip', name: 'Vertical Foregrip', kind: 'attachment', rank: 6, parent: 'ar_vector' },
  { id: 'ks_uav', name: 'UAV Recon', kind: 'killstreak', rank: 6 },
  { id: 'atc_suppressor', name: 'Suppressor', kind: 'attachment', rank: 8, parent: 'smg_wasp' },
  { id: 'dmr_lynx', name: 'LYNX DMR', kind: 'weapon', rank: 9 },
  { id: 'perk_ghost', name: 'Ghost', kind: 'perk', rank: 10 },
  { id: 'ks_carepackage', name: 'Care Package', kind: 'killstreak', rank: 11 },
  { id: 'atc_holo', name: 'Holographic Sight', kind: 'attachment', rank: 12, parent: 'smg_wasp' },
  { id: 'lmg_bison', name: 'BISON LMG', kind: 'weapon', rank: 14 },
  { id: 'atc_extmag', name: 'Extended Mag', kind: 'attachment', rank: 15, parent: 'ar_vector' },
  { id: 'ks_counteruav', name: 'Counter-UAV', kind: 'killstreak', rank: 16 },
  { id: 'perk_hardline', name: 'Hardline', kind: 'perk', rank: 18 },
  { id: 'sr_kestrel', name: 'KESTREL Sniper', kind: 'weapon', rank: 20 },
  { id: 'atc_thermal', name: 'Thermal Scope', kind: 'attachment', rank: 22, parent: 'sr_kestrel' },
  { id: 'ks_airstrike', name: 'Precision Airstrike', kind: 'killstreak', rank: 24 },
  { id: 'atc_compensator', name: 'Compensator', kind: 'attachment', rank: 26, parent: 'lmg_bison' },
  { id: 'perk_stalker', name: 'Stalker', kind: 'perk', rank: 28 },
  { id: 'smg_viper', name: 'VIPER-45 SMG', kind: 'weapon', rank: 30 },
  { id: 'ks_sentry', name: 'Sentry Turret', kind: 'killstreak', rank: 32 },
  { id: 'atc_laser', name: 'Tactical Laser', kind: 'attachment', rank: 34, parent: 'smg_viper' },
  { id: 'ar_talon', name: 'TALON-6 Assault Rifle', kind: 'weapon', rank: 38 },
  { id: 'perk_overkill', name: 'Overkill', kind: 'perk', rank: 42 },
  { id: 'atc_heavybarrel', name: 'Heavy Barrel', kind: 'attachment', rank: 46, parent: 'ar_talon' },
  { id: 'sr_apex', name: 'APEX .50 Anti-Materiel', kind: 'weapon', rank: 50 },
  { id: 'perk_tacmask', name: 'Tac Mask', kind: 'perk', rank: 55 },
];

const BY_ID = new Map<string, UnlockDef>(UNLOCKS.map((u) => [u.id, u]));

/** Menu id ⇄ catalogue id. Either side answers the same gate. */
export const LEGACY_ALIAS: Readonly<Record<string, string>> = {
  ar_vector: 'ar_vkr7',
  smg_wasp: 'smg_hornet',
  sg_breach: 'sg_breaker',
  dmr_lynx: 'dmr_kestrel',
  lmg_bison: 'lmg_vulcan',
  sr_kestrel: 'sr_longbow',
};

const REVERSE_ALIAS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const k of Object.keys(LEGACY_ALIAS)) out[LEGACY_ALIAS[k]] = k;
  return out;
})();

export function unlockDef(id: string): UnlockDef | null { return BY_ID.get(id) ?? null; }

export function unlocksForRank(rank: number): UnlockDef[] {
  return UNLOCKS.filter((u) => u.rank === rank);
}

export function unlockedAt(rank: number): UnlockDef[] {
  return UNLOCKS.filter((u) => u.rank <= rank);
}

/** Rank required to equip a catalogue weapon, or 1 when it is not tracked. */
export function weaponRankGate(weaponId: string): number {
  const t = weaponTrack(weaponId);
  if (t) return t.rank;
  const alias = LEGACY_ALIAS[weaponId];
  if (alias) return weaponTrack(alias)?.rank ?? 1;
  return BY_ID.get(weaponId)?.rank ?? 1;
}

export interface UnlockQuery {
  rank: number;
  /** Weapon id → weapon level. */
  weaponLevel(weaponId: string): number;
  extraUnlocks: readonly string[];
}

/** True when the player may equip this weapon right now. */
export function canEquipWeapon(q: UnlockQuery, weaponId: string): boolean {
  if (q.extraUnlocks.includes(weaponId)) return true;
  const legacy = REVERSE_ALIAS[weaponId];
  if (legacy && q.extraUnlocks.includes(legacy)) return true;
  return q.rank >= weaponRankGate(weaponId);
}

/** True when `attachmentId` is available on `weaponId`. */
export function canAttach(q: UnlockQuery, weaponId: string, attachmentId: string): boolean {
  if (q.extraUnlocks.includes(attachmentId)) return true;
  if (q.extraUnlocks.includes(`${weaponId}:${attachmentId}`)) return true;
  const level = q.weaponLevel(weaponId);
  if (attachmentsAtLevel(weaponId, level).includes(attachmentId)) return true;
  // Legacy menu attachments still gate on rank via `UNLOCKS`.
  const def = BY_ID.get(attachmentId);
  return !!def && def.rank <= q.rank;
}

/** Everything usable on a weapon right now — the armoury's slot list. */
export function availableAttachments(q: UnlockQuery, weaponId: string): string[] {
  const out = new Set(attachmentsAtLevel(weaponId, q.weaponLevel(weaponId)));
  for (const id of q.extraUnlocks) {
    if (id.startsWith(`${weaponId}:`)) out.add(id.slice(weaponId.length + 1));
    else if (BY_ID.get(id)?.kind === 'attachment') out.add(id);
  }
  return [...out];
}

/** Weapons the player owns, in catalogue order. */
export function unlockedWeapons(q: UnlockQuery): string[] {
  return WEAPON_TRACKS.filter((t) => canEquipWeapon(q, t.id)).map((t) => t.id);
}

/** The next thing the player is working toward — good for a "next unlock" strip. */
export function nextRankUnlock(rank: number): UnlockDef | null {
  let best: UnlockDef | null = null;
  for (const u of UNLOCKS) {
    if (u.rank <= rank) continue;
    if (!best || u.rank < best.rank) best = u;
  }
  return best;
}
