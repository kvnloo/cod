/**
 * Grenades — frag, flashbang and smoke.
 *
 * Throwing is the only part of a shooter where the player is asked to solve a
 * ballistic problem in their head, so the arc has to be honest: the predicted
 * ribbon comes from `PhysicsAPI.predictTrajectory`, which integrates the same
 * gravity, restitution and friction the live body uses and sphere-casts every
 * step — including bounces. Where the line lands is where the grenade lands.
 *
 * Cooking is a real timer on the fuse, not a throw-strength meter: hold to burn
 * fuse, release to throw, hold too long and it goes off in your hand.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { Rand } from '../core/Rand';
import type { PhysicsAPI, ProjectileOptions, TrajectoryResult } from '../physics/types';
import { LAYER, MASK_MOVE } from '../physics/types';
import type { RenderAPI } from '../render/types';
import type { Ballistics } from './Ballistics';
import type { WeaponMaterials } from './WeaponMaterials';
import { chamferBox, disc, lathe, merge, projectUV, rod, torusZ, xf } from './mesh/Geo';
import { WEAPON_TEXEL_SCALE } from './WeaponMaterials';

/**
 * The projectile services the Rapier backend adds on top of the core
 * `PhysicsAPI`. Declared structurally so this module never imports the backend
 * and still gets full type checking on the calls it makes.
 */
export interface ProjectilePhysics extends PhysicsAPI {
  spawnProjectile?(opts: ProjectileOptions): object;
  removeProjectile?(p: object): void;
  predictTrajectory?(
    origin: THREE.Vector3, velocity: THREE.Vector3, out: Float32Array,
    opts?: {
      radius?: number; restitution?: number; friction?: number; maxTime?: number;
      step?: number; maxBounces?: number; mask?: number; ignoreEntity?: number;
    },
  ): TrajectoryResult;
}

export type GrenadeKind = 'frag' | 'flash' | 'smoke';

export interface GrenadeDef {
  id: GrenadeKind;
  name: string;
  /** Seconds from pin-pull to detonation. */
  fuse: number;
  cookable: boolean;
  throwSpeed: number;
  underhandSpeed: number;
  radius: number;
  damage: number;
  power: number;
  mass: number;
  restitution: number;
  rollingFriction: number;
  /** How many the player starts with. */
  carried: number;
  /** Seconds the effect persists after detonation (smoke). */
  duration: number;
}

export const GRENADES: Record<GrenadeKind, GrenadeDef> = {
  frag: {
    id: 'frag', name: 'Frag', fuse: 3.4, cookable: true,
    throwSpeed: 17.5, underhandSpeed: 7.0,
    radius: 6.2, damage: 145, power: 26,
    mass: 0.4, restitution: 0.30, rollingFriction: 2.4, carried: 2, duration: 0,
  },
  flash: {
    id: 'flash', name: 'Flashbang', fuse: 1.9, cookable: false,
    throwSpeed: 18.5, underhandSpeed: 7.5,
    radius: 12.0, damage: 0, power: 4,
    mass: 0.3, restitution: 0.38, rollingFriction: 2.0, carried: 2, duration: 0,
  },
  smoke: {
    id: 'smoke', name: 'Smoke', fuse: 1.6, cookable: false,
    throwSpeed: 16.0, underhandSpeed: 6.5,
    radius: 7.5, damage: 0, power: 2,
    mass: 0.55, restitution: 0.22, rollingFriction: 3.2, carried: 1, duration: 14,
  },
};

interface LiveGrenade {
  active: boolean;
  kind: GrenadeKind;
  fuse: number;
  id: number;
  mesh: THREE.Mesh;
  handle: object | null;
  fromPlayer: boolean;
  ownerEntity: number;
  spin: THREE.Vector3;
}

const ARC_POINTS = 96;

export class GrenadeSystem {
  physics: ProjectilePhysics | null = null;
  render: RenderAPI | null = null;
  ballistics: Ballistics | null = null;
  /** Scene root for live grenades and the arc ribbon. */
  readonly root = new THREE.Group();

  /** Ammo by kind. */
  readonly stock: Record<GrenadeKind, number> = { frag: 2, flash: 2, smoke: 1 };
  selected: GrenadeKind = 'frag';

  /** Cook state. */
  cooking = false;
  cookTime = 0;
  private cookKind: GrenadeKind = 'frag';

  private live: LiveGrenade[] = [];
  private nextId = 1;
  private rand = new Rand('grenades');
  private geoms = new Map<GrenadeKind, THREE.BufferGeometry>();
  private arc: THREE.Line;
  private arcPositions = new Float32Array(ARC_POINTS * 3);
  private arcBuffer = new Float32Array(ARC_POINTS * 3);
  private impact: THREE.Mesh;
  private mats: WeaponMaterials;

  private readonly _p = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();

  constructor(mats: WeaponMaterials) {
    this.mats = mats;
    this.root.name = 'grenades';

    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    arcGeo.setDrawRange(0, 0);
    this.arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({
      color: 0x7fe0ff, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false,
    }));
    this.arc.frustumCulled = false;
    this.arc.renderOrder = 20;
    this.arc.visible = false;
    this.root.add(this.arc);

    this.impact = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.22, 24),
      new THREE.MeshBasicMaterial({
        color: 0x7fe0ff, transparent: true, opacity: 0.75,
        depthTest: false, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    this.impact.visible = false;
    this.impact.renderOrder = 21;
    this.root.add(this.impact);
  }

  /* ----------------------------------------------------------------- mesh */

  private geometryFor(kind: GrenadeKind): THREE.BufferGeometry {
    const cached = this.geoms.get(kind);
    if (cached) return cached;
    const parts: THREE.BufferGeometry[] = [];

    if (kind === 'frag') {
      // Ovoid body with a fragmentation sleeve and a fuse assembly.
      parts.push(lathe([
        [-0.038, 0.004], [-0.036, 0.018], [-0.020, 0.028], [0.006, 0.029],
        [0.022, 0.024], [0.030, 0.013], [0.032, 0.010],
      ], 18));
      for (let i = 0; i < 7; i++) {
        parts.push(xf(torusZ(0.0292, 0.0012, 18, 6), { pos: [0, 0, -0.030 + i * 0.0095] }));
      }
      parts.push(xf(rod(0.010, 0.020, 12), { pos: [0, 0, 0.040] }));
      parts.push(xf(disc(0.010, 0, 1, 12), { pos: [0, 0, 0.050] }));
      // Spoon and ring.
      parts.push(xf(chamferBox(0.006, 0.0022, 0.044, 0.0005), { pos: [0.011, 0, 0.026] }));
      parts.push(xf(torusZ(0.007, 0.0013, 12, 6), { pos: [-0.012, 0, 0.044], rot: [0, Math.PI / 2, 0] }));
    } else if (kind === 'flash') {
      parts.push(lathe([
        [-0.052, 0.006], [-0.050, 0.020], [-0.044, 0.021], [0.030, 0.021],
        [0.036, 0.019], [0.038, 0.012],
      ], 16));
      for (let i = 0; i < 4; i++) {
        parts.push(xf(torusZ(0.0212, 0.0016, 16, 6), { pos: [0, 0, -0.030 + i * 0.018] }));
      }
      parts.push(xf(rod(0.009, 0.018, 10), { pos: [0, 0, 0.046] }));
      parts.push(xf(chamferBox(0.005, 0.0020, 0.040, 0.0005), { pos: [0.010, 0, 0.030] }));
    } else {
      parts.push(lathe([
        [-0.062, 0.008], [-0.058, 0.024], [0.040, 0.024], [0.046, 0.020], [0.048, 0.012],
      ], 16));
      for (let i = 0; i < 5; i++) {
        parts.push(xf(torusZ(0.0245, 0.0014, 16, 6), { pos: [0, 0, -0.045 + i * 0.020] }));
      }
      // Emission ports.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const g = chamferBox(0.005, 0.003, 0.006, 0.0004);
        xf(g, { pos: [0, 0.0235, 0.030] });
        xf(g, { rot: [0, 0, a] });
        parts.push(g);
      }
      parts.push(xf(rod(0.008, 0.016, 10), { pos: [0, 0, 0.054] }));
    }

    const g = merge(parts);
    projectUV(g, WEAPON_TEXEL_SCALE);
    g.computeBoundingSphere();
    this.geoms.set(kind, g);
    return g;
  }

  private materialFor(kind: GrenadeKind): THREE.Material {
    if (kind === 'frag') return this.mats.world('phosphate');
    if (kind === 'flash') return this.mats.world('alu');
    return this.mats.world('polymerTan');
  }

  /* ----------------------------------------------------------------- cook */

  select(kind: GrenadeKind): void { this.selected = kind; }

  /** Begins cooking (or simply readying) the selected grenade. */
  beginCook(): boolean {
    if (this.cooking) return false;
    const kind = this.selected;
    if (this.stock[kind] <= 0) return false;
    this.cooking = true;
    this.cookKind = kind;
    this.cookTime = 0;
    return true;
  }

  /** Aborts the throw and puts the grenade away (no ammo lost). */
  cancelCook(): void {
    this.cooking = false;
    this.cookTime = 0;
    this.arc.visible = false;
    this.impact.visible = false;
  }

  /**
   * Releases the throw. `origin`/`direction` come from the camera; `underhand`
   * switches to a short lob.
   */
  release(origin: THREE.Vector3, direction: THREE.Vector3, underhand: boolean,
    ownerEntity: number, fromPlayer: boolean, inheritVelocity?: THREE.Vector3): boolean {
    if (!this.cooking) return false;
    const def = GRENADES[this.cookKind];
    if (this.stock[this.cookKind] <= 0) { this.cancelCook(); return false; }
    this.stock[this.cookKind]--;
    this.cooking = false;
    this.arc.visible = false;
    this.impact.visible = false;

    const speed = underhand ? def.underhandSpeed : def.throwSpeed;
    this._v.copy(direction).normalize().multiplyScalar(speed);
    // A slight upward bias makes a flat throw arc naturally.
    this._v.y += underhand ? 1.4 : 2.2;
    if (inheritVelocity) this._v.addScaledVector(inheritVelocity, 0.6);

    this._p.copy(origin).addScaledVector(direction, 0.35);
    this.spawn(this.cookKind, this._p, this._v, Math.max(0.05, def.fuse - this.cookTime), ownerEntity, fromPlayer);
    this.cookTime = 0;
    return true;
  }

  /** Spawns a live grenade directly — used by AI and by scripted sequences. */
  spawn(kind: GrenadeKind, position: THREE.Vector3, velocity: THREE.Vector3,
    fuse: number, ownerEntity: number, fromPlayer: boolean): number {
    const def = GRENADES[kind];
    const slot = this.live.find((g) => !g.active) ?? this.createSlot(kind);
    slot.active = true;
    slot.kind = kind;
    slot.fuse = fuse;
    slot.id = this.nextId++;
    slot.ownerEntity = ownerEntity;
    slot.fromPlayer = fromPlayer;
    slot.mesh.geometry = this.geometryFor(kind);
    slot.mesh.material = this.materialFor(kind);
    slot.mesh.visible = true;
    slot.mesh.position.copy(position);
    slot.spin.set(this.rand.signed() * 14, this.rand.signed() * 10, this.rand.signed() * 18);

    if (this.physics) {
      const p = this.physics.spawnProjectile?.({
        position: position.clone(),
        velocity: velocity.clone(),
        radius: kind === 'smoke' ? 0.028 : 0.032,
        mass: def.mass,
        restitution: def.restitution,
        friction: 0.62,
        rollingFriction: def.rollingFriction,
        object: slot.mesh,
        entityId: ownerEntity,
        surface: 'metal',
        mask: MASK_MOVE | LAYER.GLASS,
      });
      slot.handle = p ?? null;
    } else {
      slot.handle = null;
    }

    bus.emit('grenade:thrown', { id: slot.id, kind });
    return slot.id;
  }

  private createSlot(kind: GrenadeKind): LiveGrenade {
    const mesh = new THREE.Mesh(this.geometryFor(kind), this.materialFor(kind));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    const g: LiveGrenade = {
      active: false, kind, fuse: 0, id: 0, mesh, handle: null,
      fromPlayer: false, ownerEntity: -1, spin: new THREE.Vector3(),
    };
    this.live.push(g);
    return g;
  }

  /* --------------------------------------------------------------- update */

  fixedUpdate(dt: number, holderPosition: THREE.Vector3, ownerEntity = 1, fromPlayer = true): void {
    if (this.cooking) {
      const def = GRENADES[this.cookKind];
      if (def.cookable) {
        this.cookTime += dt;
        if (this.cookTime >= def.fuse) {
          // Cooked off in the hand. That is the deal you made when you held it.
          this.cooking = false;
          this.stock[this.cookKind] = Math.max(0, this.stock[this.cookKind] - 1);
          this.cookTime = 0;
          this.arc.visible = false;
          this.impact.visible = false;
          this.cookedOff = true;
          this.spawn(this.cookKind, holderPosition, this._v.set(0, 0.5, 0), 0.02, ownerEntity, fromPlayer);
        }
      }
    }

    for (const g of this.live) {
      if (!g.active) continue;
      g.fuse -= dt;
      if (g.fuse <= 0) this.detonate(g);
    }
  }

  /** Latched when a cooked grenade goes off in the holder's hand. */
  cookedOff = false;
  consumeCookedOff(): boolean {
    if (!this.cookedOff) return false;
    this.cookedOff = false;
    return true;
  }

  update(dt: number): void {
    for (const g of this.live) {
      if (!g.active || this.physics) continue;
      // Without a physics backend, fall under gravity so the debug scene works.
      g.mesh.position.y -= 0.5 * 9.81 * dt * dt;
    }
    for (const g of this.live) {
      if (!g.active) continue;
      this._q.setFromAxisAngle(
        this._v.set(g.spin.x, g.spin.y, g.spin.z).normalize(),
        this._v.length() > 0 ? dt * g.spin.length() * 0.35 : 0,
      );
      g.mesh.quaternion.multiply(this._q);
    }
  }

  private detonate(g: LiveGrenade): void {
    const def = GRENADES[g.kind];
    const p = g.mesh.position.clone();
    g.active = false;
    g.mesh.visible = false;
    if (g.handle) this.physics?.removeProjectile?.(g.handle);
    g.handle = null;

    if (g.kind === 'frag') {
      this.ballistics?.detonate(p, {
        radius: def.radius, damage: def.damage, power: def.power, kind: 'frag',
      }, { ownerEntity: g.ownerEntity, fromPlayer: g.fromPlayer });
    } else {
      bus.emit('explosion', { point: p, radius: def.radius, power: def.power, kind: g.kind });
      this.physics?.applyExplosion(p, def.radius * 0.35, def.power);
    }

    if (g.kind === 'flash' && this.render) {
      // Blindness is the renderer's job; the weapon system only measures it.
      const cam = this.render.camera;
      const dist = cam.position.distanceTo(p);
      if (dist < def.radius) {
        const facing = Math.max(0, this._v.copy(p).sub(cam.position).normalize()
          .dot(this._p.set(0, 0, -1).applyQuaternion(cam.quaternion)));
        const los = this.physics?.lineOfSight(cam.position, p) ?? true;
        const t = (1 - dist / def.radius) * (0.35 + facing * 0.65) * (los ? 1 : 0.25);
        this.render.screenEffect({
          flash: { intensity: 5.5 * t, color: 0xffffff, decay: 0.35 },
          concussion: { intensity: t, duration: 2.4 * t },
        });
      }
    }
  }

  /* ------------------------------------------------------------ prediction */

  /**
   * Updates the predicted arc ribbon. Returns the landing point, or null when
   * no prediction is available.
   */
  predict(origin: THREE.Vector3, direction: THREE.Vector3, underhand: boolean,
    ownerEntity: number): THREE.Vector3 | null {
    if (!this.cooking) { this.arc.visible = false; this.impact.visible = false; return null; }
    const def = GRENADES[this.cookKind];
    const speed = underhand ? def.underhandSpeed : def.throwSpeed;
    this._v.copy(direction).normalize().multiplyScalar(speed);
    this._v.y += underhand ? 1.4 : 2.2;
    this._p.copy(origin).addScaledVector(direction, 0.35);

    const phys = this.physics;
    if (!phys?.predictTrajectory) { this.arc.visible = false; return null; }
    const res = phys.predictTrajectory(this._p, this._v, this.arcBuffer, {
      radius: 0.032,
      restitution: def.restitution,
      friction: 0.62,
      maxTime: Math.min(3.2, def.fuse - this.cookTime),
      maxBounces: 3,
      ignoreEntity: ownerEntity,
    });
    const n = Math.min(res.count, ARC_POINTS);
    this.arcPositions.set(this.arcBuffer.subarray(0, n * 3));
    const attr = this.arc.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.arc.geometry.setDrawRange(0, n);
    this.arc.visible = n > 1;

    if (n > 1) {
      const i = (n - 1) * 3;
      this._p.set(this.arcPositions[i], this.arcPositions[i + 1], this.arcPositions[i + 2]);
      this.impact.position.copy(this._p);
      this.impact.lookAt(this._p.x, this._p.y + 1, this._p.z);
      this.impact.visible = true;
      return this._p;
    }
    this.impact.visible = false;
    return null;
  }

  /** Cook progress 0..1 against the fuse, for the HUD. */
  get cookFraction(): number {
    const def = GRENADES[this.cookKind];
    return def.cookable ? Math.min(1, this.cookTime / def.fuse) : 0;
  }

  resupply(): void {
    for (const k of Object.keys(GRENADES) as GrenadeKind[]) this.stock[k] = GRENADES[k].carried;
  }

  clear(): void {
    for (const g of this.live) {
      if (!g.active) continue;
      g.active = false;
      g.mesh.visible = false;
      if (g.handle) this.physics?.removeProjectile?.(g.handle);
      g.handle = null;
    }
    this.cancelCook();
  }

  dispose(): void {
    this.clear();
    for (const g of this.geoms.values()) g.dispose();
    this.geoms.clear();
    this.arc.geometry.dispose();
    (this.arc.material as THREE.Material).dispose();
    this.impact.geometry.dispose();
    (this.impact.material as THREE.Material).dispose();
  }
}
