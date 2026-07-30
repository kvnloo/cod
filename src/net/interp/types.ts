/**
 * Shared value types for the client-side interpolation layer.
 *
 * UNITS — read this once and never guess again:
 *   - All *times* in this module are **milliseconds**. Network timestamps are
 *     naturally ms, and mixing seconds with ms is the single most common source
 *     of netcode bugs. The engine's fixed step is in seconds; convert at the
 *     boundary (`ms * 0.001`) and nowhere else.
 *   - All *distances* are metres and all *velocities* metres/second, matching
 *     the Rapier world scale used by `src/physics`.
 *
 * These are plain-old-data structs, deliberately free of any `three` import so
 * the whole interpolation layer can be unit-tested in a bare Node process with
 * no WebGL and no DOM. They are structurally compatible with three's
 * `Vector3Like` / `QuaternionLike`, so consumers can do
 * `mesh.position.copy(t.position)` and `mesh.quaternion.copy(t.rotation)`
 * directly.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * One entity's authoritative *visual* state inside a snapshot.
 *
 * This is what the host chose to replicate for remote viewing. It is NOT the
 * full simulation state — the host keeps that. Everything here is optional
 * except `id` and `position` so the delta-compression layer upstream can omit
 * unchanged fields without forcing this layer to invent values.
 */
export interface EntityState {
  /** Stable network id. Not the local ECS handle. */
  readonly id: number;
  readonly position: Vec3;
  /** Absent means "no orientation replicated" (e.g. a point light, a pickup). */
  readonly rotation?: Quat;
  /**
   * Linear velocity in m/s at the snapshot instant. When present it upgrades
   * position interpolation from linear to cubic Hermite and enables bounded
   * dead reckoning. When absent both fall back to finite differences.
   */
  readonly velocity?: Vec3;
  /**
   * Monotonic counter the **server** bumps on any non-continuous motion:
   * spawn, respawn, teleporter, physics re-seat, ragdoll hand-off.
   *
   * This is the authoritative discontinuity signal and it is always preferred
   * over the distance heuristic in `Interpolator`. A server that maintains this
   * correctly gets perfect snapping; a server that does not still gets the
   * heuristic, but the heuristic can be fooled by a genuinely fast projectile.
   */
  readonly teleport?: number;
  /**
   * Generic scalar channels interpolated linearly: door open amount, turret
   * yaw, health bar, hatch angle. Keyed by a short string the gameplay layer
   * agrees on. Keys missing from one side of a pair are held, not zeroed.
   */
  readonly scalars?: Readonly<Record<string, number>>;
}

/**
 * A fully reconstructed world snapshot at one server tick.
 *
 * IMPORTANT: this layer consumes *reconstructed* snapshots. Delta decoding
 * against a baseline happens upstream (in the protocol/delta layer) before
 * `SnapshotBuffer.push`. Interpolation must never have to care whether the wire
 * form was a delta or a keyframe.
 */
export interface Snapshot {
  /** Server tick number. Monotonic on the server; may arrive out of order. */
  readonly tick: number;
  /** Server-clock time (ms) the tick represents. */
  readonly serverTimeMs: number;
  readonly entities: readonly EntityState[];
  /** Informational: the tick this was delta-encoded against, if any. */
  readonly baseTick?: number;
}

/** What `Interpolator` produces for one visible remote entity, per frame. */
export interface InterpTransform {
  readonly id: number;
  /** Render position, metres. Includes any active error-smoothing offset. */
  readonly position: Vec3;
  /** Render orientation. Identity when the entity replicates no rotation. */
  readonly rotation: Quat;
  /**
   * Velocity of the *rendered* motion, m/s. Feed this to audio doppler,
   * locomotion blend trees and cloth — not the raw snapshot velocity, which
   * is a step function.
   */
  readonly velocity: Vec3;
  /** Interpolated scalar channels. Empty object when none replicate. */
  readonly scalars: Record<string, number>;
  /**
   * True on the frame the entity teleported / respawned / first appeared.
   * Consumers MUST hard-reset trails, ribbons, footstep state and camera
   * follow on this frame instead of easing.
   */
  readonly snapped: boolean;
  /** True on the frame the entity first became visible. Implies `snapped`. */
  readonly fresh: boolean;
  /** How far past the newest snapshot this pose is dead reckoned, ms. 0 when interpolating. */
  readonly extrapolatedMs: number;
  /** True while extrapolation is pinned at a cap — the entity is frozen, not sliding. */
  readonly stalled: boolean;
  /** Magnitude of the error-smoothing offset still being bled off, metres. */
  readonly correctionM: number;
}

/** Anything that can answer "what time is it on the server, in ms?". */
export interface TimeSource {
  /**
   * Server-clock milliseconds. Guaranteed monotonic non-decreasing within an
   * epoch (see `NetClock.epoch`).
   */
  serverNowMs(): number;
  /** Bumped whenever the mapping jumps discontinuously. */
  readonly epoch: number;
}
