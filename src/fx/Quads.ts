/**
 * CPU-driven hero sprites.
 *
 * The GPU particle buffer is the right tool for thousands of anonymous puffs;
 * it is the wrong tool for the handful of large, precisely timed, *sorted*
 * elements that carry an effect's silhouette — the muzzle flash core, the
 * explosion fireball flash, a shockwave ring, a splash ring lying on water, a
 * drifting fog bank, a tracer.
 *
 * Those live here: a few hundred quads simulated on the CPU, depth-sorted so
 * alpha blending is actually correct, and drawn in three instanced batches
 * (premultiplied alpha, additive, and refractive).
 *
 * Orientation modes let one system cover everything:
 *   BILLBOARD  camera facing, free roll
 *   ORIENTED   pinned to a world plane (decal-like: splash rings, wall flashes)
 *   BEAM       stretched from an origin along an axis, camera facing (tracers)
 *   AXIAL      cylindrical billboard around a world axis (muzzle cone, columns)
 */

import * as THREE from 'three';
import { FX_LAYER_TRANSPARENT, fxSkipPatch, makeQuadGeometry } from './Common';
import { GBUFFER_PASSTHROUGH_DECL } from './Common';
import { ATLAS_COLS, type SpriteAtlas } from './SpriteAtlas';
import { GLSL_AERIAL, GLSL_ATMOSPHERE, GLSL_COMMON, GLSL_SH, GLSL_SUN } from '../render/Glsl';

export const QUAD_MODE = {
  BILLBOARD: 0,
  ORIENTED: 1,
  BEAM: 2,
  AXIAL: 3,
} as const;

export const QUAD_BLEND = {
  ALPHA: 0,
  ADD: 1,
  REFRACT: 2,
} as const;

export interface QuadDesc {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Orientation axis: plane normal (ORIENTED), segment (BEAM), up (AXIAL). */
  ax: number; ay: number; az: number;
  w0: number; h0: number; w1: number; h1: number;
  rot: number; spin: number;
  r: number; g: number; b: number; alpha: number;
  life: number; delay: number;
  cell: number; frames: number; anim: boolean;
  mode: number; blend: number; lit: boolean;
  drag: number; gravity: number;
  fadeIn: number; fadeOut: number;
  soft: number;
  /** Extra additive gain applied to emissive quads (HDR headroom for bloom). */
  intensity: number;
}

const QUAD_DEFAULTS: QuadDesc = {
  px: 0, py: 0, pz: 0,
  vx: 0, vy: 0, vz: 0,
  ax: 0, ay: 1, az: 0,
  w0: 1, h0: 1, w1: 1, h1: 1,
  rot: 0, spin: 0,
  r: 1, g: 1, b: 1, alpha: 1,
  life: 1, delay: 0,
  cell: 0, frames: 1, anim: false,
  mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ALPHA, lit: false,
  drag: 0, gravity: 0,
  fadeIn: 0.05, fadeOut: 0.55,
  soft: 0.5,
  intensity: 1,
};

const QUAD_KEYS = Object.keys(QUAD_DEFAULTS) as (keyof QuadDesc)[];

interface Quad extends QuadDesc {
  active: boolean;
  age: number;
  depth: number;
}

/* ------------------------------------------------------------------ shaders -- */

const QUAD_VERT = /* glsl */ `
precision highp float;
${GLSL_COMMON}

in vec3 iPos;
in vec4 iSize;      // w0, h0, w1, h1
in vec4 iColor;     // rgb, alpha
in vec4 iCell;      // cellA, cellB, blendT, packed(mode + lit*4 + anim*8)
in vec4 iAxis;      // xyz axis, w rotation
in vec4 iMisc;      // softness, intensity, ageT, spare

uniform float uCellScale;
uniform float uCellCols;

out vec4 vColor;
out vec2 vQuad;
out vec4 vAtlas;
out vec4 vMisc;      // viewZ, soft, intensity, blendT
out vec3 vWorldPos;
out vec3 vRightW;
out vec3 vUpW;
flat out int vLit;

void main() {
	int packed = int( iCell.w + 0.5 );
	int mode = packed & 3;
	vLit = ( packed & 4 ) != 0 ? 1 : 0;

	float t = iMisc.z;
	float w = mix( iSize.x, iSize.z, t );
	float h = mix( iSize.y, iSize.w, t );
	vec2 corner = position.xy;

	vec3 worldPos;
	vec3 rightW;
	vec3 upW;

	vec3 camPos = cameraPosition;

	if ( mode == 1 ) {
		// ORIENTED — flat against a world plane.
		vec3 n = normalize( iAxis.xyz );
		vec3 helper = abs( n.y ) > 0.94 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
		vec3 t0 = normalize( cross( helper, n ) );
		vec3 b0 = cross( n, t0 );
		float cs = cos( iAxis.w ), sn = sin( iAxis.w );
		rightW = t0 * cs + b0 * sn;
		upW = - t0 * sn + b0 * cs;
		worldPos = iPos + rightW * ( corner.x * w ) + upW * ( corner.y * h );
	} else if ( mode == 2 ) {
		// BEAM — a segment from iPos along iAxis, always turned to the camera.
		vec3 seg = iAxis.xyz;
		float len = length( seg );
		vec3 dir = len > 1e-5 ? seg / len : vec3( 0.0, 1.0, 0.0 );
		vec3 mid = iPos + dir * ( len * 0.5 );
		vec3 toCam = normalize( camPos - mid );
		vec3 side = cross( dir, toCam );
		float sl = length( side );
		side = sl > 1e-5 ? side / sl : vec3( 1.0, 0.0, 0.0 );
		rightW = side;
		upW = dir;
		worldPos = mid + rightW * ( corner.x * w ) + upW * ( corner.y * len );
	} else if ( mode == 3 ) {
		// AXIAL — cylindrical billboard: keeps the world axis, spins to face us.
		vec3 up = normalize( iAxis.xyz );
		vec3 toCam = normalize( camPos - iPos );
		vec3 side = cross( up, toCam );
		float sl = length( side );
		side = sl > 1e-5 ? side / sl : vec3( 1.0, 0.0, 0.0 );
		rightW = side;
		upW = up;
		worldPos = iPos + rightW * ( corner.x * w ) + upW * ( corner.y * h );
	} else {
		// BILLBOARD — view aligned with free roll.
		mat3 vinv = mat3(
			viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ],
			viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ],
			viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ]
		);
		float cs = cos( iAxis.w ), sn = sin( iAxis.w );
		rightW = vinv * vec3( cs, sn, 0.0 );
		upW = vinv * vec3( - sn, cs, 0.0 );
		worldPos = iPos + rightW * ( corner.x * w ) + upW * ( corner.y * h );
	}

	vec4 viewPos = viewMatrix * vec4( worldPos, 1.0 );
	gl_Position = projectionMatrix * viewPos;

	vec2 c0 = vec2( mod( iCell.x, uCellCols ), floor( iCell.x / uCellCols ) );
	vec2 c1 = vec2( mod( iCell.y, uCellCols ), floor( iCell.y / uCellCols ) );
	vAtlas = vec4( c0 * uCellScale, c1 * uCellScale );
	vColor = iColor;
	vQuad = corner * 2.0;
	vMisc = vec4( - viewPos.z, iMisc.x, iMisc.y, iCell.z );
	vWorldPos = worldPos;
	vRightW = rightW;
	vUpW = upW;
}
`;

const QUAD_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_ATMOSPHERE}
${GLSL_SH}
${GLSL_SUN}
${GLSL_AERIAL}

in vec4 vColor;
in vec2 vQuad;
in vec4 vAtlas;
in vec4 vMisc;
in vec3 vWorldPos;
in vec3 vRightW;
in vec3 vUpW;
flat in int vLit;

layout(location = 0) out vec4 outColor;
${GBUFFER_PASSTHROUGH_DECL}

uniform sampler2D tAtlasA;
uniform sampler2D tAtlasB;
uniform sampler2D tScene;
uniform sampler2D boSceneDepth;
uniform vec4 boCameraParams;
// boSunDirWorld / boSunColor come from GLSL_SUN via GLSL_AERIAL above.
uniform vec3 boAmbientSH[ 9 ];
uniform vec3 boAmbientTint;
uniform float boAmbientIntensity;
uniform float uCellScale;
uniform float uBlendMode;   // 0 alpha, 1 additive, 2 refract
uniform float uSoft;
uniform float uAerial;
uniform float uRefractScale;

void main() {
	vec2 uv01 = vQuad * 0.5 + 0.5;
	vec4 A = texture( tAtlasA, vAtlas.xy + uv01 * uCellScale );
	vec4 B = texture( tAtlasB, vAtlas.xy + uv01 * uCellScale );
	float bt = vMisc.w;
	if ( bt > 0.001 ) {
		A = mix( A, texture( tAtlasA, vAtlas.zw + uv01 * uCellScale ), bt );
		B = mix( B, texture( tAtlasB, vAtlas.zw + uv01 * uCellScale ), bt );
	}

	float alpha = A.a * vColor.a;
	if ( alpha < 0.002 ) discard;

	float viewZ = vMisc.x;
	if ( uSoft > 0.5 && vMisc.y > 0.0 ) {
		vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
		float d = texture( boSceneDepth, suv ).r;
		float sceneZ = boLinearDepth( d, boCameraParams.x, boCameraParams.y );
		alpha *= boSat( ( sceneZ - viewZ ) / vMisc.y );
	}
	alpha *= boSat( ( viewZ - boCameraParams.x * 2.0 ) / 0.35 );
	if ( alpha < 0.002 ) discard;

	if ( uBlendMode > 1.5 ) {
		// --- refraction: bend what is behind the quad using the baked normal.
		vec2 n = ( B.rg * 2.0 - 1.0 );
		vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
		float strength = uRefractScale * alpha * vMisc.z / max( viewZ, 1.0 );
		vec3 refracted = texture( tScene, clamp( suv + n * strength, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;
		// Premultiplied "replace by alpha": the plate is the scene, warped.
		outColor = vec4( refracted * alpha, alpha );
		fxGNormal = vec4( 0.0 );
		fxGVelocity = vec4( 0.0 );
		fxGMaterial = vec4( 0.0 );
		return;
	}

	vec3 albedo = vColor.rgb * A.rgb;
	vec3 lit;

	if ( vLit == 1 ) {
		float r2 = dot( vQuad, vQuad );
		vec3 nq = vec3( vQuad, sqrt( max( 1.0 - min( r2, 1.0 ), 0.02 ) ) );
		nq.xy += ( B.rg * 2.0 - 1.0 ) * 0.8;
		nq = normalize( nq );
		vec3 fwdW = normalize( cross( vRightW, vUpW ) );
		vec3 N = normalize( vRightW * nq.x + vUpW * nq.y + fwdW * nq.z );
		vec3 V = normalize( cameraPosition - vWorldPos );
		float ndl = dot( N, boSunDirWorld );
		float wrap = boSat( ( ndl + 0.72 ) / 1.72 );
		float thickness = B.b;
		float selfShadow = exp( - thickness * 2.6 * ( 1.0 - wrap ) );
		vec3 sun = boSunColor * ( wrap * selfShadow );
		float mu = boSat( dot( - V, boSunDirWorld ) );
		sun += boSunColor * pow( mu, 5.0 ) * ( 1.0 - thickness * 0.7 ) * 1.4;
		sun *= BO_INV_PI * 0.55;
		vec3 amb = boShIrradiance( N, boAmbientSH ) * boAmbientTint * boAmbientIntensity;
		lit = albedo * ( sun + amb );
		if ( uAerial > 0.5 ) lit = boAerialPerspective( lit, vWorldPos, cameraPosition, boSunDirWorld );
	} else {
		lit = albedo * ( 0.6 + B.a * 1.8 ) * vMisc.z;
	}

	if ( uBlendMode > 0.5 ) {
		outColor = vec4( lit * alpha, 0.0 );
	} else {
		outColor = vec4( lit * alpha, alpha );
	}
	fxGNormal = vec4( 0.0 );
	fxGVelocity = vec4( 0.0 );
	fxGMaterial = vec4( 0.0 );
}
`;

/* ------------------------------------------------------------------ batches -- */

class QuadBatch {
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  private iPos: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iCell: THREE.InstancedBufferAttribute;
  private iAxis: THREE.InstancedBufferAttribute;
  private iMisc: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(
    base: THREE.BufferGeometry,
    capacity: number,
    material: THREE.ShaderMaterial,
    name: string,
    renderOrder: number,
  ) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    const mk = (items: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.iPos = mk(3); this.iSize = mk(4); this.iColor = mk(4);
    this.iCell = mk(4); this.iAxis = mk(4); this.iMisc = mk(4);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iSize', this.iSize);
    g.setAttribute('iColor', this.iColor);
    g.setAttribute('iCell', this.iCell);
    g.setAttribute('iAxis', this.iAxis);
    g.setAttribute('iMisc', this.iMisc);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;
    this.material = material;

    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.name = name;
    mesh.layers.set(FX_LAYER_TRANSPARENT);
    this.mesh = mesh;
  }

  reset(): void { this.count = 0; }

  write(q: Quad, t: number, alpha: number): void {
    const i = this.count;
    if (i * 3 + 2 >= this.iPos.array.length) return;
    this.count++;
    const p = this.iPos.array as Float32Array;
    p[i * 3] = q.px; p[i * 3 + 1] = q.py; p[i * 3 + 2] = q.pz;
    const s = this.iSize.array as Float32Array;
    s[i * 4] = q.w0; s[i * 4 + 1] = q.h0; s[i * 4 + 2] = q.w1; s[i * 4 + 3] = q.h1;
    const c = this.iColor.array as Float32Array;
    c[i * 4] = q.r; c[i * 4 + 1] = q.g; c[i * 4 + 2] = q.b; c[i * 4 + 3] = alpha;

    const frames = Math.max(1, q.frames);
    const fpos = q.anim ? Math.min(t * frames, frames - 0.001) : 0;
    const f0 = Math.floor(fpos);
    const f1 = Math.min(f0 + 1, frames - 1);
    const cell = this.iCell.array as Float32Array;
    cell[i * 4] = q.cell + f0;
    cell[i * 4 + 1] = q.cell + f1;
    cell[i * 4 + 2] = q.anim ? fpos - f0 : 0;
    cell[i * 4 + 3] = (q.mode & 3) | (q.lit ? 4 : 0);

    const a = this.iAxis.array as Float32Array;
    a[i * 4] = q.ax; a[i * 4 + 1] = q.ay; a[i * 4 + 2] = q.az; a[i * 4 + 3] = q.rot;

    const m = this.iMisc.array as Float32Array;
    m[i * 4] = q.soft; m[i * 4 + 1] = q.intensity; m[i * 4 + 2] = t; m[i * 4 + 3] = 0;
  }

  flush(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    for (const [a, items] of [
      [this.iPos, 3], [this.iSize, 4], [this.iColor, 4],
      [this.iCell, 4], [this.iAxis, 4], [this.iMisc, 4],
    ] as [THREE.InstancedBufferAttribute, number][]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * items);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------- system -- */

export class QuadFX {
  private quads: Quad[] = [];
  private batches: QuadBatch[] = [];
  private base!: THREE.BufferGeometry;
  readonly desc: QuadDesc = { ...QUAD_DEFAULTS };
  private atlas!: SpriteAtlas;

  /** Set true once a scene-colour copy is available for refraction. */
  refractionReady = false;
  /** Live quads, for the perf HUD. */
  live = 0;

  meshes: THREE.Mesh[] = [];

  init(
    atlas: SpriteAtlas,
    shared: Record<string, THREE.IUniform>,
    capacity = 512,
    softParticles = true,
  ): void {
    this.atlas = atlas;
    this.base = makeQuadGeometry();
    for (let i = 0; i < capacity; i++) {
      this.quads.push({ ...QUAD_DEFAULTS, active: false, age: 0, depth: 0 });
    }

    const make = (blend: number, name: string, order: number): QuadBatch => {
      const uniforms: Record<string, THREE.IUniform> = {
        tAtlasA: { value: atlas.a },
        tAtlasB: { value: atlas.b },
        tScene: { value: null },
        uCellScale: { value: 1 / ATLAS_COLS },
        uCellCols: { value: ATLAS_COLS },
        uBlendMode: { value: blend },
        uSoft: { value: softParticles ? 1 : 0 },
        uAerial: { value: 1 },
        uRefractScale: { value: 0.06 },
      };
      for (const k in shared) uniforms[k] = shared[k];
      if (!uniforms.boSceneDepth) uniforms.boSceneDepth = { value: null };
      if (!uniforms.boCameraParams) {
        uniforms.boCameraParams = { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) };
      }
      const mat = fxSkipPatch(new THREE.ShaderMaterial({
        name,
        glslVersion: THREE.GLSL3,
        vertexShader: QUAD_VERT,
        fragmentShader: QUAD_FRAG,
        uniforms,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: blend === QUAD_BLEND.ADD ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: blend === QUAD_BLEND.ADD ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      }));
      return new QuadBatch(this.base, capacity, mat, name, order);
    };

    this.batches[QUAD_BLEND.ALPHA] = make(QUAD_BLEND.ALPHA, 'fx:quads-alpha', 3100);
    this.batches[QUAD_BLEND.REFRACT] = make(QUAD_BLEND.REFRACT, 'fx:quads-refract', 3150);
    this.batches[QUAD_BLEND.ADD] = make(QUAD_BLEND.ADD, 'fx:quads-add', 3300);
    this.meshes = this.batches.map((b) => b.mesh);
  }

  setSceneTexture(tex: THREE.Texture | null): void {
    this.batches[QUAD_BLEND.REFRACT].material.uniforms.tScene.value = tex;
    this.refractionReady = tex !== null;
  }

  /** Called before the refractive batch draws so it can grab the framebuffer. */
  onRefractBeforeRender(fn: (() => void) | null): void {
    const mesh = this.batches[QUAD_BLEND.REFRACT].mesh;
    mesh.onBeforeRender = fn ? () => fn() : () => { /* noop */ };
  }

  setSoft(on: boolean): void {
    for (const b of this.batches) b.material.uniforms.uSoft.value = on ? 1 : 0;
  }

  begin(preset?: Partial<QuadDesc>): QuadDesc {
    const d = this.desc as unknown as Record<string, number | boolean>;
    const base = QUAD_DEFAULTS as unknown as Record<string, number | boolean>;
    for (let i = 0; i < QUAD_KEYS.length; i++) {
      const k = QUAD_KEYS[i];
      d[k] = base[k];
    }
    if (preset) Object.assign(this.desc, preset);
    return this.desc;
  }

  /** Commits the scratch descriptor. Returns false when the pool is exhausted. */
  push(): boolean {
    // Steal the shortest-remaining quad if everything is busy; a hero sprite
    // arriving late matters more than the tail of an old one.
    let slot = -1;
    let worst = Infinity;
    for (let i = 0; i < this.quads.length; i++) {
      const q = this.quads[i];
      if (!q.active) { slot = i; break; }
      const remaining = q.life - q.age;
      if (remaining < worst) { worst = remaining; slot = i; }
    }
    if (slot < 0) return false;
    const q = this.quads[slot];
    const dst = q as unknown as Record<string, number | boolean>;
    const src = this.desc as unknown as Record<string, number | boolean>;
    for (let i = 0; i < QUAD_KEYS.length; i++) {
      const k = QUAD_KEYS[i];
      dst[k] = src[k];
    }
    q.active = true;
    q.age = -Math.max(0, this.desc.delay);
    q.depth = 0;
    return true;
  }

  clear(): void {
    for (const q of this.quads) q.active = false;
    for (const b of this.batches) { b.reset(); b.flush(); }
    this.live = 0;
  }

  private visible: Quad[] = [];
  private alphaValue = new Map<Quad, number>();

  update(dt: number, camera: THREE.Camera): void {
    for (const b of this.batches) b.reset();

    const cam = camera.position;
    const visible = this.visible;
    visible.length = 0;
    this.alphaValue.clear();

    for (const q of this.quads) {
      if (!q.active) continue;
      q.age += dt;
      if (q.age >= q.life) { q.active = false; continue; }
      if (q.age < 0) continue;

      if (q.drag > 0) {
        const k = Math.exp(-q.drag * dt);
        q.vx *= k; q.vy *= k; q.vz *= k;
      }
      if (q.gravity !== 0) q.vy -= 9.81 * q.gravity * dt;
      q.px += q.vx * dt; q.py += q.vy * dt; q.pz += q.vz * dt;
      q.rot += q.spin * dt;

      const t = q.age / q.life;
      let a = q.alpha;
      if (q.fadeIn > 0) a *= Math.min(1, t / q.fadeIn);
      if (q.fadeOut < 1) a *= 1 - Math.min(1, Math.max(0, (t - q.fadeOut) / (1 - q.fadeOut)));
      if (a <= 0.002) continue;

      const dx = q.px - cam.x, dy = q.py - cam.y, dz = q.pz - cam.z;
      q.depth = dx * dx + dy * dy + dz * dz;
      this.alphaValue.set(q, a);
      visible.push(q);
    }
    this.live = visible.length;

    // Hero sprites are few enough that a real back-to-front sort is affordable,
    // and it is the only way large overlapping alpha quads composite correctly.
    visible.sort((p, q) => q.depth - p.depth);

    for (const q of visible) {
      const batch = this.batches[q.blend] ?? this.batches[QUAD_BLEND.ALPHA];
      batch.write(q, q.age / q.life, this.alphaValue.get(q) ?? q.alpha);
    }

    for (const b of this.batches) b.flush();
  }

  dispose(): void {
    for (const b of this.batches) b.dispose();
    this.base?.dispose();
    void this.atlas;
  }
}
