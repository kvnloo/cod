/**
 * Per-bone hit volumes.
 *
 * Ballistics raycasts against these, not against the skinned mesh, so a hit is
 * resolved to a zone (and therefore to a damage multiplier, a blood effect and
 * a hit reaction direction) in one test. The boxes are expressed in the bone's
 * local frame, which — because the rig's rest rotation is identity — is the
 * character frame translated to the joint, so the numbers read naturally.
 *
 * Sizes scale with the character's proportions and bulk: a juggernaut's chest
 * really is a bigger target than a militia scout's.
 */

import * as THREE from 'three';
import type { HitBox } from './types';
import type { Appearance } from './Appearance';
import { BONE_INDEX, type RigInstance } from './Rig';
import type { CharacterHitboxDesc, HitZone } from '../physics/types';
import type { SurfaceType } from '../core/Surfaces';

interface BoxDef {
  zone: HitBox['zone'];
  bone: HitBox['bone'];
  half: [number, number, number];
  offset: [number, number, number];
  damageScale: number;
  /** Which scaling family the box follows. */
  kind: 'head' | 'torso' | 'arm' | 'leg';
}

const DEFS: BoxDef[] = [
  { zone: 'head', bone: 'head', half: [0.098, 0.115, 0.108], offset: [0, 0.082, 0.006], damageScale: 4.0, kind: 'head' },
  { zone: 'neck', bone: 'neck', half: [0.058, 0.052, 0.058], offset: [0, 0.038, 0], damageScale: 2.4, kind: 'head' },
  { zone: 'chest', bone: 'chest', half: [0.185, 0.115, 0.125], offset: [0, 0.075, 0], damageScale: 1.0, kind: 'torso' },
  { zone: 'stomach', bone: 'spine', half: [0.160, 0.105, 0.115], offset: [0, 0.045, 0], damageScale: 0.95, kind: 'torso' },
  { zone: 'stomach', bone: 'hips', half: [0.165, 0.095, 0.120], offset: [0, 0.020, 0], damageScale: 0.90, kind: 'torso' },

  { zone: 'arm', bone: 'upperArmL', half: [0.070, 0.150, 0.068], offset: [0.045, -0.140, 0], damageScale: 0.70, kind: 'arm' },
  { zone: 'arm', bone: 'lowerArmL', half: [0.060, 0.140, 0.060], offset: [0.028, -0.128, 0], damageScale: 0.65, kind: 'arm' },
  { zone: 'arm', bone: 'handL', half: [0.048, 0.062, 0.052], offset: [0.014, -0.048, 0.012], damageScale: 0.55, kind: 'arm' },
  { zone: 'arm', bone: 'upperArmR', half: [0.070, 0.150, 0.068], offset: [-0.045, -0.140, 0], damageScale: 0.70, kind: 'arm' },
  { zone: 'arm', bone: 'lowerArmR', half: [0.060, 0.140, 0.060], offset: [-0.028, -0.128, 0], damageScale: 0.65, kind: 'arm' },
  { zone: 'arm', bone: 'handR', half: [0.048, 0.062, 0.052], offset: [-0.014, -0.048, 0.012], damageScale: 0.55, kind: 'arm' },

  { zone: 'leg', bone: 'upperLegL', half: [0.098, 0.205, 0.104], offset: [0.004, -0.195, 0], damageScale: 0.72, kind: 'leg' },
  { zone: 'leg', bone: 'lowerLegL', half: [0.080, 0.205, 0.090], offset: [0.003, -0.200, 0.004], damageScale: 0.68, kind: 'leg' },
  { zone: 'leg', bone: 'footL', half: [0.060, 0.055, 0.140], offset: [0, -0.020, 0.058], damageScale: 0.55, kind: 'leg' },
  { zone: 'leg', bone: 'upperLegR', half: [0.098, 0.205, 0.104], offset: [-0.004, -0.195, 0], damageScale: 0.72, kind: 'leg' },
  { zone: 'leg', bone: 'lowerLegR', half: [0.080, 0.205, 0.090], offset: [-0.003, -0.200, 0.004], damageScale: 0.68, kind: 'leg' },
  { zone: 'leg', bone: 'footR', half: [0.060, 0.055, 0.140], offset: [0, -0.020, 0.058], damageScale: 0.55, kind: 'leg' },
];

export function buildHitboxes(rig: RigInstance, app: Appearance): HitBox[] {
  const s = app.proportions.height;
  const bulk = 0.55 + 0.45 * app.bulk;
  const armour = app.carrier === 'heavy' ? 1.16 : app.carrier === 'plate' ? 1.09 : 1.0;
  const helmet = app.headGear === 'helmet' || app.headGear === 'helmetCover' ? 1.10 : 1.0;

  return DEFS.map((d) => {
    let g = s;
    switch (d.kind) {
      case 'head': g = s * app.proportions.head * helmet; break;
      case 'torso': g = s * armour; break;
      case 'arm': g = s * app.proportions.arms; break;
      case 'leg': g = s * app.proportions.legs; break;
    }
    const w = g * (d.kind === 'head' ? 1 : bulk);
    return {
      zone: d.zone,
      bone: d.bone,
      half: [d.half[0] * w, d.half[1] * g, d.half[2] * w] as [number, number, number],
      offset: [d.offset[0] * g, d.offset[1] * g, d.offset[2] * g] as [number, number, number],
      damageScale: d.damageScale,
    };
  });
}

/**
 * World-space OBB of a hitbox: centre and rotation come from the live bone, so
 * physics can rebuild colliders each frame or test them directly.
 */
export function hitboxTransform(
  rig: RigInstance, box: HitBox, outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  const bone = rig.bones[BONE_INDEX[box.bone]];
  bone.matrixWorld.decompose(outPos, outQuat, _scale);
  _off.set(box.offset[0], box.offset[1], box.offset[2]).applyQuaternion(outQuat);
  outPos.add(_off);
}

/** Debug geometry for the hitbox set — one wireframe box per volume. */
export function hitboxDebug(rig: RigInstance, boxes: readonly HitBox[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hitboxes';
  const colors: Record<string, number> = {
    head: 0xff3b30, neck: 0xff9f0a, chest: 0x30d158, stomach: 0x64d2ff,
    arm: 0xbf5af2, leg: 0xffd60a, none: 0x8e8e93,
  };
  for (const box of boxes) {
    const geo = new THREE.BoxGeometry(box.half[0] * 2, box.half[1] * 2, box.half[2] * 2);
    geo.translate(box.offset[0], box.offset[1], box.offset[2]);
    const mesh = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: colors[box.zone] ?? 0xffffff, depthTest: false, toneMapped: false }),
    );
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    rig.bones[BONE_INDEX[box.bone]].add(mesh);
    group.add(new THREE.Object3D()); // keeps the group non-empty for bookkeeping
    geo.dispose();
  }
  return group;
}

const _scale = new THREE.Vector3();
const _off = new THREE.Vector3();

/** Per-zone surface tags for living combat hitboxes. */
export interface LivingHitboxOpts {
  /**
   * Head surface is metal helmet when true. Default false — bare heads are
   * flesh so impact FX / audio do not spark on every skull.
   */
  helmet?: boolean;
  /**
   * Zones protected by plating (armor multi < 1). Chest/stomach get surface
   * `armor` (metal family); a plated head uses `helmet`.
   */
  armoredZones?: ReadonlyArray<HitZone>;
}

/**
 * Surface for one living zone given presentation / armour opts.
 * Bare flesh is the default; only explicitly armoured zones leave it.
 */
export function surfaceForLivingZone(zone: HitZone, opts?: LivingHitboxOpts): SurfaceType {
  const armored = opts?.armoredZones?.includes(zone) ?? false;
  if (zone === 'head' || zone === 'neck') {
    if (opts?.helmet || armored) return 'helmet';
    return 'flesh';
  }
  if (armored && (zone === 'chest' || zone === 'stomach' || zone === 'arm' || zone === 'leg')) {
    return 'armor';
  }
  return 'flesh';
}

/**
 * Capsule-local multi-zone volumes for a living soldier.
 *
 * Bone-driven hitboxes exist for skinned presentation and ragdolls; the live
 * combat path registers these on the kinematic proxy so a bullet ray at head /
 * chest / limb height resolves a real zone without waiting on a posed rig.
 * Offsets are from the capsule centre (y-up, facing +Z). Height scales the
 * whole set so crouch re-layout is a free multiply.
 *
 * Lateral layout mirrors `HITBOX_RIG` in `game/Combat.ts`: torso occupies the
 * inner ~0.55 R, arms the outer ring past the torso edge. A centre-mass ray at
 * arm height still hits chest (correct); a lateral aim into the outer band
 * resolves arm — the previous layout let chest cuboids swallow that ring.
 */
export function livingHitboxLayout(
  height: number,
  radius: number,
  opts?: LivingHitboxOpts,
): CharacterHitboxDesc[] {
  const h = Math.max(0.9, height);
  const r = Math.max(0.2, radius);
  // Reference is a 1.80 m soldier; scale linear dimensions with height.
  const s = h / 1.80;
  // Match geometric HITBOX_RIG: torso half-width ≈ 0.55 R so the outer capsule
  // ring is exclusive arm (prior 0.88 R torso left almost no arm graze).
  const torsoW = Math.min(r * 0.55, 0.20 * s);
  const torsoD = Math.min(r * 0.55, 0.20 * s);
  const limbR = Math.min(r * 0.38, 0.125 * s);
  // Arm centres sit just outside the torso edge — no X-overlap with chest so a
  // centre-mass ray never resolves arm, and a lateral aim at ≥0.55 R does.
  const armOx = torsoW + limbR + 0.01 * s;
  // Deep along the fore/aft axis: the proxy body does not yaw with facing, so
  // lateral aim from any approach angle still clips an arm slab (half-depth
  // covers the playtest/g3 0.85 R lateral offset from ± headings).
  const armDepth = Math.min(r * 0.95, 0.34 * s);

  const box = (
    zone: HitZone,
    half: [number, number, number],
    offset: [number, number, number],
    surface?: SurfaceType,
  ): CharacterHitboxDesc => ({
    zone,
    half,
    offset,
    surface: surface ?? surfaceForLivingZone(zone, opts),
  });

  /**
   * Continuous vertical bands as fractions of height from the feet. Adjacent
   * bands overlap slightly so a centre-mass ray never slips through a seam
   * (the previous layout left chest↔neck, stomach↔chest and leg↔stomach gaps).
   * Capsule centre is at 0.5 h from the feet; local offset.y = (mid − 0.5) · h.
   * Kept in lockstep with `HITBOX_RIG` in `game/Combat.ts`.
   */
  const band = (
    zone: HitZone,
    y0: number,
    y1: number,
    halfX: number,
    halfZ: number,
    ox = 0,
    oz = 0,
    surface?: SurfaceType,
  ): CharacterHitboxDesc => {
    const mid = (y0 + y1) * 0.5;
    const halfY = (y1 - y0) * 0.5 * h;
    return box(zone, [halfX, halfY, halfZ], [ox, (mid - 0.5) * h, oz], surface);
  };

  return [
    // Playtest head band sits at 0.94 h; cover chin → crown. Flesh unless helmet.
    band('head', 0.870, 1.015, 0.11 * s, 0.11 * s),
    band('neck', 0.810, 0.885, 0.07 * s, 0.07 * s),
    // Chest covers playtest 0.72; overlaps neck above and stomach below.
    band('chest', 0.555, 0.825, torsoW, torsoD),
    // Stomach covers playtest 0.52; overlaps legs.
    band('stomach', 0.395, 0.575, torsoW * 0.95, torsoD * 0.92),
    // Arms: exclusive outer slabs. Deep Z so lateral aim works without body yaw.
    band('arm', 0.480, 0.820, limbR, armDepth, armOx, 0),
    band('arm', 0.480, 0.820, limbR, armDepth, -armOx, 0),
    // Legs cover playtest 0.22 and reach into the lower stomach band.
    band('leg', 0.000, 0.430, limbR * 1.25, limbR * 1.15, r * 0.22, 0),
    band('leg', 0.000, 0.430, limbR * 1.25, limbR * 1.15, -r * 0.22, 0),
  ];
}

/**
 * Build living hitboxes from a per-zone armour table (multi < 1 → plated).
 * Helmet surface when head/neck multi is reduced or `helmet` is forced.
 */
export function livingHitboxLayoutFromArmor(
  height: number,
  radius: number,
  armor: Partial<Record<HitZone, number>> | null | undefined,
  helmet = false,
): CharacterHitboxDesc[] {
  const armoredZones: HitZone[] = [];
  if (armor) {
    for (const z of ['head', 'neck', 'chest', 'stomach', 'arm', 'leg'] as HitZone[]) {
      const m = armor[z];
      if (typeof m === 'number' && m < 1 - 1e-6) armoredZones.push(z);
    }
  }
  const headPlated = armoredZones.includes('head') || armoredZones.includes('neck');
  return livingHitboxLayout(height, radius, {
    helmet: helmet || headPlated,
    armoredZones,
  });
}

/** Convert authored per-bone hitboxes into capsule-local descs using live bones. */
export function hitboxesToProxyDesc(
  rig: RigInstance,
  boxes: readonly HitBox[],
  capsuleCentre: THREE.Vector3,
  bodyYaw = 0,
  opts?: LivingHitboxOpts,
): CharacterHitboxDesc[] {
  const out: CharacterHitboxDesc[] = [];
  const invYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -bodyYaw);
  for (const box of boxes) {
    hitboxTransform(rig, box, _pos, _quat);
    _pos.sub(capsuleCentre).applyQuaternion(invYaw);
    out.push({
      zone: box.zone,
      half: [box.half[0], box.half[1], box.half[2]],
      offset: [_pos.x, _pos.y, _pos.z],
      surface: surfaceForLivingZone(box.zone, opts),
    });
  }
  return out;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
