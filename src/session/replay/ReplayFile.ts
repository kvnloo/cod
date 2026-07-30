/**
 * Serialising a recording.
 *
 * The on-disk (really: on-`localStorage`) form is flat number arrays rather
 * than an array of objects. That is not premature optimisation — a 10 minute
 * match is ~1.4 M snapshot fields, and `[{id:…,x:…}]` costs roughly 8× what a
 * flat array does once JSON quoting is counted. Flat arrays also survive
 * `JSON.parse` without a per-sample allocation.
 *
 * Everything stays JSON so a replay is inspectable and diffable, which matches
 * the repo's no-binary-assets rule.
 */

import { StringTable } from './Hash';
import { ReplayRecorder } from './Recorder';
import {
  REPLAY_FORMAT_VERSION, TICK_DT, TICK_HZ, type ActorSample, type RecorderConfig,
  type ReplayEvent, type ReplayEventKind, actorSample, inputFrame, replayEvent,
} from './types';

const SNAPSHOT_FIELDS = 10;
const EVENT_FIELDS = 10;
const INPUT_FIELDS = 7;

const EVENT_KINDS: ReplayEventKind[] = [
  'kill', 'damage', 'shot', 'spawn', 'objective', 'phase', 'streak',
];

export interface ReplayFile {
  version: number;
  seed: number;
  mode: string;
  label: string;
  createdAt: number;
  tickHz: number;
  snapshotHz: number;
  maxActors: number;
  durationTicks: number;
  strings: string[];
  /** [tick, count] pairs. */
  snapFrames: number[];
  /** `SNAPSHOT_FIELDS` per actor, grouped by frame in `snapFrames` order. */
  snapData: number[];
  /** `EVENT_FIELDS` per event. */
  events: number[];
  /** `INPUT_FIELDS` per recorded actor-frame. */
  inputs: number[];
  keyframeStride: number;
  /** [tick, hash] pairs. */
  keyframeMeta: number[];
  keyframeData: number[];
  /** Fingerprint of the input track — a replay that fails this is not this match. */
  fingerprint: string;
}

/* ----------------------------------------------------------------- encode -- */

export function encodeReplay(rec: ReplayRecorder, label = ''): ReplayFile {
  const file: ReplayFile = {
    version: REPLAY_FORMAT_VERSION,
    seed: rec.seed,
    mode: rec.mode,
    label,
    createdAt: 0,
    tickHz: TICK_HZ,
    snapshotHz: rec.config.snapshotHz,
    maxActors: rec.config.maxActors,
    durationTicks: rec.tick,
    strings: rec.strings.toArray(),
    snapFrames: [],
    snapData: [],
    events: [],
    inputs: [],
    keyframeStride: rec.keyframes.blobSize,
    keyframeMeta: [],
    keyframeData: [],
    fingerprint: rec.fingerprint(),
  };

  const a = actorSample();
  for (let k = 0; k < rec.snapshots.length; k++) {
    const count = rec.snapshots.frameCount(k);
    file.snapFrames.push(rec.snapshots.frameTick(k), count);
    for (let s = 0; s < count; s++) {
      if (!rec.snapshots.read(k, s, a)) continue;
      file.snapData.push(
        a.id, r4(a.x), r4(a.y), r4(a.z), r5(a.yaw), r5(a.pitch),
        Math.round(a.health), a.flags, a.team, a.weapon,
      );
    }
  }

  const e = replayEvent();
  for (let k = 0; k < rec.events.length; k++) {
    if (!rec.events.read(k, e)) continue;
    file.events.push(
      e.tick, Math.max(0, EVENT_KINDS.indexOf(e.kind)), e.a, e.b,
      r4(e.x), r4(e.y), r4(e.z), r4(e.n), e.label, e.flags,
    );
  }

  const f = inputFrame();
  for (let k = 0; k < rec.inputs.length; k++) {
    if (!rec.inputs.read(k, f)) continue;
    file.inputs.push(f.tick, f.actor, r4(f.moveX), r4(f.moveY), r5(f.yaw), r5(f.pitch), f.buttons);
  }

  if (rec.keyframes.blobSize > 0) {
    const blob = rec.keyframes.allocBlob();
    for (let k = 0; k < rec.keyframes.length; k++) {
      const m = rec.keyframes.metaAt(k);
      if (!m || !rec.keyframes.read(k, blob)) continue;
      file.keyframeMeta.push(m.tick, m.hash);
      for (let i = 0; i < blob.length; i++) file.keyframeData.push(blob[i]);
    }
  }

  return file;
}

function r4(v: number): number { return Math.round(v * 10000) / 10000; }
function r5(v: number): number { return Math.round(v * 100000) / 100000; }

/* ----------------------------------------------------------------- decode -- */

export interface DecodeResult {
  ok: boolean;
  reason: string;
  recorder: ReplayRecorder | null;
}

/**
 * Rebuilds a recorder from a file. The rings are sized to hold the whole file,
 * so a theater recorder is bounded by the length of the match it loaded rather
 * than by the live killcam window.
 */
export function decodeReplay(file: ReplayFile): DecodeResult {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'not a replay file', recorder: null };
  if (file.version !== REPLAY_FORMAT_VERSION) {
    return { ok: false, reason: `format ${file.version} != ${REPLAY_FORMAT_VERSION}`, recorder: null };
  }
  if (!Array.isArray(file.snapData) || !Array.isArray(file.snapFrames)) {
    return { ok: false, reason: 'missing snapshot track', recorder: null };
  }

  const snapFrames = file.snapFrames.length / 2;
  const eventCount = Math.floor(file.events.length / EVENT_FIELDS);
  const inputCount = Math.floor(file.inputs.length / INPUT_FIELDS);
  const keyframeCount = Math.floor(file.keyframeMeta.length / 2);

  const config: Partial<RecorderConfig> = {
    snapshotHz: file.snapshotHz || 20,
    maxActors: file.maxActors || 24,
    snapshotSeconds: Math.max(1, snapFrames / Math.max(1, file.snapshotHz || 20)),
    inputSeconds: Math.max(1, file.durationTicks * TICK_DT),
    // Sized to exactly what the file holds: nothing loaded may be discarded.
    inputCapacity: Math.max(1, inputCount),
    keyframeCount: Math.max(1, keyframeCount),
    eventCapacity: Math.max(1, eventCount),
  };
  const rec = new ReplayRecorder(config);
  // Sized to the file exactly; the ring must not discard what we just loaded.
  const inputRing = rec.inputs;
  if (inputCount > inputRing.capacity) {
    return {
      ok: false,
      reason: `input track (${inputCount}) exceeds ring capacity (${inputRing.capacity})`,
      recorder: null,
    };
  }

  rec.begin(file.seed, file.mode, file.version);
  rec.recording = true;
  const strings = StringTable.from(file.strings ?? []);
  for (const s of file.strings ?? []) rec.strings.intern(s);

  /* snapshots */
  const buf: ActorSample[] = [];
  let cursor = 0;
  for (let i = 0; i < snapFrames; i++) {
    const tick = file.snapFrames[i * 2];
    const count = file.snapFrames[i * 2 + 1];
    for (let s = 0; s < count; s++) {
      while (buf.length <= s) buf.push(actorSample());
      const a = buf[s];
      a.id = file.snapData[cursor];
      a.x = file.snapData[cursor + 1];
      a.y = file.snapData[cursor + 2];
      a.z = file.snapData[cursor + 3];
      a.yaw = file.snapData[cursor + 4];
      a.pitch = file.snapData[cursor + 5];
      a.health = file.snapData[cursor + 6];
      a.flags = file.snapData[cursor + 7];
      a.team = file.snapData[cursor + 8];
      a.weapon = file.snapData[cursor + 9];
      cursor += SNAPSHOT_FIELDS;
    }
    rec.snapshots.push(tick, buf, count);
  }

  /* events */
  const e = replayEvent();
  for (let i = 0; i < eventCount; i++) {
    const o = i * EVENT_FIELDS;
    e.tick = file.events[o];
    e.kind = EVENT_KINDS[file.events[o + 1]] ?? 'kill';
    e.a = file.events[o + 2];
    e.b = file.events[o + 3];
    e.x = file.events[o + 4];
    e.y = file.events[o + 5];
    e.z = file.events[o + 6];
    e.n = file.events[o + 7];
    e.label = file.events[o + 8];
    e.flags = file.events[o + 9];
    rec.events.push(e);
  }

  /* inputs */
  const f = inputFrame();
  for (let i = 0; i < inputCount; i++) {
    const o = i * INPUT_FIELDS;
    f.tick = file.inputs[o];
    f.actor = file.inputs[o + 1];
    f.moveX = file.inputs[o + 2];
    f.moveY = file.inputs[o + 3];
    f.yaw = file.inputs[o + 4];
    f.pitch = file.inputs[o + 5];
    f.buttons = file.inputs[o + 6];
    rec.inputs.push(f);
  }

  /* keyframes */
  if (file.keyframeStride > 0 && keyframeCount > 0) {
    const blob = new Float64Array(file.keyframeStride);
    for (let i = 0; i < keyframeCount; i++) {
      for (let j = 0; j < file.keyframeStride; j++) {
        blob[j] = file.keyframeData[i * file.keyframeStride + j];
      }
      rec.keyframes.push(file.keyframeMeta[i * 2], blob, file.keyframeMeta[i * 2 + 1] >>> 0);
    }
  }

  rec.tick = file.durationTicks;
  rec.stop();

  // Round-tripping must not change the input stream. If it did, every downstream
  // determinism claim is void, so say so loudly here rather than at replay time.
  if (file.fingerprint && rec.fingerprint() !== file.fingerprint) {
    return {
      ok: false,
      reason: `input fingerprint mismatch: ${rec.fingerprint()} != ${file.fingerprint}`,
      recorder: null,
    };
  }
  void strings;
  return { ok: true, reason: '', recorder: rec };
}

/* ------------------------------------------------------------------- size -- */

export function replayFileBytes(file: ReplayFile): number {
  // JSON of numbers averages ~7 bytes per field including the separator.
  const fields = file.snapData.length + file.snapFrames.length
    + file.events.length + file.inputs.length + file.keyframeData.length
    + file.keyframeMeta.length;
  let strBytes = 0;
  for (const s of file.strings) strBytes += s.length + 3;
  return fields * 7 + strBytes + 256;
}

/* ---------------------------------------------------------------- storage -- */

const STORE_PREFIX = 'blackout.theater.';

/** Saves a replay. Returns false when storage is missing or the quota is hit. */
export function saveReplayFile(file: ReplayFile, slot = 'last'): boolean {
  try {
    const s = globalThis.localStorage;
    if (!s) return false;
    s.setItem(STORE_PREFIX + slot, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}

export function loadReplayFile(slot = 'last'): ReplayFile | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_PREFIX + slot);
    if (!raw) return null;
    return JSON.parse(raw) as ReplayFile;
  } catch {
    return null;
  }
}

export function listReplaySlots(): string[] {
  try {
    const s = globalThis.localStorage;
    if (!s) return [];
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(STORE_PREFIX)) out.push(k.slice(STORE_PREFIX.length));
    }
    return out.sort();
  } catch {
    return [];
  }
}

export function deleteReplayFile(slot: string): void {
  try { globalThis.localStorage?.removeItem(STORE_PREFIX + slot); } catch { /* ignore */ }
}

export type { ReplayEvent };
