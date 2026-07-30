/**
 * Lag compensation — trust boundary.
 *
 * Two different levels of distrust live here, and they are not the same thing:
 *
 * - **A client is not trusted at all.** Everything a client says about when it
 *   fired, where it was aiming and how fast it can fire is an assertion, not a
 *   fact. `ShotValidator.check` is the gate every client-originated shot passes
 *   through on the host: bounded rewind age, bounded divergence from the aim the
 *   server already replicated for that player, bounded fire rate, no replayed
 *   sequence numbers.
 *
 * - **A peer host is semi-trusted.** It is somebody's browser, so it can lie
 *   about hits it awarded itself — but every other peer holds its own copy of
 *   the hitbox history, which means a host's damage claim is *checkable*.
 *   `auditHostClaim` re-derives, from the victim's own history, whether the
 *   claimed impact point was inside the victim at the claimed instant. It is the
 *   same code path a dedicated server would use to audit a replay, which is
 *   exactly the point: moving the host off a peer changes who calls this, not
 *   what it does.
 *
 * Rejections are counted per player and per reason so a future anti-cheat or
 * telemetry pass can look at the distribution rather than a single event; one
 * rejected shot is jitter, four hundred is a cheat client.
 */

import type { ShotRequest, RewindPlan } from './Rewind';
import type { LagCompConfig, RejectReason, Vec3 } from './types';
import {
  lagcompConfig, REJECT_REASONS, rejectReasonIndex, clamp,
} from './types';
import { HitboxHistory, FLOATS_PER_BOX } from './HitboxHistory';
import { angleBetween, dist3, pointObbDistance, finite3 } from './Geom';

/** Weapon slots the rate limiter tracks per player. */
export const RATE_WEAPON_SLOTS = 8;

const DEG2RAD = Math.PI / 180;

export interface AuditClaim {
  /** Player the host says was hit. */
  victimId: number;
  /** Impact point the host reported. */
  point: Vec3;
  /** Server time the host says it rewound to. */
  claimedRenderTimeSec: number;
  /** Auditor's current server time. */
  serverTimeSec: number;
  /**
   * Extra slack in metres. Peers do not hold byte-identical histories (they
   * receive quantised snapshots), so a strict containment test would produce
   * false positives. Default 0.35 m, roughly one snapshot of sprint movement.
   */
  toleranceM?: number;
}

export interface AuditResult {
  ok: boolean;
  reason: RejectReason;
  /** How far outside the nearest hitbox the claimed point fell, metres. */
  overshootM: number;
  /** Age of the claimed rewind, milliseconds. */
  ageMs: number;
}

export class ShotValidator {
  readonly maxPlayers: number;
  readonly config: LagCompConfig;

  /** Token bucket per (player slot, weapon slot). */
  private readonly tokens: Float32Array;
  private readonly lastFireSec: Float64Array;
  /** Highest command sequence seen per player, for replay rejection. */
  private readonly lastSeq: Float64Array;
  /** Rejection counters, [slot][reason]. */
  private readonly counters: Uint32Array;
  /** Rejection counters not attributable to a slot. */
  private readonly orphanCounters: Uint32Array;

  constructor(maxPlayers: number, config: LagCompConfig = lagcompConfig) {
    this.maxPlayers = Math.max(1, maxPlayers);
    this.config = config;
    const n = this.maxPlayers * RATE_WEAPON_SLOTS;
    this.tokens = new Float32Array(n);
    // A huge negative last-fire time makes the first shot refill to full burst
    // without a special case in the hot path.
    this.lastFireSec = new Float64Array(n).fill(-1e18);
    this.lastSeq = new Float64Array(this.maxPlayers).fill(-1);
    this.counters = new Uint32Array(this.maxPlayers * REJECT_REASONS.length);
    this.orphanCounters = new Uint32Array(REJECT_REASONS.length);
  }

  /* ------------------------------------------------------------------ */
  /* Gate                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Decide whether this shot may be resolved at all. Pure: consumes no rate
   * budget and records no sequence — call `commit` once the caller has decided
   * to go ahead. Returns 'ok' or the first failing reason.
   *
   * Order is cheapest-and-most-structural first, so that a malformed packet is
   * never charged against a player's fire rate.
   */
  check(req: ShotRequest, plan: RewindPlan, shooterSlot: number): RejectReason {
    const cfg = this.config;

    /* --- replayed or reordered command --- */
    if (req.sequence !== undefined && shooterSlot >= 0) {
      if (!Number.isFinite(req.sequence)) return 'bad-input';
      if (req.sequence <= this.lastSeq[shooterSlot]) return 'duplicate';
    }

    /* --- absurd claimed range: a 5 km hitscan is not a jitter artefact --- */
    if (req.maxDistanceM > cfg.maxShotRangeM * 4) return 'range';

    /* --- timing --- */
    if (plan.reason === 'future') return 'future';
    if (plan.compensated && cfg.rejectStaleRewind && plan.rawAgeMs > cfg.maxRewindMs) return 'stale';

    /* --- the claimed ray versus what the server already replicated --- */
    const so = req.serverOrigin;
    if (so && finite3(so.x, so.y, so.z)) {
      const dm = dist3(req.origin.x, req.origin.y, req.origin.z, so.x, so.y, so.z);
      if (dm > cfg.maxOriginDivergenceM) return 'origin-divergence';
    }
    const sa = req.serverAim;
    if (sa && finite3(sa.x, sa.y, sa.z)) {
      const ang = angleBetween(
        req.direction.x, req.direction.y, req.direction.z,
        sa.x, sa.y, sa.z,
      );
      if (ang > cfg.maxAimDivergenceDeg * DEG2RAD) return 'aim-divergence';
    }

    /* --- fire rate, last, so a rejected shot never burns a token --- */
    if (!this.peekRate(req, shooterSlot)) return 'rate-limit';

    return 'ok';
  }

  /** Consume the rate token and record the sequence. Call after `check` passes. */
  commit(req: ShotRequest, shooterSlot: number): void {
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers) return;
    if (req.sequence !== undefined && Number.isFinite(req.sequence)) {
      this.lastSeq[shooterSlot] = req.sequence;
    }
    const interval = req.fireIntervalSec ?? 0;
    if (interval <= 0) return;
    const w = this.weaponKey(shooterSlot, req.weaponSlot);
    const t = this.refill(w, req.serverTimeSec, interval);
    this.tokens[w] = t - 1;
    this.lastFireSec[w] = req.serverTimeSec;
  }

  /** Record a rejection against a player (or the orphan bucket for slot < 0). */
  note(shooterSlot: number, reason: RejectReason): void {
    const r = rejectReasonIndex(reason);
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers) {
      this.orphanCounters[r]++;
      return;
    }
    this.counters[shooterSlot * REJECT_REASONS.length + r]++;
  }

  rejections(shooterSlot: number, reason: RejectReason): number {
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers) return this.orphanCounters[rejectReasonIndex(reason)];
    return this.counters[shooterSlot * REJECT_REASONS.length + rejectReasonIndex(reason)];
  }

  totalRejections(reason: RejectReason): number {
    const r = rejectReasonIndex(reason);
    let sum = this.orphanCounters[r];
    for (let s = 0; s < this.maxPlayers; s++) sum += this.counters[s * REJECT_REASONS.length + r];
    return sum;
  }

  /** Wipe a player's rate budget, sequence and counters — call on respawn/join. */
  resetPlayer(shooterSlot: number): void {
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers) return;
    for (let w = 0; w < RATE_WEAPON_SLOTS; w++) {
      const k = shooterSlot * RATE_WEAPON_SLOTS + w;
      this.tokens[k] = 0;
      this.lastFireSec[k] = -1e18;
    }
    this.lastSeq[shooterSlot] = -1;
    const base = shooterSlot * REJECT_REASONS.length;
    for (let i = 0; i < REJECT_REASONS.length; i++) this.counters[base + i] = 0;
  }

  reset(): void {
    this.tokens.fill(0);
    this.lastFireSec.fill(-1e18);
    this.lastSeq.fill(-1);
    this.counters.fill(0);
    this.orphanCounters.fill(0);
  }

  /* ------------------------------------------------------------------ */
  /* Auditing a semi-trusted host                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Check a hit the host claims against our own copy of the victim's history.
   *
   * Run this on a non-host peer (or on a dedicated server replaying a match
   * recording). It answers two questions: was the rewind age legal, and does the
   * claimed impact point actually lie on the victim at that instant. It cannot
   * prove intent — it flags claims that are geometrically impossible, which is
   * the useful half.
   */
  auditHostClaim(claim: AuditClaim, history: HitboxHistory, scratch?: Float32Array): AuditResult {
    const cfg = this.config;
    const tol = claim.toleranceM ?? 0.35;
    const ageMs = (claim.serverTimeSec - claim.claimedRenderTimeSec) * 1000;

    if (!finite3(claim.point.x, claim.point.y, claim.point.z)
      || !Number.isFinite(claim.claimedRenderTimeSec)) {
      return { ok: false, reason: 'bad-input', overshootM: Infinity, ageMs };
    }
    if (ageMs < -FUTURE_SLACK_MS) return { ok: false, reason: 'future', overshootM: Infinity, ageMs };
    if (ageMs > cfg.maxRewindMs) return { ok: false, reason: 'stale', overshootM: Infinity, ageMs };

    const slot = history.slotOf(claim.victimId);
    if (slot < 0) return { ok: false, reason: 'bad-input', overshootM: Infinity, ageMs };

    const buf = scratch && scratch.length >= history.maxBoxes * FLOATS_PER_BOX
      ? scratch
      : new Float32Array(history.maxBoxes * FLOATS_PER_BOX);
    const n = history.sampleInto(slot, claim.claimedRenderTimeSec, buf, null, 0, 0, cfg.interpolate);
    if (n <= 0) return { ok: false, reason: 'no-history', overshootM: Infinity, ageMs };

    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const b = i * FLOATS_PER_BOX;
      const dm = pointObbDistance(
        claim.point.x, claim.point.y, claim.point.z,
        buf[b], buf[b + 1], buf[b + 2],
        buf[b + 3], buf[b + 4], buf[b + 5],
        buf[b + 6], buf[b + 7], buf[b + 8], buf[b + 9],
      );
      if (dm < best) best = dm;
      if (best <= 0) break;
    }
    return best <= tol
      ? { ok: true, reason: 'ok', overshootM: best, ageMs }
      : { ok: false, reason: 'aim-divergence', overshootM: best, ageMs };
  }

  /* ------------------------------------------------------------------ */
  /* Rate limiting                                                       */
  /* ------------------------------------------------------------------ */

  /** Tokens available right now, without consuming any. */
  availableShots(shooterSlot: number, weaponSlot: number, nowSec: number, fireIntervalSec: number): number {
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers || fireIntervalSec <= 0) return Infinity;
    return this.refill(this.weaponKey(shooterSlot, weaponSlot), nowSec, fireIntervalSec);
  }

  private peekRate(req: ShotRequest, shooterSlot: number): boolean {
    const interval = req.fireIntervalSec ?? 0;
    if (interval <= 0) return true;                    // caller opted out
    if (shooterSlot < 0 || shooterSlot >= this.maxPlayers) return true; // untracked shooter (AI/host)
    const w = this.weaponKey(shooterSlot, req.weaponSlot);
    return this.refill(w, req.serverTimeSec, interval) >= 1;
  }

  /**
   * Token bucket. Capacity `rateLimitBurst`, refilling one token per
   * `fireIntervalSec * rateLimitTolerance` seconds. The tolerance factor is
   * there because a client's fire timing is quantised to its own frame rate and
   * arrives jittered; without it, an honest 60 Hz client firing a 750 RPM weapon
   * would be rejected on roughly one shot in eight.
   */
  private refill(key: number, nowSec: number, fireIntervalSec: number): number {
    const cfg = this.config;
    const interval = Math.max(fireIntervalSec * clamp(cfg.rateLimitTolerance, 0.05, 1), 1e-4);
    const dt = nowSec - this.lastFireSec[key];
    let t = this.tokens[key] + (dt > 0 ? dt / interval : 0);
    const burst = Math.max(1, cfg.rateLimitBurst);
    if (!(t < burst)) t = burst;                       // also catches NaN/Infinity
    if (t < 0) t = 0;
    return t;
  }

  private weaponKey(shooterSlot: number, weaponSlot: number | undefined): number {
    const w = weaponSlot === undefined || !Number.isFinite(weaponSlot)
      ? 0
      : ((weaponSlot | 0) % RATE_WEAPON_SLOTS + RATE_WEAPON_SLOTS) % RATE_WEAPON_SLOTS;
    return shooterSlot * RATE_WEAPON_SLOTS + w;
  }
}

/** Clock-sync slack allowed when auditing a claimed render time, milliseconds. */
const FUTURE_SLACK_MS = 50;
