/**
 * Killstreak rewards.
 *
 * Five abilities, all implemented for real rather than as HUD text:
 *
 *   UAV            a drone really orbits the map and sweeps radar contacts
 *   Counter-UAV    jams enemy accuracy and blanks the enemy's picture
 *   Care Package   a bird drops a crate that must be walked to and claimed
 *   Airstrike      the player paints a point; jets run in and walk bombs on it
 *   Sentry Turret  a physical turret that acquires, tracks and fires
 *
 * Earning follows the genre convention: each reward is granted once per life
 * when the un-broken kill count reaches its threshold, queued into three slots,
 * and fired with the tactical key.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import { AirstrikeRun } from './Airstrike';
import { CarePackage } from './CarePackage';
import { SentryTurret } from './Sentry';
import type { CombatBridge } from './Combat';
import type { GameServices } from './Services';
import type { KillstreakId, KillstreakView, RadarContact } from './types';

export interface KillstreakDef {
  id: KillstreakId;
  name: string;
  short: string;
  cost: number;
  duration: number;
  description: string;
}

export const KILLSTREAK_DEFS: Record<KillstreakId, KillstreakDef> = {
  uav: {
    id: 'uav', name: 'UAV Recon', short: 'UAV', cost: 3, duration: 32,
    description: 'Reveals enemy positions on the minimap',
  },
  counteruav: {
    id: 'counteruav', name: 'Counter-UAV', short: 'CUAV', cost: 4, duration: 28,
    description: 'Jams enemy targeting and comms',
  },
  carepackage: {
    id: 'carepackage', name: 'Care Package', short: 'PKG', cost: 5, duration: 0,
    description: 'Airdrops a random killstreak',
  },
  airstrike: {
    id: 'airstrike', name: 'Precision Airstrike', short: 'STRIKE', cost: 7, duration: 0,
    description: 'Mark a target for a bombing run',
  },
  sentry: {
    id: 'sentry', name: 'Sentry Turret', short: 'SENTRY', cost: 9, duration: 90,
    description: 'Deploys an automated turret',
  },
};

const EARN_ORDER: readonly KillstreakId[] = ['uav', 'counteruav', 'carepackage', 'airstrike', 'sentry'];
const MAX_SLOTS = 3;
const UAV_SWEEP = 2.2;
const MARK_RANGE = 220;

export class Killstreaks {
  /** Earned and waiting, oldest first. */
  slots: KillstreakId[] = [];
  selected = 0;

  private awarded = new Set<KillstreakId>();
  private uavTimer = 0;
  private uavSweep = 0;
  private counterTimer = 0;
  private sentries: SentryTurret[] = [];
  private strikes: AirstrikeRun[] = [];
  private packages: CarePackage[] = [];
  private drone: UavDrone | null = null;

  /** Airstrike target-marking state. */
  marking = false;
  markValid = false;
  readonly markPoint = new THREE.Vector3();

  readonly contacts: RadarContact[] = [];
  private contactPool: RadarContact[] = [];
  private scratch: THREE.Vector3[] = [];
  private readonly _p = new THREE.Vector3();
  private used = 0;
  private viewBuf: KillstreakView[] = [];
  private viewPool: KillstreakView[] = [];

  private viewRow(i: number): KillstreakView {
    while (this.viewPool.length <= i) {
      this.viewPool.push({
        id: 'uav', name: '', cost: 0, ready: false, active: false, remaining: -1, selected: false,
      });
    }
    return this.viewPool[i];
  }

  constructor(
    private services: GameServices,
    private combat: CombatBridge,
    private rng: Rand,
  ) { }

  /** Re-seeds the reward stream when a match (re)starts. */
  setRng(rng: Rand): void { this.rng = rng; }

  /** Staging helper: makes exactly one reward ready and selected. */
  forceReady(id: KillstreakId): void {
    this.slots.length = 0;
    this.slots.push(id);
    this.selected = 0;
    this.awarded.add(id);
  }

  get killstreaksUsed(): number { return this.used; }
  get uavActive(): boolean { return this.uavTimer > 0; }
  get counterUavActive(): boolean { return this.counterTimer > 0; }

  reset(): void {
    this.slots.length = 0;
    this.selected = 0;
    this.awarded.clear();
    this.uavTimer = 0;
    this.counterTimer = 0;
    this.marking = false;
    this.contacts.length = 0;
    this.used = 0;
    this.clearDeployed();
  }

  /** Wipes earned-but-unused rewards; called when the player dies. */
  onDeath(): void {
    this.awarded.clear();
    this.marking = false;
  }

  /**
   * Grants any reward whose threshold the current streak has crossed.
   * Returns the ids granted this call so the caller can announce them.
   */
  onStreak(streak: number): KillstreakId[] {
    const granted: KillstreakId[] = [];
    for (const id of EARN_ORDER) {
      const def = KILLSTREAK_DEFS[id];
      if (streak < def.cost || this.awarded.has(id)) continue;
      this.awarded.add(id);
      if (this.slots.length >= MAX_SLOTS) continue;
      this.slots.push(id);
      granted.push(id);
      this.services.emit('killstreak:ready', { id, name: def.name, slot: this.slots.length - 1 });
      bus.emit('killstreak:earned', { name: def.name, count: def.cost });
      this.services.emit('hud:banner', {
        title: def.name.toUpperCase(), subtitle: 'READY — [T] to deploy', kind: 'reward', ttl: 2.8,
      });
    }
    return granted;
  }

  /** The next reward the player is working toward. */
  nextReward(streak: number): { id: KillstreakId | null; needed: number } {
    for (const id of EARN_ORDER) {
      if (this.awarded.has(id)) continue;
      return { id, needed: Math.max(0, KILLSTREAK_DEFS[id].cost - streak) };
    }
    return { id: null, needed: 0 };
  }

  cycleSelection(): void {
    if (this.slots.length === 0) return;
    this.selected = (this.selected + 1) % this.slots.length;
    this.services.emit('killstreak:select', { id: this.slots[this.selected], slot: this.selected });
  }

  /** Adds a reward directly (care-package payout). */
  grant(id: KillstreakId): void {
    if (this.slots.length >= MAX_SLOTS) return;
    this.slots.push(id);
    this.services.emit('killstreak:ready', {
      id, name: KILLSTREAK_DEFS[id].name, slot: this.slots.length - 1,
    });
  }

  /**
   * Fires the selected reward. Airstrike enters marking mode instead of
   * deploying immediately; everything else deploys on the spot.
   */
  activate(playerPos: THREE.Vector3 | null, playerYaw: number): boolean {
    if (this.marking) return false;
    if (this.slots.length === 0 || !playerPos) return false;
    const id = this.slots[Math.min(this.selected, this.slots.length - 1)];

    if (id === 'airstrike') {
      this.marking = true;
      this.markValid = false;
      this.services.emit('airstrike:marking', { active: true, valid: false, point: this.markPoint.clone() });
      this.services.emit('hud:banner', {
        title: 'PAINT THE TARGET', subtitle: '[F] confirm · [V] cancel', kind: 'alert', ttl: 3,
      });
      return true;
    }

    this.consume(id);
    this.deploy(id, playerPos, playerYaw);
    return true;
  }

  private consume(id: KillstreakId): void {
    const i = this.slots.indexOf(id);
    if (i >= 0) this.slots.splice(i, 1);
    if (this.selected >= this.slots.length) this.selected = Math.max(0, this.slots.length - 1);
    this.used++;
  }

  private deploy(id: KillstreakId, at: THREE.Vector3, yaw: number): void {
    const def = KILLSTREAK_DEFS[id];
    this.services.emit('killstreak:activated', { id, name: def.name, position: at.clone() });
    this.services.emit('hud:announce', { key: `ks-${id}`, text: def.name.toUpperCase(), priority: 6 });

    switch (id) {
      case 'uav': {
        this.uavTimer = def.duration;
        this.uavSweep = 0;
        if (!this.drone && this.services.scene) {
          this.drone = new UavDrone(this.services.scene, this.centreOfPlay());
        }
        this.services.emit('uav:sweep', { active: true, period: UAV_SWEEP, counter: false });
        break;
      }
      case 'counteruav': {
        this.counterTimer = def.duration;
        this.applyAccuracyScale();
        this.services.emit('uav:sweep', { active: true, period: UAV_SWEEP, counter: true });
        break;
      }
      case 'sentry': {
        this._p.copy(at);
        this._p.y = this.combat.groundAt(at.x, at.z, at.y);
        // Set it down a step in front of the player so it is not inside them.
        this._p.x += Math.sin(yaw) * 1.1;
        this._p.z += Math.cos(yaw) * 1.1;
        this.sentries.push(new SentryTurret(this._p, yaw, this.services, this.combat, this.rng));
        break;
      }
      case 'carepackage': {
        this._p.copy(at);
        this._p.x += Math.sin(yaw) * 7;
        this._p.z += Math.cos(yaw) * 7;
        this._p.y = this.combat.groundAt(this._p.x, this._p.z, at.y);
        this.packages.push(new CarePackage(this._p, yaw + Math.PI * 0.35, this.services, this.combat, this.rng));
        break;
      }
      case 'airstrike': {
        // The flight runs in over the player's shoulder and on to the mark —
        // the classic read, and it means the player always sees the aircraft.
        const from = this.services.player?.position;
        const heading = from
          ? Math.atan2(at.x - from.x, at.z - from.z)
          : this.rng.range(0, Math.PI * 2);
        this.strikes.push(new AirstrikeRun(at, heading, this.services, this.combat, this.rng));
        break;
      }
    }
  }

  /* ------------------------------------------------------------- marking -- */

  /** Called every frame while marking; traces the player's aim onto the world. */
  updateMarking(camera: THREE.PerspectiveCamera | null): void {
    if (!this.marking || !camera) return;
    this._p.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const physics = this.services.physics;
    if (physics?.ready) {
      const hit = physics.raycast(camera.position, this._p, MARK_RANGE, 0xffff, MARK_HIT);
      if (hit.hit && hit.normal.y > 0.35) {
        this.markPoint.copy(hit.point);
        this.markValid = true;
      } else if (hit.hit) {
        this.markPoint.copy(hit.point);
        this.markValid = false;
      } else {
        this.markValid = false;
      }
    } else {
      // No physics: project onto the ground plane under the reticle.
      const t = this._p.y < -0.01 ? (this.combat.groundAt(camera.position.x, camera.position.z, 0) - camera.position.y) / this._p.y : -1;
      if (t > 0 && t < MARK_RANGE) {
        this.markPoint.copy(camera.position).addScaledVector(this._p, t);
        this.markValid = true;
      } else this.markValid = false;
    }
    this.services.emit('airstrike:marking', {
      active: true, valid: this.markValid, point: this.markPoint.clone(),
    });
  }

  confirmMark(): boolean {
    if (!this.marking || !this.markValid) return false;
    this.marking = false;
    this.consume('airstrike');
    this.deploy('airstrike', this.markPoint, 0);
    this.services.emit('airstrike:marking', { active: false, valid: false, point: this.markPoint.clone() });
    return true;
  }

  cancelMark(): void {
    if (!this.marking) return;
    this.marking = false;
    this.services.emit('airstrike:marking', { active: false, valid: false, point: this.markPoint.clone() });
  }

  /* -------------------------------------------------------------- update -- */

  fixedUpdate(dt: number, playerPos: THREE.Vector3 | null, interacting: boolean): void {
    /* UAV */
    if (this.uavTimer > 0) {
      this.uavTimer -= dt;
      this.uavSweep -= dt;
      if (this.uavSweep <= 0) {
        this.uavSweep = UAV_SWEEP;
        this.sweep();
      }
      if (this.uavTimer <= 0) {
        this.contacts.length = 0;
        this.services.emit('uav:sweep', { active: false, period: UAV_SWEEP, counter: false });
        this.services.emit('killstreak:expired', { id: 'uav', name: KILLSTREAK_DEFS.uav.name });
        this.drone?.dispose();
        this.drone = null;
      }
    }
    this.drone?.fixedUpdate(dt);

    /* Counter-UAV */
    if (this.counterTimer > 0) {
      this.counterTimer -= dt;
      if (this.counterTimer <= 0) {
        this.applyAccuracyScale();
        this.services.emit('uav:sweep', { active: false, period: UAV_SWEEP, counter: true });
        this.services.emit('killstreak:expired', { id: 'counteruav', name: KILLSTREAK_DEFS.counteruav.name });
      }
    }

    /* deployed hardware */
    for (let i = this.sentries.length - 1; i >= 0; i--) {
      const s = this.sentries[i];
      s.fixedUpdate(dt);
      if (s.dead) {
        this.sentries.splice(i, 1);
        this.services.emit('killstreak:expired', { id: 'sentry', name: KILLSTREAK_DEFS.sentry.name });
      }
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.fixedUpdate(dt);
      if (s.done) this.strikes.splice(i, 1);
    }
    for (let i = this.packages.length - 1; i >= 0; i--) {
      const p = this.packages[i];
      p.fixedUpdate(dt);
      const reward = p.tryClaim(playerPos, interacting, dt);
      if (reward) {
        this.grant(reward);
        bus.emit('killstreak:earned', { name: KILLSTREAK_DEFS[reward].name, count: 0 });
      }
      if (p.done) this.packages.splice(i, 1);
    }
  }

  /** Writes the current radar picture. */
  private sweep(): void {
    const n = this.combat.enemyPositions(this.scratch);
    this.contacts.length = 0;
    for (let i = 0; i < n; i++) {
      while (this.contactPool.length <= i) this.contactPool.push({ x: 0, z: 0, yaw: 0, hostile: true });
      const c = this.contactPool[i];
      c.x = this.scratch[i].x;
      c.z = this.scratch[i].z;
      c.yaw = 0;
      c.hostile = true;
      this.contacts.push(c);
    }
    this.services.emit('radar:contacts', { contacts: this.contacts, source: 'uav' });
  }

  private applyAccuracyScale(): void {
    const scale = this.counterTimer > 0 ? 0.55 : 1;
    this.services.actors?.setAccuracyScale?.(scale);
    this.services.emit('ai:accuracy:scale', { scale });
  }

  private centreOfPlay(): THREE.Vector3 {
    const p = this.services.player?.position;
    return p ? this._p.copy(p).setY(this.combat.groundAt(p.x, p.z, p.y)).clone() : new THREE.Vector3();
  }

  /** Reused array + reused rows: this is rebuilt every frame for the HUD. */
  views(): KillstreakView[] {
    const out = this.viewBuf;
    out.length = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const id = this.slots[i];
      const def = KILLSTREAK_DEFS[id];
      const v = this.viewRow(out.length);
      v.id = id; v.name = def.name; v.cost = def.cost; v.ready = true;
      v.active = this.isActive(id); v.remaining = this.remainingFor(id); v.selected = i === this.selected;
      out.push(v);
    }
    for (const id of EARN_ORDER) {
      if (!this.isActive(id) || this.slots.includes(id)) continue;
      const def = KILLSTREAK_DEFS[id];
      const v = this.viewRow(out.length);
      v.id = id; v.name = def.name; v.cost = def.cost; v.ready = false;
      v.active = true; v.remaining = this.remainingFor(id); v.selected = false;
      out.push(v);
    }
    return out;
  }

  private isActive(id: KillstreakId): boolean {
    switch (id) {
      case 'uav': return this.uavTimer > 0;
      case 'counteruav': return this.counterTimer > 0;
      case 'sentry': return this.sentries.length > 0;
      case 'airstrike': return this.strikes.length > 0;
      case 'carepackage': return this.packages.length > 0;
    }
  }

  private remainingFor(id: KillstreakId): number {
    if (id === 'uav') return this.uavTimer > 0 ? this.uavTimer : -1;
    if (id === 'counteruav') return this.counterTimer > 0 ? this.counterTimer : -1;
    if (id === 'sentry') return this.sentries.length ? this.sentries[0].life : -1;
    return -1;
  }

  clearDeployed(): void {
    for (const s of this.sentries) s.dispose();
    for (const s of this.strikes) s.dispose();
    for (const p of this.packages) p.dispose();
    this.sentries.length = 0;
    this.strikes.length = 0;
    this.packages.length = 0;
    this.drone?.dispose();
    this.drone = null;
  }

  dispose(): void { this.clearDeployed(); }
}

const MARK_HIT = /* reused ray result for the marking trace */ (() => {
  const v = new THREE.Vector3();
  return {
    hit: false, point: v.clone(), normal: v.clone().set(0, 1, 0), distance: Infinity,
    surface: 'concrete' as const, object: null, entityId: -1, bodyHandle: -1,
    zone: 'none' as const, backface: false,
  };
})();

/* ------------------------------------------------------------- UAV drone -- */

/**
 * The physical UAV: a small procedural airframe that orbits the play space
 * while the reward is up. Cheap (one group, three meshes) and entirely visual —
 * losing it changes nothing about the radar sweep.
 */
class UavDrone {
  private group = new THREE.Group();
  private t = 0;
  private centre = new THREE.Vector3();
  private radius = 46;
  private altitude = 42;

  constructor(scene: THREE.Object3D, centre: THREE.Vector3) {
    this.centre.copy(centre);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a5158, roughness: 0.5, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.7, metalness: 0.3 });

    const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 2.4, 4, 8), mat);
    fuse.rotation.x = Math.PI / 2;
    this.group.add(fuse);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.09, 0.62), mat);
    wing.position.z = 0.2;
    this.group.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.42), mat);
    tail.position.z = -1.5;
    this.group.add(tail);
    for (const s of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.42), dark);
      fin.position.set(s * 0.85, 0.36, -1.5);
      this.group.add(fin);
    }
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), dark);
    dome.position.set(0, -0.24, 0.5);
    this.group.add(dome);

    this.group.traverse((o) => {
      o.userData.noCollide = true;
      o.layers.set(LAYERS.DEFAULT);
      (o as THREE.Mesh).castShadow = settings.gfx.shadows;
    });
    scene.add(this.group);
  }

  fixedUpdate(dt: number): void {
    this.t += dt * 0.16;
    const x = this.centre.x + Math.cos(this.t) * this.radius;
    const z = this.centre.z + Math.sin(this.t) * this.radius;
    this.group.position.set(x, this.centre.y + this.altitude, z);
    this.group.rotation.y = -this.t + Math.PI * 0.5;
    this.group.rotation.z = 0.22;
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
