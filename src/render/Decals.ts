/**
 * Deferred projected decals.
 *
 * Decals are *not* clipped geometry: each one is an instanced unit box whose
 * fragment shader reads the depth prepass, reconstructs the world position of
 * whatever surface is actually visible, and rejects anything outside the box.
 * That means a bullet hole wraps a crate corner and a pipe correctly, costs one
 * instanced draw call for the whole level, and never z-fights.
 *
 * Shading is done properly — sun with the same cascaded shadows as the world,
 * SH ambient, a cheap specular lobe and aerial perspective — so a decal on a
 * shadowed wall stays in shadow.
 *
 * Output goes to a premultiplied accumulation buffer that the frame graph
 * composites over the HDR scene colour. Blending straight into the MRT is not
 * possible without per-attachment blend state, which WebGL2 does not expose.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import {
  GLSL_AERIAL, GLSL_ATMOSPHERE, GLSL_COMMON, GLSL_CONTACT, GLSL_CSM, GLSL_SH,
} from './Glsl';
import { skipPatch } from './MaterialPatch';
import type { RenderUniforms } from './RenderUniforms';
import { ATLAS_COLS, ATLAS_ROWS, DECAL_GROUPS, type DecalAtlasTextures } from './DecalAtlas';
import type { DecalRequest } from './types';

const DECAL_VERT = /* glsl */ `
in mat4 iInvMatrix;
in vec4 iParams;   // x,y atlas cell, z fade, w normal-fade cosine
in vec4 iTint;     // rgb tint, a emissive

out mat4 vInv;
out vec4 vParams;
out vec4 vTint;
out vec3 vAxis;
out vec3 vTangent;
out vec3 vBitangent;

void main() {
	vInv = iInvMatrix;
	vParams = iParams;
	vTint = iTint;
	vTangent = normalize( instanceMatrix[ 0 ].xyz );
	vBitangent = normalize( instanceMatrix[ 1 ].xyz );
	vAxis = normalize( instanceMatrix[ 2 ].xyz );
	gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;

const DECAL_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SH}
${GLSL_CSM}
${GLSL_CONTACT}
${GLSL_AERIAL}

in mat4 vInv;
in vec4 vParams;
in vec4 vTint;
in vec3 vAxis;
in vec3 vTangent;
in vec3 vBitangent;

layout(location = 0) out vec4 outColor;

uniform sampler2D uAtlasA;
uniform sampler2D uAtlasB;
uniform vec2 uAtlasGrid;
uniform mat4 uInvProjection;
uniform mat4 uInvView;
uniform mat4 projectionMatrix;   // not part of three's fragment prefix
uniform vec3 boSunDirWorld;
uniform vec3 boSunColor;
uniform vec3 boAmbientSH[ 9 ];
uniform vec3 boAmbientTint;
uniform float boAmbientIntensity;

float D_GGX( float NoH, float a ) {
	float a2 = a * a;
	float d = ( NoH * a2 - NoH ) * NoH + 1.0;
	return a2 / ( BO_PI * d * d + 1e-7 );
}
float V_Smith( float NoV, float NoL, float a ) {
	float a2 = a * a;
	float gv = NoL * sqrt( NoV * NoV * ( 1.0 - a2 ) + a2 );
	float gl = NoV * sqrt( NoL * NoL * ( 1.0 - a2 ) + a2 );
	return 0.5 / max( gv + gl, 1e-5 );
}

void main() {
	vec2 uv = gl_FragCoord.xy * vec2( boCameraParams.z, boCameraParams.w );
	float d = texture( boSceneDepth, uv ).r;
	if ( d >= 0.9999995 ) discard;

	vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	vec4 vp = uInvProjection * clip;
	vec3 viewPos = vp.xyz / vp.w;
	vec3 worldPos = ( uInvView * vec4( viewPos, 1.0 ) ).xyz;

	vec3 lp = ( vInv * vec4( worldPos, 1.0 ) ).xyz;
	if ( any( greaterThan( abs( lp ), vec3( 0.5 ) ) ) ) discard;

	// Surface normal reconstructed from the depth buffer — no G-buffer read
	// needed, and it stays correct on geometry that was never in the prepass.
	vec3 dx = dFdx( viewPos );
	vec3 dy = dFdy( viewPos );
	vec3 nView = normalize( cross( dx, dy ) );
	if ( dot( nView, viewPos ) > 0.0 ) nView = - nView;
	vec3 nSurf = normalize( nView * mat3( viewMatrix ) );

	float facing = dot( nSurf, vAxis );
	float nFade = smoothstep( vParams.w, mix( vParams.w, 1.0, 0.5 ), facing );
	if ( nFade <= 0.001 ) discard;

	float depthFade = 1.0 - smoothstep( 0.34, 0.5, abs( lp.z ) );

	vec2 duv = ( vParams.xy + ( lp.xy + 0.5 ) ) / uAtlasGrid;
	vec4 alb = texture( uAtlasA, duv );
	vec4 nrm = texture( uAtlasB, duv );

	float alpha = alb.a * vParams.z * nFade * depthFade;
	if ( alpha <= 0.004 ) discard;

	// Tangent-space normal rotated into the surface frame.
	vec2 tsXY = nrm.xy * 2.0 - 1.0;
	float tsZ = sqrt( max( 1.0 - dot( tsXY, tsXY ), 0.0 ) );
	vec3 N = normalize( vTangent * tsXY.x + vBitangent * tsXY.y + nSurf * tsZ );

	vec3 albedo = alb.rgb * vTint.rgb;
	float rough = clamp( nrm.b, 0.045, 1.0 );
	float metal = nrm.a;
	vec3 diffuseColor = albedo * ( 1.0 - metal );
	vec3 f0 = mix( vec3( 0.04 ), albedo, metal );

	vec3 V = normalize( ( uInvView * vec4( - viewPos, 0.0 ) ).xyz );
	vec3 L = boSunDirWorld;
	float NoL = dot( N, L );

	vec3 color = vec3( 0.0 );
	if ( NoL > 0.0 ) {
		float shadow = boSunShadow( worldPos, N, max( - viewPos.z, 0.0 ), NoL, gl_FragCoord.xy );
		if ( shadow > 0.02 && boContactParams.x > 0.0 ) {
			shadow = min( shadow, boContactShadow( viewPos, nView,
				normalize( ( viewMatrix * vec4( L, 0.0 ) ).xyz ), NoL, projectionMatrix, gl_FragCoord.xy ) );
		}
		vec3 H = normalize( L + V );
		float NoV = max( dot( N, V ), 1e-4 );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );
		float a = rough * rough;
		vec3 F = f0 + ( 1.0 - f0 ) * pow( 1.0 - VoH, 5.0 );
		vec3 spec = F * ( D_GGX( NoH, a ) * V_Smith( NoV, NoL, a ) );
		vec3 irradiance = boSunColor * NoL * shadow;
		color += irradiance * ( diffuseColor * BO_INV_PI + spec );
	}

	vec3 amb = boShIrradiance( N, boAmbientSH ) * boAmbientTint * boAmbientIntensity;
	color += amb * diffuseColor * BO_INV_PI;
	color += textureLod( boSkyCube, reflect( - V, N ), rough * 6.0 ).rgb * f0 * ( 1.0 - rough ) * 0.55;
	color += albedo * vTint.a * 6.0;

	color = boAerialPerspective( color, worldPos, cameraPosition, boSunDirWorld );

	outColor = vec4( color * alpha, alpha );
}
`;

interface DecalSlot {
  matrix: THREE.Matrix4;
  local: THREE.Matrix4 | null;
  parent: THREE.Object3D | null;
  birth: number;
  lifetime: number;
  fadeIn: number;
  cell: THREE.Vector2;
  tint: THREE.Color;
  emissive: number;
  normalFade: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

export class DecalSystem {
  private renderer!: THREE.WebGLRenderer;
  private uniforms!: RenderUniforms;
  private material!: THREE.ShaderMaterial;
  private mesh!: THREE.InstancedMesh;
  private scene = new THREE.Scene();

  private invAttr!: THREE.InstancedBufferAttribute;
  private paramAttr!: THREE.InstancedBufferAttribute;
  private tintAttr!: THREE.InstancedBufferAttribute;

  private slots: DecalSlot[] = [];
  private capacity = 0;
  private time = 0;
  private rand = new Rand('decals');
  private dirtyMatrices = true;

  /** Live decal count — surfaced for the perf HUD. */
  get count(): number { return this.slots.length; }

  init(
    renderer: THREE.WebGLRenderer,
    uniforms: RenderUniforms,
    atlas: DecalAtlasTextures,
    capacity: number,
  ): void {
    this.renderer = renderer;
    this.uniforms = uniforms;
    this.capacity = Math.max(16, capacity);

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const cap = this.capacity;
    this.invAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.paramAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.invAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramAttr.setUsage(THREE.DynamicDrawUsage);
    this.tintAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iInvMatrix', this.invAttr);
    geom.setAttribute('iParams', this.paramAttr);
    geom.setAttribute('iTint', this.tintAttr);

    const shared = uniforms.shared();
    this.material = skipPatch(new THREE.ShaderMaterial({
      name: 'decals',
      glslVersion: THREE.GLSL3,
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: {
        ...shared,
        uAtlasA: { value: atlas.albedo },
        uAtlasB: { value: atlas.nrm },
        uAtlasGrid: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    }));

    this.mesh = new THREE.InstancedMesh(geom, this.material, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }

  setCapacity(capacity: number): void {
    const cap = Math.max(16, capacity);
    if (cap === this.capacity) return;
    while (this.slots.length > cap) this.slots.shift();
    // Reallocation is rare (preset change only), so a full rebuild is fine.
    const atlasA = this.material.uniforms.uAtlasA.value as THREE.Texture;
    const atlasB = this.material.uniforms.uAtlasB.value as THREE.Texture;
    const slots = this.slots.slice();
    this.dispose();
    this.init(this.renderer, this.uniforms, { albedo: atlasA, nrm: atlasB }, cap);
    this.slots = slots;
    this.dirtyMatrices = true;
  }

  add(req: DecalRequest): void {
    const range = DECAL_GROUPS[req.group] ?? DECAL_GROUPS.hard;
    if (range[1] <= 0) return;
    const variant = req.variant !== undefined && req.variant >= 0
      ? req.variant % range[1]
      : this.rand.int(0, range[1] - 1);
    const index = range[0] + variant;

    const size = Math.max(req.size, 0.01);
    const depth = Math.max(size * 0.9, 0.14);

    _z.copy(req.normal).normalize();
    if (req.up) _up.copy(req.up).normalize();
    else _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_z)) > 0.94) _up.set(_z.y > 0 ? 1 : 0, 0, _z.y > 0 ? 0 : 1);
    _x.crossVectors(_up, _z).normalize();
    _y.crossVectors(_z, _x).normalize();

    const rot = req.rotation ?? this.rand.range(0, Math.PI * 2);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const rx = _x.clone().multiplyScalar(c).addScaledVector(_y, s);
    const ry = _x.clone().multiplyScalar(-s).addScaledVector(_y, c);

    const m = new THREE.Matrix4();
    m.makeBasis(rx.multiplyScalar(size), ry.multiplyScalar(size), _z.clone().multiplyScalar(depth));
    m.setPosition(req.position.x, req.position.y, req.position.z);

    let local: THREE.Matrix4 | null = null;
    const parent = req.parent ?? null;
    if (parent) {
      local = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(m);
    }

    const slot: DecalSlot = {
      matrix: m,
      local,
      parent,
      birth: this.time,
      lifetime: req.lifetime ?? Infinity,
      fadeIn: 0.05,
      cell: new THREE.Vector2(index % ATLAS_COLS, Math.floor(index / ATLAS_COLS)),
      tint: new THREE.Color(req.colorTint ?? 0xffffff),
      emissive: req.emissive ?? 0,
      normalFade: 0.18,
    };

    if (this.slots.length >= this.capacity) this.slots.shift();
    this.slots.push(slot);
    this.dirtyMatrices = true;
  }

  clear(): void {
    this.slots.length = 0;
    this.dirtyMatrices = true;
  }

  /** Ages decals, refreshes parented transforms and uploads instance data. */
  update(dt: number): void {
    this.time += dt;

    let write = 0;
    const invArr = this.invAttr.array as Float32Array;
    const parArr = this.paramAttr.array as Float32Array;
    const tintArr = this.tintAttr.array as Float32Array;

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const age = this.time - s.birth;
      if (age > s.lifetime) continue;

      let fade = 1;
      if (Number.isFinite(s.lifetime)) {
        const tail = Math.min(s.lifetime * 0.35, 4);
        fade = THREE.MathUtils.clamp((s.lifetime - age) / Math.max(tail, 1e-3), 0, 1);
      }
      if (age < s.fadeIn) fade *= age / s.fadeIn;

      if (s.parent && s.local) {
        s.matrix.multiplyMatrices(s.parent.matrixWorld, s.local);
        this.dirtyMatrices = true;
      }

      if (write !== i) this.slots[write] = s;

      this.mesh.setMatrixAt(write, s.matrix);
      _m.copy(s.matrix).invert();
      _m.toArray(invArr, write * 16);

      parArr[write * 4] = s.cell.x;
      parArr[write * 4 + 1] = s.cell.y;
      parArr[write * 4 + 2] = fade;
      parArr[write * 4 + 3] = s.normalFade;

      tintArr[write * 4] = s.tint.r;
      tintArr[write * 4 + 1] = s.tint.g;
      tintArr[write * 4 + 2] = s.tint.b;
      tintArr[write * 4 + 3] = s.emissive;

      write++;
    }

    if (write !== this.slots.length) {
      this.slots.length = write;
      this.dirtyMatrices = true;
    }

    this.mesh.count = write;
    if (write > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.invAttr.needsUpdate = true;
      this.paramAttr.needsUpdate = true;
      this.tintAttr.needsUpdate = true;
    }
    this.dirtyMatrices = false;
  }

  /** Renders the premultiplied accumulation buffer. Returns false if empty. */
  render(camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget): boolean {
    if (this.mesh.count === 0) return false;

    const u = this.material.uniforms;
    (u.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uInvView.value as THREE.Matrix4).copy(camera.matrixWorld);

    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();

    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.autoClear = false;
    r.render(this.scene, camera);

    r.autoClear = prevAutoClear;
    r.setClearColor(prevClear, prevAlpha);
    return true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}
