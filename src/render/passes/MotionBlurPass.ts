/**
 * Motion blur — tile-max / neighbour-max reconstruction (McGuire et al. 2012).
 *
 *   tileMax X → tileMax Y → neighbourMax → reconstruction
 *
 * The reconstruction filter alternates between the pixel's own velocity and the
 * dominant velocity of its tile neighbourhood, weighting each tap by a
 * depth-aware foreground/background classification. That is what lets a fast
 * mover smear *over* a static background instead of only smearing itself, which
 * is the difference between "camera blur" and film-accurate object blur.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const TILE_X_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tVelocity;
uniform vec2 uSourceTexel;
uniform float uTile;
uniform float uScale;
uniform float uMaxLength;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = 0.0;
  for (int i = 0; i < MB_TILE; i++) {
    vec2 uv = vec2(vUv.x + (float(i) - uTile * 0.5 + 0.5) * uSourceTexel.x, vUv.y);
    vec2 v = texture(tVelocity, uv).xy * uScale;
    float l = length(v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  if (bestLen > uMaxLength) best *= uMaxLength / bestLen;
  fragColor = vec4(best, 0.0, 1.0);
}
`;

const TILE_Y_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
uniform float uTile;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = 0.0;
  for (int i = 0; i < MB_TILE; i++) {
    vec2 uv = vec2(vUv.x, vUv.y + (float(i) - uTile * 0.5 + 0.5) * uSourceTexel.y);
    vec2 v = texture(tInput, uv).xy;
    float l = length(v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  fragColor = vec4(best, 0.0, 1.0);
}
`;

const NEIGHBOUR_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
layout(location = 0) out vec4 fragColor;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texture(tInput, vUv + vec2(float(x), float(y)) * uTexel).xy;
      float l = length(v);
      // McGuire's diagonal rule: a corner tile only wins if its velocity points
      // back toward the centre, otherwise it cannot possibly reach this pixel.
      if (x != 0 && y != 0) {
        vec2 dir = vec2(float(x), float(y));
        if (dot(v, dir) >= 0.0) continue;
      }
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  fragColor = vec4(best, 0.0, 1.0);
}
`;

const RECONSTRUCT_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tVelocity;
uniform sampler2D tNeighbour;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uScale;
uniform float uMaxLength;
uniform float uFrame;
uniform float uJitter;
uniform float uBgBoost;
uniform float uDepthScale;
layout(location = 0) out vec4 fragColor;

float softDepthCompare(float za, float zb) { return sat(1.0 - (za - zb) / uDepthScale); }
float coneWeight(float dist, float speed) { return sat(1.0 - dist / max(speed, 1e-4)); }
float cylinderWeight(float dist, float speed) {
  return 1.0 - smoothstep(0.95 * speed, 1.05 * speed, dist);
}
float depthAt(vec2 uv) {
  float d = texture(tDepth, uv).r;
  return d >= 1.0 ? uFar : linearizeDepth(d, uNear, uFar);
}

void main() {
  vec3 centre = texture(tInput, vUv).rgb;
  vec2 vN = texture(tNeighbour, vUv).xy;
  float vNlen = length(vN);
  if (vNlen < 1.0) { fragColor = vec4(centre, 1.0); return; }

  vec2 vX = texture(tVelocity, vUv).xy * uScale;
  float vXlen = length(vX);
  if (vXlen > uMaxLength) vX *= uMaxLength / vXlen;
  vXlen = max(length(vX), 0.5);

  float zX = depthAt(vUv);
  vec2 wN = vN / vNlen;
  vec2 wX = vX / vXlen;
  if (dot(wX, wN) < 0.0) wX = -wX;

  float jitter = (blueNoise1T(gl_FragCoord.xy, uFrame) - 0.5) * uJitter;

  float weight = float(MB_SAMPLES) / (40.0 * vXlen);
  vec3 sum = centre * weight;

  for (int j = 0; j < MB_SAMPLES; j++) {
    if (j == MB_SAMPLES / 2) continue;
    float t = mix(-1.0, 1.0, (float(j) + jitter + 1.0) / (float(MB_SAMPLES) + 1.0));
    vec2 dir = (j % 2 == 1) ? wX : wN;
    float T = t * vNlen;
    vec2 uv = vUv + dir * T * uTexel;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;

    float zY = depthAt(uv);
    vec2 vY = texture(tVelocity, uv).xy * uScale;
    float vYlen = max(length(vY), 0.5);

    /* depthAt() returns a *positive* distance, the opposite sign convention to
       McGuire's view-space z. fg must therefore be 1 when the tap is in front
       of the centre (a mover smearing over us) and bg 1 when it is behind
       (us smearing over it). With the two swapped — which is what this pass
       shipped with — the first term fires for taps that are *further away* than
       the centre, and it trusts their velocity while reading their depth.
       Alpha particles are exactly that pathological case: smoke writes a motion
       vector but leaves the depth of whatever is behind it, so every static
       pixel found a 20-pixel-distant "fast mover" at sky depth and dragged its
       colour across the frame. That is the horizontal streaking over the tram
       and the dither speckle in the shadowed geometry. */
    float fg = softDepthCompare(zY, zX);
    float bg = softDepthCompare(zX, zY);
    float dist = abs(T);

    float w = uBgBoost * fg * coneWeight(dist, vYlen) * sat(dot(normalize(vY + vec2(1e-5)), dir))
            + bg * coneWeight(dist, vXlen) * sat(dot(wX, dir))
            + cylinderWeight(dist, vYlen) * cylinderWeight(dist, vXlen) * 2.0;

    weight += w;
    sum += texture(tInput, uv).rgb * w;
  }

  fragColor = vec4(sum / max(weight, 1e-4), 1.0);
}
`;

const TILE = 20;

export class MotionBlurPass extends BasePass {
  readonly name = 'motionblur';
  readonly order = PASS_ORDER.MOTION_BLUR;

  private tileX!: THREE.ShaderMaterial;
  private tileY!: THREE.ShaderMaterial;
  private neighbour!: THREE.ShaderMaterial;
  private reconstruct!: THREE.ShaderMaterial;

  /**
   * Longest blur trail, in pixels at 1080p. The reconstruction spends a fixed
   * sample budget over this span, so the span is what sets the noise floor —
   * and because this pass runs *after* TAA, that noise is never resolved away.
   */
  maxRadius = 10;
  /** Reconstruction taps. */
  sampleCount = 24;
  /** Amplitude of the per-pixel dither on the tap positions, 0..1. */
  jitterAmount = 1;
  /**
   * Weight of the "a fast mover reaches over this static pixel" term. Alpha
   * particles write velocity at the depth of whatever is *behind* them, which
   * makes this term smear smoke across static geometry.
   */
  backgroundBoost = 1;
  /** Metres of depth difference over which the fg/bg classification softens. */
  depthScale = 0.6;

  constructor(res: PostResources) {
    super(res);
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (params.get('capture') === '1') {
      (globalThis as unknown as Record<string, unknown>).__MB__ = this;
    }
  }

  protected override onSetup(): void {
    this.tileX = this.makeMaterial({
      name: 'motionblur/tilex',
      fragment: TILE_X_FRAG,
      defines: { MB_TILE: TILE },
      uniforms: {
        tVelocity: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uTile: { value: TILE },
        uScale: { value: 1 },
        uMaxLength: { value: TILE },
      },
    });
    this.tileY = this.makeMaterial({
      name: 'motionblur/tiley',
      fragment: TILE_Y_FRAG,
      defines: { MB_TILE: TILE },
      uniforms: {
        tInput: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uTile: { value: TILE },
      },
    });
    this.neighbour = this.makeMaterial({
      name: 'motionblur/neighbour',
      fragment: NEIGHBOUR_FRAG,
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this.reconstruct = this.makeMaterial({
      name: 'motionblur/reconstruct',
      fragment: RECONSTRUCT_FRAG,
      blueNoise: true,
      defines: { MB_SAMPLES: 12 },
      uniforms: {
        tInput: { value: null },
        tVelocity: { value: null },
        tNeighbour: { value: null },
        tDepth: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uScale: { value: 1 },
        uMaxLength: { value: TILE },
        uFrame: { value: 0 },
        uJitter: { value: 1 },
        uBgBoost: { value: 1 },
        uDepthScale: { value: 0.6 },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.motionBlur || g.motionBlurStrength <= 0) return false;

    const pool = this.res.pool;
    const velSpec = { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.NearestFilter };
    const tw = Math.max(1, Math.ceil(ctx.width / TILE));
    const th = Math.max(1, Math.ceil(ctx.height / TILE));

    // Shutter: velocity is per-frame, so strength maps directly to shutter angle.
    const scale = Math.min(2, g.motionBlurStrength);
    const maxLength = Math.max(2, Math.min(TILE, this.maxRadius * (ctx.height / 1080)));

    const tx = pool.get('mb.tilex', tw, ctx.height, velSpec);
    const ty = pool.get('mb.tiley', tw, th, velSpec);
    const nb = pool.get('mb.neighbour', tw, th, velSpec);

    const ux = this.tileX.uniforms;
    ux.tVelocity.value = ctx.gbuffer.velocity;
    (ux.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    ux.uScale.value = scale;
    ux.uMaxLength.value = maxLength;
    ctx.blit(this.tileX, tx);

    const uy = this.tileY.uniforms;
    uy.tInput.value = tx.texture;
    (uy.uSourceTexel.value as THREE.Vector2).set(1 / tw, 1 / ctx.height);
    ctx.blit(this.tileY, ty);

    const un = this.neighbour.uniforms;
    un.tInput.value = ty.texture;
    (un.uTexel.value as THREE.Vector2).set(1 / tw, 1 / th);
    ctx.blit(this.neighbour, nb);

    const samples = g.motionBlurStrength > 0.8 ? this.sampleCount : Math.max(8, this.sampleCount >> 1);
    this.setDefine(this.reconstruct, 'MB_SAMPLES', samples);
    const ur = this.reconstruct.uniforms;
    ur.tInput.value = input;
    ur.tVelocity.value = ctx.gbuffer.velocity;
    ur.tNeighbour.value = nb.texture;
    ur.tDepth.value = ctx.gbuffer.depth;
    (ur.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    ur.uNear.value = ctx.cameraNear;
    ur.uFar.value = ctx.cameraFar;
    ur.uScale.value = scale;
    ur.uMaxLength.value = maxLength;
    ur.uFrame.value = ctx.frame % 64;
    ur.uJitter.value = this.jitterAmount;
    ur.uBgBoost.value = this.backgroundBoost;
    ur.uDepthScale.value = this.depthScale;
    ctx.blit(this.reconstruct, output);
    return true;
  }
}
