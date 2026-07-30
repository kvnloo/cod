/**
 * Procedural stand-in soldier.
 *
 * The characters module owns the real skinned art. Until it lands — and as a
 * permanent fallback if character creation fails — the AI needs *something*
 * with the canonical bone rig so that aiming, leaning, stance, hit reactions and
 * ragdoll all run through the same code path they will run through later.
 *
 * So this is a real rig: the exact bone hierarchy from `characters/types.ts`,
 * built from `BufferGeometry` with no assets, with a procedural animation layer
 * (leg swing, torso lean, aim offset, crouch, recoil, flinch). Hand it to
 * `physics.spawnRagdoll({ bones })` and it ragdolls properly, because the bones
 * are genuine `Object3D`s in a genuine hierarchy.
 *
 * Geometry and materials are shared across every instance, so a six-man squad
 * costs six draw-call groups, not six meshes' worth of buffers.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { HitZone } from '../physics/types';
import type {
  AnimName, BoneName, Character, CharacterOptions, HitBox,
} from '../characters/types';

/* --------------------------------------------------------------- resources */

interface SharedGeo {
  head: THREE.SphereGeometry;
  helmet: THREE.SphereGeometry;
  torso: THREE.BoxGeometry;
  vest: THREE.BoxGeometry;
  pelvis: THREE.BoxGeometry;
  upperArm: THREE.CapsuleGeometry;
  lowerArm: THREE.CapsuleGeometry;
  upperLeg: THREE.CapsuleGeometry;
  lowerLeg: THREE.CapsuleGeometry;
  boot: THREE.BoxGeometry;
  weapon: THREE.BoxGeometry;
  magazine: THREE.BoxGeometry;
  pouch: THREE.BoxGeometry;
}

let GEO: SharedGeo | null = null;
function geo(): SharedGeo {
  if (GEO) return GEO;
  GEO = {
    head: new THREE.SphereGeometry(0.098, 14, 12),
    helmet: new THREE.SphereGeometry(0.118, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62),
    torso: new THREE.BoxGeometry(0.36, 0.44, 0.24),
    vest: new THREE.BoxGeometry(0.40, 0.34, 0.28),
    pelvis: new THREE.BoxGeometry(0.31, 0.24, 0.22),
    upperArm: new THREE.CapsuleGeometry(0.055, 0.18, 4, 8),
    lowerArm: new THREE.CapsuleGeometry(0.048, 0.18, 4, 8),
    upperLeg: new THREE.CapsuleGeometry(0.085, 0.25, 4, 10),
    lowerLeg: new THREE.CapsuleGeometry(0.066, 0.27, 4, 8),
    boot: new THREE.BoxGeometry(0.11, 0.09, 0.26),
    weapon: new THREE.BoxGeometry(0.052, 0.10, 0.62),
    magazine: new THREE.BoxGeometry(0.04, 0.17, 0.09),
    pouch: new THREE.BoxGeometry(0.10, 0.11, 0.07),
  };
  return GEO;
}

const PALETTE: Record<string, { cloth: number; gear: number; skin: number; helmet: number }> = {
  militia: { cloth: 0x8b8259, gear: 0x6b6350, skin: 0xb08a68, helmet: 0x777257 },
  pmc: { cloth: 0x6d7480, gear: 0x424851, skin: 0xc09a78, helmet: 0x4e565f },
  spetsnaz: { cloth: 0x7d7c60, gear: 0x3f4238, skin: 0xbf9670, helmet: 0x585b48 },
  player: { cloth: 0x6a7884, gear: 0x3d444b, skin: 0xc49c78, helmet: 0x4a545d },
};

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(key: string, color: number, roughness: number, metalness = 0.05): THREE.MeshStandardMaterial {
  const k = `${key}:${color}`;
  let m = matCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(k, m);
  }
  return m;
}

/* -------------------------------------------------------------- bone table */

interface BoneDef { name: BoneName; parent: BoneName | null; pos: [number, number, number] }

/** Local offsets matching the canonical 1.8 m rig. */
const RIG: BoneDef[] = [
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'hips', parent: 'root', pos: [0, 0.95, 0] },
  { name: 'spine', parent: 'hips', pos: [0, 0.16, 0] },
  { name: 'chest', parent: 'spine', pos: [0, 0.18, 0] },
  { name: 'neck', parent: 'chest', pos: [0, 0.21, 0] },
  { name: 'head', parent: 'neck', pos: [0, 0.10, 0] },
  { name: 'shoulderL', parent: 'chest', pos: [0.09, 0.17, 0] },
  { name: 'upperArmL', parent: 'shoulderL', pos: [0.11, -0.02, 0] },
  { name: 'lowerArmL', parent: 'upperArmL', pos: [0.04, -0.28, 0] },
  { name: 'handL', parent: 'lowerArmL', pos: [0.02, -0.26, 0] },
  { name: 'shoulderR', parent: 'chest', pos: [-0.09, 0.17, 0] },
  { name: 'upperArmR', parent: 'shoulderR', pos: [-0.11, -0.02, 0] },
  { name: 'lowerArmR', parent: 'upperArmR', pos: [-0.04, -0.28, 0] },
  { name: 'handR', parent: 'lowerArmR', pos: [-0.02, -0.26, 0] },
  { name: 'upperLegL', parent: 'hips', pos: [0.10, -0.03, 0] },
  { name: 'lowerLegL', parent: 'upperLegL', pos: [0.01, -0.42, 0] },
  { name: 'footL', parent: 'lowerLegL', pos: [0, -0.41, 0] },
  { name: 'toeL', parent: 'footL', pos: [0, -0.04, 0.15] },
  { name: 'upperLegR', parent: 'hips', pos: [-0.10, -0.03, 0] },
  { name: 'lowerLegR', parent: 'upperLegR', pos: [-0.01, -0.42, 0] },
  { name: 'footR', parent: 'lowerLegR', pos: [0, -0.41, 0] },
  { name: 'toeR', parent: 'footR', pos: [0, -0.04, 0.15] },
];

const HITBOXES: HitBox[] = [
  { zone: 'head', bone: 'head', half: [0.10, 0.12, 0.11], offset: [0, 0.03, 0], damageScale: 3.2 },
  { zone: 'neck', bone: 'neck', half: [0.06, 0.06, 0.06], offset: [0, 0.04, 0], damageScale: 2.0 },
  { zone: 'chest', bone: 'chest', half: [0.20, 0.22, 0.14], offset: [0, 0.08, 0], damageScale: 1.0 },
  { zone: 'stomach', bone: 'hips', half: [0.17, 0.14, 0.12], offset: [0, 0.06, 0], damageScale: 1.0 },
  { zone: 'arm', bone: 'upperArmL', half: [0.07, 0.16, 0.07], offset: [0, -0.14, 0], damageScale: 0.7 },
  { zone: 'arm', bone: 'upperArmR', half: [0.07, 0.16, 0.07], offset: [0, -0.14, 0], damageScale: 0.7 },
  { zone: 'leg', bone: 'upperLegL', half: [0.09, 0.22, 0.09], offset: [0, -0.20, 0], damageScale: 0.75 },
  { zone: 'leg', bone: 'upperLegR', half: [0.09, 0.22, 0.09], offset: [0, -0.20, 0], damageScale: 0.75 },
];

/* ------------------------------------------------------------------ proxy -- */

type LocoState = 'idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'prone';

export class ProxySoldier implements Character {
  readonly object = new THREE.Group();
  readonly options: CharacterOptions;
  readonly hitboxes: readonly HitBox[] = HITBOXES;

  private bones = new Map<BoneName, THREE.Object3D>();
  private meshes: THREE.Mesh[] = [];
  private weapon: THREE.Object3D | null = null;

  private loco: LocoState = 'idle';
  private speed = 0;
  private strafe = 0;
  private phase = 0;
  private crouchBlend = 0;
  private crouchTarget = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private aimYawSmooth = 0;
  private aimPitchSmooth = 0;
  private recoil = 0;
  private lean = 0;
  private leanTarget = 0;
  private reactImpulse = new THREE.Vector3();
  private reactTimer = 0;
  private lookTarget: THREE.Vector3 | null = null;
  private oneShot: AnimName | null = null;
  private oneShotTime = 0;
  private dead = false;
  private ragdollActive = false;

  /** Set by the AI system so `ragdoll()` can hand off to the solver. */
  physics: {
    spawnRagdoll(opts: {
      root?: THREE.Object3D | null;
      bones?: Record<string, THREE.Object3D | null>;
      mass?: number; entityId?: number; velocity?: THREE.Vector3; quality?: number;
    }): { applyImpulse(zone: HitZone, impulse: THREE.Vector3): void };
  } | null = null;
  entityId = -1;
  /** Velocity carried into the ragdoll. */
  readonly velocity = new THREE.Vector3();

  constructor(opts: CharacterOptions) {
    this.options = opts;
    const rand = new Rand(opts.seed);
    this.build(rand);
  }

  /* --------------------------------------------------------------- build -- */

  private build(rand: Rand): void {
    const g = geo();
    const pal = PALETTE[this.options.faction] ?? PALETTE.militia;
    // Per-soldier colour jitter so a squad does not look cloned.
    const jitter = (c: number, amt: number): number => {
      const col = new THREE.Color(c);
      col.offsetHSL(rand.signed() * 0.02, rand.signed() * amt * 0.4, rand.signed() * amt);
      return col.getHex();
    };
    const cloth = mat('cloth', jitter(pal.cloth, 0.06), 0.92);
    const gear = mat('gear', jitter(pal.gear, 0.05), 0.72, 0.12);
    const skin = mat('skin', jitter(pal.skin, 0.05), 0.68);
    const helmetMat = mat('helmet', jitter(pal.helmet, 0.04), 0.55, 0.18);
    const steel = mat('steel', 0x1b1d20, 0.42, 0.65);

    this.object.name = 'ai-proxy-soldier';
    this.object.userData.noCollide = true;

    for (const def of RIG) {
      const b = new THREE.Object3D();
      b.name = def.name;
      b.position.set(def.pos[0], def.pos[1], def.pos[2]);
      const parent = def.parent ? this.bones.get(def.parent) : null;
      (parent ?? this.object).add(b);
      this.bones.set(def.name, b);
    }

    const attach = (bone: BoneName, geometry: THREE.BufferGeometry, material: THREE.Material,
      x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.noCollide = true;
      this.bones.get(bone)!.add(m);
      this.meshes.push(m);
      return m;
    };

    attach('hips', g.pelvis, cloth, 0, 0.02, 0);
    attach('chest', g.torso, cloth, 0, 0.06, 0);
    attach('chest', g.vest, gear, 0, 0.05, 0.005);
    attach('chest', g.pouch, gear, 0.13, -0.06, 0.15);
    attach('chest', g.pouch, gear, -0.13, -0.06, 0.15);
    attach('neck', g.magazine, skin, 0, 0.02, 0);
    attach('head', g.head, skin, 0, 0.03, 0.006);
    attach('head', g.helmet, helmetMat, 0, 0.035, -0.004);

    attach('upperArmL', g.upperArm, cloth, 0, -0.14, 0);
    attach('lowerArmL', g.lowerArm, cloth, 0, -0.13, 0);
    attach('upperArmR', g.upperArm, cloth, 0, -0.14, 0);
    attach('lowerArmR', g.lowerArm, cloth, 0, -0.13, 0);

    attach('upperLegL', g.upperLeg, cloth, 0, -0.20, 0);
    attach('lowerLegL', g.lowerLeg, cloth, 0, -0.20, 0);
    attach('footL', g.boot, gear, 0, -0.02, 0.05);
    attach('upperLegR', g.upperLeg, cloth, 0, -0.20, 0);
    attach('lowerLegR', g.lowerLeg, cloth, 0, -0.20, 0);
    attach('footR', g.boot, gear, 0, -0.02, 0.05);

    // The weapon hangs off the chest rather than the hand: the chest is what
    // carries the aim offset, so the muzzle tracks where the soldier is actually
    // looking instead of inheriting three joints' worth of arm rotation.
    const chest = this.bones.get('chest')!;
    const w = new THREE.Group();
    w.position.set(0.11, 0.02, 0.24);
    w.rotation.set(0.05, -0.09, 0);
    chest.add(w);
    const body = new THREE.Mesh(g.weapon, steel);
    body.castShadow = true;
    body.userData.noCollide = true;
    w.add(body);
    const magazine = new THREE.Mesh(g.magazine, steel);
    magazine.position.set(0, -0.11, 0.02);
    magazine.rotation.x = 0.2;
    magazine.userData.noCollide = true;
    w.add(magazine);
    this.weapon = w;
    this.meshes.push(body, magazine);

    // Rifle-carry arm pose: both hands forward, elbows tucked.
    this.restPose();
  }

  /**
   * Rifle-carry pose. Elbows tucked in against the ribs and both forearms
   * angled across the chest toward the weapon: from any angle the silhouette
   * has to read as "carrying a rifle", which mostly means no daylight between
   * the upper arms and the torso.
   */
  private restPose(): void {
    this.setBone('upperArmR', -0.95, 0.10, -0.42);
    this.setBone('lowerArmR', -0.85, 0.30, 0.15);
    this.setBone('upperArmL', -1.05, -0.30, 0.52);
    this.setBone('lowerArmL', -1.15, 0.45, -0.30);
  }

  private setBone(name: BoneName, x: number, y: number, z: number): void {
    const b = this.bones.get(name);
    if (b) b.rotation.set(x, y, z);
  }

  /* ------------------------------------------------------------ contract -- */

  bone(name: BoneName): THREE.Object3D | null { return this.bones.get(name) ?? null; }

  boneMatrix(name: BoneName, out: THREE.Matrix4): THREE.Matrix4 {
    const b = this.bones.get(name);
    if (!b) return out.identity();
    b.updateWorldMatrix(true, false);
    return out.copy(b.matrixWorld);
  }

  setLocomotion(state: LocoState, speed: number, strafe: number): void {
    this.loco = state;
    this.speed = speed;
    this.strafe = strafe;
    this.crouchTarget = state === 'crouch' ? 1 : state === 'prone' ? 1.4 : 0;
  }

  play(name: AnimName, opts?: { fade?: number; speed?: number; loop?: boolean }): void {
    void opts;
    this.oneShot = name;
    this.oneShotTime = 0;
    if (name === 'fire') this.recoil = Math.min(1.4, this.recoil + 0.8);
    if (name === 'coverPeekL') this.leanTarget = -1;
    else if (name === 'coverPeekR') this.leanTarget = 1;
    else if (name === 'coverHigh' || name === 'coverLow') this.leanTarget = 0;
  }

  setAim(yaw: number, pitch: number): void {
    this.aimYaw = THREE.MathUtils.clamp(yaw, -1.5, 1.5);
    this.aimPitch = THREE.MathUtils.clamp(pitch, -1.1, 1.1);
  }

  lookAt(target: THREE.Vector3 | null): void { this.lookTarget = target; }

  addRecoil(amount: number): void { this.recoil = Math.min(1.6, this.recoil + amount); }

  react(direction: THREE.Vector3, zone: HitZone, power: number): void {
    this.reactImpulse.copy(direction).normalize().multiplyScalar(power);
    this.reactTimer = 0.34;
    void zone;
  }

  ragdoll(impulse: THREE.Vector3, atZone: HitZone): void {
    if (this.ragdollActive) return;
    this.ragdollActive = true;
    this.dead = true;
    const phys = this.physics;
    if (!phys) {
      // No solver: collapse the rig so the corpse at least reads as down.
      this.object.rotation.x = -Math.PI * 0.47;
      this.object.position.y += 0.2;
      return;
    }
    const bones: Record<string, THREE.Object3D | null> = {};
    for (const [name, obj] of this.bones) bones[name] = obj;
    const handle = phys.spawnRagdoll({
      root: this.object, bones, mass: 84, entityId: this.entityId,
      velocity: this.velocity, quality: 4,
    });
    handle.applyImpulse(atZone, impulse);
  }

  get isRagdoll(): boolean { return this.ragdollActive; }

  setLOD(lod: number): void {
    // Cheap LOD: drop the small kit at distance, hide everything but the
    // silhouette at LOD 2.
    const showDetail = lod < 1;
    const showAll = lod < 2;
    for (const m of this.meshes) {
      const small = m.geometry === geo().pouch || m.geometry === geo().magazine;
      m.visible = showAll && (showDetail || !small);
      m.castShadow = lod < 2;
    }
  }

  update(dt: number): void {
    if (this.ragdollActive) return;

    /* stance ------------------------------------------------------------- */
    const k = 1 - Math.exp(-9 * dt);
    this.crouchBlend += (this.crouchTarget - this.crouchBlend) * k;
    const hips = this.bones.get('hips')!;
    hips.position.y = 0.95 - this.crouchBlend * 0.30;

    /* legs --------------------------------------------------------------- */
    const moving = this.speed > 0.15;
    const stride = this.loco === 'sprint' ? 2.05 : this.loco === 'run' ? 1.85 : 1.55;
    if (moving) this.phase += dt * this.speed * stride;
    else this.phase += dt * 0.9;

    const swing = moving ? Math.min(0.72, 0.16 + this.speed * 0.115) : 0;
    const s = Math.sin(this.phase * Math.PI);
    const c = Math.cos(this.phase * Math.PI);
    const crouchBend = this.crouchBlend * 0.85;

    const ulL = this.bones.get('upperLegL')!;
    const llL = this.bones.get('lowerLegL')!;
    const ulR = this.bones.get('upperLegR')!;
    const llR = this.bones.get('lowerLegR')!;
    ulL.rotation.x = s * swing + crouchBend * 0.9;
    ulR.rotation.x = -s * swing + crouchBend * 0.9;
    llL.rotation.x = Math.max(0, -s) * swing * 1.35 + crouchBend * 1.45;
    llR.rotation.x = Math.max(0, s) * swing * 1.35 + crouchBend * 1.45;
    this.bones.get('footL')!.rotation.x = -llL.rotation.x * 0.55 - ulL.rotation.x * 0.35;
    this.bones.get('footR')!.rotation.x = -llR.rotation.x * 0.55 - ulR.rotation.x * 0.35;
    // Hips counter-rotate with the stride and drop with the crouch.
    hips.rotation.y = moving ? -s * swing * 0.28 : 0;
    hips.position.x = this.strafe * 0.03;

    /* torso + aim -------------------------------------------------------- */
    this.aimYawSmooth += (this.aimYaw - this.aimYawSmooth) * (1 - Math.exp(-11 * dt));
    this.aimPitchSmooth += (this.aimPitch - this.aimPitchSmooth) * (1 - Math.exp(-11 * dt));
    this.lean += (this.leanTarget - this.lean) * (1 - Math.exp(-8 * dt));

    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    if (this.reactTimer > 0) this.reactTimer -= dt;
    const react = Math.max(0, this.reactTimer / 0.34);

    const spine = this.bones.get('spine')!;
    const chest = this.bones.get('chest')!;
    const head = this.bones.get('head')!;
    const runLean = moving ? Math.min(0.26, this.speed * 0.045) : 0;

    spine.rotation.y = this.aimYawSmooth * 0.35 + this.lean * 0.12;
    spine.rotation.z = -this.lean * 0.22 + this.strafe * 0.04;
    spine.rotation.x = runLean * 0.6 + this.crouchBlend * 0.18;

    chest.rotation.y = this.aimYawSmooth * 0.45;
    chest.rotation.x = -this.aimPitchSmooth * 0.55 + runLean * 0.4
      + this.recoil * 0.08 + react * this.reactImpulse.z * 0.05;
    chest.rotation.z = -this.lean * 0.3 + react * this.reactImpulse.x * 0.05;

    head.rotation.y = this.aimYawSmooth * 0.25;
    head.rotation.x = -this.aimPitchSmooth * 0.4 - runLean * 0.5;
    if (this.lookTarget) {
      head.updateWorldMatrix(true, false);
      _lookV.setFromMatrixPosition(head.matrixWorld).sub(this.lookTarget);
      // Only the yaw component; a proxy head snapping in pitch reads badly.
      const yaw = Math.atan2(_lookV.x, _lookV.z) - this.object.rotation.y - Math.PI;
      head.rotation.y = THREE.MathUtils.clamp(wrapPi(yaw), -0.9, 0.9);
    }

    /* arms --------------------------------------------------------------- */
    this.restPose();
    const armR = this.bones.get('upperArmR')!;
    const armL = this.bones.get('upperArmL')!;
    armR.rotation.x += this.aimPitchSmooth * 0.45 - this.recoil * 0.22;
    armL.rotation.x += this.aimPitchSmooth * 0.4 - this.recoil * 0.16;
    if (!moving) {
      const breathe = Math.sin(this.phase * 1.2) * 0.012;
      armR.rotation.x += breathe;
      armL.rotation.x += breathe;
    }

    /* one-shots ---------------------------------------------------------- */
    if (this.oneShot) {
      this.oneShotTime += dt;
      if (this.oneShot === 'reload') {
        const t = Math.min(1, this.oneShotTime / 2.0);
        const pull = Math.sin(t * Math.PI);
        armL.rotation.x -= pull * 0.75;
        armL.rotation.y += pull * 0.35;
        chest.rotation.x += pull * 0.12;
        if (t >= 1) this.oneShot = null;
      } else if (this.oneShot === 'throw') {
        const t = Math.min(1, this.oneShotTime / 0.85);
        const wind = Math.sin(t * Math.PI);
        armR.rotation.x -= wind * 1.9;
        chest.rotation.y += wind * 0.3;
        if (t >= 1) this.oneShot = null;
      } else if (this.oneShotTime > 0.5) {
        this.oneShot = null;
      }
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    // Geometry and materials are shared; only the graph is ours to drop.
    this.bones.clear();
    this.meshes.length = 0;
    this.weapon = null;
  }

  /** Muzzle position in world space, for tracers and shot origins. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.weapon) return false;
    this.weapon.updateWorldMatrix(true, false);
    out.set(0, 0, 0.40).applyMatrix4(this.weapon.matrixWorld);
    return true;
  }

  get isDead(): boolean { return this.dead; }
}

const _lookV = new THREE.Vector3();
function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Disposes the shared geometry cache. Only for teardown in tests. */
export function disposeProxyResources(): void {
  if (GEO) {
    for (const key of Object.keys(GEO) as Array<keyof SharedGeo>) GEO[key].dispose();
    GEO = null;
  }
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
}
