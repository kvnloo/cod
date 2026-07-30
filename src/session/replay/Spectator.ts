/**
 * Spectating.
 *
 * Three cameras — free, first-person follow and over-the-shoulder — plus the
 * part that actually matters in a competitive shooter: **who you are allowed to
 * watch**. Getting that wrong is a wallhack. The rules here are the ones a
 * shipped shooter uses:
 *
 *   • While you are dead and the match is still live you may watch your own
 *     team, and nobody else. Watching an enemy would hand you their sightlines
 *     while your team is still fighting.
 *   • During your killcam you are locked to your killer and cannot cycle. That
 *     is a presentation beat, not a camera.
 *   • Free camera is off during a live match for a participant. It is on for a
 *     dedicated observer, in theater, and after the match has ended.
 *   • You cannot follow a dead player while the round is live; the cycle skips
 *     them. In theater everything is allowed because nothing is at stake.
 *
 * `SpectatorController` never decides these itself — it takes a `SpectatorRules`
 * from the caller (which the host owns) and enforces it. That keeps the policy
 * in one place and makes it something the netcode layer can hand down.
 */

import { CameraSolver, FreeCamera, forwardFrom, lerp, type FreeCamInput } from './CameraSolver';
import { ACTOR, type ActorSample, type CameraPose, actorSample, cameraPose } from './types';

export type SpectatorMode = 'off' | 'killcam' | 'first' | 'third' | 'free';

export interface SpectatorTarget {
  id: number;
  team: number;
  alive: boolean;
  name: string;
}

export interface SpectatorRules {
  allowFree: boolean;
  allowEnemyTeam: boolean;
  allowFirstPerson: boolean;
  allowThirdPerson: boolean;
  /** Hard lock to one actor (killcam). -1 for none. */
  lockTo: number;
  /** Dead targets are skipped when true. */
  requireAlive: boolean;
}

export interface SpectatorContext {
  /** True once the match result is decided; everything opens up. */
  matchOver: boolean;
  /** False while the viewer is dead / downed. */
  viewerAlive: boolean;
  viewerTeam: number;
  /** The viewer is a non-participating observer or is in theater. */
  observer: boolean;
  /** Killcam currently playing — locks the camera to the killer. */
  killcamActive: boolean;
  killer: number;
}

export function spectatorRules(ctx: SpectatorContext): SpectatorRules {
  if (ctx.killcamActive) {
    return {
      allowFree: false, allowEnemyTeam: true, allowFirstPerson: true,
      allowThirdPerson: false, lockTo: ctx.killer, requireAlive: false,
    };
  }
  if (ctx.observer || ctx.matchOver) {
    return {
      allowFree: true, allowEnemyTeam: true, allowFirstPerson: true,
      allowThirdPerson: true, lockTo: -1, requireAlive: false,
    };
  }
  // A live participant who is dead: own team only, living players only, no
  // free camera.
  return {
    allowFree: false, allowEnemyTeam: false, allowFirstPerson: true,
    allowThirdPerson: true, lockTo: -1, requireAlive: true,
  };
}

/** Where actor state comes from — live sim, or a replay's snapshot track. */
export interface ActorSource {
  actorAt(id: number, out: ActorSample): boolean;
  list(out: SpectatorTarget[]): number;
}

export interface SpectatorTuning {
  eyeHeight: number;
  /** Over-the-shoulder boom. */
  boomDistance: number;
  boomHeight: number;
  boomSide: number;
  fovFirst: number;
  fovThird: number;
  fovFree: number;
  /** Look sensitivity for the free camera, radians per input unit. */
  lookScale: number;
}

export function defaultSpectatorTuning(): SpectatorTuning {
  return {
    eyeHeight: 1.62,
    boomDistance: 3.1,
    boomHeight: 0.62,
    boomSide: 0.62,
    fovFirst: 80,
    fovThird: 72,
    fovFree: 85,
    lookScale: 0.0022,
  };
}

export class SpectatorController {
  mode: SpectatorMode = 'off';
  rules: SpectatorRules = spectatorRules({
    matchOver: false, viewerAlive: true, viewerTeam: 0,
    observer: false, killcamActive: false, killer: -1,
  });
  tuning: SpectatorTuning = defaultSpectatorTuning();
  viewerTeam = 0;

  /** Actor currently followed, or -1. */
  target = -1;
  readonly pose: CameraPose = cameraPose();
  readonly free = new FreeCamera();
  readonly solver = new CameraSolver();
  /** Set when a cycle request was refused, so the HUD can say why. */
  lastRefusal = '';

  private targets: SpectatorTarget[] = [];
  private sample = actorSample();
  private desired: CameraPose = cameraPose();
  private readonly _f = { x: 0, y: 0, z: 0 };

  /* ---------------------------------------------------------------- state -- */

  setRules(r: SpectatorRules): void {
    this.rules = r;
    if (r.lockTo >= 0) {
      this.target = r.lockTo;
      if (this.mode !== 'killcam') this.mode = 'killcam';
    } else if (this.mode === 'free' && !r.allowFree) {
      this.mode = this.rules.allowThirdPerson ? 'third' : 'first';
    }
    if (this.target >= 0 && !this.canSpectate(this.target)) {
      this.cycle(1);
    }
  }

  setTargets(list: readonly SpectatorTarget[]): void {
    this.targets.length = 0;
    for (const t of list) this.targets.push(t);
  }

  refreshTargets(src: ActorSource): void {
    const n = src.list(this.targets);
    this.targets.length = n;
  }

  get targetList(): readonly SpectatorTarget[] { return this.targets; }

  canSpectate(id: number): boolean {
    if (this.rules.lockTo >= 0) return id === this.rules.lockTo;
    const t = this.targets.find((x) => x.id === id);
    if (!t) return false;
    if (this.rules.requireAlive && !t.alive) return false;
    if (!this.rules.allowEnemyTeam && t.team !== this.viewerTeam) return false;
    return true;
  }

  /** Steps to the next permitted target. Returns the new target or -1. */
  cycle(dir: 1 | -1): number {
    this.lastRefusal = '';
    if (this.rules.lockTo >= 0) {
      this.lastRefusal = 'locked to killcam';
      this.target = this.rules.lockTo;
      return this.target;
    }
    const n = this.targets.length;
    if (n === 0) { this.target = -1; this.lastRefusal = 'no targets'; return -1; }
    let idx = this.targets.findIndex((t) => t.id === this.target);
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    for (let i = 0; i < n; i++) {
      idx = (idx + dir + n) % n;
      const cand = this.targets[idx];
      if (this.canSpectate(cand.id)) {
        if (this.target !== cand.id) this.solver.reset();
        this.target = cand.id;
        if (this.mode === 'off' || this.mode === 'free') {
          this.mode = this.rules.allowFirstPerson ? 'first' : 'third';
        }
        return this.target;
      }
    }
    this.target = -1;
    this.lastRefusal = this.rules.allowEnemyTeam ? 'no living targets' : 'no living teammates';
    return -1;
  }

  select(id: number): boolean {
    if (!this.canSpectate(id)) {
      this.lastRefusal = `actor ${id} is not spectatable`;
      return false;
    }
    if (this.target !== id) this.solver.reset();
    this.target = id;
    return true;
  }

  /** Cycles first → third → free (when allowed) → first. */
  cycleMode(): SpectatorMode {
    const order: SpectatorMode[] = ['first', 'third', 'free'];
    const allowed = order.filter((m) => (
      m === 'first' ? this.rules.allowFirstPerson
        : m === 'third' ? this.rules.allowThirdPerson
          : this.rules.allowFree));
    if (allowed.length === 0) { this.mode = 'off'; return this.mode; }
    const i = allowed.indexOf(this.mode);
    this.mode = allowed[(i + 1) % allowed.length];
    if (this.mode === 'free') this.free.placeAt(this.pose);
    else this.solver.reset();
    return this.mode;
  }

  enterFree(): boolean {
    if (!this.rules.allowFree) { this.lastRefusal = 'free camera not permitted'; return false; }
    this.free.placeAt(this.pose);
    this.mode = 'free';
    return true;
  }

  stop(): void { this.mode = 'off'; this.target = -1; this.solver.reset(); }

  /* --------------------------------------------------------------- update -- */

  /**
   * Produces the spectator pose. `input` is only consulted in free mode.
   * Returns false when there is nothing to show (caller keeps its own camera).
   */
  update(dt: number, src: ActorSource, input: FreeCamInput | null): boolean {
    if (this.mode === 'off') return false;

    if (this.mode === 'free') {
      if (input) {
        const scaled: FreeCamInput = {
          moveX: input.moveX, moveY: input.moveY, moveUp: input.moveUp,
          lookYaw: input.lookYaw * this.tuning.lookScale,
          lookPitch: input.lookPitch * this.tuning.lookScale,
          boost: input.boost, precise: input.precise,
        };
        this.free.step(scaled, dt);
      }
      this.free.pose.fov = this.tuning.fovFree;
      copyPose(this.free.pose, this.pose);
      return true;
    }

    if (this.target < 0) return false;
    if (!src.actorAt(this.target, this.sample)) return false;

    const t = this.tuning;
    const d = this.desired;
    const eyeY = this.sample.y + t.eyeHeight;

    if (this.mode === 'first' || this.mode === 'killcam') {
      d.x = this.sample.x; d.y = eyeY; d.z = this.sample.z;
      d.yaw = this.sample.yaw; d.pitch = this.sample.pitch;
      d.fov = t.fovFirst;
      // A dead target has no useful look direction; ease the pitch level so the
      // camera does not stare at the sky when the body ragdolls.
      if ((this.sample.flags & ACTOR.alive) === 0) d.pitch = lerp(d.pitch, -0.12, 0.6);
    } else {
      forwardFrom(this.sample.yaw, 0, this._f);
      d.x = this.sample.x - this._f.x * t.boomDistance + Math.cos(this.sample.yaw) * t.boomSide;
      d.y = eyeY + t.boomHeight;
      d.z = this.sample.z - this._f.z * t.boomDistance - Math.sin(this.sample.yaw) * t.boomSide;
      d.yaw = this.sample.yaw;
      d.pitch = this.sample.pitch * 0.55 - 0.05;
      d.fov = t.fovThird;
    }
    d.roll = 0;

    this.solver.step(d, dt);
    copyPose(this.solver.pose, this.pose);
    return true;
  }
}

function copyPose(src: CameraPose, dst: CameraPose): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll; dst.fov = src.fov;
}

/** Anything that can be sampled at a continuous time — i.e. `SnapshotPlayback`. */
export interface TimedActorSource {
  actorAt(id: number, t: number, out: ActorSample): boolean;
  actorsAt(t: number, out: ActorSample[]): number;
}

/** Adapts a `SnapshotPlayback` at a fixed time into an `ActorSource`. */
export class SnapshotActorSource implements ActorSource {
  time = 0;
  names = new Map<number, string>();
  private buf: ActorSample[] = [];

  constructor(private playback: TimedActorSource) { }

  setPlayback(p: TimedActorSource): void { this.playback = p; }

  actorAt(id: number, out: ActorSample): boolean {
    return this.playback.actorAt(id, this.time, out);
  }

  list(out: SpectatorTarget[]): number {
    const n = this.playback.actorsAt(this.time, this.buf);
    for (let i = 0; i < n; i++) {
      const a = this.buf[i];
      while (out.length <= i) out.push({ id: -1, team: 0, alive: false, name: '' });
      out[i].id = a.id;
      out[i].team = a.team;
      out[i].alive = (a.flags & ACTOR.alive) !== 0;
      out[i].name = this.names.get(a.id) ?? `Actor ${a.id}`;
    }
    return n;
  }
}
