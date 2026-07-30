/**
 * Versioned profile persistence.
 *
 * Rules that keep a profile alive across builds:
 *
 *  1. **Every field is coerced, never trusted.** A corrupt value falls back to
 *     its default; it does not discard the rest of the profile. The v2 loader
 *     threw the whole profile away on a single bad number — that is the failure
 *     mode this replaces.
 *  2. **Old keys are never deleted.** v3 writes to `blackout.profile.v3` and
 *     leaves `blackout.profile.v2` in place, so rolling the build back does not
 *     wipe the player.
 *  3. **A backup is taken before the first migrating write**, under
 *     `blackout.profile.backup.v<n>`, raw text, untouched.
 *  4. **A future-version blob is loaded read-only.** If a player runs an older
 *     build after a newer one, we render what we can and refuse to overwrite.
 */

import { rankForXp } from './Curves';
import { weaponLevelForXp } from './Curves';
import { emptyWeaponStats } from './Challenges';
import { ALL_CAMOS } from './Camos';
import { WEAPON_TRACKS } from './WeaponTracks';
import type {
  ChallengeState, LifetimeStatsV3, MatchHistoryEntry, PersonalBests,
  ProfileV3, WeaponProgress,
} from './types';

export const PROFILE_VERSION = 3;
export const PROFILE_KEY = 'blackout.profile.v3';
/** Read in order, newest first. Nothing here is ever removed. */
export const LEGACY_KEYS: readonly string[] = ['blackout.profile.v2', 'blackout.profile'];
export const BACKUP_PREFIX = 'blackout.profile.backup.';
export const MAX_HISTORY = 25;

const CAMO_IDS = new Set(ALL_CAMOS.map((c) => c.id));

/* ---------------------------------------------------------- constructors -- */

export function emptyLifetime(): LifetimeStatsV3 {
  return {
    matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, assists: 0,
    bestStreak: 0, wavesCleared: 0, objectives: 0, timePlayed: 0, killstreaksUsed: 0,
    losses: 0, shotsFired: 0, shotsHit: 0, score: 0, longshots: 0,
    revengeKills: 0, firstBloods: 0, bestMultikill: 0, multikills: 0,
  };
}

export function emptyBests(): PersonalBests {
  return { kills: 0, score: 0, streak: 0, multikill: 0, headshots: 0, accuracy: 0, xp: 0 };
}

export function newWeaponProgress(id: string): WeaponProgress {
  return { id, xp: 0, level: 1, stats: emptyWeaponStats(), camos: [] };
}

export function defaultProfileV3(now = Date.now()): ProfileV3 {
  const weapons: Record<string, WeaponProgress> = {};
  for (const t of WEAPON_TRACKS) weapons[t.id] = newWeaponProgress(t.id);
  return {
    version: PROFILE_VERSION,
    createdAt: now,
    updatedAt: now,
    xp: 0,
    rank: 1,
    stats: emptyLifetime(),
    extraUnlocks: [],
    lastMode: 'operation',
    weapons,
    challenges: {},
    bests: emptyBests(),
    history: [],
  };
}

/** Adds any weapon track that did not exist when the profile was written. */
export function ensureWeapons(p: ProfileV3): void {
  for (const t of WEAPON_TRACKS) {
    if (!p.weapons[t.id]) p.weapons[t.id] = newWeaponProgress(t.id);
  }
}

/* -------------------------------------------------------------- coercion -- */

function num(v: unknown, fallback = 0, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 && v.length < 128 ? v : fallback;
}
function bool(v: unknown): boolean { return v === true; }
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function coerceLifetime(raw: unknown): LifetimeStatsV3 {
  const src = obj(raw);
  const out = emptyLifetime();
  for (const k of Object.keys(out) as Array<keyof LifetimeStatsV3>) {
    out[k] = num(src[k], 0);
  }
  return out;
}

function coerceBests(raw: unknown): PersonalBests {
  const src = obj(raw);
  const out = emptyBests();
  for (const k of Object.keys(out) as Array<keyof PersonalBests>) out[k] = num(src[k], 0);
  out.accuracy = Math.min(1, out.accuracy);
  return out;
}

function coerceWeapon(id: string, raw: unknown): WeaponProgress {
  const src = obj(raw);
  const w = newWeaponProgress(id);
  w.xp = num(src.xp, 0);
  const stats = obj(src.stats);
  for (const k of Object.keys(w.stats) as Array<keyof typeof w.stats>) {
    w.stats[k] = num(stats[k], 0);
  }
  if (Array.isArray(src.camos)) {
    w.camos = src.camos.filter((c): c is string => typeof c === 'string' && CAMO_IDS.has(c));
  }
  // Level is always derived; a hand-edited level cannot outrun the XP curve.
  w.level = weaponLevelForXp(w.xp);
  return w;
}

function coerceChallenges(raw: unknown): Record<string, ChallengeState> {
  const src = obj(raw);
  const out: Record<string, ChallengeState> = {};
  for (const key of Object.keys(src)) {
    if (key.length > 96) continue;
    const c = obj(src[key]);
    out[key] = {
      progress: num(c.progress, 0),
      done: bool(c.done),
      doneAt: num(c.doneAt, 0),
    };
  }
  return out;
}

function coerceHistory(raw: unknown): MatchHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MatchHistoryEntry[] = [];
  for (const e of raw.slice(0, MAX_HISTORY)) {
    const h = obj(e);
    out.push({
      mode: str(h.mode, 'operation'),
      win: bool(h.win),
      kills: num(h.kills, 0),
      deaths: num(h.deaths, 0),
      score: num(h.score, 0),
      xp: num(h.xp, 0),
      durationSec: num(h.durationSec, 0),
      at: num(h.at, 0),
    });
  }
  return out;
}

/**
 * Turns anything at all into a valid v3 profile. Handles v1 (no version field),
 * v2 and v3 blobs; unknown shapes degrade to a fresh profile without throwing.
 */
export function coerceProfile(raw: unknown, now = Date.now()): ProfileV3 {
  const src = obj(raw);
  const p = defaultProfileV3(now);

  p.xp = num(src.xp, 0);
  p.stats = coerceLifetime(src.stats);
  p.lastMode = str(src.lastMode, p.lastMode);
  p.createdAt = num(src.createdAt, now, 0) || now;
  p.updatedAt = num(src.updatedAt, now, 0) || now;
  p.bests = coerceBests(src.bests);
  p.challenges = coerceChallenges(src.challenges);
  p.history = coerceHistory(src.history);

  if (Array.isArray(src.extraUnlocks)) {
    p.extraUnlocks = src.extraUnlocks.filter(
      (s): s is string => typeof s === 'string' && s.length > 0 && s.length < 96,
    );
  }

  const weapons = obj(src.weapons);
  for (const id of Object.keys(weapons)) {
    if (id.length > 64) continue;
    p.weapons[id] = coerceWeapon(id, weapons[id]);
  }
  ensureWeapons(p);

  /* v1/v2 profiles carry no losses column — derive it so the win rate is right. */
  if (p.stats.losses === 0 && p.stats.matches > p.stats.wins) {
    p.stats.losses = p.stats.matches - p.stats.wins;
  }
  p.stats.bestMultikill = Math.max(p.stats.bestMultikill, p.bests.multikill);
  p.bests.kills = Math.max(p.bests.kills, 0);

  // Rank is always derived from XP: it can never disagree with the curve.
  p.rank = rankForXp(p.xp);
  return p;
}

/* ------------------------------------------------------------------ i/o -- */

export interface LoadResult {
  profile: ProfileV3;
  /** Key the profile came from, or null for a fresh one. */
  source: string | null;
  /** Version found on disk before migration. */
  foundVersion: number;
  migrated: boolean;
  /** True when the stored blob is newer than this build understands. */
  readOnly: boolean;
}

function readJson(storage: Storage, key: string): { raw: string; data: unknown } | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return { raw, data: JSON.parse(raw) as unknown };
  } catch { return null; }
}

export function loadProfile(storage: Storage | null, now = Date.now()): LoadResult {
  const fresh: LoadResult = {
    profile: defaultProfileV3(now), source: null, foundVersion: 0, migrated: false, readOnly: false,
  };
  if (!storage) return fresh;

  for (const key of [PROFILE_KEY, ...LEGACY_KEYS]) {
    const found = readJson(storage, key);
    if (!found) continue;

    const version = num(obj(found.data).version, key === PROFILE_KEY ? PROFILE_VERSION : 1, 0);
    const profile = coerceProfile(found.data, now);

    if (version > PROFILE_VERSION) {
      // A newer build wrote this. Show it, never overwrite it.
      return { profile, source: key, foundVersion: version, migrated: false, readOnly: true };
    }

    const migrated = version < PROFILE_VERSION;
    if (migrated) {
      try {
        const backupKey = `${BACKUP_PREFIX}v${version}`;
        if (!storage.getItem(backupKey)) storage.setItem(backupKey, found.raw);
      } catch { /* quota — the original key is still intact, which is what matters */ }
    }
    return { profile, source: key, foundVersion: version, migrated, readOnly: false };
  }
  return fresh;
}

export function saveProfile(storage: Storage | null, profile: ProfileV3, now = Date.now()): boolean {
  if (!storage) return false;
  profile.updatedAt = now;
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    // Quota or private mode. Drop history (the largest optional block) and retry
    // once so the parts that matter still land.
    try {
      const trimmed: ProfileV3 = { ...profile, history: profile.history.slice(0, 3) };
      storage.setItem(PROFILE_KEY, JSON.stringify(trimmed));
      profile.history = trimmed.history;
      return true;
    } catch { return false; }
  }
}

/** In-memory `Storage` shim — used by the headless verifier and by self-tests. */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    key(i: number) { return [...map.keys()][i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  } as Storage;
}
