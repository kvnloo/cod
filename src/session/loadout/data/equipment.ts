/**
 * Lethal, tactical, field-upgrade and killstreak tables.
 *
 * Only three grenade kinds exist in `src/weapons/Grenades.ts` today (`frag`,
 * `flash`, `smoke`). Entries that need something the weapon module has not
 * built yet carry `grenade: null` plus a `fallback` kind, so a loadout that
 * selects Semtex still throws *something* correct-feeling instead of throwing
 * an exception. Filling those in is a one-line change per entry once the
 * projectile exists — the loadout layer needs no edit.
 *
 * Killstreak ids mirror `src/game/Killstreaks.ts` exactly; costs are duplicated
 * here only so the armoury can be drawn without loading the game module, and
 * are asserted against it by `tools/session-loadout.mjs`.
 */

import type { EquipmentDef, FieldUpgradeDef, KillstreakOption } from '../types';

export const LETHALS: readonly EquipmentDef[] = [
  {
    id: 'eq_frag', name: 'Frag Grenade', kind: 'lethal', minRank: 0, count: 1,
    grenade: 'frag',
    description: 'Cookable fragmentation grenade. Bounces, so learn the geometry.',
  },
  {
    id: 'eq_semtex', name: 'Semtex', kind: 'lethal', minRank: 6, count: 1,
    grenade: null, fallback: 'frag',
    description: 'Sticks where it lands. No cook, no roll, no second chance.',
  },
  {
    id: 'eq_thermite', name: 'Thermite', kind: 'lethal', minRank: 17, count: 1,
    grenade: null, fallback: 'frag',
    description: 'Burns through anything it touches over several seconds.',
  },
  {
    id: 'eq_claymore', name: 'Claymore', kind: 'lethal', minRank: 23, count: 2,
    grenade: null, fallback: 'frag',
    description: 'Directional proximity mine. Covers the flank you cannot watch.',
  },
  {
    id: 'eq_knife', name: 'Throwing Knife', kind: 'lethal', minRank: 35, count: 1,
    grenade: null, fallback: 'frag',
    description: 'Silent, lethal, recoverable. One chance per throw.',
  },
];

export const TACTICALS: readonly EquipmentDef[] = [
  {
    id: 'eq_flash', name: 'Flashbang', kind: 'tactical', minRank: 0, count: 2,
    grenade: 'flash',
    description: 'Blinds and deafens through the blast cone. The entry tool.',
  },
  {
    id: 'eq_smoke', name: 'Smoke Screen', kind: 'tactical', minRank: 3, count: 1,
    grenade: 'smoke',
    description: 'Dense screen that breaks sightlines for twenty seconds.',
  },
  {
    id: 'eq_stun', name: 'Stun Grenade', kind: 'tactical', minRank: 9, count: 2,
    grenade: null, fallback: 'flash',
    description: 'Slows movement and turn speed rather than blinding.',
  },
  {
    id: 'eq_snapshot', name: 'Snapshot Grenade', kind: 'tactical', minRank: 27, count: 1,
    grenade: null, fallback: 'flash',
    description: 'Paints a momentary silhouette of everyone in the blast.',
  },
  {
    id: 'eq_decoy', name: 'Decoy Grenade', kind: 'tactical', minRank: 19, count: 2,
    grenade: null, fallback: 'smoke',
    description: 'Fake gunfire and radar pings for eight seconds.',
  },
];

export const FIELD_UPGRADES: readonly FieldUpgradeDef[] = [
  {
    id: 'fu_deadsilence', name: 'Dead Silence', minRank: 0, chargeSeconds: 180, uses: 1,
    description: 'Footsteps go silent for a short window. Refreshes on a kill.',
  },
  {
    id: 'fu_trophy', name: 'Trophy System', minRank: 8, chargeSeconds: 140, uses: 1,
    description: 'Destroys up to three pieces of incoming equipment or projectiles.',
  },
  {
    id: 'fu_munitions', name: 'Munitions Box', minRank: 14, chargeSeconds: 165, uses: 1,
    description: 'Resupplies ammunition and equipment for you and your squad.',
  },
  {
    id: 'fu_recon_drone', name: 'Recon Drone', minRank: 21, chargeSeconds: 190, uses: 1,
    description: 'Pilotable drone that marks every enemy it can see.',
  },
  {
    id: 'fu_cover', name: 'Deployable Cover', minRank: 12, chargeSeconds: 120, uses: 1,
    description: 'Ballistic shield that creates a firing position anywhere.',
  },
  {
    id: 'fu_insertion', name: 'Tactical Insertion', minRank: 26, chargeSeconds: 150, uses: 1,
    description: 'Marks your next respawn point.',
  },
];

/** Mirrors `KILLSTREAK_DEFS` in `src/game/Killstreaks.ts`. */
export const KILLSTREAK_OPTIONS: readonly KillstreakOption[] = [
  { id: 'uav', name: 'UAV Recon', cost: 3, minRank: 6 },
  { id: 'counteruav', name: 'Counter-UAV', cost: 4, minRank: 16 },
  { id: 'carepackage', name: 'Care Package', cost: 5, minRank: 11 },
  { id: 'airstrike', name: 'Precision Airstrike', cost: 7, minRank: 24 },
  { id: 'sentry', name: 'Sentry Turret', cost: 9, minRank: 32 },
];

const LETHAL_BY_ID = new Map(LETHALS.map((e) => [e.id, e]));
const TACTICAL_BY_ID = new Map(TACTICALS.map((e) => [e.id, e]));
const FU_BY_ID = new Map(FIELD_UPGRADES.map((e) => [e.id, e]));
const KS_BY_ID = new Map(KILLSTREAK_OPTIONS.map((e) => [e.id, e]));

export function lethalDef(id: string): EquipmentDef | null { return LETHAL_BY_ID.get(id) ?? null; }
export function tacticalDef(id: string): EquipmentDef | null { return TACTICAL_BY_ID.get(id) ?? null; }
export function fieldUpgradeDef(id: string): FieldUpgradeDef | null { return FU_BY_ID.get(id) ?? null; }
export function killstreakOption(id: string): KillstreakOption | null { return KS_BY_ID.get(id) ?? null; }

/**
 * The grenade kind the game should actually spawn for a piece of equipment,
 * honouring the fallback for anything not implemented yet.
 */
export function grenadeKindFor(def: EquipmentDef): 'frag' | 'flash' | 'smoke' {
  return def.grenade ?? def.fallback ?? (def.kind === 'lethal' ? 'frag' : 'flash');
}
