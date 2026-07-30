/**
 * UI-local preferences.
 *
 * `src/core/Settings.ts` owns graphics and gameplay. Everything that is purely a
 * presentation choice of the HUD lives here so the UI module can ship
 * accessibility options without a core change. Values persist under their own
 * storage key and every mutation is announced on the shared bus with a
 * `ui.<key>` name, so the settings menu, the HUD and any future consumer stay in
 * sync through one channel.
 */

import { bus } from '../core/EventBus';
import { setMotionAmount } from './Anim';
import type { ColorBlindMode } from './Theme';

export type CrosshairColor = 'default' | 'accent' | 'green' | 'cyan' | 'magenta';

export interface UiPrefs {
  /** Master HUD opacity 0.25..1. */
  hudOpacity: number;
  /** Dichromat-safe palette. */
  colorBlind: ColorBlindMode;
  /** 0 = cut instead of animate, 1 = full motion design. */
  motion: number;
  /** Render subtitles for voice lines. */
  subtitles: boolean;
  subtitleSize: number;
  /** Always draw the centre dot, even with the dynamic reticle. */
  centreDot: boolean;
  crosshairColor: CrosshairColor;
  /** Fill the crosshair's centre gap when the target is an enemy. */
  showMinimap: boolean;
  showCompass: boolean;
  showKillfeed: boolean;
  /** Flash the reserve count under this many magazines. */
  lowAmmoMagazines: number;
  /** Directional damage indicators. */
  damageIndicators: boolean;
  /** Desaturate + pulse when critically wounded. */
  lowHealthEffects: boolean;
  /** Show world-space damage numbers. */
  damageNumbers: boolean;
  /** Metric vs imperial in the compass/objective distance readout. */
  units: 'metric' | 'imperial';
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  hudOpacity: 1,
  colorBlind: 'off',
  motion: 1,
  subtitles: true,
  subtitleSize: 1,
  centreDot: false,
  crosshairColor: 'default',
  showMinimap: true,
  showCompass: true,
  showKillfeed: true,
  lowAmmoMagazines: 1,
  damageIndicators: true,
  lowHealthEffects: true,
  damageNumbers: true,
  units: 'metric',
};

const STORAGE_KEY = 'blackout.ui.v1';

class UiSettingsStore {
  readonly prefs: UiPrefs = { ...DEFAULT_UI_PREFS };

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as Partial<UiPrefs>;
        for (const k of Object.keys(this.prefs) as Array<keyof UiPrefs>) {
          if (data[k] !== undefined) {
            // Runtime shapes are validated by construction: only keys we own.
            (this.prefs as Record<string, unknown>)[k] = data[k] as unknown;
          }
        }
      }
    } catch { /* private mode or corrupt storage — defaults are fine */ }
    setMotionAmount(this.prefs.motion);
  }

  save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs)); } catch { /* noop */ }
  }

  set<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
    if (this.prefs[key] === value) return;
    this.prefs[key] = value;
    if (key === 'motion') setMotionAmount(this.prefs.motion);
    this.save();
    bus.emit('settings:changed', { key: `ui.${String(key)}`, value });
  }

  reset(): void {
    Object.assign(this.prefs, DEFAULT_UI_PREFS);
    setMotionAmount(this.prefs.motion);
    this.save();
    bus.emit('settings:changed', { key: 'ui.*', value: null });
  }
}

export const ui = new UiSettingsStore();
