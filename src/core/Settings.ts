/**
 * Graphics + gameplay settings with quality presets.
 *
 * Render passes read from `settings.gfx` every frame (cheap struct reads) so a
 * preset change takes effect without rebuilding the frame graph, except where a
 * resolution-dependent target must be reallocated — those listen for
 * `quality:changed`.
 */

import { bus } from './EventBus';
import { PRESETS, type GfxSettings, type QualityPreset } from './Quality';

// The preset table, the `GfxSettings` shape and GPU auto-detection live in
// `./Quality.ts`. They are re-exported here so every existing
// `import { ... } from './Settings'` keeps working.
export { PRESETS, autoDetectPreset } from './Quality';
export type { GfxSettings, QualityPreset } from './Quality';

export interface GameplaySettings {
  fov: number;                 // vertical FOV in degrees
  adsFovScale: number;
  sensitivity: number;
  adsSensitivityScale: number;
  invertY: boolean;
  toggleAds: boolean;
  toggleCrouch: boolean;
  autoSprint: boolean;
  cameraShake: number;
  weaponBob: number;
  showBlood: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  hudScale: number;
  crosshairStyle: 'dynamic' | 'dot' | 'cross' | 'none';
  showFps: boolean;
  showDamageNumbers: boolean;
}

export const DEFAULT_GAMEPLAY: GameplaySettings = {
  fov: 80,
  adsFovScale: 0.72,
  sensitivity: 1.0,
  adsSensitivityScale: 0.72,
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  autoSprint: false,
  cameraShake: 1.0,
  weaponBob: 1.0,
  showBlood: true,
  masterVolume: 0.9,
  sfxVolume: 1.0,
  musicVolume: 0.55,
  hudScale: 1.0,
  crosshairStyle: 'dynamic',
  showFps: false,
  showDamageNumbers: true,
};

/**
 * Bumped from v1 when the preset table moved to `Quality.ts` and changed
 * meaning. A v1 payload carries a whole `gfx` blob, so restoring it would
 * resurrect the old values wholesale — `maxPixelRatio: 2`, no shadow cadence —
 * and the player would keep the exact configuration this wave exists to fix,
 * silently, forever. A settings migration that cannot express "this value is
 * now wrong" has to start over instead.
 */
const STORAGE_KEY = 'blackout.settings.v2';

class SettingsStore {
  /**
   * The pre-detection default. `main.ts` overwrites this with
   * `autoDetectPreset` once the GPU string is known; this is what a machine
   * gets if detection never runs.
   *
   * It used to be `ultra`, which is a preset with no frame-rate promise.
   */
  preset: QualityPreset = 'high';
  gfx: GfxSettings = { ...PRESETS.high };
  game: GameplaySettings = { ...DEFAULT_GAMEPLAY };

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { preset?: QualityPreset; gfx?: Partial<GfxSettings>; game?: Partial<GameplaySettings> };
      if (data.preset && PRESETS[data.preset]) this.setPreset(data.preset, false);
      if (data.gfx) Object.assign(this.gfx, data.gfx);
      if (data.game) Object.assign(this.game, data.game);
    } catch { /* corrupt storage is not fatal */ }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        preset: this.preset, gfx: this.gfx, game: this.game,
      }));
    } catch { /* private mode */ }
  }

  setPreset(preset: QualityPreset, emit = true): void {
    if (!PRESETS[preset]) return;
    this.preset = preset;
    // Mutated in place, never replaced. `__RENDER__.gfx`, `PassContext.settings`
    // and the adaptive budget governor all hold a reference to this object; a
    // fresh object would leave every one of them reading a detached snapshot.
    Object.assign(this.gfx, PRESETS[preset]);
    if (emit) {
      bus.emit('quality:changed', { preset });
      this.save();
    }
  }

  setGfx<K extends keyof GfxSettings>(key: K, value: GfxSettings[K]): void {
    this.gfx[key] = value;
    bus.emit('settings:changed', { key: `gfx.${String(key)}`, value });
    this.save();
  }

  setGame<K extends keyof GameplaySettings>(key: K, value: GameplaySettings[K]): void {
    this.game[key] = value;
    bus.emit('settings:changed', { key: `game.${String(key)}`, value });
    this.save();
  }
}

export const settings = new SettingsStore();
