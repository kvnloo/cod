/**
 * Bloom — progressive dual-filter pyramid.
 *
 *   prefilter (log-space soft-knee threshold, firefly clamp)
 *     → 13-tap downsample chain, Karis-averaged on the first mip
 *     → 9-tap tent upsample, scatter-blended back down the chain
 *     → additive composite
 *
 * The Karis average on mip 0 is what stops a single blown-out pixel from
 * producing a flickering star; the log-space knee is what keeps the threshold
 * from clipping into a hard ring around bright objects.
 *
 * The final pyramid level is published on `PostResources.bloom` so the lens pass
 * can modulate dirt and streaks with it instead of re-blurring the frame.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import { AUTO_EXPOSURE } from './Shaders';
import { applyExposureUniforms, exposureUniforms, type PostResources } from './Shared';

const PREFILTER_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
layout(location = 0) out vec4 fragColor;

${AUTO_EXPOSURE}

vec3 fetch(vec2 uv) {
  return max(texture(tInput, uv).rgb, vec3(0.0));
}

void main() {
  float exposure = resolveExposure();
  // 4-tap box downsample first so the threshold sees an anti-aliased signal.
  vec2 t = uSourceTexel;
  vec3 c = fetch(vUv + vec2(-t.x, -t.y) * 0.5) * 0.25;
  c += fetch(vUv + vec2(t.x, -t.y) * 0.5) * 0.25;
  c += fetch(vUv + vec2(-t.x, t.y) * 0.5) * 0.25;
  c += fetch(vUv + vec2(t.x, t.y) * 0.5) * 0.25;
  c *= exposure;

  // Firefly clamp before thresholding — a 5000-nit speck would otherwise survive
  // every filter and shimmer.
  float br = maxc(c);
  if (br > uClamp) c *= uClamp / br;
  br = min(br, uClamp);

  // Soft knee in log2 (stops) space: a genuinely smooth onset instead of the
  // quadratic ramp that leaves a visible contour.
  float lb = log2(br + 1e-5);
  float lt = log2(max(uThreshold, 1e-4));
  float w = smoothstep(lt - uKnee, lt + uKnee, lb);
  fragColor = vec4(c * w, 1.0);
}
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
layout(location = 0) out vec4 fragColor;

vec3 T(vec2 o) { return texture(tInput, vUv + o * uSourceTexel).rgb; }

void main() {
  vec3 a = T(vec2(-2.0,  2.0)), b = T(vec2(0.0,  2.0)), c = T(vec2(2.0,  2.0));
  vec3 d = T(vec2(-2.0,  0.0)), e = T(vec2(0.0,  0.0)), f = T(vec2(2.0,  0.0));
  vec3 g = T(vec2(-2.0, -2.0)), h = T(vec2(0.0, -2.0)), i = T(vec2(2.0, -2.0));
  vec3 j = T(vec2(-1.0,  1.0)), k = T(vec2(1.0,  1.0));
  vec3 l = T(vec2(-1.0, -1.0)), m = T(vec2(1.0, -1.0));

#if BLOOM_KARIS
  vec3 g0 = (a + b + d + e) * 0.25;
  vec3 g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
  float w0 = karisWeight(g0) * 0.125;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.5;
  vec3 result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4)
              / max(w0 + w1 + w2 + w3 + w4, 1e-5);
#else
  vec3 result = e * 0.125;
  result += (a + c + g + i) * 0.03125;
  result += (b + d + f + h) * 0.0625;
  result += (j + k + l + m) * 0.125;
#endif
  fragColor = vec4(result, 1.0);
}
`;

const UPSAMPLE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tSmall;    // the level below (lower resolution)
uniform sampler2D tLarge;    // this level's downsampled result
uniform vec2 uSmallTexel;
uniform float uRadius;
uniform float uScatter;
layout(location = 0) out vec4 fragColor;

vec3 tent(vec2 uv) {
  vec2 t = uSmallTexel * uRadius;
  vec3 s = texture(tSmall, uv + vec2(-t.x,  t.y)).rgb;
  s += texture(tSmall, uv + vec2(0.0,  t.y)).rgb * 2.0;
  s += texture(tSmall, uv + vec2(t.x,  t.y)).rgb;
  s += texture(tSmall, uv + vec2(-t.x,  0.0)).rgb * 2.0;
  s += texture(tSmall, uv).rgb * 4.0;
  s += texture(tSmall, uv + vec2(t.x,  0.0)).rgb * 2.0;
  s += texture(tSmall, uv + vec2(-t.x, -t.y)).rgb;
  s += texture(tSmall, uv + vec2(0.0, -t.y)).rgb * 2.0;
  s += texture(tSmall, uv + vec2(t.x, -t.y)).rgb;
  return s * (1.0 / 16.0);
}

void main() {
  vec3 low = tent(vUv);
  vec3 high = texture(tLarge, vUv).rgb;
  fragColor = vec4(mix(high, low, uScatter), 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tBloom;
uniform float uIntensity;
layout(location = 0) out vec4 fragColor;

${AUTO_EXPOSURE}

void main() {
  vec4 base = texture(tInput, vUv);
  // Bloom was accumulated in exposed units; bring it back to scene-referred so
  // the composite stays linear all the way to the tonemapper.
  vec3 bloom = max(texture(tBloom, vUv).rgb, vec3(0.0)) / max(resolveExposure(), 1e-4);
  fragColor = vec4(base.rgb + bloom * uIntensity, base.a);
}
`;

export class BloomPass extends BasePass {
  readonly name = 'bloom';
  readonly order = PASS_ORDER.BLOOM;

  private prefilter!: THREE.ShaderMaterial;
  private downsample!: THREE.ShaderMaterial;
  private upsample!: THREE.ShaderMaterial;
  private composite!: THREE.ShaderMaterial;
  private levels = 6;

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.renderer.getContext().getExtension('EXT_color_buffer_float');

    this.prefilter = this.makeMaterial({
      name: 'bloom/prefilter',
      fragment: PREFILTER_FRAG,
      uniforms: {
        tInput: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 1 },
        uKnee: { value: 0.7 },
        uClamp: { value: 48 },
        ...exposureUniforms(),
      },
    });
    this.downsample = this.makeMaterial({
      name: 'bloom/downsample',
      fragment: DOWNSAMPLE_FRAG,
      defines: { BLOOM_KARIS: 0 },
      uniforms: { tInput: { value: null }, uSourceTexel: { value: new THREE.Vector2() } },
    });
    this.upsample = this.makeMaterial({
      name: 'bloom/upsample',
      fragment: UPSAMPLE_FRAG,
      uniforms: {
        tSmall: { value: null }, tLarge: { value: null },
        uSmallTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 }, uScatter: { value: 0.68 },
      },
    });
    this.composite = this.makeMaterial({
      name: 'bloom/composite',
      fragment: COMPOSITE_FRAG,
      uniforms: {
        tInput: { value: null }, tBloom: { value: null },
        uIntensity: { value: 0.65 },
        ...exposureUniforms(),
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.bloom || g.bloomIntensity <= 0) { this.res.bloom = null; return false; }

    const pool = this.res.pool;
    const spec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };

    let w = Math.max(1, ctx.width >> 1);
    let h = Math.max(1, ctx.height >> 1);
    const maxLevels = Math.max(3, Math.min(7, Math.floor(Math.log2(Math.min(w, h))) - 2));
    this.levels = maxLevels;

    /* --- prefilter into mip 0 --------------------------------------------- */
    // Threshold in exposed space so bloom tracks the tonemapper, not raw radiance.
    applyExposureUniforms(this.prefilter, this.res, ctx.exposure * g.exposure);
    applyExposureUniforms(this.composite, this.res, ctx.exposure * g.exposure);
    const down: THREE.WebGLRenderTarget[] = [];
    const dn0 = pool.get('bloom.dn0', w, h, spec);
    const pu = this.prefilter.uniforms;
    pu.tInput.value = input;
    (pu.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    pu.uThreshold.value = Math.max(0.05, g.bloomThreshold);
    pu.uKnee.value = 0.75;
    pu.uClamp.value = 64;
    ctx.blit(this.prefilter, dn0);
    down.push(dn0);

    /* --- downsample chain --------------------------------------------------*/
    for (let i = 1; i < maxLevels; i++) {
      const sw = w, sh = h;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      const rt = pool.get(`bloom.dn${i}`, w, h, spec);
      this.setDefine(this.downsample, 'BLOOM_KARIS', i === 1 ? 1 : 0);
      const u = this.downsample.uniforms;
      u.tInput.value = down[i - 1].texture;
      (u.uSourceTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      ctx.blit(this.downsample, rt);
      down.push(rt);
    }

    /* --- tent upsample + scatter ------------------------------------------ */
    let small = down[maxLevels - 1];
    for (let i = maxLevels - 2; i >= 0; i--) {
      const large = down[i];
      const rt = pool.get(`bloom.up${i}`, large.width, large.height, spec);
      const u = this.upsample.uniforms;
      u.tSmall.value = small.texture;
      u.tLarge.value = large.texture;
      (u.uSmallTexel.value as THREE.Vector2).set(1 / small.width, 1 / small.height);
      u.uRadius.value = 1.0;
      u.uScatter.value = 0.68;
      ctx.blit(this.upsample, rt);
      small = rt;
    }

    this.res.bloom = small.texture;
    this.res.bloomStrength = g.bloomIntensity;

    /* --- composite ---------------------------------------------------------*/
    const cu = this.composite.uniforms;
    cu.tInput.value = input;
    cu.tBloom.value = small.texture;
    cu.uIntensity.value = g.bloomIntensity;
    ctx.blit(this.composite, output);
    return true;
  }
}
