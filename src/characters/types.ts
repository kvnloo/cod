/**
 * Character contract — shared by the procedural character-art module and by AI /
 * gameplay consumers.
 *
 * A `Character` is a skinned, animated humanoid with named bones, hit zones and
 * a procedural animation layer (aim offsets, look-at, foot IK, additive recoil,
 * hit reactions) that gameplay drives directly.
 */

import type * as THREE from 'three';
import type { HitZone } from '../physics/types';

export type CharacterLoadout = 'rifleman' | 'smg' | 'shotgun' | 'sniper' | 'lmg' | 'juggernaut';
export type CharacterFaction = 'militia' | 'pmc' | 'spetsnaz' | 'player';

export interface CharacterOptions {
  faction: CharacterFaction;
  loadout: CharacterLoadout;
  /** Deterministic appearance seed — drives body proportions, kit and colours. */
  seed: number;
  /** Level of detail: 0 = full skinned mesh, 1/2 = decimated. */
  lod?: number;
}

/** Canonical bone names every rig must provide. */
export const BONES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'toeL',
  'upperLegR', 'lowerLegR', 'footR', 'toeR',
] as const;
export type BoneName = (typeof BONES)[number];

export type AnimName =
  | 'idle' | 'idleAlert' | 'walk' | 'run' | 'sprint' | 'strafeL' | 'strafeR'
  | 'crouchIdle' | 'crouchWalk' | 'prone' | 'proneCrawl'
  | 'fire' | 'reload' | 'aim' | 'throw'
  | 'hitFront' | 'hitBack' | 'hitLeft' | 'hitRight'
  | 'deathFront' | 'deathBack' | 'deathHead'
  | 'vaultLow' | 'vaultHigh' | 'coverPeekL' | 'coverPeekR' | 'coverHigh' | 'coverLow';

/** A collider that maps a raycast hit to a damage multiplier. */
export interface HitBox {
  zone: HitZone;
  /** Bone the box is parented to. */
  bone: BoneName;
  /** Local half-extents. */
  half: [number, number, number];
  offset: [number, number, number];
  damageScale: number;
}

export interface Character {
  readonly object: THREE.Object3D;
  readonly options: CharacterOptions;
  readonly hitboxes: readonly HitBox[];
  /** World transform of a named bone; `out` is filled and returned. */
  boneMatrix(name: BoneName, out: THREE.Matrix4): THREE.Matrix4;
  bone(name: BoneName): THREE.Object3D | null;

  /** Blends toward a locomotion state. `speed` in m/s drives the walk↔run blend. */
  setLocomotion(state: 'idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'prone', speed: number, strafe: number): void;
  /** Fires a one-shot additive/override animation. */
  play(name: AnimName, opts?: { fade?: number; speed?: number; loop?: boolean }): void;
  /** Aim offset in radians; drives spine/head/arm procedural rotation. */
  setAim(yaw: number, pitch: number): void;
  /** Head look-at target in world space, or null to release. */
  lookAt(target: THREE.Vector3 | null): void;
  /** Additive recoil kick on the upper body. */
  addRecoil(amount: number): void;
  /** Impulse-driven hit reaction from a direction and zone. */
  react(direction: THREE.Vector3, zone: HitZone, power: number): void;
  /** Switch to ragdoll; returns bodies for the physics system to own. */
  ragdoll(impulse: THREE.Vector3, atZone: HitZone): void;
  readonly isRagdoll: boolean;

  setLOD(lod: number): void;
  update(dt: number): void;
  dispose(): void;
}

export interface CharacterFactory {
  create(opts: CharacterOptions): Character;
  /** Preloads shared geometry/material caches. */
  warm(): Promise<void>;
}
