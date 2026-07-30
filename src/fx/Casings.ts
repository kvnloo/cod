/**
 * Ejected shell casings.
 *
 * Real brass is one of the cheapest ways to make gunfire feel physical: it
 * spins out of the port, catches the sun, bounces twice and rattles to a stop.
 * Each casing is a full rigid body integrated here (position, orientation,
 * angular velocity, restitution, rolling friction) rather than a canned
 * animation, so no two ever land the same way.
 *
 * Geometry is lathed in code from a cartridge profile — brass rim, tapered
 * body, shoulder, neck — and drawn as a single InstancedMesh, so an entire
 * magazine of casings costs one draw call and picks up the renderer's sun,
 * shadows and ambient probe through the normal material path.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';

export type CasingKind = 'rifle' | 'pistol' | 'shotgun' | 'lmg';

interface Casing {
  active: boolean;
  age: number;
  life: number;
  settled: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  quat: THREE.Quaternion;
  floorY: number;
  kind: CasingKind;
  restitution: number;
  bounces: number;
}

const PROFILES: Record<CasingKind, { length: number; base: number; neck: number; shoulder: number }> = {
  rifle: { length: 0.045, base: 0.0048, neck: 0.0030, shoulder: 0.70 },
  pistol: { length: 0.019, base: 0.0048, neck: 0.0046, shoulder: 0.92 },
  shotgun: { length: 0.058, base: 0.0098, neck: 0.0094, shoulder: 0.90 },
  lmg: { length: 0.051, base: 0.0060, neck: 0.0038, shoulder: 0.68 },
};

function lathePoints(kind: CasingKind): THREE.Vector2[] {
  const p = PROFILES[kind];
  const L = p.length;
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(0, -L * 0.5));
  pts.push(new THREE.Vector2(p.base * 0.55, -L * 0.5));
  pts.push(new THREE.Vector2(p.base * 1.06, -L * 0.5 + L * 0.02));  // extractor rim
  pts.push(new THREE.Vector2(p.base * 1.06, -L * 0.5 + L * 0.055));
  pts.push(new THREE.Vector2(p.base * 0.92, -L * 0.5 + L * 0.075)); // extractor groove
  pts.push(new THREE.Vector2(p.base, -L * 0.5 + L * 0.11));
  pts.push(new THREE.Vector2(p.base * 0.985, -L * 0.5 + L * p.shoulder));
  pts.push(new THREE.Vector2(p.neck, -L * 0.5 + L * Math.min(0.94, p.shoulder + 0.16)));
  pts.push(new THREE.Vector2(p.neck, L * 0.5));
  pts.push(new THREE.Vector2(p.neck * 0.86, L * 0.5));             // case mouth wall
  pts.push(new THREE.Vector2(p.neck * 0.86, L * 0.5 - L * 0.06));
  return pts;
}

export class Casings {
  private pool: Casing[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private brass!: THREE.MeshStandardMaterial;
  private hull!: THREE.MeshStandardMaterial;
  /** One InstancedMesh per cartridge profile; each is one draw call. */
  private meshes = new Map<CasingKind, THREE.InstancedMesh>();
  private rand = new Rand('fx:casings');

  private tmpM = new THREE.Matrix4();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpAxis = new THREE.Vector3();

  objects: THREE.Object3D[] = [];
  live = 0;

  init(budget = 64): void {
    this.brass = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.62, 0.46, 0.19),
      metalness: 1.0,
      roughness: 0.30,
      envMapIntensity: 1.2,
    });
    this.brass.name = 'fx:brass';
    // A shotgun hull is a plastic tube on a brass head — dielectric and matte.
    this.hull = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.34, 0.045, 0.035),
      metalness: 0.15,
      roughness: 0.55,
    });
    this.hull.name = 'fx:hull';

    for (const kind of ['rifle', 'pistol', 'shotgun', 'lmg'] as CasingKind[]) {
      const geo = new THREE.LatheGeometry(lathePoints(kind), 12);
      geo.computeVertexNormals();
      this.geometries.push(geo);
      const im = new THREE.InstancedMesh(geo, kind === 'shotgun' ? this.hull : this.brass, budget);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.name = `fx:casings:${kind}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.set(kind, im);
      this.objects.push(im);
    }

    for (let i = 0; i < budget; i++) {
      this.pool.push({
        active: false, age: 0, life: 8, settled: false,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
        quat: new THREE.Quaternion(), floorY: 0, kind: 'rifle',
        restitution: 0.32, bounces: 0,
      });
    }
  }

  eject(
    position: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, forward: THREE.Vector3,
    kind: CasingKind, floorY: number, speed = 2.6,
  ): void {
    let slot = -1;
    let oldest = -1;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].active) { slot = i; break; }
      if (this.pool[i].age > oldest) { oldest = this.pool[i].age; slot = i; }
    }
    if (slot < 0) return;

    const c = this.pool[slot];
    const r = this.rand;
    c.active = true;
    c.age = 0;
    c.life = 9 + r.next() * 3;
    c.settled = false;
    c.bounces = 0;
    c.kind = kind;
    c.restitution = kind === 'shotgun' ? 0.22 : 0.34;
    c.floorY = floorY;
    c.pos.copy(position);

    // Ejection is up-and-to-the-right with a lot of scatter; the tumble rate is
    // what makes brass legible in the air.
    const s = speed * (0.75 + r.next() * 0.6);
    c.vel.set(0, 0, 0)
      .addScaledVector(right, s * (0.85 + r.next() * 0.5))
      .addScaledVector(up, s * (0.35 + r.next() * 0.45))
      .addScaledVector(forward, s * (r.next() * 0.35 - 0.1));
    c.spin.set(r.signed() * 34, r.signed() * 26, r.signed() * 34);
    c.quat.setFromEuler(new THREE.Euler(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28)));
  }

  clear(): void {
    for (const c of this.pool) c.active = false;
    for (const m of this.meshes.values()) m.count = 0;
    this.live = 0;
  }

  fixedUpdate(dt: number): void {
    for (const c of this.pool) {
      if (!c.active) continue;
      c.age += dt;
      if (c.age >= c.life) { c.active = false; continue; }
      if (c.settled) continue;

      c.vel.y -= 9.81 * dt;
      // Brass is light and tumbling — air drag is not negligible at this scale.
      const k = Math.exp(-1.1 * dt);
      c.vel.multiplyScalar(k);
      c.pos.addScaledVector(c.vel, dt);

      const len = c.spin.length();
      if (len > 1e-4) {
        this.tmpAxis.copy(c.spin).multiplyScalar(1 / len);
        this.tmpQ.setFromAxisAngle(this.tmpAxis, len * dt);
        c.quat.premultiply(this.tmpQ).normalize();
      }

      if (c.pos.y <= c.floorY + 0.004) {
        c.pos.y = c.floorY + 0.004;
        if (c.vel.y < 0) {
          c.bounces++;
          c.vel.y = -c.vel.y * c.restitution;
          c.vel.x *= 0.62; c.vel.z *= 0.62;
          c.spin.multiplyScalar(0.55);
          // Two or three bounces then it lies flat, which is what brass does.
          if (c.vel.y < 0.30 || c.bounces > 3) {
            c.settled = true;
            c.vel.set(0, 0, 0);
            c.spin.set(0, 0, 0);
            // Lay it on its side: the lathe axis is local Y, so rotate it flat
            // about a random heading.
            const yaw = this.rand.range(0, Math.PI * 2);
            this.tmpAxis.set(Math.cos(yaw), 0, Math.sin(yaw));
            c.quat.setFromAxisAngle(this.tmpAxis, Math.PI / 2);
          }
        }
      }
    }
  }

  update(): void {
    const counts = new Map<CasingKind, number>();
    for (const m of this.meshes.keys()) counts.set(m, 0);
    let live = 0;

    for (const c of this.pool) {
      if (!c.active) continue;
      live++;
      const mesh = this.meshes.get(c.kind);
      if (!mesh) continue;
      const i = counts.get(c.kind) ?? 0;
      if (i >= mesh.instanceMatrix.count) continue;
      // Shrink away in the last half second instead of popping out.
      const remain = c.life - c.age;
      const scale = remain < 0.5 ? Math.max(0.001, remain / 0.5) : 1;
      this.tmpS.setScalar(scale);
      this.tmpM.compose(c.pos, c.quat, this.tmpS);
      mesh.setMatrixAt(i, this.tmpM);
      counts.set(c.kind, i + 1);
    }

    for (const [kind, mesh] of this.meshes) {
      const n = counts.get(kind) ?? 0;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    this.live = live;
    void this.tmpV;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.brass?.dispose();
    this.hull?.dispose();
    for (const m of this.meshes.values()) m.dispose();
  }
}
