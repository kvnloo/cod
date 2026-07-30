/**
 * Create-a-class: the public surface.
 *
 * ```ts
 * import {
 *   LoadoutBook, LoadoutService, resolveWeapon, statBars, validateLoadout,
 * } from '@/session/loadout';
 *
 * const book = new LoadoutBook();          // client: saved classes + editing
 * book.load();
 * book.setAttachment(0, 'primary', 'muzzle', 'muzzle_comp');
 *
 * const service = new LoadoutService();    // host: validate, grant, activate
 * const grant = await service.request(playerId, book.current());
 * const spawn = service.notifySpawn(playerId);
 * spawn.primary.adsTime;                   // the number the weapon system uses
 * ```
 *
 * Everything here is deterministic and free of three.js, the DOM and the event
 * bus, so it can be exercised headlessly — `tools/session-loadout.mjs` does
 * exactly that.
 *
 * See `README.md` in this directory for the `EffectiveWeaponStats` contract and
 * the modifier algebra.
 */

/* --- contracts ---------------------------------------------------------- */
export type {
  AttachmentEntry, EffectiveWeaponStats, EquipmentDef, EquipmentKind,
  FieldUpgradeDef, KillstreakOption, Loadout, LoadoutAuthority, LoadoutFlag,
  LoadoutGrant, LoadoutLimits, LoadoutSlot, Modifier, ModifierMode, PerkDef,
  PerkRow, StatBars, StatKey, UnlockProvider, ValidationCode,
  ValidationContext, ValidationError, ValidationResult, WeaponLookup, WeaponSpec,
} from './types';
export { LOADOUT_SLOTS, STAT_KEYS } from './types';

/* --- the algebra -------------------------------------------------------- */
export {
  ModifierStack, clampToRule, railsFor,
  type Contribution, type StatFold,
} from './Modifiers';
export { STAT_RULES, LIMITS, FLAG_LABEL, FLAG_SIDE, type StatRule } from './data/balance';

/* --- resolution --------------------------------------------------------- */
export {
  resolveWeapon, resolveAttachments, mountable, slotsFor, statBars,
  toResolvedStats, effectiveDamageAt, effectiveShotsToKill,
  type ResolveOptions,
} from './Effective';

/* --- validation --------------------------------------------------------- */
export {
  validateLoadout, repairLoadout, defaultLoadout, cloneLoadout, loadoutsEqual,
  serialiseLoadout, sanitiseName, isLocked, contentIndex,
} from './Validate';

/* --- saved classes ------------------------------------------------------ */
export {
  LoadoutBook, MemoryStorage,
  type BookChange, type LoadoutBookOptions, type ResolvedClass, type StorageLike,
} from './Classes';

/* --- authority ---------------------------------------------------------- */
export {
  LoadoutService, LocalAuthority, activate, describeErrors,
  type ActiveLoadout, type LoadoutServiceOptions,
} from './Service';

/* --- content tables ----------------------------------------------------- */
export {
  ATTACHMENT_TABLE, attachmentEntry, attachmentsFor, auditAttachments,
  isBaseline, type AuditIssue,
} from './data/attachments';
export { PERK_TABLE, perkDef, perkConflicts, perksInRow } from './data/perks';
export {
  FIELD_UPGRADES, KILLSTREAK_OPTIONS, LETHALS, TACTICALS,
  fieldUpgradeDef, grenadeKindFor, killstreakOption, lethalDef, tacticalDef,
} from './data/equipment';
export { PRESET_CLASSES } from './data/presets';
export {
  WEAPON_META, assertWeaponMetaCoverage, weaponMeta, weaponMinRank,
  type WeaponMeta,
} from './data/weapons';

/* --- tuning ------------------------------------------------------------- */
export { applyTuningPatch, type TuningPatch } from './Tuning';
