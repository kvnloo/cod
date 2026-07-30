/**
 * Public surface of the weapon module.
 *
 * Other systems should import from here rather than reaching into individual
 * files, so the internals (mesh builders, forge recipes, animation curves) stay
 * free to change.
 *
 *   const weapons = ctx.engine.get<WeaponSystem>('weapons');
 *   const snap = weapons.snapshot();      // everything a HUD needs
 *   const def = weapons.definitionOf(id); // audio reads its voice from here
 *   weapons.setDamageResolver(fn);        // gameplay owns health
 */

export { WeaponSystem } from './Weapons';
export {
  WEAPONS, DEFAULT_LOADOUT, weaponDef, hasWeapon, damageAt, shotsToKill,
} from './Catalog';
export {
  ATTACHMENTS, attachment, attachmentsFor, fits, resolveLoadout, resolveStats,
  type ResolvedStats,
} from './Attachments';
export { GRENADES, type GrenadeDef, type GrenadeKind } from './Grenades';
export { WeaponMaterials, WEAPON_TEXEL_SCALE } from './WeaponMaterials';
export { buildWeaponMesh } from './mesh/Models';
export type { WeaponRig } from './mesh/Builder';
export type { DamageResolver, DamageResult, ShotSpec } from './Ballistics';
export type {
  ActionKind, AttachmentDef, AttachmentSlot, AttachmentStats, AudioProfile,
  BallisticsProfile, DamageStop, FireMode, HandlingProfile, HitZone,
  HitZoneMultipliers, MaterialKey, ModelProfile, RecoilPattern, ReloadProfile,
  SpreadProfile, ViewProfile, WeaponClass, WeaponDef, WeaponRuntime,
  WeaponSnapshot, WeaponState,
} from './types';
