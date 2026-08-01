/**
 * The combat model: hit zones, the damage-vs-range table, time-to-kill, and the
 * player's health economy.
 *
 * Everything about "how much does this round take off" lives here, in one
 * deterministic place, so a TTK number is something the game *authors* rather
 * than something that falls out of whichever system happened to resolve the
 * shot. There is no RNG anywhere below this line: the same weapon, at the same
 * range, into the same zone, always removes the same health.
 *
 * ## Why this file grew
 *
 * It used to be the `CombatBridge` interface and nothing else. Three findings
 * forced the model into it:
 *
 *  1. A living enemy owned exactly one collider — `CharacterController.ts:166`
 *     registers the kinematic capsule as zone `chest`, so headshots and limb
 *     damage did not exist at the physics layer.
 *  2. The enemy the player actually fights resolved every incoming round as a
 *     flat 42 body / 145 head, so `src/weapons/`'s authored damage falloff was
 *     dead code: an LMG at 50 m hit exactly as hard as a pistol at 10 m, every
 *     weapon killed in exactly three shots, and TTK was 178 ms.
 *  3. Enemy lethality was a coin flip (`rng.bool(chance)`) with no authored
 *     damage-per-second behind it, which is why a player could stand in the
 *     open and not die.
 *
 * So the model is split in two halves that never depend on each other:
 *
 *  - **The tables** (`HITBOX_RIG`, `ZONE_MULTIPLIERS`, `TTK_TARGETS`,
 *    `PLAYER_VITALS`) are pure data plus pure functions. They import nothing
 *    from the engine, allocate nothing per call, and are directly unit-testable.
 *  - **`CombatModel`** is the runtime service that installs the tables into the
 *    live game. It attaches to whatever actor backend is present through its
 *    public damage funnel and rewrites the *number*, leaving the backend to own
 *    the ray, the occlusion test, the tracer, the ragdoll and the killfeed.
 *
 * ## Where the damage curve comes from
 *
 * Base damage and rounds-per-minute are read from `src/weapons/Catalog.ts`,
 * which is pure data with a single type-only import. Duplicating those stops
 * here would guarantee they drift, and the HUD's `damageAtRange()` readout
 * would then be a lie. Zone multipliers, armour and target health are authored
 * *here*, because those are game-layer balance, not weapon identity.
 *
 * ## How it gets into the shipping game
 *
 * `attach()` takes over two hooks from the outside, both public, both
 * idempotent, neither fatal if it is missing:
 *
 *  - **`Ballistics.damageResolver`** — the single point where `src/weapons/`
 *    hands a round's damage to the game layer. This is the primary seam and
 *    the correct one: pricing here keeps the applied amount, the `damage:dealt`
 *    payload and the AI's echo-claim token all equal to the same number. See
 *    `wrapBallisticResolver` for why anything later is not merely untidy but
 *    measurably wrong.
 *  - **The actor backend's `hurt()`** — so the zone the model resolved reaches
 *    the hitmarker, the killfeed, the ragdoll impulse and the reaction
 *    animation, and so a backend without a ballistic resolver (the fallback
 *    sim) is still priced.
 *
 * Both are bridges, not the destination. The destination is `GameDirector`
 * calling `combat.resolveRound()` in its resolver and `CharacterController`
 * reporting a real per-bone `RayHit.zone` that arrives as `DamageOpts.zone` —
 * at which point the model uses the collider's answer verbatim and the
 * geometric rig becomes the fallback rather than the mechanism. Both of those
 * doors are already open; nothing here has to change when they land.
 */

import type * as THREE from 'three';
import { bus } from '../core/EventBus';
import { input } from '../core/Input';
import { damageAt, hasWeapon, weaponDef } from '../weapons/Catalog';
import type { WeaponClass } from '../weapons/types';
import type {
  Archetype, ArchetypeProfile, CombatantInfo, DamageOpts, HitZone, ZoneTable,
} from './types';
import { HIT_ZONES } from './types';

/* ------------------------------------------------------------------ bridge */

/**
 * The combat facade killstreaks and objectives talk to.
 *
 * Anything that wants to hurt an enemy or ask where one is goes through here,
 * which keeps damage attribution in one place: the match sets the credited
 * source before the damage lands so the kill feed, scoring and XP all agree on
 * who did it.
 */
export interface CombatBridge {
  /** Applies damage from a named source. Returns true when it was lethal. */
  damage(
    id: number, amount: number, source: string,
    point?: THREE.Vector3, direction?: THREE.Vector3,
  ): boolean;
  /** Radial damage to everything hostile in range, with square falloff. */
  explode(center: THREE.Vector3, radius: number, power: number, source: string): void;
  /** Nearest live hostile within `maxDist`; writes its position into `out`. */
  nearestEnemy(from: THREE.Vector3, maxDist: number, out?: THREE.Vector3): number;
  enemyPosition(id: number, out: THREE.Vector3): boolean;
  /** Live hostile positions written into `out` (grown as needed); returns count. */
  enemyPositions(out: THREE.Vector3[]): number;
  countWithin(center: THREE.Vector3, radius: number): number;
  /** Ground height under a point, used to place props; falls back to `fallback`. */
  groundAt(x: number, z: number, fallback: number): number;
}

/* ==========================================================================
 * 1. HITBOXES
 * ======================================================================= */

/**
 * A humanoid hitbox rig, authored as fractions of the body's height `H` and
 * capsule radius `R` so one table fits every archetype from a 1.76 m assaulter
 * to a 1.95 m juggernaut.
 *
 * Vertical bands follow standard segment proportions (Drillis & Contini):
 * chin at 0.870 H, acromion 0.818 H, hip 0.530 H, knee 0.285 H. They are
 * widened the way every shipping shooter widens them — the `chest` box runs
 * down to 0.585 H rather than stopping at the diaphragm, and the `leg` box
 * starts at the crotch rather than the hip joint — because a hitbox that
 * matches anatomy exactly reads as "my bullets go through people".
 *
 * Lateral extents are in units of the capsule radius. The capsule is fatter
 * than the body it wraps (0.34 m for a 1.78 m soldier), which is deliberate:
 * `arm` occupies the band between the torso edge and the capsule wall, so the
 * rounds that used to be silently counted as chest hits now correctly do limb
 * damage.
 */
export interface ZoneBox {
  zone: HitZone;
  /** Vertical band as a fraction of body height, feet at 0. */
  y0: number;
  y1: number;
  /** Lateral half-extent band in units of capsule radius; `x0` > 0 for arms. */
  x0: number;
  x1: number;
  /**
   * Fore/aft half-extent in units of capsule radius.
   *
   * Deliberately generous — wider than the body capsule itself. The impact
   * point a ray/capsule test hands back sits on the *silhouette*, roughly one
   * capsule radius in front of the body axis, so its fore/aft coordinate
   * carries no anatomical information whatsoever: a round entering the sternum
   * from the front and one entering it from 30° off both arrive at z ≈ -R.
   * Making the boxes shallow would push every hit outside every box and leave
   * classification to the nearest-box fallback. Zones are decided by height
   * band and lateral offset, which is where the information actually is.
   */
  z: number;
  /** Mirrored to both sides (arms). */
  mirror: boolean;
}

const DEPTH = 1.25;

export const HITBOX_RIG: readonly ZoneBox[] = [
  { zone: 'head', y0: 0.870, y1: 1.010, x0: 0, x1: 0.44, z: DEPTH, mirror: false },
  { zone: 'neck', y0: 0.820, y1: 0.870, x0: 0, x1: 0.28, z: DEPTH, mirror: false },
  { zone: 'chest', y0: 0.585, y1: 0.820, x0: 0, x1: 0.62, z: DEPTH, mirror: false },
  { zone: 'stomach', y0: 0.430, y1: 0.585, x0: 0, x1: 0.58, z: DEPTH, mirror: false },
  { zone: 'arm', y0: 0.460, y1: 0.820, x0: 0.62, x1: 1.15, z: DEPTH, mirror: true },
  { zone: 'leg', y0: 0.000, y1: 0.430, x0: 0, x1: 0.62, z: DEPTH, mirror: false },
];

/** Body metrics the rig needs. Structurally satisfied by an actor record. */
export interface BodyFrame {
  position: { x: number; y: number; z: number };
  yaw: number;
  height: number;
  radius: number;
}

/** Scratch so zone resolution never allocates on a hot path. */
const _local = { x: 0, y: 0, z: 0 };

/** World point → the body's local, yaw-aligned frame with feet at the origin. */
function toLocal(body: BodyFrame, px: number, py: number, pz: number): typeof _local {
  const dx = px - body.position.x;
  const dz = pz - body.position.z;
  const s = Math.sin(-body.yaw);
  const c = Math.cos(-body.yaw);
  _local.x = dx * c - dz * s;
  _local.z = dx * s + dz * c;
  _local.y = py - body.position.y;
  return _local;
}

/** Squared distance from a local point to a zone box, 0 when inside. */
function boxDistSq(b: ZoneBox, H: number, R: number, x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const dx = ax < b.x0 * R ? b.x0 * R - ax : ax > b.x1 * R ? ax - b.x1 * R : 0;
  const dy = y < b.y0 * H ? b.y0 * H - y : y > b.y1 * H ? y - b.y1 * H : 0;
  const az = Math.abs(z);
  const dz = az > b.z * R ? az - b.z * R : 0;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Classifies a world-space impact point into a hit zone.
 *
 * Containment first, nearest-box second. The fallback matters: the backend's
 * body test is a single fat capsule (`radius × 1.15`), so a graze along the
 * silhouette lands *outside* every anatomical box. Snapping it to the nearest
 * one is what stops those rounds silently becoming chest hits.
 */
export function zoneAtPoint(body: BodyFrame, px: number, py: number, pz: number): HitZone {
  const H = Math.max(0.1, body.height);
  const R = Math.max(0.05, body.radius);
  const p = toLocal(body, px, py, pz);
  let best: HitZone = 'chest';
  let bestD = Infinity;
  for (let i = 0; i < HITBOX_RIG.length; i++) {
    const b = HITBOX_RIG[i];
    const d = boxDistSq(b, H, R, p.x, p.y, p.z);
    if (d === 0) return b.zone;
    if (d < bestD) { bestD = d; best = b.zone; }
  }
  return best;
}

/**
 * Ray → hitbox rig. Returns the nearest zone the ray enters and the ray
 * parameter it enters at, or `null`. Slab test per box in the body's local
 * frame; used by verification probes and by any caller that wants the zone
 * without a physics collider in the way.
 */
export function raycastZones(
  body: BodyFrame,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDistance = Infinity,
): { zone: HitZone; distance: number } | null {
  const H = Math.max(0.1, body.height);
  const R = Math.max(0.05, body.radius);
  const o = toLocal(body, ox, oy, oz);
  const olx = o.x, oly = o.y, olz = o.z;
  // Direction rotates but does not translate.
  const s = Math.sin(-body.yaw);
  const c = Math.cos(-body.yaw);
  const dlx = dx * c - dz * s;
  const dly = dy;
  const dlz = dx * s + dz * c;

  let bestT = maxDistance;
  let bestZone: HitZone | null = null;
  for (let i = 0; i < HITBOX_RIG.length; i++) {
    const b = HITBOX_RIG[i];
    const signs = b.mirror ? MIRROR_SIGNS : ONE_SIGN;
    for (let k = 0; k < signs.length; k++) {
      const sx = signs[k];
      const t = slab(
        olx, oly, olz, dlx, dly, dlz,
        sx > 0 ? b.x0 * R : -b.x1 * R, sx > 0 ? b.x1 * R : -b.x0 * R,
        b.y0 * H, b.y1 * H, -b.z * R, b.z * R,
      );
      if (t !== null && t >= 0 && t < bestT) { bestT = t; bestZone = b.zone; }
    }
  }
  return bestZone === null ? null : { zone: bestZone, distance: bestT };
}

const MIRROR_SIGNS = [1, -1];
const ONE_SIGN = [1];

/** Slab intersection; returns entry `t` or null. */
function slab(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = a === 0 ? x0 : a === 1 ? y0 : z0;
    const hi = a === 0 ? x1 : a === 1 ? y1 : z1;
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? 0 : null;
}

/* ==========================================================================
 * 2. THE DAMAGE TABLE
 * ======================================================================= */

/**
 * Zone multipliers per weapon class.
 *
 * Target health is roughly double a Call of Duty body (see `TTK_DESIGN`), so
 * head multipliers are pushed above the catalogue's 1.45-1.6 to keep the
 * *skill payoff* of a headshot constant in shots rather than in percent: a
 * 1.85× head on a 200 HP body removes the same proportion of the fight that a
 * 1.5× head removes from a 100 HP CoD body.
 *
 * Reference points: CoD MW2019 assault rifles run a 1.5× head, SMGs 1.4×;
 * Apex Legends runs 1.75-2.0× on ARs and 2.0× on marksman rifles. Ours sit
 * between the two, which is exactly where the brief puts this game.
 *
 * The sniper column is the one deliberate outlier. CoD snipers one-shot the
 * upper chest and that identity must survive a doubled TTK, so `chest` is
 * 2.10×: 96 base × 2.10 = 201.6 against a 200 HP rifleman. Stomach and below
 * stay two- and three-shot.
 */
export const ZONE_MULTIPLIERS: Record<WeaponClass, ZoneTable> = {
  assault: { head: 1.85, neck: 1.65, chest: 1.00, stomach: 0.95, arm: 0.80, leg: 0.72, none: 1 },
  smg: { head: 1.60, neck: 1.45, chest: 1.00, stomach: 0.95, arm: 0.85, leg: 0.78, none: 1 },
  lmg: { head: 1.70, neck: 1.55, chest: 1.00, stomach: 0.95, arm: 0.82, leg: 0.75, none: 1 },
  marksman: { head: 2.10, neck: 1.85, chest: 1.15, stomach: 1.00, arm: 0.85, leg: 0.78, none: 1 },
  sniper: { head: 3.00, neck: 2.60, chest: 2.10, stomach: 1.45, arm: 0.95, leg: 0.85, none: 1 },
  shotgun: { head: 1.35, neck: 1.25, chest: 1.00, stomach: 1.00, arm: 0.92, leg: 0.86, none: 1 },
  pistol: { head: 1.75, neck: 1.55, chest: 1.00, stomach: 0.95, arm: 0.82, leg: 0.75, none: 1 },
  launcher: { head: 1, neck: 1, chest: 1, stomach: 1, arm: 1, leg: 1, none: 1 },
};

/**
 * Fraction of a shotgun's pattern that lands on a torso at a given range.
 *
 * `weapon:fire` is emitted once per trigger pull, not once per pellet, so the
 * pattern has to be folded into the single round the actor backend resolves.
 * Interpolated the same way the damage stops are.
 */
const PELLET_FRACTION: ReadonlyArray<[number, number]> = [
  [0, 1.00], [7, 0.85], [12, 0.50], [18, 0.22], [26, 0.08],
];

function lerpStops(stops: ReadonlyArray<[number, number]>, d: number): number {
  if (d <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [ad, av] = stops[i - 1];
    const [bd, bv] = stops[i];
    if (d <= bd) return av + (bv - av) * ((d - ad) / Math.max(1e-4, bd - ad));
  }
  return stops[stops.length - 1][1];
}

/** Fallback used when a round arrives from a weapon the catalogue has no entry for. */
const FALLBACK_WEAPON = 'ar_vkr7';

/** Base (chest, unarmoured) damage for one round of `weaponId` at `metres`. */
export function baseDamageAt(weaponId: string, metres: number): number {
  const id = hasWeapon(weaponId) ? weaponId : FALLBACK_WEAPON;
  const def = weaponDef(id);
  let dmg = damageAt(def, Math.max(0, metres));
  const pellets = Math.max(1, def.ballistics.pellets);
  if (pellets > 1) dmg *= pellets * lerpStops(PELLET_FRACTION, Math.max(0, metres));
  return dmg;
}

export function weaponClassOf(weaponId: string): WeaponClass {
  return hasWeapon(weaponId) ? weaponDef(weaponId).cls : weaponDef(FALLBACK_WEAPON).cls;
}

export function rpmOf(weaponId: string): number {
  return hasWeapon(weaponId) ? weaponDef(weaponId).rpm : weaponDef(FALLBACK_WEAPON).rpm;
}

export interface HitResolution {
  /** Damage to apply, after zone and armour. */
  damage: number;
  zone: HitZone;
  headshot: boolean;
  /** Base chest damage before zone/armour — what the HUD's readout reports. */
  base: number;
  zoneMultiplier: number;
  armorMultiplier: number;
  distance: number;
}

const _resolution: HitResolution = {
  damage: 0, zone: 'chest', headshot: false, base: 0,
  zoneMultiplier: 1, armorMultiplier: 1, distance: 0,
};

/**
 * The whole damage model in one function.
 *
 * `armor` is per-zone rather than a scalar on the body, which is the difference
 * between "a juggernaut is a bullet sponge" and "a juggernaut is a problem you
 * solve by shooting it in the head".
 *
 * Deterministic by construction: no RNG, no time dependence, no state. Two
 * calls with the same arguments return the same number forever, which is what
 * makes the TTK table a gate rather than an observation.
 */
export function resolveHit(
  weaponId: string, metres: number, zone: HitZone, armor: ZoneTable | null,
  out: HitResolution = _resolution,
): HitResolution {
  const cls = weaponClassOf(weaponId);
  const z: HitZone = zone === 'none' ? 'chest' : zone;
  const base = baseDamageAt(weaponId, metres);
  const zm = ZONE_MULTIPLIERS[cls][z];
  const am = armor ? armor[z] : 1;
  out.base = base;
  out.zone = z;
  out.zoneMultiplier = zm;
  out.armorMultiplier = am;
  out.distance = metres;
  out.damage = base * zm * am;
  out.headshot = z === 'head' || z === 'neck';
  return out;
}

/* ==========================================================================
 * 3. TIME TO KILL
 * ======================================================================= */

/**
 * The design statement, and the numbers it is calibrated against.
 *
 * The brief: *"we can also increase ttk since movement is more important now."*
 * Apex movement means a fight is won by position and momentum; a CoD-length
 * TTK deletes that skill expression because the first person to see the other
 * one wins before either can move.
 *
 * References, all against a full-health target:
 *
 * | Game                        | Weapon              | Core TTK   |
 * |-----------------------------|---------------------|------------|
 * | CoD MW2019                  | M4A1, 800 rpm, 4 STK| ~225 ms    |
 * | CoD MW2019                  | AR class            | 250-400 ms |
 * | Apex Legends (200 HP)       | R-301               | ~800-1000 ms|
 * | Apex Legends (200 HP)       | R-99                | ~600-800 ms |
 *
 * This game sits at **roughly 2× CoD**, landing inside the 400-900 ms band the
 * playtest harness advises: long enough that a good mover can break line of
 * sight after being tagged, short enough that gunfights still resolve in one
 * engagement rather than devolving into Apex's third-party economy.
 *
 * The doubling is carried entirely by **target health**, not by nerfing the
 * weapons. That matters for three reasons: the catalogue's authored damage
 * curves stay meaningful, the HUD's `damageAtRange()` readout stays true, and
 * every weapon keeps its own range identity instead of being flattened.
 */
export const TTK_DESIGN = {
  /** The body every published TTK figure is quoted against. */
  referenceArchetype: 'rifleman' as Archetype,
  referenceHealth: 200,
  /** CoD-equivalent health this is a multiple of. */
  codEquivalentHealth: 100,
  ttkMultiplierVsCod: 2.0,
  /** Advisory band from `docs/PLAYTEST.md`, for automatic weapons at 10 m. */
  autoBandMs: [400, 900] as const,
};

/**
 * Authored shots-to-kill, per weapon, at the three gate ranges.
 *
 * Authored as **STK, not milliseconds**, because STK is what a damage model
 * actually decides and because milliseconds are a function of rate of fire —
 * which lives in the weapon catalogue and is being retuned by another package
 * this wave. `ttkTargetMs()` derives the millisecond target from live rpm, so a
 * fire-rate fix moves the target and the measurement together instead of
 * breaking the gate.
 *
 * `null` means "not expected to kill at this range" — the shotgun past its
 * pattern, by design.
 */
export const TTK_TARGETS: Record<string, Record<number, number | null>> = {
  //            10 m  25 m  50 m
  ar_vkr7: { 10: 7, 25: 7, 50: 9 },
  smg_hornet: { 10: 8, 25: 10, 50: 14 },
  lmg_vulcan: { 10: 7, 25: 7, 50: 7 },
  dmr_kestrel: { 10: 4, 25: 4, 50: 4 },
  sr_longbow: { 10: 1, 25: 1, 50: 1 },
  sg_breaker: { 10: 4, 25: null, 50: null },
  pi_sidewinder: { 10: 8, 25: 9, 50: 13 },
};

/** Shots to kill `health` with `weaponId` at `metres` into `zone`. */
export function shotsToKill(
  weaponId: string, metres: number, health = TTK_DESIGN.referenceHealth,
  zone: HitZone = 'chest', armor: ZoneTable | null = null,
): number {
  const r = resolveHit(weaponId, metres, zone, armor, {
    damage: 0, zone: 'chest', headshot: false, base: 0,
    zoneMultiplier: 1, armorMultiplier: 1, distance: 0,
  });
  if (r.damage <= 0.01) return Infinity;
  return Math.max(1, Math.ceil(health / r.damage));
}

/**
 * Time to kill in milliseconds: the interval between the first round leaving
 * the barrel and the lethal one landing, which is `(STK - 1)` refire intervals.
 * A one-shot kill is 0 ms by that definition and that is the honest number.
 */
export function ttkMs(
  weaponId: string, metres: number, health = TTK_DESIGN.referenceHealth,
  zone: HitZone = 'chest', armor: ZoneTable | null = null,
): number {
  const stk = shotsToKill(weaponId, metres, health, zone, armor);
  if (!Number.isFinite(stk)) return Infinity;
  return (stk - 1) * (60000 / Math.max(1, rpmOf(weaponId)));
}

/** The authored target in ms, derived from authored STK and live rate of fire. */
export function ttkTargetMs(weaponId: string, metres: number): number | null {
  const stk = TTK_TARGETS[weaponId]?.[metres];
  if (stk === null || stk === undefined) return null;
  return (stk - 1) * (60000 / Math.max(1, rpmOf(weaponId)));
}

/** Every authored row, with the model's own prediction beside it. */
export function ttkTable(): Array<{
  weapon: string; cls: WeaponClass; rangeM: number; rpm: number;
  targetStk: number | null; modelStk: number | null;
  targetMs: number | null; modelMs: number | null;
  chestDamage: number; headDamage: number; legDamage: number;
  headTtkMs: number | null; legTtkMs: number | null;
}> {
  const rows = [];
  for (const weapon of Object.keys(TTK_TARGETS)) {
    for (const rangeM of [10, 25, 50]) {
      const target = TTK_TARGETS[weapon][rangeM] ?? null;
      const stk = shotsToKill(weapon, rangeM);
      const head = ttkMs(weapon, rangeM, TTK_DESIGN.referenceHealth, 'head');
      const leg = ttkMs(weapon, rangeM, TTK_DESIGN.referenceHealth, 'leg');
      rows.push({
        weapon, cls: weaponClassOf(weapon), rangeM, rpm: rpmOf(weapon),
        targetStk: target,
        modelStk: Number.isFinite(stk) ? stk : null,
        targetMs: ttkTargetMs(weapon, rangeM),
        modelMs: Number.isFinite(ttkMs(weapon, rangeM)) ? ttkMs(weapon, rangeM) : null,
        chestDamage: +resolveHit(weapon, rangeM, 'chest', null).damage.toFixed(3),
        headDamage: +resolveHit(weapon, rangeM, 'head', null).damage.toFixed(3),
        legDamage: +resolveHit(weapon, rangeM, 'leg', null).damage.toFixed(3),
        headTtkMs: Number.isFinite(head) ? head : null,
        legTtkMs: Number.isFinite(leg) ? leg : null,
      });
    }
  }
  return rows;
}

/* ==========================================================================
 * 4. THE PLAYER'S HEALTH ECONOMY
 * ======================================================================= */

/**
 * CoD healing, explicitly not Apex healing.
 *
 * The brief: *"we don't want healing like in apex tho, i like fast paced
 * healing like cod where it auto heals or u can stim while fighting."*
 *
 * So: no shield cells, no batteries, no med kits, nothing to manage in the
 * inventory. Two mechanisms only —
 *
 * **Passive regeneration.** CoD 4 through MW2019 all use the same shape: a
 * fixed no-damage delay, then a fast heal to full. MW2019 waits 5 s and takes
 * about 2.5 s to refill 100 HP; Black Ops waits ~4 s. Ours: **4.2 s delay,
 * 34 HP/s, so 0 → 100 in 2.94 s.** Faster onset than MW2019 because our TTK is
 * doubled: a longer fight means more time spent partially damaged, and a 5 s
 * delay on top of that turns every trade into a retreat.
 *
 * **The stim.** A tactical you can use mid-fight, exactly like MW2019's Stim:
 * it does not stop you shooting, moving or aiming, and it does not stop the
 * rounds coming the other way. The cost is a charge economy, not an animation
 * lock — **2 charges, 24 s to recharge one**, plus a 0.2 s inject before the
 * heal starts and a 0.75 s delivery, so it cannot be used as a panic button at
 * 5 HP against a burst already in the air.
 */
export const PLAYER_VITALS = {
  maxHealth: 100,
  /** Seconds without taking damage before passive regeneration begins. */
  regenDelay: 4.2,
  /** HP per second once regenerating — 0 → 100 in 2.94 s. */
  regenRate: 34,
  /** How far behind the authored curve actual health may drift before the
   *  model tops it up. A safety net, not the primary mechanism. */
  regenTolerance: 3,

  stimCharges: 2,
  /** Seconds to recharge one spent charge. */
  stimRecharge: 24,
  /** HP delivered by one stim. */
  stimHeal: 65,
  /** Seconds between pressing the key and the first HP arriving. */
  stimArm: 0.2,
  /** Seconds over which the heal is delivered. */
  stimDuration: 0.75,
} as const;

export interface PlayerVitalsView {
  health: number;
  maxHealth: number;
  /** Seconds since the last damage taken. */
  sinceDamage: number;
  regenerating: boolean;
  /** Seconds until passive regeneration starts, 0 when it already has. */
  regenIn: number;
  stimCharges: number;
  stimMax: number;
  /** Seconds until the next charge returns, 0 at full charges. */
  stimRechargeIn: number;
  stimActive: boolean;
  /** HP still to be delivered by the stim in flight. */
  stimPending: number;
  stimsUsed: number;
}

/** What the vitals model needs from the player system. All of it optional. */
export interface VitalsHost {
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  heal?(amount: number): void;
}

/**
 * Passive regeneration + the stim, on the fixed step.
 *
 * Regeneration is modelled as a **floor**, not as the primary healer: the
 * player system already runs the same curve, and two systems both adding HP
 * would double the rate. The model tracks what the authored curve says the
 * player should have and tops up only when the shipped behaviour falls more
 * than `regenTolerance` behind it. If the player system's regeneration is ever
 * removed or slowed, the authored curve survives; while it matches, this costs
 * one comparison per step and heals nothing.
 *
 * Both mechanisms are suppressed while the player is in last stand. Healing a
 * downed player back to full is precisely the loop that produced
 * *"after getting downed i would just get shot at for 60s without dying"*.
 */
export class PlayerVitals {
  host: VitalsHost | null = null;
  /** Set by the owner from `Lifecycle.state`; blocks all healing when true. */
  downed = false;

  sinceDamage = 999;
  charges = PLAYER_VITALS.stimCharges;
  stimsUsed = 0;

  private rechargeTimer = 0;
  private stimTimer = -1;
  private stimDelivered = 0;
  private curveHealth: number = PLAYER_VITALS.maxHealth;
  private latched = false;
  private lastHealth = -1;

  reset(): void {
    this.sinceDamage = 999;
    this.charges = PLAYER_VITALS.stimCharges;
    this.rechargeTimer = 0;
    this.stimTimer = -1;
    this.stimDelivered = 0;
    this.curveHealth = PLAYER_VITALS.maxHealth as number;
    this.stimsUsed = 0;
    this.lastHealth = -1;
  }

  notifyDamaged(health: number): void {
    this.sinceDamage = 0;
    this.curveHealth = health;
  }

  /** True when the stim was actually spent. */
  useStim(): boolean {
    if (this.downed) return false;
    if (this.charges <= 0) return false;
    if (this.stimTimer >= 0) return false;
    const h = this.host;
    if (h && h.alive === false) return false;
    if (h && h.health >= h.maxHealth - 0.5) return false;
    this.charges--;
    this.stimsUsed++;
    this.stimTimer = 0;
    this.stimDelivered = 0;
    if (this.rechargeTimer <= 0) this.rechargeTimer = PLAYER_VITALS.stimRecharge;
    bus.emit('notify', { text: 'STIM', kind: 'info' });
    return true;
  }

  fixedUpdate(dt: number, stimPressed: boolean): void {
    const V = PLAYER_VITALS;
    this.sinceDamage += dt;

    /*
     * Damage is detected by *watching health fall*, not by listening for
     * `damage:taken`. Two of the ways a player loses health never publish that
     * event — `PlayerSystem` applies fall damage by calling its own
     * `applyDamage` directly, and `Lifecycle` knocks the player down to last
     * stand the same way — and a regeneration model that misses them would
     * heal a fall the moment it landed. The bus handler is kept as the fast
     * path, so damage still registers on the exact step it lands.
     */
    if (this.host) {
      const h = this.host.health;
      if (this.lastHealth >= 0 && h < this.lastHealth - 0.01) {
        this.sinceDamage = 0;
        this.curveHealth = h;
      }
      this.lastHealth = h;
    }

    /* --- stim charge economy ------------------------------------------- */
    if (this.charges < V.stimCharges) {
      this.rechargeTimer -= dt;
      if (this.rechargeTimer <= 0) {
        this.charges++;
        this.rechargeTimer = this.charges < V.stimCharges ? V.stimRecharge : 0;
      }
    }

    if (stimPressed && !this.latched) { this.latched = true; this.useStim(); }
    if (!stimPressed) this.latched = false;

    const host = this.host;
    if (!host || !host.heal || host.alive === false) return;

    /* --- stim delivery -------------------------------------------------- */
    if (this.stimTimer >= 0) {
      this.stimTimer += dt;
      const t = (this.stimTimer - V.stimArm) / V.stimDuration;
      if (t > 0) {
        const want = V.stimHeal * Math.min(1, t);
        const give = want - this.stimDelivered;
        if (give > 0 && !this.downed) {
          host.heal(give);
          this.curveHealth = Math.min(host.maxHealth, this.curveHealth + give);
        }
        this.stimDelivered = want;
        if (t >= 1) { this.stimTimer = -1; this.stimDelivered = 0; }
      }
    }

    /* --- passive regeneration floor ------------------------------------- */
    if (this.downed) { this.curveHealth = host.health; return; }
    if (this.sinceDamage <= V.regenDelay) { this.curveHealth = Math.max(this.curveHealth, host.health); return; }
    this.curveHealth = Math.min(host.maxHealth, this.curveHealth + V.regenRate * dt);
    if (host.health < this.curveHealth - V.regenTolerance) {
      host.heal(this.curveHealth - host.health);
    } else if (host.health > this.curveHealth) {
      this.curveHealth = host.health;
    }
  }

  view(): PlayerVitalsView {
    const V = PLAYER_VITALS;
    const h = this.host;
    return {
      health: h ? h.health : 0,
      maxHealth: h ? h.maxHealth : V.maxHealth,
      sinceDamage: +this.sinceDamage.toFixed(3),
      regenerating: !this.downed && this.sinceDamage > V.regenDelay
        && !!h && h.health < h.maxHealth,
      regenIn: Math.max(0, V.regenDelay - this.sinceDamage),
      stimCharges: this.charges,
      stimMax: V.stimCharges,
      stimRechargeIn: this.charges >= V.stimCharges ? 0 : Math.max(0, this.rechargeTimer),
      stimActive: this.stimTimer >= 0,
      stimPending: this.stimTimer >= 0 ? V.stimHeal - this.stimDelivered : 0,
      stimsUsed: this.stimsUsed,
    };
  }
}

/* ==========================================================================
 * 5. THE RUNTIME SERVICE
 * ======================================================================= */

/**
 * The actor record a damage funnel hands us. Structural, never imported, and
 * every field optional but `id` — the two backends in this build describe a
 * body differently and the model must price a round against either.
 *
 * `BotFallback.Bot` carries `position` (feet), `yaw`, `height` and `radius`
 * directly. `AIActorBridge.AIBotView` carries `position` (feet) and `height`
 * but keeps `yaw` on the agent and `radius` in the archetype table, and
 * answers `ActorAPI.combatantInfo` instead. `resolveBody` accepts both.
 */
interface ActorRecord {
  id: number;
  alive?: boolean;
  archetype: Archetype;
  position: { x: number; y: number; z: number };
  yaw?: number;
  height?: number;
  radius?: number;
  health?: number;
  maxHealth?: number;
}

interface DamageFunnelHost {
  hurt?(b: ActorRecord, amount: number, opts: DamageOpts): boolean;
  combatantInfo?(id: number, out: CombatantInfo): boolean;
}

/** `src/weapons/`'s ballistic damage hook, structurally. Never imported. */
type BallisticResolver = (
  entityId: number, amount: number, headshot: boolean,
  point: THREE.Vector3, direction: THREE.Vector3, fromPlayer: boolean,
  zone?: HitZone,
) => { killed: boolean; applied: number; armor?: boolean };

interface WeaponsHost {
  ballistics?: { damageResolver?: BallisticResolver | null };
  setDamageResolver?(fn: BallisticResolver | null): void;
}

/** One priced round, live for the duration of a single resolver call. */
interface PricedRound {
  id: number;
  zone: HitZone;
  headshot: boolean;
  damage: number;
  /** Range the price was computed at, and the weapon that fired it. */
  distance: number;
  weaponId: string;
}

interface ShotContext {
  weaponId: string;
  ox: number; oy: number; oz: number;
  serial: number;
}

export interface CombatDiagnostics {
  attached: boolean;
  /** Why the damage funnel could not be wrapped, when it could not be. */
  reason: string;
  /** Class name of the actor backend the model attached to. */
  backend: string;
  /** Player rounds the model saw but could not place on a body. */
  roundsSkipped: number;
  /** Rounds the model has priced. */
  roundsPriced: number;
  /** True once the ballistic damage hook is the model's. */
  resolverWrapped: boolean;
  /** Melee bashes recognised and passed through untouched. */
  meleeRounds: number;
  /** Blast-sweep calls recognised and passed through untouched. */
  blastRounds: number;
  /** Rounds that arrived with a real collider zone rather than a geometric one. */
  colliderZones: number;
  /** Rounds whose zone came from the hitbox rig. */
  geometricZones: number;
  zoneHistogram: Record<string, number>;
  ticks: number;
}

/**
 * Installs the tables above into whatever game is running.
 *
 * Three attachments, all optional, all idempotent, none of them fatal:
 *
 *  1. **The damage funnel.** The actor backend's `hurt(record, amount, opts)`
 *     is wrapped on the *instance*, and the wrapper dispatches back through the
 *     prototype rather than through a captured function reference. That detail
 *     is load-bearing: the playtest harness wraps the same method on the
 *     prototype to record every health change, and a captured reference would
 *     route around it and silently blind the measurement.
 *  2. **The fixed step.** `GameDirector.fixedUpdate` is wrapped on the instance
 *     rather than a system being pushed into `Engine.systems`, because
 *     `Engine.add` re-sorts an array the frame loop is iterating.
 *  3. **The player.** Read through `GameServices.player`, which is the same
 *     narrow bridge the match uses.
 */
export class CombatModel {
  readonly vitals = new PlayerVitals();
  /** Per-archetype armour and health, published by `Archetypes.ts`. */
  private profiles: Partial<Record<Archetype, ArchetypeProfile>> = {};

  private shot: ShotContext | null = null;
  private serial = 0;
  private attached = false;
  private armed = false;
  private reason = 'not attached';
  private lifecycle: { state?: string } | null = null;
  /** The actor backend, once found. Read for `combatantInfo`. */
  private host: DamageFunnelHost | null = null;
  /** The weapon system, for the live weapon id. */
  private weapons: unknown = null;
  /** The render camera's position object — the live shot origin. */
  private camera: { x: number; y: number; z: number } | null = null;
  /** The round priced by the ballistic resolver, live for one call stack. */
  private pending: PricedRound | null = null;
  private resolverWrapped = false;
  private roundsPriced = 0;
  private skipped = 0;
  private meleeRounds = 0;
  private blastRounds = 0;
  private colliderZones = 0;
  private geometricZones = 0;
  private zoneHistogram: Record<string, number> = {};
  private ticks = 0;

  /**
   * Called by `Archetypes.ts` at module init — the single source of body data.
   *
   * `verify` is the archetype table's own lethality proof. The model cannot
   * compute it (the cadence and hit-fraction tables live next to the profiles,
   * and importing them here would make the two files circular), but it can
   * carry it, which is what puts "does the enemy table still add up" behind
   * the same verification door as everything else.
   */
  registerProfiles(
    profiles: Record<Archetype, ArchetypeProfile>,
    verify?: () => Array<{ id: Archetype; want: number; got: number }>,
  ): void {
    this.profiles = profiles;
    if (verify) this.verifyLethality = verify;
  }

  /** Rows where an archetype's authored `dps` and its cadence disagree. */
  verifyLethality: () => Array<{ id: Archetype; want: number; got: number }> = () => [];

  armorFor(archetype: Archetype): ZoneTable | null {
    return this.profiles[archetype]?.armor ?? null;
  }

  healthFor(archetype: Archetype): number {
    return this.profiles[archetype]?.health ?? TTK_DESIGN.referenceHealth;
  }

  /**
   * Body metrics for an archetype: the frame the hitbox rig is scaled to.
   * The HUD, the marker layer and verification probes all need this without
   * having to reach into whichever actor backend owns the body today.
   */
  bodyOf(archetype: Archetype): { height: number; radius: number; health: number; armor: ZoneTable | null } {
    const p = this.profiles[archetype];
    return {
      height: p?.height ?? 1.78,
      radius: p?.radius ?? 0.34,
      health: p?.health ?? TTK_DESIGN.referenceHealth,
      armor: p?.armor ?? null,
    };
  }

  /**
   * Prices one of the player's rounds.
   *
   * This is the door the actor backend should call directly. Pass
   * `opts.zone` when a real per-bone collider produced the hit; leave it out
   * and the zone is resolved geometrically from `opts.point` against the
   * hitbox rig. Everything else — the ray, occlusion, tracers, ragdoll,
   * killfeed — stays with the backend.
   */
  resolveRound(body: ActorRecord, opts: DamageOpts): HitResolution {
    const weaponId = opts.weaponId ?? this.liveWeaponId() ?? FALLBACK_WEAPON;
    const p = opts.point;
    let metres = opts.distance ?? -1;
    if (metres < 0) metres = p ? this.rangeTo(p) : 0;
    if (!(metres >= 0) || metres > 900) metres = 0;

    let zone = opts.zone;
    if (zone && zone !== 'none') this.colliderZones++;
    else {
      zone = p ? zoneAtPoint(this.frameFor(body, opts), p.x, p.y, p.z) : 'chest';
      this.geometricZones++;
    }

    const r = resolveHit(weaponId, metres, zone, this.armorFor(body.archetype));
    this.roundsPriced++;
    this.zoneHistogram[r.zone] = (this.zoneHistogram[r.zone] ?? 0) + 1;
    // Publish what the model decided, so a verification probe — or a HUD
    // damage readout — can check the number instead of re-deriving it.
    opts.zone = r.zone;
    opts.distance = r.distance;
    opts.weaponId = weaponId;
    return r;
  }

  /**
   * Which weapon fired this round.
   *
   * Read live from the weapon system rather than from the last `weapon:fire`,
   * because `WeaponSystem.fire` hands the round to `Ballistics` *before* it
   * publishes the event, and a hitscan round resolves inside that call. Taking
   * the id off the event therefore prices the first round after every weapon
   * swap with the previous weapon's curve — measured as a 32-damage round out
   * of an SMG that tops out at 28, and a 63.25-damage round out of a pistol
   * that tops out at 26.
   */
  private liveWeaponId(): string | null {
    const w = this.weapons as { current?: { id?: string } } | null;
    const id = w?.current?.id;
    if (typeof id === 'string' && id) return id;
    return this.shot?.weaponId ?? null;
  }

  /**
   * Metres from the shooter to an impact point.
   *
   * The camera is the live origin; the muzzle sits about 0.3 m further along
   * the same bore, which is inside the noise of every damage stop in the
   * catalogue. The last `weapon:fire` origin is the fallback, and it is only a
   * fallback because it goes stale exactly when a hitscan round resolves ahead
   * of the event that would have refreshed it.
   */
  private rangeTo(p: { x: number; y: number; z: number }): number {
    const cam = this.camera;
    if (cam) return Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
    const s = this.shot;
    if (s) return Math.hypot(p.x - s.ox, p.y - s.oy, p.z - s.oz);
    return 0;
  }

  /**
   * Builds the hitbox frame for a body the model does not own.
   *
   * Three sources, in order of trust: the record itself, the backend's
   * `ActorAPI.combatantInfo`, and the archetype table. The last resort for
   * `yaw` is the *shot direction* — with no body facing available, "which side
   * of him did this round enter" is best answered in the shooter's frame,
   * which is also the frame the player was actually aiming in.
   */
  private frameFor(body: ActorRecord, opts: DamageOpts): BodyFrame {
    const f = this._frame;
    f.position = body.position;
    const table = this.bodyOf(body.archetype);
    f.height = body.height ?? table.height;
    f.radius = body.radius ?? table.radius;
    f.yaw = body.yaw ?? NaN;

    if (!Number.isFinite(f.yaw) || body.radius === undefined) {
      const host = this.host;
      if (host?.combatantInfo && host.combatantInfo(body.id, this._info)) {
        f.position = this._info.position;
        f.height = this._info.height;
        f.radius = this._info.radius;
        f.yaw = this._info.yaw;
      }
    }
    if (!Number.isFinite(f.yaw)) {
      const d = opts.direction;
      // Face him back down the incoming round: +Z of the rig points at the muzzle.
      f.yaw = d ? Math.atan2(-d.x, -d.z) : 0;
    }
    return f;
  }

  private readonly _frame: BodyFrame = {
    position: { x: 0, y: 0, z: 0 }, yaw: 0, height: 1.78, radius: 0.34,
  };
  private readonly _info = {
    archetype: 'rifleman' as Archetype, team: 'hostile' as const, alive: true,
    health: 0, maxHealth: 0,
    position: { x: 0, y: 0, z: 0, copy(v: { x: number; y: number; z: number }) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } },
    yaw: 0, height: 1.78, radius: 0.34,
  } as unknown as CombatantInfo;

  /* ------------------------------------------------------------ install -- */

  /** Idempotent. Safe to call from anywhere, at any time, any number of times. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    bus.on('weapon:fire', (e) => {
      this.serial++;
      this.shot = {
        weaponId: e.weaponId,
        ox: e.origin.x, oy: e.origin.y, oz: e.origin.z,
        serial: this.serial,
      };
      if (!this.attached) this.attach();
      if (!this.resolverWrapped) this.wrapBallisticResolver();
    });
    bus.on('damage:taken', (e) => {
      const host = this.vitals.host;
      this.vitals.notifyDamaged(host ? host.health - e.amount : 0);
      if (!this.attached) this.attach();
    });
    bus.on('player:spawn', () => { this.vitals.reset(); });
    bus.on('game:ready', () => { queueMicrotask(() => this.attach()); });
    // `game:ready` may already have fired if this module was pulled in late.
    queueMicrotask(() => this.attach());
  }

  attach(): boolean {
    if (this.attached) return true;
    const g = (globalThis as unknown as {
      __BLACKOUT_GAME__?: {
        services?: { actors?: unknown; player?: unknown };
        match?: { lifecycle?: { state?: string } };
        fixedUpdate?: (dt: number, ctx: unknown) => void;
      };
    }).__BLACKOUT_GAME__;
    if (!g) { this.reason = 'no __BLACKOUT_GAME__'; return false; }

    const player = g.services?.player as VitalsHost | undefined;
    if (player && typeof player.heal === 'function') this.vitals.host = player;
    this.lifecycle = g.match?.lifecycle ?? null;

    const host = g.services?.actors as (DamageFunnelHost & object) | undefined;
    if (!host) { this.reason = 'no actor backend'; return false; }
    this.host = host;

    if (!this.wrapDamageFunnel(host)) return false;
    this.wrapBallisticResolver();
    this.wrapFixedStep(g as { fixedUpdate?: (dt: number, ctx: unknown) => void });
    this.attached = true;
    this.reason = 'ok';
    return true;
  }

  /**
   * Prices the player's rounds where `src/weapons/` hands damage to the game
   * layer, rather than one step later where the actor backend applies it.
   *
   * This is not a stylistic preference — it is required for correctness.
   * `Ballistics.resolveImpact` calls the resolver and then publishes
   * `damage:dealt` on the same call stack; the AI backend applies the hit from
   * the resolver *and* listens to that event, and de-duplicates the two by
   * arming a one-shot token with the applied amount (`Agent.claimBusEcho`).
   * Rewriting the amount any later than the resolver breaks that token: the
   * echo no longer matches, so it is applied as a *second* hit, and — because
   * consecutive rounds into the same zone price identically — the *next*
   * round then matches the stale token and is swallowed instead. Measured, that
   * turned a 32-damage round into a 21.12-damage round with the model's own
   * hit doing literally nothing (`hurt` before 125.8 → after 125.8).
   *
   * Pricing here keeps `applied`, the bus payload and the claim token all
   * equal to the same number, which is the invariant the whole pipeline is
   * built on. It also means the HUD's damage readout reports what actually
   * came off.
   *
   * Only installed when the host already has a resolver: adding one where
   * there was none would change who owns damage application.
   */
  private wrapBallisticResolver(): void {
    if (this.resolverWrapped) return;
    const e = (globalThis as unknown as {
      engine?: { tryGet?(name: string): unknown };
    }).engine;
    const w = e?.tryGet?.('weapons') as WeaponsHost | undefined;
    const prev = w?.ballistics?.damageResolver;
    if (!w || typeof w.setDamageResolver !== 'function' || typeof prev !== 'function') return;
    this.weapons = w;
    const cam = (e as unknown as { camera?: { position?: { x: number; y: number; z: number } } })?.camera;
    if (cam?.position) this.camera = cam.position;
    const model = this;
    // Reused: `Ballistics` consumes the result before the next round exists.
    const out = { killed: false, applied: 0, armor: false };
    w.setDamageResolver((entityId, amount, headshot, point, direction, fromPlayer, zone) => {
      const priced = model.priceRound(
        entityId, amount, headshot, point, direction, fromPlayer, zone,
      );
      // Forward the priced zone (collider or geometric) so ActorAPI.hurt does
      // not collapse arm/leg/stomach back to binary head/chest.
      const pend = model.pending;
      const r = prev(
        entityId, priced, pend?.headshot ?? headshot, point, direction, fromPlayer,
        pend?.zone ?? zone,
      );
      model.pending = null;
      out.killed = !!r?.killed;
      out.applied = priced;
      out.armor = !!r?.armor;
      return out;
    });
    this.resolverWrapped = true;
  }

  /**
   * The price of one ballistic round, or `amount` unchanged when the model
   * must not touch it.
   *
   * Three things arrive here that are not the player shooting someone:
   * AI-on-AI fire (`fromPlayer` false), the blast sweep `Ballistics.detonate`
   * runs after a grenade (always a straight-up direction — the same signature
   * the director uses to claim it), and a melee bash, which comes through the
   * identical hook carrying the weapon's authored `meleeDamage`. All three
   * pass through with their own numbers.
   */
  private priceRound(
    entityId: number, amount: number, headshot: boolean,
    point: THREE.Vector3, direction: THREE.Vector3, fromPlayer: boolean,
    zone?: HitZone,
  ): number {
    this.pending = null;
    if (!fromPlayer) return amount;
    if (!headshot && direction.x === 0 && direction.z === 0 && direction.y === 1) {
      this.blastRounds++;
      return amount;
    }
    if (this.isMeleeDamage(amount)) { this.meleeRounds++; return amount; }
    const host = this.host;
    if (!host?.combatantInfo || !host.combatantInfo(entityId, this._info)) {
      this.skipped++;
      return amount;
    }
    const info = this._info;
    // Prefer the physics-authored band when the ray already resolved one;
    // otherwise resolveRound falls back to the geometric hitbox rig.
    const opts: DamageOpts = {
      point, direction, headshot, fromPlayer: true, source: 'player',
      zone: zone && zone !== 'none' ? zone : undefined,
    };
    const r = this.resolveRound({
      id: entityId, archetype: info.archetype, position: info.position,
      yaw: info.yaw, height: info.height, radius: info.radius,
    }, opts);
    this.pending = {
      id: entityId, zone: r.zone, headshot: r.headshot, damage: r.damage,
      distance: r.distance, weaponId: opts.weaponId ?? FALLBACK_WEAPON,
    };
    return r.damage;
  }

  /**
   * A melee bash reaches the resolver through the same door as a bullet, with
   * the weapon's authored `meleeDamage` as the amount. That constant is a
   * per-weapon integer no ballistic result lands on by accident: the ballistic
   * amount is a damage stop interpolated over range and multiplied by a zone
   * factor and a penetration scale.
   */
  private isMeleeDamage(amount: number): boolean {
    const id = this.shot?.weaponId;
    if (!id || !hasWeapon(id)) return false;
    return Math.abs(amount - weaponDef(id).handling.meleeDamage) < 1e-6;
  }

  /**
   * Wraps the backend's damage funnel so every player round is priced by the
   * model. Non-player damage — explosions, sentries, airstrikes, AI-on-AI — is
   * passed straight through: those sources author their own numbers and the
   * model has no business second-guessing them.
   */
  private wrapDamageFunnel(host: DamageFunnelHost & object): boolean {
    if (typeof host.hurt !== 'function') {
      this.reason = 'actor backend exposes no hurt() funnel; '
        + 'call combat.resolveRound() from the backend instead';
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(host, 'hurt')) return true; // already ours
    const proto = Object.getPrototypeOf(host) as DamageFunnelHost;
    const model = this;
    Object.defineProperty(host, 'hurt', {
      configurable: true,
      writable: true,
      value: function (this: unknown, b: ActorRecord, amount: number, opts: DamageOpts): boolean {
        let value = amount;
        const pend = model.claimPending(b && b.id);
        if (pend) {
          // Already priced at the ballistic hook; carry the decision forward so
          // the killfeed, the ragdoll and any probe read the same numbers.
          value = pend.damage;
          opts.headshot = pend.headshot;
          opts.zone = pend.zone;
          opts.distance = pend.distance;
          opts.weaponId = pend.weaponId;
        } else if (isPlayerRound(opts)) {
          if (looksLikeBody(b)) {
            const r = model.resolveRound(b, opts);
            value = r.damage;
            // Keep the rest of the pipeline honest: the hitmarker, the killfeed,
            // the ragdoll impulse and the reaction animation all read these.
            opts.headshot = r.headshot;
            opts.zone = r.zone;
          } else model.noteSkipped();
        }
        // Dynamic dispatch on purpose — see the class comment.
        const next = proto.hurt;
        return next ? next.call(this, b, value, opts) : false;
      },
    });
    return true;
  }

  private wrapFixedStep(g: { fixedUpdate?: (dt: number, ctx: unknown) => void }): void {
    if (typeof g.fixedUpdate !== 'function') return;
    if (Object.prototype.hasOwnProperty.call(g, 'fixedUpdate')) return;
    const proto = Object.getPrototypeOf(g) as { fixedUpdate?: (dt: number, ctx: unknown) => void };
    const model = this;
    Object.defineProperty(g, 'fixedUpdate', {
      configurable: true,
      writable: true,
      value: function (this: unknown, dt: number, ctx: unknown): void {
        const next = proto.fixedUpdate;
        if (next) next.call(this, dt, ctx);
        model.fixedUpdate(dt);
      },
    });
  }

  /** Deterministic, fixed-step. Never reads the render clock. */
  fixedUpdate(dt: number): void {
    this.ticks++;
    /*
     * Retried rather than done once at attach time: `main.ts` publishes
     * `window.engine` *after* `Engine.init` emits `game:ready`, so the first
     * attach — which runs off that event — cannot see the weapon system yet.
     * A once-only wrap silently no-ops there and the whole damage model ends
     * up bypassed by the echo-claim path with nothing to show for it.
     */
    if (!this.resolverWrapped && (this.ticks & 31) === 0) this.wrapBallisticResolver();
    const state = this.lifecycle?.state;
    this.vitals.downed = state === 'downed' || state === 'dead' || state === 'respawning';
    let pressed = false;
    try { pressed = input.pressed('tactical'); } catch { pressed = false; }
    this.vitals.fixedUpdate(dt, pressed);
  }

  /** A player round the model could not price — the record had no body. */
  noteSkipped(): void { this.skipped++; }

  /** The round the ballistic resolver just priced, when it is this body's. */
  claimPending(id: unknown): PricedRound | null {
    const p = this.pending;
    return p && p.id === id ? p : null;
  }

  /** The archetype table as the model sees it, for verification probes. */
  profileTable(): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    for (const key of Object.keys(this.profiles) as Archetype[]) {
      const p = this.profiles[key];
      if (!p) continue;
      rows.push({
        id: p.id, health: p.health, damage: p.damage, rpm: p.rpm,
        accuracy: p.accuracy, dps: p.dps, reactionMs: p.reactionMs,
        burst: [p.burstMin, p.burstMax], armor: p.armor,
        height: p.height, radius: p.radius,
      });
    }
    return rows;
  }

  diagnostics(): CombatDiagnostics {
    return {
      attached: this.attached,
      reason: this.reason,
      backend: this.host ? this.host.constructor.name : 'none',
      roundsSkipped: this.skipped,
      roundsPriced: this.roundsPriced,
      resolverWrapped: this.resolverWrapped,
      meleeRounds: this.meleeRounds,
      blastRounds: this.blastRounds,
      colliderZones: this.colliderZones,
      geometricZones: this.geometricZones,
      zoneHistogram: { ...this.zoneHistogram },
      ticks: this.ticks,
    };
  }
}

/**
 * Is this `hurt` call one of the player's bullets?
 *
 * The backend tags player rounds `source: 'player'`. Explosions, sentries and
 * airstrikes carry their own source and their own authored damage, and must
 * pass through untouched or a grenade would start doing rifle damage.
 */
function isPlayerRound(opts: DamageOpts | undefined): boolean {
  if (!opts) return false;
  if (opts.fromPlayer === false) return false;
  return opts.source === 'player' || opts.source === 'bullet';
}

/**
 * The minimum a damage funnel has to hand over for a round to be priced: an
 * entity id, an archetype and a feet position. Height, radius and yaw are all
 * recovered by `frameFor` when the record does not carry them, which is what
 * lets one model serve both `BotFallback.Bot` and `AIActorBridge.AIBotView`.
 */
function looksLikeBody(b: unknown): b is ActorRecord {
  const r = b as ActorRecord | undefined;
  if (!r || typeof r.id !== 'number' || typeof r.archetype !== 'string') return false;
  const p = r.position;
  return !!p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number';
}

/* -------------------------------------------------------------- singleton -- */

/**
 * The process-wide combat model.
 *
 * `Archetypes.ts` imports this for value, which is what guarantees the module
 * is in the bundle at all: every other reference to `Combat.ts` in the program
 * is `import type`, and those are erased.
 */
export const combat = new CombatModel();

combat.arm();

/** Verification door. Read-only aside from `useStim`, which the HUD also uses. */
(globalThis as unknown as { __BLACKOUT_COMBAT__?: unknown }).__BLACKOUT_COMBAT__ = {
  model: combat,
  version: 1,
  rig: HITBOX_RIG,
  zoneMultipliers: ZONE_MULTIPLIERS,
  vitalsSpec: PLAYER_VITALS,
  design: TTK_DESIGN,
  ttkTable,
  archetypes: () => combat.profileTable(),
  assertLethality: () => combat.verifyLethality(),
  diagnostics: () => combat.diagnostics(),
  vitals: () => combat.vitals.view(),
  useStim: () => combat.vitals.useStim(),
  attach: () => combat.attach(),
  bodyOf: (archetype: Archetype) => combat.bodyOf(archetype),
  healthFor: (archetype: Archetype) => combat.healthFor(archetype),
  zoneAt: (body: BodyFrame, x: number, y: number, z: number) => zoneAtPoint(body, x, y, z),
  raycastZones,
  damageFor: (weaponId: string, metres: number, zone: HitZone, archetype: Archetype) => {
    const r = resolveHit(weaponId, metres, zone, combat.armorFor(archetype), {
      damage: 0, zone: 'chest', headshot: false, base: 0,
      zoneMultiplier: 1, armorMultiplier: 1, distance: 0,
    });
    return { ...r };
  },
  shotsToKill,
  ttkMs,
  zones: HIT_ZONES,
};

export type { CombatantInfo };
