/**
 * Game-layer contracts.
 *
 * The director never imports another gameplay system. Everything it needs from
 * the outside world is expressed here as a narrow, optional capability
 * interface — exactly the pattern `PhysicsAPI` / `RenderAPI` use — and resolved
 * at runtime by `Services.ts`. When a capability is missing the director
 * degrades to its own implementation rather than failing, which is what lets
 * this module be developed, verified and shipped independently of AI, HUD and
 * weapons.
 */

import type * as THREE from 'three';
import type { CharacterFaction, CharacterLoadout } from '../characters/types';

/* ------------------------------------------------------------------ modes -- */

export type GameModeId = 'operation' | 'tdm' | 'firefight';

/**
 * Match phases. `warmup` and `intermission` are playable but non-scoring;
 * `ending` is the frozen post-match beat before the summary is handed over.
 */
export type MatchPhase =
  | 'idle'
  | 'warmup'
  | 'live'
  | 'intermission'
  | 'ending'
  | 'ended';

export type Team = 'friendly' | 'hostile';

/** Enemy archetypes mirror `CharacterLoadout` so the AI bridge needs no mapping. */
export type Archetype = CharacterLoadout;

export interface ArchetypeProfile {
  id: Archetype;
  name: string;
  /** Base health before director scaling. */
  health: number;
  /** Preferred engagement distance in metres. */
  range: number;
  /** Rounds per minute for the fallback combat sim. */
  rpm: number;
  /** Damage per round at the muzzle. */
  damage: number;
  /** 0..1 base hit probability at preferred range. */
  accuracy: number;
  /** Metres/second ground speed when advancing. */
  speed: number;
  /** Score/XP awarded for a kill. */
  score: number;
  /** Cash awarded in Operation. */
  cash: number;
  /** How much of the director's engagement budget one of these consumes. */
  weight: number;
  /** Radius of the body capsule, used by the fallback sim and markers. */
  radius: number;
  height: number;
}

/* --------------------------------------------------------------- spawning -- */

export interface SpawnRequest {
  archetype: Archetype;
  faction: CharacterFaction;
  team: Team;
  position: THREE.Vector3;
  yaw: number;
  /** Deterministic appearance/behaviour seed. */
  seed: number;
  /** Director difficulty scalars, all multiplicative around 1.0. */
  health: number;
  accuracy: number;
  aggression: number;
  /** Free-form tag used for telemetry and objective bookkeeping. */
  tag: string;
}

export interface CombatantHandle {
  readonly id: number;
  readonly team: Team;
  readonly archetype: Archetype;
}

/**
 * What the director needs from an actor system. `AISystem` is expected to grow
 * these; until it does, `BotFallback` inside this module provides them so the
 * game is playable and verifiable end to end.
 */
export interface ActorAPI {
  /** Spawns one combatant. Returns its entity id, or -1 if it could not spawn. */
  spawnCombatant(req: SpawnRequest): number;
  despawnCombatant(id: number): void;
  isCombatantAlive(id: number): boolean;
  /** Writes the world position of a live combatant; false when it is gone. */
  combatantPosition(id: number, out: THREE.Vector3): boolean;
  /**
   * Applies damage from a non-ballistics source (sentry gun, airstrike,
   * explosion). Returns true when the hit was lethal.
   */
  damageCombatant(id: number, amount: number, opts: DamageOpts): boolean;
  /** Global accuracy multiplier — the director throttles difficulty with it. */
  setAccuracyScale?(scale: number): void;
  /** Freezes combat during warmup / intermission / post-match. */
  setCombatEnabled?(on: boolean): void;
  /** Live combatant ids written into `out`; returns the count. */
  listCombatants?(out: number[]): number;
}

export interface DamageOpts {
  headshot?: boolean;
  point?: THREE.Vector3;
  direction?: THREE.Vector3;
  fromPlayer?: boolean;
  /** 'sentry' | 'airstrike' | 'explosion' | ... — used for the killfeed. */
  source?: string;
}

/* ----------------------------------------------------------------- player -- */

/** The slice of the player system the match needs to run its lifecycle. */
export interface PlayerBridge {
  readonly position: THREE.Vector3;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  readonly entityId: number;
  spawnAt(position: THREE.Vector3, yaw: number): void;
  revive?(): void;
  heal?(amount: number): void;
  applyDamage?(amount: number, fromDirection: THREE.Vector3, lethal: boolean): void;
}

/* ------------------------------------------------------------------ world -- */

export interface WorldSpawnPoint {
  position: THREE.Vector3;
  yaw: number;
  team: 'player' | 'enemy' | 'neutral';
}

export interface WorldBridge {
  spawns?: WorldSpawnPoint[];
  cover?: Array<{ position: THREE.Vector3; normal: THREE.Vector3; height: 'low' | 'high' }>;
  bounds?: THREE.Box3;
}

/* ------------------------------------------------------------- objectives -- */

export type ObjectiveKind =
  | 'eliminate' | 'survive' | 'hold' | 'plant' | 'defuse' | 'extract' | 'reach' | 'destroy';

export type ObjectiveState = 'pending' | 'active' | 'complete' | 'failed';

export interface ObjectiveView {
  id: string;
  kind: ObjectiveKind;
  state: ObjectiveState;
  /** Short all-caps HUD label, e.g. "SECURE LZ". */
  label: string;
  /** One-line instruction under the label. */
  hint: string;
  /** 0..1 completion. */
  progress: number;
  /** Seconds remaining on the objective clock, or -1 when untimed. */
  timer: number;
  /** World anchor for the 3D marker, or null. */
  position: [number, number, number] | null;
  radius: number;
  /** True while the player is contesting/inside the objective volume. */
  contested: boolean;
}

/* ------------------------------------------------------------ killstreaks -- */

export type KillstreakId = 'uav' | 'counteruav' | 'carepackage' | 'airstrike' | 'sentry';

export interface KillstreakView {
  id: KillstreakId;
  name: string;
  cost: number;
  /** Earned and waiting in a slot. */
  ready: boolean;
  /** Currently deployed. */
  active: boolean;
  /** Seconds of deployment left, or -1. */
  remaining: number;
  selected: boolean;
}

/* ------------------------------------------------------------ progression -- */

export interface UnlockDef {
  id: string;
  name: string;
  kind: 'weapon' | 'attachment' | 'perk' | 'killstreak';
  rank: number;
  /** Weapon this attachment belongs to, when kind === 'attachment'. */
  parent?: string;
}

export interface MatchSummaryRow {
  label: string;
  value: string;
  /** XP contribution, when this row is an XP source. */
  xp?: number;
}

export interface MatchSummary {
  mode: GameModeId;
  modeName: string;
  win: boolean;
  durationSec: number;
  score: number;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  bestStreak: number;
  wavesCleared: number;
  objectivesComplete: number;
  accuracy: number;
  xpEarned: number;
  rankBefore: number;
  rankAfter: number;
  rankName: string;
  xpIntoRank: number;
  xpForNext: number;
  unlocked: UnlockDef[];
  rows: MatchSummaryRow[];
  seed: number;
  /** Deterministic fingerprint of the match log — equal seeds must match. */
  replayHash: string;
}

/* --------------------------------------------------------------- snapshot -- */

export interface BannerView {
  title: string;
  subtitle: string;
  kind: 'objective' | 'wave' | 'alert' | 'reward' | 'result';
  /** Seconds remaining on screen. */
  ttl: number;
}

export interface RadarContact {
  x: number;
  z: number;
  /** Heading in radians. */
  yaw: number;
  hostile: boolean;
}

export interface DirectorSnapshot {
  mode: GameModeId;
  modeName: string;
  phase: MatchPhase;
  phaseTime: number;
  /** Seconds of live match time elapsed. */
  matchTime: number;
  /** Seconds remaining on the match clock, or -1 for untimed. */
  timeRemaining: number;

  wave: number;
  waveTotal: number;
  waveLabel: string;
  enemiesRemaining: number;
  enemiesAlive: number;

  score: number;
  teamScore: number;
  enemyScore: number;
  scoreLimit: number;

  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  streak: number;
  bestStreak: number;
  cash: number;
  intensity: number;

  health: number;
  maxHealth: number;
  downed: boolean;
  downedRemaining: number;
  respawnIn: number;

  rank: number;
  rankName: string;
  xp: number;
  xpIntoRank: number;
  xpForNext: number;

  objectives: ObjectiveView[];
  killstreaks: KillstreakView[];
  banner: BannerView | null;
  /** Populated while a UAV sweep is up. */
  contacts: RadarContact[];
  /** Buy-menu offers during an Operation intermission. */
  offers: BuyOffer[];
  summary: MatchSummary | null;
  markingStrike: boolean;
}

export interface BuyOffer {
  id: string;
  name: string;
  detail: string;
  cost: number;
  affordable: boolean;
  kind: 'weapon' | 'attachment' | 'perk' | 'ammo' | 'armor' | 'killstreak';
}

/** Public surface other systems (HUD, menus) may read from `engine.get('director')`. */
export interface DirectorAPI {
  readonly mode: GameModeId;
  readonly phase: MatchPhase;
  snapshot(): DirectorSnapshot;
  startMatch(mode: GameModeId, seed?: number): void;
  endMatch(win: boolean): void;
}
