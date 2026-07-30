/**
 * Public surface of the game layer.
 *
 * Other modules should import from here rather than reaching into individual
 * files: `GameDirector` is the engine system, `DirectorAPI`/`DirectorSnapshot`
 * are what the HUD reads, and `events.ts` (re-exported for its side effect)
 * carries the director's typed event vocabulary.
 */

export { GameDirector } from './GameDirector';
export { MatchRunner, formatClock } from './Match';
export type { MatchCommand } from './Match';
export { KILLSTREAK_DEFS } from './Killstreaks';
export { ARCHETYPES, ARCHETYPE_ORDER } from './Archetypes';
export { UNLOCKS, XP, rankName, rankForXp, xpForRank, MAX_RANK } from './Progression';
export type { Profile, LifetimeStats } from './Progression';
export { runSelfTest, logSelfTest } from './SelfTest';
export type { SelfTestReport, SelfTestCase } from './SelfTest';
export { loadReplay, saveReplay, REPLAY_VERSION } from './Replay';
export type { ReplaySpec } from './Replay';
export type {
  ActorAPI, Archetype, ArchetypeProfile, BannerView, BuyOffer, CombatantHandle,
  DamageOpts, DirectorAPI, DirectorSnapshot, GameModeId, KillstreakId, KillstreakView,
  MatchPhase, MatchSummary, MatchSummaryRow, ObjectiveKind, ObjectiveState, ObjectiveView,
  PlayerBridge, RadarContact, SpawnRequest, Team, UnlockDef, WorldBridge,
} from './types';
export type { CombatBridge } from './Combat';
import './events';
