/**
 * Quality presets and honest GPU auto-detection.
 *
 * Split out of `Settings.ts` so the preset table — the thing that decides what
 * the player's machine is asked to do — lives on its own and can be reasoned
 * about without wading through the settings store. `Settings.ts` re-exports
 * everything here, so existing imports keep working.
 *
 * ## The rule this file exists to enforce
 *
 * **A preset must be able to hold the frame rate it claims on the hardware it
 * is offered to.** Before this file, `autoDetectPreset` handed an RTX 3080 Ti at
 * 1080p the `ultra` preset, and `ultra` measured 15.4 ms p50 / 39.9 ms p99 in a
 * live firefight — a 65 fps median with a 25 fps tail. The player's report was
 * "fps was really bad (maybe it was an ultra mode test)". It was an ultra mode
 * test, and the game chose it for them.
 *
 * ## How these are measured
 *
 * Wall-clock frame time over a scripted firefight at 1920x1080 on an RTX 3080 Ti
 * (ANGLE/Vulkan), in **live** mode (`capture=0`) — `node tools/_g6-prof.mjs`.
 *
 * Measuring with `capture=1`, which is what every other perf tool in this repo
 * does, adds roughly 7 ms/frame that no player ever pays: `RenderSystem.init`
 * hands `ExposureSystem` a synchronous readback in capture mode, and a
 * synchronous `readRenderTargetPixels` is a full GPU pipeline flush. Measured
 * side by side on the same build and seed, `ultra` came out at 23.6 ms p50 with
 * `capture=1` and 15.4 ms p50 with `capture=0`. Check
 * `RenderSystem.stats().captureSync` before believing a frame-time number.
 *
 *   preset      targets
 *   low         144 fps / 6.9 ms   — must also survive integrated graphics
 *   medium      120 fps / 8.3 ms   — console 120 Hz parity
 *   high         60 fps / 16.7 ms  — the default for discrete GPUs
 *   ultra       uncapped; adaptive off; never auto-selected
 *   cinematic   capture only; never auto-selected
 *
 * `high` is the default for discrete GPUs because it is the highest preset that
 * holds 60 fps with headroom. `ultra` is never auto-selected: it is the "I have
 * the frames to spare" opt-in, and `autoDetectPreset` will not choose it for
 * anyone. That is the whole point — a preset the machine cannot hold must be a
 * decision the player made, not one the game made for them.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';

export interface GfxSettings {
  /** Internal render scale multiplier applied to the drawing buffer. */
  renderScale: number;
  /**
   * Ceiling on `devicePixelRatio`. This multiplies `renderScale`, so a preset
   * with renderScale 1.0 and maxPixelRatio 2 renders **four times** the pixels
   * on a HiDPI laptop. No shipping first-person shooter does that; the internal
   * render scale is the honest knob and CAS sharpening recovers the rest.
   */
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
  /**
   * How often the cascaded shadow atlas is rebuilt, in Hz. `0` means every
   * frame.
   *
   * Rebuilding the atlas re-submits the whole shadow-casting scene once per
   * cascade; measured at 5.3–6.8 ms of CPU on the reference machine, the single
   * largest render cost once the capture-mode readback stall is removed. The
   * atlas persists between frames — nothing clears it — so simply not calling
   * the shadow system on a frame reuses the previous atlas at zero cost.
   *
   * The visible consequence is that shadows of *moving* things lag by up to one
   * update interval. At 40 Hz that is 25 ms, which is under the ~30 ms at which
   * shadow lag becomes legible in motion, and static world shadows — which is
   * almost all of them — are identical either way.
   */
  shadowUpdateHz: number;

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
  /**
   * How often auto-exposure re-meters the frame, in Hz. `0` means every frame.
   *
   * The metering chain is a 256x144 luminance downsample, a 36,864-point
   * histogram scatter and two reduction blits. Eye adaptation is a ~1 s
   * exponential, so re-metering at 30 Hz is indistinguishable from 144 Hz; the
   * accumulated delta is handed to the adaptation so the curve is unchanged.
   */
  exposureUpdateHz: number;

  /* geometry / textures */
  anisotropy: number;
  lodBias: number;
  maxDecals: number;
  maxParticles: number;
  foliageDensity: number;
  drawDistance: number;
  /**
   * Depth-only prepass over opaque world geometry.
   *
   * It exists so shaders that run *during* the main pass can read scene depth:
   * contact shadows (`Glsl.ts`) and every soft-particle fade in `src/fx/`. It is
   * a second full submission of the opaque scene, so it is not free — turn it
   * off on presets that have neither contact shadows nor a meaningful particle
   * budget.
   */
  depthPrepass: boolean;

  /* adaptive budget — see src/fx/Budget.ts */
  /** Let the frame budget governor trade quality for frame time at runtime. */
  adaptive: boolean;
  /**
   * Frame-time the governor holds, in milliseconds. This is a *p90* target, not
   * a mean: the complaint being fixed is "not smooth", and smoothness is a
   * property of the tail.
   */
  targetFrameMs: number;
}

/**
 * `ultra` — everything the renderer can do, with no frame-rate promise.
 *
 * Every other preset is a diff against this one, so a new feature added here is
 * on everywhere by default and has to be explicitly switched off for the cheaper
 * tiers. That is the right default: a feature nobody remembered to enable is a
 * quieter bug than one nobody remembered to disable.
 */
const ULTRA: GfxSettings = {
  renderScale: 1.0,
  // 1.25, not 2. At DPR 2 this preset rendered 3840x2160 on a HiDPI laptop
  // while claiming to be a 1080p setting.
  maxPixelRatio: 1.25,
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
  shadowUpdateHz: 0,           // every frame; ultra buys no perf with lag
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
  exposureUpdateHz: 60,
  anisotropy: 16,
  lodBias: 0,
  maxDecals: 512,
  maxParticles: 40000,
  foliageDensity: 1.0,
  drawDistance: 900,
  depthPrepass: true,
  // Off, and that is what `ultra` means. A governor holding a 16.7 ms p90 would
  // walk this preset straight back down to `high` within seconds, which would
  // make the two settings indistinguishable and the menu a lie. Ultra is the
  // "give me everything, I accept the frame time" choice; the target below is
  // what it would aim for if the player turns adaptive on themselves.
  adaptive: false,
  targetFrameMs: 16.7,
};

function derive(base: GfxSettings, o: Partial<GfxSettings>): GfxSettings {
  return { ...base, ...o };
}

export const PRESETS: Record<QualityPreset, GfxSettings> = {
  /** Capture and marketing only. `autoDetectPreset` never returns this. */
  cinematic: derive(ULTRA, {
    renderScale: 1.25, maxPixelRatio: 1.5, shadowMapSize: 4096, shadowCascades: 4,
    ssrSteps: 80, volumetricSteps: 128, taaSamples: 32, ssaoQuality: 1.5,
    dofQuality: 1.5, shadowUpdateHz: 0, exposureUpdateHz: 0,
    adaptive: false, targetFrameMs: 33.3,
  }),

  /** Opt-in showcase tier. Not frame-rate guaranteed; never auto-selected. */
  ultra: ULTRA,

  /**
   * The 60 fps tier, and the default for any discrete GPU.
   *
   * Everything here is chosen for tail latency rather than average: the shadow
   * atlas rebuilds at 40 Hz (the largest single CPU cost, and the one the eye
   * notices least), and the adaptive governor holds a 16.7 ms p90.
   */
  high: derive(ULTRA, {
    shadowMapSize: 1536, ssrSteps: 28, volumetricSteps: 40, taaSamples: 8,
    ssaoQuality: 0.7, maxParticles: 24000, lensDirt: 0.35, dofQuality: 0.7,
    shadowUpdateHz: 40, exposureUpdateHz: 30,
    adaptive: true, targetFrameMs: 16.7,
  }),

  /** Console-parity 120 Hz tier. */
  medium: derive(ULTRA, {
    renderScale: 0.85, maxPixelRatio: 1, shadowCascades: 3, shadowMapSize: 1024,
    pcssSoftness: 0.5, ssr: false, volumetricSteps: 24, ssaoQuality: 0.5,
    motionBlur: false, maxParticles: 12000, contactShadows: false, dof: false,
    anisotropy: 8, drawDistance: 500, taaSamples: 8,
    shadowUpdateHz: 30, exposureUpdateHz: 20,
    adaptive: true, targetFrameMs: 8.3,
  }),

  /**
   * 144 fps tier, and the preset that has to survive integrated graphics.
   *
   * No depth prepass: with contact shadows off and a 6k particle budget there is
   * nothing left that reads scene depth during the main pass, so the second
   * opaque submission buys nothing.
   */
  low: derive(ULTRA, {
    renderScale: 0.7, maxPixelRatio: 1, shadows: true, shadowCascades: 2,
    shadowMapSize: 1024, pcssSoftness: 0, ssao: false, ssr: false,
    volumetrics: false, bloom: true, bloomIntensity: 0.4, motionBlur: false,
    dof: false, taa: false, fxaaFallback: true, lensDirt: 0, filmGrain: 0.15,
    maxParticles: 6000, maxDecals: 128, anisotropy: 4, contactShadows: false,
    drawDistance: 350, foliageDensity: 0.5,
    shadowUpdateHz: 24, exposureUpdateHz: 15, depthPrepass: false,
    adaptive: true, targetFrameMs: 6.9,
  }),
};

/**
 * Picks a preset from the reported GPU string and the render surface area.
 *
 * Deliberately conservative, and deliberately incapable of returning `ultra` or
 * `cinematic`: a preset with no frame-rate promise is a choice the player makes.
 * The highest this ever returns is `high`, which is the 60 fps tier.
 */
export function autoDetectPreset(rendererName: string, pixels: number): QualityPreset {
  const gpu = rendererName.toLowerCase();
  const highEnd = /rtx\s?(30|40|50)|rx\s?(6[89]|7[789])|apple m[1-9]\s?(pro|max|ultra)|arc a7/.test(gpu);
  const midRange = /gtx\s?16|rtx\s?20|rx\s?5[67]|apple m[1-9]|iris xe/.test(gpu);
  const software = /swiftshader|llvmpipe|software/.test(gpu);
  if (software) return 'low';
  // Above ~1440p the pixel cost alone takes a tier off whatever the GPU is.
  if (highEnd) return pixels > 4_000_000 ? 'medium' : 'high';
  if (midRange) return pixels > 2_500_000 ? 'low' : 'medium';
  return pixels > 2_500_000 ? 'low' : 'medium';
}
