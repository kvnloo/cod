/**
 * Procedurally generated decal atlas.
 *
 * Every bullet hole, blood splatter and scorch mark in the game is baked here,
 * on the GPU, at boot — there are no image files anywhere in this project. The
 * bake writes two atlases in one MRT pass:
 *
 *   A  rgb albedo, a coverage
 *   B  rg  tangent-space normal, b roughness, a metalness
 *
 * 8×4 cells of 256px. Cell contents are grouped so `SurfaceProps.decal` maps
 * straight onto a contiguous range.
 */

import * as THREE from 'three';
import { FS_VERTEX, FullscreenBlitter } from './Fullscreen';
import { skipPatch } from './MaterialPatch';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
export const ATLAS_CELL = 256;

/** Atlas slot ranges keyed by `SurfaceProps.decal` group. */
export const DECAL_GROUPS: Record<string, [number, number]> = {
  hard: [0, 4],
  metal: [4, 3],
  wood: [7, 3],
  glass: [10, 2],
  soft: [12, 2],
  blood: [14, 4],
  scorch: [18, 2],
  // Aliases used by explosion / melee FX.
  burn: [18, 2],
  none: [0, 0],
};

const BAKE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNRM;

const float PI = 3.141592653589793;

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

float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = hash12( i );
	float b = hash12( i + vec2( 1.0, 0.0 ) );
	float c = hash12( i + vec2( 0.0, 1.0 ) );
	float d = hash12( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float fbm( vec2 p, int oct ) {
	float a = 0.5, s = 0.0;
	for ( int i = 0; i < 7; i ++ ) {
		if ( i >= oct ) break;
		s += a * vnoise( p );
		p = p * 2.03 + 17.3;
		a *= 0.5;
	}
	return s;
}

/** Worley-ish distance to the nearest of N jittered radial spokes. */
float spokes( vec2 p, float count, float seed, float sharp ) {
	float ang = atan( p.y, p.x );
	float r = length( p );
	float a = ( ang / ( 2.0 * PI ) + 0.5 ) * count;
	float cell = floor( a );
	float f = fract( a );
	float best = 1.0;
	for ( int k = -1; k <= 1; k ++ ) {
		float c = cell + float( k );
		float off = hash12( vec2( c, seed ) ) * 0.9 + 0.05;
		float len = 0.35 + 0.65 * hash12( vec2( c, seed + 7.0 ) );
		float d = abs( f - float( k ) - off ) * ( 1.0 / count ) * 2.0 * PI;
		float radial = d * r * sharp;
		float cut = smoothstep( len, len * 0.6, r );
		best = min( best, radial + ( 1.0 - cut ) * 4.0 );
	}
	return best;
}

struct Decal {
	vec3 albedo;
	float alpha;
	float height;
	float rough;
	float metal;
};

Decal defaults() {
	Decal d;
	d.albedo = vec3( 0.0 );
	d.alpha = 0.0;
	d.height = 0.0;
	d.rough = 0.9;
	d.metal = 0.0;
	return d;
}

/* ------------------------------------------------- hard (concrete/stone) -- */
Decal holeHard( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );
	float ang = atan( p.y, p.x );
	vec2 dir = vec2( cos( ang ), sin( ang ) );

	float rimN = fbm( dir * 3.4 + seed * 5.1, 4 );
	float rim = 0.185 + 0.055 * rimN;
	float hole = smoothstep( rim, rim * 0.62, r );

	float spallN = fbm( dir * 2.1 + seed * 11.7, 5 );
	float spallR = 0.40 + 0.20 * spallN;
	float spall = smoothstep( spallR, spallR * 0.42, r );

	float crackD = spokes( p, 7.0, seed, 26.0 );
	float cracks = smoothstep( 0.30, 0.0, crackD ) * smoothstep( 0.82, 0.16, r );

	float grain = fbm( p * 26.0 + seed, 4 );
	float dust = smoothstep( 0.92, 0.25, r ) * ( 0.35 + 0.4 * fbm( p * 7.0 + seed * 3.0, 4 ) );

	vec3 fresh = vec3( 0.60, 0.585, 0.555 ) * ( 0.78 + 0.42 * grain );
	vec3 dark = vec3( 0.045, 0.042, 0.040 );

	d.albedo = mix( fresh, dark, hole );
	d.albedo = mix( d.albedo, dark * 1.7, cracks * 0.85 );
	d.alpha = max( max( hole, spall * 0.92 ), cracks * 0.7 );
	d.alpha = max( d.alpha, dust * 0.22 );
	d.height = - hole * 1.0 + spall * 0.16 - cracks * 0.4;
	d.rough = mix( 0.86, 0.97, hole );
	return d;
}

/* ------------------------------------------------------------------ metal -- */
Decal holeMetal( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );
	float ang = atan( p.y, p.x );
	vec2 dir = vec2( cos( ang ), sin( ang ) );

	float rim = 0.115 + 0.03 * fbm( dir * 4.0 + seed * 3.3, 4 );
	float hole = smoothstep( rim, rim * 0.55, r );

	// Petals: the metal folds outward around the entry point.
	float petalN = fbm( dir * 5.0 + seed * 9.0, 3 );
	float petalR = 0.27 + 0.13 * petalN;
	float petal = smoothstep( petalR, petalR * 0.5, r ) - hole;
	petal = max( petal, 0.0 );

	float scratchD = spokes( p, 11.0, seed + 3.0, 40.0 );
	float scratch = smoothstep( 0.22, 0.0, scratchD ) * smoothstep( 0.62, 0.12, r );

	// Heat tint straw/blue ring left by the round.
	float heat = smoothstep( 0.46, 0.20, r ) * smoothstep( 0.16, 0.26, r );
	vec3 heatCol = mix( vec3( 0.72, 0.52, 0.16 ), vec3( 0.22, 0.34, 0.62 ), smoothstep( 0.20, 0.42, r ) );

	vec3 bright = vec3( 0.78, 0.79, 0.82 ) * ( 0.8 + 0.35 * fbm( p * 30.0 + seed, 3 ) );
	d.albedo = mix( vec3( 0.02 ), bright, petal );
	d.albedo = mix( d.albedo, bright * 1.05, scratch * 0.7 );
	d.albedo = mix( d.albedo, heatCol, heat * 0.55 * ( 1.0 - hole ) );
	d.alpha = max( max( hole, petal ), max( scratch * 0.55, heat * 0.5 ) );
	d.height = - hole * 1.0 + petal * 0.55;
	d.rough = mix( 0.42, 0.9, hole ) - scratch * 0.12;
	d.metal = ( 1.0 - hole ) * ( 0.55 + 0.45 * petal );
	return d;
}

/* ------------------------------------------------------------------- wood -- */
Decal holeWood( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );
	float ang = atan( p.y, p.x );
	vec2 dir = vec2( cos( ang ), sin( ang ) );

	float rim = 0.15 + 0.04 * fbm( dir * 4.5 + seed * 2.0, 4 );
	float hole = smoothstep( rim, rim * 0.55, r );

	// Splinters run along the grain (local X).
	vec2 grainP = vec2( p.x * 1.0, p.y * 3.4 );
	float splinterD = spokes( grainP, 9.0, seed + 5.0, 22.0 );
	float splinter = smoothstep( 0.34, 0.0, splinterD ) * smoothstep( 0.66, 0.14, r );

	float torn = smoothstep( 0.34 + 0.12 * fbm( dir * 3.0 + seed, 4 ), 0.12, r );

	vec3 pale = vec3( 0.56, 0.42, 0.25 ) * ( 0.75 + 0.5 * fbm( vec2( p.x * 4.0, p.y * 34.0 ) + seed, 4 ) );
	d.albedo = mix( pale, vec3( 0.035, 0.026, 0.018 ), hole );
	d.alpha = max( max( hole, torn * 0.85 ), splinter * 0.8 );
	d.height = - hole + splinter * 0.35;
	d.rough = mix( 0.78, 0.95, hole );
	return d;
}

/* ------------------------------------------------------------------ glass -- */
Decal glassCrack( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );

	float radialD = spokes( p, 13.0, seed, 90.0 );
	float radial = smoothstep( 0.10, 0.0, radialD ) * smoothstep( 1.0, 0.06, r );

	float rings = 0.0;
	for ( int i = 0; i < 4; i ++ ) {
		float rr = 0.14 + float( i ) * 0.17 + 0.05 * fbm( p * 3.0 + float( i ) * 9.0 + seed, 3 );
		float w = 0.012 + 0.004 * float( i );
		rings = max( rings, smoothstep( w, 0.0, abs( r - rr ) ) * smoothstep( 0.95, 0.2, r ) );
	}
	rings *= smoothstep( 0.06, 0.02, radialD ) * 1.6 + 0.35;

	float pulverised = smoothstep( 0.085, 0.02, r );
	float lines = clamp( max( radial, rings ), 0.0, 1.0 );

	d.albedo = vec3( 0.86, 0.90, 0.94 );
	d.alpha = clamp( lines * 0.85 + pulverised, 0.0, 1.0 );
	d.height = lines * 0.5 + pulverised * 0.7;
	d.rough = mix( 0.10, 0.55, pulverised );
	return d;
}

/* -------------------------------------------------------- soft (dirt etc) -- */
Decal holeSoft( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );
	float ang = atan( p.y, p.x );
	vec2 dir = vec2( cos( ang ), sin( ang ) );

	float crater = smoothstep( 0.30 + 0.10 * fbm( dir * 3.0 + seed, 4 ), 0.06, r );
	float ring = smoothstep( 0.62 + 0.14 * fbm( dir * 2.0 + seed * 3.0, 4 ), 0.22, r ) - crater;
	ring = max( ring, 0.0 );

	float grain = fbm( p * 22.0 + seed, 4 );
	d.albedo = mix( vec3( 0.20, 0.165, 0.125 ), vec3( 0.35, 0.30, 0.23 ), ring ) * ( 0.75 + 0.5 * grain );
	d.alpha = clamp( crater * 0.95 + ring * 0.7, 0.0, 1.0 );
	d.height = - crater * 0.8 + ring * 0.25;
	d.rough = 0.95;
	return d;
}

/* ------------------------------------------------------------------ blood -- */
/**
 * Blood is not a radial gradient.
 *
 * The previous splat was a centred lobe with an airbrushed falloff and evenly
 * spaced spokes, which is the shape of a sun sprite, not of a fluid hitting a
 * wall. Three things fix it and all three are geometric rather than tonal:
 *
 *  - **Direction.** Cast-off arrives travelling. The pool is offset downrange,
 *    the fingers are longer downrange, and the satellite drops are thrown
 *    forward in a cone rather than sprayed evenly around a circle.
 *  - **A hard edge.** Surface tension gives blood a meniscus and then nothing.
 *    The falloff is two or three texels wide, and the rim is *darker* than the
 *    middle — the opposite of an airbrush.
 *  - **Value flatness.** Inside the pool the value barely changes; what changes
 *    is gloss. Wet blood is a mirror in the middle and matte where it has
 *    started to dry at the perimeter.
 */
Decal bloodSplat( vec2 p, float seed ) {
	Decal d = defaults();

	// Travel direction of the event.
	float ba = hash12( vec2( seed, 3.7 ) ) * 2.0 * PI;
	vec2 bdir = vec2( cos( ba ), sin( ba ) );
	vec2 q = p - bdir * 0.11;
	float rq = length( q );
	vec2 qd = q / max( rq, 1e-4 );
	float down = max( dot( qd, bdir ), 0.0 );

	// Main pool: lopsided, irregular, and cut off hard.
	float lobe = 0.20 + 0.12 * fbm( qd * 2.4 + seed * 4.0, 5 )
	                  + 0.10 * down * down;
	float body = smoothstep( lobe, lobe - 0.022, rq );

	// Fingers: they run downrange, not evenly around the clock.
	float fingerD = spokes( q, 11.0, seed + 11.0, 16.0 );
	float fingers = smoothstep( 0.30, 0.0, fingerD )
	              * smoothstep( 0.86, 0.16, rq )
	              * mix( 0.15, 1.0, down );
	fingers = smoothstep( 0.35, 0.55, fingers );

	// Satellite droplets, thrown forward, with hard edges and a size spread.
	float drops = 0.0;
	for ( int i = 0; i < 22; i ++ ) {
		vec2 h = hash22( vec2( float( i ), seed ) );
		float spread = 0.55 + 0.45 * hash12( vec2( float( i ) + 17.0, seed ) );
		float a = ba + ( h.x - 0.5 ) * 2.4 * spread;
		float dist = 0.30 + h.y * h.y * 0.72;
		vec2 c = bdir * 0.06 + vec2( cos( a ), sin( a ) ) * dist;
		float rad = 0.010 + 0.038 * pow( hash12( vec2( float( i ) + 3.0, seed ) ), 2.0 );
		// Drops elongate along their flight path.
		vec2 e = p - c;
		vec2 el = vec2( dot( e, bdir ) * 0.62, dot( e, vec2( -bdir.y, bdir.x ) ) );
		drops = max( drops, smoothstep( rad, rad * 0.55, length( el ) ) );
	}

	float mask = clamp( max( max( body, fingers ), drops ), 0.0, 1.0 );

	// A rim of thin, part-dried blood around the perimeter of the pool.
	float rim = clamp( body - smoothstep( lobe - 0.055, lobe - 0.085, rq ), 0.0, 1.0 );
	float wet = smoothstep( lobe * 0.85, lobe * 0.25, rq ) * body;

	// Kept genuinely dark. Blood has an albedo of a few percent; at 0.09 red
	// with nothing in green or blue it clips the red channel the moment the sun
	// hits it and reads as fluorescent spray paint rather than as fluid.
	vec3 deep = vec3( 0.052, 0.0072, 0.0062 );
	vec3 dried = vec3( 0.031, 0.0085, 0.0072 );
	d.albedo = mix( deep, dried, clamp( rim * 0.9 + ( 1.0 - body ) * 0.6, 0.0, 1.0 ) );
	// Flat inside, with only a little coagulation mottling.
	d.albedo *= 0.82 + 0.30 * fbm( p * 9.0 + seed * 2.0, 4 );
	d.alpha = mask;
	d.height = body * 0.30 + rim * 0.10;
	d.rough = mix( 0.62, 0.10, wet );
	return d;
}

/* ----------------------------------------------------------------- scorch -- */
Decal scorch( vec2 p, float seed ) {
	Decal d = defaults();
	float r = length( p );
	float ang = atan( p.y, p.x );
	vec2 dir = vec2( cos( ang ), sin( ang ) );

	float body = smoothstep( 0.68 + 0.22 * fbm( dir * 2.2 + seed, 5 ), 0.05, r );
	float soot = fbm( p * 5.0 + seed * 2.0, 5 );
	float fingers = smoothstep( 0.55, 0.0, spokes( p, 14.0, seed + 2.0, 5.0 ) ) * smoothstep( 1.0, 0.2, r );

	float mask = clamp( body * ( 0.55 + 0.65 * soot ) + fingers * 0.35, 0.0, 1.0 );
	d.albedo = mix( vec3( 0.055, 0.048, 0.044 ), vec3( 0.012 ), body );
	d.alpha = mask * 0.92;
	d.height = - mask * 0.08;
	d.rough = 0.97;
	return d;
}

Decal evaluate( int idx, vec2 p ) {
	float seed = float( idx ) * 13.37 + 1.0;
	if ( idx < 4 )  return holeHard( p, seed );
	if ( idx < 7 )  return holeMetal( p, seed );
	if ( idx < 10 ) return holeWood( p, seed );
	if ( idx < 12 ) return glassCrack( p, seed );
	if ( idx < 14 ) return holeSoft( p, seed );
	if ( idx < 18 ) return bloodSplat( p, seed );
	if ( idx < 20 ) return scorch( p, seed );
	// Spare slots reuse the hard/metal generators with fresh seeds so the
	// engine can always ask for more variety than the table strictly defines.
	if ( idx < 26 ) return holeHard( p, seed * 2.7 );
	return holeMetal( p, seed * 3.9 );
}

void main() {
	vec2 grid = vec2( ${ATLAS_COLS}.0, ${ATLAS_ROWS}.0 );
	vec2 cell = floor( vUv * grid );
	int idx = int( cell.y * grid.x + cell.x );
	vec2 local = fract( vUv * grid ) * 2.0 - 1.0;

	Decal d = evaluate( idx, local );

	// Feather the very edge of every cell so bilinear taps never bleed.
	float edge = 1.0 - smoothstep( 0.86, 0.995, max( abs( local.x ), abs( local.y ) ) );
	d.alpha *= edge;

	float e = 2.0 / ${ATLAS_CELL}.0;
	float hx = evaluate( idx, local + vec2( e, 0.0 ) ).height - evaluate( idx, local - vec2( e, 0.0 ) ).height;
	float hy = evaluate( idx, local + vec2( 0.0, e ) ).height - evaluate( idx, local - vec2( 0.0, e ) ).height;
	vec3 n = normalize( vec3( - hx * 5.0, - hy * 5.0, 1.0 ) );

	outAlbedo = vec4( d.albedo, clamp( d.alpha, 0.0, 1.0 ) );
	outNRM = vec4( n.xy * 0.5 + 0.5, clamp( d.rough, 0.0, 1.0 ), clamp( d.metal, 0.0, 1.0 ) );
}
`;

export interface DecalAtlasTextures {
  albedo: THREE.Texture;
  nrm: THREE.Texture;
}

export function bakeDecalAtlas(
  renderer: THREE.WebGLRenderer,
  blitter: FullscreenBlitter,
): { textures: DecalAtlasTextures; dispose(): void } {
  const w = ATLAS_COLS * ATLAS_CELL;
  const h = ATLAS_ROWS * ATLAS_CELL;

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
  target.textures[0].name = 'decal:albedo';
  target.textures[1].name = 'decal:nrm';
  for (const t of target.textures) {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  const mat = skipPatch(new THREE.ShaderMaterial({
    name: 'decal:bake',
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
    textures: { albedo: target.textures[0], nrm: target.textures[1] },
    dispose: () => target.dispose(),
  };
}
