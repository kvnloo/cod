/**
 * Resolution: weapon + attachments + perks → `EffectiveWeaponStats`.
 *
 * This is the object the rest of the game reads. Nothing downstream should ever
 * look at an attachment id again:
 *
 * ```ts
 * import { resolveWeapon, toResolvedStats } from '@/session/loadout';
 *
 * const eff = resolveWeapon('ar_vkr7', ['optic_holo', 'muzzle_comp', 'stock_light']);
 * eff.adsTime      // 0.243  (base 0.26)
 * eff.magSize      // 30
 * eff.damage       // falloff stops with distances already scaled
 * weapons.applyEffective(toResolvedStats(eff));   // one-line adoption
 * ```
 *
 * Determinism is a hard requirement: the same inputs in any order give the same
 * output, because the algebra in `Modifiers.ts` sums deviations rather than
 * multiplying them in list order. `tools/session-loadout.mjs` proves it by
 * shuffling every combination with a seeded RNG.
 */

import { hasWeapon, weaponDef } from '../../weapons/Catalog';
import type { ResolvedStats } from '../../weapons/Attachments';
import type { DamageStop, WeaponDef } from '../../weapons/types';
import { ModifierStack } from './Modifiers';
import { attachmentEntry, isBaseline } from './data/attachments';
import { perkDef } from './data/perks';
import { RELOAD_RAILS, type DurationRail } from './data/balance';
import { LOADOUT_SLOTS } from './types';
import type {
  AttachmentEntry, EffectiveWeaponStats, LoadoutFlag, LoadoutSlot, Modifier,
  StatBars, StatKey,
} from './types';

/* --------------------------------------------------------------- ordering */

const SLOT_ORDER = new Map<LoadoutSlot, number>(LOADOUT_SLOTS.map((s, i) => [s, i]));

/**
 * Resolves attachment ids against a weapon: drops unknown ids, ids the class
 * cannot mount, baseline ("none") entries and duplicate slots, then sorts into
 * canonical slot order so the result is independent of input order.
 */
export function resolveAttachments(
  def: WeaponDef,
  ids: readonly string[],
): { fitted: AttachmentEntry[]; warnings: string[] } {
  const fitted: AttachmentEntry[] = [];
  const used = new Set<LoadoutSlot>();
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) { warnings.push(`duplicate attachment "${id}"`); continue; }
    seen.add(id);
    const entry = attachmentEntry(id);
    if (!entry) { warnings.push(`unknown attachment "${id}"`); continue; }
    if (isBaseline(entry)) continue;
    if (!mountable(def, entry)) { warnings.push(`"${id}" does not fit a ${def.cls}`); continue; }
    if (used.has(entry.slot)) { warnings.push(`slot "${entry.slot}" already filled, dropped "${id}"`); continue; }
    used.add(entry.slot);
    fitted.push(entry);
  }
  fitted.sort((a, b) => (SLOT_ORDER.get(a.slot) ?? 99) - (SLOT_ORDER.get(b.slot) ?? 99));
  return { fitted, warnings };
}

/**
 * Whether a weapon can take an attachment.
 *
 * The weapon module's `WeaponDef.slots` is the source of truth for the slots it
 * models; `barrel` is a loadout-layer slot every long gun and pistol accepts
 * until the mesh builder grows one.
 */
export function mountable(def: WeaponDef, entry: AttachmentEntry): boolean {
  if (entry.classes !== 'all' && !entry.classes.includes(def.cls)) return false;
  if (entry.slot === 'barrel') return def.cls !== 'launcher';
  return def.slots.includes(entry.slot);
}

/** Slots this weapon can actually use, in canonical order. */
export function slotsFor(def: WeaponDef): LoadoutSlot[] {
  const out: LoadoutSlot[] = [];
  for (const slot of LOADOUT_SLOTS) {
    if (slot === 'barrel') { if (def.cls !== 'launcher') out.push(slot); continue; }
    if (def.slots.includes(slot)) out.push(slot);
  }
  return out;
}

/* -------------------------------------------------------------- resolution */

export interface ResolveOptions {
  /** Perk ids whose weapon-handling modifiers apply to this weapon. */
  perks?: readonly string[];
  /** Extra sources — future camo/blueprint bonuses, mode rules, bot difficulty. */
  extra?: ReadonlyArray<{ id: string; mods: readonly Modifier[]; flags?: readonly LoadoutFlag[] }>;
}

/**
 * Folds a weapon's base numbers with everything fitted to it.
 *
 * `weapon` may be an id or a `WeaponDef`. An unknown id is not an exception —
 * the host must survive a hostile client — it resolves the default weapon and
 * records a warning.
 */
export function resolveWeapon(
  weapon: string | WeaponDef,
  attachmentIds: readonly string[] = [],
  options: ResolveOptions = {},
): EffectiveWeaponStats {
  const warnings: string[] = [];
  let def: WeaponDef;
  if (typeof weapon === 'string') {
    if (!hasWeapon(weapon)) {
      warnings.push(`unknown weapon "${weapon}" — resolved as ar_vkr7`);
      def = weaponDef('ar_vkr7');
    } else def = weaponDef(weapon);
  } else def = weapon;

  const { fitted, warnings: attachWarnings } = resolveAttachments(def, attachmentIds);
  warnings.push(...attachWarnings);

  const stack = new ModifierStack();
  for (const a of fitted) stack.add(a.id, a.mods, a.flags);
  for (const id of options.perks ?? []) {
    const p = perkDef(id);
    if (!p) { warnings.push(`unknown perk "${id}"`); continue; }
    stack.add(p.id, p.mods, p.flags);
  }
  for (const e of options.extra ?? []) stack.add(e.id, e.mods, e.flags);

  const capped: StatKey[] = [];
  const fold = (stat: StatKey, base: number): number => {
    const f = stack.fold(stat, base);
    if (f.capped) capped.push(stat);
    return f.value;
  };
  /**
   * Reload timings are railed in seconds, not in multiples — see
   * `RELOAD_RAILS`. A weapon with no such reload (base 0) stays at 0.
   */
  const reloadSeconds = (base: number, scale: number, rail: DurationRail): number => {
    if (!(base > 0)) return 0;
    const v = base * scale;
    if (v > rail.max) { capped.push('reloadTime'); return rail.max; }
    if (v < rail.min) { capped.push('reloadTime'); return rail.min; }
    return v;
  };

  const h = def.handling;
  const r = def.recoil;
  const s = def.spread;

  const recoilVerticalScale = fold('recoilVertical', 1);
  const recoilHorizontalScale = fold('recoilHorizontal', 1);
  const falloffScale = fold('falloffRange', 1);
  const damageScale = fold('damage', 1);
  const reloadScale = fold('reloadTime', 1);

  const damage: DamageStop[] = def.damage.map((stop) => ({
    distance: round(stop.distance * falloffScale, 3),
    damage: round(stop.damage * damageScale, 3),
  }));

  const flags = stack.flags;
  const eff: EffectiveWeaponStats = {
    weaponId: def.id,
    weaponName: def.name,
    cls: def.cls,
    attachments: fitted.map((a) => a.id),
    meshAttachments: fitted.map((a) => a.mesh).filter((x): x is string => typeof x === 'string'),

    adsTime: round(fold('adsTime', h.adsTime), 4),
    sprintOut: round(fold('sprintOut', h.sprintOut), 4),
    drawTime: round(fold('drawTime', h.drawTime), 4),
    holsterTime: round(fold('holsterTime', h.holsterTime), 4),
    reloadTactical: round(reloadSeconds(def.reload.tactical, reloadScale, RELOAD_RAILS.tactical), 4),
    reloadEmpty: round(reloadSeconds(def.reload.empty, reloadScale, RELOAD_RAILS.empty), 4),
    shellReload: def.reload.tactical <= 0 && (def.reload.perShell ?? 0) > 0,
    reloadPerShell: round(reloadSeconds(def.reload.perShell ?? 0, reloadScale, RELOAD_RAILS.perShell), 4),
    reloadShellIn: round((def.reload.shellIn ?? 0) * reloadScale, 4),
    reloadShellOut: round((def.reload.shellOut ?? 0) * reloadScale, 4),
    reloadScale: round(reloadScale, 4),
    moveScale: round(fold('moveScale', h.moveScale), 4),
    adsMoveScale: round(fold('adsMoveScale', h.adsMoveScale), 4),
    swayScale: round(fold('sway', def.view.swayScale), 4),
    flinchScale: round(fold('flinch', 1), 4),

    recoilVerticalScale: round(recoilVerticalScale, 4),
    recoilHorizontalScale: round(recoilHorizontalScale, 4),
    recoilFirstShotScale: round(fold('recoilFirstShot', 1), 4),
    recoilRecoverFraction: round(fold('recoilRecovery', r.recoverFraction), 4),
    patternVertical: r.vertical.map((v) => round(v * recoilVerticalScale, 4)),
    patternHorizontal: r.horizontal.map((v) => round(v * recoilHorizontalScale, 4)),

    hipSpreadDeg: round(fold('hipSpread', s.hip), 4),
    adsSpreadDeg: round(fold('adsSpread', s.ads), 4),
    bloomPerShotDeg: round(fold('bloomPerShot', s.bloomPerShot), 4),
    bloomMaxDeg: round(s.bloomMax, 4),
    bloomDecayDegPerSec: round(fold('bloomDecay', s.bloomDecay), 4),

    rpm: round(fold('fireRate', def.rpm), 2),
    magSize: fold('magSize', def.magSize),
    reserve: fold('reserveAmmo', def.startReserve),
    muzzleVelocity: round(fold('muzzleVelocity', def.ballistics.muzzleVelocity), 2),
    penetration: round(fold('penetration', def.ballistics.penetration), 4),
    damage,
    falloffScale: round(falloffScale, 4),
    damageScale: round(damageScale, 4),

    magnification: round(fold('magnification', 1), 3),
    suppressed: stack.has('suppressed'),
    laser: stack.has('laser'),
    flags,

    capped: [...new Set(capped)].sort(),
    warnings,
  };
  return eff;
}

/** Damage at a distance from an already-resolved weapon. */
export function effectiveDamageAt(eff: EffectiveWeaponStats, distance: number): number {
  const c = eff.damage;
  if (c.length === 0) return 0;
  if (distance <= c[0].distance) return c[0].damage;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1];
    const b = c[i];
    if (distance <= b.distance) {
      const t = (distance - a.distance) / Math.max(1e-4, b.distance - a.distance);
      return a.damage + (b.damage - a.damage) * t;
    }
  }
  return c[c.length - 1].damage;
}

/** Shots to kill at a distance — the only balance number players actually feel. */
export function effectiveShotsToKill(
  eff: EffectiveWeaponStats,
  distance: number,
  zone: 'head' | 'chest' = 'chest',
  health = 100,
): number {
  const def = hasWeapon(eff.weaponId) ? weaponDef(eff.weaponId) : null;
  const zoneMul = def ? def.zones[zone] : zone === 'head' ? 1.5 : 1;
  const pellets = def ? Math.max(1, def.ballistics.pellets) : 1;
  const dmg = effectiveDamageAt(eff, distance) * zoneMul * pellets;
  return Math.max(1, Math.ceil(health / Math.max(1e-3, dmg)));
}

/* ------------------------------------------------- weapon-module adoption */

/**
 * Bridges to the weapon module's own `ResolvedStats`, so `WeaponSystem` can
 * consume a loadout-resolved gun without changing a single call site:
 *
 * ```ts
 * // in WeaponSystem.give()
 * const stats = loadout ? toResolvedStats(loadout) : resolveStats(def, attachments);
 * ```
 *
 * Everything `ResolvedStats` carries is present in `EffectiveWeaponStats`; the
 * scales it wants relative to base are recovered by dividing out the base.
 */
export function toResolvedStats(eff: EffectiveWeaponStats): ResolvedStats {
  const def = hasWeapon(eff.weaponId) ? weaponDef(eff.weaponId) : weaponDef('ar_vkr7');
  const safe = (a: number, b: number): number => (b > 1e-6 ? a / b : 1);
  return {
    adsTime: eff.adsTime,
    sprintOut: eff.sprintOut,
    drawTime: eff.drawTime,
    recoilScale: eff.recoilVerticalScale,
    recoilHorizontalScale: eff.recoilHorizontalScale,
    hipSpreadScale: safe(eff.hipSpreadDeg, def.spread.hip),
    adsSpreadScale: safe(eff.adsSpreadDeg, def.spread.ads),
    bloomScale: safe(eff.bloomPerShotDeg, def.spread.bloomPerShot),
    moveScale: eff.moveScale,
    adsMoveScale: eff.adsMoveScale,
    magSize: eff.magSize,
    // Shell reloaders have no tactical reload to divide by — the scale is
    // carried directly so shotguns still respond to reload modifiers.
    reloadScale: eff.reloadScale,
    muzzleVelocity: eff.muzzleVelocity,
    penetration: eff.penetration,
    rangeScale: eff.falloffScale,
    suppressed: eff.suppressed,
    magnification: eff.magnification,
    laser: eff.laser,
  };
}

/* ------------------------------------------------------------------ bars */

/**
 * Normalised 0..1 bars for the create-a-class screen.
 *
 * The ranges are absolute across the whole armoury, not per weapon, so a pistol
 * genuinely reads as short-ranged next to an LMG. `src/ui/menus/LoadoutMenu.ts`
 * already draws exactly this shape (`LoadoutStats`) — wiring it up is assigning
 * the result of this function to its `stats` field.
 */
export function statBars(eff: EffectiveWeaponStats): StatBars {
  const closeDamage = effectiveDamageAt(eff, 0);
  const lastStop = eff.damage.length ? eff.damage[eff.damage.length - 1].distance : 30;
  const patternMean = eff.patternVertical.length
    ? eff.patternVertical.reduce((a, b) => a + Math.abs(b), 0) / eff.patternVertical.length
    : 0.5;
  return {
    damage: norm(closeDamage * Math.max(1, pelletsOf(eff)), 12, 110),
    accuracy: norm(eff.adsSpreadDeg, 0.55, 0.02),
    range: norm(lastStop, 12, 110),
    fireRate: norm(eff.rpm, 40, 950),
    mobility: clamp01(0.5 * norm(eff.moveScale, 0.75, 1.12) + 0.5 * norm(eff.adsTime, 0.75, 0.15)),
    control: clamp01(0.6 * norm(patternMean, 1.6, 0.18) + 0.4 * norm(eff.swayScale, 1.8, 0.6)),
  };
}

function pelletsOf(eff: EffectiveWeaponStats): number {
  return hasWeapon(eff.weaponId) ? Math.max(1, weaponDef(eff.weaponId).ballistics.pellets) : 1;
}

/** Maps `v` from [lo,hi] to [0,1]; `lo > hi` inverts, which is how "lower is better" reads. */
function norm(v: number, lo: number, hi: number): number {
  if (Math.abs(hi - lo) < 1e-9) return 0;
  return clamp01((v - lo) / (hi - lo));
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function round(v: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}
