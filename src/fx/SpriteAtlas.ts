/**
 * Procedurally baked particle sprite atlas.
 *
 * Two 8×8 atlases are rendered on the GPU at boot in a single MRT pass — there
 * are no image files anywhere in this project:
 *
 *   A   rgb tint, a coverage
 *   B   rg  tangent-space normal, b thickness (self-shadowing), a emissive
 *
 * The normal + thickness channels are what let smoke be *lit* rather than
 * tinted: the particle shader builds a hemispherical normal from the quad and
 * perturbs it with B.rg, then attenuates the sun by B.b so the far side of a
 * puff goes dark. That single detail is most of the distance between "WebGL
 * particles" and a shipped title.
 *
 * Frames of an animated effect are laid out contiguously so a flipbook is just
 * `base + floor(t * frames)`.
 */

import * as THREE from 'three';
import { FS_VERTEX, FxBlitter, fxSkipPatch } from './Common';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

/** Cell indices. Animated ranges are `[base, frames]`. */
export const CELL = {
  SMOKE: 0, SMOKE_FRAMES: 16,
  DUST: 16, DUST_FRAMES: 8,
  FLAME: 24, FLAME_FRAMES: 8,

  SPARK_DOT: 32,
  SPARK_STREAK: 33,
  GLOW_SOFT: 34,
  GLOW_TIGHT: 35,
  STAR: 36,
  RING: 37,
  SMOKE_RING: 38,
  EMBER: 39,

  CHIP_A: 40, CHIP_FRAMES: 4,
  SHARD_A: 44, SHARD_FRAMES: 2,
  SPLINTER_A: 46, SPLINTER_FRAMES: 2,

  BLOOD_DROP: 48,
  BLOOD_MIST: 49,
  WATER_DROP: 50,
  SPLASH_RING: 51,
  LEAF: 52,
  PAPER: 53,
  RAIN: 54,
  SNOW: 55,

  MUZZLE_CORE: 56,
  MUZZLE_STAR: 57,
  MUZZLE_CONE: 58,
  MUZZLE_PETAL: 59,
  HAZE_A: 60,
  HAZE_B: 61,
  FLASH_DISC: 62,
  CLOUD: 63,
} as const;

const BAKE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

const float PI = 3.141592653589793;

float hash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}

float hash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 hash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}

float vnoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	float n000 = hash13( i );
	float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
	float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
	float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
	float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
	float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
	float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
	float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
	return mix( mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
	            mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}

float fbm( vec3 p, int oct ) {
	float a = 0.5, s = 0.0, n = 0.0;
	for ( int i = 0; i < 7; i ++ ) {
		if ( i >= oct ) break;
		s += a * vnoise( p );
		n += a;
		p = p * 2.07 + 13.1;
		a *= 0.5;
	}
	return s / max( n, 1e-4 );
}

/** Ridged fbm — gives smoke its rolling, cauliflower silhouette. */
float ridged( vec3 p, int oct ) {
	float a = 0.5, s = 0.0, n = 0.0;
	for ( int i = 0; i < 6; i ++ ) {
		if ( i >= oct ) break;
		s += a * ( 1.0 - abs( vnoise( p ) * 2.0 - 1.0 ) );
		n += a;
		p = p * 2.13 + 7.7;
		a *= 0.55;
	}
	return s / max( n, 1e-4 );
}

struct Sprite {
	vec3 tint;
	float alpha;
	float height;      // drives the baked normal
	float thickness;   // 0..1 optical depth through the sprite
	float emissive;
};

Sprite blank() {
	Sprite s;
	s.tint = vec3( 1.0 );
	s.alpha = 0.0;
	s.height = 0.0;
	s.thickness = 0.0;
	s.emissive = 0.0;
	return s;
}

/* -------------------------------------------------------------- smoke -- */
/** 16-frame billowing puff. f walks the third noise axis so frames blend. */
Sprite smokeCell( vec2 p, float f, float wispy ) {
	Sprite s = blank();
	float t = f / 16.0;
	float z = f * 0.34;

	// Domain warp: a circular puff with a noisy boundary still reads as a
	// circle. Warping the sample point is what produces rolling lobes.
	float w1 = fbm( vec3( p * 1.35, z ) + 3.0, 5 ) - 0.5;
	float w2 = fbm( vec3( p * 1.35, z ) + 41.0, 5 ) - 0.5;
	vec2 warp = vec2( w1, w2 ) * ( 0.62 + 0.34 * wispy );
	vec2 pw = p + warp * 0.9;

	float r = length( pw );
	// The puff dissipates and spreads across the flipbook.
	float edge = mix( 0.66, 0.98, t ) * ( 1.0 - 0.18 * wispy );
	float body = smoothstep( edge, edge * 0.12, r );

	float dens = ridged( vec3( p * 2.6, z ) + 11.0, 5 );
	float fine = fbm( vec3( p * 7.5, z * 1.4 ) + 61.0, 4 );

	float d = body * ( 0.30 + 0.95 * dens ) * ( 0.62 + 0.55 * fine );
	// Break the disc into lobes so the silhouette is never a soft circle.
	float lobes = ridged( vec3( normalize( pw + 1e-4 ) * 2.2, z * 0.8 ) + 5.0, 4 );
	d *= 0.55 + 0.9 * lobes;
	d = clamp( d, 0.0, 1.0 );
	// Old frames thin out from the inside as well as the edge.
	d *= mix( 1.0, 0.62, t ) ;

	s.alpha = clamp( d * 1.35, 0.0, 1.0 );
	s.height = d * ( 0.55 + 0.45 * dens ) + fine * 0.16;
	s.thickness = clamp( d * 1.15, 0.0, 1.0 );
	// Very slight value variation so the puff is not one flat grey.
	s.tint = vec3( 1.0 ) * ( 0.86 + 0.24 * dens );
	return s;
}

/* --------------------------------------------------------------- dust -- */
Sprite dustCell( vec2 p, float f ) {
	Sprite s = blank();
	float t = f / 8.0;
	float z = f * 0.55 + 100.0;
	float w1 = fbm( vec3( p * 1.9, z ), 5 ) - 0.5;
	float w2 = fbm( vec3( p * 1.9, z ) + 71.0, 5 ) - 0.5;
	vec2 pw = p + vec2( w1, w2 ) * 1.15;
	float r = length( pw );
	float edge = mix( 0.58, 1.02, t );
	float body = smoothstep( edge, edge * 0.05, r );
	float dens = fbm( vec3( p * 4.2, z ) + 17.0, 5 );
	float fine = fbm( vec3( p * 11.0, z ) + 91.0, 4 );
	float d = body * ( 0.15 + 1.0 * dens ) * ( 0.5 + 0.7 * fine );
	d = clamp( d, 0.0, 1.0 ) * mix( 1.0, 0.5, t );
	s.alpha = clamp( d * 1.25, 0.0, 1.0 );
	s.height = d * 0.7 + fine * 0.2;
	s.thickness = d * 0.8;
	s.tint = vec3( 1.0 ) * ( 0.88 + 0.2 * dens );
	return s;
}

/* -------------------------------------------------------------- flame -- */
Sprite flameCell( vec2 p, float f ) {
	Sprite s = blank();
	float t = f / 8.0;
	float z = f * 0.7 + 200.0;

	// Tongues: stretch the noise vertically and let it rise across frames.
	vec2 q = vec2( p.x, p.y * 0.72 - 0.12 );
	float w = fbm( vec3( q * 2.3, z ), 5 ) - 0.5;
	vec2 pw = q + vec2( w * 0.55, - abs( w ) * 0.3 );
	float r = length( pw * vec2( 1.25, 0.92 ) );

	float body = smoothstep( mix( 0.62, 0.92, t ), 0.02, r );
	float tongues = ridged( vec3( pw * vec2( 3.4, 1.6 ), z * 1.2 ) + 23.0, 5 );
	float d = body * ( 0.25 + 1.05 * tongues );
	d = clamp( d, 0.0, 1.0 );

	float core = smoothstep( 0.42, 0.0, r ) * ( 1.0 - t * 0.75 );
	s.alpha = clamp( d * 1.5, 0.0, 1.0 );
	s.height = d * 0.6;
	s.thickness = d;
	// Hot core is white, edges fall to deep orange; the runtime multiplies this
	// by an HDR colour so the roll-off survives tonemapping.
	s.tint = mix( vec3( 1.0, 0.34, 0.06 ), vec3( 1.0, 0.93, 0.72 ), clamp( core * 1.6 + d * 0.25, 0.0, 1.0 ) );
	s.emissive = clamp( core * 1.2 + d * 0.55, 0.0, 1.0 );
	return s;
}

/* --------------------------------------------------------- simple shapes -- */

Sprite dotCell( vec2 p, float power, float hardness ) {
	Sprite s = blank();
	float r = length( p );
	float d = pow( clamp( 1.0 - r, 0.0, 1.0 ), power );
	d = mix( d, smoothstep( hardness, hardness * 0.35, r ), 0.35 );
	s.alpha = clamp( d, 0.0, 1.0 );
	s.height = d;
	s.thickness = d;
	s.emissive = clamp( d * 1.4, 0.0, 1.0 );
	return s;
}

/** Elongated streak with a bright head — a spark seen at speed. */
Sprite streakCell( vec2 p ) {
	Sprite s = blank();
	vec2 q = vec2( p.x, p.y * 4.6 );
	float r = length( q );
	float core = pow( clamp( 1.0 - r, 0.0, 1.0 ), 2.2 );
	float head = pow( clamp( 1.0 - length( vec2( p.x * 3.0, ( p.y - 0.42 ) * 3.4 ) ), 0.0, 1.0 ), 2.0 );
	float d = clamp( core * 0.85 + head, 0.0, 1.0 );
	s.alpha = d;
	s.height = d;
	s.thickness = d;
	s.emissive = clamp( d * 1.6, 0.0, 1.0 );
	s.tint = mix( vec3( 1.0, 0.55, 0.16 ), vec3( 1.0, 0.97, 0.86 ), clamp( head * 1.4 + core * 0.4, 0.0, 1.0 ) );
	return s;
}

/** Anamorphic star flare — the classic muzzle-flash spike pattern. */
Sprite starCell( vec2 p, float points, float sharp ) {
	Sprite s = blank();
	float r = length( p );
	float a = atan( p.y, p.x );
	float spikes = pow( abs( cos( a * points * 0.5 ) ), sharp );
	float ray = spikes * pow( clamp( 1.0 - r, 0.0, 1.0 ), 1.5 );
	float core = pow( clamp( 1.0 - r * 3.4, 0.0, 1.0 ), 2.0 );
	float d = clamp( ray * 0.85 + core, 0.0, 1.0 );
	s.alpha = d;
	s.height = d;
	s.thickness = d;
	s.emissive = 1.0;
	s.tint = mix( vec3( 1.0, 0.62, 0.22 ), vec3( 1.0, 0.96, 0.86 ), clamp( core * 2.0, 0.0, 1.0 ) );
	return s;
}

/** Thin expanding ring (shockwave / splash / smoke ring). */
Sprite ringCell( vec2 p, float radius, float width, float noiseAmt ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float n = fbm( vec3( cos( a ) * 2.0, sin( a ) * 2.0, 3.3 ), 4 ) - 0.5;
	float r = length( p ) + n * noiseAmt;
	float d = smoothstep( width, 0.0, abs( r - radius ) );
	d *= smoothstep( 1.0, 0.82, length( p ) );
	s.alpha = d;
	s.height = d;
	s.thickness = d;
	s.emissive = d;
	return s;
}

/** Irregular chunk — concrete chip / dirt clod. Solid, lit, no glow. */
Sprite chipCell( vec2 p, float seed ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float lobe = 0.52 + 0.30 * fbm( vec3( cos( a ) * 1.7, sin( a ) * 1.7, seed ), 4 );
	float r = length( p );
	float d = smoothstep( lobe, lobe * 0.86, r );
	float relief = fbm( vec3( p * 5.5, seed * 3.0 ), 4 );
	s.alpha = d;
	// A lit chunk needs real relief or it reads as a flat blob at 2m.
	s.height = d * ( 0.35 + 0.65 * relief ) + ( 1.0 - r ) * 0.35 * d;
	s.thickness = d;
	s.tint = vec3( 0.72 + 0.5 * relief );
	return s;
}

/** Long thin splinter with a torn end. */
Sprite splinterCell( vec2 p, float seed ) {
	Sprite s = blank();
	float taper = 0.20 * ( 1.0 - clamp( p.y * 0.5 + 0.5, 0.0, 1.0 ) * 0.7 );
	float jag = ( fbm( vec3( p.y * 6.0, seed, 0.0 ), 3 ) - 0.5 ) * 0.14;
	float d = smoothstep( taper, taper * 0.4, abs( p.x + jag ) );
	d *= smoothstep( 0.97, 0.86, abs( p.y ) );
	float grain = fbm( vec3( p.x * 3.0, p.y * 20.0, seed ), 3 );
	s.alpha = d;
	s.height = d * ( 0.4 + 0.6 * grain );
	s.thickness = d;
	s.tint = vec3( 0.68 + 0.55 * grain );
	return s;
}

/** Angular glass shard with a bright specular edge. */
Sprite shardCell( vec2 p, float seed ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	// Three straight-ish edges: a triangle warped per seed.
	float d = 1.0;
	for ( int i = 0; i < 3; i ++ ) {
		float ang = ( float( i ) / 3.0 + hash12( vec2( float( i ), seed ) ) * 0.22 ) * 2.0 * PI;
		vec2 n = vec2( cos( ang ), sin( ang ) );
		float off = 0.34 + 0.30 * hash12( vec2( float( i ) + 5.0, seed ) );
		d = min( d, off - dot( p, n ) );
	}
	float mask = smoothstep( 0.0, 0.035, d );
	float edge = smoothstep( 0.10, 0.0, d ) * mask;
	s.alpha = mask * 0.82 + edge * 0.5;
	s.height = mask * 0.3 + edge * 0.7;
	s.thickness = mask * 0.35;
	s.tint = mix( vec3( 0.78, 0.88, 0.95 ), vec3( 1.0 ), edge );
	s.emissive = edge * 0.55;
	// Keep it inside the cell.
	s.alpha *= smoothstep( 1.0, 0.9, length( p ) );
	return s;
}

/** Teardrop droplet, heavier at the bottom. */
Sprite dropCell( vec2 p, float stretch ) {
	Sprite s = blank();
	vec2 q = vec2( p.x * stretch, p.y );
	float bulge = 0.42 - 0.30 * clamp( q.y, 0.0, 1.0 );
	float r = length( vec2( q.x, ( q.y - 0.12 ) * ( q.y > 0.0 ? 1.7 : 1.0 ) ) );
	float d = smoothstep( bulge, bulge * 0.45, r );
	s.alpha = d;
	s.height = d * ( 1.0 - r * 0.6 );
	s.thickness = d;
	s.tint = vec3( 1.0 );
	return s;
}

/** Flat scrap that tumbles — leaf / paper. */
Sprite scrapCell( vec2 p, float seed, float crease ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float lobe = 0.62 + 0.24 * fbm( vec3( cos( a ) * 2.3, sin( a ) * 2.3, seed ), 4 );
	float r = length( vec2( p.x * 1.25, p.y * 0.85 ) );
	float d = smoothstep( lobe, lobe * 0.92, r );
	float folds = abs( sin( ( p.x * 3.4 + p.y * 1.2 ) * PI ) );
	s.alpha = d;
	s.height = d * mix( 0.5, folds, crease );
	s.thickness = d * 0.5;
	s.tint = vec3( 0.75 + 0.4 * folds );
	return s;
}

/** Vertical rain streak. */
Sprite rainCell( vec2 p ) {
	Sprite s = blank();
	float d = smoothstep( 0.14, 0.02, abs( p.x ) ) * smoothstep( 1.0, 0.72, abs( p.y ) );
	// Brighter at the leading end (+y is the direction of travel for both a
	// stretched rain particle and a tracer beam).
	d *= 0.30 + 0.85 * smoothstep( -1.0, 0.92, p.y );
	s.alpha = d;
	s.height = d;
	s.thickness = d * 0.4;
	s.emissive = d * 0.4;
	return s;
}

Sprite snowCell( vec2 p ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float r = length( p );
	float arms = pow( abs( cos( a * 3.0 ) ), 6.0 );
	float d = smoothstep( 0.30 + arms * 0.42, 0.0, r );
	s.alpha = d;
	s.height = d;
	s.thickness = d;
	s.tint = vec3( 1.0 );
	return s;
}

/** Muzzle flash core: dense white centre, ragged hot fringe. */
Sprite muzzleCore( vec2 p ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float lobe = 0.34 + 0.26 * fbm( vec3( cos( a ) * 2.6, sin( a ) * 2.6, 9.0 ), 5 );
	float r = length( p );
	float body = smoothstep( lobe, lobe * 0.15, r );
	float bloom = pow( clamp( 1.0 - r, 0.0, 1.0 ), 3.0 ) * 0.55;
	float d = clamp( body + bloom, 0.0, 1.0 );
	s.alpha = d;
	s.height = d;
	s.thickness = d;
	s.emissive = 1.0;
	s.tint = mix( vec3( 1.0, 0.44, 0.10 ), vec3( 1.0, 0.98, 0.92 ), clamp( body * 1.5, 0.0, 1.0 ) );
	return s;
}

/** Cone of burning gas leaving the barrel. */
Sprite muzzleCone( vec2 p ) {
	Sprite s = blank();
	// +Y is forward along the bore.
	float y = clamp( p.y * 0.5 + 0.5, 0.0, 1.0 );
	float halfWidth = 0.07 + 0.44 * pow( y, 0.7 );
	float n = ( fbm( vec3( p.x * 4.0, p.y * 3.0, 13.0 ), 4 ) - 0.5 ) * 0.22 * y;
	float d = smoothstep( halfWidth, halfWidth * 0.25, abs( p.x + n ) );
	d *= smoothstep( 1.0, 0.72, y ) * smoothstep( -0.02, 0.14, y );
	float hot = pow( 1.0 - y, 2.0 );
	s.alpha = clamp( d, 0.0, 1.0 );
	s.height = d;
	s.thickness = d;
	s.emissive = 1.0;
	s.tint = mix( vec3( 1.0, 0.36, 0.07 ), vec3( 1.0, 0.95, 0.80 ), clamp( hot * 1.3, 0.0, 1.0 ) );
	return s;
}

/** Petals of unburnt powder thrown sideways. */
Sprite muzzlePetal( vec2 p ) {
	Sprite s = blank();
	float a = atan( p.y, p.x );
	float r = length( p );
	float petals = pow( abs( cos( a * 2.5 + 0.4 ) ), 3.0 );
	float len = 0.30 + 0.62 * petals;
	float d = smoothstep( len, len * 0.2, r );
	float n = fbm( vec3( p * 5.0, 3.0 ), 4 );
	d *= 0.55 + 0.75 * n;
	s.alpha = clamp( d, 0.0, 1.0 );
	s.height = d;
	s.thickness = d;
	s.emissive = 1.0;
	s.tint = mix( vec3( 1.0, 0.30, 0.05 ), vec3( 1.0, 0.86, 0.55 ), clamp( d * 1.1, 0.0, 1.0 ) );
	return s;
}

/** Refraction / shimmer pattern used by heat haze. rg carries the offset. */
Sprite hazeCell( vec2 p, float seed ) {
	Sprite s = blank();
	float r = length( p );
	float mask = smoothstep( 1.0, 0.15, r );
	float h = fbm( vec3( p * 3.2, seed ), 5 );
	s.alpha = mask;
	s.height = h * 2.0 * mask;
	s.thickness = mask;
	s.tint = vec3( 1.0 );
	return s;
}

/** Enormous soft cloud used for fog banks and smoke-grenade volume. */
Sprite cloudCell( vec2 p ) {
	Sprite s = blank();
	float w1 = fbm( vec3( p * 0.9, 77.0 ), 5 ) - 0.5;
	float w2 = fbm( vec3( p * 0.9, 91.0 ), 5 ) - 0.5;
	vec2 pw = p + vec2( w1, w2 ) * 0.85;
	float r = length( pw );
	float body = smoothstep( 0.98, 0.05, r );
	float dens = ridged( vec3( p * 1.9, 55.0 ), 5 );
	float fine = fbm( vec3( p * 5.5, 55.0 ), 4 );
	float d = body * ( 0.35 + 0.85 * dens ) * ( 0.7 + 0.4 * fine );
	s.alpha = clamp( d, 0.0, 1.0 );
	s.height = d * 0.8;
	s.thickness = clamp( d * 1.1, 0.0, 1.0 );
	s.tint = vec3( 0.9 + 0.2 * dens );
	return s;
}

/* ------------------------------------------------------------- dispatch -- */

Sprite evaluate( int idx, vec2 p ) {
	if ( idx < 16 ) return smokeCell( p, float( idx ), 0.0 );
	if ( idx < 24 ) return dustCell( p, float( idx - 16 ) );
	if ( idx < 32 ) return flameCell( p, float( idx - 24 ) );
	if ( idx == 32 ) return dotCell( p, 3.5, 0.42 );
	if ( idx == 33 ) return streakCell( p );
	if ( idx == 34 ) return dotCell( p, 1.7, 0.95 );
	if ( idx == 35 ) return dotCell( p, 6.0, 0.30 );
	if ( idx == 36 ) return starCell( p, 8.0, 22.0 );
	if ( idx == 37 ) return ringCell( p, 0.76, 0.20, 0.05 );
	if ( idx == 38 ) return ringCell( p, 0.66, 0.34, 0.18 );
	if ( idx == 39 ) return dotCell( p, 2.6, 0.30 );
	if ( idx < 44 ) return chipCell( p, float( idx - 40 ) * 7.3 + 1.0 );
	if ( idx < 46 ) return shardCell( p, float( idx - 44 ) * 3.1 + 2.0 );
	if ( idx < 48 ) return splinterCell( p, float( idx - 46 ) * 5.7 + 4.0 );
	if ( idx == 48 ) return dropCell( p, 1.35 );
	if ( idx == 49 ) return smokeCell( p, 3.0, 1.0 );
	if ( idx == 50 ) return dropCell( p, 1.0 );
	if ( idx == 51 ) return ringCell( p, 0.70, 0.26, 0.10 );
	if ( idx == 52 ) return scrapCell( p, 3.0, 1.0 );
	if ( idx == 53 ) return scrapCell( p, 8.0, 0.35 );
	if ( idx == 54 ) return rainCell( p );
	if ( idx == 55 ) return snowCell( p );
	if ( idx == 56 ) return muzzleCore( p );
	if ( idx == 57 ) return starCell( p, 6.0, 9.0 );
	if ( idx == 58 ) return muzzleCone( p );
	if ( idx == 59 ) return muzzlePetal( p );
	if ( idx == 60 ) return hazeCell( p, 1.0 );
	if ( idx == 61 ) return hazeCell( p, 9.0 );
	if ( idx == 62 ) return dotCell( p, 1.2, 0.98 );
	return cloudCell( p );
}

void main() {
	vec2 grid = vec2( ${ATLAS_COLS}.0, ${ATLAS_ROWS}.0 );
	vec2 cell = floor( vUv * grid );
	int idx = int( cell.y * grid.x + cell.x );
	vec2 local = fract( vUv * grid ) * 2.0 - 1.0;

	Sprite s = evaluate( idx, local );

	// Feather the cell border so bilinear taps and mip chains never bleed
	// between neighbouring sprites.
	float e = 1.0 - smoothstep( 0.88, 0.995, max( abs( local.x ), abs( local.y ) ) );
	s.alpha *= e;
	s.thickness *= e;

	// Screen-space derivatives are exact here: the bake draws one texel per
	// pixel, so dFdx of the height field is the height gradient in texels.
	float hx = dFdx( s.height );
	float hy = dFdy( s.height );
	vec3 n = normalize( vec3( - hx * 26.0, - hy * 26.0, 1.0 ) );

	outA = vec4( clamp( s.tint, 0.0, 1.0 ), clamp( s.alpha, 0.0, 1.0 ) );
	outB = vec4( n.xy * 0.5 + 0.5, clamp( s.thickness, 0.0, 1.0 ), clamp( s.emissive, 0.0, 1.0 ) );
}
`;

export interface SpriteAtlas {
  a: THREE.Texture;
  b: THREE.Texture;
  cell: number;
  dispose(): void;
}

/**
 * Bakes both atlases in one MRT pass. `cellSize` trades VRAM for close-up
 * sharpness: 256px cells (2048² atlas) read cleanly on a smoke puff filling the
 * screen; 128px is the budget option.
 */
export function bakeSpriteAtlas(
  renderer: THREE.WebGLRenderer,
  blitter: FxBlitter,
  cellSize = 256,
): SpriteAtlas {
  const w = ATLAS_COLS * cellSize;
  const h = ATLAS_ROWS * cellSize;

  const target = new THREE.WebGLRenderTarget(w, h, {
    count: 2,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  target.textures[0].name = 'fx:atlasA';
  target.textures[1].name = 'fx:atlasB';
  for (const t of target.textures) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  }

  const mat = fxSkipPatch(new THREE.ShaderMaterial({
    name: 'fx:atlas-bake',
    glslVersion: THREE.GLSL3,
    vertexShader: FS_VERTEX,
    fragmentShader: BAKE_FRAG,
    uniforms: {},
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  }));

  const prev = renderer.getRenderTarget();
  blitter.blit(renderer, mat, target);
  renderer.setRenderTarget(prev);
  mat.dispose();

  return {
    a: target.textures[0],
    b: target.textures[1],
    cell: cellSize,
    dispose: () => target.dispose(),
  };
}
