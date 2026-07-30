/**
 * Progression's slice of the event vocabulary.
 *
 * `GameEvents` is an open interface, so this adds the progression events by
 * declaration merging rather than editing a file another team owns. Every
 * consumer that imports anything from `src/session/progression` sees them with
 * full type safety.
 *
 * All of these are *presentation* events: the HUD, the after-action screen and
 * the audio layer listen; nothing in progression listens to its own events.
 */

import type {
  AfterActionReport, ChallengeReward, WeaponUnlockDef,
} from './types';

declare module '../../core/EventBus' {
  interface GameEvents {
    /** Weapon XP ticked. Fires at most once per kill, not per hit. */
    'progression:weapon:xp': {
      weapon: string; amount: number; total: number; level: number; pct: number;
    };
    /** A weapon crossed a level. `unlocked` may be empty. */
    'progression:weapon:levelup': {
      weapon: string; name: string; level: number; unlocked: WeaponUnlockDef[];
    };
    'progression:challenge:progress': {
      id: string; name: string; progress: number; goal: number;
    };
    'progression:challenge:complete': {
      id: string; name: string; xp: number; reward: ChallengeReward | null;
    };
    'progression:camo:unlocked': {
      weapon: string; weaponName: string; camo: string; camoName: string; mastery: boolean;
    };
    /** The full after-action report, emitted once per committed match. */
    'progression:afteraction': AfterActionReport;
    /** Fired after the profile is read from storage — useful for a "welcome back". */
    'progression:profile:loaded': {
      rank: number; xp: number; foundVersion: number; migrated: boolean; readOnly: boolean;
    };
  }
}

export { };
