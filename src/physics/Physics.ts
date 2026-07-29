/**
 * PhysicsSystem — Rapier3D backend for {@link PhysicsAPI}.
 *
 * STUB: implements the contract with a flat-ground analytic fallback so the rest
 * of the game runs before the real backend lands. Replace the body of each method,
 * not the signatures.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import type {
  BodyDesc, BodyHandle, CharacterController, CharacterMoveResult,
  OverlapResult, PhysicsAPI, RayHit,
} from './types';
import { LAYER, MASK_MOVE } from './types';

const GROUND_Y = 0;

function emptyHit(out: RayHit): RayHit {
  out.hit = false; out.distance = Infinity; out.entityId = -1;
  out.object = null; out.bodyHandle = -1; out.zone = 'none'; out.backface = false;
  return out;
}

export function makeRayHit(): RayHit {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete', object: null, entityId: -1,
    bodyHandle: -1, zone: 'none', backface: false,
  };
}

export class PhysicsSystem implements System, PhysicsAPI {
  readonly name = 'physics';
  readonly order = ORDER.PHYSICS;
  ready = false;

  private bodies = new Map<number, BodyHandle>();
  private nextId = 1;
  private stepMs = 0;

  async init(_ctx: EngineContext): Promise<void> {
    this.ready = true;
  }

  fixedUpdate(_dt: number, _ctx: EngineContext): void { }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, _mask: number, out: RayHit): RayHit {
    emptyHit(out);
    if (dir.y >= -1e-6) return out;
    const t = (GROUND_Y - origin.y) / dir.y;
    if (t < 0 || t > maxDist) return out;
    out.hit = true;
    out.distance = t;
    out.point.copy(origin).addScaledVector(dir, t);
    out.normal.set(0, 1, 0);
    out.surface = 'concrete';
    return out;
  }

  raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number, out: RayHit[], max = 8): number {
    if (!out[0]) out[0] = makeRayHit();
    this.raycast(origin, dir, maxDist, mask, out[0]);
    return out[0].hit ? 1 : 0;
  }

  spherecast(origin: THREE.Vector3, dir: THREE.Vector3, _r: number, maxDist: number, mask: number, out: RayHit): RayHit {
    return this.raycast(origin, dir, maxDist, mask, out);
  }

  overlapSphere(_c: THREE.Vector3, _r: number, _mask: number, _out: OverlapResult[]): number { return 0; }

  lineOfSight(_from: THREE.Vector3, _to: THREE.Vector3): boolean { return true; }

  addBody(desc: BodyDesc): BodyHandle {
    const id = this.nextId++;
    const pos = new THREE.Vector3(...(desc.position ?? [0, 0, 0]));
    const rot = new THREE.Quaternion(...(desc.rotation ?? [0, 0, 0, 1]));
    const vel = new THREE.Vector3();
    const handle: BodyHandle = {
      id, desc,
      getPosition: (o) => o.copy(pos),
      getRotation: (o) => o.copy(rot),
      setTransform: (p, q) => { pos.copy(p); rot.copy(q); },
      setLinearVelocity: (v) => vel.copy(v),
      getLinearVelocity: (o) => o.copy(vel),
      applyImpulse: () => { },
      applyTorqueImpulse: () => { },
      wake: () => { },
      setEnabled: () => { },
      remove: () => { this.bodies.delete(id); },
    };
    this.bodies.set(id, handle);
    return handle;
  }

  removeBody(handle: BodyHandle): void { handle.remove(); }

  createCharacter(radius: number, height: number, _layer = LAYER.PLAYER): CharacterController {
    const self = this;
    return {
      radius, height,
      setHeight(h) { this.height = h; },
      move(position, motion, _dt, out): THREE.Vector3 {
        const next = position.clone().add(motion);
        const feet = next.y - this.height * 0.5;
        out.grounded = feet <= GROUND_Y + 1e-3;
        if (out.grounded) next.y = GROUND_Y + this.height * 0.5;
        out.applied.copy(next).sub(position);
        out.groundNormal.set(0, 1, 0);
        out.groundSurface = 'concrete';
        out.blocked = false;
        out.ceiling = false;
        out.impactSpeed = 0;
        void self; void MASK_MOVE;
        return next;
      },
      dispose() { },
    };
  }

  applyExplosion(_c: THREE.Vector3, _r: number, _p: number): void { }

  stats() {
    return { bodies: this.bodies.size, active: 0, contacts: 0, stepMs: this.stepMs };
  }
}

export function makeMoveResult(): CharacterMoveResult {
  return {
    applied: new THREE.Vector3(), grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0), groundSurface: 'concrete',
    blocked: false, ceiling: false, impactSpeed: 0,
  };
}
