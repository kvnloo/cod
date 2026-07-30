/**
 * Post-processing test bed.
 *
 * A self-contained scene + G-buffer + frame graph that exercises every pass in
 * this directory. It exists so the effect library can be developed and
 * screenshotted on a real GPU without waiting on the renderer's own frame graph,
 * and it doubles as executable documentation of how `PassContext` is meant to be
 * filled in.
 *
 * Usage:
 *   node tools/capture.mjs --debug post --shots post-overview,post-bloom,...
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import { bus } from '../../core/EventBus';
import { registerDebugScene, registerShots } from '../../core/Shots';
import { ORDER, type EngineContext, type System } from '../../core/Engine';
import { settings } from '../../core/Settings';
import type { AtmosphereState, GBuffer, PassContext, RenderPass } from '../Pass';
import { haltonJitter } from './BlueNoise';
import { FULLSCREEN_VERT } from './Shaders';
import {
  LAB_MAX_LIGHTS, createLabEnvironment, createLabMaterial, createLabSkyMaterial,
  type LabEnvironment,
} from './LabMaterial';
import { createPasses, postResources, postScreenEffect, postSetWeather } from './index';

interface LabLight {
  light: THREE.PointLight;
  colour: THREE.Vector3;
  radius: number;
  base: number;
  flicker: number;
}

/* ------------------------------------------------------------------ scene -- */

export class PostLab {
  readonly root = new THREE.Group();
  readonly env: LabEnvironment = createLabEnvironment();
  readonly sun = new THREE.DirectionalLight(0xffe8cc, 3.2);
  readonly materials: THREE.ShaderMaterial[] = [];
  readonly lights: LabLight[] = [];

  private movers: Array<{ mesh: THREE.Mesh; kind: 'slide' | 'spin' | 'orbit'; phase: number; speed: number }> = [];
  private meshes: THREE.Mesh[] = [];
  private elapsed = 0;

  build(scene: THREE.Scene): void {
    const rand = new Rand('postlab');
    const env = this.env;
    this.root.name = 'postlab';

    const mat = (o: Parameters<typeof createLabMaterial>[1]) => {
      const m = createLabMaterial(env, o);
      this.materials.push(m);
      return m;
    };
    const add = (geo: THREE.BufferGeometry, m: THREE.ShaderMaterial, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };

    /* --- ground: a polished lane flanked by matte asphalt ------------------ */
    const asphalt = mat({ albedo: 0x24262a, roughness: 0.72, detailScale: 2.6, detailAmount: 1, roughVariation: 0.9 });
    const ground = add(new THREE.PlaneGeometry(120, 120, 1, 1), asphalt, 0, 0, -10);
    ground.rotation.x = -Math.PI / 2;
    ground.castShadow = false;

    // The wet lane is the SSR subject: low roughness, slight tint.
    const wet = mat({ albedo: 0x14161a, roughness: 0.09, metalness: 0.04, detailScale: 1.3, detailAmount: 0.45, roughVariation: 0.5 });
    const lane = add(new THREE.PlaneGeometry(9, 62, 1, 1), wet, 0, 0.004, -12);
    lane.rotation.x = -Math.PI / 2;
    lane.castShadow = false;

    /* --- walls -------------------------------------------------------------*/
    const concrete = mat({ albedo: 0x6d6a63, roughness: 0.78, detailScale: 3.0, detailAmount: 1, roughVariation: 0.85 });
    const wallGeo = new THREE.BoxGeometry(0.8, 7.2, 62);
    const wl = add(wallGeo, concrete, -7.5, 3.6, -12);
    const wr = add(wallGeo, concrete, 7.5, 3.6, -12);
    wl.name = 'wall-left';
    wr.name = 'wall-right';

    // Distant backdrop so the sightline has a third depth layer.
    const backdrop = mat({ albedo: 0x4a4d54, roughness: 0.85, detailScale: 1.6, detailAmount: 0.8 });
    add(new THREE.BoxGeometry(60, 22, 1.2), backdrop, 0, 11, -46);
    for (let i = 0; i < 7; i++) {
      const w = rand.range(3, 9);
      const h = rand.range(8, 26);
      add(new THREE.BoxGeometry(w, h, rand.range(3, 8)), backdrop,
        rand.range(-34, 34), h * 0.5, rand.range(-72, -52));
    }

    /* --- pillars ---------------------------------------------------------- */
    const pillarMat = mat({ albedo: 0x7b7770, roughness: 0.68, detailScale: 3.6, detailAmount: 1 });
    for (let i = 0; i < 8; i++) {
      const z = -34 + i * 6.2;
      const side = i % 2 === 0 ? -1 : 1;
      const p = add(new THREE.BoxGeometry(0.85, 6.6, 0.85), pillarMat, side * 5.6, 3.3, z);
      p.rotation.y = rand.range(-0.05, 0.05);
    }

    /* --- crates and barrels ------------------------------------------------ */
    const crateMats = [
      mat({ albedo: 0x6b4a2c, roughness: 0.62, detailScale: 3.4, detailAmount: 1 }),
      mat({ albedo: 0x3f5560, roughness: 0.48, detailScale: 2.8, detailAmount: 1 }),
      mat({ albedo: 0x5a5a52, roughness: 0.55, detailScale: 3.0, detailAmount: 1 }),
      mat({ albedo: 0x77302a, roughness: 0.66, detailScale: 3.6, detailAmount: 1 }),
    ];
    for (let i = 0; i < 18; i++) {
      const s = rand.range(0.55, 1.35);
      const g = new THREE.BoxGeometry(s, s * rand.range(0.8, 1.2), s * rand.range(0.85, 1.15));
      const m = crateMats[rand.int(0, crateMats.length - 1)];
      const x = rand.range(-6.4, 6.4);
      const z = rand.range(-36, 6);
      if (Math.abs(x) < 2.2 && z > -6) continue;   // keep the hero lane clear
      const c = add(g, m, x, s * 0.5, z);
      c.rotation.y = rand.next() * Math.PI;
    }

    const steel = mat({ albedo: 0x9aa0a6, roughness: 0.24, metalness: 1, detailScale: 4.5, detailAmount: 0.6, roughVariation: 0.9 });
    for (let i = 0; i < 6; i++) {
      const b = add(new THREE.CylinderGeometry(0.34, 0.34, 0.94, 20, 1), steel,
        rand.range(-6, 6), 0.47, rand.range(-32, 2));
      b.rotation.y = rand.next() * Math.PI;
    }

    /* --- contact cluster: the GTAO subject --------------------------------- */
    // Boxes that actually touch each other and the matte floor, so the AO shot
    // has real corners, lips and crevices to darken.
    const contactA = mat({ albedo: 0x5c5f63, roughness: 0.7, detailScale: 4.2, detailAmount: 1 });
    const contactB = mat({ albedo: 0x6e5237, roughness: 0.66, detailScale: 4.6, detailAmount: 1 });
    const stack = [
      { g: new THREE.BoxGeometry(1.2, 0.9, 1.0), m: contactA, x: -4.3, y: 0.45, z: -2.4, r: 0.12 },
      { g: new THREE.BoxGeometry(0.85, 0.7, 0.8), m: contactB, x: -4.05, y: 1.25, z: -2.55, r: -0.35 },
      { g: new THREE.BoxGeometry(1.1, 0.55, 0.9), m: contactB, x: -5.35, y: 0.28, z: -1.7, r: 0.62 },
      { g: new THREE.BoxGeometry(0.6, 1.6, 0.6), m: contactA, x: -3.1, y: 0.8, z: -1.5, r: -0.18 },
    ];
    for (const b of stack) {
      const mesh = add(b.g, b.m, b.x, b.y, b.z);
      mesh.rotation.y = b.r;
    }
    const drum = add(new THREE.CylinderGeometry(0.36, 0.36, 1.0, 24, 1), steel, -5.0, 0.5, -3.3);
    drum.rotation.y = 0.4;

    /* --- thin geometry: the TAA torture test ------------------------------ */
    const railMat = mat({ albedo: 0x8d8f92, roughness: 0.35, metalness: 0.9, detailScale: 6, detailAmount: 0.4 });
    const railGeo = new THREE.CylinderGeometry(0.022, 0.022, 1.15, 6, 1);
    for (let i = 0; i < 34; i++) {
      add(railGeo, railMat, -4.2 + (i % 17) * 0.52, 0.58, i < 17 ? -3.2 : -3.9);
    }
    const railTop = new THREE.BoxGeometry(9.0, 0.05, 0.05);
    add(railTop, railMat, 0.0, 1.14, -3.2);
    add(railTop, railMat, 0.0, 1.14, -3.9);

    // Cables strung overhead break up the sky and catch the sun.
    const cableMat = mat({ albedo: 0x1c1c1e, roughness: 0.55, detailScale: 5, detailAmount: 0.3 });
    for (let i = 0; i < 5; i++) {
      const c = add(new THREE.CylinderGeometry(0.028, 0.028, 15.4, 6, 1), cableMat, 0, 5.4 + i * 0.18, -6 - i * 7);
      c.rotation.z = Math.PI / 2;
      c.rotation.y = rand.range(-0.03, 0.03);
    }

    /* --- emissives + local lights ----------------------------------------- */
    const stripCyan = mat({ albedo: 0x0a0d10, roughness: 0.35, emissive: 0x38c8ff, emissiveStrength: 26, matId: 200 });
    const stripWarm = mat({ albedo: 0x120e08, roughness: 0.35, emissive: 0xffb367, emissiveStrength: 34, matId: 201 });
    const lampGeo = new THREE.BoxGeometry(0.16, 0.16, 2.6);
    const bulbGeo = new THREE.SphereGeometry(0.13, 16, 12);

    const lampSpecs: Array<[number, number, number, boolean]> = [
      [-6.9, 4.3, -8, true], [6.9, 4.3, -14, false],
      [-6.9, 4.3, -20, false], [6.9, 4.3, -26, true],
      [-6.9, 4.3, -32, true],
    ];
    for (const [x, y, z, cyan] of lampSpecs) {
      const l = add(lampGeo, cyan ? stripCyan : stripWarm, x, y, z);
      l.castShadow = false;
      const light = new THREE.PointLight(cyan ? 0x59d0ff : 0xffb367, 26, 16, 2);
      light.position.set(x + (x < 0 ? 0.5 : -0.5), y - 0.2, z);
      this.root.add(light);
      this.lights.push({
        light,
        colour: new THREE.Vector3().setFromColor(light.color),
        radius: 16,
        base: 26,
        flicker: cyan ? 0.06 : 0.22,
      });
    }

    const bulb = add(bulbGeo, stripWarm, 1.6, 2.05, -1.2);
    bulb.castShadow = false;
    const bulbLight = new THREE.PointLight(0xffcf9a, 30, 14, 2);
    bulbLight.position.copy(bulb.position);
    this.root.add(bulbLight);
    this.lights.push({
      light: bulbLight, colour: new THREE.Vector3().setFromColor(bulbLight.color),
      radius: 14, base: 30, flicker: 0.35,
    });

    /* --- foreground: DoF near-field subject -------------------------------- */
    const pipeMat = mat({ albedo: 0x3e4348, roughness: 0.42, metalness: 0.85, detailScale: 5.5, detailAmount: 0.7 });
    const pipe = add(new THREE.CylinderGeometry(0.11, 0.11, 8.4, 14, 1), pipeMat, -1.35, 1.05, 7.1);
    pipe.rotation.x = Math.PI / 2;
    pipe.rotation.z = 0.09;
    const clampMat = mat({ albedo: 0x2a2d31, roughness: 0.5, metalness: 0.7, detailScale: 6, detailAmount: 0.6 });
    for (let i = 0; i < 3; i++) {
      const c = add(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 14, 1), clampMat, -1.35, 1.05, 9.4 - i * 2.6);
      c.rotation.x = Math.PI / 2;
    }

    /* --- movers: motion blur subjects ------------------------------------- */
    const moverMat = mat({ albedo: 0xc9542e, roughness: 0.28, metalness: 0.35, detailScale: 4, detailAmount: 0.7, matId: 90 });
    const slider = add(new THREE.SphereGeometry(0.55, 32, 24), moverMat, 0, 1.15, -8);
    this.movers.push({ mesh: slider, kind: 'slide', phase: 0, speed: 1 });

    const spinnerMat = mat({ albedo: 0xd9d2c4, roughness: 0.36, metalness: 0.15, detailScale: 3.2, detailAmount: 0.8 });
    const spinner = add(new THREE.BoxGeometry(1.1, 1.1, 1.1), spinnerMat, 3.1, 1.5, -13);
    this.movers.push({ mesh: spinner, kind: 'spin', phase: 0.4, speed: 1 });

    const orbitMat = mat({ albedo: 0x2f6f4f, roughness: 0.45, metalness: 0.2, detailScale: 3.6, detailAmount: 0.8 });
    const orbit = add(new THREE.TorusKnotGeometry(0.42, 0.14, 96, 16), orbitMat, -3.4, 1.7, -18);
    this.movers.push({ mesh: orbit, kind: 'orbit', phase: 1.7, speed: 1 });

    /* --- sky dome ---------------------------------------------------------- */
    const skyMat = createLabSkyMaterial(env);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 20), skyMat);
    sky.renderOrder = 1000;
    sky.frustumCulled = false;
    this.root.add(sky);

    /* --- sun --------------------------------------------------------------- */
    const sun = this.sun;
    sun.color.setRGB(1, 0.9, 0.76);
    sun.intensity = 3.2;
    sun.position.set(26, 30, 44);
    sun.target.position.set(0, 0, -14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 160;
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.root.add(sun);
    this.root.add(sun.target);

    env.sunDirection.copy(sun.target.position).sub(sun.position).normalize();
    env.sunColor.set(
      sun.color.r * sun.intensity * 1.35,
      sun.color.g * sun.intensity * 1.35,
      sun.color.b * sun.intensity * 1.35,
    );

    scene.add(this.root);
    scene.background = new THREE.Color(0x5d738f);
    scene.fog = new THREE.FogExp2(0x6a7f97, 0.0055);
  }

  /** Advances the animated content. Deterministic in `time`, not in `dt`. */
  animate(time: number, dt: number): void {
    this.elapsed = time;
    for (const m of this.movers) {
      const t = time * m.speed + m.phase;
      if (m.kind === 'slide') {
        // Triangle wave: constant speed, so a screenshot at any settle time
        // catches the mover mid-travel with a real velocity vector.
        const u = (t * 0.42) % 1;
        m.mesh.position.x = 4.6 * (2 * Math.abs(2 * u - 1) - 1);
        m.mesh.position.y = 1.15 + Math.abs(Math.sin(t * 3.1)) * 0.25;
      } else if (m.kind === 'spin') {
        m.mesh.rotation.y = t * 6.5;
        m.mesh.rotation.x = t * 3.2;
      } else {
        m.mesh.position.x = -3.4 + Math.cos(t * 1.35) * 1.8;
        m.mesh.position.z = -18 + Math.sin(t * 1.35) * 1.8;
        m.mesh.rotation.y = t * 1.6;
      }
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const n = 0.5 + 0.5 * Math.sin(time * (7 + i * 3.1) + i * 2.3) * Math.sin(time * (13 + i));
      l.light.intensity = l.base * (1 - l.flicker + l.flicker * n);
    }
    void dt;
  }

  /** Pushes per-frame environment state into every lab material. */
  syncMaterials(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const env = this.env;
    camera.getWorldPosition(env.cameraPos);
    env.resolution.set(width, height);

    const map = this.sun.shadow.map;
    const depth = map ? map.depthTexture : null;
    const hasShadow = !!(map && depth);
    const compare = !!(depth && depth.compareFunction != null);
    if (hasShadow && map) {
      env.shadowMatrix.copy(this.sun.shadow.matrix);
      env.shadowTexel.set(1 / map.width, 1 / map.height);
      env.shadowMap = depth;
    } else {
      env.shadowMap = null;
    }

    const n = Math.min(LAB_MAX_LIGHTS, this.lights.length);
    for (let i = 0; i < n; i++) {
      const l = this.lights[i];
      env.lightPos[i].copy(l.light.position);
      const k = l.light.intensity / (4 * Math.PI);
      env.lightColor[i].set(l.colour.x * k, l.colour.y * k, l.colour.z * k);
      env.lightRadius[i] = l.radius;
    }
    env.lightCount = n;

    for (const m of this.materials) {
      m.uniforms.uShadowMap.value = env.shadowMap;
      m.uniforms.uHasShadow.value = hasShadow ? 1 : 0;
      m.uniforms.uLightCount.value = n;
      const defines = m.defines as Record<string, number>;
      const want = compare ? 1 : 0;
      if (defines.SHADOW_COMPARE !== want) { defines.SHADOW_COMPARE = want; m.needsUpdate = true; }
    }
  }

  get meshList(): THREE.Mesh[] { return this.meshes; }
  get time(): number { return this.elapsed; }
}

/* ------------------------------------------------------------ frame graph -- */

/**
 * Minimal reference frame graph: MRT G-buffer → ping-pong post chain → screen.
 * `RenderSystem` will have its own, richer version; this one exists so the pass
 * library is independently runnable and verifiable.
 */
export class LabFrameGraph {
  private renderer: THREE.WebGLRenderer;
  private passes: RenderPass[] = [];
  private gbufferTarget: THREE.WebGLRenderTarget | null = null;
  private gbufferDepth: THREE.DepthTexture | null = null;
  private ping: THREE.WebGLRenderTarget[] = [];
  private scratch = new Map<string, THREE.WebGLRenderTarget>();
  private scratchUse = new Map<string, number>();
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private copyMaterial: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;
  private frame = 0;
  private time = 0;

  private readonly jitter = new THREE.Vector2();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly prevViewProjection = new THREE.Matrix4();
  private readonly inverseProjection = new THREE.Matrix4();
  private readonly inverseView = new THREE.Matrix4();
  private readonly prevWorld = new WeakMap<THREE.Object3D, THREE.Matrix4>();
  private readonly tmpMatrix = new THREE.Matrix4();

  /** Metres the DoF focuses on; the lab drives this from the shots. */
  focusDistance = 8;
  exposure = 1;

  /** Stand-in sky state; the lab has no `SkySystem`. */
  readonly atmosphere: AtmosphereState = {
    sunDirection: new THREE.Vector3(0.42, 0.72, 0.55).normalize(),
    sunColor: new THREE.Color(1.0, 0.94, 0.84).multiplyScalar(6),
    skyColor: new THREE.Color(0.34, 0.45, 0.62),
    skyCube: null,
    nightFactor: 0,
    weather: 0,
    shadow: {
      atlas: null,
      matrices: Array.from({ length: 4 }, () => new THREE.Matrix4()),
      tiles: Array.from({ length: 4 }, () => new THREE.Vector4()),
      params: Array.from({ length: 4 }, () => new THREE.Vector4()),
      count: 0,
      distance: 0,
      strength: 0,
    },
  };

  constructor(renderer: THREE.WebGLRenderer, passes?: RenderPass[]) {
    this.renderer = renderer;
    this.passes = (passes ?? createPasses()).slice().sort((a, b) => a.order - b.order);
    for (const p of this.passes) p.setup(renderer);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.copyMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tInput: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `in vec2 vUv; uniform sampler2D tInput;
        layout(location = 0) out vec4 fragColor;
        void main() { fragColor = texture(tInput, vUv); }`,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new THREE.Mesh(geo, this.copyMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get passList(): RenderPass[] { return this.passes; }

  private ensureTargets(width: number, height: number): void {
    if (this.gbufferTarget && this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.gbufferTarget?.dispose();
    for (const p of this.ping) p.dispose();
    for (const s of this.scratch.values()) s.dispose();
    this.scratch.clear();
    this.ping = [];

    const depth = new THREE.DepthTexture(width, height);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.gbufferTarget = new THREE.WebGLRenderTarget(width, height, {
      count: 4,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: depth,
    });
    this.gbufferDepth = depth;
    for (const t of this.gbufferTarget.textures) {
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
    }

    for (let i = 0; i < 2; i++) {
      const rt = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      this.ping.push(rt);
    }

    for (const p of this.passes) p.resize(width, height);
  }

  private blit = (material: THREE.Material, target: THREE.WebGLRenderTarget | null): void => {
    this.quad.material = material;
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.autoClear = prevAuto;
  };

  private borrow = (scale = 1, half = true): THREE.WebGLRenderTarget => {
    const w = Math.max(1, Math.round(this.width * scale));
    const h = Math.max(1, Math.round(this.height * scale));
    const base = `${w}x${h}:${half ? 'h' : 'f'}`;
    const index = this.scratchUse.get(base) ?? 0;
    this.scratchUse.set(base, index + 1);
    const key = `${base}#${index}`;
    let rt = this.scratch.get(key);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: half ? THREE.HalfFloatType : THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      this.scratch.set(key, rt);
    }
    return rt;
  };

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, lab: PostLab, dt: number): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.ensureTargets(Math.max(1, size.x), Math.max(1, size.y));
    this.scratchUse.clear();

    const gbufferTarget = this.gbufferTarget;
    if (!gbufferTarget) return;

    this.time += dt;
    const g = settings.gfx;

    /* 1 — previous-frame model matrices (before this frame's animation) ---- */
    scene.updateMatrixWorld(true);
    for (const mesh of lab.meshList) {
      let prev = this.prevWorld.get(mesh);
      if (!prev) { prev = new THREE.Matrix4().copy(mesh.matrixWorld); this.prevWorld.set(mesh, prev); }
      const material = mesh.material as THREE.ShaderMaterial;
      const uPrev = material.uniforms?.uPrevModelViewProjection?.value as THREE.Matrix4 | undefined;
      if (uPrev) uPrev.multiplyMatrices(this.prevViewProjection, prev);
    }

    /* 2 — animate + refresh matrices --------------------------------------- */
    lab.animate(this.time, dt);
    scene.updateMatrixWorld(true);

    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    lab.env.unjitteredViewProjection.copy(this.viewProjection);
    lab.syncMaterials(camera, this.width, this.height);

    /* 3 — jittered G-buffer pass -------------------------------------------- */
    if (g.taa) {
      haltonJitter(this.frame, g.taaSamples, this.width, this.height, this.jitter);
      camera.projectionMatrix.elements[8] += this.jitter.x;
      camera.projectionMatrix.elements[9] += this.jitter.y;
    } else {
      this.jitter.set(0, 0);
    }

    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(gbufferTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);
    this.renderer.autoClear = prevAuto;

    if (g.taa) {
      camera.projectionMatrix.elements[8] -= this.jitter.x;
      camera.projectionMatrix.elements[9] -= this.jitter.y;
    }

    this.inverseProjection.copy(camera.projectionMatrix).invert();
    this.inverseView.copy(camera.matrixWorld);

    /* 4 — post chain --------------------------------------------------------*/
    const gbuffer: GBuffer = {
      target: gbufferTarget,
      color: gbufferTarget.textures[0],
      normalRoughness: gbufferTarget.textures[1],
      velocity: gbufferTarget.textures[2],
      material: gbufferTarget.textures[3],
      depth: this.gbufferDepth ?? new THREE.DepthTexture(this.width, this.height),
      width: this.width,
      height: this.height,
    };

    const ctx: PassContext = {
      renderer: this.renderer,
      scene,
      camera,
      gbuffer,
      atmosphere: this.atmosphere,
      dt,
      frame: this.frame,
      time: this.time,
      width: this.width,
      height: this.height,
      settings: g,
      jitter: this.jitter,
      prevViewProjection: this.prevViewProjection,
      viewProjection: this.viewProjection,
      inverseProjection: this.inverseProjection,
      inverseView: this.inverseView,
      cameraNear: camera.near,
      cameraFar: camera.far,
      exposure: this.exposure,
      focusDistance: this.focusDistance,
      borrow: this.borrow,
      blit: this.blit,
    };

    let read: THREE.Texture = gbuffer.color;
    let write = 0;
    for (const pass of this.passes) {
      if (pass.enabled === false) continue;
      const target = this.ping[write];
      if (pass.render(ctx, read, target)) {
        read = target.texture;
        write ^= 1;
      }
    }

    this.copyMaterial.uniforms.tInput.value = read;
    this.blit(this.copyMaterial, null);

    /* 5 — bookkeeping -------------------------------------------------------*/
    this.prevViewProjection.copy(this.viewProjection);
    for (const mesh of lab.meshList) {
      const prev = this.prevWorld.get(mesh);
      if (prev) prev.copy(mesh.matrixWorld);
    }
    this.frame++;
  }

  dispose(): void {
    for (const p of this.passes) p.dispose();
    this.gbufferTarget?.dispose();
    for (const p of this.ping) p.dispose();
    for (const s of this.scratch.values()) s.dispose();
    this.copyMaterial.dispose();
    postResources.dispose();
  }
}

/* -------------------------------------------------------- debug scene ------ */

class PostLabSystem implements System {
  readonly name = 'postlab';
  /** After the renderer, so this composite is what ends up on screen. */
  readonly order = ORDER.RENDER + 100;
  graph: LabFrameGraph | null = null;
  focus = 8;

  constructor(private lab: PostLab, private renderer: THREE.WebGLRenderer) { }

  render(ctx: EngineContext): void {
    if (!this.graph) this.graph = new LabFrameGraph(this.renderer);
    this.graph.focusDistance = this.focus;
    const dt = Math.min(1 / 20, Math.max(1 / 240, ctx.time.delta || 1 / 60));
    this.graph.render(ctx.scene, ctx.camera, this.lab, dt);
  }

  dispose(): void { this.graph?.dispose(); }
}

let labInstance: PostLab | null = null;
let activeSystem: PostLabSystem | null = null;

/** The lab's DoF focus distance, driven per shot. */
function setFocus(metres: number): void {
  if (activeSystem) activeSystem.focus = metres;
}

registerDebugScene('post', (ctx: EngineContext) => {
  const render = ctx.engine.tryGet('render') as unknown as { renderer?: THREE.WebGLRenderer } | undefined;
  const renderer = render?.renderer;
  if (!renderer) {
    console.warn('[postlab] no renderer system; debug scene unavailable');
    return;
  }

  // The lab owns the whole world for this run.
  for (let i = ctx.scene.children.length - 1; i >= 0; i--) ctx.scene.remove(ctx.scene.children[i]);

  const lab = new PostLab();
  lab.build(ctx.scene);
  labInstance = lab;

  activeSystem = new PostLabSystem(lab, renderer);
  ctx.engine.add(activeSystem);
});

// The lane runs toward -Z, so a yaw near 0 looks down it; the sun sits behind
// and above +X/+Z, which is why the volumetric shot faces back up the lane.
registerShots([
  {
    name: 'post-overview',
    description: 'Wide establishing shot of the post-processing lab: three depth layers, emissive strips, wet reflective lane',
    position: [2.9, 2.45, 12.0], yaw: 9, pitch: -6, fov: 72, viewModel: false,
    setup: () => { setFocus(14); bus.emit('weapon:ads', { active: false }); postSetWeather(0, 0.2, 0.35); },
  },
  {
    name: 'post-bloom',
    description: 'Emissive strip lights and bulbs — bloom threshold, Karis average, lens dirt and anamorphic streaks',
    position: [0.4, 2.7, 1.5], yaw: 16, pitch: 4, fov: 70, viewModel: false,
    setup: () => { setFocus(20); bus.emit('weapon:ads', { active: false }); postSetWeather(0, 0.2, 0.35); },
  },
  {
    name: 'post-ssr',
    description: 'Low grazing angle across the wet lane — screen-space reflections of pillars, crates and emissives',
    position: [0.3, 0.42, 5.0], yaw: 3, pitch: -2.5, fov: 66, viewModel: false,
    setup: () => { setFocus(18); bus.emit('weapon:ads', { active: false }); postSetWeather(0, 0.2, 0.35); },
  },
  {
    name: 'post-gtao',
    description: 'Close contact between crates, barrels, railings and the floor — GTAO contact darkening and bent-normal specular occlusion',
    position: [-2.0, 1.55, 0.9], yaw: 26, pitch: -17, fov: 58, viewModel: false,
    setup: () => { setFocus(60); bus.emit('weapon:ads', { active: false }); postSetWeather(0, 0.2, 0.35); },
  },
  {
    name: 'post-volumetric',
    description: 'Looking back up the lane into the sun — froxel volumetrics, god rays through pillars and cables, height fog',
    position: [0.0, 1.7, -28.0], yaw: 204, pitch: 11, fov: 76, viewModel: false,
    setup: () => {
      setFocus(30);
      bus.emit('weapon:ads', { active: false });
      // Thicker medium for this shot so the shafts are unmistakable.
      postSetWeather(0, 0.75, 0.5);
    },
  },
  {
    name: 'post-dof',
    description: 'Foreground pipe against a deep background with ADS engaged — near and far bokeh, polygonal aperture',
    position: [-0.7, 1.25, 10.4], yaw: 2, pitch: -2, fov: 55, viewModel: false,
    setup: () => {
      setFocus(2.2);
      bus.emit('weapon:ads', { active: true });
    },
  },
  {
    name: 'post-motion',
    description: 'The fast slider and spinning box mid-travel — tile-max motion blur reconstruction',
    position: [0.0, 1.75, -3.4], yaw: 0, pitch: -2, fov: 74, viewModel: false,
    setup: () => {
      setFocus(9);
      bus.emit('weapon:ads', { active: false });
    },
  },
  {
    name: 'post-screenfx',
    description: 'Damage vignette, concussion ringing and lens spatter active over the lab',
    position: [1.2, 1.75, 4.0], yaw: 7, pitch: -4, fov: 74, viewModel: false,
    setup: () => {
      setFocus(10);
      bus.emit('weapon:ads', { active: false });
      postScreenEffect({
        damage: { intensity: 1.35, direction: new THREE.Vector3(-0.8, 0, -0.6) },
        concussion: { intensity: 1.1, duration: 1.4 },
        spatter: { intensity: 0.7, kind: 'blood' },
      });
    },
  },
  {
    name: 'post-flashbang',
    description: 'Flashbang recovery curve mid-bleach',
    position: [1.2, 1.75, 4.0], yaw: 7, pitch: -4, fov: 74, viewModel: false,
    setup: () => {
      setFocus(10);
      bus.emit('weapon:ads', { active: false });
      postScreenEffect({ flash: { intensity: 6, color: 0xffffff } });
    },
  },
]);

export function labScene(): PostLab | null { return labInstance; }
