/**
 * GLSL for the GPU particle engine.
 *
 * State lives in floating-point render targets and is advanced by a fragment
 * shader; nothing is read back to the CPU. Four textures describe a particle:
 *
 *   D0  xyz world position, w age (seconds)          ping-ponged, FloatType
 *   D1  xyz velocity,       w rotation (radians)     ping-ponged, FloatType
 *   S0  rgb tint,           a peak opacity           written once at spawn
 *   S1  x sizeBegin, y sizeEnd, z lifetime, w spin   written once at spawn
 *   S2  x drag, y gravityScale, z turbulence, w cell written once at spawn
 *   S3  x floorY, y emissive, z bounce, w flags      written once at spawn
 *
 * `cell` packs the atlas base index and the flipbook length as
 * `base + frames * 64`; `flags` is a bitfield (see FLAG_* in GpuParticles.ts).
 */

import { GLSL_AERIAL, GLSL_ATMOSPHERE, GLSL_COMMON, GLSL_SH, GLSL_SUN } from '../render/Glsl';
import { GBUFFER_PASSTHROUGH_DECL, GBUFFER_PASSTHROUGH_WRITE } from './Common';

/* ------------------------------------------------------------------ shared -- */

const FLAG_DECODE = /* glsl */ `
#define FX_MODEL_MASK   3
#define FX_ADD          4
#define FX_STRETCH      8
#define FX_ANIM         16
#define FX_COLLIDE      32
#define FX_FADEIN       64
#define FX_SHADOW       128
#define FX_FLICKER      256
#define FX_NOSOFT       512
#define FX_HOTRAMP      1024
`;

/** Divergence-free turbulence: each component depends only on the other axes,
 *  so the field has zero divergence by construction and never bunches up. */
const TURBULENCE = /* glsl */ `
vec3 fxTurbulence( vec3 p, float t ) {
	vec3 a = vec3(
		sin( p.y * 1.70 + t * 0.90 ) + cos( p.z * 1.10 - t * 0.60 ),
		sin( p.z * 1.30 - t * 0.70 ) + cos( p.x * 1.50 + t * 0.50 ),
		sin( p.x * 1.90 + t * 1.10 ) + cos( p.y * 1.20 - t * 0.80 )
	);
	vec3 b = vec3(
		sin( p.y * 4.30 - t * 1.90 ),
		sin( p.z * 3.70 + t * 2.10 ),
		sin( p.x * 4.10 - t * 1.70 )
	);
	return a * 0.42 + b * 0.22;
}
`;

/* --------------------------------------------------------------- simulation -- */

export const SIM_FRAG = /* glsl */ `
precision highp float;
${FLAG_DECODE}
${TURBULENCE}

in vec2 vUv;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outMotion;

uniform sampler2D tState;
uniform sampler2D tMotion;
uniform sampler2D tParam;
uniform sampler2D tPhys;
uniform sampler2D tExtra;

uniform float uDt;
uniform float uTime;
uniform vec3  uWind;
uniform float uTurbScale;

void main() {
	vec4 st = texture( tState, vUv );
	vec4 s1 = texture( tParam, vUv );
	float life = s1.z;
	float age = st.w;

	// A slot with no lifetime has never been used; an expired slot is parked so
	// the render pass can reject it with a single compare.
	if ( life <= 0.0 || age >= life ) {
		outState = vec4( st.xyz, max( age, life + 1.0 ) );
		outMotion = texture( tMotion, vUv );
		return;
	}

	vec4 mo = texture( tMotion, vUv );
	vec4 s2 = texture( tPhys, vUv );
	vec4 s3 = texture( tExtra, vUv );

	vec3 p = st.xyz;
	vec3 v = mo.xyz;
	float rot = mo.w;

	float drag = s2.x;
	float grav = s2.y;
	float turb = s2.z;
	float floorY = s3.x;
	float bounce = s3.z;
	int flags = int( s3.w + 0.5 );

	float dt = uDt;

	vec3 acc = vec3( 0.0, -9.81 * grav, 0.0 );
	// Wind couples through drag: a dust mote is carried, a chip of concrete is
	// not. Relative velocity keeps particles from overshooting the wind speed.
	acc += ( uWind - v ) * min( drag, 8.0 ) * 0.30;
	if ( turb > 0.0 ) acc += fxTurbulence( p * uTurbScale, uTime ) * turb;

	v += acc * dt;
	v *= exp( - drag * dt );
	p += v * dt;
	rot += s1.w * dt;

	if ( ( flags & FX_COLLIDE ) != 0 && p.y < floorY ) {
		p.y = floorY;
		if ( v.y < 0.0 ) {
			v.y = - v.y * bounce;
			v.xz *= 0.58;
			rot += 2.3 * bounce;
			// Settle rather than jitter forever on the floor.
			if ( abs( v.y ) < 0.30 ) { v.y = 0.0; v.xz *= 0.12; }
		}
	}

	outState = vec4( p, age + dt );
	outMotion = vec4( v, rot );
}
`;

/* -------------------------------------------------------------------- spawn -- */

export const SPAWN_VERT = /* glsl */ `
precision highp float;

in float aSlot;
in vec3 aPos;
in vec3 aVel;
in float aRot;
in vec4 aColor;
in vec4 aS1;
in vec4 aS2;
in vec4 aS3;

flat out vec3 fPos;
flat out vec3 fVel;
flat out float fRot;
flat out vec4 fColor;
flat out vec4 fS1;
flat out vec4 fS2;
flat out vec4 fS3;

uniform float uSide;

void main() {
	float x = mod( aSlot, uSide );
	float y = floor( aSlot / uSide );
	vec2 ndc = ( ( vec2( x, y ) + 0.5 ) / uSide ) * 2.0 - 1.0;
	gl_Position = vec4( ndc, 0.0, 1.0 );
	gl_PointSize = 1.0;
	fPos = aPos; fVel = aVel; fRot = aRot;
	fColor = aColor; fS1 = aS1; fS2 = aS2; fS3 = aS3;
}
`;

export const SPAWN_DYNAMIC_FRAG = /* glsl */ `
precision highp float;
flat in vec3 fPos;
flat in vec3 fVel;
flat in float fRot;
flat in vec4 fColor;
flat in vec4 fS1;
flat in vec4 fS2;
flat in vec4 fS3;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outMotion;
void main() {
	outState = vec4( fPos, 0.0 );
	outMotion = vec4( fVel, fRot );
}
`;

export const SPAWN_STATIC_FRAG = /* glsl */ `
precision highp float;
flat in vec3 fPos;
flat in vec3 fVel;
flat in float fRot;
flat in vec4 fColor;
flat in vec4 fS1;
flat in vec4 fS2;
flat in vec4 fS3;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outS1;
layout(location = 2) out vec4 outS2;
layout(location = 3) out vec4 outS3;
void main() {
	outColor = fColor;
	outS1 = fS1;
	outS2 = fS2;
	outS3 = fS3;
}
`;

/* ------------------------------------------------------------------- render -- */

export const RENDER_VERT = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${FLAG_DECODE}

uniform sampler2D tState;
uniform sampler2D tMotion;
uniform sampler2D tColor;
uniform sampler2D tParam;
uniform sampler2D tPhys;
uniform sampler2D tExtra;

uniform float uSide;
uniform float uInvSide;
uniform float uAdditivePass;
uniform float uCellScale;
uniform float uCellCols;
uniform float uFrameBlend;
uniform float uDt;
uniform float uSizeScale;
uniform float uStretch;

/* cascaded shadows — a single cheap PCF tap set, evaluated once per particle */
uniform sampler2D boShadowAtlas;
uniform mat4  boCsmMatrix[ 4 ];
uniform vec4  boCsmTile[ 4 ];
uniform vec4  boCsmParams[ 4 ];
uniform vec4  boCsmInfo;
uniform float boShadowStrength;
uniform mat4  boViewProjectionNoJitter;
uniform mat4  boPrevViewProjection;
uniform vec2  boResolution;

out vec4 vColor;
out vec2 vQuad;
out vec4 vAtlas;      // frame A uv offset, frame B uv offset
out vec4 vMisc;       // t, viewZ, softDist, sunShadow
out vec4 vExtra;      // frameBlend, emissive, density, sizeMetres
out vec3 vWorldPos;
out vec3 vRightW;
out vec3 vUpW;
out vec4 vVelClip;    // xy current clip, zw previous clip (for the velocity buffer)
flat out int vModel;
flat out int vFlags;

float fxParticleShadow( vec3 wp, float viewDepth ) {
	int count = int( boCsmInfo.x );
	if ( count <= 0 || boShadowStrength <= 0.0 ) return 1.0;
	if ( viewDepth > boCsmInfo.z ) return 1.0;
	int c = count - 1;
	for ( int i = 0; i < 4; i ++ ) {
		if ( i >= count ) break;
		if ( viewDepth < boCsmParams[ i ].w ) { c = i; break; }
	}
	vec4 lp = boCsmMatrix[ c ] * vec4( wp, 1.0 );
	vec3 uvd = lp.xyz;
	if ( uvd.z <= 0.0 || uvd.z >= 1.0 ) return 1.0;
	if ( any( lessThan( uvd.xy, vec2( 0.004 ) ) ) || any( greaterThan( uvd.xy, vec2( 0.996 ) ) ) ) return 1.0;
	vec4 tile = boCsmTile[ c ];
	vec2 base = tile.xy + uvd.xy * tile.zw;
	float texelW = boCsmParams[ c ].z;
	float zRange = boCsmParams[ c ].y;
	float bias = ( texelW * 3.5 ) / max( zRange, 1e-3 );
	float uvPerMetre = tile.z / max( boCsmParams[ c ].x, 1e-3 );
	float rad = texelW * 2.5 * uvPerMetre;
	float s = 0.0;
	for ( int i = 0; i < 4; i ++ ) {
		vec2 o = BO_POISSON16[ i * 4 ] * rad;
		float d = textureLod( boShadowAtlas, clamp( base + o, tile.xy, tile.xy + tile.zw ), 0.0 ).r;
		s += step( uvd.z - bias, d );
	}
	return mix( 1.0, s * 0.25, boShadowStrength );
}

void main() {
	int id = gl_InstanceID;
	float fid = float( id );
	vec2 texel = ( vec2( mod( fid, uSide ), floor( fid * uInvSide ) ) + 0.5 ) * uInvSide;

	vec4 s1 = texture( tParam, texel );
	vec4 st = texture( tState, texel );
	float life = s1.z;
	float age = st.w;
	vec4 s3 = texture( tExtra, texel );
	int flags = int( s3.w + 0.5 );
	bool additive = ( flags & FX_ADD ) != 0;

	// One instance buffer feeds two draws; reject the half that belongs to the
	// other blend mode by collapsing the quad outside the frustum.
	if ( life <= 0.0 || age >= life || additive != ( uAdditivePass > 0.5 ) ) {
		gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
		vColor = vec4( 0.0 );
		vQuad = vec2( 0.0 );
		vAtlas = vec4( 0.0 );
		vMisc = vec4( 0.0 );
		vExtra = vec4( 0.0 );
		vWorldPos = vec3( 0.0 );
		vRightW = vec3( 1.0, 0.0, 0.0 );
		vUpW = vec3( 0.0, 1.0, 0.0 );
		vVelClip = vec4( 0.0 );
		vModel = 0;
		vFlags = 0;
		return;
	}

	vec4 mo = texture( tMotion, texel );
	vec4 s0 = texture( tColor, texel );
	vec4 s2 = texture( tPhys, texel );

	float t = clamp( age / life, 0.0, 1.0 );
	int model = flags & FX_MODEL_MASK;

	/* ---- size. Media expands violently in the first hundred milliseconds and
	   then coasts — that initial punch is most of what sells an impact — while
	   solids and sparks keep a near-linear curve. */
	float growExp = ( model == 0 || model == 3 ) ? 3.4 : 1.4;
	float grow = 1.0 - pow( 1.0 - t, growExp );
	float size = mix( s1.x, s1.y, grow ) * uSizeScale;

	/* ---- opacity envelope */
	float fadeIn = ( flags & FX_FADEIN ) != 0 ? smoothstep( 0.0, 0.13, t ) : 1.0;
	float fadeOut;
	if ( model == 1 ) fadeOut = pow( 1.0 - t, 1.5 );
	else if ( model == 2 ) fadeOut = 1.0 - smoothstep( 0.74, 1.0, t );
	else fadeOut = 1.0 - smoothstep( 0.50, 1.0, t );
	float alpha = s0.a * fadeIn * fadeOut;

	if ( ( flags & FX_FLICKER ) != 0 ) {
		float ph = fract( fid * 0.6180339887 ) * 6.2831853;
		alpha *= 0.45 + 0.55 * ( 0.5 + 0.5 * sin( age * 34.0 + ph ) );
	}

	/* ---- colour: hot particles cool as they age */
	vec3 tint = s0.rgb;
	if ( ( flags & FX_HOTRAMP ) != 0 ) {
		// A spark leaves the steel white-hot and cools through orange to a
		// dull red ember. Cool it too fast and the whole shower is gone in
		// 200 ms; too slowly and every spark reads as a laser.
		float heat = pow( 1.0 - t, 1.55 );
		tint = mix( vec3( 0.70, 0.085, 0.014 ), tint, heat );
		tint += vec3( 0.85, 0.46, 0.16 ) * pow( heat, 3.0 );
	}
	vColor = vec4( tint, alpha );

	/* ---- billboard basis, in view space */
	vec3 p = st.xyz;
	vec3 viewPos = ( viewMatrix * vec4( p, 1.0 ) ).xyz;
	float rot = mo.w;
	float cs = cos( rot ), sn = sin( rot );
	vec2 right2 = vec2( cs, sn );
	vec2 up2 = vec2( - sn, cs );
	float w = size;
	float h = size;

	if ( ( flags & FX_STRETCH ) != 0 ) {
		vec3 vv = ( viewMatrix * vec4( mo.xyz, 0.0 ) ).xyz;
		vec2 d = vv.xy;
		float len = length( d );
		if ( len > 1e-4 ) {
			up2 = d / len;
			right2 = vec2( up2.y, - up2.x );
		}
		// Stretch by the distance travelled in one frame — a physically honest
		// motion streak rather than an arbitrary constant.
		float speed = length( mo.xyz );
		h = size + speed * uDt * uStretch;
		w = size * 0.85;
	}

	vec2 corner = position.xy;
	vec2 offset = right2 * ( corner.x * w ) + up2 * ( corner.y * h );
	viewPos.xy += offset;

	mat3 vinv = mat3(
		viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ],
		viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ],
		viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ]
	);
	vRightW = vinv * vec3( right2, 0.0 );
	vUpW = vinv * vec3( up2, 0.0 );
	vWorldPos = p + vRightW * ( corner.x * w ) + vUpW * ( corner.y * h );

	gl_Position = projectionMatrix * vec4( viewPos, 1.0 );

	/* ---- atlas frame (with cross-fade between consecutive frames) */
	float cellInfo = s2.w;
	float frames = max( floor( cellInfo / 64.0 ), 1.0 );
	float base = cellInfo - frames * 64.0;
	float fpos;
	if ( ( flags & FX_ANIM ) != 0 ) {
		fpos = t * ( frames - 0.001 );
	} else {
		fpos = floor( fract( fid * 0.7548776662 ) * frames );
	}
	float f0 = floor( fpos );
	float f1 = min( f0 + 1.0, frames - 1.0 );
	float blend = ( flags & FX_ANIM ) != 0 ? ( fpos - f0 ) * uFrameBlend : 0.0;
	vec2 c0 = vec2( mod( base + f0, uCellCols ), floor( ( base + f0 ) / uCellCols ) );
	vec2 c1 = vec2( mod( base + f1, uCellCols ), floor( ( base + f1 ) / uCellCols ) );
	vAtlas = vec4( c0 * uCellScale, c1 * uCellScale );

	/* ---- shading inputs */
	float viewZ = - viewPos.z;
	// Soft-particle range has to stay well under the sprite radius: an impact
	// puff is born *on* the wall, and a fade proportional to its full size
	// would erase the first hundred milliseconds of every effect.
	float softDist = clamp( size * 0.35, 0.05, 1.2 );
	float shadow = ( flags & FX_SHADOW ) != 0 ? fxParticleShadow( p, viewZ ) : 1.0;
	vMisc = vec4( t, viewZ, softDist, shadow );
	// Fraction of the frame height this sprite covers. The render pass uses
	// it to stop a small solid sprite that has drifted near the lens from owning a
	// quarter of the screen.
	float screenFrac = size * projectionMatrix[ 1 ][ 1 ] / max( viewZ * 2.0, 1e-3 );
	vExtra = vec4( blend, s3.y, screenFrac, size );
	vQuad = corner * 2.0;
	vModel = model;
	vFlags = flags;

	/* ---- screen-space velocity for the renderer's temporal passes */
	vec4 cur = boViewProjectionNoJitter * vec4( vWorldPos, 1.0 );
	vec4 prv = boPrevViewProjection * vec4( vWorldPos - mo.xyz * uDt, 1.0 );
	vVelClip = vec4(
		cur.xy / max( abs( cur.w ), 1e-5 ) * sign( cur.w ),
		prv.xy / max( abs( prv.w ), 1e-5 ) * sign( prv.w )
	);
}
`;

export const RENDER_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SH}
${GLSL_SUN}
${GLSL_AERIAL}
${FLAG_DECODE}

in vec4 vColor;
in vec2 vQuad;
in vec4 vAtlas;
in vec4 vMisc;
in vec4 vExtra;
in vec3 vWorldPos;
in vec3 vRightW;
in vec3 vUpW;
in vec4 vVelClip;
flat in int vModel;
flat in int vFlags;

layout(location = 0) out vec4 outColor;
${GBUFFER_PASSTHROUGH_DECL}

uniform sampler2D tAtlasA;
uniform sampler2D tAtlasB;
uniform sampler2D boSceneDepth;
uniform vec4 boCameraParams;
uniform vec2 boResolution;
// boSunDirWorld / boSunDirView / boSunColor arrive with GLSL_SUN, which
// GLSL_AERIAL pulls in above. Re-declaring them here is a GLSL redefinition
// error that silently kills the entire particle pass.
uniform vec3 boAmbientSH[ 9 ];
uniform vec3 boAmbientTint;
uniform float boAmbientIntensity;
uniform float uCellScale;
uniform float uAdditivePass;
uniform float uSoft;
uniform float uAerial;
uniform float uNormalStrength;
uniform float uExposureHint;

void main() {
	vec2 uv01 = vQuad * 0.5 + 0.5;
	vec2 uvA = vAtlas.xy + uv01 * uCellScale;
	vec4 A = texture( tAtlasA, uvA );
	vec4 B = texture( tAtlasB, uvA );

	float blend = vExtra.x;
	if ( blend > 0.001 ) {
		vec2 uvB = vAtlas.zw + uv01 * uCellScale;
		A = mix( A, texture( tAtlasA, uvB ), blend );
		B = mix( B, texture( tAtlasB, uvB ), blend );
	}

	float alpha = A.a * vColor.a;
	if ( alpha < 0.0025 ) discard;

	float viewZ = vMisc.y;

	// --- soft particles: fade out where the sprite intersects solid geometry
	if ( uSoft > 0.5 && ( vFlags & FX_NOSOFT ) == 0 ) {
		vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
		float d = texture( boSceneDepth, suv ).r;
		float sceneZ = boLinearDepth( d, boCameraParams.x, boCameraParams.y );
		alpha *= boSat( ( sceneZ - viewZ ) / vMisc.z );
	}
	// Never let a sprite slam into the near plane.
	alpha *= boSat( ( viewZ - boCameraParams.x * 2.0 ) / max( vExtra.w * 0.7, 0.08 ) );
	// Small solids -- chips, splinters, wind-blown scraps -- are the one
	// class that routinely drifts *into* the lens. At half a metre a 6 cm
	// scrap covers a tenth of the frame and reads as dirt on the glass, so
	// fade them out across the last couple of metres instead.
	// Small-particle classes: solid chunks (chips, splinters, scraps, shards) and
	// thin films (droplets, motes). Media — smoke and dust puffs — is exempt:
	// being metres across and filling the frame is the whole point of a puff.
	if ( vModel == 2 || vModel == 3 ) {
		alpha *= boSat( ( viewZ - 0.8 ) * 0.72 );
		// Hard screen-coverage ceiling. Whatever a chip's world size and however
		// it got there, once one sprite owns more than a few per cent of the
		// frame it has stopped being debris and started being a smudge on the
		// lens — which is the single most recognisable particle-system tell.
		alpha *= 1.0 - boSat( ( vExtra.z - 0.012 ) / 0.022 );
	}
	if ( alpha < 0.0025 ) discard;

	vec3 albedo = vColor.rgb * A.rgb;
	vec3 lit;

	if ( vModel == 1 ) {
		// --- emissive: the atlas already carries the hot/cool gradient. Kept
		// in the 3–20 range so bloom has something to find without the
		// auto-exposure histogram clamping the whole scene down.
		lit = albedo * ( 0.30 + B.a * 0.95 + vExtra.y * 1.6 );
	} else {
		// --- hemispherical normal from the quad, perturbed by the baked normal
		float r2 = dot( vQuad, vQuad );
		vec3 nq = vec3( vQuad, sqrt( max( 1.0 - min( r2, 1.0 ), 0.02 ) ) );
		nq.xy += ( B.rg * 2.0 - 1.0 ) * uNormalStrength;
		nq = normalize( nq );
		vec3 fwdW = normalize( cross( vRightW, vUpW ) );
		vec3 N = normalize( vRightW * nq.x + vUpW * nq.y + fwdW * nq.z );

		vec3 V = normalize( cameraPosition - vWorldPos );
		float ndl = dot( N, boSunDirWorld );

		// Wrapped diffuse: a particle is a lump of participating media, not a
		// surface, so light bends past the terminator — but not so far that the
		// volume loses its bright and dark side, which is the whole read.
		float wrap = boSat( ( ndl + 0.52 ) / 1.52 );
		float thickness = B.b;
		float shadow = vMisc.w;

		// Sky/bounce fill. A puff sees the sky from above and the ground from
		// below, so the SH lookup already gives it a cool top and a warm floor
		// bounce; pushing the normal toward vertical stops the fill flattening
		// out as the billboard turns.
		vec3 ambN = normalize( N + vec3( 0.0, 0.55, 0.0 ) );
		vec3 amb = boShIrradiance( ambN, boAmbientSH ) * boAmbientTint * boAmbientIntensity;
		// Deeper inside the puff, less sky reaches: ambient occlusion for media.
		amb *= mix( 1.0, 0.42, thickness );

		// Beer-Lambert through the puff along the light path. The exponent runs
		// from "thin edge, fully lit" to "dense core on the far side, dark".
		float depth = thickness * ( 0.55 + 2.85 * ( 1.0 - wrap ) );
		float selfShadow = exp( - depth * 1.9 );

		vec3 sun = boSunColor * ( wrap * selfShadow * shadow );

		// Henyey-Greenstein forward lobe. Backlit smoke glowing around its rim
		// is the single most recognisable thing about real smoke on film, and a
		// proper phase function keeps that glow broad instead of a hot dot.
		float mu = boSat( dot( - V, boSunDirWorld ) );
		const float G = 0.62;
		float hg = ( 1.0 - G * G ) / pow( 1.0 + G * G - 2.0 * G * mu, 1.5 );
		// Transmission falls off with optical depth — a thin wisp glows, the
		// dense core stays dark, and that contrast is what gives smoke volume.
		float transmit = exp( - thickness * 2.35 );
		sun += boSunColor * hg * transmit * shadow * 0.42;

		// boSunColor is illuminance; a scattering lobe converts it to radiance.
		// The extra hold-down is deliberate: pale dust really is ~3x brighter
		// than dark asphalt, but at the exposure the frame graph settles on,
		// that clips every bit of internal structure to flat white.
		sun *= BO_INV_PI * 0.62;
		amb *= 0.72;

		if ( vModel == 2 ) {
			// Solid chunk: a proper lambert term plus a tight sheen on the edge.
			float nl = boSat( ndl );
			sun = boSunColor * ( nl * 0.9 + 0.10 ) * shadow * BO_INV_PI;
			float rim = pow( 1.0 - boSat( nq.z ), 3.0 );
			sun += boSunColor * rim * 0.30 * shadow * BO_INV_PI;
			amb = boShIrradiance( N, boAmbientSH ) * boAmbientTint * boAmbientIntensity * 0.85;
		} else if ( vModel == 3 ) {
			// Thin translucent film (blood mist, spray, dust motes): almost all
			// of what you see is light coming *through* it.
			sun = boSunColor * ( wrap * 0.55 + 0.10 ) * shadow * BO_INV_PI * 0.9;
			sun += boSunColor * hg * shadow * BO_INV_PI * 0.85;
		} else {
			// Volumetric break-up. Thirty overlapping billboards average out to
			// a uniform slab no matter how good the individual sprite is; a
			// low-frequency world-space field puts lumps of light and shadow
			// *through* the cloud, which is what gives it interior.
			float vol = boFbm( vWorldPos * 0.38 + vec3( 11.0, 3.0, 7.0 ), 3 );
			float vol2 = boFbm( vWorldPos * 1.35 + vec3( 2.0, 9.0, 4.0 ), 2 );
			sun *= 0.42 + 1.35 * vol;
			amb *= 0.78 + 0.34 * vol2;
		}

		lit = albedo * ( sun + amb ) + albedo * vExtra.y * 1.2;
	}

	// Aerial perspective only makes sense for media that occludes; adding fog
	// in-scatter to an additive sprite would just wash it out.
	if ( uAerial > 0.5 && uAdditivePass < 0.5 ) {
		lit = boAerialPerspective( lit, vWorldPos, cameraPosition, boSunDirWorld );
	}

	if ( uAdditivePass > 0.5 ) {
		outColor = vec4( lit * alpha * uExposureHint, 0.0 );
		fxGNormal = vec4( 0.0 );
		fxGVelocity = vec4( 0.0 );
		fxGMaterial = vec4( 0.0 );
	} else {
		outColor = vec4( lit * alpha, alpha );
		// Every extra attachment is left strictly untouched. Writing particle
		// motion vectors here is tempting — it would stop TAA ghosting fast
		// smoke — but the motion-blur pass then smears the *geometry behind*
		// the particle along the particle's velocity, which turns a dust cloud
		// into a radial streak across the whole frame.
		fxGNormal = vec4( 0.0 );
		fxGVelocity = vec4( 0.0 );
		fxGMaterial = vec4( 0.0 );
	}
}
`;

export const GBUFFER_WRITE_SNIPPET = GBUFFER_PASSTHROUGH_WRITE;
