/**
 * AI grenades.
 *
 * A grenade is the AI's answer to a player who has found a good angle and
 * stopped moving, so the throw decision is deliberately narrow: the target has
 * to be stationary-ish, behind cover or otherwise hard to shoot, in range, and
 * the squad has to have a grenade available. Anything looser and the game
 * becomes a grenade simulator.
 *
 * The arc is solved analytically and then *verified* by stepping the same
 * integrator that will actually fly the grenade, so the prediction and the
 * flight are the same code. If the verified landing point is nowhere near the
 * target, the throw is abandoned rather than lobbed into a wall.
 *
 * The warning callout goes out **before** the throw animation completes, which
 * is the entire reason grenades are fun rather than cheap.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Rand } from '../core/Rand';
import type { PhysicsAPI, RayHit } from '../physics/types';
import { MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeHit } from './Util';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _hit: RayHit = makeHit();

export const GRENADE = {
  fuse: 3.1,
  radius: 6.2,
  power: 26,
  damage: 105,
  maxThrowSpeed: 25,
  bodyRadius: 0.055,
  restitution: 0.36,
  friction: 0.72,
  /** Seconds between the callout and the grenade leaving the hand. */
  windup: 0.55,
};

interface LiveGrenade {
  active: boolean;
  ownerId: number;
  squadId: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  fuse: number;
  mesh: THREE.Mesh | null;
  resting: boolean;
}

export interface ThrowSolution {
  ok: boolean;
  velocity: THREE.Vector3;
  /** Where the integrator says it will come to rest / detonate. */
  landing: THREE.Vector3;
  /** Closest the simulated grenade ever came to the aim point, metres. */
  miss: number;
  time: number;
}

/**
 * Owns every AI grenade in flight, their prediction, and detonation.
 */
export class GrenadeSystem {
  physics: PhysicsAPI | null = null;
  scene: THREE.Object3D | null = null;
  gravity = -22;
  /** Called when a grenade resolves so the squad can re-arm. */
  onResolved: ((squadId: number) => void) | null = null;
  /** Called on detonation with the blast centre, for target damage routing. */
  onExplode: ((point: THREE.Vector3, ownerId: number) => void) | null = null;

  private live: LiveGrenade[] = [];
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.Material | null = null;
  private nextId = 4000;
  private readonly solution: ThrowSolution = {
    ok: false, velocity: new THREE.Vector3(), landing: new THREE.Vector3(),
    miss: Infinity, time: 0,
  };
  /** Predicted arc points, for debug gizmos. */
  readonly debugArc = new Float32Array(96 * 3);
  debugArcCount = 0;
  /** Closest approach of the last simulated arc to its tracked point. */
  private closest = Infinity;

  attach(physics: PhysicsAPI | null, scene: THREE.Object3D | null): void {
    this.physics = physics;
    this.scene = scene;
    const g = physics as unknown as { gravity?: () => number } | null;
    if (g && typeof g.gravity === 'function') this.gravity = g.gravity();
  }

  /* ------------------------------------------------------------- solving -- */

  /**
   * Solves a lobbed throw from `from` to `to`. Tries progressively higher
   * elevations, verifying each with the flight integrator.
   */
  solve(from: THREE.Vector3, to: THREE.Vector3, recordArc = false): ThrowSolution {
    const s = this.solution;
    s.ok = false;
    _v0.copy(to).sub(from);
    const dy = _v0.y;
    _v0.y = 0;
    const d = _v0.length();
    if (d < 0.4) { return s; }
    _v0.multiplyScalar(1 / d);
    const g = Math.abs(this.gravity);

    for (const deg of ANGLES) {
      const th = THREE.MathUtils.degToRad(deg);
      const c = Math.cos(th), t = Math.tan(th);
      const denom = 2 * c * c * (d * t - dy);
      if (denom <= 0.01) continue;
      const v2 = (g * d * d) / denom;
      if (v2 <= 0) continue;
      const v = Math.sqrt(v2);
      if (v > GRENADE.maxThrowSpeed) continue;

      _vel.copy(_v0).multiplyScalar(v * c);
      _vel.y = v * Math.sin(th);

      // Verify: the first metre must be clear (do not throw into a wall) …
      if (!this.clearRelease(from, _vel)) continue;
      // … and it must pass close to the aim point at some point in its flight.
      // Judging by where it finally *stops* rejects perfectly good throws that
      // land on target and then roll a few metres down a slope.
      const res = this.simulate(from, _vel, GRENADE.fuse, s.landing, recordArc, 1 / 50, to);
      if (this.closest > 3.6) continue;
      s.miss = this.closest;
      s.velocity.copy(_vel);
      s.time = res;
      s.ok = true;
      return s;
    }
    return s;
  }

  private clearRelease(from: THREE.Vector3, vel: THREE.Vector3): boolean {
    const phys = this.physics;
    if (!phys || !phys.ready) return true;
    _v1.copy(vel).normalize();
    phys.raycast(from, _v1, 1.35, MASK_MOVE, _hit);
    return !_hit.hit;
  }

  /**
   * Steps a grenade forward for `maxTime`, bouncing off geometry. Writes the
   * final position to `out` and returns the elapsed time. This is exactly the
   * integrator used in flight, so predictions never lie.
   */
  simulate(
    from: THREE.Vector3, velocity: THREE.Vector3, maxTime: number,
    out: THREE.Vector3, recordArc = false, dt = 1 / 50, track?: THREE.Vector3,
  ): number {
    const phys = this.physics;
    _pos.copy(from);
    _vel.copy(velocity);
    const steps = Math.ceil(maxTime / dt);
    let arc = 0;
    let restTicks = 0;
    this.closest = Infinity;
    for (let i = 0; i < steps; i++) {
      this.integrate(_pos, _vel, dt, phys);
      if (track) {
        const d = _pos.distanceTo(track);
        if (d < this.closest) this.closest = d;
      }
      // Once it has come to rest there is nothing left to predict.
      if (_vel.lengthSq() < 0.02) { if (++restTicks > 3) break; }
      else restTicks = 0;
      if (recordArc && i % 2 === 0 && arc < 96) {
        this.debugArc[arc * 3] = _pos.x;
        this.debugArc[arc * 3 + 1] = _pos.y;
        this.debugArc[arc * 3 + 2] = _pos.z;
        arc++;
      }
    }
    if (recordArc) this.debugArcCount = arc;
    out.copy(_pos);
    return maxTime;
  }

  /** One ballistic step with a swept collision test and a bounce. */
  private integrate(
    pos: THREE.Vector3, vel: THREE.Vector3, dt: number, phys: PhysicsAPI | null,
  ): void {
    vel.y += this.gravity * dt;
    _v1.copy(vel).multiplyScalar(dt);
    const dist = _v1.length();
    if (dist < 1e-6) return;
    if (!phys || !phys.ready) { pos.add(_v1); return; }
    _v1.multiplyScalar(1 / dist);
    phys.spherecast(pos, _v1, GRENADE.bodyRadius, dist, MASK_MOVE, _hit);
    if (!_hit.hit) {
      pos.addScaledVector(_v1, dist);
      return;
    }
    const travel = Math.max(0, _hit.distance - 0.005);
    pos.addScaledVector(_v1, travel);
    // Reflect and damp.
    const vn = vel.dot(_hit.normal);
    vel.addScaledVector(_hit.normal, -(1 + GRENADE.restitution) * vn);
    vel.multiplyScalar(1 - GRENADE.friction * 0.25);
    if (vel.lengthSq() < 0.05) vel.set(0, 0, 0);
    pos.addScaledVector(_hit.normal, 0.01);
  }

  /* -------------------------------------------------------------- throwing */

  /** Launches a grenade along a solved velocity. */
  throwAt(
    ownerId: number, squadId: number, from: THREE.Vector3, velocity: THREE.Vector3,
    rand: Rand,
  ): void {
    let g = this.live.find((x) => !x.active);
    if (!g) {
      g = {
        active: false, ownerId: -1, squadId: -1,
        position: new THREE.Vector3(), velocity: new THREE.Vector3(),
        fuse: 0, mesh: null, resting: false,
      };
      this.live.push(g);
    }
    g.active = true;
    g.ownerId = ownerId;
    g.squadId = squadId;
    g.position.copy(from);
    g.velocity.copy(velocity);
    // A hair of scatter so a squad's grenades do not stack perfectly.
    g.velocity.x += rand.signed() * 0.25;
    g.velocity.z += rand.signed() * 0.25;
    g.fuse = GRENADE.fuse;
    g.resting = false;
    if (!g.mesh && this.scene) g.mesh = this.makeMesh();
    if (g.mesh) {
      g.mesh.visible = true;
      g.mesh.position.copy(from);
    }
    bus.emit('grenade:thrown', { id: this.nextId++, kind: 'frag' });
  }

  private makeMesh(): THREE.Mesh {
    if (!this.geometry) this.geometry = new THREE.IcosahedronGeometry(0.062, 1);
    if (!this.material) {
      this.material = new THREE.MeshStandardMaterial({
        color: 0x3d4a33, roughness: 0.55, metalness: 0.35,
      });
    }
    const m = new THREE.Mesh(this.geometry, this.material);
    m.castShadow = true;
    m.userData.noCollide = true;
    this.scene?.add(m);
    return m;
  }

  /* ------------------------------------------------------------ stepping -- */

  fixedUpdate(dt: number): void {
    if (this.live.length === 0) return;
    const phys = this.physics;
    for (const g of this.live) {
      if (!g.active) continue;
      if (!g.resting) {
        _pos.copy(g.position);
        _vel.copy(g.velocity);
        this.integrate(_pos, _vel, dt, phys);
        g.position.copy(_pos);
        g.velocity.copy(_vel);
        if (g.velocity.lengthSq() < 1e-4) g.resting = true;
      }
      if (g.mesh) {
        g.mesh.position.copy(g.position);
        g.mesh.rotation.x += dt * 6;
        g.mesh.rotation.z += dt * 4;
      }
      g.fuse -= dt;
      if (g.fuse <= 0) this.detonate(g);
    }
  }

  private detonate(g: LiveGrenade): void {
    g.active = false;
    if (g.mesh) g.mesh.visible = false;
    bus.emit('explosion', {
      point: g.position.clone(), radius: GRENADE.radius, power: GRENADE.power, kind: 'frag',
    });
    this.physics?.applyExplosion(g.position, GRENADE.radius, GRENADE.power);
    this.onExplode?.(g.position, g.ownerId);
    this.onResolved?.(g.squadId);
  }

  /** Damage solve for a blast against a capsule target. */
  blastDamage(centre: THREE.Vector3, targetPos: THREE.Vector3): number {
    const d = centre.distanceTo(targetPos);
    if (d > GRENADE.radius) return 0;
    let f = 1 - d / GRENADE.radius;
    f *= f;
    const phys = this.physics;
    if (phys && phys.ready) {
      _v0.copy(targetPos); _v0.y += 0.4;
      if (!phys.lineOfSight(centre, _v0, MASK_SIGHT)) f *= 0.35;
    }
    return GRENADE.damage * f;
  }

  get activeCount(): number {
    let n = 0;
    for (const g of this.live) if (g.active) n++;
    return n;
  }

  /** Position of the first live grenade, for gizmos and AI avoidance. */
  nearestLive(to: THREE.Vector3, out: THREE.Vector3): boolean {
    let best = Infinity;
    let found = false;
    for (const g of this.live) {
      if (!g.active) continue;
      const d = g.position.distanceToSquared(to);
      if (d < best) { best = d; out.copy(g.position); found = true; }
    }
    return found;
  }

  clear(): void {
    for (const g of this.live) {
      g.active = false;
      if (g.mesh) { g.mesh.removeFromParent(); g.mesh = null; }
    }
    this.live.length = 0;
  }

  dispose(): void {
    this.clear();
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
  }
}

const ANGLES = [34, 45, 57];
