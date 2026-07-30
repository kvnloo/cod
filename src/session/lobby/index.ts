/**
 * Public surface of the lobby module.
 *
 * Import from here, not from individual files. The shapes below are the whole
 * contract other modules need:
 *
 * - `LobbySystem`  — register once in `main.ts`; owns everything else.
 * - `LobbySession` — one peer's handle: `submit()` to write, `state` to read.
 * - `LobbyHost`    — the authority. Only the host peer has one.
 * - `LobbyTransport` — the interface `src/net/` implements to make this
 *   multiplayer. `LocalTransportHub` / `soloTransport` cover offline and tests.
 */

export { LobbySystem, LOBBY_ORDER, localPlayerId } from './LobbySystem';
export type { LobbySystemOptions } from './LobbySystem';

export { LobbySession } from './LobbySession';
export type { LobbySessionOptions } from './LobbySession';

export { LobbyHost } from './Lobby';
export type { LobbyHostOptions } from './Lobby';

export { PartyRegistry, browserPartyStore, memoryPartyStore } from './Party';
export type { Party, PartyStore, PersistedParty } from './Party';

export { VoteBooth, buildCandidates, candidateId } from './Vote';
export type { CandidateContext, VoteResult } from './Vote';

export { assignTeams, canSwitchTeam, summariseTeams, teamCapacity } from './Teams';
export type { BalanceMember, BalanceOptions, BalanceResult, TeamAssignment } from './Teams';

export { pickSuccessor, shouldAdopt, snapshotFromState, pingBucket, eligibleSuccessors } from './Migration';

export {
  CODE_ALPHABET, CODE_LENGTH, codeFromSeed, formatRoomCode, isRoomCode, lobbyIdForCode,
  makeRoomCode, normalizeRoomCode,
} from './RoomCode';

export {
  DEFAULT_CATALOG, MAPS, MODES, fallbackPair, findMap, findMode, modeFits,
} from './Catalog';
export type { LobbyCatalog } from './Catalog';

export { LocalTransportHub, soloTransport } from './Transport';
export type { LobbyMessage, LobbyTransport } from './Transport';

export { FORMING_ONLY, LEADER_ONLY, OK, fail } from './Commands';
export type { CommandResult, LobbyCommand, LobbyCommandType, LobbyErrorCode } from './Commands';

import './events';
