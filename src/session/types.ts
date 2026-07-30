/**
 * Session-layer vocabulary.
 *
 * Everything that surrounds a match — who is in the lobby, which party they
 * belong to, what they voted for, which team they land on — is described here
 * as plain JSON-safe data. Two rules drive the shape of these types:
 *
 * 1. **Host authoritative.** `LobbyState` is a *read model*. Clients never
 *    mutate it; they submit a `LobbyCommand` and wait for the next state. The
 *    only writer is whichever peer currently owns `LobbyState.hostId`.
 * 2. **Serializable.** Every field below survives `JSON.parse(JSON.stringify(x))`
 *    unchanged, because the netcode layer has to put it on the wire and because
 *    host migration is literally "hand the snapshot to somebody else".
 *
 * No `three`, no DOM, no engine imports at runtime — the whole session core
 * runs headlessly in node, which is what makes `tools/session-lobby.mjs`
 * possible.
 */

import type { EventKey, GameEvents } from '../core/EventBus';
import type { GameModeId } from '../game/types';

export type { GameModeId };

/* --------------------------------------------------------------- identity -- */

/** Stable per-player identity. Supplied by the platform/netcode layer. */
export type PlayerId = string;
/** Server-unique lobby identity, e.g. `lby_7f3a1c`. */
export type LobbyId = string;
/** Stable party identity; survives matches and page reloads. */
export type PartyId = string;
/** Six-character human-shareable join code, e.g. `K4M-9TQ`. */
export type RoomCode = string;

export type Platform = 'pc' | 'console' | 'mobile' | 'bot';

/**
 * The public card shown for a player anywhere in the meta UI.
 *
 * `rank` / `prestige` mirror `src/game/Progression.ts` so a profile can be
 * built straight from a saved `Profile` with no translation.
 */
export interface PlayerProfile {
  id: PlayerId;
  /** Display name, 3..16 chars. */
  name: string;
  /** Up to 4 characters, `''` when the player has no clan. */
  clanTag: string;
  rank: number;
  prestige: number;
  /** Index into the procedural emblem table; the UI owns the art. */
  emblem: number;
  platform: Platform;
  /** 0..1 relative strength, used only for team balancing. */
  skill: number;
  /** True for an AI-filled slot. */
  bot: boolean;
}

/** Derives the 0..1 balancing skill from persistent progression numbers. */
export function skillFromProgress(rank: number, prestige: number, kd: number): number {
  const r = Math.max(0, Math.min(1, (rank - 1) / 54));
  const p = Math.max(0, Math.min(1, prestige / 10));
  const k = Math.max(0, Math.min(1, kd / 3));
  return Math.max(0, Math.min(1, 0.45 * r + 0.2 * p + 0.35 * k));
}

/** A profile with sensible defaults — handy for bots and for tests. */
export function makeProfile(id: PlayerId, name: string, patch: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    id,
    name,
    clanTag: '',
    rank: 1,
    prestige: 0,
    emblem: 0,
    platform: 'pc',
    skill: 0.5,
    bot: false,
    ...patch,
  };
}

/* ----------------------------------------------------------------- teams -- */

/**
 * Lobby teams are *absolute* (alpha/bravo), unlike `Team` in `src/game/types`
 * which is player-relative (friendly/hostile). `toGameTeam` converts.
 */
export type SessionTeam = 'alpha' | 'bravo' | 'none';

/** Relative team as the game layer wants it, from the point of view of `local`. */
export function toGameTeam(team: SessionTeam, local: SessionTeam): 'friendly' | 'hostile' {
  if (team === 'none' || local === 'none') return 'friendly';
  return team === local ? 'friendly' : 'hostile';
}

export interface TeamSummary {
  id: SessionTeam;
  name: string;
  size: number;
  capacity: number;
  /** Sum of member skill — the balancer minimises the gap between teams. */
  skill: number;
  full: boolean;
}

/* --------------------------------------------------------------- members -- */

/**
 * Connection lifecycle of one lobby slot.
 *
 * `joining`  — handshake accepted, profile not yet confirmed
 * `connected`— present in the lobby
 * `loading`  — level streaming after launch
 * `dropped`  — gone; kept for one state so the UI can animate the slot out
 */
export type MemberConnection = 'joining' | 'connected' | 'loading' | 'dropped';

export interface MemberState {
  id: PlayerId;
  profile: PlayerProfile;
  partyId: PartyId | null;
  team: SessionTeam;
  connection: MemberConnection;
  ready: boolean;
  /** 0..1 while `connection === 'loading'`. */
  loadProgress: number;
  host: boolean;
  leader: boolean;
  /** Party leader (distinct from lobby leader). */
  partyLeader: boolean;
  /** Lobby seconds at which this member joined; drives seniority. */
  joinedAt: number;
  /** Round-trip milliseconds as last reported by the transport. */
  ping: number;
  /** Vote candidate id, or null. */
  vote: string | null;
  /** Ordinal slot for stable UI rows. */
  slot: number;
  /** True when the player picked their team by hand; auto-balance leaves it alone. */
  teamLocked: boolean;
}

/* ---------------------------------------------------------------- parties -- */

export interface PartyView {
  id: PartyId;
  leaderId: PlayerId;
  members: PlayerId[];
  /** Matches this exact party has finished together. The social number. */
  matchesTogether: number;
  /** Colour index the UI uses to tint the party's rows. */
  colour: number;
  /** True when balancing had to break the party across teams. */
  split: boolean;
}

/* ------------------------------------------------------------- catalogue -- */

export interface MapDef {
  id: string;
  name: string;
  /** Level the world system loads; several map entries may share one. */
  levelId: string;
  /** Hour of day handed to `RenderAPI.setTimeOfDay`. */
  hour: number;
  /** Weather handed to `RenderAPI.setWeather`. */
  rain: number;
  fog: number;
  wind: number;
  /** Player counts this map plays well at. */
  minPlayers: number;
  maxPlayers: number;
  /** One-line flavour for the vote card. */
  tagline: string;
}

export interface ModeDef {
  id: GameModeId;
  name: string;
  /** Short HUD/vote label, e.g. `TDM`. */
  short: string;
  teamCount: 1 | 2;
  minPlayers: number;
  maxPlayers: number;
  /** Team display names, indexed alpha then bravo. */
  teamNames: [string, string];
  tagline: string;
}

/* ------------------------------------------------------------------ vote -- */

export interface VoteCandidate {
  id: string;
  mapId: string;
  modeId: GameModeId;
  /** `"BLACKOUT DUSK"` — map name, all caps, for the card. */
  label: string;
  /** `"TEAM DEATHMATCH"` — mode name. */
  sublabel: string;
  tagline: string;
  votes: number;
  voters: PlayerId[];
  /** The default that wins on a timeout with no votes cast. */
  recommended: boolean;
}

export type VoteResolution =
  | 'votes'
  | 'freshness'
  | 'leader'
  | 'hash'
  | 'timeout-default'
  | 'pinned';

export interface VoteState {
  open: boolean;
  /** Seconds left on the vote clock; -1 when closed. */
  secondsLeft: number;
  total: number;
  candidates: VoteCandidate[];
  /** Winning candidate id once resolved. */
  winner: string | null;
  resolvedBy: VoteResolution | null;
  /** Votes cast so far. */
  cast: number;
}

/* ------------------------------------------------------------- countdown -- */

export type CountdownAbortReason =
  | 'member-left'
  | 'member-dropped'
  | 'member-joined'
  | 'unready'
  | 'settings-changed'
  | 'leader-cancelled'
  | 'too-few-players'
  | 'host-migrated';

export interface CountdownState {
  active: boolean;
  secondsLeft: number;
  total: number;
  /** `"LAUNCHING"` / `"WAITING FOR PLAYERS"` — renderable verbatim. */
  label: string;
  /** Set for one state after an abort so the UI can show why. */
  abortedBy: CountdownAbortReason | null;
}

/* ------------------------------------------------------------- lifecycle -- */

/**
 * `forming` → `ready` → `loading` → `in-match` → `post-match` → `forming`
 *
 * `ready` is the countdown window: everyone has readied and the launch is
 * armed but still abortable. `post-match` is the scoreboard beat; the lobby
 * returns to `forming` with the same people, which is what "the party stays
 * together" actually means in code.
 */
export type LobbyPhase = 'forming' | 'ready' | 'loading' | 'in-match' | 'post-match';

export const LOBBY_PHASES: readonly LobbyPhase[] = [
  'forming', 'ready', 'loading', 'in-match', 'post-match',
];

/* -------------------------------------------------------------- settings -- */

export interface LobbySettings {
  /** Free-form lobby name shown in the browser list. */
  name: string;
  visibility: 'private' | 'friends' | 'public';
  maxPlayers: number;
  /** Human players required before the lobby will arm. */
  minPlayers: number;
  teamCount: 1 | 2;
  /** Fill empty slots with bots at launch. */
  fillWithBots: boolean;
  /** Keep every party on one team, splitting only when it cannot fit. */
  keepPartiesTogether: boolean;
  /** Re-balance teams automatically as people come and go. */
  autoBalance: boolean;
  allowJoinInProgress: boolean;
  /** Countdown when the lobby is not yet full. */
  countdownSec: number;
  /** Shorter countdown once every slot is taken. */
  fullCountdownSec: number;
  voteSec: number;
  /** Number of map/mode cards on the vote board. */
  voteCandidates: number;
  /** Members still loading after this are dropped and the match starts. */
  loadTimeoutSec: number;
  /** Countdown is extended by this much right after a host migration. */
  hostMigrationGraceSec: number;
  /** Seconds the post-match scoreboard holds before returning to `forming`. */
  postMatchSec: number;
  /**
   * Drop a member that has not been heard from in this many seconds.
   * 0 disables it — the transport's `onPeerLost` is the primary path.
   */
  heartbeatTimeoutSec: number;
  /** Leader pin: skips the vote entirely when both are set. */
  pinnedMapId: string | null;
  pinnedModeId: GameModeId | null;
}

export function defaultLobbySettings(patch: Partial<LobbySettings> = {}): LobbySettings {
  return {
    name: 'Blackout Lobby',
    visibility: 'private',
    maxPlayers: 12,
    minPlayers: 1,
    teamCount: 2,
    fillWithBots: true,
    keepPartiesTogether: true,
    autoBalance: true,
    allowJoinInProgress: false,
    countdownSec: 10,
    fullCountdownSec: 5,
    voteSec: 20,
    voteCandidates: 3,
    loadTimeoutSec: 30,
    hostMigrationGraceSec: 5,
    postMatchSec: 15,
    heartbeatTimeoutSec: 0,
    pinnedMapId: null,
    pinnedModeId: null,
    ...patch,
  };
}

/* ------------------------------------------------------------ read model -- */

export interface LobbySelection {
  mapId: string;
  mapName: string;
  modeId: GameModeId;
  modeName: string;
  /** Deterministic match seed derived from the lobby seed and match index. */
  seed: number;
}

/**
 * Everything the UI needs to draw the lobby, in one JSON object.
 * Emitted on `lobby:state` whenever it changes.
 */
export interface LobbyState {
  id: LobbyId;
  code: RoomCode;
  phase: LobbyPhase;
  /** Seconds spent in the current phase. */
  phaseTime: number;
  /** Seconds since the lobby was created. Monotonic, tick-driven. */
  clock: number;
  /** Bumped on every host migration; clients drop messages from older epochs. */
  epoch: number;
  /** Monotonic state version; the only ordering guarantee clients need. */
  seq: number;

  hostId: PlayerId;
  leaderId: PlayerId;
  settings: LobbySettings;

  members: MemberState[];
  parties: PartyView[];
  teams: TeamSummary[];

  vote: VoteState;
  countdown: CountdownState;
  selection: LobbySelection;

  readyCount: number;
  connectedCount: number;
  capacity: number;
  /** Matches this lobby has played through. Party persistence, visible. */
  matchesPlayed: number;
  lastResult: LobbyResult | null;
  /** A single renderable status line, e.g. `"WAITING FOR 2 MORE PLAYERS"`. */
  message: string;
}

export interface LobbyResult {
  matchIndex: number;
  mapId: string;
  modeId: GameModeId;
  /** Winning team, or 'none' for a draw. */
  winner: SessionTeam;
  alphaScore: number;
  bravoScore: number;
  durationSec: number;
}

/* ---------------------------------------------------------------- launch -- */

export interface MatchRosterEntry {
  id: PlayerId;
  name: string;
  team: SessionTeam;
  partyId: PartyId | null;
  bot: boolean;
  skill: number;
  profile: PlayerProfile;
}

/**
 * The launch order. Emitted once on `lobby:launch`; the game layer turns this
 * into `DirectorAPI.startMatch(modeId, seed)` and the world layer reads
 * `levelId` / `hour` / `rain` / `fog` / `wind`.
 */
export interface MatchConfig {
  lobbyId: LobbyId;
  code: RoomCode;
  /** 0-based index of this match within the lobby's life. */
  matchIndex: number;
  hostId: PlayerId;
  modeId: GameModeId;
  mapId: string;
  levelId: string;
  hour: number;
  rain: number;
  fog: number;
  wind: number;
  seed: number;
  teamCount: 1 | 2;
  teamNames: [string, string];
  roster: MatchRosterEntry[];
}

/* -------------------------------------------------------------- snapshot -- */

/**
 * The full authoritative state, including the bits the read model hides.
 * This is what a migrating host receives, and it is JSON.
 */
export interface LobbySnapshot {
  version: 1;
  state: LobbyState;
  seed: number;
  matchIndex: number;
  /** Map id of the previous match; the vote prefers something else. */
  lastMapId: string | null;
  /** Party bookkeeping, so the successor host keeps everyone grouped. */
  parties: PartyRecord[];
  /** Seconds remaining on whatever timer the current phase runs. */
  phaseTimer: number;
  /** Raw ballot, so a vote in progress survives the handover. */
  ballot: Array<[PlayerId, string]>;
  /** The leader forced the start, so the ready gate is not re-checked. */
  forcedStart: boolean;
}

export interface PartyRecord {
  id: PartyId;
  leaderId: PlayerId;
  members: PlayerId[];
  createdAt: number;
  matchesTogether: number;
  colour: number;
  /** Last lobby the party was in, so a reload can rejoin it. */
  lobbyCode: RoomCode | null;
}

/* ---------------------------------------------------------------- emitter -- */

/**
 * The bus signature, narrowed. Passing an emitter in (rather than importing
 * `bus`) is what lets the harness run several lobbies side by side without
 * their events colliding.
 */
export type SessionEmitter = <K extends EventKey>(key: K, payload: GameEvents[K]) => void;

/** An emitter that drops everything — the default for headless tests. */
export const nullEmitter: SessionEmitter = () => { };
