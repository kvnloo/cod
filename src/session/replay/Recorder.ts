/**
 * The recorder: one object that owns all four tracks and the memory budget.
 *
 * It is driven from the fixed step. Every tick it takes the actors' quantised
 * intent; at `snapshotHz` it takes an actor snapshot; every `keyframeSeconds`
 * it asks the sim for a full-state blob. Nothing here is optional — drop the
 * keyframes and re-simulation cannot start; drop the snapshots and a client
 * with no authority has nothing to show.
 *
 * Memory is fixed at construction. `bytes` is the real resident cost and
 * `bytesPerMinute` is what that buys you, both reported by the verifier.
 */

import { StateHash, StringTable } from './Hash';
import { EventRing, InputRing, KeyframeRing, SnapshotRing } from './Rings';
import {
  TICK_DT, TICK_HZ, type ActorSample, type InputFrame, type RecorderConfig,
  type ReplayEvent, type ReplaySim, actorSample, defaultRecorderConfig, inputFrame,
  replayEvent,
} from './types';

export interface RecordingWindow {
  /** Oldest and newest ticks held across all tracks. */
  fromTick: number;
  toTick: number;
  /** Same, in seconds of match time. */
  fromTime: number;
  toTime: number;
  seconds: number;
}

export interface RecorderStats {
  inputBytes: number;
  snapshotBytes: number;
  keyframeBytes: number;
  eventBytes: number;
  stringBytes: number;
  totalBytes: number;
  inputFrames: number;
  snapshotFrames: number;
  keyframes: number;
  events: number;
  /** Bytes the recorder would consume for one minute of match at this density. */
  bytesPerMinute: number;
}

export class ReplayRecorder {
  readonly config: RecorderConfig;
  readonly inputs: InputRing;
  readonly snapshots: SnapshotRing;
  readonly keyframes: KeyframeRing;
  readonly events: EventRing;
  readonly strings = new StringTable();

  /** Match identity — a replay is only valid against the same seed and build. */
  seed = 0;
  mode = '';
  formatVersion = 0;

  /** Ticks since the match started. Owned by the caller via `beginTick`. */
  tick = 0;
  recording = false;

  private snapshotEvery: number;
  private keyframeEvery: number;
  private nextSnapshotTick = 0;
  private nextKeyframeTick = 0;
  private actorScratch: ActorSample[] = [];
  private eventScratch: ReplayEvent[] = [];
  private inputPool: InputFrame[] = [];
  /** Density counters used to project bytes/minute from a real run. */
  private inputFramesTotal = 0;
  private snapshotFramesTotal = 0;
  private keyframesTotal = 0;
  private eventsTotal = 0;
  private ticksTotal = 0;

  constructor(config: Partial<RecorderConfig> = {}) {
    const c = { ...defaultRecorderConfig(), ...config };
    this.config = c;
    this.snapshotEvery = Math.max(1, Math.round(TICK_HZ / c.snapshotHz));
    this.keyframeEvery = Math.max(1, Math.round(c.keyframeSeconds * TICK_HZ));
    this.inputs = new InputRing(
      c.inputCapacity > 0
        ? c.inputCapacity
        : Math.ceil(c.inputSeconds * TICK_HZ * Math.max(1, c.inputActors)),
    );
    this.snapshots = new SnapshotRing(Math.ceil(c.snapshotSeconds * c.snapshotHz) + 1, c.maxActors);
    this.keyframes = new KeyframeRing(c.keyframeCount);
    this.events = new EventRing(c.eventCapacity);
    for (let i = 0; i < c.maxActors; i++) this.actorScratch.push(actorSample());
    for (let i = 0; i < 16; i++) this.eventScratch.push(replayEvent());
  }

  /* --------------------------------------------------------------- control -- */

  begin(seed: number, mode: string, formatVersion: number): void {
    this.seed = seed;
    this.mode = mode;
    this.formatVersion = formatVersion;
    this.tick = 0;
    this.nextSnapshotTick = 0;
    this.nextKeyframeTick = 0;
    this.inputFramesTotal = 0;
    this.snapshotFramesTotal = 0;
    this.keyframesTotal = 0;
    this.eventsTotal = 0;
    this.ticksTotal = 0;
    this.inputs.clear();
    this.snapshots.clear();
    this.keyframes.clear();
    this.events.clear();
    this.recording = true;
  }

  stop(): void { this.recording = false; }

  /* --------------------------------------------------------------- capture -- */

  /** Stores one actor's intent for the current tick. */
  recordInput(f: InputFrame): void {
    if (!this.recording) return;
    this.inputs.push(f);
    this.inputFramesTotal++;
  }

  /**
   * Called once per fixed step *before* the sim advances, and before any input
   * for this tick is recorded.
   *
   * Keyframes are captured here, not after the step, so a keyframe stamped
   * tick N means exactly "the state at the start of tick N". Replay can then
   * restore it and run `for (t = N; t < end; t++)` with no off-by-one — which
   * is the single most common way a replay system drifts.
   */
  beforeStep(sim: ReplaySim | null): void {
    if (!this.recording || !sim) return;
    if (this.tick < this.nextKeyframeTick) return;
    this.nextKeyframeTick = this.tick + this.keyframeEvery;
    const blob = sim.capture();
    this.keyframes.push(this.tick, blob, sim.hash());
    this.keyframesTotal++;
  }

  /**
   * Called once per fixed step *after* the sim has advanced. Drains the sim's
   * events, pulls a snapshot when one is due, and advances the tick counter.
   */
  afterStep(sim: ReplaySim | null): void {
    if (!this.recording) return;
    this.ticksTotal++;

    if (sim) {
      const n = sim.drainEvents(this.eventScratch);
      for (let i = 0; i < n; i++) {
        this.eventScratch[i].tick = this.tick;
        this.events.push(this.eventScratch[i]);
        this.eventsTotal++;
      }
    }

    if (this.tick >= this.nextSnapshotTick && sim) {
      this.nextSnapshotTick = this.tick + this.snapshotEvery;
      const n = sim.sample(this.actorScratch);
      this.snapshots.push(this.tick, this.actorScratch, n);
      this.snapshotFramesTotal++;
    }

    this.tick++;
  }

  /** Direct snapshot push for sources that are not a `ReplaySim` (a live game). */
  recordSnapshot(actors: readonly ActorSample[], n: number): void {
    if (!this.recording) return;
    if (this.tick < this.nextSnapshotTick) return;
    this.nextSnapshotTick = this.tick + this.snapshotEvery;
    this.snapshots.push(this.tick, actors, n);
    this.snapshotFramesTotal++;
  }

  recordEvent(e: ReplayEvent): void {
    if (!this.recording) return;
    e.tick = this.tick;
    this.events.push(e);
    this.eventsTotal++;
  }

  /** Advances the tick counter for callers that do not use `afterStep`. */
  advance(): void { if (this.recording) { this.ticksTotal++; this.tick++; } }

  /* ---------------------------------------------------------------- query -- */

  window(): RecordingWindow {
    const from = Math.max(
      this.inputs.oldestTick >= 0 ? this.inputs.oldestTick : 0,
      this.snapshots.oldestTick >= 0 ? this.snapshots.oldestTick : 0,
    );
    const to = Math.max(this.snapshots.newestTick, this.inputs.newestTick, 0);
    return {
      fromTick: from,
      toTick: to,
      fromTime: from * TICK_DT,
      toTime: to * TICK_DT,
      seconds: Math.max(0, (to - from) * TICK_DT),
    };
  }

  collectInputs(tick: number, out: InputFrame[]): number {
    return this.inputs.collect(tick, out, this.inputPool);
  }

  stats(): RecorderStats {
    const inputBytes = this.inputs.bytes;
    const snapshotBytes = this.snapshots.bytes;
    const keyframeBytes = this.keyframes.bytes;
    const eventBytes = this.events.bytes;
    const stringBytes = this.strings.bytes;
    const total = inputBytes + snapshotBytes + keyframeBytes + eventBytes + stringBytes;

    // Project from measured density rather than from capacity: a 4-player match
    // costs a quarter of a 16-player one and the number should say so.
    const seconds = Math.max(TICK_DT, this.ticksTotal * TICK_DT);
    const perMin = 60 * (
      (this.inputFramesTotal * 14
        + this.snapshotFramesTotal * (8 + this.config.maxActors * 20)
        + this.keyframesTotal * (this.keyframes.blobSize * 8 + 24)
        + this.eventsTotal * 28) / seconds
    );

    return {
      inputBytes, snapshotBytes, keyframeBytes, eventBytes, stringBytes,
      totalBytes: total,
      inputFrames: this.inputs.length,
      snapshotFrames: this.snapshots.length,
      keyframes: this.keyframes.length,
      events: this.events.length,
      bytesPerMinute: Math.round(perMin),
    };
  }

  /** Hash over the recorded tracks — a fingerprint of the recording itself. */
  fingerprint(): string {
    const h = new StateHash();
    h.u32(this.formatVersion).u32(this.seed).str(this.mode);
    const f = inputFrame();
    for (let i = 0; i < this.inputs.length; i++) {
      this.inputs.read(i, f);
      h.u32(f.tick).u32(f.actor).f(f.moveX, 127).f(f.moveY, 127)
        .f(f.yaw, 10430).f(f.pitch, 20860).u32(f.buttons);
    }
    return h.hex();
  }
}
