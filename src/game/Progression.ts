/**
 * Persistent progression: XP, rank curve, unlocks and lifetime stats.
 *
 * The curve is tuned to the shape players expect from a modern military
 * shooter: the first handful of ranks fall in a couple of matches, the middle
 * band stretches out, and the last ranks are a grind. Everything is stored in
 * one localStorage blob and every write is defensive — a corrupt or absent
 * store simply yields a fresh profile.
 */

import type { Emitter } from './Services';
import type { MatchSummary, UnlockDef } from './types';

const STORAGE_KEY = 'blackout.profile.v2';
export const MAX_RANK = 55;

/* ------------------------------------------------------------ rank curve -- */

/**
 * Cumulative XP required to *reach* rank `n` (1-indexed; rank 1 costs 0).
 *
 * `900·(n-1)^1.62` gives ~900 XP for rank 2 (one good match), ~28k by rank 20
 * and ~460k at rank 55 — a curve that stays motivating without ever going
 * vertical.
 */
export function xpForRank(n: number): number {
  if (n <= 1) return 0;
  const r = n - 1;
  return Math.round(900 * Math.pow(r, 1.62) + 140 * r);
}

const RANK_NAMES: readonly string[] = [
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

/** Rank implied by a total XP figure. */
export function rankForXp(xp: number): number {
  let r = 1;
  while (r < MAX_RANK && xp >= xpForRank(r + 1)) r++;
  return r;
}

/* --------------------------------------------------------------- unlocks -- */

/**
 * Unlock table. Weapons gate on rank; attachments gate on rank and are scoped
 * to a parent weapon so the armoury UI can group them.
 */
export const UNLOCKS: readonly UnlockDef[] = [
  { id: 'ar_vector', name: 'VKR-7 Assault Rifle', kind: 'weapon', rank: 1 },
  { id: 'smg_wasp', name: 'WASP-9 SMG', kind: 'weapon', rank: 2 },
  { id: 'atc_reflex', name: 'Reflex Sight', kind: 'attachment', rank: 3, parent: 'ar_vector' },
  { id: 'perk_scavenger', name: 'Scavenger', kind: 'perk', rank: 4 },
  { id: 'sg_breach', name: 'BR-12 Breacher', kind: 'weapon', rank: 5 },
  { id: 'atc_foregrip', name: 'Vertical Foregrip', kind: 'attachment', rank: 6, parent: 'ar_vector' },
  { id: 'ks_uav', name: 'UAV Recon', kind: 'killstreak', rank: 6 },
  { id: 'atc_suppressor', name: 'Suppressor', kind: 'attachment', rank: 8, parent: 'smg_wasp' },
  { id: 'dmr_lynx', name: 'LYNX DMR', kind: 'weapon', rank: 9 },
  { id: 'perk_ghost', name: 'Ghost', kind: 'perk', rank: 10 },
  { id: 'ks_carepackage', name: 'Care Package', kind: 'killstreak', rank: 11 },
  { id: 'atc_holo', name: 'Holographic Sight', kind: 'attachment', rank: 12, parent: 'smg_wasp' },
  { id: 'lmg_bison', name: 'BISON LMG', kind: 'weapon', rank: 14 },
  { id: 'atc_extmag', name: 'Extended Mag', kind: 'attachment', rank: 15, parent: 'ar_vector' },
  { id: 'ks_counteruav', name: 'Counter-UAV', kind: 'killstreak', rank: 16 },
  { id: 'perk_hardline', name: 'Hardline', kind: 'perk', rank: 18 },
  { id: 'sr_kestrel', name: 'KESTREL Sniper', kind: 'weapon', rank: 20 },
  { id: 'atc_thermal', name: 'Thermal Scope', kind: 'attachment', rank: 22, parent: 'sr_kestrel' },
  { id: 'ks_airstrike', name: 'Precision Airstrike', kind: 'killstreak', rank: 24 },
  { id: 'atc_compensator', name: 'Compensator', kind: 'attachment', rank: 26, parent: 'lmg_bison' },
  { id: 'perk_stalker', name: 'Stalker', kind: 'perk', rank: 28 },
  { id: 'smg_viper', name: 'VIPER-45 SMG', kind: 'weapon', rank: 30 },
  { id: 'ks_sentry', name: 'Sentry Turret', kind: 'killstreak', rank: 32 },
  { id: 'atc_laser', name: 'Tactical Laser', kind: 'attachment', rank: 34, parent: 'smg_viper' },
  { id: 'ar_talon', name: 'TALON-6 Assault Rifle', kind: 'weapon', rank: 38 },
  { id: 'perk_overkill', name: 'Overkill', kind: 'perk', rank: 42 },
  { id: 'atc_heavybarrel', name: 'Heavy Barrel', kind: 'attachment', rank: 46, parent: 'ar_talon' },
  { id: 'sr_apex', name: 'APEX .50 Anti-Materiel', kind: 'weapon', rank: 50 },
  { id: 'perk_tacmask', name: 'Tac Mask', kind: 'perk', rank: 55 },
];

export function unlocksForRank(rank: number): UnlockDef[] {
  return UNLOCKS.filter((u) => u.rank === rank);
}

export function unlockedAt(rank: number): UnlockDef[] {
  return UNLOCKS.filter((u) => u.rank <= rank);
}

/* --------------------------------------------------------------- profile -- */

export interface LifetimeStats {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  bestStreak: number;
  wavesCleared: number;
  objectives: number;
  timePlayed: number;
  killstreaksUsed: number;
}

export interface Profile {
  version: 2;
  xp: number;
  rank: number;
  stats: LifetimeStats;
  /** Ids unlocked beyond the rank table (care-package rewards, challenges). */
  extraUnlocks: string[];
  /** Last mode played, restored by the front end. */
  lastMode: string;
}

function emptyStats(): LifetimeStats {
  return {
    matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, assists: 0,
    bestStreak: 0, wavesCleared: 0, objectives: 0, timePlayed: 0, killstreaksUsed: 0,
  };
}

export function defaultProfile(): Profile {
  return { version: 2, xp: 0, rank: 1, stats: emptyStats(), extraUnlocks: [], lastMode: 'operation' };
}

/** XP awards. Kept in one table so tuning is a single-file change. */
export const XP = {
  kill: 100,
  headshotBonus: 50,
  longshotBonus: 40,
  assist: 30,
  execution: 75,
  objectiveTick: 15,
  objectiveComplete: 250,
  waveCleared: 400,
  survivedWave: 120,
  killstreakKill: 60,
  multikill2: 60,
  multikill3: 140,
  multikill4: 260,
  multikill5: 420,
  streakStep: 45,
  matchWin: 750,
  matchLoss: 250,
  revive: 150,
} as const;

/**
 * Owns the persisted profile and the in-match XP ledger. The ledger is applied
 * to the profile only when the match ends, so an abandoned match awards nothing
 * — the same rule shipped shooters use.
 */
export class Progression {
  profile: Profile = defaultProfile();
  /** XP accumulated this match, by reason, in insertion order. */
  private ledger = new Map<string, number>();
  private ledgerTotal = 0;

  constructor(private emit: Emitter, private storage: Storage | null = safeStorage()) { }

  load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<Profile>;
      const p = defaultProfile();
      if (typeof data.xp === 'number' && Number.isFinite(data.xp)) p.xp = Math.max(0, data.xp);
      if (Array.isArray(data.extraUnlocks)) p.extraUnlocks = data.extraUnlocks.filter((s) => typeof s === 'string');
      if (typeof data.lastMode === 'string') p.lastMode = data.lastMode;
      if (data.stats && typeof data.stats === 'object') {
        const s = data.stats as Partial<LifetimeStats>;
        const base = emptyStats();
        for (const k of Object.keys(base) as Array<keyof LifetimeStats>) {
          const v = s[k];
          if (typeof v === 'number' && Number.isFinite(v)) base[k] = v;
        }
        p.stats = base;
      }
      p.rank = rankForXp(p.xp);
      this.profile = p;
    } catch { /* corrupt store — keep the fresh profile */ }
  }

  save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.profile)); } catch { /* quota / private mode */ }
  }

  reset(): void {
    this.profile = defaultProfile();
    this.save();
  }

  /* ------------------------------------------------------------- ledger -- */

  beginMatch(mode: string): void {
    this.ledger.clear();
    this.ledgerTotal = 0;
    this.profile.lastMode = mode;
  }

  /** Records XP for the current match and announces it. */
  award(amount: number, reason: string): void {
    if (amount <= 0) return;
    const a = Math.round(amount);
    this.ledger.set(reason, (this.ledger.get(reason) ?? 0) + a);
    this.ledgerTotal += a;
    this.emit('xp:award', { amount: a, reason, total: this.ledgerTotal });
  }

  get matchXp(): number { return this.ledgerTotal; }
  get rank(): number { return this.profile.rank; }
  get xp(): number { return this.profile.xp; }

  /** XP into the current rank and the amount needed for the next one. */
  progressInRank(): { into: number; needed: number } {
    const r = this.profile.rank;
    if (r >= MAX_RANK) return { into: 1, needed: 1 };
    const base = xpForRank(r);
    const next = xpForRank(r + 1);
    return { into: Math.max(0, this.profile.xp - base), needed: Math.max(1, next - base) };
  }

  /** Ledger rows for the post-match screen, biggest first. */
  ledgerRows(): Array<{ label: string; xp: number }> {
    return [...this.ledger.entries()]
      .map(([label, xp]) => ({ label, xp }))
      .sort((a, b) => b.xp - a.xp);
  }

  /**
   * Commits the match: banks XP, promotes, grants unlocks and persists.
   * Returns the unlocks earned so the summary can list them.
   */
  commit(win: boolean, stats: Partial<LifetimeStats>): UnlockDef[] {
    this.award(win ? XP.matchWin : XP.matchLoss, win ? 'Match Win' : 'Match Complete');

    const before = this.profile.rank;
    this.profile.xp += this.ledgerTotal;
    const after = rankForXp(this.profile.xp);
    this.profile.rank = after;

    const granted: UnlockDef[] = [];
    for (let r = before + 1; r <= after; r++) {
      this.emit('rank:up', { rank: r, name: rankName(r), total: this.profile.xp });
      for (const u of unlocksForRank(r)) {
        granted.push(u);
        this.emit('unlock:granted', u);
      }
    }

    const s = this.profile.stats;
    s.matches++;
    if (win) s.wins++;
    s.kills += stats.kills ?? 0;
    s.deaths += stats.deaths ?? 0;
    s.headshots += stats.headshots ?? 0;
    s.assists += stats.assists ?? 0;
    s.wavesCleared += stats.wavesCleared ?? 0;
    s.objectives += stats.objectives ?? 0;
    s.timePlayed += stats.timePlayed ?? 0;
    s.killstreaksUsed += stats.killstreaksUsed ?? 0;
    s.bestStreak = Math.max(s.bestStreak, stats.bestStreak ?? 0);

    this.save();
    return granted;
  }

  /** True when an id is available to the player right now. */
  isUnlocked(id: string): boolean {
    if (this.profile.extraUnlocks.includes(id)) return true;
    const def = UNLOCKS.find((u) => u.id === id);
    return !!def && def.rank <= this.profile.rank;
  }

  grantExtra(id: string): void {
    if (this.profile.extraUnlocks.includes(id)) return;
    this.profile.extraUnlocks.push(id);
    const def = UNLOCKS.find((u) => u.id === id);
    if (def) this.emit('unlock:granted', def);
    this.save();
  }

  /** Fills the progression block of a match summary. */
  decorateSummary(summary: MatchSummary, unlocked: UnlockDef[]): void {
    const p = this.progressInRank();
    summary.xpEarned = this.ledgerTotal;
    summary.rankAfter = this.profile.rank;
    summary.rankName = rankName(this.profile.rank);
    summary.xpIntoRank = p.into;
    summary.xpForNext = p.needed;
    summary.unlocked = unlocked;
  }
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Probe once — Safari private mode throws on write, not on access.
    s.setItem('blackout.probe', '1');
    s.removeItem('blackout.probe');
    return s;
  } catch { return null; }
}
