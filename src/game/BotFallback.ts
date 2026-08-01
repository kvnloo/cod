/**
 * Fallback combatant simulation.
 *
 * The director talks to actors through `ActorAPI`. `src/ai/` is now wired to
 * that surface (`AIActorBridge` in `Services.ts`), so in the shipping game this
 * file is never constructed. It survives for the case it was always meant for:
 * a build with no AI module registered at all — headless game tests, a stripped
 * bundle, a debug scene that wants bodies without a tactical stack.
 *
 * It is deliberately self-contained:
 *   • one `InstancedMesh` for every body → a single draw call for the crowd
 *   • no `Math.random`, no per-frame allocation
 *   • damage to the player goes out as `damage:taken` on the bus, which is
 *     exactly what the real AI emits, so nothing downstream can tell the
 *     difference.
 *
 * ## No coin flip
 *
 * This used to decide whether you were hit with `rng.bool(chance)`. That is the
 * single worst thing a shooter can do: it makes cover, range, movement and
 * stance all cosmetic, and it is why an enemy could shoot at you for a minute
 * without killing you and then kill you for no visible reason.
 *
 * Every round now leaves the barrel along a real direction and is traced with
 * `MASK_BULLET` — the same collider set the player's own rounds resolve
 * against. Whether it hits is decided by where the muzzle was pointing, what
 * was in the way, and which part of the body the line passed through. The
 * *skill* knobs are where they belong: a reaction delay before the first shot,
 * an aim cone that starts wide and converges while the shooter tracks you, and
 * deliberate opening misses so the fight has a readable first beat.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { Rand } from '../core/Rand';
import { LAYERS } from '../render/types';
import { MASK_BULLET, MASK_MOVE, MASK_SIGHT } from '../physics/types';
import { makeRayHit, type GameServices } from './Services';
import { ARCHETYPES } from './Archetypes';
import { resolveHit } from './Combat';
import type { Character, CharacterFactory } from '../characters/types';
import type { ActorAPI, Archetype, DamageOpts, HitZone, SpawnRequest, Team } from './types';

const MAX_BOTS_BY_PRESET: Record<string, number> = {
  // Cap live bodies to what the frame budget can absorb. Each skinned bot is
  // animation + hitboxes + LOS rays on the fixed step; the wall-path p99 failure
  // was CPU-bound with ~2k draws and a handful of combatants, not fillrate.
  low: 8, medium: 12, high: 14, ultra: 20, cinematic: 24,
};

const TRACERS = 48;
const CORPSE_LINGER = 14;

/**
 * Fire-control constants, mirroring `src/ai/Combat.ts` so the two backends feel
 * like the same enemy.
 *
 * `reaction*` is the gap between acquiring line of sight and the first round.
 * CoD campaign AI sits around 300-500 ms on Regular; below ~200 ms an enemy
 * appearing from cover is an unavoidable death.
 */
const FIRE = {
  reactionMin: 0.34,
  reactionMax: 0.62,
  /** Aim cone at the moment of acquisition, radians. ~4.9° */
  aimErrorStart: 0.085,
  /** Time constant of the exponential convergence toward the floor, seconds. */
  aimConverge: 1.7,
  /** Tightest cone a perfectly-accurate archetype ever reaches, radians. */
  aimFloorBest: 0.006,
  /** Widest floor, for the sloppiest archetype. */
  aimFloorWorst: 0.030,
  /** Opening rounds of an engagement thrown deliberately wide. */
  missFirstShots: 2,
  /** Damage falls off linearly past the archetype's range, down to this. */
  falloffFloor: 0.4,
  /** Per-zone damage multipliers. */
  zone: { head: 2.2, neck: 1.7, chest: 1, stomach: 0.9, arm: 0.7, leg: 0.7, none: 1 },
} as const;

/** The player capsule, as the fallback sim models it. Matches `TUNING` in Movement. */
const PLAYER_BODY = { height: 1.8, radius: 0.4 } as const;

/** Anti-repeat: never play the same death clip on two consecutive kills. */
let lastDeathClip: 'deathFront' | 'deathBack' | 'deathHead' | null = null;

function zoneHasArmor(archetype: Archetype, zone: keyof typeof FIRE.zone | string | undefined): boolean {
  const p = ARCHETYPES[archetype];
  if (!p) return false;
  const z = (zone && zone !== 'none' ? zone : 'chest') as keyof typeof p.armor;
  return (p.armor[z] ?? 1) < 1 - 1e-6;
}

/**
 * Directional death clip from shot direction relative to body yaw, with
 * headshots forced to deathHead and consecutive repeats broken.
 */
function pickDeathClip(
  yaw: number,
  direction: THREE.Vector3 | undefined,
  headshot: boolean,
): 'deathFront' | 'deathBack' | 'deathHead' {
  let pick: 'deathFront' | 'deathBack' | 'deathHead';
  if (headshot) {
    pick = 'deathHead';
  } else if (direction && direction.lengthSq() > 1e-8) {
    // Bullet direction aligned with facing → struck from behind.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const d = direction.clone().normalize();
    pick = d.x * fx + d.z * fz > 0.15 ? 'deathBack' : 'deathFront';
  } else {
    pick = 'deathFront';
  }
  if (pick === lastDeathClip) {
    if (pick === 'deathHead') pick = 'deathFront';
    else if (pick === 'deathFront') pick = 'deathBack';
    else pick = 'deathFront';
  }
  lastDeathClip = pick;
  return pick;
}


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
  /** 0..1 marksmanship. Drives the aim cone floor — never a hit probability. */
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
  /** Seconds left before this engagement's first round may leave the barrel. */
  reactionTimer: number;
  /** True once the reaction has elapsed for the current engagement. */
  ready: boolean;
  /** Current angular aim error, radians. Converges while the target is held. */
  aimError: number;
  /** Rounds fired since this engagement began — drives the opening misses. */
  engagementShots: number;
  /** Slow random walk so successive rounds group instead of scattering. */
  errorPhase: number;
  errorYaw: number;
  errorPitch: number;
  shotsFired: number;
  shotsHit: number;
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
  /**
   * Entity ids start well clear of `Agent.entityId`, which is `1000 + agentId`.
   * The two backends are mutually exclusive today, but a debug scene that
   * spawns AI agents alongside a forced fallback would otherwise alias two
   * different combatants onto the same id and route damage to the wrong one.
   */
  private nextId = 5000;
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
    this.unsub.push(bus.on('weapon:fire', (e) => this.resolvePlayerShot(e.origin, e.direction, e.weaponId)));
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
      // Stand-in bodies do not cast: the atlas already re-submits the whole
      // casting scene once per cascade, and an InstancedMesh with
      // frustumCulled=false is drawn into every cascade whenever count>0 —
      // free extra atlas draws on the pass that is ~70% of frame draw calls.
      // Skinned characters (when the factory is present) cast via their own
      // meshes; the fallback silhouette is silhouette enough without a shadow.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
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
      reactionTimer: -1,
      ready: false,
      aimError: FIRE.aimErrorStart,
      engagementShots: 0,
      errorPhase: this.rng.range(0, 6.28),
      errorYaw: 0,
      errorPitch: 0,
      shotsFired: 0,
      shotsHit: 0,
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
        // Stagger harder past mid-range: LOS is a raycast every bot and is pure
        // CPU. Close fights stay responsive; far ones refresh ~3 Hz.
        const losBase = dist > 28 ? 0.38 : dist > 16 ? 0.28 : 0.20;
        b.losTimer = losBase + (b.phase * 0.04);
        this._a.copy(b.position); this._a.y += b.muzzleHeight;
        // Chest height on whatever we are looking at. The player's `position`
        // is the capsule *centre*, not the feet, so this used to aim a third of
        // a metre over his head — invisible while hits were a coin flip, fatal
        // to the shot once they stopped being one.
        this._b.copy(targetPos);
        this._b.y += targetIsPlayer ? 0.12 : 1.2;
        const had = b.hasLos;
        b.hasLos = physics?.ready ? physics.lineOfSight(this._a, this._b, MASK_SIGHT) : dist < 70;
        if (b.hasLos && !had) this.beginEngagement(b);
        else if (!b.hasLos && had) { b.ready = false; b.reactionTimer = -1; }
      }
      this.stepAim(b, dt);

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

      // Cheap obstacle deflection, only while advancing/repositioning and only
      // on staggered ticks — engage strafes are short and do not need a ray.
      if (physics?.ready && this._c.lengthSq() > 0.01
          && (b.state === 'advance' || b.state === 'reposition')
          && ((tick + b.phase) & 1) === 0) {
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

  /**
   * Starts the clock on a fresh engagement.
   *
   * This is the beat the player needs: the enemy has seen you, but the first
   * round is still `reaction` seconds away, and the ones after it open wide.
   */
  private beginEngagement(b: Bot): void {
    b.ready = false;
    b.reactionTimer = this.rng.range(FIRE.reactionMin, FIRE.reactionMax)
      / Math.max(0.35, this.accuracyScale);
    b.aimError = FIRE.aimErrorStart;
    b.engagementShots = 0;
    b.burstLeft = 0;
  }

  /**
   * Converges the aim cone while the shooter holds the target, and relaxes it
   * back out when he loses it. This is the whole difficulty curve: standing in
   * the open is survivable for a moment and *staying* there is not.
   */
  private stepAim(b: Bot, dt: number): void {
    if (b.hasLos && b.ready) {
      const floor = THREE.MathUtils.lerp(
        FIRE.aimFloorWorst, FIRE.aimFloorBest, THREE.MathUtils.clamp(b.accuracy / 0.45, 0, 1),
      ) / Math.max(0.35, this.accuracyScale);
      b.aimError += (floor - b.aimError) * (1 - Math.exp(-dt / FIRE.aimConverge));
    } else {
      b.aimError = Math.min(FIRE.aimErrorStart, b.aimError + dt * 0.05);
    }
    b.errorPhase += dt * 2.7;
  }

  private stepFiring(b: Bot, dt: number, target: THREE.Vector3, dist: number, targetIsPlayer: boolean): void {
    if (!b.ready) {
      if (b.reactionTimer < 0) this.beginEngagement(b);
      b.reactionTimer -= dt;
      if (b.reactionTimer > 0) return;
      b.ready = true;
    }
    if (b.burstCooldown > 0) { b.burstCooldown -= dt; return; }
    if (b.burstLeft <= 0) {
      b.burstLeft = burstSizeFor(b.archetype, this.rng);
      b.fireTimer = 0;
    }
    b.fireTimer -= dt;
    if (b.fireTimer > 0) return;

    b.fireTimer = b.fireInterval;
    b.burstLeft--;
    b.engagementShots++;
    b.shotsFired++;
    if (b.burstLeft <= 0) b.burstCooldown = this.rng.range(0.55, 1.6) / (0.6 + b.aggression * 0.6);

    /* --- origin ---------------------------------------------------------- */
    this._a.copy(b.position); this._a.y += b.muzzleHeight;

    /* --- aim point: centre mass, or deliberately past it on the opening --- */
    this._b.copy(target);
    this._b.y += targetIsPlayer ? 0.05 : 1.15;
    if (b.engagementShots <= FIRE.missFirstShots) {
      this._c.copy(this._b).sub(this._a);
      this._c.y = 0;
      if (this._c.lengthSq() > 1e-6) {
        this._c.normalize();
        const side = this.rng.bool() ? 1 : -1;
        this._b.x += this._c.z * side * this.rng.range(0.55, 1.45);
        this._b.z += -this._c.x * side * this.rng.range(0.55, 1.45);
        this._b.y += this.rng.range(0.35, 1.1);
      }
    }

    /* --- aim error: a converging cone, wobbled by a slow random walk so the
       rounds land as a group rather than as noise ------------------------- */
    const lead = THREE.MathUtils.clamp(this.accuracyScale, 0.35, 2);
    const cone = b.aimError / lead;
    b.errorYaw += (Math.sin(b.errorPhase * 1.7) * 0.6 + this.rng.signed() * 0.4 - b.errorYaw) * 0.1;
    b.errorPitch += (Math.cos(b.errorPhase * 1.3) * 0.5 + this.rng.signed() * 0.4 - b.errorPitch) * 0.1;

    this._d.copy(this._b).sub(this._a);
    const range = this._d.length();
    if (range < 0.01) return;
    this._d.multiplyScalar(1 / range);
    const cy = Math.cos(b.errorYaw * cone);
    const sy = Math.sin(b.errorYaw * cone);
    const dx = this._d.x * cy + this._d.z * sy;
    const dz = -this._d.x * sy + this._d.z * cy;
    this._d.set(dx, this._d.y + b.errorPitch * cone, dz).normalize();

    bus.emit('ai:fire', { id: b.id, origin: this._a.clone(), direction: this._d.clone() });
    b.char?.play('fire', { fade: 0.04 });
    b.char?.addRecoil(0.7);
    this.services.render?.addDynamicLight({
      position: this._a.clone(), color: 0xffbb66, intensity: 22,
      radius: 5.5, lifetime: 0.05, decay: 'flash',
    });

    this.resolveBotShot(b, target, dist, targetIsPlayer);
  }

  /**
   * Traces one round. `this._a` is the muzzle and `this._d` the direction; both
   * are already set by the caller.
   *
   * World geometry wins over the target — a round that clips the corner the
   * shooter is peeking around hits the corner — because the trace uses
   * `MASK_BULLET`, the same collider set the player's rounds use.
   */
  private resolveBotShot(b: Bot, target: THREE.Vector3, dist: number, targetIsPlayer: boolean): void {
    const physics = this.services.physics;
    const maxRange = Math.max(40, b.range * 2.2);

    // Target capsule. The player's `position` is his capsule centre; a bot's is
    // his feet, so each gets its own base.
    const height = targetIsPlayer ? PLAYER_BODY.height : 1.8;
    const radius = targetIsPlayer ? PLAYER_BODY.radius : 0.4;
    const base = targetIsPlayer ? target.y - height * 0.5 : target.y;
    _capA.set(target.x, base + radius, target.z);
    _capB.set(target.x, base + height - radius, target.z);
    const capT = rayCapsule(this._a, this._d, _capA, _capB, radius);

    let worldDist = maxRange;
    let worldHit = false;
    if (physics?.ready) {
      const h = physics.raycast(this._a, this._d, maxRange, MASK_BULLET, this.ray, b.id);
      if (h.hit) { worldHit = true; worldDist = h.distance; }
    }

    const hitTarget = capT >= 0 && capT < worldDist + 0.05;
    if (!hitTarget) {
      if (worldHit) {
        bus.emit('bullet:impact', {
          point: this.ray.point.clone(), normal: this.ray.normal.clone(), surface: this.ray.surface,
          incoming: this._d.clone(), energy: 900, penetrated: false,
        });
        this.spawnTracer(this._a, this._d, this.ray.distance);
      } else {
        this.spawnTracer(this._a, this._d, Math.min(90, dist * 1.4));
      }
      return;
    }

    /* --- a hit. Which part of him, and how much does it cost -------------- */
    b.shotsHit++;
    this._c.copy(this._d).multiplyScalar(capT).add(this._a);
    const frac = THREE.MathUtils.clamp((this._c.y - base) / Math.max(0.4, height), 0, 1);
    const zone: keyof typeof FIRE.zone = frac > 0.88 ? 'head'
      : frac > 0.72 ? 'neck'
        : frac > 0.48 ? 'chest'
          : frac > 0.34 ? 'stomach' : 'leg';
    // Linear falloff past the archetype's comfortable range, floored so a long
    // shot still stings.
    const over = Math.max(0, dist - b.range);
    const falloff = THREE.MathUtils.clamp(
      1 - (over / Math.max(1, b.range)) * (1 - FIRE.falloffFloor), FIRE.falloffFloor, 1,
    );
    const dmg = b.damage * FIRE.zone[zone] * falloff;

    this.spawnTracer(this._a, this._d, capT);
    if (targetIsPlayer) {
      bus.emit('bullet:impact', {
        point: this._c.clone(), normal: this._d.clone().negate(),
        surface: zone === 'head' ? 'helmet' : 'flesh',
        incoming: this._d.clone(), energy: dmg * 22, penetrated: false,
      });
      bus.emit('damage:taken', {
        amount: dmg,
        fromDirection: this._c.copy(this._d).negate().clone(),
        sourceId: b.id, lethal: false,
      });
      return;
    }
    const victim = this.nearest(target, b.team === 'hostile' ? 'friendly' : 'hostile', 2.5);
    if (victim >= 0) {
      this.damageCombatant(victim, dmg, {
        headshot: zone === 'head', point: this._c, direction: this._d,
        fromPlayer: false, source: 'ai',
      });
    }
  }

  /* ------------------------------------------------------------- damage -- */

  private hurt(b: Bot, amount: number, opts: DamageOpts): boolean {
    const zone = (opts.zone && opts.zone !== 'none')
      ? opts.zone
      : (opts.headshot ? 'head' : 'chest');
    // Per-zone armour multi from the archetype table (plate/breacher/jug suit).
    const armorTable = ARCHETYPES[b.archetype]?.armor;
    const armorMul = armorTable ? (armorTable[zone as keyof typeof armorTable] ?? 1) : 1;
    const applied = amount * armorMul;
    b.health -= applied;
    const killed = b.health <= 0;
    const point = opts.point ?? this._a.copy(b.position).setY(b.position.y + 1.2);
    const armored = zoneHasArmor(b.archetype, zone);
    bus.emit('damage:dealt', {
      targetId: b.id, amount: applied, headshot: !!opts.headshot || zone === 'head' || zone === 'neck', killed,
      point: point.clone(), fromPlayer: opts.fromPlayer !== false,
    });
    if (!killed && b.char && opts.direction) {
      b.char.react(opts.direction, zone as 'head' | 'chest', Math.min(1, applied / 60));
    }
    if (opts.fromPlayer !== false) {
      bus.emit('hud:hitmarker', {
        headshot: !!opts.headshot || zone === 'head' || zone === 'neck',
        killed,
        armor: armored,
      });
    }
    if (killed) {
      b.alive = false;
      b.state = 'dead';
      b.deathTime = 0;
      if (b.char) {
        // Clip-then-ragdoll: play a directional death, stash impulse for host.onDeath.
        this._b.copy(opts.direction ?? this._up).normalize().multiplyScalar(Math.min(48, 8 + applied * 0.55));
        this._b.y += 1.5;
        const clip = pickDeathClip(b.yaw, opts.direction, !!opts.headshot || zone === 'head');
        const hitZone = (zone === 'head' || zone === 'neck') ? 'head' : 'chest';
        b.char.object.userData.pendingDeathImpulse = this._b.clone();
        b.char.object.userData.pendingDeathZone = hitZone;
        try {
          b.char.play(clip, { fade: 0.05 });
        } catch {
          try { b.char.ragdoll(this._b, hitZone); }
          catch { /* no presentation path available */ }
        }
      }
      bus.emit('entity:death', {
        id: b.id, byPlayer: opts.fromPlayer !== false, headshot: !!opts.headshot || zone === 'head',
        name: b.archetype, point: b.position.clone(),
      });
    }
    return killed;
  }

  /**
   * Resolves one of the player's rounds against the bot capsules. Analytic
   * ray/capsule rather than physics colliders — the fallback owns no bodies.
   *
   * Prices through the same combat model the AI path uses (`resolveHit`):
   * weapon catalogue base damage, range falloff, and multi-zone multipliers.
   * The previous flat 42 body / 145 head made every weapon a three-shot kill.
   */
  private resolvePlayerShot(origin: THREE.Vector3, direction: THREE.Vector3, weaponId?: string): void {
    let bestBot: Bot | null = null;
    let bestT = Infinity;

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
    }

    if (!bestBot) return;
    this._c.copy(direction).multiplyScalar(bestT).add(origin);
    // Multi-zone from impact height / lateral offset (HITBOX_RIG bands).
    const frac = THREE.MathUtils.clamp(
      (this._c.y - bestBot.position.y) / Math.max(0.4, bestBot.height), 0, 1,
    );
    const lateral = Math.hypot(this._c.x - bestBot.position.x, this._c.z - bestBot.position.z);
    let zoneFinal: HitZone;
    if (frac > 0.87) zoneFinal = 'head';
    else if (frac > 0.81) zoneFinal = 'neck';
    else if (frac >= 0.48 && frac <= 0.82 && lateral > bestBot.radius * 0.55) zoneFinal = 'arm';
    else if (frac > 0.555) zoneFinal = 'chest';
    else if (frac > 0.40) zoneFinal = 'stomach';
    else zoneFinal = 'leg';
    const metres = bestT;
    const wid = weaponId && weaponId.length > 0 ? weaponId : 'ar_vkr7';
    // resolveHit already folds zone multi; hurt() multiplies armour again, so
    // strip armour here (pass null) and let hurt apply ARCHETYPES plating.
    const priced = resolveHit(wid, metres, zoneFinal, null);
    const dmg = priced.damage;
    const armored = zoneHasArmor(bestBot.archetype, zoneFinal);
    bus.emit('bullet:impact', {
      point: this._c.clone(), normal: this._d.copy(direction).negate().clone(),
      surface: armored
        ? (zoneFinal === 'head' || zoneFinal === 'neck' ? 'helmet' : 'armor')
        : 'flesh',
      incoming: direction.clone(), energy: dmg * 40, penetrated: false,
    });
    this.hurt(bestBot, dmg, {
      headshot: priced.headshot, point: this._c, direction, fromPlayer: true,
      source: 'player', zone: zoneFinal, weaponId: wid, distance: metres,
    });
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
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
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
