/**
 * Environmental effects — the layer that turns a lit box into a place with air
 * in it.
 *
 *   • wind-driven dust motes and paper scraps around the player
 *   • embers, flame and heat shimmer from fire sources
 *   • drifting low fog banks that give a sightline foreground/background depth
 *   • rain with splash rings, plus the weather hand-off to the renderer so wet
 *     surfaces get their roughness modulated
 *   • volumetric light shafts: real oriented boxes ray-marched in the fragment
 *     shader against the depth buffer, so a shaft ends on the floor instead of
 *     punching through it
 */

import * as THREE from 'three';
import { CELL } from './SpriteAtlas';
import { FLAG, MODEL } from './GpuParticles';
import { QUAD_BLEND, QUAD_MODE } from './Quads';
import { FX_LAYER_TRANSPARENT, clamp, fxSkipPatch } from './Common';
import { GBUFFER_PASSTHROUGH_DECL } from './Common';
import { GLSL_COMMON, GLSL_SUN } from '../render/Glsl';
import type { FxWorld } from './Context';

/* -------------------------------------------------------------- light shaft -- */

const SHAFT_VERT = /* glsl */ `
precision highp float;
out vec3 vLocal;
out vec3 vWorld;
void main() {
	vLocal = position;
	vec4 world = modelMatrix * vec4( position, 1.0 );
	vWorld = world.xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SHAFT_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
${GLSL_SUN}
in vec3 vLocal;
in vec3 vWorld;
layout(location = 0) out vec4 outColor;
${GBUFFER_PASSTHROUGH_DECL}

uniform mat4 uInvModel;
uniform vec3 uHalf;          // box half extents in metres (local space)
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFalloff;
uniform float uTime;
uniform float uDust;
uniform sampler2D boSceneDepth;
uniform vec4 boCameraParams;

/** Slab intersection with the local-space box. Returns false when missed. */
bool boxHit( vec3 ro, vec3 rd, vec3 h, out float t0, out float t1 ) {
	vec3 inv = 1.0 / max( abs( rd ), vec3( 1e-6 ) ) * sign( rd + 1e-9 );
	vec3 a = ( - h - ro ) * inv;
	vec3 b = ( h - ro ) * inv;
	vec3 lo = min( a, b );
	vec3 hi = max( a, b );
	t0 = max( max( lo.x, lo.y ), lo.z );
	t1 = min( min( hi.x, hi.y ), hi.z );
	return t1 > max( t0, 0.0 );
}

void main() {
	vec3 roL = ( uInvModel * vec4( cameraPosition, 1.0 ) ).xyz;
	vec3 rdW = normalize( vWorld - cameraPosition );
	vec3 rdL = normalize( ( uInvModel * vec4( rdW, 0.0 ) ).xyz );

	float t0, t1;
	if ( ! boxHit( roL, rdL, uHalf, t0, t1 ) ) discard;
	t0 = max( t0, 0.0 );

	// Stop the shaft where solid geometry starts, or it lances through floors.
	vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
	float d = texture( boSceneDepth, suv ).r;
	float sceneZ = boLinearDepth( d, boCameraParams.x, boCameraParams.y );
	vec3 camFwd = - vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
	float sceneDist = sceneZ / max( dot( rdW, camFwd ), 1e-3 );
	t1 = min( t1, sceneDist );
	if ( t1 <= t0 ) discard;

	// March the segment: falloff along the shaft axis (local +z is "away from
	// the window") plus a soft radial mask and slowly drifting dust density.
	const int STEPS = 6;
	float seg = ( t1 - t0 ) / float( STEPS );
	float acc = 0.0;
	for ( int i = 0; i < STEPS; i ++ ) {
		vec3 p = roL + rdL * ( t0 + seg * ( float( i ) + 0.5 ) );
		float along = boSat( ( p.z + uHalf.z ) / ( 2.0 * uHalf.z ) );
		float axial = exp( - along * uFalloff );
		vec2 radial = abs( p.xy ) / uHalf.xy;
		float mask = ( 1.0 - smoothstep( 0.55, 1.0, radial.x ) ) * ( 1.0 - smoothstep( 0.55, 1.0, radial.y ) );
		// Slight spread with distance, as a real beam does.
		mask *= mix( 1.0, 0.75, along );
		float dust = mix( 1.0, 0.45 + 1.15 * boFbm( p * 0.55 + vec3( uTime * 0.09, uTime * 0.05, - uTime * 0.07 ), 3 ), uDust );
		acc += axial * mask * dust * seg;
	}

	// Forward scattering: a shaft is far brighter when you look up it.
	float mu = boSat( dot( - rdW, boSunDirWorld ) );
	float phase = 0.55 + 1.9 * pow( mu, 4.0 );

	float amount = acc * uIntensity * phase;
	if ( amount < 0.0004 ) discard;
	outColor = vec4( uColor * amount, 0.0 );
	fxGNormal = vec4( 0.0 );
	fxGVelocity = vec4( 0.0 );
	fxGMaterial = vec4( 0.0 );
}
`;

export interface ShaftOptions {
  width: number;
  height: number;
  length: number;
  color?: number;
  intensity?: number;
  falloff?: number;
  dust?: number;
}

interface Fire {
  active: boolean;
  x: number; y: number; z: number;
  radius: number;
  intensity: number;
  acc: number;
  lightTimer: number;
  floorY: number;
}

/* ------------------------------------------------------------------ system -- */

export class EnvironmentFX {
  objects: THREE.Object3D[] = [];
  private shafts: THREE.Mesh[] = [];
  private shaftGeoms: THREE.BufferGeometry[] = [];
  private shared: Record<string, THREE.IUniform> = {};

  private fires: Fire[] = [];
  private moteAcc = 0;
  private scrapAcc = 0;
  /**
   * Expiry clocks for the ambient layers.
   *
   * Rate alone is not a population control: the emitter runs off `dt`, and any
   * hitch, capture step or slow frame silently multiplies how many particles
   * are in flight. Ambient dust and litter are *always on*, so an unbounded
   * population is how a scene ends up with scraps tumbling across the sky.
   * These rings make the live count a hard number instead of an estimate.
   */
  private moteDeath: number[] = [];
  private scrapDeath: number[] = [];
  private rainAcc = 0;
  private splashAcc = 0;
  private fogTimer = 0;

  /** 0..1 — drives rain particles and the renderer's wetness. */
  rain = 0;
  /** 0..1 — drives drifting fog banks. */
  fog = 0;
  /** Ambient dust density around the player, 0..1. */
  dust = 0.55;
  /** Wind-blown litter, 0..1. */
  litter = 0.25;
  fogBanks = 0;

  private tmp = new THREE.Vector3();
  private quatScratch = new THREE.Quaternion();
  private matScratch = new THREE.Matrix4();

  init(shared: Record<string, THREE.IUniform>, fireBudget = 6): void {
    this.shared = shared;
    for (let i = 0; i < fireBudget; i++) {
      this.fires.push({
        active: false, x: 0, y: 0, z: 0, radius: 0.5,
        intensity: 1, acc: 0, lightTimer: 0, floorY: 0,
      });
    }
  }

  clear(): void {
    for (const f of this.fires) f.active = false;
    for (const m of this.shafts) m.visible = false;
    this.moteAcc = 0; this.rainAcc = 0; this.scrapAcc = 0;
    this.moteDeath.length = 0; this.scrapDeath.length = 0;
    this.fogBanks = 0;
    this.fogTimer = 0;
  }

  /** Drops expired entries and reports how many of a layer are still alive. */
  private alive(ring: number[], now: number): number {
    let n = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i] <= now) ring.splice(i, 1); else n++;
    }
    return n;
  }

  /* ------------------------------------------------------------------ fire */

  addFire(w: FxWorld, point: THREE.Vector3, radius = 0.6, intensity = 1): number {
    let idx = this.fires.findIndex((f) => !f.active);
    if (idx < 0) idx = 0;
    const f = this.fires[idx];
    f.active = true;
    f.x = point.x; f.y = point.y; f.z = point.z;
    f.radius = radius;
    f.intensity = intensity;
    f.acc = 0;
    f.lightTimer = 0;
    f.floorY = w.floorUnder(point.x, point.y, point.z);
    return idx;
  }

  removeFire(index: number): void {
    if (this.fires[index]) this.fires[index].active = false;
  }

  /* ---------------------------------------------------------- light shafts */

  /**
   * A shaft is an oriented box: `origin` is the middle of the window, `dir` is
   * the light direction, `up` orients the window's height axis.
   */
  addLightShaft(
    origin: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, o: ShaftOptions,
  ): THREE.Mesh {
    const d = this.tmp.copy(dir).normalize();
    const geo = new THREE.BoxGeometry(o.width, o.height, o.length);
    this.shaftGeoms.push(geo);

    const uniforms: Record<string, THREE.IUniform> = {
      uInvModel: { value: new THREE.Matrix4() },
      uHalf: { value: new THREE.Vector3(o.width * 0.5, o.height * 0.5, o.length * 0.5) },
      uColor: { value: new THREE.Color(o.color ?? 0xfff0d8) },
      uIntensity: { value: o.intensity ?? 0.16 },
      uFalloff: { value: o.falloff ?? 1.6 },
      uTime: { value: 0 },
      uDust: { value: o.dust ?? 0.85 },
    };
    for (const k in this.shared) uniforms[k] = this.shared[k];
    if (!uniforms.boSceneDepth) uniforms.boSceneDepth = { value: null };
    if (!uniforms.boCameraParams) {
      uniforms.boCameraParams = { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) };
    }
    if (!uniforms.boSunDirWorld) uniforms.boSunDirWorld = { value: new THREE.Vector3(0, 1, 0) };

    const mat = fxSkipPatch(new THREE.ShaderMaterial({
      name: 'fx:lightshaft',
      glslVersion: THREE.GLSL3,
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2900;
    mesh.castShadow = false;
    mesh.name = 'fx:lightshaft';
    mesh.layers.set(FX_LAYER_TRANSPARENT);

    // Point local +Z down the light direction.
    this.matScratch.lookAt(new THREE.Vector3(0, 0, 0), d.clone().negate(), up);
    this.quatScratch.setFromRotationMatrix(this.matScratch);
    mesh.quaternion.copy(this.quatScratch);
    mesh.position.copy(origin).addScaledVector(d, o.length * 0.5);
    mesh.updateMatrixWorld(true);
    (mesh.material as THREE.ShaderMaterial).uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();

    this.shafts.push(mesh);
    this.objects.push(mesh);
    return mesh;
  }

  /* ---------------------------------------------------------------- update */

  update(dt: number, w: FxWorld): void {
    const g = w.particles;
    const rand = w.rand;
    const cam = w.camera.position;

    for (const m of this.shafts) {
      const u = (m.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = w.clock;
    }

    /* --- ambient dust motes -------------------------------------------
     *
     * Motes are *additive glints*, not alpha sprites. A speck of dust is far
     * too small to occlude anything: what the eye actually sees is the light
     * it scatters, which means it flares when it is between you and the sun
     * and disappears against a bright sky. Rendering them with alpha instead
     * paints grey dots over the whole frame — the single fastest way to make
     * a scene look like it has dirt on the lens.
     */
    if (this.dust > 0) {
      const moteCap = Math.round(26 * this.dust * w.density);
      const moteLive = this.alive(this.moteDeath, w.clock);
      this.moteAcc += dt * 20 * this.dust * w.density;
      const n = Math.min(Math.floor(this.moteAcc), Math.max(0, moteCap - moteLive));
      if (n > 0) {
        this.moteAcc = 0;
        const floorY = w.floorUnder(cam.x, cam.y, cam.z);
        g.begin({
          cell: CELL.GLOW_SOFT, frames: 1, model: MODEL.THIN,
          flags: FLAG.ADD | FLAG.FADEIN | FLAG.SHADOW | FLAG.NOSOFT,
          r: 1.0, g: 0.93, b: 0.80, opacity: 0.14,
          drag: 2.4, gravity: 0.004, turbulence: 0.20,
        });
        for (let i = 0; i < n; i++) {
          const d = g.desc;
          const ma = rand.range(0, Math.PI * 2);
          // Near field for parallax, but never so near that one mote can own a
          // patch of the frame: at arm's length a 1 cm sprite is a 40 px smudge.
          const mr = 3.2 + rand.next() * rand.next() * 10;
          d.px = cam.x + Math.cos(ma) * mr;
          d.py = clamp(cam.y + rand.range(-1.8, 1.6), floorY + 0.15, floorY + 4.5);
          d.pz = cam.z + Math.sin(ma) * mr;
          d.vx = rand.signed() * 0.10;
          d.vy = rand.signed() * 0.05;
          d.vz = rand.signed() * 0.10;
          d.sizeBegin = 0.004 + rand.next() * 0.008;
          d.sizeEnd = d.sizeBegin;
          d.lifetime = 5 + rand.next() * 7;
          this.moteDeath.push(w.clock + d.lifetime);
          g.push();
        }
      }
    }

    /* --- wind-blown litter --------------------------------------------
     *
     * Scraps are the one environmental element that legitimately occludes,
     * so they stay alpha — but they are kept small, sparse and inside the
     * lower half of the sightline. Litter tumbling through the sky reads as
     * a bug; litter skittering across the cobbles reads as wind.
     */
    if (this.litter > 0) {
      // Three scraps in flight at full weather. Wind-blown litter is punctuation
      // in a sightline, not a texture: more than a handful and the frame reads
      // as though the lens is dirty.
      const scrapCap = Math.max(1, Math.round(3 * this.litter * w.density));
      const scrapLive = this.alive(this.scrapDeath, w.clock);
      this.scrapAcc += dt * 0.55 * this.litter * w.density;
      const n = Math.min(Math.floor(this.scrapAcc), Math.max(0, scrapCap - scrapLive));
      if (n > 0) {
        this.scrapAcc = 0;
        const floorY = w.floorUnder(cam.x, cam.y, cam.z);
        g.begin({
          cell: CELL.PAPER, frames: 1, model: MODEL.SOLID,
          flags: FLAG.SHADOW | FLAG.FADEIN,
          r: 0.60, g: 0.56, b: 0.49, opacity: 0.85,
          drag: 2.6, gravity: 0.05, turbulence: 1.6, floorY,
        });
        for (let i = 0; i < n; i++) {
          const d = g.desc;
          const a = rand.range(0, Math.PI * 2);
          // Spawned far enough out that the wind cannot carry a scrap into the
          // lens inside its own lifetime: at ~1 m/s it covers 7 m before it dies.
          const r = 11 + rand.next() * 15;
          d.px = cam.x + Math.cos(a) * r;
          d.py = floorY + rand.range(0.04, 1.15);
          d.pz = cam.z + Math.sin(a) * r;
          d.vx = w.wind.x * 1.4; d.vy = 0.12; d.vz = w.wind.z * 1.4;
          d.sizeBegin = 0.009 + rand.next() * 0.016;
          d.sizeEnd = d.sizeBegin;
          d.lifetime = 4 + rand.next() * 3;
          d.rot = rand.range(0, 6.28);
          d.spin = rand.signed() * 3;
          this.scrapDeath.push(w.clock + d.lifetime);
          g.push();
        }
      }
    }

    /* --- drifting fog banks ------------------------------------------- */
    if (this.fog > 0.01) {
      this.fogTimer -= dt;
      const want = Math.round(6 * this.fog * w.density);
      if (this.fogTimer <= 0 && this.fogBanks < want) {
        this.fogTimer = 1.4;
        this.fogBanks++;
        const a = rand.range(0, Math.PI * 2);
        const r = 12 + rand.next() * 22;
        const floorY = w.floorUnder(cam.x + Math.cos(a) * r, cam.y, cam.z + Math.sin(a) * r);
        w.quads.begin({
          px: cam.x + Math.cos(a) * r,
          py: floorY + 0.6 + rand.next() * 1.6,
          pz: cam.z + Math.sin(a) * r,
          vx: w.wind.x * 0.35, vy: 0.01, vz: w.wind.z * 0.35,
          w0: 10 + rand.next() * 8, h0: 4 + rand.next() * 3,
          w1: 18 + rand.next() * 10, h1: 6 + rand.next() * 4,
          r: 0.80, g: 0.82, b: 0.86, alpha: 0.16 * this.fog,
          life: 26 + rand.next() * 14, cell: CELL.CLOUD, frames: 1,
          mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ALPHA, lit: true,
          fadeIn: 0.18, fadeOut: 0.55, soft: 2.5,
          rot: rand.range(0, 6.28), spin: rand.signed() * 0.012,
        });
        if (!w.quads.push()) this.fogBanks--;
      }
    }

    /* --- rain ---------------------------------------------------------- */
    if (this.rain > 0.01) {
      const floorY = w.floorUnder(cam.x, cam.y, cam.z);
      this.rainAcc += dt * 620 * this.rain * w.density;
      const n = Math.min(320, Math.floor(this.rainAcc));
      if (n > 0) {
        this.rainAcc -= n;
        g.begin({
          cell: CELL.RAIN, frames: 1, model: MODEL.THIN,
          flags: FLAG.STRETCH | FLAG.NOSOFT,
          r: 0.68, g: 0.74, b: 0.82, opacity: 0.32,
          drag: 0.02, gravity: 1.0,
        });
        for (let i = 0; i < n; i++) {
          const d = g.desc;
          const ra = rand.range(0, Math.PI * 2);
          const rr = 3.5 + rand.next() * 11;
          d.px = cam.x + Math.cos(ra) * rr;
          d.py = cam.y + rand.range(4, 11);
          d.pz = cam.z + Math.sin(ra) * rr;
          d.vx = w.wind.x * 0.8; d.vy = -14 - rand.next() * 6; d.vz = w.wind.z * 0.8;
          d.sizeBegin = 0.010; d.sizeEnd = 0.010;
          d.lifetime = 1.0 + rand.next() * 0.4;
          g.push();
        }
      }

      // Splashes on the ground: rings plus a short burst of droplets.
      this.splashAcc += dt * 60 * this.rain * w.density;
      const s = Math.floor(this.splashAcc);
      if (s > 0) {
        this.splashAcc -= s;
        for (let i = 0; i < s; i++) {
          const x = cam.x + rand.range(-9, 9);
          const z = cam.z + rand.range(-9, 9);
          w.quads.begin({
            px: x, py: floorY + 0.03, pz: z,
            ax: 0, ay: 1, az: 0,
            w0: 0.02, h0: 0.02, w1: 0.20, h1: 0.20,
            r: 0.80, g: 0.86, b: 0.92, alpha: 0.35,
            life: 0.32, cell: CELL.SPLASH_RING, frames: 1,
            mode: QUAD_MODE.ORIENTED, blend: QUAD_BLEND.ALPHA, lit: true,
            fadeIn: 0.05, fadeOut: 0.2, soft: 0.1, rot: rand.range(0, 6.28),
          });
          w.quads.push();

          g.begin({
            cell: CELL.WATER_DROP, frames: 1, model: MODEL.THIN,
            flags: FLAG.STRETCH,
            r: 0.75, g: 0.82, b: 0.90, opacity: 0.5,
            drag: 0.4, gravity: 1,
            px: x, py: floorY + 0.01, pz: z,
          });
          g.pushMany(3, (d) => {
            const a = rand.range(0, Math.PI * 2);
            d.vx = Math.cos(a) * (0.4 + rand.next() * 0.7);
            d.vy = 0.9 + rand.next() * 0.7;
            d.vz = Math.sin(a) * (0.4 + rand.next() * 0.7);
            d.sizeBegin = 0.008; d.sizeEnd = 0.004;
            d.lifetime = 0.22 + rand.next() * 0.15;
          });
        }
      }
    }

    /* --- fires --------------------------------------------------------- */
    for (const f of this.fires) {
      if (!f.active) continue;
      f.acc += dt * 40 * f.intensity * w.density;
      const n = Math.floor(f.acc);
      if (n > 0) {
        f.acc -= n;
        // flame tongues
        g.begin({
          cell: CELL.FLAME, frames: CELL.FLAME_FRAMES, model: MODEL.HOT,
          flags: FLAG.ADD | FLAG.ANIM | FLAG.FADEIN,
          r: 1.0, g: 0.45, b: 0.13, opacity: 0.42, emissive: 0.42,
          drag: 1.6, gravity: -0.75, turbulence: 1.6,
        });
        for (let i = 0; i < n; i++) {
          const d = g.desc;
          const a = rand.range(0, Math.PI * 2);
          const rr = rand.next() * f.radius;
          d.px = f.x + Math.cos(a) * rr;
          d.py = f.y;
          d.pz = f.z + Math.sin(a) * rr;
          d.vx = Math.cos(a) * 0.25; d.vy = 1.4 + rand.next() * 1.6; d.vz = Math.sin(a) * 0.25;
          d.sizeBegin = f.radius * 0.5;
          d.sizeEnd = f.radius * 1.1;
          d.lifetime = 0.35 + rand.next() * 0.35;
          d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 2;
          g.push();
        }
        // embers rising out of it
        g.begin({
          cell: CELL.EMBER, frames: 1, model: MODEL.HOT,
          flags: FLAG.ADD | FLAG.HOTRAMP | FLAG.FLICKER | FLAG.NOSOFT,
          r: 1.0, g: 0.62, b: 0.24, opacity: 1, emissive: 1.0,
          drag: 0.9, gravity: -0.35, turbulence: 2.4,
        });
        g.pushMany(Math.max(1, n * 0.3), (d) => {
          const a = rand.range(0, Math.PI * 2);
          const rr = rand.next() * f.radius;
          d.px = f.x + Math.cos(a) * rr;
          d.py = f.y + 0.1;
          d.pz = f.z + Math.sin(a) * rr;
          d.vx = Math.cos(a) * 0.4 + w.wind.x * 0.5;
          d.vy = 1.6 + rand.next() * 2.2;
          d.vz = Math.sin(a) * 0.4 + w.wind.z * 0.5;
          d.sizeBegin = 0.020 + rand.next() * 0.018;
          d.sizeEnd = 0.005;
          d.lifetime = 1.8 + rand.next() * 2.6;
        });
        // smoke above the flame
        g.begin({
          cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
          flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
          r: 0.11, g: 0.104, b: 0.10, opacity: 0.52,
          drag: 0.8, gravity: -0.16, turbulence: 1.3,
        });
        g.pushMany(Math.max(1, n * 0.42), (d) => {
          const a = rand.range(0, Math.PI * 2);
          d.px = f.x + Math.cos(a) * f.radius * 0.6;
          d.py = f.y + f.radius * 1.6;
          d.pz = f.z + Math.sin(a) * f.radius * 0.6;
          d.vx = w.wind.x * 0.6; d.vy = 1.5 + rand.next(); d.vz = w.wind.z * 0.6;
          d.sizeBegin = f.radius * 0.9;
          d.sizeEnd = f.radius * (3 + rand.next() * 2);
          d.lifetime = 3 + rand.next() * 3;
          d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.3;
        });
      }

      // Flicker light, refreshed a few times a second so it never goes flat.
      f.lightTimer -= dt;
      if (f.lightTimer <= 0) {
        f.lightTimer = 0.22;
        w.light({
          x: f.x, y: f.y + f.radius * 1.2, z: f.z,
          color: 0xff7a2a,
          intensity: 7 * f.intensity * (0.7 + rand.next() * 0.6),
          radius: f.radius * 14,
          lifetime: 0.3,
          decay: 'flicker',
        });
      }

      // Heat shimmer over the flame.
      if (w.quads.refractionReady && rand.bool(0.25)) {
        w.quads.begin({
          px: f.x + rand.signed() * f.radius, py: f.y + f.radius * 1.8, pz: f.z + rand.signed() * f.radius,
          vy: 1.4,
          w0: f.radius * 1.4, h0: f.radius * 1.4, w1: f.radius * 2.6, h1: f.radius * 3.4,
          r: 1, g: 1, b: 1, alpha: 0.7,
          life: 1.1, cell: rand.bool() ? CELL.HAZE_A : CELL.HAZE_B, frames: 1,
          mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.REFRACT,
          fadeIn: 0.3, fadeOut: 0.4, soft: 0.5, intensity: 1.4,
          rot: rand.range(0, 6.28), spin: rand.signed() * 0.4,
        });
        w.quads.push();
      }
    }
  }

  /** Bullet passing near the camera: a fast streak plus displaced air. */
  whizzBy(w: FxWorld, from: THREE.Vector3, direction: THREE.Vector3, distance: number): void {
    const rand = w.rand;
    const q = w.quads;
    const strength = clamp(1 - distance / 3.2, 0, 1);
    if (strength <= 0.02) return;

    // A near-invisible streak — it is the motion in the periphery that reads,
    // not the sprite itself.
    q.begin({
      px: from.x, py: from.y, pz: from.z,
      vx: direction.x * 260, vy: direction.y * 260, vz: direction.z * 260,
      ax: direction.x * 6, ay: direction.y * 6, az: direction.z * 6,
      w0: 0.10, h0: 1, w1: 0.06, h1: 1,
      r: 0.85, g: 0.88, b: 0.95, alpha: 0.28 * strength,
      life: 0.22, cell: CELL.RAIN, frames: 1,
      mode: QUAD_MODE.BEAM, blend: QUAD_BLEND.ADD,
      fadeIn: 0.05, fadeOut: 0.4, soft: 0.4, intensity: 1.2,
    });
    q.push();
    if (strength > 0.5) w.shake(0.006 * strength, 46, 0.09);
    void rand;
  }

  /** Lingering haze from sustained incoming fire. */
  suppressionHaze(w: FxWorld, amount: number): void {
    if (amount <= 0.05) return;
    const g = w.particles;
    const rand = w.rand;
    const cam = w.camera.position;
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.62, g: 0.60, b: 0.57, opacity: 0.045 * clamp(amount / 4, 0.2, 1),
      drag: 1.0, gravity: -0.02, turbulence: 1.4,
    });
    g.pushMany(1, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const r = 2 + rand.next() * 5;
      d.px = cam.x + Math.cos(a) * r;
      d.py = cam.y + rand.range(-1.2, 1.4);
      d.pz = cam.z + Math.sin(a) * r;
      d.vx = w.wind.x * 0.4; d.vy = 0.15; d.vz = w.wind.z * 0.4;
      d.sizeBegin = 0.6; d.sizeEnd = 2.6 + rand.next() * 1.6;
      d.lifetime = 3 + rand.next() * 3;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.15;
    });
  }

  dispose(): void {
    for (const g of this.shaftGeoms) g.dispose();
    for (const m of this.shafts) (m.material as THREE.Material).dispose();
  }
}
