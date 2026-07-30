/**
 * Public surface of the lobby module — the room your friends are standing in.
 *
 * Import from here, not from individual files. The shapes below are the whole
 * contract other modules need:
 *
 * - `LobbySystem`  — register once in `main.ts`; owns everything else.
 * - `LobbySession` — one peer's handle: `submit()` to write, `state` to read.
 * - `LobbyHost`    — the authority. Only the host peer has one.
 * - `LobbyTransport` — the interface `src/net/` implements to make this
 *   multiplayer. `LocalTransportHub` / `soloTransport` cover offline and tests.
 *
 * Verified end to end by `node tools/session-lobby.mjs` — 135 checks covering
 * room codes, join/kick/promote, ready gating, a drop mid-countdown, launch,
 * party persistence across matches *and* page reloads, host migration (fresh
 * snapshot, stale snapshot, and mid-countdown), the vote tie-break ladder, and
 * the authority rules.
 *
 * ## Authority, in one paragraph
 *
 * Exactly one peer holds a `LobbyHost`. Everyone else holds a read-only
 * `LobbyState` and a `LobbySession` whose write methods put a `LobbyCommand` on
 * the wire. A client that mutates its own `LobbyState` changes nothing: the
 * transport hands every peer its own copy, and the next `lobby:state` overwrites
 * it. When the host vanishes, every peer independently ranks the survivors over
 * data it already holds (`Migration.ts`) and reaches the same answer with no
 * negotiation; the winner calls `LobbyHost.adopt` and the room carries on with
 * the same code, the same people and the same parties. Link quality — which
 * decides that election — is measured by the transport and stamped in by the
 * host, never claimed by a client.
 *
 * ## What the UI should display
 *
 * `src/ui/` owns every pixel; this module owns every fact. **Render from
 * `lobby:state` and animate from everything else.** Never accumulate lobby
 * state out of the granular events — they exist so a sound, a toast or a slot
 * animation can fire at the right instant, and they are not a replica log.
 *
 * ### The lobby screen, top to bottom
 *
 * | Region | Read from `LobbyState` | Notes |
 * |---|---|---|
 * | Room code chip | `formatRoomCode(code)` | `K4M-9TQ`. The share/copy affordance. |
 * | Title bar | `settings.name`, `settings.visibility` | |
 * | Status line | `message` | Already all-caps and renderable verbatim — `WAITING FOR 2 MORE PLAYERS`, `LOADING 3/6`, `NEXT MATCH IN 8`. Do not compose your own. |
 * | Selection card | `selection.mapName`, `selection.modeName` | The map that will actually load. |
 * | Team columns | `teams[]` → `name`, `size`, `capacity`, `full` | Two columns when `settings.teamCount === 2`, one roster otherwise. |
 * | Roster rows | `members[]` | See below. |
 * | Party tint | `members[].partyId` → `parties[]` `.colour` | One colour index per party; `.split === true` means balancing had to break them up and deserves a warning. |
 * | Vote board | `vote` | Cards from `vote.candidates[]` (`label`, `sublabel`, `tagline`, `votes`, `voters`, `recommended`), clock from `vote.secondsLeft`, `vote.open === false` means the board is closed — show the winner (`vote.winner`) and why (`vote.resolvedBy`). |
 * | Countdown | `countdown` | `active`, `secondsLeft`, `total`, `label` (`LAUNCHING` / `STARTING`). `abortedBy` is set for one state after an abort — show `lobby:countdown:abort`'s `text`. |
 * | Bottom bar | `readyCount` / `connectedCount` / `capacity` | Ready button state comes from the local member's `ready`. |
 *
 * One roster row is one `MemberState`: `profile.name` (+ `profile.clanTag`,
 * `profile.rank`, `profile.emblem`), `ready`, `team`, `ping`, `connection`
 * (`joining` / `connected` / `loading` / `dropped` — `dropped` survives one
 * state so the row can animate out), `loadProgress` for the loading bar,
 * `host` / `leader` / `partyLeader` for the badges, `vote` for the little
 * candidate pip, and `slot` as a **stable sort key** so rows do not jump.
 *
 * ### Which controls to show
 *
 * Enable a control from the state, not from a guess:
 *
 * - kick / promote / settings / pin / start / cancel → only when
 *   `state.leaderId === localId` (`LEADER_ONLY` is the exact set).
 * - vote / switch team / settings → only while `phase === 'forming'`
 *   (`FORMING_ONLY`).
 * - ready toggle → `phase === 'forming' || phase === 'ready'`.
 * - Every rejected command comes back as `lobby:error` with a `code` and a
 *   `error` string that is already safe to put in a toast.
 *
 * ### Events, and what each is for
 *
 * `lobby:state` is the truth. The rest are cues: `lobby:created`,
 * `lobby:joined`, `lobby:closed`, `lobby:member:join` / `:leave` / `:ready` /
 * `:connection`, `lobby:leader`, `lobby:phase`, `lobby:countdown`,
 * `lobby:countdown:abort`, `lobby:loading`, `lobby:launch`, `lobby:result`,
 * `lobby:vote:open` / `:cast` / `:result`, `lobby:teams`, `lobby:party:update`,
 * `lobby:party:invite`, `lobby:host:migrated`, `lobby:error`. Full payloads are
 * in `./events.ts`, declared onto `GameEvents` by interface merging so the UI
 * needs no import from this directory to be type-safe.
 *
 * Two are worth special handling: `lobby:party:invite` should raise an accept
 * prompt (answer with `LobbySession.acceptInvite(partyId)`), and
 * `lobby:host:migrated` should show a brief `HOST MIGRATED` banner for
 * `graceSec` seconds rather than tearing the screen down — the room did not
 * change, only who is running it.
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
