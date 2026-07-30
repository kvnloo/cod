/**
 * Progression — the runtime face of `src/session/progression/`.
 *
 * This file owns the *instance* the match talks to. Everything it decides is
 * computed by the pure modules under `src/session/progression/`:
 *
 *   Curves        rank + weapon-level curves
 *   WeaponTracks  weapon XP, per-weapon attachment ladders
 *   Challenges    challenge/camo criteria evaluated from lifetime stats
 *   Unlocks       the three unlock gates (rank, weapon level, explicit grants)
 *   Session       the in-match ledger
 *   Tracker       bus events → ledger, with zero edits to gameplay code
 *   Commit        the one place a match becomes permanent progress
 *   Store         versioned localStorage persistence with migration
 *   Record        the lifetime combat record
 *
 * Authority. Progression never assumes it may bank XP. With no net port it
 * behaves as an offline host (single player). With `authority: 'client'` a
 * committed match produces a *provisional* report for the after-action screen,
 * submits the raw record to the host, and banks nothing until the host's report
 * comes back. `src/net/` is being built in parallel — the seam is
 * `ProgressionNetPort` in `src/session/progression/types.ts` and nothing here
 * reaches into `src/net/`.
 *
 * The legacy surface (`award`, `commit`, `ledgerRows`, `progressInRank`,
 * `decorateSummary`, `UNLOCKS`, `XP`, `rankName`, …) is preserved verbatim so
 * `Match`, `Scoring` and the loadout validator keep working unchanged.
 */

import type { Emitter } from './Services';
import type { MatchSummary, UnlockDef } from './types';

import '../session/progression/events';

import {
  MAX_RANK, RANK_NAMES, WEAPON_MAX_LEVEL, WEAPON_XP_TO_MAX,
  rankForXp, rankName, rankProgress, weaponLevelForXp, weaponProgressAt, xpForRank,
} from '../session/progression/Curves';
import {
  DEFAULT_ATTACHMENTS, WEAPON_TRACKS, WXP, attachmentsAtLevel, isTrackedWeapon,
  weaponTrack,
} from '../session/progression/WeaponTracks';
import {
  LEGACY_ALIAS, UNLOCKS, availableAttachments, canAttach, canEquipWeapon,
  nextRankUnlock, unlockDef, unlockedAt, unlockedWeapons, unlocksForRank,
  weaponRankGate, type UnlockQuery,
} from '../session/progression/Unlocks';
import {
  CHALLENGES, camoProgressFor, challengeDef, challengesForWeapon,
} from '../session/progression/Challenges';
import { ALL_CAMOS, BASE_CAMO_IDS } from '../session/progression/Camos';
import {
  MAX_HISTORY, PROFILE_KEY, PROFILE_VERSION, ensureWeapons, defaultProfileV3,
  loadProfile, newWeaponProgress, saveProfile,
} from '../session/progression/Store';
import { MatchSession } from '../session/progression/Session';
import { MatchEventTracker, TRACKER_XP } from '../session/progression/Tracker';
import { commitMatch, previewMatch, type CommitResult } from '../session/progression/Commit';
import { buildCombatRecord, recordHeadline } from '../session/progression/Record';
import { busPort } from '../session/progression/Bus';
import type {
  AfterActionReport, CamoDef, ChallengeDef, ChallengeState, CombatRecord,
  EventPort, LifetimeStatsV3, MatchHistoryEntry, MatchRecord, ProfileV3,
  ProgressionAuthority, ProgressionNetPort, WeaponClassId, WeaponProgress,
} from '../session/progression/types';

/* ------------------------------------------------------------ re-exports -- */

export {
  MAX_RANK, RANK_NAMES, WEAPON_MAX_LEVEL, WEAPON_XP_TO_MAX, UNLOCKS, CHALLENGES,
  ALL_CAMOS, BASE_CAMO_IDS, WEAPON_TRACKS, DEFAULT_ATTACHMENTS, MAX_HISTORY,
  PROFILE_KEY, PROFILE_VERSION, TRACKER_XP, WXP,
  rankForXp, rankName, rankProgress, xpForRank, weaponLevelForXp, weaponProgressAt,
  weaponTrack, weaponRankGate, unlockedAt, unlocksForRank, unlockDef,
  challengeDef, challengesForWeapon, recordHeadline, buildCombatRecord,
  defaultProfileV3,
};

export type {
  AfterActionReport, CombatRecord, MatchRecord, ProfileV3, ProgressionNetPort,
  WeaponProgress, WeaponClassId,
};

/** The persisted profile. `Profile` is the historical name for it. */
export type Profile = ProfileV3;
/** Lifetime counters. `LifetimeStats` is the historical name for it. */
export type LifetimeStats = LifetimeStatsV3;

/** Historical alias — the v3 default profile. */
export function defaultProfile(): Profile { return defaultProfileV3(); }

/**
 * Match XP awards. Kept here (not in the data layer) because this is the table
 * gameplay code tunes against; `src/game/Scoring.ts` and `src/game/Match.ts`
 * both read it.
 */
export const XP = {
  kill: 100,
  headshotBonus: 50,
  longshotBonus: 40,
  assist: 30,
  execution: 75,
  /** Paid by the tracker, per 10% of an objective captured. */
  objectiveTick: TRACKER_XP.captureTick,
  objectiveComplete: 250,
  /** Paid by the tracker on `wave:cleared`. */
  waveCleared: TRACKER_XP.waveCleared,
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
  firstBlood: TRACKER_XP.firstBlood,
  revenge: TRACKER_XP.revenge,
  pointBlank: TRACKER_XP.pointblank,
} as const;

/* ------------------------------------------------------------ read model -- */

/** One row of the armoury list. Everything a weapon card needs. */
export interface ArmouryRow {
  id: string;
  name: string;
  cls: WeaponClassId;
  /** Rank required to equip it. */
  rankGate: number;
  /** False when the rank gate is not met. */
  unlocked: boolean;
  level: number;
  xp: number;
  intoLevel: number;
  forNext: number;
  pct: number;
  maxed: boolean;
  kills: number;
  headshots: number;
  accuracy: number;
  /** Number of camos earned on this weapon. */
  camos: number;
  camoIds: string[];
  /** Attachments available right now. */
  attachments: number;
}

/** One row of the challenge list. */
export interface ChallengeRow {
  def: ChallengeDef;
  id: string;
  name: string;
  description: string;
  progress: number;
  goal: number;
  pct: number;
  done: boolean;
  xp: number;
  weapon?: string;
}

export interface BeginMatchOptions {
  modeName?: string;
  seed?: number;
}

/**
 * Everything the meta screens need in one read, so the UI never reaches into
 * the profile. What to render where:
 *
 *   • **Lobby / barracks card** — `rank`, `rankName`, `pct` bar with
 *     `intoRank`/`forNext`, `headline`, and `nextUnlock` + `xpToNextUnlock`
 *     as the "next reward" strip.
 *   • **Challenge widget** — `challenges` (already sorted: closest to done
 *     first), showing `progress`/`goal` and a bar from `pct`.
 *   • **Recent matches** — `history`, newest first: mode, W/L, K/D, XP.
 *   • **Armoury grid** — `Progression.armoury()`; grey out `unlocked === false`
 *     and show "Rank {rankGate}" on the tile.
 *   • **Weapon detail** — `Progression.camoProgress(id)` and
 *     `Progression.challengeRows({ weapon: id })`.
 *   • **Combat record page** — `Progression.combatRecord()`.
 *   • **After-action screen** — `Progression.afterAction()`, or listen for
 *     `progression:afteraction`. Render `xp.rows` as the counting-up list,
 *     `xp.byCategory` as the subtotal block, then the rank bar, then weapons,
 *     challenges, camos and `personalBests`. If `provisional` is true the host
 *     has not confirmed yet — render it dimmed/pending, it will be re-emitted.
 */
export interface ProgressionView {
  rank: number;
  rankName: string;
  xp: number;
  intoRank: number;
  forNext: number;
  pct: number;
  maxed: boolean;
  /** One-line summary: rank · K/D · win rate · favourite weapon. */
  headline: string;
  nextUnlock: UnlockDef | null;
  /** Lifetime XP still to earn before `nextUnlock` lands. */
  xpToNextUnlock: number;
  challengesComplete: number;
  challengesTotal: number;
  camosUnlocked: number;
  /** Closest-to-done first, capped. */
  challenges: ChallengeRow[];
  history: readonly MatchHistoryEntry[];
  /** True while a committed match is waiting on the host's XP figure. */
  awaitingHost: boolean;
}

/* --------------------------------------------------------------- system -- */

export class Progression {
  profile: ProfileV3 = defaultProfileV3();

  /** The in-match ledger. Public so a killcam/scoreboard can read it live. */
  readonly session = new MatchSession();
  /** Bus → ledger bridge. Public so a host can drive it from network kills. */
  readonly tracker: MatchEventTracker;

  /** Double-XP weekends, playlist bonuses, Operation modifiers. */
  xpMultiplier = 1;

  /** True when a newer build wrote the store — we display it but never save. */
  readOnly = false;

  private report: AfterActionReport | null = null;
  private pending: MatchRecord | null = null;
  private net: ProgressionNetPort | null = null;
  private netOff: (() => void) | null = null;
  private matchStartMs = 0;
  private inMatch = false;

  constructor(
    private emit: Emitter,
    private storage: Storage | null = safeStorage(),
    private port: EventPort | null = null,
  ) {
    this.tracker = new MatchEventTracker(this.session, this, this.port ?? lazyBusPort());
  }

  /* ---------------------------------------------------------- lifecycle -- */

  /** Swap the backing store; `null` makes the profile purely in-memory. */
  setStorage(storage: Storage | null): void { this.storage = storage; }

  /**
   * Attaches the netcode seam. Pass `null` to go back to offline-host
   * behaviour. Safe to call at any time; a pending match survives the swap.
   */
  setNetPort(net: ProgressionNetPort | null): void {
    this.netOff?.();
    this.netOff = null;
    this.net = net;
    if (net?.onMatchReport) {
      this.netOff = net.onMatchReport((r) => { this.applyHostReport(r); });
    }
  }

  get authority(): ProgressionAuthority { return this.net?.authority ?? 'host'; }
  /** True when a committed match is waiting for the host to confirm its XP. */
  get awaitingHost(): boolean { return this.pending !== null; }

  load(): void {
    const res = loadProfile(this.storage);
    this.profile = res.profile;
    this.readOnly = res.readOnly;
    ensureWeapons(this.profile);
    this.emit('progression:profile:loaded', {
      rank: this.profile.rank,
      xp: this.profile.xp,
      foundVersion: res.foundVersion,
      migrated: res.migrated,
      readOnly: res.readOnly,
    });
  }

  save(): void {
    if (this.readOnly) return;
    saveProfile(this.storage, this.profile);
  }

  reset(): void {
    this.profile = defaultProfileV3();
    this.readOnly = false;
    this.report = null;
    this.pending = null;
    this.save();
  }

  /** Releases bus subscriptions. Call when the match system is torn down. */
  dispose(): void {
    this.tracker.detach();
    this.netOff?.();
    this.netOff = null;
  }

  /* -------------------------------------------------------------- match -- */

  beginMatch(mode: string, opts: BeginMatchOptions = {}): void {
    this.session.begin(mode, opts.modeName ?? modeLabel(mode), opts.seed ?? 0);
    this.tracker.detach();
    this.tracker.reset();
    this.tracker.attach();
    this.report = null;
    this.pending = null;
    this.inMatch = true;
    this.matchStartMs = Date.now();
    this.profile.lastMode = mode;
  }

  /** Leaves a match without banking anything — the shipped-shooter rule. */
  abandonMatch(): void {
    this.tracker.detach();
    this.tracker.reset();
    this.session.begin(this.session.mode, this.session.modeName, this.session.seed);
    this.inMatch = false;
    this.pending = null;
    this.report = null;
  }

  /** Records XP for the current match and announces it. */
  award(amount: number, reason: string): void {
    if (!(amount > 0)) return;
    const a = Math.round(amount);
    this.session.noteXp(a, reason);
    this.emit('xp:award', { amount: a, reason, total: this.session.xpTotal });
  }

  /** The weapon kills are attributed to. Driven by `weapon:switch` normally. */
  setActiveWeapon(id: string): void { this.session.setActiveWeapon(id); }

  get matchXp(): number { return this.session.xpTotal; }
  get rank(): number { return this.profile.rank; }
  get xp(): number { return this.profile.xp; }
  get inMatchNow(): boolean { return this.inMatch; }

  /** XP into the current rank and the amount needed for the next one. */
  progressInRank(): { into: number; needed: number } {
    const p = rankProgress(this.profile.xp);
    return { into: p.into, needed: p.needed };
  }

  /** Ledger rows for the post-match screen, biggest first. */
  ledgerRows(): Array<{ label: string; xp: number; count: number }> {
    return this.session.ledger().map((r) => ({ label: r.label, xp: r.xp, count: r.count }));
  }

  /**
   * Commits the match. On a host (or offline) this banks XP, promotes, levels
   * weapons, evaluates challenges and persists; on a client it produces a
   * provisional report and submits the record instead.
   *
   * Returns the rank unlocks earned, so the legacy summary can list them.
   */
  commit(win: boolean, stats: Partial<LifetimeStatsV3> = {}): UnlockDef[] {
    // Match-completion XP is part of the ledger, so award it before freezing.
    this.award(win ? XP.matchWin : XP.matchLoss, win ? 'Match Win' : 'Match Complete');

    this.mergeLegacyStats(stats);
    const duration = stats.timePlayed && stats.timePlayed > 0
      ? stats.timePlayed
      : Math.max(1, Math.round((Date.now() - this.matchStartMs) / 1000));

    const record = this.session.toRecord(win, duration);
    this.tracker.detach();
    this.inMatch = false;

    if (this.authority === 'client') {
      this.report = previewMatch(this.profile, record, { multiplier: this.xpMultiplier });
      this.pending = record;
      this.net?.submitMatchResult?.(record);
      this.emit('progression:afteraction', this.report);
      return [];
    }

    const res = commitMatch(this.profile, record, { multiplier: this.xpMultiplier });
    this.report = res.report;
    this.publish(res);
    this.save();
    return res.unlocks;
  }

  /** The last after-action report, or `null` before the first commit. */
  afterAction(): AfterActionReport | null { return this.report; }

  /**
   * Host → client: the authoritative report lands. The local record is still
   * used for stats, weapon XP and challenges (those are derived from what the
   * player did), but the *XP figure* is the host's.
   */
  private applyHostReport(report: AfterActionReport): void {
    const record = this.pending;
    this.pending = null;

    if (!record) {
      report.provisional = false;
      this.report = report;
      this.emit('progression:afteraction', report);
      return;
    }

    const xpBefore = this.profile.xp;
    const rankBefore = this.profile.rank;
    const res = commitMatch(this.profile, record, { multiplier: this.xpMultiplier });

    // Rebase onto the host's number, then re-derive rank from the profile.
    const delta = Math.round(report.xp.total) - res.report.xp.total;
    this.profile.xp = Math.max(0, this.profile.xp + delta);
    this.profile.rank = rankForXp(this.profile.xp);

    const rp = rankProgress(this.profile.xp);
    report.provisional = false;
    report.rank.before = rankBefore;
    report.rank.after = this.profile.rank;
    report.rank.nameBefore = rankName(rankBefore);
    report.rank.nameAfter = rankName(this.profile.rank);
    report.rank.xpBefore = xpBefore;
    report.rank.xpAfter = this.profile.xp;
    report.rank.intoRank = rp.into;
    report.rank.forNext = rp.needed;
    report.rank.pct = rp.pct;
    report.rank.promoted = this.profile.rank > rankBefore;
    report.rank.maxed = this.profile.rank >= MAX_RANK;
    report.rank.unlocks = ranksBetween(rankBefore, this.profile.rank);
    report.record = buildCombatRecord(this.profile);

    this.report = report;
    this.publish({ ...res, report, unlocks: report.rank.unlocks, rankUps: rankStepsBetween(rankBefore, this.profile.rank) });
    this.save();
  }

  /** Fans the commit out to the HUD, the audio layer and the after-action screen. */
  private publish(res: CommitResult): void {
    for (const r of res.rankUps) {
      this.emit('rank:up', { rank: r, name: rankName(r), total: this.profile.xp });
    }
    for (const u of res.unlocks) this.emit('unlock:granted', u);

    for (const lv of res.weaponLevelUps) {
      this.emit('progression:weapon:levelup', {
        weapon: lv.weapon,
        name: weaponTrack(lv.weapon)?.name ?? lv.weapon,
        level: lv.to,
        unlocked: lv.unlocked,
      });
    }
    for (const d of res.challengeDeltas) {
      if (d.completedNow) {
        this.emit('progression:challenge:complete', {
          id: d.def.id, name: d.def.name, xp: d.def.xp, reward: d.def.reward ?? null,
        });
      } else {
        this.emit('progression:challenge:progress', {
          id: d.def.id, name: d.def.name, progress: d.after, goal: d.def.goal,
        });
      }
    }
    for (const g of res.camoGrants) {
      const def: CamoDef | undefined = ALL_CAMOS.find((c) => c.id === g.camo);
      this.emit('progression:camo:unlocked', {
        weapon: g.weapon,
        weaponName: weaponTrack(g.weapon)?.name ?? g.weapon,
        camo: g.camo,
        camoName: def?.name ?? g.camo,
        mastery: def?.kind === 'mastery',
      });
    }
    this.emit('progression:afteraction', res.report);
  }

  /**
   * Folds the caller's own tally into the ledger. `Scoring` counts assists and
   * objectives that never reach the bus, so the larger of the two wins.
   */
  private mergeLegacyStats(s: Partial<LifetimeStatsV3>): void {
    const c = this.session.counters;
    const take = (k: keyof typeof c, v: number | undefined): void => {
      if (typeof v === 'number' && Number.isFinite(v) && v > c[k]) c[k] = Math.round(v);
    };
    take('kills', s.kills);
    take('deaths', s.deaths);
    take('headshots', s.headshots);
    take('assists', s.assists);
    take('bestStreak', s.bestStreak);
    take('bestMultikill', s.bestMultikill);
    take('objectives', s.objectives);
    take('wavesCleared', s.wavesCleared);
    take('killstreaksUsed', s.killstreaksUsed);
    take('score', s.score);
  }

  /* ------------------------------------------------------------ weapons -- */

  /** Persisted progress for a weapon. Untracked ids get a zeroed row. */
  weaponProgress(id: string): WeaponProgress {
    return this.profile.weapons[id] ?? newWeaponProgress(id);
  }

  weaponLevel(id: string): number { return this.weaponProgress(id).level; }
  weaponXp(id: string): number { return this.weaponProgress(id).xp; }

  /** The armoury list — every tracked weapon, gated and levelled. */
  armoury(): ArmouryRow[] {
    const q = this.unlockQuery();
    return WEAPON_TRACKS.map((t) => {
      const w = this.weaponProgress(t.id);
      const p = weaponProgressAt(w.xp);
      const st = w.stats;
      return {
        id: t.id,
        name: t.name,
        cls: t.cls,
        rankGate: t.rank,
        unlocked: canEquipWeapon(q, t.id),
        level: p.level,
        xp: w.xp,
        intoLevel: p.into,
        forNext: p.needed,
        pct: p.pct,
        maxed: p.maxed,
        kills: st.kills,
        headshots: st.headshots,
        accuracy: st.shotsFired > 0 ? st.shotsHit / st.shotsFired : 0,
        camos: w.camos.length,
        camoIds: [...w.camos],
        attachments: attachmentsAtLevel(t.id, p.level).length,
      };
    });
  }

  /* ------------------------------------------------------------ unlocks -- */

  /** The query object the loadout/armoury layer should gate against. */
  unlockQuery(): UnlockQuery {
    return {
      rank: this.profile.rank,
      weaponLevel: (id: string) => this.weaponLevel(id),
      extraUnlocks: this.profile.extraUnlocks,
    };
  }

  canEquip(weaponId: string): boolean { return canEquipWeapon(this.unlockQuery(), weaponId); }
  rankGate(weaponId: string): number { return weaponRankGate(weaponId); }
  canAttach(weaponId: string, attachmentId: string): boolean {
    return canAttach(this.unlockQuery(), weaponId, attachmentId);
  }
  availableAttachments(weaponId: string): string[] {
    return availableAttachments(this.unlockQuery(), weaponId);
  }
  unlockedWeapons(): string[] { return unlockedWeapons(this.unlockQuery()); }
  nextUnlock(): UnlockDef | null { return nextRankUnlock(this.profile.rank); }

  /**
   * True when the player owns `id` right now.
   *
   * Content progression does not know about is *not* claimed as granted — the
   * caller's own gate decides. That keeps `src/session/loadout`'s validator
   * (which treats a `true` here as "bypass the rank gate") correct.
   */
  isUnlocked(id: string): boolean {
    const extra = this.profile.extraUnlocks;
    if (extra.includes(id)) return true;
    const alias = LEGACY_ALIAS[id];
    if (alias && extra.includes(alias)) return true;

    const def = unlockDef(id);
    if (def) return def.rank <= this.profile.rank;
    if (isTrackedWeapon(id)) return this.profile.rank >= weaponRankGate(id);
    return false;
  }

  /** Grants something outside the curve: care package, challenge, purchase. */
  grantExtra(id: string): void {
    if (this.profile.extraUnlocks.includes(id)) return;
    this.profile.extraUnlocks.push(id);
    const def = unlockDef(id);
    if (def) this.emit('unlock:granted', def);
    this.save();
  }

  /* --------------------------------------------------- challenges/camos -- */

  challengeRows(opts: { onlyActive?: boolean; weapon?: string } = {}): ChallengeRow[] {
    const defs = opts.weapon ? challengesForWeapon(opts.weapon) : CHALLENGES;
    const rows: ChallengeRow[] = [];
    for (const def of defs) {
      const st: ChallengeState = this.profile.challenges[def.id]
        ?? { progress: 0, done: false, doneAt: 0 };
      const progress = Math.min(def.goal, Math.max(0, st.progress));
      if (opts.onlyActive && st.done) continue;
      rows.push({
        def,
        id: def.id,
        name: def.name,
        description: def.description,
        progress,
        goal: def.goal,
        pct: def.goal > 0 ? progress / def.goal : 0,
        done: st.done,
        xp: def.xp,
        weapon: def.scope === 'weapon' ? def.target : undefined,
      });
    }
    rows.sort((a, b) => Number(a.done) - Number(b.done) || b.pct - a.pct || a.goal - b.goal);
    return rows;
  }

  camoProgress(weaponId: string): ReturnType<typeof camoProgressFor> {
    return camoProgressFor(this.profile, weaponId);
  }

  /* ------------------------------------------------------ combat record -- */

  combatRecord(): CombatRecord { return buildCombatRecord(this.profile); }
  history(): readonly MatchHistoryEntry[] { return this.profile.history; }

  /** One read for every meta screen. See `ProgressionView` for the mapping. */
  view(activeChallenges = 5, recentMatches = 8): ProgressionView {
    const rec = buildCombatRecord(this.profile);
    const next = nextRankUnlock(this.profile.rank);
    return {
      rank: rec.rank,
      rankName: rec.rankName,
      xp: rec.xp,
      intoRank: rec.xpIntoRank,
      forNext: rec.xpForNext,
      pct: rec.xpForNext > 0 ? Math.min(1, rec.xpIntoRank / rec.xpForNext) : 1,
      maxed: rec.rank >= MAX_RANK,
      headline: recordHeadline(rec),
      nextUnlock: next,
      xpToNextUnlock: next ? Math.max(0, xpForRank(next.rank) - this.profile.xp) : 0,
      challengesComplete: rec.challengesComplete,
      challengesTotal: rec.challengesTotal,
      camosUnlocked: rec.camosUnlocked,
      challenges: this.challengeRows({ onlyActive: true }).slice(0, activeChallenges),
      history: this.profile.history.slice(0, recentMatches),
      awaitingHost: this.awaitingHost,
    };
  }

  /* ------------------------------------------------------------- legacy -- */

  /** Fills the progression block of a match summary. */
  decorateSummary(summary: MatchSummary, unlocked: UnlockDef[]): void {
    const r = this.report;
    const p = this.progressInRank();
    summary.xpEarned = r ? r.xp.total : this.session.xpTotal;
    summary.rankBefore = r ? r.rank.before : this.profile.rank;
    summary.rankAfter = this.profile.rank;
    summary.rankName = rankName(this.profile.rank);
    summary.xpIntoRank = p.into;
    summary.xpForNext = p.needed;
    summary.unlocked = unlocked.length ? unlocked : (r?.rank.unlocks ?? []);
  }
}

/* ---------------------------------------------------------------- helpers -- */

function ranksBetween(before: number, after: number): UnlockDef[] {
  const out: UnlockDef[] = [];
  for (let r = before + 1; r <= after; r++) out.push(...unlocksForRank(r));
  return out;
}

function rankStepsBetween(before: number, after: number): number[] {
  const out: number[] = [];
  for (let r = before + 1; r <= after; r++) out.push(r);
  return out;
}

const MODE_LABELS: Readonly<Record<string, string>> = {
  operation: 'Operation',
  tdm: 'Team Deathmatch',
  dom: 'Domination',
  firefight: 'Firefight',
  hardpoint: 'Hardpoint',
  sabotage: 'Sabotage',
  kc: 'Kill Confirmed',
  ffa: 'Free-for-All',
};

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Deferred so importing this module never touches the bus at load time. */
let cachedPort: EventPort | null = null;
function lazyBusPort(): EventPort {
  if (!cachedPort) cachedPort = busPort();
  return cachedPort;
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
