/**
 * The post-processing effect library.
 *
 * `createPasses()` returns every effect, already ordered by `PASS_ORDER`. Each
 * pass reads `settings.gfx` through `PassContext` every frame and no-ops
 * (returns `false`) when its feature flag is off, so the frame graph never has
 * to rebuild when the quality preset changes.
 *
 *   AO 100          GtaoPass        horizon-slice GTAO + bent normals
 *   SSR 200         SsrPass         stride-marched reflections + cone tracing
 *   VOLUMETRICS 300 VolumetricPass  froxel scattering, god rays, height fog
 *   TAA 400         TaaPass         Halton jitter resolve (FXAA fallback)
 *   MOTION_BLUR 500 MotionBlurPass  tile-max reconstruction filter
 *   DOF 600         DofPass         physical CoC, polygonal bokeh, near+far
 *   BLOOM 700       BloomPass       Karis-averaged dual-filter pyramid
 *   LENS 750        LensPass        dirt, anamorphic streaks, ghosts
 *   EXPOSURE 800    TonemapPass     eye adaptation, AgX/ACES, 3D LUT grade
 *   SHARPEN 900     CasPass         contrast-adaptive sharpening
 *   GRAIN 950       GrainPass       grain, vignette, aberration, dither
 *   SCREEN_FX 980   ScreenFxPass    flashbang, damage, concussion, spatter
 *
 * Everything up to and including TAA works on scene-referred linear HDR.
 * `TonemapPass` is the colour-space boundary: it writes sRGB-encoded,
 * display-referred values, and every pass after it operates in that space.
 */

import type { RenderPass } from '../Pass';
import type { ScreenEffectRequest } from '../types';
import { PostResources } from './Shared';

import { GtaoPass } from './GtaoPass';
import { SsrPass } from './SsrPass';
import { VolumetricPass } from './VolumetricPass';
import { TaaPass } from './TaaPass';
import { MotionBlurPass } from './MotionBlurPass';
import { DofPass } from './DofPass';
import { BloomPass } from './BloomPass';
import { LensPass } from './LensPass';
import { TonemapPass } from './TonemapPass';
import { CasPass } from './CasPass';
import { GrainPass } from './GrainPass';
import { ScreenFxPass } from './ScreenFxPass';

/** Resources shared by every pass (target pool, blue noise, screen-effect state). */
export const postResources = new PostResources();

/** Every pass, keyed by name, populated by `createPasses()`. */
const registry = new Map<string, RenderPass>();

/**
 * Builds the full post chain in `PASS_ORDER` order.
 *
 * Call once; the returned array is owned by the caller, which is responsible for
 * `setup`, `resize`, `render` and `dispose`.
 */
export function createPasses(): RenderPass[] {
  const res = postResources;
  const passes: RenderPass[] = [
    new GtaoPass(res),
    new SsrPass(res),
    new VolumetricPass(res),
    new TaaPass(res),
    new MotionBlurPass(res),
    new DofPass(res),
    new BloomPass(res),
    new LensPass(res),
    new TonemapPass(res),
    new CasPass(res),
    new GrainPass(res),
    new ScreenFxPass(res),
  ];
  passes.sort((a, b) => a.order - b.order);
  registry.clear();
  for (const p of passes) registry.set(p.name, p);
  return passes;
}

/** Looks up a pass created by `createPasses()`, for tuning at runtime. */
export function getPass<T extends RenderPass>(name: string): T | undefined {
  return registry.get(name) as T | undefined;
}

/**
 * Entry point for `RenderAPI.screenEffect`. The screen-effect state also listens
 * to the event bus directly, so damage, explosions and ADS already work without
 * anyone calling this.
 */
export function postScreenEffect(req: ScreenEffectRequest): void {
  postResources.fx.request(req);
}

/** Weather hook for `RenderAPI.setWeather` — scales volumetric fog density. */
export function postSetWeather(rain: number, fog: number, wind: number): void {
  const vol = registry.get('volumetrics') as VolumetricPass | undefined;
  if (vol) {
    // Quadratic so "a bit of haze" stays a bit of haze and only real fog
    // weather closes the level down.
    vol.fogScale = 0.55 + fog * 1.4 + fog * fog * 5.0;
    vol.windSpeed = 0.01 + wind * 0.06;
  }
  const fx = postResources.fx;
  if (rain > 0.01) fx.water = Math.max(fx.water, Math.min(0.85, rain));
}

/** Frees every GPU resource the library owns. Passes dispose themselves. */
export function disposePasses(): void {
  postResources.dispose();
  registry.clear();
}

export { PostResources } from './Shared';
export { haltonJitter, blueNoiseTexture, radicalInverse, hammersley } from './BlueNoise';
export { DEFAULT_GRADE, gradeLutTexture, whiteBalanceCoeffs, type GradeSettings } from './ColorGrade';
export { lensDirtTexture } from './LensDirt';

export { GtaoPass } from './GtaoPass';
export { SsrPass } from './SsrPass';
export { VolumetricPass } from './VolumetricPass';
export { TaaPass } from './TaaPass';
export { MotionBlurPass } from './MotionBlurPass';
export { DofPass } from './DofPass';
export { BloomPass } from './BloomPass';
export { LensPass } from './LensPass';
export { TonemapPass } from './TonemapPass';
export { CasPass } from './CasPass';
export { GrainPass } from './GrainPass';
export { ScreenFxPass } from './ScreenFxPass';

// Registers the 'post' debug scene and its shots. Importing for side effects is
// deliberate: it means `node tools/capture.mjs --debug post` works as soon as
// anything pulls in the pass library.
import './PostLab';
export { PostLab, LabFrameGraph } from './PostLab';
