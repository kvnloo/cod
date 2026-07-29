/**
 * Graphics + gameplay settings with quality presets.
 *
 * Render passes read from `settings.gfx` every frame (cheap struct reads) so a
 * preset change takes effect without rebuilding the frame graph, except where a
 * resolution-dependent target must be reallocated — those listen for
 * `quality:changed`.
 */

import { bus } from './EventBus';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';

export interface GfxSettings {
  /** Internal render scale multiplier applied to the drawing buffer. */
  renderScale: number;
  maxPixelRatio: number;

  /* anti-aliasing */
  taa: boolean;
  taaSamples: number;
  fxaaFallback: boolean;
  sharpen: number;             // CAS strength 0..1

  /* shadows */
  shadows: boolean;
  shadowCascades: number;
  shadowMapSize: number;
  shadowDistance: number;
  pcssSoftness: number;        // 0 = hard PCF, 1 = wide penumbra
  contactShadows: boolean;

  /* ambient occlusion */
  ssao: boolean;
  ssaoQuality: number;         // slice/step count scalar
  ssaoRadius: number;
  ssaoIntensity: number;

  /* reflections */
  ssr: boolean;
  ssrSteps: number;
  ssrThickness: number;

  /* volumetrics */
  volumetrics: boolean;
  volumetricSteps: number;
  fogDensity: number;

  /* post */
  bloom: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  motionBlur: boolean;
  motionBlurStrength: number;
  dof: boolean;
  dofQuality: number;
  chromaticAberration: number;
  filmGrain: number;
  vignette: number;
  lensDirt: number;
  exposure: number;
  tonemap: 'aces' | 'agx' | 'reinhard' | 'none';
  colorGrade: boolean;

  /* geometry / textures */
  anisotropy: number;
  lodBias: number;
  maxDecals: number;
  maxParticles: number;
  foliageDensity: number;
  drawDistance: number;
}

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

const ULTRA: GfxSettings = {
  renderScale: 1.0,
  maxPixelRatio: 2,
  taa: true,
  taaSamples: 16,
  fxaaFallback: false,
  sharpen: 0.35,
  shadows: true,
  shadowCascades: 4,
  shadowMapSize: 2048,
  shadowDistance: 140,
  pcssSoftness: 1.0,
  contactShadows: true,
  ssao: true,
  ssaoQuality: 1.0,
  ssaoRadius: 0.7,
  ssaoIntensity: 1.0,
  ssr: true,
  ssrSteps: 48,
  ssrThickness: 0.35,
  volumetrics: true,
  volumetricSteps: 64,
  fogDensity: 1.0,
  bloom: true,
  bloomIntensity: 0.65,
  bloomThreshold: 1.0,
  motionBlur: true,
  motionBlurStrength: 0.7,
  dof: true,
  dofQuality: 1.0,
  chromaticAberration: 0.35,
  filmGrain: 0.35,
  vignette: 0.4,
  lensDirt: 0.5,
  exposure: 1.0,
  tonemap: 'agx',
  colorGrade: true,
  anisotropy: 16,
  lodBias: 0,
  maxDecals: 512,
  maxParticles: 40000,
  foliageDensity: 1.0,
  drawDistance: 900,
};

function derive(base: GfxSettings, o: Partial<GfxSettings>): GfxSettings {
  return { ...base, ...o };
}

export const PRESETS: Record<QualityPreset, GfxSettings> = {
  cinematic: derive(ULTRA, {
    renderScale: 1.25, shadowMapSize: 4096, shadowCascades: 4, ssrSteps: 80,
    volumetricSteps: 128, taaSamples: 32, ssaoQuality: 1.5, dofQuality: 1.5,
  }),
  ultra: ULTRA,
  high: derive(ULTRA, {
    shadowMapSize: 1536, ssrSteps: 28, volumetricSteps: 40, taaSamples: 8,
    ssaoQuality: 0.7, maxParticles: 24000, lensDirt: 0.35, dofQuality: 0.7,
  }),
  medium: derive(ULTRA, {
    renderScale: 0.85, shadowCascades: 3, shadowMapSize: 1024, pcssSoftness: 0.5,
    ssr: false, volumetricSteps: 24, ssaoQuality: 0.5, motionBlur: false,
    maxParticles: 12000, contactShadows: false, dof: false, anisotropy: 8,
    drawDistance: 500,
  }),
  low: derive(ULTRA, {
    renderScale: 0.7, shadows: true, shadowCascades: 2, shadowMapSize: 1024,
    pcssSoftness: 0, ssao: false, ssr: false, volumetrics: false, bloom: true,
    bloomIntensity: 0.4, motionBlur: false, dof: false, taa: false,
    fxaaFallback: true, lensDirt: 0, filmGrain: 0.15, maxParticles: 6000,
    maxDecals: 128, anisotropy: 4, contactShadows: false, drawDistance: 350,
    foliageDensity: 0.5,
  }),
};

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

const STORAGE_KEY = 'blackout.settings.v1';

class SettingsStore {
  preset: QualityPreset = 'ultra';
  gfx: GfxSettings = { ...ULTRA };
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
    this.gfx = { ...PRESETS[preset] };
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

/** Auto-picks a preset from the reported GPU and screen size. */
export function autoDetectPreset(rendererName: string, pixels: number): QualityPreset {
  const gpu = rendererName.toLowerCase();
  const highEnd = /rtx\s?(30|40|50)|rx\s?(6[89]|7[789])|apple m[1-9]\s?(pro|max|ultra)|arc a7/.test(gpu);
  const midRange = /gtx\s?16|rtx\s?20|rx\s?5[67]|apple m[1-9]|iris xe/.test(gpu);
  const software = /swiftshader|llvmpipe|software/.test(gpu);
  if (software) return 'low';
  if (highEnd) return pixels > 4_000_000 ? 'high' : 'ultra';
  if (midRange) return pixels > 2_500_000 ? 'medium' : 'high';
  return 'medium';
}
