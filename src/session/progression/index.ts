/**
 * Session · Progression
 *
 * XP, ranks, weapon levels, attachments, challenges, camos, the after-action
 * report, the combat record and the persistence that keeps them across builds.
 *
 * `src/game/Progression.ts` is the runtime face of this module — it owns the
 * profile instance the match talks to. Everything here is data and pure
 * functions so the host, a client prediction and the headless verifier all run
 * identical code.
 */

import './events';

export * from './types';

export {
  MAX_RANK, RANK_NAMES, WEAPON_MAX_LEVEL, WEAPON_XP_TO_MAX,
  rankForXp, rankName, rankProgress, xpForRank, xpSpanForRank,
  weaponLevelForXp, weaponProgressAt, weaponXpForLevel,
} from './Curves';

export {
  DEFAULT_ATTACHMENTS, WEAPON_TRACKS, WXP,
  attachmentsAtLevel, attachmentsBetween, isTrackedWeapon, longshotRange,
  weaponTrack, weaponTracksOfClass, weaponXpForKill,
} from './WeaponTracks';

export {
  ALL_CAMOS, BASE_CAMOS, BASE_CAMO_IDS, MASTERY_CAMOS, MASTERY_XP,
  camoDef, camoLadder,
} from './Camos';

export {
  CHALLENGES, applyCamoGrants, camoProgressFor, challengeDef, challengeValue,
  challengeXp, challengesForWeapon, emptyChallengeState, emptyWeaponStats,
  evaluateChallenges, playerChallenges, playerStatValue, weaponStatValue,
} from './Challenges';
export type { CamoGrant, ChallengeDelta } from './Challenges';

export {
  LEGACY_ALIAS, UNLOCKS, availableAttachments, canAttach, canEquipWeapon,
  nextRankUnlock, unlockDef, unlockedAt, unlockedWeapons, unlocksForRank,
  weaponRankGate,
} from './Unlocks';
export type { UnlockQuery } from './Unlocks';

export {
  BACKUP_PREFIX, LEGACY_KEYS, MAX_HISTORY, PROFILE_KEY, PROFILE_VERSION,
  coerceProfile, defaultProfileV3, emptyBests, emptyLifetime, ensureWeapons,
  loadProfile, memoryStorage, newWeaponProgress, saveProfile,
} from './Store';
export type { LoadResult } from './Store';

export { MatchSession, POINT_BLANK_RANGE } from './Session';
export type { KillClassification, MatchCounters } from './Session';

export { MatchEventTracker, TRACKER_XP } from './Tracker';
export type { XpSink } from './Tracker';

export { cloneProfile, commitMatch, previewMatch } from './Commit';
export type { CommitOptions, CommitResult, WeaponLevelUp } from './Commit';

export { buildCombatRecord, classRollup, recordHeadline } from './Record';

export {
  CATEGORY_ORDER, XP_SOURCES, classifyXpReason, xpSourceLabel, xpSourceMeta,
} from './XpSources';

export { busPort, recordingPort } from './Bus';
