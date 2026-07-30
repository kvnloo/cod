/**
 * Lens artefacts: procedural dirt, anamorphic streaks and ghost/halo flare.
 *
 * All three are driven by the bloom pyramid the previous pass left behind, which
 * means they cost three small draws rather than another full-resolution blur.
 * The dirt mask is generated in code (see ./LensDirt) — nothing is loaded.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import { lensDirtTexture } from './LensDirt';
import { AUTO_EXPOSURE } from './Shaders';
import { applyExposureUniforms, exposureUniforms, type PostResources } from './Shared';

const STREAK_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uStride;
uniform float uAttenuation;
uniform float uThreshold;
uniform vec3 uTint;
layout(location = 0) out vec4 fragColor;

${AUTO_EXPOSURE}

void main() {
  // Separable horizontal pass with exponentially decaying weights. Run three
  // times with a geometrically growing stride it approximates a 250-tap smear
  // for 39 taps of work. Weights are normalised, so a point source spreads and
  // dims rather than painting a constant bar across the row.
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  // The bloom pyramid is stored in exposed units, so the scene-referred
  // threshold has to travel through the same exposure curve.
  float threshold = uThreshold * resolveExposure();
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = pow(uAttenuation, abs(fi));
    vec2 uv = vUv + vec2(fi * uStride * uTexel.x, 0.0);
    vec3 c = texture(tInput, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
    // Only genuinely bright sources streak; without this the whole frame smears.
    c = max(c - threshold, vec3(0.0));
    sum += c * w;
    wsum += w;
  }
  fragColor = vec4(sum / max(wsum, 1e-4) * uTint, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tDirt;
uniform float uDirt;
uniform float uStreak;
uniform float uGhost;
uniform float uHalo;
uniform float uDispersal;
uniform float uHaloWidth;
uniform float uFlareThreshold;
uniform vec3 uStreakTint;
layout(location = 0) out vec4 fragColor;

${AUTO_EXPOSURE}

/* Slightly different scales per channel: a real optic disperses ghosts.
   Thresholded, because only sources far brighter than the frame produce a
   visible internal reflection. */
vec3 chromaticBloom(vec2 uv, float amount) {
  vec2 c = vec2(0.5);
  vec2 d = uv - c;
  vec3 s = vec3(
    texture(tBloom, c + d * (1.0 - amount)).r,
    texture(tBloom, c + d).g,
    texture(tBloom, c + d * (1.0 + amount)).b);
  return max(s - uFlareThreshold * resolveExposure(), vec3(0.0));
}

void main() {
  vec4 base = texture(tInput, vUv);
  vec3 add = vec3(0.0);
  float inv = 1.0 / max(resolveExposure(), 1e-4);

  if (uDirt > 0.0) {
    vec3 dirt = texture(tDirt, vUv).rgb;
    vec3 bloom = max(texture(tBloom, vUv).rgb, vec3(0.0)) * inv;
    add += bloom * dirt * uDirt;
  }

  if (uStreak > 0.0) {
    add += max(texture(tStreak, vUv).rgb, vec3(0.0)) * inv * uStreakTint * uStreak;
  }

  if (uGhost > 0.0 || uHalo > 0.0) {
    vec2 c = vec2(0.5);
    // Ghosts march along the vector from the pixel through the frame centre.
    vec2 ghostVec = (c - vUv) * uDispersal;
    vec3 ghosts = vec3(0.0);
    for (int i = 1; i <= 3; i++) {
      vec2 offs = vUv + ghostVec * float(i);
      if (any(lessThan(offs, vec2(0.0))) || any(greaterThan(offs, vec2(1.0)))) continue;
      float w = length(c - offs) / length(c);
      w = pow(sat(1.0 - w), 12.0);
      ghosts += max(chromaticBloom(offs, 0.012 * float(i)), vec3(0.0)) * w;
    }
    add += ghosts * inv * uGhost;

    vec2 haloVec = normalize(ghostVec + vec2(1e-6)) * uHaloWidth;
    vec2 hUv = vUv + haloVec;
    if (all(greaterThanEqual(hUv, vec2(0.0))) && all(lessThanEqual(hUv, vec2(1.0)))) {
      // A wide, soft halo: a tight one reads as a hard ring, which is the most
      // artificial artefact a lens model can produce.
      float w = length(c - hUv) / length(c);
      w = pow(sat(1.0 - w), 3.0) * (1.0 - smoothstep(0.55, 1.0, w));
      add += max(chromaticBloom(hUv, 0.03), vec3(0.0)) * inv * w * uHalo;
    }
  }

  fragColor = vec4(base.rgb + add, base.a);
}
`;

export class LensPass extends BasePass {
  readonly name = 'lens';
  readonly order = PASS_ORDER.LENS;

  private streak!: THREE.ShaderMaterial;
  private composite!: THREE.ShaderMaterial;
  private dirt: THREE.DataTexture | null = null;

  /** Anamorphic streak strength; 0 disables the streak passes entirely. */
  anamorphic = 0.18;
  /** Ghost/halo flare strength. Small on purpose — visible ghosting reads as a
   *  filter, not an optic. */
  flare = 0.05;
  /** Scene-referred luminance a source must exceed to streak or ghost. */
  flareThreshold = 8.0;

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.dirt = lensDirtTexture();
    this.dirt.anisotropy = 4;

    this.streak = this.makeMaterial({
      name: 'lens/streak',
      fragment: STREAK_FRAG,
      uniforms: {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStride: { value: 1 },
        uAttenuation: { value: 0.78 },
        uThreshold: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        ...exposureUniforms(),
      },
    });

    this.composite = this.makeMaterial({
      name: 'lens/composite',
      fragment: COMPOSITE_FRAG,
      uniforms: {
        tInput: { value: null },
        tBloom: { value: null },
        tStreak: { value: null },
        tDirt: { value: this.dirt },
        uDirt: { value: 0.5 },
        uStreak: { value: 0.5 },
        uGhost: { value: 0.35 },
        uHalo: { value: 0.25 },
        ...exposureUniforms(),
        uDispersal: { value: 0.22 },
        uHaloWidth: { value: 0.33 },
        uFlareThreshold: { value: 1.5 },
        uStreakTint: { value: new THREE.Vector3(0.5, 0.72, 1.4) },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    const bloom = this.res.bloom;
    const wantDirt = g.lensDirt > 0;
    const wantStreak = this.anamorphic > 0 && g.lensDirt > 0;
    const wantFlare = this.flare > 0 && g.lensDirt > 0;
    if (!this.enabled || !bloom || (!wantDirt && !wantStreak && !wantFlare)) return false;

    const pool = this.res.pool;
    const spec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };
    const sw = Math.max(8, ctx.width >> 2);
    const sh = Math.max(8, ctx.height >> 2);
    const base = Math.max(1e-3, ctx.exposure * g.exposure);
    applyExposureUniforms(this.composite, this.res, base);
    applyExposureUniforms(this.streak, this.res, base);

    let streakTex: THREE.Texture | null = null;
    if (wantStreak) {
      const a = pool.get('lens.streakA', sw, sh, spec);
      const b = pool.get('lens.streakB', sw, sh, spec);
      const u = this.streak.uniforms;
      (u.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      u.uAttenuation.value = 0.76;
      // Strides 1 / 4 / 16 at quarter resolution: an effective +-500px smear.
      const strides = [1, 4, 10];
      let src: THREE.Texture = bloom;
      let dst = a;
      for (let i = 0; i < strides.length; i++) {
        u.tInput.value = src;
        u.uStride.value = strides[i];
        // Threshold only on the first pass, in the bloom's exposed units.
        u.uThreshold.value = i === 0 ? this.flareThreshold : 0;
        (u.uTint.value as THREE.Vector3).set(1, 1, 1);
        ctx.blit(this.streak, dst);
        src = dst.texture;
        dst = dst === a ? b : a;
      }
      streakTex = src;
    }

    const cu = this.composite.uniforms;
    cu.tInput.value = input;
    cu.tBloom.value = bloom;
    cu.tStreak.value = streakTex ?? bloom;
    cu.uDirt.value = wantDirt ? g.lensDirt * 0.9 : 0;
    cu.uStreak.value = streakTex ? this.anamorphic : 0;
    cu.uGhost.value = wantFlare ? this.flare : 0;
    cu.uHalo.value = wantFlare ? this.flare * 0.35 : 0;
    cu.uFlareThreshold.value = this.flareThreshold;
    ctx.blit(this.composite, output);
    return true;
  }
}
