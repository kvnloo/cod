/**
 * Shared GLSL ES 3.00 chunks for the post-processing library.
 *
 * Every pass is a `THREE.ShaderMaterial` with `glslVersion: THREE.GLSL3`, so
 * three injects `precision`, the standard matrix uniforms and the default vertex
 * attributes for us; fragment outputs must be declared explicitly.
 *
 * The full-screen vertex shader derives its UV from `position` rather than the
 * `uv` attribute so it works with either a full-screen triangle
 * (-1,-1)/(3,-1)/(-1,3) or a 2x2 quad — we do not own the frame graph's blit
 * geometry.
 */

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Maths, colour spaces, depth reconstruction, hashes. Prepended to every pass. */
export const COMMON = /* glsl */ `
#define BLK_PI 3.141592653589793
#define BLK_TAU 6.283185307179586
#define BLK_HALF_PI 1.5707963267948966
#define BLK_GOLDEN 0.6180339887498949
#define BLK_EPS 1e-6

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2  sat(vec2 x)  { return clamp(x, vec2(0.0), vec2(1.0)); }
vec3  sat(vec3 x)  { return clamp(x, vec3(0.0), vec3(1.0)); }

float maxc(vec3 c) { return max(c.x, max(c.y, c.z)); }
float minc(vec3 c) { return min(c.x, min(c.y, c.z)); }
float luma(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }
/* Fast perceptual weight used for firefly suppression (Karis). */
float karisWeight(vec3 c) { return 1.0 / (1.0 + luma(c)); }

/* --- YCoCg: the colour space TAA neighbourhood clamping wants ------------- */
vec3 rgbToYCoCg(vec3 c) {
  float co = c.r - c.b;
  float t  = c.b + co * 0.5;
  float cg = c.g - t;
  return vec3(t + cg * 0.5, co, cg);
}
vec3 yCoCgToRgb(vec3 c) {
  float t = c.x - c.z * 0.5;
  float g = c.z + t;
  float b = t - c.y * 0.5;
  return vec3(b + c.y, g, b);
}

/* --- tone-mapped weighting for temporal blending (Karis / Brian Karis) ---- */
vec3 tonemapForResolve(vec3 c)   { return c / (1.0 + maxc(max(c, vec3(0.0)))); }
vec3 untonemapForResolve(vec3 c) { return c / max(1.0 - maxc(max(c, vec3(0.0))), 1e-4); }

/* --- depth ---------------------------------------------------------------- */
/** Hardware depth [0,1] -> positive view-space distance along -Z. */
float linearizeDepth(float d, float n, float f) {
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}
/** Positive view depth -> hardware depth [0,1]. */
float delinearizeDepth(float vz, float n, float f) {
  float z = (f + n - (2.0 * n * f) / max(vz, 1e-5)) / (f - n);
  return z * 0.5 + 0.5;
}
/** Exact view-space position from UV + hardware depth. */
vec3 viewPosition(vec2 uv, float depth, mat4 invProj) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 p = invProj * ndc;
  return p.xyz / p.w;
}

/* --- noise ---------------------------------------------------------------- */
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float hash12(vec2 p) {
  vec3 p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
/** Jimenez interleaved-gradient noise — free, and remarkably blue for 1 sample. */
float interleavedGradient(vec2 pixel, float frame) {
  pixel += frame * vec2(5.588238, 5.588238);
  return fract(52.9829189 * fract(0.06711056 * pixel.x + 0.00583715 * pixel.y));
}
/** Value noise in 3D, used for fog wisps and lens dirt. */
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i + vec3(0, 0, 0)).x;
  float n100 = hash33(i + vec3(1, 0, 0)).x;
  float n010 = hash33(i + vec3(0, 1, 0)).x;
  float n110 = hash33(i + vec3(1, 1, 0)).x;
  float n001 = hash33(i + vec3(0, 0, 1)).x;
  float n101 = hash33(i + vec3(1, 0, 1)).x;
  float n011 = hash33(i + vec3(0, 1, 1)).x;
  float n111 = hash33(i + vec3(1, 1, 1)).x;
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p, int octaves) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * valueNoise3(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

/* --- misc ----------------------------------------------------------------- */
float linstep(float a, float b, float x) { return sat((x - a) / max(b - a, 1e-6)); }
vec2 rotate2(vec2 v, float a) { float s = sin(a), c = cos(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
/** Schlick with a scalar F0. */
float fresnelSchlick(float f0, float cosTheta) {
  float m = clamp(1.0 - cosTheta, 0.0, 1.0);
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}
`;

/**
 * Blue-noise sampling helpers. Requires `uniform sampler2D tBlueNoise;` and
 * `uniform float uFrame;` in the material. The mask is 64x64 RGBA where each
 * channel is a decorrelated void-and-cluster pattern.
 */
export const BLUE_NOISE = /* glsl */ `
uniform sampler2D tBlueNoise;

vec4 blueNoise4(vec2 pixel) {
  ivec2 c = ivec2(mod(pixel, 64.0));
  return texelFetch(tBlueNoise, c, 0);
}
/** Blue noise animated with the golden ratio: stays blue over time. */
vec4 blueNoise4T(vec2 pixel, float frame) {
  return fract(blueNoise4(pixel) + frame * BLK_GOLDEN);
}
float blueNoise1T(vec2 pixel, float frame) {
  return fract(blueNoise4(pixel).x + frame * BLK_GOLDEN);
}
`;

/**
 * Resolves the same exposure curve the tonemap pass applies, from the 1x1
 * adaptation texture. Lets pre-tonemap passes (bloom, lens) threshold in exposed
 * units without duplicating the auto-exposure logic.
 */
export const AUTO_EXPOSURE = /* glsl */ `
uniform sampler2D tAdapt;
uniform float uAdaptEnabled;
uniform float uExposureBase;
uniform float uKey;
uniform float uMinExposure;
uniform float uMaxExposure;

float resolveExposure() {
  if (uAdaptEnabled < 0.5) return uExposureBase;
  float avg = exp2(texture(tAdapt, vec2(0.5)).r);
  return uExposureBase * clamp(uKey / max(avg, 1e-4), uMinExposure, uMaxExposure);
}
`;

/** Cheap sky/IBL fallback used when a real environment cubemap is unavailable. */
export const SKY_FALLBACK = /* glsl */ `
vec3 skyFallback(vec3 dir, vec3 zenith, vec3 horizon, vec3 ground) {
  float t = dir.y;
  vec3 up = mix(horizon, zenith, sat(pow(sat(t), 0.55)));
  vec3 dn = mix(horizon, ground, sat(pow(sat(-t), 0.5)));
  return t > 0.0 ? up : dn;
}
`;
