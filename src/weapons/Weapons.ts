/**
 * WeaponSystem — weapon state machine, view model, recoil, ballistics dispatch.
 *
 * STUB: emits `weapon:fire` on trigger pull so FX/audio/HUD can be built against
 * real events before the full weapon rig exists.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { input } from '../core/Input';
import { bus } from '../core/EventBus';
import type { PlayerSystem } from '../player/Player';

export interface WeaponRuntime {
  id: string;
  name: string;
  ammo: number;
  magSize: number;
  reserve: number;
  rpm: number;
  ads: boolean;
  reloading: boolean;
}

export class WeaponSystem implements System {
  readonly name = 'weapons';
  readonly order = ORDER.WEAPONS;

  current: WeaponRuntime = {
    id: 'ar_vector', name: 'VKR-7', ammo: 30, magSize: 30, reserve: 210,
    rpm: 720, ads: false, reloading: false,
  };

  private nextShotAt = 0;
  private shotIndex = 0;
  private player!: PlayerSystem;

  async init(ctx: EngineContext): Promise<void> {
    this.player = ctx.engine.get<PlayerSystem>('player');
  }

  fixedUpdate(_dt: number, ctx: EngineContext): void {
    const t = ctx.time.elapsed;
    const w = this.current;

    const wantAds = input.held('ads');
    if (wantAds !== w.ads) { w.ads = wantAds; bus.emit('weapon:ads', { active: wantAds }); }

    if (input.pressed('reload') && w.ammo < w.magSize && w.reserve > 0 && !w.reloading) {
      w.reloading = true;
      bus.emit('weapon:reload:start', { weaponId: w.id, tactical: w.ammo > 0 });
      setTimeout(() => {
        const need = w.magSize - w.ammo;
        const take = Math.min(need, w.reserve);
        w.ammo += take; w.reserve -= take; w.reloading = false;
        bus.emit('weapon:reload:end', { weaponId: w.id });
      }, 2100);
    }

    if (input.held('fire') && !w.reloading && t >= this.nextShotAt) {
      if (w.ammo <= 0) {
        if (input.pressed('fire')) bus.emit('weapon:dryfire', { weaponId: w.id });
        this.nextShotAt = t + 0.25;
        return;
      }
      w.ammo--;
      this.nextShotAt = t + 60 / w.rpm;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      bus.emit('weapon:fire', {
        weaponId: w.id,
        origin: ctx.camera.position.clone(),
        direction: dir,
        shotIndex: this.shotIndex++,
        suppressed: false,
      });
    }
    void this.player;
  }
}
