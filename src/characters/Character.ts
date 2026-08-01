/**
 * A live character: geometry, skeleton, animation graph, hit volumes and LODs.
 *
 * The mesh is rebuilt per LOD but every level shares one skeleton, so switching
 * level costs a visibility flip and nothing else. Materials are shared across
 * every character of a faction; per-character colour lives in the vertex tint
 * baked into the geometry.
 */

import * as THREE from 'three';
import type { HitZone } from '../physics/types';
import type {
  AnimName, BoneName, Character as CharacterAPI, CharacterOptions, HitBox,
} from './types';
import { BONES } from './types';
import { BONE_INDEX, buildRig, type PoseSkeleton, type RigInstance } from './Rig';
import { makeAppearance, appearanceMass, type Appearance } from './Appearance';
import { buildSoldier } from './geom/Soldier';
import { buildHitboxes } from './Hitboxes';
import { Animator, type Locomotion } from './anim/Animator';
import type { GroundProbe } from './anim/FootIK';
import type { CharacterMaterials } from './Materials';

/** Services the character needs from the rest of the engine, all optional. */
export interface CharacterHost {
  materials: CharacterMaterials;
  /** Physics ragdoll spawner, when a physics world exists. */
  spawnRagdoll?(opts: {
    bones: Record<string, THREE.Object3D | null>;
    root?: THREE.Object3D | null;
    mass?: number; entityId?: number; velocity?: THREE.Vector3; quality?: number;
  }): { applyImpulse(zone: HitZone, impulse: THREE.Vector3): void; remove(): void } | null;
  groundProbe?: GroundProbe | null;
  /** Called when a foot plants, for footstep audio/dust. */
  onFootPlant?(character: Character, foot: number, speed: number): void;
  onDeath?(character: Character): void;
}

interface LodLevel {
  mesh: THREE.SkinnedMesh | null;
  triangles: number;
}

const MAX_LOD = 3;

export class Character implements CharacterAPI {
  readonly object = new THREE.Group();
  readonly options: CharacterOptions;
  readonly appearance: Appearance;
  readonly hitboxes: readonly HitBox[];
  readonly rig: RigInstance;
  readonly animator: Animator;
  /** Attach weapons here; it tracks the chest and the current carry pose. */
  readonly weaponSocket: THREE.Object3D;
  /** Entity id used for physics ownership; set by the spawner. */
  entityId = -1;

  private levels: LodLevel[] = [];
  private lod = 0;
  private ragdollHandle: { applyImpulse(z: HitZone, i: THREE.Vector3): void; remove(): void } | null = null;
  private ragdollActive = false;
  private disposed = false;
  private accum = 0;
  private velocity = new THREE.Vector3();
  private lastPos = new THREE.Vector3();

  /** Screen-space height in pixels, filled in by the owning system. */
  screenSize = 1000;
  /** Simulation rate divider applied at low LOD. */
  private stepInterval = 0;

  constructor(opts: CharacterOptions, private host: CharacterHost) {
    this.options = { ...opts };
    this.appearance = makeAppearance(this.options);
    this.rig = buildRig(this.appearance.proportions);
    this.hitboxes = buildHitboxes(this.rig, this.appearance);

    this.object.name = `character:${opts.faction}:${opts.seed}`;
    this.object.add(this.rig.root);

    this.animator = new Animator(this.rig, this.object);
    this.weaponSocket = this.animator.weaponSocket;
    this.animator.groundProbe = host.groundProbe ?? null;
    this.animator.hooks = {
      onFootPlant: (foot, speed) => host.onFootPlant?.(this, foot, speed),
      onDeathComplete: () => host.onDeath?.(this),
    };

    for (let i = 0; i < MAX_LOD; i++) this.levels.push({ mesh: null, triangles: 0 });
    this.ensureLevel(Math.max(0, Math.min(MAX_LOD - 1, opts.lod ?? 0)));
    this.lod = opts.lod ?? 0;
    this.applyVisibility();
  }

  /* --------------------------------------------------------------- meshes */

  private ensureLevel(lod: number): LodLevel {
    const level = this.levels[lod];
    if (level.mesh) return level;
    const built = buildSoldier(this.rig, this.appearance, lod);
    const mats = built.slots.map((s) => this.host.materials.get(s as 0 | 1 | 2 | 3 | 4, this.options.faction));
    const mesh = new THREE.SkinnedMesh(built.geometry, mats);
    mesh.name = `soldier-lod${lod}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.bind(this.rig.skeleton, new THREE.Matrix4());
    this.object.add(mesh);
    level.mesh = mesh;
    level.triangles = built.triangles;
    return level;
  }

  private applyVisibility(): void {
    for (let i = 0; i < MAX_LOD; i++) {
      const m = this.levels[i].mesh;
      if (m) m.visible = i === this.lod;
    }
  }

  setLOD(lod: number): void {
    const l = Math.max(0, Math.min(MAX_LOD - 1, Math.round(lod)));
    if (l === this.lod && this.levels[l].mesh) return;
    this.ensureLevel(l);
    this.lod = l;
    this.stepInterval = l === 0 ? 0 : l === 1 ? 1 / 30 : 1 / 12;
    this.applyVisibility();
  }

  get currentLOD(): number { return this.lod; }
  get triangles(): number { return this.levels[this.lod].triangles; }

  /**
   * Mean and minimum baked vertex tint per material group.
   *
   * Character albedo is a product of a generated texture and a per-vertex tint
   * that already carries baked occlusion, so "is the plate carrier too dark?"
   * is a numeric question. This answers it without a screenshot.
   */
  tintStats(): { faction: string; groups: { slot: number; mean: number[]; min: number }[] } {
    const mesh = this.levels[this.lod].mesh;
    const out: { slot: number; mean: number[]; min: number }[] = [];
    const geo = mesh?.geometry;
    const col = geo?.getAttribute('color');
    const idx = geo?.getIndex();
    if (!geo || !col || !idx) return { faction: this.options.faction, groups: out };
    for (let g = 0; g < geo.groups.length; g++) {
      const grp = geo.groups[g];
      const seen = new Set<number>();
      let r = 0, gg = 0, bb = 0, min = 1;
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        const v = idx.getX(i);
        if (seen.has(v)) continue;
        seen.add(v);
        const cr = col.getX(v), cg = col.getY(v), cb = col.getZ(v);
        r += cr; gg += cg; bb += cb;
        min = Math.min(min, 0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
      }
      const n = Math.max(1, seen.size);
      out.push({ slot: g, mean: [r / n, gg / n, bb / n], min });
    }
    return { faction: this.options.faction, groups: out };
  }

  /* ------------------------------------------------------------- queries */

  bone(name: BoneName): THREE.Object3D | null {
    return this.rig.byName[name] ?? null;
  }

  boneMatrix(name: BoneName, out: THREE.Matrix4): THREE.Matrix4 {
    const b = this.rig.bones[BONE_INDEX[name]];
    return b ? out.copy(b.matrixWorld) : out.identity();
  }

  /** Standing height in metres, useful for LOD and camera framing. */
  get height(): number { return this.rig.standHeight; }

  /* ------------------------------------------------------------- driving */

  setLocomotion(state: Locomotion, speed: number, strafe: number): void {
    if (this.ragdollActive) return;
    this.animator.setLocomotion(state, speed, strafe);
  }

  play(name: AnimName, opts?: { fade?: number; speed?: number; loop?: boolean }): void {
    if (this.ragdollActive) return;
    this.animator.play(name, opts);
  }

  setAim(yaw: number, pitch: number): void {
    if (this.ragdollActive) return;
    this.animator.setAim(yaw, pitch);
  }

  lookAt(target: THREE.Vector3 | null): void {
    if (this.ragdollActive) return;
    this.animator.lookAt(target);
  }

  addRecoil(amount: number): void {
    if (this.ragdollActive) return;
    this.animator.addRecoil(amount);
  }

  react(direction: THREE.Vector3, zone: HitZone, power: number): void {
    if (this.ragdollActive) return;
    this.object.getWorldQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    const facing = Math.atan2(_fwd.x, _fwd.z);
    this.animator.react(direction, zone, power, facing);
  }

  setGroundProbe(probe: GroundProbe | null): void {
    this.animator.groundProbe = probe;
  }

  /* ------------------------------------------------------------- ragdoll */

  get isRagdoll(): boolean { return this.ragdollActive; }

  ragdoll(impulse: THREE.Vector3, atZone: HitZone): void {
    if (this.ragdollActive || this.disposed) return;
    this.ragdollActive = true;
    this.object.updateMatrixWorld(true);

    const bones: Record<string, THREE.Object3D | null> = {};
    for (const name of BONES) bones[name] = this.rig.byName[name];

    const handle = this.host.spawnRagdoll?.({
      bones,
      root: this.object,
      mass: appearanceMass(this.appearance),
      entityId: this.entityId,
      velocity: this.velocity,
      // Quality 0: cheapest crowd ragdoll (no neck/feet, 0 extra solver iters).
      // lod0 used to pass 6 and manufactured death-window frame spikes.
      quality: 0,
    }) ?? null;

    this.ragdollHandle = handle;
    if (handle && impulse.lengthSq() > 1e-6) handle.applyImpulse(atZone, impulse);
    // Without a physics world the character simply holds its last pose, which
    // is a death pose if a death clip was played first.
  }

  /* -------------------------------------------------------------- update */

  update(dt: number): void {
    if (this.disposed) return;
    // Track world velocity so a ragdoll inherits the character's momentum.
    this.object.getWorldPosition(_pos);
    if (dt > 1e-5) this.velocity.subVectors(_pos, this.lastPos).multiplyScalar(1 / dt);
    this.lastPos.copy(_pos);

    if (this.ragdollActive) {
      (this.rig.skeleton as PoseSkeleton).invalidate?.();
      return;
    }

    if (this.stepInterval > 0) {
      this.accum += dt;
      if (this.accum < this.stepInterval) return;
      dt = this.accum;
      this.accum = 0;
    }
    this.animator.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ragdollHandle?.remove();
    this.ragdollHandle = null;
    for (const l of this.levels) {
      if (!l.mesh) continue;
      l.mesh.geometry.dispose();
      this.object.remove(l.mesh);
      l.mesh = null;
    }
    this.object.removeFromParent();
  }
}

const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _pos = new THREE.Vector3();
