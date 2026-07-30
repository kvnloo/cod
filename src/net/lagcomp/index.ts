/**
 * Lag compensation — public surface.
 *
 * "I shot them on my screen and it counted."
 *
 * ---------------------------------------------------------------------------
 * HOST-SIDE USAGE
 * ---------------------------------------------------------------------------
 *
 *   const history = new HitboxHistory({ maxPlayers: 16, tickRateHz: 64 });
 *   const rewind  = new RewindService(history, { debug: lagcompDebugRing });
 *
 *   // when a player joins / leaves
 *   const slot = history.acquireSlot(playerId);
 *   history.releaseSlot(playerId);
 *
 *   // once per server tick, after the simulation has stepped
 *   history.beginTick(tick, serverTimeSec);
 *   for (const p of players) {
 *     for (let i = 0; i < p.hitboxes.length; i++) { ...history.writeBox(...) }
 *     history.commitPlayer(p.slot, p.hitboxes.length, p.alive);
 *   }
 *
 *   // when a fire command arrives
 *   const r = rewind.resolveShot({ ... });
 *   if (r.valid && r.hit) applyDamage(r.playerId, r.zone, r.damageScale);
 *
 * ---------------------------------------------------------------------------
 * PORTABILITY
 * ---------------------------------------------------------------------------
 * Nothing in this directory imports three, the DOM, Rapier or another net
 * module. That is the authority boundary made concrete: when the host moves off
 * a peer and into a headless Node process, these files move with it unchanged.
 */

export {
  HitPart,
  HIT_PART_COUNT,
  HIT_PART_NAMES,
  HIT_PART_DAMAGE_HINT,
  REJECT_REASONS,
  DEFAULT_LAGCOMP_CONFIG,
  lagcompConfig,
  configureLagComp,
  setLagCompEnabled,
  resetLagCompConfig,
  hitZoneForPart,
  hitPartName,
  damageHintForPart,
  rejectReasonIndex,
  clamp,
} from './types';
export type {
  Vec3,
  Quat,
  HitPartId,
  LagCompHitZone,
  RejectReason,
  LagCompConfig,
} from './types';

export {
  HitboxHistory,
  FLOATS_PER_BOX,
} from './HitboxHistory';
export type {
  HitboxSample,
  HitboxHistoryOptions,
} from './HitboxHistory';

export {
  RewindService,
  ShotResolution,
  computeRewindTime,
  createRewindPlan,
  FUTURE_TOLERANCE_SEC,
} from './Rewind';
export type {
  ShotRequest,
  RewindPlan,
  RewindTiming,
  RewindServiceOptions,
} from './Rewind';

export {
  ShotValidator,
  RATE_WEAPON_SLOTS,
} from './Validate';
export type {
  AuditClaim,
  AuditResult,
} from './Validate';

export {
  RewindDebugRing,
  RewindDebugRecord,
  RewindDebugTarget,
  lagcompDebugRing,
  describeRewind,
  obbCorners,
  OBB_EDGE_INDICES,
} from './Debug';
export type { RewindDebugRingOptions } from './Debug';

export {
  rayObb,
  raySphere,
  pointObbDistance,
  rotateVec,
  rotateVecInv,
  nlerpQuat,
  angleBetween,
  dist3,
  lerp,
} from './Geom';
