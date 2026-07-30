/**
 * GPU luminance histogram + eye adaptation.
 *
 * 1. The HDR buffer is boxed down to a fixed 256×144 luminance tile so the cost
 *    is independent of resolution.
 * 2. A point-scatter pass builds a 256-bin log-luminance histogram with
 *    additive blending and centre-weighted metering — one vertex per tile texel,
 *    positioned at its own bin.
 * 3. Two reduction passes (256 → 16 → 1) compute the log-average of the middle
 *    of the distribution, discarding the darkest 45% and brightest 5% of the
 *    weight so a bright sky or a dark doorway cannot drag the exposure around.
 * 4. The 1×1 result is packed to 16-bit and read back; adaptation and the final
 *    exposure multiplier are resolved on the CPU where gameplay can bias them.
 *
 * The same 1×1 texel also carries the linear depth at screen centre, which
 * gives depth-of-field a free auto-focus signal.
 */

import * as THREE from 'three';
import { FS_VERTEX, FullscreenBlitter } from './Fullscreen';
import { GLSL_COMMON } from './Glsl';
import { skipPatch } from './MaterialPatch';

const LUM_W = 256;
const LUM_H = 144;
const BINS = 256;
const MIN_LOG = -10;
const MAX_LOG = 10;

const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tScene;
uniform vec2 tSceneTexel;

void main() {
	// 2x2 box in the source resolution; the hardware bilinear tap widens it.
	vec3 c = texture( tScene, vUv ).rgb;
	c += texture( tScene, vUv + vec2( tSceneTexel.x, 0.0 ) ).rgb;
	c += texture( tScene, vUv + vec2( 0.0, tSceneTexel.y ) ).rgb;
	c += texture( tScene, vUv + tSceneTexel ).rgb;
	float lum = max( boLuma( c * 0.25 ), 1e-6 );
	outColor = vec4( lum, 0.0, 0.0, 1.0 );
}
`;

const HISTOGRAM_VERT = /* glsl */ `
uniform sampler2D tLum;
uniform vec2 uLumSize;
uniform vec2 uRange;      // x minLog, y 1/(maxLog-minLog)
out float vWeight;

void main() {
	int id = gl_VertexID;
	int w = int( uLumSize.x );
	ivec2 texel = ivec2( id % w, id / w );
	float lum = texelFetch( tLum, texel, 0 ).r;

	float logLum = clamp( ( log2( max( lum, 1e-7 ) ) - uRange.x ) * uRange.y, 0.0, 1.0 );
	float bin = floor( logLum * ${BINS - 1}.0 + 0.5 );

	// Centre-weighted metering: the middle of frame decides the exposure.
	vec2 uv = ( vec2( texel ) + 0.5 ) / uLumSize;
	vec2 d = ( uv - 0.5 ) * vec2( 1.0, 0.75 );
	vWeight = mix( 1.0, 0.16, clamp( dot( d, d ) * 3.4, 0.0, 1.0 ) );
	// Reject anything that is essentially black — it is usually a skybox hole
	// or a fully occluded pixel and only biases the average down.
	if ( lum < 1e-5 ) vWeight = 0.0;

	gl_Position = vec4( ( bin + 0.5 ) / ${BINS}.0 * 2.0 - 1.0, 0.0, 0.0, 1.0 );
	gl_PointSize = 1.0;
}
`;

const HISTOGRAM_FRAG = /* glsl */ `
precision highp float;
in float vWeight;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4( vWeight, 0.0, 0.0, 0.0 ); }
`;

const REDUCE_A_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tHistogram;
uniform vec2 uRange;

void main() {
	int group = int( floor( vUv.x * 16.0 ) );
	float sumW = 0.0;
	float sumWL = 0.0;
	for ( int i = 0; i < 16; i ++ ) {
		int bin = group * 16 + i;
		float w = texelFetch( tHistogram, ivec2( bin, 0 ), 0 ).r;
		float logLum = uRange.x + ( float( bin ) + 0.5 ) / ${BINS}.0 / uRange.y;
		sumW += w;
		sumWL += w * logLum;
	}
	outColor = vec4( sumW, sumWL, 0.0, 1.0 );
}
`;

const REDUCE_B_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
in vec2 vUv;
layout(location = 0) out vec4 outColor;
uniform sampler2D tPartial;
uniform sampler2D tHistogram;
uniform sampler2D tDepth;
uniform vec2 uRange;
uniform vec4 uCamera;   // near, far

void main() {
	float total = 0.0;
	for ( int g = 0; g < 16; g ++ ) total += texelFetch( tPartial, ivec2( g, 0 ), 0 ).r;

	float lowCut = total * 0.45;
	float highCut = total * 0.95;

	float acc = 0.0;
	float sumW = 0.0;
	float sumWL = 0.0;
	for ( int bin = 0; bin < ${BINS}; bin ++ ) {
		float w = texelFetch( tHistogram, ivec2( bin, 0 ), 0 ).r;
		if ( w <= 0.0 ) continue;
		float lo = acc;
		float hi = acc + w;
		acc = hi;
		float use = max( min( hi, highCut ) - max( lo, lowCut ), 0.0 );
		if ( use <= 0.0 ) continue;
		float logLum = uRange.x + ( float( bin ) + 0.5 ) / ${BINS}.0 / uRange.y;
		sumW += use;
		sumWL += use * logLum;
	}

	float avgLog = sumW > 0.0 ? sumWL / sumW : 0.0;
	float norm = clamp( ( avgLog - uRange.x ) * uRange.y, 0.0, 1.0 );

	float d = texture( tDepth, vec2( 0.5 ) ).r;
	float linear = boLinearDepth( d, uCamera.x, uCamera.y );
	float dn = clamp( linear / uCamera.y, 0.0, 1.0 );

	outColor = vec4( boPack16( norm ), boPack16( dn ) );
}
`;

export interface ExposureSettings {
  /** Middle-grey target; lower = darker image. */
  key: number;
  /** Stops of user/gameplay compensation. */
  compensation: number;
  /** Manual multiplier from the quality preset. */
  manual: number;
  speedUp: number;
  speedDown: number;
  minEV: number;
  maxEV: number;
}

export class ExposureSystem {
  /** Resolved exposure multiplier applied by the tonemapper. */
  exposure = 1;
  /** Smoothed average scene luminance. */
  averageLuminance = 0.35;
  /** Linear depth at screen centre, in metres. */
  centreDepth = 10;

  settings: ExposureSettings = {
    // Middle-grey target. Tuned so the *production* chain (the effect library's
    // tonemap + grade, which is considerably more contrasty than a bare AgX)
    // lands mid-grey on a sunlit diffuse surface. `FrameGraph.present` scales
    // this back down when it has to tonemap by itself.
    key: 0.42,
    compensation: 0,
    manual: 1,
    speedUp: 3.6,
    speedDown: 1.6,
    // The floor is what keeps night looking like night: the eye does not fully
    // adapt in a few seconds, and a game that brightens moonlight to daylight
    // reads as broken. −1 EV caps the gain at roughly 2 stops over mid-grey.
    minEV: 0.0,
    maxEV: 16,
  };

  private renderer!: THREE.WebGLRenderer;
  private blitter!: FullscreenBlitter;

  private lumTarget!: THREE.WebGLRenderTarget;
  private histTarget!: THREE.WebGLRenderTarget;
  private partialTarget!: THREE.WebGLRenderTarget;
  private resultTarget!: THREE.WebGLRenderTarget;

  private downsampleMat!: THREE.ShaderMaterial;
  private histMat!: THREE.ShaderMaterial;
  private reduceAMat!: THREE.ShaderMaterial;
  private reduceBMat!: THREE.ShaderMaterial;

  private points!: THREE.Points;
  private pointScene = new THREE.Scene();
  private pointCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private readback = new Uint8Array(4);
  private readbackPending = false;
  private useAsync = true;
  private settled = 0;
  private haveSample = false;
  private far = 900;

  init(renderer: THREE.WebGLRenderer, blitter: FullscreenBlitter, useAsync: boolean): void {
    this.renderer = renderer;
    this.blitter = blitter;
    this.useAsync = useAsync;

    const half = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    } as const;

    this.lumTarget = new THREE.WebGLRenderTarget(LUM_W, LUM_H, half);
    this.histTarget = new THREE.WebGLRenderTarget(BINS, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.partialTarget = new THREE.WebGLRenderTarget(16, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.resultTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    const range = new THREE.Vector2(MIN_LOG, 1 / (MAX_LOG - MIN_LOG));

    this.downsampleMat = skipPatch(new THREE.ShaderMaterial({
      name: 'exposure:downsample',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: DOWNSAMPLE_FRAG,
      uniforms: {
        tScene: { value: null },
        tSceneTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    }));

    this.histMat = skipPatch(new THREE.ShaderMaterial({
      name: 'exposure:histogram',
      glslVersion: THREE.GLSL3,
      vertexShader: HISTOGRAM_VERT,
      fragmentShader: HISTOGRAM_FRAG,
      uniforms: {
        tLum: { value: this.lumTarget.texture },
        uLumSize: { value: new THREE.Vector2(LUM_W, LUM_H) },
        uRange: { value: range.clone() },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    }));

    this.reduceAMat = skipPatch(new THREE.ShaderMaterial({
      name: 'exposure:reduceA',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: REDUCE_A_FRAG,
      uniforms: {
        tHistogram: { value: this.histTarget.texture },
        uRange: { value: range.clone() },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    }));

    this.reduceBMat = skipPatch(new THREE.ShaderMaterial({
      name: 'exposure:reduceB',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: REDUCE_B_FRAG,
      uniforms: {
        tPartial: { value: this.partialTarget.texture },
        tHistogram: { value: this.histTarget.texture },
        tDepth: { value: null },
        uRange: { value: range.clone() },
        uCamera: { value: new THREE.Vector4(0.02, 900, 0, 0) },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    }));

    const count = LUM_W * LUM_H;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.points = new THREE.Points(geom, this.histMat);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.pointScene.add(this.points);
    this.pointScene.matrixWorldAutoUpdate = false;
  }

  /** Runs the whole chain; call once per frame after the opaque pass. */
  update(
    dt: number,
    sceneColor: THREE.Texture,
    depth: THREE.Texture,
    width: number,
    height: number,
    near: number,
    far: number,
  ): void {
    const r = this.renderer;
    this.far = far;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevClearAlpha = r.getClearAlpha();
    r.autoClear = false;

    // 1 — luminance tile
    this.downsampleMat.uniforms.tScene.value = sceneColor;
    (this.downsampleMat.uniforms.tSceneTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    this.blitter.blit(r, this.downsampleMat, this.lumTarget);

    // 2 — scatter into the histogram
    r.setRenderTarget(this.histTarget);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.pointScene, this.pointCamera);

    // 3 — reduce 256 → 16 → 1
    this.blitter.blit(r, this.reduceAMat, this.partialTarget);
    this.reduceBMat.uniforms.tDepth.value = depth;
    (this.reduceBMat.uniforms.uCamera.value as THREE.Vector4).set(near, far, 0, 0);
    this.blitter.blit(r, this.reduceBMat, this.resultTarget);

    r.autoClear = prevAutoClear;
    r.setClearColor(prevClear, prevClearAlpha);
    r.setRenderTarget(prevTarget);

    this.fetch();
    this.adapt(dt);
  }

  private fetch(): void {
    const r = this.renderer;
    if (!this.useAsync) {
      r.readRenderTargetPixels(this.resultTarget, 0, 0, 1, 1, this.readback);
      this.haveSample = true;
      return;
    }
    if (this.readbackPending) return;
    this.readbackPending = true;
    r.readRenderTargetPixelsAsync(this.resultTarget, 0, 0, 1, 1, this.readback)
      .then(() => { this.readbackPending = false; this.haveSample = true; })
      .catch(() => { this.readbackPending = false; this.useAsync = false; });
  }

  private adapt(dt: number): void {
    const s = this.settings;
    if (this.haveSample) {
      const norm = (this.readback[0] * 256 + this.readback[1]) / 65535;
      const depthNorm = (this.readback[2] * 256 + this.readback[3]) / 65535;
      const logLum = MIN_LOG + norm * (MAX_LOG - MIN_LOG);
      const target = Math.pow(2, logLum);

      const ratio = Math.abs(Math.log2(Math.max(target, 1e-6) / Math.max(this.averageLuminance, 1e-6)));
      if (this.settled < 2 || ratio > 3.2) {
        // First frames, or a teleport/time-of-day jump: snap rather than crawl.
        this.averageLuminance = target;
      } else {
        const speed = target > this.averageLuminance ? s.speedUp : s.speedDown;
        const k = 1 - Math.exp(-Math.max(dt, 1e-4) * speed);
        this.averageLuminance += (target - this.averageLuminance) * k;
      }
      this.settled++;
      this.centreDepth = Math.max(0.2, depthNorm * this.far);
    }

    // Standard saturation-based metering: EV100 = log2(L * 100 / K), K = 12.5.
    const lum = Math.max(this.averageLuminance, 1e-6);
    const minLum = Math.pow(2, s.minEV) * 12.5 / 100;
    const maxLum = Math.pow(2, s.maxEV) * 12.5 / 100;
    const clamped = THREE.MathUtils.clamp(lum, minLum, maxLum);
    this.exposure = (s.key / clamped) * Math.pow(2, s.compensation) * s.manual;
  }

  reset(): void {
    this.settled = 0;
    this.haveSample = false;
  }

  dispose(): void {
    this.lumTarget.dispose();
    this.histTarget.dispose();
    this.partialTarget.dispose();
    this.resultTarget.dispose();
    this.downsampleMat.dispose();
    this.histMat.dispose();
    this.reduceAMat.dispose();
    this.reduceBMat.dispose();
    this.points.geometry.dispose();
  }
}
