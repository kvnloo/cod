/**
 * Preset classes — the builds a player starts with and the ones the armoury
 * offers as "recommended".
 *
 * They deliberately span the unlock curve. `LoadoutBook` repairs each preset
 * against the player's actual rank when it loads them, so a rank-1 player gets
 * the same five classes with the locked pieces swapped for legal ones rather
 * than five copies of the starter rifle.
 */

import type { Loadout } from '../types';

function cls(
  id: string,
  name: string,
  primary: [string, string[]],
  secondary: [string, string[]],
  lethal: string,
  tactical: string,
  perks: [string, string, string],
  fieldUpgrade: string,
  killstreaks: string[],
): Loadout {
  return {
    version: 1, id, name,
    primary: { weaponId: primary[0], attachments: primary[1] },
    secondary: { weaponId: secondary[0], attachments: secondary[1] },
    lethal, tactical, perks, fieldUpgrade, killstreaks,
  };
}

export const PRESET_CLASSES: readonly Loadout[] = [
  cls(
    'preset-rifleman', 'RIFLEMAN',
    ['ar_vkr7', ['optic_reddot', 'muzzle_flash', 'under_grip', 'mag_extended', 'stock_heavy']],
    ['pi_sidewinder', ['laser_visible']],
    'eq_frag', 'eq_flash',
    ['perk_double_time', 'perk_sleight', 'perk_marksman'],
    'fu_deadsilence',
    ['uav', 'carepackage', 'airstrike'],
  ),
  cls(
    'preset-assaulter', 'ASSAULTER',
    ['smg_hornet', ['optic_holo', 'barrel_short', 'laser_visible', 'mag_quick', 'stock_none']],
    ['pi_sidewinder', []],
    'eq_semtex', 'eq_stun',
    ['perk_double_time', 'perk_stalker', 'perk_lightweight'],
    'fu_deadsilence',
    ['uav', 'counteruav', 'carepackage'],
  ),
  cls(
    'preset-marksman', 'MARKSMAN',
    ['dmr_kestrel', ['optic_acog', 'barrel_long', 'muzzle_suppressor', 'under_bipod', 'stock_heavy']],
    ['pi_sidewinder', ['mag_quick']],
    'eq_claymore', 'eq_smoke',
    ['perk_scavenger', 'perk_ghost', 'perk_marksman'],
    'fu_trophy',
    ['uav', 'airstrike', 'sentry'],
  ),
  cls(
    'preset-breacher', 'BREACHER',
    ['sg_breaker', ['optic_reddot', 'barrel_short', 'laser_visible', 'stock_none']],
    ['pi_sidewinder', ['laser_visible']],
    'eq_thermite', 'eq_flash',
    ['perk_double_time', 'perk_stalker', 'perk_fasthands'],
    'fu_cover',
    ['uav', 'carepackage', 'sentry'],
  ),
  cls(
    'preset-gunner', 'GUNNER',
    ['lmg_vulcan', ['optic_acog', 'muzzle_brake', 'under_bipod', 'mag_drum', 'barrel_heavy']],
    ['pi_sidewinder', []],
    'eq_frag', 'eq_decoy',
    ['perk_bandolier', 'perk_hardline', 'perk_marksman'],
    'fu_munitions',
    ['uav', 'counteruav', 'sentry'],
  ),
];
