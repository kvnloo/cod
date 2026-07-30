/**
 * Lobby event vocabulary.
 *
 * `GameEvents` is an open interface, so the session layer adds its own keys by
 * declaration merging instead of editing `src/core/EventBus.ts` — the same
 * trick `src/game/events.ts` uses. Every module in the program sees the merged
 * type, which means the menu UI can write `bus.on('lobby:state', …)` with full
 * type safety and zero imports from this directory.
 *
 * The contract for listeners: **`lobby:state` is the truth**. Every other event
 * here is a *notification* — a hook for a sound, an animation or a toast — and
 * carries only what the presentation needs. Never accumulate lobby state from
 * the granular events; render from `lobby:state` and animate from the rest.
 */

import type {
  CountdownAbortReason, LobbyPhase, LobbyResult, LobbyState, MatchConfig, MemberConnection,
  MemberState, PartyView, PlayerId, RoomCode, SessionTeam, TeamSummary, VoteCandidate,
  VoteResolution,
} from '../types';
import type { LobbyErrorCode } from './Commands';

declare module '../../core/EventBus' {
  interface GameEvents {
    /* --- the read model --- */
    'lobby:state': LobbyState;

    /* --- room --- */
    'lobby:created': { id: string; code: RoomCode; hostId: PlayerId };
    'lobby:closed': { id: string; reason: string };
    /** The local player's join was accepted. */
    'lobby:joined': { id: string; code: RoomCode; localId: PlayerId; member: MemberState };

    /* --- membership --- */
    'lobby:member:join': { member: MemberState; count: number; capacity: number };
    'lobby:member:leave': {
      id: PlayerId; name: string; count: number;
      reason: 'left' | 'kicked' | 'dropped' | 'timeout' | 'load-timeout';
    };
    'lobby:member:ready': { id: PlayerId; name: string; ready: boolean; readyCount: number; total: number };
    'lobby:member:connection': { id: PlayerId; connection: MemberConnection };
    'lobby:leader': { id: PlayerId; name: string; previous: PlayerId };

    /* --- lifecycle --- */
    'lobby:phase': { phase: LobbyPhase; previous: LobbyPhase; clock: number };
    'lobby:countdown': { secondsLeft: number; total: number; label: string };
    'lobby:countdown:abort': { reason: CountdownAbortReason; text: string };
    'lobby:loading': { loaded: number; total: number; progress: number };
    /** The launch order. The game layer listens for this and starts the match. */
    'lobby:launch': MatchConfig;
    'lobby:result': LobbyResult;

    /* --- vote --- */
    'lobby:vote:open': { candidates: VoteCandidate[]; seconds: number };
    'lobby:vote:cast': { playerId: PlayerId; candidateId: string; cast: number; total: number };
    'lobby:vote:result': {
      candidateId: string; mapId: string; mapName: string;
      modeId: string; modeName: string; resolvedBy: VoteResolution;
    };

    /* --- teams and parties --- */
    'lobby:teams': { teams: TeamSummary[]; splitParties: string[]; skillGap: number };
    'lobby:party:update': { parties: PartyView[]; localPartyId: string | null };
    'lobby:party:invite': { from: PlayerId; fromName: string; to: PlayerId; partyId: string };

    /* --- authority --- */
    'lobby:host:migrated': { from: PlayerId; to: PlayerId; epoch: number; graceSec: number };

    /* --- failures --- */
    'lobby:error': { code: LobbyErrorCode; error: string; playerId: PlayerId };
  }
}

export {};
