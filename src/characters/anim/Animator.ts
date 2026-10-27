/**
 * The animation graph.
 *
 * Layers, in evaluation order:
 *
 *   0  locomotion blend tree   idle/walk/run/sprint × strafe, crouch, prone,
 *                              speed-synced foot phase
 *   1  body action             cover pose, vault, death — masked override
 *   2  upper-body action       throw, reload — masked override
 *   3  additive aim offset     spine/chest/neck/head split of the aim angles
 *   4  additive procedural     breathing, weapon sway, recoil spring
 *   5  additive hit reaction   direction × zone, decaying
 *   —  bones written, world matrices updated —
 *   6  foot IK                 ground probe, hip drop, ankle roll
 *   7  weapon IK               both arms solved onto the weapon's grips
 *   8  head look-at            with neck limits
 *
 * Layers 0–5 are pure data on `Float32Array`s and allocate nothing. Layers 6–8
 * need world transforms, so they run after the pose has been written to the
 * bones, each updating only the subtree it touched.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { AnimName, BoneName } from '../types';
import type { HitZone } from '../../physics/types';
import { ARM_BONES, BONE_COUNT, BONE_INDEX, UPPER_BODY, type RigInstance } from '../Rig';
import { Clip, maskOf } from './Clip';
import { clip, clips, STRIDE } from './clips';
import { Pose, eulerYXZInto } from './Pose';
import { FootIK, type GroundProbe } from './FootIK';
import { setWorldRotation, twoBoneIK } from './Ik';

const DEG = Math.PI / 180;

export type Locomotion = 'idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'prone' | 'slide';
export type CarryPose = 'ready' | 'aim' | 'run' | 'sprint' | 'relaxed' | 'cover';

/** Where the weapon sits relative to the chest bone, per carry. */
interface Carry {
  pos: [number, number, number];
  /** Euler XYZ degrees, YXZ order. */
  rot: [number, number, number];
}

const CARRY: Record<CarryPose, Carry> = {
  ready: { pos: [-0.075, -0.075, 0.185], rot: [14, -6, 2] },
  aim: { pos: [-0.020, 0.028, 0.205], rot: [0, 0, 0] },
  run: { pos: [-0.090, -0.140, 0.150], rot: [34, -12, 4] },
  sprint: { pos: [-0.020, -0.185, 0.115], rot: [46, -34, -22] },
  relaxed: { pos: [-0.110, -0.185, 0.135], rot: [46, -10, 6] },
  cover: { pos: [-0.055, -0.045, 0.170], rot: [8, 22, 4] },
};

/** Grip points in weapon space: the wrists sit here. */
const GRIP_R = new THREE.Vector3(0, 0.012, -0.035);
const GRIP_L = new THREE.Vector3(0.010, -0.010, 0.235);
/** Elbow pole hints, in character space relative to the shoulder. */
const POLE_L = new THREE.Vector3(0.30, -0.62, -0.30);
const POLE_R = new THREE.Vector3(-0.46, -0.50, -0.34);
/** Wrist orientation offsets relative to the weapon. */
const HAND_R_OFFSET = new THREE.Euler(-72 * DEG, 8 * DEG, -8 * DEG, 'YXZ');
const HAND_L_OFFSET = new THREE.Euler(-64 * DEG, -12 * DEG, 22 * DEG, 'YXZ');

const MASK_UPPER = maskOf(UPPER_BODY);
const MASK_ARMS = maskOf(ARM_BONES);
const MASK_ALL = (() => { const m = new Float32Array(BONE_COUNT); m.fill(1); return m; })();

/** Hit reactions weight the spine chain differently depending on where it hit. */
const ZONE_SCALE: Record<HitZone, number> = {
  head: 1.25, neck: 1.1, chest: 1.0, stomach: 0.85, arm: 0.55, leg: 0.45, none: 0.6,
};

interface Action {
  clip: Clip;
  time: number;
  weight: number;
  target: number;
  fade: number;
  speed: number;
  mask: Float32Array;
  loop: boolean;
  /** Called once when a non-looping action reaches its end. */
  done?: () => void;
}

export interface AnimatorHooks {
  /** Fired when a foot plants, with 0 = left, 1 = right. */
  onFootPlant?(foot: number, speed: number): void;
  /** Fired when a death clip finishes so the owner can hand off to ragdoll. */
  onDeathComplete?(): void;
}

export class Animator {
  readonly footIK: FootIK;
  /** Node the weapon attaches to; a child of the chest bone. */
  readonly weaponSocket = new THREE.Object3D();

  hooks: AnimatorHooks = {};
  /** Blend weight of the whole foot IK solver. */
  footIKWeight = 1;
  /** Blend weight of the weapon arm IK. */
  armIKWeight = 1;
  /** Set false for characters with no weapon (arms fall to the locomotion pose). */
  hasWeapon = true;
  /** Alert characters use the ready stance; relaxed ones stand easy. */
  alert = true;
  groundProbe: GroundProbe | null = null;

  /* locomotion state */
  private state: Locomotion = 'idle';
  private speed = 0;
  private strafe = 0;
  private cyclePhase = 0;
  private idlePhase = 0;
  private crouchW = 0;
  private slideW = 0;
  private proneW = 0;
  private moveW = 0;
  private runW = 0;
  private sprintW = 0;
  private strafeW = 0;
  private lastFootSign = 1;

  /* aim + look */
  private aimYaw = 0;
  private aimPitch = 0;
  private aimYawS = 0;
  private aimPitchS = 0;
  private lookTarget: THREE.Vector3 | null = null;
  private lookW = 0;

  /* procedural */
  private recoil = 0;
  private recoilVel = 0;
  private recoilYaw = 0;
  private breathPhase: number;
  private swayPhase: number;
  private breathRate = 0.24;
  private breathDepth = 1;
  private rand: Rand;

  /* hit reaction */
  private hit: Action | null = null;
  private hitPower = 0;

  /* actions */
  private bodyAction: Action | null = null;
  private upperAction: Action | null = null;

  /* carry */
  private carry: CarryPose = 'ready';
  private carryPos = new THREE.Vector3();
  private carryQuat = new THREE.Quaternion();
  private carryTargetPos = new THREE.Vector3();
  private carryTargetQuat = new THREE.Quaternion();

  /* scratch poses */
  private base = new Pose();
  private tmpA = new Pose();
  private tmpB = new Pose();
  private tmpC = new Pose();
  private additive = new Pose();

  private dying = false;
  private frozen = false;
  /**
   * Holds the graph exactly where it stands.
   *
   * Capture tooling needs a character stopped at a chosen millisecond — the
   * frame 120 ms into a hit reaction is the one that says whether it reads as
   * an impact — and the character system updates every character it owns, so a
   * debug driver cannot achieve that by simply not calling `update`.
   */
  paused = false;

  constructor(private rig: RigInstance, private root: THREE.Object3D) {
    this.footIK = new FootIK(rig);
    this.rand = new Rand(Math.round(rig.standHeight * 100000));
    this.breathPhase = this.rand.next() * Math.PI * 2;
    this.swayPhase = this.rand.next() * Math.PI * 2;
    rig.byName.chest.add(this.weaponSocket);
    this.applyCarry('ready', true);
    clips();
  }

  /* --------------------------------------------------------------- inputs */

  setLocomotion(state: Locomotion, speed: number, strafe: number): void {
    this.state = state;
    this.speed = Math.max(0, speed);
    this.strafe = THREE.MathUtils.clamp(strafe, -1, 1);
  }

  setAim(yaw: number, pitch: number): void {
    this.aimYaw = THREE.MathUtils.clamp(yaw, -1.6, 1.6);
    this.aimPitch = THREE.MathUtils.clamp(pitch, -1.1, 1.1);
  }

  lookAt(target: THREE.Vector3 | null): void {
    this.lookTarget = target;
  }

  addRecoil(amount: number): void {
    this.recoilVel += amount * 26;
    this.recoilYaw += (this.rand.signed() * 0.4 + 0.25) * amount;
    this.breathDepth = Math.min(2.2, this.breathDepth + amount * 0.5);
  }

  setCarry(pose: CarryPose): void {
    if (this.carry !== pose) this.applyCarry(pose, false);
  }

  private applyCarry(pose: CarryPose, immediate: boolean): void {
    this.carry = pose;
    const c = CARRY[pose];
    this.carryTargetPos.set(c.pos[0], c.pos[1], c.pos[2]);
    _euler.set(c.rot[0] * DEG, c.rot[1] * DEG, c.rot[2] * DEG, 'YXZ');
    this.carryTargetQuat.setFromEuler(_euler);
    if (immediate) {
      this.carryPos.copy(this.carryTargetPos);
      this.carryQuat.copy(this.carryTargetQuat);
    }
  }

  /** Direction is in world space; the caller supplies the character's facing. */
  react(direction: THREE.Vector3, zone: HitZone, power: number, facing: number): void {
    if (this.dying) return;
    // Resolve the impact direction into the character's own frame.
    const yaw = Math.atan2(direction.x, direction.z) - facing;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let name: AnimName;
    if (c > 0.5) name = 'hitBack';
    else if (c < -0.5) name = 'hitFront';
    else name = s > 0 ? 'hitLeft' : 'hitRight';
    const cl = clip(name);
    if (!cl) return;
    this.hitPower = THREE.MathUtils.clamp(power * (ZONE_SCALE[zone] ?? 1), 0, 1.6);
    this.hit = {
      clip: cl, time: 0, weight: 1, target: 1, fade: 0.05,
      speed: 1 / cl.duration, mask: MASK_ALL, loop: false,
    };
    // A limb hit also shoves the weapon.
    this.addRecoil(this.hitPower * 0.35);
  }

  /**
   * Plays a one-shot or looping clip. Death clips take over the whole body and
   * suppress IK; upper-body actions leave the legs to the locomotion tree.
   */
  play(name: AnimName, opts: { fade?: number; speed?: number; loop?: boolean } = {}): void {
    if (this.frozen) return;
    if (name === 'fire') { this.addRecoil(0.55); return; }
    if (name === 'aim') { this.setCarry('aim'); return; }
    if (name === 'reload') { this.startReload(); return; }

    const cl = clip(name);
    if (!cl) return;
    const fade = opts.fade ?? 0.14;
    const speed = (opts.speed ?? 1) / cl.duration;
    const death = name.startsWith('death');
    const upper = name === 'throw';
    const action: Action = {
      clip: cl, time: 0, weight: 0, target: 1, fade,
      speed, mask: upper ? MASK_UPPER : MASK_ALL,
      loop: opts.loop ?? cl.loop,
    };

    if (death) {
      this.dying = true;
      this.footIKWeight = 0;
      this.armIKWeight = 0;
      // Was 0.05 — a one-frame pop into the death pose. Cross-fade long enough
      // that the collapse reads as a performance, not a teleport.
      action.fade = Math.max(fade, 0.18);
      action.done = () => {
        this.frozen = true;
        this.hooks.onDeathComplete?.();
      };
      this.bodyAction = action;
      this.upperAction = null;
      this.hit = null;
      return;
    }

    if (upper) {
      action.done = () => { this.armIKWeight = 1; };
      this.armIKWeight = 0;
      this.upperAction = action;
    } else {
      this.bodyAction = action;
      if (name === 'coverHigh' || name === 'coverLow') this.setCarry('cover');
    }
  }

  /** Cancels cover / vault overrides and returns to the locomotion tree. */
  clearAction(fade = 0.18): void {
    if (this.bodyAction) { this.bodyAction.target = 0; this.bodyAction.fade = fade; }
    if (this.upperAction) { this.upperAction.target = 0; this.upperAction.fade = fade; }
    if (this.carry === 'cover') this.setCarry('ready');
  }

  get isDying(): boolean { return this.dying; }
  get recoilAmount(): number { return this.recoil; }

  /* ------------------------------------------------------------- reload */

  private reloadT = -1;

  private startReload(): void {
    this.reloadT = 0;
    this.armIKWeight = 1;
  }

  /**
   * The reload is driven as a left-hand target path in weapon space rather than
   * a bone clip, so it stays correct for any body proportions and any carry.
   */
  private reloadOffset(out: THREE.Vector3): number {
    const t = this.reloadT;
    if (t < 0) return 0;
    const seq: [number, number, number, number][] = [
      [0.00, 0.010, -0.010, 0.235],
      [0.18, 0.010, -0.075, 0.120],
      [0.38, -0.110, -0.300, 0.020],
      [0.62, -0.060, -0.140, 0.080],
      [0.80, 0.010, -0.045, 0.150],
      [1.00, 0.010, -0.010, 0.235],
    ];
    const p = THREE.MathUtils.clamp(t / 2.1, 0, 1);
    for (let i = 0; i < seq.length - 1; i++) {
      if (p >= seq[i][0] && p <= seq[i + 1][0]) {
        const span = seq[i + 1][0] - seq[i][0];
        const f = span > 1e-5 ? (p - seq[i][0]) / span : 0;
        const e = f * f * (3 - 2 * f);
        out.set(
          THREE.MathUtils.lerp(seq[i][1], seq[i + 1][1], e),
          THREE.MathUtils.lerp(seq[i][2], seq[i + 1][2], e),
          THREE.MathUtils.lerp(seq[i][3], seq[i + 1][3], e),
        );
        return 1;
      }
    }
    out.copy(GRIP_L);
    return 0;
  }

  /* --------------------------------------------------------------- update */

  update(dt: number): void {
    if (this.frozen || this.paused) return;
    const d = Math.min(dt, 0.1);

    this.advance(d);
    this.sampleBase(this.base);
    this.applyActions(d, this.base);
    this.applyAdditives(d, this.base);
    this.writeBones(this.base);

    this.root.updateMatrixWorld(true);

    if (!this.dying) {
      this.footIK.update(d, this.groundProbe, this.footIKWeight);
      if (this.hasWeapon) this.solveArms(d);
      this.applyLookAt(d);
    }
    (this.rig.skeleton as { invalidate?: () => void }).invalidate?.();
  }

  /* ------------------------------------------------------- state advance */

  private advance(dt: number): void {
    const standing = this.state !== 'crouch' && this.state !== 'prone' && this.state !== 'slide';
    const k = 1 - Math.exp(-dt * 9);
    this.crouchW += ((this.state === 'crouch' ? 1 : 0) - this.crouchW) * k;
    this.proneW += ((this.state === 'prone' ? 1 : 0) - this.proneW) * k;
    this.slideW += ((this.state === 'slide' ? 1 : 0) - this.slideW) * (1 - Math.exp(-dt * 12));

    // Speed → locomotion weights.
    const s = this.speed;
    const moveTarget = THREE.MathUtils.clamp((s - 0.12) / 0.7, 0, 1);
    const runTarget = THREE.MathUtils.clamp((s - 1.7) / 1.6, 0, 1);
    const sprintTarget = THREE.MathUtils.clamp((s - 3.9) / 1.7, 0, 1);
    const km = 1 - Math.exp(-dt * 8);
    this.moveW += (moveTarget - this.moveW) * km;
    this.runW += (runTarget - this.runW) * km;
    this.sprintW += (sprintTarget - this.sprintW) * km;
    this.strafeW += (Math.abs(this.strafe) * (standing ? 1 : 0.4) - this.strafeW) * km;

    // Foot phase advances by distance travelled, not by wall time, so the feet
    // never skate however the blend weights move.
    const stride = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(STRIDE.walk, STRIDE.run, this.runW),
      STRIDE.sprint, this.sprintW,
    ) * THREE.MathUtils.lerp(1, STRIDE.crouchWalk / STRIDE.walk, this.crouchW)
      * THREE.MathUtils.lerp(1, (STRIDE.slide ?? 2.2) / STRIDE.walk, this.slideW);
    const cycleRate = s > 0.05 ? s / Math.max(stride, 0.2) : 0.55;
    const prev = this.cyclePhase;
    this.cyclePhase = (this.cyclePhase + dt * cycleRate) % 1;
    this.idlePhase = (this.idlePhase + dt) % 1000;

    // Foot-plant events for audio and dust.
    if (this.moveW > 0.25) {
      if (prev < 0.5 && this.cyclePhase >= 0.5 && this.lastFootSign !== 1) {
        this.hooks.onFootPlant?.(1, s); this.lastFootSign = 1;
      } else if (prev > this.cyclePhase) {
        this.hooks.onFootPlant?.(0, s); this.lastFootSign = 0;
      } else if (this.cyclePhase >= 0.5 && this.lastFootSign === 0) {
        this.hooks.onFootPlant?.(1, s); this.lastFootSign = 1;
      } else if (this.cyclePhase < 0.5 && this.lastFootSign === 1) {
        this.lastFootSign = 0;
      }
    }

    // Carry pose follows the locomotion unless something overrode it.
    if (this.carry !== 'aim' && this.carry !== 'cover') {
      const want: CarryPose = this.slideW > 0.4 ? 'sprint'
        : this.sprintW > 0.5 ? 'sprint'
          : this.runW > 0.55 ? 'run'
            : this.alert ? 'ready' : 'relaxed';
      if (want !== this.carry) this.applyCarry(want, false);
    }
    const ck = 1 - Math.exp(-dt * 8);
    this.carryPos.lerp(this.carryTargetPos, ck);
    this.carryQuat.slerp(this.carryTargetQuat, ck);

    // Recoil spring: stiff, slightly under-damped, so it snaps and settles.
    this.recoilVel += (-260 * this.recoil - 22 * this.recoilVel) * dt;
    this.recoil += this.recoilVel * dt;
    this.recoilYaw *= Math.exp(-dt * 9);

    // Aim smoothing — soldiers lead with the eyes, the body follows.
    const ak = 1 - Math.exp(-dt * 12);
    this.aimYawS += (this.aimYaw - this.aimYawS) * ak;
    this.aimPitchS += (this.aimPitch - this.aimPitchS) * ak;

    // Breathing gets faster and deeper with exertion.
    const exert = THREE.MathUtils.clamp(this.speed / 5, 0, 1);
    this.breathRate = 0.24 + exert * 0.55;
    this.breathDepth += ((0.8 + exert * 1.4) - this.breathDepth) * (1 - Math.exp(-dt * 0.9));
    this.breathPhase += dt * this.breathRate * Math.PI * 2;
    this.swayPhase += dt;

    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT > 2.1) this.reloadT = -1;
    }
  }

  /* --------------------------------------------------------- base sample */

  private sampleBase(out: Pose): void {
    const walk = clips().get('walk')!;
    const run = clips().get('run')!;
    const sprint = clips().get('sprint')!;

    // Standing locomotion: idle → walk → run → sprint.
    const idleName = this.alert ? 'idleAlert' : 'idle';
    clips().get(idleName)!.sample(this.idlePhase / clips().get(idleName)!.duration, out);

    if (this.moveW > 0.001) {
      walk.sample(this.cyclePhase, this.tmpA);
      if (this.runW > 0.001) {
        run.sample(this.cyclePhase, this.tmpB);
        this.tmpA.blend(this.tmpB, this.runW);
        if (this.sprintW > 0.001) {
          sprint.sample(this.cyclePhase, this.tmpB);
          this.tmpA.blend(this.tmpB, this.sprintW);
        }
      }
      // Lateral cycle blended against the forward one.
      if (this.strafeW > 0.01) {
        const sc = clips().get(this.strafe > 0 ? 'strafeL' : 'strafeR')!;
        sc.sample(this.cyclePhase, this.tmpC);
        this.tmpA.blend(this.tmpC, this.strafeW * 0.85);
      }
      out.blend(this.tmpA, this.moveW);
    }

    if (this.crouchW > 0.001) {
      const ci = clips().get('crouchIdle')!;
      ci.sample(this.idlePhase / ci.duration, this.tmpA);
      if (this.moveW > 0.001) {
        clips().get('crouchWalk')!.sample(this.cyclePhase, this.tmpB);
        this.tmpA.blend(this.tmpB, this.moveW);
      }
      out.blend(this.tmpA, this.crouchW);
    }

    if (this.slideW > 0.001) {
      const sl = clips().get('slide')!;
      // Phase from distance so the slide pose holds while drifting, not cycling.
      sl.sample(Math.min(0.92, this.cyclePhase * 0.35 + 0.2), this.tmpA);
      out.blend(this.tmpA, this.slideW);
    }

    if (this.proneW > 0.001) {
      const pr = clips().get('prone')!;
      pr.sample(this.idlePhase / pr.duration, this.tmpA);
      if (this.moveW > 0.001) {
        clips().get('proneCrawl')!.sample(this.cyclePhase, this.tmpB);
        this.tmpA.blend(this.tmpB, this.moveW);
      }
      out.blend(this.tmpA, this.proneW);
    }
  }

  /* ------------------------------------------------------------- actions */

  private applyActions(dt: number, out: Pose): void {
    for (const slot of ['bodyAction', 'upperAction'] as const) {
      const a = this[slot];
      if (!a) continue;
      a.time += dt * a.speed;
      const k = a.fade > 1e-4 ? 1 - Math.exp(-dt / a.fade) : 1;
      a.weight += (a.target - a.weight) * k;
      if (!a.loop && a.time >= 1) {
        a.time = 1;
        if (a.done) { a.done(); a.done = undefined; }
        if (!this.dying) a.target = 0;
      }
      if (a.weight < 0.002 && a.target === 0) { this[slot] = null; continue; }
      a.clip.sample(a.time, this.tmpA);
      // The clip's own mask limits it to bones it actually animates.
      _mask.set(a.clip.mask);
      for (let i = 0; i < BONE_COUNT; i++) _mask[i] *= a.mask[i];
      out.blendMasked(this.tmpA, _mask, a.weight);
    }
  }

  /* ----------------------------------------------------------- additives */

  private applyAdditives(dt: number, out: Pose): void {
    const add = this.additive;
    add.identity();

    // Aim offset, split down the spine so the whole torso turns rather than
    // the neck snapping round.
    if (!this.dying) {
      const y = this.aimYawS, p = this.aimPitchS;
      setEuler(add, 'spine', p * 0.14, y * 0.17, 0);
      setEuler(add, 'chest', p * 0.34, y * 0.33, y * 0.06);
      setEuler(add, 'neck', p * 0.22, y * 0.20, 0);
      setEuler(add, 'head', p * 0.28, y * 0.28, 0);
    }

    // Breathing: the chest rises, the shoulders open, the head lifts a little.
    const br = Math.sin(this.breathPhase) * this.breathDepth;
    const br2 = Math.sin(this.breathPhase * 2 + 0.6) * this.breathDepth;
    addEuler(add, 'spine', br * 0.35 * DEG, 0, 0);
    addEuler(add, 'chest', -br * 1.15 * DEG, 0, 0);
    addEuler(add, 'shoulderL', -br * 0.5 * DEG, 0, br * 0.9 * DEG);
    addEuler(add, 'shoulderR', -br * 0.5 * DEG, 0, -br * 0.9 * DEG);
    addEuler(add, 'neck', br2 * 0.25 * DEG, 0, 0);

    // Weapon sway: two incommensurable sines so it never looks like a loop.
    const t = this.swayPhase;
    const swayA = Math.sin(t * 0.83 + this.swayPhase * 0.0 + this.breathPhase * 0.13);
    const swayB = Math.sin(t * 1.37 + 1.9);
    const swayScale = (this.carry === 'aim' ? 0.35 : 1) * (1 - this.moveW * 0.4);
    addEuler(add, 'chest', swayB * 0.30 * DEG * swayScale, swayA * 0.55 * DEG * swayScale, swayA * 0.25 * DEG * swayScale);
    addEuler(add, 'head', swayB * 0.20 * DEG * swayScale, -swayA * 0.30 * DEG * swayScale, 0);

    // Recoil: a sharp backward pitch through the upper body plus a yaw kick.
    const r = this.recoil;
    if (Math.abs(r) > 1e-4) {
      addEuler(add, 'chest', r * 4.5 * DEG, this.recoilYaw * 2.2 * DEG, 0);
      addEuler(add, 'neck', r * 2.4 * DEG, this.recoilYaw * 1.0 * DEG, 0);
      addEuler(add, 'head', r * 1.6 * DEG, this.recoilYaw * 0.8 * DEG, 0);
      addEuler(add, 'spine', r * 1.6 * DEG, 0, 0);
    }

    out.additive(add, 1);

    // Hit reactions ride on top of everything, weighted by power and zone.
    const h = this.hit;
    if (h) {
      h.time += dt * h.speed;
      if (h.time >= 1) { this.hit = null; }
      else {
        h.clip.sample(h.time, this.tmpA);
        out.additive(this.tmpA, Math.min(1.4, this.hitPower));
      }
    }
    void dt;
  }

  /* ------------------------------------------------------------ transfer */

  private writeBones(pose: Pose): void {
    const bones = this.rig.bones;
    const off = this.rig.localOffset;
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = bones[i];
      const o = i * 4;
      b.quaternion.set(pose.rot[o], pose.rot[o + 1], pose.rot[o + 2], pose.rot[o + 3]);
      const p = i * 3;
      b.position.set(
        off[i].x + pose.pos[p],
        off[i].y + pose.pos[p + 1],
        off[i].z + pose.pos[p + 2],
      );
    }
  }

  /* ------------------------------------------------------------- weapon */

  private solveArms(dt: number): void {
    const w = this.armIKWeight;
    if (w <= 0.002) return;

    // Recoil shoves the weapon back and up in the shooter's hands.
    _v.copy(this.carryPos);
    _v.z -= this.recoil * 0.055;
    _v.y += this.recoil * 0.012;
    this.weaponSocket.position.copy(_v);
    _q.copy(this.carryQuat);
    _euler.set(this.recoil * 7 * DEG, this.recoilYaw * 3 * DEG, 0, 'YXZ');
    _q2.setFromEuler(_euler);
    this.weaponSocket.quaternion.copy(_q).multiply(_q2);
    this.weaponSocket.updateMatrixWorld(true);

    const rig = this.rig;
    // Right hand: fixed to the pistol grip.
    _target.copy(GRIP_R).applyMatrix4(this.weaponSocket.matrixWorld);
    _pole.copy(POLE_R).applyMatrix4(this.root.matrixWorld);
    twoBoneIK(rig.byName.upperArmR, rig.byName.lowerArmR, rig.byName.handR, _target, { pole: _pole, weight: w });
    this.weaponSocket.getWorldQuaternion(_q);
    _q2.setFromEuler(HAND_R_OFFSET);
    setWorldRotation(rig.byName.handR, _q.multiply(_q2), w);

    // Left hand: on the handguard, or running the reload path.
    const reloading = this.reloadOffset(_v2);
    if (reloading > 0) _target.copy(_v2);
    else _target.copy(GRIP_L);
    _target.applyMatrix4(this.weaponSocket.matrixWorld);
    _pole.copy(POLE_L).applyMatrix4(this.root.matrixWorld);
    twoBoneIK(rig.byName.upperArmL, rig.byName.lowerArmL, rig.byName.handL, _target, { pole: _pole, weight: w });
    this.weaponSocket.getWorldQuaternion(_q);
    _q2.setFromEuler(HAND_L_OFFSET);
    setWorldRotation(rig.byName.handL, _q.multiply(_q2), w * (reloading > 0 ? 0.5 : 1));
    void dt;
  }

  /* ------------------------------------------------------------ look-at */

  private applyLookAt(dt: number): void {
    const want = this.lookTarget ? 1 : 0;
    this.lookW += (want - this.lookW) * (1 - Math.exp(-dt * 6));
    if (this.lookW < 0.01 || !this.lookTarget) return;

    const head = this.rig.byName.head;
    head.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(head.matrixWorld);
    _dir.subVectors(this.lookTarget, _v);
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();

    // Work in the chest's frame so the limits are anatomical, not world-space.
    this.rig.byName.chest.getWorldQuaternion(_q);
    _q2.copy(_q).invert();
    _v2.copy(_dir).applyQuaternion(_q2);

    const yaw = THREE.MathUtils.clamp(Math.atan2(_v2.x, _v2.z), -70 * DEG, 70 * DEG);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(_v2.y, -1, 1)), -42 * DEG, 45 * DEG);
    // Beyond the neck limit the character simply stops tracking rather than
    // twisting its head off.
    const reach = 1 - THREE.MathUtils.clamp((Math.abs(Math.atan2(_v2.x, _v2.z)) - 70 * DEG) / (30 * DEG), 0, 1);

    _euler.set(-pitch * 0.62, yaw * 0.62, 0, 'YXZ');
    _q2.setFromEuler(_euler);
    _q.multiply(_q2);
    setWorldRotation(head, _q, this.lookW * reach);

    // The neck takes a share so the head does not look bolted on.
    const neck = this.rig.byName.neck;
    neck.getWorldQuaternion(_q);
    _euler.set(-pitch * 0.30, yaw * 0.30, 0, 'YXZ');
    _q2.setFromEuler(_euler);
    setWorldRotation(neck, _q.multiply(_q2), this.lookW * reach * 0.7);
  }
}

/* ------------------------------------------------------------------ helpers */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _mask = new Float32Array(BONE_COUNT);
const _scratch = new Float32Array(4);

function setEuler(pose: Pose, bone: BoneName, x: number, y: number, z: number): void {
  eulerYXZInto(x, y, z, pose.rot, BONE_INDEX[bone] * 4);
}

function addEuler(pose: Pose, bone: BoneName, x: number, y: number, z: number): void {
  if (x === 0 && y === 0 && z === 0) return;
  const o = BONE_INDEX[bone] * 4;
  eulerYXZInto(x, y, z, _scratch, 0);
  const ax = pose.rot[o], ay = pose.rot[o + 1], az = pose.rot[o + 2], aw = pose.rot[o + 3];
  const bx = _scratch[0], by = _scratch[1], bz = _scratch[2], bw = _scratch[3];
  pose.rot[o] = aw * bx + ax * bw + ay * bz - az * by;
  pose.rot[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  pose.rot[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  pose.rot[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
