/**
 * Lag compensation — debug capture.
 *
 * Netcode bugs are invisible. "It felt off" is the only symptom you get, and by
 * the time you notice, the frame is gone. So every rewind can be recorded into a
 * fixed-size ring: the ray that was traced, every candidate's hitboxes both as
 * they were reconstructed *and* as they are right now, and what the trace
 * decided. A future debug scene draws the two sets in different colours and the
 * whole feature becomes something you can look at.
 *
 * The ring is preallocated and THREE-free — it hands out plain Float32Arrays of
 * box transforms plus a corner/edge helper, so a renderer can push them into a
 * LineSegments buffer without this module knowing what a renderer is. Recording
 * is off unless `lagcompConfig.debug` is true, and even then costs one copy of
 * ~180 floats per candidate.
 */

import { hitPartName, type RejectReason } from './types';
import { rotateVec } from './Geom';
import { FLOATS_PER_BOX } from './HitboxHistory';

/** One candidate player inside a recorded rewind. */
export class RewindDebugTarget {
  playerId = -1;
  boxCount = 0;
  /** Reconstructed pose at the rewound time — boxCount * FLOATS_PER_BOX. */
  readonly rewound: Float32Array;
  /** Pose at the newest recorded tick, same layout. */
  readonly present: Float32Array;
  readonly parts: Uint8Array;
  /** Distance the first hitbox moved between the two poses, metres. */
  displacementM = 0;

  constructor(maxBoxes: number) {
    this.rewound = new Float32Array(maxBoxes * FLOATS_PER_BOX);
    this.present = new Float32Array(maxBoxes * FLOATS_PER_BOX);
    this.parts = new Uint8Array(maxBoxes);
  }
}

/** One recorded rewind. Reused in place; copy anything you need to keep. */
export class RewindDebugRecord {
  seq = -1;
  shooterId = -1;
  serverTimeSec = 0;
  renderTimeSec = 0;
  rewindMs = 0;

  readonly rayOrigin = new Float32Array(3);
  readonly rayDir = new Float32Array(3);
  rayLengthM = 0;

  hit = false;
  hitPlayerId = -1;
  hitPart = -1;
  hitDistanceM = 0;
  rewindDistanceM = 0;
  blockedByWorld = false;
  reason: RejectReason = 'ok';

  targetCount = 0;
  readonly targets: RewindDebugTarget[];

  constructor(maxTargets: number, private readonly maxBoxes: number) {
    this.targets = new Array(maxTargets);
    for (let i = 0; i < maxTargets; i++) this.targets[i] = new RewindDebugTarget(maxBoxes);
  }

  addTarget(
    playerId: number, boxCount: number,
    rewound: Float32Array, present: Float32Array, parts: Uint8Array,
    displacementM: number,
  ): void {
    if (this.targetCount >= this.targets.length) return;
    const t = this.targets[this.targetCount++];
    const n = Math.min(boxCount, this.maxBoxes);
    t.playerId = playerId;
    t.boxCount = n;
    t.displacementM = displacementM;
    const f = n * FLOATS_PER_BOX;
    for (let i = 0; i < f; i++) {
      t.rewound[i] = rewound[i];
      t.present[i] = present[i];
    }
    for (let i = 0; i < n; i++) t.parts[i] = parts[i];
  }

  finish(
    hit: boolean, hitPlayerId: number, hitPart: number,
    hitDistanceM: number, rewindDistanceM: number,
    reason: RejectReason, blockedByWorld: boolean,
  ): void {
    this.hit = hit;
    this.hitPlayerId = hitPlayerId;
    this.hitPart = hitPart;
    this.hitDistanceM = hitDistanceM;
    this.rewindDistanceM = rewindDistanceM;
    this.reason = reason;
    this.blockedByWorld = blockedByWorld;
  }
}

export interface RewindDebugRingOptions {
  capacity?: number;
  maxTargets?: number;
  maxBoxes?: number;
}

export class RewindDebugRing {
  readonly capacity: number;
  private readonly records: RewindDebugRecord[];
  private cursor = -1;
  private filled = 0;
  private nextSeq = 0;

  constructor(opts: RewindDebugRingOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 32);
    const maxTargets = Math.max(1, opts.maxTargets ?? 8);
    const maxBoxes = Math.max(1, opts.maxBoxes ?? 18);
    this.records = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.records[i] = new RewindDebugRecord(maxTargets, maxBoxes);
  }

  /** Number of records currently held. */
  get size(): number { return this.filled; }

  /** Open the next record. Called by RewindService; safe to call directly. */
  begin(
    shooterId: number, serverTimeSec: number, renderTimeSec: number, rewindMs: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    rayLengthM: number,
  ): RewindDebugRecord {
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
    const r = this.records[this.cursor];
    r.seq = this.nextSeq++;
    r.shooterId = shooterId;
    r.serverTimeSec = serverTimeSec;
    r.renderTimeSec = renderTimeSec;
    r.rewindMs = rewindMs;
    r.rayOrigin[0] = ox; r.rayOrigin[1] = oy; r.rayOrigin[2] = oz;
    r.rayDir[0] = dx; r.rayDir[1] = dy; r.rayDir[2] = dz;
    r.rayLengthM = rayLengthM;
    r.targetCount = 0;
    r.hit = false;
    r.hitPlayerId = -1;
    r.hitPart = -1;
    r.hitDistanceM = 0;
    r.rewindDistanceM = 0;
    r.blockedByWorld = false;
    r.reason = 'ok';
    return r;
  }

  latest(): RewindDebugRecord | null {
    return this.filled === 0 ? null : this.records[this.cursor];
  }

  /** Oldest first. */
  forEach(fn: (record: RewindDebugRecord, index: number) => void): void {
    for (let i = 0; i < this.filled; i++) {
      const idx = (this.cursor - (this.filled - 1) + i + this.capacity * 2) % this.capacity;
      fn(this.records[idx], i);
    }
  }

  clear(): void { this.cursor = -1; this.filled = 0; }
}

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */

/** Index pairs into the 8 corners produced by `obbCorners`, for LineSegments. */
export const OBB_EDGE_INDICES: readonly number[] = [
  0, 1, 1, 3, 3, 2, 2, 0,
  4, 5, 5, 7, 7, 6, 6, 4,
  0, 4, 1, 5, 2, 6, 3, 7,
];

const _c = new Float32Array(3);

/**
 * Expand one stored box into 8 world-space corners (24 floats).
 * Corner bit order: x = bit0, y = bit1, z = bit2.
 */
export function obbCorners(
  boxes: Float32Array, boxOffset: number,
  out: Float32Array, outOffset = 0,
): void {
  const px = boxes[boxOffset], py = boxes[boxOffset + 1], pz = boxes[boxOffset + 2];
  const hx = boxes[boxOffset + 3], hy = boxes[boxOffset + 4], hz = boxes[boxOffset + 5];
  const qx = boxes[boxOffset + 6], qy = boxes[boxOffset + 7];
  const qz = boxes[boxOffset + 8], qw = boxes[boxOffset + 9];
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? hx : -hx;
    const sy = (i & 2) ? hy : -hy;
    const sz = (i & 4) ? hz : -hz;
    rotateVec(qx, qy, qz, qw, sx, sy, sz, _c, 0);
    const o = outOffset + i * 3;
    out[o] = px + _c[0];
    out[o + 1] = py + _c[1];
    out[o + 2] = pz + _c[2];
  }
}

/** One-line human summary — console, overlay text, test output. */
export function describeRewind(r: RewindDebugRecord): string {
  const head = '#' + r.seq + ' shooter ' + r.shooterId
    + ' rewind ' + r.rewindMs.toFixed(1) + 'ms'
    + ' (t=' + r.renderTimeSec.toFixed(4) + ' of ' + r.serverTimeSec.toFixed(4) + ')'
    + ' candidates ' + r.targetCount;
  if (r.hit) {
    return head + ' -> HIT player ' + r.hitPlayerId + ' ' + hitPartName(r.hitPart)
      + ' at ' + r.hitDistanceM.toFixed(2) + 'm, target had moved '
      + r.rewindDistanceM.toFixed(3) + 'm since';
  }
  if (r.blockedByWorld) return head + ' -> BLOCKED by world geometry';
  return head + ' -> MISS (' + r.reason + ')';
}

/** Process-wide debug ring, so a debug scene can find recordings with no wiring. */
export const lagcompDebugRing = new RewindDebugRing();
