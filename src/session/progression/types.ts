/**
 * Progression read models and ports.
 *
 * Everything in `src/session/progression` is pure data + pure functions over
 * that data. It imports no engine, no THREE, no DOM — which is what lets the
 * headless verifier (`tools/session-prog.mjs`) simulate fifty matches in a few
 * milliseconds and lets the netcode layer run the exact same code on a host.
 *
 * ## Authority
 *
 * The host decides, clients request and display. Progression is written so the
 * *commit* step (banking XP into the persisted profile) is a single call that
 * either runs locally (host / offline) or is deferred until the host's
 * authoritative report arrives (client). See `ProgressionNetPort`.
 */

import type { EventKey, GameEvents } from '../../core/EventBus';
import type { UnlockDef } from '../../game/types';

/* -------------------------------------------------------------- ports -- */

/** The slice of the event bus progression needs. Injected so tests stay pure. */
export interface EventPort {
  emit<K extends EventKey>(key: K, payload: GameEvents[K]): void;
  on<K extends EventKey>(key: K, fn: (payload: GameEvents[K]) => void): () => void;
}

/** Who is allowed to bank XP into the profile. */
export type ProgressionAuthority = 'host' | 'client';

/**
 * What progression needs from the netcode layer (`src/net/`, built in parallel).
 * Nothing here exists yet, so every member is optional and the whole port may be
 * `null` — in which case progression behaves as an offline host, which is
 * exactly the single-player case.
 *
 * Contract:
 *   • `authority === 'host'`   → commit locally, then broadcast the report.
 *   • `authority === 'client'` → build a *provisional* report for the
 *     after-action screen, submit the raw match record, and only bank XP when
 *     `onMatchReport` delivers the host's version.
 */
export interface ProgressionNetPort {
  readonly authority: ProgressionAuthority;
  /** Client → host. The host re-derives XP from its own match record. */
  submitMatchResult?(record: MatchRecord): void;
  /** Host → client. Returns an unsubscribe. */
  onMatchReport?(cb: (report: AfterActionReport) => void): () => void;
}

/* ------------------------------------------------------------ taxonomy -- */

export type WeaponClassId =
  | 'assault' | 'smg' | 'shotgun' | 'sniper'
  | 'lmg' | 'marksman' | 'pistol' | 'launcher';

/**
 * Canonical XP sources. `Scoring` already emits human labels ("Headshots",
 * "Multikills"); `classifyXpReason` maps those onto these ids so the
 * after-action screen can group, colour and order rows without string matching
 * scattered through the UI.
 */
export type XpSourceId =
  | 'kill' | 'headshot' | 'longshot' | 'pointblank' | 'objectiveKill'
  | 'assist' | 'revenge' | 'firstblood' | 'execution'
  | 'multikill' | 'streak' | 'killstreakKill'
  | 'objective' | 'capture' | 'wave' | 'revive'
  | 'matchResult' | 'challenge' | 'other';

/** Display grouping for the after-action screen. */
export type XpCategory = 'combat' | 'objective' | 'bonus' | 'match' | 'challenge';

export interface XpSourceMeta {
  id: XpSourceId;
  /** Plural label used on the report, e.g. "Headshots". */
  label: string;
  category: XpCategory;
  /** Lower sorts first inside a category. */
  order: number;
}

/* ---------------------------------------------------- weapon progression -- */

export interface WeaponUnlockDef {
  /** Attachment id from `src/weapons/Attachments.ts`. */
  id: string;
  name: string;
  slot: string;
  /** Weapon level at which it becomes available. */
  level: number;
}

export interface WeaponTrackDef {
  /** Weapon id from `src/weapons/Catalog.ts`. */
  id: string;
  name: string;
  cls: WeaponClassId;
  /** Player rank needed before the weapon itself can be equipped. */
  rank: number;
  maxLevel: number;
  /** Metres past which a kill with this weapon counts as a longshot. */
  longshot: number;
  unlocks: readonly WeaponUnlockDef[];
}

/** Lifetime, per-weapon counters. Every field is a monotonic total. */
export interface WeaponStats {
  kills: number;
  deaths: number;
  headshots: number;
  longshots: number;
  pointblankKills: number;
  hipfireKills: number;
  adsKills: number;
  killstreakKills: number;
  revengeKills: number;
  firstBloods: number;
  multikills: number;
  assists: number;
  shotsFired: number;
  shotsHit: number;
  damage: number;
  timeUsed: number;
}

export interface WeaponProgress {
  id: string;
  xp: number;
  level: number;
  stats: WeaponStats;
  /** Camo ids earned on this weapon. */
  camos: string[];
}

/* --------------------------------------------------------- challenges -- */

export type ChallengeStat =
  | keyof WeaponStats
  | 'wins' | 'matches' | 'bestStreak' | 'bestMultikill'
  | 'objectives' | 'score' | 'wavesCleared' | 'level';

export type ChallengeScope = 'weapon' | 'class' | 'player';

export interface ChallengeReward {
  kind: 'camo' | 'unlock' | 'title';
  id: string;
  name: string;
}

export interface ChallengeDef {
  id: string;
  name: string;
  description: string;
  scope: ChallengeScope;
  /** Weapon id for `weapon` scope, class id for `class` scope. */
  target?: string;
  stat: ChallengeStat;
  /** Value of `stat` that completes the challenge. */
  goal: number;
  xp: number;
  reward?: ChallengeReward;
  /** Tier index inside a chain (1-based); chains share a `chain` id. */
  chain?: string;
  tier?: number;
  /** Hidden until the previous tier completes. */
  requires?: string;
}

export interface ChallengeState {
  progress: number;
  done: boolean;
  /** Match index (profile.stats.matches) at completion; 0 when not done. */
  doneAt: number;
}

/* -------------------------------------------------------------- camos -- */

export interface CamoDef {
  id: string;
  name: string;
  /** Presentation hint for the armoury: the UI owns the actual material. */
  tint: string;
  /** 'base' camos feed mastery; mastery camos gate on other camos. */
  kind: 'base' | 'mastery';
  description: string;
}

/* ------------------------------------------------------------- profile -- */

export interface PersonalBests {
  kills: number;
  score: number;
  streak: number;
  multikill: number;
  headshots: number;
  /** Best single-match accuracy, only counted from matches with ≥40 shots. */
  accuracy: number;
  xp: number;
}

export interface LifetimeStatsV3 {
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
  /* --- added in v3 --- */
  losses: number;
  shotsFired: number;
  shotsHit: number;
  score: number;
  longshots: number;
  revengeKills: number;
  firstBloods: number;
  bestMultikill: number;
  multikills: number;
}

export interface ProfileV3 {
  version: 3;
  createdAt: number;
  updatedAt: number;
  xp: number;
  rank: number;
  stats: LifetimeStatsV3;
  extraUnlocks: string[];
  lastMode: string;
  weapons: Record<string, WeaponProgress>;
  challenges: Record<string, ChallengeState>;
  bests: PersonalBests;
  /** Most recent match ids, newest first; capped. */
  history: MatchHistoryEntry[];
}

export interface MatchHistoryEntry {
  mode: string;
  win: boolean;
  kills: number;
  deaths: number;
  score: number;
  xp: number;
  durationSec: number;
  at: number;
}

/* ------------------------------------------------------- match records -- */

/** One kill, as observed by the match. Everything the trackers can attribute. */
export interface KillRecord {
  weapon: string;
  headshot: boolean;
  /** Metres from shooter to victim. */
  distance: number;
  ads: boolean;
  /** 'player' | 'sentry' | 'airstrike' | 'explosion' | … */
  source: string;
  victimId: number;
  /** Player killstreak *after* this kill. */
  streak: number;
  revenge: boolean;
  firstBlood: boolean;
}

export interface WeaponMatchStats extends WeaponStats {
  weapon: string;
  xp: number;
}

export interface XpLedgerRow {
  source: XpSourceId;
  label: string;
  xp: number;
  count: number;
}

/**
 * The raw, authority-checkable record of what a player did in one match.
 * A client submits this; a host re-derives XP from it rather than trusting a
 * client-computed total.
 */
export interface MatchRecord {
  mode: string;
  modeName: string;
  win: boolean;
  durationSec: number;
  seed: number;
  replayHash: string;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  longshots: number;
  bestStreak: number;
  bestMultikill: number;
  objectives: number;
  wavesCleared: number;
  killstreaksUsed: number;
  shotsFired: number;
  shotsHit: number;
  revengeKills: number;
  firstBloods: number;
  /** Per-weapon slice, keyed by weapon id. */
  weapons: WeaponMatchStats[];
  /** XP as the *reporting* peer computed it. The host may overrule. */
  ledger: XpLedgerRow[];
  xpTotal: number;
}

/* ------------------------------------------------- after-action report -- */

export interface RankReport {
  before: number;
  after: number;
  nameBefore: string;
  nameAfter: string;
  xpBefore: number;
  xpAfter: number;
  /** XP into the rank the player ended on. */
  intoRank: number;
  forNext: number;
  /** 0..1 fill of the rank bar after the match. */
  pct: number;
  promoted: boolean;
  maxed: boolean;
  unlocks: UnlockDef[];
}

export interface WeaponReportRow {
  id: string;
  name: string;
  cls: WeaponClassId;
  xpGained: number;
  levelBefore: number;
  levelAfter: number;
  intoLevel: number;
  forNext: number;
  pct: number;
  maxed: boolean;
  kills: number;
  headshots: number;
  accuracy: number;
  /** Attachments crossed this match. */
  unlocked: WeaponUnlockDef[];
}

export interface ChallengeReportRow {
  id: string;
  name: string;
  description: string;
  before: number;
  after: number;
  goal: number;
  complete: boolean;
  xp: number;
  reward?: ChallengeReward;
  weapon?: string;
}

export interface CamoReportRow {
  weapon: string;
  weaponName: string;
  camo: string;
  camoName: string;
  kind: CamoDef['kind'];
}

export interface CombatRecordWeaponRow {
  id: string;
  name: string;
  cls: WeaponClassId;
  level: number;
  xp: number;
  kills: number;
  deaths: number;
  kd: number;
  headshots: number;
  headshotRate: number;
  accuracy: number;
  shotsFired: number;
  camos: number;
}

export interface CombatRecord {
  rank: number;
  rankName: string;
  xp: number;
  xpIntoRank: number;
  xpForNext: number;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  headshots: number;
  headshotRate: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number;
  bestStreak: number;
  bestMultikill: number;
  objectives: number;
  timePlayed: number;
  killsPerMinute: number;
  scorePerMinute: number;
  challengesComplete: number;
  challengesTotal: number;
  camosUnlocked: number;
  bests: PersonalBests;
  weapons: CombatRecordWeaponRow[];
  favouriteWeapon: string | null;
}

export interface AfterActionReport {
  version: 1;
  /** True while waiting on the host to confirm (client authority). */
  provisional: boolean;
  mode: string;
  modeName: string;
  win: boolean;
  durationSec: number;
  seed: number;
  replayHash: string;

  scoreboard: {
    score: number;
    kills: number;
    deaths: number;
    assists: number;
    kd: number;
    headshots: number;
    accuracy: number;
    bestStreak: number;
    bestMultikill: number;
    objectives: number;
    wavesCleared: number;
    killstreaksUsed: number;
  };

  xp: {
    total: number;
    /** Sum of match XP before any multiplier. */
    base: number;
    multiplier: number;
    rows: XpLedgerRow[];
    byCategory: Array<{ category: XpCategory; xp: number }>;
  };

  rank: RankReport;
  weapons: WeaponReportRow[];
  challenges: ChallengeReportRow[];
  camos: CamoReportRow[];
  /** Human strings: "New best killstreak: 14". */
  personalBests: string[];
  record: CombatRecord;
}
