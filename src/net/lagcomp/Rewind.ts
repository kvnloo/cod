/**
 * Lag compensation — rewinding the world to what the shooter actually saw.
 *
 * ============================================================================
 * THE FORMULA
 * ============================================================================
 *
 * Symbols (all in server-clock terms):
 *
 *   S      server time at which the host is processing this shot
 *   C      server time at which the *client* authored the fire command
 *   L_up   client → server latency
 *   L_down server → client latency
 *   RTT    L_up + L_down, as measured by the host's own ping/pong
 *   D      the client's interpolation delay — how far behind the newest
 *          snapshot it renders other players, so their motion stays smooth
 *          across packet jitter
 *
 * A remote player's position on the shooter's screen at the moment of the shot
 * is *not* their position at S. Two independent delays sit between them:
 *
 *   1. The snapshot the client was drawing left the server L_down ago.
 *   2. The client deliberately draws D further into the past, because it
 *      interpolates between two received snapshots rather than extrapolating.
 *
 * So, when the fire command carries the client's estimate of server time C
 * (which it does here — the clock-sync layer hands every client a server-clock
 * estimate, and the command is stamped with it), the upstream leg is already
 * paid for by C itself, and:
 *
 *      shooterRenderTime = C - RTT * rttFraction - D
 *                        = C - RTT/2 - D              (symmetric link)
 *
 * This is the formula in the brief, and it is the one used below.
 * `rttFraction` exists because "half of RTT" is an *assumption* of a symmetric
 * link, not a measurement; asymmetric connections can be tuned without touching
 * code.
 *
 * When no command stamp is available (a transport that cannot stamp, or an
 * AI/host-local shot) the upstream leg has not been accounted for anywhere, and
 * the base becomes S:
 *
 *      shooterRenderTime = S - RTT - D
 *
 * which is the same expression with the missing upstream share RTT*(1-fraction)
 * added back. `computeRewindTime` handles both, so callers never have to pick a
 * formula — they just supply what they know.
 *
 * ============================================================================
 * WHY NOT MOVE THE PHYSICS COLLIDERS
 * ============================================================================
 * The textbook implementation teleports every player's collider back, runs the
 * raycast through the physics world, and teleports them forward. We ray-test the
 * stored transforms instead. Nothing in the live world is mutated, so there is
 * no restore step to get wrong, no broadphase rebuild per shot, no interaction
 * with concurrent queries — and, critically, no dependency on a physics backend,
 * which is what lets this exact file run in a headless Node host later. Static
 * world occlusion is still a normal present-time raycast, supplied by the caller
 * as `worldOcclusionDistanceM`, because static geometry does not move and
 * therefore never needs rewinding.
 */

import type { Vec3, LagCompHitZone, RejectReason, LagCompConfig } from './types';
import {
  lagcompConfig, clamp, damageHintForPart, hitZoneForPart, hitPartName,
} from './types';
import { HitboxHistory, FLOATS_PER_BOX } from './HitboxHistory';
import { rayObb, raySphere, dist3, finite3 } from './Geom';
import { ShotValidator } from './Validate';
import type { RewindDebugRing } from './Debug';

/** Tolerance for a command stamp that lands slightly ahead of the server clock. */
export const FUTURE_TOLERANCE_SEC = 0.05;

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

export interface RewindTiming {
  /** Server time the host is processing this shot at, seconds. */
  serverTimeSec: number;
  /**
   * The client's server-clock estimate stamped on the fire command. Supply it
   * whenever the transport has it — it removes the upstream latency guess.
   */
  commandServerTimeSec?: number;
  /** Host-measured round trip to the shooter, milliseconds. */
  rttMs: number;
  /** Interpolation delay the shooter renders with, milliseconds. */
  interpDelayMs: number;
}

/** The full working of the rewind, kept for debugging and telemetry. */
export interface RewindPlan {
  /** Lag compensation was applied (false ⇒ resolved at present time). */
  compensated: boolean;
  /** 'ok', or why the plan is suspicious ('stale' / 'future'). */
  reason: RejectReason;
  /** Server time the world will be reconstructed at, after clamping. */
  renderTimeSec: number;
  /** What the formula produced before any clamp. */
  rawRenderTimeSec: number;
  /** serverTime - renderTime, milliseconds, after clamping. */
  ageMs: number;
  /** serverTime - rawRenderTime, milliseconds. */
  rawAgeMs: number;
  /** Latency share subtracted, milliseconds (downstream + any upstream). */
  rttTermMs: number;
  /** Interpolation delay subtracted, milliseconds. */
  interpTermMs: number;
  /** True when maxRewindMs (or the future guard) moved the target time. */
  clamped: boolean;
  /** True when a client command stamp was used as the base instead of "now". */
  usedCommandStamp: boolean;
}

export function createRewindPlan(): RewindPlan {
  return {
    compensated: false, reason: 'ok',
    renderTimeSec: 0, rawRenderTimeSec: 0,
    ageMs: 0, rawAgeMs: 0, rttTermMs: 0, interpTermMs: 0,
    clamped: false, usedCommandStamp: false,
  };
}

/**
 * Work out the server time to reconstruct the world at. Pure, allocation-free
 * (writes into `out`), and unit-testable on its own — see tools/net-lagcomp.mjs.
 */
export function computeRewindTime(
  t: RewindTiming,
  cfg: LagCompConfig = lagcompConfig,
  out: RewindPlan = createRewindPlan(),
): RewindPlan {
  const S = t.serverTimeSec;
  out.reason = 'ok';
  out.clamped = false;
  out.compensated = cfg.enabled;

  const hasStamp = t.commandServerTimeSec !== undefined && Number.isFinite(t.commandServerTimeSec);
  out.usedCommandStamp = hasStamp;

  // Never believe a client's numbers unconditionally: clamp before use.
  const rtt = clamp(Number.isFinite(t.rttMs) ? t.rttMs : 0, 0, cfg.maxRttMs);
  const interp = clamp(Number.isFinite(t.interpDelayMs) ? t.interpDelayMs : 0, 0, cfg.maxInterpDelayMs);

  const downstreamMs = rtt * cfg.rttFraction;
  // Without a command stamp the upstream leg has not been paid for anywhere.
  const upstreamMs = hasStamp ? 0 : rtt * (1 - cfg.rttFraction);

  out.rttTermMs = downstreamMs + upstreamMs;
  out.interpTermMs = interp;

  if (!cfg.enabled) {
    // Feature off: everyone is shot where the server says they are, right now.
    out.compensated = false;
    out.renderTimeSec = S;
    out.rawRenderTimeSec = S;
    out.ageMs = 0;
    out.rawAgeMs = 0;
    return out;
  }

  const base = hasStamp ? (t.commandServerTimeSec as number) : S;
  const raw = base - (out.rttTermMs + out.interpTermMs) / 1000;
  out.rawRenderTimeSec = raw;
  out.rawAgeMs = (S - raw) * 1000;

  let target = raw;

  // Guard 1: a shot may not be resolved in the future. A client claiming a
  // command stamp ahead of the server clock is either badly synced or lying.
  if (target > S + FUTURE_TOLERANCE_SEC) {
    out.reason = 'future';
    target = S;
    out.clamped = true;
  } else if (target > S) {
    target = S;
    out.clamped = true;
  }

  // Guard 2: sv_maxunlag. Beyond this, rewinding starts stealing cover from
  // players who have already broken line of sight on their own screens.
  const maxAgeSec = cfg.maxRewindMs / 1000;
  if (S - target > maxAgeSec) {
    if (out.reason === 'ok') out.reason = 'stale';
    target = S - maxAgeSec;
    out.clamped = true;
  }

  out.renderTimeSec = target;
  out.ageMs = (S - target) * 1000;
  return out;
}

/* ------------------------------------------------------------------ */
/* Shot request / resolution                                           */
/* ------------------------------------------------------------------ */

export interface ShotRequest {
  /** Player id of the shooter (must have a history slot to be rate-limited). */
  shooterId: number;
  /** Inventory slot of the firing weapon, 0..7. Used by the rate limiter. */
  weaponSlot?: number;
  /** Nominal seconds between shots for that weapon. 0 disables rate limiting. */
  fireIntervalSec?: number;
  /** Monotonic per-player command sequence, for replay rejection. */
  sequence?: number;

  /** Server time the host is processing this shot at. */
  serverTimeSec: number;
  /** Client's stamped server-time estimate for the fire command, if any. */
  commandServerTimeSec?: number;
  rttMs: number;
  interpDelayMs: number;

  /** Claimed muzzle position. */
  origin: Vec3;
  /** Claimed aim direction; need not be normalised. */
  direction: Vec3;
  /** Claimed maximum range in metres (clamped to config). */
  maxDistanceM: number;

  /** Server's own replicated muzzle position for this shooter, if known. */
  serverOrigin?: Vec3 | null;
  /** Server's own replicated aim direction for this shooter, if known. */
  serverAim?: Vec3 | null;

  /** Restrict candidates (e.g. enemy team only). Null ⇒ everyone but shooter. */
  targetIds?: readonly number[] | null;

  /**
   * Distance along the ray to the nearest *static world* hit, from a normal
   * present-time raycast done by the caller. Infinity / undefined when clear.
   */
  worldOcclusionDistanceM?: number;
}

/** Reusable result object. Never allocated per shot in the steady state. */
export class ShotResolution {
  /** A player hitbox was hit and nothing static was in the way. */
  hit = false;
  /** The shot passed validation (a legal miss is valid:true, hit:false). */
  valid = false;
  reason: RejectReason = 'ok';

  /** True when the world was rewound; false when resolved at present time. */
  compensated = false;

  playerId = -1;
  slot = -1;
  boxIndex = -1;
  part = -1;
  partName = 'none';
  zone: LagCompHitZone = 'none';
  damageScale = 1;

  distanceM = 0;
  readonly point: Vec3 = { x: 0, y: 0, z: 0 };
  readonly normal: Vec3 = { x: 0, y: 0, z: 0 };

  /** Server time the world was reconstructed at. */
  renderTimeSec = 0;
  /** How far back the rewind reached, milliseconds. */
  rewindMs = 0;
  /**
   * How far the hit hitbox had moved between the rewound time and now, metres.
   * This is the number that answers "how much did lag compensation matter".
   */
  rewindDistanceM = 0;

  /** A player was hit but static geometry was closer along the ray. */
  blockedByWorld = false;
  /** Candidates that survived the broadphase and got a narrow-phase test. */
  targetsTested = 0;

  reset(): void {
    this.hit = false;
    this.valid = false;
    this.reason = 'ok';
    this.compensated = false;
    this.playerId = -1;
    this.slot = -1;
    this.boxIndex = -1;
    this.part = -1;
    this.partName = 'none';
    this.zone = 'none';
    this.damageScale = 1;
    this.distanceM = 0;
    this.point.x = 0; this.point.y = 0; this.point.z = 0;
    this.normal.x = 0; this.normal.y = 0; this.normal.z = 0;
    this.renderTimeSec = 0;
    this.rewindMs = 0;
    this.rewindDistanceM = 0;
    this.blockedByWorld = false;
    this.targetsTested = 0;
  }
}

export interface RewindServiceOptions {
  config?: LagCompConfig;
  validator?: ShotValidator;
  debug?: RewindDebugRing;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class RewindService {
  readonly history: HitboxHistory;
  readonly config: LagCompConfig;
  readonly validator: ShotValidator;
  /** Ring of recent rewinds for the debug scene. Null ⇒ never recorded. */
  debug: RewindDebugRing | null;

  /** The plan produced by the most recent `resolveShot`. */
  readonly lastPlan: RewindPlan = createRewindPlan();
  /**
   * Reusable result, returned when the caller does not supply one.
   *
   * CAREFUL: this is one object, overwritten by every `resolveShot`. Read what
   * you need before the next call, or pass your own `ShotResolution` in. Two
   * results from the same service are the same object, not two objects.
   */
  readonly result = new ShotResolution();

  /* scratch — sized once, never reallocated */
  private readonly boxBuf: Float32Array;
  private readonly partBuf: Uint8Array;
  private readonly presentBuf: Float32Array;
  private readonly sphereBuf = new Float32Array(4);
  private readonly normalBuf = new Float32Array(3);
  private readonly bestNormal = new Float32Array(3);
  private readonly bestBox = new Float32Array(FLOATS_PER_BOX);

  constructor(history: HitboxHistory, opts: RewindServiceOptions = {}) {
    this.history = history;
    this.config = opts.config ?? lagcompConfig;
    this.validator = opts.validator ?? new ShotValidator(history.maxPlayers, this.config);
    this.debug = opts.debug ?? null;
    this.boxBuf = new Float32Array(history.maxBoxes * FLOATS_PER_BOX);
    this.partBuf = new Uint8Array(history.maxBoxes);
    this.presentBuf = new Float32Array(history.maxBoxes * FLOATS_PER_BOX);
  }

  /** Attach (or replace) the debug ring. Pass null to stop recording. */
  setDebugRing(ring: RewindDebugRing | null): void { this.debug = ring; }

  /** Pass-through so a caller can draw or collide against a rewound pose. */
  sampleTarget(
    playerId: number, timeSec: number,
    outBoxes: Float32Array, outParts?: Uint8Array | null,
  ): number {
    const slot = this.history.slotOf(playerId);
    if (slot < 0) return -1;
    return this.history.sampleInto(slot, timeSec, outBoxes, outParts, 0, 0, this.config.interpolate);
  }

  /**
   * Resolve one hitscan shot against the rewound world.
   *
   * Returns `out` (or the service's reusable result). Check `valid` first — a
   * rejected shot must deal no damage and should be counted against the player.
   */
  resolveShot(req: ShotRequest, out: ShotResolution = this.result): ShotResolution {
    out.reset();
    const cfg = this.config;
    const h = this.history;
    const plan = this.lastPlan;

    /* ---- 1. structural sanity, before any maths ---- */
    const o = req.origin, d = req.direction;
    if (!o || !d || !finite3(o.x, o.y, o.z) || !finite3(d.x, d.y, d.z)
      || !Number.isFinite(req.serverTimeSec) || !Number.isFinite(req.maxDistanceM)
      || req.maxDistanceM <= 0) {
      out.reason = 'bad-input';
      this.validator.note(h.slotOf(req.shooterId), 'bad-input');
      return out;
    }
    const dl = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    if (dl < 1e-6) {
      out.reason = 'bad-input';
      this.validator.note(h.slotOf(req.shooterId), 'bad-input');
      return out;
    }

    /* ---- 2. rewind plan ---- */
    computeRewindTime(req, cfg, plan);
    out.compensated = plan.compensated;
    out.renderTimeSec = plan.renderTimeSec;
    out.rewindMs = plan.ageMs;

    /* ---- 3. trust checks ---- */
    const shooterSlot = h.slotOf(req.shooterId);
    const reason = this.validator.check(req, plan, shooterSlot);
    if (reason !== 'ok') {
      out.reason = reason;
      this.validator.note(shooterSlot, reason);
      return out;
    }
    this.validator.commit(req, shooterSlot);
    out.valid = true;

    /* ---- 4. pick the ray the server will actually trace ---- */
    let ox = o.x, oy = o.y, oz = o.z;
    let dx = d.x / dl, dy = d.y / dl, dz = d.z / dl;
    if (!cfg.trustClientRay) {
      const so = req.serverOrigin, sa = req.serverAim;
      if (so && finite3(so.x, so.y, so.z)) { ox = so.x; oy = so.y; oz = so.z; }
      if (sa && finite3(sa.x, sa.y, sa.z)) {
        const l = Math.sqrt(sa.x * sa.x + sa.y * sa.y + sa.z * sa.z);
        if (l > 1e-6) { dx = sa.x / l; dy = sa.y / l; dz = sa.z / l; }
      }
    }
    const maxDist = clamp(req.maxDistanceM, 0, cfg.maxShotRangeM);
    const worldT = req.worldOcclusionDistanceM === undefined ? Infinity : req.worldOcclusionDistanceM;

    /* ---- 5. trace against the reconstructed world ---- */
    const time = plan.renderTimeSec;
    const dbg = cfg.debug && this.debug ? this.debug : null;
    const rec = dbg ? dbg.begin(req.shooterId, req.serverTimeSec, time, plan.ageMs, ox, oy, oz, dx, dy, dz, maxDist) : null;

    let bestT = Infinity;
    let bestSlot = -1;
    let bestBoxIndex = -1;
    let bestPart = -1;

    const explicit = req.targetIds ?? null;
    const targetCount = explicit ? explicit.length : h.maxPlayers;

    for (let ti = 0; ti < targetCount; ti++) {
      const slot = explicit ? h.slotOf(explicit[ti]) : ti;
      if (slot < 0 || slot === shooterSlot) continue;
      const pid = h.playerIdAt(slot);
      if (pid < 0 || pid === req.shooterId) continue;

      if (!h.sampleSphereInto(slot, time, this.sphereBuf, 0)) continue;
      if (!raySphere(
        ox, oy, oz, dx, dy, dz,
        this.sphereBuf[0], this.sphereBuf[1], this.sphereBuf[2],
        this.sphereBuf[3] + cfg.broadphasePadM, maxDist,
      )) continue;

      const n = h.sampleInto(slot, time, this.boxBuf, this.partBuf, 0, 0, cfg.interpolate);
      if (n <= 0) continue;
      if (!h.lastSampleAlive) continue;
      out.targetsTested++;

      let displacement = 0;
      if (rec) {
        const pn = h.presentInto(slot, this.presentBuf, null, 0, 0);
        if (pn > 0) {
          displacement = dist3(
            this.boxBuf[0], this.boxBuf[1], this.boxBuf[2],
            this.presentBuf[0], this.presentBuf[1], this.presentBuf[2],
          );
          rec.addTarget(pid, n, this.boxBuf, this.presentBuf, this.partBuf, displacement);
        } else {
          rec.addTarget(pid, n, this.boxBuf, this.boxBuf, this.partBuf, 0);
        }
      }

      for (let i = 0; i < n; i++) {
        const b = i * FLOATS_PER_BOX;
        const t = rayObb(
          ox, oy, oz, dx, dy, dz,
          this.boxBuf[b], this.boxBuf[b + 1], this.boxBuf[b + 2],
          this.boxBuf[b + 3], this.boxBuf[b + 4], this.boxBuf[b + 5],
          this.boxBuf[b + 6], this.boxBuf[b + 7], this.boxBuf[b + 8], this.boxBuf[b + 9],
          maxDist, this.normalBuf, 0,
        );
        if (t < 0 || t >= bestT) continue;
        bestT = t;
        bestSlot = slot;
        bestBoxIndex = i;
        bestPart = this.partBuf[i];
        this.bestNormal[0] = this.normalBuf[0];
        this.bestNormal[1] = this.normalBuf[1];
        this.bestNormal[2] = this.normalBuf[2];
        for (let k = 0; k < FLOATS_PER_BOX; k++) this.bestBox[k] = this.boxBuf[b + k];
      }
    }

    /* ---- 6. static world wins ties against a rewound player ---- */
    if (bestSlot >= 0 && bestT > worldT) {
      out.blockedByWorld = true;
      bestSlot = -1;
    }

    if (bestSlot >= 0) {
      out.hit = true;
      out.slot = bestSlot;
      out.playerId = h.playerIdAt(bestSlot);
      out.boxIndex = bestBoxIndex;
      out.part = bestPart;
      out.partName = hitPartName(bestPart);
      out.zone = hitZoneForPart(bestPart);
      out.damageScale = damageHintForPart(bestPart);
      out.distanceM = bestT;
      out.point.x = ox + dx * bestT;
      out.point.y = oy + dy * bestT;
      out.point.z = oz + dz * bestT;
      out.normal.x = this.bestNormal[0];
      out.normal.y = this.bestNormal[1];
      out.normal.z = this.bestNormal[2];

      // How far the winning hitbox had travelled since the rewound instant.
      const pn = h.presentInto(bestSlot, this.presentBuf, null, 0, 0);
      if (pn > bestBoxIndex) {
        const pb = bestBoxIndex * FLOATS_PER_BOX;
        out.rewindDistanceM = dist3(
          this.bestBox[0], this.bestBox[1], this.bestBox[2],
          this.presentBuf[pb], this.presentBuf[pb + 1], this.presentBuf[pb + 2],
        );
      }
    }

    if (rec) {
      rec.finish(out.hit, out.playerId, out.part, out.distanceM, out.rewindDistanceM, out.reason, out.blockedByWorld);
    }
    return out;
  }
}
