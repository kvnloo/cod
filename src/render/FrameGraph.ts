/**
 * G-buffer allocation, scratch pooling, and the final present stage.
 *
 * The frame graph owns every render target the renderer allocates per-frame and
 * is the only place that knows their layout. Post passes see it exclusively
 * through `PassContext` (see `Pass.ts`), which is why the effect library and the
 * frame graph can be developed independently.
 */

import * as THREE from 'three';
import type { GBuffer } from './Pass';
import { FS_VERTEX, FullscreenBlitter, TargetPool } from './Fullscreen';
import { GLSL_COMMON, GLSL_TONEMAP } from './Glsl';
import { skipPatch } from './MaterialPatch';

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tScene;
uniform sampler2D tDecals;
void main() {
	vec4 base = texture( tScene, vUv );
	vec4 d = texture( tDecals, vUv );
	outColor = vec4( base.rgb * ( 1.0 - d.a ) + d.rgb, base.a );
}
`;

const PRESENT_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_TONEMAP}

in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform sampler2D tScene;
uniform float uExposure;
uniform int   uTonemap;
uniform int   uEncode;          // 0 = passthrough (an external pass tonemapped)
uniform vec2  uResolution;
uniform float uTime;

uniform vec4  uGrade;           // contrast, saturation, lift, temperature
uniform vec3  uFlashColor;
uniform float uFlashAmount;
uniform vec4  uDamage;          // intensity, dirX, dirY, pulse
uniform vec2  uConcussion;      // intensity, phase
uniform vec2  uSpatter;         // intensity, kind (0 blood, 1 water, 2 dirt)
uniform float uVignette;
uniform float uGrain;

vec3 grade( vec3 c ) {
	// Lift/contrast around middle grey, then saturation, then a gentle
	// cool-shadow / warm-highlight split that reads as "film".
	float lift = uGrade.z;
	c = max( c + lift * ( 1.0 - c ), vec3( 0.0 ) );
	c = ( c - 0.5 ) * uGrade.x + 0.5;
	float l = boLuma( c );
	c = mix( vec3( l ), c, uGrade.y );
	float t = uGrade.w;
	vec3 shadowTint = vec3( 0.94, 0.985, 1.06 );
	vec3 highTint = vec3( 1.05, 1.0, 0.945 );
	c *= mix( shadowTint, highTint, boSat( l * 1.35 ) ) * ( 1.0 - t ) + vec3( 1.0 ) * t;
	return max( c, vec3( 0.0 ) );
}

float dropletMask( vec2 uv, float seed, float density ) {
	vec2 g = uv * vec2( 9.0, 5.0 );
	vec2 cell = floor( g );
	vec2 f = fract( g );
	float m = 0.0;
	for ( int y = -1; y <= 1; y ++ ) {
		for ( int x = -1; x <= 1; x ++ ) {
			vec2 c = cell + vec2( float( x ), float( y ) );
			vec2 h = boHash22( c + seed );
			if ( h.x > density ) continue;
			vec2 p = vec2( float( x ), float( y ) ) + 0.15 + 0.7 * h;
			float r = 0.06 + 0.22 * h.y;
			m = max( m, smoothstep( r, r * 0.35, length( f - p ) ) );
		}
	}
	return m;
}

void main() {
	vec2 uv = vUv;
	vec3 color;

	float ca = uConcussion.x * 0.006;
	if ( ca > 0.00002 ) {
		vec2 d = ( uv - 0.5 );
		float r2 = dot( d, d );
		vec2 off = d * ( ca * ( 0.5 + r2 * 3.0 ) );
		color.r = texture( tScene, uv + off ).r;
		color.g = texture( tScene, uv ).g;
		color.b = texture( tScene, uv - off ).b;
	} else {
		color = texture( tScene, uv ).rgb;
	}

	if ( uEncode == 1 ) {
		color *= uExposure;
		color += uFlashColor * uFlashAmount;
		color = boTonemap( color, uTonemap );
		color = grade( color );
	}

	// --- damage vignette: directional, blood-red, pulsing
	if ( uDamage.x > 0.001 ) {
		vec2 d = uv - 0.5;
		float radial = boSat( length( d ) * 1.75 );
		float dirMask = boSat( dot( normalize( d + 1e-5 ), uDamage.yz ) * 0.5 + 0.5 );
		float m = pow( radial, 1.6 ) * mix( 0.35, 1.0, dirMask ) * uDamage.x;
		float veins = boFbm( vec3( uv * 9.0, uDamage.w ), 3 );
		m *= 0.75 + 0.55 * veins;
		color = mix( color, vec3( 0.36, 0.015, 0.012 ), boSat( m ) );
	}

	// --- lens spatter
	if ( uSpatter.x > 0.002 ) {
		float mask = dropletMask( uv, uSpatter.y * 13.0, 0.10 + 0.28 * uSpatter.x );
		vec3 tint = uSpatter.y < 0.5 ? vec3( 0.32, 0.02, 0.015 )
		         : ( uSpatter.y < 1.5 ? vec3( 0.72, 0.78, 0.85 ) : vec3( 0.30, 0.24, 0.17 ) );
		float k = mask * uSpatter.x;
		// Refract slightly inside each droplet so it reads as a lens artefact.
		vec2 warp = ( boHash22( floor( uv * vec2( 9.0, 5.0 ) ) ) - 0.5 ) * 0.02 * k;
		vec3 inside = texture( tScene, uv + warp ).rgb;
		if ( uEncode == 1 ) {
			inside = grade( boTonemap( inside * uExposure, uTonemap ) );
		}
		color = mix( color, mix( inside, tint, uSpatter.y < 0.5 ? 0.72 : 0.28 ), boSat( k ) );
	}

	// --- vignette + grain
	if ( uVignette > 0.001 ) {
		vec2 d = ( uv - 0.5 ) * vec2( 1.0, 0.92 );
		float v = 1.0 - uVignette * boSat( dot( d, d ) * 1.55 );
		color *= v;
	}
	if ( uGrain > 0.001 ) {
		float n = boHash12( uv * uResolution + uTime * 71.0 ) - 0.5;
		color += n * uGrain * 0.06 * ( 1.0 - boSat( boLuma( color ) ) * 0.6 );
	}

	if ( uEncode == 1 ) color = boLinearToSRGB( color );

	// Ordered dither kills banding in the dark sky gradients.
	float dither = ( boIGN( gl_FragCoord.xy ) - 0.5 ) / 255.0;
	outColor = vec4( max( color + dither, vec3( 0.0 ) ), 1.0 );
}
`;

export interface ScreenState {
  flashColor: THREE.Color;
  flashAmount: number;
  flashDecay: number;
  damage: number;
  damageDir: THREE.Vector2;
  concussion: number;
  concussionDecay: number;
  spatter: number;
  spatterKind: number;
}

export class FrameGraph {
  readonly blitter = new FullscreenBlitter();
  readonly pool = new TargetPool();

  gbuffer!: GBuffer;
  /** Depth-only prepass: enables contact shadows and depth-projected decals. */
  prepassTarget!: THREE.WebGLRenderTarget;
  prepassDepth!: THREE.DepthTexture;

  width = 1;
  height = 1;

  readonly screen: ScreenState = {
    flashColor: new THREE.Color(1, 1, 1),
    flashAmount: 0,
    flashDecay: 4,
    damage: 0,
    damageDir: new THREE.Vector2(0, 1),
    concussion: 0,
    concussionDecay: 1.2,
    spatter: 0,
    spatterKind: 0,
  };

  private renderer!: THREE.WebGLRenderer;
  private presentMat!: THREE.ShaderMaterial;
  private compositeMat!: THREE.ShaderMaterial;
  private mrt!: THREE.WebGLRenderTarget;
  private damagePulse = 0;

  init(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;

    this.presentMat = skipPatch(new THREE.ShaderMaterial({
      name: 'present',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: PRESENT_FRAG,
      uniforms: {
        tScene: { value: null },
        uExposure: { value: 1 },
        uTonemap: { value: 0 },
        uEncode: { value: 1 },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uGrade: { value: new THREE.Vector4(1.04, 1.02, 0.0, 0.0) },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uFlashAmount: { value: 0 },
        uDamage: { value: new THREE.Vector4(0, 0, 1, 0) },
        uConcussion: { value: new THREE.Vector2(0, 0) },
        uSpatter: { value: new THREE.Vector2(0, 0) },
        uVignette: { value: 0.25 },
        uGrain: { value: 0.2 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }));

    this.compositeMat = skipPatch(new THREE.ShaderMaterial({
      name: 'decal-composite',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: { tScene: { value: null }, tDecals: { value: null } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }));
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.gbuffer && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;

    this.mrt?.dispose();
    this.prepassTarget?.dispose();

    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = 'gbuffer:depth';

    const mrt = new THREE.WebGLRenderTarget(w, h, {
      count: 4,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    // Per-attachment formats, exactly as documented in Pass.ts.
    const [c0, c1, c2, c3] = mrt.textures;
    c0.name = 'gbuffer:color';
    c1.name = 'gbuffer:normalRoughness';
    c1.minFilter = THREE.NearestFilter;
    c1.magFilter = THREE.NearestFilter;
    c2.name = 'gbuffer:velocity';
    c2.format = THREE.RGFormat;
    c3.name = 'gbuffer:material';
    c3.type = THREE.UnsignedByteType;
    c3.minFilter = THREE.NearestFilter;
    c3.magFilter = THREE.NearestFilter;

    this.mrt = mrt;

    const preDepth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    preDepth.format = THREE.DepthFormat;
    preDepth.minFilter = THREE.NearestFilter;
    preDepth.magFilter = THREE.NearestFilter;
    preDepth.generateMipmaps = false;
    preDepth.name = 'prepass:depth';

    this.prepassTarget = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: preDepth,
      generateMipmaps: false,
    });
    this.prepassTarget.texture.name = 'prepass:dummy';
    this.prepassDepth = preDepth;

    this.gbuffer = {
      target: mrt,
      color: c0,
      normalRoughness: c1,
      velocity: c2,
      material: c3,
      depth,
      width: w,
      height: h,
    };

    this.pool.resize(w, h);
  }

  /** Composites the decal accumulation buffer over the HDR scene colour. */
  compositeDecals(scene: THREE.Texture, decals: THREE.Texture, out: THREE.WebGLRenderTarget): void {
    this.compositeMat.uniforms.tScene.value = scene;
    this.compositeMat.uniforms.tDecals.value = decals;
    this.blitter.blit(this.renderer, this.compositeMat, out);
  }

  /** Advances transient screen effects. */
  updateScreen(dt: number): void {
    const s = this.screen;
    if (s.flashAmount > 0) {
      s.flashAmount = Math.max(0, s.flashAmount - s.flashAmount * s.flashDecay * dt - dt * 0.02);
      if (s.flashAmount < 1e-4) s.flashAmount = 0;
    }
    if (s.damage > 0) s.damage = Math.max(0, s.damage - dt * 0.85);
    if (s.concussion > 0) s.concussion = Math.max(0, s.concussion - dt * s.concussionDecay);
    if (s.spatter > 0) s.spatter = Math.max(0, s.spatter - dt * 0.14);
    this.damagePulse += dt * 2.4;
  }

  /**
   * Final blit to the canvas: exposure, tonemap, grade, screen effects, sRGB.
   * `encode` is false when a post pass already produced display-referred pixels;
   * `screenFx` is false when the effect library owns the damage/flash overlays.
   */
  present(o: {
    input: THREE.Texture;
    exposure: number;
    tonemap: number;
    encode: boolean;
    screenFx: boolean;
    grade: THREE.Vector4;
    vignette: number;
    grain: number;
    time: number;
  }): void {
    const u = this.presentMat.uniforms;
    const s = this.screen;
    const fx = o.screenFx;
    u.tScene.value = o.input;
    // The shared exposure is calibrated for the effect library's grade; a bare
    // AgX needs roughly 1.6 stops less to land on the same mid-grey.
    u.uExposure.value = o.exposure * (o.encode ? 0.33 : 1);
    u.uTonemap.value = o.tonemap;
    u.uEncode.value = o.encode ? 1 : 0;
    (u.uResolution.value as THREE.Vector2).set(this.width, this.height);
    u.uTime.value = o.time;
    (u.uGrade.value as THREE.Vector4).copy(o.grade);
    (u.uFlashColor.value as THREE.Color).copy(s.flashColor);
    u.uFlashAmount.value = fx ? s.flashAmount : 0;
    (u.uDamage.value as THREE.Vector4).set(fx ? s.damage : 0, s.damageDir.x, s.damageDir.y, this.damagePulse);
    (u.uConcussion.value as THREE.Vector2).set(fx ? s.concussion : 0, o.time);
    (u.uSpatter.value as THREE.Vector2).set(fx ? s.spatter : 0, s.spatterKind);
    u.uVignette.value = o.vignette;
    u.uGrain.value = o.grain;

    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.renderer.domElement.width, this.renderer.domElement.height);
    this.blitter.blit(this.renderer, this.presentMat, null);
  }

  dispose(): void {
    this.mrt?.dispose();
    this.prepassTarget?.dispose();
    this.pool.dispose();
    this.blitter.dispose();
    this.presentMat?.dispose();
    this.compositeMat?.dispose();
  }
}
