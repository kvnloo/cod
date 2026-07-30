/**
 * Film grain, natural vignette, lateral chromatic aberration and dithering.
 *
 * All four are the "lens and film" layer that sits between a clean render and a
 * photographed image:
 *
 *  - grain is Gaussian, animated with a golden-ratio-rotated blue-noise mask, and
 *    weighted toward the shadows the way silver-halide grain actually behaves
 *    (visible grain in the highlights is the classic wrong-looking version)
 *  - the vignette is the physical cos⁴ falloff plus a small artistic term
 *  - aberration is lateral: zero at the optical centre, growing with r², sampled
 *    as a short spectral smear rather than three hard fringes
 *  - an ordered dither breaks up the banding an 8-bit backbuffer would show in
 *    smooth gradients
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const GRAIN_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uAberration;
uniform float uGrain;
uniform float uVignette;
uniform float uFrame;
uniform float uTime;
uniform float uDither;
uniform float uExposureScale;
layout(location = 0) out vec4 fragColor;

vec3 sampleAberrated(vec2 uv, float amount) {
  vec2 centre = vec2(0.5);
  vec2 d = uv - centre;
  float r2 = dot(d, d) * 4.0;
  // Lateral aberration grows with the *fourth* power of field height, so the
  // centre two thirds of the frame is left completely alone and the corner
  // displacement stays under a pixel. An r^2 law at a visible corner amount
  // still smears half a percent of the frame width across the mid-field, which
  // is what put coloured fringes on ordinary silhouette edges.
  float k = amount * r2 * r2;
  if (k < 1e-6) return texture(tInput, uv).rgb;

  // Five-tap spectral smear along the radial direction.
  vec3 sum = vec3(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float t = (float(i) / 4.0) * 2.0 - 1.0;   // -1 .. 1
    vec2 suv = uv + d * (k * t);
    vec3 c = texture(tInput, clamp(suv, vec2(0.0), vec2(1.0))).rgb;
    // Weight each tap toward one end of the spectrum.
    vec3 w = vec3(sat(1.0 - abs(t - 0.6) * 1.6),
                  sat(1.0 - abs(t) * 1.6),
                  sat(1.0 - abs(t + 0.6) * 1.6));
    sum += c * w;
    wsum += w;
  }
  return sum / max(wsum, vec3(1e-4));
}

void main() {
  vec3 color = sampleAberrated(vUv, uAberration);

  /* --- vignette: physical cos^4 plus a gentle artistic falloff ------------ */
  if (uVignette > 0.0) {
    vec2 d = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    float r = length(d) * 1.32;
    float cosTheta = 1.0 / sqrt(1.0 + r * r);
    float natural = cosTheta * cosTheta * cosTheta * cosTheta;
    float artistic = smoothstep(1.15, 0.32, r);
    color *= mix(1.0, natural * mix(1.0, artistic, 0.65), uVignette);
  }

  /* --- grain -------------------------------------------------------------- */
  vec4 n = blueNoise4T(gl_FragCoord.xy, uFrame);
  if (uGrain > 0.0) {
    // Two decorrelated blue-noise taps make an approximately Gaussian variate.
    float g1 = n.x + n.y - 1.0;
    float g2 = n.z + n.w - 1.0;
    float lum = luma(color);
    // Silver-halide response: grain peaks in the mid-shadows, vanishes in the
    // highlights, and scales down as exposure (and therefore signal) rises.
    float response = pow(1.0 - lum, 2.2) * (0.30 + 0.70 * smoothstep(0.0, 0.20, lum));
    float amount = uGrain * response * uExposureScale;
    // Grain is overwhelmingly a luminance phenomenon. Giving R and B fully
    // decorrelated noise (which is what independent g1/g2 does) reads as
    // magenta/green chroma speckle in the shadows, not as film.
    vec3 chroma = vec3(g2, -0.5 * g2, 0.35 * g2) * 0.16;
    color += (vec3(g1) + chroma) * amount * 0.055;
  }

  /* --- dither ------------------------------------------------------------- */
  // Triangular-PDF blue noise at exactly one 8-bit step peak-to-peak. TPDF is
  // the correct quantisation dither: it removes the banding *and* the
  // signal-dependent modulation a uniform (or ordered Bayer) dither leaves
  // behind. Bayer in particular tiles a visible 8x8 cross-hatch over every flat
  // gradient, which is precisely the "stipple" it was supposed to prevent.
  float tri = (n.z + fract(n.w + BLK_GOLDEN)) - 1.0;
  color += tri * uDither;

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export class GrainPass extends BasePass {
  readonly name = 'grain';
  readonly order = PASS_ORDER.GRAIN;

  private grain!: THREE.ShaderMaterial;

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.grain = this.makeMaterial({
      name: 'grain/composite',
      fragment: GRAIN_FRAG,
      blueNoise: true,
      uniforms: {
        tInput: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        uTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uAberration: { value: 0.003 },
        uGrain: { value: 0.35 },
        uVignette: { value: 0.4 },
        uFrame: { value: 0 },
        uTime: { value: 0 },
        uDither: { value: 1 / 255 },
        uExposureScale: { value: 1 },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    // Always runs: this pass also owns the output dither, and skipping it would
    // leave the 8-bit backbuffer to band on its own.
    if (!this.enabled) return false;

    const u = this.grain.uniforms;
    u.tInput.value = input;
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    (u.uResolution.value as THREE.Vector2).set(ctx.width, ctx.height);
    // Under a pixel of displacement at the extreme corner, nothing at all before
    // ~65% field height — see sampleAberrated.
    u.uAberration.value = g.chromaticAberration * 0.0006;
    u.uGrain.value = g.filmGrain;
    u.uVignette.value = g.vignette;
    u.uFrame.value = ctx.frame % 64;
    u.uTime.value = ctx.time;
    u.uDither.value = 1 / 255;
    // Grain is exposure-responsive: a darker scene is amplified more, so grain
    // grows the way it does when a camera pushes ISO. Bounded tightly — a 2.2x
    // multiplier on top of the shadow response is how it ended up visible as
    // colour noise across the whole road surface.
    u.uExposureScale.value = THREE.MathUtils.clamp(1 / Math.max(0.2, ctx.exposure), 0.75, 1.35);
    ctx.blit(this.grain, output);
    return true;
  }
}
