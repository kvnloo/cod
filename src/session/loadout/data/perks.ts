/**
 * Perk table — three rows, one pick per row.
 *
 * Perks differ from attachments in one important way: a perk's cost is the row
 * it occupies, not a stat penalty, so the no-free-lunch audit does not apply to
 * them. What *does* apply is anti-stacking: perks that move the same stat share
 * a `group`, and two perks from the same group can never be equipped together
 * even when they sit in different rows. That is what stops a 0.55× reload from
 * being assembled out of two "small" perks.
 */

import type { Modifier, PerkDef, PerkRow, StatKey } from '../types';
import type { TuningPatch } from './balance';

function m(stat: StatKey, value: number): Modifier {
  return { stat, mode: 'mul', value };
}

export const PERK_TABLE: readonly PerkDef[] = [
  /* ------------------------------------------------------------- row 1 -- */
  {
    id: 'perk_double_time', name: 'Double Time', row: 1, minRank: 0, group: 'sprint',
    mods: [m('moveScale', 1.05), m('sprintOut', 0.95)],
    description: 'Longer tactical sprint and a quicker recovery out of it.',
  },
  {
    id: 'perk_scavenger', name: 'Scavenger', row: 1, minRank: 4, group: 'ammo',
    mods: [m('reserveAmmo', 1.15)], flags: ['scavenger'],
    description: 'Resupply from fallen players. Start with a deeper reserve.',
  },
  {
    id: 'perk_bandolier', name: 'Bandolier', row: 1, minRank: 7, group: 'ammo',
    mods: [m('reserveAmmo', 1.5), m('moveScale', 0.99)],
    description: 'Half again the reserve ammunition, and the weight to go with it.',
  },
  {
    id: 'perk_overkill', name: 'Overkill', row: 1, minRank: 42,
    mods: [], flags: ['overkill'],
    description: 'Carry a second primary weapon instead of a sidearm.',
  },

  /* ------------------------------------------------------------- row 2 -- */
  {
    id: 'perk_ghost', name: 'Ghost', row: 2, minRank: 10,
    mods: [], flags: ['ghost'],
    description: 'Undetectable by UAVs and radar sweeps while moving.',
  },
  {
    id: 'perk_hardline', name: 'Hardline', row: 2, minRank: 18,
    mods: [], flags: ['hardline'],
    description: 'Killstreaks cost one kill less.',
  },
  {
    id: 'perk_sleight', name: 'Sleight of Hand', row: 2, minRank: 13, group: 'reload',
    mods: [m('reloadTime', 0.75)],
    description: 'Reload substantially faster.',
  },
  {
    id: 'perk_stalker', name: 'Stalker', row: 2, minRank: 28,
    mods: [m('adsMoveScale', 1.35)],
    description: 'Move much faster while aiming down sights.',
  },

  /* ------------------------------------------------------------- row 3 -- */
  {
    id: 'perk_marksman', name: 'Marksman', row: 3, minRank: 16,
    mods: [m('sway', 0.70), m('flinch', 0.65)],
    description: 'Steadier hold and far less flinch when taking fire.',
  },
  {
    id: 'perk_fasthands', name: 'Fast Hands', row: 3, minRank: 25, group: 'reload',
    mods: [m('reloadTime', 0.85), m('drawTime', 0.80), m('holsterTime', 0.75)],
    description: 'Swap weapons and reload noticeably faster.',
  },
  {
    id: 'perk_lightweight', name: 'Lightweight', row: 3, minRank: 30, group: 'sprint',
    mods: [m('moveScale', 1.06), m('sprintOut', 0.90)],
    description: 'Move faster on foot at the cost of nothing but the slot.',
  },
  {
    id: 'perk_tacmask', name: 'Tac Mask', row: 3, minRank: 55,
    mods: [], flags: ['tacMask'],
    description: 'Greatly reduced effect from flash and stun.',
  },
];

const BY_ID = new Map<string, PerkDef>(PERK_TABLE.map((p) => [p.id, p]));

export function perkDef(id: string): PerkDef | null {
  return BY_ID.get(id) ?? null;
}

export function perksInRow(row: PerkRow): PerkDef[] {
  return PERK_TABLE.filter((p) => p.row === row);
}

/** Ids that cannot be run alongside `id` because they share an exclusivity group. */
export function perkConflicts(id: string): string[] {
  const def = BY_ID.get(id);
  if (!def || !def.group) return [];
  return PERK_TABLE.filter((p) => p.id !== id && p.group === def.group).map((p) => p.id);
}

/** Applies the `perks` half of a tuning patch in place. */
export function applyPerkTuning(patch: TuningPatch): string[] {
  const notes: string[] = [];
  if (!patch.perks) return notes;
  for (const id of Object.keys(patch.perks)) {
    const def = BY_ID.get(id);
    const over = patch.perks[id];
    if (!def || !over) continue;
    const mods = def.mods as Modifier[];
    for (const stat of Object.keys(over) as StatKey[]) {
      const value = over[stat];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const existing = mods.find((x) => x.stat === stat && x.mode === 'mul');
      if (existing) existing.value = value;
      else mods.push(m(stat, value));
      notes.push(`perk ${id}.${stat} = ${value}`);
    }
  }
  return notes;
}
