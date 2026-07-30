/**
 * Procedural noise primitives, as GLSL ES 3.00 source.
 *
 * Everything here is *tiling safe*: every generator takes an integer `period`
 * (in lattice cells) and hashes lattice coordinates modulo that period, so a
 * texture rendered over uv ∈ [0,1] with `p = uv * period` repeats seamlessly.
 * fBm variants double the period alongside the frequency, which keeps the
 * whole octave stack periodic.
 *
 * Naming: everything is prefixed `ob` (Operation Blackout) so injection into
 * three's shader chunks can never collide with engine symbols.
 */

export const NOISE_GLSL = /* glsl */ `
#ifndef OB_NOISE_INCLUDED
#define OB_NOISE_INCLUDED

#define OB_TAU 6.283185307179586
#define OB_PI  3.141592653589793

/* ------------------------------------------------------------------ hashes */
/* Dave Hoskins' hash family — cheap, no visible lattice structure. */

float obHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float obHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float obHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 obHash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 obHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 obHash23(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 obHash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

vec3 obHash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/* ------------------------------------------------------------- value noise */

/** Periodic 2D value noise in [0,1]. 'period' is in lattice cells. */
float obValueP(vec2 p, vec2 period, float seed) {
  vec2 pp = max(period, vec2(1.0));
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = obHash13(vec3(mod(i, pp), seed));
  float b = obHash13(vec3(mod(i + vec2(1.0, 0.0), pp), seed));
  float c = obHash13(vec3(mod(i + vec2(0.0, 1.0), pp), seed));
  float d = obHash13(vec3(mod(i + vec2(1.0, 1.0), pp), seed));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/* ----------------------------------------------------------- gradient/perlin */

vec2 obGradP(vec2 i, vec2 pp, float seed) {
  float a = obHash13(vec3(mod(i, pp), seed)) * OB_TAU;
  return vec2(cos(a), sin(a));
}

/** Periodic 2D Perlin gradient noise, roughly [-1,1]. */
float obPerlinP(vec2 p, vec2 period, float seed) {
  vec2 pp = max(period, vec2(1.0));
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(obGradP(i, pp, seed), f);
  float b = dot(obGradP(i + vec2(1.0, 0.0), pp, seed), f - vec2(1.0, 0.0));
  float c = dot(obGradP(i + vec2(0.0, 1.0), pp, seed), f - vec2(0.0, 1.0));
  float d = dot(obGradP(i + vec2(1.0, 1.0), pp, seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142135;
}

/* ------------------------------------------------------------------ simplex */
/* Non-periodic. Use for effects where seamlessness is irrelevant (screen-space
   dithering, view-dependent breakup) or where the domain is already wrapped. */

float obSimplex2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  vec3 p = vec3(obHash12(i), obHash12(i + i1), obHash12(i + vec2(1.0)));
  vec3 ang = p * OB_TAU;
  vec2 g0 = vec2(cos(ang.x), sin(ang.x));
  vec2 g1 = vec2(cos(ang.y), sin(ang.y));
  vec2 g2 = vec2(cos(ang.z), sin(ang.z));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 px = vec3(dot(g0, x0), dot(g1, x12.xy), dot(g2, x12.zw));
  return 70.0 * dot(m, px);
}

vec4 obPermute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 obTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

/** Classic Ashima simplex noise, [-1,1]. */
float obSimplex3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = obPermute(obPermute(obPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = obTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/* -------------------------------------------------------- worley / voronoi */

/**
 * Periodic Worley noise.
 * Returns (F1, F2, cellId) where cellId ∈ [0,1) is a stable per-cell random.
 * 'jitter' 0 = regular grid, 1 = fully scattered points.
 */
vec3 obWorleyP(vec2 p, vec2 period, float jitter, float seed) {
  vec2 pp = max(period, vec2(1.0));
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 16.0, f2 = 16.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, pp);
      vec2 o = obHash23(vec3(cell, seed));
      vec2 r = g + vec2(0.5) + (o - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1; f1 = d;
        id = obHash13(vec3(cell, seed + 91.7));
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

/**
 * Periodic Voronoi returning distance to the *cell border* (not the point),
 * which is what you want for cracks, cobbles and shattered glass.
 * Returns (borderDistance, cellId, F1).
 */
vec3 obVoronoiEdgeP(vec2 p, vec2 period, float jitter, float seed) {
  vec2 pp = max(period, vec2(1.0));
  vec2 i = floor(p);
  vec2 f = p - i;

  vec2 mr = vec2(0.0), mg = vec2(0.0);
  float md = 16.0, mid = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, pp);
      vec2 o = obHash23(vec3(cell, seed));
      vec2 r = g + vec2(0.5) + (o - 0.5) * jitter - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; mid = obHash13(vec3(cell, seed + 91.7)); }
    }
  }

  float border = 16.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 g = mg + vec2(float(x), float(y));
      vec2 cell = mod(i + g, pp);
      vec2 o = obHash23(vec3(cell, seed));
      vec2 r = g + vec2(0.5) + (o - 0.5) * jitter - f;
      vec2 diff = r - mr;
      if (dot(diff, diff) > 1e-5) {
        border = min(border, dot(0.5 * (mr + r), normalize(diff)));
      }
    }
  }
  return vec3(border, mid, sqrt(md));
}

/* ---------------------------------------------------------------- fractals */

/** Periodic fBm of Perlin noise, [0,1]. Lacunarity is fixed at 2 so it tiles. */
float obFbm(vec2 p, vec2 period, int octaves, float gain, float seed) {
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = period;
  for (int o = 0; o < 10; o++) {
    if (o >= octaves) break;
    sum += amp * obPerlinP(q, pr, seed + float(o) * 17.13);
    norm += amp;
    amp *= gain;
    q *= 2.0;
    pr *= 2.0;
  }
  return sum / max(norm, 1e-5) * 0.5 + 0.5;
}

/** Periodic ridged multifractal, [0,1]. Great for cracks, rock, rust fronts. */
float obRidged(vec2 p, vec2 period, int octaves, float gain, float seed) {
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = period;
  for (int o = 0; o < 10; o++) {
    if (o >= octaves) break;
    float n = 1.0 - abs(obPerlinP(q, pr, seed + float(o) * 23.71));
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= gain;
    q *= 2.0;
    pr *= 2.0;
  }
  return sum / max(norm, 1e-5);
}

/** Periodic billowy fBm — puffy, good for clouds of rust and moss. */
float obBillow(vec2 p, vec2 period, int octaves, float gain, float seed) {
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = period;
  for (int o = 0; o < 10; o++) {
    if (o >= octaves) break;
    sum += amp * abs(obPerlinP(q, pr, seed + float(o) * 11.37));
    norm += amp;
    amp *= gain;
    q *= 2.0;
    pr *= 2.0;
  }
  return sum / max(norm, 1e-5);
}

/** Periodic fBm of Worley F1 — cellular clumping (aggregate, gravel, foam). */
float obWorleyFbm(vec2 p, vec2 period, int octaves, float jitter, float seed) {
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = period;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    sum += amp * obWorleyP(q, pr, jitter, seed + float(o) * 5.91).x;
    norm += amp;
    amp *= 0.5;
    q *= 2.0;
    pr *= 2.0;
  }
  return sum / max(norm, 1e-5);
}

/* -------------------------------------------------------------- warping */

/**
 * Periodic domain warp. Because the offset field is itself periodic with the
 * same period, warping preserves tileability exactly.
 */
vec2 obWarp(vec2 p, vec2 period, float amount, float seed) {
  float wx = obFbm(p, period, 4, 0.5, seed) * 2.0 - 1.0;
  float wy = obFbm(p + vec2(5.2, 1.3), period, 4, 0.5, seed + 41.0) * 2.0 - 1.0;
  return p + vec2(wx, wy) * amount;
}

/** Two-level warp (Inigo Quilez style) for fluid, organic staining. */
vec2 obWarp2(vec2 p, vec2 period, float amount, float seed) {
  vec2 q = obWarp(p, period, amount, seed);
  return obWarp(q, period, amount * 0.5, seed + 137.0);
}

/** Divergence-free 2D curl of a periodic potential — smoke, streaks, flow. */
vec2 obCurl(vec2 p, vec2 period, float seed) {
  const float e = 0.02;
  float n1 = obFbm(p + vec2(0.0, e), period, 4, 0.5, seed);
  float n2 = obFbm(p - vec2(0.0, e), period, 4, 0.5, seed);
  float n3 = obFbm(p + vec2(e, 0.0), period, 4, 0.5, seed);
  float n4 = obFbm(p - vec2(e, 0.0), period, 4, 0.5, seed);
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

/* ---------------------------------------------------------------- helpers */

float obRemap(float v, float a, float b) { return clamp((v - a) / max(b - a, 1e-5), 0.0, 1.0); }
float obSat(float v) { return clamp(v, 0.0, 1.0); }
vec3  obSat3(vec3 v) { return clamp(v, 0.0, 1.0); }

/** Smooth, energy-preserving-ish min used for merging height fields. */
float obSmin(float a, float b, float k) {
  float h = obSat(0.5 + 0.5 * (b - a) / k);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float obSmax(float a, float b, float k) { return -obSmin(-a, -b, k); }

/** sRGB helpers — recipes author colours in sRGB and emit linear. */
vec3 obSrgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));
}
vec3 obLinearToSrgb(vec3 c) {
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, step(c, vec3(0.0031308)));
}

/** 8-bit sRGB colour literal → linear working space. */
vec3 obRGB(float r, float g, float b) {
  return obSrgbToLinear(vec3(r, g, b) / 255.0);
}
/* GLSL ES 3.00 has no implicit int→float promotion, so recipes that write
   obRGB(148, 152, 158) need this overload to stay readable. */
vec3 obRGB(int r, int g, int b) {
  return obRGB(float(r), float(g), float(b));
}

/** Perceptual hue rotation on a linear colour. */
vec3 obHueShift(vec3 c, float shift) {
  const vec3 k = vec3(0.57735);
  float ca = cos(shift * OB_TAU);
  return c * ca + cross(k, c) * sin(shift * OB_TAU) + k * dot(k, c) * (1.0 - ca);
}

float obLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

#endif
`;
