/**
 * The modifier algebra.
 *
 * This is the file that stops create-a-class from producing absurd guns. Every
 * attachment and perk contributes typed `Modifier`s; this module folds them into
 * one number per stat with rules that are the same for every stat, stated once
 * here and tuned from `data/balance.ts`.
 *
 * ## The rules
 *
 * 1. **Multiplicative modifiers stack with diminishing returns — but only on
 *    the side that helps you.** Sort the beneficial deviations by magnitude,
 *    largest first; the first counts in full, the next at `soften`, the next at
 *    `soften²`. Penalties always count in full. A compensator, an angled grip
 *    and a precision stock on the same gun therefore give roughly
 *    `0.18 + 0.72·0.14 + 0.72²·0.20 ≈ 0.39` of recoil reduction instead of the
 *    naive `1 − 0.82·0.86·0.80 = 0.44`, and every extra recoil attachment after
 *    that is worth less than the last.
 * 2. **Additive modifiers apply after scaling.** `base × factor + Σadd`.
 * 3. **`max` modifiers ignore the base entirely** — optic magnification is the
 *    largest fitted optic, not a product of them.
 * 4. **Everything is clamped**, first to rails relative to the weapon's own base
 *    (so a 0.7 s LMG ADS and a 0.19 s pistol ADS get proportionate limits), then
 *    to absolute rails. Any stat that hits a rail is reported in `capped`, so
 *    the UI can show it and the balance tools can measure how often the rails
 *    are load-bearing.
 * 5. **Order never matters.** Deviations are summed, and the sort is stabilised
 *    by source id, so shuffling the attachment list produces byte-identical
 *    output. Replays, killcams and the netcode layer depend on that.
 */

import type { LoadoutFlag, Modifier, StatKey } from './types';
import { STAT_RULES, type StatRule } from './data/balance';

const EPS = 1e-9;

export interface Contribution {
  /** Attachment or perk id. */
  source: string;
  mode: Modifier['mode'];
  value: number;
  /** How much of the modifier survived diminishing returns, as a deviation. */
  applied: number;
  beneficial: boolean;
}

export interface StatFold {
  stat: StatKey;
  base: number;
  /** Final value after scaling, addition, max-override and clamping. */
  value: number;
  /** The combined multiplicative factor that was applied to `base`. */
  factor: number;
  /** Total of the additive modifiers. */
  addend: number;
  /** True when a rail changed the result. */
  capped: boolean;
  contributions: Contribution[];
}

interface Entry { source: string; value: number }

/**
 * Accumulates modifiers from any number of sources and folds them per stat.
 *
 * Sources are added by id so contributions stay attributable — the armoury can
 * show "−18% recoil from the Compensator" without the resolver knowing what an
 * armoury is.
 */
export class ModifierStack {
  private muls = new Map<StatKey, Entry[]>();
  private adds = new Map<StatKey, Entry[]>();
  private maxes = new Map<StatKey, Entry[]>();
  private flagSet = new Set<LoadoutFlag>();
  private flagOwner = new Map<LoadoutFlag, string>();

  /** Adds every modifier of one source. Adding the same source twice doubles it. */
  add(source: string, mods: readonly Modifier[], flags?: readonly LoadoutFlag[]): void {
    for (const mod of mods) {
      if (!Number.isFinite(mod.value)) continue;
      if (!STAT_RULES[mod.stat]) continue;
      const bucket = mod.mode === 'mul' ? this.muls : mod.mode === 'add' ? this.adds : this.maxes;
      let list = bucket.get(mod.stat);
      if (!list) { list = []; bucket.set(mod.stat, list); }
      list.push({ source, value: mod.value });
    }
    for (const f of flags ?? []) {
      if (!this.flagSet.has(f)) this.flagOwner.set(f, source);
      this.flagSet.add(f);
    }
  }

  has(flag: LoadoutFlag): boolean { return this.flagSet.has(flag); }
  get flags(): LoadoutFlag[] { return [...this.flagSet].sort(); }
  /** Which source granted a flag first — for tooltips. */
  ownerOf(flag: LoadoutFlag): string | null { return this.flagOwner.get(flag) ?? null; }

  /** True when nothing at all touches this stat. */
  untouched(stat: StatKey): boolean {
    return !this.muls.has(stat) && !this.adds.has(stat) && !this.maxes.has(stat);
  }

  /** Folds one stat against a weapon's base value. Pure — safe to call repeatedly. */
  fold(stat: StatKey, base: number): StatFold {
    const rule: StatRule = STAT_RULES[stat];
    const contributions: Contribution[] = [];

    /* --- 1. multiplicative, with one-sided diminishing returns ---------- */
    const muls = this.muls.get(stat) ?? [];
    const good: Array<Entry & { dev: number }> = [];
    let harm = 0;
    for (const e of muls) {
      const dev = e.value - 1;
      if (Math.abs(dev) < EPS) {
        contributions.push({ source: e.source, mode: 'mul', value: e.value, applied: 0, beneficial: false });
        continue;
      }
      const beneficial = rule.better === 'higher' ? dev > 0 : dev < 0;
      if (beneficial) good.push({ ...e, dev });
      else {
        harm += dev;
        contributions.push({ source: e.source, mode: 'mul', value: e.value, applied: dev, beneficial: false });
      }
    }
    // Deterministic order: strongest first, ties broken by source id.
    good.sort((a, b) => (Math.abs(b.dev) - Math.abs(a.dev)) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    let benefit = 0;
    for (let i = 0; i < good.length; i++) {
      const w = Math.pow(rule.soften, i);
      const applied = good[i].dev * w;
      benefit += applied;
      contributions.push({ source: good[i].source, mode: 'mul', value: good[i].value, applied, beneficial: true });
    }
    let factor = 1 + benefit + harm;
    if (factor < 0.05) factor = 0.05;

    /* --- 2. additive ---------------------------------------------------- */
    let addend = 0;
    for (const e of this.adds.get(stat) ?? []) {
      addend += e.value;
      contributions.push({
        source: e.source, mode: 'add', value: e.value, applied: e.value,
        beneficial: rule.better === 'higher' ? e.value > 0 : e.value < 0,
      });
    }

    let value = base * factor + addend;

    /* --- 3. max override ------------------------------------------------ */
    for (const e of this.maxes.get(stat) ?? []) {
      contributions.push({ source: e.source, mode: 'max', value: e.value, applied: e.value, beneficial: true });
      if (e.value > value) value = e.value;
    }

    /* --- 4. rails ------------------------------------------------------- */
    const raw = value;
    value = clampToRule(value, base, rule);
    if (rule.integer) {
      value = Math.round(value);
      value = clampToRule(value, base, rule);
    }
    const capped = Math.abs(value - raw) > Math.max(EPS, Math.abs(raw) * 1e-9);

    return { stat, base, value, factor, addend, capped, contributions };
  }

  /** Convenience: fold and return only the number. */
  value(stat: StatKey, base: number): number {
    return this.fold(stat, base).value;
  }
}

/** Applies the relative rails, then the absolute ones. */
export function clampToRule(value: number, base: number, rule: StatRule): number {
  let v = value;
  if (base > 0) {
    const lo = base * rule.minMul;
    const hi = base * rule.maxMul;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
  }
  if (rule.min !== undefined && v < rule.min) v = rule.min;
  if (rule.max !== undefined && v > rule.max) v = rule.max;
  return v;
}

/**
 * The rails a stat can reach for a given base, as concrete numbers. Used by the
 * verification tool and by any UI that wants to draw a bar with real endpoints.
 */
export function railsFor(stat: StatKey, base: number): { lo: number; hi: number } {
  const rule = STAT_RULES[stat];
  let lo = base > 0 ? base * rule.minMul : -Infinity;
  let hi = base > 0 ? base * rule.maxMul : Infinity;
  if (rule.min !== undefined) lo = Math.max(lo, rule.min);
  if (rule.max !== undefined) hi = Math.min(hi, rule.max);
  return { lo, hi };
}
