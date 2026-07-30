/**
 * FXSystem — GPU particles, impacts, tracers, muzzle flashes, explosions and
 * environmental effects.
 *
 * The whole module is a *pure listener*: it subscribes to the event bus and
 * never calls into gameplay, never holds a reference to another system's
 * internals, and works identically whether or not weapons, AI or the director
 * exist yet. Everything it needs from the renderer arrives through `RenderAPI`
 * plus one optional, defensively probed extra — the renderer's shared uniform
 * block — which lets particles be lit by the same sun, sky probe, cascades and
 * fog as the rest of the world without either module knowing about the other.
 *
 * Ordering inside a frame:
 *   fixedUpdate  rigid bodies that need a stable step (casings, blood droplets)
 *   update       CPU sprites, ribbons, emitters, then one GPU simulation pass
 *   render        two instanced draws for particles + a handful for hero quads
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { SurfaceType } from '../core/Surfaces';

import { FxBlitter, asScreenFxState, clamp } from './Common';
import type { FxRenderHost, FxScreenFxState } from './Common';
import { bakeSpriteAtlas, type SpriteAtlas } from './SpriteAtlas';
import { GpuParticles } from './GpuParticles';
import { QuadFX } from './Quads';
import { Ribbons } from './Ribbons';
import { Casings } from './Casings';
import { Impacts } from './Impacts';
import { MuzzleFX } from './MuzzleFX';
import { Explosions } from './Explosions';
import { SmokeFX } from './Smoke';
import { EnvironmentFX } from './Environment';
import type { DecalDrop, FxWorld, LightRequest } from './Context';
import { registerFxDebugScene } from './DebugScene';

interface MinimalRayHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceType;
  object: THREE.Object3D | null;
  entityId: number;
  bodyHandle: number;
  zone: string;
  backface: boolean;
}

interface PhysicsProbe {
  ready?: boolean;
  raycast?(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: MinimalRayHit, ignoreEntity?: number,
  ): MinimalRayHit;
}

interface Scheduled { at: number; fn: () => void; }

const DOWN = new THREE.Vector3(0, -1, 0);
const MASK_SOLID = (1 << 0) | (1 << 1);

export class FXSystem implements System, FxWorld {
  readonly name = 'fx';
  readonly order = ORDER.FX;

  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;

  readonly particles = new GpuParticles();
  readonly quads = new QuadFX();
  readonly ribbons = new Ribbons();
  readonly casings = new Casings();
  readonly impacts = new Impacts();
  readonly muzzle = new MuzzleFX();
  readonly explosions = new Explosions();
  readonly smoke = new SmokeFX();
  readonly environment = new EnvironmentFX();

  readonly rand = new Rand('fx:main');
  renderHost: FxRenderHost | null = null;
  clock = 0;
  density = 1;
  quality = 'ultra';
  blood = true;

  get wind(): THREE.Vector3 { return this.particles.wind; }

  /** Fallback floor height when there is no physics backend to ask. */
  defaultGroundY = 0;

  private blitter = new FxBlitter();
  private atlas!: SpriteAtlas;
  private shared: Record<string, THREE.IUniform> = {};
  private fallback: Record<string, THREE.IUniform> = {};
  private usingFallback = true;
  private physics: PhysicsProbe | null = null;
  private rayHit: MinimalRayHit;
  private unsubscribe: (() => void)[] = [];
  private scheduled: Scheduled[] = [];

  /* --- scene-colour copy used by refractive effects --------------------- */
  private sceneCopy: THREE.FramebufferTexture | null = null;
  private copyWidth = 0;
  private copyHeight = 0;
  private refractionEnabled = false;
  private refractionFailed = false;

  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private floorCache: { x: number; z: number; y: number; t: number }[] = [];

  /* --- the post module's screen-effect state, probed until found --------- */
  private screenFx: FxScreenFxState | null = null;

  constructor() {
    this.rayHit = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      distance: 0, surface: 'concrete', object: null, entityId: -1,
      bodyHandle: -1, zone: 'none', backface: false,
    };
    for (let i = 0; i < 8; i++) this.floorCache.push({ x: NaN, z: NaN, y: 0, t: -1 });
  }

  /* ------------------------------------------------------------------ init */

  async init(ctx: EngineContext): Promise<void> {
    this.scene = ctx.scene;
    this.camera = ctx.camera;

    const host = ctx.engine.tryGet('render') as unknown as FxRenderHost | undefined;
    this.renderHost = host ?? null;
    const phys = ctx.engine.tryGet('physics') as unknown as PhysicsProbe | undefined;
    this.physics = phys ?? null;

    this.buildFallbackUniforms();
    const provided = this.renderHost?.uniforms?.shared?.();
    if (provided) {
      this.shared = { ...this.fallback, ...provided };
      this.usingFallback = false;
    } else {
      this.shared = this.fallback;
      this.usingFallback = true;
    }

    const renderer = this.renderHost?.renderer;
    if (!renderer) {
      console.warn('[fx] no renderer available — effects disabled');
      return;
    }

    this.applyQuality(false);
    const cellSize = settings.preset === 'low' || settings.preset === 'medium' ? 128 : 256;
    this.atlas = bakeSpriteAtlas(renderer, this.blitter, cellSize);

    this.particles.init(renderer, this.blitter, this.atlas, this.shared, this.particleOptions());
    this.quads.init(this.atlas, this.shared, 640, true);
    this.ribbons.init(this.shared, 96, true);
    this.casings.init(72);
    this.impacts.init(96);
    this.explosions.init(this.shared, 3, true);
    this.smoke.init(6);
    this.environment.init(this.shared, 6);

    const root = new THREE.Group();
    root.name = 'fx';
    root.matrixAutoUpdate = false;
    this.scene.add(root);
    root.add(this.particles.meshAlpha, this.particles.meshAdd);
    for (const m of this.quads.meshes) root.add(m);
    root.add(this.ribbons.mesh);
    for (const o of this.casings.objects) root.add(o);
    for (const o of this.explosions.objects) root.add(o);
    this.fxRoot = root;

    this.setupRefraction(renderer);
    this.subscribe();
    // The engine handle is what lets a staged shot fast-forward an effect to the
    // age it reads best at. It has to come from here, not from the `?debug=fx`
    // scene builder: the FX shots are registered unconditionally and are
    // captured against whatever level is loaded.
    registerFxDebugScene(this, ctx.engine);
  }

  private fxRoot: THREE.Group | null = null;

  /** Effects created after init (light shafts) attach here. */
  attach(object: THREE.Object3D): void {
    (this.fxRoot ?? this.scene).add(object);
  }

  private buildFallbackUniforms(): void {
    this.fallback = {
      boSunDirWorld: { value: new THREE.Vector3(0.32, 0.78, 0.53).normalize() },
      boSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      boSunColor: { value: new THREE.Color(2.6, 2.4, 2.1) },
      boAmbientSH: { value: Array.from({ length: 9 }, (_, i) => new THREE.Vector3(i === 0 ? 0.45 : 0, i === 0 ? 0.5 : 0, i === 0 ? 0.62 : 0)) },
      boAmbientTint: { value: new THREE.Color(1, 1, 1) },
      boAmbientIntensity: { value: 1 },
      boSceneDepth: { value: null },
      boCameraParams: { value: new THREE.Vector4(0.02, 900, 1 / 1920, 1 / 1080) },
      boResolution: { value: new THREE.Vector2(1920, 1080) },
      boPrevViewProjection: { value: new THREE.Matrix4() },
      boViewProjectionNoJitter: { value: new THREE.Matrix4() },
      boShadowStrength: { value: 0 },
      boCsmInfo: { value: new THREE.Vector4(0, 0.01, 120, 2048) },
      boCsmMatrix: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
      boCsmTile: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      boCsmParams: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      boShadowAtlas: { value: null },
    };
  }

  private particleOptions() {
    const g = settings.gfx;
    const preset = settings.preset;
    return {
      maxParticles: g.maxParticles,
      density: this.density,
      softParticles: true,
      shadows: preset !== 'low' && preset !== 'medium',
      aerial: true,
      frameBlend: preset !== 'low',
    };
  }

  private applyQuality(propagate = true): void {
    this.quality = settings.preset;
    this.density = settings.preset === 'low' ? 0.32
      : settings.preset === 'medium' ? 0.6
        : settings.preset === 'high' ? 0.85 : 1.0;
    this.blood = settings.game.showBlood;
    this.refractionEnabled = !this.refractionFailed
      && (settings.preset === 'high' || settings.preset === 'ultra' || settings.preset === 'cinematic');
    if (propagate) {
      this.particles.applyQuality(this.particleOptions());
      this.quads.setSoft(true);
      this.ribbons.setSoft(true);
    }
  }

  /* ---------------------------------------------------------- refraction -- */

  private setupRefraction(renderer: THREE.WebGLRenderer): void {
    this.quads.onRefractBeforeRender(() => {
      if (!this.refractionEnabled || this.refractionFailed) return;
      const tex = this.sceneCopy;
      if (!tex) return;
      try {
        renderer.copyFramebufferToTexture(tex);
      } catch (err) {
        // Some drivers refuse a float copy; fall back to the additive look
        // rather than spamming the log every frame.
        console.warn('[fx] scene copy unavailable — refraction disabled', err);
        this.refractionFailed = true;
        this.quads.setSceneTexture(null);
      }
    });
  }

  private ensureSceneCopy(renderer: THREE.WebGLRenderer): void {
    if (!this.refractionEnabled || this.refractionFailed) {
      if (this.quads.refractionReady) this.quads.setSceneTexture(null);
      return;
    }
    const size = renderer.getDrawingBufferSize(this.tmpSize);
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    if (this.sceneCopy && this.copyWidth === w && this.copyHeight === h) return;
    this.sceneCopy?.dispose();
    const tex = new THREE.FramebufferTexture(w, h);
    // The scene buffer is HDR; copying into an 8-bit texture is both a format
    // mismatch and a loss of everything above white.
    tex.type = THREE.HalfFloatType;
    tex.format = THREE.RGBAFormat;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.name = 'fx:sceneCopy';
    this.sceneCopy = tex;
    this.copyWidth = w;
    this.copyHeight = h;
    this.quads.setSceneTexture(tex);
  }

  private tmpSize = new THREE.Vector2();

  /* ------------------------------------------------------------- listeners */

  private subscribe(): void {
    const off = this.unsubscribe;

    off.push(bus.on('bullet:impact', (e) => {
      this.impacts.spawn(
        this, e.point, e.normal, e.surface, e.energy,
        e.incoming ?? null, e.penetrated,
      );
    }));

    off.push(bus.on('weapon:fire', (e) => {
      this.muzzle.fire(this, e.weaponId, e.origin, e.direction, e.shotIndex, e.suppressed, true);
    }));

    off.push(bus.on('ai:fire', (e) => {
      // AI weapons are third person: a smaller flash, no view shake, and the
      // round is checked for a near miss so incoming fire reads.
      this.muzzle.fire(this, 'ar_ai', e.origin, e.direction, e.id, false, false);
      this.checkWhizz(e.origin, e.direction);
    }));

    off.push(bus.on('explosion', (e) => {
      const kind = (e.kind ?? '').toLowerCase();
      if (kind.includes('flash') || kind.includes('stun')) {
        this.smoke.flashbang(this, e.point);
      } else if (kind.includes('smoke')) {
        this.smoke.screen(this, e.point, Math.max(3, e.radius), 15);
      } else {
        this.explosions.detonate(this, e.point, e.radius, clamp(e.power / 100, 0.4, 3), kind);
      }
    }));

    off.push(bus.on('player:footstep', (e) => this.footstep(e.point, e.surface, e.sprinting)));
    off.push(bus.on('player:land', (e) => this.land(e.point, e.force, e.surface)));

    off.push(bus.on('quality:changed', () => this.applyQuality()));
    off.push(bus.on('settings:changed', (e) => {
      if (e.key === 'game.showBlood') this.blood = settings.game.showBlood;
      if (e.key.startsWith('gfx.')) this.applyQuality();
    }));

    off.push(bus.on('weapon:overheat', () => { /* handled by barrel heat */ }));
  }

  private checkWhizz(origin: THREE.Vector3, direction: THREE.Vector3): void {
    // Closest approach of the shot line to the camera.
    this.tmpV.subVectors(this.camera.position, origin);
    const along = this.tmpV.dot(direction);
    if (along <= 0.5) return;
    this.tmpV2.copy(origin).addScaledVector(direction, along);
    const miss = this.tmpV2.distanceTo(this.camera.position);
    if (miss > 3.2) return;
    // Start the streak a little before the camera so it crosses the view.
    this.tmpV2.copy(origin).addScaledVector(direction, Math.max(0, along - 14));
    this.environment.whizzBy(this, this.tmpV2, direction, miss);
  }

  private footstep(point: THREE.Vector3, surfaceName: string, sprinting: boolean): void {
    if (this.density < 0.4) return;
    const g = this.particles;
    const rand = this.rand;
    const soft = surfaceName === 'dirt' || surfaceName === 'sand' || surfaceName === 'gravel'
      || surfaceName === 'snow' || surfaceName === 'mud' || surfaceName === 'grass';
    if (!soft && !sprinting) return;
    g.begin({
      cell: 16, frames: 8, model: 0,
      flags: 16 | 64 | 128,
      r: 0.5, g: 0.47, b: 0.42, opacity: soft ? 0.22 : 0.10,
      drag: 3.0, gravity: -0.01, turbulence: 0.5,
    });
    g.pushMany(soft ? 4 : 2, (d) => {
      d.px = point.x + rand.signed() * 0.10;
      d.py = point.y + 0.02;
      d.pz = point.z + rand.signed() * 0.10;
      d.vx = rand.signed() * 0.5; d.vy = 0.25 + rand.next() * 0.3; d.vz = rand.signed() * 0.5;
      d.sizeBegin = 0.06; d.sizeEnd = 0.34 + rand.next() * 0.25;
      d.lifetime = 0.7 + rand.next() * 0.7;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.7;
    });
  }

  private land(point: THREE.Vector3, force: number, surfaceName: string): void {
    const g = this.particles;
    const rand = this.rand;
    const k = clamp(force / 8, 0.2, 2);
    g.begin({
      cell: 16, frames: 8, model: 0,
      flags: 16 | 64 | 128,
      r: 0.55, g: 0.52, b: 0.47, opacity: 0.26 * k,
      drag: 2.4, gravity: -0.01, turbulence: 0.6,
    });
    g.pushMany(7 * k, (d) => {
      const a = rand.range(0, Math.PI * 2);
      d.px = point.x + Math.cos(a) * 0.18;
      d.py = point.y + 0.03;
      d.pz = point.z + Math.sin(a) * 0.18;
      const sp = 1.1 + rand.next() * 1.6 * k;
      d.vx = Math.cos(a) * sp; d.vy = 0.35 + rand.next() * 0.5; d.vz = Math.sin(a) * sp;
      d.sizeBegin = 0.10; d.sizeEnd = 0.55 + rand.next() * 0.5;
      d.lifetime = 1.0 + rand.next() * 1.0;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.5;
    });
    void surfaceName;
  }

  /* ------------------------------------------------------------- FxWorld -- */

  floorUnder(x: number, y: number, z: number): number {
    const now = this.clock;
    for (const c of this.floorCache) {
      if (Math.abs(c.x - x) < 1.5 && Math.abs(c.z - z) < 1.5 && now - c.t < 0.5) return c.y;
    }
    let result = this.defaultGroundY;
    const phys = this.physics;
    if (phys?.ready && typeof phys.raycast === 'function') {
      this.tmpV.set(x, y + 0.35, z);
      try {
        const hit = phys.raycast(this.tmpV, DOWN, 60, MASK_SOLID, this.rayHit);
        if (hit?.hit) result = hit.point.y;
      } catch { /* physics not ready yet */ }
    }
    // Evict the oldest cache line.
    let oldest = this.floorCache[0];
    for (const c of this.floorCache) if (c.t < oldest.t) oldest = c;
    oldest.x = x; oldest.z = z; oldest.y = result; oldest.t = now;
    return result;
  }

  distanceToCamera(x: number, y: number, z: number): number {
    const c = this.camera.position;
    return Math.hypot(x - c.x, y - c.y, z - c.z);
  }

  light(req: LightRequest): void {
    const r = this.renderHost;
    if (!r) return;
    this.tmpV.set(req.x, req.y, req.z);
    r.addDynamicLight({
      position: this.tmpV,
      color: req.color,
      intensity: req.intensity,
      radius: req.radius,
      lifetime: req.lifetime,
      decay: req.decay ?? 'exp',
    });
  }

  decal(req: DecalDrop): void {
    const r = this.renderHost;
    if (!r) return;
    this.tmpV.set(req.x, req.y, req.z);
    this.tmpV2.set(req.nx, req.ny, req.nz);
    r.addDecal({
      position: this.tmpV,
      normal: this.tmpV2,
      size: req.size,
      group: req.group,
      rotation: req.rotation,
      lifetime: req.lifetime,
      colorTint: req.colorTint,
      emissive: req.emissive,
    });
  }

  shake(amount: number, frequency?: number, duration?: number): void {
    this.renderHost?.addCameraShake(amount, frequency, duration);
  }

  flash(intensity: number, color = 0xffffff, decay = 4): void {
    this.renderHost?.screenEffect({ flash: { intensity, color, decay } });
  }

  concussion(intensity: number, duration: number): void {
    this.renderHost?.screenEffect({ concussion: { intensity, duration } });
  }

  /**
   * The post library's screen-effect state, found once and cached.
   *
   * `RenderAPI` can only *add* to that state — there is no way to read it back
   * or clear it — yet the same state also subscribes to the event bus on its
   * own. FX therefore has to be able to reach it to (a) dial a flashbang's
   * white-out down by distance and (b) leave a clean frame behind on `reset()`.
   * Probed defensively: no post library, no handle, no behaviour change.
   */
  private screenFxState(): FxScreenFxState | null {
    if (this.screenFx) return this.screenFx;
    const passes = this.renderHost?.passes;
    // The post library is loaded asynchronously, so an empty list means "not
    // yet", not "never" — latching the miss on the first frame would switch
    // this off for the whole session.
    if (!Array.isArray(passes) || passes.length === 0) return null;
    for (const p of passes) {
      const found = asScreenFxState(p?.res?.fx);
      if (found) { this.screenFx = found; break; }
    }
    return this.screenFx;
  }

  blind(amount: number): void {
    this.blindCeiling = clamp(amount, 0, 1);
    const s = this.screenFxState();
    if (!s) return;
    this.applyBlind(s, this.blindCeiling);
    this.blindSolvedTime = s.blindTime;
  }

  /** Ceiling the white-out is held under, or −1 when nothing is blinding. */
  private blindCeiling = -1;
  private blindSolvedTime = 0;

  /**
   * Asks the post module for a *partial* white-out.
   *
   * Writing `blind` directly does nothing: the module recomputes it from
   * `blindTime` on its own curve every frame, pinning it to 1.0 for the first
   * 0.55 s no matter what anyone else wrote — which is why a flashbang thirty
   * metres away used to erase the frame just as thoroughly as one at your feet.
   * Starting the clock part-way down that curve is the one lever that survives.
   * The constants are a best guess at the module's; `update()` corrects for them
   * being wrong, so this only has to be close.
   */
  private applyBlind(s: FxScreenFxState, amount: number): void {
    if (amount <= 0.002) { s.blind = 0; s.blindTime = 0; return; }
    const HOLD = 0.55, RECOVER = 4.2, CURVE = 2.2;
    s.blind = amount;
    s.blindTime = amount >= 0.999 ? 0 : HOLD + RECOVER * (1 - Math.pow(amount, 1 / CURVE));
  }

  /**
   * Zeroes every transient screen overlay.
   *
   * Without this a staged shot inherits the previous shot's flashbang: the
   * white-out holds for 0.55 s and then recovers over 4.2 s, which is longer
   * than any capture settles for, so the frame after a flashbang comes out a
   * flat white rectangle.
   */
  private clearScreenFx(): void {
    const s = this.screenFxState();
    if (!s) return;
    s.blind = 0; s.blindTime = 0;
    s.flash.setScalar(0);
    s.damage = 0;
    s.concussion = 0; s.concussionTime = 0;
    s.blood = 0; s.water = 0; s.dirt = 0;
  }

  after(delay: number, fn: () => void): void {
    this.scheduled.push({ at: this.clock + delay, fn });
  }

  /* --------------------------------------------------------------- public */

  /** Starts a smoke screen — the API a grenade should call. */
  smokeScreen(point: THREE.Vector3, radius = 5, duration = 15): void {
    this.smoke.screen(this, point, radius, duration);
  }

  /**
   * Unit vector toward the sun, as the renderer currently has it.
   *
   * Effects that have to agree with the key light — shafts, god rays, the side
   * a smoke column is lit from — read it here rather than hard-coding a
   * direction that is only correct at one time of day.
   */
  sunDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const v = this.shared.boSunDirWorld?.value as THREE.Vector3 | undefined;
    if (v && Number.isFinite(v.x)) out.copy(v);
    else out.set(0.32, 0.78, 0.53);
    return out.normalize();
  }

  /** Adds a persistent fire that emits flame, embers, smoke and light. */
  addFire(point: THREE.Vector3, radius = 0.6, intensity = 1): number {
    return this.environment.addFire(this, point, radius, intensity);
  }

  /** Adds a volumetric shaft; returns the mesh so callers can remove it. */
  addLightShaft(
    origin: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3,
    o: {
      width: number; height: number; length: number; color?: number;
      intensity?: number; falloff?: number; dust?: number; followSun?: boolean;
    },
  ): THREE.Mesh {
    const mesh = this.environment.addLightShaft(origin, dir, up, o);
    this.attach(mesh);
    return mesh;
  }

  setWeather(rain: number, fog: number, wind: number): void {
    this.environment.rain = clamp(rain, 0, 1);
    this.environment.fog = clamp(fog, 0, 1);
    this.particles.wind.set(wind * 1.4, 0.05, -wind * 0.8);
    this.renderHost?.setWeather(rain, fog, wind);
  }

  /** Wipes every live effect. Debug scenes use it to stage a clean frame. */
  reset(): void {
    // Decals outlive an effect by design, so a staged shot has to drop the
    // previous take's bullet holes as well.
    const decals = (this.renderHost as unknown as { decals?: { clear?(): void } } | null)?.decals;
    decals?.clear?.();
    this.clearScreenFx();
    this.particles.clear();
    this.quads.clear();
    this.ribbons.clear();
    this.casings.clear();
    this.impacts.clear();
    this.muzzle.clear();
    this.explosions.clear();
    this.smoke.clear();
    this.environment.clear();
    this.blindCeiling = -1;
    this.blindSolvedTime = 0;
    this.scheduled.length = 0;
    this.rand.seed('fx:main');
  }

  stats(): { particles: number; quads: number; ribbons: number; casings: number } {
    return {
      particles: this.particles.live,
      quads: this.quads.live,
      ribbons: this.ribbons.live,
      casings: this.casings.live,
    };
  }

  /* ---------------------------------------------------------------- frame */

  fixedUpdate(dt: number): void {
    this.casings.fixedUpdate(dt);
    this.impacts.fixedUpdate(dt, this);
  }

  update(dt: number, _ctx: EngineContext): void {
    const renderer = this.renderHost?.renderer;
    if (!renderer) return;
    const step = Math.min(dt, 1 / 20);
    this.clock += step;

    if (this.usingFallback) this.updateFallbackUniforms();
    this.ensureSceneCopy(renderer);

    // The white-out's recovery curve raises a negative base to a fractional
    // power once the effect is ~4.8 s old, which is NaN, and `Math.max(0, NaN)`
    // is NaN — so the guard that would decay it back to zero never fires again
    // and every later frame clamps to pure white. One comparison per frame is
    // cheaper than living with a permanently blank screen.
    const sfx = this.screenFxState();
    if (sfx && !Number.isFinite(sfx.blind)) { sfx.blind = 0; sfx.blindTime = 0; }
    if (sfx && this.blindCeiling >= 0) {
      // Both this module and the post module listen to `explosion`, and whichever
      // subscribed second wins, so the ceiling is re-asserted here rather than
      // trusting subscription order. If the module's clock is where we last left
      // it and the white-out is *still* over the ceiling, our model of its
      // recovery curve is out of date — walk its clock forward until it agrees.
      if (sfx.blind > this.blindCeiling + 0.01) {
        if (sfx.blindTime < this.blindSolvedTime - 1e-3) {
          this.applyBlind(sfx, this.blindCeiling);
        } else {
          sfx.blindTime += 0.35;
        }
        this.blindSolvedTime = sfx.blindTime;
      } else if (sfx.blind <= 0.004) {
        this.blindCeiling = -1;
      }
    }

    // Timed continuations (secondary fire, delayed debris, staged effects).
    if (this.scheduled.length) {
      for (let i = this.scheduled.length - 1; i >= 0; i--) {
        if (this.scheduled[i].at <= this.clock) {
          const s = this.scheduled[i];
          this.scheduled.splice(i, 1);
          try { s.fn(); } catch (err) { console.warn('[fx] scheduled effect threw', err); }
        }
      }
    }

    this.muzzle.update(step, this);
    this.smoke.update(step, this);
    this.environment.update(step, this);
    if (this.impacts.suppression > 0.2) {
      this.environment.suppressionHaze(this, this.impacts.suppression);
    }
    this.explosions.update(step);
    this.casings.update();

    // Emitters have all run; simulate and hand the buffers to the draw calls.
    this.particles.update(step, this.clock);
    this.quads.update(step, this.camera);
    this.ribbons.update(step, this.camera);
  }

  private updateFallbackUniforms(): void {
    const cam = this.camera;
    const p = this.fallback.boCameraParams.value as THREE.Vector4;
    p.x = cam.near; p.y = cam.far;
    void p;
  }

  /**
   * Runs before the render system's own `render()` (ORDER.FX < ORDER.RENDER).
   *
   * Defensive guard, not a feature: the frame graph re-points
   * `gbuffer.color` at a transient pool texture after compositing decals and
   * never restores it, so from the next frame on the composite reads and
   * writes the same scratch target — the scene colour becomes a feedback loop
   * and *nothing* drawn into the MRT after that frame is ever presented.
   * Restoring the attachment costs nothing and becomes a no-op the moment the
   * renderer stops aliasing it (see the integration note in the FX report).
   */
  render(): void {
    const gb = this.renderHost?.graph?.gbuffer;
    if (!gb) return;
    const attachment = gb.target?.textures?.[0];
    if (attachment && gb.color !== attachment) gb.color = attachment;
  }

  resize(): void { /* targets are sized from the drawing buffer on demand */ }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.particles.dispose();
    this.quads.dispose();
    this.ribbons.dispose();
    this.casings.dispose();
    this.explosions.dispose();
    this.environment.dispose();
    this.atlas?.dispose();
    this.blitter.dispose();
    this.sceneCopy?.dispose();
  }
}
