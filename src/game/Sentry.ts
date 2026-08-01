/**
 * Sentry turret killstreak.
 *
 * A real object in the world: a procedural turret that scans, acquires the
 * nearest visible hostile inside its arc, tracks it with rate-limited yaw/pitch
 * servos, fires two-round bursts with tracers and muzzle light, runs out of
 * ammo, and cooks off when its deployment expires.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import { MASK_BULLET, MASK_SIGHT } from '../physics/types';
import type { RayHit } from '../physics/types';
import type { GameServices } from './Services';
import type { CombatBridge } from './Combat';

const LIFETIME = 90;
const AMMO = 220;
const RANGE = 32;
const ARC = Math.PI * 0.92;          // ±83° from the placement heading
const RPM = 420;
const DAMAGE = 26;
const YAW_RATE = 3.4;                 // rad/s
const PITCH_RATE = 2.2;

export class SentryTurret {
  readonly group = new THREE.Group();
  private head = new THREE.Group();
  private barrels = new THREE.Group();
  private ledMat: THREE.MeshStandardMaterial;

  private baseYaw: number;
  private yaw = 0;
  private pitch = 0;
  private targetId = -1;
  private acquireTimer = 0;
  private fireTimer = 0;
  private burst = 0;
  private burstCooldown = 0;
  private recoil = 0;
  private scanPhase = 0;

  ammo = AMMO;
  life = LIFETIME;
  dead = false;

  private readonly _t = new THREE.Vector3();
  private readonly _m = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly _ray: RayHit = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: 'concrete',
    object: null,
    entityId: -1,
    bodyHandle: -1,
    zone: 'none',
    backface: false,
  };

  constructor(
    position: THREE.Vector3,
    yaw: number,
    private services: GameServices,
    private combat: CombatBridge,
    private rng: Rand,
  ) {
    this.position.copy(position);
    this.baseYaw = yaw;
    this.yaw = yaw;
    this.ledMat = new THREE.MeshStandardMaterial({
      color: 0x220604, emissive: 0xff2a12, emissiveIntensity: 3.2, roughness: 0.5,
    });
    this.build();
    this.group.position.copy(position);
    services.scene?.add(this.group);
  }

  private build(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.75 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x3d4247, roughness: 0.48, metalness: 0.8 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x121416, roughness: 0.92, metalness: 0.02 });

    const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.noCollide = true;
      parent.add(mesh);
      return mesh;
    };

    // Tripod: three splayed legs, a hub, then the rotating head.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = add(new THREE.BoxGeometry(0.055, 0.5, 0.055), dark, this.group,
        Math.cos(a) * 0.17, 0.25, Math.sin(a) * 0.17);
      leg.rotation.z = -Math.cos(a) * 0.38;
      leg.rotation.x = Math.sin(a) * 0.38;
      add(new THREE.CylinderGeometry(0.055, 0.075, 0.035, 8), rubber, this.group,
        Math.cos(a) * 0.30, 0.018, Math.sin(a) * 0.30);
    }
    add(new THREE.CylinderGeometry(0.13, 0.16, 0.11, 14), mid, this.group, 0, 0.53);

    this.head.position.y = 0.63;
    this.group.add(this.head);
    add(new THREE.BoxGeometry(0.30, 0.20, 0.26), mid, this.head);
    add(new THREE.BoxGeometry(0.12, 0.13, 0.10), dark, this.head, 0, 0.13, 0.06);   // optic housing
    const lens = add(new THREE.CylinderGeometry(0.042, 0.042, 0.02, 12), this.ledMat, this.head, 0, 0.13, 0.115);
    lens.rotation.x = Math.PI / 2;

    this.head.add(this.barrels);
    for (const x of [-0.075, 0.075]) {
      add(new THREE.CylinderGeometry(0.021, 0.021, 0.42, 8), dark, this.barrels, x, 0.01, 0.21)
        .rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.032, 0.032, 0.06, 8), mid, this.barrels, x, 0.01, 0.40)
        .rotation.x = Math.PI / 2;
    }
    // Ammo box slung under the receiver.
    add(new THREE.BoxGeometry(0.14, 0.14, 0.18), dark, this.head, 0, -0.14, -0.04);

    this.group.traverse((o) => { o.layers.set(LAYERS.DEFAULT); });
  }

  fixedUpdate(dt: number): void {
    if (this.dead) return;
    this.life -= dt;
    if (this.life <= 0 || this.ammo <= 0) { this.destroy(this.life <= 0); return; }

    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.barrels.position.z = -this.recoil * 0.06;

    /* --- acquisition --- */
    this.acquireTimer -= dt;
    if (this.targetId < 0 || this.acquireTimer <= 0) {
      this.acquireTimer = 0.35;
      this._m.copy(this.position); this._m.y += 0.63;
      const id = this.combat.nearestEnemy(this._m, RANGE, this._t);
      this.targetId = id >= 0 && this.inArc(this._t) && this.visible(this._t) ? id : -1;
    }

    let aiming = false;
    if (this.targetId >= 0 && this.combat.enemyPosition(this.targetId, this._t)) {
      this._t.y += 1.15;
      this._m.copy(this.position); this._m.y += 0.63;
      this._d.copy(this._t).sub(this._m);
      const dist = this._d.length();
      if (dist > RANGE * 1.15 || !this.inArc(this._t)) {
        this.targetId = -1;
      } else {
        const wantYaw = Math.atan2(this._d.x, this._d.z);
        const wantPitch = Math.asin(THREE.MathUtils.clamp(this._d.y / Math.max(0.001, dist), -1, 1));
        this.yaw = stepAngle(this.yaw, wantYaw, YAW_RATE * dt);
        this.pitch = stepAngle(this.pitch, wantPitch, PITCH_RATE * dt);
        aiming = Math.abs(angleDelta(this.yaw, wantYaw)) < 0.11 && Math.abs(this.pitch - wantPitch) < 0.11;
        if (aiming) this.tryFire(dt, dist);
      }
    } else {
      this.targetId = -1;
    }

    if (this.targetId < 0) {
      // Idle scan: a slow sweep across the arc reads as "alive" in a still frame.
      this.scanPhase += dt * 0.55;
      this.yaw = this.baseYaw + Math.sin(this.scanPhase) * ARC * 0.45;
      this.pitch = stepAngle(this.pitch, -0.04, PITCH_RATE * dt);
      this.burst = 0;
    }

    this.head.rotation.y = this.yaw;
    this.barrels.rotation.x = -this.pitch;
    this.ledMat.emissiveIntensity = this.targetId >= 0 ? 5.5 : 1.6 + Math.sin(this.scanPhase * 4) * 0.6;
    this.ledMat.color.setHex(this.targetId >= 0 ? 0x330805 : 0x0a2a10);
    this.ledMat.emissive.setHex(this.targetId >= 0 ? 0xff2a12 : 0x2bff6a);
  }

  private tryFire(dt: number, dist: number): void {
    if (this.burstCooldown > 0) { this.burstCooldown -= dt; return; }
    if (this.burst <= 0) this.burst = 2;
    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;
    this.fireTimer = 60 / RPM;
    this.burst--;
    this.ammo--;
    if (this.burst <= 0) this.burstCooldown = 0.22;
    this.recoil = 1;

    this._m.copy(this.position); this._m.y += 0.63;
    this._d.copy(this._t).sub(this._m).normalize();
    this._m.addScaledVector(this._d, 0.45);

    bus.emit('ai:fire', { id: -2, origin: this._m.clone(), direction: this._d.clone() });
    this.services.render?.addDynamicLight({
      position: this._m.clone(), color: 0xffc477, intensity: 26, radius: 6, lifetime: 0.045, decay: 'flash',
    });

    // Same MASK_BULLET path the player uses — no coin-flip hitChance.
    const physics = this.services.physics;
    const maxRange = Math.min(RANGE * 1.2, Math.max(dist + 2, 4));
    if (physics?.ready) {
      const h = physics.raycast(this._m, this._d, maxRange, MASK_BULLET, this._ray);
      if (h.hit) {
        bus.emit('bullet:impact', {
          point: h.point.clone(), normal: h.normal.clone(), surface: h.surface,
          incoming: this._d.clone(), energy: DAMAGE * 22, penetrated: false,
        });
        // Prefer the acquired target when the ray lands on it; also accept any
        // hostile entity the bullet collides with along the aim line.
        const target = h.entityId >= 0 ? h.entityId : this.targetId;
        if (h.entityId >= 0 || h.surface === 'flesh' || h.surface === 'armor' || h.surface === 'helmet') {
          const zone = h.zone && h.zone !== 'none' ? h.zone : 'chest';
          const multi = zone === 'head' || zone === 'neck' ? 2.0
            : zone === 'stomach' ? 0.9
              : zone === 'arm' || zone === 'leg' ? 0.7 : 1;
          this.combat.damage(target, DAMAGE * multi, 'sentry', h.point, this._d);
        }
      }
    } else {
      // Headless / no physics: direct damage (deterministic lab path).
      this.combat.damage(this.targetId, DAMAGE, 'sentry', this._t, this._d);
    }
    void this.rng;
  }

  private inArc(p: THREE.Vector3): boolean {
    const a = Math.atan2(p.x - this.position.x, p.z - this.position.z);
    return Math.abs(angleDelta(this.baseYaw, a)) <= ARC * 0.5;
  }

  private visible(p: THREE.Vector3): boolean {
    const physics = this.services.physics;
    if (!physics?.ready) return true;
    this._m.copy(this.position); this._m.y += 0.63;
    this._d.copy(p); this._d.y += 1.1;
    return physics.lineOfSight(this._m, this._d, MASK_SIGHT);
  }

  /** Cooks off: a small explosion, then the mesh is gone. */
  destroy(expired: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this._m.copy(this.position); this._m.y += 0.55;
    if (expired) this.combat.explode(this._m, 4.5, 55, 'sentry');
    this.dispose();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) for (const x of mat) x.dispose(); else mat.dispose();
      }
    });
  }
}

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function stepAngle(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  return current + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}
