/**
 * Precision airstrike killstreak.
 *
 * The whole beat is implemented: the player paints a target, a flight of three
 * jets is spawned off-map and flown along the strike axis, the ordnance walks
 * through the marked point as a line of timed detonations, and every explosion
 * pushes damage, physics impulse, camera shake and a screen flash.
 *
 * The aircraft are procedural delta-wing meshes — no assets — flown low (34 m)
 * so they read as fast movers from the street rather than as dots against the
 * sky.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import type { GameServices } from './Services';
import type { CombatBridge } from './Combat';

const JETS = 3;
const ALTITUDE = 34;
const SPEED = 165;
const RUN_IN = 620;               // metres of approach before the marked point (~3.8 s)
const BOMB_COUNT = 8;
const BOMB_SPACING = 9.5;
const BOMB_INTERVAL = 0.14;
const BLAST_RADIUS = 11.5;
const BLAST_POWER = 220;

type Phase = 'inbound' | 'striking' | 'egress' | 'done';

export class AirstrikeRun {
  private group = new THREE.Group();
  private jets: THREE.Object3D[] = [];
  private phase: Phase = 'inbound';
  private t = 0;
  private bombsDropped = 0;
  private bombTimer = 0;
  private axis = new THREE.Vector3(1, 0, 0);
  private target = new THREE.Vector3();
  private start = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _right = new THREE.Vector3();
  private eta: number;
  /** Distance along the axis, from `start`, at which the target sits. */
  private targetAlong: number;

  done = false;

  constructor(
    target: THREE.Vector3,
    heading: number,
    private services: GameServices,
    private combat: CombatBridge,
    private rng: Rand,
  ) {
    this.target.copy(target);
    this.axis.set(Math.sin(heading), 0, Math.cos(heading)).normalize();
    this.start.copy(target).addScaledVector(this.axis, -RUN_IN);
    this.start.y = target.y + ALTITUDE;
    this.targetAlong = RUN_IN;
    this.eta = RUN_IN / SPEED;

    this.build();
    services.scene?.add(this.group);

    bus.emit('airstrike:inbound', { point: target.clone(), eta: this.eta, heading });
    services.emit('hud:banner', {
      title: 'AIRSTRIKE INBOUND', subtitle: 'Danger close — clear the area',
      kind: 'alert', ttl: 3.2,
    });
  }

  private build(): void {
    const body = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.42, metalness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.55, metalness: 0.7 });
    const burner = new THREE.MeshBasicMaterial({
      color: 0xffb066, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });

    const geo = buildJetGeometry();
    for (let i = 0; i < JETS; i++) {
      const jet = new THREE.Group();
      const hull = new THREE.Mesh(geo, body);
      hull.castShadow = settings.gfx.shadows;
      hull.userData.noCollide = true;
      jet.add(hull);

      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.4, 2.2), trim);
      fin.position.set(0, 1.3, -4.2);
      fin.userData.noCollide = true;
      jet.add(fin);

      for (const x of [-1.15, 1.15]) {
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.6, 8, 1, true), burner);
        flame.rotation.x = Math.PI / 2;
        flame.position.set(x, 0, -6.4);
        flame.layers.set(LAYERS.TRANSPARENT);
        flame.renderOrder = 7;
        flame.userData.noCollide = true;
        jet.add(flame);
      }

      // Tight echelon: a 26 m spread put wingmen through the buildings either
      // side of a street. Nine metres out and thirteen back keeps the flight
      // readable as one formation and clear of the rooflines.
      jet.userData.offset = new THREE.Vector3((i - 1) * 9, (i - 1) * 2.5, -i * 13);
      this.jets.push(jet);
      this.group.add(jet);
    }
    this.group.traverse((o) => { if (o.layers.mask === 1) o.layers.set(LAYERS.DEFAULT); });
  }

  fixedUpdate(dt: number): void {
    if (this.done) return;
    this.t += dt;

    /* --- fly the formation along the strike axis --- */
    const along = this.t * SPEED;
    this._p.copy(this.start).addScaledVector(this.axis, along);
    this._q.setFromAxisAngle(this._up, Math.atan2(this.axis.x, this.axis.z));
    this._right.copy(this.axis).cross(this._up).normalize();

    for (const jet of this.jets) {
      const off = jet.userData.offset as THREE.Vector3;
      jet.position.copy(this._p)
        .addScaledVector(this._right, off.x)
        .addScaledVector(this._up, off.y)
        .addScaledVector(this.axis, off.z);
      jet.quaternion.copy(this._q);
    }

    /* --- release point: start walking bombs in half a stick early --- */
    if (this.phase === 'inbound' && along >= this.targetAlong - BOMB_COUNT * BOMB_SPACING * 0.5) {
      this.phase = 'striking';
      this.bombTimer = 0;
    }

    if (this.phase === 'striking') {
      this.bombTimer -= dt;
      while (this.bombTimer <= 0 && this.bombsDropped < BOMB_COUNT) {
        this.bombTimer += BOMB_INTERVAL;
        this.detonate(this.bombsDropped);
        this.bombsDropped++;
      }
      if (this.bombsDropped >= BOMB_COUNT) this.phase = 'egress';
    }

    if (this.phase === 'egress' && this.t > this.eta + 3.6) {
      this.finish();
    }
    // Hard timeout so a strike can never leak an object into the scene.
    if (this.t > this.eta + 14) this.finish();
  }

  private detonate(index: number): void {
    const offset = (index - (BOMB_COUNT - 1) * 0.5) * BOMB_SPACING;
    this._p.copy(this.target).addScaledVector(this.axis, offset);
    this._p.x += this.rng.range(-2.4, 2.4);
    this._p.z += this.rng.range(-2.4, 2.4);
    this._p.y = this.combat.groundAt(this._p.x, this._p.z, this.target.y) + 0.4;

    const power = BLAST_POWER * this.rng.range(0.9, 1.1);
    // `explode` publishes the `explosion` event and routes damage/attribution;
    // it is the single entry point so nothing double-applies.
    this.combat.explode(this._p, BLAST_RADIUS, power, 'airstrike');
    this.services.physics?.applyExplosion(this._p, BLAST_RADIUS * 1.4, power * 12);

    const render = this.services.render;
    if (render) {
      render.addDynamicLight({
        position: this._p.clone(), color: 0xffb066, intensity: 55,
        radius: BLAST_RADIUS * 1.8, lifetime: 0.45, decay: 'exp',
      });
      // Scorch the ground — the crater trail is what sells a walked stick of
      // bombs once the smoke has cleared.
      render.addDecal({
        position: this._p.clone(), normal: new THREE.Vector3(0, 1, 0),
        size: BLAST_RADIUS * 1.5, group: 'hard', lifetime: 90,
        colorTint: 0x101010, rotation: this.rng.range(0, Math.PI * 2),
      });
      // Camera shake only. Flash, concussion and the fireball are the
      // *presentation* of an explosion, and the `explosion` event already told
      // FX and the renderer everything they need — adding a second set here
      // just double-exposes the frame when eight blasts land in one second.
      const player = this.services.player;
      const d = player ? player.position.distanceTo(this._p) : 60;
      const prox = THREE.MathUtils.clamp(1 - d / 55, 0, 1);
      if (prox > 0.02) render.addCameraShake(0.3 * prox * settings.game.cameraShake, 22, 0.5);
      void index;
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
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

/** Delta-wing fast mover: fuselage, wings, canards and intakes, all triangles. */
function buildJetGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const push = (g: THREE.BufferGeometry) => { parts.push(g.toNonIndexed()); g.dispose(); };

  const fuselage = new THREE.CylinderGeometry(0.75, 0.45, 13, 10);
  fuselage.rotateX(Math.PI / 2);
  push(fuselage);

  const nose = new THREE.ConeGeometry(0.75, 3.2, 10);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, 7.9);
  push(nose);

  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2.4, 7.6, -0.15, -3.6, 0, 0, -4.2,
    0, 0, 2.4, 0, 0, -4.2, -7.6, -0.15, -3.6,
    0, 0.12, 2.4, 0, 0.12, -4.2, 7.6, 0.02, -3.6,
    0, 0.12, 2.4, -7.6, 0.02, -3.6, 0, 0.12, -4.2,
  ]), 3));
  wing.computeVertexNormals();
  push(wing);

  for (const x of [-1.15, 1.15]) {
    const intake = new THREE.BoxGeometry(0.9, 0.8, 5.5);
    intake.translate(x, -0.35, -0.5);
    push(intake);
  }

  let total = 0;
  for (const g of parts) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nrm.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}
