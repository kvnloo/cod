/**
 * Foot IK: plants both feet on whatever the character is standing on.
 *
 * Four things happen every frame, in this order, because each depends on the
 * last: probe the ground under each animated foot; decide which feet are in
 * *contact* and anchor those to a world-space point; drop the pelvis far enough
 * that the lower foot can reach without the leg hyper-extending; then solve
 * each leg to its target and roll the ankle onto the surface normal.
 *
 * The anchor is the part that stops foot sliding, and it is not optional. A
 * locomotion cycle is authored in the *character's* frame: the stance foot
 * travels backward relative to the pelvis while the pelvis travels forward
 * through the world, and the two cancel only if the animation's stride length
 * exactly matches the distance the controller moved this frame. It never does —
 * the blend tree is mixing walk against run against strafe, the controller is
 * on a slope, the character is turning. Measured on the walk cycle at its own
 * nominal speed, the stance foot drifted 91 mm through the floor per step
 * before this existed. So instead of hoping the numbers cancel, a foot that
 * touches down records where it touched down and the solver holds it there
 * until the animation genuinely lifts it, drags it past `maxDrag`, or runs the
 * leg out of reach.
 *
 * Hysteresis matters more than the thresholds do. Contact is entered at
 * `contactHeight` and left at `releaseHeight`, roughly twice as high, because a
 * single threshold makes a foot chatter in and out of its anchor across the
 * two or three frames either side of touchdown, and a chattering anchor looks
 * far worse than a sliding one.
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
  /** World point this foot is pinned to while it is in contact. */
  lock: THREE.Vector3;
  /** Whether the anchor is currently held. */
  locked: boolean;
  /** 0..1 blend of the anchor into the IK target; ramped, never switched. */
  lockW: number;
  /** Blocks an immediate re-anchor after a drag/reach release. */
  cooldown: number;
  /** Root position when the anchor was taken; the drag budget grows from it. */
  lockRoot: THREE.Vector3;
  /** Previous frame's animated ankle, for the touchdown speed test. */
  prev: THREE.Vector3;
  hasPrev: boolean;
}

const _sample: GroundSample = { y: 0, normal: new THREE.Vector3(0, 1, 0) };
const _toe: GroundSample = { y: 0, normal: new THREE.Vector3(0, 1, 0) };
const _ankle = new THREE.Vector3();
const _toePos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _rootPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _n = new THREE.Vector3();

export class FootIK {
  /** Maximum distance the pelvis may be dropped, metres. */
  maxHipDrop = 0.34;
  /** Maximum ankle roll onto a slope, radians. */
  maxRoll = 0.42;
  /** Vertical smoothing time constant, seconds. */
  smoothing = 0.09;
  /** How much faster a foot below the surface is corrected than one above it. */
  sinkUrgency = 3;

  /** Master switch for the planted-foot anchor. */
  plantLock = true;
  /** Ankle height above the ground at which a foot takes an anchor, metres. */
  contactHeight: number;
  /** Ankle height at which it lets go again. Must exceed `contactHeight`. */
  releaseHeight: number;
  /**
   * Hard ceiling on how far the animation may pull the ankle from its anchor.
   * The *working* budget is `min(maxDrag, rootTravel + dragSlack)`, which is
   * the rule that makes the anchor safe: a foot may only lag as far as the
   * body has actually travelled since it touched down. Holding a foot while
   * the body is stationary is never right — that case is a stance change
   * (crouching, turning, a strafe cycle repositioning the stance) and the
   * animation means it. Without this the anchor pinned a standing foot through
   * a whole crouch transition and then snapped it 131 mm when the safety valve
   * finally fired.
   */
  maxDrag: number;
  /** Drag allowed with the body stationary, metres. */
  dragSlack = 0.045;
  /**
   * A foot may only take an anchor once it has stopped travelling. Height
   * alone is not enough: the walk cycle reaches the heel forward *below* its
   * own nominal ankle height for the last 60 ms before touchdown, so a pure
   * height test grabs an anchor at 3.7 m/s and then has to throw it away three
   * frames later. Threshold is `max(plantSpeedFloor, plantSpeedRatio × body
   * speed)` so it scales from a crouch-shuffle to a sprint.
   */
  plantSpeedFloor = 0.30;
  plantSpeedRatio = 0.55;
  /** Fraction of the straight leg the anchor may sit from the hip. */
  maxReach = 0.98;
  /** Yaw rate above which anchors are abandoned, rad/s — a hard pivot. */
  maxTurnRate = 4.5;
  /** Root displacement in one step that counts as a teleport, metres. */
  teleportDistance = 0.55;
  /** Anchor blend-in / blend-out time constants, seconds. */
  lockIn = 0.035;
  lockOut = 0.06;

  private feet: FootState[] = [makeFoot(), makeFoot()];
  private hipOffset = 0;
  /** Bind-pose ankle height above the sole, scaled. */
  private ankleHeight: number;
  private toeReach: number;
  /** Hip → ankle distance with the leg straight; the anchor's reach budget. */
  private legLength: number;
  private lastRootPos = new THREE.Vector3();
  private lastRootYaw = 0;
  private hasRootRef = false;
  private above: [number, number] = [0, 0];
  private footSpeed: [number, number] = [0, 0];
  private rootSpeed = 0;

  constructor(private rig: RigInstance) {
    this.ankleHeight = rig.bindPos[BONE_INDEX.footL].y;
    this.toeReach = rig.bindPos[BONE_INDEX.toeL].z - rig.bindPos[BONE_INDEX.footL].z;
    this.legLength =
      rig.bindPos[BONE_INDEX.upperLegL].distanceTo(rig.bindPos[BONE_INDEX.lowerLegL])
      + rig.bindPos[BONE_INDEX.lowerLegL].distanceTo(rig.bindPos[BONE_INDEX.footL]);
    // Thresholds are authored against the 1.80 m reference soldier and scale
    // with the actual rig, so a short militiaman and a juggernaut plant alike.
    const s = this.ankleHeight / 0.085;
    this.contactHeight = 0.032 * s;
    this.releaseHeight = 0.060 * s;
    this.maxDrag = 0.42 * s;
  }

  reset(): void {
    this.hipOffset = 0;
    this.hasRootRef = false;
    for (const f of this.feet) {
      f.offset = 0; f.planted = 0; f.normal.set(0, 1, 0);
      f.locked = false; f.lockW = 0; f.cooldown = 0; f.hasPrev = false;
    }
  }

  /** Drops every anchor without disturbing the vertical solve. */
  releaseLocks(): void {
    for (const f of this.feet) { f.locked = false; f.lockW = 0; }
  }

  /**
   * @param weight 0 disables the solver but keeps its state decaying, so
   *               switching foot IK off mid-stride does not snap the legs.
   */
  update(dt: number, probe: GroundProbe | null, weight: number): void {
    const rig = this.rig;
    const hips = rig.byName.hips;
    const alpha = 1 - Math.exp(-dt / Math.max(this.smoothing, 1e-3));
    const sinkAlpha = 1 - Math.exp(-dt / Math.max(this.smoothing / this.sinkUrgency, 1e-3));

    if (!probe || weight <= 0.001) {
      this.hipOffset += (0 - this.hipOffset) * alpha;
      for (const f of this.feet) {
        f.offset += (0 - f.offset) * alpha;
        f.locked = false;
        f.lockW = 0;
      }
      this.hasRootRef = false;
      if (Math.abs(this.hipOffset) > 1e-4) {
        hips.position.y += this.hipOffset;
        rig.root.updateMatrixWorld(true);
      }
      return;
    }

    // 0. Root continuity. An anchor is a world-space promise, and a respawn,
    //    a vault teleport or a hard pivot all break it. `_rootPos` is left
    //    current for the drag-budget test below.
    if (this.rootBroke(dt) || !this.plantLock) this.releaseLocks();

    const ankles = [rig.byName.footL, rig.byName.footR];
    const toes = [rig.byName.toeL, rig.byName.toeR];
    const upperLegs = [rig.byName.upperLegL, rig.byName.upperLegR];
    const lowerLegs = [rig.byName.lowerLegL, rig.byName.lowerLegR];

    // 1. Probe.
    let lowest = 0;
    const wanted: number[] = [0, 0];
    const found: boolean[] = [false, false];
    const invDt = 1 / Math.max(dt, 1e-4);
    for (let i = 0; i < 2; i++) {
      const fs = this.feet[i];
      _ankle.setFromMatrixPosition(ankles[i].matrixWorld);
      this.footSpeed[i] = fs.hasPrev
        ? Math.hypot(_ankle.x - fs.prev.x, _ankle.z - fs.prev.z) * invDt
        : 0;
      fs.prev.copy(_ankle);
      fs.hasPrev = true;
      const hit = probe(_ankle.x, _ankle.z, _ankle.y + 0.55, _sample);
      found[i] = hit;
      if (!hit) { wanted[i] = _ankle.y; this.above[i] = 99; continue; }

      // Use the toe probe to pick the higher of the two contacts, which is what
      // stops a foot sinking into the riser of a step.
      _toePos.setFromMatrixPosition(toes[i].matrixWorld);
      const toeHit = probe(_toePos.x, _toePos.z, _toePos.y + 0.55, _toe);
      const groundY = toeHit ? Math.max(_sample.y, _toe.y - 0.02) : _sample.y;

      const desired = groundY + this.ankleHeight;
      wanted[i] = desired;
      const delta = desired - _ankle.y;
      this.above[i] = -delta;
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

    // 3. Solve each leg to the probed height, pinned to its anchor if it has one.
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (!found[i]) {
        // Airborne, or standing over a hole. Nothing to be anchored to.
        f.offset += (0 - f.offset) * alpha;
        f.locked = false;
        f.lockW += (0 - f.lockW) * (1 - Math.exp(-dt / this.lockOut));
        continue;
      }
      _ankle.setFromMatrixPosition(ankles[i].matrixWorld);
      const delta = wanted[i] - _ankle.y;
      // The two directions are not the same problem.
      //
      // Pushing a foot UP is anti-penetration: always correct, always urgent,
      // so it runs at `sinkUrgency` times the normal rate.
      //
      // Pulling a foot DOWN is only correct for a foot that is *supposed* to be
      // on the ground. Applying it unconditionally to both feet every frame is
      // what dragged the run cycle's recovering ankle 70 mm under the floor:
      // the solver was told to put both feet on the surface, and it obeyed —
      // including the one halfway through its swing 285 mm in the air. Scaling
      // it by plant confidence is the planted-foot logic the solver was
      // missing; a swing foot now simply plays the animation.
      const plantW = Math.max(f.lockW, f.planted);
      const want = delta > 0 ? delta : delta * plantW;
      const k = delta > 0 ? sinkAlpha : alpha;
      f.offset += (want - f.offset) * k;
      const off = f.offset * weight;

      // Contact test. The `other + 0.05` term is what keeps the *swing* foot
      // out of an anchor on a shuffling gait whose ankle never rises far: the
      // trailing foot only anchors while it is the lower of the two.
      _hip.setFromMatrixPosition(upperLegs[i].matrixWorld);
      const plantSpeed = Math.max(this.plantSpeedFloor, this.plantSpeedRatio * this.rootSpeed);
      const contact = this.plantLock && weight > 0.2
        && this.above[i] < this.contactHeight
        && this.above[i] <= this.above[1 - i] + 0.05
        && (this.footSpeed[i] < plantSpeed || this.feet[i].locked);
      this.stepLock(f, dt, contact, this.above[i], _ankle.x, wanted[i], _ankle.z);

      const lw = f.lockW * weight;
      if (Math.abs(off) < 0.0015 && lw < 0.002) continue;

      _target.copy(_ankle);
      _target.y += off;
      if (lw > 0.002) {
        _target.x += (f.lock.x - _target.x) * lw;
        _target.y += (f.lock.y - _target.y) * lw;
        _target.z += (f.lock.z - _target.z) * lw;
      }

      // Knee points along the direction the shin already leans, biased forward.
      _pole.setFromMatrixPosition(lowerLegs[i].matrixWorld);
      _pole.sub(_ankle).setY(0);
      if (_pole.lengthSq() < 1e-6) _pole.set(0, 0, 1);
      _pole.normalize().multiplyScalar(0.6);
      _pole.add(_ankle);
      _pole.y += 0.35;

      twoBoneIK(upperLegs[i], lowerLegs[i], ankles[i], _target, { pole: _pole, weight: 1 });

      // 4. Roll the ankle onto the surface.
      const rollW = Math.max(f.planted, f.lockW) * weight;
      if (rollW > 0.01) {
        _up.set(0, 1, 0).applyQuaternion(ankles[i].getWorldQuaternion(_qw));
        _n.copy(f.normal);
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

  /**
   * Anchor state machine for one foot. Split out because every branch has to
   * end at the same blend update — an early return here is how a foot ends up
   * with a stale `lockW` and skates for a frame.
   */
  private stepLock(
    f: FootState, dt: number, contact: boolean,
    above: number, x: number, y: number, z: number,
  ): void {
    if (f.locked) {
      const drag = Math.hypot(x - f.lock.x, z - f.lock.z);
      const travel = Math.hypot(_rootPos.x - f.lockRoot.x, _rootPos.z - f.lockRoot.z);
      const budget = Math.min(this.maxDrag, travel + this.dragSlack);
      const reach = _hip.distanceTo(f.lock);
      if (!contact && above > this.releaseHeight) {
        f.locked = false;
      } else if (drag > budget || reach > this.legLength * this.maxReach) {
        f.locked = false;
        f.cooldown = 0.05;
      }
    } else {
      f.cooldown -= dt;
      if (contact && f.cooldown <= 0) {
        f.locked = true;
        f.lock.set(x, y, z);
        f.lockRoot.copy(_rootPos);
      }
    }
    const tau = f.locked ? this.lockIn : this.lockOut;
    f.lockW += ((f.locked ? 1 : 0) - f.lockW) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
  }

  /** True when the character moved in a way no world-space anchor survives. */
  private rootBroke(dt: number): boolean {
    const root = this.rig.root;
    _rootPos.setFromMatrixPosition(root.matrixWorld);
    root.getWorldQuaternion(_qr);
    _fwd.set(0, 0, 1).applyQuaternion(_qr);
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    let broke = false;
    if (this.hasRootRef) {
      let dyaw = yaw - this.lastRootYaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const moved = _rootPos.distanceTo(this.lastRootPos);
      this.rootSpeed = moved / Math.max(dt, 1e-4);
      broke = moved > this.teleportDistance
        || Math.abs(dyaw) > this.maxTurnRate * Math.max(dt, 1e-4);
    } else {
      this.rootSpeed = 0;
    }
    this.lastRootPos.copy(_rootPos);
    this.lastRootYaw = yaw;
    this.hasRootRef = true;
    return broke;
  }

  /** Current pelvis drop, so callers can offset a capsule or camera. */
  get pelvisDrop(): number { return this.hipOffset; }
  get forwardReach(): number { return this.toeReach; }
  /** 0..1 anchor strength per foot — 0 = left. Debug and gate surface. */
  lockWeight(foot: number): number { return this.feet[foot & 1].lockW; }
  /** World anchor for a foot; meaningless while `lockWeight` is 0. */
  lockPoint(foot: number, out: THREE.Vector3): THREE.Vector3 { return out.copy(this.feet[foot & 1].lock); }
}

const IDENT = new THREE.Quaternion();

function makeFoot(): FootState {
  return {
    offset: 0, normal: new THREE.Vector3(0, 1, 0), planted: 0,
    lock: new THREE.Vector3(), locked: false, lockW: 0, cooldown: 0,
    lockRoot: new THREE.Vector3(), prev: new THREE.Vector3(), hasPrev: false,
  };
}

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
