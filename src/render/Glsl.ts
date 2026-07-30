/**
 * Shared GLSL building blocks for the render module.
 *
 * Every string here is a self-contained, include-guarded chunk that can be
 * concatenated into either a hand-written ShaderMaterial (GLSL3) or injected
 * into a stock three.js material through onBeforeCompile. Keeping them as
 * plain strings (rather than .glsl files) means the whole shading model is
 * diffable next to the TypeScript that drives it.
 *
 * Naming convention: everything is prefixed bo / BO_ so injected code can
 * never collide with three's own identifiers.
 */

/* ------------------------------------------------------------------ common -- */

export const GLSL_COMMON = /* glsl */ `
#ifndef BO_COMMON
#define BO_COMMON

const float BO_PI = 3.141592653589793;
const float BO_INV_PI = 0.3183098861837907;

float boLuma( const in vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float boSat( const in float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  boSat3( const in vec3 x ) { return clamp( x, vec3( 0.0 ), vec3( 1.0 ) ); }

/** Interleaved gradient noise — cheap, temporally stable per-pixel dither. */
float boIGN( const in vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

float boHash12( in vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 boHash22( in vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}

vec3 boHash33( in vec3 p ) {
	p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ),
	          dot( p, vec3( 269.5, 183.3, 246.1 ) ),
	          dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
	return fract( sin( p ) * 43758.5453123 );
}

float boValueNoise( in vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	float n000 = boHash33( i + vec3( 0.0, 0.0, 0.0 ) ).x;
	float n100 = boHash33( i + vec3( 1.0, 0.0, 0.0 ) ).x;
	float n010 = boHash33( i + vec3( 0.0, 1.0, 0.0 ) ).x;
	float n110 = boHash33( i + vec3( 1.0, 1.0, 0.0 ) ).x;
	float n001 = boHash33( i + vec3( 0.0, 0.0, 1.0 ) ).x;
	float n101 = boHash33( i + vec3( 1.0, 0.0, 1.0 ) ).x;
	float n011 = boHash33( i + vec3( 0.0, 1.0, 1.0 ) ).x;
	float n111 = boHash33( i + vec3( 1.0, 1.0, 1.0 ) ).x;
	return mix( mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
	            mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}

float boFbm( in vec3 p, const in int octaves ) {
	float a = 0.5, s = 0.0;
	for ( int i = 0; i < 8; i ++ ) {
		if ( i >= octaves ) break;
		s += a * boValueNoise( p );
		p *= 2.02;
		a *= 0.5;
	}
	return s;
}

/** Linear eye depth from a hardware depth sample (perspective projection). */
float boLinearDepth( const in float d, const in float n, const in float f ) {
	float z = d * 2.0 - 1.0;
	return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

/** Pack a value in [0,1] into two 8-bit channels (16-bit precision). */
vec2 boPack16( const in float v ) {
	float x = clamp( v, 0.0, 1.0 ) * 65535.0;
	float hi = floor( x / 256.0 );
	float lo = x - hi * 256.0;
	return vec2( hi, lo ) / 255.0;
}
float boUnpack16( const in vec2 p ) {
	return ( p.x * 255.0 * 256.0 + p.y * 255.0 ) / 65535.0;
}

/** 16-tap Poisson disc, blue-noise-ish distribution. */
const vec2 BO_POISSON16[ 16 ] = vec2[ 16 ](
	vec2( -0.94201624, -0.39906216 ), vec2(  0.94558609, -0.76890725 ),
	vec2( -0.09418410, -0.92938870 ), vec2(  0.34495938,  0.29387760 ),
	vec2( -0.91588581,  0.45771432 ), vec2( -0.81544232, -0.87912464 ),
	vec2( -0.38277543,  0.27676845 ), vec2(  0.97484398,  0.75648379 ),
	vec2(  0.44323325, -0.97511554 ), vec2(  0.53742981, -0.47373420 ),
	vec2( -0.26496911, -0.41893023 ), vec2(  0.79197514,  0.19090188 ),
	vec2( -0.24188840,  0.99706507 ), vec2( -0.81409955,  0.91437590 ),
	vec2(  0.19984126,  0.78641367 ), vec2(  0.14383161, -0.14100790 )
);

#endif
`;

/* ------------------------------------------------------------- tone mapping -- */

export const GLSL_TONEMAP = /* glsl */ `
#ifndef BO_TONEMAP
#define BO_TONEMAP

// AgX — Troy Sobotka's display transform (the variant shipped in Blender 4.x).
// Gives filmic highlight roll-off with far better hue stability than ACES.
const mat3 BO_AGX_IN = mat3(
	0.8567656, 0.0951212, 0.0482131,
	0.1372625, 0.7612156, 0.1015741,
	0.1118217, 0.0767996, 0.8113786
);
const mat3 BO_AGX_OUT = mat3(
	 1.1271005, -0.1413297, -0.1413297,
	-0.1106067,  1.1578237, -0.1106067,
	-0.0164939, -0.0164939,  1.2519364
);

vec3 boAgxContrast( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return  15.5 * x4 * x2
	      - 40.14 * x4 * x
	      + 31.96 * x4
	      - 6.868 * x2 * x
	      + 0.4298 * x2
	      + 0.1191 * x
	      - 0.00232;
}

vec3 boTonemapAgX( vec3 color ) {
	const float minEv = -12.47393;
	const float maxEv = 4.026069;
	color = max( color, vec3( 0.0 ) );
	color = BO_AGX_IN * color;
	color = clamp( log2( max( color, vec3( 1e-10 ) ) ), vec3( minEv ), vec3( maxEv ) );
	color = ( color - minEv ) / ( maxEv - minEv );
	color = boAgxContrast( color );
	// "Punchy" look: a touch of saturation restored after the sigmoid.
	float l = boLuma( color );
	color = l + 1.18 * ( color - l );
	color = BO_AGX_OUT * color;
	return max( color, vec3( 0.0 ) );
}

// ACES fitted RRT+ODT (Stephen Hill).
const mat3 BO_ACES_IN = mat3(
	0.59719, 0.07600, 0.02840,
	0.35458, 0.90834, 0.13383,
	0.04823, 0.01566, 0.83777
);
const mat3 BO_ACES_OUT = mat3(
	 1.60475, -0.10208, -0.00327,
	-0.53108,  1.10813, -0.07276,
	-0.07367, -0.00605,  1.07602
);

vec3 boTonemapACES( vec3 color ) {
	color = BO_ACES_IN * color;
	vec3 a = color * ( color + 0.0245786 ) - 0.000090537;
	vec3 b = color * ( 0.983729 * color + 0.4329510 ) + 0.238081;
	color = BO_ACES_OUT * ( a / b );
	return max( color, vec3( 0.0 ) );
}

vec3 boTonemapReinhard( vec3 color ) {
	float l = boLuma( color );
	float lw = l * ( 1.0 + l / ( 4.0 * 4.0 ) ) / ( 1.0 + l );
	return color * ( lw / max( l, 1e-5 ) );
}

vec3 boTonemap( vec3 c, int mode ) {
	if ( mode == 0 ) return boTonemapAgX( c );
	if ( mode == 1 ) return boTonemapACES( c );
	if ( mode == 2 ) return boTonemapReinhard( c );
	return c;
}

vec3 boLinearToSRGB( vec3 c ) {
	c = max( c, vec3( 0.0 ) );
	return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}

#endif
`;

/* ------------------------------------------------------------------- sky -- */

/**
 * Single-scattering Rayleigh/Mie atmosphere.
 *
 * Ray-marched in a spherical shell; the light ray at every sample accumulates
 * its own optical depth so twilight, the horizon gradient and the Mie halo all
 * fall out of the physics instead of being faked. Only ever evaluated into a
 * cubemap (once per time-of-day change), never per-pixel per-frame.
 */
export const GLSL_ATMOSPHERE = /* glsl */ `
#ifndef BO_ATMOSPHERE
#define BO_ATMOSPHERE

const float BO_Rg = 6360000.0;   // ground radius (m)
const float BO_Rt = 6460000.0;   // atmosphere top (m)
const float BO_Hr = 8000.0;      // Rayleigh scale height
const float BO_Hm = 1200.0;      // Mie scale height
const vec3  BO_BETA_R = vec3( 5.8e-6, 13.5e-6, 33.1e-6 );

/** Distance to the far intersection with a sphere of the given radius, or -1. */
float boRaySphereFar( vec3 ro, vec3 rd, float r ) {
	float b = dot( ro, rd );
	float c = dot( ro, ro ) - r * r;
	float d = b * b - c;
	if ( d < 0.0 ) return -1.0;
	return - b + sqrt( d );
}

float boRaySphereNear( vec3 ro, vec3 rd, float r ) {
	float b = dot( ro, rd );
	float c = dot( ro, ro ) - r * r;
	float d = b * b - c;
	if ( d < 0.0 ) return -1.0;
	d = sqrt( d );
	float t0 = - b - d;
	float t1 = - b + d;
	if ( t1 < 0.0 ) return -1.0;
	return t0 < 0.0 ? -1.0 : t0;
}

float boPhaseRayleigh( float mu ) {
	return ( 3.0 / ( 16.0 * BO_PI ) ) * ( 1.0 + mu * mu );
}

float boPhaseMie( float mu, float g ) {
	float g2 = g * g;
	float denom = 1.0 + g2 - 2.0 * g * mu;
	return ( 3.0 / ( 8.0 * BO_PI ) ) * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) )
	     / ( ( 2.0 + g2 ) * max( pow( denom, 1.5 ), 1e-4 ) );
}

/**
 * In-scattered radiance along rd from an observer altitude metres up.
 * betaM is the Mie scattering coefficient (turbidity/haze).
 */
vec3 boAtmosphere(
	vec3 rd, float altitude, vec3 sunDir, float sunIntensity,
	float betaM, float mieG, out vec3 transmittance
) {
	const int STEPS = 20;
	const int LSTEPS = 6;

	vec3 ro = vec3( 0.0, BO_Rg + max( altitude, 1.0 ), 0.0 );
	float tMax = boRaySphereFar( ro, rd, BO_Rt );
	if ( tMax <= 0.0 ) { transmittance = vec3( 1.0 ); return vec3( 0.0 ); }
	float tGround = boRaySphereNear( ro, rd, BO_Rg );
	if ( tGround > 0.0 ) tMax = min( tMax, tGround );

	float segLen = tMax / float( STEPS );
	float t = 0.0;
	vec3 sumR = vec3( 0.0 );
	vec3 sumM = vec3( 0.0 );
	float odR = 0.0;
	float odM = 0.0;
	vec3 betaMv = vec3( betaM );

	for ( int i = 0; i < STEPS; i ++ ) {
		vec3 p = ro + rd * ( t + segLen * 0.5 );
		float h = length( p ) - BO_Rg;
		float hr = exp( - h / BO_Hr ) * segLen;
		float hm = exp( - h / BO_Hm ) * segLen;
		odR += hr;
		odM += hm;

		float tl = boRaySphereFar( p, sunDir, BO_Rt );
		if ( tl > 0.0 ) {
			float lseg = tl / float( LSTEPS );
			float lodR = 0.0;
			float lodM = 0.0;
			bool blocked = false;
			for ( int j = 0; j < LSTEPS; j ++ ) {
				vec3 lp = p + sunDir * ( lseg * ( float( j ) + 0.5 ) );
				float lh = length( lp ) - BO_Rg;
				if ( lh < 0.0 ) { blocked = true; break; }
				lodR += exp( - lh / BO_Hr ) * lseg;
				lodM += exp( - lh / BO_Hm ) * lseg;
			}
			if ( ! blocked ) {
				vec3 tau = BO_BETA_R * ( odR + lodR ) + betaMv * 1.1 * ( odM + lodM );
				vec3 att = exp( - tau );
				sumR += att * hr;
				sumM += att * hm;
			}
		}
		t += segLen;
	}

	transmittance = exp( - ( BO_BETA_R * odR + betaMv * 1.1 * odM ) );

	float mu = dot( rd, sunDir );
	return sunIntensity * (
		sumR * BO_BETA_R * boPhaseRayleigh( mu ) +
		sumM * betaMv * boPhaseMie( mu, mieG )
	);
}

/** Atmospheric transmittance from the ground straight out along dir. */
vec3 boSunTransmittance( float altitude, vec3 dir, float betaM ) {
	vec3 ro = vec3( 0.0, BO_Rg + max( altitude, 1.0 ), 0.0 );
	float tMax = boRaySphereFar( ro, dir, BO_Rt );
	if ( tMax <= 0.0 ) return vec3( 0.0 );
	const int STEPS = 12;
	float seg = tMax / float( STEPS );
	float odR = 0.0;
	float odM = 0.0;
	for ( int i = 0; i < STEPS; i ++ ) {
		vec3 p = ro + dir * ( seg * ( float( i ) + 0.5 ) );
		float h = max( length( p ) - BO_Rg, 0.0 );
		odR += exp( - h / BO_Hr ) * seg;
		odM += exp( - h / BO_Hm ) * seg;
	}
	return exp( - ( BO_BETA_R * odR + vec3( betaM ) * 1.1 * odM ) );
}

#endif
`;

/* --------------------------------------------------------------- SH probe -- */

export const GLSL_SH = /* glsl */ `
#ifndef BO_SH
#define BO_SH

/**
 * Irradiance from 9 pre-convolved SH coefficients. The CPU side already folded
 * the cosine lobe and 1/PI into the coefficients, so this is a plain dot.
 */
vec3 boShIrradiance( const in vec3 n, const in vec3 sh[ 9 ] ) {
	float x = n.x, y = n.y, z = n.z;
	vec3 r = sh[ 0 ];
	r += sh[ 1 ] * y;
	r += sh[ 2 ] * z;
	r += sh[ 3 ] * x;
	r += sh[ 4 ] * ( x * y );
	r += sh[ 5 ] * ( y * z );
	r += sh[ 6 ] * ( 3.0 * z * z - 1.0 );
	r += sh[ 7 ] * ( x * z );
	r += sh[ 8 ] * ( x * x - y * y );
	return max( r, vec3( 0.0 ) );
}

#endif
`;

/* ------------------------------------------------------- cascaded shadows -- */

export const GLSL_CSM = /* glsl */ `
#ifndef BO_CSM
#define BO_CSM

#define BO_CSM_MAX 4

uniform sampler2D boShadowAtlas;
uniform mat4  boCsmMatrix[ BO_CSM_MAX ];   // world -> cascade [0,1]^3
uniform vec4  boCsmTile[ BO_CSM_MAX ];     // xy atlas offset, zw atlas scale
uniform vec4  boCsmParams[ BO_CSM_MAX ];   // x worldExtent(m) y zRange(m) z texelWorld(m) w splitFar(view m)
uniform vec4  boCsmInfo;                   // x count, y tan(sunAngularRadius), z shadowDistance, w mapSize
uniform float boShadowStrength;
/** Per-frame rotation offset for the sampling kernels; TAA averages it out. */
uniform float boFrameJitter;

float boCascadeSample( const in int c, const in vec3 wp, const in float NdotL, const in float rot ) {

	vec4 lp = boCsmMatrix[ c ] * vec4( wp, 1.0 );
	vec3 uvd = lp.xyz;
	if ( uvd.z <= 0.0 || uvd.z >= 1.0 ) return 1.0;
	if ( any( lessThan( uvd.xy, vec2( 0.002 ) ) ) || any( greaterThan( uvd.xy, vec2( 0.998 ) ) ) ) return 1.0;

	vec4 tile = boCsmTile[ c ];
	vec2 base = tile.xy + uvd.xy * tile.zw;

	float extent = boCsmParams[ c ].x;
	float zRange = boCsmParams[ c ].y;
	float texelW = boCsmParams[ c ].z;

	// Slope-scaled depth bias in metres, converted to normalised depth.
	float slope = clamp( tan( acos( clamp( NdotL, 0.02, 1.0 ) ) ), 0.0, 6.0 );
	float biasM = texelW * ( 0.85 + 1.25 * slope );
	float bias = biasM / max( zRange, 1e-3 );

	float uvPerMetre = tile.z / max( extent, 1e-3 );
	float texelUV = uvPerMetre * texelW;

	vec2 tileMin = tile.xy + texelUV;
	vec2 tileMax = tile.xy + tile.zw - texelUV;

	float ca = cos( rot ), sa = sin( rot );
	mat2 rm = mat2( ca, sa, - sa, ca );

	float tanSun = boCsmInfo.y;

	// The widest penumbra this cascade may produce, in metres.
	//
	// This used to be clamp( texelW * 8, 0.10, 0.80 ) — a floor of ten centimetres
	// and a ceiling of eighty. The sun's penumbra only reaches ten centimetres
	// once the occluder is ten metres away from what it is shading, so that floor
	// was applied to *every* shadow in the level: a kerb, a bench leg, a lamppost
	// and a crate all got blurred by a disc wider than the shadow itself and came
	// back as a 40% grey wash with no edge. Rendering the same frame with a
	// single-texel filter brought back the lamppost stripe, the kerb line and
	// every crate shadow immediately, which is what proved this was the culprit
	// rather than missing casters or a bad frustum fit.
	//
	// The ceiling now tracks the cascade's own texel (so a far cascade still gets
	// a cheap, blur-limited filter) but the *floor* is sub-texel, so contact
	// shadows stay as sharp as the map allows.
	float maxFilterM = clamp( texelW * 5.0, 0.03, 0.30 );

	// ---- blocker search (PCSS step 1)
	//
	// An 8-tap search only finds an occluder whose shadow covers a decent
	// fraction of the search disc, so a metre-scale radius is statistically
	// blind to poles, railings, benches and crates — every one of them reports
	// "no blocker" and the surface comes back fully lit. A couple of texels is
	// both the smallest useful radius and the largest one that still resolves
	// prop-sized casters, so the radius simply tracks the cascade's texel.
	float searchM = clamp( texelW * 2.0, 0.02, 0.22 );
	float searchUV = searchM * uvPerMetre;
	float blockerSum = 0.0;
	float blockerCount = 0.0;
	for ( int i = 0; i < 8; i ++ ) {
		vec2 o = rm * BO_POISSON16[ i * 2 ] * searchUV;
		float d = texture( boShadowAtlas, clamp( base + o, tileMin, tileMax ) ).r;
		if ( d < uvd.z - bias ) { blockerSum += d; blockerCount += 1.0; }
	}
	if ( blockerCount < 0.5 ) return 1.0;

	float blocker = blockerSum / blockerCount;

	// ---- variable penumbra (PCSS step 2)
	// Penumbra width = occluder-to-receiver distance x the sun's angular size.
	// Nothing else. No floor beyond half a texel, because a floor here is exactly
	// what erased every small shadow in the level.
	float penumbraM = max( ( uvd.z - blocker ) * zRange, 0.0 ) * tanSun;
	float filterM = clamp( penumbraM, texelW * 0.55, maxFilterM );
	float filterUV = filterM * uvPerMetre;

	// ---- filtered comparison (PCSS step 3)
	float sum = 0.0;
	for ( int i = 0; i < 16; i ++ ) {
		vec2 o = rm * BO_POISSON16[ i ] * filterUV;
		float d = texture( boShadowAtlas, clamp( base + o, tileMin, tileMax ) ).r;
		sum += step( uvd.z - bias, d );
	}
	return sum * ( 1.0 / 16.0 );
}

/**
 * Sun visibility for a world-space point. viewDepth is positive distance
 * along the camera forward axis and selects the cascade.
 */
float boSunShadow( const in vec3 worldPos, const in vec3 worldNormal,
                   const in float viewDepth, const in float NdotL, const in vec2 screenPos ) {

	int count = int( boCsmInfo.x );
	if ( count <= 0 ) return 1.0;

	float dist = boCsmInfo.z;
	if ( viewDepth > dist ) return 1.0;

	int c = count - 1;
	for ( int i = 0; i < BO_CSM_MAX; i ++ ) {
		if ( i >= count ) break;
		if ( viewDepth < boCsmParams[ i ].w ) { c = i; break; }
	}

	float rot = ( boIGN( screenPos ) + boFrameJitter ) * 6.2831853;
	float nOff = 1.1 + 2.2 * ( 1.0 - NdotL );

	vec3 wp = worldPos + worldNormal * ( boCsmParams[ c ].z * nOff );
	float s = boCascadeSample( c, wp, NdotL, rot );

	// Cross-fade the seam so the change in penumbra width is invisible.
	float splitFar = boCsmParams[ c ].w;
	if ( c + 1 < count ) {
		float band = splitFar * 0.14;
		float t = smoothstep( splitFar - band, splitFar, viewDepth );
		if ( t > 0.001 ) {
			vec3 wp2 = worldPos + worldNormal * ( boCsmParams[ c + 1 ].z * nOff );
			float s2 = boCascadeSample( c + 1, wp2, NdotL, rot );
			s = mix( s, s2, t );
		}
	}

	// Fade the whole thing out at the shadow distance so there is no hard edge.
	float fade = 1.0 - smoothstep( dist * 0.82, dist, viewDepth );
	s = mix( 1.0, s, fade * boShadowStrength );
	return s;
}

#endif
`;

/* -------------------------------------------------------- contact shadows -- */

export const GLSL_CONTACT = /* glsl */ `
#ifndef BO_CONTACT
#define BO_CONTACT

uniform sampler2D boSceneDepth;
uniform vec4 boContactParams;   // x strength, y length(m), z steps, w thickness(m)
uniform vec4 boCameraParams;    // x near, y far, z 1/width, w 1/height

/**
 * Short screen-space ray march toward the sun. Picks up the tiny occlusions the
 * shadow atlas can never resolve — the base of a wall, a rifle against a crate.
 */
float boContactShadow( const in vec3 viewPos, const in vec3 viewNormal,
                       const in vec3 viewLightDir, const in float NdotL,
                       const in mat4 proj, const in vec2 screenPos ) {

	if ( boContactParams.x <= 0.0 ) return 1.0;

	// Grazing light is where a screen-space ray is least reliable — the ray
	// hugs the surface and self-intersects. Fade out instead of speckling.
	float grazing = smoothstep( 0.10, 0.42, NdotL );
	if ( grazing <= 0.001 ) return 1.0;

	int steps = int( boContactParams.z );
	float rayLen = boContactParams.y;
	float thickness = boContactParams.w;

	// Depth precision falls off quadratically with distance, so both the start
	// offset and the acceptance window have to grow with it.
	float viewZ = max( - viewPos.z, 0.05 );
	float bias = 0.03 + viewZ * 0.010;
	vec3 ro = viewPos + viewNormal * bias;
	float jitter = boIGN( screenPos + vec2( 7.13, 3.71 ) + boFrameJitter * 41.0 );
	float stepLen = rayLen / float( steps );

	float occ = 0.0;
	float weight = 0.0;
	for ( int i = 0; i < 16; i ++ ) {
		if ( i >= steps ) break;
		float t = ( float( i ) + jitter ) * stepLen;
		vec3 p = ro + viewLightDir * t;
		vec4 clip = proj * vec4( p, 1.0 );
		if ( clip.w <= 0.0 ) break;
		vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
		if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) break;
		float sceneD = texture( boSceneDepth, uv ).r;
		float sceneZ = boLinearDepth( sceneD, boCameraParams.x, boCameraParams.y );
		float diff = ( - p.z ) - sceneZ;
		// Soft acceptance window; a hard test turns the whole surface into
		// binary noise that no amount of temporal filtering can clean up.
		float hit = smoothstep( bias, bias * 2.0, diff ) * ( 1.0 - smoothstep( thickness, thickness * 1.8, diff ) );
		float fade = 1.0 - t / rayLen;
		occ += hit * fade;
		weight += fade;
	}
	occ = weight > 0.0 ? boSat( occ / weight * 2.4 ) : 0.0;

	// Close-range detail only; further out the cascades already resolve it and
	// the ray is mostly noise.
	float range = 1.0 - smoothstep( 18.0, 34.0, viewZ );
	return 1.0 - occ * boContactParams.x * range * grazing;
}

#endif
`;

/* ------------------------------------------------------------------- sun -- */

/**
 * The analytic sun uniforms.
 *
 * This chunk is deliberately *not* pulled in by `GLSL_AERIAL`. Several shaders
 * outside this module (fx/Quads, fx/ParticleShaders, render/Decals) hand-declare
 * the same uniforms *after* their `${GLSL_AERIAL}` block, so a transitive
 * declaration here makes every one of them fail to link with
 * `'boSunDirWorld' : redefinition` — which silently kills decals and every lit
 * particle. Aerial perspective carries its own private `boFogSun` instead.
 */
export const GLSL_SUN = /* glsl */ `
#ifndef BO_SUN
#define BO_SUN

uniform vec3 boSunDirWorld;
uniform vec3 boSunDirView;
uniform vec3 boSunColor;

#endif
`;

/* ------------------------------------------------------ aerial perspective -- */

export const GLSL_AERIAL = /* glsl */ `
#ifndef BO_AERIAL
#define BO_AERIAL

uniform samplerCube boSkyCube;
uniform vec4 boFogParams;      // x density, y heightFalloff, z sunAmount, w mieG
uniform vec4 boFogParams2;     // x baseHeight, y maxOpacity, z inscatterBoost, w weatherGrey
uniform vec3 boFogTint;
// Sun illuminance under a private name, so this chunk can never collide with a
// caller that declares boSunColor itself. Mirrors boSunColor every frame.
uniform vec3 boFogSun;

/**
 * Height-attenuated exponential fog whose in-scatter colour is sampled from the
 * sky cubemap along the view ray — so distant geometry picks up the same warm
 * horizon at dusk and the same cold blue at dawn, automatically.
 */
vec3 boAerialPerspective( vec3 color, vec3 worldPos, vec3 camPos, vec3 sunDirWorld ) {

	vec3 delta = worldPos - camPos;
	float dist = length( delta );
	if ( dist < 0.05 ) return color;
	vec3 dir = delta / dist;

	float kH = boFogParams.y;
	float base = boFogParams2.x;
	float y0 = camPos.y - base;
	float y1 = worldPos.y - base;

	// Analytic integral of exp(-k*y) along the segment.
	float dy = y1 - y0;
	float integral;
	if ( abs( dy ) < 1e-3 ) {
		integral = exp( - kH * y0 ) * dist;
	} else {
		integral = dist * ( exp( - kH * y0 ) - exp( - kH * y1 ) ) / ( kH * dy );
	}
	integral = max( integral, 0.0 );

	float od = boFogParams.x * integral;
	float fog = 1.0 - exp( - od );
	fog = min( fog, boFogParams2.y );

	// In-scatter = the sky along the view ray, plus single-scattered sunlight.
	//
	// The sun term is *added*, never multiplied into the sky: a multiplicative
	// Mie boost reaches ~46x within twenty degrees of a low sun and turns the
	// whole forward hemisphere into a white sheet.
	vec3 sky = textureLod( boSkyCube, dir, 3.0 ).rgb;
	float mu = dot( dir, sunDirWorld );
	vec3 inscatter = sky + boFogSun * ( boPhaseMie( mu, boFogParams.w ) * boFogParams.z );
	inscatter = mix( inscatter, vec3( boLuma( inscatter ) ) * boFogTint, boFogParams2.w );
	inscatter *= boFogParams2.z;

	return mix( color, inscatter, fog );
}

#endif
`;

/* --------------------------------------------------------- sky dome shader -- */

export const GLSL_SKYDOME = /* glsl */ `
#ifndef BO_SKYDOME
#define BO_SKYDOME

/**
 * Procedural star field: three octaves of cell noise thresholded into points.
 * Deliberately dim — stars sit only a little above the airglow, so bloom and
 * lens streaks treat them as pinpricks rather than light sources.
 */
vec3 boStars( vec3 dir, float amount, float twinkle ) {
	if ( amount <= 0.001 ) return vec3( 0.0 );
	vec3 acc = vec3( 0.0 );
	float scale = 260.0;
	for ( int oct = 0; oct < 3; oct ++ ) {
		vec3 p = dir * scale;
		vec3 cell = floor( p );
		vec3 f = fract( p );
		vec3 h = boHash33( cell );
		if ( h.z > 0.975 - float( oct ) * 0.004 ) {
			vec3 centre = 0.34 + 0.32 * h;
			float d = length( f - centre );
			float mag = ( h.z - 0.972 ) * 12.0;
			float core = exp( - d * d * ( 6200.0 - float( oct ) * 900.0 ) );
			float tw = 0.7 + 0.3 * sin( twinkle * ( 1.3 + h.x * 5.0 ) + h.y * 12.0 );
			// Slight colour spread: blue-white giants through orange dwarfs.
			vec3 tint = mix( vec3( 0.72, 0.82, 1.0 ), vec3( 1.0, 0.82, 0.62 ), h.x );
			acc += tint * core * mag * tw;
		}
		scale *= 2.31;
	}
	// Faint galactic band.
	float band = exp( - pow( abs( dot( normalize( dir ), normalize( vec3( 0.42, 0.30, -0.86 ) ) ) ) * 3.2, 2.0 ) );
	acc += vec3( 0.55, 0.60, 0.82 ) * band * 0.012 * ( 0.6 + 0.4 * boFbm( dir * 6.0, 4 ) );
	// Fade out toward the horizon, where extinction kills them in reality.
	return acc * amount * smoothstep( -0.02, 0.22, dir.y );
}

/** Moon disc with a phase terminator, limb softening and a small halo. */
vec3 boMoon( vec3 dir, vec3 moonDir, float phase, float intensity ) {
	if ( intensity <= 0.0001 ) return vec3( 0.0 );
	float cosA = dot( dir, moonDir );
	float ang = acos( clamp( cosA, -1.0, 1.0 ) );
	float radius = 0.0092;   // ~0.53 degrees
	vec3 col = vec3( 0.0 );

	if ( ang < radius * 1.6 ) {
		// Build a local frame to get surface coordinates on the disc.
		vec3 up = abs( moonDir.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
		vec3 tx = normalize( cross( up, moonDir ) );
		vec3 ty = cross( moonDir, tx );
		vec2 uv = vec2( dot( dir, tx ), dot( dir, ty ) ) / radius;
		float r2 = dot( uv, uv );
		if ( r2 < 1.0 ) {
			float z = sqrt( max( 1.0 - r2, 0.0 ) );
			// Phase: light direction rotating across the disc.
			vec3 lightDir = normalize( vec3( cos( phase ), 0.22, sin( phase ) ) );
			vec3 n = normalize( vec3( uv, z ) );
			float lit = boSat( dot( n, lightDir ) );
			lit = pow( lit, 0.7 );
			float maria = 0.72 + 0.28 * boFbm( n * 5.0 + 11.0, 4 );
			float craters = 1.0 - 0.25 * smoothstep( 0.5, 0.9, boFbm( n * 22.0, 3 ) );
			float edge = smoothstep( 1.0, 0.86, r2 );
			col += vec3( 1.0, 0.97, 0.9 ) * lit * maria * craters * edge * intensity;
		}
	}
	// Halo.
	float halo = exp( - ang * 55.0 ) * 0.35 + exp( - ang * 14.0 ) * 0.05;
	col += vec3( 0.62, 0.70, 0.95 ) * halo * intensity * 0.55;
	return col;
}

/** Sun disc with quadratic limb darkening plus the forward Mie halo. */
vec3 boSunDisc( vec3 dir, vec3 sunDir, float angularRadius, vec3 sunColor, float glow ) {
	float cosA = dot( dir, sunDir );
	float ang = acos( clamp( cosA, -1.0, 1.0 ) );
	vec3 col = vec3( 0.0 );
	float edge = 1.0 - smoothstep( angularRadius * 0.985, angularRadius * 1.06, ang );
	if ( edge > 0.0 ) {
		float r = clamp( ang / angularRadius, 0.0, 1.0 );
		float mu = sqrt( max( 1.0 - r * r, 0.0 ) );
		// Empirical solar limb darkening (Hestroffer & Magnan).
		float limb = 0.34 + 0.66 * mu * ( 0.93 + 0.07 * mu );
		col += sunColor * limb * edge;
	}
	// Atmospheric bloom around the disc.
	float d = max( ang - angularRadius, 0.0 );
	col += sunColor * glow * ( exp( - d * 140.0 ) * 0.30 + exp( - d * 26.0 ) * 0.055 + exp( - d * 5.0 ) * 0.008 );
	return col;
}

#endif
`;
