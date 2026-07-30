/**
 * Fallback combatant simulation.
 *
 * The director talks to actors through `ActorAPI`. When the AI system provides
 * that surface the director uses it and this file never runs. Until then this
 * is a complete, deterministic stand-in: real soldiers with health, line of
 * sight, an approach/engage/reposition state machine, hit resolution against
 * the player's shots, muzzle flashes and tracers — enough that every mode,
 * objective and killstreak can be played and screenshotted for real.
 *
 * It is deliberately self-contained:
 *   • one `InstancedMesh` for every body → a single draw call for the crowd
 *   • no `Math.random`, no per-frame allocation
 *   • damage to the player goes out as `damage:taken` on the bus, which is
 *     exactly what the real AI will emit, so nothing downstream can tell the
 *     difference.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import { MASK_BULLET, MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeRayHit, type GameServices } from './Services';
import { ARCHETYPES } from './Archetypes';
import type { Character, CharacterFactory } from '../characters/types';
import type { ActorAPI, Archetype, DamageOpts, SpawnRequest, Team } from './types';

const MAX_BOTS_BY_PRESET: Record<string, number> = {
  low: 10, medium: 16, high: 22, ultra: 26, cinematic: 30,
};

const TRACERS = 48;
const CORPSE_LINGER = 14;

/** Colour groups for the stand-in bodies. */
type BodyGroup = 'hostile' | 'elite' | 'friendly' | 'dead';
const GROUP_COLORS: ReadonlyArray<[BodyGroup, number]> = [
  ['hostile', 0x2c281f],
  ['elite', 0x36180f],
  ['friendly', 0x1d2733],
  ['dead', 0x141210],
];

function groupOf(b: { alive: boolean; team: Team; archetype: Archetype }): BodyGroup {
  if (!b.alive) return 'dead';
  if (b.team === 'friendly') return 'friendly';
  return b.archetype === 'juggernaut' ? 'elite' : 'hostile';
}

interface Bot {
  /** Skinned character when the character module is available. */
  char: Character | null;
  id: number;
  alive: boolean;
  team: Team;
  archetype: Archetype;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  health: number;
  maxHealth: number;
  accuracy: number;
  aggression: number;
  speed: number;
  range: number;
  damage: number;
  fireInterval: number;
  /** Countdown to the next round in a burst. */
  fireTimer: number;
  burstLeft: number;
  burstCooldown: number;
  state: 'advance' | 'engage' | 'reposition' | 'dead';
  stateTimer: number;
  losTimer: number;
  hasLos: boolean;
  strafe: number;
  deathTime: number;
  deathTilt: number;
  /** Staggered index so ground probes are spread across frames. */
  phase: number;
  tag: string;
  muzzleHeight: number;
  radius: number;
  height: number;
}

export class BotFallback implements ActorAPI {
  private bots: Bot[] = [];
  private byId = new Map<number, Bot>();
  private nextId = 1000;
  private accuracyScale = 1;
  private combatEnabled = true;

  private group = new THREE.Group();
  /** One instanced body per colour group — instanceColor is not guaranteed to
   *  survive the renderer's material patching, and a solid material always is. */
  private bodies = new Map<BodyGroup, THREE.InstancedMesh>();
  private bodyBuf = new Map<BodyGroup, number>();
  private tracers: THREE.InstancedMesh | null = null;
  private tracerAge = new Float32Array(TRACERS);
  private tracerCursor = 0;
  private capacity: number;

  private ray = makeRayHit();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _c = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _col = new THREE.Color();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _down = new THREE.Vector3(0, -1, 0);
  private unsub: Array<() => void> = [];
  /** Staging helper: holds every combatant exactly where it was placed. */
  frozen = false;

  constructor(
    private services: GameServices,
    private rng: Rand,
    private factory: CharacterFactory | null = null,
  ) {
    this.capacity = MAX_BOTS_BY_PRESET[settings.preset] ?? 22;
    if (services.scene) this.buildVisuals(services.scene);
    // The weapon system publishes shots; with no ballistics backend present we
    // resolve them ourselves so the player's rounds actually kill things.
    this.unsub.push(bus.on('weapon:fire', (e) => this.resolvePlayerShot(e.origin, e.direction)));
    this.unsub.push(bus.on('explosion', (e) => this.applyExplosion(e.point, e.radius, e.power)));
  }

  /* ------------------------------------------------------------ visuals -- */

  private buildVisuals(scene: THREE.Object3D): void {
    this.group.name = 'director-bots';
    scene.add(this.group);

    const geo = buildSoldierGeometry();
    for (const [group, color] of GROUP_COLORS) {
      this.bodyBuf.set(group, 0);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.03 });
      const mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.userData.noCollide = true;
      this.group.add(mesh);
      this.bodies.set(group, mesh);
    }

    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const tracers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 1), tracerMat, TRACERS);
    tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tracers.frustumCulled = false;
    tracers.count = TRACERS;
    tracers.layers.set(LAYERS.TRANSPARENT);
    tracers.userData.noCollide = true;
    tracers.renderOrder = 6;
    this.group.add(tracers);
    this.tracers = tracers;
    // Park every tracer off-screen until it is fired.
    for (let i = 0; i < TRACERS; i++) {
      this._m.makeScale(0, 0, 0);
      tracers.setMatrixAt(i, this._m);
    }
    tracers.instanceMatrix.needsUpdate = true;
  }

  /* ---------------------------------------------------------- ActorAPI -- */

  spawnCombatant(req: SpawnRequest): number {
    if (this.liveCount() >= this.capacity) return -1;
    const p = ARCHETYPES[req.archetype];
    const id = this.nextId++;
    const bot: Bot = {
      char: this.makeCharacter(req),
      id,
      alive: true,
      team: req.team,
      archetype: req.archetype,
      position: req.position.clone(),
      velocity: new THREE.Vector3(),
      yaw: req.yaw,
      health: p.health * req.health,
      maxHealth: p.health * req.health,
      accuracy: p.accuracy * req.accuracy,
      aggression: req.aggression,
      speed: p.speed,
      range: p.range,
      damage: p.damage,
      fireInterval: 60 / p.rpm,
      fireTimer: this.rng.range(0.3, 1.2),
      burstLeft: 0,
      burstCooldown: this.rng.range(0.2, 0.8),
      state: 'advance',
      stateTimer: 0,
      losTimer: this.rng.range(0, 0.25),
      hasLos: false,
      strafe: this.rng.bool() ? 1 : -1,
      deathTime: 0,
      deathTilt: this.rng.range(-1, 1),
      phase: this.bots.length & 3,
      tag: req.tag,
      muzzleHeight: p.height * 0.78,
      radius: p.radius,
      height: p.height,
    };
    if (bot.char) {
      bot.char.object.position.copy(bot.position);
      bot.char.object.rotation.y = bot.yaw;
      this.group.add(bot.char.object);
    }
    this.bots.push(bot);
    this.byId.set(id, bot);
    return id;
  }

  /**
   * Builds a real skinned soldier when the character module is reachable.
   * Any failure silently degrades to the instanced stand-in body.
   */
  private makeCharacter(req: SpawnRequest): Character | null {
    if (!this.factory) return null;
    try {
      return this.factory.create({
        faction: req.faction, loadout: req.archetype, seed: req.seed,
      });
    } catch (err) {
      console.warn('[game] character factory failed; using stand-in bodies', err);
      this.factory = null;
      return null;
    }
  }

  despawnCombatant(id: number): void {
    const b = this.byId.get(id);
    if (!b) return;
    this.disposeCharacter(b);
    this.byId.delete(id);
    const i = this.bots.indexOf(b);
    if (i >= 0) this.bots.splice(i, 1);
  }

  isCombatantAlive(id: number): boolean {
    return this.byId.get(id)?.alive === true;
  }

  combatantPosition(id: number, out: THREE.Vector3): boolean {
    const b = this.byId.get(id);
    if (!b) return false;
    out.copy(b.position);
    return true;
  }

  damageCombatant(id: number, amount: number, opts: DamageOpts): boolean {
    const b = this.byId.get(id);
    if (!b || !b.alive) return false;
    return this.hurt(b, amount, opts);
  }

  setAccuracyScale(scale: number): void { this.accuracyScale = Math.max(0, scale); }
  setCombatEnabled(on: boolean): void { this.combatEnabled = on; }
  setFrozen(on: boolean): void { this.frozen = on; }

  /** Attaches the character factory once every system has finished booting. */
  setFactory(factory: CharacterFactory | null): void { this.factory = factory; }

  private disposeCharacter(b: Bot): void {
    if (!b.char) return;
    b.char.object.removeFromParent();
    const f = this.factory as (CharacterFactory & { remove?(c: Character): void }) | null;
    if (f?.remove) f.remove(b.char); else b.char.dispose();
    b.char = null;
  }

  listCombatants(out: number[]): number {
    out.length = 0;
    for (const b of this.bots) if (b.alive) out.push(b.id);
    return out.length;
  }

  /* -------------------------------------------------------------- query -- */

  liveCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }

  hostilesWithin(center: THREE.Vector3, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (const b of this.bots) {
      if (!b.alive || b.team !== 'hostile') continue;
      if (b.position.distanceToSquared(center) <= r2) n++;
    }
    return n;
  }

  /** Nearest live combatant of `team` to `p`, or -1. */
  nearest(p: THREE.Vector3, team: Team, maxDist: number): number {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (const b of this.bots) {
      if (!b.alive || b.team !== team) continue;
      const d = b.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = b.id; }
    }
    return best;
  }

  /* ------------------------------------------------------------- update -- */

  fixedUpdate(dt: number, tick: number): void {
    const svc = this.services;
    const player = svc.player;
    const physics = svc.physics;

    for (let i = this.bots.length - 1; i >= 0; i--) {
      const b = this.bots[i];
      if (!b.alive) {
        b.deathTime += dt;
        if (b.deathTime > CORPSE_LINGER) {
          this.disposeCharacter(b);
          this.byId.delete(b.id);
          this.bots.splice(i, 1);
        }
        continue;
      }

      if (this.frozen) { this.syncCharacter(b, dt, null); continue; }

      /* --- pick a target --- */
      let targetPos: THREE.Vector3 | null = null;
      let targetIsPlayer = false;
      if (b.team === 'hostile') {
        if (player?.alive) { targetPos = player.position; targetIsPlayer = true; }
        else {
          const fid = this.nearest(b.position, 'friendly', 90);
          const f = fid >= 0 ? this.byId.get(fid) : undefined;
          if (f) targetPos = f.position;
        }
      } else {
        const hid = this.nearest(b.position, 'hostile', 90);
        const h = hid >= 0 ? this.byId.get(hid) : undefined;
        if (h) targetPos = h.position;
      }

      if (!targetPos) { this.stepIdle(b, dt); this.syncCharacter(b, dt, null); continue; }

      const dist = b.position.distanceTo(targetPos);

      /* --- line of sight, re-tested on a stagger so cost stays flat --- */
      b.losTimer -= dt;
      if (b.losTimer <= 0) {
        b.losTimer = 0.22 + (b.phase * 0.03);
        this._a.copy(b.position); this._a.y += b.muzzleHeight;
        this._b.copy(targetPos); this._b.y += 1.35;
        b.hasLos = physics?.ready ? physics.lineOfSight(this._a, this._b, MASK_SIGHT) : dist < 70;
      }

      /* --- state machine --- */
      b.stateTimer -= dt;
      const wantRange = b.range * (0.55 + b.aggression * 0.25);
      if (!b.hasLos || dist > wantRange * 1.25) b.state = 'advance';
      else if (b.stateTimer <= 0 && b.state === 'engage' && this.rng.bool(0.25)) {
        b.state = 'reposition';
        b.stateTimer = this.rng.range(1.1, 2.4);
        b.strafe = this.rng.bool() ? 1 : -1;
      } else if (b.state !== 'reposition') b.state = 'engage';
      if (b.state === 'reposition' && b.stateTimer <= 0) { b.state = 'engage'; b.stateTimer = this.rng.range(1.5, 3.5); }

      /* --- movement --- */
      this._d.copy(targetPos).sub(b.position); this._d.y = 0;
      const toTarget = this._d.length() > 0.001 ? this._d.normalize() : this._d.set(0, 0, 1);
      this._c.set(0, 0, 0);
      if (b.state === 'advance') {
        this._c.copy(toTarget).multiplyScalar(b.speed * (0.75 + b.aggression * 0.35));
      } else if (b.state === 'reposition') {
        this._c.set(-toTarget.z, 0, toTarget.x).multiplyScalar(b.speed * 0.7 * b.strafe);
        this._c.addScaledVector(toTarget, dist > wantRange ? b.speed * 0.25 : -b.speed * 0.15);
      } else if (dist < wantRange * 0.55) {
        this._c.copy(toTarget).multiplyScalar(-b.speed * 0.35);
      }

      // Cheap obstacle deflection: if the path forward is blocked, slide along.
      if (physics?.ready && this._c.lengthSq() > 0.01) {
        this._a.copy(b.position); this._a.y += 0.9;
        this._b.copy(this._c).normalize();
        const hit = physics.raycast(this._a, this._b, 1.6, MASK_MOVE, this.ray);
        if (hit.hit) {
          this._b.set(-this._b.z, 0, this._b.x).multiplyScalar(b.strafe);
          this._c.copy(this._b).multiplyScalar(b.speed * 0.6);
        }
      }

      b.position.addScaledVector(this._c, dt);

      /* --- ground snap, staggered across four ticks --- */
      if (physics?.ready && ((tick + b.phase) & 3) === 0) {
        this._a.copy(b.position); this._a.y += 2.2;
        const hit = physics.raycast(this._a, this._down, 6, MASK_MOVE, this.ray);
        if (hit.hit && hit.normal.dot(this._up) > 0.4) b.position.y = hit.point.y;
      }

      // Face the target; soldiers snap to threat much faster than they walk.
      const wantYaw = Math.atan2(toTarget.x, toTarget.z);
      b.yaw = approachAngle(b.yaw, wantYaw, dt * 7.5);

      /* --- firing --- */
      if (this.combatEnabled && b.hasLos && dist < b.range * 1.35) {
        this.stepFiring(b, dt, targetPos, dist, targetIsPlayer);
      } else {
        b.burstLeft = 0;
        b.burstCooldown = Math.max(b.burstCooldown, 0.25);
      }

      this.syncCharacter(b, dt, targetPos);
    }

    this.stepTracers(dt);
    this.syncInstances();
  }

  private stepIdle(b: Bot, dt: number): void {
    b.yaw += dt * 0.25;
  }

  private stepFiring(b: Bot, dt: number, target: THREE.Vector3, dist: number, targetIsPlayer: boolean): void {
    if (b.burstCooldown > 0) { b.burstCooldown -= dt; return; }
    if (b.burstLeft <= 0) {
      b.burstLeft = burstSizeFor(b.archetype, this.rng);
      b.fireTimer = 0;
    }
    b.fireTimer -= dt;
    if (b.fireTimer > 0) return;

    b.fireTimer = b.fireInterval;
    b.burstLeft--;
    if (b.burstLeft <= 0) b.burstCooldown = this.rng.range(0.55, 1.6) / (0.6 + b.aggression * 0.6);

    /* origin + aim */
    this._a.copy(b.position); this._a.y += b.muzzleHeight;
    this._b.copy(target); this._b.y += 1.15;
    this._b.sub(this._a);
    const range = this._b.length();
    if (range < 0.01) return;
    this._b.multiplyScalar(1 / range);

    bus.emit('ai:fire', { id: b.id, origin: this._a.clone(), direction: this._b.clone() });
    b.char?.play('fire', { fade: 0.04 });
    b.char?.addRecoil(0.7);
    this.services.render?.addDynamicLight({
      position: this._a.clone(), color: 0xffbb66, intensity: 22,
      radius: 5.5, lifetime: 0.05, decay: 'flash',
    });

    /* hit roll — falloff past the archetype's comfortable range */
    const falloff = THREE.MathUtils.clamp(1 - (dist - b.range * 0.4) / (b.range * 1.6), 0.12, 1);
    const chance = THREE.MathUtils.clamp(b.accuracy * this.accuracyScale * falloff, 0.02, 0.94);
    const hit = this.rng.bool(chance);

    if (hit && targetIsPlayer) {
      const dmg = b.damage * this.rng.range(0.85, 1.15);
      this._c.copy(this._b).negate();
      bus.emit('damage:taken', {
        amount: dmg, fromDirection: this._c.clone(), sourceId: b.id, lethal: false,
      });
      this.spawnTracer(this._a, this._b, dist);
      return;
    }
    if (hit && !targetIsPlayer) {
      const victim = this.nearest(target, b.team === 'hostile' ? 'friendly' : 'hostile', 2.5);
      if (victim >= 0) this.damageCombatant(victim, b.damage, { direction: this._b, fromPlayer: false, source: 'ai' });
      this.spawnTracer(this._a, this._b, dist);
      return;
    }

    /* a miss still needs to hit *something* so impacts read on the wall behind */
    const physics = this.services.physics;
    this._d.copy(this._b);
    this._d.x += this.rng.range(-0.05, 0.05);
    this._d.y += this.rng.range(-0.03, 0.05);
    this._d.z += this.rng.range(-0.05, 0.05);
    this._d.normalize();
    if (physics?.ready) {
      const h = physics.raycast(this._a, this._d, 120, MASK_BULLET, this.ray, b.id);
      if (h.hit) {
        bus.emit('bullet:impact', {
          point: h.point.clone(), normal: h.normal.clone(), surface: h.surface,
          incoming: this._d.clone(), energy: 900, penetrated: false,
        });
        this.spawnTracer(this._a, this._d, h.distance);
        return;
      }
    }
    this.spawnTracer(this._a, this._d, Math.min(90, dist * 1.4));
  }

  /* ------------------------------------------------------------- damage -- */

  private hurt(b: Bot, amount: number, opts: DamageOpts): boolean {
    b.health -= amount;
    const killed = b.health <= 0;
    const point = opts.point ?? this._a.copy(b.position).setY(b.position.y + 1.2);
    bus.emit('damage:dealt', {
      targetId: b.id, amount, headshot: !!opts.headshot, killed,
      point: point.clone(), fromPlayer: opts.fromPlayer !== false,
    });
    if (!killed && b.char && opts.direction) {
      b.char.react(opts.direction, opts.headshot ? 'head' : 'chest', Math.min(1, amount / 60));
    }
    if (opts.fromPlayer !== false) {
      bus.emit('hud:hitmarker', { headshot: !!opts.headshot, killed, armor: b.archetype === 'juggernaut' });
    }
    if (killed) {
      b.alive = false;
      b.state = 'dead';
      b.deathTime = 0;
      if (b.char) {
        this._b.copy(opts.direction ?? this._up).multiplyScalar(amount * 0.06);
        try { b.char.ragdoll(this._b, opts.headshot ? 'head' : 'chest'); }
        catch { b.char.play(opts.headshot ? 'deathHead' : 'deathFront'); }
      }
      bus.emit('entity:death', {
        id: b.id, byPlayer: opts.fromPlayer !== false, headshot: !!opts.headshot,
        name: b.archetype, point: b.position.clone(),
      });
    }
    return killed;
  }

  /**
   * Resolves one of the player's rounds against the bot capsules. Analytic
   * ray/capsule rather than physics colliders — the fallback owns no bodies.
   */
  private resolvePlayerShot(origin: THREE.Vector3, direction: THREE.Vector3): void {
    let bestBot: Bot | null = null;
    let bestT = Infinity;
    let bestHead = false;

    for (const b of this.bots) {
      if (!b.alive || b.team !== 'hostile') continue;
      this._a.copy(b.position); this._a.y += b.radius;
      this._b.copy(b.position); this._b.y += b.height - b.radius;
      const t = rayCapsule(origin, direction, this._a, this._b, b.radius * 1.15);
      if (t < 0 || t >= bestT) continue;
      // Occlusion: something solid between the muzzle and the body cancels it.
      const physics = this.services.physics;
      if (physics?.ready) {
        this._c.copy(direction).multiplyScalar(t).add(origin);
        if (!physics.lineOfSight(origin, this._c, MASK_SIGHT)) continue;
      }
      bestT = t;
      bestBot = b;
      this._c.copy(direction).multiplyScalar(t).add(origin);
      bestHead = this._c.y > b.position.y + b.height - 0.3;
    }

    if (!bestBot) return;
    this._c.copy(direction).multiplyScalar(bestT).add(origin);
    const armor = bestBot.archetype === 'juggernaut' ? 0.42 : 1;
    const dmg = (bestHead ? 145 : 42) * armor;
    bus.emit('bullet:impact', {
      point: this._c.clone(), normal: this._d.copy(direction).negate().clone(),
      surface: 'flesh', incoming: direction.clone(), energy: 1400, penetrated: false,
    });
    this.hurt(bestBot, dmg, { headshot: bestHead, point: this._c, direction, fromPlayer: true, source: 'player' });
  }

  private applyExplosion(point: THREE.Vector3, radius: number, power: number): void {
    for (const b of this.bots) {
      if (!b.alive) continue;
      this._a.copy(b.position); this._a.y += b.height * 0.5;
      const d = this._a.distanceTo(point);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      this.hurt(b, power * falloff * falloff, {
        point: this._a, direction: this._b.copy(this._a).sub(point).normalize(),
        fromPlayer: true, source: 'explosion',
      });
    }
  }

  /* ------------------------------------------------------------ tracers -- */

  private spawnTracer(origin: THREE.Vector3, dir: THREE.Vector3, length: number): void {
    const t = this.tracers;
    if (!t) return;
    const i = this.tracerCursor;
    this.tracerCursor = (this.tracerCursor + 1) % TRACERS;
    const len = Math.min(length, 80);
    this._a.copy(dir).multiplyScalar(len * 0.5).add(origin);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this._s.set(1, 1, len);
    this._m.compose(this._a, this._q, this._s);
    t.setMatrixAt(i, this._m);
    t.instanceMatrix.needsUpdate = true;
    this.tracerAge[i] = 0.075;
    this._s.set(1, 1, 1);
  }

  private stepTracers(dt: number): void {
    const t = this.tracers;
    if (!t) return;
    let dirty = false;
    for (let i = 0; i < TRACERS; i++) {
      if (this.tracerAge[i] <= 0) continue;
      this.tracerAge[i] -= dt;
      if (this.tracerAge[i] <= 0) {
        this._m.makeScale(0, 0, 0);
        t.setMatrixAt(i, this._m);
        dirty = true;
      }
    }
    if (dirty) t.instanceMatrix.needsUpdate = true;
  }

  /* ---------------------------------------------------------- instances -- */

  /**
   * Places the stand-in bodies. Characters, when present, are transformed in
   * `fixedUpdate` instead, so only the bots without one land here.
   */
  private syncInstances(): void {
    if (this.bodies.size === 0) return;
    for (const g of this.bodyBuf.keys()) this.bodyBuf.set(g, 0);

    for (const b of this.bots) {
      if (b.char) continue;
      const g = groupOf(b);
      const mesh = this.bodies.get(g);
      if (!mesh) continue;
      const n = this.bodyBuf.get(g) ?? 0;
      if (n >= this.capacity) continue;

      if (b.alive) {
        this._q.setFromAxisAngle(this._up, b.yaw);
        this._a.copy(b.position);
      } else {
        // Collapse: tilt over the death axis and sink slightly into the ground.
        const k = Math.min(1, b.deathTime / 0.9);
        const fall = Math.sin(k * Math.PI * 0.5) * (Math.PI * 0.5);
        this._q.setFromAxisAngle(this._up, b.yaw);
        this._q2.setFromAxisAngle(this._d.set(1, 0, b.deathTilt * 0.4).normalize(), fall);
        this._q.multiply(this._q2);
        this._a.copy(b.position);
        this._a.y -= 0.05 * k;
      }
      this._s.setScalar(b.archetype === 'juggernaut' ? 1.16 : 1);
      this._m.compose(this._a, this._q, this._s);
      mesh.setMatrixAt(n, this._m);
      this.bodyBuf.set(g, n + 1);
    }

    for (const [g, mesh] of this.bodies) {
      const n = this.bodyBuf.get(g) ?? 0;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this._s.setScalar(1);
  }

  /** Drives a skinned character's transform, locomotion and aim. */
  private syncCharacter(b: Bot, dt: number, target: THREE.Vector3 | null): void {
    const c = b.char;
    if (!c) return;
    if (!b.alive) {
      // The ragdoll (or the death clip) owns the pose from here.
      return;
    }
    c.object.position.copy(b.position);
    c.object.rotation.y = b.yaw;
    const speed = this._c.length();
    const state = speed < 0.15 ? 'idle' : speed > b.speed * 0.85 ? 'run' : 'walk';
    c.setLocomotion(state, speed, 0);
    if (target) {
      this._b.copy(target).sub(b.position);
      const dist = Math.hypot(this._b.x, this._b.z);
      c.setAim(0, Math.atan2(this._b.y - b.muzzleHeight, Math.max(0.01, dist)));
    }
    void dt;
  }

  clear(): void {
    for (const b of this.bots) this.disposeCharacter(b);
    this.bots.length = 0;
    this.byId.clear();
    for (const mesh of this.bodies.values()) mesh.count = 0;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    this.clear();
    this.group.removeFromParent();
    for (const mesh of this.bodies.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.bodies.clear();
    this.tracers?.geometry.dispose();
    (this.tracers?.material as THREE.Material | undefined)?.dispose();
    this.tracers?.dispose();
  }
}

/* ----------------------------------------------------------------- utils -- */

/**
 * Kit colours. Deliberately dark and desaturated: a soldier has to read as a
 * silhouette against a bright street, and the instance colour multiplies a white
 * base so these are the final albedo.
 */
function teamColor(out: THREE.Color, b: Bot): THREE.Color {
  if (!b.alive) return out.setRGB(0.055, 0.05, 0.045);
  if (b.team === 'friendly') return out.setRGB(0.09, 0.13, 0.19);
  switch (b.archetype) {
    case 'juggernaut': return out.setRGB(0.15, 0.055, 0.045);
    case 'sniper': return out.setRGB(0.10, 0.10, 0.07);
    case 'shotgun': return out.setRGB(0.15, 0.10, 0.055);
    case 'lmg': return out.setRGB(0.12, 0.11, 0.07);
    default: return out.setRGB(0.11, 0.10, 0.075);
  }
}

function burstSizeFor(a: Archetype, rng: Rand): number {
  switch (a) {
    case 'sniper': return 1;
    case 'shotgun': return 1;
    case 'lmg': return rng.int(8, 16);
    case 'juggernaut': return rng.int(10, 20);
    case 'smg': return rng.int(5, 9);
    default: return rng.int(3, 6);
  }
}

function approachAngle(current: number, target: number, t: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * Math.min(1, t);
}

/**
 * Closest approach of a ray to a capsule segment. Returns the ray parameter of
 * the hit, or -1. Cheap enough to run against every bot on every shot.
 */
const _ab = new THREE.Vector3();
const _ao = new THREE.Vector3();
const _tmp = new THREE.Vector3();
function rayCapsule(
  ro: THREE.Vector3, rd: THREE.Vector3,
  a: THREE.Vector3, b: THREE.Vector3, radius: number,
): number {
  _ab.copy(b).sub(a);
  _ao.copy(ro).sub(a);
  const abab = _ab.dot(_ab);
  const abrd = _ab.dot(rd);
  const abao = _ab.dot(_ao);
  const rdao = rd.dot(_ao);

  const A = abab - abrd * abrd;
  const B = abab * rdao - abao * abrd;
  const C = abab * _ao.dot(_ao) - abao * abao - radius * radius * abab;

  if (Math.abs(A) < 1e-6) {
    // Ray parallel to the capsule axis — fall back to a sphere test at the top.
    _tmp.copy(a).addScaledVector(_ab, 0.5);
    return raySphere(ro, rd, _tmp, radius + _ab.length() * 0.5);
  }
  const disc = B * B - A * C;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / A;
  if (t < 0) return -1;
  const y = abao + t * abrd;
  if (y >= 0 && y <= abab) return t;
  // Cap spheres.
  const capCenter = y < 0 ? a : b;
  return raySphere(ro, rd, capCenter, radius);
}

function raySphere(ro: THREE.Vector3, rd: THREE.Vector3, c: THREE.Vector3, r: number): number {
  _tmp.copy(ro).sub(c);
  const b = _tmp.dot(rd);
  const cc = _tmp.dot(_tmp) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

/* -------------------------------------------------------------- geometry -- */

/**
 * A soldier silhouette merged into one non-indexed BufferGeometry: legs, torso,
 * plate carrier, arms, head, helmet and a slung rifle. Chunky on purpose — it
 * has to read as a human shape at 60 m, not survive a close-up.
 */
function buildSoldierGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const push = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
    g.rotateY(ry);
    g.translate(x, y, z);
    parts.push(g.toNonIndexed());
    g.dispose();
  };

  push(new THREE.BoxGeometry(0.16, 0.86, 0.19), -0.11, 0.44, 0);   // left leg
  push(new THREE.BoxGeometry(0.16, 0.86, 0.19), 0.11, 0.44, 0);    // right leg
  push(new THREE.BoxGeometry(0.46, 0.56, 0.26), 0, 1.15, 0);       // torso
  push(new THREE.BoxGeometry(0.50, 0.38, 0.30), 0, 1.20, 0);       // plate carrier
  push(new THREE.BoxGeometry(0.13, 0.50, 0.15), -0.29, 1.14, 0.03); // left arm
  push(new THREE.BoxGeometry(0.13, 0.44, 0.15), 0.29, 1.16, 0.06);  // right arm
  push(new THREE.CapsuleGeometry(0.105, 0.08, 3, 8), 0, 1.54, 0);   // neck+head
  push(new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 1.60, 0); // helmet
  push(new THREE.BoxGeometry(0.07, 0.09, 0.62), 0.20, 1.16, 0.30);  // rifle body
  push(new THREE.BoxGeometry(0.05, 0.16, 0.10), 0.20, 1.06, 0.16);  // magazine

  const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const nAttr = g.getAttribute('normal');
    pos.set(p.array as Float32Array, o * 3);
    nrm.set(nAttr.array as Float32Array, o * 3);
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}
