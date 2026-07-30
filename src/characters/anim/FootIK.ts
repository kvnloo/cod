/**
 * Foot IK: plants both feet on whatever the character is standing on.
 *
 * Three things happen every frame, in this order, because each depends on the
 * last: probe the ground under each animated foot; drop the pelvis far enough
 * that the lower foot can reach without the leg hyper-extending; then solve
 * each leg to its target and roll the ankle onto the surface normal.
 *
 * The ground probe is injected rather than imported so this works with the
 * physics raycaster in game and with an analytic heightfield in the debug
 * scene — and so characters cost nothing extra when foot IK is switched off.
 */

import * as THREE from 'three';
import { BONE_INDEX, type RigInstance } from '../Rig';
import { twoBoneIK } from './Ik';

export interface GroundSample {
  y: number;
  normal: THREE.Vector3;
}

/**
 * Returns true when the ground was found under (x, z) searching downward from
 * `fromY`. Implementations must fill `out`.
 */
export type GroundProbe = (x: number, z: number, fromY: number, out: GroundSample) => boolean;

interface FootState {
  /** Smoothed vertical correction applied to the ankle. */
  offset: number;
  /** Smoothed surface normal. */
  normal: THREE.Vector3;
  /** 0..1 how planted the foot is (drives how much rotation to apply). */
  planted: number;
}

const _sample: GroundSample = { y: 0, normal: new THREE.Vector3(0, 1, 0) };
const _toe: GroundSample = { y: 0, normal: new THREE.Vector3(0, 1, 0) };
const _ankle = new THREE.Vector3();
const _toePos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _n = new THREE.Vector3();

export class FootIK {
  /** Maximum distance the pelvis may be dropped, metres. */
  maxHipDrop = 0.34;
  /** Maximum ankle roll onto a slope, radians. */
  maxRoll = 0.42;
  /** Vertical smoothing time constant, seconds. */
  smoothing = 0.09;

  private feet: FootState[] = [
    { offset: 0, normal: new THREE.Vector3(0, 1, 0), planted: 0 },
    { offset: 0, normal: new THREE.Vector3(0, 1, 0), planted: 0 },
  ];
  private hipOffset = 0;
  /** Bind-pose ankle height above the sole, scaled. */
  private ankleHeight: number;
  private toeReach: number;

  constructor(private rig: RigInstance) {
    this.ankleHeight = rig.bindPos[BONE_INDEX.footL].y;
    this.toeReach = rig.bindPos[BONE_INDEX.toeL].z - rig.bindPos[BONE_INDEX.footL].z;
  }

  reset(): void {
    this.hipOffset = 0;
    for (const f of this.feet) { f.offset = 0; f.planted = 0; f.normal.set(0, 1, 0); }
  }

  /**
   * @param weight 0 disables the solver but keeps its state decaying, so
   *               switching foot IK off mid-stride does not snap the legs.
   */
  update(dt: number, probe: GroundProbe | null, weight: number): void {
    const rig = this.rig;
    const hips = rig.byName.hips;
    const alpha = 1 - Math.exp(-dt / Math.max(this.smoothing, 1e-3));

    if (!probe || weight <= 0.001) {
      this.hipOffset += (0 - this.hipOffset) * alpha;
      for (const f of this.feet) f.offset += (0 - f.offset) * alpha;
      if (Math.abs(this.hipOffset) > 1e-4) {
        hips.position.y += this.hipOffset;
        rig.root.updateMatrixWorld(true);
      }
      return;
    }

    const ankles = [rig.byName.footL, rig.byName.footR];
    const toes = [rig.byName.toeL, rig.byName.toeR];
    const upperLegs = [rig.byName.upperLegL, rig.byName.upperLegR];
    const lowerLegs = [rig.byName.lowerLegL, rig.byName.lowerLegR];

    // 1. Probe.
    let lowest = 0;
    const wanted: number[] = [0, 0];
    const found: boolean[] = [false, false];
    for (let i = 0; i < 2; i++) {
      _ankle.setFromMatrixPosition(ankles[i].matrixWorld);
      const hit = probe(_ankle.x, _ankle.z, _ankle.y + 0.55, _sample);
      found[i] = hit;
      if (!hit) { wanted[i] = _ankle.y; continue; }

      // Use the toe probe to pick the higher of the two contacts, which is what
      // stops a foot sinking into the riser of a step.
      _toePos.setFromMatrixPosition(toes[i].matrixWorld);
      const toeHit = probe(_toePos.x, _toePos.z, _toePos.y + 0.55, _toe);
      const groundY = toeHit ? Math.max(_sample.y, _toe.y - 0.02) : _sample.y;

      const desired = groundY + this.ankleHeight;
      wanted[i] = desired;
      const delta = desired - _ankle.y;
      lowest = Math.min(lowest, delta);

      _n.copy(_sample.normal);
      if (toeHit) _n.add(_toe.normal).normalize();
      this.feet[i].normal.lerp(_n, alpha).normalize();
      // Planted when the animation has the foot close to the surface.
      const closeness = 1 - THREE.MathUtils.clamp((_ankle.y - desired) / 0.14, 0, 1);
      this.feet[i].planted += (closeness - this.feet[i].planted) * alpha;
    }

    // 2. Hip adjustment — the pelvis drops to the lower foot.
    const targetHip = THREE.MathUtils.clamp(lowest, -this.maxHipDrop, 0) * weight;
    this.hipOffset += (targetHip - this.hipOffset) * alpha;
    if (Math.abs(this.hipOffset) > 1e-4) {
      hips.position.y += this.hipOffset;
      rig.root.updateMatrixWorld(true);
    }

    // 3. Solve each leg to the probed height.
    for (let i = 0; i < 2; i++) {
      if (!found[i]) {
        this.feet[i].offset += (0 - this.feet[i].offset) * alpha;
        continue;
      }
      _ankle.setFromMatrixPosition(ankles[i].matrixWorld);
      const delta = wanted[i] - _ankle.y;
      this.feet[i].offset += (delta - this.feet[i].offset) * alpha;
      const off = this.feet[i].offset * weight;
      if (Math.abs(off) < 0.0015) continue;

      _target.copy(_ankle);
      _target.y += off;

      // Knee points along the direction the shin already leans, biased forward.
      _pole.setFromMatrixPosition(lowerLegs[i].matrixWorld);
      _pole.sub(_ankle).setY(0);
      if (_pole.lengthSq() < 1e-6) _pole.set(0, 0, 1);
      _pole.normalize().multiplyScalar(0.6);
      _pole.add(_ankle);
      _pole.y += 0.35;

      twoBoneIK(upperLegs[i], lowerLegs[i], ankles[i], _target, { pole: _pole, weight: 1 });

      // 4. Roll the ankle onto the surface.
      const rollW = this.feet[i].planted * weight;
      if (rollW > 0.01) {
        _up.set(0, 1, 0).applyQuaternion(ankles[i].getWorldQuaternion(_qw));
        _n.copy(this.feet[i].normal);
        const dot = THREE.MathUtils.clamp(_up.dot(_n), -1, 1);
        if (Math.acos(dot) > 0.005) {
          _q.setFromUnitVectors(_up, _n);
          const ang = 2 * Math.acos(THREE.MathUtils.clamp(_q.w, -1, 1));
          if (ang > this.maxRoll) {
            const t = this.maxRoll / ang;
            _q.slerp(IDENT, 1 - t);
          }
          if (rollW < 1) _q.slerp(IDENT, 1 - rollW);
          _qw.premultiply(_q);
          const parent = ankles[i].parent;
          if (parent) {
            parent.getWorldQuaternion(_qp).invert();
            _qw.premultiply(_qp);
          }
          ankles[i].quaternion.copy(_qw);
          ankles[i].updateMatrixWorld(true);
        }
      }
    }
  }

  /** Current pelvis drop, so callers can offset a capsule or camera. */
  get pelvisDrop(): number { return this.hipOffset; }
  get forwardReach(): number { return this.toeReach; }
}

const IDENT = new THREE.Quaternion();

/** A flat-ground probe — the fallback when no physics world is available. */
export function flatGround(y = 0): GroundProbe {
  return (_x, _z, _fromY, out) => {
    out.y = y;
    out.normal.set(0, 1, 0);
    return true;
  };
}

/** Builds a probe from an analytic height function; used by the debug scene. */
export function heightFieldProbe(
  height: (x: number, z: number) => number, eps = 0.08,
): GroundProbe {
  return (x, z, _fromY, out) => {
    const h = height(x, z);
    const hx = height(x + eps, z) - height(x - eps, z);
    const hz = height(x, z + eps) - height(x, z - eps);
    out.y = h;
    out.normal.set(-hx, 2 * eps, -hz).normalize();
    return true;
  };
}
