/**
 * Killcam.
 *
 * The point of a killcam is not decoration — it is *evidence*. A death has to
 * read as "he was there, he saw me, he shot me" instead of "I died". So the
 * shot is composed the way Call of Duty composes it:
 *
 *   • It runs from the killer's own eyes, not from a spectator boom, because
 *     the question the player is asking is "what could he see".
 *   • The killer's look is smoothed just enough to remove per-tick jitter and
 *     no more; over-smoothing turns a flick shot into a lazy pan and reads as
 *     a lie.
 *   • Approaching the fatal shot the FOV tightens and, if the victim somehow
 *     is not inside the killer's cone, the aim is nudged (bounded, ≤ 14°) so
 *     the kill is on screen. Framing may be helped; it may not be invented.
 *   • After the shot the camera pulls back off the killer's shoulder and holds
 *     on the body, which is what makes the last frame legible.
 *
 * The final killcam is the same director with a longer pre-roll, slow motion
 * through the impact and the third-person pull-back opened up.
 *
 * Everything is computed from the recorded snapshot track, so a client that has
 * no authority over the simulation can still show it.
 */

import { CameraSolver, distance, forwardFrom, lerp, smooth, yawPitchTo } from './CameraSolver';
import { SnapshotPlayback, clamp01, isTeleport, lerpAngle } from './Playback';
import type { ReplayRecorder } from './Recorder';
import type { StringTable } from './Hash';
import {
  ACTOR, EVT, TICK_DT, type ActorSample, type CameraPose, type ReplayEvent, type Vec3,
  actorSample, cameraPose, replayEvent,
} from './types';

/* ---------------------------------------------------------------- options -- */

export interface KillcamOptions {
  /** Seconds of the killer's life shown before the fatal shot. */
  preRoll: number;
  /** Seconds held after the shot. */
  postRoll: number;
  /** Eye height above the recorded actor origin. */
  eyeHeight: number;
  /** Look smoothing half-life. Small on purpose — see the header. */
  lookHalfLife: number;
  fovWide: number;
  fovTight: number;
  /** Seconds before impact where slow motion starts. 0 disables. */
  slowMoLead: number;
  slowMoScale: number;
  /** Third-person pull-back after the kill: distance, height, lateral offset. */
  pullBack: number;
  pullHeight: number;
  pullSide: number;
  /** Max degrees the aim may be nudged so the victim is on screen. */
  maxAimAssistDeg: number;
}

export function defaultKillcamOptions(): KillcamOptions {
  return {
    preRoll: 3.2,
    postRoll: 1.7,
    eyeHeight: 1.62,
    lookHalfLife: 0.035,
    fovWide: 78,
    fovTight: 62,
    slowMoLead: 0,
    slowMoScale: 1,
    pullBack: 2.9,
    pullHeight: 0.85,
    pullSide: 0.75,
    maxAimAssistDeg: 14,
  };
}

export function finalKillcamOptions(): KillcamOptions {
  return {
    ...defaultKillcamOptions(),
    preRoll: 4.5,
    postRoll: 3.2,
    slowMoLead: 0.55,
    slowMoScale: 0.28,
    pullBack: 4.4,
    pullHeight: 1.5,
    pullSide: 1.4,
    fovTight: 54,
  };
}

/* ------------------------------------------------------------------- plan -- */

export interface KillcamShot {
  tick: number;
  /** Muzzle-ish origin (killer eye at the fatal tick). */
  from: Vec3;
  /** Where the round landed on the victim. */
  to: Vec3;
  headshot: boolean;
  distance: number;
  weapon: string;
}

export interface KillcamPlan {
  valid: boolean;
  reason: string;
  killer: number;
  victim: number;
  startTick: number;
  deathTick: number;
  endTick: number;
  startTime: number;
  deathTime: number;
  endTime: number;
  shot: KillcamShot | null;
  weapon: string;
  headshot: boolean;
  distance: number;
  /** True when the recording had to be clipped because the ring did not reach back far enough. */
  clipped: boolean;
  options: KillcamOptions;
}

function emptyPlan(reason: string, options: KillcamOptions): KillcamPlan {
  return {
    valid: false, reason, killer: -1, victim: -1,
    startTick: 0, deathTick: 0, endTick: 0,
    startTime: 0, deathTime: 0, endTime: 0,
    shot: null, weapon: '', headshot: false, distance: 0, clipped: false, options,
  };
}

/**
 * Builds a killcam plan from the recording.
 *
 * `deathTick < 0` means "the most recent death of this victim", which is what
 * the live game asks for. A death whose killer is the victim (suicide, fall,
 * world damage) has no viewpoint worth showing and is rejected — the caller
 * should skip straight to the respawn timer rather than show a shrug.
 */
export function planKillcam(
  recorder: ReplayRecorder,
  victim: number,
  deathTick = -1,
  options: KillcamOptions = defaultKillcamOptions(),
  strings: StringTable = recorder.strings,
): KillcamPlan {
  const scratch = replayEvent();
  const wantTick = deathTick;
  const k = recorder.events.findLast(
    (e) => e.kind === 'kill' && e.b === victim && (wantTick < 0 || e.tick === wantTick),
    scratch,
  );
  if (k < 0) return emptyPlan(`no recorded kill for actor ${victim}`, options);
  recorder.events.read(k, scratch);

  const killer = scratch.a;
  const dTick = scratch.tick;
  if (killer < 0 || killer === victim) {
    return emptyPlan('death had no killer to spectate', options);
  }

  const oldest = Math.max(0, recorder.snapshots.oldestTick);
  const wantStart = dTick - Math.round(options.preRoll / TICK_DT);
  const rawStart = Math.max(oldest, wantStart);
  const rawEnd = dTick + Math.round(options.postRoll / TICK_DT);

  // A killcam shorter than half a second is worse than none: it reads as a
  // glitch. Better to tell the caller than to show it. This is about the
  // *recording* — a ring that no longer reaches back has nothing to show.
  if ((dTick - rawStart) * TICK_DT < 0.5) {
    return emptyPlan('recording does not reach back far enough', options);
  }

  // Never span a break in the killer's track — see `continuousWindow`.
  const win = continuousWindow(recorder, killer, rawStart, dTick, rawEnd);
  const startTick = win.startTick;
  // A break is not a failure, it just makes the clip shorter. Give back on the
  // tail what it took off the front, so a kill by someone who spawned a moment
  // earlier still holds on the body long enough to read — but never past the
  // break that follows the kill.
  const lost = startTick - rawStart;
  const endTick = Math.min(win.maxEndTick, rawEnd + lost);

  const playback = new SnapshotPlayback(recorder.snapshots);
  const killerSample = actorSample();
  const from: Vec3 = { x: 0, y: 0, z: 0 };
  const to: Vec3 = { x: scratch.x, y: scratch.y, z: scratch.z };
  if (playback.actorAt(killer, dTick * TICK_DT, killerSample)) {
    from.x = killerSample.x;
    from.y = killerSample.y + options.eyeHeight;
    from.z = killerSample.z;
  }

  const weapon = strings.get(scratch.label);
  const headshot = (scratch.flags & EVT.headshot) !== 0;
  const dist = scratch.n > 0 ? scratch.n : distance(from, to);

  return {
    valid: true,
    reason: '',
    killer,
    victim,
    startTick,
    deathTick: dTick,
    endTick,
    startTime: startTick * TICK_DT,
    deathTime: dTick * TICK_DT,
    endTime: endTick * TICK_DT,
    shot: { tick: dTick, from, to, headshot, distance: dist, weapon },
    weapon,
    headshot,
    distance: dist,
    clipped: startTick > wantStart,
    options,
  };
}

/**
 * A killcam must not span a break in the killer's track. If he was teleported
 * inside the window — he respawned, a killstreak inserted him, the host
 * corrected him — a camera locked to his eyes would streak across the map and
 * the clip would read as a bug rather than as evidence.
 *
 * So the window is trimmed to the continuous run of his track that contains the
 * kill: the start is pulled forward past the last break before the shot, and
 * the end is pushed back to the first break after it. The kill itself is never
 * trimmed away — only the parts of the window that were never really his.
 */
function continuousWindow(
  recorder: ReplayRecorder,
  killer: number,
  startTick: number,
  deathTick: number,
  endTick: number,
): { startTick: number; endTick: number; maxEndTick: number } {
  const ring = recorder.snapshots;
  const a = actorSample();
  const b = actorSample();
  let s = startTick;
  let e = endTick;
  /** Hard ceiling: the clip may never be extended past a post-kill break. */
  let maxEnd = Number.MAX_SAFE_INTEGER;
  let prevTick = -1;

  const first = Math.max(0, ring.frameAtOrBefore(startTick));
  for (let k = first; k < ring.length; k++) {
    const tick = ring.frameTick(k);
    if (tick < startTick) continue;
    if (tick > endTick) break;
    const slot = ring.slotOf(k, killer);
    if (slot < 0) continue;
    if (prevTick < 0) {
      ring.read(k, slot, a);
      prevTick = tick;
      continue;
    }
    ring.read(k, slot, b);
    if (isTeleport(a, b, (tick - prevTick) * TICK_DT)) {
      // Before the shot: the pre-roll starts after the break instead.
      if (tick <= deathTick) s = Math.max(s, tick);
      // After the shot: hold on the last frame that was still him.
      else { e = Math.min(e, prevTick); maxEnd = prevTick; break; }
    }
    ring.read(k, slot, a);
    prevTick = tick;
  }

  // The kill must survive the trim even if the track is a mess around it.
  if (e < deathTick) e = Math.min(endTick, deathTick);
  if (s > deathTick) s = Math.min(startTick, deathTick);
  if (maxEnd < e) maxEnd = e;
  return { startTick: s, endTick: e, maxEndTick: maxEnd };
}

/**
 * Final killcam: the last kill of the match, from whoever made it.
 * Returns an invalid plan when the match ended without a kill.
 */
export function planFinalKillcam(
  recorder: ReplayRecorder,
  options: KillcamOptions = finalKillcamOptions(),
  strings: StringTable = recorder.strings,
): KillcamPlan {
  const scratch = replayEvent();
  const k = recorder.events.findLast((e) => e.kind === 'kill' && e.a >= 0 && e.a !== e.b, scratch);
  if (k < 0) return emptyPlan('match ended with no kill to show', options);
  recorder.events.read(k, scratch);
  return planKillcam(recorder, scratch.b, scratch.tick, options, strings);
}

/* --------------------------------------------------------------- director -- */

export interface KillcamFrame {
  /** Seconds elapsed inside the plan. */
  time: number;
  /** 0..1 across the whole plan. */
  progress: number;
  /** Signed seconds to the fatal shot; negative after it. */
  toImpact: number;
  /** Time scale the presentation layer should apply (final killcam slow-mo). */
  timeScale: number;
  killer: number;
  victim: number;
  weapon: string;
  headshot: boolean;
  distance: number;
  /** True once the fatal shot has played. */
  impacted: boolean;
  /** 0..1 opacity for the shot-line overlay, peaking at impact. */
  shotLineAlpha: number;
  /** True while the camera has pulled off the killer's shoulder. */
  thirdPerson: boolean;
  done: boolean;
}

/**
 * Plays a `KillcamPlan`. Owns its own smoothing so the caller only has to copy
 * `pose` onto a camera every frame.
 */
export class KillcamDirector {
  plan: KillcamPlan | null = null;
  readonly solver = new CameraSolver();
  readonly pose: CameraPose = cameraPose();
  readonly frame: KillcamFrame = {
    time: 0, progress: 0, toImpact: 0, timeScale: 1,
    killer: -1, victim: -1, weapon: '', headshot: false, distance: 0,
    impacted: false, shotLineAlpha: 0, thirdPerson: false, done: true,
  };

  private playback: SnapshotPlayback | null = null;
  private time = 0;
  private readonly killer = actorSample();
  private readonly victim = actorSample();
  private readonly target: CameraPose = cameraPose();
  private readonly _f: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _aim = { yaw: 0, pitch: 0 };
  private readonly _look = { yaw: 0, pitch: 0 };

  get active(): boolean { return this.plan !== null && !this.frame.done; }
  get duration(): number { return this.plan ? this.plan.endTime - this.plan.startTime : 0; }
  /** Absolute match time currently being shown. */
  get matchTime(): number { return this.plan ? this.plan.startTime + this.time : 0; }

  begin(plan: KillcamPlan, snapshots: SnapshotPlayback): boolean {
    if (!plan.valid) { this.stop(); return false; }
    this.plan = plan;
    this.playback = snapshots;
    this.time = 0;
    this.solver.reset();
    this.solver.tuning.rotationHalfLife = plan.options.lookHalfLife;
    this.solver.tuning.positionHalfLife = 0.06;
    // The camera is locked to a man's eye. He sprints at ~7 m/s and the
    // pull-back adds ~6, so 30 m/s is four times more than this shot can
    // legitimately need — and it is the backstop that guarantees no residual
    // discontinuity in the track (a gap in the snapshots, an actor dropping out
    // and returning) can ever become a visible teleport. The solver's generic
    // 220 m/s default exists for deliberate target switches, not for this.
    this.solver.tuning.maxSpeed = 30;
    this.frame.done = false;
    this.frame.killer = plan.killer;
    this.frame.victim = plan.victim;
    this.frame.weapon = plan.weapon;
    this.frame.headshot = plan.headshot;
    this.frame.distance = plan.distance;
    this.sample(0);
    // First frame is a hard cut, not a swoop in from wherever the camera was.
    this.solver.snap(this.target);
    this.copyPose();
    return true;
  }

  stop(): void {
    this.plan = null;
    this.playback = null;
    this.frame.done = true;
    this.frame.timeScale = 1;
    this.frame.shotLineAlpha = 0;
  }

  /** `dt` is real seconds; the director applies its own slow motion internally. */
  step(dt: number): void {
    const plan = this.plan;
    if (!plan || this.frame.done) return;
    this.time += dt * this.frame.timeScale;
    if (this.time >= this.duration) {
      this.time = this.duration;
      this.frame.done = true;
    }
    this.sample(dt);
  }

  /** Recomputes the desired pose and the readout for the current time. */
  private sample(dt: number): void {
    const plan = this.plan;
    const pb = this.playback;
    if (!plan || !pb) return;
    const opts = plan.options;
    const t = plan.startTime + this.time;
    const toImpact = plan.deathTime - t;

    const f = this.frame;
    f.time = this.time;
    f.progress = this.duration > 0 ? clamp01(this.time / this.duration) : 1;
    f.toImpact = toImpact;
    f.impacted = toImpact <= 0;
    f.timeScale = opts.slowMoLead > 0 && toImpact < opts.slowMoLead && toImpact > -opts.slowMoLead
      ? lerp(opts.slowMoScale, 1, clamp01(Math.abs(toImpact) / Math.max(1e-3, opts.slowMoLead)))
      : 1;
    // Shot line flashes on at impact and fades over ~0.6 s.
    f.shotLineAlpha = toImpact > 0 ? 0 : clamp01(1 + toImpact / 0.6);

    const haveKiller = pb.actorAt(plan.killer, t, this.killer);
    const haveVictim = pb.actorAt(plan.victim, t, this.victim);

    // --- where the camera wants to be -------------------------------------
    const eyeX = this.killer.x;
    const eyeY = this.killer.y + opts.eyeHeight;
    const eyeZ = this.killer.z;

    // Pull-back begins the instant the round lands and eases over 0.45 s.
    const pull = smooth(clamp01(-toImpact / 0.45));
    f.thirdPerson = pull > 0.02;

    let yaw = this.killer.yaw;
    let pitch = this.killer.pitch;

    // Aim assist for readability: if the victim is outside the killer's cone,
    // rotate toward them by a bounded amount so the kill is on screen.
    if (haveVictim && haveKiller) {
      this._look.yaw = yaw; this._look.pitch = pitch;
      yawPitchTo(
        { x: eyeX, y: eyeY, z: eyeZ },
        { x: this.victim.x, y: this.victim.y + 1.05, z: this.victim.z },
        this._aim,
      );
      const maxRad = (opts.maxAimAssistDeg * Math.PI) / 180;
      // Weight rises as the shot approaches so early frames stay honest.
      const w = smooth(clamp01(1 - Math.abs(toImpact) / Math.max(0.25, opts.preRoll * 0.55)));
      yaw = clampToward(yaw, lerpAngle(yaw, this._aim.yaw, w), maxRad);
      pitch = clampToward(pitch, lerp(pitch, this._aim.pitch, w), maxRad);
    }

    const tp = this.target;
    if (pull <= 0.001 || !haveKiller) {
      tp.x = eyeX; tp.y = eyeY; tp.z = eyeZ;
      tp.yaw = yaw; tp.pitch = pitch;
    } else {
      // Behind and above the killer's shoulder, still looking at the victim.
      forwardFrom(yaw, 0, this._f);
      const bx = eyeX - this._f.x * opts.pullBack * pull + Math.cos(yaw) * opts.pullSide * pull;
      const by = eyeY + opts.pullHeight * pull;
      const bz = eyeZ - this._f.z * opts.pullBack * pull - Math.sin(yaw) * opts.pullSide * pull;
      tp.x = lerp(eyeX, bx, 1);
      tp.y = lerp(eyeY, by, 1);
      tp.z = lerp(eyeZ, bz, 1);
      const look = haveVictim
        ? { x: this.victim.x, y: this.victim.y + 0.9, z: this.victim.z }
        : { x: eyeX, y: eyeY, z: eyeZ };
      yawPitchTo(tp, look, this._aim);
      tp.yaw = lerpAngle(yaw, this._aim.yaw, pull);
      tp.pitch = lerp(pitch, this._aim.pitch, pull);
    }

    tp.roll = 0;
    // Tighten on the way in, then open back up as the camera pulls off.
    const tighten = smooth(clamp01(1 - Math.abs(toImpact) / 1.2));
    tp.fov = lerp(lerp(opts.fovWide, opts.fovTight, tighten), opts.fovWide, pull);

    this.solver.step(tp, dt);
    this.copyPose();
  }

  private copyPose(): void {
    const s = this.solver.pose;
    this.pose.x = s.x; this.pose.y = s.y; this.pose.z = s.z;
    this.pose.yaw = s.yaw; this.pose.pitch = s.pitch;
    this.pose.roll = s.roll; this.pose.fov = s.fov;
  }

  /** Actors visible at the currently displayed instant, for the debug view. */
  actors(out: ActorSample[]): number {
    if (!this.plan || !this.playback) return 0;
    return this.playback.actorsAt(this.plan.startTime + this.time, out);
  }

  /** Convenience for a HUD: is the victim's body on screen and dead yet. */
  victimDown(): boolean {
    return this.frame.impacted && (this.victim.flags & ACTOR.alive) === 0;
  }
}

/** Rotates `from` toward `to` by at most `maxRad`. */
function clampToward(from: number, to: number, maxRad: number): number {
  let d = to - from;
  const twoPi = Math.PI * 2;
  d -= twoPi * Math.floor((d + Math.PI) / twoPi);
  if (d > maxRad) d = maxRad;
  if (d < -maxRad) d = -maxRad;
  return from + d;
}

export type { ReplayEvent };
