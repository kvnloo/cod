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
import { skipPatch, skyField } from '../MaterialPatch';
import { SHADOW_VISIBLE } from '../SceneIndex';
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
uniform float uHorizonBias;
uniform float uNearRadius;       // contact-scale search radius, metres
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

  // --- near field -----------------------------------------------------------
  //
  // The broad term above is deliberately weak: it was a black veil and the fix
  // was to stop it darkening whole panels. What it cannot then do is *ground*
  // anything — at 0.74 m the horizon search averages the metre of floor around
  // an object together with the object, so a 12 m tram and a lamp column both
  // sit on the plaza with no darkening where they meet it. That is VISUAL-BAR
  // tell #2, and it is a separate measurement from the broad one, so it gets a
  // separate integral: the same horizon walk over a contact-scale radius,
  // carried through the chain in the *length* of the bent normal and applied
  // with its own response and its own floor.
  //
  // It fades out rather than clamping up once its footprint drops below ~2
  // texels. Clamping would silently widen the world radius at distance and turn
  // the contact term into a second broad term — exactly the veil this whole
  // package exists to keep out.
  float nearPix = uNearRadius * uPixelsPerMeter / z;
  float nearFade = sat((nearPix - 1.4) / 1.6);
  float nearScreenRadius = clamp(nearPix, 1.4, 64.0);
  float nearRange = 0.615 * uNearRadius;
  float nearMul = -1.0 / nearRange;
  float nearAdd = (uNearRadius - nearRange) / nearRange + 1.0;

  vec4 noise = blueNoise4T(gl_FragCoord.xy, uFrame);
  float sliceNoise = noise.x;
  float stepNoise = noise.y;
  float nearNoise = noise.z;

  float visibility = 0.0;
  float nearVisibility = 0.0;
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

      // Angle bias. The horizon is accumulated with max(), which turns *any*
      // symmetric depth noise into a one-sided lift — the flatter and more
      // grazing the surface, the bigger the spurious occlusion. Nudging each
      // candidate horizon back by a fixed cosine costs a sliver of true contact
      // darkening and removes the veil over every large flat panel.
      float shc0 = dot(d0 / len0, viewVec) - uHorizonBias;
      float shc1 = dot(d1 / len1, viewVec) - uHorizonBias;
      shc0 = mix(horizonCos0, shc0, w0);
      shc1 = mix(horizonCos1, shc1, w1);

      horizonCos0 = max(horizonCos0, shc0);
      horizonCos1 = max(horizonCos1, shc1);
    }

    // Contact-scale horizon walk. Same geometry, same slice, a radius small
    // enough that only something actually touching this surface can enter it.
    float nearCos0 = -1.0;
    float nearCos1 = -1.0;
    if (nearFade > 0.0) {
      for (int st = 0; st < AO_NEAR_STEPS; st++) {
        float s = (float(st) + nearNoise) / float(AO_NEAR_STEPS);
        float offsetLen = max(1.0, floor(s * nearScreenRadius + 0.5));
        vec2 off = omega * offsetLen * uTexel;

        vec2 uv0 = vUv + off;
        vec2 uv1 = vUv - off;
        vec3 d0 = viewFromLinear(uv0, texture(tDepth, uv0).r) - viewPos;
        vec3 d1 = viewFromLinear(uv1, texture(tDepth, uv1).r) - viewPos;
        float len0 = max(length(d0), 1e-5);
        float len1 = max(length(d1), 1e-5);

        float fb0 = length(vec3(d0.xy, d0.z * (1.0 + uThickness)));
        float fb1 = length(vec3(d1.xy, d1.z * (1.0 + uThickness)));
        float w0 = sat(fb0 * nearMul + nearAdd);
        float w1 = sat(fb1 * nearMul + nearAdd);

        float shc0 = dot(d0 / len0, viewVec) - uHorizonBias;
        float shc1 = dot(d1 / len1, viewVec) - uHorizonBias;
        nearCos0 = max(nearCos0, mix(nearCos0, shc0, w0));
        nearCos1 = max(nearCos1, mix(nearCos1, shc1, w1));
      }
    }

    float h0 = -acos(clamp(horizonCos1, -1.0, 1.0));
    float h1 = acos(clamp(horizonCos0, -1.0, 1.0));
    h0 = nAngle + clamp(h0 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);
    h1 = nAngle + clamp(h1 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);

    float sinN = sin(nAngle);
    float iarc0 = (cosNorm + 2.0 * h0 * sinN - cos(2.0 * h0 - nAngle)) * 0.25;
    float iarc1 = (cosNorm + 2.0 * h1 * sinN - cos(2.0 * h1 - nAngle)) * 0.25;
    visibility += projectedNormalVecLength * (iarc0 + iarc1);

    float n0 = -acos(clamp(nearCos1, -1.0, 1.0));
    float n1 = acos(clamp(nearCos0, -1.0, 1.0));
    n0 = nAngle + clamp(n0 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);
    n1 = nAngle + clamp(n1 - nAngle, -BLK_HALF_PI, BLK_HALF_PI);
    float narc0 = (cosNorm + 2.0 * n0 * sinN - cos(2.0 * n0 - nAngle)) * 0.25;
    float narc1 = (cosNorm + 2.0 * n1 * sinN - cos(2.0 * n1 - nAngle)) * 0.25;
    nearVisibility += projectedNormalVecLength * (narc0 + narc1);

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
  nearVisibility = mix(1.0, sat(nearVisibility / float(AO_SLICES)), nearFade);
  bentNormal = normalize(bentNormal + n * 1e-4);
  // The bent normal is a unit vector, so its *length* is a free channel: the
  // contact term rides in it all the way through denoise, temporal and the
  // bilateral upsample without a second attachment, and SsrPass — the only
  // other consumer of this texture — reads .a and nothing else.
  fragColor = vec4(bentNormal * nearVisibility, visibility);
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
  // The contact term rides in |xyz|, so it needs the same neighbourhood clamp as
  // .a or a moving occluder drags a dark smear behind its own contact ring.
  float curNear = length(current.xyz);
  float lo = current.a, hi = current.a;
  float nlo = curNear, nhi = curNear;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 ? 1.0 : (i == 1 ? -1.0 : 0.0), i == 2 ? 1.0 : (i == 3 ? -1.0 : 0.0));
    vec4 s = texture(tAo, vUv + o * uTexel);
    lo = min(lo, s.a); hi = max(hi, s.a);
    float sn = length(s.xyz);
    nlo = min(nlo, sn); nhi = max(nhi, sn);
  }
  float span = max(hi - lo, 0.02) * 1.6;
  float clamped = clamp(history.a, lo - span, hi + span);
  reject = max(reject, sat(abs(clamped - history.a) * 4.0));

  float feedback = mix(0.93, 0.0, reject);
  // Direction and magnitude are accumulated separately: normalising the mix
  // (as this used to) throws the contact term away entirely.
  float histNear = length(history.xyz);
  float nspan = max(nhi - nlo, 0.02) * 1.6;
  float nearOut = mix(curNear, clamp(histNear, nlo - nspan, nhi + nspan), feedback);
  vec3 dir = normalize(mix(current.xyz, history.xyz, feedback) + vec3(1e-5));
  fragColor = vec4(dir * clamp(nearOut, 0.0, 1.0), mix(current.a, clamped, feedback));
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
uniform float uNearPower;
uniform float uNearFloor;
uniform float uDirectPreserve;
uniform float uAoFloor;
uniform float uUpsampleSharpness;
uniform float uDebug;
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
  //
  // The weight used to be 1/(1e-3 + |zs-z|/max(z,0.1)) — unbounded as the depths
  // converge. A tap matching to within a micron outvotes its three neighbours by
  // ~1000:1, so along a silhouette the winning tap alternates from pixel to
  // pixel and the edge comes back as a 1-px checkerboard that TAA then smears
  // into a crawling fringe. A Gaussian in relative depth is bounded above by 1
  // and never reaches zero, so all four taps always contribute something and the
  // result varies smoothly across the edge. Clamping to the local tap range on
  // top of that keeps a bilateral overshoot from inventing values the AO buffer
  // never contained.
  vec4 ao4 = vec4(0.0);
  float wsum = 0.0;
  float alo = 1.0, ahi = 0.0;
  float nlo = 1.0, nhi = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5);
    vec2 uv = vUv + o * uAoTexel;
    float zs = texture(tAoDepth, uv).r;
    float w = exp(-uUpsampleSharpness * abs(zs - z) / max(z, 0.1)) + 1e-3;
    vec4 s = texture(tAo, uv);
    alo = min(alo, s.a); ahi = max(ahi, s.a);
    float sn = length(s.xyz);
    nlo = min(nlo, sn); nhi = max(nhi, sn);
    ao4 += s * w;
    wsum += w;
  }
  vec4 g = ao4 / max(wsum, 1e-4);
  g.a = clamp(g.a, alo, ahi);
  // Same overshoot guard on the contact channel, applied to the vector's length
  // so the bent-normal direction it carries is untouched.
  float gnear = length(g.xyz);
  g.xyz *= clamp(gnear, nlo, nhi) / max(gnear, 1e-4);
#else
  vec4 g = texture(tAo, vUv);
#endif

  vec4 nr = texture(tNormal, vUv);
  vec4 mat = texture(tMaterial, vUv);
  float metal = mat.r;
  float bakedAo = mat.g;
  float emissive = mat.a;
  float rough = clamp(nr.w, 0.02, 1.0);

  // Visibility -> occlusion. uIntensityPower was 1.0 + 1.9*ssaoIntensity = 2.9
  // at ultra, which turns a perfectly ordinary visibility of 0.55 into 0.19 and
  // took an unoccluded shop sign to 11/255 (121/255 with the pass off) — a black
  // veil, not ambient occlusion. AO is also a *bounded* term: no real surface
  // loses all of its ambient light to a sub-metre crease, so the result is
  // floored rather than allowed to reach zero.
  float ao = sat(pow(sat(g.a), uIntensityPower));
  ao = mix(uAoFloor, 1.0, ao);

  // Near-field contact darkening, decoded from the bent normal's length.
  //
  // Combined with a min, not a product: the occluder that grounds an object is
  // inside both searches, so multiplying would count it twice. The broad term
  // stays exactly as the wave-7A critics certified it on open surfaces (where
  // the contact term is 1 by construction — nothing is within 22 cm of an
  // unoccluded panel), and the contact term is free to go deeper than the broad
  // floor allows right where two surfaces meet.
  float nearVis = clamp(length(g.xyz), 0.0, 1.0);
  vec3 bentDir = g.xyz / max(nearVis, 1e-4);
  float aoNear = mix(uNearFloor, 1.0, sat(pow(nearVis, uNearPower)));
  ao = min(ao, aoNear);
  ao = min(ao, bakedAo > 0.0 ? bakedAo : 1.0);

  // Diagnostic channels; ship at 0. There was previously no way to tell a
  // genuinely occluded pixel from an integrator artefact without rebuilding.
  //   1 raw visibility  2 floored occlusion  3 baked AO  4 metalness
  //   5 raw contact visibility  6 floored contact occlusion
  if (uDebug > 0.5) {
    float d = uDebug < 1.5 ? sat(g.a) : (uDebug < 2.5 ? ao : (uDebug < 3.5 ? bakedAo
            : (uDebug < 4.5 ? metal : (uDebug < 5.5 ? nearVis : aoNear))));
    fragColor = vec4(vec3(d), color.a);
    return;
  }

  // Hue-preserving pseudo-albedo: the shaded buffer is all we have here, and the
  // multi-bounce curve only needs the chromaticity to be roughly right.
  // 0.42 is brighter than almost any real surface; the multi-bounce curve then
  // gives back so much energy that the occlusion barely survives it.
  vec3 albedo = sat(color.rgb / (maxc(color.rgb) + 1e-4)) * 0.28;
  vec3 diffuseOcc = multiBounce(ao, albedo);

  vec3 nView = normalize(nr.xyz + vec3(1e-6));
  vec3 vView = vec3(0.0, 0.0, 1.0);
  float nov = sat(dot(nView, vView));
  vec3 bent = normalize(bentDir + vec3(1e-6));
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

interface QualityTier { slices: number; steps: number; half: boolean; nearSteps: number; }

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
  if (quality <= 0.55) return { slices: 2, steps: 3, half: true, nearSteps: 2 };
  if (quality <= 0.75) return { slices: 3, steps: 4, half: true, nearSteps: 3 };
  if (quality <= 1.05) return { slices: 4, steps: 5, half: true, nearSteps: 3 };
  return { slices: 4, steps: 9, half: false, nearSteps: 4 };
}

/* ------------------------------------------------- sky-occlusion bake ----- */

/** Height-field resolution. 1024 over a ~150 m level is ~15 cm per texel. */
const SKY_FIELD_SIZE = 1024;
/** Nothing bigger than this is level geometry — backdrop shells and sky domes. */
const SKY_FIELD_MAX_RADIUS = 400;
/** Half-extent cap, so one stray mesh cannot dilute the whole field. */
const SKY_FIELD_MAX_HALF = 110;
/** Frames to wait before baking, so the boot compile storm is over. */
const SKY_FIELD_BAKE_FRAME = 6;

export class GtaoPass extends BasePass {
  readonly name = 'gtao';
  readonly order = PASS_ORDER.AO;

  private prefilter!: THREE.ShaderMaterial;
  private gtao!: THREE.ShaderMaterial;
  private denoise!: THREE.ShaderMaterial;
  private temporal!: THREE.ShaderMaterial;
  private apply!: THREE.ShaderMaterial;
  private tier: QualityTier = { slices: 3, steps: 6, half: false, nearSteps: 3 };
  private flip = 0;
  private lastFrame = -1;

  /* --- sky-occlusion height field ------------------------------------- */
  private skyTarget: THREE.WebGLRenderTarget | null = null;
  private skyDepthMaterial: THREE.MeshDepthMaterial | null = null;
  private readonly skyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private skyBuilt = false;
  private skyBakeFailed = false;
  private skySceneSize = -1;
  private skyBakeFrame = -1e9;
  private readonly bakeHidden: THREE.Object3D[] = [];
  private readonly bakeShown: THREE.Object3D[] = [];
  private readonly bakeCasters: THREE.Mesh[] = [];
  /** Last frame's camera/scene, for the measurement handle only. */
  private probeCtx: { camera: THREE.PerspectiveCamera; scene: THREE.Scene } | null = null;

  /**
   * Live tuning, published on `__GTAO__` for the capture harness exactly like
   * `__DOF__`. Nothing in the frame loop writes it.
   *
   * `radiusScale` is what turns the preset's *detail* radius into the world
   * radius the horizon search actually uses. It was 2.1 (= 1.47 m at ultra),
   * wide enough that a whole 1 m panel sat inside the search and got occluded by
   * its own plane. GTAO is now the sub-metre crease term it should be; grounding
   * an object against the floor is the contact-shadow ray's job, and that ray is
   * no longer running at 19% strength.
   */
  readonly tuning = {
    /** uIntensityPower = 1 + intensityGain * gfx.ssaoIntensity. */
    intensityGain: 0.4,
    /** World radius = gfx.ssaoRadius * radiusScale. */
    radiusScale: 1.05,
    /** Lowest the diffuse occlusion multiplier may reach. */
    floor: 0.50,
    /**
     * Contact-scale search radius, metres. This is the whole near-field term:
     * only geometry within this of a surface can darken it. 22 cm puts the
     * readable part of the ring in the 5-15 cm band the bar asks for and keeps
     * the term geometrically incapable of veiling an open panel.
     */
    nearRadius: 0.22,
    /** Response of the contact term. Steeper than the broad one on purpose. */
    nearPower: 2.4,
    /** Lowest the contact term may reach — deeper than the broad floor. */
    nearFloor: 0.22,
    /** Depth falloff of the half-res bilateral upsample weight. */
    upsampleSharpness: 8,
    /** Cosine subtracted from each candidate horizon; see the note in GTAO_FRAG. */
    horizonBias: 0.04,
    /** 0 off, 1 raw vis, 2 occlusion, 3 baked AO, 4 metal, 5 contact vis, 6 contact occ. */
    debug: 0,
  };
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
      defines: { AO_SLICES: 3, AO_STEPS: 6, AO_NEAR_STEPS: 3 },
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
        uHorizonBias: { value: 0.04 },
        uNearRadius: { value: 0.22 },
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
        uNearPower: { value: 2.4 },
        uNearFloor: { value: 0.22 },
        uDirectPreserve: { value: 0.25 },
        uAoFloor: { value: 0.50 },
        uUpsampleSharpness: { value: 8 },
        uDebug: { value: 0 },
      },
    });

    // Created here rather than lazily at first bake: the bake happens inside a
    // frame, and asking the driver to link a brand-new program in the middle of
    // one — while it is still working through the boot compile queue — is how a
    // contended GPU ends up handing back LINK_STATUS false with an empty info
    // log and taking the whole context with it.
    this.skyDepthMaterial = skipPatch(new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
    }));

    const g = globalThis as unknown as Record<string, unknown>;
    g.__GTAO__ = this.tuning;
    g.__AOPROBE__ = this.measurementHandle();
  }

  /**
   * Measurement handle for the capture harness, mirroring `__SHADING__` and
   * `__WORLD__`.
   *
   * Two of this pass's claims — "the contact ring is 5-15 cm wide" and "sky
   * occlusion returns the same number for a world point from every camera" —
   * are statements about *world* positions, and there was no way to turn a world
   * position into the pixel that shows it without re-deriving the camera
   * convention in the measuring script and hoping it matched. Both of those went
   * wrong in previous waves. This projects through the camera the frame was
   * actually rendered with.
   */
  private measurementHandle(): Record<string, unknown> {
    const v = new THREE.Vector3();
    return {
      /** World -> NDC + view depth, through the live camera. */
      project: (pts: [number, number, number][]) => {
        const cam = this.probeCtx?.camera;
        if (!cam) return null;
        cam.updateMatrixWorld();
        return pts.map((p) => {
          v.set(p[0], p[1], p[2]);
          const depth = v.distanceTo(cam.position);
          v.project(cam);
          return { x: v.x, y: v.y, z: v.z, depth };
        });
      },
      /** World positions of every instance of a scattered prop cluster. */
      instances: (id: string) => {
        const scene = this.probeCtx?.scene;
        if (!scene) return null;
        const out: number[][] = [];
        const seen = new Set<string>();
        const m = new THREE.Matrix4();
        scene.traverse((o) => {
          const im = o as THREE.InstancedMesh;
          if (!im.isInstancedMesh || !im.name.startsWith(`prop:${id}:`)) return;
          // One entry per bucket: every part shares the same instance matrices.
          const bucket = im.name.split(':').slice(3).join(':');
          if (seen.has(bucket)) return;
          seen.add(bucket);
          for (let i = 0; i < im.count; i++) {
            im.getMatrixAt(i, m);
            m.premultiply(im.matrixWorld);
            out.push([m.elements[12], m.elements[13], m.elements[14]]);
          }
        });
        return out;
      },
      /** World-space AABB of every object whose name starts with `prefix`. */
      bounds: (prefix: string) => {
        const scene = this.probeCtx?.scene;
        if (!scene) return null;
        const box = new THREE.Box3();
        let hits = 0;
        scene.traverse((o) => {
          if (!o.name.startsWith(prefix)) return;
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          hits++;
          box.expandByObject(mesh);
        });
        return hits === 0 || box.isEmpty() ? null
          : { hits, min: box.min.toArray(), max: box.max.toArray() };
      },
      /** Baked sky-occlusion field parameters, or null if it never built. */
      field: () => {
        const x = skyField.xform.value as THREE.Vector4;
        const i = skyField.info.value as THREE.Vector4;
        return {
          built: i.w > 0.5, originX: x.x, originZ: x.y, invExtent: x.z,
          topY: i.x, range: i.y, texelM: i.z, size: SKY_FIELD_SIZE,
          casters: this.bakeCasters.length, failed: this.skyBakeFailed,
        };
      },
      rebake: () => { this.skyBuilt = false; this.skyBakeFailed = false; },
    };
  }

  /* ------------------------------------------------ sky-occlusion bake -- */

  /**
   * Bakes the top-down height field the sky-occlusion term reads.
   *
   * One orthographic depth render of every sky-blocking surface in the level,
   * straight down. The level is static and procedural, so this runs once.
   *
   * The caster set is chosen with exactly the rule the shadow atlas uses —
   * `castShadow`, plus the off-screen casters `SceneIndex` flags — because "what
   * blocks the sun" and "what blocks the sky" have to be the same set of
   * objects, or a prop throws a shadow while its own footprint reads as open
   * sky. Rendering the scene from a post pass is the same manoeuvre
   * `Shadows.render` makes: override material, hide, render, restore.
   */
  private bakeSkyField(ctx: PassContext): void {
    const renderer = ctx.renderer;
    const scene = ctx.scene;

    if (!this.skyTarget) {
      this.skyTarget = new THREE.WebGLRenderTarget(SKY_FIELD_SIZE, SKY_FIELD_SIZE, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.skyTarget.texture.name = 'skyocc:height';
    }
    const target = this.skyTarget;
    const depthMat = this.skyDepthMaterial;
    if (!depthMat) return;

    // --- caster set, and the bounds it occupies -----------------------------
    this.collectCasters(scene);
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    for (const mesh of this.bakeCasters) {
      const im = mesh as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        if (!im.boundingSphere) im.computeBoundingSphere();
        if (!im.boundingSphere) continue;
        sphere.copy(im.boundingSphere);
      } else {
        const geo = mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        if (!geo.boundingSphere) continue;
        sphere.copy(geo.boundingSphere);
      }
      sphere.applyMatrix4(mesh.matrixWorld);
      if (!Number.isFinite(sphere.radius) || sphere.radius > SKY_FIELD_MAX_RADIUS) continue;
      // The distant backdrop is geometry too, and it is hundreds of metres out
      // and hundreds of metres tall. Letting it into the bounds costs the field
      // both its resolution (one texel over the play space instead of four) and
      // its depth precision, and it can never occlude anything the player
      // stands on.
      if (Math.abs(sphere.center.x) > SKY_FIELD_MAX_HALF || Math.abs(sphere.center.z) > SKY_FIELD_MAX_HALF) continue;
      box.expandByPoint(sphere.center.clone().addScalar(-sphere.radius));
      box.expandByPoint(sphere.center.clone().addScalar(sphere.radius));
    }

    if (box.isEmpty()) { this.restoreCasters(); this.skyBakeFailed = true; return; }

    const cx = THREE.MathUtils.clamp((box.min.x + box.max.x) * 0.5, -SKY_FIELD_MAX_HALF, SKY_FIELD_MAX_HALF);
    const cz = THREE.MathUtils.clamp((box.min.z + box.max.z) * 0.5, -SKY_FIELD_MAX_HALF, SKY_FIELD_MAX_HALF);
    const half = Math.min(
      SKY_FIELD_MAX_HALF,
      Math.max(24, 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 4),
    );
    // The depth range is the field's precision budget: half-float over 180 m
    // quantises height to ~9 cm, over 70 m to ~3 cm. Nothing in a street level
    // blocks the sky from above 70 m.
    const topY = Math.min(box.max.y + 2, 70);
    const botY = Math.max(box.min.y - 2, -25);
    const range = Math.max(topY - botY, 1);

    const cam = this.skyCamera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0; cam.far = range;
    cam.position.set(cx, topY, cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, topY - 1, cz);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // --- render -------------------------------------------------------------
    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = depthMat;
    scene.background = null;
    // Cleared black decodes to the bottom of the range, i.e. "nothing here".
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.setClearColor(prevClear, prevClearAlpha);
    renderer.setRenderTarget(prevTarget);
    this.restoreCasters();

    skyField.texture.value = target.texture;
    (skyField.xform.value as THREE.Vector4).set(cx - half, cz - half, 1 / (half * 2), 1 / (half * 2));
    (skyField.info.value as THREE.Vector4).set(topY, range, (half * 2) / SKY_FIELD_SIZE, 1);
    this.skyBuilt = true;
    this.skyBakeFailed = false;
    this.skySceneSize = scene.children.length;
  }

  /** Shadow-pass visibility, applied to the scene graph for one bake render. */
  private collectCasters(root: THREE.Object3D): void {
    const hidden = this.bakeHidden;
    const shown = this.bakeShown;
    const casters = this.bakeCasters;
    hidden.length = 0; shown.length = 0; casters.length = 0;

    const visit = (o: THREE.Object3D): void => {
      if (!o.visible) {
        // Culled from the colour pass but still occluding: shown for the bake
        // only, subtree left alone, exactly as `SceneIndex.hideNonCasters` does.
        if ((o.userData as Record<string, unknown>)[SHADOW_VISIBLE] === true) {
          o.visible = true;
          shown.push(o);
          const m = o as THREE.Mesh;
          if (m.isMesh) casters.push(m);
        }
        return;
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) {
        if (mesh.castShadow === true) casters.push(mesh);
        else { o.visible = false; hidden.push(o); }
      }
      const kids = o.children;
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    visit(root);
  }

  private restoreCasters(): void {
    for (const o of this.bakeHidden) o.visible = true;
    for (const o of this.bakeShown) o.visible = false;
    this.bakeHidden.length = 0;
    this.bakeShown.length = 0;
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    if (this.probeCtx) { this.probeCtx.camera = ctx.camera; this.probeCtx.scene = ctx.scene; }
    else this.probeCtx = { camera: ctx.camera, scene: ctx.scene };

    // The height field is level data, not frame data, and the level is static
    // and procedural: build it once and never again.
    //
    // Deliberately not "rebuild when the scene changes". FX, decals and the
    // light pool add and remove children of the scene root constantly, so any
    // scene-shape test fires most frames, and re-entering `renderer.render`
    // from inside a post pass every frame is enough to take the GPU process
    // down. A level reload calls `__AOPROBE__.rebake()`; nothing else needs to.
    // Deferred a few frames past boot. The first frames are the driver's compile
    // storm — every material in the level links its program — and inserting a
    // whole extra scene render into the middle of that is exactly when the bake
    // was observed to fail.
    if (!this.skyBakeFailed && !this.skyBuilt && ctx.frame >= SKY_FIELD_BAKE_FRAME) {
      this.skyBakeFrame = ctx.frame;
      try {
        this.bakeSkyField(ctx);
      } catch (err) {
        this.restoreCasters();
        this.skyBakeFailed = true;
        (skyField.info.value as THREE.Vector4).w = 0;
        console.warn('[gtao] sky-occlusion bake failed; term disabled', err);
      }
    }

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
    this.setDefine(this.gtao, 'AO_NEAR_STEPS', tier.nearSteps);
    const gu = this.gtao.uniforms;
    gu.tDepth.value = depthCur.texture;
    gu.tNormal.value = ctx.gbuffer.normalRoughness;
    (gu.uTexel.value as THREE.Vector2).set(1 / aw, 1 / ah);
    (gu.uProj.value as THREE.Vector4).copy(projVec);
    gu.uPixelsPerMeter.value = 0.5 * ah * proj[5];
    // The preset's radius is the *detail* scale (creases, window reveals).
    // See `tuning.radiusScale` for why this is no longer a metre and a half.
    gu.uRadius.value = Math.max(0.05, g.ssaoRadius) * this.tuning.radiusScale;
    gu.uThickness.value = 0.55;
    gu.uHorizonBias.value = this.tuning.horizonBias;
    gu.uNearRadius.value = Math.max(0.02, this.tuning.nearRadius);
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
    au.uIntensityPower.value = 1.0 + this.tuning.intensityGain * Math.max(0, g.ssaoIntensity);
    // Direct light should survive occlusion, but not this much: at 0.25 a sunlit
    // wall base kept a quarter of its ambient occlusion budget back and the
    // contact never read.
    au.uDirectPreserve.value = 0.14;
    au.uAoFloor.value = this.tuning.floor;
    au.uNearPower.value = this.tuning.nearPower;
    au.uNearFloor.value = this.tuning.nearFloor;
    au.uUpsampleSharpness.value = this.tuning.upsampleSharpness;
    au.uDebug.value = this.tuning.debug;
    ctx.blit(this.apply, output);
    return true;
  }
}
