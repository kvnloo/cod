/**
 * WeaponSystem — the weapon state machine, view model, recoil and ballistics
 * dispatch.
 *
 * Everything the player does with a gun goes through here:
 *
 *   input → state machine → firing → recoil → ballistics → events
 *                        ↘ view model (procedural animation)
 *
 * The simulation half runs in `fixedUpdate` at 120 Hz so fire rate, recoil
 * patterns and projectile flight are frame-rate independent and reproducible
 * for a seed. The presentation half — the view-model rig, weapon collision,
 * tracers — runs in `update` at display rate so it stays smooth.
 *
 * Nothing outside this module is reached into: the player is read through its
 * public accessors, the renderer and physics through their contract
 * interfaces, and everything else is published on the bus.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { input } from '../core/Input';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { RayHit } from '../physics/types';
import { LAYER, MASK_MOVE } from '../physics/types';
import type { RenderAPI } from '../render/types';
import type { PlayerSystem } from '../player/Player';

import { DEFAULT_LOADOUT, WEAPONS, damageAt, weaponDef } from './Catalog';
import { resolveLoadout, resolveStats, type ResolvedStats } from './Attachments';
import type {
  AttachmentDef, FireMode, WeaponDef, WeaponRuntime, WeaponSnapshot, WeaponState,
} from './types';
import { WeaponMaterials } from './WeaponMaterials';
import { ViewModel } from './ViewModel';
import { RecoilState, type RecoilContext, type RecoilImpulse } from './Recoil';
import { SpreadState, type SpreadContext } from './Spread';
import { Ballistics, type DamageResolver } from './Ballistics';
import { TracerPool } from './Tracers';
import { GRENADES, GrenadeSystem, type GrenadeDef, type GrenadeKind, type ProjectilePhysics } from './Grenades';

export type { WeaponRuntime, WeaponSnapshot } from './types';

interface RenderExtras extends RenderAPI {
  viewModelScene: THREE.Scene;
  viewModelFovScale: number;
}

interface Slot {
  runtime: WeaponRuntime;
  attachments: AttachmentDef[];
  stats: ResolvedStats;
}

const MASK_MELEE = MASK_MOVE | LAYER.ENEMY | LAYER.RAGDOLL;

/**
 * Slack on every fire-clock comparison, seconds.
 *
 * The clock is a float accumulated one 1/120 step at a time and the schedule is
 * a float built from `60 / rpm`; the two round differently, so their difference
 * creeps by an ULP or so per second. Without slack that creep eventually flips
 * a comparison and one round in a magazine slips a whole step — measurable as
 * 720 rpm at one framerate and 718.8 at another, for no reason a player could
 * ever explain. 1 µs is 1/8333 of a fixed step: far too small to fire a round
 * early, far too large for accumulated rounding to cross.
 */
const FIRE_EPS = 1e-6;

const _hit: RayHit = {
  hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  distance: Infinity, surface: 'concrete', object: null, entityId: -1,
  bodyHandle: -1, zone: 'none', backface: false,
};

export class WeaponSystem implements System {
  readonly name = 'weapons';
  readonly order = ORDER.WEAPONS;

  /** Shared surfaces for every weapon and grenade mesh. */
  readonly materials = new WeaponMaterials();
  readonly viewModel = new ViewModel(this.materials);
  readonly ballistics = new Ballistics();
  readonly tracers = new TracerPool();
  readonly grenades = new GrenadeSystem(this.materials);

  /** The carried weapons. */
  slots: Slot[] = [];
  index = 0;

  state: WeaponState = 'idle';
  private triggerHeld = false;
  private nextShotAt = 0;
  private shotIndex = 0;
  private burstLeft = 0;
  private adsActive = false;
  private meleeUntil = 0;
  private switchTo = -1;
  /**
   * The weapon clock, in seconds, accumulated from the *fixed* step.
   *
   * Deliberately not `Time.elapsed`: that advances once per displayed frame
   * (`Time.tick`), so every fixed step inside one frame reads the same value.
   * Scheduling a 720 rpm cadence off it quantises every shot to the frame
   * boundary — and because the next shot was scheduled from the quantised
   * "now" rather than from the previous scheduled time, the error compounded
   * instead of averaging out, so the gun fired at a different rate at 60 fps
   * than at 144. This clock ticks once per 120 Hz step and nothing else.
   */
  private timeNow = 0;
  /* Edge guards: input edges persist for a whole frame, which is two or more
   * fixed steps, so anything that toggles state needs its own debounce. */
  private lastToggleAt = -1;
  private lastJumpAt = -1;

  /**
   * The last fixed step on which the player was in a sprint stance. The
   * sprint-to-fire gate is `lastSprintAt + stats.sprintOut`, i.e. a timer that
   * starts when the sprint *ends* — gating on the sprint state itself (the old
   * behaviour) is a no-op, because the state drops on the same step the input
   * does and the trigger is serviced on that very step.
   */
  private lastSprintAt = -999;
  /** Sim time the sprint-out finishes; a round cannot leave before it. */
  private fireReadyAt = -999;
  /** Sim time of the most recent shot, for telemetry. */
  private lastShotAt = -1;

  /**
   * Gameplay ADS blend, advanced on the fixed step.
   *
   * The view model runs its own spring for the *pose* at display rate, which is
   * right for presentation and wrong for anything that decides where a bullet
   * goes: spread, first-shot accuracy and recoil scaling would all become
   * frame-rate dependent. This is the authoritative one and it reaches 1.0
   * exactly `stats.adsTime` after the aim button goes down.
   */
  private adsProgress = 0;
  private adsBlendSim = 0;

  private recoil = new RecoilState();
  private spread = new SpreadState();
  private rand = new Rand('weapons');
  private recoilOut: RecoilImpulse = { pitch: 0, yaw: 0, recover: 0.72 };
  private recoilCtx: RecoilContext = {
    ads: false, crouched: false, prone: false, scale: 1, horizontalScale: 1,
  };
  private spreadCtx: SpreadContext = {
    ads: 0, speed01: 0, grounded: true, crouched: false, prone: false,
    hipScale: 1, adsScale: 1, bloomScale: 1,
  };

  private player: PlayerSystem | null = null;
  private physics: ProjectilePhysics | null = null;
  private renderApi: RenderExtras | null = null;
  private camera: THREE.PerspectiveCamera | null = null;

  /** The user's own ADS FOV preference, so per-weapon zoom can layer on top. */
  private baseAdsFovScale = 0.72;

  private readonly _dir = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _origin = new THREE.Vector3();
  private readonly _muzzle = new THREE.Vector3();
  private readonly _tmp = new THREE.Vector3();

  /* ------------------------------------------------------------------ init */

  async init(ctx: EngineContext): Promise<void> {
    this.player = ctx.engine.tryGet<PlayerSystem>('player') ?? null;
    this.physics = ctx.engine.tryGet<System & ProjectilePhysics>('physics') ?? null;
    this.renderApi = ctx.engine.tryGet<System & RenderExtras>('render') ?? null;
    this.camera = ctx.camera;
    this.baseAdsFovScale = settings.game.adsFovScale;

    this.ballistics.physics = this.physics;
    this.ballistics.render = this.renderApi;
    this.ballistics.tracers = this.tracers;
    this.grenades.physics = this.physics;
    this.grenades.render = this.renderApi;
    this.grenades.ballistics = this.ballistics;

    if (this.renderApi) {
      this.renderApi.viewModelScene.add(this.viewModel.root);
      this.materials.bringUp(this.renderApi.renderer);
    }
    ctx.scene.add(this.tracers.mesh);
    ctx.scene.add(this.grenades.root);

    // Textures are generated on the GPU, so bake them once the context
    // definitely exists rather than on the first draw.
    bus.on('game:ready', () => {
      if (this.renderApi) this.materials.warmup(this.renderApi.renderer);
    });

    for (const id of DEFAULT_LOADOUT) this.give(id);
    this.equip(0, true);

    bus.on('player:land', (e) => this.viewModel.land(e.force));
    bus.on('player:mantle', () => this.viewModel.mantle());
    bus.on('player:spawn', () => this.onSpawn());
    // `weapon:ads` was write-only: this system announced it and nobody could
    // ask for it. Scripted sequences — capture shots, cinematics, the HUD's own
    // sight-picture stills — need to pose the view model down its sights
    // without synthesising input, so the event now works in both directions.
    bus.on('weapon:ads', (e) => {
      if (this.adsEmitting) return;
      this.adsScripted = e.active;
    });
  }

  /* --------------------------------------------------------------- loadout */

  /** Adds a weapon to the loadout, replacing whatever occupied its slot. */
  give(id: string, attachmentIds?: readonly string[]): void {
    const def = weaponDef(id);
    const attachments = resolveLoadout(def, attachmentIds ?? def.attachments);
    const stats = resolveStats(def, attachments);
    const runtime: WeaponRuntime = {
      id: def.id, name: def.name, magSize: stats.magSize, ammo: stats.magSize,
      reserve: def.startReserve, rpm: def.rpm, ads: false, reloading: false,
      def, fireMode: def.defaultFireMode, attachments: attachments.map((a) => a.id),
      patternIndex: 0, bloom: 0, heat: 0, chambered: true,
    };
    const slot: Slot = { runtime, attachments, stats };
    const existing = this.slots.findIndex((s) => s.runtime.def.slot === def.slot);
    if (existing >= 0) this.slots[existing] = slot; else this.slots.push(slot);
  }

  /** Rebuilds the current weapon with a different attachment loadout. */
  setAttachments(ids: readonly string[]): void {
    const slot = this.slots[this.index];
    if (!slot) return;
    const def = slot.runtime.def;
    const attachments = resolveLoadout(def, ids);
    const stats = resolveStats(def, attachments);
    slot.attachments = attachments;
    slot.stats = stats;
    slot.runtime.attachments = attachments.map((a) => a.id);
    const ratio = slot.runtime.ammo / Math.max(1, slot.runtime.magSize);
    slot.runtime.magSize = stats.magSize;
    slot.runtime.ammo = Math.min(stats.magSize, Math.round(stats.magSize * ratio));
    this.equip(this.index, true);
  }

  private equip(index: number, immediate = false): void {
    if (index < 0 || index >= this.slots.length) return;
    const from = this.slots[this.index]?.runtime.id ?? null;
    this.index = index;
    const slot = this.slots[index];
    this.viewModel.equip(slot.runtime.def, slot.attachments, slot.stats);
    this.viewModel.setVisible(true);
    this.recoil.reset();
    this.spread.reset();
    this.burstLeft = 0;
    // A swap re-runs the whole ADS transition: carrying the previous weapon's
    // blend across would hand the new gun an instant sight picture.
    this.adsProgress = 0;
    this.adsBlendSim = 0;
    this.state = 'drawing';
    const draw = immediate ? slot.stats.drawTime * 0.6 : slot.stats.drawTime;
    this.viewModel.startDraw(draw);
    this.nextShotAt = this.timeNow + draw * 0.72;
    bus.emit('weapon:switch', { from, to: slot.runtime.id });
    this.applyScopeZoom();
  }

  /** Per-weapon scope magnification, layered on the player's own FOV setting. */
  private applyScopeZoom(): void {
    const slot = this.slots[this.index];
    if (!slot) return;
    const mag = Math.max(1, slot.stats.magnification);
    // A magnified optic has to actually magnify.
    //
    // The old curve (1 / (1 + (mag−1)·0.11)) turned a 4× prism into 1.33× of
    // extra squeeze on top of the iron-sight ADS zoom — about 1.8× against the
    // hip frame. The result was measurable: the image inside the ACOG's glass
    // carried the same local contrast as the wall beside it, so the optic was
    // decoration rather than a sight. A 4× should pull ~3.4× and a 9× ~7.4×,
    // which is what a shipped shooter gives you; the 0.80 term is the only
    // concession to playability.
    const optical = mag > 1 ? 1 + (mag - 1) * 0.80 : 1;
    // Never *less* zoom than the plain ADS pull the player has configured.
    const base = this.baseAdsFovScale * slot.runtime.def.view.scopeZoom;
    const scale = mag > 1 ? Math.min(base, 1 / optical) : base;
    settings.game.adsFovScale = THREE.MathUtils.clamp(scale, 0.11, 1);
  }

  get current(): WeaponRuntime { return this.slots[this.index].runtime; }
  get currentStats(): ResolvedStats { return this.slots[this.index].stats; }
  get definition(): WeaponDef { return this.current.def; }

  /** Everything a HUD or an audio engine needs, allocation free. */
  snapshot(out?: WeaponSnapshot): WeaponSnapshot {
    const w = this.current;
    const s = this.currentStats;
    const o = out ?? ({} as WeaponSnapshot);
    o.id = w.id; o.name = w.name; o.short = w.def.short; o.cls = w.def.cls;
    o.ammo = w.ammo; o.magSize = w.magSize; o.reserve = w.reserve;
    o.fireMode = w.fireMode; o.ads = this.viewModel.adsBlend; o.reloading = w.reloading;
    o.state = this.state; o.spreadDeg = this.spread.cone(w.def, this.spreadCtx);
    o.heat = w.heat; o.attachments = w.attachments;
    o.suppressed = s.suppressed; o.magnification = s.magnification;
    return o;
  }

  /** Looks up any weapon definition — audio and HUD read voices from here. */
  definitionOf(id: string): WeaponDef | null {
    return WEAPONS.find((w) => w.id === id) ?? null;
  }

  /** Installs the host game's health model. Without one, damage is reported raw. */
  setDamageResolver(fn: DamageResolver | null): void {
    this.ballistics.damageResolver = fn;
  }

  private onSpawn(): void {
    for (const s of this.slots) {
      s.runtime.ammo = s.runtime.magSize;
      s.runtime.reserve = s.runtime.def.startReserve;
      s.runtime.heat = 0;
    }
    this.grenades.resupply();
    this.grenades.clear();
    this.ballistics.clear();
    this.tracers.clear();
    this.state = 'idle';
    this.lastSprintAt = -999;
    this.fireReadyAt = -999;
    this.adsProgress = 0;
    this.adsBlendSim = 0;
    this.recoil.reset();
    this.spread.reset();
  }

  /* --------------------------------------------------------- fixed update */

  fixedUpdate(dt: number, _ctx: EngineContext): void {
    this.timeNow += dt;
    const slot = this.slots[this.index];
    if (!slot) return;
    const w = slot.runtime;
    const def = w.def;

    this.readStance();
    // Recoil recovery is driven from here, not from the render frame, so a
    // spray recovers identically at 30 and 540 fps.
    this.player?.camera.stepRecoil(dt);
    if (this.stanceSprinting) {
      this.lastSprintAt = this.timeNow;
      this.fireReadyAt = this.timeNow + slot.stats.sprintOut;
    }
    this.recoil.tick(dt, def.recoil);
    // Bloom must not decay faster than the gun cycles, or holding the trigger
    // recovers accuracy — which is the exact opposite of what bloom is for. The
    // hold window is therefore one refire interval plus a margin, not a
    // constant that happens to be shorter than a 720 rpm cycle.
    this.spread.tick(dt, def.spread, this.refireInterval(def) * 1.35);
    w.bloom = this.spread.bloom;
    w.heat = Math.max(0, w.heat - dt * 0.18);

    this.ballistics.fixedUpdate(dt);
    this.grenades.fixedUpdate(
      dt, this.player?.position ?? this._origin.set(0, 0, 0), this.player?.entityId ?? 1, true,
    );
    if (this.grenades.consumeCookedOff()) {
      bus.emit('notify', { text: 'Cooked off', kind: 'warn' });
    }

    // The jump impulse has no event of its own, so read the edge directly:
    // the weapon lifts as the legs push, then compresses again on landing
    // (which does have an event).
    if (input.pressed('jump') && this.stanceGrounded && this.timeNow - this.lastJumpAt > 0.25) {
      this.lastJumpAt = this.timeNow;
      this.viewModel.jump();
    }

    // Order matters and is the whole point: aim intent → the blend that intent
    // drives → the spread context that reads the blend → actions → the trigger.
    // Running the blend before the intent cost a step of latency on every ADS.
    this.updateAds();
    this.updateAdsBlend(dt, slot.stats);
    this.syncSpreadCtx(slot.stats);
    this.updateActions();
    this.updateFiring();
    this.updateGrenades();
  }

  /* --------------------------------------------------------------- stance */

  private stanceSprinting = false;
  private stanceCrouched = false;
  private stanceProne = false;
  private stanceSpeed01 = 0;
  private stanceGrounded = true;
  private stepPhase = 0;

  private readStance(): void {
    const p = this.player;
    if (!p) return;
    const st = p.state;
    this.stanceSprinting = st === 'sprint' || st === 'tacSprint' || st === 'slide';
    this.stanceCrouched = st === 'crouchIdle' || st === 'crouchWalk' || st === 'slide';
    this.stanceProne = st === 'prone' || st === 'proneCrawl';
    this.stanceSpeed01 = p.speed01;
    this.stanceGrounded = p.grounded;
    this.stepPhase = p.movement.out.stepPhase;
  }

  /* ------------------------------------------------------------------ ADS */

  /** Externally requested aim, from a scripted `weapon:ads`. */
  private adsScripted: boolean | null = null;
  /** Guards the round trip through the bus while this system announces its own. */
  private adsEmitting = false;

  private updateAds(): void {
    const w = this.slots[this.index].runtime;
    const busy = this.state === 'melee' || this.state === 'holstering';
    const held = input.held('ads');
    // A real trigger finger always outranks a script, and taking hold of the
    // aim button drops the override for good.
    if (held) this.adsScripted = null;
    const wantAds = (held || this.adsScripted === true)
      && !this.stanceSprinting && !busy && !this.grenades.cooking;
    if (wantAds !== this.adsActive) {
      this.adsActive = wantAds;
      w.ads = wantAds;
      this.adsEmitting = true;
      bus.emit('weapon:ads', { active: wantAds });
      this.adsEmitting = false;
    }
  }

  /**
   * Advances the gameplay ADS blend on the fixed step.
   *
   * `stats.adsTime` is the contract — hip to fully sighted — and it is honoured
   * exactly: linear progress at `1 / adsTime`, shaped by a smootherstep so the
   * blend has zero velocity at both ends and never snaps. Coming *out* of the
   * sights is 25% quicker, which is how every CoD since MW2019 handles it (you
   * drop the gun faster than you raise it).
   *
   * The 0.92 threshold Spread uses for first-shot accuracy lands at 79% of
   * `adsTime` — 198 ms on the 250 ms VKR-7 — which is within a step of where
   * the view-model spring finishes its pose. Being "sighted" to the eye and
   * "sighted" to the ballistics therefore happen together.
   */
  private updateAdsBlend(dt: number, stats: ResolvedStats): void {
    const inRate = 1 / Math.max(0.02, stats.adsTime);
    const outRate = 1 / Math.max(0.02, stats.adsTime * 0.8);
    this.adsProgress = this.adsActive
      ? Math.min(1, this.adsProgress + inRate * dt)
      : Math.max(0, this.adsProgress - outRate * dt);
    const t = this.adsProgress;
    this.adsBlendSim = t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * Refreshes the spread context once per fixed step.
   *
   * It used to be written only inside `shoot`, which left `snapshot().spreadDeg`
   * — the crosshair the player is looking at — describing the stance they were
   * in when they last pulled the trigger.
   */
  private syncSpreadCtx(stats: ResolvedStats): void {
    // Every gameplay-visible aim term reads the fixed-step blend, never the
    // view model's display-rate spring: where the bullet goes must not depend
    // on the refresh rate.
    this.spreadCtx.ads = this.adsBlendSim;
    this.spreadCtx.speed01 = this.stanceSpeed01;
    this.spreadCtx.grounded = this.stanceGrounded;
    this.spreadCtx.crouched = this.stanceCrouched;
    this.spreadCtx.prone = this.stanceProne;
    this.spreadCtx.hipScale = stats.hipSpreadScale;
    this.spreadCtx.adsScale = stats.adsSpreadScale;
    this.spreadCtx.bloomScale = stats.bloomScale;
  }

  /** Authoritative ADS blend, 0..1, on the fixed step. */
  get adsBlend(): number { return this.adsBlendSim; }
  /** Linear ADS progress, 0..1 — 1.0 means fully sighted, exactly at `adsTime`. */
  get adsProgress01(): number { return this.adsProgress; }

  /* -------------------------------------------------------------- actions */

  private updateActions(): void {
    const slot = this.slots[this.index];
    const w = slot.runtime;
    const def = w.def;
    const vm = this.viewModel;

    /* --- weapon switching ------------------------------------------------ */
    if (this.state !== 'holstering') {
      let want = -1;
      if (input.pressed('switchWeapon')) want = (this.index + 1) % Math.max(1, this.slots.length);
      if (input.pressed('slot1')) want = 0;
      if (input.pressed('slot2')) want = 1;
      if (want >= 0 && want !== this.index && want < this.slots.length) {
        this.switchTo = want;
        this.state = 'holstering';
        w.reloading = false;
        vm.cancelAction();
        vm.startHolster(slot.stats.drawTime * 0.55);
      }
    } else if (vm.currentAction === 'none') {
      const to = this.switchTo;
      this.switchTo = -1;
      if (to >= 0) { this.equip(to); return; }
    }

    /* --- fire-mode toggle (slot 3 is unused by a two-weapon loadout) ------ */
    if (input.pressed('slot3') && def.fireModes.length > 1
      && this.timeNow - this.lastToggleAt > 0.2
      && (this.state === 'idle' || this.state === 'firing')) {
      this.lastToggleAt = this.timeNow;
      const i = (def.fireModes.indexOf(w.fireMode) + 1) % def.fireModes.length;
      w.fireMode = def.fireModes[i];
      vm.setFireModeIndex(i);
      bus.emit('notify', { text: fireModeLabel(w.fireMode), kind: 'info' });
    }

    /* --- melee ------------------------------------------------------------ */
    if (input.pressed('melee') && this.state !== 'melee' && this.state !== 'holstering') {
      this.state = 'melee';
      w.reloading = false;
      vm.cancelAction();
      vm.startMelee(def.handling.meleeTime);
      this.meleeUntil = this.timeNow + def.handling.meleeTime;
      this.nextShotAt = Math.max(this.nextShotAt, this.meleeUntil);
    }
    if (this.state === 'melee') {
      if (vm.consumeStrike(def.handling.meleeHitAt / def.handling.meleeTime)) {
        this.resolveMelee(def.handling.meleeRange, def.handling.meleeDamage);
      }
      if (this.timeNow >= this.meleeUntil) this.state = 'idle';
      return;
    }

    /* --- inspect ---------------------------------------------------------- */
    if (input.pressed('inspect') && this.state === 'idle') {
      this.state = 'inspecting';
      vm.startInspect(def.handling.inspectTime);
    }
    if (this.state === 'inspecting') {
      if (vm.currentAction === 'none') this.state = 'idle';
      if (input.held('fire') || input.held('ads') || this.stanceSprinting) {
        vm.cancelAction();
        this.state = 'idle';
      }
    }

    /* --- reload ----------------------------------------------------------- */
    const shellReload = def.reload.perShell !== undefined;
    const wantsReload = input.pressed('reload') && w.ammo < w.magSize && w.reserve > 0;
    if (wantsReload && !w.reloading
      && (this.state === 'idle' || this.state === 'firing' || this.state === 'inspecting'
        || this.state === 'sprinting')) {
      this.beginReload();
    }

    if (w.reloading) {
      if (shellReload) this.tickShellReload();
      else this.tickMagReload();
      // Sprinting cancels a reload; on a shell reload so does the trigger.
      if (this.stanceSprinting || (shellReload && input.pressed('fire') && w.ammo > 0)) {
        this.finishReload(false);
      }
    }

    /* --- sprint pose ------------------------------------------------------ */
    if (this.state === 'idle' && this.stanceSprinting) this.state = 'sprinting';
    else if (this.state === 'sprinting' && !this.stanceSprinting) this.state = 'idle';
    if (this.state === 'drawing' && vm.currentAction === 'none') this.state = 'idle';
  }

  private beginReload(): void {
    const slot = this.slots[this.index];
    const w = slot.runtime;
    const def = w.def;
    const empty = w.ammo <= 0;
    w.reloading = true;
    this.state = 'reloading';
    this.burstLeft = 0;

    if (def.reload.perShell !== undefined) {
      this.viewModel.startShellReload(999);
      bus.emit('weapon:reload:start', { weaponId: w.id, tactical: !empty });
      return;
    }
    const base = empty ? def.reload.empty : def.reload.tactical;
    const duration = base * slot.stats.reloadScale;
    this.viewModel.startReload(empty, duration);
    this.nextShotAt = Math.max(this.nextShotAt, this.timeNow + duration * def.reload.addAmmoAt);
    bus.emit('weapon:reload:start', { weaponId: w.id, tactical: !empty });
  }

  private tickMagReload(): void {
    const w = this.slots[this.index].runtime;
    if (this.viewModel.consumeCommit(w.def.reload.addAmmoAt)) {
      const take = Math.min(w.magSize - w.ammo, w.reserve);
      w.ammo += take;
      w.reserve -= take;
    }
    if (this.viewModel.currentAction === 'none') this.finishReload(true);
  }

  private tickShellReload(): void {
    const w = this.slots[this.index].runtime;
    if (this.viewModel.shellBeat() && w.reserve > 0 && w.ammo < w.magSize) {
      w.ammo++;
      w.reserve--;
    }
    if (w.ammo >= w.magSize || w.reserve <= 0) this.finishReload(true);
  }

  private finishReload(complete: boolean): void {
    const w = this.current;
    w.reloading = false;
    this.state = 'idle';
    if (w.def.reload.perShell !== undefined) this.viewModel.finishShellReload();
    else if (!complete) this.viewModel.cancelAction();
    bus.emit('weapon:reload:end', { weaponId: w.id });
  }

  /* --------------------------------------------------------------- firing */

  /**
   * Seconds between rounds. `60 / rpm` is the mechanical cycle; `cycleTime` is
   * the manual action on top of it (pump, bolt); `semiRefire` is the floor a
   * human trigger finger cannot beat.
   */
  private refireInterval(def: WeaponDef): number {
    return Math.max(60 / def.rpm + def.handling.cycleTime, def.handling.semiRefire);
  }

  /**
   * Schedules the next round.
   *
   * The remainder is *carried*: the next shot is anchored to the previous
   * scheduled time, not to the step the trigger happened to be serviced on. A
   * 640 rpm LMG wants a round every 93.75 ms, which is 11.25 fixed steps — with
   * carry the cadence alternates 11/11/11/12 steps and the mean is exact; the
   * old `now + interval` rounded up every single time and the gun lost 4% of
   * its rate of fire. Only when the schedule is stale by a full interval (idle
   * trigger, reload, weapon swap) does the anchor reset to now.
   */
  private scheduleNextShot(interval: number): void {
    const over = this.timeNow - this.nextShotAt;
    this.nextShotAt = over >= -FIRE_EPS && over < interval
      ? this.nextShotAt + interval
      : this.timeNow + interval;
  }

  private updateFiring(): void {
    const slot = this.slots[this.index];
    const w = slot.runtime;
    const def = w.def;
    const held = input.held('fire');
    const pressed = input.pressed('fire');
    if (!held) this.triggerHeld = false;

    // Sprint-to-fire: the timer starts when the sprint *ends*. CoD MW2019 runs
    // 80-250 ms by class and it is the single biggest reason its gunfights feel
    // committed — you cannot sprint around a corner and instantly shoot.
    // `stats.sprintOut` is the authored per-weapon number (VKR-7 190 ms, Hornet
    // 130 ms, Vulcan 360 ms) and attachments scale it.
    const sprintBlocked = this.timeNow < this.fireReadyAt - FIRE_EPS;
    const blocked = w.reloading || this.state === 'drawing' || this.state === 'holstering'
      || this.state === 'melee' || this.stanceSprinting || sprintBlocked
      || this.grenades.cooking;
    if (blocked) { if (this.state === 'firing') this.state = 'idle'; return; }

    // A burst finishes on its own once started.
    if (this.burstLeft > 0) {
      if (this.timeNow >= this.nextShotAt - FIRE_EPS && w.ammo > 0) {
        this.shoot();
        this.burstLeft--;
        if (this.burstLeft === 0) this.nextShotAt = this.timeNow + def.handling.burstDelay;
      }
      return;
    }

    // Note: `input.pressed` edges survive for the whole frame, and this runs at
    // 120 Hz — twice per displayed frame at 60 fps. Semi-auto must therefore
    // latch on `triggerHeld`, not on the edge, or every click fires twice.
    const canStart = w.fireMode === 'auto' ? held : (held && !this.triggerHeld);
    if (!canStart || this.timeNow < this.nextShotAt - FIRE_EPS) {
      if (this.state === 'firing' && !held) this.state = 'idle';
      return;
    }

    if (w.ammo <= 0) {
      if (!this.triggerHeld) {
        bus.emit('weapon:dryfire', { weaponId: w.id });
        this.nextShotAt = this.timeNow + 0.22;
        this.triggerHeld = true;
        // Auto-reload on an empty trigger pull, like every modern shooter.
        if (w.reserve > 0) this.beginReload();
      }
      return;
    }

    if (w.fireMode === 'burst') {
      this.burstLeft = def.handling.burstCount;
      this.shoot();
      this.burstLeft--;
      this.triggerHeld = true;
      return;
    }
    this.shoot();
    if (w.fireMode === 'semi') this.triggerHeld = true;
  }

  private shoot(): void {
    const slot = this.slots[this.index];
    const w = slot.runtime;
    const def = w.def;
    const stats = slot.stats;
    const cam = this.camera;
    if (!cam) return;

    w.ammo--;
    w.heat = Math.min(1, w.heat + 1 / Math.max(8, def.magSize * 0.8));
    this.state = 'firing';
    this.scheduleNextShot(this.refireInterval(def));
    this.lastShotAt = this.timeNow;

    /* --- direction ------------------------------------------------------- */
    // The round is aimed from the eye, not the muzzle: that is what makes what
    // you see through the sights match where the bullet goes.
    this._origin.copy(cam.position);
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    const cone = this.spread.cone(def, this.spreadCtx);
    this.spread.onShot(def.spread, this.spreadCtx);

    const bal = def.ballistics;
    const pellets = Math.max(1, bal.pellets);
    const tracer = bal.tracerEvery > 0 && this.shotIndex % bal.tracerEvery === 0;

    for (let i = 0; i < pellets; i++) {
      this._tmp.copy(this._dir);
      const spreadDeg = pellets > 1 ? Math.max(cone, bal.pelletSpreadDeg) : cone;
      SpreadState.apply(this._tmp, spreadDeg, this.rand, this._right, this._up);
      this.ballistics.fire({
        def,
        origin: this._origin,
        direction: this._tmp,
        penetration: stats.penetration,
        muzzleVelocity: stats.muzzleVelocity,
        rangeScale: stats.rangeScale,
        ownerEntity: this.player?.entityId ?? 1,
        fromPlayer: true,
        tracer: tracer && i === 0,
        shotIndex: this.shotIndex,
      });
    }

    /* --- recoil ---------------------------------------------------------- */
    this.recoilCtx.ads = this.adsBlendSim > 0.5;
    this.recoilCtx.crouched = this.stanceCrouched;
    this.recoilCtx.prone = this.stanceProne;
    this.recoilCtx.scale = stats.recoilScale;
    this.recoilCtx.horizontalScale = stats.recoilHorizontalScale;
    const imp = this.recoil.next(def, this.recoilCtx, this.rand, this.recoilOut);
    w.patternIndex = this.recoil.index;

    const rig = this.player?.camera;
    if (rig) {
      rig.addRecoil(imp.pitch * (Math.PI / 180), -imp.yaw * (Math.PI / 180), imp.recover);
      rig.addShake(def.recoil.shake * (1 - this.adsBlendSim * 0.45), 30, 0.18);
    }
    this.viewModel.onFire(imp.pitch, imp.yaw);
    // A can turns a fireball into a puff; the view-model emitter has to know.
    if (stats.suppressed) this.viewModel.setFlashScale(0.16);
    input.rumble(Math.min(1, def.recoil.shake * 55), 0.25, 55);

    /* --- events ---------------------------------------------------------- */
    this.viewModel.muzzleWorld(cam, this._muzzle);
    bus.emit('weapon:fire', {
      weaponId: w.id,
      origin: this._muzzle.clone(),
      direction: this._tmp.clone(),
      shotIndex: this.shotIndex,
      suppressed: stats.suppressed,
    });
    if (!stats.suppressed && this.renderApi) {
      this.renderApi.addDynamicLight({
        position: this._muzzle.clone(),
        color: 0xffcb87,
        intensity: 12 + pellets * 2,
        radius: 6.5,
        lifetime: 0.055,
        decay: 'flash',
      });
      this.renderApi.screenEffect({ flash: { intensity: 0.10, color: 0xffd9a8, decay: 0.06 } });
    }
    if (def.cls === 'lmg' && w.heat > 0.85) {
      bus.emit('weapon:overheat', { weaponId: w.id, heat: w.heat });
    }
    this.shotIndex++;
  }

  private resolveMelee(range: number, damage: number): void {
    const cam = this.camera;
    const phys = this.physics;
    if (!cam || !phys) return;
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const hit = phys.raycast(cam.position, this._dir, range, MASK_MELEE, _hit, this.player?.entityId ?? 1);
    if (!hit.hit) return;
    if (hit.entityId >= 0) {
      const res = this.ballistics.damageResolver?.(hit.entityId, damage, false, hit.point, this._dir, true)
        ?? { killed: false, applied: damage };
      bus.emit('damage:dealt', {
        targetId: hit.entityId, amount: res.applied, headshot: false,
        killed: res.killed, point: hit.point.clone(), fromPlayer: true,
      });
      bus.emit('hud:hitmarker', { headshot: false, killed: res.killed, armor: false });
    } else {
      bus.emit('bullet:impact', {
        point: hit.point.clone(), normal: hit.normal.clone(), surface: hit.surface,
        incoming: this._dir.clone(), energy: 40, penetrated: false,
      });
    }
  }

  /* ------------------------------------------------------------- grenades */

  private updateGrenades(): void {
    const cam = this.camera;
    if (!cam) return;

    const wantFrag = input.pressed('grenade');
    const wantTac = input.pressed('tactical');
    if ((wantFrag || wantTac) && !this.grenades.cooking && this.state !== 'holstering') {
      this.grenades.select(wantFrag ? 'frag' : this.grenades.stock.flash > 0 ? 'flash' : 'smoke');
      this.grenades.beginCook();
    }
    if (this.grenades.cooking && (input.released('grenade') || input.released('tactical'))) {
      this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
      this.grenades.release(
        cam.position, this._dir, input.held('crouch'),
        this.player?.entityId ?? 1, true, this.player?.velocity,
      );
    }
  }

  /* -------------------------------------------------------------- present */

  update(dt: number, ctx: EngineContext): void {
    const slot = this.slots[this.index];
    if (!slot) return;
    const cam = ctx.camera;

    // Weapon collision: probe forward along the bore and pull the weapon in so
    // the barrel never disappears into geometry.
    let lowReady = 0;
    const phys = this.physics;
    const rig = this.viewModel.rig;
    if (phys && rig) {
      const reach = Math.abs(rig.point('muzzle')?.z ?? 0.7) + 0.22;
      this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const hit = phys.raycast(cam.position, this._dir, reach, MASK_MOVE, _hit, this.player?.entityId ?? 1);
      if (hit.hit) lowReady = THREE.MathUtils.clamp(1 - (hit.distance - 0.35) / (reach - 0.35), 0, 1);
    }

    const s = input.state;
    this.viewModel.update(dt, {
      ads: this.adsActive ? 1 : 0,
      sprint: this.stanceSprinting && this.state !== 'melee' ? 1 : 0,
      speed01: this.stanceSpeed01,
      stepPhase: this.stepPhase,
      grounded: this.stanceGrounded,
      crouch: this.stanceCrouched ? 1 : 0,
      lookDX: s.mouseDX,
      lookDY: s.mouseDY,
      strafe: s.moveX,
      forward: s.moveY,
      lowReady,
      boltLocked: slot.runtime.ammo <= 0 && slot.runtime.def.cls !== 'shotgun',
      ammo: slot.runtime.ammo,
    });

    // Aiming through a magnified optic narrows the view-model FOV too, or the
    // scope body swells to fill the screen.
    if (this.renderApi) {
      const mag = Math.max(1, slot.stats.magnification);
      const target = THREE.MathUtils.clamp(0.78 - (mag - 1) * 0.012, 0.55, 0.85);
      this.renderApi.viewModelFovScale = THREE.MathUtils.lerp(0.78, target, this.viewModel.adsBlend);
    }

    this.grenades.update(dt);
    this.tracers.update3(dt, cam);

    if (this.grenades.cooking) {
      this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
      this.grenades.predict(cam.position, this._dir, input.held('crouch'), this.player?.entityId ?? 1);
    }
  }

  /* ---------------------------------------------------------------- debug */

  /** Damage at a distance for the current weapon — used by the HUD and tests. */
  damageAtRange(metres: number): number { return damageAt(this.definition, metres); }

  /**
   * Everything the gunfeel probe needs to check the clock without reaching into
   * private state: the fixed-step time base, the shot schedule, the sprint-out
   * gate and the authoritative ADS blend. All times are seconds on the *sim*
   * clock, which is the only clock any of this is scheduled against.
   */
  fireClock(): {
    time: number; interval: number; nextShotAt: number; lastShotAt: number;
    fireReadyAt: number; lastSprintAt: number; sprintOut: number;
    adsProgress: number; adsBlend: number; viewAdsBlend: number;
    bloom: number; coneDeg: number; patternIndex: number; shotIndex: number;
  } {
    const slot = this.slots[this.index];
    const def = slot.runtime.def;
    return {
      time: this.timeNow,
      interval: this.refireInterval(def),
      nextShotAt: this.nextShotAt,
      lastShotAt: this.lastShotAt,
      fireReadyAt: this.fireReadyAt,
      lastSprintAt: this.lastSprintAt,
      sprintOut: slot.stats.sprintOut,
      adsProgress: this.adsProgress,
      adsBlend: this.adsBlendSim,
      viewAdsBlend: this.viewModel.adsBlend,
      bloom: this.spread.bloom,
      coneDeg: this.spread.cone(def, this.spreadCtx),
      patternIndex: this.recoil.index,
      shotIndex: this.shotIndex,
    };
  }

  /**
   * Re-seeds the weapon RNG and clears the pattern walk. Two sprays taken after
   * the same call are byte-identical, which is what makes an authored recoil
   * pattern a *pattern* rather than a suggestion.
   */
  resetSpray(seed: number | string = 'weapons'): void {
    this.rand.seed(seed);
    this.recoil.reset();
    this.spread.reset();
    this.shotIndex = 0;
    this.nextShotAt = this.timeNow;
  }

  grenadeStock(kind: GrenadeKind): number { return this.grenades.stock[kind]; }
  grenadeDef(kind: GrenadeKind): GrenadeDef { return GRENADES[kind]; }

  dispose(): void {
    this.viewModel.dispose();
    this.grenades.dispose();
    this.tracers.dispose();
    this.materials.dispose();
  }
}

function fireModeLabel(m: FireMode): string {
  return m === 'auto' ? 'AUTO' : m === 'burst' ? 'BURST' : 'SEMI';
}

/* Registering the debug scene is a side effect of importing the module that
 * main.ts already imports, which lets this subsystem own its own visual
 * verification without touching any shared file. */
import './DebugScene';
