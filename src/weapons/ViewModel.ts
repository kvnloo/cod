/**
 * View-model rig — everything the player actually looks at.
 *
 * The weapon lives in the renderer's dedicated view-model scene, authored in
 * *view space*: the view-model camera sits at the origin looking down −Z, so
 * the rig's transform is literally "where the gun is relative to your eye".
 * That is what makes sight alignment exact rather than hand-tuned — the ADS
 * pose is solved from the mesh's own sight point, so bolting on a 9× scope
 * re-aligns the aimed pose for free.
 *
 * Everything is layered and additive:
 *
 *   base pose      hip ↔ ADS ↔ sprint ↔ low-ready, blended with springs
 * + bob            figure-8 on the footstep phase, scaled by speed
 * + sway           two-octave noise breathing, plus inertial mouse lag
 * + recoil         spring-damper kick on position and rotation, per-weapon
 * + impulses       landing, jumping, mantling
 * + action         reload / draw / inspect / melee, timed curves that also
 *                  drive named parts of the mesh hierarchy
 *
 * No layer knows about any other, so they compose without special cases.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { AttachmentDef, WeaponDef } from './types';
import type { ResolvedStats } from './Attachments';
import type { WeaponRig } from './mesh/Builder';
import { buildWeaponMesh } from './mesh/Models';
import { setReticleFade } from './mesh/Reticle';
import type { WeaponMaterials } from './WeaponMaterials';
import { DEG, Spring1, Spring3, approach, clamp01, curve, curveLinear, fbm1, ring } from './Anim';

export type ActionKind =
  | 'none' | 'reload' | 'reloadShell' | 'draw' | 'holster'
  | 'inspect' | 'melee' | 'fireMode';

export interface ViewModelState {
  /** 0..1 target aim blend. */
  ads: number;
  /** 0..1 target sprint blend. */
  sprint: number;
  /** Normalised horizontal speed. */
  speed01: number;
  /** Footstep phase, 0..1, from the movement system. */
  stepPhase: number;
  grounded: boolean;
  crouch: number;
  /** 0..1 slide presentation blend (distinct from sprint tuck). */
  slide?: number;
  /** Raw mouse delta this frame, device units. */
  lookDX: number;
  lookDY: number;
  /** Analog movement, −1..1. */
  strafe: number;
  forward: number;
  /** 0..1 — how much the barrel is being pushed into a wall. */
  lowReady: number;
  /** True while the bolt is held open on an empty magazine. */
  boltLocked: boolean;
  /** Rounds left, so shell reloads know when to stop. */
  ammo: number;
}

interface Action {
  kind: ActionKind;
  t: number;
  duration: number;
  empty: boolean;
  /** Shell index for shell-by-shell reloads. */
  index: number;
  /** Set once the "ammo lands" moment has fired. */
  committed: boolean;
  /** Set once the melee hit moment has fired. */
  struck: boolean;
}

const ZERO = new THREE.Vector3();

export class ViewModel {
  readonly root = new THREE.Group();
  rig: WeaponRig | null = null;
  def: WeaponDef | null = null;
  stats: ResolvedStats | null = null;

  /* --- blends --- */
  private adsSpring = new Spring1(7.5, 0.66);
  private ads = 0;
  private sprint = 0;
  private slideW = 0;
  private crouchW = 0;
  private mantleT = -1;
  private lowReady = 0;
  private hidden = false;

  /* --- poses --- */
  private pHip = new THREE.Vector3();
  private qHip = new THREE.Quaternion();
  private pAds = new THREE.Vector3();
  private qAds = new THREE.Quaternion();
  private pSprint = new THREE.Vector3();
  private qSprint = new THREE.Quaternion();
  private pLow = new THREE.Vector3();
  private qLow = new THREE.Quaternion();

  /* --- layers --- */
  private bob = new THREE.Vector3();
  private bobRot = new THREE.Vector3();
  private swayPos = new Spring3(6.0, 0.72);
  private swayRot = new Spring3(5.2, 0.68);
  private swayTargetPos = new THREE.Vector3();
  private swayTargetRot = new THREE.Vector3();
  private kickPos = new Spring3(9.5, 0.55);
  private kickRot = new Spring3(9.0, 0.5);
  private kickTarget = new THREE.Vector3();
  private impulsePos = new Spring3(5.5, 0.5);
  private breath = 0;
  private moveTilt = new THREE.Vector3();

  /* --- action state --- */
  private action: Action = {
    kind: 'none', t: 0, duration: 0, empty: false, index: 0, committed: false, struck: false,
  };
  private cycleT = 1;
  private cycleDuration = 0.06;
  private triggerPull = new Spring1(22, 0.6);
  private triggerTarget = 0;
  private selector = new Spring1(16, 0.5);
  private selectorTarget = 0;
  private dustCover = 0;
  private bipodOpen = 0;
  private rand = new Rand('viewmodel');

  /* --- scratch --- */
  private readonly _p = new THREE.Vector3();
  private readonly _p2 = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _qTmp = new THREE.Quaternion();
  private readonly _e = new THREE.Euler(0, 0, 0, 'XYZ');
  private readonly _add = new THREE.Vector3();
  private readonly _addRot = new THREE.Vector3();
  private readonly _eye = new THREE.Vector3();
  private readonly _inv = new THREE.Matrix4();

  /**
   * The weapon's own muzzle flash, in view space.
   *
   * The world light pool mirrors a flash into the view-model scene, but it is a
   * shared, budgeted resource: the flash competes with explosions and burning
   * debris for a slot, and when it loses one the weapon is the only thing on
   * screen that does not react to its own shot. So the view model keeps a
   * private emitter, created once and never added or removed — a changing light
   * count recompiles every shader in the scene — and simply modulates it.
   *
   * It lights the receiver, the optic *and* the hands, which is the whole
   * point: the flash washing over a gloved hand is one of the most recognisable
   * images in the genre.
   */
  private flash = new THREE.PointLight(0xffc27a, 0, 2.6, 2);
  private flashT = 0;
  private flashPeak = 0;
  private static readonly FLASH_LIFE = 0.085;

  constructor(private mats: WeaponMaterials) {
    this.root.name = 'viewmodel';
    this.root.matrixAutoUpdate = true;
    this.flash.name = 'vm-muzzle-flash';
    this.flash.castShadow = false;
    this.root.add(this.flash);
  }

  /* ------------------------------------------------------------- equipping */

  /** Rebuilds the mesh for a definition + loadout and recomputes every pose. */
  equip(def: WeaponDef, attachments: readonly AttachmentDef[], stats: ResolvedStats): void {
    this.rig?.dispose();
    this.root.clear();
    const rig = buildWeaponMesh(def, attachments, this.mats);
    this.root.add(rig.root);
    // `clear()` took the emitter with everything else; put it back and sit it
    // just ahead of the crown, where the fireball actually is.
    this.root.add(this.flash);
    const mz = rig.point('muzzle');
    // Full authored muzzle xyz — discarding X/Y put the wash beside the barrel
    // (floating-flash). A small −Z bias keeps the emitter just ahead of the crown.
    this.flash.position.set(
      mz?.x ?? 0,
      mz?.y ?? 0,
      (mz?.z ?? -0.6) - 0.045,
    );
    this.rig = rig;
    this.def = def;
    this.stats = stats;
    this.rand.seed(`viewmodel:${def.id}`);

    const v = def.view;
    this.pHip.set(v.hipPosition[0], v.hipPosition[1], v.hipPosition[2]);
    this.qHip.setFromEuler(this._e.set(
      v.hipRotationDeg[0] * DEG, v.hipRotationDeg[1] * DEG, v.hipRotationDeg[2] * DEG,
    ));
    this.pSprint.set(v.sprintPosition[0], v.sprintPosition[1], v.sprintPosition[2]);
    this.qSprint.setFromEuler(this._e.set(
      v.sprintRotationDeg[0] * DEG, v.sprintRotationDeg[1] * DEG, v.sprintRotationDeg[2] * DEG,
    ));
    this.pLow.set(v.lowReadyPosition[0], v.lowReadyPosition[1], v.lowReadyPosition[2]);
    this.qLow.setFromEuler(this._e.set(
      v.lowReadyRotationDeg[0] * DEG, v.lowReadyRotationDeg[1] * DEG, v.lowReadyRotationDeg[2] * DEG,
    ));

    // ADS: solve for the root position that puts the sight exactly on the eye
    // axis at the weapon's designed eye relief. No rotation — a canted sight is
    // a bug, not a style.
    const sight = rig.point('sight') ?? new THREE.Vector3(0, def.model.sightHeight, -0.08);
    this.qAds.identity();
    this.pAds.set(
      -sight.x + v.adsOffset[0],
      -sight.y + v.adsOffset[1],
      -v.adsDistance - sight.z + v.adsOffset[2],
    );

    this.adsSpring.frequency = 1 / Math.max(0.05, stats.adsTime * 1.35);
    this.adsSpring.damping = 0.62;
    this.kickPos.frequency = def.recoil.viewFrequency;
    this.kickPos.damping = def.recoil.viewDamping;
    this.kickRot.frequency = def.recoil.viewFrequency * 0.92;
    this.kickRot.damping = def.recoil.viewDamping;
    this.cycleDuration = Math.min(0.14, Math.max(0.035, (60 / def.rpm) * 0.55));

    this.selectorTarget = this.selectorAngleFor(def);
    this.selector.value = this.selectorTarget;
    this.bipodOpen = attachments.some((a) => a.build.kind === 'bipod') ? 1 : 0;
    this.resetLayers();
  }

  private selectorAngleFor(def: WeaponDef): number {
    const i = def.fireModes.indexOf(def.defaultFireMode);
    return -(i < 0 ? 0 : i) * 32 * DEG;
  }

  setFireModeIndex(index: number): void {
    this.selectorTarget = -index * 32 * DEG;
    this.startAction('fireMode', 0.28);
  }

  private resetLayers(): void {
    this.swayPos.reset(); this.swayRot.reset();
    this.kickPos.reset(); this.kickRot.reset();
    this.impulsePos.reset();
    this.bob.set(0, 0, 0); this.bobRot.set(0, 0, 0);
    this.kickTarget.set(0, 0, 0);
    this.cycleT = 1;
  }

  get visible(): boolean { return !this.hidden; }
  setVisible(v: boolean): void { this.hidden = !v; this.root.visible = v; }

  /* --------------------------------------------------------------- actions */

  private startAction(kind: ActionKind, duration: number, empty = false): void {
    this.action.kind = kind;
    this.action.t = 0;
    this.action.duration = Math.max(0.01, duration);
    this.action.empty = empty;
    this.action.index = 0;
    this.action.committed = false;
    this.action.struck = false;
  }

  get currentAction(): ActionKind { return this.action.kind; }
  get actionProgress(): number {
    return this.action.kind === 'none' ? 1 : clamp01(this.action.t / this.action.duration);
  }
  get actionRemaining(): number {
    return this.action.kind === 'none' ? 0 : Math.max(0, this.action.duration - this.action.t);
  }

  cancelAction(): void { this.action.kind = 'none'; }

  /**
   * Advances gameplay action clocks (reload / draw / holster / inspect / melee)
   * on the fixed 120 Hz step only. Display `update()` must never call this.
   */
  advanceAction(dt: number): void {
    if (this.action.kind === 'none') return;
    this.action.t += dt;
    if (this.action.t >= this.action.duration && this.action.kind !== 'reloadShell') {
      this.action.kind = 'none';
    }
  }

  /** True once the reload addAmmo beat has fired (cancel window opens at 0 ms). */
  get ammoCommitted(): boolean { return this.action.committed; }

  startReload(empty: boolean, duration: number): void {
    this.startAction('reload', duration, empty);
  }

  /** Shotgun-style: one shell at a time, the sequence loops until told to stop. */
  startShellReload(duration: number): void {
    this.startAction('reloadShell', duration, false);
  }

  startDraw(duration: number): void { this.startAction('draw', duration); }
  startHolster(duration: number): void { this.startAction('holster', duration); }
  startInspect(duration: number): void { this.startAction('inspect', duration); }
  startMelee(duration: number): void { this.startAction('melee', duration); }

  /** Fires the mechanical layers: bolt cycle, trigger, dust cover, kick. */
  onFire(verticalDeg: number, horizontalDeg: number): void {
    const def = this.def;
    if (!def) return;
    const r = def.recoil;
    this.cycleT = 0;
    this.triggerTarget = 1;
    this.dustCover = 1;

    // Back along the bore, up and rolled — magnitudes come from the weapon.
    // The flash is a genuine light source, not a decal: it has to wash the
    // barrel, the handguard and the support hand from *in front*.
    this.flashPeak = 26 + Math.min(18, def.rpm * 0.012);
    this.flashT = ViewModel.FLASH_LIFE;

    const back = r.viewKickBack * (1 - this.ads * 0.45);
    const up = r.viewKickUp * DEG * (1 - this.ads * 0.55);
    const roll = r.viewKickRoll * DEG * (1 - this.ads * 0.6);
    const jitter = this.rand.signed();

    this.kickPos.impulse(
      jitter * back * 0.35,
      back * 0.30 + Math.abs(verticalDeg) * 0.0016,
      back * 26,
    );
    this.kickRot.impulse(
      -(up * 24 + verticalDeg * 0.9),
      horizontalDeg * 1.4 + jitter * up * 3,
      roll * 22 * (jitter > 0 ? 1 : -1),
    );
  }

  /** Suppressed shots make almost no light; the caller knows, the rig does not. */
  setFlashScale(k: number): void { this.flashPeak *= Math.max(0, k); }

  /**
   * Holds the emitter at a fixed brightness for a still. The capture harness
   * settles a shot for the best part of a second, which is ten times a flash's
   * life — so a photograph of a muzzle flash has to be staged, not simulated.
   */
  holdFlash(peak: number): void {
    this.flashPeak = peak;
    this.flashT = ViewModel.FLASH_LIFE;
    this.flash.intensity = peak;
  }

  /** Landing compression; `force` is the impact speed in m/s. */
  land(force: number): void {
    const f = clamp01((force - 2.5) / 12);
    this.impulsePos.impulse(0, -f * 1.6, f * 0.35);
    this.kickRot.impulse(f * 5.5, 0, f * 3.0);
  }

  jump(): void {
    this.impulsePos.impulse(0, 0.55, -0.10);
    this.kickRot.impulse(-2.2, 0, 0);
  }

  /** Called when the player mantles or vaults — timed two-handed pull, not a dead impulse. */
  mantle(): void {
    this.mantleT = 0;
    this.impulsePos.impulse(0.35, -1.6, 0.7);
    this.kickRot.impulse(6, 4, 8);
  }

  /* ---------------------------------------------------------------- update */

  update(dt: number, s: ViewModelState): void {
    const def = this.def;
    const rig = this.rig;
    if (!def || !rig) return;

    /* --- blends ------------------------------------------------------- */
    // ADS overshoots slightly and settles; that tiny bit of extra travel is
    // what makes aiming feel mechanical instead of lerped.
    // First-visible (cat A): when aim intent rises this frame, seed a visible
    // pose fraction immediately so ADS is not waiting on the spring alone.
    if (s.ads > 0.5 && this.adsSpring.value < 0.05) {
      this.adsSpring.value = Math.max(this.adsSpring.value, 0.18);
      this.adsSpring.velocity = Math.max(this.adsSpring.velocity, 2.4);
    } else if (s.ads < 0.5 && this.adsSpring.value > 0.95) {
      // Same for drop-out — hip is acknowledged on this display frame.
      this.adsSpring.value = Math.min(this.adsSpring.value, 0.82);
      this.adsSpring.velocity = Math.min(this.adsSpring.velocity, -2.0);
    }
    const adsRaw = this.adsSpring.step(s.ads, dt);
    this.ads = THREE.MathUtils.clamp(adsRaw, -0.08, 1.12);
    const sprintRate = s.sprint > this.sprint
      ? 1 / Math.max(0.04, def.handling.sprintIn)
      : 1 / Math.max(0.04, this.stats?.sprintOut ?? def.handling.sprintOut);
    const slideTarget = Math.max(0, Math.min(1, s.slide ?? 0));
    // Slide is not sprint: drop out of sprint blend when sliding so the
    // dedicated low-gun pose can take over.
    const sprintTarget = slideTarget > 0.5 ? 0 : s.sprint;
    this.sprint = approach(this.sprint, sprintTarget, sprintRate, dt);
    this.slideW = approach(this.slideW, slideTarget, 14, dt);
    this.crouchW = approach(this.crouchW, Math.max(0, Math.min(1, s.crouch)) * (1 - this.slideW), 10, dt);
    this.lowReady = approach(this.lowReady, s.lowReady, 14, dt);

    const busy = this.action.kind === 'reload' || this.action.kind === 'reloadShell'
      || this.action.kind === 'melee' || this.action.kind === 'inspect';
    const adsW = busy ? this.ads * 0.15 : this.ads;
    const sprintW = this.sprint * (1 - adsW) * (1 - this.slideW);
    const slideW = this.slideW * (1 - adsW);
    const crouchW = this.crouchW * (1 - adsW) * (1 - slideW) * (1 - sprintW);
    const lowW = this.lowReady * (1 - adsW) * (1 - sprintW) * (1 - slideW);

    /* --- base pose ---------------------------------------------------- */
    this._p.copy(this.pHip).lerp(this.pAds, adsW);
    this._q.copy(this.qHip).slerp(this.qAds, adsW);
    this._p.lerp(this.pSprint, sprintW);
    this._q.slerp(this.qSprint, sprintW);
    // Slide: gun lower and more forward than sprint tuck, slight roll into the dive.
    if (slideW > 0.001) {
      this._p.x += 0.04 * slideW;
      this._p.y += -0.12 * slideW;
      this._p.z += 0.08 * slideW;
      this._e.set(18 * DEG * slideW, -8 * DEG * slideW, -14 * DEG * slideW);
      this._q.multiply(this._qTmp.setFromEuler(this._e));
    }
    // Crouch: subtle drop + nose-up so hip-fire from crouch reads distinct.
    if (crouchW > 0.001) {
      this._p.y += -0.045 * crouchW;
      this._p.z += 0.02 * crouchW;
      this._e.set(6 * DEG * crouchW, 0, 0);
      this._q.multiply(this._qTmp.setFromEuler(this._e));
    }
    this._p.lerp(this.pLow, lowW);
    this._q.slerp(this.qLow, lowW);

    // Timed mantle pull: plant → haul → settle over ~0.42 s.
    if (this.mantleT >= 0) {
      this.mantleT += dt;
      const u = Math.min(1, this.mantleT / 0.42);
      const haul = u < 0.45
        ? (u / 0.45)
        : 1 - ((u - 0.45) / 0.55);
      const pull = haul * haul * (3 - 2 * haul);
      this._p.y += -0.18 * pull;
      this._p.z += 0.12 * pull;
      this._p.x += 0.05 * pull;
      this._e.set(22 * DEG * pull, 10 * DEG * pull, 14 * DEG * pull);
      this._q.multiply(this._qTmp.setFromEuler(this._e));
      if (u >= 1) this.mantleT = -1;
    }

    /* --- weapon bob: a figure-8 on the footstep phase ------------------ */
    const bobScale = settings.game.weaponBob * def.view.bobScale
      * s.speed01 * (1 - adsW * 0.78) * (s.grounded ? 1 : 0.25);
    const phase = s.stepPhase * Math.PI * 2;
    const massLag = 1 / (0.8 + def.handling.mass * 0.05);
    const bx = Math.sin(phase) * 0.0165 * bobScale;
    const by = -Math.abs(Math.cos(phase)) * 0.0135 * bobScale;
    const bz = Math.sin(phase * 2) * 0.0060 * bobScale;
    this.bob.x = approach(this.bob.x, bx, 15 * massLag, dt);
    this.bob.y = approach(this.bob.y, by, 15 * massLag, dt);
    this.bob.z = approach(this.bob.z, bz, 15 * massLag, dt);
    this.bobRot.z = approach(this.bobRot.z, Math.sin(phase) * 1.9 * DEG * bobScale, 13 * massLag, dt);
    this.bobRot.x = approach(this.bobRot.x, Math.cos(phase * 2) * 1.0 * DEG * bobScale, 13 * massLag, dt);
    this.bobRot.y = approach(this.bobRot.y, Math.sin(phase + 1.1) * 1.4 * DEG * bobScale, 13 * massLag, dt);

    /* --- idle sway: noise-driven breathing ----------------------------- */
    this.breath += dt * (0.42 + s.speed01 * 0.55);
    const breathAmp = (1 - s.speed01 * 0.6) * (1 - adsW * 0.62) * def.view.swayScale;
    const swayX = fbm1(this.breath * 0.83) * 0.0042 * breathAmp;
    const swayY = fbm1(this.breath * 0.61 + 17.3) * 0.0034 * breathAmp;
    const swayRz = fbm1(this.breath * 0.47 + 51.9) * 1.1 * DEG * breathAmp;

    /* --- look sway: the weapon lags behind the mouse -------------------- */
    const lagScale = def.view.swayScale * (1 - adsW * 0.72) * massLag;
    const dx = THREE.MathUtils.clamp(s.lookDX, -60, 60);
    const dy = THREE.MathUtils.clamp(s.lookDY, -60, 60);
    this.swayTargetPos.set(
      THREE.MathUtils.clamp(-dx * 0.00055, -0.045, 0.045) * lagScale + swayX,
      THREE.MathUtils.clamp(-dy * 0.00045, -0.035, 0.035) * lagScale + swayY,
      0,
    );
    this.swayTargetRot.set(
      THREE.MathUtils.clamp(dy * 0.0016, -0.14, 0.14) * lagScale,
      THREE.MathUtils.clamp(dx * 0.0020, -0.18, 0.18) * lagScale,
      THREE.MathUtils.clamp(-dx * 0.0016, -0.14, 0.14) * lagScale + swayRz,
    );
    this.swayPos.step(this.swayTargetPos, dt);
    this.swayRot.step(this.swayTargetRot, dt);

    /* --- movement tilt: the weapon leans into a strafe ------------------ */
    const tiltScale = (1 - adsW * 0.6) * (1 - sprintW);
    this.moveTilt.x = approach(this.moveTilt.x, -s.forward * 0.9 * DEG * tiltScale, 7, dt);
    this.moveTilt.z = approach(this.moveTilt.z, -s.strafe * 2.4 * DEG * tiltScale, 7, dt);
    this.moveTilt.y = approach(this.moveTilt.y, s.strafe * 1.2 * DEG * tiltScale, 7, dt);

    /* --- muzzle flash ---------------------------------------------------- */
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      // Instant attack, quadratic fall: the shape of a real powder flash.
      const u = this.flashT / ViewModel.FLASH_LIFE;
      this.flash.intensity = this.flashPeak * u * u;
    } else if (this.flash.intensity !== 0) {
      this.flash.intensity = 0;
    }

    /* --- springs -------------------------------------------------------- */
    this.kickPos.step(ZERO, dt);
    this.kickRot.step(ZERO, dt);
    this.impulsePos.step(ZERO, dt);

    /* --- action layer (pose only — clock advances in fixedUpdate) -------- */
    this._add.set(0, 0, 0);
    this._addRot.set(0, 0, 0);
    if (this.action.kind !== 'none') {
      // action.t is owned by fixedUpdate via advanceAction(); here we only
      // re-evaluate the pose for the current sim time so display framerate
      // cannot stretch reload/draw/melee clocks.
      this.evaluateAction(this.action.t / this.action.duration, s);
    }
    this.applyParts(dt, s);

    /* --- compose --------------------------------------------------------- */
    // Kick is weapon-local (it follows the bore); sway and bob are view-space.
    this._p2.copy(this.kickPos.value).applyQuaternion(this._q);
    this._p.add(this._p2);
    this._p.add(this.bob);
    this._p.add(this.swayPos.value);
    this._p.add(this.impulsePos.value);
    this._p.add(this._add);

    this._e.set(
      this.kickRot.value.x * DEG + this.bobRot.x + this.swayRot.value.x + this.moveTilt.x + this._addRot.x,
      this.kickRot.value.y * DEG + this.bobRot.y + this.swayRot.value.y + this.moveTilt.y + this._addRot.y,
      this.kickRot.value.z * DEG + this.bobRot.z + this.swayRot.value.z + this.moveTilt.z + this._addRot.z,
    );
    this._q2.setFromEuler(this._e);
    this._q.multiply(this._q2);

    this.root.position.copy(this._p);
    this.root.quaternion.copy(this._q);

    this.updateReticle();
  }

  /**
   * Collimates the optic's reticle.
   *
   * A reflex sight projects its dot to infinity: the ray from the eye through
   * the dot is always parallel to the optical axis, whatever the eye is doing.
   * The view model is authored in view space with the eye at the origin, so
   * "the eye's position expressed in optic space" *is* the lateral offset the
   * dot needs — two lines, and the sight then behaves exactly like the real
   * thing: dead centre when the head is behind it, sliding across the glass
   * and vignetting out as the weapon swings.
   *
   * The quad is also rescaled by eye distance each frame so the mark holds a
   * constant angular size; that is what stops the reticle ballooning as the
   * ADS blend pulls the sight toward the camera.
   */
  private updateReticle(): void {
    const ret = this.rig?.reticle;
    if (!ret) return;
    const host = this.rig?.node(ret.parent) ?? this.root;
    host.updateWorldMatrix(true, false);
    this._inv.copy(host.matrixWorld).invert();
    // The view-model camera sits at the origin of the view-model scene.
    this._eye.set(0, 0, 0).applyMatrix4(this._inv);

    const dz = this._eye.z - ret.planeZ;
    if (dz <= 1e-4) { setReticleFade(ret.mesh, 0); return; }

    ret.mesh.position.set(this._eye.x, this._eye.y, ret.planeZ);
    ret.mesh.rotation.set(0, 0, 0);
    const size = Math.max(1e-4, dz * Math.tan(ret.halfAngle));
    ret.mesh.scale.set(size, size, size);

    // Out past the window edge the dot is behind the tube wall, which is what
    // a real optic does; a soft vignette avoids a hard pop at the boundary.
    const off = Math.hypot(this._eye.x, this._eye.y - ret.axisY);
    const edge = 1 - clamp01((off - ret.window * 0.55) / Math.max(1e-4, ret.window * 0.55));
    // The dot is only worth drawing when the shooter is actually behind it.
    const aimed = clamp01(this.ads * 1.35 - 0.12);
    setReticleFade(ret.mesh, edge * (0.16 + aimed * 0.84));
  }

  /** Current ADS blend, for the HUD and the camera FOV. */
  get adsBlend(): number { return clamp01(this.ads); }

  /* ---------------------------------------------------------- part motion */

  private applyParts(dt: number, s: ViewModelState): void {
    const rig = this.rig;
    const def = this.def;
    if (!rig || !def) return;

    // Trigger returns as soon as the shot is away.
    this.triggerTarget = approach(this.triggerTarget, 0, 26, dt);
    const trig = this.triggerPull.step(this.triggerTarget, dt);
    const trigger = rig.node('trigger');
    if (trigger) trigger.rotation.x = -trig * 16 * DEG;

    // Selector switch.
    const sel = this.selector.step(this.selectorTarget, dt);
    const selector = rig.node('selector');
    if (selector) selector.rotation.x = sel;

    // Action cycling: back fast, forward slower, then a hard stop.
    if (this.cycleT < 1) this.cycleT = Math.min(1, this.cycleT + dt / this.cycleDuration);
    const locked = s.boltLocked && this.action.kind !== 'reload';
    const cyc = locked ? 1 : curve(this.cycleT, [[0, 0], [0.34, 1], [0.86, 0], [1, 0]]);
    const travel = this.actionTravel(def);

    const bolt = rig.node('bolt');
    if (bolt) bolt.position.z = cyc * travel;
    const slide = rig.node('slide');
    if (slide) slide.position.z = cyc * travel;
    const pump = rig.node('pump');
    if (pump) pump.position.z = cyc * travel * 0.9;
    const charging = rig.node('charging');
    if (charging && def.model.action !== 'boltAction') charging.position.z = cyc * travel * 0.8;

    // Dust cover flips open on the first shot and stays open.
    this.dustCover = approach(this.dustCover, this.dustCover > 0.5 ? 1 : 0, 18, dt);
    const cover = rig.node('dustCover');
    if (cover) cover.rotation.z = -this.dustCover * 78 * DEG;

    // Bipod legs.
    const bipod = rig.node('bipod');
    if (bipod) bipod.rotation.x = (1 - this.bipodOpen) * 78 * DEG;

    // Belt sags a little with the bob so it does not look welded on.
    const belt = rig.node('belt');
    if (belt) {
      belt.rotation.z = Math.sin(this.breath * 2.1) * 2.5 * DEG * (0.3 + s.speed01);
      belt.position.y = this.bob.y * 0.6;
    }

    // Shell held mid-reload — hidden unless a shell reload is running.
    const shell = rig.node('shell');
    if (shell && this.action.kind !== 'reloadShell') shell.visible = false;

    // The support hand leaves the handguard to fetch a magazine and comes back
    // with it. A hand welded to the forend through a magazine change is the
    // loudest possible statement that the arms are a prop bolted to the gun.
    const left = rig.node('handLeft');
    if (left) {
      const rest = rig.rest.get('handLeft');
      if (rest) left.position.copy(rest);
      left.rotation.set(0, 0, 0);
      let reach = 0;
      if (this.action.kind === 'reload') {
        const t = clamp01(this.action.t / this.action.duration);
        const r = def.reload;
        reach = curve(t, [
          [r.magOut - 0.06, 0], [r.magOut + 0.10, 1], [r.magSeat - 0.06, 1], [r.magSeat + 0.12, 0],
        ]);
      } else if (this.action.kind === 'reloadShell') {
        reach = curve(this.action.t / Math.max(0.01, def.reload.shellIn ?? 0.34), [[0, 0], [1, 1]]);
      }
      if (reach > 0.001) {
        // Down and back toward the magwell, rolling the wrist as it goes.
        left.position.x -= reach * 0.055;
        left.position.y -= reach * 0.135;
        left.position.z += reach * 0.150;
        left.rotation.x = reach * 0.55;
        left.rotation.z = -reach * 0.42;
      }
    }
  }

  private actionTravel(def: WeaponDef): number {
    switch (def.model.action) {
      case 'boltAction': return 0.055;
      case 'pump': case 'tube': return 0.048;
      case 'beltFed': return 0.030;
      default: return def.cls === 'pistol' ? 0.030 : 0.024;
    }
  }

  /* -------------------------------------------------------- action curves */

  private evaluateAction(t01: number, s: ViewModelState): void {
    const t = clamp01(t01);
    switch (this.action.kind) {
      case 'reload': this.evalReload(t); break;
      case 'reloadShell': this.evalShellReload(); break;
      case 'draw': this.evalDraw(t); break;
      case 'holster': this.evalHolster(t); break;
      case 'inspect': this.evalInspect(t); break;
      case 'melee': this.evalMelee(t); break;
      case 'fireMode': this.evalFireMode(t); break;
      default: break;
    }
    void s;
  }

  /**
   * Magazine change. The body motion and the part motion are authored on the
   * same normalised timeline, so a 1.3 s pistol reload and a 5 s LMG reload use
   * one set of curves and still read correctly.
   */
  private evalReload(t: number): void {
    const def = this.def!;
    const rig = this.rig!;
    const r = def.reload;
    const empty = this.action.empty;

    // Body: cant in toward the support hand, dip, then return with a settle.
    // Body: the weapon comes *in* toward the centre of the screen and cants
    // over, rather than dropping out of frame. A reload is a hero moment; if
    // the player cannot see the magazine change there is no animation.
    const dip = curve(t, [[0, 0], [0.16, 1], [0.66, 1], [0.93, 0.06], [1, 0]]);
    this._add.x += -0.062 * dip;
    // *Up*, not down. The magazine well is the lowest thing on the weapon, and
    // a reload that drops the gun puts the one moving part below the frame —
    // which is the difference between an animation and a wobble.
    this._add.y += 0.026 * dip;
    this._add.z += 0.052 * dip;
    this._addRot.x += -9 * DEG * dip;
    this._addRot.y += 15 * DEG * dip;
    this._addRot.z += 27 * DEG * dip;

    // Magazine slap and bolt release both punch the whole weapon.
    const slap = ring((t - r.magSeat) / 0.10, 1.1, 6.5);
    this._add.y += slap * 0.012;
    this._addRot.x += slap * 4 * DEG;
    if (empty) {
      const rel = ring((t - r.boltRelease) / 0.09, 1.3, 7.5);
      this._add.z += rel * 0.010;
      this._addRot.x += rel * 3.4 * DEG;
    }

    const mag = rig.node('magazine');
    if (mag) {
      const rest = rig.rest.get('magazine');
      if (rest) mag.position.copy(rest);
      if (t < (r.magIn + r.magOut) * 0.5) {
        // Old magazine falls free.
        const drop = curveLinear(t, [[r.magOut, 0], [r.magOut + 0.16, 1]]);
        mag.position.y -= drop * 0.34;
        mag.position.z += drop * 0.05;
        mag.rotation.x = drop * 0.75;
        mag.visible = drop < 0.985;
      } else {
        // Fresh magazine is offered up and seated.
        const up = curve(t, [[r.magIn, 0], [r.magSeat, 1]]);
        mag.visible = t > r.magIn - 0.03;
        mag.position.y -= (1 - up) * 0.30;
        mag.position.x += (1 - up) * 0.030;
        mag.position.z += (1 - up) * 0.014;
        mag.rotation.x = (1 - up) * -0.42;
        mag.rotation.z = (1 - up) * 0.22;
      }
    }

    if (empty) {
      // Bolt sits back until the release, then slams home.
      const home = curveLinear(t, [[r.boltRelease, 0], [r.boltRelease + 0.045, 1]]);
      const travel = this.actionTravel(def);
      const bolt = rig.node('bolt');
      if (bolt) bolt.position.z = (1 - home) * travel;
      const charging = rig.node('charging');
      if (charging) charging.position.z = (1 - home) * travel * 0.8;
      const slide = rig.node('slide');
      if (slide) slide.position.z = (1 - home) * travel;
      // The support hand slaps the bolt catch: a small extra dip.
      this._addRot.z += curve(t, [[r.boltRelease - 0.08, 0], [r.boltRelease, 1], [r.boltRelease + 0.10, 0]]) * 6 * DEG;
    }

    // Belt-fed guns lift the feed cover instead of dropping a magazine.
    const cover = rig.node('cover');
    if (cover) {
      cover.rotation.x = curve(t, [
        [r.magOut - 0.06, 0], [r.magOut + 0.04, -0.9], [r.magSeat - 0.02, -0.9], [r.magSeat + 0.08, 0],
      ]);
    }

    // The launcher's warhead only exists once it has been loaded.
    const rocket = rig.node('rocket');
    if (rocket) {
      const load = curve(t, [[r.magIn, 0], [r.magSeat, 1]]);
      rocket.visible = t > r.magIn;
      rocket.position.z -= (1 - load) * 0.30;
      rocket.position.y -= (1 - load) * 0.05;
    }
  }

  /** Shotgun: a start-up, a repeating shell insert, and a close-up. */
  private evalShellReload(): void {
    const def = this.def!;
    const rig = this.rig!;
    const per = def.reload.perShell ?? 0.42;
    const startT = def.reload.shellIn ?? 0.34;

    const t = this.action.t;
    if (t < startT) {
      const u = t / startT;
      const dip = curve(u, [[0, 0], [1, 1]]);
      this.shellBody(dip);
      return;
    }
    const loop = (t - startT) % per;
    const u = loop / per;
    this.shellBody(1);

    const shell = rig.node('shell');
    if (shell) {
      const rest = rig.rest.get('shell');
      if (rest) shell.position.copy(rest);
      const feed = curve(u, [[0.05, 0], [0.55, 1], [0.7, 1]]);
      shell.visible = u > 0.03 && u < 0.72;
      shell.position.x += (1 - feed) * 0.10;
      shell.position.y -= (1 - feed) * 0.06;
      shell.position.z += (1 - feed) * 0.05;
      shell.rotation.y = (1 - feed) * 0.9;
    }
    const lifter = rig.node('lifter');
    if (lifter) lifter.rotation.x = -curve(u, [[0.5, 0], [0.62, 0.55], [0.8, 0]]);

    // Each shell insert punches the weapon slightly.
    const punch = ring((u - 0.58) / 0.14, 1.0, 6.0);
    this._addRot.x += punch * 2.6 * DEG;
    this._add.y += punch * 0.006;
  }

  private shellBody(k: number): void {
    this._add.x += -0.046 * k;
    this._add.y += 0.020 * k;
    this._add.z += 0.040 * k;
    this._addRot.x += -8 * DEG * k;
    this._addRot.y += 16 * DEG * k;
    this._addRot.z += 21 * DEG * k;
  }

  /** Finish a shell reload: pump/charge the action and return to the ready. */
  finishShellReload(): void {
    if (this.action.kind !== 'reloadShell') return;
    this.action.kind = 'none';
    this.cycleT = 0;
    const rig = this.rig;
    const shell = rig?.node('shell');
    if (shell) shell.visible = false;
    this.kickRot.impulse(3.5, 0, 2.0);
  }

  private evalDraw(t: number): void {
    // Up from below and to the right, overshooting the ready pose slightly.
    const k = 1 - curve(t, [[0, 0], [0.72, 1.06], [1, 1]]);
    this._add.x += 0.075 * k;
    this._add.y += -0.240 * k;
    this._add.z += 0.070 * k;
    this._addRot.x += -34 * DEG * k;
    this._addRot.y += 26 * DEG * k;
    this._addRot.z += 16 * DEG * k;
    // The bolt rides home as the weapon comes up.
    const rig = this.rig;
    const bolt = rig?.node('bolt');
    if (bolt) bolt.position.z = curve(t, [[0.25, 0], [0.45, 1], [0.62, 0]]) * this.actionTravel(this.def!);
  }

  private evalHolster(t: number): void {
    const k = curve(t, [[0, 0], [1, 1]]);
    this._add.x += 0.070 * k;
    this._add.y += -0.260 * k;
    this._add.z += 0.060 * k;
    this._addRot.x += -38 * DEG * k;
    this._addRot.y += 24 * DEG * k;
    this._addRot.z += 14 * DEG * k;
  }

  /**
   * Inspect: bring the weapon in, roll it left to read the receiver, tip it to
   * check the magazine, then return. Six seconds of animation from nine keys.
   */
  private evalInspect(t: number): void {
    const rig = this.rig!;
    const pull = curve(t, [[0, 0], [0.12, 1], [0.86, 1], [1, 0]]);
    // Inspect also draws the weapon toward the centre so it is actually on screen.
    this._add.x += -0.055 * pull;
    const roll = curve(t, [
      [0.08, 0], [0.26, 1], [0.44, 1], [0.58, -0.75], [0.74, -0.75], [0.90, 0],
    ]);
    const tip = curve(t, [[0.10, 0], [0.32, 0.5], [0.50, 1], [0.68, 0.2], [0.88, 0]]);

    this._add.x += -0.035 * pull;
    this._add.y += -0.010 * pull + 0.020 * tip;
    this._add.z += 0.085 * pull;
    this._addRot.x += (-6 * pull + 18 * tip) * DEG;
    this._addRot.y += (34 * roll) * DEG;
    this._addRot.z += (-26 * roll + 10 * tip) * DEG;

    // Charging handle gets tugged back to check the chamber.
    const tug = curve(t, [[0.50, 0], [0.60, 1], [0.70, 0]]);
    const charging = rig.node('charging');
    if (charging) charging.position.z = tug * this.actionTravel(this.def!) * 1.4;
    const bolt = rig.node('bolt');
    if (bolt) bolt.position.z = tug * this.actionTravel(this.def!) * 1.4;
  }

  /** Melee: wind up, drive the stock forward-left, recover. */
  private evalMelee(t: number): void {
    const wind = curve(t, [[0, 0], [0.22, 1], [0.34, 0]]);
    const thrust = curve(t, [[0.24, 0], [0.42, 1], [0.62, 0.55], [1, 0]]);
    this._add.x += 0.055 * wind - 0.130 * thrust;
    this._add.y += -0.020 * wind + 0.055 * thrust;
    this._add.z += 0.080 * wind - 0.230 * thrust;
    this._addRot.x += (10 * wind - 26 * thrust) * DEG;
    this._addRot.y += (-16 * wind + 38 * thrust) * DEG;
    this._addRot.z += (18 * wind - 30 * thrust) * DEG;
  }

  private evalFireMode(t: number): void {
    const k = curve(t, [[0, 0], [0.35, 1], [1, 0]]);
    this._addRot.z += 7 * DEG * k;
    this._add.y += -0.008 * k;
  }

  /* ------------------------------------------------------------- queries */

  /** True at the exact frame a timed event inside the action fires. */
  consumeCommit(at: number): boolean {
    if (this.action.kind === 'none' || this.action.committed) return false;
    if (this.action.t / this.action.duration >= at) { this.action.committed = true; return true; }
    return false;
  }

  consumeStrike(at: number): boolean {
    if (this.action.kind !== 'melee' || this.action.struck) return false;
    if (this.action.t / this.action.duration >= at) { this.action.struck = true; return true; }
    return false;
  }

  /** Shells inserted so far in a running shell reload. */
  shellsInserted(): number {
    if (this.action.kind !== 'reloadShell') return 0;
    const def = this.def!;
    const per = def.reload.perShell ?? 0.42;
    const startT = def.reload.shellIn ?? 0.34;
    if (this.action.t < startT) return 0;
    return Math.floor((this.action.t - startT) / per);
  }

  /** Whether the current shell-insert beat has just landed. */
  shellBeat(): boolean {
    if (this.action.kind !== 'reloadShell') return false;
    const def = this.def!;
    const per = def.reload.perShell ?? 0.42;
    const startT = def.reload.shellIn ?? 0.34;
    if (this.action.t < startT) return false;
    const n = Math.floor((this.action.t - startT) / per);
    if (n >= this.action.index && (this.action.t - startT) % per > per * 0.58) {
      this.action.index = n + 1;
      return true;
    }
    return false;
  }

  /** World-space muzzle position, given the camera the view model is drawn with. */
  muzzleWorld(camera: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    const local = this.rig?.point('muzzle');
    if (!local || !this.rig) return out.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    out.copy(local);
    this.rig.root.localToWorld(out);
    return out.applyMatrix4(camera.matrixWorld);
  }

  /** World-space ejection-port position. */
  ejectWorld(camera: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    const local = this.rig?.point('eject');
    if (!local || !this.rig) return out.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    out.copy(local);
    this.rig.root.localToWorld(out);
    return out.applyMatrix4(camera.matrixWorld);
  }

  dispose(): void {
    this.rig?.dispose();
    this.rig = null;
    this.root.clear();
  }
}
