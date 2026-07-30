/**
 * Physical sky, sun/moon ephemeris, image-based lighting.
 *
 * A single `setTimeOfDay(hours)` drives everything: the solar position from a
 * real hour-angle/declination model, a ray-marched Rayleigh/Mie atmosphere
 * baked into a cubemap, the PMREM specular probe, a 9-coefficient SH irradiance
 * probe for diffuse ambient, the sun's colour and intensity (from atmospheric
 * transmittance along the solar ray, so dawn goes red on its own), the aerial
 * perspective colour, and the night sky with stars and a phased moon.
 *
 * The expensive part — the cubemap bake, PMREM and SH projection — only runs
 * when the time of day or the weather actually changes.
 */

import * as THREE from 'three';
import {
  GLSL_ATMOSPHERE, GLSL_COMMON, GLSL_SKYDOME,
} from './Glsl';
import { FS_VERTEX, FullscreenBlitter } from './Fullscreen';
import { skipPatch } from './MaterialPatch';
import type { RenderUniforms } from './RenderUniforms';

const DEG = Math.PI / 180;

/**
 * Angular radius of the sun disc, in radians.
 *
 * The real sun subtends 0.53° across, i.e. a radius of 0.0047 rad — which at
 * 1080p is a seven-pixel dot that the tonemapper, TAA and bloom between them
 * reduce to a smudge, and the reason a clipped-pixel census of this project
 * came back at 0.0000%. Shipped games draw it roughly twice over-size for
 * exactly that reason; this is 2.1×, which reads as a sun at 62–80° of field
 * without becoming a cartoon.
 */
const SUN_ANGULAR_RADIUS = 0.0100;

/**
 * Radiance of the disc relative to the illuminance it delivers.
 *
 * Physically the ratio is ~1/Ω ≈ 1/6.8e-5, which no tonemapper can be given
 * directly; what matters for the picture is that it sits far enough above
 * display white that the core clips flat, the limb rolls off through orange
 * over two or three stops, and a specular reflection of it in a window or a wet
 * kerb also clips.
 */
const SUN_DISC_GAIN = 26;

/**
 * Brightness of the scattered sky, relative to the direct sun.
 *
 * Lowered from 22 in step with `SUN_BASE` going the other way. The camera and
 * the ambient probe are fed by the same bake, so this is the sun-to-sky ratio
 * knob: at 22 against a 16-strength sun the dome sat two and a half stops over
 * mid-grey in every frame, which is where AgX and the highlight bleach in the
 * grade strip out the last of its colour and hand back a milky white ceiling.
 * The fill the sky used to provide is restored by the level's ambient
 * intensity, which scales the probe without touching what the camera sees.
 */
const SKY_INTENSITY = 9.5;

/* --------------------------------------------------- CPU-side atmosphere -- */

const Rg = 6360000;
const Rt = 6460000;
const Hr = 8000;
const Hm = 1200;
const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6] as const;

function raySphereFar(oy: number, dy: number, r: number): number {
  // Ray from (0, oy, 0) in direction (dx, dy, dz) with |d| = 1; only the
  // vertical component matters for the origin's dot product.
  const b = oy * dy;
  const c = oy * oy - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

/** Atmospheric transmittance from the ground along a direction with elevation `sinEl`. */
export function atmosphericTransmittance(sinEl: number, altitude: number, betaM: number, out: THREE.Color): THREE.Color {
  const oy = Rg + Math.max(altitude, 1);
  const dy = sinEl;
  const tMax = raySphereFar(oy, dy, Rt);
  if (tMax <= 0) return out.setRGB(0, 0, 0);
  const STEPS = 24;
  const seg = tMax / STEPS;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < STEPS; i++) {
    const t = seg * (i + 0.5);
    // |p| for a ray starting at (0, oy, 0): sqrt(oy^2 + 2*oy*dy*t + t^2)
    const len = Math.sqrt(oy * oy + 2 * oy * dy * t + t * t);
    const h = Math.max(len - Rg, 0);
    odR += Math.exp(-h / Hr) * seg;
    odM += Math.exp(-h / Hm) * seg;
  }
  return out.setRGB(
    Math.exp(-(BETA_R[0] * odR + betaM * 1.1 * odM)),
    Math.exp(-(BETA_R[1] * odR + betaM * 1.1 * odM)),
    Math.exp(-(BETA_R[2] * odR + betaM * 1.1 * odM)),
  );
}

/* ------------------------------------------------------------- ephemeris -- */

export interface SunState {
  /** Unit vector from the observer toward the sun. */
  direction: THREE.Vector3;
  elevation: number;   // radians
  azimuth: number;     // radians, 0 = north, increasing east
}

/**
 * Solar position for a given hour, latitude and solar declination.
 * Good enough that noon shadows shorten toward the tropics and the sun tracks a
 * believable arc; not an almanac.
 */
export function solarPosition(hours: number, latitudeDeg: number, declinationDeg: number, out: SunState): SunState {
  const H = (hours - 12) * 15 * DEG;
  const lat = latitudeDeg * DEG;
  const dec = declinationDeg * DEG;
  const sinEl = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const az = Math.atan2(
    -Math.sin(H) * Math.cos(dec),
    Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H),
  );
  out.elevation = el;
  out.azimuth = az;
  // World convention: +Y up, -Z north, +X east.
  const ce = Math.cos(el);
  out.direction.set(ce * Math.sin(az), Math.sin(el), -ce * Math.cos(az)).normalize();
  return out;
}

/* ------------------------------------------------------------ SH helpers -- */

const SH_A = [3.141593, 2.094395, 0.785398];
const SH_K = [
  0.282095,
  0.488603, 0.488603, 0.488603,
  1.092548, 1.092548, 0.315392, 1.092548, 0.546274,
];

/* --------------------------------------------------------------- shaders -- */

/**
 * Shared radiance function for both bakes. `uDisc` is 1 for the cubemap (so
 * mirrors and PMREM see the sun) and 0 for the SH source, where a disc that
 * small would only produce ringing — the sun is already an analytic light.
 */
const SKY_RADIANCE = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunLum;     // sun/moon illuminance in renderer units
uniform vec3 uSunDisc;    // radiance of the disc itself
uniform vec4 uAtmo;       // x sunIntensity, y betaM, z mieG, w altitude
uniform vec4 uNight;      // x nightAmount, y moonIntensity, z moonPhase, w airglow
uniform vec4 uGround;     // xyz albedo, w bounce strength
uniform vec4 uWeather;    // x greyness, y disc enable, z horizonHaze, w unused
uniform vec4 uMs;         // x amount, y horizon falloff, z forward power, w disc gain
uniform vec3 uFogTint;

vec3 boSkyRadiance( vec3 dir ) {
	vec3 transmittance;
	vec3 col = boAtmosphere( dir, uAtmo.w, uSunDir, uAtmo.x, uAtmo.y, uAtmo.z, transmittance );

	// --- multiple scattering, approximated.
	//
	// The integral above is single-scatter only: every photon that bounces more
	// than once is thrown away. That is a fifth of the sky at midday and most of
	// it near sunset, and because the missing light has already crossed the long
	// slant path it is the *warm* part of the spectrum. Discarding it is exactly
	// why a physical single-scatter sky measures bluer than a photograph at
	// golden hour, at every hour we have ever shipped. Re-injecting it, tinted by
	// the sun's own transmittance and piled up toward the horizon and toward the
	// sun, is what turns 17:40 from a cold afternoon into an amber one.
	{
		float lum = max( boLuma( uSunLum ), 1e-4 );
		vec3 tint = uSunLum / lum;
		float horizon = exp( - max( dir.y, 0.0 ) * uMs.y );
		float toward = pow( boSat( dot( dir, uSunDir ) * 0.5 + 0.5 ), uMs.z );
		// Only near sunrise/sunset: a high sun has a short enough path that
		// single scattering is already most of the answer. Full strength below
		// 12 degrees of elevation, gone by 35.
		float low = 1.0 - boSat( ( uSunDir.y - 0.21 ) * 2.7 );
		col += tint * ( uMs.x * lum * low ) * ( 0.12 + 0.88 * horizon ) * ( 0.20 + 0.80 * toward );
	}

	// --- night: airglow gradient plus the moon's own scattered halo.
	float night = uNight.x;
	if ( night > 0.001 ) {
		float up = boSat( dir.y * 0.5 + 0.5 );
		vec3 zenith = vec3( 0.0055, 0.0085, 0.0180 );
		vec3 horizon = vec3( 0.0130, 0.0150, 0.0230 );
		vec3 nightCol = mix( horizon, zenith, pow( up, 0.75 ) ) * uNight.w;
		float mu = dot( dir, uMoonDir );
		nightCol += vec3( 0.09, 0.11, 0.17 ) * uNight.y * ( pow( boSat( mu ), 40.0 ) * 0.55 + pow( boSat( mu ), 6.0 ) * 0.05 );
		col += nightCol * night;
	}

	// --- Lambertian ground bounce below the horizon. Without this the lower
	// hemisphere is black and every vertical surface in the level goes dead.
	if ( dir.y < 0.10 ) {
		float k = boSat( ( 0.10 - dir.y ) / 0.35 );
		vec3 t2;
		vec3 hemi = boAtmosphere( normalize( vec3( dir.x, 0.30, dir.z ) ),
			uAtmo.w, uSunDir, uAtmo.x, uAtmo.y, uAtmo.z, t2 );
		vec3 skyIrradiance = hemi * BO_PI;
		vec3 groundIrradiance = uSunLum * max( uSunDir.y, 0.0 ) + skyIrradiance;
		vec3 groundCol = uGround.xyz * groundIrradiance * ( 1.0 / BO_PI ) * uGround.w;
		// Keep a little of the sky so the far distance reads as haze, not dirt.
		groundCol = mix( groundCol, col * 0.9 + groundCol * 0.3, boSat( 0.35 + uWeather.z ) );
		col = mix( col, groundCol, k );
	}

	// --- weather: desaturate toward a flat overcast and thicken the horizon.
	float haze = uWeather.z * exp( - max( dir.y, 0.0 ) * 5.0 );
	col = mix( col, vec3( boLuma( col ) ) * uFogTint * 1.25, boSat( haze ) );
	col = mix( col, vec3( boLuma( col ) ) * uFogTint, uWeather.x );

	if ( uWeather.y > 0.5 ) {
		col += boSunDisc( dir, uSunDir, uMs.w, uSunDisc, 0.42 );
	}

	return max( col, vec3( 0.0 ) );
}
`;

const ATMOS_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SKYDOME}
${SKY_RADIANCE}

in vec3 vDir;
layout(location = 0) out vec4 outColor;

void main() {
	outColor = vec4( boSkyRadiance( normalize( vDir ) ), 1.0 );
}
`;

const ATMOS_VERT = /* glsl */ `
out vec3 vDir;
void main() {
	vDir = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** Equirectangular bake used purely as the CPU-readable source for SH. */
const EQUIRECT_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SKYDOME}
${SKY_RADIANCE}

in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
	float phi = ( vUv.x * 2.0 - 1.0 ) * BO_PI;
	float theta = ( 1.0 - vUv.y ) * BO_PI;
	float st = sin( theta );
	vec3 dir = normalize( vec3( st * sin( phi ), cos( theta ), st * cos( phi ) ) );
	outColor = vec4( boSkyRadiance( dir ), 1.0 );
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SKYDOME}

in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalRough;
layout(location = 2) out vec2 outVelocity;
layout(location = 3) out vec4 outMaterial;

uniform samplerCube uSkyCube;
uniform mat4 uInvViewProjection;
uniform mat4 uPrevViewProjection;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform vec3 uMoonDir;
uniform vec4 uSunParams;    // x angularRadius, y glow, z moonIntensity, w moonPhase
uniform vec4 uNightParams;  // x starAmount, y time, z cirrus, w cirrusTime
uniform vec2 uResolution;

/** Wispy high cloud, kept subtle; weather drives coverage. */
float boCirrus( vec3 dir, float t ) {
	if ( dir.y < 0.015 ) return 0.0;
	vec3 p = dir / max( dir.y, 0.015 );
	vec2 q = p.xz * 0.055 + vec2( t * 0.004, t * 0.0015 );
	float f = boFbm( vec3( q * 3.1, t * 0.01 ), 5 );
	float streak = boFbm( vec3( q.x * 12.0, q.y * 1.6, t * 0.02 ), 3 );
	float d = boSat( ( f * 0.65 + streak * 0.35 ) * 1.9 - 0.72 );
	return d * smoothstep( 0.015, 0.16, dir.y );
}

void main() {
	vec2 ndc = vUv * 2.0 - 1.0;
	vec4 farPoint = uInvViewProjection * vec4( ndc, 1.0, 1.0 );
	vec3 dir = normalize( farPoint.xyz / farPoint.w - uCameraPos );

	vec3 col = textureLod( uSkyCube, dir, 0.0 ).rgb;

	// Cirrus deck, lit by the sun colour, tinted toward the sky at the edges.
	float cir = uNightParams.z > 0.001 ? boCirrus( dir, uNightParams.w ) * uNightParams.z : 0.0;
	if ( cir > 0.001 ) {
		float mu = boSat( dot( dir, uSunDir ) );
		vec3 lit = mix( col * 1.15, uSunDisc * 0.020, 0.35 ) * ( 0.75 + 0.75 * pow( mu, 6.0 ) );
		col = mix( col, lit, boSat( cir ) );
	}

	col += boSunDisc( dir, uSunDir, uSunParams.x, uSunDisc, uSunParams.y );
	col += boStars( dir, uNightParams.x, uNightParams.y ) * ( 1.0 - boSat( cir * 1.4 ) );
	col += boMoon( dir, uMoonDir, uSunParams.w, uSunParams.z );

	outColor = vec4( col, 1.0 );

	vec4 pc = uPrevViewProjection * vec4( uCameraPos + dir * 40000.0, 1.0 );
	vec2 prevNdc = pc.xy / max( abs( pc.w ), 1e-5 ) * sign( pc.w );
	outVelocity = ( ndc - prevNdc ) * 0.5 * uResolution;

	outNormalRough = vec4( 0.5, 0.5, 1.0, 1.0 );
	outMaterial = vec4( 0.0, 1.0, 1.0, 1.0 );
}
`;

/* ----------------------------------------------------------------- class -- */

export interface SkyOptions {
  latitude: number;
  declination: number;
  altitude: number;
  cubeSize: number;
}

export class SkySystem {
  hours = 12;
  latitude = 34;
  /**
   * Solar declination. Raised from 12° to 20° — high summer rather than late
   * spring — which lifts the whole arc by four degrees and swings the afternoon
   * azimuth nine degrees north of west. Both matter for what ends up on screen:
   * the level's hero hour can sit at a genuine 11° golden hour and still clear
   * the town's own rooflines on the way in, and the sun's own direction moves
   * measurably closer to the cameras that look up the square. Noon goes to 76°,
   * 18:06 to 10° and 23:12 to −35°, so midday, dusk and night stay firmly what
   * they each are.
   */
  declination = 20;
  altitude = 40;

  /** Weather knobs, all 0..1. */
  rain = 0;
  fogAmount = 0;
  wind = 0.25;
  /** Strength of the multiple-scattering warm-up applied at low sun. */
  msAmount = 0.032;

  readonly sun: SunState = { direction: new THREE.Vector3(0, 1, 0), elevation: Math.PI / 2, azimuth: 0 };
  readonly moon: SunState = { direction: new THREE.Vector3(0, -1, 0), elevation: -Math.PI / 2, azimuth: 0 };

  /** Illuminance of the dominant celestial light, in the renderer's linear units. */
  readonly sunIlluminance = new THREE.Color(1, 1, 1);
  /** Radiance used to draw the sun disc itself (much brighter than illuminance). */
  readonly sunDiscColor = new THREE.Color(1, 1, 1);
  readonly shCoefficients: THREE.Vector3[] = Array.from({ length: 9 }, () => new THREE.Vector3());
  /** Average sky colour, used to tint fog when no cubemap sample is available. */
  readonly horizonColor = new THREE.Color(0.5, 0.6, 0.75);
  nightFactor = 0;

  /** Per-level ambient controls, driven by the world system through the API. */
  ambientTint = new THREE.Color(1, 1, 1);
  ambientIntensity = 1;
  /** Diffuse albedo of the terrain, used for the sky's ground-bounce term. */
  readonly groundAlbedo = new THREE.Color(0.24, 0.225, 0.20);
  groundBounce = 1;

  private renderer!: THREE.WebGLRenderer;
  private blitter!: FullscreenBlitter;
  private uniforms!: RenderUniforms;

  private cubeTarget!: THREE.WebGLCubeRenderTarget;
  private cubeCamera!: THREE.CubeCamera;
  private cubeScene!: THREE.Scene;
  private atmosMaterial!: THREE.ShaderMaterial;

  private equirectTarget!: THREE.WebGLRenderTarget;
  private equirectMaterial!: THREE.ShaderMaterial;
  private equirectPixels!: Float32Array;

  private pmrem!: THREE.PMREMGenerator;
  private pmremTarget: THREE.WebGLRenderTarget | null = null;

  domeMaterial!: THREE.ShaderMaterial;

  private dirty = true;
  private lastBakedHours = Number.NaN;
  private lastBakedWeather = Number.NaN;
  private time = 0;
  private scratchColor = new THREE.Color();

  init(renderer: THREE.WebGLRenderer, blitter: FullscreenBlitter, uniforms: RenderUniforms, opts?: Partial<SkyOptions>): void {
    this.renderer = renderer;
    this.blitter = blitter;
    this.uniforms = uniforms;
    if (opts?.latitude !== undefined) this.latitude = opts.latitude;
    if (opts?.declination !== undefined) this.declination = opts.declination;
    if (opts?.altitude !== undefined) this.altitude = opts.altitude;

    const size = opts?.cubeSize ?? 256;

    this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.cubeTarget.texture.name = 'sky:cube';
    this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeTarget);

    const bakeUniforms = (disc: number) => ({
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunLum: { value: new THREE.Color(1, 1, 1) },
      uSunDisc: { value: new THREE.Color(1, 1, 1) },
      uAtmo: { value: new THREE.Vector4(SKY_INTENSITY, 13e-6, 0.76, this.altitude) },
      uNight: { value: new THREE.Vector4(0, 0, 0, 1) },
      uGround: { value: new THREE.Vector4(0.21, 0.19, 0.16, 1) },
      uWeather: { value: new THREE.Vector4(0, disc, 0.05, 0) },
      uMs: { value: new THREE.Vector4(0.032, 3.2, 4.0, SUN_ANGULAR_RADIUS) },
      uFogTint: { value: new THREE.Color(0.72, 0.74, 0.78) },
    });

    this.atmosMaterial = skipPatch(new THREE.ShaderMaterial({
      name: 'sky:atmosphere',
      glslVersion: THREE.GLSL3,
      vertexShader: ATMOS_VERT,
      fragmentShader: ATMOS_FRAG,
      uniforms: bakeUniforms(1),
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));

    this.cubeScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), this.atmosMaterial);
    dome.frustumCulled = false;
    this.cubeScene.add(dome);

    // SH source — deliberately tiny; SH cannot represent anything sharper.
    const EW = 64;
    const EH = 32;
    this.equirectTarget = new THREE.WebGLRenderTarget(EW, EH, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.equirectPixels = new Float32Array(EW * EH * 4);
    this.equirectMaterial = skipPatch(new THREE.ShaderMaterial({
      name: 'sky:equirect',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: EQUIRECT_FRAG,
      uniforms: bakeUniforms(0),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();

    this.domeMaterial = skipPatch(new THREE.ShaderMaterial({
      name: 'sky:dome',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uSkyCube: { value: this.cubeTarget.texture },
        uInvViewProjection: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunDisc: { value: new THREE.Color(1, 1, 1) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunParams: { value: new THREE.Vector4(0.0046, 1, 0, 0) },
        uNightParams: { value: new THREE.Vector4(0, 0, 0.22, 0) },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));

    this.setTimeOfDay(this.hours);
  }

  setTimeOfDay(hours: number): void {
    const h = ((hours % 24) + 24) % 24;
    if (Math.abs(h - this.hours) > 1e-6) this.dirty = true;
    this.hours = h;
    this.updateEphemeris();
  }

  setWeather(rain: number, fog: number, wind: number): void {
    const r = THREE.MathUtils.clamp(rain, 0, 1);
    const f = THREE.MathUtils.clamp(fog, 0, 1);
    if (Math.abs(r - this.rain) > 1e-4 || Math.abs(f - this.fogAmount) > 1e-4) this.dirty = true;
    this.rain = r;
    this.fogAmount = f;
    this.wind = THREE.MathUtils.clamp(wind, 0, 1);
    this.updateEphemeris();
  }

  private get betaM(): number {
    // Mie scattering coefficient rises with haze/rain (turbidity). The clear-air
    // base was 21e-6 — a hazy-city value that whitened the entire dome, so the
    // sky measured near-neutral at every hour and read as overcast no matter
    // what the sun was doing. 13e-6 is a clean continental atmosphere: deep blue
    // at the zenith, and the warmth near the horizon then comes from the
    // multiple-scattering term rather than from a uniform white veil.
    return 13e-6 * (1 + this.fogAmount * 3.2 + this.rain * 2.2);
  }

  /** Cheap per-call update: directions, sun colour, night blend. */
  private updateEphemeris(): void {
    solarPosition(this.hours, this.latitude, this.declination, this.sun);
    // The moon trails the sun by roughly half a day and rides a shallower arc.
    solarPosition((this.hours + 12.4) % 24, this.latitude, -this.declination * 0.6, this.moon);

    const sinEl = this.sun.direction.y;
    const betaM = this.betaM;

    // Sunlight: top-of-atmosphere white, attenuated along the solar ray.
    atmosphericTransmittance(Math.max(sinEl, -0.06), this.altitude, betaM, this.scratchColor);
    const dayMask = THREE.MathUtils.smoothstep(sinEl, -0.045, 0.055);
    this.nightFactor = 1 - THREE.MathUtils.smoothstep(sinEl, -0.14, 0.02);

    const weatherDim = 1 - 0.55 * this.rain - 0.35 * this.fogAmount;
    // Direct sun, relative to the sky's own scattered radiance. Raised from 16:
    // the key-to-fill ratio is what makes a frame read as *sunlit* rather than
    // as an overcast day with a warm filter, and with the meter anchored to the
    // subject a stronger key also pushes the sky further down the tone curve,
    // where it keeps its colour instead of bleaching toward white.
    const SUN_BASE = 26.0;

    if (dayMask > 0.001) {
      this.sunIlluminance.copy(this.scratchColor).multiplyScalar(SUN_BASE * dayMask * Math.max(weatherDim, 0.12));
      // Warm the low sun a little beyond pure transmittance — real skies scatter
      // a lot of long-wavelength light back onto the subject at golden hour.
      const warm = 1 - THREE.MathUtils.smoothstep(sinEl, 0.02, 0.32);
      this.sunIlluminance.r *= 1 + warm * 0.16;
      this.sunIlluminance.b *= 1 - warm * 0.20;
      this.uniforms.boSunDirWorld.value.copy(this.sun.direction);
    } else {
      // Moonlight: cool, dim, and boosted well above physical so night is
      // playable. Auto-exposure does the rest.
      const moonUp = THREE.MathUtils.smoothstep(this.moon.direction.y, -0.06, 0.18);
      atmosphericTransmittance(Math.max(this.moon.direction.y, -0.06), this.altitude, betaM, this.scratchColor);
      this.sunIlluminance.copy(this.scratchColor)
        .multiply(new THREE.Color(0.55, 0.68, 1.0))
        .multiplyScalar(0.40 * moonUp * Math.max(weatherDim, 0.15));
      this.uniforms.boSunDirWorld.value.copy(this.moon.direction);
    }

    // Disc radiance: far brighter than the illuminance so it blows out on
    // camera the way a real sun does, but still tonemappable.
    if (dayMask > 0.001) {
      this.sunDiscColor.copy(this.sunIlluminance).multiplyScalar(SUN_DISC_GAIN);
    } else {
      this.sunDiscColor.setRGB(0, 0, 0);
    }

    this.uniforms.boSunColor.value.copy(this.sunIlluminance);
    this.uniforms.boFogSun.value.copy(this.sunIlluminance);
  }

  /** Recomputes the environment when time of day or weather actually moved. */
  update(dt: number, scene: THREE.Scene): void {
    this.time += dt;

    const weatherKey = this.rain * 7 + this.fogAmount * 13;
    const needBake = this.dirty
      || !(Math.abs(this.hours - this.lastBakedHours) < 0.02)
      || !(Math.abs(weatherKey - this.lastBakedWeather) < 1e-4);

    if (needBake) {
      this.dirty = false;
      this.lastBakedHours = this.hours;
      this.lastBakedWeather = weatherKey;
      this.bake(scene);
    }

    this.pushUniforms();
  }

  /** Forces a rebake on the next update — used after a quality change. */
  invalidate(): void { this.dirty = true; }

  private syncBakeUniforms(): void {
    const moonUp = THREE.MathUtils.smoothstep(this.moon.direction.y, -0.06, 0.2);
    for (const mat of [this.atmosMaterial, this.equirectMaterial]) {
      const u = mat.uniforms;
      (u.uSunDir.value as THREE.Vector3).copy(this.sun.direction);
      (u.uMoonDir.value as THREE.Vector3).copy(this.moon.direction);
      (u.uSunLum.value as THREE.Color).copy(this.sunIlluminance);
      (u.uSunDisc.value as THREE.Color).copy(this.sunDiscColor);
      (u.uAtmo.value as THREE.Vector4).set(
        SKY_INTENSITY * (1 - 0.35 * this.rain),
        this.betaM,
        0.76 + 0.06 * this.fogAmount,
        this.altitude,
      );
      (u.uNight.value as THREE.Vector4).set(this.nightFactor, moonUp, 0, 1);
      (u.uGround.value as THREE.Vector4).set(
        this.groundAlbedo.r, this.groundAlbedo.g, this.groundAlbedo.b, this.groundBounce,
      );
      const w = u.uWeather.value as THREE.Vector4;
      w.x = this.rain * 0.55 + this.fogAmount * 0.35;
      w.z = 0.045 + this.fogAmount * 0.55 + this.rain * 0.3;
      // Aerosol load feeds the multiple-scattering term: haze and smoke are what
      // make a low sun paint the whole western sky rather than just its halo.
      (u.uMs.value as THREE.Vector4).set(
        this.msAmount * (1 + this.fogAmount * 1.4 + this.rain * 0.6),
        3.2,
        4.0,
        SUN_ANGULAR_RADIUS,
      );
      (u.uFogTint.value as THREE.Color).copy(this.uniforms.boFogTint.value);
    }
  }

  private bake(scene: THREE.Scene): void {
    const renderer = this.renderer;
    this.syncBakeUniforms();

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    // 1. Cubemap — used directly by the sky dome and as the PMREM source.
    this.cubeCamera.update(renderer, this.cubeScene);

    // 2. Equirect bake for the SH projection (needs a CPU-readable float target).
    renderer.autoClear = false;
    this.blitter.blit(renderer, this.equirectMaterial, this.equirectTarget);
    renderer.readRenderTargetPixels(
      this.equirectTarget, 0, 0,
      this.equirectTarget.width, this.equirectTarget.height,
      this.equirectPixels,
    );
    this.projectSH();

    // 3. PMREM specular probe.
    const next = this.pmrem.fromCubemap(this.cubeTarget.texture, this.pmremTarget);
    this.pmremTarget = next;
    scene.environment = next.texture;
    scene.environmentIntensity = this.ambientIntensity;

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /** Projects the equirect bake onto 9 SH coefficients, cosine-convolved. */
  private projectSH(): void {
    const w = this.equirectTarget.width;
    const h = this.equirectTarget.height;
    const px = this.equirectPixels;

    const L = new Float64Array(27);
    const dPhi = (2 * Math.PI) / w;
    const dTheta = Math.PI / h;

    let horizonR = 0;
    let horizonG = 0;
    let horizonB = 0;
    let horizonN = 0;

    for (let j = 0; j < h; j++) {
      const v = (j + 0.5) / h;
      const theta = (1 - v) * Math.PI;
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      const solid = st * dTheta * dPhi;
      for (let i = 0; i < w; i++) {
        const uu = (i + 0.5) / w;
        const phi = (uu * 2 - 1) * Math.PI;
        const x = st * Math.sin(phi);
        const y = ct;
        const z = st * Math.cos(phi);

        const o = (j * w + i) * 4;
        const r = px[o];
        const g = px[o + 1];
        const b = px[o + 2];

        if (Math.abs(y) < 0.18) { horizonR += r; horizonG += g; horizonB += b; horizonN++; }

        const basis = [
          SH_K[0],
          SH_K[1] * y, SH_K[2] * z, SH_K[3] * x,
          SH_K[4] * x * y, SH_K[5] * y * z, SH_K[6] * (3 * z * z - 1),
          SH_K[7] * x * z, SH_K[8] * (x * x - y * y),
        ];
        for (let k = 0; k < 9; k++) {
          const wgt = basis[k] * solid;
          L[k * 3] += r * wgt;
          L[k * 3 + 1] += g * wgt;
          L[k * 3 + 2] += b * wgt;
        }
      }
    }

    const bands = [0, 1, 1, 1, 2, 2, 2, 2, 2];
    for (let k = 0; k < 9; k++) {
      const a = SH_A[bands[k]] * SH_K[k];
      this.shCoefficients[k].set(L[k * 3] * a, L[k * 3 + 1] * a, L[k * 3 + 2] * a);
    }

    if (horizonN > 0) {
      this.horizonColor.setRGB(horizonR / horizonN, horizonG / horizonN, horizonB / horizonN);
    }
  }

  private pushUniforms(): void {
    const u = this.uniforms;
    for (let i = 0; i < 9; i++) u.boAmbientSH.value[i].copy(this.shCoefficients[i]);
    u.boAmbientTint.value.copy(this.ambientTint);
    u.boAmbientIntensity.value = this.ambientIntensity;
    u.boSkyCube.value = this.cubeTarget.texture;

    // Fog tint tracks the horizon so distant geometry always matches the sky.
    const tint = u.boFogTint.value;
    const lum = Math.max(this.horizonColor.r + this.horizonColor.g + this.horizonColor.b, 1e-5) / 3;
    tint.setRGB(
      this.horizonColor.r / lum,
      this.horizonColor.g / lum,
      this.horizonColor.b / lum,
    );
  }

  /** Fills the dome material's per-frame uniforms and returns it for blitting. */
  domeFor(
    camera: THREE.PerspectiveCamera,
    prevViewProjection: THREE.Matrix4,
    width: number,
    height: number,
  ): THREE.ShaderMaterial {
    const u = this.domeMaterial.uniforms;
    const inv = u.uInvViewProjection.value as THREE.Matrix4;
    inv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    (u.uPrevViewProjection.value as THREE.Matrix4).copy(prevViewProjection);
    (u.uCameraPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    (u.uSunDir.value as THREE.Vector3).copy(this.sun.direction);
    (u.uMoonDir.value as THREE.Vector3).copy(this.moon.direction);
    (u.uSunDisc.value as THREE.Color).copy(this.sunDiscColor);

    const moonUp = THREE.MathUtils.smoothstep(this.moon.direction.y, -0.04, 0.2);
    const moonPhase = ((this.hours / 24) * 0.7 + 2.1) % (Math.PI * 2);
    (u.uSunParams.value as THREE.Vector4).set(
      SUN_ANGULAR_RADIUS,
      // Circumsolar glare. At 1.0 against a disc this bright the widest term
      // alone clears display white across twenty degrees of sky, which is how
      // "sun disc" turned into "the top half of the frame is paper"; at 0.45
      // the core and the first few degrees clip and it rolls off through orange
      // from there. That rolloff is what still reads as a sun on the days the
      // disc itself is behind the ridge, which at 11 degrees of elevation is
      // most of them.
      0.45 * (1 - 0.45 * this.rain),
      this.nightFactor * moonUp * 3.2,
      moonPhase,
    );
    (u.uNightParams.value as THREE.Vector4).set(
      this.nightFactor * (1 - 0.8 * this.rain) * 0.9,
      this.time,
      (0.10 + 0.55 * this.rain + 0.25 * this.fogAmount) * (1 - 0.25 * this.nightFactor),
      this.time * (0.4 + this.wind),
    );
    (u.uResolution.value as THREE.Vector2).set(width, height);
    (u.uSkyCube as THREE.IUniform).value = this.cubeTarget.texture;
    return this.domeMaterial;
  }

  dispose(): void {
    this.cubeTarget.dispose();
    this.equirectTarget.dispose();
    this.atmosMaterial.dispose();
    this.equirectMaterial.dispose();
    this.domeMaterial.dispose();
    this.pmremTarget?.dispose();
    this.pmrem.dispose();
  }
}
