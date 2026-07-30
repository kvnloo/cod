/**
 * Client-side interpolation: the layer that turns a 20-30 Hz jittery snapshot
 * feed into smooth motion for everything the local player does not control.
 *
 * Read the file headers in this directory for the reasoning behind each number.
 * The short version:
 *
 *   Clock.ts          four-timestamp NTP, minimum-RTT filter, slewed apply.
 *                     `serverNowMs()` is monotonic; error tracks rttMin/2.
 *   SnapshotBuffer.ts ring of reconstructed snapshots + the adaptive playout
 *                     delay (2 snapshot intervals + 1.5x peak jitter, 40-300 ms).
 *   Interpolator.ts   Hermite position / slerp rotation between the straddling
 *                     pair, authoritative teleport handling, monotonic playout.
 *   Extrapolate.ts    bounded dead reckoning (250 ms / 2 m / 12 m/s, decaying)
 *                     and the error smoother that hides the snap back.
 *
 * Everything here is transport-agnostic and authority-agnostic. It consumes
 * `Snapshot` values and a `TimeSource`; it does not care whether the host is a
 * peer on a DataChannel today or a dedicated server tomorrow.
 */

export type { EntityState, InterpTransform, Quat, Snapshot, TimeSource, Vec3 } from './types';

export { ClockSyncDriver, DEFAULT_CLOCK_OPTIONS, LocalTimeSource, NetClock } from './Clock';
export type { ClockSample, NetClockOptions } from './Clock';

export { DEFAULT_BUFFER_OPTIONS, SnapshotBuffer } from './SnapshotBuffer';
export type {
  SnapshotBufferOptions, SnapshotBufferStats, SnapshotEntry, SnapshotSample,
} from './SnapshotBuffer';

export {
  DEFAULT_EXTRAPOLATION, DEFAULT_SMOOTHER, ErrorSmoother, estimateVelocity, extrapolate,
  makeExtrapolationResult,
} from './Extrapolate';
export type {
  ErrorSmootherOptions, ExtrapolationLimits, ExtrapolationResult,
} from './Extrapolate';

export { DEFAULT_INTERPOLATOR_OPTIONS, Interpolator } from './Interpolator';
export type { InterpolatorOptions, InterpolatorStats } from './Interpolator';

export { INTERPOLATION_ORDER, InterpolationSystem } from './InterpolationSystem';
export type { TransformVisitor } from './InterpolationSystem';

export {
  distance, hermiteVec, hermiteVelocity, lerpVec, quat, quatAngle, slerpQuat, vec3,
} from './math';
