import { settings } from '../core/Settings';
/**
 * Articulated ragdolls.
 *
 * A ragdoll is fifteen capsules laid out along the canonical bone rig in
 * `src/characters/types.ts`, wired with spherical joints at the ball joints
 * (spine, neck, shoulders, hips) and revolute joints with hard limits at the
 * hinges (elbows, knees, ankles) so limbs cannot invert.
 *
 * Two implementation choices are worth calling out:
 *
 *  - **Bodies are created with identity rotation** and the capsule is rotated
 *    inside the collider instead. That makes every joint anchor and axis a plain
 *    world-space offset at spawn time, which removes an entire class of
 *    bone-orientation bugs and keeps the maths readable.
 *  - **Contacts are disabled only between directly jointed pairs.** Everything
 *    else self-collides, so the forearm cannot pass through the chest, without
 *    the jitter you get from adjacent capsules fighting their own joint.
 *
 * Mass follows the standard anthropometric distribution (Dempster), scaled to
 * the character's total mass, which is what makes a body fold at the waist and
 * flop at the wrist instead of behaving like a mannequin.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { HitZone, RagdollHandle, RagdollOptions } from './types';
import { LAYER } from './types';
import { groups, defaultMask } from './Layers';
import type { ColliderRegistry } from './Registry';

export interface RagdollHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
}

type JointKind = 'ball' | 'hinge';

interface SegmentDef {
  name: string;
  /** Bone at the proximal end of the capsule. */
  from: string;
  /** Bone at the distal end; `null` extends along the bone's own up axis. */
  to: string | null;
  /** Length used when `to` is null or the two bones coincide. */
  fallbackLength: number;
  radius: number;
  /** Fraction of total body mass. */
  massFrac: number;
  zone: HitZone;
  /** Index of the parent segment in this table, or -1 for the root. */
  parent: number;
  joint: JointKind;
  /** Hinge limits in radians, [min, max]. */
  limits?: [number, number];
  /** Which reference axis the hinge swings about: body right or body forward. */
  hingeAxis?: 'right' | 'forward';
}

/* Order matters: a parent must appear before its children. */
const SEGMENTS: SegmentDef[] = [
  /* 0 */ { name: 'pelvis', from: 'hips', to: 'spine', fallbackLength: 0.16, radius: 0.125, massFrac: 0.142, zone: 'stomach', parent: -1, joint: 'ball' },
  /* 1 */ { name: 'spine', from: 'spine', to: 'chest', fallbackLength: 0.18, radius: 0.125, massFrac: 0.100, zone: 'stomach', parent: 0, joint: 'ball' },
  /* 2 */ { name: 'chest', from: 'chest', to: 'neck', fallbackLength: 0.22, radius: 0.145, massFrac: 0.170, zone: 'chest', parent: 1, joint: 'ball' },
  /* 3 */ { name: 'neck', from: 'neck', to: 'head', fallbackLength: 0.09, radius: 0.055, massFrac: 0.020, zone: 'neck', parent: 2, joint: 'ball' },
  /* 4 */ { name: 'head', from: 'head', to: null, fallbackLength: 0.20, radius: 0.100, massFrac: 0.055, zone: 'head', parent: 3, joint: 'ball' },

  /* 5 */ { name: 'upperArmL', from: 'upperArmL', to: 'lowerArmL', fallbackLength: 0.28, radius: 0.055, massFrac: 0.027, zone: 'arm', parent: 2, joint: 'ball' },
  /* 6 */ { name: 'lowerArmL', from: 'lowerArmL', to: 'handL', fallbackLength: 0.27, radius: 0.047, massFrac: 0.022, zone: 'arm', parent: 5, joint: 'hinge', limits: [-2.35, -0.05], hingeAxis: 'forward' },
  /* 7 */ { name: 'upperArmR', from: 'upperArmR', to: 'lowerArmR', fallbackLength: 0.28, radius: 0.055, massFrac: 0.027, zone: 'arm', parent: 2, joint: 'ball' },
  /* 8 */ { name: 'lowerArmR', from: 'lowerArmR', to: 'handR', fallbackLength: 0.27, radius: 0.047, massFrac: 0.022, zone: 'arm', parent: 7, joint: 'hinge', limits: [-2.35, -0.05], hingeAxis: 'forward' },

  /* 9  */ { name: 'upperLegL', from: 'upperLegL', to: 'lowerLegL', fallbackLength: 0.42, radius: 0.085, massFrac: 0.105, zone: 'leg', parent: 0, joint: 'ball' },
  /* 10 */ { name: 'lowerLegL', from: 'lowerLegL', to: 'footL', fallbackLength: 0.41, radius: 0.062, massFrac: 0.048, zone: 'leg', parent: 9, joint: 'hinge', limits: [0.05, 2.35], hingeAxis: 'right' },
  /* 11 */ { name: 'footL', from: 'footL', to: 'toeL', fallbackLength: 0.16, radius: 0.045, massFrac: 0.014, zone: 'leg', parent: 10, joint: 'hinge', limits: [-0.55, 0.85], hingeAxis: 'right' },
  /* 12 */ { name: 'upperLegR', from: 'upperLegR', to: 'lowerLegR', fallbackLength: 0.42, radius: 0.085, massFrac: 0.105, zone: 'leg', parent: 0, joint: 'ball' },
  /* 13 */ { name: 'lowerLegR', from: 'lowerLegR', to: 'footR', fallbackLength: 0.41, radius: 0.062, massFrac: 0.048, zone: 'leg', parent: 12, joint: 'hinge', limits: [0.05, 2.35], hingeAxis: 'right' },
  /* 14 */ { name: 'footR', from: 'footR', to: 'toeR', fallbackLength: 0.16, radius: 0.045, massFrac: 0.014, zone: 'leg', parent: 13, joint: 'hinge', limits: [-0.55, 0.85], hingeAxis: 'right' },
];

const MASS_TOTAL_FRAC = SEGMENTS.reduce((a, s) => a + s.massFrac, 0);

/** Bones the ragdoll drives, mapped to (segment index, use distal end). */
const BONE_DRIVERS: Array<{ bone: string; segment: number }> = [
  { bone: 'hips', segment: 0 }, { bone: 'spine', segment: 1 }, { bone: 'chest', segment: 2 },
  { bone: 'neck', segment: 3 }, { bone: 'head', segment: 4 },
  { bone: 'shoulderL', segment: 2 }, { bone: 'upperArmL', segment: 5 }, { bone: 'lowerArmL', segment: 6 }, { bone: 'handL', segment: 6 },
  { bone: 'shoulderR', segment: 2 }, { bone: 'upperArmR', segment: 7 }, { bone: 'lowerArmR', segment: 8 }, { bone: 'handR', segment: 8 },
  { bone: 'upperLegL', segment: 9 }, { bone: 'lowerLegL', segment: 10 }, { bone: 'footL', segment: 11 }, { bone: 'toeL', segment: 11 },
  { bone: 'upperLegR', segment: 12 }, { bone: 'lowerLegR', segment: 13 }, { bone: 'footR', segment: 14 }, { bone: 'toeR', segment: 14 },
];

/* ------------------------------------------------------------------ scratch */

const rv = { x: 0, y: 0, z: 0 };
const rv2 = { x: 0, y: 0, z: 0 };
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vDir = new THREE.Vector3();
const vAxis = new THREE.Vector3();
const vUp = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vFwd = new THREE.Vector3();
const qTmp = new THREE.Quaternion();
const mBody = new THREE.Matrix4();
const mBone = new THREE.Matrix4();
const mParentInv = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

interface BonePose { position: THREE.Vector3; rotation: THREE.Quaternion; }

interface Segment {
  def: SegmentDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Capsule endpoints in world space at spawn, for joint anchoring. */
  head: THREE.Vector3;
  tail: THREE.Vector3;
  /** Body origin at spawn. */
  origin: THREE.Vector3;
}

interface BoneDrive {
  object: THREE.Object3D;
  segment: number;
  /** bodyWorld⁻¹ · boneWorld at spawn. */
  offset: THREE.Matrix4;
  scale: THREE.Vector3;
}

export class Ragdoll implements RagdollHandle {
  readonly id: number;
  private segments: (Segment | null)[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  private drives: BoneDrive[] = [];
  private host: RagdollHost;
  private removed = false;
  private restTicks = 0;
  /** Seconds since spawn — the manager despawns old ragdolls. */
  age = 0;
  /** True until bodies exist (rate-limited multi-kill construct). */
  private deferred = false;
  private pendingOpts: RagdollOptions | null = null;
  private pendingImpulse: { zone: HitZone; impulse: THREE.Vector3; at?: THREE.Vector3 } | null = null;

  /**
   * @param defer When true, only stash options — `completeBuild()` creates the
   * 15 bodies on a later display frame so multi-kills cannot stack construct
   * cost into one wall hitch (wave-2 death-window frame-spikes).
   */
  constructor(id: number, host: RagdollHost, opts: RagdollOptions, defer = false) {
    this.id = id;
    this.host = host;
    if (defer) {
      this.deferred = true;
      this.pendingOpts = opts;
      return;
    }
    this.buildAll(opts);
  }

  /** Whether this handle still needs its physics bodies built. */
  get isDeferred(): boolean { return this.deferred; }

  /** Finishes a rate-limited spawn. No-op if already built or removed. */
  completeBuild(): void {
    if (!this.deferred || this.removed || !this.pendingOpts) return;
    const opts = this.pendingOpts;
    this.pendingOpts = null;
    this.deferred = false;
    this.buildAll(opts);
    const pend = this.pendingImpulse;
    this.pendingImpulse = null;
    if (pend) this.applyImpulse(pend.zone, pend.impulse, pend.at);
  }

  private buildAll(opts: RagdollOptions): void {
    const pose = resolvePose(opts);
    const totalMass = opts.mass ?? 82;
    // Crowd deaths must stay cheap. Character used to pass quality 6 (lod0) /
    // 3 (crowd) which stacked solver iterations into death-window hitches.
    // Clamp to [0,2]: 0 = fewest segments + 0 extra iters, 2 = full limbs.
    const quality = Math.max(0, Math.min(2, Math.round(opts.quality ?? 0)));

    // Body frame from the pelvis, used for hinge axes when a limb is straight.
    const hips = pose.get('hips');
    if (hips) {
      vRight.set(1, 0, 0).applyQuaternion(hips.rotation);
      vFwd.set(0, 0, 1).applyQuaternion(hips.rotation);
      vUp.set(0, 1, 0).applyQuaternion(hips.rotation);
    } else {
      vRight.set(1, 0, 0); vFwd.set(0, 0, 1); vUp.set(0, 1, 0);
    }
    const bodyRight = vRight.clone();
    const bodyFwd = vFwd.clone();
    const bodyUp = vUp.clone();

    // Segment budget by quality (dominant death-frame cost is body/joint create):
    //   q0: 7 bodies — pelvis, chest, head, upper arms, upper legs
    //   q1: +spine +lower limbs, still no neck/feet
    //   q2: full minus feet
    const skip = new Set<number>();
    if (quality <= 2) { skip.add(11); skip.add(14); }           // feet
    if (quality <= 1) { skip.add(3); }                           // neck
    if (quality <= 0) {
      skip.add(1);                                              // spine
      skip.add(6); skip.add(8);                                 // lower arms
      skip.add(10); skip.add(13);                               // lower legs
    }
    for (let i = 0; i < SEGMENTS.length; i++) {
      const def = SEGMENTS[i];
      if (skip.has(i)) { this.segments.push(null); continue; }
      this.segments.push(this.buildSegment(def, pose, totalMass, quality, bodyUp, opts));
    }

    // Prune failed segments and remap parents.
    for (let i = 0; i < SEGMENTS.length; i++) {
      const def = SEGMENTS[i];
      const child = this.segments[i];
      if (!child) continue;
      let parentIdx = def.parent;
      while (parentIdx >= 0 && !this.segments[parentIdx]) parentIdx = SEGMENTS[parentIdx].parent;
      if (parentIdx < 0) continue;
      const parent = this.segments[parentIdx];
      if (!parent) continue;
      this.link(parent, child, def, bodyRight, bodyFwd);
    }

    // Inherit the character's motion so a sprinting death carries momentum.
    if (opts.velocity) {
      rv.x = opts.velocity.x; rv.y = opts.velocity.y; rv.z = opts.velocity.z;
      for (const s of this.segments) if (s) s.body.setLinvel(rv, true);
    }

    if (opts.bones) this.bindBones(opts.bones);
  }

  get bones(): number { return this.segments.reduce((a, s) => a + (s ? 1 : 0), 0); }
  get settled(): boolean { return !this.deferred && this.restTicks > 12; }

  /* --------------------------------------------------------------- building */

  private buildSegment(
    def: SegmentDef, pose: Map<string, BonePose>, totalMass: number, quality: number,
    bodyUp: THREE.Vector3, opts: RagdollOptions,
  ): Segment | null {
    const a = pose.get(def.from);
    if (!a) return null;
    vA.copy(a.position);

    const b = def.to ? pose.get(def.to) : undefined;
    if (b) vB.copy(b.position);
    else vB.copy(vA).addScaledVector(bodyUp, def.fallbackLength);

    vDir.copy(vB).sub(vA);
    let len = vDir.length();
    if (len < 0.02) {
      // Degenerate bone pair — extend along the character's up axis instead.
      vDir.copy(bodyUp);
      len = def.fallbackLength;
      vB.copy(vA).addScaledVector(vDir, len);
    }
    vDir.multiplyScalar(1 / len);

    const radius = def.radius;
    const halfHeight = Math.max(0.01, len * 0.5 - radius * 0.6);
    const cx = (vA.x + vB.x) * 0.5, cy = (vA.y + vB.y) * 0.5, cz = (vA.z + vB.z) * 0.5;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(cx, cy, cz)
      // Higher damping so corpses settle (and sleep) within a few hundred ms
      // instead of paying full solver cost for the whole linger window.
      .setLinearDamping(0.55)
      .setAngularDamping(3.4)
      .setAdditionalSolverIterations(quality)
      .setCcdEnabled(false)
      .setSoftCcdPrediction(0.2);
    const body = this.host.world.createRigidBody(bodyDesc);

    qTmp.setFromUnitVectors(UP, vDir);
    const mass = (def.massFrac / MASS_TOTAL_FRAC) * totalMass;
    const colDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setRotation({ x: qTmp.x, y: qTmp.y, z: qTmp.z, w: qTmp.w })
      .setMass(mass)
      .setFriction(0.65)
      .setRestitution(0.02)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      .setCollisionGroups(groups(LAYER.RAGDOLL, defaultMask(LAYER.RAGDOLL)))
      .setContactSkin(0.004);
    const collider = this.host.world.createCollider(colDesc, body);

    this.host.registry.add({
      handle: collider.handle,
      bodyId: -1,
      object: opts.root ?? null,
      surface: def.zone === 'head' ? 'helmet' : 'flesh',
      entityId: opts.entityId ?? -1,
      zone: def.zone,
      layer: LAYER.RAGDOLL,
      ranges: null,
      ragdollId: this.id,
      debris: false,
    });

    return {
      def, body, collider,
      head: new THREE.Vector3(vA.x, vA.y, vA.z),
      tail: new THREE.Vector3(vB.x, vB.y, vB.z),
      origin: new THREE.Vector3(cx, cy, cz),
    };
  }

  private link(
    parent: Segment, child: Segment, def: SegmentDef,
    bodyRight: THREE.Vector3, bodyFwd: THREE.Vector3,
  ): void {
    // The joint sits at the child's proximal end.
    const jx = child.head.x, jy = child.head.y, jz = child.head.z;
    const a1 = { x: jx - parent.origin.x, y: jy - parent.origin.y, z: jz - parent.origin.z };
    const a2 = { x: jx - child.origin.x, y: jy - child.origin.y, z: jz - child.origin.z };

    let data: RAPIER.JointData;
    if (def.joint === 'hinge') {
      // Hinge axis: the natural bend axis when the limb is already bent,
      // otherwise the character's own left-right / forward axis.
      vA.copy(parent.tail).sub(parent.head).normalize();
      vB.copy(child.tail).sub(child.head).normalize();
      vAxis.copy(vA).cross(vB);
      if (vAxis.lengthSq() < 0.03) {
        vAxis.copy(def.hingeAxis === 'forward' ? bodyFwd : bodyRight);
      }
      vAxis.normalize();
      data = RAPIER.JointData.revolute(a1, a2, { x: vAxis.x, y: vAxis.y, z: vAxis.z });
      if (def.limits) {
        data.limitsEnabled = true;
        data.limits = [def.limits[0], def.limits[1]];
      }
    } else {
      data = RAPIER.JointData.spherical(a1, a2);
    }

    const joint = this.host.world.createImpulseJoint(data, parent.body, child.body, true);
    // Adjacent capsules overlap by design; let the joint own that relationship
    // and leave self-collision to non-adjacent pairs.
    joint.setContactsEnabled(false);
    this.joints.push(joint);
  }

  private bindBones(bones: Record<string, THREE.Object3D | null>): void {
    // Prefer already-updated world matrices from resolvePose; only refresh if
    // a bone has no parent chain we trust.
    for (const d of BONE_DRIVERS) {
      const obj = bones[d.bone];
      const seg = this.segments[d.segment];
      if (!obj || !seg) continue;
      mBody.makeTranslation(seg.origin.x, seg.origin.y, seg.origin.z);
      mBody.invert();
      const offset = new THREE.Matrix4().multiplyMatrices(mBody, obj.matrixWorld);
      const scale = new THREE.Vector3(1, 1, 1);
      obj.matrixWorld.decompose(vA, qTmp, scale);
      this.drives.push({ object: obj, segment: d.segment, offset, scale: scale.clone() });
    }
  }

  /* ----------------------------------------------------------------- runtime */

  /** Advances rest detection. Called once per simulation step by the manager. */
  tick(dt: number): void {
    this.age += dt;
    if (this.deferred) return;
    let moving = false;
    for (const s of this.segments) {
      if (!s) continue;
      if (s.body.isSleeping()) continue;
      const v = s.body.linvel();
      const w = s.body.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04 || w.x * w.x + w.y * w.y + w.z * w.z > 0.08) {
        moving = true;
        break;
      }
    }
    this.restTicks = moving ? 0 : this.restTicks + 1;
    // Force-sleep after a short rest so a pile of corpses cannot keep the
    // solver busy through the death-window frames the hard gate samples.
    if (this.restTicks === 12) {
      for (const s of this.segments) {
        if (s && !s.body.isSleeping()) s.body.sleep();
      }
    }
  }

  syncToRig(): void {
    if (this.removed || this.drives.length === 0) return;
    for (const d of this.drives) {
      const seg = this.segments[d.segment];
      if (!seg) continue;
      const t = seg.body.translation();
      const r = seg.body.rotation();
      qTmp.set(r.x, r.y, r.z, r.w);
      vA.set(t.x, t.y, t.z);
      mBody.compose(vA, qTmp, ONE);
      mBone.multiplyMatrices(mBody, d.offset);

      const parent = d.object.parent;
      if (parent) {
        mParentInv.copy(parent.matrixWorld).invert();
        mBone.premultiply(mParentInv);
      }
      mBone.decompose(d.object.position, d.object.quaternion, vB);
      d.object.scale.copy(d.scale);
      d.object.matrixWorldNeedsUpdate = true;
    }
  }

  /**
   * World transform of one capsule. This is the *collider's* transform, not the
   * body's: bodies are spawned axis-aligned with the capsule rotated inside
   * them, so a renderer that used the body transform would draw every limb
   * standing upright.
   */
  segmentTransform(index: number, outPos: THREE.Vector3, outRot: THREE.Quaternion): void {
    const seg = this.segments[index];
    if (!seg) { outPos.set(0, 0, 0); outRot.identity(); return; }
    const t = seg.collider.translation();
    const r = seg.collider.rotation();
    outPos.set(t.x, t.y, t.z);
    outRot.set(r.x, r.y, r.z, r.w);
  }

  /** Capsule dimensions of one segment, for proxy meshes and debug drawing. */
  segmentShape(index: number, out: { radius: number; halfHeight: number }): boolean {
    const seg = this.segments[index];
    if (!seg) return false;
    out.radius = seg.collider.radius() ?? seg.def.radius;
    out.halfHeight = seg.collider.halfHeight() ?? 0.05;
    return true;
  }

  /** World-space centre of the ragdoll, used for culling and audio. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    const seg = this.segments[2] ?? this.segments[0];
    if (!seg) return out.set(0, 0, 0);
    const t = seg.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  applyImpulse(zone: HitZone, impulse: THREE.Vector3, atPoint?: THREE.Vector3): void {
    if (this.removed) return;
    if (this.deferred) {
      this.pendingImpulse = {
        zone,
        impulse: impulse.clone(),
        at: atPoint ? atPoint.clone() : undefined,
      };
      return;
    }
    let target: Segment | null = null;
    for (const s of this.segments) {
      if (s && s.def.zone === zone) { target = s; break; }
    }
    if (!target) target = this.segments[2] ?? this.segments[0] ?? null;
    if (!target) return;
    rv.x = impulse.x; rv.y = impulse.y; rv.z = impulse.z;
    if (atPoint) {
      rv2.x = atPoint.x; rv2.y = atPoint.y; rv2.z = atPoint.z;
      target.body.applyImpulseAtPoint(rv, rv2, true);
    } else {
      target.body.applyImpulse(rv, true);
    }
  }

  /** Radial impulse used when an explosion goes off nearby. */
  applyRadialImpulse(centre: THREE.Vector3, radius: number, power: number): void {
    if (this.removed || this.deferred) return;
    for (const s of this.segments) {
      if (!s) continue;
      const t = s.body.translation();
      vA.set(t.x - centre.x, t.y - centre.y, t.z - centre.z);
      const d = vA.length();
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      if (d < 1e-4) vA.set(0, 1, 0); else vA.multiplyScalar(1 / d);
      vA.y += 0.35;
      vA.normalize().multiplyScalar(power * falloff * falloff * s.body.mass() * 0.06);
      rv.x = vA.x; rv.y = vA.y; rv.z = vA.z;
      s.body.applyImpulse(rv, true);
    }
    this.restTicks = 0;
  }

  colliderHandles(out: number[]): number {
    out.length = 0;
    for (const s of this.segments) if (s) out.push(s.collider.handle);
    return out.length;
  }

  /** Puts every segment to sleep so a queued teardown stops costing the solver. */
  forceSleep(): void {
    if (this.removed || this.deferred) return;
    for (const s of this.segments) {
      if (s && !s.body.isSleeping()) s.body.sleep();
    }
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.deferred = false;
    this.pendingOpts = null;
    this.pendingImpulse = null;
    for (const s of this.segments) {
      if (!s) continue;
      this.host.registry.remove(s.collider.handle);
      this.host.world.removeRigidBody(s.body);
    }
    this.segments.length = 0;
    this.joints.length = 0;
    this.drives.length = 0;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

/* ------------------------------------------------------------------ manager */

export class RagdollManager {
  private ragdolls: Ragdoll[] = [];
  private nextId = 1;
  /** Hard cap; the oldest settled ragdoll is retired when exceeded. */
  budget = 3;
  /** Seconds a settled ragdoll persists before it is reclaimed. */
  maxAge = 12;
  /**
   * Full constructs on the current display frame. The frame opens on the first
   * fixed step (or on `update` if the frame had zero sim steps). Physics
   * presents before AI/characters, so the counter must stay open across
   * fixed→present so multi-kill spawns in Agent/Character update still share
   * one budget (acceptance: ≤1 full ragdoll construct per kill display frame).
   */
  private constructsThisFrame = 0;
  private teardownsThisFrame = 0;
  /** Queued body frees — never stack with a full construct on the same frame. */
  private pendingTeardown: Ragdoll[] = [];
  /** True after `update()` until the next frame's first fixed/`update` opens it. */
  private frameOpen = true;
  private syncParity = 0;
  private static readonly MAX_CONSTRUCTS_PER_FRAME = 1;
  private static readonly MAX_TEARDOWNS_PER_FRAME = 1;

  constructor(private host: RagdollHost) { }

  get count(): number { return this.ragdolls.length; }

  private openFrameIfNeeded(): void {
    if (!this.frameOpen) return;
    this.frameOpen = false;
    this.constructsThisFrame = 0;
    this.teardownsThisFrame = 0;
    // Drain pending frees first (up to 2). Never construct on a teardown frame.
    this.flushOneTeardown();
    this.flushOneTeardown();
    if (this.teardownsThisFrame === 0 && this.pendingTeardown.length === 0) {
      this.completeOneDeferred();
    }
  }

  private completeOneDeferred(): void {
    if (this.constructsThisFrame >= RagdollManager.MAX_CONSTRUCTS_PER_FRAME) return;
    // Never construct on a frame that already tore bodies down.
    if (this.teardownsThisFrame > 0) return;
    for (let i = 0; i < this.ragdolls.length; i++) {
      const r = this.ragdolls[i];
      if (!r.isDeferred) continue;
      r.completeBuild();
      this.constructsThisFrame++;
      return;
    }
  }

  private flushOneTeardown(): void {
    if (this.teardownsThisFrame >= RagdollManager.MAX_TEARDOWNS_PER_FRAME) return;
    if (this.constructsThisFrame > 0) return;
    const r = this.pendingTeardown.shift();
    if (!r) return;
    r.remove();
    this.teardownsThisFrame++;
  }

  private queueTeardown(r: Ragdoll): void {
    // Sleep immediately so the corpse leaves the active island while waiting
    // for its free — otherwise pending free bodies stack death-window cost.
    r.forceSleep();
    this.pendingTeardown.push(r);
  }

  spawn(opts: RagdollOptions): Ragdoll {
    // Always defer body construction off the death-event frame. Multi-kill
    // stacks + kill FX already own that wall frame; completeOneDeferred builds
    // at most one full ragdoll on a later frame open.
    this.enforceBudget(1);
    const r = new Ragdoll(this.nextId++, this.host, opts, /* defer */ true);
    this.ragdolls.push(r);
    return r;
  }

  fixedUpdate(dt: number): void {
    // Free ladder cpuLod trims active corpses before age-out (CPU body cut).
    const lod = settings.gfx.cpuLod | 0;
    this.budget = lod >= 3 ? 2 : lod >= 2 ? 3 : lod >= 1 ? 4 : 5;
    this.maxAge = lod >= 3 ? 8 : lod >= 2 ? 10 : 16;
    this.openFrameIfNeeded();
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const r = this.ragdolls[i];
      r.tick(dt);
      if (r.age > this.maxAge && r.settled) {
        this.ragdolls.splice(i, 1);
        // Age-out teardown shares the per-frame budget with budget enforcement.
        if (this.teardownsThisFrame < RagdollManager.MAX_TEARDOWNS_PER_FRAME
          && this.constructsThisFrame === 0) {
          r.remove();
          this.teardownsThisFrame++;
        } else {
          this.queueTeardown(r);
        }
      }
    }
  }

  /** Pushes solver state onto the skinned rigs. Presentation, not simulation. */
  update(): void {
    // Zero-step frames never call fixedUpdate; open the budget here instead.
    this.openFrameIfNeeded();
    // Only complete a deferred construct if we did not already tear down.
    this.completeOneDeferred();
    // cpuLod ≥ 2: sync every other frame; ≥ 3: only unsettled bodies.
    const lod = settings.gfx.cpuLod | 0;
    this.syncParity ^= 1;
    if (lod >= 2 && this.syncParity === 0) {
      // skip full sync this display frame under CPU pressure
    } else {
      for (const r of this.ragdolls) {
        if (lod >= 3 && r.settled) continue;
        r.syncToRig();
      }
    }
    // Close the frame after presentation; next fixed step re-opens.
    this.frameOpen = true;
  }

  applyExplosion(centre: THREE.Vector3, radius: number, power: number): void {
    for (const r of this.ragdolls) r.applyRadialImpulse(centre, radius, power);
  }

  remove(r: RagdollHandle): void {
    const i = this.ragdolls.findIndex((x) => x.id === r.id);
    if (i >= 0) {
      const doomed = this.ragdolls[i];
      this.ragdolls.splice(i, 1);
      if (this.teardownsThisFrame < RagdollManager.MAX_TEARDOWNS_PER_FRAME
        && this.constructsThisFrame === 0) {
        doomed.remove();
        this.teardownsThisFrame++;
      } else {
        this.queueTeardown(doomed);
      }
    }
  }

  clear(): void {
    for (const r of this.ragdolls) r.remove();
    this.ragdolls.length = 0;
    for (const r of this.pendingTeardown) r.remove();
    this.pendingTeardown.length = 0;
  }

  private enforceBudget(incoming: number): void {
    while (this.ragdolls.length + incoming > this.budget) {
      // Prefer retiring something that has already come to rest.
      let idx = this.ragdolls.findIndex((r) => r.settled);
      if (idx < 0) idx = 0;
      const doomed = this.ragdolls[idx];
      this.ragdolls.splice(idx, 1);
      // If this frame already built a ragdoll, defer the free; otherwise free
      // now so the world body count never quietly grows past budget.
      if (this.constructsThisFrame > 0
        || this.teardownsThisFrame >= RagdollManager.MAX_TEARDOWNS_PER_FRAME) {
        this.queueTeardown(doomed);
      } else {
        doomed.remove();
        this.teardownsThisFrame++;
      }
    }
  }
}

/* -------------------------------------------------------------------- utils */

function resolvePose(opts: RagdollOptions): Map<string, BonePose> {
  const map = new Map<string, BonePose>();
  if (opts.bones) {
    // One full graph walk instead of N parent walks (death-frame cost).
    if (opts.root) opts.root.updateWorldMatrix(true, true);
    for (const key of Object.keys(opts.bones)) {
      const obj = opts.bones[key];
      if (!obj) continue;
      if (!opts.root) obj.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      obj.matrixWorld.decompose(p, q, s);
      map.set(key, { position: p, rotation: q });
    }
  }
  if (opts.pose) {
    for (const key of Object.keys(opts.pose)) {
      if (map.has(key)) continue;
      const e = opts.pose[key];
      map.set(key, {
        position: new THREE.Vector3(e.position[0], e.position[1], e.position[2]),
        rotation: new THREE.Quaternion(e.rotation[0], e.rotation[1], e.rotation[2], e.rotation[3]),
      });
    }
  }
  return map;
}

/**
 * Builds a plausible standing pose for the canonical rig. Used by the debug
 * scene and as a fallback when a caller has no rig to hand.
 */
export function defaultHumanPose(
  origin: THREE.Vector3, yaw = 0, height = 1.8,
): Record<string, { position: [number, number, number]; rotation: [number, number, number, number] }> {
  const s = height / 1.8;
  const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const rot: [number, number, number, number] = [q.x, q.y, q.z, q.w];
  const put = (x: number, y: number, z: number): [number, number, number] => {
    vA.set(x * s, y * s, z * s).applyQuaternion(q).add(origin);
    return [vA.x, vA.y, vA.z];
  };
  return {
    root: { position: put(0, 0, 0), rotation: rot },
    hips: { position: put(0, 0.95, 0), rotation: rot },
    spine: { position: put(0, 1.11, 0), rotation: rot },
    chest: { position: put(0, 1.29, 0), rotation: rot },
    neck: { position: put(0, 1.50, 0), rotation: rot },
    head: { position: put(0, 1.60, 0), rotation: rot },
    shoulderL: { position: put(0.09, 1.46, 0), rotation: rot },
    upperArmL: { position: put(0.20, 1.44, 0), rotation: rot },
    lowerArmL: { position: put(0.24, 1.16, 0), rotation: rot },
    handL: { position: put(0.26, 0.90, 0), rotation: rot },
    shoulderR: { position: put(-0.09, 1.46, 0), rotation: rot },
    upperArmR: { position: put(-0.20, 1.44, 0), rotation: rot },
    lowerArmR: { position: put(-0.24, 1.16, 0), rotation: rot },
    handR: { position: put(-0.26, 0.90, 0), rotation: rot },
    upperLegL: { position: put(0.10, 0.92, 0), rotation: rot },
    lowerLegL: { position: put(0.11, 0.50, 0), rotation: rot },
    footL: { position: put(0.11, 0.09, 0), rotation: rot },
    toeL: { position: put(0.11, 0.05, 0.15), rotation: rot },
    upperLegR: { position: put(-0.10, 0.92, 0), rotation: rot },
    lowerLegR: { position: put(-0.11, 0.50, 0), rotation: rot },
    footR: { position: put(-0.11, 0.09, 0), rotation: rot },
    toeR: { position: put(-0.11, 0.05, 0.15), rotation: rot },
  };
}
