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
import type { Objective } from '../Objectives';
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
}

export interface ModeOffer extends BuyOffer {
  apply(host: MatchHost): void;
}

export abstract class GameMode {
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
  onObjectiveComplete(_host: MatchHost, _objective: Objective): void { }
  onObjectiveFailed(_host: MatchHost, _objective: Objective): void { }
  /** Buy-phase slot press, 0-based. */
  onBuy(_host: MatchHost, _slot: number): void { }

  decorate(_snapshot: DirectorSnapshot): void { }
  end(_host: MatchHost, _win: boolean): void { }
}
