/**
 * The canonical humanoid rig.
 *
 * Every bone in `BONES` is laid out here as a local offset from its parent, in
 * metres, for a 1.80 m reference soldier standing in a relaxed A-pose.
 *
 * One deliberate convention runs through the whole module: **every bone's rest
 * rotation is identity**. The A-pose lives entirely in the translation offsets,
 * so a bone's local frame is always the character frame (+X right, +Y up,
 * +Z forward). That makes animation data readable — rotating `upperArmR` about
 * X swings it in the sagittal plane, about Z abducts it, about Y twists it —
 * and it makes the additive maths trivial, because "additive" is just "compose
 * a delta onto the rest rotation" with no bind-space fixup.
 *
 * Proportions are driven by a small parameter block so a squad reads as eight
 * different people rather than one mesh at eight scales.
 */

import * as THREE from 'three';
import { BONES, type BoneName } from './types';

export const BONE_COUNT = BONES.length;

/** Index of a bone in `BONES` / in the skeleton's bone array. */
export const BONE_INDEX: Record<BoneName, number> = (() => {
  const map = {} as Record<BoneName, number>;
  for (let i = 0; i < BONES.length; i++) map[BONES[i]] = i;
  return map;
})();

export interface BoneDef {
  name: BoneName;
  parent: BoneName | null;
  /** Local translation from the parent joint, reference scale, left side. */
  offset: [number, number, number];
}

/**
 * Reference skeleton. Joint heights follow standard anthropometry for a 1.80 m
 * male: hip 0.94, knee 0.505, ankle 0.085, shoulder 1.44, C7 1.505, crown 1.78.
 */
export const RIG: readonly BoneDef[] = [
  { name: 'root', parent: null, offset: [0, 0, 0] },
  { name: 'hips', parent: 'root', offset: [0, 0.940, 0] },
  { name: 'spine', parent: 'hips', offset: [0, 0.160, 0.006] },
  { name: 'chest', parent: 'spine', offset: [0, 0.200, -0.004] },
  { name: 'neck', parent: 'chest', offset: [0, 0.205, -0.014] },
  { name: 'head', parent: 'neck', offset: [0, 0.080, 0.014] },

  { name: 'shoulderL', parent: 'chest', offset: [0.045, 0.145, 0.004] },
  { name: 'upperArmL', parent: 'shoulderL', offset: [0.130, -0.010, 0] },
  { name: 'lowerArmL', parent: 'upperArmL', offset: [0.0912, -0.2806, 0.004] },
  { name: 'handL', parent: 'lowerArmL', offset: [0.0551, -0.2592, 0.004] },

  { name: 'shoulderR', parent: 'chest', offset: [-0.045, 0.145, 0.004] },
  { name: 'upperArmR', parent: 'shoulderR', offset: [-0.130, -0.010, 0] },
  { name: 'lowerArmR', parent: 'upperArmR', offset: [-0.0912, -0.2806, 0.004] },
  { name: 'handR', parent: 'lowerArmR', offset: [-0.0551, -0.2592, 0.004] },

  { name: 'upperLegL', parent: 'hips', offset: [0.085, -0.035, 0] },
  { name: 'lowerLegL', parent: 'upperLegL', offset: [0.007, -0.400, 0.004] },
  { name: 'footL', parent: 'lowerLegL', offset: [0.006, -0.420, -0.010] },
  { name: 'toeL', parent: 'footL', offset: [0, -0.055, 0.130] },

  { name: 'upperLegR', parent: 'hips', offset: [-0.085, -0.035, 0] },
  { name: 'lowerLegR', parent: 'upperLegR', offset: [-0.007, -0.400, 0.004] },
  { name: 'footR', parent: 'lowerLegR', offset: [-0.006, -0.420, -0.010] },
  { name: 'toeR', parent: 'footR', offset: [0, -0.055, 0.130] },
];

/** Parent index per bone (−1 for the root). Handy for flat pose maths. */
export const BONE_PARENT: Int8Array = (() => {
  const out = new Int8Array(BONE_COUNT).fill(-1);
  for (const d of RIG) out[BONE_INDEX[d.name]] = d.parent ? BONE_INDEX[d.parent] : -1;
  return out;
})();

/** Bones whose subtree is "upper body" — used for animation layer masks. */
export const UPPER_BODY: readonly BoneName[] = [
  'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
];

export const ARM_BONES: readonly BoneName[] = [
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
];

export const LEG_BONES: readonly BoneName[] = [
  'upperLegL', 'lowerLegL', 'footL', 'toeL',
  'upperLegR', 'lowerLegR', 'footR', 'toeR',
];

/** Per-character proportion multipliers. All default to 1. */
export interface Proportions {
  /** Overall height multiplier. */
  height: number;
  /** Leg length relative to torso. */
  legs: number;
  /** Torso length. */
  torso: number;
  /** Arm length. */
  arms: number;
  /** Shoulder width (also drives clavicle offset). */
  shoulders: number;
  /** Hip width. */
  hips: number;
  /** Head size. */
  head: number;
  /** Neck length. */
  neck: number;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  height: 1, legs: 1, torso: 1, arms: 1, shoulders: 1, hips: 1, head: 1, neck: 1,
};

const LEG_SET = new Set<BoneName>(['upperLegL', 'lowerLegL', 'footL', 'toeL', 'upperLegR', 'lowerLegR', 'footR', 'toeR']);
const ARM_SET = new Set<BoneName>(['upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR']);

/** Applies the proportion block to a bone's reference offset. */
export function scaledOffset(def: BoneDef, p: Proportions, out: THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = def.offset;
  let sx = 1, sy = 1, sz = 1;
  const n = def.name;

  if (n === 'hips') { sy = p.legs; }
  else if (LEG_SET.has(n)) { sy = p.legs; sx = p.hips; }
  else if (n === 'spine' || n === 'chest') { sy = p.torso; }
  else if (n === 'neck') { sy = p.torso * p.neck; }
  else if (n === 'head') { sy = p.neck; }
  else if (n === 'shoulderL' || n === 'shoulderR') { sx = p.shoulders; sy = p.torso; }
  else if (ARM_SET.has(n)) { sx = p.arms; sy = p.arms; sz = p.arms; }

  return out.set(x * sx * p.height, y * sy * p.height, z * sz * p.height);
}

export interface RigInstance {
  /** Bone objects indexed exactly like `BONES`. */
  bones: THREE.Bone[];
  byName: Record<BoneName, THREE.Bone>;
  skeleton: THREE.Skeleton;
  /** The `root` bone; add this to the character object. */
  root: THREE.Bone;
  /** Bind-pose world position of each bone. */
  bindPos: THREE.Vector3[];
  /** Bind-pose local offset of each bone (already scaled). */
  localOffset: THREE.Vector3[];
  proportions: Proportions;
  /** Total standing height in metres (crown of the head, no helmet). */
  standHeight: number;
  /** Bind-pose eye height. */
  eyeHeight: number;
}

/**
 * A skeleton that only rebuilds its bone texture when the animator says the
 * pose actually changed.
 *
 * three calls `Skeleton.update()` once per *render pass* per skeleton, and this
 * renderer runs a depth prepass plus up to four shadow cascades plus the main
 * pass — so a naive skeleton pays six full bone-matrix rebuilds a frame. With
 * a dozen characters on screen that is measurable. The animator sets `dirty`
 * once, after it has finished posing, and every later call in the same frame is
 * free.
 */
export class PoseSkeleton extends THREE.Skeleton {
  dirty = true;

  override update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    super.update();
  }

  /** Forces a rebuild on the next render pass. */
  invalidate(): void { this.dirty = true; }
}

/** Builds bones, computes bind matrices and returns a ready `THREE.Skeleton`. */
export function buildRig(proportions: Proportions): RigInstance {
  const bones: THREE.Bone[] = [];
  const byName = {} as Record<BoneName, THREE.Bone>;
  const localOffset: THREE.Vector3[] = [];
  const v = new THREE.Vector3();

  for (const def of RIG) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    scaledOffset(def, proportions, v);
    bone.position.copy(v);
    localOffset.push(v.clone());
    bones.push(bone);
    byName[def.name] = bone;
  }
  for (const def of RIG) {
    if (def.parent) byName[def.parent].add(byName[def.name]);
  }

  const root = byName.root;
  root.updateMatrixWorld(true);

  const bindPos: THREE.Vector3[] = bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
  const inverses = bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
  const skeleton = new PoseSkeleton(bones, inverses);

  // Crown of the skull: head joint + skull rise. Keep in sync with the head
  // mesh in geom/Soldier.ts.
  const headTop = bindPos[BONE_INDEX.head].y + 0.195 * proportions.head * proportions.height;
  const eye = bindPos[BONE_INDEX.head].y + 0.085 * proportions.head * proportions.height;

  return {
    bones, byName, skeleton, root, bindPos, localOffset,
    proportions, standHeight: headTop, eyeHeight: eye,
  };
}

/**
 * Bind-pose segment for a bone: start at the joint, end at its "primary" child
 * (or an extrapolated tip for leaf bones). Skin weighting works off these.
 */
export function boneSegments(rig: RigInstance): { a: THREE.Vector3; b: THREE.Vector3 }[] {
  const out: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
  const primaryChild: Partial<Record<BoneName, BoneName>> = {
    root: 'hips', hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
    shoulderL: 'upperArmL', upperArmL: 'lowerArmL', lowerArmL: 'handL',
    shoulderR: 'upperArmR', upperArmR: 'lowerArmR', lowerArmR: 'handR',
    upperLegL: 'lowerLegL', lowerLegL: 'footL', footL: 'toeL',
    upperLegR: 'lowerLegR', lowerLegR: 'footR', footR: 'toeR',
  };
  /** Leaf tips: direction and length of the implied continuation. */
  const leafTip: Partial<Record<BoneName, [number, number, number]>> = {
    head: [0, 0.16, 0.01],
    handL: [0.02, -0.09, 0.01], handR: [-0.02, -0.09, 0.01],
    toeL: [0, 0, 0.05], toeR: [0, 0, 0.05],
  };

  for (let i = 0; i < BONE_COUNT; i++) {
    const name = BONES[i];
    const a = rig.bindPos[i];
    const childName = primaryChild[name];
    let b: THREE.Vector3;
    if (childName) {
      b = rig.bindPos[BONE_INDEX[childName]];
    } else {
      const t = leafTip[name] ?? [0, 0.08, 0];
      b = new THREE.Vector3(a.x + t[0], a.y + t[1], a.z + t[2]);
    }
    out.push({ a, b });
  }
  return out;
}
