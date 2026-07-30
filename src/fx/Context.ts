/**
 * The service surface every effect module is written against.
 *
 * Effects never see the engine, the event bus or another system — they get this
 * object and nothing else, which is what keeps FX a pure listener and lets any
 * individual effect be developed and tested in isolation.
 */

import type * as THREE from 'three';
import type { Rand } from '../core/Rand';
import type { GpuParticles } from './GpuParticles';
import type { QuadFX } from './Quads';
import type { Ribbons } from './Ribbons';
import type { Casings } from './Casings';
import type { FxRenderHost } from './Common';

export interface LightRequest {
  x: number; y: number; z: number;
  color: number;
  intensity: number;
  radius: number;
  lifetime: number;
  decay?: 'linear' | 'exp' | 'flicker' | 'flash';
}

export interface DecalDrop {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  size: number;
  group: string;
  lifetime?: number;
  rotation?: number;
  colorTint?: number;
  emissive?: number;
}

export interface FxWorld {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly particles: GpuParticles;
  readonly quads: QuadFX;
  readonly ribbons: Ribbons;
  readonly casings: Casings;
  readonly rand: Rand;
  readonly renderHost: FxRenderHost | null;
  /** Seconds since the FX system initialised. */
  readonly clock: number;
  /** Effect budget scalar, 0.3 (low) … 1.0 (ultra+). */
  readonly density: number;
  readonly quality: string;
  /** True when blood effects are permitted by the player's settings. */
  readonly blood: boolean;
  /** Wind vector currently driving the particle sim. */
  readonly wind: THREE.Vector3;

  /** Ground height under a world point; uses physics when it is available. */
  floorUnder(x: number, y: number, z: number): number;
  /** Squared distance from the camera — used to scale detail by importance. */
  distanceToCamera(x: number, y: number, z: number): number;

  light(req: LightRequest): void;
  decal(req: DecalDrop): void;
  shake(amount: number, frequency?: number, duration?: number): void;
  flash(intensity: number, color?: number, decay?: number): void;
  concussion(intensity: number, duration: number): void;
  /**
   * Retinal white-out, 0..1. Unlike `flash` this is *the* blinding overlay, so
   * an effect must scale it by how close the charge went off — a stun grenade
   * across the street should wash the frame, not erase it.
   */
  blind(amount: number): void;
  /** Schedules `fn` to run after `delay` seconds of FX clock. */
  after(delay: number, fn: () => void): void;
}
