/**
 * The character system: factory, per-frame driver and LOD governor.
 *
 * It owns nothing gameplay-shaped — AI decides what a soldier does, this only
 * decides how many of them can afford to be fully skinned this frame, and
 * hands each one a ground probe so its feet land on the world the physics
 * system knows about.
 */

import * as THREE from 'three';
import { ORDER, type EngineContext, type System } from '../core/Engine';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import type { PhysicsAPI, RayHit } from '../physics/types';
import { MASK_MOVE } from '../physics/types';
import type { CharacterFactory, CharacterOptions, CharacterFaction } from './types';
import { Character, type CharacterHost } from './Character';
import { CharacterMaterials } from './Materials';
import type { GroundProbe, GroundSample } from './anim/FootIK';

/** Maximum fully skinned (LOD0) characters, by quality preset. */
const SKINNED_BUDGET: Record<string, number> = {
  cinematic: 16, ultra: 14, high: 12, medium: 8, low: 5,
};

/** Screen height in pixels below which a character drops a level. */
const LOD1_PIXELS = 190;
const LOD2_PIXELS = 66;

export class CharacterSystem implements System, CharacterFactory {
  readonly name = 'characters';
  readonly order = ORDER.AI + 10;

  readonly materials = new CharacterMaterials();
  readonly characters: Character[] = [];

  /** Overrides the physics ground probe; used by debug scenes. */
  groundProbe: GroundProbe | null = null;
  /** Turns the LOD governor off so a debug scene can pin levels. */
  autoLOD = true;

  private physics: PhysicsAPI | null = null;
  private viewportHeight = 1080;
  private halfFovTan = Math.tan((60 * Math.PI) / 180 / 2);
  private host: CharacterHost;
  private order2: number[] = [];

  constructor() {
    this.host = {
      materials: this.materials,
      spawnRagdoll: (opts) => {
        const phys = this.physics as (PhysicsAPI & {
          spawnRagdoll?(o: unknown): { applyImpulse(z: never, i: THREE.Vector3): void; remove(): void };
        }) | null;
        if (!phys?.spawnRagdoll) return null;
        return phys.spawnRagdoll(opts) as never;
      },
      groundProbe: null,
      onFootPlant: (character, foot, speed) => {
        character.object.getWorldPosition(_p);
        bus.emit('player:footstep', {
          point: _p.clone(), surface: 'dirt', sprinting: speed > 4,
        });
        void foot;
      },
      onDeath: (character) => {
        // Death clip finished — hand off to physics ragdoll. Impulse/zone may
        // have been stashed by the owner (BotFallback / AI) on userData.
        if (character.isRagdoll) return;
        const ud = character.object.userData as {
          pendingDeathImpulse?: THREE.Vector3;
          pendingDeathZone?: import('../physics/types').HitZone;
        };
        const impulse = ud.pendingDeathImpulse?.clone() ?? new THREE.Vector3(0, 2.2, 1.5);
        const zone = ud.pendingDeathZone ?? 'chest';
        delete ud.pendingDeathImpulse;
        delete ud.pendingDeathZone;
        try { character.ragdoll(impulse, zone); }
        catch { /* no physics ragdoll available — hold death pose */ }
      },
    };
  }

  init(ctx: EngineContext): void {
    const render = ctx.engine.tryGet<System & { renderer: THREE.WebGLRenderer }>('render');
    if (render?.renderer) this.materials.attach(render.renderer);
    const phys = ctx.engine.tryGet<System & PhysicsAPI>('physics');
    if (phys) {
      this.physics = phys;
      this.host.groundProbe = this.physicsProbe(phys);
    }
    bus.on('quality:changed', () => { /* materials keep their generated size */ });
  }

  /** Ground probe backed by the physics raycaster. */
  private physicsProbe(phys: PhysicsAPI): GroundProbe {
    return (x: number, z: number, fromY: number, out: GroundSample): boolean => {
      if (!phys.ready) return false;
      _origin.set(x, fromY, z);
      _down.set(0, -1, 0);
      const hit = phys.raycast(_origin, _down, 2.4, MASK_MOVE, _ray);
      if (!hit.hit) return false;
      out.y = hit.point.y;
      out.normal.copy(hit.normal);
      return true;
    };
  }

  /* ------------------------------------------------------------- factory */

  create(opts: CharacterOptions): Character {
    const host: CharacterHost = {
      ...this.host,
      groundProbe: this.groundProbe ?? this.host.groundProbe ?? null,
    };
    const c = new Character(opts, host);
    this.characters.push(c);
    return c;
  }

  remove(c: Character): void {
    const i = this.characters.indexOf(c);
    if (i >= 0) this.characters.splice(i, 1);
    c.dispose();
  }

  /** Pre-generates the texture sets for the factions a level will use. */
  async warm(factions: readonly CharacterFaction[] = ['militia', 'pmc']): Promise<void> {
    await this.materials.warm(factions);
  }

  /* -------------------------------------------------------------- frame */

  update(dt: number): void {
    for (const c of this.characters) c.update(dt);
  }

  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (!this.autoLOD || this.characters.length === 0) return;
    const cam = ctx.camera;
    this.halfFovTan = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    cam.getWorldPosition(_camPos);

    const n = this.characters.length;
    if (this.order2.length !== n) {
      this.order2.length = n;
      for (let i = 0; i < n; i++) this.order2[i] = i;
    }
    for (let i = 0; i < n; i++) {
      const c = this.characters[i];
      c.object.getWorldPosition(_p);
      const dist = Math.max(0.2, _p.distanceTo(_camPos));
      c.screenSize = (this.viewportHeight * c.height) / (2 * dist * this.halfFovTan);
      this.order2[i] = i;
    }
    this.order2.sort((a, b) => this.characters[b].screenSize - this.characters[a].screenSize);

    const budget = SKINNED_BUDGET[settings.preset] ?? 10;
    for (let rank = 0; rank < n; rank++) {
      const c = this.characters[this.order2[rank]];
      let lod = c.screenSize > LOD1_PIXELS ? 0 : c.screenSize > LOD2_PIXELS ? 1 : 2;
      if (rank >= budget) lod = Math.max(lod, 1);
      if (rank >= budget * 2) lod = 2;
      c.setLOD(lod);
    }
  }

  resize(_w: number, h: number): void {
    this.viewportHeight = h;
  }

  dispose(): void {
    for (const c of this.characters) c.dispose();
    this.characters.length = 0;
    this.materials.dispose();
  }
}

const _camPos = new THREE.Vector3();
const _p = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _ray: RayHit = {
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

// Registers the `--debug characters` scene. Kept as a side-effect import (the
// pattern the material and physics modules use) so importing the system is
// enough to make the test bed available.
import './DebugScene';
