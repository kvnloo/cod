/**
 * PlayerSystem — first-person controller: movement state machine, camera,
 * health and interaction.
 *
 * STUB: free-look + basic walk so the world can be inspected.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { input } from '../core/Input';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import type { PhysicsSystem } from '../physics/Physics';
import { makeMoveResult } from '../physics/Physics';
import type { CharacterController } from '../physics/types';

export type MoveState = 'idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'crouchWalk' | 'prone' | 'slide' | 'air' | 'mantle';

export class PlayerSystem implements System {
  readonly name = 'player';
  readonly order = ORDER.PLAYER;

  readonly position = new THREE.Vector3(0, 1.7, 8);
  readonly velocity = new THREE.Vector3();
  yaw = Math.PI;
  pitch = 0;
  state: MoveState = 'idle';
  health = 100;
  maxHealth = 100;
  grounded = true;
  eyeHeight = 1.68;

  private controller: CharacterController | null = null;
  private moveResult = makeMoveResult();
  private physics!: PhysicsSystem;

  async init(ctx: EngineContext): Promise<void> {
    this.physics = ctx.engine.get<PhysicsSystem>('physics');
    this.controller = this.physics.createCharacter(0.36, 1.78);
    bus.emit('player:spawn', { point: this.position.clone() });
  }

  fixedUpdate(dt: number, _ctx: EngineContext): void {
    const s = input.state;
    const speed = input.held('sprint') ? 7.2 : input.held('crouch') ? 2.2 : 4.6;

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, s.moveY)
      .addScaledVector(right, s.moveX);
    if (wish.lengthSq() > 1) wish.normalize();

    this.velocity.x = wish.x * speed;
    this.velocity.z = wish.z * speed;
    this.velocity.y -= 22 * dt;
    if (this.grounded && input.pressed('jump')) this.velocity.y = 6.2;

    const motion = this.velocity.clone().multiplyScalar(dt);
    if (this.controller) {
      const next = this.controller.move(this.position, motion, dt, this.moveResult);
      this.position.copy(next);
      this.grounded = this.moveResult.grounded;
      if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.position.add(motion);
    }

    const moving = wish.lengthSq() > 0.01;
    this.state = !this.grounded ? 'air'
      : input.held('crouch') ? (moving ? 'crouchWalk' : 'crouch')
        : !moving ? 'idle'
          : input.held('sprint') ? 'sprint' : 'run';
  }

  update(_dt: number, ctx: EngineContext): void {
    const g = settings.game;
    const sens = g.sensitivity * 0.0022;
    this.yaw -= input.state.mouseDX * sens;
    this.pitch -= input.state.mouseDY * sens * (g.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    const cam = ctx.camera;
    cam.position.set(this.position.x, this.position.y + (this.eyeHeight - 0.89), this.position.z);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
