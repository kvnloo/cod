/**
 * Matchmaking event vocabulary.
 *
 * `GameEvents` in `src/core/EventBus.ts` is an interface, so it merges: this
 * file adds the session layer's events without editing a shared file, exactly
 * as `src/game/events.ts` does for the director.
 *
 * ## What the front end should show (UI is owned by another agent — these
 * events and `MatchmakingService.snapshot()` are the whole contract)
 *
 *  - `mm:queue:state` every ~250 ms while searching. A "SEARCHING FOR MATCH"
 *    panel wants: elapsed time, `candidates` (players currently in range),
 *    and the two windows. Showing the widening honestly — "skill range ±150,
 *    expanding" — reads as the game working rather than the game hanging.
 *  - `mm:queue:estimate` for the ETA line. `-1` means "no idea", show nothing.
 *  - `mm:match:found` → the lobby screen: two team columns from
 *    `roster.slots`, bots badged as BOT, the host marked, `quality.meanPing`
 *    in the corner.
 *  - `mm:bot:yield` → a killfeed-style line: "Nomad-42 left · Reaper joined".
 *    Never silently swap a bot for a human; players notice and it feels broken.
 *  - `mm:backfill:joined` → the "JOINING IN PROGRESS" banner.
 *  - `mm:rating:update` → the post-match skill delta chip (+18 SR).
 */

import type {
  BackfillRefusal, BotId, MatchId, MatchProposal, MatchRoster, PlayerId,
  PlaylistId, QueueState, TicketId,
} from './types';

declare module '../../core/EventBus' {
  interface GameEvents {
    /* --- queue --- */
    'mm:queue:state': {
      state: QueueState;
      playlist: PlaylistId | null;
      waited: number;
      skillWindow: number;
      pingWindow: number;
      crossRegion: boolean;
      botFillArmed: boolean;
      candidates: number;
    };
    'mm:queue:estimate': { seconds: number; confident: boolean };
    'mm:queue:left': { ticketId: TicketId; reason: 'player' | 'matched' | 'timeout' };

    /* --- lobby --- */
    'mm:match:found': { proposal: MatchProposal };
    'mm:roster:update': { roster: MatchRoster };
    'mm:host:elected': { matchId: MatchId; hostId: PlayerId | null; worstPing: number };

    /* --- bots --- */
    'mm:botfill': { matchId: MatchId; added: number; humans: number; bots: number };
    'mm:bot:yield': { matchId: MatchId; botId: BotId; botName: string; forPlayer: PlayerId; team: number };

    /* --- backfill --- */
    'mm:backfill:need': { matchId: MatchId; team: number; count: number };
    'mm:backfill:joined': { matchId: MatchId; playerId: PlayerId; team: number; late: boolean };
    'mm:backfill:refused': { matchId: MatchId; reason: BackfillRefusal };

    /* --- rating --- */
    'mm:rating:update': { playerId: PlayerId; before: number; after: number; delta: number; rd: number };
  }
}

export { };
