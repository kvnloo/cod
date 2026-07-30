/**
 * Two ways to replay, for two different trust levels.
 *
 * `ResimPlayer` restores the newest keyframe at or before the target tick and
 * re-runs the recorded input through the simulation. It is exact — the final
 * state hash must equal the hash the live run produced — and it is what the
 * host and theater use.
 *
 * `SnapshotPlayback` never runs a simulation. It interpolates the recorded
 * actor track, which is all a non-authoritative client is allowed to do and all
 * a killcam actually needs. It also works when the sim is unavailable
 * (mid-level-load, a spectator who joined late, a saved file from another
 * build), which makes it the safe default.
 */

import {
  TICK_DT, type ActorSample, type InputFrame, type ReplayEvent, type ReplaySim,
  actorSample, inputFrame, replayEvent,
} from './types';
import type { ReplayRecorder } from './Recorder';
import type { SnapshotRing } from './Rings';

/* ------------------------------------------------------------ re-simulate -- */

export interface ResimResult {
  ok: boolean;
  /** Keyframe the run started from. */
  fromTick: number;
  toTick: number;
  ticksSimulated: number;
  hash: number;
  /** Populated when the run diverged from a recorded keyframe. */
  divergedAtTick: number;
  reason: string;
}

export class ResimPlayer {
  private commands: InputFrame[] = [];
  private blob: Float64Array | null = null;

  constructor(private recorder: ReplayRecorder, private sim: ReplaySim) { }

  /**
   * Restores keyframe `k` and steps forward to `toTick` inclusive-exclusive.
   * Along the way every keyframe that falls inside the range is checked, so a
   * drift is reported at the tick it appeared rather than at the end.
   */
  runFromKeyframe(k: number, toTick: number): ResimResult {
    const kf = this.recorder.keyframes;
    const meta = kf.metaAt(k);
    const res: ResimResult = {
      ok: false, fromTick: -1, toTick, ticksSimulated: 0,
      hash: 0, divergedAtTick: -1, reason: '',
    };
    if (!meta) { res.reason = `no keyframe at index ${k}`; return res; }
    if (!this.blob || this.blob.length !== kf.blobSize) this.blob = kf.allocBlob();
    if (!kf.read(k, this.blob)) { res.reason = 'keyframe read failed'; return res; }

    this.sim.restore(this.blob);
    res.fromTick = meta.tick;
    if (this.sim.hash() !== meta.hash) {
      res.reason = 'restore(capture(x)) did not reproduce the captured hash';
      res.divergedAtTick = meta.tick;
      return res;
    }

    // Keyframes ahead of the start are checkpoints we must still agree with.
    let nextCheck = k + 1;
    for (let t = meta.tick; t < toTick; t++) {
      this.recorder.collectInputs(t, this.commands);
      this.sim.step(t, this.commands);
      // Drain so an implementation that queues events does not grow unbounded.
      this.sim.drainEvents(DRAIN);
      res.ticksSimulated++;

      const nm = kf.metaAt(nextCheck);
      if (nm && nm.tick === t + 1) {
        if (this.sim.hash() !== nm.hash) {
          res.divergedAtTick = t + 1;
          res.reason = `state diverged at tick ${t + 1}`;
          res.hash = this.sim.hash();
          return res;
        }
        nextCheck++;
      }
    }

    res.hash = this.sim.hash();
    res.ok = true;
    return res;
  }

  /** Convenience: start from the newest keyframe at or before `fromTick`. */
  runFrom(fromTick: number, toTick: number): ResimResult {
    const k = this.recorder.keyframes.indexAtOrBefore(fromTick);
    if (k < 0) {
      return {
        ok: false, fromTick: -1, toTick, ticksSimulated: 0, hash: 0,
        divergedAtTick: -1, reason: `no keyframe at or before tick ${fromTick}`,
      };
    }
    return this.runFromKeyframe(k, toTick);
  }
}

const DRAIN: ReplayEvent[] = [replayEvent(), replayEvent(), replayEvent(), replayEvent()];

/* ------------------------------------------------------------- interpolate -- */

/**
 * A view over the snapshot ring that can be sampled at any continuous time.
 *
 * Interpolation is plain lerp on position and shortest-arc lerp on the angles.
 * An actor that appears or disappears between the two bracketing frames is
 * held at its known frame rather than popping to the origin, which is what
 * stops corpses and fresh spawns from streaking across the killcam.
 */
export class SnapshotPlayback {
  private a = actorSample();
  private b = actorSample();

  constructor(public ring: SnapshotRing) { }

  get fromTime(): number { return Math.max(0, this.ring.oldestTick) * TICK_DT; }
  get toTime(): number { return Math.max(0, this.ring.newestTick) * TICK_DT; }
  get duration(): number { return Math.max(0, this.toTime - this.fromTime); }

  /** Live actor ids present at time `t`. Returns the count written into `out`. */
  actorsAt(t: number, out: ActorSample[]): number {
    const tick = t / TICK_DT;
    const k = this.bracket(tick);
    if (k < 0) return 0;
    const k1 = Math.min(this.ring.length - 1, k + 1);
    const t0 = this.ring.frameTick(k);
    const t1 = this.ring.frameTick(k1);
    const alpha = t1 > t0 ? clamp01((tick - t0) / (t1 - t0)) : 0;

    const count = this.ring.frameCount(k);
    let n = 0;
    for (let slot = 0; slot < count; slot++) {
      if (!this.ring.read(k, slot, this.a)) continue;
      while (out.length <= n) out.push(actorSample());
      const dst = out[n++];
      const slot1 = this.ring.slotOf(k1, this.a.id);
      if (slot1 >= 0 && this.ring.read(k1, slot1, this.b)) {
        lerpSample(this.a, this.b, alpha, dst, (t1 - t0) * TICK_DT);
      } else {
        copySample(this.a, dst);
      }
    }
    return n;
  }

  /** Interpolated state of one actor at time `t`. */
  actorAt(id: number, t: number, out: ActorSample): boolean {
    const tick = t / TICK_DT;
    const k = this.bracket(tick);
    if (k < 0) return false;
    const s0 = this.ring.slotOf(k, id);
    if (s0 < 0) {
      // Fall back to the newest frame the actor did appear in, so following a
      // dead player holds on their body instead of snapping to the origin.
      for (let j = k - 1; j >= 0; j--) {
        const s = this.ring.slotOf(j, id);
        if (s >= 0) return this.ring.read(j, s, out);
      }
      return false;
    }
    this.ring.read(k, s0, this.a);
    const k1 = Math.min(this.ring.length - 1, k + 1);
    const s1 = this.ring.slotOf(k1, id);
    const t0 = this.ring.frameTick(k);
    const t1 = this.ring.frameTick(k1);
    if (s1 < 0 || t1 <= t0) { copySample(this.a, out); return true; }
    this.ring.read(k1, s1, this.b);
    lerpSample(this.a, this.b, clamp01((tick - t0) / (t1 - t0)), out, (t1 - t0) * TICK_DT);
    return true;
  }

  private bracket(tick: number): number {
    const n = this.ring.length;
    if (n === 0) return -1;
    const k = this.ring.frameAtOrBefore(tick);
    if (k < 0) return 0;
    return Math.min(k, n - 1);
  }
}

/* -------------------------------------------------------------------- util -- */

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Shortest-arc angle lerp — a killcam must not spin the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  const twoPi = Math.PI * 2;
  d -= twoPi * Math.floor((d + Math.PI) / twoPi);
  return a + d * t;
}

/**
 * Fastest a player can plausibly travel, metres/second. Anything quicker
 * between two snapshots did not *move* — it was teleported (a respawn, a
 * killstreak insertion, a host correction).
 *
 * Generous on purpose: it only has to sit above real locomotion and below a
 * map-scale jump, and being generous keeps genuine fast motion smooth.
 */
export const TELEPORT_SPEED = 40;

/** True when `a`→`b` over `seconds` is a teleport rather than locomotion. */
export function isTeleport(a: ActorSample, b: ActorSample, seconds: number): boolean {
  if (!(seconds > 0)) return false;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const limit = TELEPORT_SPEED * seconds;
  return dx * dx + dy * dy + dz * dz > limit * limit;
}

/**
 * `seconds` is the real time the two samples are apart. When they are further
 * apart than a player could have moved in it, position is *held* on the earlier
 * sample and changes over in one step at the boundary, exactly like the flags.
 * Smearing a respawn across the interval would drag the camera across the map.
 */
function lerpSample(
  a: ActorSample, b: ActorSample, t: number, out: ActorSample, seconds = 0,
): void {
  out.id = a.id;
  out.team = a.team;
  if (isTeleport(a, b, seconds)) {
    const s = t >= 1 ? b : a;
    out.x = s.x; out.y = s.y; out.z = s.z;
    out.yaw = s.yaw; out.pitch = s.pitch; out.health = s.health;
    out.flags = s.flags;
    out.weapon = s.weapon;
    return;
  }
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.yaw = lerpAngle(a.yaw, b.yaw, t);
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.health = a.health + (b.health - a.health) * t;
  // Flags never interpolate; the earlier frame owns them until the later one
  // is actually reached, so "alive" flips exactly once.
  out.flags = t >= 1 ? b.flags : a.flags;
  out.weapon = a.weapon;
}

function copySample(a: ActorSample, out: ActorSample): void {
  out.id = a.id; out.team = a.team;
  out.x = a.x; out.y = a.y; out.z = a.z;
  out.yaw = a.yaw; out.pitch = a.pitch;
  out.health = a.health; out.flags = a.flags; out.weapon = a.weapon;
}

export { actorSample, inputFrame };
