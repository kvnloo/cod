/**
 * GTAO — ground-truth ambient occlusion.
 *
 * Horizon-based slice sampling with cosine-weighted visibility integration
 * (Jimenez et al. 2016, following Intel's XeGTAO formulation), a thin-occluder
 * thickness heuristic, bent-normal output, an edge-aware spatial denoise and
 * temporal accumulation that reuses the G-buffer velocity.
 *
 * Stages (all but the last run at `aoScale` resolution):
 *   prefilter depth → gtao → bilateral denoise → temporal accumulate → apply
 *
 * The bent normal + visibility texture is published on `PostResources.gtao` so a
 * deferred lighting pass can consume it directly instead of the screen-space
 * approximation applied here.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

/* --------------------------------------------------------------- shaders -- */

const PREFILTER_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tDepth;
uniform vec2 uSourceTexel;
uniform float uNear;
uniform float uFar;
layout(location = 0) out vec4 fragColor;

void main() {
#if AO_SCALE_HALF
  // Depth-aware 2x2 reduction: bias toward the closest sample so thin silhouettes
  // survive the downsample instead of being averaged into the background.
  vec2 b = vUv - uSourceTexel * 0.5;
  float d0 = texture(tDepth, b).r;
  float d1 = texture(tDepth, b + vec2(uSourceTexel.x, 0.0)).r;
  float d2 = texture(tDepth, b + vec2(0.0, uSourceTexel.y)).r;
  float d3 = texture(tDepth, b + uSourceTexel).r;
  float z0 = linearizeDepth(d0, uNear, uFar);
  float z1 = linearizeDepth(d1, uNear, uFar);
  float z2 = linearizeDepth(d2, uNear, uFar);
  float z3 = linearizeDepth(d3, uNear, uFar);
  float zmin = min(min(z0, z1), min(z2, z3));
  float w0 = 1.0 / (1.0 + abs(z0 - zmin) * 4.0);
  float w1 = 1.0 / (1.0 + abs(z1 - zmin) * 4.0);
  float w2 = 1.0 / (1.0 + abs(z2 - zmin) * 4.0);
  float w3 = 1.0 / (1.0 + abs(z3 - zmin) * 4.0);
  float z = (z0 * w0 + z1 * w1 + z2 * w2 + z3 * w3) / (w0 + w1 + w2 + w3);
#else
  float z = linearizeDepth(texture(tDepth, vUv).r, uNear, uFar);
#endif
  fragColor = vec4(z, 0.0, 0.0, 1.0);
}
`;

const GTAO_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tDepth;        // linear view depth at AO resolution
uniform sampler2D tNormal;       // view-space normal (xyz) + roughness (w)
uniform vec2 uTexel;             // 1 / aoResolution
uniform vec4 uProj;              // P00, P11, P02, P12
uniform float uPixelsPerMeter;   // 0.5 * aoHeight * P11
uniform float uRadius;
uniform float uThickness;
uniform float uFrame;
uniform float uFar;
layout(location = 0) out vec4 fragColor;

vec3 viewFromLinear(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(z * (ndc.x + uProj.z) / uProj.x, z * (ndc.y + uProj.w) / uProj.y, -z);
}

/* Rotation taking the "from" axis onto "to" (Moller-Hughes), applied to v. */
vec3 rotFromTo(vec3 from, vec3 to, vec3 v) {
  float e = dot(from, to);
  if (abs(e) > 0.9997) return e > 0.0 ? v : -v;
  vec3 c = cross(from, to);
  float h = 1.0 / (1.0 + e);
  float hvx = h * c.x, hvz = h * c.z;
  float hvxy = hvx * c.y, hvxz = hvx * c.z, hvyz = hvz * c.y;
  vec3 r0 = vec3(e + hvx * c.x, hvxy - c.z, hvxz + c.y);
  vec3 r1 = vec3(hvxy + c.z, e + h * c.y * c.y, hvyz - c.x);
  vec3 r2 = vec3(hvxz - c.y, hvyz + c.x, e + hvz * c.z);
  return vec3(dot(r0, v), dot(r1, v), dot(r2, v));
}

void main() {
  float z = texture(tDepth, vUv).r;
  vec4 nr = texture(tNormal, vUv);
  vec3 n = nr.xyz;
  float nlen = length(n);

  // Sky / unwritten pixels: fully visible, bent normal = view vector.
  if (z >= uFar * 0.995 || nlen < 0.1) {
    fragColor = vec4(0.0, 0.0, 1.0, 1.0);
    return;
  }
  n /= nlen;

  vec3 viewPos = viewFromLinear(vUv, z);
  vec3 viewVec = normalize(-viewPos);

  // Screen-space radius of the effect sphere, clamped so grazing pixels do not
  // explode the sampling footprint. The floor matters: below ~4px the whole
  // kernel lands inside one texel neighbourhood and distant geometry silently
  // loses its ambient occlusion entirely.
  float screenRadius = clamp(uRadius * uPixelsPerMeter / z, 4.0, 110.0);

  float falloffRange = 0.615 * uRadius;
  float falloffFrom = uRadius - falloffRange;
  float falloffMul = -1.0 / falloffRange;
  float falloffAdd = falloffFrom / falloffRange + 1.0;

  vec4 noise = blueNoise4T(gl_FragCoord.xy, uFrame);
  float sliceNoise = noise.x;
  float stepNoise = noise.y;

  float visibility = 0.0;
  vec3 bentNormal = vec3(0.0);

  for (int slice = 0; slice < AO_SLICES; slice++) {
    float phi = (float(slice) + sliceNoise) * (BLK_PI / float(AO_SLICES));
    float cosPhi = cos(phi), sinPhi = sin(phi);
    vec2 omega = vec2(cosPhi, sinPhi);
    vec3 directionVec = vec3(cosPhi, sinPhi, 0.0);

    vec3 orthoDirectionVec = directionVec - dot(directionVec, viewVec) * viewVec;
    vec3 axisVec = normalize(cross(orthoDirectionVec, viewVec));
    vec3 projectedNormalVec = n - axisVec * dot(n, axisVec);
    float projectedNormalVecLength = length(projectedNormalVec);
    if (projectedNormalVecLength < 1e-4) continue;

    float signNorm = dot(orthoDirectionVec, projectedNormalVec) < 0.0 ? -1.0 : 1.0;
    float cosNorm = sat(dot(projectedNormalVec, viewVec) / projectedNormalVecLength);
    float nAngle = signNorm * acos(cosNorm);

    float horizonCos0 = -1.0;
    float horizonCos1 = -1.0;

    for (int st = 0; st < AO_STEPS; st++) {
      float s = (float(st) + stepNoise) / float(AO_STEPS);
      // Bias toward the centre — but only mildly. A pure square law puts five of
      // six samples inside the first third of the radius, so the occluder that
      // actually grounds an object (the metre of floor beside it) is never
      // sampled and the AO collapses into a thin rim around creases.
      s = s * (0.32 + 0.68 * s);
      float offsetLen = max(1.0, floor(s * screenRadius + 0.5));
      vec2 off = omega * offsetLen * uTexel;

      vec2 uv0 = vUv + off;
      vec2 uv1 = vUv - off;
      float z0 = texture(tDepth, uv0).r;
      float z1 = texture(tDepth, uv1).r;
      vec3 d0 = viewFromLinear(uv0, z0) - viewPos;
      vec3 d1 = viewFromLinear(uv1, z1) - viewPos;
      float len0 = max(length(d0), 1e-5);
      float len1 = max(length(d1), 1e-5);

      // Thickness heuristic: stretching along view Z makes thin occluders stop
      // occluding once the ray has passed behind them.
      float fb0 = length(vec3(d0.xy, d0.z * (1.0 + uThickness)));
      float fb1 = length(vec3(d1.xy, d1.z * (1.0 + uThickness)));
      float w0 = sat(fb0 * falloffMul + falloffAdd);
      float w1 = sat(fb1 * falloffMul + falloffAdd);

      float shc0 = dot(d0 / len0, viewVec);
      float shc1 = dot(d1 / len1, viewVec);
      shc0 = mix(horizonCos0, shc0, w0);
      shc1 = mix(horizonCos1, shc1, w1);

      horizonCos0 = max(horizonCos0, shc0);
      horizonCos1 = max(horizonCos1, shc1);
    }

    float h0 = -acos(clamp(horizonCos1, -1.0, 1.0));
    float h1 = acos(clamp(horizonCos0, -1.0, 1.0));
    h0 = nAngle + clamp(h0 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);
    h1 = nAngle + clamp(h1 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);

    float sinN = sin(nAngle);
    float iarc0 = (cosNorm + 2.0 * h0 * sinN - cos(2.0 * h0 - nAngle)) * 0.25;
    float iarc1 = (cosNorm + 2.0 * h1 * sinN - cos(2.0 * h1 - nAngle)) * 0.25;
    visibility += projectedNormalVecLength * (iarc0 + iarc1);

    // Analytic bent normal for this slice.
    float t0 = (6.0 * sin(h0 - nAngle) - sin(3.0 * h0 - nAngle)
              + 6.0 * sin(h1 - nAngle) - sin(3.0 * h1 - nAngle)
              + 16.0 * sinN - 3.0 * (sin(h0 + nAngle) + sin(h1 + nAngle))) / 12.0;
    float t1 = (-cos(3.0 * h0 - nAngle) - cos(3.0 * h1 - nAngle)
              + 8.0 * cos(nAngle) - 3.0 * (cos(h0 + nAngle) + cos(h1 + nAngle))) / 12.0;
    vec3 localBent = vec3(directionVec.x * t0, directionVec.y * t0, -t1);
    bentNormal += rotFromTo(vec3(0.0, 0.0, -1.0), viewVec, localBent) * projectedNormalVecLength;
  }

  visibility = sat(visibility / float(AO_SLICES));
  bentNormal = normalize(bentNormal + n * 1e-4);
  fragColor = vec4(bentNormal, visibility);
}
`;

const DENOISE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tAo;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uSharpness;
layout(location = 0) out vec4 fragColor;

void main() {
  float z0 = texture(tDepth, vUv).r;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  // 3x3 cross-bilateral; depth similarity keeps contact shadows crisp.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      float z = texture(tDepth, uv).r;
      float dw = exp(-abs(z - z0) * uSharpness / max(z0, 0.1));
      float sw = (x == 0 && y == 0) ? 1.0 : ((x == 0 || y == 0) ? 0.6 : 0.35);
      float w = dw * sw;
      sum += texture(tAo, uv) * w;
      wsum += w;
    }
  }
  fragColor = sum / max(wsum, 1e-4);
}
`;

const TEMPORAL_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tAo;
uniform sampler2D tHistory;
uniform sampler2D tDepth;      // current linear depth, AO res
uniform sampler2D tPrevDepth;  // previous frame linear depth, AO res
uniform sampler2D tVelocity;   // full-res velocity in pixels/frame
uniform vec2 uTexel;
uniform vec2 uFullTexel;
uniform vec4 uProj;
uniform mat4 uInverseView;
uniform mat4 uPrevViewProjection;
uniform float uNear;
uniform float uFar;
uniform float uReset;
layout(location = 0) out vec4 fragColor;

vec3 viewFromLinear(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(z * (ndc.x + uProj.z) / uProj.x, z * (ndc.y + uProj.w) / uProj.y, -z);
}

void main() {
  vec4 current = texture(tAo, vUv);
  float z = texture(tDepth, vUv).r;

  vec2 vel = texture(tVelocity, vUv).xy * uFullTexel;
  vec2 prevUv = vUv - vel;

  if (uReset > 0.5 || any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    fragColor = current;
    return;
  }

  // Expected previous depth for a static point, used as the disocclusion test.
  vec3 viewPos = viewFromLinear(vUv, z);
  vec4 world = uInverseView * vec4(viewPos, 1.0);
  vec4 prevClip = uPrevViewProjection * world;
  float expected = uFar;
  if (prevClip.w > 1e-4) {
    expected = linearizeDepth((prevClip.z / prevClip.w) * 0.5 + 0.5, uNear, uFar);
  }
  float prevZ = texture(tPrevDepth, prevUv).r;
  float reject = linstep(0.02, 0.09, abs(prevZ - expected) / max(expected, 0.1));

  vec4 history = texture(tHistory, prevUv);
  // Reject history that disagrees violently with the local neighbourhood too.
  float lo = current.a, hi = current.a;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 ? 1.0 : (i == 1 ? -1.0 : 0.0), i == 2 ? 1.0 : (i == 3 ? -1.0 : 0.0));
    float a = texture(tAo, vUv + o * uTexel).a;
    lo = min(lo, a); hi = max(hi, a);
  }
  float span = max(hi - lo, 0.02) * 1.6;
  float clamped = clamp(history.a, lo - span, hi + span);
  reject = max(reject, sat(abs(clamped - history.a) * 4.0));

  float feedback = mix(0.93, 0.0, reject);
  fragColor = vec4(
    normalize(mix(current.xyz, history.xyz, feedback) + vec3(1e-5)),
    mix(current.a, clamped, feedback));
}
`;

const APPLY_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tAo;
uniform sampler2D tAoDepth;
uniform sampler2D tNormal;
uniform sampler2D tMaterial;
uniform sampler2D tDepth;
uniform vec2 uAoTexel;
uniform float uNear;
uniform float uFar;
uniform float uIntensityPower;
uniform float uDirectPreserve;
layout(location = 0) out vec4 fragColor;

vec3 multiBounce(float ao, vec3 albedo) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  vec3 x = vec3(ao);
  return max(x, ((x * a + b) * x + c) * x);
}

float specularOcclusion(float nov, float ao, float rough) {
  return sat(pow(nov + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
}

void main() {
  vec4 color = texture(tInput, vUv);
  float depth = texture(tDepth, vUv).r;
  if (depth >= 1.0) { fragColor = color; return; }

  float z = linearizeDepth(depth, uNear, uFar);

#if AO_SCALE_HALF
  // Depth-weighted bilateral upsample from the half-res AO buffer.
  vec4 ao4 = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5);
    vec2 uv = vUv + o * uAoTexel;
    float zs = texture(tAoDepth, uv).r;
    float w = 1.0 / (1e-3 + abs(zs - z) / max(z, 0.1));
    ao4 += texture(tAo, uv) * w;
    wsum += w;
  }
  vec4 g = ao4 / max(wsum, 1e-4);
#else
  vec4 g = texture(tAo, vUv);
#endif

  vec4 nr = texture(tNormal, vUv);
  vec4 mat = texture(tMaterial, vUv);
  float metal = mat.r;
  float bakedAo = mat.g;
  float emissive = mat.a;
  float rough = clamp(nr.w, 0.02, 1.0);

  float ao = sat(pow(sat(g.a), uIntensityPower));
  ao = min(ao, bakedAo > 0.0 ? bakedAo : 1.0);

  // Hue-preserving pseudo-albedo: the shaded buffer is all we have here, and the
  // multi-bounce curve only needs the chromaticity to be roughly right.
  // 0.42 is brighter than almost any real surface; the multi-bounce curve then
  // gives back so much energy that the occlusion barely survives it.
  vec3 albedo = sat(color.rgb / (maxc(color.rgb) + 1e-4)) * 0.28;
  vec3 diffuseOcc = multiBounce(ao, albedo);

  vec3 nView = normalize(nr.xyz + vec3(1e-6));
  vec3 vView = vec3(0.0, 0.0, 1.0);
  float nov = sat(dot(nView, vView));
  vec3 bent = normalize(g.xyz + vec3(1e-6));
  vec3 refl = reflect(-vView, nView);
  float bentAlign = sat(dot(bent, refl) * 0.5 + 0.5);
  float so = specularOcclusion(nov, ao, rough);
  so *= mix(1.0, mix(0.45, 1.0, bentAlign), sat(1.0 - rough * 1.6));

  vec3 occ = mix(diffuseOcc, vec3(min(diffuseOcc.g, so)), metal);
  occ = mix(occ, vec3(1.0), emissive);
  // Keep some energy in obviously direct-lit pixels — AO is an ambient term.
  occ = mix(occ, vec3(1.0), uDirectPreserve * sat(luma(color.rgb) * 0.35));

  fragColor = vec4(color.rgb * occ, color.a);
}
`;

/* ------------------------------------------------------------------ pass -- */

interface QualityTier { slices: number; steps: number; half: boolean; }

/**
 * Cost/quality tiers.
 *
 * Resolution is the wrong place to spend an AO budget. A full-resolution buffer
 * multiplies *five* stages (prefilter, gtao, denoise, temporal, apply) by four,
 * and the horizon search is the most cache-hostile shader in the frame — it
 * costs `slices * steps * 2` dependent depth taps at a stride that defeats the
 * texture cache. Half resolution buys back roughly 2.4x the total fetch count,
 * which is then spent on more *slices*: the azimuthal sample count is what
 * decides whether a corner reads as occluded from every direction or bands, and
 * the visibility term is low-frequency enough that the depth-aware bilateral
 * upsample in `APPLY_FRAG` reconstructs it without softening contact darkening.
 *
 * Cinematic keeps the full-resolution path — it is not a real-time budget.
 */
function tierFor(quality: number): QualityTier {
  if (quality <= 0.55) return { slices: 2, steps: 3, half: true };
  if (quality <= 0.75) return { slices: 3, steps: 4, half: true };
  if (quality <= 1.05) return { slices: 4, steps: 5, half: true };
  return { slices: 4, steps: 9, half: false };
}

export class GtaoPass extends BasePass {
  readonly name = 'gtao';
  readonly order = PASS_ORDER.AO;

  private prefilter!: THREE.ShaderMaterial;
  private gtao!: THREE.ShaderMaterial;
  private denoise!: THREE.ShaderMaterial;
  private temporal!: THREE.ShaderMaterial;
  private apply!: THREE.ShaderMaterial;
  private tier: QualityTier = { slices: 3, steps: 6, half: false };
  private flip = 0;
  private lastFrame = -1;
  /** Reused every frame — no allocation in the render path. */
  private readonly projVec = new THREE.Vector4(1, 1, 0, 0);

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    // Half-float colour attachments need this on WebGL2.
    const gl = this.renderer.getContext();
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');

    this.prefilter = this.makeMaterial({
      name: 'gtao/prefilter',
      fragment: PREFILTER_FRAG,
      defines: { AO_SCALE_HALF: 0 },
      uniforms: {
        tDepth: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
      },
    });

    this.gtao = this.makeMaterial({
      name: 'gtao/main',
      fragment: GTAO_FRAG,
      blueNoise: true,
      defines: { AO_SLICES: 3, AO_STEPS: 6 },
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        uTexel: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uPixelsPerMeter: { value: 500 },
        uRadius: { value: 0.7 },
        uThickness: { value: 0.55 },
        uFrame: { value: 0 },
        uFar: { value: 1000 },
      },
    });

    this.denoise = this.makeMaterial({
      name: 'gtao/denoise',
      fragment: DENOISE_FRAG,
      uniforms: {
        tAo: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSharpness: { value: 24 },
      },
    });

    this.temporal = this.makeMaterial({
      name: 'gtao/temporal',
      fragment: TEMPORAL_FRAG,
      uniforms: {
        tAo: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        tPrevDepth: { value: null },
        tVelocity: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFullTexel: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uInverseView: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uReset: { value: 1 },
      },
    });

    this.apply = this.makeMaterial({
      name: 'gtao/apply',
      fragment: APPLY_FRAG,
      defines: { AO_SCALE_HALF: 0 },
      uniforms: {
        tInput: { value: null },
        tAo: { value: null },
        tAoDepth: { value: null },
        tNormal: { value: null },
        tMaterial: { value: null },
        tDepth: { value: null },
        uAoTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uIntensityPower: { value: 2.2 },
        uDirectPreserve: { value: 0.25 },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.ssao) { this.res.gtao = null; return false; }

    const tier = tierFor(g.ssaoQuality);
    if (tier.half !== this.tier.half) this.res.pool.release('gtao.');
    this.tier = tier;

    const scale = tier.half ? 0.5 : 1;
    const aw = Math.max(1, Math.round(ctx.width * scale));
    const ah = Math.max(1, Math.round(ctx.height * scale));
    const pool = this.res.pool;

    const depthSpec = { type: THREE.HalfFloatType, format: THREE.RedFormat, filter: THREE.LinearFilter };
    const aoSpec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };

    // Ping-pong the linear-depth target so the temporal stage has last frame's.
    const advance = ctx.frame !== this.lastFrame;
    if (advance) { this.flip ^= 1; this.lastFrame = ctx.frame; }
    const depthCur = pool.get(`gtao.depth${this.flip}`, aw, ah, depthSpec);
    const depthPrev = pool.get(`gtao.depth${this.flip ^ 1}`, aw, ah, depthSpec);
    const raw = pool.get('gtao.raw', aw, ah, aoSpec);
    const den = pool.get('gtao.den', aw, ah, aoSpec);
    const histCur = pool.get(`gtao.hist${this.flip}`, aw, ah, aoSpec);
    const histPrev = pool.get(`gtao.hist${this.flip ^ 1}`, aw, ah, aoSpec);

    const proj = ctx.camera.projectionMatrix.elements;
    const projVec = this.projVec.set(proj[0], proj[5], proj[8], proj[9]);

    /* 1 — prefilter depth ---------------------------------------------------*/
    this.setDefine(this.prefilter, 'AO_SCALE_HALF', tier.half ? 1 : 0);
    const pu = this.prefilter.uniforms;
    pu.tDepth.value = ctx.gbuffer.depth;
    (pu.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    pu.uNear.value = ctx.cameraNear;
    pu.uFar.value = ctx.cameraFar;
    ctx.blit(this.prefilter, depthCur);

    /* 2 — GTAO --------------------------------------------------------------*/
    this.setDefine(this.gtao, 'AO_SLICES', tier.slices);
    this.setDefine(this.gtao, 'AO_STEPS', tier.steps);
    const gu = this.gtao.uniforms;
    gu.tDepth.value = depthCur.texture;
    gu.tNormal.value = ctx.gbuffer.normalRoughness;
    (gu.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    (gu.uProj.value as THREE.Vector4).copy(projVec);
    gu.uPixelsPerMeter.value = 0.5 * ah * proj[5];
    // The preset's radius is the *detail* scale (creases, window reveals). World
    // grounding — the darkening under a crate, in a doorway, along a kerb — needs
    // roughly a metre and a half of reach, so scale it up here rather than
    // asking every preset to carry a second number.
    gu.uRadius.value = Math.max(0.05, g.ssaoRadius) * 2.1;
    gu.uThickness.value = 0.55;
    gu.uFrame.value = ctx.frame % 64;
    gu.uFar.value = ctx.cameraFar;
    ctx.blit(this.gtao, raw);

    /* 3 — denoise -----------------------------------------------------------*/
    const du = this.denoise.uniforms;
    du.tAo.value = raw.texture;
    du.tDepth.value = depthCur.texture;
    (du.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    du.uSharpness.value = 22;
    ctx.blit(this.denoise, den);

    /* 4 — temporal accumulation --------------------------------------------*/
    const tu = this.temporal.uniforms;
    tu.tAo.value = den.texture;
    tu.tHistory.value = histPrev.texture;
    tu.tDepth.value = depthCur.texture;
    tu.tPrevDepth.value = depthPrev.texture;
    tu.tVelocity.value = ctx.gbuffer.velocity;
    (tu.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    (tu.uFullTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    (tu.uProj.value as THREE.Vector4).copy(projVec);
    (tu.uInverseView.value as THREE.Matrix4).copy(ctx.inverseView);
    (tu.uPrevViewProjection.value as THREE.Matrix4).copy(ctx.prevViewProjection);
    tu.uNear.value = ctx.cameraNear;
    tu.uFar.value = ctx.cameraFar;
    tu.uReset.value = ctx.frame < 2 ? 1 : 0;
    ctx.blit(this.temporal, histCur);

    this.res.gtao = histCur.texture;

    /* 5 — apply -------------------------------------------------------------*/
    this.setDefine(this.apply, 'AO_SCALE_HALF', tier.half ? 1 : 0);
    const au = this.apply.uniforms;
    au.tInput.value = input;
    au.tAo.value = histCur.texture;
    au.tAoDepth.value = depthCur.texture;
    au.tNormal.value = ctx.gbuffer.normalRoughness;
    au.tMaterial.value = ctx.gbuffer.material;
    au.tDepth.value = ctx.gbuffer.depth;
    (au.uAoTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    au.uNear.value = ctx.cameraNear;
    au.uFar.value = ctx.cameraFar;
    au.uIntensityPower.value = 1.0 + 1.9 * Math.max(0, g.ssaoIntensity);
    // Direct light should survive occlusion, but not this much: at 0.25 a sunlit
    // wall base kept a quarter of its ambient occlusion budget back and the
    // contact never read.
    au.uDirectPreserve.value = 0.14;
    ctx.blit(this.apply, output);
    return true;
  }
}
