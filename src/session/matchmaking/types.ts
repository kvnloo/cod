/**
 * Matchmaking contracts.
 *
 * Everything in this module is plain data: ratings, tickets, rosters, bot
 * slots. No Three.js, no DOM, no engine — the whole system runs headlessly in
 * node (see `tools/session-mm.mjs`) which is the only way a queue can be tuned
 * honestly, and it is also what lets the host run it authoritatively while
 * clients only mirror it.
 *
 * ## Authority model
 *
 * The host owns the queue and the roster. A client never mutates either; it
 * sends a *request* (`queue:join`, `queue:leave`, `party:invite`) and waits for
 * the host to broadcast the resulting state. `MatchmakingService` enforces
 * this: on a client every mutating call becomes a message and the local state
 * is a read-only mirror updated from `roster:update` / `ticket:update`.
 *
 * The netcode layer does not exist yet, so the seam is `MatchmakingTransport`
 * below — four methods, all trivially satisfiable by whatever `src/net/`
 * lands. `LoopbackTransport` in `Transport.ts` implements it for solo play and
 * for the simulation.
 */

import type { Difficulty } from '../../ai/types';
import type { Archetype, GameModeId } from '../../game/types';

/* ------------------------------------------------------------------- ids -- */

export type PlayerId = string;
export type PartyId = string;
export type MatchId = string;
export type TicketId = string;
export type BotId = string;

/** Datacentre regions. Ping between them comes from `REGION_RTT` in `Connection.ts`. */
export type RegionId = 'na-east' | 'na-west' | 'eu-west' | 'eu-east' | 'apac' | 'oce' | 'sa';

export const REGIONS: readonly RegionId[] = [
  'na-east', 'na-west', 'eu-west', 'eu-east', 'apac', 'oce', 'sa',
];

/* ---------------------------------------------------------------- rating -- */

/**
 * Glicko-2 state for one player. `rating` is on the familiar 1500-centred
 * scale; `rd` is the standard deviation of our belief about it and `vol` is how
 * erratic their results have been.
 */
export interface SkillRating {
  rating: number;
  /** Rating deviation — 350 for an unrated player, ~50 for a well-known one. */
  rd: number;
  /** Glicko-2 volatility σ. */
  vol: number;
  /** Matches that have contributed to this rating. */
  matches: number;
  /** Match-clock timestamp (seconds) of the last rated match, for RD decay. */
  lastPlayed: number;
}

/** One player's persisted matchmaking record. */
export interface PlayerRecord {
  id: PlayerId;
  name: string;
  rating: SkillRating;
  /** Progression rank, used only to seed a brand new rating. */
  rank: number;
  /** Rolling per-minute combat score, used for the performance term. */
  avgScorePerMin: number;
  wins: number;
  losses: number;
  /** Matches abandoned early — feeds the backfill penalty and nothing else. */
  quits: number;
  region: RegionId;
}

/* ------------------------------------------------------------ connection -- */

export type NatType = 'open' | 'moderate' | 'strict';

export interface ConnectionInfo {
  region: RegionId;
  /**
   * Access-network latency added to every path this player takes (Wi-Fi, DSL,
   * cellular). Region RTT + both ends' last mile is the pairwise estimate.
   */
  lastMileMs: number;
  jitterMs: number;
  lossPct: number;
  nat: NatType;
  /** Upstream capacity in kbit/s — a host needs headroom for N clients. */
  upstreamKbps: number;
  /** False for players who can never be the authority (strict NAT, mobile). */
  hostCapable: boolean;
}

/* --------------------------------------------------------------- tickets -- */

export type PlaylistId =
  | 'core-tdm-6v6'
  | 'core-tdm-4v4'
  | 'ranked-tdm-4v4'
  | 'private-6v6'
  | 'operation-coop-4'
  | 'firefight-coop-4';

export interface PlaylistDef {
  id: PlaylistId;
  name: string;
  mode: GameModeId;
  /** Players per team. */
  teamSize: number;
  /** 2 for versus, 1 for co-op against the director's AI. */
  teams: 1 | 2;
  /** Below this many humans the match will not start, bots or not. */
  minHumansToStart: number;
  /** Ranked playlists refuse bot fill and refuse backfill into a live match. */
  allowBots: boolean;
  allowBackfill: boolean;
  ranked: boolean;
  /** Per-playlist overrides on the widening curve. */
  widening?: Partial<WideningParams>;
}

export type TicketKind = 'fresh' | 'backfill' | 'rejoin';

export interface QueueMember {
  playerId: PlayerId;
  name: string;
  rating: SkillRating;
  connection: ConnectionInfo;
  /** Progression rank — display only. */
  rank: number;
}

/** A party of 1..n players searching as a unit. Parties are never split. */
export interface QueueTicket {
  id: TicketId;
  partyId: PartyId;
  leaderId: PlayerId;
  members: QueueMember[];
  playlist: PlaylistId;
  kind: TicketKind;
  /** Queue-clock seconds at which the ticket entered. */
  joinedAt: number;
  /** Higher goes first among equally-old tickets. Backfill outranks fresh. */
  priority: number;
  /** Set for `rejoin` tickets: the match this party dropped out of. */
  preferredMatchId?: MatchId;
  /** Party skill: rating mean weighted so a strong leader carries the party. */
  skill: number;
  /** Largest RD in the party — the party is only as certain as its vaguest member. */
  rd: number;
}

/* ---------------------------------------------------------------- roster -- */

export interface HumanSlot {
  kind: 'human';
  playerId: PlayerId;
  name: string;
  team: number;
  rating: SkillRating;
  connection: ConnectionInfo;
  partyId: PartyId;
  /** Queue-clock seconds at which this player took the slot. */
  joinedAt: number;
  /** True when the player came in through backfill rather than at match start. */
  backfilled: boolean;
}

export interface BotSlot {
  kind: 'bot';
  botId: BotId;
  name: string;
  team: number;
  /** Notional rating, so team balance can treat bots and humans uniformly. */
  rating: number;
  difficulty: Difficulty;
  archetype: Archetype;
  /** Multipliers handed to the actor layer on top of the difficulty profile. */
  accuracyScale: number;
  aggressionScale: number;
  /** Deterministic appearance/behaviour seed. */
  seed: number;
  joinedAt: number;
  /**
   * Larger yields first when a human needs the slot. Newest bots yield before
   * bots that have been fighting for a while, so a live match churns as little
   * as possible.
   */
  yieldPriority: number;
}

export type MatchSlot = HumanSlot | BotSlot;

export interface MatchRoster {
  matchId: MatchId;
  playlist: PlaylistId;
  mode: GameModeId;
  teamSize: number;
  teams: 1 | 2;
  slots: MatchSlot[];
  /** Chosen authority. Null only while every candidate is unreachable. */
  hostId: PlayerId | null;
  formedAt: number;
  seed: number;
}

/** Quality report for a formed match — this is what the tuning tool prints. */
export interface MatchQuality {
  /** max(rating) - min(rating) across humans. */
  skillSpread: number;
  /** |team0 mean - team1 mean| including bots. */
  teamDelta: number;
  /** Mean member→host RTT estimate in ms. */
  meanPing: number;
  worstPing: number;
  humans: number;
  bots: number;
  /** Seconds the oldest ticket in this match waited. */
  seedWait: number;
  /** Seconds each ticket waited, longest first. */
  waits: number[];
}

export interface MatchProposal {
  roster: MatchRoster;
  quality: MatchQuality;
  ticketIds: TicketId[];
}

/* ----------------------------------------------------------- live match -- */

/**
 * The slice of a running match that backfill needs. `MatchRunner` does not
 * publish this yet (it is single-player today) and neither does the netcode
 * layer; whichever gets there first should implement this and hand it to
 * `MatchmakingService.registerMatch`.
 */
export interface LiveMatchView {
  matchId: MatchId;
  phase: 'warmup' | 'live' | 'intermission' | 'ending' | 'ended';
  /** Seconds of live match time elapsed. */
  elapsed: number;
  /** Total scheduled seconds, or -1 when the match is untimed. */
  duration: number;
  /** Score limit, or -1. */
  scoreLimit: number;
  /** Score per team, index-aligned with `MatchRoster.slots[].team`. */
  teamScores: number[];
}

export type BackfillRefusal =
  | 'ok'
  | 'playlist-forbids'
  | 'phase'
  | 'too-late'
  | 'blowout'
  | 'no-slot'
  /** Candidate is past the absolute ping ceiling; the bot keeps the slot. */
  | 'ping'
  | 'ranked'
  | 'match-unknown';

/* ------------------------------------------------------- widening curve -- */

/**
 * The knob that decides fast matches versus fair ones. See `Widening.ts` for
 * the curve itself and the reasoning behind each shape.
 */
export interface WideningParams {
  /** Rating points of skill difference tolerated at t=0. */
  skillWindow0: number;
  /** Seconds for the skill window to double. */
  skillDoubleEvery: number;
  skillWindowMax: number;
  /** Multiplier on the ticket's RD added to the skill window. */
  rdWeight: number;
  /** Ping (ms) tolerated at t=0. */
  pingWindow0: number;
  /** Extra ms of ping tolerated per second waited. */
  pingWidenRate: number;
  pingWindowMax: number;
  /** Seconds before players outside the seed's region are considered. */
  crossRegionAfter: number;
  /** Seconds before empty slots may be filled with bots. */
  botFillAfter: number;
  /**
   * Fraction of the lobby that must still be human at the instant bots first
   * arm. Decays to `minHumansToStart` by `hardTimeout`. 0 means "bots may take
   * every free slot the moment they arm" — correct for private lobbies, wrong
   * for a populated public playlist. See `humansRequired` in `Widening.ts`.
   */
  botFillFloor: number;
  /** Seconds after which we launch with whatever we have. */
  hardTimeout: number;
}

/* ------------------------------------------------------------- transport -- */

export type MatchmakingMessage =
  | { t: 'queue:join'; ticket: QueueTicket }
  | { t: 'queue:leave'; ticketId: TicketId }
  | { t: 'ticket:update'; ticketId: TicketId; waited: number; skillWindow: number; pingWindow: number; candidates: number; estimate: number }
  | { t: 'match:found'; proposal: MatchProposal }
  | { t: 'roster:update'; roster: MatchRoster }
  | { t: 'bot:yield'; matchId: MatchId; botId: BotId; forPlayer: PlayerId }
  | { t: 'backfill:request'; matchId: MatchId; team: number; count: number }
  | { t: 'rating:update'; playerId: PlayerId; before: number; after: number; rd: number };

/**
 * The seam to `src/net/`. Anything that can deliver an object to the host and
 * broadcast one back satisfies it.
 */
export interface MatchmakingTransport {
  readonly isHost: boolean;
  readonly localPlayerId: PlayerId;
  /** Client → host, or host → everyone. */
  send(msg: MatchmakingMessage): void;
  /** Returns an unsubscribe function. `from` is the sender's player id. */
  subscribe(fn: (msg: MatchmakingMessage, from: PlayerId) => void): () => void;
}

/* -------------------------------------------------------------- snapshot -- */

export type QueueState = 'idle' | 'searching' | 'found' | 'joining' | 'in-match';

/** One frame of matchmaking state for the front end. */
export interface MatchmakingSnapshot {
  state: QueueState;
  playlist: PlaylistId | null;
  playlistName: string;
  /** Seconds spent searching. */
  waited: number;
  /** Current constraints, so the UI can show "expanding search…". */
  skillWindow: number;
  pingWindow: number;
  crossRegion: boolean;
  botFillArmed: boolean;
  /** Tickets that currently satisfy our constraints (host-side truth). */
  candidates: number;
  /** Predicted seconds remaining, -1 when unknown. */
  estimate: number;
  /** Populated once a match is found. */
  roster: MatchRoster | null;
  quality: MatchQuality | null;
  /** Local player's rating, for the front end's skill chip. */
  rating: number;
  rd: number;
  region: RegionId;
  /** True on a client: everything above is a mirror of host state. */
  mirrored: boolean;
}
