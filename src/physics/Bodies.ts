/**
 * Rigid-body wrapper: shape construction, the {@link BodyHandle} facade and
 * fixed-step → frame interpolation.
 *
 * The simulation runs at a fixed rate (120 Hz, or 60 Hz on the `low` preset) but
 * frames present at whatever the display does. Every body therefore keeps the
 * previous and current solver transforms and exposes the blend of the two, so a
 * 144 Hz present off a 120 Hz sim shows smooth motion instead of the 24 Hz beat
 * pattern you get from reading raw solver state.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { BodyDesc, BodyHandle } from './types';
import { LAYER } from './types';
import { groups, defaultMask, isSensorLayer, physMaterial } from './Layers';
import { surface } from '../core/Surfaces';

const rv = { x: 0, y: 0, z: 0 };
const rv2 = { x: 0, y: 0, z: 0 };
const rq = { x: 0, y: 0, z: 0, w: 1 };
const _pd = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pe = new THREE.Euler(0, 0, 0, 'YXZ');

/** Builds a Rapier collider descriptor from our backend-neutral shape union. */
export function colliderDescFor(shape: BodyDesc['shape']): RAPIER.ColliderDesc {
  switch (shape.type) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(shape.half[0], shape.half[1], shape.half[2]);
    case 'sphere':
      return RAPIER.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'cylinder':
      return RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    case 'trimesh':
      return RAPIER.ColliderDesc.trimesh(
        shape.vertices, shape.indices,
        RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES,
      );
    case 'convex': {
      const d = RAPIER.ColliderDesc.convexHull(shape.vertices);
      if (d) return d;
      // Degenerate point cloud — fall back to a bounding ball so the caller
      // still gets a body rather than an exception.
      let r = 0.05;
      for (let i = 0; i < shape.vertices.length; i += 3) {
        const x = shape.vertices[i], y = shape.vertices[i + 1], z = shape.vertices[i + 2];
        r = Math.max(r, Math.sqrt(x * x + y * y + z * z));
      }
      return RAPIER.ColliderDesc.ball(r);
    }
    case 'heightfield':
      return RAPIER.ColliderDesc.heightfield(
        shape.rows, shape.cols, shape.heights,
        { x: shape.scale[0], y: shape.scale[1], z: shape.scale[2] },
      );
  }
}

export function bodyDescFor(desc: BodyDesc): RAPIER.RigidBodyDesc {
  let d: RAPIER.RigidBodyDesc;
  switch (desc.kind) {
    case 'static': d = RAPIER.RigidBodyDesc.fixed(); break;
    case 'kinematic': d = RAPIER.RigidBodyDesc.kinematicPositionBased(); break;
    default: d = RAPIER.RigidBodyDesc.dynamic(); break;
  }
  const p = desc.position ?? [0, 0, 0];
  d.setTranslation(p[0], p[1], p[2]);
  const r = desc.rotation;
  if (r) d.setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] });
  if (desc.linearDamping !== undefined) d.setLinearDamping(desc.linearDamping);
  if (desc.angularDamping !== undefined) d.setAngularDamping(desc.angularDamping);
  if (desc.ccd) d.setCcdEnabled(true);
  // Soft CCD is cheap and stops small fast props from popping through floors.
  if (desc.kind === 'dynamic') d.setSoftCcdPrediction(0.25);
  // `sleepThreshold: 0` is the caller asking for a body that never sleeps.
  if (desc.sleepThreshold === 0) d.setCanSleep(false);
  return d;
}

/**
 * Concrete {@link BodyHandle}. `getPosition`/`getRotation` return the
 * interpolated presentation transform; `getSimPosition` returns the exact
 * solver state for gameplay logic that must not see a blend.
 */
export class RapierBody implements BodyHandle {
  readonly id: number;
  readonly desc: BodyDesc;
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];

  /** Ticks since this body last moved; used by the debris reaper. */
  idleTicks = 0;
  /** Seconds this body has existed — drives lifetime-based despawn. */
  age = 0;
  /** Optional despawn time in seconds; Infinity to persist. */
  lifetime = Infinity;
  removed = false;

  private prevPos = new THREE.Vector3();
  private prevRot = new THREE.Quaternion();
  private currPos = new THREE.Vector3();
  private currRot = new THREE.Quaternion();
  private kinematic: boolean;
  private onRemove: (b: RapierBody) => void;

  constructor(id: number, desc: BodyDesc, body: RAPIER.RigidBody, onRemove: (b: RapierBody) => void) {
    this.id = id;
    this.desc = desc;
    this.body = body;
    this.onRemove = onRemove;
    this.kinematic = desc.kind === 'kinematic';
    const t = body.translation();
    const r = body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currRot.set(r.x, r.y, r.z, r.w);
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
  }

  /** Snapshots the solver transform; called once per simulation step. */
  captureTransform(): void {
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currRot.set(r.x, r.y, r.z, r.w);
  }

  /** Distance travelled in the last step — the reaper's idle test. */
  stepDelta(): number {
    return this.currPos.distanceToSquared(this.prevPos);
  }

  /**
   * Displacement a world-space point rigidly attached to this body underwent
   * during the last step, and the yaw the body turned through. This is what
   * lets a character ride a moving platform without any special-casing in the
   * character controller.
   */
  pointDelta(point: THREE.Vector3, out: THREE.Vector3): number {
    out.set(0, 0, 0);
    const dp = this.currPos.distanceToSquared(this.prevPos);
    const dq = 1 - Math.abs(this.prevRot.dot(this.currRot));
    if (dp < 1e-12 && dq < 1e-9) return 0;

    // point → previous body space → current world space.
    _pd.copy(point).sub(this.prevPos);
    _pq.copy(this.prevRot).invert();
    _pd.applyQuaternion(_pq);
    _pd.applyQuaternion(this.currRot).add(this.currPos);
    out.copy(_pd).sub(point);

    // Yaw component of the rotation delta, for turntables and lifts.
    _pq.copy(this.prevRot).invert().premultiply(this.currRot);
    _pe.setFromQuaternion(_pq, 'YXZ');
    return _pe.y;
  }

  /** Writes the interpolated transform onto the attached scene object. */
  syncObject(alpha: number): void {
    const obj = this.desc.object;
    if (!obj) return;
    obj.position.lerpVectors(this.prevPos, this.currPos, alpha);
    obj.quaternion.copy(this.prevRot).slerp(this.currRot, alpha);
  }

  getPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.currPos);
  }

  getRotation(out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(this.currRot);
  }

  /** Interpolated presentation transform for a given blend factor. */
  getInterpolatedPosition(out: THREE.Vector3, alpha: number): THREE.Vector3 {
    return out.lerpVectors(this.prevPos, this.currPos, alpha);
  }

  getInterpolatedRotation(out: THREE.Quaternion, alpha: number): THREE.Quaternion {
    return out.copy(this.prevRot).slerp(this.currRot, alpha);
  }

  setTransform(p: THREE.Vector3, q: THREE.Quaternion): void {
    if (this.removed) return;
    rv.x = p.x; rv.y = p.y; rv.z = p.z;
    rq.x = q.x; rq.y = q.y; rq.z = q.z; rq.w = q.w;
    if (this.kinematic) {
      this.body.setNextKinematicTranslation(rv);
      this.body.setNextKinematicRotation(rq);
    } else {
      this.body.setTranslation(rv, true);
      this.body.setRotation(rq, true);
    }
    this.currPos.copy(p); this.currRot.copy(q);
    this.prevPos.copy(p); this.prevRot.copy(q);
  }

  setLinearVelocity(v: THREE.Vector3): void {
    if (this.removed) return;
    rv.x = v.x; rv.y = v.y; rv.z = v.z;
    this.body.setLinvel(rv, true);
  }

  getLinearVelocity(out: THREE.Vector3): THREE.Vector3 {
    if (this.removed) return out.set(0, 0, 0);
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  setAngularVelocity(v: THREE.Vector3): void {
    if (this.removed) return;
    rv.x = v.x; rv.y = v.y; rv.z = v.z;
    this.body.setAngvel(rv, true);
  }

  applyImpulse(impulse: THREE.Vector3, atPoint?: THREE.Vector3): void {
    if (this.removed || !this.body.isDynamic()) return;
    rv.x = impulse.x; rv.y = impulse.y; rv.z = impulse.z;
    if (atPoint) {
      rv2.x = atPoint.x; rv2.y = atPoint.y; rv2.z = atPoint.z;
      this.body.applyImpulseAtPoint(rv, rv2, true);
    } else {
      this.body.applyImpulse(rv, true);
    }
  }

  applyTorqueImpulse(t: THREE.Vector3): void {
    if (this.removed || !this.body.isDynamic()) return;
    rv.x = t.x; rv.y = t.y; rv.z = t.z;
    this.body.applyTorqueImpulse(rv, true);
  }

  wake(): void { if (!this.removed) this.body.wakeUp(); }

  isSleeping(): boolean { return this.removed ? true : this.body.isSleeping(); }

  setEnabled(on: boolean): void {
    if (this.removed) return;
    this.body.setEnabled(on);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.onRemove(this);
  }
}

/** Applies the shared collider tuning from a {@link BodyDesc}. */
export function applyColliderProps(cd: RAPIER.ColliderDesc, desc: BodyDesc): RAPIER.ColliderDesc {
  const layer = desc.layer ?? (desc.kind === 'static' ? LAYER.STATIC : LAYER.DYNAMIC);
  const mask = desc.mask ?? defaultMask(layer);
  const props = surface(desc.surface);
  // Default the mass from the surface's density; `BodyDesc.mass` overrides it
  // afterwards. Without this a Rapier collider defaults to 1 kg/m³ and a crate
  // weighs 100 g.
  cd.setDensity(physMaterial(desc.surface).density);
  cd.setFriction(desc.friction ?? props.friction);
  cd.setRestitution(desc.restitution ?? props.restitution);
  cd.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
  cd.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
  cd.setCollisionGroups(groups(layer, mask));
  cd.setSensor(desc.sensor ?? isSensorLayer(layer));
  cd.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
  // A hair of contact skin buys a lot of stacking stability for boxes.
  if (desc.kind === 'dynamic') cd.setContactSkin(0.002);
  return cd;
}
