/**
 * Lag compensation — shared types and tuning.
 *
 * This whole module is deliberately **dependency free**: no three, no DOM, no
 * Rapier, no imports from any other net module. That is not tidiness for its own
 * sake — it is the authority boundary. The exact same files must run inside the
 * browser peer that is currently acting as host *and* inside a headless Node
 * dedicated server later, with zero gameplay rewrite. Anything that reaches for
 * `window`, a THREE.Object3D or a Rapier collider would have to be torn out on
 * that move, so none of it is allowed in here.
 *
 * `Vec3` / `Quat` are structural, so a caller may pass a `THREE.Vector3` or a
 * `THREE.Quaternion` directly without this module ever importing three.
 */

/** Structurally compatible with THREE.Vector3. */
export interface Vec3 { x: number; y: number; z: number; }

/** Structurally compatible with THREE.Quaternion. */
export interface Quat { x: number; y: number; z: number; w: number; }

/* ------------------------------------------------------------------ */
/* Hitbox parts                                                        */
/* ------------------------------------------------------------------ */

/**
 * Canonical hitbox parts. Numeric so they live in a Uint8Array in the history
 * ring. The ordering is stable and is part of the wire contract — append only,
 * never renumber.
 */
export const HitPart = {
  Head: 0,
  Neck: 1,
  Chest: 2,
  Stomach: 3,
  Pelvis: 4,
  UpperArmL: 5,
  UpperArmR: 6,
  ForearmL: 7,
  ForearmR: 8,
  HandL: 9,
  HandR: 10,
  ThighL: 11,
  ThighR: 12,
  ShinL: 13,
  ShinR: 14,
  FootL: 15,
  FootR: 16,
} as const;

export type HitPartId = (typeof HitPart)[keyof typeof HitPart];

export const HIT_PART_COUNT = 17;

export const HIT_PART_NAMES: readonly string[] = [
  'head', 'neck', 'chest', 'stomach', 'pelvis',
  'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
];

/**
 * Advisory damage multipliers. The weapon system owns real damage numbers; this
 * table exists so the host can resolve a hit into a scale without a round trip
 * to a module it must not depend on. Callers are free to ignore it.
 */
export const HIT_PART_DAMAGE_HINT: readonly number[] = [
  2.50, 1.60, 1.00, 1.00, 1.00,
  0.90, 0.90, 0.80, 0.80, 0.70, 0.70,
  0.85, 0.85, 0.75, 0.75, 0.70, 0.70,
];

/**
 * Mirrors `HitZone` in src/physics/types.ts by value, without importing it — we
 * do not take a dependency on a module another agent owns. Assignable both ways.
 */
export type LagCompHitZone = 'head' | 'neck' | 'chest' | 'stomach' | 'arm' | 'leg' | 'none';

const PART_ZONES: readonly LagCompHitZone[] = [
  'head', 'neck', 'chest', 'stomach', 'chest',
  'arm', 'arm', 'arm', 'arm', 'arm', 'arm',
  'leg', 'leg', 'leg', 'leg', 'leg', 'leg',
];

export function hitZoneForPart(part: number): LagCompHitZone {
  return part >= 0 && part < PART_ZONES.length ? PART_ZONES[part] : 'none';
}

export function hitPartName(part: number): string {
  return part >= 0 && part < HIT_PART_NAMES.length ? HIT_PART_NAMES[part] : 'unknown';
}

export function damageHintForPart(part: number): number {
  return part >= 0 && part < HIT_PART_DAMAGE_HINT.length ? HIT_PART_DAMAGE_HINT[part] : 1;
}

/* ------------------------------------------------------------------ */
/* Reject reasons                                                      */
/* ------------------------------------------------------------------ */

/**
 * Why a shot was refused. Strings, because these end up in telemetry and in the
 * debug overlay where a number would be useless.
 */
export type RejectReason =
  | 'ok'
  /** Lag compensation is switched off; the shot was resolved at present time. */
  | 'disabled'
  /** Ring has nothing usable for the requested time. */
  | 'no-history'
  /** Requested rewind is older than `maxRewindMs` (or older than the ring). */
  | 'stale'
  /** Requested rewind is in the future relative to the server clock. */
  | 'future'
  /** Shooter is firing faster than the weapon can. */
  | 'rate-limit'
  /** Claimed aim diverges too far from the shooter's replicated aim. */
  | 'aim-divergence'
  /** Claimed muzzle origin is too far from the shooter's replicated position. */
  | 'origin-divergence'
  /** Claimed shot range exceeds the cap. */
  | 'range'
  /** Sequence number replayed or went backwards. */
  | 'duplicate'
  /** NaN, zero-length direction, unknown shooter, etc. */
  | 'bad-input';

export const REJECT_REASONS: readonly RejectReason[] = [
  'ok', 'disabled', 'no-history', 'stale', 'future', 'rate-limit',
  'aim-divergence', 'origin-divergence', 'range', 'duplicate', 'bad-input',
];

export function rejectReasonIndex(reason: RejectReason): number {
  const i = REJECT_REASONS.indexOf(reason);
  return i < 0 ? 0 : i;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every knob for the feature. There is one process-wide default instance
 * (`lagcompConfig`) so a debug menu can flip things live, but every class also
 * accepts its own config object so a headless server, a unit test and the
 * browser host can each hold independent settings.
 */
export interface LagCompConfig {
  /** Master switch. Off ⇒ every shot resolves against present-time hitboxes. */
  enabled: boolean;
  /** Interpolate between the two bracketing ticks instead of snapping. */
  interpolate: boolean;

  /** How much history the ring keeps. Storage bound, not a policy bound. */
  historySeconds: number;
  /**
   * Policy bound: the furthest back a shot may ever reach, measured from the
   * server's *current* time — not from the command stamp. That is deliberate.
   * The quantity that matters to the victim is "how long ago was I really
   * there", and that includes the upstream travel time of the command as well
   * as the interpolation window. 250 ms covers a 300 ms-ping player running a
   * 100 ms interpolation buffer (upstream 150 + interp 100); past that,
   * rewinding starts taking cover away from people who broke line of sight a
   * quarter of a second ago on their own screens.
   *
   * This mirrors `DEFAULT_NET_CONFIG.maxLagCompMs` in src/net/types.ts BY VALUE
   * — that is the authority-wide contract and it wins. We do not import it,
   * because nothing in this directory imports anything (see index.ts), so if
   * you change one, change both. A host that has a `NetConfig` in hand should
   * pass it through: `configureLagComp({ maxRewindMs: net.maxLagCompMs })`.
   */
  maxRewindMs: number;
  /**
   * True  ⇒ a shot asking to rewind past `maxRewindMs` is rejected outright.
   * False ⇒ it is clamped to `maxRewindMs` and still resolved, the way Source's
   * sv_maxunlag behaves. Rejecting is the stricter default; a private lobby of
   * friends on bad connections may prefer clamping.
   */
  rejectStaleRewind: boolean;

  /**
   * Fraction of RTT attributed to the client→server (upstream) leg. 0.5 assumes
   * a symmetric link. Used ONLY for shots whose command carries no client
   * timestamp; a stamped command has no RTT term at all. See Rewind.ts.
   */
  rttFraction: number;
  /** Clamp on the RTT the server will believe, milliseconds. */
  maxRttMs: number;
  /** Clamp on the interpolation delay the client may claim, milliseconds. */
  maxInterpDelayMs: number;
  /**
   * How much older than the host's own RTT estimate a client's command stamp
   * may be before the host stops believing it, milliseconds.
   *
   * Back-dating the stamp is the one way a client can buy itself extra rewind
   * (docs/NETCODE.md §11). A stamp should be about one upstream leg old; this
   * is the slack on top of that, and it must cover host-side input buffering
   * (a few ticks), clock-sync error and RTT jitter, because the penalty for
   * being wrong lands on an honest player. Exceeding it does not reject the
   * shot — the stamp is simply ignored in favour of the host's own measurement,
   * so a liar gains nothing and a spike costs nobody a hit.
   */
  maxStampSkewMs: number;

  /** Max angle between the claimed shot ray and the replicated aim, degrees. */
  maxAimDivergenceDeg: number;
  /** Max distance between the claimed muzzle and the replicated position, m. */
  maxOriginDivergenceM: number;
  /** Hard cap on hitscan range, m. */
  maxShotRangeM: number;

  /** Shots a player may bank while not firing (jitter/burst tolerance). */
  rateLimitBurst: number;
  /** Accept a shot at this fraction of the nominal fire interval. */
  rateLimitTolerance: number;

  /** Slack added to the broadphase sphere test, m. */
  broadphasePadM: number;

  /**
   * When false the resolver prefers the server's own replicated origin/aim over
   * whatever the client claimed. True is only for local/offline testing.
   */
  trustClientRay: boolean;

  /** Record rewinds into the debug ring. */
  debug: boolean;
  /** How many rewinds the debug ring keeps. */
  debugCapacity: number;
}

export const DEFAULT_LAGCOMP_CONFIG: Readonly<LagCompConfig> = Object.freeze({
  enabled: true,
  interpolate: true,

  historySeconds: 1.0,
  maxRewindMs: 250,
  rejectStaleRewind: true,

  rttFraction: 0.5,
  maxRttMs: 400,
  maxInterpDelayMs: 200,
  maxStampSkewMs: 120,

  maxAimDivergenceDeg: 20,
  maxOriginDivergenceM: 1.5,
  maxShotRangeM: 500,

  rateLimitBurst: 3,
  rateLimitTolerance: 0.85,

  broadphasePadM: 0.15,

  trustClientRay: false,

  debug: false,
  debugCapacity: 32,
});

/** Process-wide config. Mutate through `configureLagComp`. */
export const lagcompConfig: LagCompConfig = { ...DEFAULT_LAGCOMP_CONFIG };

/** Partial update of the process-wide config. Returns it for chaining. */
export function configureLagComp(patch: Partial<LagCompConfig>): LagCompConfig {
  for (const k of Object.keys(patch) as (keyof LagCompConfig)[]) {
    const v = patch[k];
    if (v === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (lagcompConfig as any)[k] = v;
  }
  return lagcompConfig;
}

/** The master toggle, as a one-liner for debug menus and the console. */
export function setLagCompEnabled(on: boolean): void {
  lagcompConfig.enabled = on;
}

/** Restore shipped defaults. */
export function resetLagCompConfig(): LagCompConfig {
  return configureLagComp(DEFAULT_LAGCOMP_CONFIG);
}

/** Clamp helper shared by the validator and the rewind planner. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
