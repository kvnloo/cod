/**
 * AudioSystem — synthesised 3D audio for the whole game.
 *
 * Everything you hear is generated: there is not one audio file in the
 * repository. The system is a pure listener on the event bus — no gameplay code
 * knows it exists — and it owns:
 *
 *   Mixer          category buses, multi-band glue, master limiter, HDR ducking,
 *                  and the "deafness" path a flashbang drags the mix through
 *   ReverbRack     convolution zones with procedurally generated impulses,
 *                  crossfaded as the listener moves
 *   VoicePool      pooled HRTF channel strips with air absorption, occlusion
 *                  and distance-decoupled reverb sends
 *   SoundBank      modal-synthesised impacts, footsteps, casings and gear
 *   Ambience       continuous bed plus an adaptive tension score
 *
 * Scheduling: listener and zone updates happen in `update()` (presentation
 * rate); everything else is event-driven, scheduled on the Web Audio clock so
 * it is sample-accurate regardless of frame rate.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import { SURFACES, type SurfaceType } from '../core/Surfaces';
import { MASK_SIGHT, type PhysicsAPI } from '../physics/types';

import type { AudioAPI, AudioStats, BusName, ImpulseId, OcclusionProbe, ReverbZoneDesc, Gait } from './types';
import type { SfxContext } from './Context';
import { Mixer } from './Mixer';
import { ReverbRack } from './ReverbZones';
import { VoicePool } from './Voices';
import { SoundBank } from './Bank';
import { Ambience } from './Ambience';
import { Tinnitus, playChatter, playFlashbangOnset, playGrunt, playHeartbeat } from './Vocals';
import { clamp, clamp01, lerp } from './Dsp';
import {
  createWeaponState, playDryFire, playShot, playWhizzBy, profileFor, type WeaponSoundState,
} from './WeaponSounds';
import {
  playCasing, playExplosion, playFleshHit, playGlassShatter, playGrenadeBounce,
  playGrenadePin, playImpact, playPhysicsImpact, playRicochet, playWaterEntry,
} from './Impacts';
import {
  playAds, playFootstep, playGearRustle, playLanding, playMantle, playOverheat,
  playReload, playSlide, playWeaponSwitch, type ReloadHandle, type SlideHandle,
} from './Foley';
import { playReward, playUi, type UiSound } from './Ui';
import type { UiCue } from '../ui/UiEvents';

import './DebugScene';

/** Maps HUD/menu `ui:sound` cues onto the synthesised UiSound bank. */
const UI_CUE_TO_SOUND: Partial<Record<UiCue, UiSound>> = {
  hit: 'hitmarker',
  hitArmor: 'hitmarkerArmor',
  hitCrit: 'hitmarkerHead',
  hitKill: 'kill',
  streakReady: 'killstreak',
  xp: 'pickup',
  objective: 'objective',
  alarm: 'error',
  lowAmmo: 'lowAmmo',
  menuMove: 'hover',
  menuSelect: 'select',
  menuBack: 'back',
  menuOpen: 'select',
  menuClose: 'back',
  promptComplete: 'notify',
};

/** Default acoustic zoning until the level publishes its own. */
const DEFAULT_FALLBACK: ImpulseId = 'streetCanyon';

interface Pending {
  at: number;
  fn: () => void;
}

export class AudioSystem implements System, AudioAPI {
  readonly name = 'audio';
  readonly order = ORDER.AUDIO;

  ready = false;

  private ctx: AudioContext | null = null;
  private mixer!: Mixer;
  private reverb!: ReverbRack;
  private pool!: VoicePool;
  private bank!: SoundBank;
  private ambience!: Ambience;
  private tinnitus!: Tinnitus;
  private weapons!: WeaponSoundState;
  private sfx!: SfxContext;
  private rand = new Rand('audio');

  private physics: PhysicsAPI | null = null;
  private cheap = false;
  private failed = false;

  /* --- listener ------------------------------------------------------- */
  private readonly _fwd = new THREE.Vector3(0, 0, -1);
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _from = new THREE.Vector3();
  private readonly _to = new THREE.Vector3();
  private readonly _tmp = new THREE.Vector3();
  private listenerPos = new THREE.Vector3();

  /* --- gameplay state mirrored from bus events ------------------------ */
  private gait: Gait = 'walk';
  private footIndex = 0;
  private health = 100;
  private maxHealth = 100;
  private alive = true;
  private slide: SlideHandle | null = null;
  private reload: ReloadHandle | null = null;
  private currentWeapon = 'ar';
  private ads = false;
  private lastFootstepAt = 0;
  private heartbeatAt = 0;
  private breathAt = 0;
  private pending: Pending[] = [];
  private tensionExternal = -1;
  private cpuMs = 0;
  private disposers: Array<() => void> = [];
  private started = false;
  private zones: ReverbZoneDesc[] = [];
  private zoneFallback: ImpulseId = DEFAULT_FALLBACK;
  /** Last known world positions for AI agents (from fire/voice) for spatial VO. */
  private readonly aiLastPos = new Map<number, THREE.Vector3>();

  /* ------------------------------------------------------------- init -- */

  async init(ctx: EngineContext): Promise<void> {
    this.physics = ctx.engine.tryGet<System & PhysicsAPI>('physics') ?? null;
    this.cheap = settings.preset === 'low';

    try {
      const Ctor = (globalThis as unknown as {
        AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext;
      }).AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio unavailable');
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      // A machine with no audio device must not take the game down with it.
      console.warn('[audio] Web Audio unavailable; running silent', err);
      this.failed = true;
      this.subscribeNoop();
      return;
    }

    const audio = this.ctx;
    // The bank outlives graph rebuilds: its buffers belong to the context, not
    // to the mixer, and re-baking 130 of them on a preset change would hitch.
    this.bank = new SoundBank(audio, {
      variants: this.cheap ? 2 : 4,
      lengthScale: this.cheap ? 0.65 : 1,
    });
    this.buildGraph();

    const warm = this.bank.warmup();
    if (warm.ms > 40) console.info(`[audio] baked ${warm.built} buffers in ${warm.ms.toFixed(0)}ms`);

    this.subscribe();
    this.installGestureResume();
    this.ready = true;
  }

  /**
   * Builds (or rebuilds) the live audio graph for the current quality preset.
   *
   * Separate from `init` because `main.ts` auto-detects the preset *after*
   * systems have initialised: on a low-end machine the graph is first built as
   * `ultra` and then has to be swapped for the cheap one. Rebuilding is a few
   * dozen node allocations and is only ever triggered by a preset change.
   */
  private buildGraph(): void {
    const audio = this.ctx!;
    this.mixer = new Mixer(audio, audio.destination, this.cheap);
    this.reverb = new ReverbRack(audio, this.mixer, {
      cheap: this.cheap,
      lengthScale: this.cheap ? 0.5 : settings.preset === 'medium' ? 0.8 : 1,
      densityScale: this.cheap ? 0.45 : 1,
    });
    this.pool = new VoicePool(audio, this.mixer, this.reverb);
    this.weapons = createWeaponState(audio, this.mixer, this.cheap);
    this.tinnitus = new Tinnitus(audio, this.mixer);

    this.sfx = {
      ctx: audio,
      mixer: this.mixer,
      pool: this.pool,
      reverb: this.reverb,
      bank: this.bank,
      rand: this.rand,
      cheap: this.cheap,
      now: () => audio.currentTime,
    };

    this.ambience = new Ambience(this.sfx, {
      cheap: this.cheap,
      onDistantShot: (x, y, z, id) => {
        playShot(this.sfx, this.weapons, { weaponId: id, x, y, z, gain: 0.85 });
      },
    });

    this.pool.setOcclusionProbe(this.makeProbe());
    this.reverb.setZones(this.zones, this.zoneFallback);
    this.weapons.tails.setImpulse(this.reverb.activeIr);
    if (this.started) this.ambience.start();
  }

  /** Swaps the graph when the preset crosses the cheap/expensive boundary. */
  private onQualityChanged(): void {
    if (this.failed || !this.ctx) return;
    const nowCheap = settings.preset === 'low';
    if (nowCheap === this.cheap) { this.mixer.applySettings(); return; }
    this.slide?.stop();
    this.slide = null;
    this.reload?.cancel();
    this.reload = null;
    this.pending.length = 0;
    this.ambience.dispose();
    this.tinnitus.dispose();
    this.weapons.tails.dispose();
    this.pool.dispose();
    this.reverb.dispose();
    this.mixer.dispose();
    this.cheap = nowCheap;
    this.buildGraph();
    this.mixer.applySettings();
    console.info(`[audio] rebuilt graph for preset "${settings.preset}"`);
  }

  /* --------------------------------------------------------- occlusion -- */

  /**
   * Five rays from the listener to the source. Sampling the neighbourhood
   * rather than a single line separates "behind a lamp post" from "in the next
   * room"; it costs four extra casts per *sound trigger*, not per frame.
   */
  private makeProbe(): OcclusionProbe {
    const offsets: Array<[number, number, number]> = this.cheap
      ? [[0, 0, 0]]
      : [[0, 0, 0], [0.45, 0.3, 0], [-0.45, 0.3, 0], [0, -0.5, 0.35], [0, 0.55, -0.35]];
    return (fx, fy, fz, tx, ty, tz) => {
      const phys = this.physics;
      if (!phys || !phys.ready) return 0;
      let blocked = 0;
      for (const [ox, oy, oz] of offsets) {
        this._from.set(fx, fy, fz);
        this._to.set(tx + ox, ty + oy, tz + oz);
        if (!phys.lineOfSight(this._from, this._to, MASK_SIGHT)) blocked++;
      }
      return blocked / offsets.length;
    };
  }

  /* ------------------------------------------------------------ update -- */

  update(dt: number, ectx: EngineContext): void {
    if (!this.ctx || this.failed) return;
    const t0 = performance.now();
    const audio = this.ctx;
    const running = audio.state === 'running';

    // Listener follows the render camera exactly; Web Audio's own listener
    // smoothing is what keeps a fast mouse flick from zippering the HRTF.
    const cam = ectx.camera;
    cam.getWorldPosition(this.listenerPos);
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.pool.setListener(
      this.listenerPos.x, this.listenerPos.y, this.listenerPos.z,
      this._fwd.x, this._fwd.y, this._fwd.z,
      this._up.x, this._up.y, this._up.z,
      0.012,
    );

    this.reverb.update(dt, this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
    this.weapons.tails.setImpulse(this.reverb.activeIr);
    this.pool.update(dt);
    this.mixer.tickDeafness(dt);
    this.tinnitus.set(this.mixer.deafnessAmount * 0.9);

    if (running && !this.started) {
      this.started = true;
      this.ambience.start();
    }
    this.ambience.setListener(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
    // Enclosed spaces have more reverb and less wind; reuse the zone blend.
    const enclosed = this.reverb.activeIr === 'openField' ? 0
      : this.reverb.activeIr === 'streetCanyon' ? 0.25 : 0.9;
    this.ambience.setInterior(enclosed);
    if (this.tensionExternal >= 0) this.ambience.setTension(this.tensionExternal);
    this.ambience.update(dt);

    /* --- physiological feedback ------------------------------------------ */
    const now = audio.currentTime;
    const frac = clamp01(this.health / Math.max(1, this.maxHealth));
    const stress = clamp01(1 - frac / 0.45) * (this.alive ? 1 : 0);
    if (running && stress > 0.05 && now >= this.heartbeatAt) {
      playHeartbeat(this.sfx, this.mixer, 0.35 + stress * 0.75);
      // 74 bpm calm, 150 bpm about to die.
      this.heartbeatAt = now + 60 / lerp(74, 150, stress);
    } else if (stress <= 0.05) {
      this.heartbeatAt = now;
    }
    if (running && this.alive && stress > 0.25 && now >= this.breathAt) {
      playGrunt(this.sfx, { kind: 'breath', firstPerson: true, gain: 0.35 + stress * 0.4 });
      this.breathAt = now + lerp(2.6, 1.2, stress);
    }

    /* --- audio-clock timers ---------------------------------------------- */
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (now >= this.pending[i].at) {
        const p = this.pending[i];
        this.pending.splice(i, 1);
        try { p.fn(); } catch (err) { console.warn('[audio] deferred sound failed', err); }
      }
    }

    this.cpuMs = performance.now() - t0;
  }

  private defer(seconds: number, fn: () => void): void {
    if (!this.ctx) return;
    this.pending.push({ at: this.ctx.currentTime + seconds, fn });
  }

  private get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /* ------------------------------------------------------------ events -- */

  private on<K extends Parameters<typeof bus.on>[0]>(key: K, fn: Parameters<typeof bus.on<K>>[1]): void {
    this.disposers.push(bus.on(key, fn));
  }

  private subscribeNoop(): void {
    // Nothing to do: with no context every handler would be a no-op anyway.
  }

  private subscribe(): void {
    /* ---------------------------------------------------------- weapons -- */
    this.on('weapon:fire', (e) => {
      if (!this.running) return;
      this.currentWeapon = e.weaponId;
      playShot(this.sfx, this.weapons, {
        weaponId: e.weaponId,
        x: e.origin.x, y: e.origin.y, z: e.origin.z,
        firstPerson: true,
        suppressed: e.suppressed,
        shotIndex: e.shotIndex,
      });
      this.ambience.bumpTension(0.16);
      this.scheduleCasing(e.origin, e.weaponId);
    });

    this.on('weapon:dryfire', (e) => {
      if (!this.running) return;
      playDryFire(this.sfx, e.weaponId, true);
    });

    this.on('weapon:reload:start', (e) => {
      if (!this.running) return;
      this.reload?.cancel();
      // duration on the contract is stamped by WeaponSystem when reloadScale
      // stretches the view-model; stages are fractions of that total (cat C).
      this.reload = playReload(this.sfx, e.weaponId, e.tactical, true, 0, 0, 0, e.duration);
    });

    this.on('weapon:reload:end', () => {
      // Interrupt must silence remaining stages (sprint/fire cancel pre/post commit).
      this.reload?.cancel();
      this.reload = null;
    });

    this.on('weapon:switch', (e) => {
      if (!this.running) return;
      this.reload?.cancel();
      this.reload = null;
      this.currentWeapon = e.to;
      playWeaponSwitch(this.sfx, e.from, e.to);
    });

    this.on('weapon:ads', (e) => {
      if (!this.running || e.active === this.ads) return;
      this.ads = e.active;
      playAds(this.sfx, e.active, this.currentWeapon);
    });

    this.on('weapon:overheat', (e) => {
      if (!this.running) return;
      playOverheat(this.sfx, clamp01(e.heat));
    });

    /* -------------------------------------------------------- ballistics -- */
    this.on('bullet:impact', (e) => {
      if (!this.running) return;
      const surface = e.surface as SurfaceType;
      const props = SURFACES[surface];

      if (surface === 'flesh' || surface === 'armor' || surface === 'helmet') {
        playFleshHit(this.sfx, e.point.x, e.point.y, e.point.z, surface === 'helmet');
      } else if (surface === 'water' || surface === 'puddle') {
        playWaterEntry(this.sfx, e.point.x, e.point.y, e.point.z, e.energy);
      } else {
        playImpact(this.sfx, {
          x: e.point.x, y: e.point.y, z: e.point.z,
          surface: e.surface, energy: e.energy, penetrated: e.penetrated,
        });
      }

      // Ricochet chance comes from the surface table and the incidence angle:
      // a shallow hit on steel sings, a square hit on plaster does not.
      const grazing = 1 - Math.abs(e.incoming.dot(e.normal));
      const chance = (props?.ricochet ?? 0) * (0.35 + grazing * 1.5);
      if (!e.penetrated && this.rand.next() < chance) {
        playRicochet(this.sfx, {
          x: e.point.x, y: e.point.y, z: e.point.z, energy: e.energy,
        });
      }
      if (props?.breakable && (surface === 'glass' || surface === 'glassThick')) {
        playGlassShatter(this.sfx, e.point.x, e.point.y, e.point.z, surface === 'glassThick' ? 0.9 : 0.55);
      }
    });

    // Hitmarker + menu cues share one bus. HitMarkers (and menus) publish
    // `ui:sound`; listening here — and nowhere else — keeps one kill blip per
    // kill and one menu click per hover. `damage:dealt` / `hud:hitmarker` used
    // to double- and triple-fire the same cue on every round.
    this.on('ui:sound', (e) => {
      if (!this.running) return;
      const cue = UI_CUE_TO_SOUND[e.cue];
      if (cue) playUi(this.sfx, cue, e.gain ?? 1);
    });

    /* ------------------------------------------------------------ player -- */
    this.on('player:footstep', (e) => {
      if (!this.running) return;
      // Local player steps are head-locked; AI / remote plants are spatial so
      // they ILD-localise instead of stacking on the listener (cat C).
      const local = e.isLocal !== false;
      const now = this.ctx!.currentTime;
      // Debounce only local double-reports; AI agents plant independently.
      if (local) {
        if (now - this.lastFootstepAt < 0.09) return;
        this.lastFootstepAt = now;
      }
      playFootstep(this.sfx, {
        x: e.point.x, y: e.point.y, z: e.point.z,
        surface: e.surface,
        gait: e.sprinting ? 'sprint' : this.gait,
        firstPerson: local,
        foot: this.footIndex++,
      });
    });

    this.on('player:land', (e) => {
      if (!this.running) return;
      playLanding(this.sfx, e.point.x, e.point.y, e.point.z, e.surface, e.force, true);
    });

    this.on('player:mantle', () => {
      if (!this.running) return;
      playMantle(this.sfx, this.listenerPos.x, this.listenerPos.y, this.listenerPos.z, true);
      playGrunt(this.sfx, { kind: 'effort', firstPerson: true, gain: 0.7 });
    });

    this.on('player:slide', (e) => {
      if (!this.running) return;
      if (e.start) {
        this.slide?.stop();
        this.slide = playSlide(
          this.sfx, this.listenerPos.x, this.listenerPos.y, this.listenerPos.z, 'concrete', true,
        );
      } else {
        this.slide?.stop();
        this.slide = null;
      }
    });

    this.on('player:move:state', (e) => {
      const s = e.state.toLowerCase();
      const next: Gait = s.includes('sprint') ? 'sprint'
        : s.includes('crouch') ? 'crouch'
          : s.includes('prone') ? 'prone'
            : s.includes('run') || s.includes('walk') ? 'run' : 'walk';
      if (next !== this.gait && this.running) {
        // Gear settles whenever the body changes what it is doing.
        playGearRustle(this.sfx, this.listenerPos.x, this.listenerPos.y, this.listenerPos.z,
          next === 'sprint' ? 0.8 : 0.45, true);
      }
      this.gait = next;
    });

    this.on('player:health', (e) => {
      this.health = e.health;
      this.maxHealth = e.max;
      if (e.health > 0) this.alive = true;
    });

    this.on('player:spawn', () => {
      this.alive = true;
      this.mixer.clearDeafness();
      this.tinnitus.set(0);
      this.slide?.stop();
      this.slide = null;
    });

    this.on('damage:taken', (e) => {
      if (!this.running) return;
      const severe = e.amount > 28 || e.lethal;
      playGrunt(this.sfx, {
        kind: e.lethal ? 'death' : severe ? 'heavy' : 'hit',
        firstPerson: true,
      });
      this.ambience.bumpTension(clamp01(e.amount / 45) * 0.6);
      this.mixer.duck({ depthDb: severe ? 5 : 2.5, attack: 0.01, hold: 0.05, release: 0.4, source: 'voice' });
      if (e.lethal) this.alive = false;
    });

    /* --------------------------------------------------------------- ai -- */
    this.on('ai:fire', (e) => {
      if (!this.running) return;
      let last = this.aiLastPos.get(e.id);
      if (!last) { last = new THREE.Vector3(); this.aiLastPos.set(e.id, last); }
      last.copy(e.origin);
      const weaponId = e.weaponId ?? 'ar';
      playShot(this.sfx, this.weapons, {
        weaponId,
        x: e.origin.x, y: e.origin.y, z: e.origin.z,
        suppressed: e.suppressed,
        gain: 0.95,
      });
      this.ambience.bumpTension(0.22);
      this.maybeWhizz(e.origin, e.direction);
    });

    this.on('ai:alert', (e) => {
      this.ambience.bumpTension(clamp01(e.level) * 0.55);
    });

    this.on('ai:voice', (e) => {
      if (!this.running) return;
      // Prefer authored point, else last muzzle/fire origin for this agent so
      // callouts spatialise instead of collapsing onto the listener.
      const pos = e.point ?? this.aiLastPos.get(e.id);
      if (pos) {
        playChatter(this.sfx, {
          x: pos.x, y: pos.y, z: pos.z,
          urgency: 0.6, radio: false, seed: e.id * 7919 + e.line.length,
        });
      } else {
        // Unknown position: radio path (head-locked, intentionally non-world).
        playChatter(this.sfx, {
          urgency: 0.55, radio: true, seed: e.id * 7919 + e.line.length,
        });
      }
    });

    /* -------------------------------------------------- explosions/props -- */
    this.on('explosion', (e) => {
      if (!this.running) return;
      const dist = this.pool.distanceTo(e.point.x, e.point.y, e.point.z);
      const flash = e.kind === 'flash' || e.kind === 'flashbang';

      if (!flash) {
        playExplosion(this.sfx, {
          x: e.point.x, y: e.point.y, z: e.point.z,
          radius: e.radius, power: e.power, kind: e.kind,
        });
      }

      // Blast overpressure: hearing damage scales with how close you were
      // relative to the blast radius, and a flashbang is nothing but this.
      const reach = flash ? e.radius * 2.4 : e.radius * 1.35;
      const exposure = clamp01(1 - dist / Math.max(1, reach));
      if (exposure > 0.05) {
        const amount = flash ? Math.pow(exposure, 0.6) : Math.pow(exposure, 1.5) * 0.8;
        this.mixer.addDeafness(amount, flash ? 1.6 + amount * 2.4 : 0.35 + amount * 1.2);
        playFlashbangOnset(this.sfx, this.mixer, amount);
      }
      this.ambience.bumpTension(0.7 * clamp01(1 - dist / 60));
    });

    this.on('grenade:thrown', (e) => {
      if (!this.running) return;
      playGrenadePin(this.sfx, this.listenerPos.x, this.listenerPos.y, this.listenerPos.z, true);
      void e;
    });

    this.on('physics:impact', (e) => {
      if (!this.running) return;
      // Grenades and small props bouncing are the common case; big impulses
      // route to the heavier collision sound.
      if (e.impulse < 900) {
        playGrenadeBounce(this.sfx, e.point.x, e.point.y, e.point.z, e.material, e.impulse / 900);
      } else {
        playPhysicsImpact(this.sfx, e.point.x, e.point.y, e.point.z, e.impulse, e.material);
      }
    });

    /* ------------------------------------------------------------- meta -- */
    this.on('entity:death', (e) => {
      if (!this.running) return;
      if (e.name === 'player') {
        this.alive = false;
        this.ambience.stinger('death');
        return;
      }
      playGrunt(this.sfx, {
        kind: 'enemyDeath',
        x: e.point.x, y: e.point.y, z: e.point.z,
        timbre: ((e.id * 37) % 100) / 100,
      });
      if (e.byPlayer) this.ambience.stinger('kill');
    });

    this.on('killstreak:earned', (e) => {
      if (!this.running) return;
      playReward(this.sfx, e.count);
      this.ambience.stinger('objective');
    });

    this.on('score:add', () => {
      if (!this.running) return;
      playUi(this.sfx, 'pickup', 0.5);
    });

    this.on('notify', (e) => {
      if (!this.running) return;
      playUi(this.sfx, e.kind === 'warn' ? 'error' : e.kind === 'reward' ? 'objective' : 'notify', 0.8);
    });

    this.on('game:pause', (e) => {
      this.mixer.setPaused(e.paused);
    });

    this.on('game:over', (e) => {
      if (!this.running) return;
      this.ambience.setTension(0);
      this.ambience.stinger(e.win ? 'objective' : 'death');
    });

    this.on('level:loaded', () => {
      this.pool.stopAll();
      this.pending.length = 0;
      this.slide = null;
      this.reload = null;
      this.mixer.clearDeafness();
      this.aiLastPos.clear();
      // Levels that never call setReverbZones still get a listener-tracking
      // acoustic field: open exterior under a street-canyon playspace.
      if (this.zones.length === 0) {
        this.setReverbZones([
          {
            id: 'playspace-street', ir: 'streetCanyon',
            center: [0, 8, 0], half: [180, 24, 180], feather: 28, wet: 0.85, priority: 1,
          },
          {
            id: 'playspace-open', ir: 'openField',
            center: [0, 8, 0], half: [520, 60, 520], feather: 80, wet: 0.45, priority: 0,
          },
        ], DEFAULT_FALLBACK);
      } else {
        // Re-apply authored set so the rack tracks the new level's listener path.
        this.reverb.setZones(this.zones, this.zoneFallback);
      }
    });

    this.on('settings:changed', (e) => {
      if (String(e.key).startsWith('game.')) this.mixer.applySettings();
    });

    this.on('quality:changed', () => this.onQualityChanged());
  }

  /* ------------------------------------------------------- derived cues -- */

  /** Ejected brass lands a beat after the shot. */
  private scheduleCasing(origin: THREE.Vector3, weaponId: string): void {
    const p = profileFor(weaponId);
    if (p.family === 'launcher') return;
    const size = p.family === 'sniper' || p.family === 'lmg' ? 0.8
      : p.family === 'shotgun' ? 0.9 : p.family === 'pistol' ? 0.2 : 0.4;
    const x = origin.x + this.rand.signed() * 0.5;
    const z = origin.z + this.rand.signed() * 0.5;
    const y = origin.y - 1.5;
    this.defer(0.42 + this.rand.next() * 0.22, () => {
      if (!this.running) return;
      playCasing(this.sfx, { x, y, z, surface: 'concrete', size });
    });
  }

  /**
   * Turns an AI shot into a supersonic pass if the round goes near the player.
   * Derived from the fire event rather than needing a per-bullet audio event,
   * which keeps the ballistics module free of any audio coupling.
   */
  private maybeWhizz(origin: THREE.Vector3, dir: THREE.Vector3): void {
    this._tmp.copy(this.listenerPos).sub(origin);
    const along = this._tmp.dot(dir);
    if (along <= 1 || along > 220) return;
    this._to.copy(dir).multiplyScalar(along).add(origin);
    const miss = this._to.distanceTo(this.listenerPos);
    if (miss > 9) return;
    const speed = 840;
    playWhizzBy(this.sfx, {
      x: this._to.x, y: this._to.y, z: this._to.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      miss, speed, delay: along / speed,
    });
  }

  /* ------------------------------------------------------- gesture gate -- */

  private installGestureResume(): void {
    const audio = this.ctx;
    if (!audio) return;
    if (typeof document === 'undefined') return;
    const tryResume = (): void => {
      if (audio.state !== 'running') void audio.resume().catch(() => { /* still blocked */ });
    };
    // Browsers block audio until a gesture; every plausible one re-tries.
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'click'] as const) {
      document.addEventListener(ev, tryResume, { passive: true });
      this.disposers.push(() => document.removeEventListener(ev, tryResume));
    }
    tryResume();
  }

  /* --------------------------------------------------------- public API -- */

  async resume(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* still blocked by policy */ }
    }
  }

  setBusVolume(busName: BusName, value: number): void {
    if (this.failed) return;
    this.mixer.setBusVolume(busName, value);
  }

  setReverbZones(zones: ReverbZoneDesc[], fallback: ImpulseId = DEFAULT_FALLBACK): void {
    if (this.failed) return;
    this.zones = zones.slice();
    this.zoneFallback = fallback;
    this.reverb.setZones(this.zones, fallback);
  }

  zoneAt(p: THREE.Vector3): string {
    if (this.failed) return 'default';
    return this.reverb.zoneAt(p.x, p.y, p.z);
  }

  setTension(v: number): void {
    this.tensionExternal = clamp01(v);
    if (!this.failed) this.ambience.setTension(this.tensionExternal);
  }

  /** Lets the director hand back tension control to the reactive model. */
  releaseTension(): void { this.tensionExternal = -1; }

  stats(): AudioStats {
    if (this.failed || !this.ctx) {
      return {
        running: false, contextState: 'unavailable', sampleRate: 0, activeVoices: 0,
        peakVoices: 0, starvedVoices: 0, zone: 'none', irLoaded: 0, bankBuffers: 0,
        tension: 0, deafness: 0, cpuMs: 0,
      };
    }
    return {
      running: this.ctx.state === 'running',
      contextState: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      activeVoices: this.pool.liveCount,
      peakVoices: this.pool.peak,
      starvedVoices: this.pool.starved,
      zone: this.reverb.activeZoneId,
      irLoaded: this.reverb.loaded,
      bankBuffers: this.bank.size,
      tension: this.ambience.tensionValue,
      deafness: this.mixer.deafnessAmount,
      cpuMs: this.cpuMs,
    };
  }

  /** Debug/tooling escape hatch: fire any registered sound by name. */
  trigger(name: string, x = 0, y = 0, z = 0): void {
    if (!this.running) return;
    switch (name) {
      case 'shot': playShot(this.sfx, this.weapons, { weaponId: this.currentWeapon, x, y, z }); break;
      case 'explosion': playExplosion(this.sfx, { x, y, z, radius: 6, power: 1 }); break;
      case 'impact': playImpact(this.sfx, { x, y, z, surface: 'concrete', energy: 1500 }); break;
      case 'ric': playRicochet(this.sfx, { x, y, z, energy: 1200 }); break;
      case 'step': playFootstep(this.sfx, { x, y, z, surface: 'concrete', gait: this.gait }); break;
      default: playUi(this.sfx, 'select'); break;
    }
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.slide?.stop();
    this.reload?.cancel();
    if (this.failed || !this.ctx) return;
    this.ambience.dispose();
    this.tinnitus.dispose();
    this.weapons.tails.dispose();
    this.pool.dispose();
    this.reverb.dispose();
    this.mixer.dispose();
    this.bank.dispose();
    void this.ctx.close().catch(() => { /* already closed */ });
    this.ctx = null;
  }
}
