/**
 * The client → host command vocabulary.
 *
 * This is the whole authority story in one file. A client never edits lobby
 * state; it submits one of these, the host validates it against the current
 * phase and the sender's role, applies it if legal, and publishes a new state.
 * Nothing outside `LobbyHost` mutates anything.
 *
 * `from` is never carried in the payload — the host is told who sent a command
 * by the transport, so a client cannot forge another player's identity by
 * writing a different id into the message.
 */

import type {
  GameModeId, LobbyResult, LobbySettings, PartyId, PlayerId, PlayerProfile, RoomCode, SessionTeam,
} from '../types';

export type LobbyCommand =
  /** Ask to enter a lobby. The host checks the code, capacity and phase. */
  | { t: 'join'; code: RoomCode; profile: PlayerProfile; partyId?: PartyId | null }
  | { t: 'leave' }
  /** Leader-only. */
  | { t: 'kick'; target: PlayerId; reason?: string }
  /** Leader-only: hand the lobby leadership to someone else. */
  | { t: 'promote'; target: PlayerId }
  | { t: 'ready'; ready: boolean }
  | { t: 'vote'; candidateId: string }
  /** Leader-only. Any change aborts an armed countdown. */
  | { t: 'settings'; patch: Partial<LobbySettings> }
  /** Leader-only shortcut for `settings` when pinning the match. */
  | { t: 'pin'; mapId: string | null; modeId: GameModeId | null }
  | { t: 'switchTeam'; team: SessionTeam }
  | { t: 'party:create' }
  | { t: 'party:invite'; target: PlayerId }
  | { t: 'party:accept'; partyId: PartyId }
  | { t: 'party:leave' }
  | { t: 'party:promote'; target: PlayerId }
  /** Leader-only: arm the countdown without waiting for stragglers. */
  | { t: 'start' }
  /** Leader-only: disarm it. */
  | { t: 'cancel' }
  /** Level streaming progress, 0..1. */
  | { t: 'loading'; progress: number }
  /** Keeps the member's `lastSeen` fresh and updates the displayed ping. */
  | { t: 'heartbeat'; ping: number }
  /** Host-local: the game layer reporting that the match finished. */
  | { t: 'matchEnded'; result: LobbyResult };

export type LobbyCommandType = LobbyCommand['t'];

export type LobbyErrorCode =
  | 'not-host'
  | 'not-leader'
  | 'not-member'
  | 'already-member'
  | 'full'
  | 'bad-code'
  | 'wrong-phase'
  | 'unknown-target'
  | 'unknown-candidate'
  | 'unknown-command'
  | 'team-full'
  | 'not-allowed'
  | 'bad-argument';

export interface CommandResult {
  ok: boolean;
  code?: LobbyErrorCode;
  /** Human-readable, safe to show in a toast. */
  error?: string;
}

export const OK: CommandResult = { ok: true };

export function fail(code: LobbyErrorCode, error: string): CommandResult {
  return { ok: false, code, error };
}

/** Commands only the lobby leader may issue. */
export const LEADER_ONLY: ReadonlySet<LobbyCommandType> = new Set<LobbyCommandType>([
  'kick', 'promote', 'settings', 'pin', 'start', 'cancel',
]);

/** Commands that are meaningless outside `forming`. */
export const FORMING_ONLY: ReadonlySet<LobbyCommandType> = new Set<LobbyCommandType>([
  'vote', 'settings', 'pin', 'switchTeam', 'start',
]);
