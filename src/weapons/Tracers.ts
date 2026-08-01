/**
 * Tracer pool.
 *
 * Tracers belong to the FX module conceptually, but ballistics is where the
 * information lives (which round is a tracer, where it is right now, where a
 * hitscan round terminated), and a weapon system that cannot show its own
 * rounds is impossible to tune. So this is a small, self-contained pool that
 * the FX module can switch off with `enabled = false` once it owns tracers.
 *
 * One `InstancedMesh` of a stretched box, additive and unlit: a live tracer
 * tracks its projectile, a hitscan tracer is a streak that decays in ~70 ms.
 * No allocation after construction.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';

interface Slot {
  active: boolean;
  /** −1 for a decaying streak, otherwise the owning projectile. */
  live: boolean;
  from: THREE.Vector3;
  to: THREE.Vector3;
  life: number;
  ttl: number;
  width: number;
  intensity: number;
}

const CAPACITY = 96;

export class TracerPool {
  enabled = true;
  readonly mesh: THREE.InstancedMesh;
  private slots: Slot[] = [];
  private material: THREE.MeshBasicMaterial;

  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _colour = new THREE.Color();

  constructor(colour = 0xffb257) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, -0.5);       // pivot at the head, extending backwards
    this.material = new THREE.MeshBasicMaterial({
      color: colour,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAPACITY);
    this.mesh.name = 'weapon-tracers';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < CAPACITY; i++) {
      this.slots.push({
        active: false, live: false,
        from: new THREE.Vector3(), to: new THREE.Vector3(),
        life: 0, ttl: 1, width: 0.012, intensity: 1,
      });
    }
  }

  private alloc(): number {
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i].active) return i;
    return -1;
  }

  /** Starts a tracer that follows a live projectile. Returns its id. */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3): number {
    if (!this.enabled) return -1;
    const i = this.alloc();
    if (i < 0) return -1;
    const s = this.slots[i];
    s.active = true;
    s.live = true;
    s.life = 0;
    s.ttl = 6;
    s.width = 0.018;
    s.intensity = 1;
    s.from.copy(pos);
    this._d.copy(vel).normalize();
    s.to.copy(pos).addScaledVector(this._d, 2.4);
    return i;
  }

  update(id: number, pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (id < 0 || id >= this.slots.length) return;
    const s = this.slots[id];
    if (!s.active) return;
    // The visible streak is the last few metres of flight.
    this._d.copy(vel).normalize();
    s.to.copy(pos);
    s.from.copy(pos).addScaledVector(this._d, -Math.min(3.2, vel.length() * 0.008));
  }

  kill(id: number): void {
    if (id < 0 || id >= this.slots.length) return;
    const s = this.slots[id];
    s.live = false;
    s.ttl = Math.min(s.ttl, s.life + 0.05);
  }

  /** A hitscan tracer: a whole path, drawn once and decayed. */
  streak(from: THREE.Vector3, to: THREE.Vector3, intensity = 1): void {
    if (!this.enabled) return;
    const i = this.alloc();
    if (i < 0) return;
    const s = this.slots[i];
    s.active = true;
    s.live = false;
    s.life = 0;
    s.ttl = 0.22;
    s.width = 0.028;
    s.intensity = intensity;
    s.from.copy(from);
    s.to.copy(to);
  }

  update3(dt: number, camera: THREE.Camera): void {
    if (!this.enabled) { this.mesh.count = 0; return; }
    const budget = settings.preset === 'low' ? 24 : CAPACITY;
    let n = 0;
    const colours = this.mesh.instanceColor;
    for (let i = 0; i < this.slots.length && n < budget; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.life += dt;
      if (s.life >= s.ttl) { s.active = false; continue; }

      this._d.subVectors(s.to, s.from);
      const len = this._d.length();
      if (len < 1e-4) continue;
      this._d.multiplyScalar(1 / len);

      // Orient +Z along the streak; the box is unit length pivoted at the head.
      this._q.setFromUnitVectors(this._up.set(0, 0, 1), this._d);
      const fade = s.live ? 1 : Math.pow(1 - s.life / s.ttl, 0.7);
      // Widen with distance so a far tracer stays visible at 1080p.
      // Hitscan streaks get a floor width so a 70–220 ms flash is still a
      // readable orange rod at mid-range, not a sub-pixel hairline.
      const dist = this._p.copy(s.to).distanceTo(camera.position);
      const w = Math.max(s.width * (1 + dist * 0.028), s.live ? 0.01 : 0.018);
      this._s.set(w, w, len);
      this._p.copy(s.to);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      const k = fade * s.intensity;
      this._colour.setRGB(2.6 * k, 1.05 * k, 0.32 * k);
      colours?.setXYZ(n, this._colour.r, this._colour.g, this._colour.b);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colours) colours.needsUpdate = true;
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
