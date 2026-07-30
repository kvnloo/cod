/**
 * GPU particle engine.
 *
 * Particle state lives entirely in floating-point render targets. Each frame:
 *
 *   1. a fragment shader integrates every slot (forces, drag, turbulence,
 *      ground collision) from the read pair into the write pair,
 *   2. newly requested particles are rasterised as single-pixel POINTS straight
 *      into the write pair and into the static attribute atlas,
 *   3. two instanced draws render the whole buffer — one premultiplied-alpha
 *      pass for lit media, one additive pass for hot emissive sprites.
 *
 * Nothing is read back, nothing is allocated per frame, and the entire buffer
 * costs two draw calls regardless of how many particles are alive.
 *
 * Slots are handed out from a ring cursor: when the budget is exhausted the
 * oldest particles are recycled, which is exactly the behaviour you want when
 * a grenade goes off next to a firefight.
 */

import * as THREE from 'three';
import {
  FS_VERTEX, FX_LAYER_TRANSPARENT, FxBlitter, fxSkipPatch, makeQuadGeometry,
} from './Common';
import { ATLAS_COLS, type SpriteAtlas } from './SpriteAtlas';
import {
  RENDER_FRAG, RENDER_VERT, SIM_FRAG, SPAWN_DYNAMIC_FRAG, SPAWN_STATIC_FRAG, SPAWN_VERT,
} from './ParticleShaders';

/* ------------------------------------------------------------------ flags -- */

/** Shading models — the low two bits of `flags`. */
export const MODEL = {
  /** Lit participating media: smoke, dust, steam. */
  MEDIA: 0,
  /** Emissive, rendered additively: sparks, flame, glow. */
  HOT: 1,
  /** Lit solid chunk: chips, splinters, shards, casings' debris. */
  SOLID: 2,
  /** Thin translucent film: blood mist, water spray. */
  THIN: 3,
} as const;

export const FLAG = {
  ADD: 4,
  STRETCH: 8,
  ANIM: 16,
  COLLIDE: 32,
  FADEIN: 64,
  SHADOW: 128,
  FLICKER: 256,
  NOSOFT: 512,
  HOTRAMP: 1024,
} as const;

/* ------------------------------------------------------------ descriptor -- */

export interface SpawnDesc {
  /* transform */
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  rot: number;
  /* appearance */
  r: number; g: number; b: number; opacity: number;
  sizeBegin: number; sizeEnd: number; lifetime: number; spin: number;
  /* physics */
  drag: number; gravity: number; turbulence: number;
  floorY: number; emissive: number; bounce: number;
  /* atlas + behaviour */
  cell: number; frames: number; model: number; flags: number;
}

const DEFAULTS: SpawnDesc = {
  px: 0, py: 0, pz: 0,
  vx: 0, vy: 0, vz: 0,
  rot: 0,
  r: 1, g: 1, b: 1, opacity: 1,
  sizeBegin: 0.2, sizeEnd: 0.4, lifetime: 1, spin: 0,
  drag: 1.5, gravity: 0, turbulence: 0,
  floorY: -1e6, emissive: 0, bounce: 0,
  cell: 0, frames: 1, model: MODEL.MEDIA, flags: 0,
};

const KEYS = Object.keys(DEFAULTS) as (keyof SpawnDesc)[];

/* ------------------------------------------------------------------ engine -- */

export interface GpuParticleOptions {
  maxParticles: number;
  /** Multiplies every requested particle count. 1 = full quality. */
  density: number;
  softParticles: boolean;
  shadows: boolean;
  aerial: boolean;
  frameBlend: boolean;
}

const MAX_SPAWN_PER_FRAME = 2048;

function sideFor(capacity: number): number {
  let side = 16;
  while (side * side < capacity) side *= 2;
  return Math.min(side, 512);
}

export class GpuParticles {
  capacity = 0;
  side = 16;
  /** Highest slot index that currently holds a live particle. */
  private high = -1;
  private cursor = 0;
  private deathAt!: Float32Array;
  private clock = 0;
  private frameIndex = 0;

  /** Live particle estimate, surfaced for the perf HUD. */
  live = 0;
  spawnedThisFrame = 0;
  droppedThisFrame = 0;

  options: GpuParticleOptions = {
    maxParticles: 20000, density: 1, softParticles: true,
    shadows: true, aerial: true, frameBlend: true,
  };

  readonly desc: SpawnDesc = { ...DEFAULTS };

  private renderer!: THREE.WebGLRenderer;
  private blitter!: FxBlitter;
  private atlas!: SpriteAtlas;
  private shared: Record<string, THREE.IUniform> = {};

  private dyn: THREE.WebGLRenderTarget[] = [];
  private stat!: THREE.WebGLRenderTarget;
  private ping = 0;

  private simMat!: THREE.ShaderMaterial;
  private spawnDynMat!: THREE.ShaderMaterial;
  private spawnStatMat!: THREE.ShaderMaterial;
  private spawnGeom!: THREE.BufferGeometry;
  private spawnPoints!: THREE.Points;
  private spawnScene = new THREE.Scene();
  private spawnCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private spawnCount = 0;

  private aSlot!: THREE.BufferAttribute;
  private aPos!: THREE.BufferAttribute;
  private aVel!: THREE.BufferAttribute;
  private aRot!: THREE.BufferAttribute;
  private aColor!: THREE.BufferAttribute;
  private aS1!: THREE.BufferAttribute;
  private aS2!: THREE.BufferAttribute;
  private aS3!: THREE.BufferAttribute;

  private quadGeom!: THREE.InstancedBufferGeometry;
  private alphaMat!: THREE.ShaderMaterial;
  private addMat!: THREE.ShaderMaterial;
  meshAlpha!: THREE.Mesh;
  meshAdd!: THREE.Mesh;

  readonly wind = new THREE.Vector3(0.6, 0.05, -0.35);
  turbulenceScale = 0.55;

  /* ---------------------------------------------------------------- setup */

  init(
    renderer: THREE.WebGLRenderer,
    blitter: FxBlitter,
    atlas: SpriteAtlas,
    shared: Record<string, THREE.IUniform>,
    options: Partial<GpuParticleOptions>,
  ): void {
    this.renderer = renderer;
    this.blitter = blitter;
    this.atlas = atlas;
    this.shared = shared;
    Object.assign(this.options, options);

    this.buildSpawnBuffers();
    this.buildMaterials();
    this.allocate(this.options.maxParticles);
  }

  private buildSpawnBuffers(): void {
    const n = MAX_SPAWN_PER_FRAME;
    const g = new THREE.BufferGeometry();
    const mk = (items: number): THREE.BufferAttribute => {
      const a = new THREE.BufferAttribute(new Float32Array(n * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aSlot = mk(1); this.aPos = mk(3); this.aVel = mk(3); this.aRot = mk(1);
    this.aColor = mk(4); this.aS1 = mk(4); this.aS2 = mk(4); this.aS3 = mk(4);
    g.setAttribute('aSlot', this.aSlot);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aRot', this.aRot);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aS1', this.aS1);
    g.setAttribute('aS2', this.aS2);
    g.setAttribute('aS3', this.aS3);
    // `position` is required by three's default attribute set even though the
    // spawn shader computes gl_Position from the slot index alone.
    g.setAttribute('position', mk(3));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.spawnGeom = g;

    this.spawnPoints = new THREE.Points(g, new THREE.MeshBasicMaterial());
    this.spawnPoints.frustumCulled = false;
    this.spawnPoints.matrixAutoUpdate = false;
    this.spawnPoints.updateMatrix();
    this.spawnScene.add(this.spawnPoints);
    this.spawnScene.matrixWorldAutoUpdate = false;
    this.spawnScene.updateMatrixWorld(true);
  }

  private buildMaterials(): void {
    this.simMat = fxSkipPatch(new THREE.ShaderMaterial({
      name: 'fx:particle-sim',
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERTEX,
      fragmentShader: SIM_FRAG,
      uniforms: {
        tState: { value: null }, tMotion: { value: null },
        tParam: { value: null }, tPhys: { value: null }, tExtra: { value: null },
        uDt: { value: 0 }, uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uTurbScale: { value: 0.55 },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    }));

    const spawnUniforms = () => ({ uSide: { value: 16 } });
    this.spawnDynMat = fxSkipPatch(new THREE.ShaderMaterial({
      name: 'fx:particle-spawn-dyn',
      glslVersion: THREE.GLSL3,
      vertexShader: SPAWN_VERT,
      fragmentShader: SPAWN_DYNAMIC_FRAG,
      uniforms: spawnUniforms(),
      depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.spawnStatMat = fxSkipPatch(new THREE.ShaderMaterial({
      name: 'fx:particle-spawn-stat',
      glslVersion: THREE.GLSL3,
      vertexShader: SPAWN_VERT,
      fragmentShader: SPAWN_STATIC_FRAG,
      uniforms: spawnUniforms(),
      depthTest: false, depthWrite: false, toneMapped: false,
    }));

    const base = makeQuadGeometry();
    const inst = new THREE.InstancedBufferGeometry();
    inst.index = base.index;
    inst.setAttribute('position', base.getAttribute('position'));
    inst.setAttribute('uv', base.getAttribute('uv'));
    inst.instanceCount = 0;
    inst.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.quadGeom = inst;

    this.alphaMat = this.makeRenderMaterial(false);
    this.addMat = this.makeRenderMaterial(true);

    this.meshAlpha = new THREE.Mesh(inst, this.alphaMat);
    this.meshAdd = new THREE.Mesh(inst, this.addMat);
    for (const [m, order] of [[this.meshAlpha, 3000], [this.meshAdd, 3200]] as const) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.renderOrder = order;
      m.castShadow = false;
      m.receiveShadow = false;
      m.layers.set(FX_LAYER_TRANSPARENT);
      m.name = order === 3000 ? 'fx:particles-alpha' : 'fx:particles-add';
    }
  }

  private makeRenderMaterial(additive: boolean): THREE.ShaderMaterial {
    const uniforms: Record<string, THREE.IUniform> = {
      tState: { value: null }, tMotion: { value: null }, tColor: { value: null },
      tParam: { value: null }, tPhys: { value: null }, tExtra: { value: null },
      tAtlasA: { value: this.atlas.a }, tAtlasB: { value: this.atlas.b },
      uSide: { value: 16 }, uInvSide: { value: 1 / 16 },
      uAdditivePass: { value: additive ? 1 : 0 },
      uCellScale: { value: 1 / ATLAS_COLS },
      uCellCols: { value: ATLAS_COLS },
      uFrameBlend: { value: this.options.frameBlend ? 1 : 0 },
      uDt: { value: 1 / 60 },
      uSizeScale: { value: 1 },
      uStretch: { value: 1 },
      uSoft: { value: this.options.softParticles ? 1 : 0 },
      uAerial: { value: this.options.aerial && !additive ? 1 : 0 },
      uNormalStrength: { value: additive ? 0.25 : 0.85 },
      uExposureHint: { value: 1 },
    };
    // Share the renderer's own uniform objects: the sun, the sky SH probe, the
    // cascades and the depth buffer all stay in sync with zero bookkeeping.
    for (const k in this.shared) uniforms[k] = this.shared[k];
    if (!uniforms.boSceneDepth) uniforms.boSceneDepth = { value: null };
    if (!uniforms.boCameraParams) uniforms.boCameraParams = { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) };
    if (!uniforms.boResolution) uniforms.boResolution = { value: new THREE.Vector2(1920, 1080) };

    const mat = fxSkipPatch(new THREE.ShaderMaterial({
      name: additive ? 'fx:particles-add' : 'fx:particles-alpha',
      glslVersion: THREE.GLSL3,
      vertexShader: RENDER_VERT,
      fragmentShader: RENDER_FRAG,
      uniforms,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    }));
    return mat;
  }

  /* ----------------------------------------------------------- allocation */

  /** (Re)sizes the buffers for a new particle budget. Live particles are lost. */
  allocate(maxParticles: number): void {
    const capacity = Math.max(256, Math.min(Math.floor(maxParticles), 262144));
    const side = sideFor(capacity);
    if (this.capacity === capacity && this.side === side && this.dyn.length) return;

    for (const t of this.dyn) t.dispose();
    this.dyn.length = 0;
    this.stat?.dispose();

    this.capacity = capacity;
    this.side = side;
    this.deathAt = new Float32Array(side * side);
    this.high = -1;
    this.cursor = 0;

    const common = {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    } as const;

    for (let i = 0; i < 2; i++) {
      const t = new THREE.WebGLRenderTarget(side, side, { ...common, count: 2 });
      t.textures[0].name = `fx:pstate${i}`;
      t.textures[1].name = `fx:pmotion${i}`;
      for (const tex of t.textures) {
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
      }
      this.dyn.push(t);
    }
    this.stat = new THREE.WebGLRenderTarget(side, side, { ...common, count: 4 });
    const names = ['fx:pcolor', 'fx:pparam', 'fx:pphys', 'fx:pextra'];
    this.stat.textures.forEach((tex, i) => {
      tex.name = names[i];
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    });

    this.spawnDynMat.uniforms.uSide.value = side;
    this.spawnStatMat.uniforms.uSide.value = side;
    for (const m of [this.alphaMat, this.addMat]) {
      m.uniforms.uSide.value = side;
      m.uniforms.uInvSide.value = 1 / side;
    }

    this.clearTargets();
  }

  private clearTargets(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevClear = new THREE.Color();
    r.getClearColor(prevClear);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of this.dyn) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setRenderTarget(this.stat); r.clear(true, false, false);
    r.setRenderTarget(prev);
    r.setClearColor(prevClear, prevAlpha);
    this.deathAt.fill(0);
    this.high = -1;
    this.live = 0;
  }

  /** Kills everything. Used when a debug scene restages an effect. */
  clear(): void {
    this.clearTargets();
    this.spawnCount = 0;
    this.cursor = 0;
  }

  /* --------------------------------------------------------------- spawning */

  /** Resets the scratch descriptor, optionally seeding it from a preset. */
  begin(preset?: Partial<SpawnDesc>): SpawnDesc {
    const d = this.desc;
    for (let i = 0; i < KEYS.length; i++) {
      const k = KEYS[i];
      d[k] = DEFAULTS[k];
    }
    if (preset) Object.assign(d, preset);
    return d;
  }

  /** Commits the scratch descriptor as one new particle. */
  push(): void {
    if (this.spawnCount >= MAX_SPAWN_PER_FRAME) { this.droppedThisFrame++; return; }
    const d = this.desc;
    if (d.lifetime <= 0) return;

    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (slot > this.high) this.high = slot;
    this.deathAt[slot] = this.clock + d.lifetime;

    const i = this.spawnCount++;
    this.aSlot.array[i] = slot;
    const p = this.aPos.array as Float32Array;
    p[i * 3] = d.px; p[i * 3 + 1] = d.py; p[i * 3 + 2] = d.pz;
    const v = this.aVel.array as Float32Array;
    v[i * 3] = d.vx; v[i * 3 + 1] = d.vy; v[i * 3 + 2] = d.vz;
    (this.aRot.array as Float32Array)[i] = d.rot;

    const c = this.aColor.array as Float32Array;
    c[i * 4] = d.r; c[i * 4 + 1] = d.g; c[i * 4 + 2] = d.b; c[i * 4 + 3] = d.opacity;

    const s1 = this.aS1.array as Float32Array;
    s1[i * 4] = d.sizeBegin; s1[i * 4 + 1] = d.sizeEnd;
    s1[i * 4 + 2] = d.lifetime; s1[i * 4 + 3] = d.spin;

    const frames = Math.max(1, Math.min(16, Math.round(d.frames)));
    const s2 = this.aS2.array as Float32Array;
    s2[i * 4] = d.drag; s2[i * 4 + 1] = d.gravity; s2[i * 4 + 2] = d.turbulence;
    s2[i * 4 + 3] = d.cell + frames * 64;

    const s3 = this.aS3.array as Float32Array;
    s3[i * 4] = d.floorY; s3[i * 4 + 1] = d.emissive; s3[i * 4 + 2] = d.bounce;
    s3[i * 4 + 3] = (d.model & 3) | d.flags;
  }

  /** Convenience: commit the scratch `n` times, calling `vary` before each. */
  pushMany(n: number, vary: (d: SpawnDesc, i: number) => void): void {
    const count = Math.max(0, Math.round(n * this.options.density));
    for (let i = 0; i < count; i++) {
      vary(this.desc, i);
      this.push();
    }
  }

  /** Scales a requested count by the density budget. */
  count(n: number): number {
    if (n <= 0) return 0;
    return Math.max(1, Math.round(n * this.options.density));
  }

  /* ----------------------------------------------------------------- frame */

  update(dt: number, elapsed: number): void {
    if (!this.dyn.length) return;
    this.clock = elapsed;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    const read = this.dyn[this.ping];
    const write = this.dyn[1 - this.ping];

    /* --- 1. integrate */
    const su = this.simMat.uniforms;
    su.tState.value = read.textures[0];
    su.tMotion.value = read.textures[1];
    su.tParam.value = this.stat.textures[1];
    su.tPhys.value = this.stat.textures[2];
    su.tExtra.value = this.stat.textures[3];
    su.uDt.value = Math.min(dt, 1 / 20);
    su.uTime.value = elapsed;
    (su.uWind.value as THREE.Vector3).copy(this.wind);
    su.uTurbScale.value = this.turbulenceScale;
    this.blitter.blit(r, this.simMat, write);

    /* --- 2. rasterise new particles into the freshly written state */
    if (this.spawnCount > 0) {
      this.uploadSpawns();
      this.spawnGeom.setDrawRange(0, this.spawnCount);

      this.spawnPoints.material = this.spawnDynMat;
      r.setRenderTarget(write);
      r.render(this.spawnScene, this.spawnCamera);

      this.spawnPoints.material = this.spawnStatMat;
      r.setRenderTarget(this.stat);
      r.render(this.spawnScene, this.spawnCamera);

      this.spawnedThisFrame = this.spawnCount;
      this.spawnCount = 0;
    } else {
      this.spawnedThisFrame = 0;
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    this.ping = 1 - this.ping;

    /* --- 3. hand the current state to the draw materials */
    const cur = this.dyn[this.ping];
    while (this.high >= 0 && this.deathAt[this.high] <= elapsed) this.high--;
    // The exact live count is only wanted by the perf HUD; a full scan of the
    // slot table every frame is pure waste, so amortise it.
    if ((this.frameIndex++ & 15) === 0) {
      let liveCount = 0;
      for (let i = 0; i <= this.high; i++) if (this.deathAt[i] > elapsed) liveCount++;
      this.live = liveCount;
    }

    const instances = this.high + 1;
    this.quadGeom.instanceCount = instances;
    this.meshAlpha.visible = instances > 0;
    this.meshAdd.visible = instances > 0;

    for (const m of [this.alphaMat, this.addMat]) {
      const u = m.uniforms;
      u.tState.value = cur.textures[0];
      u.tMotion.value = cur.textures[1];
      u.tColor.value = this.stat.textures[0];
      u.tParam.value = this.stat.textures[1];
      u.tPhys.value = this.stat.textures[2];
      u.tExtra.value = this.stat.textures[3];
      u.uDt.value = Math.max(dt, 1 / 240);
      u.uSoft.value = this.options.softParticles ? 1 : 0;
      u.uFrameBlend.value = this.options.frameBlend ? 1 : 0;
    }
    this.droppedThisFrame = 0;
  }

  private uploadSpawns(): void {
    const n = this.spawnCount;
    const attrs: [THREE.BufferAttribute, number][] = [
      [this.aSlot, 1], [this.aPos, 3], [this.aVel, 3], [this.aRot, 1],
      [this.aColor, 4], [this.aS1, 4], [this.aS2, 4], [this.aS3, 4],
    ];
    for (const [a, items] of attrs) {
      const ranged = a as unknown as {
        addUpdateRange?: (start: number, count: number) => void;
        clearUpdateRanges?: () => void;
      };
      if (ranged.addUpdateRange && ranged.clearUpdateRanges) {
        ranged.clearUpdateRanges();
        ranged.addUpdateRange(0, n * items);
      }
      a.needsUpdate = true;
    }
  }

  /** Applies a quality preset without rebuilding the pipeline. */
  applyQuality(o: Partial<GpuParticleOptions>): void {
    Object.assign(this.options, o);
    if (o.maxParticles !== undefined) this.allocate(o.maxParticles);
    for (const m of [this.alphaMat, this.addMat]) {
      m.uniforms.uSoft.value = this.options.softParticles ? 1 : 0;
      m.uniforms.uFrameBlend.value = this.options.frameBlend ? 1 : 0;
    }
    // Fewer, slightly larger particles keeps the same visual density when the
    // budget drops instead of thinning a plume into a scatter of dots.
    const s = this.options.density < 1 ? 1 + (1 - this.options.density) * 0.45 : 1;
    for (const m of [this.alphaMat, this.addMat]) m.uniforms.uSizeScale.value = s;
  }

  dispose(): void {
    for (const t of this.dyn) t.dispose();
    this.stat?.dispose();
    this.simMat?.dispose();
    this.spawnDynMat?.dispose();
    this.spawnStatMat?.dispose();
    this.alphaMat?.dispose();
    this.addMat?.dispose();
    this.spawnGeom?.dispose();
    this.quadGeom?.dispose();
  }
}
