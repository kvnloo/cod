/**
 * Session replay contracts.
 *
 * Killcam, spectating and theater are one capability with three presentations,
 * so they all read from one recording. The recording is *not* rendered output:
 * it is
 *
 *   1. the quantised input stream, one frame per actor per fixed step,
 *   2. periodic full-state keyframes the simulation can be restored from,
 *   3. a low-rate actor snapshot track for interpolated playback, and
 *   4. a sparse event track (kills, shots, spawns) for readability and bookmarks.
 *
 * (1) + (2) give exact re-simulation, which is what theater and the host use.
 * (3) + (4) give playback with no simulation at all, which is what a *client*
 * uses for a killcam: a client is not authoritative and must never re-run the
 * match locally to decide what happened.
 *
 * Nothing in this file imports THREE or touches the DOM — the whole core is
 * plain numbers so it can be verified headlessly in node.
 */

/* ------------------------------------------------------------------ clock -- */

/** Simulation rate. Matches `Time.fixedDelta` (1/120). */
export const TICK_HZ = 120;
export const TICK_DT = 1 / TICK_HZ;

/** Bumped whenever the recorded layout changes. Old files are rejected. */
export const REPLAY_FORMAT_VERSION = 1;

/* ------------------------------------------------------------------- math -- */

export interface Vec3 { x: number; y: number; z: number }

export function vec3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; }

/** Camera pose in the same convention the engine camera uses (`YXZ` euler). */
export interface CameraPose {
  x: number; y: number; z: number;
  yaw: number; pitch: number; roll: number;
  fov: number;
}

export function cameraPose(): CameraPose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 75 };
}

/* ------------------------------------------------------------------ input -- */

/**
 * Button bits — **bit-identical to `BUTTON` in `src/net/types.ts`**.
 *
 * Deliberately duplicated rather than imported: this file must stay free of
 * every other module so the core compiles standalone in node. Duplication with
 * a stated invariant beats a translation table, which is a thing that silently
 * rots. If the netcode layout changes, this changes with it.
 */
export const BTN = {
  fire: 1 << 0,
  ads: 1 << 1,
  jump: 1 << 2,
  crouch: 1 << 3,
  prone: 1 << 4,
  sprint: 1 << 5,
  reload: 1 << 6,
  melee: 1 << 7,
  use: 1 << 8,
  grenade: 1 << 9,
  tactical: 1 << 10,
  leanLeft: 1 << 11,
  leanRight: 1 << 12,
  swap: 1 << 13,
} as const;

export type ButtonName = keyof typeof BTN;

/**
 * One actor's intent for one fixed step, already quantised.
 *
 * Quantisation happens *before* the simulation consumes it, never after. That
 * is the only way a recorded stream can reproduce a run bit for bit: the sim
 * must have eaten exactly the numbers we stored.
 */
export interface InputFrame {
  tick: number;
  actor: number;
  /** Strafe / forward intent, [-1..1] after quantisation to 1/127. */
  moveX: number;
  moveY: number;
  /** Absolute look angles in radians, quantised to 2π/65536 and π/32768. */
  yaw: number;
  pitch: number;
  /** `BTN` bitfield. */
  buttons: number;
}

export function inputFrame(): InputFrame {
  return { tick: 0, actor: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0 };
}

const YAW_SCALE = 65536 / (Math.PI * 2);
const PITCH_SCALE = 32768 / (Math.PI * 0.5);

export function quantAxis(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127)));
}
export function dequantAxis(q: number): number { return q / 127; }

export function quantYaw(rad: number): number {
  // Wrap into [-π, π) first so the int16 round-trips exactly.
  let a = rad;
  const twoPi = Math.PI * 2;
  a -= twoPi * Math.floor((a + Math.PI) / twoPi);
  const q = Math.round(a * YAW_SCALE);
  return q > 32767 ? q - 65536 : q < -32768 ? q + 65536 : q;
}
export function dequantYaw(q: number): number { return q / YAW_SCALE; }

export function quantPitch(rad: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(rad * PITCH_SCALE)));
}
export function dequantPitch(q: number): number { return q / PITCH_SCALE; }

/**
 * Forces a frame through the wire representation in place.
 *
 * The simulation must eat exactly what the recorder stored, so callers snap the
 * frame *before* both the sim and the recorder see it. Skip this and a live run
 * and its replay differ by one quantisation step per tick, which compounds into
 * a visible drift inside a couple of seconds.
 */
export function quantizeInPlace(f: InputFrame): InputFrame {
  f.moveX = dequantAxis(quantAxis(f.moveX));
  f.moveY = dequantAxis(quantAxis(f.moveY));
  f.yaw = dequantYaw(quantYaw(f.yaw));
  f.pitch = dequantPitch(quantPitch(f.pitch));
  f.buttons &= 0xffff;
  return f;
}

/* ------------------------------------------------------------------ actor -- */

/** Flags packed into `ActorSample.flags`. */
export const ACTOR = {
  alive: 1 << 0,
  firing: 1 << 1,
  ads: 1 << 2,
  crouched: 1 << 3,
  sprinting: 1 << 4,
  airborne: 1 << 5,
  local: 1 << 6,
} as const;

/** One actor at one snapshot instant — enough to draw them and follow them. */
export interface ActorSample {
  id: number;
  team: number;
  x: number; y: number; z: number;
  yaw: number;
  pitch: number;
  /** 0..255 scaled health. */
  health: number;
  /** `ACTOR` bitfield. */
  flags: number;
  /** Index into the recording's string table. */
  weapon: number;
}

export function actorSample(): ActorSample {
  return { id: 0, team: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 0, flags: 0, weapon: 0 };
}

export function isAlive(a: ActorSample): boolean { return (a.flags & ACTOR.alive) !== 0; }

/* ----------------------------------------------------------------- events -- */

export type ReplayEventKind =
  | 'kill' | 'damage' | 'shot' | 'spawn' | 'objective' | 'phase' | 'streak';

/**
 * A sparse gameplay event. `a`/`b` are actor ids (subject / object), the three
 * floats are a world point, and `n` is a kind-specific scalar (damage amount,
 * distance, phase index).
 */
export interface ReplayEvent {
  tick: number;
  kind: ReplayEventKind;
  a: number;
  b: number;
  x: number; y: number; z: number;
  n: number;
  /** Index into the string table (weapon id, objective id, …). */
  label: number;
  /** Bitfield: 1 = headshot, 2 = fatal, 4 = by local player. */
  flags: number;
}

export const EVT = { headshot: 1, fatal: 2, byLocal: 4, penetrated: 8 } as const;

export function replayEvent(): ReplayEvent {
  return { tick: 0, kind: 'kill', a: -1, b: -1, x: 0, y: 0, z: 0, n: 0, label: 0, flags: 0 };
}

/* -------------------------------------------------------------- simulation -- */

/**
 * The narrow contract a simulation must satisfy to be re-simulated from a
 * keyframe. Implemented by `ProbeSim` (verification) and, in the game, by the
 * host-side match adapter.
 *
 * The contract is deliberately tiny: everything the replay layer needs is
 * "restore this blob", "step exactly one tick with these commands", "hash your
 * whole state". If a sim cannot do those three things it is not deterministic
 * and no amount of recording will save it.
 */
export interface ReplaySim {
  /** Full state as a transferable blob. Must round-trip through `restore`. */
  capture(): Float64Array;
  restore(blob: Float64Array): void;
  /** Advance exactly one fixed step consuming the commands stamped for `tick`. */
  step(tick: number, commands: readonly InputFrame[]): void;
  /** Order-independent-free, quantised hash of the entire simulation state. */
  hash(): number;
  /** Current actor state for the snapshot track. Returns the count written. */
  sample(out: ActorSample[]): number;
  /** Events produced during the last `step`, drained by the recorder. */
  drainEvents(out: ReplayEvent[]): number;
}

/* --------------------------------------------------------------- authority -- */

/**
 * What the replay layer needs from the netcode layer, which does not exist yet.
 *
 * The rule the whole module is written to: **the host decides, clients request
 * and display.** A client recorder is a passive mirror of what the host told it
 * — it may record, scrub and render, but `resim` playback is only trusted on
 * the host. `SessionReplay` degrades to snapshot playback when `role` is
 * `'client'`, which is exactly what a shipped killcam does.
 *
 * When `src/net/` lands, whatever it exposes needs to be adapted to this shape;
 * nothing here reaches into it.
 */
export type AuthorityRole = 'host' | 'client' | 'offline';

export interface ReplayAuthority {
  readonly role: AuthorityRole;
  /** Actor id of the viewer. -1 before the local player exists. */
  readonly localActor: number;
  /** Server tick the local client currently believes is authoritative. */
  readonly serverTick: number;
  /**
   * Ask the host for a killcam. Clients cannot mint one locally: the host owns
   * the fatal shot. Returns false when unavailable and the caller should fall
   * back to the locally recorded snapshot track.
   */
  requestKillcam?(victim: number, deathTick: number): boolean;
}

/** The offline / single-player authority: everything is local and trusted. */
export function offlineAuthority(localActor = 0): ReplayAuthority {
  return { role: 'offline', localActor, serverTick: 0 };
}

/* ----------------------------------------------------------------- config -- */

export interface RecorderConfig {
  /** Seconds of input history kept. The ring never grows past this. */
  inputSeconds: number;
  /**
   * How many actors send input. The input ring is sized
   * `inputSeconds × TICK_HZ × inputActors`, so this is the knob that decides
   * whether the buffer costs 200 KB or 2 MB. Bots that are simulated from the
   * host's own script do not need an input slot; players do.
   */
  inputActors: number;
  /** Overrides the computed input ring capacity in frames. 0 = compute it. */
  inputCapacity: number;
  /** Seconds of interpolated actor snapshots kept. */
  snapshotSeconds: number;
  /** Snapshot rate in Hz. 20 is plenty for a smooth killcam. */
  snapshotHz: number;
  /** Seconds between full-state keyframes. */
  keyframeSeconds: number;
  /** How many keyframes to keep. */
  keyframeCount: number;
  /** Max sparse events kept. */
  eventCapacity: number;
  /** Max actors tracked per snapshot. */
  maxActors: number;
}

export function defaultRecorderConfig(): RecorderConfig {
  return {
    inputSeconds: 30,
    inputActors: 12,
    inputCapacity: 0,
    snapshotSeconds: 30,
    snapshotHz: 20,
    keyframeSeconds: 2,
    keyframeCount: 16,
    eventCapacity: 512,
    maxActors: 24,
  };
}

/** Theater keeps the whole match, so it is sized by match length, not seconds. */
export function theaterRecorderConfig(matchSeconds = 900, actors = 12): RecorderConfig {
  return {
    inputSeconds: matchSeconds,
    inputActors: actors,
    inputCapacity: 0,
    snapshotSeconds: matchSeconds,
    snapshotHz: 20,
    keyframeSeconds: 5,
    keyframeCount: Math.ceil(matchSeconds / 5) + 2,
    eventCapacity: 4096,
    maxActors: Math.max(actors, 12),
  };
}
