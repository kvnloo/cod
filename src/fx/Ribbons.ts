/**
 * Trail ribbons.
 *
 * A stretched billboard reads as a streak; a ribbon reads as a *path*. Sparks
 * ricocheting off steel arc and curl, and the curl is what sells them — so the
 * hottest handful of sparks in every metal impact, plus grenade and rocket
 * trails, get a real swept ribbon behind them.
 *
 * The whole system is one dynamic BufferGeometry rebuilt on the CPU each frame;
 * with a budget of 96 trails × 10 samples that is a few thousand vertex writes,
 * far cheaper than the equivalent in draw calls.
 */

import * as THREE from 'three';
import { FX_LAYER_TRANSPARENT, fxSkipPatch } from './Common';
import { GBUFFER_PASSTHROUGH_DECL } from './Common';
import { GLSL_COMMON } from '../render/Glsl';

const MAX_POINTS = 10;

const RIBBON_VERT = /* glsl */ `
precision highp float;
in vec4 aColor;
in vec2 aParam;      // u along the trail, v across
out vec4 vColor;
out vec2 vParam;
out float vViewZ;
void main() {
	vColor = aColor;
	vParam = aParam;
	vec4 viewPos = viewMatrix * vec4( position, 1.0 );
	vViewZ = - viewPos.z;
	gl_Position = projectionMatrix * viewPos;
}
`;

const RIBBON_FRAG = /* glsl */ `
precision highp float;
${GLSL_COMMON}
in vec4 vColor;
in vec2 vParam;
in float vViewZ;
layout(location = 0) out vec4 outColor;
${GBUFFER_PASSTHROUGH_DECL}
uniform sampler2D boSceneDepth;
uniform vec4 boCameraParams;
uniform float uSoft;
void main() {
	// Soft round cross-section: the ribbon should look like a glowing filament,
	// not a flat strip of paper.
	float across = 1.0 - abs( vParam.y );
	float core = pow( across, 2.2 );
	float a = vColor.a * ( core * 0.85 + across * 0.3 );
	if ( uSoft > 0.5 ) {
		vec2 suv = gl_FragCoord.xy * boCameraParams.zw;
		float d = texture( boSceneDepth, suv ).r;
		float sceneZ = boLinearDepth( d, boCameraParams.x, boCameraParams.y );
		a *= boSat( ( sceneZ - vViewZ ) / 0.12 );
	}
	if ( a < 0.002 ) discard;
	vec3 c = vColor.rgb * ( 0.65 + 1.6 * core );
	outColor = vec4( c * a, 0.0 );
	fxGNormal = vec4( 0.0 );
	fxGVelocity = vec4( 0.0 );
	fxGMaterial = vec4( 0.0 );
}
`;

interface Trail {
  active: boolean;
  age: number;
  life: number;
  /** Ring buffer of world-space samples, newest last. */
  pts: Float32Array;
  count: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  drag: number;
  gravity: number;
  floorY: number;
  bounce: number;
  width: number;
  r: number; g: number; b: number;
  intensity: number;
  sampleTimer: number;
  sampleInterval: number;
}

export interface TrailDesc {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  life: number; width: number;
  r: number; g: number; b: number; intensity: number;
  drag: number; gravity: number; floorY: number; bounce: number;
  sampleInterval: number;
}

const TRAIL_DEFAULTS: TrailDesc = {
  px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
  life: 0.6, width: 0.02,
  r: 1, g: 0.6, b: 0.2, intensity: 3,
  drag: 0.9, gravity: 1, floorY: -1e6, bounce: 0.35,
  sampleInterval: 1 / 90,
};

export class Ribbons {
  private trails: Trail[] = [];
  private geometry!: THREE.BufferGeometry;
  private material!: THREE.ShaderMaterial;
  mesh!: THREE.Mesh;

  private positions!: Float32Array;
  private colors!: Float32Array;
  private params!: Float32Array;
  private posAttr!: THREE.BufferAttribute;
  private colAttr!: THREE.BufferAttribute;
  private parAttr!: THREE.BufferAttribute;
  private capacity = 0;

  readonly desc: TrailDesc = { ...TRAIL_DEFAULTS };
  live = 0;

  private tmpDir = new THREE.Vector3();
  private tmpSide = new THREE.Vector3();
  private tmpToCam = new THREE.Vector3();

  init(shared: Record<string, THREE.IUniform>, capacity = 96, soft = true): void {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      this.trails.push({
        active: false, age: 0, life: 1,
        pts: new Float32Array(MAX_POINTS * 3), count: 0,
        px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        drag: 0, gravity: 1, floorY: -1e6, bounce: 0,
        width: 0.02, r: 1, g: 1, b: 1, intensity: 1,
        sampleTimer: 0, sampleInterval: 1 / 90,
      });
    }

    // Each trail contributes (MAX_POINTS - 1) quads = 6 vertices each.
    const verts = capacity * (MAX_POINTS - 1) * 6;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    this.params = new Float32Array(verts * 2);

    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.parAttr = new THREE.BufferAttribute(this.params, 2);
    for (const a of [this.posAttr, this.colAttr, this.parAttr]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aColor', this.colAttr);
    g.setAttribute('aParam', this.parAttr);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    const uniforms: Record<string, THREE.IUniform> = { uSoft: { value: soft ? 1 : 0 } };
    for (const k in shared) uniforms[k] = shared[k];
    if (!uniforms.boSceneDepth) uniforms.boSceneDepth = { value: null };
    if (!uniforms.boCameraParams) {
      uniforms.boCameraParams = { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) };
    }

    this.material = fxSkipPatch(new THREE.ShaderMaterial({
      name: 'fx:ribbons',
      glslVersion: THREE.GLSL3,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    }));

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.renderOrder = 3250;
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    this.mesh.name = 'fx:ribbons';
    this.mesh.layers.set(FX_LAYER_TRANSPARENT);
  }

  begin(preset?: Partial<TrailDesc>): TrailDesc {
    Object.assign(this.desc, TRAIL_DEFAULTS);
    if (preset) Object.assign(this.desc, preset);
    return this.desc;
  }

  push(): boolean {
    let slot = -1;
    let worst = Infinity;
    for (let i = 0; i < this.trails.length; i++) {
      const t = this.trails[i];
      if (!t.active) { slot = i; break; }
      const rem = t.life - t.age;
      if (rem < worst) { worst = rem; slot = i; }
    }
    if (slot < 0) return false;
    const t = this.trails[slot];
    const d = this.desc;
    t.active = true; t.age = 0; t.life = d.life;
    t.px = d.px; t.py = d.py; t.pz = d.pz;
    t.vx = d.vx; t.vy = d.vy; t.vz = d.vz;
    t.drag = d.drag; t.gravity = d.gravity; t.floorY = d.floorY; t.bounce = d.bounce;
    t.width = d.width; t.r = d.r; t.g = d.g; t.b = d.b; t.intensity = d.intensity;
    t.sampleInterval = d.sampleInterval; t.sampleTimer = 0;
    t.count = 1;
    t.pts[0] = d.px; t.pts[1] = d.py; t.pts[2] = d.pz;
    return true;
  }

  clear(): void {
    for (const t of this.trails) t.active = false;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.live = 0;
  }

  setSoft(on: boolean): void { this.material.uniforms.uSoft.value = on ? 1 : 0; }

  update(dt: number, camera: THREE.Camera): void {
    const cam = camera.position;
    let vertex = 0;
    let live = 0;

    for (const t of this.trails) {
      if (!t.active) continue;
      t.age += dt;
      if (t.age >= t.life) { t.active = false; continue; }
      live++;

      // --- integrate the head
      const k = Math.exp(-t.drag * dt);
      t.vy -= 9.81 * t.gravity * dt;
      t.vx *= k; t.vy *= k; t.vz *= k;
      t.px += t.vx * dt; t.py += t.vy * dt; t.pz += t.vz * dt;
      if (t.py < t.floorY && t.vy < 0) {
        t.py = t.floorY;
        t.vy = -t.vy * t.bounce;
        t.vx *= 0.6; t.vz *= 0.6;
      }

      // --- sample the path
      t.sampleTimer += dt;
      if (t.sampleTimer >= t.sampleInterval) {
        t.sampleTimer = 0;
        if (t.count < MAX_POINTS) {
          t.pts[t.count * 3] = t.px;
          t.pts[t.count * 3 + 1] = t.py;
          t.pts[t.count * 3 + 2] = t.pz;
          t.count++;
        } else {
          t.pts.copyWithin(0, 3);
          t.pts[(MAX_POINTS - 1) * 3] = t.px;
          t.pts[(MAX_POINTS - 1) * 3 + 1] = t.py;
          t.pts[(MAX_POINTS - 1) * 3 + 2] = t.pz;
        }
      } else if (t.count > 0) {
        // Always keep the newest sample glued to the head so the ribbon does
        // not visibly lag behind the spark.
        const i = (t.count - 1) * 3;
        t.pts[i] = t.px; t.pts[i + 1] = t.py; t.pts[i + 2] = t.pz;
      }

      if (t.count < 2) continue;

      const fade = 1 - t.age / t.life;
      for (let i = 0; i < t.count - 1; i++) {
        const ax = t.pts[i * 3], ay = t.pts[i * 3 + 1], az = t.pts[i * 3 + 2];
        const bx = t.pts[(i + 1) * 3], by = t.pts[(i + 1) * 3 + 1], bz = t.pts[(i + 1) * 3 + 2];
        this.tmpDir.set(bx - ax, by - ay, bz - az);
        if (this.tmpDir.lengthSq() < 1e-10) continue;
        this.tmpToCam.set(cam.x - ax, cam.y - ay, cam.z - az);
        this.tmpSide.crossVectors(this.tmpDir, this.tmpToCam);
        if (this.tmpSide.lengthSq() < 1e-12) continue;
        this.tmpSide.normalize();

        // Taper: the tail is thinner and dimmer than the head.
        const u0 = i / (t.count - 1);
        const u1 = (i + 1) / (t.count - 1);
        const w0 = t.width * (0.2 + 0.8 * u0);
        const w1 = t.width * (0.2 + 0.8 * u1);
        const a0 = fade * (0.10 + 0.90 * u0 * u0);
        const a1 = fade * (0.10 + 0.90 * u1 * u1);

        const sx = this.tmpSide.x, sy = this.tmpSide.y, sz = this.tmpSide.z;
        const p = this.positions;
        const c = this.colors;
        const q = this.params;

        const put = (
          x: number, y: number, z: number, side: number, w: number, a: number, u: number,
        ): void => {
          const vi = vertex++;
          p[vi * 3] = x + sx * side * w;
          p[vi * 3 + 1] = y + sy * side * w;
          p[vi * 3 + 2] = z + sz * side * w;
          c[vi * 4] = t.r * t.intensity;
          c[vi * 4 + 1] = t.g * t.intensity;
          c[vi * 4 + 2] = t.b * t.intensity;
          c[vi * 4 + 3] = a;
          q[vi * 2] = u;
          q[vi * 2 + 1] = side;
        };

        if ((vertex + 6) * 3 > p.length) break;
        put(ax, ay, az, -1, w0, a0, u0);
        put(bx, by, bz, -1, w1, a1, u1);
        put(bx, by, bz, 1, w1, a1, u1);
        put(ax, ay, az, -1, w0, a0, u0);
        put(bx, by, bz, 1, w1, a1, u1);
        put(ax, ay, az, 1, w0, a0, u0);
      }
    }

    this.live = live;
    this.geometry.setDrawRange(0, vertex);
    this.mesh.visible = vertex > 0;
    if (vertex > 0) {
      for (const [a, items] of [
        [this.posAttr, 3], [this.colAttr, 4], [this.parAttr, 2],
      ] as [THREE.BufferAttribute, number][]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, vertex * items);
        a.needsUpdate = true;
      }
    }
    void this.capacity;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
