/**
 * Theater — the whole match, scrubbable, with the camera off the leash.
 *
 * Theater is the same recording the killcam uses, just not clipped to a
 * window. It adds three things:
 *
 *   • a transport (play / pause / rate, including reverse) that works by
 *     *seeking* rather than by stepping, so scrubbing backwards costs the same
 *     as scrubbing forwards,
 *   • bookmarks generated from the event track, because nobody scrubs a
 *     10 minute match by hand looking for the one triple, and
 *   • camera modes, all of which are unlocked here: theater has no competitive
 *     integrity to protect.
 *
 * Playback is snapshot interpolation, never re-simulation. Re-simulating in
 * theater would mean the file has to match the build exactly; interpolating
 * means an old replay still plays. `ResimPlayer` is available separately for
 * the cases that need bit-exactness (determinism checks, host-side rewind).
 */

import { FreeCamera, type FreeCamInput } from './CameraSolver';
import { KillcamDirector, planKillcam, type KillcamOptions } from './Killcam';
import { SnapshotPlayback } from './Playback';
import type { ReplayRecorder } from './Recorder';
import { SnapshotActorSource, SpectatorController, spectatorRules } from './Spectator';
import {
  TICK_DT, type ActorSample, type CameraPose, type ReplayEvent,
  cameraPose, replayEvent,
} from './types';
import { decodeReplay, type ReplayFile } from './ReplayFile';

export type TheaterCamera = 'free' | 'follow' | 'killcam';

export interface TheaterBookmark {
  /** Match time in seconds. */
  time: number;
  tick: number;
  kind: ReplayEvent['kind'];
  /** Actor whose moment this is (killer for kills). */
  actor: number;
  other: number;
  label: string;
  headshot: boolean;
}

export interface TheaterState {
  loaded: boolean;
  playing: boolean;
  /** Playback rate; negative rewinds. */
  rate: number;
  time: number;
  duration: number;
  camera: TheaterCamera;
  followTarget: number;
  bookmarkCount: number;
  /** Index of the bookmark at or before `time`, or -1. */
  bookmark: number;
  mode: string;
  seed: number;
}

const RATES = [-4, -2, -1, -0.5, 0.25, 0.5, 1, 2, 4, 8];

export class TheaterSession {
  recorder: ReplayRecorder | null = null;
  playback: SnapshotPlayback | null = null;
  readonly source = new SnapshotActorSource({
    actorAt: () => false,
    actorsAt: () => 0,
  });
  readonly spectator = new SpectatorController();
  readonly killcam = new KillcamDirector();
  readonly free = new FreeCamera();
  readonly pose: CameraPose = cameraPose();

  camera: TheaterCamera = 'free';
  playing = false;
  rate = 1;
  time = 0;
  startTime = 0;
  duration = 0;
  bookmarks: TheaterBookmark[] = [];

  private lastError = '';

  get error(): string { return this.lastError; }
  get loaded(): boolean { return this.recorder !== null; }

  /* ----------------------------------------------------------------- load -- */

  /** Attaches a live recorder directly (end-of-match theater, no file round-trip). */
  attach(rec: ReplayRecorder): void {
    this.recorder = rec;
    this.playback = new SnapshotPlayback(rec.snapshots);
    this.source.setPlayback(this.playback);
    this.startTime = this.playback.fromTime;
    this.duration = this.playback.duration;
    this.time = 0;
    this.playing = false;
    this.rate = 1;
    this.rebuildBookmarks();
    this.spectator.setRules(spectatorRules({
      matchOver: true, viewerAlive: false, viewerTeam: 0,
      observer: true, killcamActive: false, killer: -1,
    }));
    this.source.time = this.startTime;
    this.spectator.refreshTargets(this.source);
    this.lastError = '';
  }

  loadFile(file: ReplayFile): boolean {
    const res = decodeReplay(file);
    if (!res.ok || !res.recorder) {
      this.lastError = res.reason;
      return false;
    }
    this.attach(res.recorder);
    return true;
  }

  unload(): void {
    this.recorder = null;
    this.playback = null;
    this.bookmarks.length = 0;
    this.duration = 0;
    this.time = 0;
    this.playing = false;
    this.killcam.stop();
  }

  /* ------------------------------------------------------------ bookmarks -- */

  private rebuildBookmarks(): void {
    this.bookmarks.length = 0;
    const rec = this.recorder;
    if (!rec) return;
    const e = replayEvent();
    for (let k = 0; k < rec.events.length; k++) {
      if (!rec.events.read(k, e)) continue;
      if (e.kind !== 'kill' && e.kind !== 'objective' && e.kind !== 'streak') continue;
      this.bookmarks.push({
        time: e.tick * TICK_DT - this.startTime,
        tick: e.tick,
        kind: e.kind,
        actor: e.a,
        other: e.b,
        label: rec.strings.get(e.label),
        headshot: (e.flags & 1) !== 0,
      });
    }
    this.bookmarks.sort((a, b) => a.time - b.time);
  }

  bookmarkAt(time: number): number {
    let best = -1;
    for (let i = 0; i < this.bookmarks.length; i++) {
      if (this.bookmarks[i].time <= time + 1e-6) best = i; else break;
    }
    return best;
  }

  jumpToBookmark(i: number, lead = 3): boolean {
    const b = this.bookmarks[i];
    if (!b) return false;
    this.scrub(Math.max(0, b.time - lead));
    return true;
  }

  /** Next bookmark strictly after the current time; wraps. */
  nextBookmark(dir: 1 | -1 = 1, lead = 3): boolean {
    if (this.bookmarks.length === 0) return false;
    if (dir > 0) {
      for (let i = 0; i < this.bookmarks.length; i++) {
        if (this.bookmarks[i].time > this.time + lead + 0.01) return this.jumpToBookmark(i, lead);
      }
      return this.jumpToBookmark(0, lead);
    }
    for (let i = this.bookmarks.length - 1; i >= 0; i--) {
      if (this.bookmarks[i].time < this.time + lead - 0.01) return this.jumpToBookmark(i, lead);
    }
    return this.jumpToBookmark(this.bookmarks.length - 1, lead);
  }

  /* ------------------------------------------------------------ transport -- */

  play(): void { this.playing = true; }
  pause(): void { this.playing = false; }
  togglePlay(): void { this.playing = !this.playing; }

  setRate(r: number): void {
    this.rate = Math.max(-8, Math.min(8, r));
  }

  /** Steps the rate through the preset ladder. */
  nudgeRate(dir: 1 | -1): number {
    let i = RATES.findIndex((r) => Math.abs(r - this.rate) < 1e-6);
    if (i < 0) i = RATES.indexOf(1);
    this.rate = RATES[Math.max(0, Math.min(RATES.length - 1, i + dir))];
    return this.rate;
  }

  scrub(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.killcam.stop();
    if (this.camera === 'killcam') this.camera = 'follow';
    this.spectator.solver.reset();
  }

  /** Fraction 0..1 of the timeline — what a scrub bar binds to. */
  scrubFraction(f: number): void {
    this.scrub(f * this.duration);
  }

  /* --------------------------------------------------------------- camera -- */

  setCamera(mode: TheaterCamera): boolean {
    if (mode === 'killcam') return this.playKillcamAt(this.time);
    this.camera = mode;
    if (mode === 'free') this.free.placeAt(this.pose);
    else if (this.spectator.target < 0) this.spectator.cycle(1);
    return true;
  }

  follow(actorId: number): boolean {
    this.camera = 'follow';
    return this.spectator.select(actorId);
  }

  cycleFollow(dir: 1 | -1 = 1): number {
    this.camera = 'follow';
    this.source.time = this.startTime + this.time;
    this.spectator.refreshTargets(this.source);
    return this.spectator.cycle(dir);
  }

  /** Plays the killcam of the kill nearest to `t`. */
  playKillcamAt(t: number, options?: KillcamOptions): boolean {
    const rec = this.recorder;
    const pb = this.playback;
    if (!rec || !pb) return false;
    let best: TheaterBookmark | null = null;
    for (const b of this.bookmarks) {
      if (b.kind !== 'kill') continue;
      if (!best || Math.abs(b.time - t) < Math.abs(best.time - t)) best = b;
    }
    if (!best) { this.lastError = 'no kills in this replay'; return false; }
    const plan = planKillcam(rec, best.other, best.tick, options);
    if (!plan.valid) { this.lastError = plan.reason; return false; }
    this.killcam.begin(plan, pb);
    this.camera = 'killcam';
    this.time = Math.max(0, plan.startTime - this.startTime);
    this.playing = true;
    return true;
  }

  /* ---------------------------------------------------------------- frame -- */

  /** Advances by real seconds and produces the camera pose. */
  step(dt: number, input: FreeCamInput | null): void {
    const pb = this.playback;
    if (!pb) return;

    if (this.camera === 'killcam' && this.killcam.active) {
      this.killcam.step(dt);
      copyPose(this.killcam.pose, this.pose);
      this.time = Math.max(0, this.killcam.matchTime - this.startTime);
      if (!this.killcam.active) this.camera = 'follow';
      return;
    }

    if (this.playing) {
      this.time += dt * this.rate;
      if (this.time >= this.duration) { this.time = this.duration; this.playing = false; }
      if (this.time <= 0) { this.time = 0; if (this.rate < 0) this.playing = false; }
    }

    this.source.time = this.startTime + this.time;

    if (this.camera === 'free') {
      if (input) this.free.step(scaleInput(input), dt);
      copyPose(this.free.pose, this.pose);
      return;
    }

    this.spectator.refreshTargets(this.source);
    if (this.spectator.target < 0) this.spectator.cycle(1);
    if (this.spectator.mode === 'off') this.spectator.mode = 'third';
    if (this.spectator.update(dt, this.source, input)) {
      copyPose(this.spectator.pose, this.pose);
    }
  }

  actorsNow(out: ActorSample[]): number {
    if (!this.playback) return 0;
    return this.playback.actorsAt(this.startTime + this.time, out);
  }

  state(): TheaterState {
    return {
      loaded: this.loaded,
      playing: this.playing,
      rate: this.rate,
      time: this.time,
      duration: this.duration,
      camera: this.camera,
      followTarget: this.spectator.target,
      bookmarkCount: this.bookmarks.length,
      bookmark: this.bookmarkAt(this.time),
      mode: this.recorder?.mode ?? '',
      seed: this.recorder?.seed ?? 0,
    };
  }
}

function scaleInput(i: FreeCamInput): FreeCamInput {
  return {
    moveX: i.moveX, moveY: i.moveY, moveUp: i.moveUp,
    lookYaw: i.lookYaw * 0.0022, lookPitch: i.lookPitch * 0.0022,
    boost: i.boost, precise: i.precise,
  };
}

function copyPose(src: CameraPose, dst: CameraPose): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll; dst.fov = src.fov;
}
