/**
 * Balance data — the tuning surface of the whole loadout system.
 *
 * Nothing in this file is logic. It is the table the modifier algebra reads:
 * for every stat, which direction is good for the player, how hard stacked
 * bonuses are damped, and the hard rails the final value may never leave.
 * Retuning the game is editing numbers here (or shipping a `TuningPatch`),
 * never rewriting a resolver.
 *
 * ## The rails, in one paragraph
 *
 * A stat's final value is `clamp(base × factor + add, lo, hi)` where `lo`/`hi`
 * come from `minMul`/`maxMul` (relative to the *base*, so a heavy LMG and a
 * pistol get proportionate rails) intersected with the absolute `min`/`max`.
 * `factor` is produced by `Modifiers.ts` from the multiplicative modifiers with
 * diminishing returns applied to the beneficial side only — three recoil
 * attachments cannot multiply into a laser beam, but three penalties absolutely
 * do add up.
 */

import type { LoadoutFlag, FlagSide, LoadoutLimits, StatKey } from '../types';

export interface StatRule {
  /** Human label for stat tables and the armoury UI. */
  label: string;
  /** Unit suffix for display. */
  unit: string;
  /** Which direction the player wants. Decides which stackers get damped. */
  better: 'lower' | 'higher';
  /**
   * Diminishing-returns factor for stacked *beneficial* multipliers, 0..1.
   * The largest bonus counts in full, the next at `soften`, the next at
   * `soften²`, and so on. 1 disables damping (pure product).
   */
  soften: number;
  /** Rails relative to the weapon's own base value. */
  minMul: number;
  maxMul: number;
  /** Absolute rails, applied after the relative ones. */
  min?: number;
  max?: number;
  /** Round to a whole number (magazine capacity, reserve ammo). */
  integer?: boolean;
}

/**
 * Per-stat rules.
 *
 * `soften` is lowest where stacking is most tempting and most damaging:
 * hip-fire spread (laser + no-stock + short barrel) and recoil (comp + grip +
 * heavy stock) are the two builds that historically break shooters.
 */
export const STAT_RULES: Record<StatKey, StatRule> = {
  adsTime: { label: 'ADS', unit: 's', better: 'lower', soften: 0.72, minMul: 0.62, maxMul: 1.85, min: 0.08 },
  sprintOut: { label: 'Sprint-out', unit: 's', better: 'lower', soften: 0.75, minMul: 0.55, maxMul: 1.70, min: 0.05 },
  drawTime: { label: 'Draw', unit: 's', better: 'lower', soften: 0.80, minMul: 0.55, maxMul: 1.60, min: 0.12 },
  holsterTime: { label: 'Holster', unit: 's', better: 'lower', soften: 0.80, minMul: 0.55, maxMul: 1.60, min: 0.08 },
  reloadTime: { label: 'Reload', unit: '×', better: 'lower', soften: 0.70, minMul: 0.62, maxMul: 1.90 },
  moveScale: { label: 'Move', unit: '×', better: 'higher', soften: 0.65, minMul: 0.86, maxMul: 1.14, min: 0.68, max: 1.16 },
  adsMoveScale: { label: 'ADS move', unit: '×', better: 'higher', soften: 0.65, minMul: 0.80, maxMul: 1.60, min: 0.20, max: 0.95 },
  sway: { label: 'Sway', unit: '×', better: 'lower', soften: 0.72, minMul: 0.50, maxMul: 2.20 },
  flinch: { label: 'Flinch', unit: '×', better: 'lower', soften: 0.75, minMul: 0.50, maxMul: 1.60 },

  recoilVertical: { label: 'Recoil ↕', unit: '×', better: 'lower', soften: 0.68, minMul: 0.45, maxMul: 1.80 },
  recoilHorizontal: { label: 'Recoil ↔', unit: '×', better: 'lower', soften: 0.68, minMul: 0.45, maxMul: 1.80 },
  recoilFirstShot: { label: '1st shot', unit: '×', better: 'lower', soften: 0.80, minMul: 0.60, maxMul: 1.50 },
  recoilRecovery: { label: 'Recovery', unit: '', better: 'higher', soften: 0.80, minMul: 0.80, maxMul: 1.45, max: 0.95 },

  hipSpread: { label: 'Hipfire', unit: '°', better: 'lower', soften: 0.62, minMul: 0.45, maxMul: 1.90, min: 0.35 },
  adsSpread: { label: 'ADS spread', unit: '°', better: 'lower', soften: 0.70, minMul: 0.35, maxMul: 1.60, min: 0.02 },
  bloomPerShot: { label: 'Bloom', unit: '°', better: 'lower', soften: 0.70, minMul: 0.40, maxMul: 1.80 },
  bloomDecay: { label: 'Bloom decay', unit: '°/s', better: 'higher', soften: 0.80, minMul: 0.70, maxMul: 1.60 },

  magSize: { label: 'Mag', unit: '', better: 'higher', soften: 0.85, minMul: 0.50, maxMul: 2.50, min: 1, max: 250, integer: true },
  reserveAmmo: { label: 'Reserve', unit: '', better: 'higher', soften: 0.85, minMul: 0.50, maxMul: 2.00, min: 0, max: 900, integer: true },
  muzzleVelocity: { label: 'Velocity', unit: 'm/s', better: 'higher', soften: 0.80, minMul: 0.85, maxMul: 1.35 },
  penetration: { label: 'Pierce', unit: '', better: 'higher', soften: 0.80, minMul: 0.70, maxMul: 1.60 },
  falloffRange: { label: 'Range', unit: '×', better: 'higher', soften: 0.70, minMul: 0.78, maxMul: 1.45 },
  damage: { label: 'Damage', unit: '×', better: 'higher', soften: 0.90, minMul: 0.90, maxMul: 1.12 },
  fireRate: { label: 'RPM', unit: '×', better: 'higher', soften: 0.90, minMul: 0.88, maxMul: 1.15 },

  magnification: { label: 'Zoom', unit: '×', better: 'higher', soften: 1, minMul: 1, maxMul: 12, min: 1, max: 12 },
};

/** Structural limits. A mode may widen these through `ValidationContext`. */
export const LIMITS: LoadoutLimits = {
  attachmentsPerWeapon: 5,
  savedClasses: 10,
  killstreaks: 3,
  nameMaxLength: 24,
};

/**
 * Whether a flag is an upside or a downside. The no-free-lunch audit counts a
 * `con` flag as a real cost, which is how a laser (all upside numerically, but
 * a beam that gives your position away) passes the audit honestly.
 */
export const FLAG_SIDE: Record<LoadoutFlag, FlagSide> = {
  suppressed: 'pro',
  noFlash: 'pro',
  loud: 'con',
  laser: 'pro',
  laserVisible: 'con',
  bipod: 'pro',
  thermal: 'pro',
  scavenger: 'pro',
  ghost: 'pro',
  hardline: 'pro',
  overkill: 'pro',
  tacMask: 'pro',
  silentMove: 'pro',
};

export const FLAG_LABEL: Record<LoadoutFlag, string> = {
  suppressed: 'Suppressed',
  noFlash: 'No muzzle flash',
  loud: 'Louder report',
  laser: 'Laser',
  laserVisible: 'Visible beam',
  bipod: 'Bipod',
  thermal: 'Thermal',
  scavenger: 'Scavenger',
  ghost: 'Ghost',
  hardline: 'Hardline',
  overkill: 'Overkill',
  tacMask: 'Tac Mask',
  silentMove: 'Silent movement',
};

/* ------------------------------------------------------------- live tuning */

/**
 * A tuning patch: sparse overrides applied to the data tables at boot, so a
 * balance pass is a JSON blob rather than a rebuild.
 *
 * ```ts
 * applyTuning({
 *   stats: { recoilVertical: { minMul: 0.5 } },
 *   limits: { attachmentsPerWeapon: 6 },
 *   attachments: { muzzle_comp: { recoilVertical: 0.86 } },
 * });
 * ```
 */
export interface TuningPatch {
  stats?: Partial<Record<StatKey, Partial<StatRule>>>;
  limits?: Partial<LoadoutLimits>;
  /** attachment id → stat → new multiplicative value. */
  attachments?: Record<string, Partial<Record<StatKey, number>>>;
  /** perk id → stat → new multiplicative value. */
  perks?: Record<string, Partial<Record<StatKey, number>>>;
}

type MutableStatRule = { -readonly [K in keyof StatRule]: StatRule[K] };

/**
 * Applies the stat-rule and limit halves of a patch in place. The attachment /
 * perk halves are applied by `data/attachments.ts` and `data/perks.ts`, which
 * own those tables; `applyTuningPatch` in `../Tuning.ts` drives all three.
 */
export function applyStatTuning(patch: TuningPatch): string[] {
  const notes: string[] = [];
  if (patch.stats) {
    for (const key of Object.keys(patch.stats) as StatKey[]) {
      const over = patch.stats[key];
      const rule = STAT_RULES[key] as MutableStatRule | undefined;
      if (!over || !rule) continue;
      for (const field of Object.keys(over) as Array<keyof StatRule>) {
        const v = over[field];
        if (v === undefined) continue;
        (rule as Record<string, unknown>)[field] = v;
        notes.push(`stat ${key}.${String(field)} = ${String(v)}`);
      }
    }
  }
  if (patch.limits) {
    for (const field of Object.keys(patch.limits) as Array<keyof LoadoutLimits>) {
      const v = patch.limits[field];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      LIMITS[field] = v;
      notes.push(`limit ${field} = ${v}`);
    }
  }
  return notes;
}
