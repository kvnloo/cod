/**
 * Care package killstreak.
 *
 * A cargo bird runs in on the marked point, cuts the crate loose, and the crate
 * descends under a procedural canopy until it hits the deck. Once it lands the
 * chute collapses, a strobe comes up and the player can hold the interact key
 * to claim whatever the weighted drop table rolls.
 *
 * Nothing here is faked with a timer: the crate is really falling, the ground
 * height really comes from a physics probe, and the claim is a real proximity +
 * hold interaction.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import { BeaconMarker } from './Markers';
import type { GameServices } from './Services';
import type { CombatBridge } from './Combat';
import type { KillstreakId } from './types';

const DROP_ALTITUDE = 68;
const PLANE_SPEED = 78;
const TERMINAL = 9.5;
const CLAIM_RADIUS = 2.6;
const CLAIM_TIME = 1.5;

/** Weighted drop table — the good stuff is rare but never impossible. */
const DROP_TABLE: ReadonlyArray<{ id: KillstreakId; weight: number }> = [
  { id: 'uav', weight: 30 },
  { id: 'counteruav', weight: 18 },
  { id: 'sentry', weight: 20 },
  { id: 'airstrike', weight: 16 },
  { id: 'carepackage', weight: 8 },
];

export type CarePackageState = 'inbound' | 'falling' | 'landed' | 'claimed';

export class CarePackage {
  readonly group = new THREE.Group();
  state: CarePackageState = 'inbound';
  claimProgress = 0;
  /** Set once claimed. */
  reward: KillstreakId | null = null;
  done = false;

  private plane: THREE.Group | null = null;
  private crate = new THREE.Group();
  private chute: THREE.Mesh | null = null;
  private chuteLines: THREE.Object3D[] = [];
  private strobe: THREE.MeshStandardMaterial;
  private beacon: BeaconMarker;

  private planePos = new THREE.Vector3();
  private planeDir = new THREE.Vector3();
  private cratePos = new THREE.Vector3();
  private crateVel = 0;
  private groundY = 0;
  private t = 0;
  private spin = 0;
  private readonly target = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();

  constructor(
    target: THREE.Vector3,
    heading: number,
    private services: GameServices,
    private combat: CombatBridge,
    private rng: Rand,
  ) {
    this.target.copy(target);
    this.groundY = combat.groundAt(target.x, target.z, target.y);
    this.planeDir.set(Math.sin(heading), 0, Math.cos(heading)).normalize();
    this.planePos.copy(target).addScaledVector(this.planeDir, -PLANE_SPEED * 3.4);
    this.planePos.y = this.groundY + DROP_ALTITUDE;

    this.strobe = new THREE.MeshStandardMaterial({
      color: 0x0a1a06, emissive: 0x53ff6a, emissiveIntensity: 4, roughness: 0.4,
    });

    this.build(heading);
    this.beacon = new BeaconMarker(0x66ff9e, 0.42);
    this.beacon.setPosition(this._v.set(target.x, this.groundY, target.z));
    services.scene?.add(this.beacon.group);
    services.scene?.add(this.group);

    services.emit('hud:banner', {
      title: 'CARE PACKAGE INBOUND', subtitle: 'Secure the drop', kind: 'reward', ttl: 3,
    });
  }

  private build(heading: number): void {
    const hull = new THREE.MeshStandardMaterial({ color: 0x39423b, roughness: 0.6, metalness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f1c, roughness: 0.7, metalness: 0.4 });

    /* --- cargo bird: fat fuselage, high wing, twin tails --- */
    const plane = new THREE.Group();
    const fuse = new THREE.Mesh(new THREE.CapsuleGeometry(1.7, 11, 4, 10), hull);
    fuse.rotation.x = Math.PI / 2;
    plane.add(fuse);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(24, 0.4, 3.1), hull);
    wing.position.set(0, 1.5, 0.6);
    plane.add(wing);
    for (const x of [-4.6, 4.6]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.62, 3.4, 8), dark);
      nac.rotation.x = Math.PI / 2;
      nac.position.set(x, 1.35, 1.6);
      plane.add(nac);
    }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.35, 2.1), hull);
    tail.position.set(0, 1.9, -6.4);
    plane.add(tail);
    for (const x of [-3.4, 3.4]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 2.0), hull);
      fin.position.set(x, 3.1, -6.4);
      plane.add(fin);
    }
    plane.traverse((o) => { o.userData.noCollide = true; (o as THREE.Mesh).castShadow = false; });
    plane.rotation.y = heading;
    plane.position.copy(this.planePos);
    this.group.add(plane);
    this.plane = plane;

    /* --- crate: framed box with a strobe on the lid --- */
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.82, 1.05), hull);
    box.castShadow = true;
    box.receiveShadow = true;
    this.crate.add(box);
    for (const [ax, sx, sy, sz] of [
      [0, 1.1, 0.09, 0.09], [1, 0.09, 0.88, 0.09], [2, 0.09, 0.09, 1.1],
    ] as Array<[number, number, number, number]>) {
      for (let i = 0; i < 4; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), dark);
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const r = 0.52;
        if (ax === 0) bar.position.set(0, Math.sin(a) * 0.42, Math.cos(a) * r);
        else if (ax === 1) bar.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        else bar.position.set(Math.cos(a) * r, Math.sin(a) * 0.42, 0);
        this.crate.add(bar);
      }
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), this.strobe);
    led.position.set(0.3, 0.45, 0.3);
    this.crate.add(led);
    this.crate.traverse((o) => { o.userData.noCollide = true; });
    this.crate.visible = false;
    this.group.add(this.crate);

    /* --- canopy --- */
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xb9c4b2, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    const chute = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), canopyMat);
    chute.position.y = 3.1;
    chute.castShadow = true;
    chute.userData.noCollide = true;
    chute.visible = false;
    this.crate.add(chute);
    this.chute = chute;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 3.0, 3), dark);
      line.position.set(Math.cos(a) * 1.05, 1.7, Math.sin(a) * 1.05);
      line.rotation.z = -Math.cos(a) * 0.32;
      line.rotation.x = Math.sin(a) * 0.32;
      line.userData.noCollide = true;
      line.visible = false;
      this.crate.add(line);
      this.chuteLines.push(line);
    }

    this.group.traverse((o) => { if (o.layers.mask === 1) o.layers.set(LAYERS.DEFAULT); });
  }

  fixedUpdate(dt: number): void {
    if (this.done) return;
    this.t += dt;

    if (this.state === 'inbound') {
      this.planePos.addScaledVector(this.planeDir, PLANE_SPEED * dt);
      this.plane?.position.copy(this.planePos);
      this._v.copy(this.target).setY(this.planePos.y).sub(this.planePos);
      if (this._v.dot(this.planeDir) <= 0) {
        this.state = 'falling';
        this.cratePos.copy(this.planePos);
        this.crate.visible = true;
        if (this.chute) this.chute.visible = true;
        for (const l of this.chuteLines) l.visible = true;
        this.crateVel = 0;
      }
    } else if (this.state === 'falling') {
      // Gravity into a drag terminal velocity — the classic slow chute descent.
      this.crateVel = Math.min(TERMINAL, this.crateVel + 9.81 * dt * 0.55);
      this.cratePos.y -= this.crateVel * dt;
      // Drift toward the marked point so it lands where it was called.
      this.cratePos.x += (this.target.x - this.cratePos.x) * Math.min(1, dt * 1.4);
      this.cratePos.z += (this.target.z - this.cratePos.z) * Math.min(1, dt * 1.4);
      this.spin += dt * 0.4;
      this.crate.rotation.y = this.spin;
      this.crate.rotation.z = Math.sin(this.t * 1.3) * 0.06;
      this.crate.position.copy(this.cratePos);

      if (this.cratePos.y <= this.groundY + 0.42) {
        this.cratePos.y = this.groundY + 0.42;
        this.crate.position.copy(this.cratePos);
        this.crate.rotation.z = 0;
        this.state = 'landed';
        if (this.chute) this.chute.visible = false;
        for (const l of this.chuteLines) l.visible = false;
        bus.emit('physics:impact', {
          point: this.cratePos.clone(), impulse: 320, material: 'metal',
        });
        this.services.emit('hud:banner', {
          title: 'PACKAGE DOWN', subtitle: 'Hold [F] to claim', kind: 'reward', ttl: 2.6,
        });
      }
      // Keep the plane flying out of frame.
      this.planePos.addScaledVector(this.planeDir, PLANE_SPEED * dt);
      this.plane?.position.copy(this.planePos);
    } else if (this.state === 'landed') {
      this.planePos.addScaledVector(this.planeDir, PLANE_SPEED * dt);
      this.plane?.position.copy(this.planePos);
      if (this.plane && this.planePos.distanceTo(this.target) > 620) {
        this.plane.removeFromParent();
        this.plane = null;
      }
      this.strobe.emissiveIntensity = 2.2 + Math.abs(Math.sin(this.t * 5.5)) * 6;
    }

    const bx = this.state === 'inbound' ? this.target.x : this.cratePos.x;
    const bz = this.state === 'inbound' ? this.target.z : this.cratePos.z;
    this.beacon.setPosition(this._v.set(bx, this.groundY, bz));
    this.beacon.update(dt);
  }

  /** Proximity + hold interaction. Returns the reward the frame it is claimed. */
  tryClaim(playerPos: THREE.Vector3 | null, interacting: boolean, dt: number): KillstreakId | null {
    if (this.state !== 'landed' || !playerPos) return null;
    const near = playerPos.distanceTo(this.cratePos) < CLAIM_RADIUS;
    if (near && interacting) this.claimProgress = Math.min(1, this.claimProgress + dt / CLAIM_TIME);
    else this.claimProgress = Math.max(0, this.claimProgress - dt / CLAIM_TIME);
    if (this.claimProgress < 1) return null;

    this.state = 'claimed';
    this.reward = rollDrop(this.rng);
    this.services.emit('hud:banner', {
      title: 'PACKAGE SECURED', subtitle: this.reward.toUpperCase(), kind: 'reward', ttl: 2.8,
    });
    this.finish();
    return this.reward;
  }

  /** True while the player is close enough for the claim prompt. */
  promptVisible(playerPos: THREE.Vector3 | null): boolean {
    return this.state === 'landed' && !!playerPos && playerPos.distanceTo(this.cratePos) < CLAIM_RADIUS * 1.6;
  }

  get position(): THREE.Vector3 { return this.cratePos; }

  private finish(): void {
    this.done = true;
    this.dispose();
  }

  dispose(): void {
    this.beacon.dispose();
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

function rollDrop(rng: Rand): KillstreakId {
  let total = 0;
  for (const d of DROP_TABLE) total += d.weight;
  let r = rng.next() * total;
  for (const d of DROP_TABLE) {
    r -= d.weight;
    if (r <= 0) return d.id;
  }
  return 'uav';
}
