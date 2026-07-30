/**
 * Matchmaking, backfill and bot fill — public surface.
 *
 * ```ts
 * import { MatchmakingService, PLAYLISTS } from '@/session/matchmaking';
 *
 * const mm = new MatchmakingService();          // loopback: local player is host
 * mm.requestJoin('core-tdm-6v6');
 * // …every frame (or every 250 ms):
 * for (const proposal of mm.update(nowSeconds)) startMatch(proposal.roster);
 * ```
 *
 * What the rest of the game plugs into:
 *
 *  - **UI** (owned elsewhere): listen to `mm:*` on the bus — see `events.ts`
 *    for the full list and for what each event should draw — or poll
 *    `MatchmakingService.snapshot()`.
 *  - **Game/AI**: for every `BotSlot` in a roster, call `toAgentOptions(slot)`
 *    for `AISystem.spawn()` or `toSpawnParams(slot, localTeam)` for
 *    `ActorAPI.spawnCombatant()`; both need a position from `src/game/Spawns.ts`.
 *  - **Netcode**: implement `MatchmakingTransport` and hand it in. Until then
 *    `LoopbackTransport` makes the local player the authority and `TransportHub`
 *    lets tests run a host and clients in one process.
 *  - **Match layer**: publish a `LiveMatchView` into `registerMatch` /
 *    `updateMatch` so backfill knows whether it is too late to join.
 */

export { MatchmakingService, unratedMember } from './Service';
export type {
  MatchmakingOptions, MatchResultReport, MmEmitter, PartyMemberInput,
} from './Service';

export { MatchQueue, qualityOf, ticketConnection, ticketRegion } from './Queue';
export type { QueueOptions, TicketStatus } from './Queue';

export {
  DEFAULT_WIDENING, PRIVATE_WIDENING, RANKED_WIDENING, describeCurve,
  humansRequired, mutualWindows, wideningFor, windowsAt, windowsForTicket,
} from './Widening';
export type { SearchWindows } from './Widening';

export { PLAYLISTS, PLAYLIST_IDS, playlist, slotCount } from './Playlists';

export {
  applyMatch, conservativeSkill, decayed, expectedScore, newRating,
  performanceScore, ratingFromRank, updateRating,
  RATING_DEFAULT, RD_DEFAULT, RD_MAX, RD_MIN, VOL_DEFAULT,
} from './Rating';
export type { MatchPerformance, RatedGame } from './Rating';

export { RatingStore, defaultRecord } from './Store';

export {
  backboneRtt, connectionQuality, defaultConnection, effectiveRtt,
  estimateRtt, pingsToHost, selectHost,
} from './Connection';
export type { HostCandidateInfo, HostChoice } from './Connection';

export { balanceTeams, partySkill } from './TeamBalance';
export type { BalanceResult } from './TeamBalance';

export {
  botsOn, chooseBotToYield, difficultyForRating, fillRoster, humansOn,
  lobbyHumanMean, removeBot, resetBotIds, slotRating, teamForIncoming,
  toAgentOptions, toSpawnParams,
} from './BotFill';
export type {
  AgentOptionsLike, BotFillOptions, BotFillResult, SpawnParamsLike,
} from './BotFill';

export { BackfillManager, DEFAULT_BACKFILL, canBackfill } from './Backfill';
export type { BackfillNeed, BackfillPlacement, BackfillPolicy } from './Backfill';

export { LoopbackTransport, TransportHub } from './Transport';

export { generatePopulation, skillPercentiles } from './Population';
export type { PopulationOptions, SyntheticPlayer } from './Population';

export {
  DEFAULT_SIM, curveTable, runBackfillPolicyProbe, runFriendGroupScenario, runSimulation,
} from './Simulation';
export type {
  Dist, FriendGroupResult, PolicyProbeRow, SimConfig, SimStats,
} from './Simulation';

export type {
  BackfillRefusal, BotId, BotSlot, ConnectionInfo, HumanSlot, LiveMatchView,
  MatchId, MatchProposal, MatchQuality, MatchRoster, MatchSlot,
  MatchmakingMessage, MatchmakingSnapshot, MatchmakingTransport, NatType,
  PartyId, PlayerId, PlayerRecord, PlaylistDef, PlaylistId, QueueMember,
  QueueState, QueueTicket, RegionId, SkillRating, TicketId, TicketKind,
  WideningParams,
} from './types';
export { REGIONS } from './types';

import './events';
