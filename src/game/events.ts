/**
 * Game-layer event vocabulary.
 *
 * `GameEvents` in `src/core/EventBus.ts` is an interface, so it is open for
 * declaration merging: this module adds the director's events without editing a
 * shared file. Any module in the program sees the merged type, which means the
 * HUD can `bus.on('hud:banner', ...)` with full type safety.
 *
 * Two of these are *request* events — `ai:spawn:request` and `ai:damage:request`.
 * They carry a mutable result field that a handler fills in. That gives us
 * request/response over a fire-and-forget bus without either side holding a
 * reference to the other; when nobody answers, the director falls back to its
 * own combat sim.
 */

import type { Vector3 } from 'three';
import type {
  BannerView, BuyOffer, DirectorSnapshot, GameModeId, KillstreakId, MatchPhase,
  MatchSummary, ObjectiveView, RadarContact, SpawnRequest, Team, UnlockDef,
} from './types';

declare module '../core/EventBus' {
  interface GameEvents {
    /* --- match state machine --- */
    'match:state': { mode: GameModeId; phase: MatchPhase; previous: MatchPhase; time: number };
    'match:countdown': { seconds: number; label: string };
    'match:summary': MatchSummary;

    /* --- waves / director --- */
    'wave:start': { index: number; total: number; label: string; enemies: number };
    'wave:cleared': { index: number; bonus: number; nextIn: number };
    'director:intensity': { value: number; target: number; active: number; budget: number };

    /* --- objectives --- */
    'objective:added': ObjectiveView;
    'objective:update': ObjectiveView;
    'objective:complete': { id: string; label: string; score: number };
    'objective:failed': { id: string; label: string };

    /* --- HUD presentation --- */
    'hud:banner': BannerView;
    'hud:announce': { key: string; text: string; priority: number };
    'hud:score': { amount: number; reason: string; total: number };
    'hud:snapshot': DirectorSnapshot;
    'hud:offers': { offers: BuyOffer[]; cash: number; secondsLeft: number };

    /* --- scoring --- */
    'streak:multikill': { count: number; name: string; window: number };
    'streak:progress': { kills: number; next: KillstreakId | null; needed: number };

    /* --- killstreaks --- */
    'killstreak:ready': { id: KillstreakId; name: string; slot: number };
    'killstreak:activated': { id: KillstreakId; name: string; position: Vector3 };
    'killstreak:expired': { id: KillstreakId; name: string };
    'killstreak:select': { id: KillstreakId | null; slot: number };
    'uav:sweep': { active: boolean; period: number; counter: boolean };
    'radar:contacts': { contacts: RadarContact[]; source: 'uav' | 'sentry' | 'objective' };
    'airstrike:marking': { active: boolean; valid: boolean; point: Vector3 };
    'airstrike:inbound': { point: Vector3; eta: number; heading: number };

    /* --- progression --- */
    'xp:award': { amount: number; reason: string; total: number };
    'rank:up': { rank: number; name: string; total: number };
    'unlock:granted': UnlockDef;
    'cash:change': { cash: number; delta: number; reason: string };

    /* --- player lifecycle --- */
    'player:downed': { bleedout: number };
    'player:revived': { health: number };
    'player:respawn:timer': { seconds: number; total: number };
    'player:respawn': { point: Vector3; yaw: number };
    'player:killed': { by: string; distance: number; headshot: boolean };

    /* --- actor bridge (request/response) --- */
    'ai:spawn:request': { req: SpawnRequest; id: number };
    'ai:damage:request': {
      id: number; amount: number; headshot: boolean; fromPlayer: boolean;
      source: string; point: Vector3 | null; direction: Vector3 | null;
      applied: boolean; killed: boolean;
    };
    'ai:combat:enabled': { on: boolean; team: Team | 'all' };
    'ai:accuracy:scale': { scale: number };
  }
}

export {};
