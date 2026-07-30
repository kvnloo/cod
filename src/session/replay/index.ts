/**
 * Engine-facing entry point for the replay layer.
 *
 * `core.ts` is the pure barrel — no THREE, no DOM — and is what the node
 * verifier compiles. This module re-exports all of it and adds `ReplayService`,
 * the single object a game or UI drives so it does not have to wire a recorder,
 * a killcam director, a spectator controller and a theater session together by
 * hand.
 *
 * AUTHORITY
 * ---------
 * The netcode layer is being built in parallel, so this codes against a narrow
 * interface (`ReplayAuthority`) rather than reaching into `src/net`. The rule it
 * encodes is the one that matters: **the host decides, clients display.**
 *
 *   • Only a host holds a `ReplaySim` and can write keyframes, so only a host
 *     can produce a re-simulatable recording.
 *   • A client records the snapshot and event tracks it is *sent*. That is
 *     enough for killcam, spectating and theater playback, all of which read
 *     the snapshot track and never run the simulation.
 *   • Nothing here mutates shared game state. Asking to spectate someone is a
 *     request that `spectatorRules` may refuse; it is not a local write.
 *
 * WHAT THE UI SHOULD SHOW (this module exposes state, it draws nothing):
 *   • `state()` → `ReplayServiceState`, safe to poll every frame.
 *   • `mode === 'killcam'`: the killer's name, weapon, distance and whether it
 *     was a headshot come from `killcamFrame`; `shotLineAlpha` fades the tracer
 *     in at impact; `timeScale < 1` means slow motion, so damp any HUD motion.
 *   • `mode === 'spectate'`: show the followed player's name and the cycle
 *     hints; `canFree` decides whether the free-camera prompt is offered.
 *   • `mode === 'theater'`: `theater` carries the scrub position, duration and
 *     bookmark list to draw the timeline.
 *   • `pose` is a plain camera pose in world units — copy it onto the render
 *     camera. This layer deliberately never imports THREE.
 */

export * from './core';

import {
  KillcamDirector, defaultKillcamOptions, finalKillcamOptions, planFinalKillcam, planKillcam,
  type KillcamFrame, type KillcamOptions, type KillcamPlan,
} from './Killcam';
import { ReplayRecorder } from './Recorder';
import { SnapshotPlayback } from './Playback';
import {
  SnapshotActorSource, SpectatorController, spectatorRules,
  type SpectatorContext, type SpectatorMode,
} from './Spectator';
import { TheaterSession, type TheaterState } from './Theater';
import { encodeReplay, type ReplayFile } from './ReplayFile';
import type { FreeCamInput } from './CameraSolver';
import {
  type ActorSample, type CameraPose, type InputFrame, type RecorderConfig,
  type ReplayEvent, type ReplaySim, cameraPose, defaultRecorderConfig,
} from './types';

/* ------------------------------------------------------------- authority -- */

/**
 * The slice of the netcode layer this module needs. Implement it over whatever
 * `src/net` ends up exposing; nothing here assumes more than these four facts.
 */
export interface ReplayAuthority {
  /** True on the machine that owns the simulation. Only a host writes keyframes. */
  isHost(): boolean;
  /** Local player's actor id, or -1 while not yet assigned. */
  localActor(): number;
  /** Local player's team, for the spectate-your-own-team restriction. */
  localTeam(): number;
  /** True once the match is over — after which free camera is allowed. */
  matchOver(): boolean;
}

/**
 * A stand-in for offline play and tests: this machine is the host and owns the
 * simulation, so it may write keyframes. `endMatch()` flips the flag that
 * unlocks the free camera.
 */
export class OfflineAuthority implements ReplayAuthority {
  private over = false;

  constructor(private actor = 0, private team = 0) { }

  isHost(): boolean { return true; }
  localActor(): number { return this.actor; }
  localTeam(): number { return this.team; }
  matchOver(): boolean { return this.over; }

  setLocal(actor: number, team: number): void { this.actor = actor; this.team = team; }
  endMatch(): void { this.over = true; }
}

export function offlineAuthority(localActor = 0, localTeam = 0): OfflineAuthority {
  return new OfflineAuthority(localActor, localTeam);
}

/* ----------------------------------------------------------------- state -- */

export type ReplayServiceMode = 'live' | 'killcam' | 'spectate' | 'theater';

export interface ReplayServiceState {
  mode: ReplayServiceMode;
  recording: boolean;
  /** Seconds of match history currently resident in the ring. */
  bufferedSeconds: number;
  /** Total bytes the rings occupy. Fixed at construction — see `RecorderConfig`. */
  bytes: number;
  killcam: KillcamFrame | null;
  spectateMode: SpectatorMode;
  spectateTarget: number;
  canFree: boolean;
  theater: TheaterState | null;
}

/* --------------------------------------------------------------- service -- */

export class ReplayService {
  readonly recorder: ReplayRecorder;
  readonly playback: SnapshotPlayback;
  readonly killcam = new KillcamDirector();
  readonly spectator = new SpectatorController();
  readonly theater = new TheaterSession();
  readonly pose: CameraPose = cameraPose();

  private authority: ReplayAuthority;
  private source: SnapshotActorSource;
  private mode: ReplayServiceMode = 'live';

  constructor(
    authority: ReplayAuthority = offlineAuthority(),
    config: Partial<RecorderConfig> = defaultRecorderConfig(),
  ) {
    this.authority = authority;
    this.recorder = new ReplayRecorder(config);
    this.playback = new SnapshotPlayback(this.recorder.snapshots);
    this.source = new SnapshotActorSource(this.playback);
  }

  setAuthority(a: ReplayAuthority): void { this.authority = a; }

  /* ------------------------------------------------------------- record -- */

  begin(seed: number, mode: string, formatVersion = 1): void {
    this.recorder.begin(seed, mode, formatVersion);
    this.mode = 'live';
    this.killcam.stop();
    this.spectator.stop();
  }

  stop(): void { this.recorder.stop(); }

  /**
   * Host path: call around the fixed step, with the same `sim` both times.
   * `beforeStep` must run *before* any of this tick's input is recorded — a
   * keyframe stamped tick N is the state at the start of tick N, and capturing
   * it after the step puts the blob one tick out of phase with the input
   * stream, which is the classic way a replay drifts.
   */
  beforeStep(sim: ReplaySim | null): void {
    if (this.authority.isHost()) this.recorder.beforeStep(sim);
  }

  afterStep(sim: ReplaySim | null): void {
    this.recorder.afterStep(this.authority.isHost() ? sim : null);
  }

  recordInput(f: InputFrame): void { this.recorder.recordInput(f); }

  /** Client path: feed the snapshot track straight from the wire. */
  recordSnapshot(actors: readonly ActorSample[], n: number): void {
    this.recorder.recordSnapshot(actors, n);
  }

  recordEvent(e: ReplayEvent): void { this.recorder.recordEvent(e); }

  /** Clients advance the tick themselves; hosts get it from `afterStep`. */
  advance(): void { this.recorder.advance(); }

  /* ------------------------------------------------------------ killcam -- */

  /**
   * Show the local player their own death. Returns false when there is nothing
   * honest to show — no recorded killer, or the ring no longer reaches back —
   * in which case the caller should go straight to the respawn flow rather than
   * display a broken clip.
   */
  showKillcam(victim: number, deathTick = -1, options: KillcamOptions = defaultKillcamOptions()): boolean {
    const plan = planKillcam(this.recorder, victim, deathTick, options, this.recorder.strings);
    return this.beginKillcam(plan);
  }

  /** End-of-match killcam: the last kill, from whoever made it. */
  showFinalKillcam(options: KillcamOptions = finalKillcamOptions()): boolean {
    return this.beginKillcam(planFinalKillcam(this.recorder, options, this.recorder.strings));
  }

  private beginKillcam(plan: KillcamPlan): boolean {
    if (!plan.valid || !this.killcam.begin(plan, this.playback)) return false;
    this.mode = 'killcam';
    // `pose` must be valid the instant the mode changes. A caller that reads it
    // before the next `update()` — to place the camera on the frame the death
    // is registered — would otherwise get the previous view for one frame,
    // which reads as the killcam starting from wherever the player was killed.
    this.copy(this.killcam.pose);
    return true;
  }

  skipKillcam(): void {
    if (this.mode !== 'killcam') return;
    this.killcam.stop();
    this.mode = 'live';
  }

  /* ----------------------------------------------------------- spectate -- */

  /**
   * Enter spectator. The restrictions are computed from the live context, not
   * trusted from the caller: a dead player may follow their own team, an
   * observer may follow anyone, and free camera waits for the match to end.
   */
  spectate(): void {
    this.mode = 'spectate';
    this.refreshRules(false);
    this.spectator.refreshTargets(this.source);
    if (this.spectator.targetList.length > 0) this.spectator.cycle(1);
    // Prime the pose so it is valid before the first `update()`. dt = 0 makes
    // the solver snap rather than ease in from the previous view.
    this.spectator.update(0, this.source, null);
    this.copy(this.spectator.pose);
  }

  cycleSpectate(dir: 1 | -1): number { return this.spectator.cycle(dir); }
  cycleSpectateMode(): SpectatorMode { return this.spectator.cycleMode(); }

  leaveSpectate(): void {
    if (this.mode !== 'spectate') return;
    this.spectator.stop();
    this.mode = 'live';
  }

  private refreshRules(killcamActive: boolean): void {
    const ctx: SpectatorContext = {
      matchOver: this.authority.matchOver(),
      viewerAlive: false,
      viewerTeam: this.authority.localTeam(),
      observer: false,
      killcamActive,
      killer: this.killcam.plan ? this.killcam.plan.killer : -1,
    };
    this.spectator.setRules(spectatorRules(ctx));
  }

  /* ------------------------------------------------------------ theater -- */

  /** Save the whole recording so it can be re-opened in theater. */
  save(label = 'match'): ReplayFile { return encodeReplay(this.recorder, label); }

  /** Open a saved replay. Returns false if it came from an incompatible build. */
  openTheater(file: ReplayFile): boolean {
    if (!this.theater.loadFile(file)) return false;
    this.mode = 'theater';
    this.theater.step(0, null);
    this.copy(this.theater.pose);
    return true;
  }

  /** Open the recording still in memory, without a save/load round trip. */
  openTheaterLive(): boolean {
    this.theater.attach(this.recorder);
    if (!this.theater.loaded) return false;
    this.mode = 'theater';
    this.theater.step(0, null);
    this.copy(this.theater.pose);
    return true;
  }

  closeTheater(): void {
    if (this.mode !== 'theater') return;
    this.theater.unload();
    this.mode = 'live';
  }

  /* --------------------------------------------------------------- tick -- */

  /** Drives whichever view is active and updates `pose`. `dt` is real seconds. */
  update(dt: number, input: FreeCamInput | null = null): void {
    switch (this.mode) {
      case 'killcam':
        this.killcam.step(dt);
        this.copy(this.killcam.pose);
        // A killcam ends itself; fall through to spectate so the player is not
        // left staring at a frozen frame.
        if (!this.killcam.active) { this.killcam.stop(); this.spectate(); }
        break;
      case 'spectate':
        this.refreshRules(false);
        this.spectator.update(dt, this.source, input);
        this.copy(this.spectator.pose);
        break;
      case 'theater':
        this.theater.step(dt, input);
        this.copy(this.theater.pose);
        break;
      default:
        break;
    }
  }

  private copy(p: CameraPose): void {
    this.pose.x = p.x; this.pose.y = p.y; this.pose.z = p.z;
    this.pose.yaw = p.yaw; this.pose.pitch = p.pitch;
    this.pose.roll = p.roll; this.pose.fov = p.fov;
  }

  /* -------------------------------------------------------------- query -- */

  /** Actors to draw for the currently displayed instant. */
  actorsNow(out: ActorSample[]): number {
    if (this.mode === 'theater') return this.theater.actorsNow(out);
    if (this.mode === 'killcam') return this.killcam.actors(out);
    return 0;
  }

  state(): ReplayServiceState {
    const w = this.recorder.window();
    return {
      mode: this.mode,
      recording: this.recorder.recording,
      bufferedSeconds: w.seconds,
      bytes: this.recorder.stats().totalBytes,
      killcam: this.mode === 'killcam' ? this.killcam.frame : null,
      spectateMode: this.spectator.mode,
      spectateTarget: this.spectator.target,
      canFree: this.spectator.rules.allowFree,
      theater: this.mode === 'theater' ? this.theater.state() : null,
    };
  }

}
