/**
 * Game-mode contract.
 *
 * A mode is a script over the shared machinery: it configures the director,
 * pushes objectives, decides when the match is won or lost, and decorates the
 * HUD snapshot. It never owns spawning, scoring, killstreaks or the player
 * lifecycle — those are services it drives through `MatchHost`.
 */

import type * as THREE from 'three';
import type { Rand } from '../../core/Rand';
import type { Director } from '../Director';
import type { Killstreaks } from '../Killstreaks';
import type { Lifecycle } from '../Lifecycle';
import type { Objective, PresenceProbe } from '../Objectives';
import type { MatchLog } from '../Replay';
import type { Scoring, KillContext } from '../Scoring';
import type { CombatBridge } from '../Combat';
import type { Emitter, GameServices } from '../Services';
import type { BannerView, BuyOffer, DirectorSnapshot, GameModeId, MatchPhase } from '../types';

export interface MatchHost {
  readonly services: GameServices;
  readonly director: Director;
  readonly scoring: Scoring;
  readonly killstreaks: Killstreaks;
  readonly lifecycle: Lifecycle;
  readonly combat: CombatBridge;
  readonly rng: Rand;
  readonly log: MatchLog;
  /** Fixed-step counter since the match started. */
  readonly tick: number;
  /** Live match seconds. */
  readonly matchTime: number;
  readonly phase: MatchPhase;
  readonly emit: Emitter;

  setPhase(phase: MatchPhase): void;
  addObjective(objective: Objective): void;
  objectives(): readonly Objective[];
  clearObjectives(): void;
  finish(win: boolean): void;
  banner(title: string, subtitle: string, kind: BannerView['kind'], ttl?: number): void;
  countdown(seconds: number, label: string): void;

  /** Ground height under a point, from the physics probe when available. */
  groundAt(x: number, z: number, fallback: number): number;
  playerPosition(): THREE.Vector3 | null;
  /** A safe player spawn transform; writes the point, returns the yaw. */
  pickPlayerSpawn(out: THREE.Vector3): number;

  cash: number;
  addCash(amount: number, reason: string): void;
  spendCash(amount: number): boolean;

  /** Offers presented during a buy phase. */
  setOffers(offers: ModeOffer[]): void;

  /**
   * Installs the team-occupancy probe every team objective reads. Only the
   * active mode knows which entity id belongs to which side, so the mode hands
   * the lookup down rather than the objectives reaching up for it.
   */
  setPresenceProbe(probe: PresenceProbe | null): void;
}

export interface ModeOffer extends BuyOffer {
  apply(host: MatchHost): void;
}

export abstract class GameMode {
  /**
   * NOTE: still typed `GameModeId` on purpose. The real id space is `ModeId`
   * in `./ModeDefs`, which widens this union with dom/snd/hardpoint/kc/ffa.
   * `GameModeId` cannot be widened yet because `src/session/**` builds
   * exhaustive `Record<GameModeId, …>` tables over it and this module does not
   * own that file. `TeamMode` therefore exposes the honest id as `modeId` and
   * narrows here with a single documented cast; once the session layer absorbs
   * the new ids this annotation becomes `ModeId` and the cast disappears.
   */
  abstract readonly id: GameModeId;
  abstract readonly name: string;

  /** Score needed to win, or 0 when the mode is not score-limited. */
  scoreLimit = 0;
  /** Seconds on the match clock, or -1 for untimed. */
  timeLimit = -1;
  /** Total waves, or 0 when the mode has none. */
  waveTotal = 0;
  wave = 0;
  waveLabel = '';
  teamScore = 0;
  enemyScore = 0;

  abstract start(host: MatchHost): void;
  abstract fixedUpdate(dt: number, host: MatchHost): void;

  /** A kill the player is credited with. */
  onPlayerKill(_host: MatchHost, _ctx: KillContext, _victimId: number): void { }
  /** Any combatant death, including friendly bots. */
  onEntityDeath(_host: MatchHost, _id: number, _byPlayer: boolean): void { }
  onPlayerDeath(_host: MatchHost): void { }
  /**
   * The player ran out of lives in a no-respawn mode. Return true when the mode
   * absorbed it (round-based modes keep playing with the player spectating);
   * `MatchRunner` ends the match when it returns false.
   */
  onFinalDeath(_host: MatchHost): boolean { return false; }
  /**
   * Kill attribution from a layer that actually knows who pulled the trigger.
   * Two-team modes infer the scoring side from the victim, free-for-all cannot.
   * Called by `MatchRunner.reportKill`; the AI and netcode layers should route
   * their kills through it.
   */
  onKillAttributed(_host: MatchHost, _killerId: number, _victimId: number): void { }
  onObjectiveComplete(_host: MatchHost, _objective: Objective): void { }
  onObjectiveFailed(_host: MatchHost, _objective: Objective): void { }
  /** Buy-phase slot press, 0-based. */
  onBuy(_host: MatchHost, _slot: number): void { }

  /**
   * Per-mode player respawn. Return the yaw and write the point, or null to let
   * `MatchRunner` use its generic away-from-threats selector. This is how S&D
   * (fixed team pads) and Domination (spawn behind a flag you hold) get
   * fundamentally different behaviour out of the same machinery.
   */
  pickPlayerSpawn(_host: MatchHost, _out: THREE.Vector3): number | null { return null; }

  decorate(_snapshot: DirectorSnapshot): void { }
  end(_host: MatchHost, _win: boolean): void { }
}
