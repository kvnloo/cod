/**
 * PlayerSystem — binds input, movement, camera and health together and publishes
 * everything the rest of the game needs on the bus.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { input } from '../core/Input';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import type { PhysicsAPI } from '../physics/types';
import type { RenderAPI } from '../render/types';
import { Movement, TUNING, type MoveState } from './Movement';
import { CameraRig } from './CameraRig';
import type { PlayerNetDriver } from './NetDriver';

const HEALTH: Record<string, number> = {
  max: 100,
  /** Seconds without damage before regeneration begins. */
  regenDelay: 4.2,
  /** Health per second once regenerating. */
  regenRate: 34,
  /** Below this fraction the screen effects kick in hard. */
  criticalFraction: 0.34,
};

export class PlayerSystem implements System {
  readonly name = 'player';
  readonly order = ORDER.PLAYER;

  readonly movement = new Movement();
  readonly camera = new CameraRig();

  /**
   * When set, the netcode owns the movement step: it builds the command, applies
   * it locally for prediction, and replays it after a server correction. Null in
   * single-player, where movement is stepped straight from local input.
   */
  netDriver: PlayerNetDriver | null = null;

  health = HEALTH.max;
  readonly maxHealth = HEALTH.max;
  alive = true;
  /** Entity id used by AI targeting and damage routing. */
  readonly entityId = 1;

  private timeSinceDamage = 999;
  private adsBlend = 0;
  private renderApi: RenderAPI | null = null;
  private physics: PhysicsAPI | null = null;
  private readonly _dir = new THREE.Vector3();
  private readonly _spawn = new THREE.Vector3(0, TUNING.standHeight * 0.5, 8);
  private spawnYaw = Math.PI;

  async init(ctx: EngineContext): Promise<void> {
    this.physics = ctx.engine.tryGet<System & PhysicsAPI>('physics') ?? null;
    this.renderApi = ctx.engine.tryGet<System & RenderAPI>('render') ?? null;
    if (this.physics) this.movement.attach(this.physics);

    this.movement.teleport(this._spawn, this.spawnYaw);
    this.camera.reset(this.spawnYaw);

    bus.on('damage:taken', (e) => this.applyDamage(e.amount, e.fromDirection, e.lethal));
    bus.on('weapon:ads', (e) => { void e; });
    bus.emit('player:spawn', { point: this._spawn.clone() });
  }

  /** Places the player at a level-provided spawn. */
  spawnAt(position: THREE.Vector3, yaw: number): void {
    this._spawn.copy(position);
    this.spawnYaw = yaw;
    this.movement.teleport(position, yaw);
    this.camera.reset(yaw);
    this.health = HEALTH.max;
    this.alive = true;
    this.timeSinceDamage = 999;
    bus.emit('player:spawn', { point: position.clone() });
    bus.emit('player:health', { health: this.health, max: this.maxHealth, regen: false });
  }

  get position(): THREE.Vector3 { return this.movement.position; }
  get velocity(): THREE.Vector3 { return this.movement.velocity; }
  get state(): MoveState { return this.movement.out.state; }
  get grounded(): boolean { return this.movement.out.grounded; }
  get speed01(): number { return this.movement.out.speed01; }
  get ads(): number { return this.adsBlend; }

  fixedUpdate(dt: number, _ctx: EngineContext): void {
    if (!this.alive) return;

    const prevState = this.movement.out.state;
    const out = this.netDriver
      ? this.netDriver.fixedStep(dt, this.camera.yaw, this.camera.pitch)
      : this.movement.step(dt, this.camera.yaw, this.camera.pitch);

    if (out.landImpact > 0) {
      this.camera.land(out.landImpact);
      bus.emit('player:land', {
        point: this.position.clone(),
        force: out.landImpact,
        surface: out.groundSurface,
      });
      // Fall damage above a survivable drop.
      if (out.landImpact > 15.5) {
        const dmg = (out.landImpact - 15.5) * 9;
        this._dir.set(0, 1, 0);
        this.applyDamage(dmg, this._dir, false);
      }
    }
    if (out.state !== prevState) bus.emit('player:move:state', { state: out.state });

    /* --- health regeneration ------------------------------------------- */
    this.timeSinceDamage += dt;
    if (this.health < HEALTH.max && this.timeSinceDamage > HEALTH.regenDelay) {
      const before = this.health;
      this.health = Math.min(HEALTH.max, this.health + HEALTH.regenRate * dt);
      if (Math.floor(before) !== Math.floor(this.health)) {
        bus.emit('player:health', { health: this.health, max: this.maxHealth, regen: true });
      }
    }
  }

  update(dt: number, ctx: EngineContext): void {
    const s = input.state;
    const adsHeld = input.held('ads');

    // ADS blend is presentation-rate so it stays smooth above the sim rate.
    const adsSpeed = adsHeld ? 9.5 : 12;
    this.adsBlend += ((adsHeld ? 1 : 0) - this.adsBlend) * (1 - Math.exp(-adsSpeed * dt));
    if (this.adsBlend < 0.001) this.adsBlend = 0;
    this.camera.setAds(this.adsBlend);

    this.camera.look(s.mouseDX, s.mouseDY, dt, adsHeld);
    if (s.usingGamepad) this.camera.stick(s.lookX, s.lookY, dt, adsHeld);

    // Decay any pending server correction and feed it to the rig, so the
    // simulation can snap while the view slides.
    if (this.netDriver) {
      this.netDriver.updateVisual(dt);
      const o = this.netDriver.visualOffset;
      this.camera.predictionOffset.set(o.x, o.y, o.z);
    } else if (this.camera.predictionOffset.lengthSq() > 0) {
      this.camera.predictionOffset.set(0, 0, 0);
    }

    // The capture harness owns the camera while a fixed shot is framed.
    if (!ctx.engine.cameraLockedByCapture) {
      this.camera.update(dt, this.movement.out, this.position, ctx.camera);
    }

    // Depth of field focuses where the player is looking.
    if (this.renderApi && settings.gfx.dof) {
      this._dir.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      let focus = 12;
      if (this.physics) {
        const hit = this.physics.raycast(
          ctx.camera.position, this._dir, 120, 0xffff,
          (this.physics as unknown as { _scratchHit?: never })._scratchHit ?? scratchHit(),
        );
        if (hit.hit) focus = hit.distance;
      }
      this.renderApi.setFocusDistance(focus);
      this.renderApi.setExposureCompensation(this.adsBlend * -0.25);
    }

    // Low-health screen feedback.
    const frac = this.health / HEALTH.max;
    if (this.renderApi && frac < HEALTH.criticalFraction) {
      const t = 1 - frac / HEALTH.criticalFraction;
      this.renderApi.screenEffect({ damage: { intensity: t * 0.55 } });
    }
  }

  applyDamage(amount: number, fromDirection: THREE.Vector3, forceLethal: boolean): void {
    if (!this.alive || amount <= 0) return;
    this.health -= amount;
    this.timeSinceDamage = 0;

    this.camera.addShake(Math.min(0.09, amount * 0.0022), 26, 0.3);
    this.renderApi?.screenEffect({ damage: { intensity: Math.min(1, amount / 45), direction: fromDirection.clone() } });
    input.rumble(Math.min(1, amount / 60), 0.3, 160);
    bus.emit('player:health', { health: Math.max(0, this.health), max: this.maxHealth, regen: false });

    if (this.health <= 0 || forceLethal) {
      this.health = 0;
      this.alive = false;
      bus.emit('entity:death', {
        id: this.entityId, byPlayer: false, headshot: false,
        name: 'player', point: this.position.clone(),
      });
    }
  }

  heal(amount: number): void {
    if (!this.alive) return;
    this.health = Math.min(HEALTH.max, this.health + amount);
    bus.emit('player:health', { health: this.health, max: this.maxHealth, regen: false });
  }

  revive(): void {
    this.alive = true;
    this.health = HEALTH.max;
    this.timeSinceDamage = 999;
    bus.emit('player:health', { health: this.health, max: this.maxHealth, regen: false });
  }

  dispose(): void { this.movement.dispose(); }
}

/** Lazily-created scratch hit so the DoF probe never allocates per frame. */
let _hit: ReturnType<typeof makeHit> | null = null;
function makeHit() {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete' as const, object: null,
    entityId: -1, bodyHandle: -1, zone: 'none' as const, backface: false,
  };
}
function scratchHit() {
  if (!_hit) _hit = makeHit();
  return _hit;
}
