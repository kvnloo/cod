/**
 * Height-field filters used by the "derive" pass: normal-from-height (Sobel at
 * two scales), AO-from-height (horizon-based cone tracing), curvature and
 * cavity.
 *
 * These operate on the half-float height buffer produced by the recipe's
 * height pass, with Repeat wrapping so every result is seamless.
 */

export const FILTERS_GLSL = /* glsl */ `
#ifndef OB_FILTERS_INCLUDED
#define OB_FILTERS_INCLUDED

uniform sampler2D obHeightTex;
uniform float obTexel;          // 1 / resolution
uniform float obNormalStrength; // slope gain (height metres / tile metres)
uniform float obNormalWide;     // weight of the wide-radius gradient
uniform float obAoRadius;       // in uv units
uniform float obAoStrength;
uniform float obHeightAspect;   // height range / tile size, in uv units
uniform float obCurvScale;
uniform int   obAoDirs;
uniform int   obAoSteps;

float obH(vec2 uv) { return texture(obHeightTex, uv).r; }

/** Sobel normal at radius r texels. Returns (dH/du, dH/dv). */
vec2 obSobel(vec2 uv, float r) {
  float t = obTexel * r;
  float tl = obH(uv + vec2(-t,  t));
  float tc = obH(uv + vec2( 0.0, t));
  float tr = obH(uv + vec2( t,  t));
  float ml = obH(uv + vec2(-t,  0.0));
  float mr = obH(uv + vec2( t,  0.0));
  float bl = obH(uv + vec2(-t, -t));
  float bc = obH(uv + vec2( 0.0,-t));
  float br = obH(uv + vec2( t, -t));
  float dX = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float dY = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  return vec2(dX, dY) / (8.0 * t);
}

/** Tangent-space normal, +Y up (OpenGL convention). */
vec3 obNormalFromHeight(vec2 uv) {
  vec2 gFine = obSobel(uv, 1.0);
  vec2 gWide = obSobel(uv, 3.0);
  vec2 g = gFine + gWide * obNormalWide;
  g *= obNormalStrength;
  return normalize(vec3(-g.x, -g.y, 1.0));
}

/**
 * Horizon-based ambient occlusion traced through the height field.
 * Samples are quadratically distributed so near-field contact darkening — the
 * thing that sells crevices — is resolved properly.
 */
float obAoFromHeight(vec2 uv) {
  float h0 = obH(uv);
  float dirs = float(max(obAoDirs, 1));
  float steps = float(max(obAoSteps, 1));
  float vis = 0.0;
  float jitter = obHash12(uv * 4096.0) * 0.5;
  for (int d = 0; d < 16; d++) {
    if (d >= obAoDirs) break;
    float a = (float(d) + 0.5 + jitter) / dirs * OB_TAU;
    vec2 dir = vec2(cos(a), sin(a));
    float maxTan = 0.0;
    for (int s = 1; s <= 16; s++) {
      if (s > obAoSteps) break;
      float k = float(s) / steps;
      float rr = k * k * obAoRadius;
      float hs = obH(uv + dir * rr);
      maxTan = max(maxTan, (hs - h0) * obHeightAspect / max(rr, 1e-5));
    }
    vis += 1.0 - maxTan * inversesqrt(1.0 + maxTan * maxTan);
  }
  vis /= dirs;
  return mix(1.0, obSat(vis), obAoStrength);
}

/**
 * Curvature via a two-scale Laplacian.
 * +1 = convex ridge/edge (paint rubs off here), −1 = concave crevice (dirt,
 * moss and rust collect here).
 */
float obCurvature(vec2 uv) {
  float h0 = obH(uv);
  float t1 = obTexel * 1.5;
  float t2 = obTexel * 5.0;
  float l1 = obH(uv + vec2(t1, 0.0)) + obH(uv - vec2(t1, 0.0))
           + obH(uv + vec2(0.0, t1)) + obH(uv - vec2(0.0, t1)) - 4.0 * h0;
  float l2 = obH(uv + vec2(t2, 0.0)) + obH(uv - vec2(t2, 0.0))
           + obH(uv + vec2(0.0, t2)) + obH(uv - vec2(0.0, t2)) - 4.0 * h0;
  float curv = -(l1 * 0.65 / (t1 * t1) + l2 * 0.35 / (t2 * t2)) * obCurvScale * 1e-4;
  return clamp(curv, -1.0, 1.0);
}

/** How far below the local (wide) average this texel sits: dirt accumulation. */
float obCavity(vec2 uv, float radius) {
  float h0 = obH(uv);
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = (float(i) + 0.5) / 8.0 * OB_TAU;
    acc += obH(uv + vec2(cos(a), sin(a)) * radius);
  }
  acc /= 8.0;
  return clamp((acc - h0) * 3.0, 0.0, 1.0);
}

/** Wide blur of the height field — large-scale form, used for tonal variation. */
float obHeightBlur(vec2 uv, float radius) {
  float acc = obH(uv) * 0.28;
  float w = 0.28;
  for (int i = 0; i < 8; i++) {
    float a = (float(i) + 0.5) / 8.0 * OB_TAU;
    acc += obH(uv + vec2(cos(a), sin(a)) * radius) * 0.09;
    acc += obH(uv + vec2(cos(a + 0.4), sin(a + 0.4)) * radius * 0.5) * 0.09;
    w += 0.18;
  }
  return acc / w;
}

#endif
`;
