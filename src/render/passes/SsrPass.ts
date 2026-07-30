/**
 * Screen-space reflections.
 *
 * Half-resolution stride-marched rays with binary refinement, GGX
 * importance-sampled directions (so rough surfaces get a physically shaped lobe
 * rather than a blurred mirror), roughness-driven cone tracing against a colour
 * mip pyramid, backface + edge + facing fades, temporal accumulation, and a
 * graceful fallback to the environment cubemap (or a fitted sky gradient) when a
 * ray leaves the screen.
 *
 * The raw reflection buffer is published on `PostResources.ssr`; the composite
 * here is a Fresnel-weighted additive approximation, which is the best that can
 * be done when the pass only sees the already-shaded HDR buffer. A deferred
 * lighting pass should consume `PostResources.ssr` instead.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import { SKY_FALLBACK } from './Shaders';
import type { PostResources } from './Shared';

const LINEAR_DEPTH_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uSourceTexel;
uniform float uNear;
uniform float uFar;
layout(location = 0) out vec4 fragColor;
void main() {
  // Closest-of-4 keeps thin geometry from being marched through.
  vec2 b = vUv - uSourceTexel * 0.5;
  float d = min(
    min(texture(tDepth, b).r, texture(tDepth, b + vec2(uSourceTexel.x, 0.0)).r),
    min(texture(tDepth, b + vec2(0.0, uSourceTexel.y)).r, texture(tDepth, b + uSourceTexel).r));
  vec4 nr = texture(tNormal, vUv);
  fragColor = vec4(linearizeDepth(d, uNear, uFar), nr.w, 0.0, 1.0);
}
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
layout(location = 0) out vec4 fragColor;
void main() {
  // 9-tap tent — cheap and free of the box-filter aliasing that makes rough
  // reflections crawl.
  vec2 t = uSourceTexel;
  vec3 s = texture(tInput, vUv).rgb * 4.0;
  s += texture(tInput, vUv + vec2(-t.x, 0.0)).rgb * 2.0;
  s += texture(tInput, vUv + vec2(t.x, 0.0)).rgb * 2.0;
  s += texture(tInput, vUv + vec2(0.0, -t.y)).rgb * 2.0;
  s += texture(tInput, vUv + vec2(0.0, t.y)).rgb * 2.0;
  s += texture(tInput, vUv + vec2(-t.x, -t.y)).rgb;
  s += texture(tInput, vUv + vec2(t.x, -t.y)).rgb;
  s += texture(tInput, vUv + vec2(-t.x, t.y)).rgb;
  s += texture(tInput, vUv + vec2(t.x, t.y)).rgb;
  fragColor = vec4(s / 16.0, 1.0);
}
`;

const MARCH_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tDepth;        // r = linear view depth, g = roughness (half res)
uniform sampler2D tNormal;       // full-res view normal + roughness
uniform sampler2D tMaterial;
uniform sampler2D tMip0;
uniform sampler2D tMip1;
uniform sampler2D tMip2;
uniform sampler2D tMip3;
uniform sampler2D tMip4;
#ifdef USE_ENV_CUBE
uniform samplerCube tEnv;
#endif
uniform vec2 uTexel;
uniform vec4 uProj;
uniform mat4 uProjection;
uniform mat4 uInverseView;
uniform float uNear;
uniform float uFar;
uniform float uThickness;
uniform float uMaxDistance;
uniform float uFrame;
uniform float uPixelsPerMeter;
uniform float uMaxRoughness;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uEnvIntensity;
layout(location = 0) out vec4 fragColor;

${SKY_FALLBACK}

vec3 viewFromLinear(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(z * (ndc.x + uProj.z) / uProj.x, z * (ndc.y + uProj.w) / uProj.y, -z);
}

vec3 samplePyramid(vec2 uv, float level) {
  float l = clamp(level, 0.0, 4.0);
  float f = fract(l);
  int i = int(floor(l));
  vec3 a, b;
  if (i == 0)      { a = texture(tMip0, uv).rgb; b = texture(tMip1, uv).rgb; }
  else if (i == 1) { a = texture(tMip1, uv).rgb; b = texture(tMip2, uv).rgb; }
  else if (i == 2) { a = texture(tMip2, uv).rgb; b = texture(tMip3, uv).rgb; }
  else             { a = texture(tMip3, uv).rgb; b = texture(tMip4, uv).rgb; }
  return mix(a, b, f);
}

vec3 environmentFallback(vec3 viewDir) {
  vec3 world = normalize((uInverseView * vec4(viewDir, 0.0)).xyz);
#ifdef USE_ENV_CUBE
  return texture(tEnv, world).rgb * uEnvIntensity;
#else
  return skyFallback(world, uSkyZenith, uSkyHorizon, uSkyGround) * uEnvIntensity;
#endif
}

/* GGX importance sample around N (view space). */
vec3 importanceGGX(vec3 N, float rough, vec2 u) {
  float a = max(rough * rough, 1e-3);
  vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float phi = BLK_TAU * u.x;
  float cosTheta = sqrt((1.0 - u.y) / (1.0 + (a * a - 1.0) * u.y));
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  return normalize(T * (sinTheta * cos(phi)) + B * (sinTheta * sin(phi)) + N * cosTheta);
}

void main() {
  vec2 dg = texture(tDepth, vUv).rg;
  float z = dg.r;
  vec4 nr = texture(tNormal, vUv);
  vec3 N = nr.xyz;
  float rough = clamp(nr.w, 0.02, 1.0);
  if (z >= uFar * 0.995 || length(N) < 0.1 || rough > uMaxRoughness) {
    fragColor = vec4(0.0);
    return;
  }
  N = normalize(N);

  vec3 P = viewFromLinear(vUv, z);
  vec3 V = normalize(P);   // camera → surface

  vec4 noise = blueNoise4T(gl_FragCoord.xy, uFrame);

  vec3 accum = vec3(0.0);
  float accumConf = 0.0;

  for (int ray = 0; ray < SSR_RAYS; ray++) {
    vec2 xi = fract(noise.xy + float(ray) * vec2(0.7548776662, 0.5698402909));
    vec3 H = importanceGGX(N, rough, xi);
    vec3 dir = reflect(V, H);
    if (dot(dir, N) <= 0.0) dir = reflect(V, N);

    // Clip the ray so it never crosses the near plane.
    float maxDist = uMaxDistance;
    float endZ = P.z + dir.z * maxDist;
    if (endZ > -uNear) maxDist = (-uNear - P.z) / max(dir.z, 1e-5);
    maxDist = max(maxDist, 0.01);
    vec3 rayEnd = P + dir * maxDist;

    vec4 h0 = uProjection * vec4(P, 1.0);
    vec4 h1 = uProjection * vec4(rayEnd, 1.0);
    if (h0.w < 1e-5 || h1.w < 1e-5) continue;
    vec2 s0 = (h0.xy / h0.w) * 0.5 + 0.5;
    vec2 s1 = (h1.xy / h1.w) * 0.5 + 0.5;
    float k0 = 1.0 / h0.w;
    float k1 = 1.0 / h1.w;
    vec3 q0 = P * k0;
    vec3 q1 = rayEnd * k1;

    float jitter = fract(noise.z + float(ray) * 0.618);
    float dt = 1.0 / float(SSR_STEPS);
    float tPrev = 0.0;
    float t = 0.0;
    bool hit = false;
    float hitT = 0.0;

    for (int s = 0; s < SSR_STEPS; s++) {
      tPrev = t;
      t = (float(s) + jitter) * dt;
      vec2 uv = mix(s0, s1, t);
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
      float k = mix(k0, k1, t);
      vec3 rp = mix(q0, q1, t) / max(k, 1e-6);
      float rayLin = -rp.z;
      float sceneLin = texture(tDepth, uv).r;
      float bias = 0.02 + rayLin * 0.0045;
      float thickness = uThickness * (1.0 + rayLin * 0.05);
      if (rayLin > sceneLin + bias && rayLin - sceneLin < thickness + rayLin * 0.02) {
        hit = true;
        hitT = t;
        break;
      }
    }

    if (!hit) {
      accum += environmentFallback(dir);
      accumConf += 0.0;   // env fallback carries no screen-space confidence
      continue;
    }

    // Binary refinement between the last miss and the hit.
    float lo = tPrev, hi = hitT;
    for (int i = 0; i < 5; i++) {
      float mid = 0.5 * (lo + hi);
      vec2 uv = mix(s0, s1, mid);
      float k = mix(k0, k1, mid);
      vec3 rp = mix(q0, q1, mid) / max(k, 1e-6);
      float rayLin = -rp.z;
      float sceneLin = texture(tDepth, uv).r;
      if (rayLin > sceneLin) hi = mid; else lo = mid;
    }
    float tHit = hi;
    vec2 hitUv = mix(s0, s1, tHit);
    float kHit = mix(k0, k1, tHit);
    vec3 hitView = mix(q0, q1, tHit) / max(kHit, 1e-6);
    float hitDist = length(hitView - P);

    // Reject backfaces: a reflection landing on a surface pointing away from the
    // ray is geometrically impossible and produces the classic smear.
    vec3 hitNormal = texture(tNormal, hitUv).xyz;
    float backface = sat(-dot(normalize(hitNormal + vec3(1e-6)), dir));

    // Cone footprint: the rougher the surface and the longer the ray, the wider
    // the filter we must read the scene colour through.
    float coneTan = max(rough * rough, 1e-3);
    float radiusPx = coneTan * hitDist * uPixelsPerMeter / max(-hitView.z, 0.05);
    float level = log2(max(radiusPx * 0.5, 1.0));

    vec2 edge = smoothstep(vec2(0.0), vec2(0.14), hitUv)
              * (1.0 - smoothstep(vec2(0.86), vec2(1.0), hitUv));
    float fade = edge.x * edge.y;
    fade *= backface;
    // Rays coming back toward the camera cannot be trusted in screen space.
    fade *= sat(1.0 - pow(sat(dot(dir, vec3(0.0, 0.0, 1.0))), 2.0));
    fade *= 1.0 - smoothstep(uMaxRoughness * 0.6, uMaxRoughness, rough);
    fade *= 1.0 - smoothstep(uMaxDistance * 0.7, uMaxDistance, hitDist);

    vec3 hitColor = samplePyramid(hitUv, level);
    accum += mix(environmentFallback(dir), hitColor, fade);
    accumConf += fade;
  }

  float inv = 1.0 / float(SSR_RAYS);
  fragColor = vec4(max(accum * inv, vec3(0.0)), accumConf * inv);
}
`;

const TEMPORAL_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform vec2 uFullTexel;
uniform float uReset;
layout(location = 0) out vec4 fragColor;

void main() {
  vec4 c = texture(tCurrent, vUv);
  vec2 vel = texture(tVelocity, vUv).xy * uFullTexel;
  vec2 prevUv = vUv - vel;
  if (uReset > 0.5 || any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    fragColor = c;
    return;
  }
  vec3 lo = c.rgb, hi = c.rgb;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 ? 1.0 : (i == 1 ? -1.0 : 0.0), i == 2 ? 1.0 : (i == 3 ? -1.0 : 0.0));
    vec3 s = texture(tCurrent, vUv + o * uTexel).rgb;
    lo = min(lo, s); hi = max(hi, s);
  }
  vec3 span = (hi - lo) * 0.6 + vec3(0.02);
  vec4 h = texture(tHistory, prevUv);
  vec3 clamped = clamp(h.rgb, lo - span, hi + span);
  float drift = length(clamped - h.rgb) / (length(h.rgb) + 0.05);
  float feedback = 0.9 * (1.0 - sat(drift));
  fragColor = vec4(mix(c.rgb, clamped, feedback), mix(c.a, h.a, feedback));
}
`;

const COMPOSITE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tSsr;
uniform sampler2D tNormal;
uniform sampler2D tMaterial;
uniform sampler2D tDepth;
uniform sampler2D tAo;
#ifdef USE_ENV_CUBE
uniform samplerCube tEnv;
#endif
uniform mat4 uInverseView;
uniform vec4 uProj;
uniform float uNear;
uniform float uFar;
uniform float uIntensity;
uniform float uMaxRoughness;
uniform float uHasAo;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uEnvIntensity;
layout(location = 0) out vec4 fragColor;

${SKY_FALLBACK}

vec3 environmentEstimate(vec3 viewDir) {
  vec3 world = normalize((uInverseView * vec4(viewDir, 0.0)).xyz);
#ifdef USE_ENV_CUBE
  return texture(tEnv, world).rgb * uEnvIntensity;
#else
  return skyFallback(world, uSkyZenith, uSkyHorizon, uSkyGround) * uEnvIntensity;
#endif
}

void main() {
  vec4 color = texture(tInput, vUv);
  float depth = texture(tDepth, vUv).r;
  if (depth >= 1.0) { fragColor = color; return; }

  vec4 nr = texture(tNormal, vUv);
  vec3 N = nr.xyz;
  if (length(N) < 0.1) { fragColor = color; return; }
  N = normalize(N);
  float rough = clamp(nr.w, 0.02, 1.0);
  if (rough > uMaxRoughness) { fragColor = color; return; }

  vec4 mat = texture(tMaterial, vUv);
  float metal = mat.r;
  float emissive = mat.a;

  float z = linearizeDepth(depth, uNear, uFar);
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 P = vec3(z * (ndc.x + uProj.z) / uProj.x, z * (ndc.y + uProj.w) / uProj.y, -z);
  vec3 V = normalize(-P);
  float nov = sat(dot(N, V));

  vec4 refl = texture(tSsr, vUv);
  float f0 = mix(0.04, 1.0, metal);
  float fres = fresnelSchlick(f0, nov);
  // Rough surfaces lose the grazing-angle Fresnel spike.
  fres = mix(fres, f0, rough * rough);

  // Metals tint their reflection; use the shaded hue as an albedo proxy.
  vec3 tint = mix(vec3(1.0), sat(color.rgb / (maxc(color.rgb) + 1e-4)), metal * 0.85);

  float occ = 1.0;
  if (uHasAo > 0.5) {
    vec4 g = texture(tAo, vUv);
    occ = mix(1.0, sat(g.a), 0.7);
  }

  float w = uIntensity * fres * occ * (1.0 - emissive)
          * (1.0 - smoothstep(uMaxRoughness * 0.7, uMaxRoughness, rough));

  // The shaded buffer already contains an environment specular estimate. SSR
  // *corrects* that estimate where a screen-space hit was found rather than
  // adding a second reflection on top of it — adding is what turns every
  // glancing surface into a milky white sheet.
  vec3 env = environmentEstimate(reflect(-V, mix(N, normalize(N + V * 0.0), 0.0)));
  vec3 delta = refl.rgb - env;
  fragColor = vec4(max(color.rgb + delta * tint * w, vec3(0.0)), color.a);
}
`;

export class SsrPass extends BasePass {
  readonly name = 'ssr';
  readonly order = PASS_ORDER.SSR;

  private linearDepth!: THREE.ShaderMaterial;
  private downsample!: THREE.ShaderMaterial;
  private march!: THREE.ShaderMaterial;
  private temporal!: THREE.ShaderMaterial;
  private composite!: THREE.ShaderMaterial;
  private flip = 0;
  private lastFrame = -1;
  private envCube: THREE.CubeTexture | null = null;
  private readonly projVec = new THREE.Vector4(1, 1, 0, 0);
  private readonly skyZenith = new THREE.Color(0.16, 0.26, 0.45);
  private readonly skyHorizon = new THREE.Color(0.42, 0.47, 0.55);
  private readonly skyGround = new THREE.Color(0.09, 0.08, 0.07);

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.renderer.getContext().getExtension('EXT_color_buffer_float');

    this.linearDepth = this.makeMaterial({
      name: 'ssr/lineardepth',
      fragment: LINEAR_DEPTH_FRAG,
      uniforms: {
        tDepth: { value: null }, tNormal: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
      },
    });

    this.downsample = this.makeMaterial({
      name: 'ssr/downsample',
      fragment: DOWNSAMPLE_FRAG,
      uniforms: { tInput: { value: null }, uSourceTexel: { value: new THREE.Vector2() } },
    });

    this.march = this.makeMaterial({
      name: 'ssr/march',
      fragment: MARCH_FRAG,
      blueNoise: true,
      defines: { SSR_STEPS: 32, SSR_RAYS: 1 },
      uniforms: {
        tDepth: { value: null }, tNormal: { value: null }, tMaterial: { value: null },
        tMip0: { value: null }, tMip1: { value: null }, tMip2: { value: null },
        tMip3: { value: null }, tMip4: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        tEnv: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uProjection: { value: new THREE.Matrix4() },
        uInverseView: { value: new THREE.Matrix4() },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        uThickness: { value: 0.35 },
        uMaxDistance: { value: 40 },
        uFrame: { value: 0 },
        uPixelsPerMeter: { value: 500 },
        uMaxRoughness: { value: 0.62 },
        uSkyZenith: { value: new THREE.Vector3(0.16, 0.26, 0.45) },
        uSkyHorizon: { value: new THREE.Vector3(0.42, 0.47, 0.55) },
        uSkyGround: { value: new THREE.Vector3(0.09, 0.08, 0.07) },
        uEnvIntensity: { value: 1 },
      },
    });

    this.temporal = this.makeMaterial({
      name: 'ssr/temporal',
      fragment: TEMPORAL_FRAG,
      uniforms: {
        tCurrent: { value: null }, tHistory: { value: null }, tVelocity: { value: null },
        uTexel: { value: new THREE.Vector2() }, uFullTexel: { value: new THREE.Vector2() },
        uReset: { value: 1 },
      },
    });

    this.composite = this.makeMaterial({
      name: 'ssr/composite',
      fragment: COMPOSITE_FRAG,
      uniforms: {
        tInput: { value: null }, tSsr: { value: null }, tNormal: { value: null },
        tMaterial: { value: null }, tDepth: { value: null }, tAo: { value: null },
        tEnv: { value: null },
        uInverseView: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        uIntensity: { value: 1 },
        uMaxRoughness: { value: 0.62 },
        uHasAo: { value: 0 },
        uSkyZenith: { value: new THREE.Vector3(0.16, 0.26, 0.45) },
        uSkyHorizon: { value: new THREE.Vector3(0.42, 0.47, 0.55) },
        uSkyGround: { value: new THREE.Vector3(0.09, 0.08, 0.07) },
        uEnvIntensity: { value: 1 },
      },
    });
  }

  /** Picks up an environment cubemap and a sky tint from the scene, if present. */
  private syncEnvironment(scene: THREE.Scene): void {
    const env = scene.environment;
    const cube = env && (env as THREE.CubeTexture).isCubeTexture ? (env as THREE.CubeTexture) : null;
    if (cube !== this.envCube) {
      this.envCube = cube;
      this.march.uniforms.tEnv.value = cube;
      this.composite.uniforms.tEnv.value = cube;
      for (const m of [this.march, this.composite]) {
        const defines = m.defines as Record<string, string | number>;
        if (cube) defines.USE_ENV_CUBE = 1; else delete defines.USE_ENV_CUBE;
        m.needsUpdate = true;
      }
    }
    const bg = scene.background;
    if (bg && (bg as THREE.Color).isColor) {
      const c = bg as THREE.Color;
      this.skyHorizon.copy(c);
      this.skyZenith.setRGB(c.r * 0.55, c.g * 0.72, c.b * 1.05);
      this.skyGround.setRGB(c.r * 0.22, c.g * 0.2, c.b * 0.17);
    }
    const u = this.march.uniforms;
    (u.uSkyZenith.value as THREE.Vector3).set(this.skyZenith.r, this.skyZenith.g, this.skyZenith.b);
    (u.uSkyHorizon.value as THREE.Vector3).set(this.skyHorizon.r, this.skyHorizon.g, this.skyHorizon.b);
    (u.uSkyGround.value as THREE.Vector3).set(this.skyGround.r, this.skyGround.g, this.skyGround.b);
    u.uEnvIntensity.value = scene.environmentIntensity ?? 1;
    const cu = this.composite.uniforms;
    (cu.uSkyZenith.value as THREE.Vector3).copy(u.uSkyZenith.value as THREE.Vector3);
    (cu.uSkyHorizon.value as THREE.Vector3).copy(u.uSkyHorizon.value as THREE.Vector3);
    (cu.uSkyGround.value as THREE.Vector3).copy(u.uSkyGround.value as THREE.Vector3);
    cu.uEnvIntensity.value = u.uEnvIntensity.value;
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.ssr) { this.res.ssr = null; this.res.colorPyramid = []; return false; }

    const hw = Math.max(1, ctx.width >> 1);
    const hh = Math.max(1, ctx.height >> 1);
    const pool = this.res.pool;
    const colorSpec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };
    const depthSpec = { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.LinearFilter };

    const advance = ctx.frame !== this.lastFrame;
    if (advance) { this.flip ^= 1; this.lastFrame = ctx.frame; }

    this.syncEnvironment(ctx.scene);

    /* 1 — half-res linear depth + roughness -------------------------------- */
    const lin = pool.get('ssr.lineardepth', hw, hh, depthSpec);
    const ld = this.linearDepth.uniforms;
    ld.tDepth.value = ctx.gbuffer.depth;
    ld.tNormal.value = ctx.gbuffer.normalRoughness;
    (ld.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    ld.uNear.value = ctx.cameraNear;
    ld.uFar.value = ctx.cameraFar;
    ctx.blit(this.linearDepth, lin);

    /* 2 — colour mip pyramid ----------------------------------------------- */
    const mips: THREE.WebGLRenderTarget[] = [];
    let sw = hw, sh = hh;
    let src: THREE.Texture = input;
    let srcW = ctx.width, srcH = ctx.height;
    for (let i = 0; i < 5; i++) {
      const rt = pool.get(`ssr.mip${i}`, sw, sh, colorSpec);
      const u = this.downsample.uniforms;
      u.tInput.value = src;
      (u.uSourceTexel.value as THREE.Vector2).set(1 / srcW, 1 / srcH);
      ctx.blit(this.downsample, rt);
      mips.push(rt);
      src = rt.texture;
      srcW = sw; srcH = sh;
      sw = Math.max(1, sw >> 1);
      sh = Math.max(1, sh >> 1);
    }
    this.res.colorPyramid = mips.map((m) => m.texture);

    /* 3 — march -------------------------------------------------------------*/
    const steps = Math.max(8, Math.min(96, Math.round(g.ssrSteps)));
    const rays = g.ssrSteps >= 64 ? 2 : 1;
    this.setDefine(this.march, 'SSR_STEPS', steps);
    this.setDefine(this.march, 'SSR_RAYS', rays);

    const proj = ctx.camera.projectionMatrix.elements;
    const projVec = this.projVec.set(proj[0], proj[5], proj[8], proj[9]);
    const raw = pool.get('ssr.raw', hw, hh, colorSpec);
    const mu = this.march.uniforms;
    mu.tDepth.value = lin.texture;
    mu.tNormal.value = ctx.gbuffer.normalRoughness;
    mu.tMaterial.value = ctx.gbuffer.material;
    mu.tMip0.value = mips[0].texture;
    mu.tMip1.value = mips[1].texture;
    mu.tMip2.value = mips[2].texture;
    mu.tMip3.value = mips[3].texture;
    mu.tMip4.value = mips[4].texture;
    (mu.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (mu.uProj.value as THREE.Vector4).copy(projVec);
    (mu.uProjection.value as THREE.Matrix4).copy(ctx.camera.projectionMatrix);
    (mu.uInverseView.value as THREE.Matrix4).copy(ctx.inverseView);
    mu.uNear.value = ctx.cameraNear;
    mu.uFar.value = ctx.cameraFar;
    mu.uThickness.value = Math.max(0.05, g.ssrThickness);
    mu.uMaxDistance.value = Math.min(120, Math.max(12, g.drawDistance * 0.08));
    mu.uFrame.value = ctx.frame % 64;
    mu.uPixelsPerMeter.value = 0.5 * hh * proj[5];
    ctx.blit(this.march, raw);

    /* 4 — temporal ----------------------------------------------------------*/
    const cur = pool.get(`ssr.hist${this.flip}`, hw, hh, colorSpec);
    const prev = pool.get(`ssr.hist${this.flip ^ 1}`, hw, hh, colorSpec);
    const tu = this.temporal.uniforms;
    tu.tCurrent.value = raw.texture;
    tu.tHistory.value = prev.texture;
    tu.tVelocity.value = ctx.gbuffer.velocity;
    (tu.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    (tu.uFullTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    tu.uReset.value = ctx.frame < 2 ? 1 : 0;
    ctx.blit(this.temporal, cur);
    this.res.ssr = cur.texture;

    /* 5 — composite ---------------------------------------------------------*/
    const cu = this.composite.uniforms;
    cu.tInput.value = input;
    cu.tSsr.value = cur.texture;
    cu.tNormal.value = ctx.gbuffer.normalRoughness;
    cu.tMaterial.value = ctx.gbuffer.material;
    cu.tDepth.value = ctx.gbuffer.depth;
    cu.tAo.value = this.res.gtao;
    cu.uHasAo.value = this.res.gtao ? 1 : 0;
    (cu.uInverseView.value as THREE.Matrix4).copy(ctx.inverseView);
    (cu.uProj.value as THREE.Vector4).copy(projVec);
    cu.uNear.value = ctx.cameraNear;
    cu.uFar.value = ctx.cameraFar;
    cu.uIntensity.value = 1;
    ctx.blit(this.composite, output);
    return true;
  }
}
