/**
 * Volumetric lighting / participating media.
 *
 * A froxel volume (view-frustum-aligned 3D grid, exponentially distributed in
 * depth) is scattered and then integrated front-to-back, exactly as in Hillaire's
 * "Physically Based and Unified Volumetric Rendering". The volume is stored as a
 * tiled 2D atlas rather than a `sampler3D` so the whole scatter step and the
 * whole integration step are one draw call each — filling a real 3D texture in
 * WebGL2 costs one draw per layer, which is unaffordable at 32+ slices.
 *
 * Features: sun shadow sampling for god rays, Henyey–Greenstein phase, height
 * fog with animated 3D noise, up to 8 local scattering lights, blue-noise slice
 * dithering and temporal reprojection of the scattering volume.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const MAX_LIGHTS = 8;

const SCATTER_FRAG = /* glsl */ `
uniform sampler2D tPrev;
#ifdef VOL_SHADOW
#ifdef VOL_SHADOW_COMPARE
uniform highp sampler2DShadow tShadow;
#else
uniform sampler2D tShadow;
#endif
uniform mat4 uShadowMatrix;
uniform float uShadowBias;
uniform vec2 uShadowTexel;
#endif
uniform vec2 uFroxel;        // froxel tile size in pixels
uniform vec2 uTiles;         // tiles across / down
uniform vec2 uAtlasSize;
uniform mat4 uInverseView;
uniform mat4 uPrevViewProjection;
uniform vec4 uProj;          // P00,P11,P02,P12
uniform vec3 uCameraPos;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;  // direction the light propagates
uniform vec3 uAmbient;
uniform float uVolNear;
uniform float uVolFar;
uniform float uDensity;
uniform float uHeight;
uniform float uFalloff;
uniform float uAnisotropy;
uniform float uFrame;
uniform float uTime;
uniform float uNoiseAmount;
uniform float uReset;
uniform vec3 uWind;
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightRadius[${MAX_LIGHTS}];
uniform int uLightCount;
layout(location = 0) out vec4 fragColor;

float sliceToViewZ(float s) { return uVolNear * pow(uVolFar / uVolNear, s); }
float viewZToSlice(float z) { return log(max(z, uVolNear) / uVolNear) / log(uVolFar / uVolNear); }

vec2 atlasUv(vec2 local, float slice) {
  float clamped = clamp(slice, 0.0, uTiles.x * uTiles.y - 1.0);
  float tx = mod(floor(clamped), uTiles.x);
  float ty = floor(floor(clamped) / uTiles.x);
  vec2 half_ = 0.5 / uFroxel;
  vec2 l = clamp(local, half_, 1.0 - half_);
  return (vec2(tx, ty) + l) * uFroxel / uAtlasSize;
}

vec4 samplePrev(vec2 local, float slice) {
  float s0 = floor(slice);
  float f = slice - s0;
  vec4 a = texture(tPrev, atlasUv(local, s0));
  vec4 b = texture(tPrev, atlasUv(local, s0 + 1.0));
  return mix(a, b, f);
}

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * BLK_PI * max(d * sqrt(max(d, 1e-4)), 1e-4));
}

#ifdef VOL_SHADOW
float shadowTap(vec2 uv, float ref) {
#ifdef VOL_SHADOW_COMPARE
  return texture(tShadow, vec3(uv, ref));
#else
  return ref <= texture(tShadow, uv).r ? 1.0 : 0.0;
#endif
}

float sunShadow(vec3 world) {
  vec4 s = uShadowMatrix * vec4(world, 1.0);
  if (s.w <= 0.0) return 1.0;
  vec3 p = s.xyz / s.w;
  if (any(lessThan(p.xy, vec2(0.0))) || any(greaterThan(p.xy, vec2(1.0))) || p.z > 1.0) return 1.0;
  // 4-tap rotated cross — volumetrics do not need PCSS, just no banding.
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5707963 + p.x * 12.0;
    vec2 o = vec2(cos(a), sin(a)) * uShadowTexel * 1.2;
    sum += shadowTap(p.xy + o, p.z - uShadowBias);
  }
  return sum * 0.25;
}
#endif

void main() {
  vec2 pix = floor(gl_FragCoord.xy);
  vec2 tile = floor(pix / uFroxel);
  vec2 local = (mod(pix, uFroxel) + 0.5) / uFroxel;
  float slice = tile.y * uTiles.x + tile.x;
  if (slice >= float(VOL_SLICES)) { fragColor = vec4(0.0); return; }

  // Jitter the sample depth inside its froxel; temporal reprojection integrates
  // the jitter away and removes slice banding.
  float jitter = blueNoise1T(pix, uFrame);
  float sNorm = (slice + jitter) / float(VOL_SLICES);
  float viewZ = sliceToViewZ(sNorm);

  vec2 ndc = local * 2.0 - 1.0;
  vec3 viewPos = vec3(
    viewZ * (ndc.x + uProj.z) / uProj.x,
    viewZ * (ndc.y + uProj.w) / uProj.y,
    -viewZ);
  vec3 world = (uInverseView * vec4(viewPos, 1.0)).xyz;
  vec3 rayDir = normalize(world - uCameraPos);

  /* --- density ---------------------------------------------------------- */
  float height = exp(-max(world.y - uHeight, 0.0) / max(uFalloff, 0.1));
  float noise = 1.0;
  if (uNoiseAmount > 0.001) {
    vec3 np = world * 0.055 + uWind * uTime;
    noise = mix(1.0, 0.35 + 1.5 * fbm3(np, 3), uNoiseAmount);
  }
  float density = max(uDensity * height * noise, 0.0);
  // Fade the volume out at its far plane so the analytic fog can take over.
  density *= 1.0 - smoothstep(0.86, 1.0, sNorm);

  float sigmaS = density;          // scattering
  float sigmaE = density * 1.08;   // + a little absorption

  /* --- in-scattering ---------------------------------------------------- */
  vec3 inscatter = uAmbient * sigmaS;

  float cosTheta = dot(-rayDir, uSunDirection);
  float phase = henyeyGreenstein(cosTheta, uAnisotropy);
  float shadow = 1.0;
#ifdef VOL_SHADOW
  shadow = sunShadow(world);
#endif
  inscatter += uSunColor * (phase * shadow * sigmaS);

  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i] - world;
    float dist2 = dot(d, d);
    float r = uLightRadius[i];
    float atten = 1.0 / (1.0 + dist2);
    atten *= sat(1.0 - dist2 / max(r * r, 1e-3));
    if (atten <= 0.0) continue;
    float lp = henyeyGreenstein(dot(-rayDir, normalize(-d)), uAnisotropy * 0.6);
    inscatter += uLightColor[i] * (atten * lp * sigmaS);
  }

  vec4 current = vec4(inscatter, sigmaE);

  /* --- temporal reprojection -------------------------------------------- */
  if (uReset < 0.5) {
    vec4 prevClip = uPrevViewProjection * vec4(world, 1.0);
    if (prevClip.w > 1e-4) {
      vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
      float prevSlice = viewZToSlice(prevClip.w) * float(VOL_SLICES);
      if (all(greaterThanEqual(prevUv, vec2(0.0))) && all(lessThanEqual(prevUv, vec2(1.0)))
          && prevSlice >= 0.0 && prevSlice < float(VOL_SLICES)) {
        vec4 prev = samplePrev(prevUv, prevSlice);
        current = mix(current, prev, 0.88);
      }
    }
  }

  fragColor = current;
}
`;

const INTEGRATE_FRAG = /* glsl */ `
uniform sampler2D tScatter;
uniform vec2 uFroxel;
uniform vec2 uTiles;
uniform vec2 uAtlasSize;
uniform float uVolNear;
uniform float uVolFar;
layout(location = 0) out vec4 fragColor;

float sliceToViewZ(float s) { return uVolNear * pow(uVolFar / uVolNear, s); }

vec2 atlasUv(vec2 local, float slice) {
  float tx = mod(slice, uTiles.x);
  float ty = floor(slice / uTiles.x);
  return (vec2(tx, ty) + local) * uFroxel / uAtlasSize;
}

void main() {
  vec2 pix = floor(gl_FragCoord.xy);
  vec2 tile = floor(pix / uFroxel);
  vec2 local = (mod(pix, uFroxel) + 0.5) / uFroxel;
  float slice = tile.y * uTiles.x + tile.x;
  if (slice >= float(VOL_SLICES)) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 accum = vec3(0.0);
  float transmittance = 1.0;
  float prevZ = 0.0;

  for (int i = 0; i < VOL_SLICES; i++) {
    if (float(i) > slice) break;
    float z = sliceToViewZ((float(i) + 1.0) / float(VOL_SLICES));
    float dz = max(z - prevZ, 1e-4);
    prevZ = z;

    vec4 s = texture(tScatter, atlasUv(local, float(i)));
    float sigmaE = max(s.a, 1e-5);
    float t = exp(-sigmaE * dz);
    // Analytic integration of a constant medium over the slice.
    vec3 integrated = (s.rgb - s.rgb * t) / sigmaE;
    accum += transmittance * integrated;
    transmittance *= t;
  }

  fragColor = vec4(accum, transmittance);
}
`;

const APPLY_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tVolume;
uniform sampler2D tDepth;
uniform vec2 uFroxel;
uniform vec2 uTiles;
uniform vec2 uAtlasSize;
uniform float uVolNear;
uniform float uVolFar;
uniform float uNear;
uniform float uFar;
uniform float uFrame;
uniform vec3 uDistantFogColor;
uniform float uDistantFogDensity;
layout(location = 0) out vec4 fragColor;

float viewZToSlice(float z) { return log(max(z, uVolNear) / uVolNear) / log(uVolFar / uVolNear); }

vec2 atlasUv(vec2 local, float slice) {
  float clamped = clamp(slice, 0.0, uTiles.x * uTiles.y - 1.0);
  float tx = mod(floor(clamped), uTiles.x);
  float ty = floor(floor(clamped) / uTiles.x);
  vec2 half_ = 0.5 / uFroxel;
  vec2 l = clamp(local, half_, 1.0 - half_);
  return (vec2(tx, ty) + l) * uFroxel / uAtlasSize;
}

void main() {
  vec3 color = texture(tInput, vUv).rgb;
  float d = texture(tDepth, vUv).r;
  float z = d >= 1.0 ? uFar : linearizeDepth(d, uNear, uFar);

  float dither = blueNoise1T(gl_FragCoord.xy, uFrame) - 0.5;
  float slice = viewZToSlice(min(z, uVolFar)) * float(VOL_SLICES) + dither;
  slice = clamp(slice, 0.0, float(VOL_SLICES) - 1.0);

  float s0 = floor(slice);
  float f = slice - s0;
  vec4 v = mix(texture(tVolume, atlasUv(vUv, s0)), texture(tVolume, atlasUv(vUv, s0 + 1.0)), f);

  color = color * v.a + v.rgb;

  // Beyond the froxel volume, fall back to analytic exponential distance fog so
  // the horizon still recedes into atmosphere.
  if (z > uVolFar) {
    float extra = 1.0 - exp(-(z - uVolFar) * uDistantFogDensity);
    color = mix(color, uDistantFogColor * v.a, sat(extra));
  }

  fragColor = vec4(color, 1.0);
}
`;

export class VolumetricPass extends BasePass {
  readonly name = 'volumetrics';
  readonly order = PASS_ORDER.VOLUMETRICS;

  private scatter!: THREE.ShaderMaterial;
  private integrate!: THREE.ShaderMaterial;
  private apply!: THREE.ShaderMaterial;
  private slices = 32;
  private flip = 0;
  private lastFrame = -1;
  private lightScanFrame = -999;
  private sun: THREE.DirectionalLight | null = null;
  private readonly lightPos: THREE.Vector3[] = [];
  private readonly lightColor: THREE.Vector3[] = [];
  private readonly lightRadius: number[] = [];
  private readonly projVec = new THREE.Vector4(1, 1, 0, 0);
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly candidates: Array<{ light: THREE.PointLight | THREE.SpotLight; d2: number }> = [];
  private readonly sunDir = new THREE.Vector3(0, -1, 0);
  private readonly sunColor = new THREE.Vector3(1, 1, 1);
  private readonly ambient = new THREE.Vector3(0.02, 0.03, 0.05);
  private readonly fogColor = new THREE.Vector3(0.5, 0.6, 0.72);
  /** Weather knobs — driven by `RenderAPI.setWeather` through the pass registry. */
  fogScale = 1;
  windSpeed = 0.02;

  constructor(res: PostResources) {
    super(res);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      this.lightPos.push(new THREE.Vector3());
      this.lightColor.push(new THREE.Vector3());
      this.lightRadius.push(1);
    }
  }

  protected override onSetup(): void {
    this.renderer.getContext().getExtension('EXT_color_buffer_float');

    this.scatter = this.makeMaterial({
      name: 'volumetrics/scatter',
      fragment: SCATTER_FRAG,
      blueNoise: true,
      defines: { VOL_SLICES: 32 },
      uniforms: {
        tPrev: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        tShadow: { value: null },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uShadowBias: { value: 0.0016 },
        uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
        uFroxel: { value: new THREE.Vector2(160, 90) },
        uTiles: { value: new THREE.Vector2(6, 6) },
        uAtlasSize: { value: new THREE.Vector2(960, 540) },
        uInverseView: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCameraPos: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Vector3(1, 0.95, 0.85) },
        uSunDirection: { value: new THREE.Vector3(0, -1, 0) },
        uAmbient: { value: new THREE.Vector3(0.02, 0.03, 0.05) },
        uVolNear: { value: 0.5 },
        uVolFar: { value: 120 },
        uDensity: { value: 0.02 },
        uHeight: { value: 6 },
        uFalloff: { value: 14 },
        uAnisotropy: { value: 0.68 },
        uFrame: { value: 0 },
        uTime: { value: 0 },
        uNoiseAmount: { value: 0.55 },
        uReset: { value: 1 },
        uWind: { value: new THREE.Vector3(0.02, 0.004, 0.013) },
        uLightPos: { value: this.lightPos },
        uLightColor: { value: this.lightColor },
        uLightRadius: { value: this.lightRadius },
        uLightCount: { value: 0 },
      },
    });

    this.integrate = this.makeMaterial({
      name: 'volumetrics/integrate',
      fragment: INTEGRATE_FRAG,
      defines: { VOL_SLICES: 32 },
      uniforms: {
        tScatter: { value: null },
        uFroxel: { value: new THREE.Vector2(160, 90) },
        uTiles: { value: new THREE.Vector2(6, 6) },
        uAtlasSize: { value: new THREE.Vector2(960, 540) },
        uVolNear: { value: 0.5 },
        uVolFar: { value: 120 },
      },
    });

    this.apply = this.makeMaterial({
      name: 'volumetrics/apply',
      fragment: APPLY_FRAG,
      blueNoise: true,
      defines: { VOL_SLICES: 32 },
      uniforms: {
        tInput: { value: null },
        tVolume: { value: null },
        tDepth: { value: null },
        tBlueNoise: { value: this.res.blueNoise },
        uFroxel: { value: new THREE.Vector2(160, 90) },
        uTiles: { value: new THREE.Vector2(6, 6) },
        uAtlasSize: { value: new THREE.Vector2(960, 540) },
        uVolNear: { value: 0.5 },
        uVolFar: { value: 120 },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uFrame: { value: 0 },
        uDistantFogColor: { value: new THREE.Vector3(0.5, 0.6, 0.72) },
        uDistantFogDensity: { value: 0.004 },
      },
    });
  }

  /** Finds the shadow-casting sun and the nearest local lights. */
  private scanLights(ctx: PassContext): void {
    if (ctx.frame - this.lightScanFrame < 12 && this.sun) return;
    this.lightScanFrame = ctx.frame;

    const suns: THREE.DirectionalLight[] = [];
    const candidates = this.candidates;
    candidates.length = 0;
    const camPos = ctx.camera.getWorldPosition(this.tmpV);

    ctx.scene.traverse((obj) => {
      const dir = obj as THREE.DirectionalLight;
      if (dir.isDirectionalLight) { suns.push(dir); return; }
      const pl = obj as THREE.PointLight;
      if (pl.isPointLight && pl.intensity > 0.01) {
        candidates.push({ light: pl, d2: pl.getWorldPosition(this.tmpB).distanceToSquared(camPos) });
        return;
      }
      const sl = obj as THREE.SpotLight;
      if (sl.isSpotLight && sl.intensity > 0.01) {
        candidates.push({ light: sl, d2: sl.getWorldPosition(this.tmpB).distanceToSquared(camPos) });
      }
    });

    let brightest: THREE.DirectionalLight | null = null;
    for (const s of suns) {
      if (!brightest || s.intensity > brightest.intensity) brightest = s;
      if (s.castShadow && s.shadow.map) { brightest = s; break; }
    }
    this.sun = brightest;

    candidates.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(MAX_LIGHTS, candidates.length);
    for (let i = 0; i < n; i++) {
      const l = candidates[i].light;
      l.getWorldPosition(this.lightPos[i]);
      // Volumetric scattering wants radiometric-ish units; the /(4π) keeps a
      // 1000 W bulb from turning the whole froxel white.
      const k = l.intensity / (4 * Math.PI);
      this.lightColor[i].set(l.color.r * k, l.color.g * k, l.color.b * k);
      this.lightRadius[i] = (l as THREE.PointLight).distance || 22;
    }
    this.scatter.uniforms.uLightCount.value = n;
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.volumetrics || g.fogDensity <= 0) return false;

    const slices = Math.max(12, Math.min(48, Math.round(g.volumetricSteps / 2) & ~1));
    if (slices !== this.slices) {
      this.slices = slices;
      this.res.pool.release('vol.');
      this.setDefine(this.scatter, 'VOL_SLICES', slices);
      this.setDefine(this.integrate, 'VOL_SLICES', slices);
      this.setDefine(this.apply, 'VOL_SLICES', slices);
    }

    // Froxel grid: ~12px cells, clamped so the atlas stays a sensible size.
    const fx = Math.max(24, Math.min(240, Math.round(ctx.width / 12)));
    const fy = Math.max(16, Math.min(160, Math.round(ctx.height / 12)));
    const tilesX = Math.ceil(Math.sqrt(slices));
    const tilesY = Math.ceil(slices / tilesX);
    const aw = fx * tilesX;
    const ah = fy * tilesY;

    const advance = ctx.frame !== this.lastFrame;
    if (advance) { this.flip ^= 1; this.lastFrame = ctx.frame; }

    const spec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };
    const cur = this.res.pool.get(`vol.scatter${this.flip}`, aw, ah, spec);
    const prev = this.res.pool.get(`vol.scatter${this.flip ^ 1}`, aw, ah, spec);
    const integrated = this.res.pool.get('vol.integrated', aw, ah, spec);

    this.scanLights(ctx);

    const volFar = Math.min(Math.max(60, g.drawDistance * 0.2), 260);
    const proj = ctx.camera.projectionMatrix.elements;
    this.projVec.set(proj[0], proj[5], proj[8], proj[9]);

    /* --- sun + shadow ------------------------------------------------------*/
    const sun = this.sun;
    const su = this.scatter.uniforms;
    const defines = this.scatter.defines as Record<string, string | number>;
    let shadowTex: THREE.Texture | null = null;
    let shadowCompare = false;
    if (sun) {
      this.sunDir.copy(sun.target.getWorldPosition(this.tmpV)).sub(sun.getWorldPosition(this.tmpB));
      if (this.sunDir.lengthSq() < 1e-8) this.sunDir.set(0, -1, 0);
      this.sunDir.normalize();
      const k = sun.intensity * 0.14;
      this.sunColor.set(sun.color.r * k, sun.color.g * k, sun.color.b * k);
      const map = sun.shadow.map;
      const dt = map ? map.depthTexture : null;
      // three uses a comparison sampler for PCF shadow maps and a plain depth
      // texture for Basic/VSM; a define selects the matching sampler type.
      if (map && dt) {
        shadowCompare = dt.compareFunction != null;
        shadowTex = dt;
        (su.uShadowMatrix.value as THREE.Matrix4).copy(sun.shadow.matrix);
        (su.uShadowTexel.value as THREE.Vector2).set(1 / map.width, 1 / map.height);
        su.uShadowBias.value = 0.0018;
      }
    }
    const wantShadow = shadowTex ? 1 : 0;
    const wantCompare = shadowCompare ? 1 : 0;
    if ((defines.VOL_SHADOW ?? 0) !== wantShadow) {
      if (wantShadow) defines.VOL_SHADOW = 1; else delete defines.VOL_SHADOW;
      this.scatter.needsUpdate = true;
    }
    if ((defines.VOL_SHADOW_COMPARE ?? 0) !== wantCompare) {
      if (wantCompare) defines.VOL_SHADOW_COMPARE = 1; else delete defines.VOL_SHADOW_COMPARE;
      this.scatter.needsUpdate = true;
    }
    su.tShadow.value = shadowTex;

    /* --- ambient / fog colour from the scene ------------------------------ */
    const bg = ctx.scene.background;
    if (bg && (bg as THREE.Color).isColor) {
      const c = bg as THREE.Color;
      this.fogColor.set(c.r, c.g, c.b);
      this.ambient.set(c.r * 0.06, c.g * 0.07, c.b * 0.09);
    }
    const fog = ctx.scene.fog;
    let distantDensity = 0.0035;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      distantDensity = (fog as THREE.FogExp2).density;
      const c = (fog as THREE.FogExp2).color;
      this.fogColor.set(c.r, c.g, c.b);
    }

    /* --- 1: scatter --------------------------------------------------------*/
    su.tPrev.value = prev.texture;
    (su.uFroxel.value as THREE.Vector2).set(fx, fy);
    (su.uTiles.value as THREE.Vector2).set(tilesX, tilesY);
    (su.uAtlasSize.value as THREE.Vector2).set(aw, ah);
    (su.uInverseView.value as THREE.Matrix4).copy(ctx.inverseView);
    (su.uPrevViewProjection.value as THREE.Matrix4).copy(ctx.prevViewProjection);
    (su.uProj.value as THREE.Vector4).copy(this.projVec);
    ctx.camera.getWorldPosition(su.uCameraPos.value as THREE.Vector3);
    (su.uSunColor.value as THREE.Vector3).copy(this.sunColor);
    (su.uSunDirection.value as THREE.Vector3).copy(this.sunDir);
    (su.uAmbient.value as THREE.Vector3).copy(this.ambient);
    su.uVolNear.value = Math.max(0.25, ctx.cameraNear * 4);
    su.uVolFar.value = volFar;
    su.uDensity.value = 0.010 * g.fogDensity * this.fogScale;
    su.uHeight.value = 3;
    su.uFalloff.value = 12;
    su.uAnisotropy.value = 0.66;
    su.uFrame.value = ctx.frame % 64;
    su.uTime.value = ctx.time;
    su.uNoiseAmount.value = 0.5;
    su.uReset.value = ctx.frame < 2 ? 1 : 0;
    (su.uWind.value as THREE.Vector3).set(this.windSpeed, this.windSpeed * 0.2, this.windSpeed * 0.7);
    ctx.blit(this.scatter, cur);

    /* --- 2: integrate ------------------------------------------------------*/
    const iu = this.integrate.uniforms;
    iu.tScatter.value = cur.texture;
    (iu.uFroxel.value as THREE.Vector2).set(fx, fy);
    (iu.uTiles.value as THREE.Vector2).set(tilesX, tilesY);
    (iu.uAtlasSize.value as THREE.Vector2).set(aw, ah);
    iu.uVolNear.value = su.uVolNear.value;
    iu.uVolFar.value = volFar;
    ctx.blit(this.integrate, integrated);

    /* --- 3: apply ----------------------------------------------------------*/
    const au = this.apply.uniforms;
    au.tInput.value = input;
    au.tVolume.value = integrated.texture;
    au.tDepth.value = ctx.gbuffer.depth;
    (au.uFroxel.value as THREE.Vector2).set(fx, fy);
    (au.uTiles.value as THREE.Vector2).set(tilesX, tilesY);
    (au.uAtlasSize.value as THREE.Vector2).set(aw, ah);
    au.uVolNear.value = su.uVolNear.value;
    au.uVolFar.value = volFar;
    au.uNear.value = ctx.cameraNear;
    au.uFar.value = ctx.cameraFar;
    au.uFrame.value = ctx.frame % 64;
    (au.uDistantFogColor.value as THREE.Vector3).copy(this.fogColor);
    au.uDistantFogDensity.value = distantDensity;
    ctx.blit(this.apply, output);
    return true;
  }
}
