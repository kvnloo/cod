/**
 * The determinism harness, in TypeScript so it type-checks with everything it
 * tests. `tools/session-replay.mjs` compiles this and prints the report.
 *
 * What it proves, in order:
 *   1. a scripted match records without the rings overflowing,
 *   2. re-simulating from *every* keyframe reaches the same final state hash as
 *      the live run — not "close", equal,
 *   3. a replay survives the JSON round trip byte for byte,
 *   4. a killcam can be planned from the recording and produces a camera that
 *      moves and ends up looking at the victim,
 *   5. spectator restrictions actually refuse the things they should,
 *   6. theater can scrub anywhere in the timeline and read actors back,
 *   7. and it reports what all of that cost in bytes per minute.
 *
 * A drift is reported at the tick it first appears, because "the hash differs"
 * is useless and "the hash differed at tick 4271, actor 3" is a bug report.
 */

import { hex32 } from './Hash';
import { KillcamDirector, defaultKillcamOptions, finalKillcamOptions, planFinalKillcam, planKillcam } from './Killcam';
import { ResimPlayer, SnapshotPlayback } from './Playback';
import { ProbeScript, ProbeSim } from './ProbeSim';
import { ReplayRecorder, type RecorderStats } from './Recorder';
import { decodeReplay, encodeReplay, replayFileBytes, type ReplayFile } from './ReplayFile';
import { SpectatorController, spectatorRules } from './Spectator';
import { TheaterSession } from './Theater';
import {
  TICK_DT, TICK_HZ, type ActorSample, type InputFrame, type RecorderConfig,
  actorSample, quantizeInPlace, theaterRecorderConfig,
} from './types';

export interface VerifyOptions {
  seed: number;
  actors: number;
  seconds: number;
  /** Which keyframes to replay from. Empty = all of them. */
  keyframes: number[];
  config?: Partial<RecorderConfig>;
}

export function defaultVerifyOptions(): VerifyOptions {
  return { seed: 20260730, actors: 8, seconds: 60, keyframes: [] };
}

export interface ResimReport {
  index: number;
  fromTick: number;
  fromTime: number;
  ticks: number;
  hash: string;
  ok: boolean;
  reason: string;
  divergedAtTick: number;
  ms: number;
}

export interface VerifyReport {
  pass: boolean;
  failures: string[];
  seed: number;
  actors: number;
  seconds: number;
  ticks: number;
  liveHash: string;
  liveMs: number;
  kills: number;
  shots: number;
  keyframes: number;
  resims: ResimReport[];
  memory: RecorderStats;
  /** Resident bytes per minute of match at the measured event density. */
  bytesPerMinute: number;
  file: {
    bytes: number;
    kbPerMinute: number;
    roundTrip: boolean;
    reason: string;
    resimAfterRoundTrip: ResimReport | null;
  };
  killcam: {
    planned: boolean;
    reason: string;
    killer: number;
    victim: number;
    weapon: string;
    headshot: boolean;
    distanceM: number;
    preRollSec: number;
    frames: number;
    cameraTravelM: number;
    /** Degrees between the final camera forward and the direction to the victim. */
    finalAimErrorDeg: number;
    maxStepM: number;
  };
  finalKillcam: { planned: boolean; reason: string; durationSec: number };
  spectator: {
    enemyRefusedWhileLive: boolean;
    freeRefusedWhileLive: boolean;
    killcamLockHeld: boolean;
    freeAllowedAfterMatch: boolean;
    cycledTargets: number;
  };
  theater: {
    loaded: boolean;
    durationSec: number;
    bookmarks: number;
    scrubSamples: number;
    scrubActorsOk: boolean;
    reverseOk: boolean;
  };
}

/* ------------------------------------------------------------------- live -- */

interface LiveRun {
  recorder: ReplayRecorder;
  sim: ProbeSim;
  finalHash: number;
  ticks: number;
  ms: number;
  kills: number;
  shots: number;
}

/** Records a scripted match. Returns the recorder plus the live final hash. */
export function recordProbeMatch(opts: VerifyOptions): LiveRun {
  const ticks = Math.round(opts.seconds * TICK_HZ);
  const config: Partial<RecorderConfig> = {
    ...theaterRecorderConfig(opts.seconds + 2, opts.actors),
    keyframeSeconds: 5,
    maxActors: Math.max(opts.actors, 8),
    eventCapacity: 8192,
    ...opts.config,
  };

  const sim = new ProbeSim(opts.seed, opts.actors);
  const script = new ProbeScript(sim, opts.seed);
  const recorder = new ReplayRecorder(config);
  for (const w of ProbeSim.weaponNames()) recorder.strings.intern(w);
  recorder.begin(opts.seed, 'probe', 1);

  const frames: InputFrame[] = [];
  const t0 = now();
  for (let t = 0; t < ticks; t++) {
    // Keyframe first: a keyframe stamped tick N is the state at the *start* of
    // tick N, before any of tick N's input has been applied. Capturing after
    // the step would put the blob and the input stream one tick out of phase,
    // which is the classic way a replay drifts.
    recorder.beforeStep(sim);
    const n = script.frames(t, frames);
    // Snap to the wire representation before anything consumes it.
    for (let i = 0; i < n; i++) {
      quantizeInPlace(frames[i]);
      recorder.recordInput(frames[i]);
    }
    sim.step(t, frames.slice(0, n));
    recorder.afterStep(sim);
  }
  const ms = now() - t0;

  let kills = 0;
  let shots = 0;
  const scratch = { tick: 0, kind: 'kill' as const, a: 0, b: 0, x: 0, y: 0, z: 0, n: 0, label: 0, flags: 0 };
  for (let k = 0; k < recorder.events.length; k++) {
    if (!recorder.events.read(k, scratch)) continue;
    if (scratch.kind === 'kill') kills++;
    else if (scratch.kind === 'shot') shots++;
  }

  return { recorder, sim, finalHash: sim.hash(), ticks, ms, kills, shots };
}

/* ----------------------------------------------------------------- verify -- */

export function runVerification(opts: VerifyOptions = defaultVerifyOptions()): VerifyReport {
  const failures: string[] = [];
  const live = recordProbeMatch(opts);
  const rec = live.recorder;

  const report: VerifyReport = {
    pass: false,
    failures,
    seed: opts.seed,
    actors: opts.actors,
    seconds: opts.seconds,
    ticks: live.ticks,
    liveHash: hex32(live.finalHash),
    liveMs: live.ms,
    kills: live.kills,
    shots: live.shots,
    keyframes: rec.keyframes.length,
    resims: [],
    memory: rec.stats(),
    bytesPerMinute: 0,
    file: { bytes: 0, kbPerMinute: 0, roundTrip: false, reason: '', resimAfterRoundTrip: null },
    killcam: {
      planned: false, reason: '', killer: -1, victim: -1, weapon: '', headshot: false,
      distanceM: 0, preRollSec: 0, frames: 0, cameraTravelM: 0,
      finalAimErrorDeg: 0, maxStepM: 0,
    },
    finalKillcam: { planned: false, reason: '', durationSec: 0 },
    spectator: {
      enemyRefusedWhileLive: false, freeRefusedWhileLive: false,
      killcamLockHeld: false, freeAllowedAfterMatch: false, cycledTargets: 0,
    },
    theater: {
      loaded: false, durationSec: 0, bookmarks: 0,
      scrubSamples: 0, scrubActorsOk: false, reverseOk: false,
    },
  };
  report.bytesPerMinute = report.memory.bytesPerMinute;

  if (rec.inputs.wrapped) {
    failures.push(`input ring wrapped during recording (capacity ${rec.inputs.capacity})`);
  }
  if (rec.keyframes.length < 2) failures.push('fewer than two keyframes recorded');
  if (live.kills === 0) failures.push('scripted match produced no kills — nothing to killcam');

  /* --- 2. resim from keyframes ------------------------------------------ */
  const replaySim = new ProbeSim(opts.seed, opts.actors);
  const player = new ResimPlayer(rec, replaySim);
  const indices = opts.keyframes.length
    ? opts.keyframes.filter((i) => i >= 0 && i < rec.keyframes.length)
    : range(rec.keyframes.length);

  for (const k of indices) {
    const meta = rec.keyframes.metaAt(k);
    const t0 = now();
    const res = player.runFromKeyframe(k, live.ticks);
    const ms = now() - t0;
    const ok = res.ok && res.hash === live.finalHash;
    report.resims.push({
      index: k,
      fromTick: res.fromTick,
      fromTime: res.fromTick * TICK_DT,
      ticks: res.ticksSimulated,
      hash: hex32(res.hash),
      ok,
      reason: res.ok
        ? (ok ? '' : `final hash ${hex32(res.hash)} != live ${hex32(live.finalHash)}`)
        : res.reason,
      divergedAtTick: res.divergedAtTick,
      ms,
    });
    if (!ok) {
      failures.push(
        `resim from keyframe ${k} (tick ${meta?.tick ?? -1}) failed: `
        + (res.reason || `hash ${hex32(res.hash)} != ${hex32(live.finalHash)}`),
      );
    }
  }

  /* --- 3. file round trip ------------------------------------------------ */
  const file: ReplayFile = encodeReplay(rec, 'verify');
  report.file.bytes = replayFileBytes(file);
  report.file.kbPerMinute = (report.file.bytes / 1024) / Math.max(1 / 60, opts.seconds / 60);
  const json = JSON.stringify(file);
  const decoded = decodeReplay(JSON.parse(json) as ReplayFile);
  report.file.roundTrip = decoded.ok;
  report.file.reason = decoded.reason;
  if (!decoded.ok || !decoded.recorder) {
    failures.push(`replay file round trip failed: ${decoded.reason}`);
  } else {
    const sim2 = new ProbeSim(opts.seed, opts.actors);
    const p2 = new ResimPlayer(decoded.recorder, sim2);
    const k = Math.max(0, Math.floor(decoded.recorder.keyframes.length / 2));
    const t0 = now();
    const res = p2.runFromKeyframe(k, live.ticks);
    const ok = res.ok && res.hash === live.finalHash;
    report.file.resimAfterRoundTrip = {
      index: k,
      fromTick: res.fromTick,
      fromTime: res.fromTick * TICK_DT,
      ticks: res.ticksSimulated,
      hash: hex32(res.hash),
      ok,
      reason: res.ok ? (ok ? '' : 'hash mismatch after round trip') : res.reason,
      divergedAtTick: res.divergedAtTick,
      ms: now() - t0,
    };
    if (!ok) failures.push(`resim after file round trip failed: ${report.file.resimAfterRoundTrip.reason}`);
  }

  /* --- 4. killcam -------------------------------------------------------- */
  const victim = findVictim(rec);
  const playback = new SnapshotPlayback(rec.snapshots);
  if (victim < 0) {
    report.killcam.reason = 'no victim found';
    failures.push('no victim found for killcam');
  } else {
    const plan = planKillcam(rec, victim, -1, defaultKillcamOptions());
    report.killcam.planned = plan.valid;
    report.killcam.reason = plan.reason;
    report.killcam.killer = plan.killer;
    report.killcam.victim = plan.victim;
    report.killcam.weapon = plan.weapon;
    report.killcam.headshot = plan.headshot;
    report.killcam.distanceM = plan.distance;
    report.killcam.preRollSec = plan.deathTime - plan.startTime;
    if (!plan.valid) failures.push(`killcam plan failed: ${plan.reason}`);
    else {
      const dir = new KillcamDirector();
      dir.begin(plan, playback);
      let travel = 0;
      let maxStep = 0;
      let frames = 0;
      let px = dir.pose.x, py = dir.pose.y, pz = dir.pose.z;
      const dt = 1 / 60;
      while (dir.active && frames < 6000) {
        dir.step(dt);
        const d = Math.hypot(dir.pose.x - px, dir.pose.y - py, dir.pose.z - pz);
        travel += d;
        if (d > maxStep) maxStep = d;
        px = dir.pose.x; py = dir.pose.y; pz = dir.pose.z;
        frames++;
      }
      report.killcam.frames = frames;
      report.killcam.cameraTravelM = travel;
      report.killcam.maxStepM = maxStep;

      // The last frame must actually be looking at the victim; that is the
      // whole promise of a killcam.
      const v = actorSample();
      if (playback.actorAt(plan.victim, plan.endTime, v)) {
        report.killcam.finalAimErrorDeg = aimErrorDeg(dir.pose, v);
      } else {
        report.killcam.finalAimErrorDeg = 999;
      }
      if (frames < 30) failures.push(`killcam produced only ${frames} frames`);
      if (report.killcam.finalAimErrorDeg > 35) {
        failures.push(`killcam final frame is ${report.killcam.finalAimErrorDeg.toFixed(1)}° off the victim`);
      }
      // After the initial placement (which is a deliberate hard cut) the camera
      // must stay continuous. The subject sprints at ~7 m/s and the pull-back
      // adds ~6, so anything past 0.6 m in a 60 Hz frame — 36 m/s — is not the
      // camera following a man, it is the camera teleporting.
      if (maxStep > 0.6) {
        failures.push(`killcam camera jumped ${maxStep.toFixed(2)} m in one frame `
          + `(${(maxStep * 60).toFixed(0)} m/s) — that is a cut, not a follow`);
      }
    }
  }

  const fk = planFinalKillcam(rec, finalKillcamOptions());
  report.finalKillcam.planned = fk.valid;
  report.finalKillcam.reason = fk.reason;
  report.finalKillcam.durationSec = fk.valid ? fk.endTime - fk.startTime : 0;
  if (!fk.valid) failures.push(`final killcam plan failed: ${fk.reason}`);

  /* --- 5. spectator rules ------------------------------------------------ */
  {
    const spec = new SpectatorController();
    spec.viewerTeam = 0;
    const targets = teamRoster(rec);
    spec.setTargets(targets);

    spec.setRules(spectatorRules({
      matchOver: false, viewerAlive: false, viewerTeam: 0,
      observer: false, killcamActive: false, killer: -1,
    }));
    const enemy = targets.find((t) => t.team !== 0);
    report.spectator.enemyRefusedWhileLive = enemy ? !spec.select(enemy.id) : false;
    report.spectator.freeRefusedWhileLive = !spec.enterFree();

    let cycled = 0;
    const seen = new Set<number>();
    for (let i = 0; i < targets.length + 2; i++) {
      const id = spec.cycle(1);
      if (id < 0) break;
      if (seen.has(id)) break;
      seen.add(id);
      cycled++;
    }
    report.spectator.cycledTargets = cycled;
    const leakedEnemy = [...seen].some((id) => (targets.find((t) => t.id === id)?.team ?? 0) !== 0);
    if (leakedEnemy) failures.push('spectator cycled onto an enemy while the match was live');
    if (!report.spectator.enemyRefusedWhileLive) failures.push('spectator allowed an enemy target while live');
    if (!report.spectator.freeRefusedWhileLive) failures.push('spectator allowed free camera while live');

    spec.setRules(spectatorRules({
      matchOver: false, viewerAlive: false, viewerTeam: 0,
      observer: false, killcamActive: true, killer: report.killcam.killer,
    }));
    spec.cycle(1);
    report.spectator.killcamLockHeld = spec.target === report.killcam.killer;
    if (!report.spectator.killcamLockHeld) failures.push('killcam lock did not hold through a cycle');

    spec.setRules(spectatorRules({
      matchOver: true, viewerAlive: false, viewerTeam: 0,
      observer: false, killcamActive: false, killer: -1,
    }));
    report.spectator.freeAllowedAfterMatch = spec.enterFree();
    if (!report.spectator.freeAllowedAfterMatch) failures.push('free camera refused after the match ended');
  }

  /* --- 6. theater -------------------------------------------------------- */
  {
    const th = new TheaterSession();
    th.attach(rec);
    report.theater.loaded = th.loaded;
    report.theater.durationSec = th.duration;
    report.theater.bookmarks = th.bookmarks.length;

    const buf: ActorSample[] = [];
    let ok = true;
    let samples = 0;
    for (let i = 0; i <= 20; i++) {
      th.scrub((i / 20) * th.duration);
      const n = th.actorsNow(buf);
      samples++;
      if (n <= 0) ok = false;
    }
    report.theater.scrubActorsOk = ok;
    report.theater.scrubSamples = samples;
    if (!ok) failures.push('theater scrub returned no actors at some point on the timeline');
    if (th.bookmarks.length === 0) failures.push('theater found no bookmarks in a match with kills');

    th.scrub(th.duration * 0.5);
    th.setRate(-2);
    th.play();
    const before = th.time;
    th.setCamera('free');
    for (let i = 0; i < 30; i++) th.step(1 / 60, null);
    report.theater.reverseOk = th.time < before;
    if (!report.theater.reverseOk) failures.push('theater reverse playback did not move the timeline backwards');
  }

  report.pass = failures.length === 0;
  return report;
}

/* -------------------------------------------------------------------- util -- */

function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

function findVictim(rec: ReplayRecorder): number {
  const e = { tick: 0, kind: 'kill' as const, a: 0, b: 0, x: 0, y: 0, z: 0, n: 0, label: 0, flags: 0 };
  // Prefer a kill in the middle of the recording so pre-roll is unclipped.
  const mid = Math.floor(rec.events.length / 2);
  for (let k = mid; k < rec.events.length; k++) {
    if (rec.events.read(k, e) && e.kind === 'kill' && e.a !== e.b) return e.b;
  }
  for (let k = 0; k < rec.events.length; k++) {
    if (rec.events.read(k, e) && e.kind === 'kill' && e.a !== e.b) return e.b;
  }
  return -1;
}

function teamRoster(rec: ReplayRecorder): Array<{ id: number; team: number; alive: boolean; name: string }> {
  const out: Array<{ id: number; team: number; alive: boolean; name: string }> = [];
  const a = actorSample();
  const k = Math.max(0, rec.snapshots.length - 1);
  const count = rec.snapshots.frameCount(k);
  for (let s = 0; s < count; s++) {
    if (!rec.snapshots.read(k, s, a)) continue;
    out.push({ id: a.id, team: a.team, alive: true, name: `Actor ${a.id}` });
  }
  return out;
}

function aimErrorDeg(pose: { x: number; y: number; z: number; yaw: number; pitch: number }, v: ActorSample): number {
  const cp = Math.cos(pose.pitch);
  const fx = -Math.sin(pose.yaw) * cp;
  const fy = Math.sin(pose.pitch);
  const fz = -Math.cos(pose.yaw) * cp;
  const dx = v.x - pose.x;
  const dy = (v.y + 1.05) - pose.y;
  const dz = v.z - pose.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-4) return 0;
  const cos = Math.max(-1, Math.min(1, (fx * dx + fy * dy + fz * dz) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
