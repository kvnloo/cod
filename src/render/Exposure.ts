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
uniform sampler2D tDepth;
uniform vec2 uLumSize;
uniform vec2 uRange;      // x minLog, y 1/(maxLog-minLog)
uniform vec2 uMeter;      // x sky weight, y distant-geometry weight
uniform vec2 uCamera;     // near, far
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

	// Meter the subject, not the sky. Sky pixels sit exactly on the far plane
	// and are two to three stops above anything the player is standing on;
	// letting them into the average is what stops a plaza down to 3% grey the
	// moment the camera tilts up. They keep a small weight so a frame that is
	// nothing but sky still has something to meter, and everything within the
	// far quarter of the depth range (the backdrop ridge, distant haze) is
	// partially discounted for the same reason.
	float depth = textureLod( tDepth, uv, 0.0 ).r;
	float ndc = depth * 2.0 - 1.0;
	float linear = ( 2.0 * uCamera.x * uCamera.y )
		/ ( uCamera.y + uCamera.x - ndc * ( uCamera.y - uCamera.x ) );
	vWeight *= mix( 1.0, uMeter.y, smoothstep( 55.0, 220.0, linear ) );
	vWeight *= mix( 1.0, uMeter.x, step( 0.9999995, depth ) );

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
uniform vec4 uCamera;   // near, far, lowCut, highCut

void main() {
	float total = 0.0;
	for ( int g = 0; g < 16; g ++ ) total += texelFetch( tPartial, ivec2( g, 0 ), 0 ).r;

	// Trim window over the weighted distribution. The old 45%/95% pair threw
	// away the darkest *half* of every frame, which in a street shot is the
	// street: the subject the player is standing on was excluded from its own
	// exposure by construction, and the average was set by the lit facades and
	// the haze above them. Discarding rather less at the bottom and rather more
	// at the top puts the median of what is actually on screen back in charge.
	float lowCut = total * uCamera.z;
	float highCut = total * uCamera.w;

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
  /**
   * Partial adaptation below EV100 0. 1 = the meter compensates a dark scene
   * completely (night looks like noon); 0 = it does not compensate at all
   * (night is unplayable). Anything in between keeps the *relationship* between
   * times of day while making all of them legible.
   */
  darkAdapt: number;
  /**
   * Partial adaptation above EV100 `brightPivot`. Same idea at the other end:
   * a full meter renders midnight and midday at exactly the same grey, which is
   * the single biggest reason a time-of-day cycle reads as a colour filter
   * rather than as light. Below 1 the image keeps a share of the scene's own
   * brightness, so noon is genuinely brighter than golden hour.
   */
  brightAdapt: number;
  /** EV100 above which `brightAdapt` starts to apply. */
  brightPivot: number;
  /** EV100 below which `darkAdapt` starts to apply. */
  darkPivot: number;
  /** Metering weight for pixels on the far plane (sky). */
  skyWeight: number;
  /** Metering weight for distant geometry (backdrop, far haze). */
  distantWeight: number;
  /** Fraction of the weighted histogram discarded from the dark end. */
  lowCut: number;
  /** Fraction of the weighted histogram kept from the bright end. */
  highCut: number;
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
    //
    // 0.36 rather than 0.42: the trim window below no longer throws away the
    // darkest half of the frame, so the same key now means something brighter
    // than it used to — the number it was fitted against was the average of the
    // *lit* part of the image, not of the image.
    key: 0.36,
    compensation: 0,
    manual: 1,
    speedUp: 3.6,
    speedDown: 1.6,
    // A *hard* luminance floor is the wrong tool for "night looks like night":
    // at minEV 0 the meter refused to consider anything below 0.125, which
    // capped exposure at ~3.4 and rendered golden hour two stops under and
    // midnight as a black frame. The floor is now only a safety rail; the
    // relationship between times of day comes from `darkAdapt`.
    minEV: -8,
    maxEV: 16,
    // 0.30 / 0.58 rather than 0.42 / 0.72. Measured across the time-of-day
    // shots the old pair put midday and midnight 3.0 stops apart on the same
    // tram roof; a real camera walking that cycle at a fixed key would see
    // eleven. We cannot spend eleven — night has to stay playable — but three
    // is what makes a day/night cycle read as a colour filter. Widening both
    // ends buys roughly two more stops of separation while leaving the hero
    // hour, whose EV100 sits between 0 and `brightPivot`, exactly where it is.
    darkAdapt: 0.18,
    brightAdapt: 0.58,
    brightPivot: 1.5,
    // Golden hour on this level meters at EV100 ≈ −0.4: with the dark rolloff
    // starting at 0 the hero hour was being *darkened* by the same knob meant
    // to keep midnight dark, and the square lost a third of a stop. The dead
    // band between the two pivots is where the whole playable range of the
    // level's own time of day sits.
    darkPivot: -0.9,
    skyWeight: 0.10,
    distantWeight: 0.35,
    lowCut: 0.26,
    highCut: 0.88,
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
  /**
   * Capture runs resolve the meter every frame instead of easing toward it.
   * The harness only settles a shot for ~24 frames, which at a plausible
   * gameplay adaptation rate leaves the eye somewhere between the *previous*
   * shot and this one — so every screenshot in a contact sheet was exposed for
   * whatever the camera happened to be looking at before it. Determinism beats
   * simulated latency in a still.
   */
  private instant = false;
  private settled = 0;
  private haveSample = false;
  private far = 900;

  init(renderer: THREE.WebGLRenderer, blitter: FullscreenBlitter, useAsync: boolean): void {
    this.renderer = renderer;
    this.blitter = blitter;
    this.useAsync = useAsync;
    this.instant = !useAsync;

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
        tDepth: { value: null },
        uLumSize: { value: new THREE.Vector2(LUM_W, LUM_H) },
        uRange: { value: range.clone() },
        uMeter: { value: new THREE.Vector2(0.10, 0.35) },
        uCamera: { value: new THREE.Vector2(0.02, 900) },
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
    this.histMat.uniforms.tDepth.value = depth;
    (this.histMat.uniforms.uMeter.value as THREE.Vector2).set(this.settings.skyWeight, this.settings.distantWeight);
    (this.histMat.uniforms.uCamera.value as THREE.Vector2).set(near, far);
    r.setRenderTarget(this.histTarget);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.pointScene, this.pointCamera);

    // 3 — reduce 256 → 16 → 1
    this.blitter.blit(r, this.reduceAMat, this.partialTarget);
    this.reduceBMat.uniforms.tDepth.value = depth;
    (this.reduceBMat.uniforms.uCamera.value as THREE.Vector4)
      .set(near, far, this.settings.lowCut, this.settings.highCut);
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
      if (this.instant || this.settled < 2 || ratio > 3.2) {
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
    let ev = Math.log2((lum * 100) / 12.5);
    // Partial adaptation at both ends. Below EV100 0 the meter only partially
    // opens up, so dusk reads warmer and a stop under noon and night reads as
    // night; above `brightPivot` it only partially stops down, so midday is
    // genuinely brighter than golden hour instead of metering to the same grey.
    if (ev < s.darkPivot) ev = s.darkPivot + (ev - s.darkPivot) * s.darkAdapt;
    else if (ev > s.brightPivot) ev = s.brightPivot + (ev - s.brightPivot) * s.brightAdapt;
    ev = THREE.MathUtils.clamp(ev, s.minEV, s.maxEV);
    const effective = Math.pow(2, ev) * 12.5 / 100;
    this.exposure = (s.key / effective) * Math.pow(2, s.compensation) * s.manual;
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
