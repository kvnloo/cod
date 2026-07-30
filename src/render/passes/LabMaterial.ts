/**
 * G-buffer material for the post-processing test bed.
 *
 * This is *not* the game's material system (that lives in src/material) — it is
 * a compact, self-contained MRT writer so the pass library can be exercised and
 * screenshotted without depending on any other module's progress. It writes the
 * exact G-buffer layout documented in src/render/Pass.ts:
 *
 *   0  rgba16f  shaded HDR colour
 *   1  rgba16f  view-space normal (xyz) + roughness (w)
 *   2  rgba16f  screen-space velocity in pixels/frame (xy)
 *   3  rgba16f  metalness / AO / material id / emissive mask
 *
 * Shading is a compact analytic PBR: one shadowed sun, a hemisphere sky
 * irradiance, an analytic sky specular lobe, and up to four point lights. All
 * surface detail (albedo mottling, roughness breakup, cavity darkening, a
 * derived detail normal) is procedural, so nothing here loads a texture.
 */

import * as THREE from 'three';
import { COMMON, SKY_FALLBACK } from './Shaders';

export const LAB_MAX_LIGHTS = 4;

const VERT = /* glsl */ `
uniform mat4 uPrevModelViewProjection;
uniform mat4 uUnjitteredViewProjection;
out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vViewPos;
out vec3 vViewNormal;
out vec4 vCurrClip;
out vec4 vPrevClip;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = mat3(modelMatrix) * normal;
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  vViewNormal = normalMatrix * normal;
  vCurrClip = uUnjitteredViewProjection * world;
  vPrevClip = uPrevModelViewProjection * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vViewPos;
in vec3 vViewNormal;
in vec4 vCurrClip;
in vec4 vPrevClip;

uniform vec3 uAlbedo;
uniform float uRoughness;
uniform float uMetalness;
uniform vec3 uEmissive;
uniform float uEmissiveStrength;
uniform float uMatId;
uniform float uDetailScale;
uniform float uDetailAmount;
uniform float uRoughVariation;

uniform vec3 uSunDirection;   // direction the light travels
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uSkyIntensity;
uniform vec3 uCameraPos;
uniform vec2 uResolution;

#ifdef SHADOW_COMPARE
uniform highp sampler2DShadow uShadowMap;
#else
uniform sampler2D uShadowMap;
#endif
uniform mat4 uShadowMatrix;
uniform vec2 uShadowTexel;
uniform float uHasShadow;

uniform vec3 uLightPos[${LAB_MAX_LIGHTS}];
uniform vec3 uLightColor[${LAB_MAX_LIGHTS}];
uniform float uLightRadius[${LAB_MAX_LIGHTS}];
uniform int uLightCount;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalRough;
layout(location = 2) out vec4 gVelocity;
layout(location = 3) out vec4 gMaterial;

${SKY_FALLBACK}

/* Two scales of detail: a slow macro tint plus a much finer grain. One octave
   set at a single frequency reads as cloud blotches, which is the classic
   procedural-material tell. */
float detailField(vec3 p) {
  float macro = fbm3(p * uDetailScale * 0.22, 3);
  float micro = fbm3(p * uDetailScale * 2.6, 3);
  return mix(macro, micro, 0.72);
}

float distributionGGX(float noh, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = noh * noh * (a2 - 1.0) + 1.0;
  return a2 / max(BLK_PI * d * d, 1e-6);
}
float smithGGX(float nov, float nol, float rough) {
  float a = rough * rough;
  float k = a * 0.5;
  float gv = nov / (nov * (1.0 - k) + k);
  float gl = nol / (nol * (1.0 - k) + k);
  return gv * gl;
}
vec3 fresnel(vec3 f0, float voh) {
  float m = clamp(1.0 - voh, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

/* three's shadow map is a depth texture in comparison mode for PCF, and a plain
   depth texture for Basic/VSM. Both are supported so this material works
   whatever shadow-map type the host renderer picked. */
float shadowTap(vec2 uv, float ref) {
#ifdef SHADOW_COMPARE
  return texture(uShadowMap, vec3(uv, ref));
#else
  return ref <= texture(uShadowMap, uv).r ? 1.0 : 0.0;
#endif
}

float sampleShadow(vec3 world, float nol) {
  if (uHasShadow < 0.5) return 1.0;
  vec4 s = uShadowMatrix * vec4(world, 1.0);
  if (s.w <= 0.0) return 1.0;
  vec3 p = s.xyz / s.w;
  if (any(lessThan(p.xy, vec2(0.001))) || any(greaterThan(p.xy, vec2(0.999))) || p.z > 1.0) return 1.0;
  float bias = mix(0.0022, 0.0004, nol);
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += shadowTap(p.xy + vec2(float(x), float(y)) * uShadowTexel, p.z - bias);
    }
  }
  return sum / 9.0;
}

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);

  /* --- procedural surface detail ---------------------------------------- */
  float d0 = detailField(vWorldPos);
  float e = 0.35 / max(uDetailScale, 1e-3);
  float dx = detailField(vWorldPos + vec3(e, 0.0, 0.0)) - d0;
  float dy = detailField(vWorldPos + vec3(0.0, e, 0.0)) - d0;
  float dz = detailField(vWorldPos + vec3(0.0, 0.0, e)) - d0;
  vec3 grad = vec3(dx, dy, dz) / e;
  // Project the gradient onto the surface to get a detail normal without a
  // tangent frame — good enough for macro breakup.
  vec3 tangentGrad = grad - N * dot(grad, N);
  N = normalize(N - tangentGrad * uDetailAmount * 0.06);

  float cavity = sat(0.5 + (d0 - 0.5) * 1.35);
  vec3 albedo = uAlbedo * mix(1.0, 0.76 + d0 * 0.44, uDetailAmount);
  albedo *= mix(1.0, 0.72 + cavity * 0.4, 0.55 * uDetailAmount);
  float rough = clamp(uRoughness * mix(1.0, 0.74 + d0 * 0.52, uRoughVariation), 0.03, 1.0);
  float ao = mix(1.0, sat(0.62 + cavity * 0.44), 0.55 * uDetailAmount);

  vec3 f0 = mix(vec3(0.04), albedo, uMetalness);
  vec3 diffuseAlbedo = albedo * (1.0 - uMetalness);

  float nov = max(dot(N, V), 1e-4);

  /* --- sun --------------------------------------------------------------- */
  vec3 L = -normalize(uSunDirection);
  float nol = max(dot(N, L), 0.0);
  vec3 colour = vec3(0.0);
  if (nol > 0.0) {
    float shadow = sampleShadow(vWorldPos, nol);
    vec3 H = normalize(L + V);
    float noh = max(dot(N, H), 0.0);
    float voh = max(dot(V, H), 0.0);
    float D = distributionGGX(noh, rough);
    float G = smithGGX(nov, nol, rough);
    vec3 F = fresnel(f0, voh);
    vec3 spec = (D * G * 0.25 / max(nov * nol, 1e-4)) * F;
    vec3 kd = (1.0 - F) * diffuseAlbedo / BLK_PI;
    colour += (kd + spec) * uSunColor * nol * shadow;
  }

  /* --- sky irradiance + analytic env specular ---------------------------- */
  vec3 skyDiffuse = skyFallback(N, uSkyZenith, uSkyHorizon, uSkyGround) * uSkyIntensity;
  colour += diffuseAlbedo * skyDiffuse * ao;

  vec3 R = reflect(-V, N);
  vec3 skySpec = skyFallback(normalize(mix(R, N, rough * rough)), uSkyZenith, uSkyHorizon, uSkyGround);
  vec3 Fenv = fresnel(f0, nov);
  float specAo = sat(pow(nov + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
  colour += skySpec * uSkyIntensity * Fenv * mix(1.0, 0.35, rough) * specAo;

  /* --- point lights ------------------------------------------------------- */
  for (int i = 0; i < ${LAB_MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 toL = uLightPos[i] - vWorldPos;
    float dist2 = dot(toL, toL);
    float radius = uLightRadius[i];
    float atten = 1.0 / (1.0 + dist2);
    atten *= sat(1.0 - dist2 / max(radius * radius, 1e-3));
    if (atten <= 0.0) continue;
    vec3 Lp = toL * inversesqrt(max(dist2, 1e-6));
    float nolp = max(dot(N, Lp), 0.0);
    if (nolp <= 0.0) continue;
    vec3 H = normalize(Lp + V);
    float noh = max(dot(N, H), 0.0);
    float voh = max(dot(V, H), 0.0);
    float D = distributionGGX(noh, rough);
    float G = smithGGX(nov, nolp, rough);
    vec3 F = fresnel(f0, voh);
    vec3 spec = (D * G * 0.25 / max(nov * nolp, 1e-4)) * F;
    vec3 kd = (1.0 - F) * diffuseAlbedo / BLK_PI;
    colour += (kd + spec) * uLightColor[i] * nolp * atten;
  }

  vec3 emissive = uEmissive * uEmissiveStrength;
  colour += emissive;

  /* --- velocity ----------------------------------------------------------- */
  vec2 currNdc = vCurrClip.xy / max(vCurrClip.w, 1e-5);
  vec2 prevNdc = vPrevClip.xy / max(vPrevClip.w, 1e-5);
  vec2 velocity = (currNdc - prevNdc) * 0.5 * uResolution;

  float emissiveMask = sat(maxc(emissive) * 0.5);

  gColor = vec4(colour, 1.0);
  gNormalRough = vec4(normalize(vViewNormal), rough);
  gVelocity = vec4(velocity, 0.0, 1.0);
  gMaterial = vec4(uMetalness, ao, uMatId, emissiveMask);
}
`;

export interface LabMaterialOptions {
  albedo?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveStrength?: number;
  detailScale?: number;
  detailAmount?: number;
  roughVariation?: number;
  matId?: number;
}

/** Shared uniform block every lab material references (lights, sky, shadow). */
export interface LabEnvironment {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Vector3;
  skyZenith: THREE.Vector3;
  skyHorizon: THREE.Vector3;
  skyGround: THREE.Vector3;
  skyIntensity: number;
  cameraPos: THREE.Vector3;
  resolution: THREE.Vector2;
  shadowMap: THREE.Texture | null;
  shadowMatrix: THREE.Matrix4;
  shadowTexel: THREE.Vector2;
  lightPos: THREE.Vector3[];
  lightColor: THREE.Vector3[];
  lightRadius: number[];
  lightCount: number;
  unjitteredViewProjection: THREE.Matrix4;
}

export function createLabEnvironment(): LabEnvironment {
  const lightPos: THREE.Vector3[] = [];
  const lightColor: THREE.Vector3[] = [];
  const lightRadius: number[] = [];
  for (let i = 0; i < LAB_MAX_LIGHTS; i++) {
    lightPos.push(new THREE.Vector3());
    lightColor.push(new THREE.Vector3());
    lightRadius.push(1);
  }
  return {
    sunDirection: new THREE.Vector3(-0.45, -0.5, -0.74).normalize(),
    sunColor: new THREE.Vector3(5.4, 4.6, 3.6),
    skyZenith: new THREE.Vector3(0.14, 0.24, 0.46),
    skyHorizon: new THREE.Vector3(0.34, 0.4, 0.5),
    skyGround: new THREE.Vector3(0.06, 0.055, 0.05),
    skyIntensity: 0.75,
    cameraPos: new THREE.Vector3(),
    resolution: new THREE.Vector2(1920, 1080),
    shadowMap: null,
    shadowMatrix: new THREE.Matrix4(),
    shadowTexel: new THREE.Vector2(1 / 2048, 1 / 2048),
    lightPos, lightColor, lightRadius, lightCount: 0,
    unjitteredViewProjection: new THREE.Matrix4(),
  };
}

export function createLabMaterial(env: LabEnvironment, o: LabMaterialOptions = {}): THREE.ShaderMaterial {
  const albedo = new THREE.Color(o.albedo ?? 0x9a9a9a);
  const emissive = new THREE.Color(o.emissive ?? 0x000000);
  return new THREE.ShaderMaterial({
    name: 'lab/gbuffer',
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: COMMON + FRAG,
    defines: { SHADOW_COMPARE: 0 },
    uniforms: {
      uPrevModelViewProjection: { value: new THREE.Matrix4() },
      uUnjitteredViewProjection: { value: env.unjitteredViewProjection },
      uAlbedo: { value: new THREE.Vector3(albedo.r, albedo.g, albedo.b) },
      uRoughness: { value: o.roughness ?? 0.6 },
      uMetalness: { value: o.metalness ?? 0 },
      uEmissive: { value: new THREE.Vector3(emissive.r, emissive.g, emissive.b) },
      uEmissiveStrength: { value: o.emissiveStrength ?? 0 },
      uMatId: { value: (o.matId ?? 0) / 255 },
      uDetailScale: { value: o.detailScale ?? 1.6 },
      uDetailAmount: { value: o.detailAmount ?? 1 },
      uRoughVariation: { value: o.roughVariation ?? 0.7 },
      uSunDirection: { value: env.sunDirection },
      uSunColor: { value: env.sunColor },
      uSkyZenith: { value: env.skyZenith },
      uSkyHorizon: { value: env.skyHorizon },
      uSkyGround: { value: env.skyGround },
      uSkyIntensity: { value: env.skyIntensity },
      uCameraPos: { value: env.cameraPos },
      uResolution: { value: env.resolution },
      uShadowMap: { value: null },
      uShadowMatrix: { value: env.shadowMatrix },
      uShadowTexel: { value: env.shadowTexel },
      uHasShadow: { value: 0 },
      uLightPos: { value: env.lightPos },
      uLightColor: { value: env.lightColor },
      uLightRadius: { value: env.lightRadius },
      uLightCount: { value: 0 },
    },
  });
}

/** Sky dome material — writes "no geometry" into normal/velocity/material. */
export function createLabSkyMaterial(env: LabEnvironment): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'lab/sky',
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w;   // pin to the far plane
      }
    `,
    fragmentShader: COMMON + SKY_FALLBACK + /* glsl */ `
      in vec3 vDir;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSkyGround;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform float uSkyIntensity;
      layout(location = 0) out vec4 gColor;
      layout(location = 1) out vec4 gNormalRough;
      layout(location = 2) out vec4 gVelocity;
      layout(location = 3) out vec4 gMaterial;
      void main() {
        vec3 dir = normalize(vDir);
        vec3 sky = skyFallback(dir, uSkyZenith, uSkyHorizon, uSkyGround) * uSkyIntensity * 2.4;
        // Sun disc + forward-scattering halo.
        float cosSun = dot(dir, -normalize(uSunDirection));
        sky += uSunColor * 34.0 * smoothstep(0.99965, 0.99992, cosSun);
        sky += uSunColor * 0.18 * pow(sat(cosSun), 220.0);
        sky += uSunColor * 0.05 * pow(sat(cosSun), 8.0);
        gColor = vec4(sky, 1.0);
        gNormalRough = vec4(0.0, 0.0, 0.0, 1.0);
        gVelocity = vec4(0.0);
        gMaterial = vec4(0.0, 1.0, 0.0, 1.0);
      }
    `,
    uniforms: {
      uSkyZenith: { value: env.skyZenith },
      uSkyHorizon: { value: env.skyHorizon },
      uSkyGround: { value: env.skyGround },
      uSunDirection: { value: env.sunDirection },
      uSunColor: { value: env.sunColor },
      uSkyIntensity: { value: env.skyIntensity },
    },
  });
}
