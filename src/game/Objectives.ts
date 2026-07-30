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
import type { ObjectiveKind, ObjectiveState, ObjectiveView, Team } from './types';

/** Bodies of each team inside a probed volume. */
export interface TeamPresence {
  friendly: number;
  hostile: number;
}

/**
 * Counts live bodies of each team inside a sphere, player included.
 *
 * Objectives cannot enumerate combatants themselves — only the active mode
 * knows which entity id sits on which team — so the mode installs this probe on
 * the `ObjectiveWorld`. Team objectives fall back to
 * `hostilesWithin` + the player when it is absent, which keeps every existing
 * single-player objective working unchanged.
 */
export type PresenceProbe = (
  center: THREE.Vector3, radius: number, out: TeamPresence,
) => void;

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
  /** Installed by team modes; see `PresenceProbe`. */
  presence?: PresenceProbe;
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
  /**
   * Suppresses the activation banner. Persistent team objectives (three
   * domination flags, a hardpoint rotation) would otherwise stack banners on
   * top of the mode's own round announcement.
   */
  silent = false;

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
    if (!this.silent) {
      w.emit('hud:banner', {
        title: this.label, subtitle: this.hint, kind: 'objective', ttl: 3.4,
      });
    }
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

/* ================================================================ team ==== */
/*
 * Replicable team objectives.
 *
 * Everything below is authority-aware from the first line. The host runs
 * `step()` and mutates state; a client sets `authority = false`, never mutates,
 * and takes whole states through `applyReplicated()`. `replicate()` returns a
 * compact numeric payload rather than an object graph so the netcode layer can
 * delta-encode it without knowing what a "hardpoint" is.
 *
 * INTERFACE OWED BY src/net (does not exist yet — code against it, do not
 * block): the host should call `replicate()` on every entity it owns once per
 * snapshot and hand `NetObjectiveState` to the writer; the client should call
 * `applyReplicated()` on receipt. Nothing here imports src/net.
 */

export type ZoneOwner = Team | 'neutral';
export type NetObjectiveKind = 'zone' | 'hardpoint' | 'bomb' | 'tag';

/** Wire form of one objective entity. `v` is documented per entity. */
export interface NetObjectiveState {
  netId: number;
  kind: NetObjectiveKind;
  v: number[];
}

export interface ReplicatedEntity {
  readonly netId: number;
  readonly netKind: NetObjectiveKind;
  /** False on clients: `step()` becomes display-only. */
  authority: boolean;
  replicate(out?: NetObjectiveState): NetObjectiveState;
  applyReplicated(s: NetObjectiveState): void;
}

let nextNetId = 1;
/**
 * Net ids are assigned in creation order, which is fixed for a given mode and
 * seed — so resetting the counter at the head of every match makes them
 * reproducible, which is what replay hashing and snapshot delta-encoding both
 * need. `MatchRunner.start` owns the call; one match runs at a time.
 */
export function resetNetIds(): void { nextNetId = 1; }

const OWNERS: readonly ZoneOwner[] = ['neutral', 'friendly', 'hostile'];
function ownerIndex(o: ZoneOwner): number { return OWNERS.indexOf(o); }
function ownerOf(i: number): ZoneOwner { return OWNERS[i] ?? 'neutral'; }

const COLOR_FRIENDLY = 0x4fd2ff;
const COLOR_HOSTILE = 0xff5b4a;
const COLOR_NEUTRAL = 0xdcdcdc;

function teamColor(o: ZoneOwner): number {
  return o === 'friendly' ? COLOR_FRIENDLY : o === 'hostile' ? COLOR_HOSTILE : COLOR_NEUTRAL;
}

/** Shared base: presence probing with a single-player fallback. */
abstract class TeamObjective extends Objective implements ReplicatedEntity {
  readonly netId = nextNetId++;
  abstract readonly netKind: NetObjectiveKind;
  authority = true;

  protected pres: TeamPresence = { friendly: 0, hostile: 0 };
  private _net: NetObjectiveState = { netId: 0, kind: 'zone', v: [] };

  protected probe(w: ObjectiveWorld, radius = this.radius): TeamPresence {
    const p = this.pres;
    p.friendly = 0;
    p.hostile = 0;
    if (!this.position) return p;
    if (w.presence) {
      w.presence(this.position, radius, p);
      return p;
    }
    p.hostile = w.hostilesWithin(this.position, radius);
    if (w.playerAlive && w.playerPosition) {
      const dx = w.playerPosition.x - this.position.x;
      const dz = w.playerPosition.z - this.position.z;
      if (dx * dx + dz * dz <= radius * radius) p.friendly = 1;
    }
    return p;
  }

  protected netOut(v: number[], out?: NetObjectiveState): NetObjectiveState {
    const s = out ?? this._net;
    s.netId = this.netId;
    s.kind = this.netKind;
    s.v = v;
    return s;
  }

  abstract replicate(out?: NetObjectiveState): NetObjectiveState;
  abstract applyReplicated(s: NetObjectiveState): void;

  protected override markerColor(): number { return teamColor(this.ownerForColor()); }
  protected ownerForColor(): ZoneOwner { return 'neutral'; }
}

/* ----------------------------------------------------------- capture zone -- */

/**
 * A domination flag.
 *
 * One bar in [0..1] owned by `capturingTeam`. Standing on an enemy flag first
 * drives the bar back to zero (neutralise) and then up again (capture), which
 * is why a contested flip costs about twice a neutral one. Extra bodies speed
 * the bar up with diminishing returns; both teams present freezes it.
 */
export class CaptureZoneObjective extends TeamObjective {
  readonly kind: ObjectiveKind = 'hold';
  readonly netKind: NetObjectiveKind = 'zone';

  owner: ZoneOwner = 'neutral';
  /** 0..1 toward `capturingTeam` taking the flag. */
  capture = 0;
  capturingTeam: Team | null = null;
  /** Letter shown on the HUD — A/B/C. */
  readonly letter: string;
  readonly index: number;

  /** Fires host-side whenever the flag changes hands. */
  onCaptured: ((zone: CaptureZoneObjective, by: Team, from: ZoneOwner) => void) | null = null;

  constructor(index: number, center: THREE.Vector3, radius: number, private captureTime = 8) {
    super(`zone${index}`);
    this.index = index;
    this.letter = String.fromCharCode(65 + index);
    this.position = center.clone();
    this.radius = radius;
    this.label = `FLAG ${this.letter}`;
    this.hint = 'Capture and hold';
    this.silent = true;
    this.score = 0;
  }

  /** Bodies of `team` speed capture up: 1x, 1.5x, 1.83x… */
  private rate(n: number): number {
    let mul = 0;
    for (let i = 1; i <= n; i++) mul += 1 / i;
    return mul / this.captureTime;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    const p = this.probe(w);
    const both = p.friendly > 0 && p.hostile > 0;
    this.contested = both || (this.capture > 0 && this.capture < 1);

    if (!this.authority) { this.updateHud(); return; }

    if (both || (p.friendly === 0 && p.hostile === 0)) {
      // Nobody, or a standoff: bleed the bar back so a half-cap does not bank.
      if (this.capturingTeam) {
        this.capture = Math.max(0, this.capture - dt * (both ? 0 : 0.35 / this.captureTime));
        if (this.capture <= 0) this.capturingTeam = null;
      }
      this.updateHud();
      return;
    }

    const team: Team = p.friendly > 0 ? 'friendly' : 'hostile';
    const n = team === 'friendly' ? p.friendly : p.hostile;
    if (this.owner === team) {
      // Already ours — reset any partial enemy progress.
      this.capture = 0;
      this.capturingTeam = null;
      this.updateHud();
      return;
    }
    if (this.capturingTeam !== team) { this.capturingTeam = team; this.capture = 0; }
    this.capture = Math.min(1, this.capture + dt * this.rate(n));
    if (this.capture >= 1) {
      const from = this.owner;
      this.owner = team;
      this.capture = 0;
      this.capturingTeam = null;
      this.onCaptured?.(this, team, from);
      w.emit('objective:update', this.view());
    }
    this.updateHud();
  }

  private updateHud(): void {
    this.progress = this.capturingTeam ? this.capture : (this.owner === 'neutral' ? 0 : 1);
    this.hint = this.owner === 'neutral' ? 'NEUTRAL'
      : this.owner === 'friendly' ? 'HELD' : 'ENEMY HELD';
  }

  /** `v` = [ownerIndex, capture×1000, capturingTeam(0 none/1 friendly/2 hostile)]. */
  replicate(out?: NetObjectiveState): NetObjectiveState {
    return this.netOut([
      ownerIndex(this.owner),
      Math.round(this.capture * 1000),
      this.capturingTeam === 'friendly' ? 1 : this.capturingTeam === 'hostile' ? 2 : 0,
    ], out);
  }

  applyReplicated(s: NetObjectiveState): void {
    this.owner = ownerOf(s.v[0] ?? 0);
    this.capture = (s.v[1] ?? 0) / 1000;
    this.capturingTeam = s.v[2] === 1 ? 'friendly' : s.v[2] === 2 ? 'hostile' : null;
    this.updateHud();
  }

  protected override ownerForColor(): ZoneOwner {
    return this.capturingTeam && this.capture > 0 ? 'neutral' : this.owner;
  }
}

/* ------------------------------------------------------------- hardpoint -- */

/**
 * The rotating hill. One objective entity owns the whole rotation so the HUD
 * and the netcode see a single stable id whose position moves, rather than a
 * churn of create/destroy every sixty seconds.
 */
export class HardpointObjective extends TeamObjective {
  readonly kind: ObjectiveKind = 'hold';
  readonly netKind: NetObjectiveKind = 'hardpoint';

  owner: ZoneOwner = 'neutral';
  /** Index into `points`. */
  hill = 0;
  /** Seconds until the hill moves. */
  nextIn: number;
  /** True while both teams stand on it — nobody scores. */
  locked = false;

  onRotate: ((h: HardpointObjective) => void) | null = null;

  constructor(
    private points: readonly THREE.Vector3[],
    radius: number,
    private rotateEvery = 60,
    private firstDelay = rotateEvery,
  ) {
    super('hardpoint');
    this.position = points[0].clone();
    this.radius = radius;
    this.nextIn = firstDelay;
    this.label = 'HARDPOINT';
    this.hint = 'Hold the zone';
    this.silent = true;
    this.score = 0;
  }

  get hillCount(): number { return this.points.length; }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    const p = this.probe(w);
    this.locked = p.friendly > 0 && p.hostile > 0;
    this.contested = this.locked;

    if (!this.authority) { this.refresh(); return; }

    if (this.locked) this.owner = this.owner;                    // frozen
    else if (p.friendly > 0) this.owner = 'friendly';
    else if (p.hostile > 0) this.owner = 'hostile';

    this.nextIn -= dt;
    if (this.nextIn <= 0) this.rotate(w);
    this.refresh();
  }

  rotate(w: ObjectiveWorld): void {
    this.hill = (this.hill + 1) % this.points.length;
    this.nextIn = this.rotateEvery;
    this.owner = 'neutral';
    this.locked = false;
    this.position!.copy(this.points[this.hill]);
    this.marker?.setPosition(this.position!);
    this.onRotate?.(this);
    w.emit('objective:update', this.view());
    w.emit('hud:banner', {
      title: 'HARDPOINT MOVED', subtitle: `Zone ${String.fromCharCode(65 + this.hill)}`,
      kind: 'objective', ttl: 2.4,
    });
  }

  private refresh(): void {
    this.timer = Math.max(0, this.nextIn);
    this.progress = 1 - Math.max(0, Math.min(1, this.nextIn / this.rotateEvery));
    this.hint = this.locked ? 'CONTESTED'
      : this.owner === 'friendly' ? 'SECURED'
        : this.owner === 'hostile' ? 'ENEMY CONTROLLED' : 'UNCLAIMED';
  }

  /** `v` = [hill, ownerIndex, nextIn×100, locked]. */
  replicate(out?: NetObjectiveState): NetObjectiveState {
    return this.netOut([
      this.hill, ownerIndex(this.owner), Math.round(this.nextIn * 100), this.locked ? 1 : 0,
    ], out);
  }

  applyReplicated(s: NetObjectiveState): void {
    const hill = s.v[0] ?? 0;
    if (hill !== this.hill && this.points[hill]) {
      this.hill = hill;
      this.position!.copy(this.points[hill]);
      this.marker?.setPosition(this.position!);
    }
    this.owner = ownerOf(s.v[1] ?? 0);
    this.nextIn = (s.v[2] ?? 0) / 100;
    this.locked = s.v[3] === 1;
    this.refresh();
  }

  protected override ownerForColor(): ZoneOwner { return this.locked ? 'neutral' : this.owner; }
}

/* ------------------------------------------------------------- bomb site -- */

export type BombPhase = 'idle' | 'planting' | 'armed' | 'defusing' | 'detonated' | 'defused';

/**
 * A search-and-destroy site.
 *
 * Which team attacks is a per-round input, not a constant, because the sides
 * swap at halftime. Only the attackers can plant and only the defenders can
 * defuse; a defender standing on an un-armed site simply denies the plant.
 */
export class BombSiteObjective extends TeamObjective {
  /** Flips to `defuse` the moment the charge is live, so the HUD icon follows. */
  get kind(): ObjectiveKind {
    return this.phase === 'armed' || this.phase === 'defusing' || this.phase === 'detonated'
      ? 'defuse' : 'plant';
  }
  readonly netKind: NetObjectiveKind = 'bomb';

  phase: BombPhase = 'idle';
  /** 0..1 plant or defuse bar. */
  bar = 0;
  fuseLeft = 0;
  attackers: Team = 'friendly';
  readonly site: string;

  onPlanted: ((b: BombSiteObjective) => void) | null = null;
  onDefused: ((b: BombSiteObjective) => void) | null = null;
  onDetonated: ((b: BombSiteObjective) => void) | null = null;

  constructor(
    index: number, center: THREE.Vector3, radius: number,
    private plantTime = 5, private fuse = 45, private defuseTime = 7.5,
  ) {
    super(`bomb${index}`);
    this.site = String.fromCharCode(65 + index);
    this.position = center.clone();
    this.radius = radius;
    this.label = `SITE ${this.site}`;
    this.hint = 'Plant the charge';
    this.silent = true;
    this.score = 0;
  }

  /** Round reset — called by the mode, host side only. */
  arm(attackers: Team): void {
    this.attackers = attackers;
    this.phase = 'idle';
    this.bar = 0;
    this.fuseLeft = 0;
    this.contested = false;
    this.progress = 0;
    this.timer = -1;
    this.state = 'active';
  }

  private count(p: TeamPresence, t: Team): number {
    return t === 'friendly' ? p.friendly : p.hostile;
  }

  protected onStep(dt: number, w: ObjectiveWorld): void {
    if (this.phase === 'detonated' || this.phase === 'defused') return;
    const defenders: Team = this.attackers === 'friendly' ? 'hostile' : 'friendly';
    const p = this.probe(w);
    const att = this.count(p, this.attackers);
    const def = this.count(p, defenders);

    if (!this.authority) { this.refresh(); return; }

    if (this.phase === 'idle' || this.phase === 'planting') {
      this.contested = att > 0 && def > 0;
      if (att > 0 && def === 0) {
        this.phase = 'planting';
        this.bar = Math.min(1, this.bar + dt / this.plantTime);
        if (this.bar >= 1) {
          this.phase = 'armed';
          this.bar = 0;
          this.fuseLeft = this.fuse;
          this.onPlanted?.(this);
          w.emit('hud:banner', { title: 'BOMB PLANTED', subtitle: `Site ${this.site}`, kind: 'alert', ttl: 3 });
        }
      } else if (this.bar > 0) {
        this.bar = Math.max(0, this.bar - dt / this.plantTime);
        if (this.bar === 0) this.phase = 'idle';
      }
      this.refresh();
      return;
    }

    // Armed: the fuse runs no matter who is standing where.
    this.fuseLeft -= dt;
    this.contested = def > 0 && att > 0;
    if (def > 0 && att === 0) {
      this.phase = 'defusing';
      this.bar = Math.min(1, this.bar + dt / this.defuseTime);
      if (this.bar >= 1) {
        this.phase = 'defused';
        this.onDefused?.(this);
        w.emit('hud:banner', { title: 'BOMB DEFUSED', subtitle: `Site ${this.site}`, kind: 'reward', ttl: 3 });
        this.refresh();
        return;
      }
    } else if (this.bar > 0) {
      this.bar = Math.max(0, this.bar - dt / this.defuseTime);
      if (this.bar === 0) this.phase = 'armed';
    }
    if (this.fuseLeft <= 0) {
      this.fuseLeft = 0;
      this.phase = 'detonated';
      this.onDetonated?.(this);
      w.emit('hud:banner', { title: 'BOMB DETONATED', subtitle: `Site ${this.site}`, kind: 'alert', ttl: 3 });
    }
    this.refresh();
  }

  private refresh(): void {
    this.progress = this.bar;
    this.timer = this.phase === 'armed' || this.phase === 'defusing' ? this.fuseLeft : -1;
    this.hint = this.phase === 'armed' || this.phase === 'defusing'
      ? `Fuse ${this.fuseLeft.toFixed(0)}s`
      : this.phase === 'planting' ? 'Planting…' : 'Plant the charge';
  }

  /** `v` = [phaseIndex, bar×1000, fuseLeft×100, attackers(0 friendly/1 hostile)]. */
  replicate(out?: NetObjectiveState): NetObjectiveState {
    return this.netOut([
      BOMB_PHASES.indexOf(this.phase),
      Math.round(this.bar * 1000),
      Math.round(this.fuseLeft * 100),
      this.attackers === 'friendly' ? 0 : 1,
    ], out);
  }

  applyReplicated(s: NetObjectiveState): void {
    this.phase = BOMB_PHASES[s.v[0] ?? 0] ?? 'idle';
    this.bar = (s.v[1] ?? 0) / 1000;
    this.fuseLeft = (s.v[2] ?? 0) / 100;
    this.attackers = s.v[3] === 1 ? 'hostile' : 'friendly';
    this.refresh();
  }

  protected override ownerForColor(): ZoneOwner {
    return this.phase === 'armed' || this.phase === 'defusing' ? 'hostile' : 'neutral';
  }
}

const BOMB_PHASES: readonly BombPhase[] =
  ['idle', 'planting', 'armed', 'defusing', 'detonated', 'defused'];

/* ------------------------------------------------------------- dog tags -- */

export interface DogTag {
  netId: number;
  /** Team of the operator who died — a *friendly* tag is denied, not confirmed. */
  owner: Team;
  x: number;
  y: number;
  z: number;
  /** Seconds before it despawns. */
  ttl: number;
}

export type TagOutcome = 'confirm' | 'deny' | 'expire';

/**
 * The Kill Confirmed tag field.
 *
 * Not an `Objective` — there can be twenty of these on the floor at once and
 * the HUD wants one aggregate row, not twenty. It is still a first-class
 * replicable entity: `replicate()` emits every live tag as a flat number run.
 */
export class DogTagField implements ReplicatedEntity {
  readonly netId = nextNetId++;
  readonly netKind: NetObjectiveKind = 'tag';
  authority = true;

  readonly tags: DogTag[] = [];
  /** Host-side callback for every resolved tag. */
  onResolved: ((tag: DogTag, by: Team, outcome: TagOutcome) => void) | null = null;

  private _net: NetObjectiveState = { netId: 0, kind: 'tag', v: [] };
  private readonly _c = new THREE.Vector3();
  private pres: TeamPresence = { friendly: 0, hostile: 0 };

  constructor(private pickupRadius = 2.6, private lifetime = 30) { }

  clear(): void { this.tags.length = 0; }

  drop(owner: Team, x: number, y: number, z: number): DogTag {
    const tag: DogTag = { netId: nextNetId++, owner, x, y, z, ttl: this.lifetime };
    this.tags.push(tag);
    return tag;
  }

  /**
   * Host-side advance. Confirm beats deny when both teams reach a tag on the
   * same tick — the mode that dropped it wants the play rewarded.
   */
  step(dt: number, w: ObjectiveWorld): void {
    if (!this.authority) return;
    for (let i = this.tags.length - 1; i >= 0; i--) {
      const t = this.tags[i];
      t.ttl -= dt;
      if (t.ttl <= 0) {
        this.tags.splice(i, 1);
        this.onResolved?.(t, t.owner, 'expire');
        continue;
      }
      this._c.set(t.x, t.y, t.z);
      const p = this.pres;
      p.friendly = 0;
      p.hostile = 0;
      if (w.presence) w.presence(this._c, this.pickupRadius, p);
      else {
        p.hostile = w.hostilesWithin(this._c, this.pickupRadius);
        if (w.playerAlive && w.playerPosition) {
          const dx = w.playerPosition.x - t.x;
          const dz = w.playerPosition.z - t.z;
          if (dx * dx + dz * dz <= this.pickupRadius * this.pickupRadius) p.friendly = 1;
        }
      }
      const confirmer: Team = t.owner === 'friendly' ? 'hostile' : 'friendly';
      const confirmN = confirmer === 'friendly' ? p.friendly : p.hostile;
      const denyN = confirmer === 'friendly' ? p.hostile : p.friendly;
      if (confirmN > 0) {
        this.tags.splice(i, 1);
        this.onResolved?.(t, confirmer, 'confirm');
      } else if (denyN > 0) {
        this.tags.splice(i, 1);
        this.onResolved?.(t, t.owner, 'deny');
      }
    }
  }

  /** `v` = [count, (netId, ownerFlag, x×10, y×10, z×10, ttl×10) × count]. */
  replicate(out?: NetObjectiveState): NetObjectiveState {
    const v: number[] = [this.tags.length];
    for (const t of this.tags) {
      v.push(t.netId, t.owner === 'friendly' ? 0 : 1,
        Math.round(t.x * 10), Math.round(t.y * 10), Math.round(t.z * 10), Math.round(t.ttl * 10));
    }
    const s = out ?? this._net;
    s.netId = this.netId;
    s.kind = 'tag';
    s.v = v;
    return s;
  }

  applyReplicated(s: NetObjectiveState): void {
    this.tags.length = 0;
    const n = s.v[0] ?? 0;
    for (let i = 0; i < n; i++) {
      const o = 1 + i * 6;
      this.tags.push({
        netId: s.v[o], owner: s.v[o + 1] === 1 ? 'hostile' : 'friendly',
        x: s.v[o + 2] / 10, y: s.v[o + 3] / 10, z: s.v[o + 4] / 10, ttl: s.v[o + 5] / 10,
      });
    }
  }
}
