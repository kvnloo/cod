/**
 * Inverse kinematics.
 *
 * One analytic two-bone solver serves both arms and both legs. It works
 * entirely in world space and never needs to know a bone's "aim axis": it
 * measures the direction a bone currently points (joint → child joint) and
 * applies the delta rotation that swings it onto the direction the solution
 * wants. That makes it immune to rig conventions, which matters here because
 * the rest pose is identity and the limbs get their direction from translation
 * offsets alone.
 */

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dirAT = new THREE.Vector3();
const _dirAB = new THREE.Vector3();
const _dirBC = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _want = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();

/** Rotates `bone` so that `fromWorldDir` ends up along `toWorldDir`. */
export function swingBone(bone: THREE.Object3D, fromWorldDir: THREE.Vector3, toWorldDir: THREE.Vector3, weight = 1): void {
  if (fromWorldDir.lengthSq() < 1e-12 || toWorldDir.lengthSq() < 1e-12) return;
  _q.setFromUnitVectors(fromWorldDir, toWorldDir);
  if (weight < 1) _q.slerp(IDENTITY, 1 - weight);
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(_q);
  const parent = bone.parent;
  if (parent) {
    parent.getWorldQuaternion(_qp);
    _qp.invert();
    _qw.premultiply(_qp);
  }
  bone.quaternion.copy(_qw);
  bone.updateMatrixWorld(true);
}

const IDENTITY = new THREE.Quaternion();

export interface TwoBoneOptions {
  /** 0..1 blend between the animated pose and the solved pose. */
  weight?: number;
  /** World-space hint for which way the joint should bend. */
  pole?: THREE.Vector3;
  /** Allow the chain to stretch by this fraction rather than pop off target. */
  stretch?: number;
}

/**
 * Solves `root → mid → tip` so `tip` reaches `target`.
 * Assumes the chain's world matrices are current; leaves them current.
 */
export function twoBoneIK(
  root: THREE.Object3D, mid: THREE.Object3D, tip: THREE.Object3D,
  target: THREE.Vector3, opts: TwoBoneOptions = {},
): void {
  const weight = opts.weight ?? 1;
  if (weight <= 0.0005) return;

  _a.setFromMatrixPosition(root.matrixWorld);
  _b.setFromMatrixPosition(mid.matrixWorld);
  _c.setFromMatrixPosition(tip.matrixWorld);

  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  if (l1 < 1e-5 || l2 < 1e-5) return;

  _t.copy(target);
  _dirAT.subVectors(_t, _a);
  let d = _dirAT.length();
  if (d < 1e-5) return;
  _dirAT.multiplyScalar(1 / d);

  const max = (l1 + l2) * (1 + (opts.stretch ?? 0)) * 0.999;
  const min = Math.abs(l1 - l2) * 1.001 + 1e-4;
  d = THREE.MathUtils.clamp(d, min, max);

  // Interior angle at the root of the triangle (l1, l2, d).
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const angleA = Math.acos(cosA);

  // Bend plane: defined by the target direction and the pole hint.
  if (opts.pole) {
    _pole.subVectors(opts.pole, _a);
  } else {
    _pole.subVectors(_b, _a);
  }
  _pole.addScaledVector(_dirAT, -_pole.dot(_dirAT));
  if (_pole.lengthSq() < 1e-8) {
    _pole.set(0, 1, 0).addScaledVector(_dirAT, -_dirAT.y);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  _pole.normalize();
  _axis.crossVectors(_dirAT, _pole).normalize();

  // Rotating the target direction about `axis` toward the pole by angleA gives
  // the direction the upper bone must point.
  _want.copy(_dirAT).applyAxisAngle(_axis, angleA);
  _dirAB.subVectors(_b, _a).normalize();
  swingBone(root, _dirAB, _want, weight);

  // Second pass: after the root moved, aim the lower bone straight at the goal.
  _b.setFromMatrixPosition(mid.matrixWorld);
  _c.setFromMatrixPosition(tip.matrixWorld);
  _dirBC.subVectors(_c, _b);
  if (_dirBC.lengthSq() < 1e-10) return;
  _dirBC.normalize();
  _want.subVectors(_t, _b);
  if (_want.lengthSq() < 1e-10) return;
  _want.normalize();
  swingBone(mid, _dirBC, _want, weight);
}

/** Sets a bone's world rotation directly, blended from its current one. */
export function setWorldRotation(bone: THREE.Object3D, world: THREE.Quaternion, weight = 1): void {
  if (weight <= 0.0005) return;
  const parent = bone.parent;
  _qw.copy(world);
  if (parent) {
    parent.getWorldQuaternion(_qp);
    _qp.invert();
    _qw.premultiply(_qp);
  }
  if (weight < 1) bone.quaternion.slerp(_qw, weight);
  else bone.quaternion.copy(_qw);
  bone.updateMatrixWorld(true);
}

/**
 * Constrains a direction to a cone around `axis` with a half-angle limit.
 * Returns the clamped direction in `dir` and how much clamping happened.
 */
export function clampToCone(dir: THREE.Vector3, axis: THREE.Vector3, limit: number): number {
  const cos = THREE.MathUtils.clamp(dir.dot(axis), -1, 1);
  const angle = Math.acos(cos);
  if (angle <= limit) return 0;
  _axis.crossVectors(axis, dir);
  if (_axis.lengthSq() < 1e-10) return 0;
  _axis.normalize();
  dir.copy(axis).applyAxisAngle(_axis, limit);
  return angle - limit;
}
