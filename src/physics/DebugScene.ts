/**
 * `--debug physics` test bed.
 *
 * Everything the module claims to do is exercised here in one scene so it can be
 * judged by eye and by script:
 *
 *   • a crate stack to prove stacking stability and explosion response
 *   • a staircase with a ragdoll dropped down it
 *   • a walkable ramp and an over-limit ramp, walked by a real character
 *     controller whose path is drawn as a ribbon of markers
 *   • glass panes that shatter into radial shards
 *   • a grenade with its predicted arc drawn against the path it actually flew
 *
 * Shots are registered from inside `build()` rather than at module scope so they
 * only appear in capture runs that asked for this scene.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { registerDebugScene, registerShots } from '../core/Shots';
import { Rand } from '../core/Rand';
import { tagSurface } from '../core/Surfaces';
import type { PhysicsSystem } from './Physics';
import { makeMoveResult } from './Physics';
import type { BodyHandle, CharacterController, RagdollHandle } from './types';
import { LAYER, MASK_MOVE } from './types';
import { defaultHumanPose } from './Ragdoll';
import type { Projectile } from './Projectiles';

const SIM_DT = 1 / 120;

interface Crate { body: BodyHandle; mesh: THREE.Mesh; home: THREE.Vector3; }

/**
 * A scripted character: real controller, real capsule, walking a straight line
 * and dropping a marker every few steps so the path it took is visible in a
 * still frame. This is how the step-up and slope behaviour gets judged by eye.
 */
class ScriptedWalker {
  readonly controller: CharacterController;
  readonly mesh: THREE.Mesh;
  readonly position = new THREE.Vector3();
  readonly result = makeMoveResult();
  private velY = 0;
  private trail: THREE.InstancedMesh;
  private trailIndex = 0;
  private tick = 0;
  private matrix = new THREE.Matrix4();

  constructor(
    physics: PhysicsSystem, parent: THREE.Object3D,
    private start: THREE.Vector3, private stopZ: number,
    private speed: number, colour: number, trailColour: number,
  ) {
    const radius = 0.36;
    const height = 1.78;
    this.controller = physics.createCharacter(radius, height, LAYER.PLAYER);
    this.position.copy(start);

    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, height - radius * 2, 8, 18),
      new THREE.MeshStandardMaterial({
        color: colour, roughness: 0.42, metalness: 0.05,
        emissive: colour, emissiveIntensity: 0.08,
      }),
    );
    this.mesh.castShadow = true;
    this.mesh.userData.noCollide = true;
    this.mesh.position.copy(start);
    parent.add(this.mesh);

    const inst = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.13, 0.022, 0.13),
      new THREE.MeshStandardMaterial({
        color: trailColour, emissive: trailColour, emissiveIntensity: 1.1, roughness: 0.6,
      }),
      320,
    );
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.userData.noCollide = true;
    inst.frustumCulled = false;
    inst.count = 0;
    this.trail = inst;
    parent.add(inst);

    this.controller.teleport?.(this.position);
  }

  reset(): void {
    this.position.copy(this.start);
    this.velY = 0;
    this.trailIndex = 0;
    this.tick = 0;
    this.trail.count = 0;
    this.controller.teleport?.(this.position);
    this.mesh.position.copy(this.position);
  }

  step(dt: number): void {
    const c = this.controller;
    const moving = this.position.z > this.stopZ;
    this.velY -= 22 * dt;

    _v0.set(0, this.velY * dt, (moving ? -1 : 0) * this.speed * dt);
    this.position.copy(c.move(this.position, _v0, dt, this.result));
    if (this.result.grounded && this.velY < 0) this.velY = 0;
    if (this.result.ceiling && this.velY > 0) this.velY = 0;
    this.mesh.position.copy(this.position);

    this.tick++;
    if (moving && this.tick % 4 === 0 && this.trailIndex < this.trail.instanceMatrix.count) {
      this.matrix.makeTranslation(
        this.position.x, this.position.y - c.height * 0.5 + 0.014, this.position.z,
      );
      this.trail.setMatrixAt(this.trailIndex++, this.matrix);
      this.trail.count = this.trailIndex;
      this.trail.instanceMatrix.needsUpdate = true;
    }
  }
}

class PhysicsDebugScene {
  readonly root = new THREE.Group();
  private physics: PhysicsSystem;
  private ctx: EngineContext;
  private rand = new Rand('physics-debug');

  private crates: Crate[] = [];
  private panes: THREE.Mesh[] = [];
  private ragdoll: RagdollHandle | null = null;
  private grenade: Projectile | null = null;

  private walkers: ScriptedWalker[] = [];

  private arc: THREE.InstancedMesh | null = null;
  private arcPoints = new Float32Array(220 * 3);
  private path: THREE.InstancedMesh | null = null;
  private pathPoints = new Float32Array(240 * 3);
  private pathCount = 0;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
    this.physics = ctx.engine.get<PhysicsSystem>('physics');
  }

  /* ------------------------------------------------------------------ build */

  build(): void {
    const { scene } = this.ctx;

    // A debug scene owns the whole world for the run. The player system drives
    // the camera from its own transform every frame, which would fight the
    // capture harness's shot placement, so park it for the duration.
    for (const name of ['player', 'weapons', 'ai', 'director']) {
      const sys = this.ctx.engine.tryGet<System>(name);
      if (sys) sys.enabled = false;
    }

    // Take over the world: drop the level and its lighting rig, but leave
    // anything the renderer owns (sky dome, decal buffers, probes) alone.
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c === this.physics.debrisRoot) continue;
      const light = c as THREE.Light;
      if (c.name === 'world' || c.name === 'level') scene.remove(c);
      else if (light.isLight && !c.name.startsWith('dyn')) scene.remove(c);
    }
    this.physics.reset();
    if (!this.physics.debrisRoot.parent) scene.add(this.physics.debrisRoot);

    this.root.name = 'physics-debug';
    scene.add(this.root);

    this.buildEnvironment();
    this.buildGround();
    this.buildStairs();
    this.buildRamps();
    this.buildGlass();
    this.buildPillars();

    // Bake collision for everything static we just made.
    this.physics.rebuildStatic(scene);

    this.buildCrates();
    this.buildWalkers();
    this.buildLines();

    // Settle: two seconds of simulation so the stack is at rest for the wide
    // shot and the walker has climbed the ramp.
    this.simulate(240);
  }

  /**
   * Local material palette.
   *
   * Deliberately self-contained plain `MeshStandardMaterial`s rather than a call
   * into the material library: this scene has to keep rendering while the
   * material and render modules are being rewritten around it, and a physics
   * test bed that goes invisible because someone else's shader is mid-edit is
   * useless for verifying physics.
   */
  private palette = new Map<string, THREE.MeshStandardMaterial>();
  private material(
    key: string, color: number, roughness = 0.9, metalness = 0,
  ): THREE.MeshStandardMaterial {
    let m = this.palette.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.palette.set(key, m);
    }
    return m;
  }

  private buildEnvironment(): void {
    // Every shot in this scene looks in from +X/+Z, so the key comes from that
    // side: lit faces point at the camera and shadows fall away from it.
    const sun = new THREE.DirectionalLight(0xffeacc, 4.0);
    sun.position.set(10, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -18; c.right = 18; c.top = 18; c.bottom = -18;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    this.root.add(sun);
    this.root.add(sun.target);
    sun.target.position.set(0, 0.5, -1.5);

    // Strong sky bounce so shadowed faces still read, plus a cool backlight to
    // separate silhouettes from the ground.
    this.root.add(new THREE.HemisphereLight(0xa8c8ea, 0x4a453d, 1.9));
    const rim = new THREE.DirectionalLight(0x86b6ff, 1.3);
    rim.position.set(-12, 9, -14);
    this.root.add(rim);
    const fill = new THREE.DirectionalLight(0xdfe6f2, 0.55);
    fill.position.set(-9, 4, 12);
    this.root.add(fill);
  }

  private buildGround(): void {
    const mat = this.material('ground', 0x726f68, 0.94);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    tagSurface(ground, 'concrete');
    this.root.add(ground);
  }

  /** Ten 22 cm risers — the classic "does the controller hop?" test. */
  private buildStairs(): void {
    const mat = this.material('steps', 0x9d9a92, 0.9);
    const steps = 10;
    const rise = 0.22;
    const run = 0.32;
    const group = new THREE.Group();
    group.position.set(-4.2, 0, -1.5);
    for (let i = 0; i < steps; i++) {
      const h = rise * (i + 1);
      const b = new THREE.Mesh(new THREE.BoxGeometry(3.0, h, run), mat);
      b.position.set(0, h * 0.5, -i * run);
      b.castShadow = true;
      b.receiveShadow = true;
      tagSurface(b, 'concrete');
      group.add(b);
    }
    // Landing at the top of the flight.
    const landing = new THREE.Mesh(new THREE.BoxGeometry(3.0, rise * steps, 2.2), mat);
    landing.position.set(0, rise * steps * 0.5, -steps * run - 1.1 + run * 0.5);
    landing.castShadow = true;
    landing.receiveShadow = true;
    tagSurface(landing, 'concrete');
    group.add(landing);

    // A single 42 cm ledge: right at the edge of the step-up budget.
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.42, 1.6), mat);
    ledge.position.set(4.0, 0.21, -3.4);
    ledge.castShadow = true;
    ledge.receiveShadow = true;
    tagSurface(ledge, 'concrete');
    this.root.add(ledge);

    this.root.add(group);
  }

  /**
   * One 22° ramp (walkable, rising toward −Z) beside one 58° ramp (over the
   * slope limit, so anything that lands on it slides back off).
   *
   * `rotation.x = +θ` tilts the slab's local +Z end downward, so the low end
   * faces +Z where the walker starts.
   */
  private buildRamps(): void {
    const walkMat = this.material('ramp', 0x9a7548, 0.85);
    const steepMat = this.material('steep', 0x9aa1a9, 0.45, 0.15);

    const ramp = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.28, 7.4), walkMat);
    ramp.position.set(2.6, 1.42, 4.37);
    ramp.rotation.x = THREE.MathUtils.degToRad(22);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    tagSurface(ramp, 'wood');
    this.root.add(ramp);

    // Platform the walkable ramp arrives at, level with the ramp's top end.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.3, 3.2), walkMat);
    deck.position.set(2.6, 2.66, -0.3);
    deck.castShadow = true;
    deck.receiveShadow = true;
    tagSurface(deck, 'wood');
    this.root.add(deck);

    // Support post so the deck does not read as floating.
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.5, 0.3), steepMat);
    post.position.set(2.6, 1.25, -1.6);
    post.castShadow = true;
    tagSurface(post, 'metal');
    this.root.add(post);

    const steep = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.24, 4.0), steepMat);
    steep.position.set(-8.4, 1.85, 2.2);
    steep.rotation.x = THREE.MathUtils.degToRad(58);
    steep.castShadow = true;
    steep.receiveShadow = true;
    tagSurface(steep, 'metal');
    this.root.add(steep);
  }

  private buildGlass(): void {
    const frameMat = this.material('frame', 0x707880, 0.45, 0.2);
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xbcd8e6, roughness: 0.06, metalness: 0.0,
      transparent: true, opacity: 0.34, side: THREE.DoubleSide,
    });
    glassMat.userData.surface = 'glass';

    const group = new THREE.Group();
    group.position.set(-1.4, 0, 5.0);
    group.rotation.y = THREE.MathUtils.degToRad(14);

    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 1.42;
      const pane = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.75, 0.022), glassMat);
      pane.position.set(x, 1.35, 0);
      pane.castShadow = false;
      pane.receiveShadow = false;
      tagSurface(pane, 'glass');
      group.add(pane);
      this.panes.push(pane);

      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.4, 0.1), frameMat);
      mullion.position.set(x - 0.71, 1.2, 0);
      mullion.castShadow = true;
      tagSurface(mullion, 'metal');
      group.add(mullion);
    }
    const lastPost = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.4, 0.1), frameMat);
    lastPost.position.set(1.42 + 0.71, 1.2, 0);
    lastPost.castShadow = true;
    tagSurface(lastPost, 'metal');
    group.add(lastPost);

    const header = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.12, 0.12), frameMat);
    header.position.set(0, 2.36, 0);
    header.castShadow = true;
    tagSurface(header, 'metal');
    group.add(header);

    this.root.add(group);
  }

  /** Foreground/background silhouette breakers so shots have depth layers. */
  private buildPillars(): void {
    const mat = this.material('pillar', 0x86847d, 0.92);
    const rand = new Rand('pillars');
    for (let i = 0; i < 6; i++) {
      const h = rand.range(2.4, 4.6);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.55, h, 0.55), mat);
      const a = (i / 6) * Math.PI * 2 + 0.4;
      p.position.set(Math.cos(a) * 13.5, h * 0.5, Math.sin(a) * 13.5 - 2);
      p.rotation.y = rand.range(-0.4, 0.4);
      p.castShadow = true;
      p.receiveShadow = true;
      tagSurface(p, 'concrete');
      this.root.add(p);
    }
  }

  /* ------------------------------------------------------------------ crates */

  private buildCrates(): void {
    const mat = this.material('crate', 0xa07a44, 0.82);
    const size = 0.5;
    const rows = 5;
    const base = new THREE.Vector3(-0.4, 0, -4.6);
    const rand = new Rand('crates');

    for (let row = 0; row < rows; row++) {
      const n = rows - row;
      for (let i = 0; i < n; i++) {
        const x = base.x + (i - (n - 1) * 0.5) * (size + 0.006);
        const y = base.y + size * 0.5 + row * (size + 0.004);
        const z = base.z + rand.signed() * 0.004;
        this.addCrate(x, y, z, size, mat, rand);
      }
    }
    // Two loose crates so the explosion shot has something to launch.
    this.addCrate(1.35, 0.26, -3.4, size, mat, rand);
    this.addCrate(-2.1, 0.26, -3.9, size, mat, rand);
  }

  private addCrate(x: number, y: number, z: number, size: number, mat: THREE.Material, rand: Rand): void {
    const h = size * 0.5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Crate meshes are driven by the body, so they must not be baked as static.
    mesh.userData.noCollide = true;
    tagSurface(mesh, 'crate');
    this.root.add(mesh);

    const body = this.physics.addBody({
      kind: 'dynamic',
      shape: { type: 'box', half: [h, h, h] },
      position: [x, y, z],
      rotation: quatY(rand.signed() * 0.03),
      mass: 14,
      surface: 'crate',
      layer: LAYER.DYNAMIC,
      object: mesh,
    });
    this.crates.push({ body, mesh, home: new THREE.Vector3(x, y, z) });
  }

  /* ------------------------------------------------------------------ walker */

  /** Two scripted characters: one up the ramp, one up the staircase. */
  private buildWalkers(): void {
    this.walkers.push(new ScriptedWalker(
      this.physics, this.root, new THREE.Vector3(2.6, 0.94, 8.8), -0.8, 3.1,
      0xd8622e, 0x36d6a0,
    ));
    this.walkers.push(new ScriptedWalker(
      this.physics, this.root, new THREE.Vector3(-4.2, 0.94, 0.8), -6.0, 2.9,
      0x2e7fd8, 0x53c8ff,
    ));
  }

  /**
   * Both trajectories are drawn as instanced beads rather than `THREE.Line`:
   * WebGL line width is capped at one pixel on every desktop driver, which is
   * invisible in a 1080p screenshot. Beads also make the *spacing* legible, so
   * the shot shows how the grenade accelerates and slows.
   */
  private buildLines(): void {
    this.arc = makeBeads(0x35d2ff, 0.055, 220);
    this.arc.name = 'predicted-arc';
    this.root.add(this.arc);

    this.path = makeBeads(0xffb43a, 0.038, 260);
    this.path.name = 'flown-path';
    this.root.add(this.path);
  }

  /* --------------------------------------------------------------- scenarios */

  /** Steps the physics world plus the scripted characters for `n` sim ticks. */
  simulate(n: number): void {
    for (let i = 0; i < n; i++) {
      for (const w of this.walkers) w.step(SIM_DT);
      this.physics.fixedUpdate(SIM_DT, this.ctx);
      this.trackGrenade();
    }
    this.physics.update(SIM_DT, this.ctx);
  }

  resetWalkers(): void {
    for (const w of this.walkers) w.reset();
  }

  /** Grounded fraction and climb rate, for scripted assertions. */
  walkerState(): Array<{ pos: [number, number, number]; grounded: boolean; normalY: number }> {
    return this.walkers.map((w) => ({
      pos: [w.position.x, w.position.y, w.position.z],
      grounded: w.result.grounded,
      normalY: w.result.groundNormal.y,
    }));
  }

  /** Restores the crate stack to its authored layout. */
  resetCrates(): void {
    for (const c of this.crates) {
      c.body.setTransform(c.home, IDENTITY_Q);
      c.body.setLinearVelocity(ZERO);
      c.body.wake();
    }
    this.physics.destruction.clear();
  }

  explodeCrates(): void {
    this.physics.applyExplosion(_v1.set(-0.4, 0.35, -3.2), 4.6, 26);
    // Rubble kicked out of the floor by the blast.
    this.physics.spawnDebris(
      _v1.set(-0.4, 0.06, -3.2), _v2.set(0, 1, 0), null,
      { surface: 'concrete', count: 12, size: 0.09, speed: 6.5, seed: 4242 },
    );
  }

  dropRagdoll(): void {
    if (this.ragdoll) { this.physics.removeRagdoll(this.ragdoll); this.ragdoll = null; }
    // Enough of a shove to tumble a few treads and drape over them, not enough
    // to slide the whole flight and end up flat on the floor.
    const origin = _v1.set(-4.2, 2.5, -4.3);
    const pose = defaultHumanPose(origin, Math.PI * 0.5, 1.8);
    this.ragdoll = this.physics.spawnRagdoll({
      pose, mass: 84, entityId: 900, velocity: _v2.set(0.25, 0.1, 1.5),
    });
    this.ragdoll.applyImpulse('chest', _v0.set(0, 5, 26));
    this.buildRagdollProxies();
  }

  /**
   * Capsule proxies so the ragdoll is visible without a skinned character mesh.
   * Dimensions come straight from the colliders, so what is drawn is exactly
   * what is simulated.
   */
  private ragdollProxies: THREE.Mesh[] = [];
  private buildRagdollProxies(): void {
    for (const m of this.ragdollProxies) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.ragdollProxies.length = 0;
    const rag = this.ragdoll;
    if (!rag || !(rag instanceof Object) || typeof (rag as { segmentShape?: unknown }).segmentShape !== 'function') return;
    const shaped = rag as unknown as {
      segmentShape(i: number, out: { radius: number; halfHeight: number }): boolean;
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.6, metalness: 0.05 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xcdb094, roughness: 0.65 });
    const dims = { radius: 0.06, halfHeight: 0.06 };
    for (let i = 0; i < rag.bones; i++) {
      if (!shaped.segmentShape(i, dims)) continue;
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(dims.radius, dims.halfHeight * 2, 5, 12),
        i === 4 ? headMat : mat,
      );
      mesh.castShadow = true;
      mesh.userData.noCollide = true;
      this.root.add(mesh);
      this.ragdollProxies.push(mesh);
    }
  }

  syncRagdollProxies(): void {
    const rag = this.ragdoll;
    if (!rag) return;
    for (let i = 0; i < this.ragdollProxies.length; i++) {
      rag.segmentTransform(i, _v0, _q0);
      this.ragdollProxies[i].position.copy(_v0);
      this.ragdollProxies[i].quaternion.copy(_q0);
    }
  }

  /** Puts every pane back and drops the shards from any previous break. */
  restoreGlass(): void {
    for (const pane of this.panes) {
      pane.visible = true;
      (pane.userData as Record<string, unknown>).shattered = false;
    }
    this.physics.destruction.clear();
    this.physics.rebuildStatic();
  }

  /** Breaks one pane, as if shot through from the camera side. */
  shatterPane(index: number, power = 1.5, seed = 20260729): void {
    const pane = this.panes[index];
    if (!pane) return;
    pane.getWorldPosition(_v1);
    _v1.y += 0.24;
    pane.getWorldDirection(_v2);
    this.physics.shatterGlass(pane, {
      point: _v1, direction: _v2.negate(), shards: 14, seed, power,
    });
  }

  throwGrenade(): void {
    if (this.grenade) { this.physics.removeProjectile(this.grenade); this.grenade = null; }
    this.pathCount = 0;

    const origin = new THREE.Vector3(6.4, 1.75, 7.2);
    const velocity = new THREE.Vector3(0, 9.0, -8.6);

    const res = this.physics.predictTrajectory(origin, velocity, this.arcPoints, {
      radius: 0.05, restitution: 0.42, friction: 0.55, maxTime: 4.5, maxBounces: 3,
      mask: MASK_MOVE | LAYER.GLASS,
    });
    if (this.arc) setBeads(this.arc, this.arcPoints, res.count, 1);

    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.06, 1),
      new THREE.MeshStandardMaterial({ color: 0x4c5a3f, roughness: 0.55, metalness: 0.2 }),
    );
    mesh.castShadow = true;
    mesh.userData.noCollide = true;
    this.root.add(mesh);

    this.grenade = this.physics.spawnProjectile({
      position: origin, velocity, radius: 0.05, mass: 0.42,
      restitution: 0.42, friction: 0.55, rollingFriction: 1.4,
      object: mesh, surface: 'metal',
    });
  }

  private trackGrenade(): void {
    const g = this.grenade;
    if (!g || !g.alive) return;
    const cap = Math.floor(this.pathPoints.length / 3);
    if (this.pathCount >= cap) return;
    const t = g.body.translation();
    const i = this.pathCount * 3;
    this.pathPoints[i] = t.x; this.pathPoints[i + 1] = t.y; this.pathPoints[i + 2] = t.z;
    this.pathCount++;
    // Every third sim tick: 40 beads a second reads as a trail, 120 as a tube.
    if (this.path && this.pathCount % 3 === 0) setBeads(this.path, this.pathPoints, this.pathCount, 3);
  }

  /** Called after every simulate() batch so proxies match the solver. */
  postSimulate(): void {
    this.syncRagdollProxies();
    this.physics.update(SIM_DT, this.ctx);
  }
}


/** Instanced bead strip used to draw trajectories legibly at 1080p. */
function makeBeads(colour: number, size: number, capacity: number): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(size, 0),
    new THREE.MeshStandardMaterial({
      color: colour, emissive: colour, emissiveIntensity: 1.6, roughness: 0.5,
    }),
    capacity,
  );
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.noCollide = true;
  inst.frustumCulled = false;
  inst.count = 0;
  return inst;
}

const _beadMatrix = new THREE.Matrix4();

/** Places `count` beads from an XYZ-triple buffer, taking every `stride`th. */
function setBeads(inst: THREE.InstancedMesh, points: Float32Array, count: number, stride: number): void {
  let n = 0;
  for (let i = 0; i < count && n < inst.instanceMatrix.count; i += stride) {
    _beadMatrix.makeTranslation(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    inst.setMatrixAt(n++, _beadMatrix);
  }
  inst.count = n;
  inst.instanceMatrix.needsUpdate = true;
}

/* --------------------------------------------------------------- registration */

let active: PhysicsDebugScene | null = null;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const IDENTITY_Q = new THREE.Quaternion();
const ZERO = new THREE.Vector3();

function quatY(angle: number): [number, number, number, number] {
  const h = angle * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

registerDebugScene('physics', (ctx: EngineContext) => {
  const scene = new PhysicsDebugScene(ctx);
  active = scene;
  scene.build();
  scene.dropRagdoll();
  scene.simulate(200);
  scene.throwGrenade();
  scene.simulate(200);
  scene.postSimulate();

  // The capture harness settles each shot with extra frames, during which the
  // solver keeps running; a tiny presentation system keeps the debug proxies
  // in step with it so the screenshot never shows a stale pose.
  ctx.engine.add({
    name: 'physics-debug-sync',
    order: 650,
    update: () => scene.syncRagdollProxies(),
  });

  registerShots([
    {
      name: 'physics-overview',
      description: 'Wide view of the physics test bed: crate stack, stairs, ramps, glass and the walked path',
      position: [11.0, 5.6, 12.0], yaw: 40.8, pitch: -16.0, fov: 62, hour: 11, viewModel: false,
      setup: () => { scene.simulate(30); scene.postSimulate(); },
    },
    {
      name: 'physics-crates',
      description: 'Crate stack blown apart by an explosion, with concrete debris in flight',
      position: [0.0, 2.6, 2.2], yaw: 3.4, pitch: -14.0, fov: 62, hour: 11, viewModel: false,
      setup: () => {
        scene.resetCrates();
        scene.simulate(90);
        scene.explodeCrates();
        scene.simulate(26);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-stack',
      description: 'Settled crate pyramid — stacking stability with no jitter or sinking',
      position: [0.0, 2.4, 2.0], yaw: 3.4, pitch: -13.0, fov: 54, hour: 11, viewModel: false,
      setup: () => {
        scene.resetCrates();
        scene.simulate(260);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-ragdoll',
      description: 'Ragdoll thrown down a flight of stairs, draped over the treads',
      position: [0.8, 2.6, 2.4], yaw: 45.0, pitch: -15.0, fov: 58, hour: 11, viewModel: false,
      setup: () => {
        scene.resetCrates();
        scene.dropRagdoll();
        scene.simulate(170);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-slope',
      description: 'Character controller partway up a 22° ramp; the green ribbon is the foot path it traced, evenly spaced because the slope costs it no speed',
      position: [7.6, 3.2, 9.6], yaw: 38.0, pitch: -9.1, fov: 60, hour: 11, viewModel: false,
      setup: () => {
        scene.resetWalkers();
        scene.simulate(300);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-stairs',
      description: 'Character controller climbing 22 cm stair treads; the blue ribbon shows it stepping up cleanly instead of hopping',
      position: [-0.2, 4.0, 1.6], yaw: 35.5, pitch: -20.7, fov: 58, hour: 11, viewModel: false,
      setup: () => {
        scene.resetCrates();
        scene.resetWalkers();
        scene.simulate(300);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-glass',
      description: 'Glass pane shattering into radial shards a few frames after the hit',
      position: [1.1, 1.9, 8.6], yaw: 34.2, pitch: -8.5, fov: 55, hour: 11, viewModel: false,
      setup: () => {
        scene.restoreGlass();
        scene.simulate(4);
        // One pane broken a second ago (settled pile) and one breaking right
        // now — the harness's settle frames catch the second mid-air.
        scene.shatterPane(0, 1.2, 424242);
        scene.simulate(150);
        scene.shatterPane(2, 2.6, 20260729);
        scene.postSimulate();
      },
    },
    {
      name: 'physics-grenade',
      description: 'Grenade in flight: cyan is the predicted arc including bounces, amber is the path actually flown',
      position: [14.6, 3.7, 1.2], yaw: 90.0, pitch: -14.0, fov: 58, hour: 11, viewModel: false,
      setup: () => {
        scene.throwGrenade();
        scene.simulate(150);
        scene.postSimulate();
      },
    },
  ]);
});

/** Exposed for scripted verification from the capture harness. */
export function physicsDebugScene(): unknown { return active; }
