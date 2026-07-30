/**
 * Explosions.
 *
 * The single biggest tell of an amateur explosion is that it happens all at
 * once. A real detonation is a *sequence*, and the eye reads the sequence even
 * at a tenth of a second:
 *
 *   0 ms    white flash, hard light on every surface, concussion
 *   0-350   fireball: a displaced sphere of burning gas that rolls outward and
 *           upward, cooling from white through orange to soot
 *   30-400  shockwave: a refracting ring of compressed air outrunning the fire
 *   60-900  ground wave: dust sheared off the floor, travelling out flat
 *   0-3 s   embers and debris on ballistic arcs, bouncing where they land
 *   200 ms+ a buoyant smoke column that leans into the wind and hangs
 *
 * The fireball is a real mesh with a noise-displaced surface, not a sprite —
 * that is what gives it silhouette and mass.
 */

import * as THREE from 'three';
import { CELL } from './SpriteAtlas';
import { FLAG, MODEL } from './GpuParticles';
import { QUAD_BLEND, QUAD_MODE } from './Quads';
import { clamp, fxSkipPatch, FX_LAYER_TRANSPARENT } from './Common';
import { GBUFFER_PASSTHROUGH_DECL } from './Common';
import { GLSL_COMMON } from '../render/Glsl';
import type { FxWorld } from './Context';

/* ---------------------------------------------------------------- fireball -- */

const FIREBALL_VERT = /* glsl */ `
precision highp float;
${GLSL_COMMON}
uniform float uT;         // 0..1 through the fireball's life
uniform float uRadius;
uniform float uSeed;
uniform float uRoll;
out vec3 vDir;
out float vDisp;
out vec3 vWorld;
out float vViewZ;

void main() {
	vec3 n = normalize( position );
	// Two octaves scrolling downward through the noise field make the surface
	// roll *upward*, which is the motion that reads as buoyant burning gas.
	float d1 = boFbm( n * 2.1 + vec3( uSeed, - uRoll * 1.15, uSeed * 0.5 ), 4 );
	float d2 = boFbm( n * 5.3 + vec3( uSeed * 2.0, - uRoll * 2.1, 0.0 ), 3 );
	float disp = d1 * 0.7 + d2 * 0.3;
	// Early on the ball is tight and lumpy; later it inflates and smooths out.
	float amp = mix( 0.55, 0.30, uT );
	float r = uRadius * ( 1.0 - amp * 0.5 + amp * disp * 2.0 );
	vec3 p = n * r;
	// Buoyancy: the whole ball lifts and stretches as it ages.
	p.y += uRadius * uT * 0.55;
	p.y *= 1.0 + uT * 0.25;
	vDir = n;
	vDisp = disp;
	vec4 view = viewMatrix * vec4( p + modelMatrix[ 3 ].xyz, 1.0 );
	vWorld = p + modelMatrix[ 3 ].xyz;
	vViewZ = - view.z;
	gl_Position = projectionMatrix * view;
}
`;

const FIREBALL_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
in vec3 vDir;
in float vDisp;
in vec3 vWorld;
in float vViewZ;
layout(location = 0) out vec4 outColor;
${GBUFFER_PASSTHROUGH_DECL}
uniform float uT;
uniform float uSeed;
uniform float uRoll;
uniform float uPower;
uniform sampler2D boSceneDepth;
uniform vec4 boCameraParams;
uniform float uSoft;

void main() {
	vec3 V = normalize( cameraPosition - vWorld );
	float facing = boSat( dot( normalize( vDir ), V ) );

	float fine = boFbm( vDir * 9.0 + vec3( uSeed, - uRoll * 2.6, 0.0 ), 4 );
	// Temperature: hottest in the deep folds early on, cooling from the rim in.
	float heat = boSat( ( vDisp * 1.35 + fine * 0.45 - 0.52 ) * 2.6 );
	heat *= pow( 1.0 - uT, 1.35 );
	heat = boSat( heat * ( 0.35 + 0.70 * facing ) );

	// Blackbody-ish ramp: deep red -> orange -> yellow -> white.
	vec3 c = mix( vec3( 0.32, 0.030, 0.006 ), vec3( 1.0, 0.30, 0.03 ), boSat( heat * 2.2 ) );
	c = mix( c, vec3( 1.0, 0.72, 0.22 ), boSat( ( heat - 0.35 ) * 2.4 ) );
	c = mix( c, vec3( 1.0, 0.95, 0.80 ), boSat( ( heat - 0.72 ) * 3.2 ) );

	// Soot: the cooling shell turns to smoke from the outside in, and there is
	// always some rolling through even at peak — a fireball that is uniformly
	// incandescent reads as a light bulb, not as burning fuel.
	float soot = boSat( ( uT - 0.10 ) * 1.7 + ( 0.62 - vDisp ) * 1.5 ) * ( 1.0 - heat * 0.85 );
	c = mix( c, vec3( 0.045, 0.040, 0.038 ), soot );

	float gain = mix( 0.85, 0.22, boSat( uT * 1.5 ) ) * uPower;
	c *= 0.35 + gain * heat + soot * 0.15;

	// Opaque core, ragged edge: the silhouette must be broken up or the whole
	// thing reads as a ball.
	// A wide limb ramp: the alpha has to be near zero *before* the geometric
	// silhouette, or the tessellation shows up as a straight cut against the sky.
	float edge = smoothstep( 0.0, 0.62, facing );
	// Break the silhouette per pixel. The displacement arrives interpolated
	// across the mesh triangles, so on its own the outline shows facets.
	float alpha = boSat( ( 0.24 + vDisp * 1.15 + ( fine - 0.5 ) * 0.85 ) * edge );
	alpha *= 1.0 - smoothstep( 0.55, 1.0, uT );

	if ( uSoft > 0.5 ) {
		vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
		float d = texture( boSceneDepth, suv ).r;
		float sceneZ = boLinearDepth( d, boCameraParams.x, boCameraParams.y );
		alpha *= boSat( ( sceneZ - vViewZ ) / 0.6 );
	}
	if ( alpha < 0.004 ) discard;

	outColor = vec4( c * alpha, alpha );
	fxGNormal = vec4( 0.0 );
	fxGVelocity = vec4( 0.0 );
	fxGMaterial = vec4( 0.0 );
}
`;

interface Fireball {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  active: boolean;
  age: number;
  life: number;
  radius: number;
}

/* ------------------------------------------------------------------ system -- */

export class Explosions {
  private fireballs: Fireball[] = [];
  private geometry!: THREE.IcosahedronGeometry;
  objects: THREE.Object3D[] = [];

  init(shared: Record<string, THREE.IUniform>, count = 3, soft = true): void {
    this.geometry = new THREE.IcosahedronGeometry(1, 5);
    for (let i = 0; i < count; i++) {
      const uniforms: Record<string, THREE.IUniform> = {
        uT: { value: 0 }, uRadius: { value: 1 }, uSeed: { value: i * 7.3 },
        uRoll: { value: 0 }, uPower: { value: 1 }, uSoft: { value: soft ? 1 : 0 },
      };
      for (const k in shared) uniforms[k] = shared[k];
      if (!uniforms.boSceneDepth) uniforms.boSceneDepth = { value: null };
      if (!uniforms.boCameraParams) {
        uniforms.boCameraParams = { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) };
      }
      const material = fxSkipPatch(new THREE.ShaderMaterial({
        name: 'fx:fireball',
        glslVersion: THREE.GLSL3,
        vertexShader: FIREBALL_VERT,
        fragmentShader: FIREBALL_FRAG,
        uniforms,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }));
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 3050;
      mesh.castShadow = false;
      mesh.name = `fx:fireball${i}`;
      mesh.layers.set(FX_LAYER_TRANSPARENT);
      this.fireballs.push({ mesh, material, active: false, age: 0, life: 1, radius: 1 });
      this.objects.push(mesh);
    }
  }

  clear(): void {
    for (const f of this.fireballs) { f.active = false; f.mesh.visible = false; }
  }

  update(dt: number): void {
    for (const f of this.fireballs) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) { f.active = false; f.mesh.visible = false; continue; }
      const t = f.age / f.life;
      // Fast expansion that eases hard — the classic detonation curve.
      const grow = 1 - Math.pow(1 - t, 2.6);
      f.material.uniforms.uT.value = t;
      f.material.uniforms.uRadius.value = f.radius * (0.18 + 0.82 * grow);
      f.material.uniforms.uRoll.value = f.age * 1.6;
    }
  }

  private spawnFireball(p: THREE.Vector3, radius: number, power: number, life: number): void {
    let best: Fireball | null = null;
    let worst = Infinity;
    for (const f of this.fireballs) {
      if (!f.active) { best = f; break; }
      const remain = f.life - f.age;
      if (remain < worst) { worst = remain; best = f; }
    }
    if (!best) return;
    best.active = true;
    best.age = 0;
    best.life = life;
    best.radius = radius;
    best.mesh.position.copy(p);
    best.mesh.visible = true;
    best.mesh.updateMatrixWorld(true);
    best.material.uniforms.uPower.value = power;
    best.material.uniforms.uT.value = 0;
    best.material.uniforms.uRadius.value = radius * 0.18;
  }

  /* ------------------------------------------------------------------ spawn */

  detonate(
    w: FxWorld,
    point: THREE.Vector3,
    radius: number,
    power: number,
    kind: string,
  ): void {
    const rand = w.rand;
    const g = w.particles;
    const q = w.quads;
    const scale = clamp(radius / 6, 0.35, 3);
    const floorY = w.floorUnder(point.x, point.y, point.z);
    const overGround = point.y - floorY;
    const dist = w.distanceToCamera(point.x, point.y, point.z);

    /* --- 0 ms: flash + light + concussion ------------------------------- */
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: radius * 0.25, h0: radius * 0.25, w1: radius * 0.95, h1: radius * 0.95,
      r: 1.0, g: 0.93, b: 0.80, alpha: 1,
      life: 0.10, cell: CELL.FLASH_DISC, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.06, fadeOut: 0.18, soft: 0, intensity: 0.85 * power,
      rot: rand.range(0, 6.28),
    });
    q.push();

    w.light({
      x: point.x, y: point.y + radius * 0.2, z: point.z,
      color: 0xffb060, intensity: 9 * power * scale,
      radius: radius * 5, lifetime: 0.8, decay: 'flash',
    });

    const proximity = clamp(1 - dist / (radius * 3.2), 0, 1);
    if (proximity > 0.01) {
      w.flash(0.55 * proximity * proximity * power, 0xffd8a8, 7.5);
      w.concussion(1.15 * proximity, 1.6);
      // A blast you are 12 m from moves the camera by about a degree, not
      // five. Anything more and the motion-blur pass smears the whole frame
      // into porridge for the second the explosion is worth watching.
      w.shake(0.022 * proximity * power, 10, 0.5);
    }

    /* --- fireball ------------------------------------------------------- */
    this.spawnFireball(point, radius * 0.75, power, 0.62 + scale * 0.18);
    // A second, smaller, slightly offset ball breaks the symmetry.
    if (w.density > 0.5) {
      this.spawnFireball(
        new THREE.Vector3(
          point.x + rand.signed() * radius * 0.18,
          point.y + radius * 0.22,
          point.z + rand.signed() * radius * 0.18,
        ),
        radius * 0.45, power * 0.8, 0.5 + scale * 0.15,
      );
    }

    /* --- shockwave: a refracting shell outrunning the fire -------------- */
    const refract = q.refractionReady;
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: radius * 0.5, h0: radius * 0.5, w1: radius * 3.4, h1: radius * 3.4,
      r: 1, g: 1, b: 1, alpha: refract ? 0.85 : 0.16,
      life: 0.36, cell: CELL.RING, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: refract ? QUAD_BLEND.REFRACT : QUAD_BLEND.ADD,
      fadeIn: 0.04, fadeOut: 0.15, soft: 0.8, intensity: 1.6,
      rot: rand.range(0, 6.28),
    });
    q.push();

    // Ground ring — the pressure front skimming the floor.
    if (overGround < radius * 0.8) {
      q.begin({
        px: point.x, py: floorY + 0.02, pz: point.z,
        ax: 0, ay: 1, az: 0,
        w0: radius * 0.4, h0: radius * 0.4, w1: radius * 3.0, h1: radius * 3.0,
        r: 0.62, g: 0.58, b: 0.52, alpha: 0.55,
        life: 0.75, cell: CELL.RING, frames: 1,
        mode: QUAD_MODE.ORIENTED, blend: QUAD_BLEND.ALPHA, lit: true,
        fadeIn: 0.05, fadeOut: 0.25, soft: 0.4, rot: rand.range(0, 6.28),
      });
      q.push();
    }

    /* --- burning gas ---------------------------------------------------- */
    g.begin({
      cell: CELL.FLAME, frames: CELL.FLAME_FRAMES, model: MODEL.HOT,
      flags: FLAG.ADD | FLAG.ANIM | FLAG.FADEIN,
      r: 1.0, g: 0.52, b: 0.19, opacity: 0.55, emissive: 0.55,
      drag: 2.2, gravity: -0.55, turbulence: 2.2,
    });
    g.pushMany(30 * scale, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const z = rand.signed();
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const sp = radius * (1.2 + rand.next() * 2.6);
      d.px = point.x; d.py = point.y; d.pz = point.z;
      d.vx = Math.cos(a) * s * sp;
      d.vy = z * sp * 0.7 + radius * 1.1;
      d.vz = Math.sin(a) * s * sp;
      d.sizeBegin = radius * 0.16;
      d.sizeEnd = radius * (0.5 + rand.next() * 0.5);
      d.lifetime = 0.30 + rand.next() * 0.45;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 3;
    });

    /* --- embers --------------------------------------------------------- */
    g.begin({
      cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
      flags: FLAG.ADD | FLAG.STRETCH | FLAG.COLLIDE | FLAG.HOTRAMP | FLAG.FLICKER | FLAG.NOSOFT,
      r: 1.0, g: 0.78, b: 0.36, opacity: 1, emissive: 1.2,
      drag: 0.5, gravity: 1.0, bounce: 0.35, floorY,
    });
    g.pushMany(48 * scale, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const z = rand.range(-0.35, 1);
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const sp = 5 + rand.next() * 26 * scale;
      d.px = point.x; d.py = point.y; d.pz = point.z;
      d.vx = Math.cos(a) * s * sp;
      d.vy = z * sp + 3;
      d.vz = Math.sin(a) * s * sp;
      d.sizeBegin = 0.022 + rand.next() * 0.030;
      d.sizeEnd = 0.006;
      d.lifetime = 0.9 + rand.next() * 2.2;
    });

    /* --- physically thrown debris --------------------------------------- */
    g.begin({
      cell: CELL.CHIP_A, frames: CELL.CHIP_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: 0.30, g: 0.27, b: 0.24, opacity: 1,
      drag: 0.25, gravity: 1, bounce: 0.2, floorY,
    });
    g.pushMany(26 * scale, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const z = rand.range(-0.2, 1);
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const sp = 4 + rand.next() * 18 * scale;
      d.px = point.x; d.py = point.y; d.pz = point.z;
      d.vx = Math.cos(a) * s * sp;
      d.vy = z * sp + 4;
      d.vz = Math.sin(a) * s * sp;
      const sz = 0.022 + rand.next() * 0.038 * scale;
      d.sizeBegin = sz; d.sizeEnd = sz;
      d.lifetime = 1.6 + rand.next() * 2.2;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 12;
    });

    /* --- ground dust wave ----------------------------------------------- */
    if (overGround < radius * 1.2) {
      g.begin({
        cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
        flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
        r: 0.52, g: 0.49, b: 0.45, opacity: 0.42,
        drag: 1.35, gravity: -0.02, turbulence: 0.75,
      });
      g.pushMany(30 * scale, (d) => {
        const a = rand.range(0, Math.PI * 2);
        const sp = radius * (1.6 + rand.next() * 2.2);
        d.px = point.x + Math.cos(a) * radius * 0.25;
        d.py = floorY + 0.15 + rand.next() * 0.3;
        d.pz = point.z + Math.sin(a) * radius * 0.25;
        d.vx = Math.cos(a) * sp;
        d.vy = 0.5 + rand.next() * 1.4;
        d.vz = Math.sin(a) * sp;
        d.sizeBegin = radius * 0.15;
        d.sizeEnd = radius * (0.7 + rand.next() * 0.7);
        d.lifetime = 1.6 + rand.next() * 2.4;
        d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.5;
      });
    }

    /* --- buoyant smoke column ------------------------------------------- */
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.13, g: 0.122, b: 0.118, opacity: 0.78,
      drag: 1.15, gravity: -0.13, turbulence: 1.5,
    });
    g.pushMany(48 * scale, (d, i) => {
      const a = rand.range(0, Math.PI * 2);
      const rr = rand.next() * radius * 0.5;
      d.px = point.x + Math.cos(a) * rr;
      d.py = point.y + rand.next() * radius * 0.4;
      d.pz = point.z + Math.sin(a) * rr;
      const sp = radius * (0.4 + rand.next() * 0.9);
      d.vx = Math.cos(a) * sp * 0.6;
      d.vy = 1.3 + rand.next() * 2.4 + i * 0.015;
      d.vz = Math.sin(a) * sp * 0.6;
      d.sizeBegin = radius * 0.22;
      d.sizeEnd = radius * (0.9 + rand.next() * 0.9);
      d.lifetime = 4.0 + rand.next() * 4.0;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.35;
      // The head of the column is lit by the fire beneath it for a moment.
      if (i < 6) { d.r = 0.5; d.g = 0.28; d.b = 0.12; }
    });

    /* --- scorch --------------------------------------------------------- */
    if (overGround < radius * 0.6) {
      w.decal({
        x: point.x, y: floorY + 0.004, z: point.z,
        nx: 0, ny: 1, nz: 0,
        size: radius * 1.35,
        group: 'scorch',
        rotation: rand.range(0, Math.PI * 2),
        lifetime: Infinity,
      });
    }

    // Secondary fire licking the crater for a moment after the ball dies.
    w.after(0.22, () => {
      g.begin({
        cell: CELL.FLAME, frames: CELL.FLAME_FRAMES, model: MODEL.HOT,
        flags: FLAG.ADD | FLAG.ANIM | FLAG.FADEIN,
        r: 1.0, g: 0.42, b: 0.12, opacity: 0.55, emissive: 0.7,
        drag: 2.0, gravity: -0.5, turbulence: 1.6,
      });
      g.pushMany(10 * scale, (d) => {
        const a = rand.range(0, Math.PI * 2);
        const rr = rand.next() * radius * 0.4;
        d.px = point.x + Math.cos(a) * rr;
        d.py = floorY + 0.1;
        d.pz = point.z + Math.sin(a) * rr;
        d.vx = Math.cos(a) * 0.6; d.vy = 2.2 + rand.next() * 2; d.vz = Math.sin(a) * 0.6;
        d.sizeBegin = radius * 0.12; d.sizeEnd = radius * 0.32;
        d.lifetime = 0.4 + rand.next() * 0.4;
        d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 2;
      });
      w.light({
        x: point.x, y: floorY + radius * 0.2, z: point.z,
        color: 0xff7a30, intensity: 16 * power, radius: radius * 3,
        lifetime: 0.6, decay: 'flicker',
      });
    });

    void kind;
  }

  dispose(): void {
    this.geometry?.dispose();
    for (const f of this.fireballs) f.material.dispose();
  }
}
