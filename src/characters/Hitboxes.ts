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
