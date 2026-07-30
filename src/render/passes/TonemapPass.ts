/**
 * Exposure, tonemapping and the cinematic grade.
 *
 *   log-luminance pyramid → 1x1 eye adaptation (GPU-side, no readback stall)
 *     → exposure in linear → white balance → AgX / ACES / Reinhard
 *     → sRGB encode → 3D LUT grade
 *
 * This pass is the boundary of the pipeline's colour space: everything before it
 * is scene-referred linear HDR, everything after it (CAS, grain, screen effects)
 * works on display-referred sRGB-encoded values, which is where those filters
 * are defined.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import { DEFAULT_GRADE, LUT_SIZE, gradeLutTexture, whiteBalanceCoeffs, type GradeSettings } from './ColorGrade';
import type { PostResources } from './Shared';

const LUMINANCE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
uniform float uLumaMin;
uniform float uLumaMax;
layout(location = 0) out vec4 fragColor;

void main() {
  vec3 c = vec3(0.0);
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * 4.0 * uSourceTexel;
      c += max(texture(tInput, vUv + o).rgb, vec3(0.0));
    }
  }
  c *= 0.25;
  // Clamp before the log. A geometric mean is extremely sensitive to near-black
  // pixels: an unclamped log2(1e-4) drags the average down by ten stops and the
  // metering opens all the way up, which is exactly how auto-exposure blows a
  // scene out when it contains a dark floor.
  float l = clamp(luma(c), uLumaMin, uLumaMax);
  // Centre-weighted metering: the subject, not the sky, sets the exposure.
  vec2 d = vUv - 0.5;
  float w = exp(-dot(d, d) * 3.4) + 0.1;
  float logL = log2(l);
  fragColor = vec4(logL * w, w, 0.0, 1.0);
}
`;

const REDUCE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 s = vec2(0.0);
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = (vec2(float(x), float(y)) - 0.5) * 2.0 * uSourceTexel;
      s += texture(tInput, vUv + o).rg;
    }
  }
  fragColor = vec4(s * 0.25, 0.0, 1.0);
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tPrev;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform float uDt;
uniform float uReset;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 s = texture(tCurrent, vec2(0.5)).rg;
  float target = s.x / max(s.y, 1e-5);          // average log2 luminance
  float prev = texture(tPrev, vec2(0.5)).r;
  if (uReset > 0.5) { fragColor = vec4(target, 0.0, 0.0, 1.0); return; }
  float speed = target > prev ? uSpeedUp : uSpeedDown;
  float k = 1.0 - exp(-uDt * speed);
  fragColor = vec4(mix(prev, target, k), 0.0, 0.0, 1.0);
}
`;

const TONEMAP_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tAdapt;
uniform sampler3D tLut;
uniform float uExposure;
uniform float uAutoExposure;
uniform float uKey;
uniform float uMinExposure;
uniform float uMaxExposure;
uniform vec3 uWhiteBalance;
uniform float uLutSize;
uniform float uLutStrength;
uniform vec3 uAgxLook;    // x power, y saturation, z (unused)
layout(location = 0) out vec4 fragColor;

const mat3 LIN_2_LMS = mat3(
  vec3(3.90405e-1, 7.08416e-2, 2.31082e-2),
  vec3(5.49941e-1, 9.63172e-1, 1.28021e-1),
  vec3(8.92632e-3, 1.35775e-3, 9.36245e-1));
const mat3 LMS_2_LIN = mat3(
  vec3(2.85847e+0, -2.10182e-1, -4.18120e-2),
  vec3(-1.62879e+0, 1.15820e+0, -1.18169e-1),
  vec3(-2.48910e-2, 3.24014e-4, 1.06867e+0));

const mat3 LINEAR_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187));

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
       + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 tonemapAgX(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = LINEAR_SRGB_TO_REC2020 * color;
  color = inset * color;
  color = log2(max(color, 1e-10));
  color = clamp((color - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = agxContrast(color);
  // AgX "look" stage. Base AgX alone is deliberately flat and desaturated — it
  // is a working space, not a delivery grade, and shipping it raw is what makes
  // an image read as milky no matter how good the lighting is. The power/
  // saturation pair here is the same shape as Blender's Punchy look, applied in
  // the log-encoded domain where it cannot clip.
  {
    float agxLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = pow(max(color, vec3(0.0)), vec3(uAgxLook.x));
    agxLuma = pow(max(agxLuma, 0.0), uAgxLook.x);
    color = agxLuma + (color - agxLuma) * uAgxLook.y;
    color = clamp(color, 0.0, 1.0);
  }
  color = outset * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  color = REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 tonemapACES(vec3 color) {
  const mat3 inMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color /= 0.6;
  color = inMat * color;
  color = rrtOdtFit(color);
  color = outMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 tonemapReinhard(vec3 color) {
  const float whiteSq = 16.0;
  vec3 num = color * (1.0 + color / whiteSq);
  return clamp(num / (1.0 + color), 0.0, 1.0);
}

vec3 encodeSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 applyLut(vec3 c) {
  float scale = (uLutSize - 1.0) / uLutSize;
  float offset = 0.5 / uLutSize;
  vec3 uvw = clamp(c, 0.0, 1.0) * scale + offset;
  return texture(tLut, uvw).rgb;
}

void main() {
  vec3 color = max(texture(tInput, vUv).rgb, vec3(0.0));

  float exposure = uExposure;
  if (uAutoExposure > 0.5) {
    float avgLum = exp2(texture(tAdapt, vec2(0.5)).r);
    float auto_ = uKey / max(avgLum, 1e-4);
    exposure *= clamp(auto_, uMinExposure, uMaxExposure);
  }
  color *= exposure;

  // White balance in linear, LMS (von Kries) space.
  vec3 lms = LIN_2_LMS * color;
  lms *= uWhiteBalance;
  color = max(LMS_2_LIN * lms, vec3(0.0));

#if TONEMAP_MODE == 0
  color = tonemapAgX(color);
#elif TONEMAP_MODE == 1
  color = tonemapACES(color);
#elif TONEMAP_MODE == 2
  color = tonemapReinhard(color);
#else
  color = clamp(color, 0.0, 1.0);
#endif

  vec3 display = encodeSrgb(color);

#if USE_LUT
  display = mix(display, applyLut(display), uLutStrength);
#endif

  fragColor = vec4(display, 1.0);
}
`;

const MODES: Record<string, number> = { agx: 0, aces: 1, reinhard: 2, none: 3 };

export class TonemapPass extends BasePass {
  readonly name = 'tonemap';
  readonly order = PASS_ORDER.EXPOSURE;

  private luminance!: THREE.ShaderMaterial;
  private reduce!: THREE.ShaderMaterial;
  private adaptMat!: THREE.ShaderMaterial;
  private tonemap!: THREE.ShaderMaterial;
  private lut: THREE.Data3DTexture | null = null;
  private flip = 0;
  private lastFrame = -1;

  /**
   * GPU eye adaptation. Turn this off if `RenderSystem` resolves auto-exposure
   * itself and feeds it through `PassContext.exposure`.
   */
  autoExposure = true;
  /** Target luminance the adaptation aims at (18% grey). */
  key = 0.11;
  minExposure = 0.2;
  maxExposure = 4.5;
  /** Luminance clamp applied before the log average — see LUMINANCE_FRAG. */
  meterMin = 0.02;
  meterMax = 50;
  adaptUpSpeed = 2.6;
  adaptDownSpeed = 1.1;
  /** Colour temperature / tint in [-100,100], applied in linear. */
  temperature = 4;
  tint = 0;
  lutStrength = 1;
  /** AgX look: x = contrast power about the log midpoint, y = saturation. */
  readonly agxLook = new THREE.Vector3(1.15, 1.14, 0);
  grade: GradeSettings = { ...DEFAULT_GRADE };
  /** True when this pass encodes sRGB itself (it always does — see the header). */
  readonly outputsSrgb = true;

  private gradeKey = '';
  private readonly wb = new THREE.Vector3(1, 1, 1);

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.renderer.getContext().getExtension('EXT_color_buffer_float');

    this.luminance = this.makeMaterial({
      name: 'tonemap/luminance',
      fragment: LUMINANCE_FRAG,
      uniforms: {
        tInput: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uLumaMin: { value: 0.02 },
        uLumaMax: { value: 50 },
      },
    });
    this.reduce = this.makeMaterial({
      name: 'tonemap/reduce',
      fragment: REDUCE_FRAG,
      uniforms: { tInput: { value: null }, uSourceTexel: { value: new THREE.Vector2() } },
    });
    this.adaptMat = this.makeMaterial({
      name: 'tonemap/adapt',
      fragment: ADAPT_FRAG,
      uniforms: {
        tCurrent: { value: null }, tPrev: { value: null },
        uSpeedUp: { value: 2.6 }, uSpeedDown: { value: 1.1 },
        uDt: { value: 1 / 60 }, uReset: { value: 1 },
      },
    });
    this.tonemap = this.makeMaterial({
      name: 'tonemap/tonemap',
      fragment: TONEMAP_FRAG,
      defines: { TONEMAP_MODE: 0, USE_LUT: 1 },
      uniforms: {
        tInput: { value: null },
        tAdapt: { value: null },
        tLut: { value: null },
        uExposure: { value: 1 },
        uAutoExposure: { value: 1 },
        uKey: { value: 0.11 },
        uMinExposure: { value: 0.2 },
        uMaxExposure: { value: 4.5 },
        uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
        uLutSize: { value: LUT_SIZE },
        uLutStrength: { value: 1 },
        uAgxLook: { value: new THREE.Vector3(1.15, 1.14, 0) },
      },
    });
    this.refreshLut();
  }

  /** Rebuilds the LUT after `grade` has been mutated. */
  refreshLut(): void {
    const key = JSON.stringify(this.grade);
    if (key === this.gradeKey && this.lut) return;
    this.gradeKey = key;
    this.lut = gradeLutTexture(this.grade);
    this.tonemap.uniforms.tLut.value = this.lut;
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    if (!this.enabled) return false;
    const g = ctx.settings;
    const pool = this.res.pool;

    const advance = ctx.frame !== this.lastFrame;
    if (advance) { this.flip ^= 1; this.lastFrame = ctx.frame; }

    // Publish the exposure curve so bloom and the lens pass — which run before
    // this one — can threshold in the same exposed units.
    const params = this.res.exposureParams;
    params.base = Math.max(0, ctx.exposure * g.exposure);
    params.key = this.key;
    params.min = this.minExposure;
    params.max = this.maxExposure;
    params.auto = this.autoExposure ? 1 : 0;

    /* --- eye adaptation ----------------------------------------------------*/
    const useAuto = this.autoExposure;
    let adaptTex: THREE.Texture | null = null;
    if (useAuto) {
      const spec = { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.LinearFilter };
      let w = Math.max(1, Math.ceil(ctx.width / 16));
      let h = Math.max(1, Math.ceil(ctx.height / 16));
      const first = pool.get('tm.lum0', w, h, spec);
      const lu = this.luminance.uniforms;
      lu.tInput.value = input;
      (lu.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
      lu.uLumaMin.value = this.meterMin;
      lu.uLumaMax.value = this.meterMax;
      ctx.blit(this.luminance, first);

      let src = first;
      let level = 1;
      while ((w > 1 || h > 1) && level < 8) {
        const sw = w, sh = h;
        w = Math.max(1, w >> 2);
        h = Math.max(1, h >> 2);
        const rt = pool.get(`tm.lum${level}`, w, h, spec);
        const ru = this.reduce.uniforms;
        ru.tInput.value = src.texture;
        (ru.uSourceTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
        ctx.blit(this.reduce, rt);
        src = rt;
        level++;
      }

      const cur = pool.get(`tm.adapt${this.flip}`, 1, 1, spec);
      const prev = pool.get(`tm.adapt${this.flip ^ 1}`, 1, 1, spec);
      const au = this.adaptMat.uniforms;
      au.tCurrent.value = src.texture;
      au.tPrev.value = prev.texture;
      au.uSpeedUp.value = this.adaptUpSpeed;
      au.uSpeedDown.value = this.adaptDownSpeed;
      au.uDt.value = Math.min(0.1, Math.max(1 / 240, ctx.dt));
      au.uReset.value = ctx.frame < 3 ? 1 : 0;
      ctx.blit(this.adaptMat, cur);
      adaptTex = cur.texture;
      this.res.adaptation = adaptTex;
    }

    /* --- tonemap + grade ---------------------------------------------------*/
    this.refreshLut();
    this.setDefine(this.tonemap, 'TONEMAP_MODE', MODES[g.tonemap] ?? 0);
    this.setDefine(this.tonemap, 'USE_LUT', g.colorGrade && this.lutStrength > 0 ? 1 : 0);

    whiteBalanceCoeffs(this.temperature, this.tint, this.wb);
    const u = this.tonemap.uniforms;
    u.tInput.value = input;
    u.tAdapt.value = adaptTex;
    u.uExposure.value = Math.max(0, ctx.exposure * g.exposure);
    u.uAutoExposure.value = useAuto ? 1 : 0;
    u.uKey.value = this.key;
    u.uMinExposure.value = this.minExposure;
    u.uMaxExposure.value = this.maxExposure;
    (u.uWhiteBalance.value as THREE.Vector3).copy(this.wb);
    u.uLutSize.value = LUT_SIZE;
    u.uLutStrength.value = this.lutStrength;
    (u.uAgxLook.value as THREE.Vector3).copy(this.agxLook);
    ctx.blit(this.tonemap, output);
    return true;
  }
}
