/**
 * Create-a-class contracts.
 *
 * This file is pure types and unit documentation — no logic, no imports that
 * touch three.js — so tools, tests, the netcode layer and the HUD can all read
 * it without dragging the renderer in.
 *
 * Three ideas carry the whole system:
 *
 *  1. **A loadout is data.** `Loadout` is a plain, serialisable record of ids.
 *     It is what a client sends and what the host stores; it contains no
 *     resolved numbers, because resolved numbers are the *host's* opinion.
 *  2. **Attachments are typed modifiers, not code.** Every attachment is a list
 *     of `Modifier`s against named `StatKey`s. The algebra that folds them is in
 *     `Modifiers.ts` and is the same for every attachment, perk and future
 *     content pack — so a new attachment is a data entry, never a code change.
 *  3. **`EffectiveWeaponStats` is the only output that matters.** The weapons
 *     module consumes it; the HUD renders bars derived from it; ballistics reads
 *     its damage curve. Nothing downstream needs to know an attachment existed.
 *
 * Units are SI: seconds, metres, m/s, degrees only where named `Deg`.
 */

import type {
  AttachmentSlot, DamageStop, WeaponClass, WeaponDef,
} from '../../weapons/types';

/* ========================================================== slots & content */

/**
 * Attachment slots the loadout layer understands.
 *
 * This is the weapon module's `AttachmentSlot` plus `barrel`, which the weapon
 * mesh builder does not model yet. Barrel attachments therefore resolve their
 * numbers but declare `mesh: null` — see `AttachmentEntry.mesh`.
 */
export type LoadoutSlot = AttachmentSlot | 'barrel';

export const LOADOUT_SLOTS: readonly LoadoutSlot[] = [
  'optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'laser',
];

/** Stats an attachment or perk is allowed to move. */
export type StatKey =
  /* handling */
  | 'adsTime' | 'sprintOut' | 'drawTime' | 'holsterTime' | 'reloadTime'
  | 'moveScale' | 'adsMoveScale' | 'sway' | 'flinch'
  /* recoil */
  | 'recoilVertical' | 'recoilHorizontal' | 'recoilFirstShot' | 'recoilRecovery'
  /* accuracy */
  | 'hipSpread' | 'adsSpread' | 'bloomPerShot' | 'bloomDecay'
  /* firepower */
  | 'magSize' | 'reserveAmmo' | 'muzzleVelocity' | 'penetration'
  | 'falloffRange' | 'damage' | 'fireRate'
  /* optics */
  | 'magnification';

export const STAT_KEYS: readonly StatKey[] = [
  'adsTime', 'sprintOut', 'drawTime', 'holsterTime', 'reloadTime',
  'moveScale', 'adsMoveScale', 'sway', 'flinch',
  'recoilVertical', 'recoilHorizontal', 'recoilFirstShot', 'recoilRecovery',
  'hipSpread', 'adsSpread', 'bloomPerShot', 'bloomDecay',
  'magSize', 'reserveAmmo', 'muzzleVelocity', 'penetration',
  'falloffRange', 'damage', 'fireRate', 'magnification',
];

/**
 * How a modifier folds into its stat.
 *
 * - `mul` — scales the base. Multiplicative modifiers stack with diminishing
 *   returns on the *beneficial* side only (see `Modifiers.ts`).
 * - `add`  — flat delta applied after scaling (magazine `+2`, reserve `+60`).
 * - `max`  — the largest value wins and the base is ignored (optic zoom).
 */
export type ModifierMode = 'mul' | 'add' | 'max';

export interface Modifier {
  stat: StatKey;
  mode: ModifierMode;
  value: number;
}

/** Non-numeric properties an attachment / perk can confer. */
export type LoadoutFlag =
  | 'suppressed' | 'noFlash' | 'loud' | 'laser' | 'laserVisible' | 'bipod'
  | 'thermal' | 'scavenger' | 'ghost' | 'hardline' | 'overkill'
  | 'tacMask' | 'silentMove';

/** Which side of the ledger a flag sits on — used by the no-free-lunch audit. */
export type FlagSide = 'pro' | 'con';

export interface AttachmentEntry {
  id: string;
  name: string;
  slot: LoadoutSlot;
  /** Weapon classes that may mount it. */
  classes: readonly WeaponClass[] | 'all';
  /** Rank at which it unlocks. 0 = available from the first match. */
  minRank: number;
  /** Typed stat deltas. Order within the array never matters. */
  mods: readonly Modifier[];
  flags?: readonly LoadoutFlag[];
  /**
   * Id of the weapon-module `AttachmentDef` whose mesh + build hints represent
   * this entry, or `null` when the mesh builder has no part for it yet
   * (currently every `barrel`). Resolution passes the non-null ids straight to
   * `resolveLoadout()` so the gun the player sees matches the gun they built.
   */
  mesh: string | null;
  /** Ids that may not be fitted alongside this one, beyond the slot rule. */
  conflicts?: readonly string[];
  /** True for the "nothing fitted" entry of a slot; exempt from the audit. */
  baseline?: boolean;
  pros: readonly string[];
  cons: readonly string[];
  description: string;
}

/** Perk rows. One perk per row, exactly like every modern shooter. */
export type PerkRow = 1 | 2 | 3;

export interface PerkDef {
  id: string;
  name: string;
  row: PerkRow;
  minRank: number;
  /** Weapon-handling deltas the perk contributes. May be empty. */
  mods: readonly Modifier[];
  flags?: readonly LoadoutFlag[];
  /**
   * Exclusivity group. Two perks in the same group cannot be run together even
   * when they sit in different rows — this is what stops reload-speed stacking.
   */
  group?: string;
  description: string;
}

export type EquipmentKind = 'lethal' | 'tactical';

export interface EquipmentDef {
  id: string;
  name: string;
  kind: EquipmentKind;
  minRank: number;
  /** Carried count at spawn. */
  count: number;
  /**
   * Grenade kind in the weapon module (`frag` | `flash` | `smoke`) or `null`
   * when this piece of equipment has no implementation yet, in which case
   * `fallback` names the kind the game should throw instead.
   */
  grenade: 'frag' | 'flash' | 'smoke' | null;
  fallback?: 'frag' | 'flash' | 'smoke';
  description: string;
}

export interface FieldUpgradeDef {
  id: string;
  name: string;
  minRank: number;
  /** Seconds of match time to charge one use. */
  chargeSeconds: number;
  /** Uses granted per charge. */
  uses: number;
  description: string;
}

export interface KillstreakOption {
  id: string;
  name: string;
  /** Kills required — mirrors `src/game/Killstreaks.ts`. */
  cost: number;
  minRank: number;
}

/* ================================================================= loadout */

/** One weapon plus the attachment ids fitted to it. */
export interface WeaponSpec {
  weaponId: string;
  attachments: string[];
}

/**
 * A saved class. Plain JSON — this is the exact shape that crosses the wire.
 *
 * `version` lets the host reject or migrate stale clients instead of guessing.
 */
export interface Loadout {
  version: 1;
  /** Stable id for the saved slot; the host keys grants by player, not by this. */
  id: string;
  name: string;
  primary: WeaponSpec;
  secondary: WeaponSpec;
  lethal: string;
  tactical: string;
  /** Exactly one id per row, in row order. Empty string = row left empty. */
  perks: [string, string, string];
  fieldUpgrade: string;
  /** Up to `LIMITS.killstreaks` ids, ordered by cost. */
  killstreaks: string[];
}

/* ============================================================== validation */

export type ValidationCode =
  | 'malformed'
  | 'unknown_weapon'
  | 'slot_mismatch'
  | 'duplicate_weapon'
  | 'attachment_unknown'
  | 'attachment_limit'
  | 'attachment_slot_conflict'
  | 'attachment_incompatible'
  | 'attachment_conflict'
  | 'attachment_duplicate'
  | 'perk_unknown'
  | 'perk_row'
  | 'perk_duplicate'
  | 'perk_conflict'
  | 'equipment_unknown'
  | 'field_upgrade_unknown'
  | 'killstreak_unknown'
  | 'killstreak_limit'
  | 'killstreak_duplicate'
  | 'locked'
  | 'name_invalid';

export interface ValidationError {
  code: ValidationCode;
  /** Dotted path into the loadout, e.g. `primary.attachments[2]`. */
  path: string;
  /** The offending id, when there is one. */
  id?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /**
   * The loadout the host is willing to run. On success it is the (normalised)
   * input; on failure it is the *repaired* loadout, with every illegal element
   * dropped or replaced — never a partially-applied one.
   */
  loadout: Loadout;
  errors: ValidationError[];
  /** Human-readable list of what the repair changed. */
  repairs: string[];
}

/**
 * What the validator is allowed to consult. Narrow on purpose: the host injects
 * a progression-shaped object (`src/game/Progression.ts` satisfies it
 * structurally) and nothing else is reachable from the trust boundary.
 */
export interface UnlockProvider {
  /** Player rank, used for the rank-gate on every piece of content. */
  readonly rank: number;
  /** Explicit grants that bypass the rank gate (challenges, care packages). */
  isUnlocked?(id: string): boolean;
}

/** Everything the validator needs besides the loadout itself. */
export interface ValidationContext {
  unlocks?: UnlockProvider;
  /** When false the rank gate is skipped entirely (private match, bots). */
  enforceUnlocks?: boolean;
  /** Overrides the default limits — modes may widen or narrow them. */
  limits?: Partial<LoadoutLimits>;
}

export interface LoadoutLimits {
  /** Maximum attachments per weapon. */
  attachmentsPerWeapon: number;
  /** Maximum saved custom classes. */
  savedClasses: number;
  killstreaks: number;
  nameMaxLength: number;
}

/* ========================================================= effective stats */

/**
 * The resolved gun: base stats folded with every fitted attachment and every
 * equipped perk, clamped to sane bounds.
 *
 * This is the *only* object downstream systems should read. It is a value type
 * — resolving twice with the same inputs gives byte-identical output, and the
 * order attachments appear in never changes the result.
 */
export interface EffectiveWeaponStats {
  weaponId: string;
  weaponName: string;
  cls: WeaponClass;
  /** Attachment ids that actually resolved, in canonical slot order. */
  attachments: string[];
  /** Subset of `attachments` the weapon mesh builder can represent. */
  meshAttachments: string[];

  /* --- handling (seconds unless noted) --- */
  adsTime: number;
  sprintOut: number;
  drawTime: number;
  holsterTime: number;
  reloadTactical: number;
  reloadEmpty: number;
  /**
   * Shell-by-shell reloaders (shotguns, some marksman rifles) have
   * `reloadTactical === 0`; their timing lives here instead. Every field is
   * already scaled by `reloadScale`, so a quickdraw magazine or Sleight of Hand
   * speeds a shotgun up exactly as it speeds a rifle up.
   */
  shellReload: boolean;
  reloadPerShell: number;
  reloadShellIn: number;
  reloadShellOut: number;
  /** The multiplier that produced every reload number above. */
  reloadScale: number;
  /** Multipliers on the player's base speed. */
  moveScale: number;
  adsMoveScale: number;
  /** Multiplier on the view-model sway amplitude. */
  swayScale: number;
  /** Multiplier on incoming-fire flinch. */
  flinchScale: number;

  /* --- recoil --- */
  recoilVerticalScale: number;
  recoilHorizontalScale: number;
  recoilFirstShotScale: number;
  /** Absolute fraction, 0..0.95 — replaces `RecoilPattern.recoverFraction`. */
  recoilRecoverFraction: number;
  /** The weapon's pattern with the scales already applied, degrees per shot. */
  patternVertical: number[];
  patternHorizontal: number[];

  /* --- accuracy, degrees of cone half-angle --- */
  hipSpreadDeg: number;
  adsSpreadDeg: number;
  bloomPerShotDeg: number;
  bloomMaxDeg: number;
  bloomDecayDegPerSec: number;

  /* --- firepower --- */
  rpm: number;
  magSize: number;
  reserve: number;
  muzzleVelocity: number;
  penetration: number;
  /** Damage curve with the falloff distances scaled. */
  damage: DamageStop[];
  /** The multiplier that was applied to every falloff distance. */
  falloffScale: number;
  /** Damage multiplier applied to every stop. */
  damageScale: number;

  /* --- optics / flags --- */
  magnification: number;
  suppressed: boolean;
  laser: boolean;
  flags: LoadoutFlag[];

  /* --- provenance --- */
  /** Stats whose value hit a clamp. Non-empty means the build is at a limit. */
  capped: StatKey[];
  /** Anything the resolver had to ignore (unknown id, wrong class, …). */
  warnings: string[];
}

/** Normalised 0..1 bars for the create-a-class UI. */
export interface StatBars {
  damage: number;
  accuracy: number;
  range: number;
  fireRate: number;
  mobility: number;
  control: number;
}

/* =============================================================== authority */

/**
 * What the host grants a player. Clients display this; they never derive it.
 *
 * `tick` is the authoritative simulation tick the grant takes effect on — the
 * netcode layer fills it in; a local (offline) authority uses 0.
 */
export interface LoadoutGrant {
  playerId: number;
  accepted: boolean;
  /** The loadout the host will actually run — repaired if the request was bad. */
  loadout: Loadout;
  errors: ValidationError[];
  tick: number;
  /** True when the grant is queued for the next respawn rather than immediate. */
  pending: boolean;
}

/**
 * The netcode seam.
 *
 * `src/net/` does not export anything yet, so this is the interface the loadout
 * layer codes against. A host-side implementation validates and grants; a
 * client-side implementation serialises the request and waits for the host's
 * answer. `LocalAuthority` in `Service.ts` is the offline implementation and is
 * what runs today.
 */
export interface LoadoutAuthority {
  /** True when this peer decides. Clients must render, not compute. */
  readonly isHost: boolean;
  /** Ask for a loadout. Resolves with whatever the authority granted. */
  request(playerId: number, loadout: Loadout): Promise<LoadoutGrant>;
  /** Every accepted grant, including other players'. */
  onGrant(fn: (grant: LoadoutGrant) => void): () => void;
}

/** Convenience alias — a weapon definition lookup the resolver can be given. */
export type WeaponLookup = (id: string) => WeaponDef | null;
