/**
 * Shader extensions layered on top of MeshStandardMaterial via
 * onBeforeCompile.
 *
 * Everything here exists to defeat the three tells that mark a WebGL scene:
 *
 *  - **Triplanar projection** so world geometry never needs authored UVs and
 *    never shows stretching on ramps, rubble or sloped ground.
 *  - **Detail maps** — a second, much higher frequency layer that fades in
 *    inside ~6 m, which is what stops surfaces going soft when you walk up to
 *    them.
 *  - **Parallax occlusion mapping with self-shadowing** so brick, tile and
 *    gravel have real silhouette-free depth at grazing angles.
 *  - **Per-instance variation** driven by an instanced obVar attribute so a
 *    field of 200 crates has hue, roughness, wear and UV offset spread.
 *  - **Vertex-colour blending** between two full PBR stacks with height-aware
 *    transitions (concrete → dirt drifts, wall → damage).
 *  - **Specular anti-aliasing + distance normal damping** so nothing shimmers.
 *
 * All injected identifiers are ob-prefixed; nothing here can collide with a
 * three.js chunk symbol.
 */

import * as THREE from 'three';
import type { PbrTextureSet } from './TextureForge';

export interface ShaderExtensionConfig {
  triplanar?: boolean;
  /** Blend exponent for triplanar weights. 4–8 reads best. */
  triplanarSharpness?: number;
  /** World metres per texture repeat. */
  tile: number;
  detail?: boolean;
  /** Repeats per metre for the detail layer. */
  detailScale?: number;
  /** x = normal strength, y = albedo strength, z = roughness strength. */
  detailStrength?: THREE.Vector3;
  /** Start/end distance of the detail cross-fade, metres. */
  detailFade?: THREE.Vector2;
  detailMap?: THREE.Texture | null;
  pom?: boolean;
  /** Displacement depth in metres. */
  pomDepth?: number;
  pomMinSteps?: number;
  pomMaxSteps?: number;
  pomShadow?: boolean;
  instanceVariation?: boolean;
  /** Second layer blended by vertex colour red. */
  blend?: PbrTextureSet | null;
  blendTile?: number;
  /** 0..1 extra grime multiplier applied to albedo/roughness. */
  wear?: number;
  /**
   * 0..1 weathering film. Lifts and neutralises the deep end of the albedo,
   * the way chalked binder and settled dust do on anything left outdoors.
   * Recipes with a wide internal range (painted metal, timber, plastic) need
   * it; narrow-palette masonry and ground recipes must not have it.
   */
  film?: number;
  specularAA?: boolean;
  /** Distance past which normal strength is damped, metres. */
  normalFadeDistance?: number;
  /**
   * World-space macro variation. Two octaves of low-frequency noise sampled
   * from world position, applied as a *small* multiplicative tint and a
   * roughness offset. This is what stops a 2 m texture repeat from reading as
   * a pattern across a 20 m facade, and it is where "colour variation over
   * metres" comes from — the base maps deliberately carry almost none.
   *   x = coarse wavelength (m), y = fine wavelength (m),
   *   z = albedo strength (0..1), w = roughness strength.
   */
  macro?: THREE.Vector4 | null;
  /**
   * World-space *story* layers, all of which need macro to be on.
   *   x = patch strength    — replaced slabs, repairs, a second pour
   *   y = damp strength     — standing damp, silt drift and oil marks
   *   z = traffic strength  — polished wheel/foot lanes
   *   w = metal wash        — rain-burnished up-facing metal
   * A tiling texture cannot carry any of these: they are all features of
   * *where a surface is in the world*, and without them a ground plane has the
   * same value from the player's boots to the far end of the street.
   */
  surface?: THREE.Vector4 | null;
  /**
   * Splash-back / rising-damp band at the foot of vertical surfaces, in world
   * space. Grounds walls and props against the floor, which the base maps
   * cannot do because they tile.
   *   x = world Y of the ground, y = fade height (m), z = strength (0..1).
   */
  ground?: THREE.Vector3 | null;
  /**
   * Re-derive the base map's own masonry lattice from world position so each
   * block gets a unique tone. obBrick wraps its per-block random with
   * mod(id, counts), so an authored map only ever holds counts.x * counts.y
   * distinct blocks and repeats them once per tile.
   *   x = blocks across, y = courses up, z = per-course jitter, w = recipe seed.
   * Null disables the layer. Triplanar only — the UV path has uvVariation.
   */
  cellTone?: THREE.Vector4 | null;
  /**
   * Laid paving: courses, a running bond, a joint network and a per-flag value
   * spread, all in world space so a floor is *laid* rather than tiled.
   *   x, y = flag size in metres, z = joint strength (0 = tone only), w = seed.
   * Only applies to up-facing surfaces of archetypes that carry `surface`.
   */
  paving?: THREE.Vector4 | null;
  /** Take opacity from the albedo alpha channel (glass, grates, foliage). */
  alphaFromMap?: boolean;
  /**
   * Roll and mirror the UVs per flat panel, keyed off the panel's recovered uv
   * origin. Only meaningful in the UV path (glass, signage) where every panel
   * is mapped 0..1 and would otherwise show the same baked damage.
   */
  uvVariation?: boolean;
  /**
   * Animated emissive mode. 1 = fluorescent tube, 2 = hazard strobe,
   * 3 = monitor, 4 = hot metal, 5 = emergency lamp, 6 = sodium.
   * The albedo map doubles as the emissive map.
   */
  emissiveMode?: number;
}

/** Animated emissive behaviours, indexed by ShaderExtensionConfig.emissiveMode. */
export const EMISSIVE_MODES = {
  none: 0,
  fluorescent: 1,
  strobe: 2,
  monitor: 3,
  hotMetal: 4,
  emergency: 5,
  sodium: 6,
} as const;

export interface ObUniforms {
  obTileScale: THREE.IUniform<number>;
  obTriSharp: THREE.IUniform<number>;
  obDetailMap: THREE.IUniform<THREE.Texture | null>;
  obDetailScale: THREE.IUniform<number>;
  obDetailStrength: THREE.IUniform<THREE.Vector3>;
  obDetailFade: THREE.IUniform<THREE.Vector2>;
  obPom: THREE.IUniform<THREE.Vector3>;
  obWear: THREE.IUniform<number>;
  obFilm: THREE.IUniform<number>;
  obNormalFade: THREE.IUniform<number>;
  obBlendAlb: THREE.IUniform<THREE.Texture | null>;
  obBlendNrm: THREE.IUniform<THREE.Texture | null>;
  obBlendOrm: THREE.IUniform<THREE.Texture | null>;
  obBlendTile: THREE.IUniform<number>;
  obHueSat: THREE.IUniform<THREE.Vector2>;
  obTime: THREE.IUniform<number>;
  obEmissive: THREE.IUniform<THREE.Vector4>;
  obMacro: THREE.IUniform<THREE.Vector4>;
  obSurf: THREE.IUniform<THREE.Vector4>;
  obGround: THREE.IUniform<THREE.Vector3>;
  obCell: THREE.IUniform<THREE.Vector4>;
  obPave: THREE.IUniform<THREE.Vector4>;
  [key: string]: THREE.IUniform;
}

/* ------------------------------------------------------------------ GLSL */

const VERT_PARS = /* glsl */ `
varying vec3 vObWorld;
varying vec3 vObNormalW;
#ifdef OB_INSTANCE_VAR
  attribute vec4 obVar;
  varying vec4 vObVar;
#endif
`;

const VERT_BODY = /* glsl */ `
{
  vec4 obW4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    obW4 = instanceMatrix * obW4;
  #endif
  obW4 = modelMatrix * obW4;
  vObWorld = obW4.xyz;

  vec3 obN = objectNormal;
  #ifdef USE_INSTANCING
    obN = mat3(instanceMatrix) * obN;
  #endif
  vObNormalW = normalize(mat3(modelMatrix) * obN);
  #ifdef OB_INSTANCE_VAR
    vObVar = obVar;
  #endif
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vObWorld;
varying vec3 vObNormalW;
#ifdef OB_INSTANCE_VAR
  varying vec4 vObVar;
#endif

uniform float obTileScale;
uniform float obTriSharp;
uniform vec3  obPom;
uniform float obWear;
uniform float obFilm;
uniform float obNormalFade;
uniform vec2  obHueSat;
uniform float obTime;
uniform vec4  obEmissive;   // x = gain, y = rate, z = phase, w = temperature

#ifdef OB_MACRO
  uniform vec4 obMacro;     // x,y = 1/wavelength (m), z = albedo gain, w = rough gain
  uniform vec4 obSurf;      // x = patch, y = damp, z = traffic, w = metal wash
  uniform vec3 obGround;    // x = ground Y, y = fade height, z = strength
#endif

#ifdef OB_CELLTONE
  uniform vec4 obCell;        // x,y = blocks/courses per tile, z = jitter, w = seed
#endif

#ifdef OB_MACRO
  uniform vec4 obPave;      // x,y = flag size (m), z = joint strength, w = seed
#endif

#ifdef OB_DETAIL
  uniform sampler2D obDetailMap;
  uniform float obDetailScale;
  uniform vec3  obDetailStrength;
  uniform vec2  obDetailFade;
#endif

#ifdef OB_BLEND
  uniform sampler2D obBlendAlb;
  uniform sampler2D obBlendNrm;
  uniform sampler2D obBlendOrm;
  uniform float obBlendTile;
#endif

mat3 obFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz);
  vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}

float obHash1(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

/* Same hash the pattern library uses, so a lattice re-derived here lands on the
   same courses the baked map drew. */
float obHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

/** Cheap blackbody ramp, t in [0,1] → visible glow from dull red to white. */
vec3 obBlackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = vec3(1.0, 0.16 + 0.84 * t * t, max(0.0, t * 2.2 - 1.35));
  return c * (t * t * t);
}

vec3 obHueRot(vec3 c, float shift) {
  const vec3 k = vec3(0.57735);
  float ca = cos(shift * 6.2831853);
  return c * ca + cross(k, c) * sin(shift * 6.2831853) + k * dot(k, c) * (1.0 - ca);
}

/** Whiteout normal blend — preserves detail from both layers. */
vec3 obBlendNormals(vec3 a, vec3 b) {
  return normalize(vec3(a.xy + b.xy, a.z * b.z));
}

/** Projection of a texture-space point onto one of the three triplanar planes. */
vec2 obPlaneUv(vec3 p, int axis, vec3 sg) {
  if (axis == 0) return vec2(-p.z * sg.x, p.y);
  if (axis == 1) return vec2( p.x, -p.z * sg.y);
  return vec2(p.x * sg.z, p.y);
}

int obDomAxis(vec3 n) {
  vec3 a = abs(n);
  return (a.x > a.y && a.x > a.z) ? 0 : ((a.y > a.z) ? 1 : 2);
}

/**
 * Clamp how far a shading normal may tilt away from the geometric one.
 *
 * With the sun 5-10° above the horizon, N·L on a wall is ~0.09, so a facet
 * that leans even 15° toward the light is three times brighter than its
 * neighbour. Uncapped micro-relief therefore stops reading as texture and
 * starts reading as a rash of blown speckles — the single most common way a
 * procedural surface betrays itself at golden hour. Sub-pixel geometry belongs
 * in roughness, not in the normal.
 */
vec3 obClampTilt(vec3 n, vec3 g) {
  const float OB_COS_MAX = 0.870;   // ~29.5 degrees
  n = normalize(n);
  float c = dot(n, g);
  if (c >= OB_COS_MAX) return n;
  vec3 t = n - g * c;
  float tl = length(t);
  if (tl < 1e-5) return g;
  return normalize(g * OB_COS_MAX + (t / tl) * sqrt(1.0 - OB_COS_MAX * OB_COS_MAX));
}

#ifdef OB_MACRO
/* Cheap 3D value noise (iq). Used only at metre wavelengths, so a couple of
   octaves per fragment costs nothing and never aliases. */
float obMHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.71, 0.37));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float obMNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(obMHash(i + vec3(0.0, 0.0, 0.0)), obMHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(obMHash(i + vec3(0.0, 1.0, 0.0)), obMHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(obMHash(i + vec3(0.0, 0.0, 1.0)), obMHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(obMHash(i + vec3(0.0, 1.0, 1.0)), obMHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

/**
 * Trilinear value noise is *not* uniform on 0..1.
 *
 * Averaging eight independent uniforms gives a Gaussian about 0.5 with a
 * standard deviation of only ~0.15 (and ~0.11 once two octaves are mixed), so a
 * threshold written as smoothstep(0.6, 0.85, n) — which looks perfectly
 * sensible — fires on well under one percent of the surface. That single
 * mistake is why every world-space weathering layer in this shader was
 * invisible and why a street held one value for sixty metres. Stretch the
 * distribution once, here, and let every consumer use honest thresholds.
 */
float obMWide(float v, float k) { return clamp((v - 0.5) * k + 0.5, 0.0, 1.0); }

float obMNoiseN(vec3 p) { return obMWide(obMNoise(p), 2.7); }

float obMFbm(vec3 p) {
  return obMNoise(p) * 0.62 + obMNoise(p * 2.17 + 19.7) * 0.38;
}

float obMFbmN(vec3 p) { return obMWide(obMFbm(p), 3.4); }

/**
 * An irregular patch lattice in the ground plane.
 *
 * A regular grid warped by a metre-scale noise gives quadrilateral cells with
 * wobbly borders — which is exactly the shape of a road repair, a replaced
 * paving slab or a second concrete pour. The returned value is
 *   x = 1 inside a patch (with a firm, not gradual, edge)
 *   y = per-patch random, for its own value and roughness
 *   z = distance to the patch border, for a rim of ground-in dirt
 */
/* Polynomial smooth minimum. min() has a gradient discontinuity along the
   locus where its two arguments cross, and a discontinuous gradient in a value
   that modulates albedo is exactly what the eye reads as a straight-edged
   step. */
float obSMin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

vec4 obPatch(vec2 p, float cell, float coverage, float seed) {
  // Rotated off the world axes on purpose. Aligned with them the lattice lands
  // on top of the level's own 0.5 m grid and the paving reads as a chessboard
  // rather than as repairs.
  const vec2 obRot = vec2(0.8988, 0.4384);   // ~26 degrees
  p = vec2(p.x * obRot.x - p.y * obRot.y, p.x * obRot.y + p.y * obRot.x);
  vec2 q = p / max(cell, 1e-3);
  vec2 wob = vec2(obMNoise(vec3(q * 0.75, seed)), obMNoise(vec3(q * 0.75, seed + 31.0))) - 0.5;
  q += wob * 1.5;
  // A second, much shorter octave. Without it every patch border is a smooth
  // metre-scale curve, and a smooth curve across a facade reads as a lighting
  // boundary; a real repair edge is ragged at a decimetre.
  q += vec2(obMNoise(vec3(q * 3.30, seed + 5.0)), obMNoise(vec3(q * 3.30, seed + 47.0))) * 0.30 - 0.15;
  vec2 cid = floor(q);
  vec2 lf = fract(q);
  float rnd = obMHash(vec3(cid, seed + 7.0));
  vec2 dv = min(lf, 1.0 - lf);
  // Smooth, not min().
  //
  // This is the source of the hard-edged diagonal value steps that appear on
  // every facade and interior wall in the level and read as a lighting bug.
  // min(dv.x, dv.y) creases along each cell's diagonals, and the lattice is
  // rotated 26 degrees, so the crease lands at ~19 and ~71 degrees across a
  // wall; the patch layer then draws that crease as a pure value jump of up to
  // 30% because the whole cell is tinted. Rounding the corner removes the
  // crease and, as a bonus, makes a repair patch look feathered in at its
  // corners rather than mitred like a floor tile.
  float d = obSMin(dv.x, dv.y, 0.22);
  float on = step(coverage, rnd);
  // Widened from 0.055. On a 5.2 m cell that was a 29 cm border — visually a
  // razor edge at any range the player sees a wall from.
  return vec4(on * smoothstep(0.0, 0.20, d), obMHash(vec3(cid, seed + 53.0)), d, on);
}
#endif
`;

/**
 * The prologue does *all* texture work: projection choice, parallax march,
 * detail layer, second-material blend and per-instance variation. The chunk
 * replacements below are then trivial reads of these locals.
 */
const FRAG_PROLOGUE = /* glsl */ `
  vec3  obWPos = vObWorld;
  vec3  obWNrm = normalize(vObNormalW);
  float obDist = length(vViewPosition);
  vec3  obVdirV = normalize(vViewPosition);

  #ifdef OB_INSTANCE_VAR
    vec4 obV = vObVar;
  #else
    vec4 obV = vec4(0.0);
  #endif

  vec4 obAlb = vec4(1.0);
  vec4 obOrm = vec4(1.0, 1.0, 0.0, 0.5);
  vec3 obNrmT = vec3(0.0, 0.0, 1.0);   // tangent space (uv path)
  vec3 obWn   = obWNrm;                // world space (triplanar path)
  vec3 obNrmV = normalize(vNormal);
  float obPomShade = 1.0;
  float obDistFade = 1.0 - smoothstep(obNormalFade, obNormalFade * 4.0, obDist);
  // Screen-space footprint of one world metre, hoisted out of every branch:
  // fwidth() inside non-uniform control flow is undefined behaviour in GLSL ES
  // and crashes some drivers outright.
  float obPixW = max(fwidth(obWPos.x), fwidth(obWPos.z));

  #ifdef OB_TRIPLANAR
    /* ---------------------------------------------------- triplanar ---- */
    vec3 obTw = pow(abs(obWNrm), vec3(obTriSharp));
    obTw /= (obTw.x + obTw.y + obTw.z + 1e-5);
    vec3 obSg = sign(obWNrm + vec3(1e-6));
    vec3 obTp = obWPos * obTileScale + obV.w;

    #ifdef OB_POM
      /* World-space parallax. The ray is marched through the height field of
         the *dominant* plane only — one fetch per step instead of three — and
         the hit point is then re-projected onto all three planes, so the whole
         triplanar stack shifts together and stays consistent. */
      {
        float obPomFade = 1.0 - smoothstep(5.0, 13.0, obDist);
        float obDepthT = obPom.x * obPomFade;
        if (obDepthT > 1e-5) {
          vec3 obVw = normalize(cameraPosition - obWPos);
          float obNdv = max(dot(obWNrm, obVw), 0.42);
          float obSteps = mix(obPom.z, obPom.y, obNdv);
          vec3 obStepT = -obVw * (obDepthT / (obNdv * obSteps));
          int obAx = obDomAxis(obWNrm);
          vec2 obPdx = dFdx(obPlaneUv(obTp, obAx, obSg));
          vec2 obPdy = dFdy(obPlaneUv(obTp, obAx, obSg));
          float obLayer = 1.0 / obSteps;
          float obCur = 0.0;
          vec3 obP = obTp;
          float obD = 1.0 - textureGrad(roughnessMap, obPlaneUv(obP, obAx, obSg), obPdx, obPdy).a;
          for (int i = 0; i < 48; i++) {
            if (float(i) >= obSteps || obCur >= obD) break;
            obP += obStepT;
            obD = 1.0 - textureGrad(roughnessMap, obPlaneUv(obP, obAx, obSg), obPdx, obPdy).a;
            obCur += obLayer;
          }
          vec3 obPrev = obP - obStepT;
          float obAfter = obD - obCur;
          float obBefore = (1.0 - textureGrad(roughnessMap, obPlaneUv(obPrev, obAx, obSg), obPdx, obPdy).a) - obCur + obLayer;
          float obW = clamp(obAfter / (obAfter - obBefore + 1e-5), 0.0, 1.0);
          obTp = mix(obP, obPrev, obW);

          #ifdef OB_POM_SHADOW
            #if NUM_DIR_LIGHTS > 0
              vec3 obLw = normalize(directionalLights[0].direction * mat3(viewMatrix));
              float obNdl = dot(obWNrm, obLw);
              if (obNdl > 0.05) {
                float obH0 = textureGrad(roughnessMap, obPlaneUv(obTp, obAx, obSg), obPdx, obPdy).a;
                vec3 obSStep = obLw * (obDepthT / (obNdl * 8.0));
                float obOcc = 0.0;
                vec3 obSp = obTp;
                for (int s = 1; s <= 8; s++) {
                  float t = float(s) / 8.0;
                  obSp += obSStep;
                  float hs = textureGrad(roughnessMap, obPlaneUv(obSp, obAx, obSg), obPdx, obPdy).a;
                  obOcc = max(obOcc, (hs - (obH0 + t * (1.0 - obH0))) * (1.0 - t * 0.55));
                }
                obPomShade = mix(1.0, clamp(1.0 - obOcc * 5.0, 0.18, 1.0), obPomFade);
              }
            #endif
          #endif
        }
      }
    #endif

    vec2 obUvX = vec2(-obTp.z * obSg.x, obTp.y);
    vec2 obUvY = vec2( obTp.x, -obTp.z * obSg.y);
    vec2 obUvZ = vec2( obTp.x * obSg.z, obTp.y);

    obAlb = texture2D(map, obUvX) * obTw.x + texture2D(map, obUvY) * obTw.y + texture2D(map, obUvZ) * obTw.z;
    obOrm = texture2D(roughnessMap, obUvX) * obTw.x + texture2D(roughnessMap, obUvY) * obTw.y + texture2D(roughnessMap, obUvZ) * obTw.z;

    vec3 obNx = texture2D(normalMap, obUvX).xyz * 2.0 - 1.0;
    vec3 obNy = texture2D(normalMap, obUvY).xyz * 2.0 - 1.0;
    vec3 obNz = texture2D(normalMap, obUvZ).xyz * 2.0 - 1.0;
    vec2 obNs = normalScale * mix(0.34, 1.0, obDistFade);
    obNx.xy *= obNs; obNy.xy *= obNs; obNz.xy *= obNs;
    // Reoriented whiteout blend: fold the geometric normal into each plane so
    // the result stays correct on curved and beveled surfaces.
    obNx = vec3(obNx.xy + obWNrm.zy, abs(obNx.z) * obWNrm.x);
    obNy = vec3(obNy.xy + obWNrm.xz, abs(obNy.z) * obWNrm.y);
    obNz = vec3(obNz.xy + obWNrm.xy, abs(obNz.z) * obWNrm.z);
    obWn = normalize(obNx.zyx * obTw.x + obNy.xzy * obTw.y + obNz.xyz * obTw.z);
    vec2 obDetUv = vec2(obTp.x + obTp.z * 0.71, obTp.y - obTp.z * 0.71);
  #else
    /* ------------------------------------------------------- uv path ---- */
    mat3 obTBN = obFrame(-vViewPosition, normalize(vNormal), vMapUv);
    vec2 obUv = vMapUv;
    #ifdef OB_INSTANCE_VAR
      obUv += obV.w;
    #endif

    #ifdef OB_UV_VARY
      {
        /* Per-panel variation without a per-instance attribute.
           World position is an affine function of uv across a flat panel, so
           the panel's uv origin can be recovered from screen-space derivatives.
           Every fragment on the panel resolves the same origin, so hashing it
           gives a stable per-panel id with no seam down the middle — which is
           what stops twelve windows carrying the same baked crack. */
        vec2 obDux = dFdx(vMapUv), obDuy = dFdy(vMapUv);
        vec3 obDpx = dFdx(obWPos), obDpy = dFdy(obWPos);
        float obDet = obDux.x * obDuy.y - obDux.y * obDuy.x;
        vec3 obOrg = obWPos;
        if (abs(obDet) > 1e-10) {
          vec3 obPu = ( obDuy.y * obDpx - obDux.y * obDpy) / obDet;
          vec3 obPv = (-obDuy.x * obDpx + obDux.x * obDpy) / obDet;
          obOrg = obWPos - vMapUv.x * obPu - vMapUv.y * obPv;
        }
        vec3 obPid = floor(obOrg * 3.0 + 0.137);
        float obJ0 = obHash1(dot(obPid, vec3(1.0, 57.0, 113.0)) + 0.5);
        float obJ1 = obHash1(dot(obPid, vec3(11.0, 7.0, 191.0)) + 3.7);
        float obJ2 = obHash1(dot(obPid, vec3(31.0, 97.0, 5.0)) + 9.1);
        if (obJ2 > 0.5) obUv.x = -obUv.x;
        if (obJ2 > 0.75) obUv.y = -obUv.y;
        obUv += vec2(obJ0, obJ1) * 3.0;
      }
    #endif

    #ifdef OB_POM
      {
        vec3 vts = normalize(vec3(dot(obVdirV, obTBN[0]), dot(obVdirV, obTBN[1]), dot(obVdirV, obTBN[2])));
        float nSteps = mix(obPom.z, obPom.y, clamp(abs(vts.z), 0.0, 1.0));
        float pomFade = 1.0 - smoothstep(5.0, 13.0, obDist);
        float depth = obPom.x * pomFade;
        if (depth > 1e-5) {
          vec2 ddx = dFdx(obUv);
          vec2 ddy = dFdy(obUv);
          vec2 delta = (vts.xy / max(abs(vts.z), 0.45)) * depth / nSteps;
          float layer = 1.0 / nSteps;
          float cur = 0.0;
          vec2 p = obUv;
          float d = 1.0 - textureGrad(roughnessMap, p, ddx, ddy).a;
          for (int i = 0; i < 48; i++) {
            if (float(i) >= nSteps || cur >= d) break;
            p -= delta;
            d = 1.0 - textureGrad(roughnessMap, p, ddx, ddy).a;
            cur += layer;
          }
          vec2 prev = p + delta;
          float after = d - cur;
          float before = (1.0 - textureGrad(roughnessMap, prev, ddx, ddy).a) - cur + layer;
          float w = clamp(after / (after - before + 1e-5), 0.0, 1.0);
          obUv = mix(p, prev, w);

          #ifdef OB_POM_SHADOW
            #if NUM_DIR_LIGHTS > 0
              vec3 ld = normalize(directionalLights[0].direction);
              vec3 lts = normalize(vec3(dot(ld, obTBN[0]), dot(ld, obTBN[1]), dot(ld, obTBN[2])));
              if (lts.z > 0.05) {
                float sh0 = textureGrad(roughnessMap, obUv, ddx, ddy).a;
                vec2 sdelta = (lts.xy / lts.z) * depth / 8.0;
                float occ = 0.0;
                for (int s = 1; s <= 8; s++) {
                  float t = float(s) / 8.0;
                  float hs = textureGrad(roughnessMap, obUv + sdelta * float(s), ddx, ddy).a;
                  occ = max(occ, (hs - (sh0 + t * (1.0 - sh0))) * (1.0 - t * 0.6));
                }
                obPomShade = clamp(1.0 - occ * 5.0, 0.18, 1.0);
                obPomShade = mix(1.0, obPomShade, pomFade);
              }
            #endif
          #endif
        }
      }
    #endif

    obAlb = texture2D(map, obUv);
    obOrm = texture2D(roughnessMap, obUv);
    obNrmT = texture2D(normalMap, obUv).xyz * 2.0 - 1.0;
    obNrmT.xy *= normalScale * mix(0.34, 1.0, obDistFade);
    vec2 obDetUv = obUv;
  #endif

  /* ------------------------------------------------- second material ---- */
  #ifdef OB_BLEND
    {
      #ifdef OB_TRIPLANAR
        vec3 btp = obWPos * obBlendTile;
        vec2 bx = vec2(-btp.z * obSg.x, btp.y);
        vec2 by = vec2( btp.x, -btp.z * obSg.y);
        vec2 bz = vec2( btp.x * obSg.z, btp.y);
        vec4 bAlb = texture2D(obBlendAlb, bx) * obTw.x + texture2D(obBlendAlb, by) * obTw.y + texture2D(obBlendAlb, bz) * obTw.z;
        vec4 bOrm = texture2D(obBlendOrm, bx) * obTw.x + texture2D(obBlendOrm, by) * obTw.y + texture2D(obBlendOrm, bz) * obTw.z;
        vec3 bnx = texture2D(obBlendNrm, bx).xyz * 2.0 - 1.0;
        vec3 bny = texture2D(obBlendNrm, by).xyz * 2.0 - 1.0;
        vec3 bnz = texture2D(obBlendNrm, bz).xyz * 2.0 - 1.0;
        bnx = vec3(bnx.xy + obWNrm.zy, abs(bnx.z) * obWNrm.x);
        bny = vec3(bny.xy + obWNrm.xz, abs(bny.z) * obWNrm.y);
        bnz = vec3(bnz.xy + obWNrm.xy, abs(bnz.z) * obWNrm.z);
        vec3 bWn = normalize(bnx.zyx * obTw.x + bny.xzy * obTw.y + bnz.xyz * obTw.z);
      #else
        vec2 buv = obDetUv * obBlendTile;
        vec4 bAlb = texture2D(obBlendAlb, buv);
        vec4 bOrm = texture2D(obBlendOrm, buv);
        vec3 bNrmT = texture2D(obBlendNrm, buv).xyz * 2.0 - 1.0;
      #endif

      // The mask arrives as a *per-vertex* value, so on a wall built from one
      // quad it is bilinear at the corners but linear-per-triangle in the
      // rasteriser: the gradient kinks along the shared diagonal and a smooth
      // ramp draws that kink as a metres-long straight line — the X across a
      // facade. Two octaves of world-space noise, at an amplitude larger than
      // the kink, move the transition off the diagonal entirely and give the
      // dirt boundary the ragged edge a real one has.
      float bwv = clamp(vColor.r, 0.0, 1.0);
      float bwN = obMNoiseN(obWPos * 1.35 + 12.3) * 0.55
                + obMNoiseN(obWPos * 4.20 + 41.9) * 0.30
                + obMNoiseN(obWPos * 12.5 + 77.1) * 0.15;
      // Only the transition band is displaced: a mask of exactly 0 or 1 has to
      // stay exact, or the second layer leaks onto surfaces that never asked
      // for it. Inside the band the noise is larger than the crease, so the
      // boundary follows the noise and there is no straight line left to read.
      //
      // Deliberately left as authored. The wave brief attributes the level's
      // hard-edged diagonal value steps to this gate switching the de-kinking
      // noise off on a broad vertex-colour ramp. Measured instead: rendering
      // vColor.r directly and dividing the lighting back out shows the mask on
      // those facades is *blobby*, not a ramp — facadeDamage() thresholds to
      // 0/1 with a 0.09-wide band — and no crease appears in it. Disabling this
      // block leaves the steps untouched; disabling the obPatch lattice below
      // removes them completely. Widening this gate does change the look — it
      // pushes ~2.5x more of every facade past the height-blend threshold and
      // exposes far more masonry — so it is left alone.
      float bwEdge = smoothstep(0.015, 0.30, min(bwv, 1.0 - bwv));
      float bw = clamp(bwv + (bwN - 0.5) * 0.62 * bwEdge, 0.0, 1.0);
      // Height-aware transition: whichever layer is physically taller wins,
      // so dirt settles into mortar lines instead of fading over them. The
      // 0.12 band snapped between the two stacks inside a centimetre of height,
      // which is what gave the paving hard-bordered blotches; 0.15 feathers
      // slightly without letting the second layer bleed over the joints.
      float ha = obOrm.a * (1.0 - bw) + 1e-4;
      float hb = bOrm.a * bw + 1e-4;
      float mx = max(ha, hb) - 0.15;
      float wa = max(ha - mx, 0.0);
      float wb = max(hb - mx, 0.0);
      float bt = wb / max(wa + wb, 1e-5);

      // Dirt takes its hue from what it has settled on: neat, fully saturated
      // ochre dirt dropped on grey paving reads as spilled paint, not grime.
      float bLum = dot(bAlb.rgb, vec3(0.2126, 0.7152, 0.0722));
      float aLum = max(dot(obAlb.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      bAlb.rgb = mix(bAlb.rgb, vec3(bLum), 0.30);
      bAlb.rgb *= mix(vec3(1.0), obAlb.rgb / aLum, 0.32);

      obAlb = mix(obAlb, bAlb, bt);
      obOrm = mix(obOrm, bOrm, bt);
      #ifdef OB_TRIPLANAR
        obWn = normalize(mix(obWn, bWn, bt));
      #else
        obNrmT = normalize(mix(obNrmT, bNrmT, bt));
      #endif
    }
  #endif

  /* ------------------------------------------------ per-block masonry tone -- */
  #if defined(OB_TRIPLANAR) && defined(OB_CELLTONE)
    {
      // obBrick takes each block's random from mod(id, counts), so a map
      // authored on a 4x7 lattice contains exactly 28 distinct stones and
      // repeats them once per tile. At cobble scale (0.55 m) that is the same
      // block of 28 setts every 55 centimetres, unbroken from the player's
      // boots to the far end of the square — which is precisely why the paving
      // reads as a printed grid rather than as a setted street.
      //
      // Re-deriving the same lattice from world position and hashing the
      // *unwrapped* course/column id gives every stone in the level its own
      // value for the price of three hashes. Real paving is a quarry mix: most
      // stones within a quarter stop of each other, a few near-black, a few
      // bleached.
      vec2 obCu = obPlaneUv(obTp, obDomAxis(obWNrm), obSg) * obCell.xy;
      float obCrow = floor(obCu.y);
      // The running-bond shift has to use the course index *within the tile*,
      // exactly as obBrick does, because the map is generated on a wrapped
      // 0..1 uv. Using the unwrapped course offsets every other tile by half a
      // stone and the tint then straddles two blocks instead of landing on one.
      float obCrowL = mod(obCrow, obCell.y);
      float obCjit = (obHash13(vec3(0.0, obCrowL, obCell.w)) - 0.5) * obCell.z;
      float obCx = obCu.x + 0.5 * obCrowL + obCjit;
      float obCcol = floor(obCx);
      vec2 obClocal = vec2(fract(obCx), fract(obCu.y));
      // Roll the tint off toward the joints, so any residual misfit between
      // this lattice and the one baked into the map lands in the mortar rather
      // than as a sliver across a face.
      // Kept narrow on purpose: d is min() over both axes of a unit cell, so
      // its mean over the cell is only 1/6. A roll-off of 0.17 therefore runs
      // the whole layer at about half strength — measured as a 6/255 mean
      // change where a 22% albedo spread should have given three times that.
      vec2 obCd = min(obClocal, 1.0 - obClocal);
      float obCface = smoothstep(0.0, 0.055, min(obCd.x, obCd.y));
      // Once a block is near a pixel the hash is just noise, so fade it out and
      // let the macro drift carry the distance.
      obCface *= 1.0 - smoothstep(22.0, 48.0, obDist);
      float obCh0 = obHash13(vec3(obCcol, obCrow, obCell.w + 3.1));
      float obCh1 = obHash13(vec3(obCcol, obCrow, obCell.w + 17.7));
      float obCh2 = obHash13(vec3(obCcol, obCrow, obCell.w + 41.3));
      // A 0.78..1.22 spread measured 6/255 across the plaza: the display
      // transform is very compressive where the sunlit paving lands, so a
      // quarter-stop authored spread arrives as two levels and the square reads
      // as one printed grid you can count from 1 m to 40 m. A real setted
      // square is a quarry mix — most stones close together, a solid minority a
      // long way off — so the authored spread has to be a good deal wider than
      // the one you would pick off a swatch.
      float obCv = mix(0.66, 1.30, obCh0);
      obCv *= mix(1.0, 0.52, step(0.880, obCh1));   // dark: wet, oil-soaked, replaced
      obCv *= mix(1.0, 1.26, step(0.930, obCh0));   // bleached
      obAlb.rgb *= mix(1.0, obCv, obCface);
      // Setts come out of more than one quarry and weather differently. Value
      // alone still reads as a printed grid at a second exposure; the warm/cool
      // spread is what makes them read as separate stones.
      obAlb.rgb *= mix(vec3(1.0), mix(vec3(0.950, 0.986, 1.046), vec3(1.046, 1.004, 0.944), obCh2), obCface * 0.9);
      // Traffic has burnished some stones and left others matte; without this
      // the whole run answers a raking sun with one specular value.
      obOrm.g = clamp(obOrm.g + (obCh1 - 0.5) * 0.30 * obCface, 0.03, 1.0);
      // Joints must be darker than the stones.
      //
      // The baked map draws its mortar a shade *lighter* than the stone faces
      // and puts a curvature highlight on every arris, so the setted street
      // reads as a bright grid printed on a flat sheet — countable from 1 m to
      // 40 m. The height channel already knows where the joint is, so drive the
      // darkening off that rather than trying to re-author the map.
      float obCjoint = 1.0 - smoothstep(0.14, 0.44, obOrm.a);
      obAlb.rgb *= mix(1.0, 0.50, obCjoint);
      obOrm.g = clamp(obOrm.g + obCjoint * 0.24, 0.03, 1.0);
      // A joint is a hole. Occluding it as well as staining it is what turns a
      // drawn grid into a network of gaps between separate stones.
      obOrm.r = clamp(obOrm.r * mix(1.0, 0.62, obCjoint), 0.0, 1.0);
    }
  #endif

  /* ------------------------------------------------------ detail layer -- */
  #ifdef OB_DETAIL
    {
      float dfade = 1.0 - smoothstep(obDetailFade.x, obDetailFade.y, obDist);
      if (dfade > 0.002) {
        vec4 dt = texture2D(obDetailMap, obDetUv * obDetailScale);
        // The *normal* half of the detail layer has to die off far faster than
        // the albedo/roughness half. Past a metre or two its texels fall below
        // a pixel, the mip chain keeps their variance, and what should be sand
        // grain turns into a crawling gravel rash across the whole wall.
        float dnFade = mix(0.28, 1.0, 1.0 - smoothstep(1.2, 7.0, obDist));
        // Half strength on anything facing up. A ground plane returns the sky
        // as a broad specular veil, and a millimetre-scale normal map modulating
        // that veil is not texture — it is a field of identical bright dots, the
        // "sand scattered on a mat" read that a 1 m crop of the alley floor came
        // back with. On a wall the same layer is doing real work, so this is
        // gated on the normal rather than turned down globally.
        dnFade *= mix(1.0, 0.60, clamp(obWNrm.y * 2.4 - 0.7, 0.0, 1.0));
        vec2 dn = (dt.rg * 2.0 - 1.0) * obDetailStrength.x * dfade * dnFade;
        float da = (dt.b - 0.5) * obDetailStrength.y * dfade;
        float dr = (dt.a - 0.5) * obDetailStrength.z * dfade;
        obAlb.rgb *= (1.0 + da);
        obOrm.g = clamp(obOrm.g + dr, 0.03, 1.0);
        #ifdef OB_TRIPLANAR
          vec3 upRef = abs(obWNrm.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
          vec3 dT = normalize(cross(upRef, obWNrm));
          vec3 dB = cross(obWNrm, dT);
          obWn = normalize(obWn + dT * dn.x + dB * dn.y);
        #else
          obNrmT = obBlendNormals(obNrmT, vec3(dn, 1.0));
        #endif
      }
    }
  #endif

  /* -------------------------------------------- per-instance variation -- */
  #ifdef OB_INSTANCE_VAR
    obAlb.rgb = obHueRot(obAlb.rgb, obV.x * 0.05);
    obAlb.rgb *= (1.0 + obV.y * 0.20);
    obOrm.g = clamp(obOrm.g + obV.z * 0.22, 0.03, 1.0);
    obAlb.rgb = mix(obAlb.rgb, obAlb.rgb * vec3(0.72, 0.68, 0.62), clamp(obV.z, 0.0, 1.0) * 0.35);
  #endif

  /* ------------------------------------------- world-space macro breakup -- */
  #ifdef OB_MACRO
    {
      // Two decorrelated octaves in metres. The coarse one carries the "this
      // wall has been patched and weathered unevenly" story; the fine one
      // desynchronises the texture repeat so the tiling never lines up.
      float obM1 = obMNoiseN(obWPos * obMacro.x + 13.7);
      float obM2 = obMNoiseN(obWPos * obMacro.y + 71.3);
      float obM3 = obMNoiseN(obWPos * (obMacro.x * 2.9) + 41.9);
      float obMv = (obM1 - 0.5) * 1.30 + (obM2 - 0.5) * 0.70 + (obM3 - 0.5) * 0.60;

      // Value drift, kept small: real render/plaster varies a few percent, and
      // anything more reads as camouflage.
      obAlb.rgb *= 1.0 + obMv * obMacro.z;
      // Temperature drift — sun-bleached patches go warm-pale, sheltered ones
      // stay cool. This is what sells "large scale variation" without contrast.
      // Temperature drift. +/-2% was inside the noise: a facade with one hue at
      // several values is the printed-sheet read, and the cure is a *hue*
      // spread, not more value. Sun-bleached patches go warm-pale, sheltered
      // ones keep the cool cast of the sky that is the only light they see.
      obAlb.rgb *= mix(vec3(0.966, 0.990, 1.040), vec3(1.036, 1.004, 0.950),
                       clamp(obM2 * 1.35 - 0.18, 0.0, 1.0));
      // A real hue drift on top of the temperature drift.
      //
      // A tinted family is a *hue line*: every pixel on a red shutter sits at
      // the same hue and only its value moves, which is the "saturated blotch"
      // read. Carried on the same weathering-film weight as the deep-end lift,
      // so it lands on the paint/timber/plastic recipes that are authored as
      // pigment and leaves masonry and ground — where a hue drift would only
      // push a warm ground plane warmer — completely alone.
      obAlb.rgb = obHueRot(obAlb.rgb, (obM3 - 0.5) * obFilm * 0.105);
      obOrm.g = clamp(obOrm.g + obMv * obMacro.w, 0.03, 1.0);

      /* ------------------------------------------------ gravity runoff --- */
      // The same noise stretched 6:1 vertically becomes staining that runs
      // *down* a wall at building scale. A tiling texture physically cannot
      // do this — any vertical gradient baked into the tile bands at every
      // repeat — so the streaks that read as weathering have to live here.
      {
        float obRun = obMNoiseN(obWPos * vec3(0.62, 0.105, 0.62) + 47.1);
        obRun = smoothstep(0.48, 0.80, obRun) * (1.0 - abs(obWNrm.y));
        obRun *= obMacro.z * 2.4;
        obAlb.rgb = mix(obAlb.rgb, obAlb.rgb * vec3(0.80, 0.785, 0.755), obRun);
        obOrm.g = clamp(obOrm.g + obRun * 0.22, 0.03, 1.0);
      }

      /* --------------------------------------------- repairs and patches -- */
      // Two lattices at different scales: the coarse one is a resurfaced bay
      // or a second pour, the fine one is an individual replaced slab. Without
      // them a tiled ground plane holds one value from the player's boots to
      // the end of the street, which is the single loudest procedural tell.
      if (obSurf.x > 0.001) {
        // Project into the surface's own plane. Using world xz everywhere put
        // the whole height of a wall — and the whole of a jersey barrier or an
        // arcade pier — inside one lattice cell, so a vertical surface came out
        // as a single flat value: exactly the complaint about the plaster pier.
        vec2 obPp = abs(obWNrm.y) > 0.5
          ? obWPos.xz
          : (abs(obWNrm.x) > abs(obWNrm.z) ? vec2(obWPos.z, obWPos.y) : vec2(obWPos.x, obWPos.y));
        vec4 pA = obPatch(obPp, 5.2, 0.60, 3.0);
        vec4 pB = obPatch(obPp, 2.35, 0.58, 61.0);
        // A 5.2 m lattice rotated 26 degrees is the right story for a road —
        // resurfaced bays really are laid in big skewed rectangles — and the
        // wrong one for a facade, where nothing is repaired on a diagonal.
        // Half strength on verticals keeps the pier from reading as one flat
        // value without stamping a road repair across a wall.
        float obPFace = mix(0.50, 1.0, clamp(abs(obWNrm.y) * 1.8, 0.0, 1.0));
        float wA = pA.x * obSurf.x * obPFace;
        float wB = pB.x * obSurf.x * 0.62 * obPFace;

        // Value: a repair is laid in a different batch, so it reads at a
        // different exposure — this is where most of the frame's tonal range
        // on the ground comes from. Pulled in from 0.44..1.34: at that range a
        // single cell boundary is a 3:1 value step, which no amount of edge
        // feathering stops the eye reading as a lighting discontinuity.
        obAlb.rgb *= mix(1.0, mix(0.62, 1.26, pA.y), wA);
        obAlb.rgb *= mix(1.0, mix(0.74, 1.18, pB.y), wB);
        // Cooler when darker, warmer when paler: fresh tarmac against old.
        obAlb.rgb *= mix(vec3(1.0), mix(vec3(0.955, 0.985, 1.035), vec3(1.035, 1.005, 0.960), pA.y), wA);
        obOrm.g = clamp(mix(obOrm.g, mix(0.30, 0.99, pA.y), wA * 0.80), 0.03, 1.0);
        obOrm.g = clamp(mix(obOrm.g, mix(0.48, 0.99, pB.y), wB * 0.60), 0.03, 1.0);

        // Ground-in dirt in the joint around a patch — but only around a patch,
        // never around every cell, or the lattice itself becomes the pattern.
        float rim = (1.0 - smoothstep(0.0, 0.14, pA.z)) * pA.w * obSurf.x * obPFace;
        obAlb.rgb *= mix(1.0, 0.72, rim * 0.75);
        obOrm.g = clamp(obOrm.g + rim * 0.16, 0.03, 1.0);
      }

      /* ---------------------------------- what happens on a ground plane -- */
      // Everything below is gravity-driven, so it belongs only on surfaces
      // that actually face up. A wall gets none of it.
      float obUp = clamp(obWNrm.y * 2.4 - 0.7, 0.0, 1.0);

      if (obUp > 0.002 && obSurf.y + obSurf.z + obSurf.w > 0.001) {
        // Standing damp in the low, sheltered ground. Wet stone is both much
        // darker and much smoother, so this carries a stop and a half of value
        // *and* puts a sheen under a low sun.
        // Broken up at a second, much shorter wavelength so the wet area has a
        // ragged edge and a mottled interior instead of reading as one smooth
        // lens of oil laid over the street.
        float obDamp = obMFbmN(obWPos * vec3(0.155, 0.03, 0.155) + 5.3);
        obDamp = smoothstep(0.40, 0.74, obDamp);
        obDamp *= mix(0.45, 1.0, obMNoiseN(obWPos * vec3(0.95, 0.10, 0.95) + 33.1));
        obDamp *= obUp * obSurf.y;
        obAlb.rgb *= mix(1.0, 0.62, obDamp);
        obOrm.g = clamp(mix(obOrm.g, 0.62, obDamp * 0.90), 0.03, 1.0);

        // Wheel and foot lanes: polished, slightly darker, and stretched 20:1
        // along whichever axis the traffic runs.
        float obLnA = obMNoiseN(obWPos * vec3(0.032, 0.0, 0.62) + 27.1);
        float obLnB = obMNoiseN(obWPos * vec3(0.62, 0.0, 0.032) + 63.7);
        float obPol = max(smoothstep(0.50, 0.86, obLnA), smoothstep(0.50, 0.86, obLnB));
        obPol *= obUp * obSurf.z;
        obAlb.rgb *= mix(1.0, 0.74, obPol);
        obOrm.g = clamp(mix(obOrm.g, 0.58, obPol * 0.8), 0.03, 1.0);

        // Silt and blown dust: pale, warm, dead matte, and it lands where the
        // damp is not.
        float obSilt = obMNoiseN(obWPos * vec3(0.30, 0.03, 0.30) + 91.3);
        obSilt = smoothstep(0.48, 0.84, obSilt) * obUp * obSurf.y * (1.0 - obDamp * 0.8);
        obAlb.rgb = mix(obAlb.rgb, obAlb.rgb * vec3(1.15, 1.09, 0.99) + 0.010, obSilt * 0.7);
        obOrm.g = clamp(obOrm.g + obSilt * 0.20, 0.03, 1.0);

        // Oil and tar: small, tight, near black, and glossy.
        float obOil = obMNoiseN(obWPos * vec3(0.95, 0.06, 0.95) + 151.7);
        obOil = smoothstep(0.72, 0.93, obOil) * obUp * obSurf.y;
        obAlb.rgb *= mix(1.0, 0.34, obOil);
        obOrm.g = clamp(mix(obOrm.g, 0.34, obOil * 0.9), 0.03, 1.0);

      }

      /* ------------------------------------------------- laid paving ------ */
      // A floor is *laid*, and that is the single loudest thing missing from a
      // procedural ground plane: courses, a running bond, a joint network that
      // takes the light differently from the flags, and a value spread flag to
      // flag because they came out of different batches, have been lifted and
      // relaid, and are polished by different amounts of traffic.
      //
      // The base map cannot carry any of it — it is the same tile from the
      // player's boots to the end of the street — and the anonymous per-cell
      // tint this replaces drew the value steps but never drew the joint, so
      // the eye had nothing to read them against.
      //
      // obPave.xy is the flag size in metres, obPave.z the joint strength.
      // With the joint at zero the block degenerates to exactly the per-cell
      // tone it replaces, which is what dirt, gravel and grass want.
      if (obUp > 0.002 && obSurf.x > 0.001) {
        vec2 obPsz = max(obPave.xy, vec2(0.05));
        // Courses run along +x. Every other course is offset half a flag, and
        // each one wanders a few centimetres, so the joints never resolve into
        // one ruled grid running the length of the street.
        float obPcrs = floor(obWPos.z / obPsz.y);
        float obPoff = 0.5 * mod(obPcrs, 2.0)
                     + (obHash1(obPcrs * 1.37 + obPave.w) - 0.5) * 0.42;
        float obPsx = obWPos.x / obPsz.x + obPoff;
        float obPcol = floor(obPsx);
        vec2 obPlf = vec2(fract(obPsx), fract(obWPos.z / obPsz.y));
        vec2 obPdm = min(obPlf, 1.0 - obPlf) * obPsz;      // metres to the joint

        float obPh0 = obHash1(dot(vec2(obPcol, obPcrs), vec2(1.0, 137.0)) + obPave.w + 7.31);
        float obPh1 = obHash1(dot(vec2(obPcol, obPcrs), vec2(53.0, 11.0)) + obPave.w + 91.7);
        float obPh2 = obHash1(dot(vec2(obPcol, obPcrs), vec2(19.0, 71.0)) + obPave.w + 53.1);

        // Hard cell edges alias badly once a cell is under a pixel, so the tone
        // fades out with distance and lets the macro drift carry the far field.
        float obPw = obUp * obSurf.x * (1.0 - smoothstep(26.0, 62.0, obDist));
        // Most flags sit within a quarter stop of each other; a minority are a
        // long way off, and *that* is what a real paving run looks like at
        // twenty metres. A tight uniform spread just reads as noise.
        float obPv = mix(0.80, 1.19, obPh0);
        obPv *= mix(1.0, 0.62, step(0.86, obPh1));   // relaid, oil-soaked or burnt
        obPv *= mix(1.0, 1.20, step(0.93, obPh2));   // and a few bleached
        obAlb.rgb *= mix(1.0, obPv, obPw * 0.95);
        // Batch temperature. A mixed run of flags is warm and cool, never one
        // hue at several values — that is the printed-sheet read.
        obAlb.rgb *= mix(vec3(1.0), mix(vec3(0.958, 0.988, 1.038), vec3(1.040, 1.004, 0.952), obPh1), obPw * 0.85);
        obOrm.g = clamp(obOrm.g + (obPh2 - 0.5) * 0.34 * obPw, 0.03, 1.0);

        if (obPave.z > 0.001) {
          // Joint width wanders: a hand-laid joint is 12-30 mm and never twice
          // the same. Below a pixel the whole term has to fade by *amplitude*
          // rather than by width, or a paving run turns into a moire screen at
          // thirty metres.
          float obJw = 0.006 + 0.008 * obMNoiseN(obWPos * 5.7 + 3.3);
          float obAa = obPixW;
          float obJe = max(obAa * 0.8, obJw * 0.30);
          float obJd = min(obPdm.x, obPdm.y);
          float obJoint = 1.0 - smoothstep(obJw - obJe, obJw + obJe, obJd);
          obJoint *= obJw / max(obJw, obAa);
          float obJm = obJoint * obUp * obPave.z;
          // Silt and grit pack into a joint and never wash out of it, so it is
          // darker, matte, and occluded — the darkening is what makes each flag
          // read as a separate object instead of as a printed rectangle.
          obAlb.rgb *= mix(1.0, 0.46, obJm);
          obOrm.g = clamp(obOrm.g + obJm * 0.30, 0.03, 1.0);
          obOrm.r = clamp(obOrm.r * mix(1.0, 0.64, obJm), 0.0, 1.0);
          // Flags are not flush: each one dishes into its joint, and that
          // chamfer is what catches a low sun along one edge and shades the
          // other. Without it the joint is a painted line.
          float obJs = obJoint * (1.0 - obJoint) * 4.0 * obPave.z;
          vec2 obJdir = obPdm.x < obPdm.y
            ? vec2(sign(0.5 - obPlf.x), 0.0)
            : vec2(0.0, sign(0.5 - obPlf.y));
          #ifdef OB_TRIPLANAR
            obWn = normalize(obWn + vec3(obJdir.x, 0.0, obJdir.y) * obJs * 0.50);
          #else
            obNrmT = normalize(obNrmT + vec3(obJdir.x, obJdir.y, 0.0) * obJs * 0.50);
          #endif
        }
      }

      /* ------------------------------------------------- ground gloss floor -- */
      // Every up-facing layer above targets a *low* roughness — damp pinned it
      // at 0.42, wheel polish at 0.40, oil at 0.18, a replaced slab at 0.24 —
      // and the ground archetypes already run wear 0.9, so most of the paving
      // ended up somewhere in the low 0.4s at once. At that roughness a
      // horizontal plane under a low sun returns the amber sky as a near
      // mirror: every ground plane on the map came out spattered with
      // srgb(168,83,21) blobs that read as molten metal, and the town-hall
      // terrace picked up a glossy swimming-pool blue.
      //
      // A damp European sett or a walked-on concrete flag is simply never 0.42.
      // Flooring the whole up-facing stack keeps the wet look as a soft value
      // lift along the sun azimuth — which is what it is in life — instead of a
      // saturated specular blob. Vertical faces are untouched, and the metal
      // wash below deliberately runs *after* this so steel can still be a
      // mirror.
      obOrm.g = mix(obOrm.g, max(obOrm.g, 0.72), obUp);

      /* --------------------------------------------- rain-burnished metal -- */
      // Steel left outdoors loses its paint and its oxide film to weather,
      // traffic and hands, and what is left is a blurry mirror that takes its
      // colour from the sky. This is the single thing that separates "metal"
      // from "grey card", so it must not be gated on an up-facing normal: a
      // lamp column, a handrail and a tram flank are all vertical and all of
      // them are rain-washed and hand-polished.
      if (obSurf.w > 0.001) {
        // Long wavelength and a low threshold: a rail running face or a
        // handrail top is continuously burnished, not polished in 60 cm
        // patches. Vertical faces get less of it, but never none.
        // 0.26 on a vertical face left the tram's 12 m flank, every handrail
        // and every lamp column below the threshold where the wash does
        // anything, so nothing in the level took its colour from the sky and
        // nothing showed a specular gradient down a cylinder. A rail flank is
        // rained on and rubbed exactly as much as a rail top.
        float obWFace = mix(0.48, 1.0, obUp);
        float obWash = smoothstep(0.04, 0.40, obMNoiseN(obWPos * 0.48 + 7.9)) * obWFace * obSurf.w;
        // Rubbing wear on anything a hand or a sleeve reaches. Kept long and
        // weak on vertical faces: a metre-scale, half-strength version of this
        // turns a lamp column into a row of cyan blotches, because a 0.1-rough
        // metal facing a blue sky is a mirror of a blue sky.
        float obRub = smoothstep(0.34, 0.78, obMNoiseN(obWPos * vec3(0.38, 0.11, 0.38) + 19.3));
        obWash = clamp(obWash + obRub * obSurf.w * 0.16 * (1.0 - obUp * 0.4), 0.0, 1.0);
        // Paint does not burnish, it chalks.
        //
        // The recipe has already worked out where the paint film survived and
        // where the steel is bare — that is what it writes into the metalness
        // channel — and the wash was overriding it, driving *painted* panels to
        // metalness 1 at roughness 0.30. A vertical painted panel at 0.30 is a
        // mirror: it returns the sky where it faces it and near-black
        // everywhere else, which is exactly how two hung shutters in a shaded
        // alley came out 36-40% near-black with one saturated hue over 43% of
        // the card. Bare steel still gets the full wash; paint gets a fifth of
        // it, which is the chalked sheen it actually has.
        float obBare = smoothstep(0.10, 0.55, obOrm.b);
        obWash *= mix(0.20, 1.0, obBare);
        obOrm.b = clamp(mix(obOrm.b, 1.0, obWash), 0.0, 1.0);
        // Weathered steel is a *blurry* mirror, and a vertical face is blurrier
        // than a rained-on top: water sheets off it and the polishing comes from
        // hands and sleeves, not from grit under a boot. 0.30 on a wall was
        // sharp enough to resolve the sky/wall boundary as an edge.
        obOrm.g = clamp(mix(obOrm.g, mix(0.42, 0.15, obUp), obWash * 0.9), 0.02, 1.0);
        obAlb.rgb = mix(obAlb.rgb, mix(obAlb.rgb, vec3(0.62, 0.63, 0.66), 0.62), obWash);
      }

      /* ------------------------------------------- ground contact band --- */
      if (obGround.z > 0.001) {
        // The top of the wedge has to be ragged at a *decimetre* wavelength,
        // not a metre one: a clean line where a wall meets a floor is one of
        // the loudest reads in the whole frame, and a smooth metre-scale
        // gradient still leaves a clean line, just a blurrier one.
        float obRag = obMNoiseN(vec3(obWPos.x, obWPos.y * 0.25, obWPos.z) * 3.1 + 5.7);
        float obH = obGround.y * mix(0.45, 1.55, obRag);
        float obGy = 1.0 - smoothstep(obGround.x, obGround.x + obH, obWPos.y);
        // Only walls: a floor does not get splash-back on itself.
        obGy *= 1.0 - abs(obWNrm.y);
        // Broken up so the band is never a clean horizontal line.
        obGy *= mix(0.45, 1.0, obM1) * mix(0.65, 1.15, obM2);
        obGy = clamp(obGy, 0.0, 1.0) * obGround.z;
        // A hard wedge of ground-in silt in the last few centimetres, where
        // the wall is genuinely buried rather than merely splashed.
        float obWedge = pow(1.0 - smoothstep(obGround.x, obGround.x + obH * 0.30, obWPos.y), 1.6)
                      * (1.0 - abs(obWNrm.y)) * obGround.z;
        // Rising damp.
        //
        // Splash-back dirt alone left a soft grey haze at the foot of every
        // wall, and what a shaded alley actually shows is a hard, near-black
        // wet band 30-45 cm up the render: masonry wicks water out of the
        // ground continuously and it never dries in shade. It is much darker
        // than the dirt above it, slightly *cooler* (wet stone loses its warm
        // scatter), smoother, and it occludes — which together are what stop a
        // wall and a floor reading as two cards that happen to touch.
        float obDampH = obGround.y * 0.46 * mix(0.58, 1.32, obRag);
        float obWet = 1.0 - smoothstep(obGround.x + obDampH * 0.30, obGround.x + obDampH, obWPos.y);
        obWet = clamp(obWet, 0.0, 1.0) * (1.0 - abs(obWNrm.y)) * obGround.z * mix(0.62, 1.0, obM2);
        obAlb.rgb *= mix(1.0, 0.42, obWet);
        obAlb.rgb *= mix(vec3(1.0), vec3(0.93, 0.975, 1.070), obWet);
        obOrm.g = clamp(mix(obOrm.g, 0.58, obWet * 0.75), 0.03, 1.0);
        obOrm.r = clamp(obOrm.r * mix(1.0, 0.70, obWet), 0.0, 1.0);

        // Splash-back dirt: darker, desaturated, and much rougher.
        vec3 obGrime = obAlb.rgb * vec3(0.42, 0.40, 0.37);
        obAlb.rgb = mix(obAlb.rgb, obGrime, obGy);
        obAlb.rgb = mix(obAlb.rgb, obAlb.rgb * vec3(0.86, 0.79, 0.66) * 0.72 + vec3(0.020, 0.017, 0.012), obWedge * 0.85);
        obOrm.g = clamp(mix(obOrm.g, 0.97, obGy * 0.8 + obWedge * 0.5), 0.03, 1.0);
        // Salt bloom rising just above the wet line — pale, low contrast.
        float obSalt = smoothstep(0.28, 0.62, obGy / max(obGround.z, 1e-3))
                     * smoothstep(0.75, 0.42, obGy / max(obGround.z, 1e-3))
                     * smoothstep(0.45, 0.85, obM2);
        obAlb.rgb = mix(obAlb.rgb, obAlb.rgb * 1.16 + 0.012, obSalt * 0.55);
      }
    }
  #endif

  /* ------------------------------------------------------------- wear --- */
  // Grime is grey-brown dust and soot. It is *not* a darker version of the
  // paint underneath — scaling a saturated albedo by 0.55 keeps every pixel on
  // the same hue line and just moves it down, which is how a red shutter comes
  // out as one hot orange at two values with black in the cavities. Real dirt
  // pulls the surface toward neutral as it darkens it, and that desaturation is
  // most of what makes a weathered object read as weathered.
  if (obWear > 0.001) {
    float cav = 1.0 - obOrm.a;
    float w = obWear * cav;
    float lum = dot(obAlb.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 dust = mix(obAlb.rgb, vec3(lum * 1.02, lum * 0.96, lum * 0.86), 0.62) * 0.66;
    obAlb.rgb = mix(obAlb.rgb, dust, w);
    obOrm.g = clamp(mix(obOrm.g, 0.92, w * 0.6), 0.03, 1.0);
  }

  /* -------------------------------------------------- crevice grime ----- */
  // "Every place two surfaces meet must darken." The base maps already carry a
  // height field, so the shader knows where every joint, crack, dent, chip and
  // mortar line on the surface is — and until now only obWear used it, so a
  // material authored at wear 0 had perfectly clean crevices. Dirt accumulates
  // by cavity before it accumulates by anything else, on every surface in the
  // world, so it belongs here rather than in a per-material knob.
  {
    float obCav = smoothstep(0.34, 0.96, 1.0 - obOrm.a);
    float obCg = obCav * (0.42 + 0.58 * obWear);
    float obCl = dot(obAlb.rgb, vec3(0.2126, 0.7152, 0.0722));
    obAlb.rgb = mix(obAlb.rgb, vec3(obCl * 0.62, obCl * 0.58, obCl * 0.50), obCg * 0.55);
    obOrm.g = clamp(obOrm.g + obCg * 0.18, 0.03, 1.0);
    // Ambient occlusion in the crevice as well as pigment: a joint is a hole,
    // and a hole sees less sky than the face beside it.
    obOrm.r = clamp(obOrm.r * mix(1.0, 0.70, obCg), 0.0, 1.0);
  }

  /* --------------------------------------------- weathering film -------- */
  // Nothing outdoors keeps its factory contrast.
  //
  // Chalked binder, blown dust and salt settle on every exposed face, and they
  // lift the *deep* end of a surface far more than the light end: a 1 %
  // reflectance patch goes to 3-4 %, a 40 % patch barely moves. A texture map
  // authored with two and a half stops of internal range keeps every bit of it
  // forever without this, which is exactly how two hung shutters in a shaded
  // alley came out with 27-36 % of their area more than two stops below their
  // own mean — and a surface with a third of its area at pigment black does not
  // read as paint, it reads as a saturated blotch pattern.
  //
  // Deliberately off for masonry and ground: those recipes already run a narrow
  // palette, and the same compression there would flatten a floor.
  if (obFilm > 0.001) {
    // Judged on the *tinted* albedo, not on the raw map. The palette's tint is
    // a separate uniform that never reaches this shader as part of obAlb, and
    // most of the level's darkness lives in it — paintRed is linear 0.40,
    // 0.03, 0.02 — so a threshold on obAlb alone fires nowhere and the term
    // measures as a no-op.
    vec3 obFc = obAlb.rgb * diffuse;
    float obFl = dot(obFc, vec3(0.2126, 0.7152, 0.0722));
    float obFdeep = 1.0 - smoothstep(0.006, 0.085, obFl);
    // Least where the surface is a genuine cavity — dust does settle there, but
    // a real recess is also genuinely occluded, and that darkness is earned.
    float obFamt = obFilm * obFdeep * (1.0 - clamp(1.0 - obOrm.a, 0.0, 1.0) * 0.45);
    vec3 obFlift = obFc * 0.44 + vec3(0.0225, 0.0210, 0.0184);
    obAlb.rgb = mix(obAlb.rgb, obFlift / max(diffuse, vec3(1e-4)), obFamt);
  }

  /* --------------------------------------------------- hue / saturation - */
  if (abs(obHueSat.x) > 0.0005 || abs(obHueSat.y - 1.0) > 0.0005) {
    obAlb.rgb = obHueRot(obAlb.rgb, obHueSat.x);
    float obL = dot(obAlb.rgb, vec3(0.2126, 0.7152, 0.0722));
    obAlb.rgb = mix(vec3(obL), obAlb.rgb, obHueSat.y);
  }

  /* ------------------------------------------------------ energy clamp -- */
  // The palette may drive the diffuse uniform above 1 (SurfaceOptions.gain),
  // because most of this level's tints are being used as darkeners on maps that
  // are already at the right level. diffuse * obAlb is both the diffuse albedo
  // and, where metalness is high, the specular F0, so it has to stay inside the
  // unit cube whatever the palette asks for.
  obAlb.rgb = min(obAlb.rgb, vec3(1.0) / max(diffuse, vec3(1e-3)));

  /* --------------------------------------------------- resolve normal --- */
  #ifdef OB_TRIPLANAR
    obWn = obClampTilt(obWn, obWNrm);
    obNrmV = normalize((viewMatrix * vec4(obWn, 0.0)).xyz);
  #else
    obNrmT = obClampTilt(obNrmT, vec3(0.0, 0.0, 1.0));
    obNrmV = normalize(obTBN * obNrmT);
  #endif
`;

/**
 * Animated emissive. The albedo map doubles as the emissive map — for a
 * monitor the "screen content" *is* the albedo — and each mode modulates it
 * with the temporal signature of the real fixture: mains ripple and ballast
 * stutter for fluorescents, a rotating-mirror ramp for beacons, a refresh
 * roll and phosphor mask for CRTs, a height-driven blackbody for hot metal.
 */
const EMISSIVE_GLSL = /* glsl */ `
{
  vec3 obEm = obAlb.rgb;
  float obT = obTime;

  #if OB_EMISSIVE_MODE == 1
    // Fluorescent: 100 Hz mains ripple, slow warm-up, failing-ballast dropouts.
    float mains = 0.93 + 0.07 * sin(obT * 628.3 + obEmissive.z);
    float bucket = floor(obT * 14.0 + obEmissive.z * 37.0);
    float fail = step(0.055, obHash1(bucket));
    float restrike = step(0.5, obHash1(bucket * 0.37 + 11.0));
    float warm = clamp(0.45 + obT * 0.5, 0.45, 1.0);
    obEm *= mains * warm * mix(mix(0.12, 0.55, restrike), 1.0, fail);
  #elif OB_EMISSIVE_MODE == 2
    // Rotating beacon: a sharp double flash, then dark.
    float p = fract(obT * obEmissive.y + obEmissive.z);
    float flash = smoothstep(0.0, 0.02, p) * smoothstep(0.16, 0.04, p)
                + smoothstep(0.22, 0.24, p) * smoothstep(0.36, 0.26, p) * 0.7;
    obEm *= flash * 3.2 + 0.04;
  #elif OB_EMISSIVE_MODE == 3
    // CRT: phosphor mask, refresh roll, interlace shimmer, occasional glitch.
    float scan = 0.80 + 0.20 * sin((obDetUv.y + obT * 0.6) * 1600.0);
    float roll = fract(obDetUv.y * 0.35 - obT * 0.09);
    float band = 1.0 + 0.22 * smoothstep(0.0, 0.04, roll) * smoothstep(0.10, 0.05, roll);
    float glitchBucket = floor(obT * 3.0 + obEmissive.z * 13.0);
    float glitch = step(0.94, obHash1(glitchBucket));
    obEm *= scan * band * mix(1.0, 0.35, glitch);
    obEm += vec3(0.02, 0.05, 0.04);
  #elif OB_EMISSIVE_MODE == 4
    // Hot metal: fissures (low height) glow, the crust stays dark.
    float heat = clamp(obEmissive.w - obOrm.a * 1.5, 0.0, 1.0);
    float shimmer = 0.9 + 0.1 * sin(obT * 3.7 + obDetUv.x * 12.0);
    obEm = obBlackbody(heat) * shimmer * 6.0;
  #elif OB_EMISSIVE_MODE == 5
    // Emergency lamp: rock steady with a slow thermal sag.
    obEm *= 0.9 + 0.1 * sin(obT * 0.7 + obEmissive.z);
  #elif OB_EMISSIVE_MODE == 6
    // Sodium: long warm-up from dull red to full amber.
    float warm = clamp(obT * 0.18, 0.0, 1.0);
    obEm *= mix(vec3(0.35, 0.10, 0.02), vec3(1.0, 0.72, 0.28), warm);
    obEm *= 0.92 + 0.08 * sin(obT * 100.0);
  #endif

  totalEmissiveRadiance *= obEm * obEmissive.x;
}
`;

/* ------------------------------------------------------------- extension */

function ensureUniforms(material: THREE.MeshStandardMaterial): ObUniforms {
  const ud = material.userData as { obUniforms?: ObUniforms };
  if (ud.obUniforms) return ud.obUniforms;
  const u: ObUniforms = {
    obTileScale: { value: 0.5 },
    obTriSharp: { value: 6 },
    obDetailMap: { value: null },
    obDetailScale: { value: 8 },
    // x = normal, y = albedo, z = roughness.
    //
    // y was 0.20 against a detail map packed at +/-0.08, i.e. +/-1.6% peak
    // albedo modulation — 0.03 of a stop, under the quantisation step of the
    // 8-bit target. Every close-range material read as untextured because the
    // only thing the layer actually moved was roughness, and roughness is
    // invisible on a 0.9-rough dielectric lit by a sky.
    obDetailStrength: { value: new THREE.Vector3(0.26, 0.85, 0.74) },
    obDetailFade: { value: new THREE.Vector2(7, 24) },
    obPom: { value: new THREE.Vector3(0.02, 8, 32) },
    obWear: { value: 0 },
    obFilm: { value: 0 },
    obNormalFade: { value: 14 },
    obBlendAlb: { value: null },
    obBlendNrm: { value: null },
    obBlendOrm: { value: null },
    obBlendTile: { value: 0.5 },
    obHueSat: { value: new THREE.Vector2(0, 1) },
    obTime: { value: 0 },
    obEmissive: { value: new THREE.Vector4(1, 1, 0, 1) },
    obMacro: { value: new THREE.Vector4(1 / 7.5, 1 / 23, 0.11, 0.05) },
    obSurf: { value: new THREE.Vector4(0, 0, 0, 0) },
    obGround: { value: new THREE.Vector3(0, 0.9, 0) },
    obCell: { value: new THREE.Vector4(0, 0, 0, 0) },
    obPave: { value: new THREE.Vector4(1.0, 1.0, 0.0, 7.0) },
  };
  ud.obUniforms = u;
  return u;
}

/** Reads back the extension uniforms of an already-extended material. */
export function materialUniforms(material: THREE.Material): ObUniforms | null {
  return (material.userData as { obUniforms?: ObUniforms }).obUniforms ?? null;
}

/**
 * Installs the Blackout shader extension on a standard material.
 * Safe to call once per material; the uniform block is created on first call
 * and reused, so runtime tweaks work whether or not the shader has compiled.
 */
export function extendStandardMaterial(
  material: THREE.MeshStandardMaterial,
  cfg: ShaderExtensionConfig,
): ObUniforms {
  const u = ensureUniforms(material);
  const defines: Record<string, string> = (material.defines as Record<string, string> | undefined) ?? {};

  if (cfg.triplanar) defines.OB_TRIPLANAR = '1'; else delete defines.OB_TRIPLANAR;
  if (cfg.detail && cfg.detailMap) defines.OB_DETAIL = '1'; else delete defines.OB_DETAIL;
  if (cfg.pom) defines.OB_POM = '1'; else delete defines.OB_POM;
  if (cfg.pom && cfg.pomShadow) defines.OB_POM_SHADOW = '1'; else delete defines.OB_POM_SHADOW;
  if (cfg.instanceVariation) defines.OB_INSTANCE_VAR = '1'; else delete defines.OB_INSTANCE_VAR;
  if (cfg.blend) defines.OB_BLEND = '1'; else delete defines.OB_BLEND;
  if (cfg.specularAA !== false) defines.OB_SPEC_AA = '1'; else delete defines.OB_SPEC_AA;
  if (cfg.macro) defines.OB_MACRO = '1'; else delete defines.OB_MACRO;
  if (cfg.cellTone && cfg.triplanar) defines.OB_CELLTONE = '1'; else delete defines.OB_CELLTONE;
  if (cfg.alphaFromMap) defines.OB_ALPHA_FROM_MAP = '1'; else delete defines.OB_ALPHA_FROM_MAP;
  if (cfg.uvVariation && !cfg.triplanar) defines.OB_UV_VARY = '1'; else delete defines.OB_UV_VARY;
  if (cfg.emissiveMode) defines.OB_EMISSIVE_MODE = String(cfg.emissiveMode);
  else delete defines.OB_EMISSIVE_MODE;
  defines.OB_EXTENDED = '1';
  material.defines = defines;

  u.obTileScale.value = 1 / Math.max(cfg.tile, 1e-3);
  u.obTriSharp.value = cfg.triplanarSharpness ?? 6;
  u.obDetailMap.value = cfg.detailMap ?? null;
  u.obDetailScale.value = cfg.detailScale ?? 10;
  if (cfg.detailStrength) u.obDetailStrength.value.copy(cfg.detailStrength);
  if (cfg.detailFade) u.obDetailFade.value.copy(cfg.detailFade);
  u.obPom.value.set(
    (cfg.pomDepth ?? 0.02) / Math.max(cfg.tile, 1e-3),
    cfg.pomMinSteps ?? 8,
    cfg.pomMaxSteps ?? 28,
  );
  u.obWear.value = cfg.wear ?? 0;
  u.obFilm.value = cfg.film ?? 0;
  u.obNormalFade.value = cfg.normalFadeDistance ?? 14;
  if (cfg.macro) u.obMacro.value.copy(cfg.macro);
  if (cfg.surface) u.obSurf.value.copy(cfg.surface);
  else u.obSurf.value.set(0, 0, 0, 0);
  if (cfg.cellTone) u.obCell.value.copy(cfg.cellTone);
  else u.obCell.value.set(0, 0, 0, 0);
  if (cfg.paving) u.obPave.value.copy(cfg.paving);
  else u.obPave.value.set(Math.max(cfg.tile, 0.05), Math.max(cfg.tile, 0.05), 0, 7);
  if (cfg.ground) u.obGround.value.copy(cfg.ground);
  else u.obGround.value.set(0, 0.9, 0);
  if (cfg.blend) {
    u.obBlendAlb.value = cfg.blend.albedo;
    u.obBlendNrm.value = cfg.blend.normal;
    u.obBlendOrm.value = cfg.blend.orm;
    u.obBlendTile.value = 1 / Math.max(cfg.blendTile ?? cfg.blend.tile, 1e-3);
  }

  material.onBeforeCompile = (shader) => {
    for (const k of Object.keys(u)) shader.uniforms[k] = u[k];

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);

    let f = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n${FRAG_PROLOGUE}`)
      .replace('#include <map_fragment>', /* glsl */ `
        diffuseColor.rgb *= obAlb.rgb;
        #ifdef OB_ALPHA_FROM_MAP
          diffuseColor.a *= obAlb.a;
        #endif
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * obOrm.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * obOrm.b;')
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        normal = obNrmV;
        #ifdef OB_SPEC_AA
          {
            // Kaplanyan-style normal-variance filtering. The cap has to be
            // generous: at 15-30 m a cobble or brick normal map swings a full
            // hemisphere inside one pixel, and anything left unfiltered turns
            // into the sparkle that chromatic aberration then paints magenta.
            vec3 dnx = dFdx(normal);
            vec3 dny = dFdy(normal);
            float variance = 0.5 * (dot(dnx, dnx) + dot(dny, dny));
            float kernel = min(variance * 2.6, 0.42);
            roughnessFactor = sqrt(clamp(roughnessFactor * roughnessFactor + kernel, 0.0, 1.0));
          }
        #endif
      `)
      // Mirrors three's own chunk exactly — including leaving ambientOcclusion
      // at function scope, because the renderer's G-buffer patch reads it.
      .replace('#include <aomap_fragment>', /* glsl */ `
        #ifdef USE_AOMAP
          float ambientOcclusion = (obOrm.r - 1.0) * aoMapIntensity + 1.0;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float obDotNV = saturate(dot(geometryNormal, geometryViewDir));
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(obDotNV, ambientOcclusion, material.roughness);
          #endif
        #endif
      `);

    if (cfg.pom && cfg.pomShadow) {
      f = f.replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n reflectedLight.directDiffuse *= obPomShade;\n reflectedLight.directSpecular *= obPomShade;',
      );
    }

    if (cfg.blend) {
      // vColor is the blend mask, not a tint.
      f = f.replace('#include <color_fragment>', '');
    }

    if (cfg.emissiveMode) {
      f = f.replace('#include <emissivemap_fragment>', EMISSIVE_GLSL);
    }

    shader.fragmentShader = f;
  };

  material.customProgramCacheKey = () => `ob|${Object.keys(defines).sort().join(',')}`;
  material.needsUpdate = true;
  return u;
}

/**
 * Writes the per-instance variation attribute used by 'OB_INSTANCE_VAR'.
 * xyz = hue / brightness / wear offsets in [-1,1], w = UV offset.
 */
export function applyInstanceVariation(
  geometry: THREE.InstancedBufferGeometry | THREE.BufferGeometry,
  count: number,
  next: () => number,
  spread = 1,
): THREE.InstancedBufferAttribute {
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4 + 0] = (next() * 2 - 1) * spread;
    data[i * 4 + 1] = (next() * 2 - 1) * spread;
    data[i * 4 + 2] = next() * spread;
    data[i * 4 + 3] = next() * 4;
  }
  const attr = new THREE.InstancedBufferAttribute(data, 4);
  geometry.setAttribute('obVar', attr);
  return attr;
}

/**
 * Fills a geometry's colour attribute with a blend weight so
 * 'OB_BLEND' materials transition between their two layers.
 */
export function setBlendWeights(
  geometry: THREE.BufferGeometry,
  weight: (x: number, y: number, z: number) => number,
): void {
  const pos = geometry.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const w = THREE.MathUtils.clamp(weight(pos.getX(i), pos.getY(i), pos.getZ(i)), 0, 1);
    arr[i * 3] = w; arr[i * 3 + 1] = w; arr[i * 3 + 2] = w;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}
