/**
 * The two curves that define how long everything takes.
 *
 * Both are closed-form so any point can be evaluated without walking a table,
 * which matters because the after-action screen animates a bar between two
 * arbitrary XP values sixty times a second.
 *
 * These are the *authoritative* definitions — `src/game/Progression.ts`
 * re-exports them so the historical import path keeps working.
 */

/* ---------------------------------------------------------- player rank -- */

export const MAX_RANK = 55;

/**
 * Cumulative XP required to *reach* rank `n` (1-indexed; rank 1 costs 0).
 *
 * `900·(n-1)^1.62 + 140·(n-1)` gives ~1040 XP for rank 2 (one good match),
 * ~29k by rank 20 and ~467k at rank 55 — a curve that stays motivating without
 * ever going vertical.
 */
export function xpForRank(n: number): number {
  if (n <= 1) return 0;
  const r = n - 1;
  return Math.round(900 * Math.pow(r, 1.62) + 140 * r);
}

/** XP the player must earn *inside* rank `n` to reach `n + 1`. */
export function xpSpanForRank(n: number): number {
  if (n >= MAX_RANK) return 1;
  return Math.max(1, xpForRank(n + 1) - xpForRank(n));
}

export const RANK_NAMES: readonly string[] = [
  'Recruit', 'Private', 'Private I', 'Private II', 'Specialist',
  'Corporal', 'Corporal I', 'Corporal II', 'Sergeant', 'Sergeant I',
  'Sergeant II', 'Staff Sergeant', 'Staff Sergeant I', 'Staff Sergeant II',
  'Gunnery Sergeant', 'Gunnery Sgt I', 'Gunnery Sgt II', 'Master Sergeant',
  'Master Sgt I', 'Master Sgt II', 'First Sergeant', 'First Sgt I',
  'First Sgt II', 'Sergeant Major', 'Sgt Major I', 'Sgt Major II',
  'Warrant Officer', 'Warrant Officer I', 'Warrant Officer II', 'Chief Warrant',
  'Chief Warrant I', 'Chief Warrant II', 'Second Lieutenant', '2nd Lt I',
  '2nd Lt II', 'First Lieutenant', '1st Lt I', '1st Lt II', 'Captain',
  'Captain I', 'Captain II', 'Major', 'Major I', 'Major II',
  'Lieutenant Colonel', 'Lt Colonel I', 'Lt Colonel II', 'Colonel',
  'Colonel I', 'Colonel II', 'Brigadier General', 'Major General',
  'Lieutenant General', 'General', 'Commander',
];

export function rankName(rank: number): string {
  return RANK_NAMES[Math.max(0, Math.min(RANK_NAMES.length - 1, rank - 1))];
}

/** Rank implied by a total XP figure. Binary search — the curve is monotonic. */
export function rankForXp(xp: number): number {
  if (!(xp > 0)) return 1;
  let lo = 1;
  let hi = MAX_RANK;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= xpForRank(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** XP into the current rank and the span of that rank. */
export function rankProgress(xp: number): { rank: number; into: number; needed: number; pct: number } {
  const rank = rankForXp(xp);
  if (rank >= MAX_RANK) return { rank, into: 1, needed: 1, pct: 1 };
  const base = xpForRank(rank);
  const needed = Math.max(1, xpForRank(rank + 1) - base);
  const into = Math.max(0, xp - base);
  return { rank, into, needed, pct: Math.min(1, into / needed) };
}

/* -------------------------------------------------------- weapon levels -- */

export const WEAPON_MAX_LEVEL = 30;

/**
 * Cumulative weapon XP to *reach* weapon level `n`.
 *
 * `420·(n-1)^1.42 + 260·(n-1)` — level 2 lands inside a single good match
 * (~680 WXP), level 10 around 5.4k, level 30 at ~57.6k. At a typical
 * 1.2–2.5k WXP per match that is roughly 25–45 matches of dedicated use to max
 * one weapon, which is the shape a shipped shooter uses.
 */
export function weaponXpForLevel(n: number): number {
  if (n <= 1) return 0;
  const r = n - 1;
  return Math.round(420 * Math.pow(r, 1.42) + 260 * r);
}

export function weaponLevelForXp(xp: number): number {
  if (!(xp > 0)) return 1;
  let lo = 1;
  let hi = WEAPON_MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= weaponXpForLevel(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function weaponProgressAt(xp: number): { level: number; into: number; needed: number; pct: number; maxed: boolean } {
  const level = weaponLevelForXp(xp);
  if (level >= WEAPON_MAX_LEVEL) {
    return { level, into: 1, needed: 1, pct: 1, maxed: true };
  }
  const base = weaponXpForLevel(level);
  const needed = Math.max(1, weaponXpForLevel(level + 1) - base);
  const into = Math.max(0, xp - base);
  return { level, into, needed, pct: Math.min(1, into / needed), maxed: false };
}

/** Total weapon XP required to fully max a weapon. */
export const WEAPON_XP_TO_MAX = weaponXpForLevel(WEAPON_MAX_LEVEL);
