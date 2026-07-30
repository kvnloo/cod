/**
 * Temporal anti-aliasing.
 *
 * Halton(2,3) jitter is applied to the projection by the frame graph (see
 * `haltonJitter` in ./BlueNoise); this pass resolves it. The resolve does:
 *
 *   - closest-depth velocity dilation so silhouettes drag their motion vector
 *   - Catmull-Rom history reconstruction (5-tap cross) to counter the blur that
 *     bilinear resampling of the history introduces
 *   - neighbourhood variance clipping in YCoCg, in a tonemapped domain so HDR
 *     fireflies cannot dominate the statistics
 *   - disocclusion rejection from the reprojected depth stored in history alpha
 *   - luminance-difference feedback modulation (Playdead style)
 *   - a bounded unsharp mask to restore the micro-contrast TAA eats
 *
 * When `taa` is off but `fxaaFallback` is on, a compact FXAA 3.11 quality filter
 * runs instead so the `low` preset still gets edge smoothing for ~0.2ms.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass, makeCopyMaterial } from './PassBase';
import type { PostResources } from './Shared';

const RESOLVE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uProj;
uniform mat4 uInverseView;
uniform mat4 uPrevViewProjection;
uniform float uNear;
uniform float uFar;
uniform float uFeedbackMin;
uniform float uFeedbackMax;
uniform float uSharpen;
uniform float uClipGamma;
uniform float uReset;
layout(location = 0) out vec4 fragColor;

vec3 viewFromLinear(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(z * (ndc.x + uProj.z) / uProj.x, z * (ndc.y + uProj.w) / uProj.y, -z);
}

/* 5-tap Catmull-Rom: sharp history resampling without the 9-tap cost. */
vec3 historyCatmullRom(vec2 uv) {
  vec2 samplePos = uv * uResolution;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 p0 = (texPos1 - 1.0) * uTexel;
  vec2 p3 = (texPos1 + 2.0) * uTexel;
  vec2 p12 = (texPos1 + offset12) * uTexel;

  vec3 result = vec3(0.0);
  float wsum = 0.0;
  float w;
  w = w12.x * w0.y;  result += texture(tHistory, vec2(p12.x, p0.y)).rgb * w;  wsum += w;
  w = w0.x * w12.y;  result += texture(tHistory, vec2(p0.x, p12.y)).rgb * w;  wsum += w;
  w = w12.x * w12.y; result += texture(tHistory, vec2(p12.x, p12.y)).rgb * w; wsum += w;
  w = w3.x * w12.y;  result += texture(tHistory, vec2(p3.x, p12.y)).rgb * w;  wsum += w;
  w = w12.x * w3.y;  result += texture(tHistory, vec2(p12.x, p3.y)).rgb * w;  wsum += w;
  return max(result / max(wsum, 1e-5), vec3(0.0));
}

vec3 clipToAABB(vec3 lo, vec3 hi, vec3 p) {
  vec3 centre = 0.5 * (hi + lo);
  vec3 extent = 0.5 * (hi - lo) + 1e-5;
  vec3 offset = p - centre;
  vec3 unit = abs(offset / extent);
  float m = max(unit.x, max(unit.y, unit.z));
  return m > 1.0 ? centre + offset / m : p;
}

void main() {
  /* --- closest-depth velocity dilation --------------------------------- */
  float closest = 1.0;
  vec2 closestUv = vUv;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      float d = texture(tDepth, uv).r;
      if (d < closest) { closest = d; closestUv = uv; }
    }
  }
  vec2 velocity = texture(tVelocity, closestUv).xy;
  vec2 prevUv = vUv - velocity * uTexel;

  /* --- current neighbourhood statistics in tonemapped YCoCg ------------ */
  vec3 taps[9];
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 nmin = vec3(1e9);
  vec3 nmax = vec3(-1e9);
  int idx = 0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = texture(tInput, vUv + vec2(float(x), float(y)) * uTexel).rgb;
      c = rgbToYCoCg(tonemapForResolve(max(c, vec3(0.0))));
      taps[idx++] = c;
      m1 += c;
      m2 += c * c;
      nmin = min(nmin, c);
      nmax = max(nmax, c);
    }
  }
  vec3 current = taps[4];

  float depth = texture(tDepth, vUv).r;
  bool offscreen = any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)));
  if (uReset > 0.5 || offscreen) {
    vec3 rgb = untonemapForResolve(yCoCgToRgb(current));
    float z = depth >= 1.0 ? uFar : linearizeDepth(depth, uNear, uFar);
    fragColor = vec4(rgb, z);
    return;
  }

  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
  vec3 lo = max(mu - uClipGamma * sigma, nmin);
  vec3 hi = min(mu + uClipGamma * sigma, nmax);

  /* --- history --------------------------------------------------------- */
  vec3 history = historyCatmullRom(prevUv);
  vec4 historyPoint = texture(tHistory, prevUv);
  history = rgbToYCoCg(tonemapForResolve(history));
  vec3 clipped = clipToAABB(lo, hi, history);

  /* --- disocclusion: compare stored previous depth to the reprojected one */
  float reject = 0.0;
  if (depth < 1.0) {
    float z = linearizeDepth(depth, uNear, uFar);
    vec4 world = uInverseView * vec4(viewFromLinear(vUv, z), 1.0);
    vec4 prevClip = uPrevViewProjection * world;
    if (prevClip.w > 1e-4) {
      float expected = linearizeDepth((prevClip.z / prevClip.w) * 0.5 + 0.5, uNear, uFar);
      float speed = length(velocity);
      // Objects that moved get their depth mismatch forgiven — velocity already
      // reprojected them; only static geometry must agree.
      float tol = 0.035 + 0.0025 * speed;
      reject = linstep(tol, tol * 3.0, abs(historyPoint.a - expected) / max(expected, 0.1));
    }
  }

  /* --- feedback weight -------------------------------------------------- */
  float lumaDiff = abs(current.x - clipped.x) / max(max(current.x, clipped.x), 0.15);
  float feedback = mix(uFeedbackMax, uFeedbackMin, lumaDiff * lumaDiff);
  feedback *= 1.0 - reject;
  // Long trails on fast movers are the classic ghost; shorten the history there.
  feedback *= exp(-length(velocity) * 0.018);

  vec3 resolved = mix(current, clipped, feedback);

  /* --- bounded unsharp mask to give back the micro-contrast ------------- */
  vec3 blur = (taps[1] + taps[3] + taps[5] + taps[7]) * 0.25;
  vec3 sharpened = resolved + (resolved - blur) * uSharpen;
  resolved = clamp(sharpened, min(nmin, resolved), max(nmax, resolved));

  vec3 rgb = untonemapForResolve(yCoCgToRgb(resolved));
  rgb = max(rgb, vec3(0.0));
  float z = depth >= 1.0 ? uFar : linearizeDepth(depth, uNear, uFar);
  fragColor = vec4(rgb, z);
}
`;

const FXAA_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
layout(location = 0) out vec4 fragColor;

/* HDR-safe luma proxy: compress first so a 40-nit highlight does not swamp the
   edge detector. */
float lumaAt(vec2 uv) {
  vec3 c = max(texture(tInput, uv).rgb, vec3(0.0));
  return sqrt(luma(c / (1.0 + c)));
}

void main() {
  float lM = lumaAt(vUv);
  float lNW = lumaAt(vUv + vec2(-1.0, -1.0) * uTexel);
  float lNE = lumaAt(vUv + vec2(1.0, -1.0) * uTexel);
  float lSW = lumaAt(vUv + vec2(-1.0, 1.0) * uTexel);
  float lSE = lumaAt(vUv + vec2(1.0, 1.0) * uTexel);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) { fragColor = texture(tInput, vUv); return; }

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 a = 0.5 * (texture(tInput, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                + texture(tInput, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(tInput, vUv - dir * 0.5).rgb
                           + texture(tInput, vUv + dir * 0.5).rgb);
  float lB = sqrt(luma(b / (1.0 + b)));
  fragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;

export class TaaPass extends BasePass {
  readonly name = 'taa';
  readonly order = PASS_ORDER.TAA;

  private resolve!: THREE.ShaderMaterial;
  private fxaa!: THREE.ShaderMaterial;
  private copy!: THREE.ShaderMaterial;
  private flip = 0;
  private lastFrame = -1;
  private readonly projVec = new THREE.Vector4(1, 1, 0, 0);

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    const gl = this.renderer.getContext();
    gl.getExtension('EXT_color_buffer_float');

    this.resolve = this.makeMaterial({
      name: 'taa/resolve',
      fragment: RESOLVE_FRAG,
      uniforms: {
        tInput: { value: null },
        tHistory: { value: null },
        tVelocity: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uInverseView: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uFeedbackMin: { value: 0.86 },
        uFeedbackMax: { value: 0.97 },
        uSharpen: { value: 0.32 },
        uClipGamma: { value: 1.15 },
        uReset: { value: 1 },
      },
    });

    this.fxaa = this.makeMaterial({
      name: 'taa/fxaa',
      fragment: FXAA_FRAG,
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.copy = this.own(makeCopyMaterial());
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled) return false;

    if (!g.taa) {
      if (!g.fxaaFallback) return false;
      const u = this.fxaa.uniforms;
      u.tInput.value = input;
      (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
      ctx.blit(this.fxaa, output);
      return true;
    }

    const advance = ctx.frame !== this.lastFrame;
    if (advance) { this.flip ^= 1; this.lastFrame = ctx.frame; }

    const spec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };
    const cur = this.res.pool.get(`taa.hist${this.flip}`, ctx.width, ctx.height, spec);
    const prev = this.res.pool.get(`taa.hist${this.flip ^ 1}`, ctx.width, ctx.height, spec);

    const proj = ctx.camera.projectionMatrix.elements;
    const u = this.resolve.uniforms;
    u.tInput.value = input;
    u.tHistory.value = prev.texture;
    u.tVelocity.value = ctx.gbuffer.velocity;
    u.tDepth.value = ctx.gbuffer.depth;
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    (u.uResolution.value as THREE.Vector2).set(ctx.width, ctx.height);
    (u.uProj.value as THREE.Vector4).copy(this.projVec.set(proj[0], proj[5], proj[8], proj[9]));
    (u.uInverseView.value as THREE.Matrix4).copy(ctx.inverseView);
    (u.uPrevViewProjection.value as THREE.Matrix4).copy(ctx.prevViewProjection);
    u.uNear.value = ctx.cameraNear;
    u.uFar.value = ctx.cameraFar;

    // More samples ⇒ we can afford a longer history and a lighter clip.
    const samples = Math.max(2, g.taaSamples);
    u.uFeedbackMax.value = Math.min(0.975, 1 - 1 / samples);
    u.uFeedbackMin.value = Math.min(0.9, u.uFeedbackMax.value - 0.11);
    u.uClipGamma.value = samples >= 16 ? 1.25 : 1.05;
    u.uSharpen.value = 0.34;
    u.uReset.value = ctx.frame < 2 ? 1 : 0;

    ctx.blit(this.resolve, cur);

    this.copy.uniforms.tInput.value = cur.texture;
    this.copy.uniforms.uScale.value = 1;
    ctx.blit(this.copy, output);
    return true;
  }
}
