/**
 * Objective state machines.
 *
 * Every objective is a tiny explicit FSM (`pending → active → complete|failed`)
 * that owns its own world marker and publishes itself on the bus. Modes compose
 * them; nothing else in the game layer knows what a "bomb site" is.
 */

import * as THREE from 'three';
import type { Emitter } from './Services';
import { BeaconMarker, ZoneMarker } from './Markers';
import type { ObjectiveKind, ObjectiveState, ObjectiveView } from './types';

/** The slice of the match an objective is allowed to see. */
export interface ObjectiveWorld {
  emit: Emitter;
  /** Player eye/feet position, or null when dead/absent. */
  playerPosition: THREE.Vector3 | null;
  playerAlive: boolean;
  /** True while the interact key is held. */
  playerInteracting: boolean;
  /** Live hostiles inside a sphere — drives contest logic. */
  hostilesWithin(center: THREE.Vector3, radius: number): number;
  addMarker(object: THREE.Object3D): void;
  now: number;
}

const COLOR_ACTIVE = 0x5fb8ff;
const COLOR_CONTESTED = 0xff9a3c;
const COLOR_DANGER = 0xff4a3a;
const COLOR_DONE = 0x66ff9e;

let nextObjectiveId = 1;

export abstract class Objective {
  readonly id: string;
  abstract readonly kind: ObjectiveKind;
  label = 'OBJECTIVE';
  hint = '';
  state: ObjectiveState = 'pending';
  progress = 0;
  /** Seconds remaining, or -1 when untimed. */
  timer = -1;
  position: THREE.Vector3 | null = null;
  radius = 0;
  contested = false;
  /** Score granted on completion. */
  score = 500;
  /** Set when failing this objective should end the match. */
  critical = false;

  protected marker: ZoneMarker | BeaconMarker | null = null;
  private _view: ObjectiveView = {
    id: '', kind: 'eliminate', state: 'pending', label: '', hint: '',
    progress: 0, timer: -1, position: null, radius: 0, contested: false,
  };
  private publishAccum = 0;
  private lastProgress = -1;

  constructor(id?: string) {
    this.id = id ?? `obj${nextObjectiveId++}`;
  }

  activate(w: ObjectiveWorld): void {
    if (this.state !== 'pending') return;
    this.state = 'active';
    this.onActivate(w);
    if (this.position) {
      if (this.radius >= 1.5) {
        const m = new ZoneMarker(this.radius, COLOR_ACTIVE);
        m.setPosition(this.position);
        this.marker = m;
        w.addMarker(m.group);
      } else {
        const m = new BeaconMarker(COLOR_ACTIVE);
        m.setPosition(this.position);
        this.marker = m;
        w.addMarker(m.group);
      }
    }
    w.emit('objective:added', this.view());
    w.emit('hud:banner', {
      title: this.label, subtitle: this.hint, kind: 'objective', ttl: 3.4,
    });
  }

  protected onActivate(_w: ObjectiveWorld): void { }

  /** Fixed-step advance. Implementations must be deterministic. */
  step(dt: number, w: ObjectiveWorld): void {
    if (this.state !== 'active') return;
    this.onStep(dt, w);
    this.updateMarker(dt);

    this.publishAccum += dt;
    if (this.publishAccum >= 0.2 || Math.abs(this.progress - this.lastProgress) > 0.08) {
      this.publishAccum = 0;
      this.lastProgress = this.progress;
      w.emit('objective:update', this.view());
    }
  }

  protected abstract onStep(dt: number, w: ObjectiveWorld): void;

  protected updateMarker(dt: number): void {
    const m = this.marker;
    if (!m) return;
    if (m instanceof ZoneMarker) {
      m.setProgress(this.progress);
      m.setColor(this.markerColor());
      m.update(dt, this.contested ? 1 : 0);
    } else {
      m.setColor(this.markerColor());
      m.update(dt);
    }
  }

  protected markerColor(): number {
    if (this.state === 'complete') return COLOR_DONE;
    if (this.state === 'failed') return COLOR_DANGER;
    if (this.timer >= 0 && this.timer < 10) return COLOR_DANGER;
    return this.contested ? COLOR_CONTESTED : COLOR_ACTIVE;
  }

  complete(w: ObjectiveWorld): void {
    if (this.state !== 'active') return;
    this.state = 'complete';
    this.progress = 1;
    this.contested = false;
    w.emit('objective:complete', { id: this.id, label: this.label, score: this.score });
    w.emit('objective:update', this.view());
    w.emit('hud:banner', { title: 'OBJECTIVE COMPLETE', subtitle: this.label, kind: 'reward', ttl: 3 });
    this.disposeMarker();
  }

  fail(w: ObjectiveWorld): void {
    if (this.state !== 'active') return;
    this.state = 'failed';
    this.contested = false;
    w.emit('objective:failed', { id: this.id, label: this.label });
    w.emit('objective:update', this.view());
    w.emit('hud:banner', { title: 'OBJECTIVE FAILED', subtitle: this.label, kind: 'alert', ttl: 3.4 });
    this.disposeMarker();
  }

  get done(): boolean { return this.state === 'complete' || this.state === 'failed'; }

  /**
   * Reused view object — `snapshot()` runs every frame, so this must not
   * allocate. Consumers read it, they do not retain it.
   */
  view(): ObjectiveView {
    const v = this._view;
    v.id = this.id;
    v.kind = this.kind;
    v.state = this.state;
    v.label = this.label;
    v.hint = this.hint;
    v.progress = this.progress;
    v.timer = this.timer;
    v.radius = this.radius;
    v.contested = this.contested;
    if (this.position) {
      if (!v.position) v.position = [0, 0, 0];
      v.position[0] = this.position.x;
      v.position[1] = this.position.y;
      v.position[2] = this.position.z;
    } else v.position = null;
    return v;
  }

  protected disposeMarker(): void {
    this.marker?.dispose();
    this.marker = null;
  }

  dispose(): void { this.disposeMarker(); }

  /* helpers shared by the zone-shaped objectives */
  protected playerInside(w: ObjectiveWorld): boolean {
    if (!this.position || !w.playerPosition || !w.playerAlive) return false;
    const dx = w.playerPosition.x - this.position.x;
    const dz = w.playerPosition.z - this.position.z;
    const dy = w.playerPosition.y - this.position.y;
    return dx * dx + dz * dz <= this.radius * this.radius && Math.abs(dy) < 6;
  }
}

/* --------------------------------------------------------------- kill N -- */

export class EliminateObjective extends Objective {
  readonly kind: ObjectiveKind = 'eliminate';
  private killed = 0;

  constructor(private target: number, label = 'ELIMINATE HOSTILES') {
    super();
    this.label = label;
    this.hint = `Neutralise ${target} enemy combatants`;
    this.score = 400;
  }

  notifyKill(): void {
    if (this.state !== 'active') return;
    this.killed++;
    this.progress = Math.min(1, this.killed / this.target);
  }

  get remaining(): number { return Math.max(0, this.target - this.killed); }

  protected onStep(_dt: number, w: ObjectiveWorld): void {
    this.hint = `${this.remaining} remaining`;
    if (this.killed >= this.target) this.complete(w);
  }
}

/* -------------------------------------------------------------- survive -- */

export class SurviveObjective extends Objective {
  readonly kind: ObjectiveKind = 'survive';

  constructor(private duration: number, label = 'HOLD OUT') {
    super();
    this.label = label;
    this.hint = 'Survive until extraction';
    this.timer = duration;
    this.score = 600;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    this.timer = Math.max(0, this.timer - dt);
    this.progress = 1 - this.timer / this.duration;
    if (this.timer <= 0) this.complete(w);
  }
}

/* ------------------------------------------------------------- hold zone -- */

/**
 * Classic hardpoint: progress accrues while the player stands in the ring and
 * halts (then bleeds) while hostiles contest it. The bleed is deliberately much
 * slower than the fill so losing a zone is recoverable.
 */
export class HoldZoneObjective extends Objective {
  readonly kind: ObjectiveKind = 'hold';

  constructor(center: THREE.Vector3, radius: number, private duration: number, label = 'SECURE THE ZONE') {
    super();
    this.position = center.clone();
    this.radius = radius;
    this.label = label;
    this.hint = 'Hold the marked position';
    this.timer = duration;
    this.score = 750;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    const inside = this.playerInside(w);
    const hostiles = this.position ? w.hostilesWithin(this.position, this.radius + 1.5) : 0;
    this.contested = inside && hostiles > 0;

    if (inside && hostiles === 0) {
      this.progress = Math.min(1, this.progress + dt / this.duration);
    } else if (this.contested) {
      // Contested: frozen, with a slow bleed so camping a contested point is not free.
      this.progress = Math.max(0, this.progress - dt / (this.duration * 6));
    } else {
      this.progress = Math.max(0, this.progress - dt / (this.duration * 3.2));
    }

    this.timer = Math.max(0, (1 - this.progress) * this.duration);
    this.hint = inside
      ? (this.contested ? 'CONTESTED — clear the zone' : 'Capturing…')
      : 'Move to the marked position';

    if (this.progress >= 1) this.complete(w);
  }
}

/* ----------------------------------------------------------------- plant -- */

export class PlantObjective extends Objective {
  readonly kind: ObjectiveKind = 'plant';

  constructor(site: THREE.Vector3, radius: number, private plantTime = 5, label = 'PLANT THE CHARGE') {
    super();
    this.position = site.clone();
    this.radius = radius;
    this.label = label;
    this.hint = 'Hold [F] at the marked site';
    this.score = 700;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    const inside = this.playerInside(w);
    const planting = inside && w.playerInteracting;
    this.contested = inside && this.position !== null && w.hostilesWithin(this.position, this.radius + 2) > 0;

    if (planting) this.progress = Math.min(1, this.progress + dt / this.plantTime);
    else this.progress = Math.max(0, this.progress - dt / (this.plantTime * 1.6));

    this.hint = inside ? (planting ? 'Planting…' : 'Hold [F] to plant') : 'Move to the charge site';
    if (this.progress >= 1) this.complete(w);
  }
}

/* ---------------------------------------------------------------- defuse -- */

/**
 * A live charge with a fuse. The player must reach it and hold the interact key
 * long enough; if the fuse runs out first the objective fails, and modes mark it
 * `critical` when that should lose the match.
 */
export class DefuseObjective extends Objective {
  readonly kind: ObjectiveKind = 'defuse';
  private defused = 0;

  constructor(
    site: THREE.Vector3, radius: number,
    private fuse = 60, private defuseTime = 7,
    label = 'DEFUSE THE CHARGE',
  ) {
    super();
    this.position = site.clone();
    this.radius = radius;
    this.label = label;
    this.hint = 'Reach the charge and hold [F]';
    this.timer = fuse;
    this.score = 900;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    this.timer = Math.max(0, this.timer - dt);
    const inside = this.playerInside(w);
    const working = inside && w.playerInteracting;
    this.contested = inside && this.position !== null && w.hostilesWithin(this.position, this.radius + 2) > 0;

    if (working) this.defused = Math.min(this.defuseTime, this.defused + dt);
    else this.defused = Math.max(0, this.defused - dt * 1.8);
    this.progress = this.defused / this.defuseTime;

    this.hint = inside
      ? (working ? 'Defusing…' : 'Hold [F] to defuse')
      : `Charge armed — ${Math.ceil(this.timer)}s`;

    if (this.defused >= this.defuseTime) { this.complete(w); return; }
    if (this.timer <= 0) this.fail(w);
  }

  /** Fuse time left, for the HUD countdown. */
  get fuseRemaining(): number { return this.timer; }
  get fuseTotal(): number { return this.fuse; }
}

/* --------------------------------------------------------------- extract -- */

/**
 * Reach the LZ and hold it until the bird lands. Hostiles inside the ring stall
 * the countdown, which turns extraction into a last stand rather than a walk.
 */
export class ExtractObjective extends Objective {
  readonly kind: ObjectiveKind = 'extract';

  constructor(zone: THREE.Vector3, radius: number, private duration = 25, label = 'EXFIL') {
    super();
    this.position = zone.clone();
    this.radius = radius;
    this.label = label;
    this.hint = 'Reach the extraction zone';
    this.timer = duration;
    this.score = 1200;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    const inside = this.playerInside(w);
    const hostiles = this.position ? w.hostilesWithin(this.position, this.radius + 4) : 0;
    this.contested = inside && hostiles > 0;

    if (inside && !this.contested) this.timer = Math.max(0, this.timer - dt);
    else if (inside) this.timer = Math.min(this.duration, this.timer + dt * 0.25);

    this.progress = 1 - this.timer / this.duration;
    this.hint = inside
      ? (this.contested ? 'LZ HOT — clear the zone' : `Exfil in ${Math.ceil(this.timer)}s`)
      : 'Move to the extraction zone';

    if (this.timer <= 0 && inside) this.complete(w);
  }
}

/* ----------------------------------------------------------------- reach -- */

export class ReachObjective extends Objective {
  readonly kind: ObjectiveKind = 'reach';

  constructor(point: THREE.Vector3, radius = 4.5, label = 'ADVANCE', hint = 'Move to the waypoint') {
    super();
    this.position = point.clone();
    this.radius = radius;
    this.label = label;
    this.hint = hint;
    this.score = 250;
  }

  protected onStep(_dt: number, w: ObjectiveWorld): void {
    if (!this.position || !w.playerPosition) return;
    const d = Math.hypot(
      w.playerPosition.x - this.position.x,
      w.playerPosition.z - this.position.z,
    );
    this.progress = THREE.MathUtils.clamp(1 - (d - this.radius) / 40, 0, 1);
    if (d <= this.radius) this.complete(w);
  }
}

/* --------------------------------------------------------------- destroy -- */

export class DestroyObjective extends Objective {
  readonly kind: ObjectiveKind = 'destroy';
  private destroyed = 0;

  constructor(private targets: number, point: THREE.Vector3 | null, label = 'DESTROY THE CACHE') {
    super();
    if (point) { this.position = point.clone(); this.radius = 3.2; }
    this.label = label;
    this.hint = `${targets} targets remaining`;
    this.score = 650;
  }

  notifyDestroyed(): void {
    if (this.state !== 'active') return;
    this.destroyed++;
    this.progress = Math.min(1, this.destroyed / this.targets);
  }

  protected onStep(_dt: number, w: ObjectiveWorld): void {
    this.hint = `${Math.max(0, this.targets - this.destroyed)} targets remaining`;
    if (this.destroyed >= this.targets) this.complete(w);
  }
}
