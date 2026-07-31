/**
 * WorldSystem — "Blackout": a war-torn Eastern-European town square.
 *
 * Owns the level in its entirety: terrain, the modular building kit and the
 * twelve buildings assembled from it, the prop library and its placement, the
 * distant backdrop, the lighting design, the navigation data and the visibility
 * system.
 *
 * Build order matters and is load-bearing:
 *
 *   terrain → buildings → boundary → backdrop → props → cloth → practicals
 *           → navigation (voxelises the finished scene graph)
 *           → culling registration → level:loaded
 *
 * Navigation is built from the *rendered* geometry, so it can never disagree
 * with what the player collides against; the physics module bakes its static
 * colliders from the same graph a frame later.
 *
 * ## API for other systems
 *
 *   const world = engine.get<WorldSystem>('world');
 *   world.findPath(from, to)         → straightened waypoints
 *   world.nearestPoly(point)         → polygon id, or -1 when off-mesh
 *   world.coverNear(pos, { threat }) → ranked cover points
 *   world.raycastNav(a, b)           → walkable line-of-travel test
 *   world.spawns / world.cover / world.links
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { ShotDef } from '../core/CaptureAPI';
import { LAYERS, type RenderAPI } from '../render/types';
import { LAYER, type PhysicsAPI, type RayHit } from '../physics/types';
import type { MaterialSystem } from '../material/MaterialLibrary';

import { MatCatalog } from './MatCatalog';
import { Chunk, ChunkSet } from './geom/Chunk';
import { FOOTPRINTS, MAP, SPAWN_POINTS, insideBuilding } from './Layout';
import { buildTerrain, groundHeightAt } from './build/Terrain';
import { buildAllBuildings, buildBoundary } from './build/Buildings';
import { buildBackdrop } from './build/Backdrop';
import { facadeDamage, fbm3, groundGrime } from './build/Grounding';
import { PropScatter, type PropCluster } from './props/Scatter';
import { dressWorld } from './props/Dressing';
import { ClothSystem, levelCloth } from './Cloth';
import { PracticalLights, type Practical } from './Lighting';
import { WorldCulling, type CullMode } from './Culling';
import {
  CompactField, DEFAULT_NAV_CONFIG, Rasteriser, SolidHeightfield, rasteriseScene,
} from './nav/Heightfield';
import { buildNavMesh, type CoverPoint, type NavMeshData, type TraversalLink } from './nav/NavMesh';
import { NavQuery, navDebugMesh, type CoverQuery, type PathResult, type ScoredCover } from './nav/NavQuery';
import { WORLD_SHOTS, registerWorldShots } from './Shots';

export interface SpawnPoint { position: THREE.Vector3; yaw: number; team: 'player' | 'enemy' | 'neutral'; }

/** Bounds of the ground-lit census grid; all optional, all in world metres. */
export interface SunCensusOptions {
  x0?: number; x1?: number; z0?: number; z1?: number;
  step?: number; maxDist?: number; lift?: number;
  /** Start each ray on the surface a player would stand on. Default true. */
  snap?: boolean;
}

export type { CoverPoint, TraversalLink, CoverQuery, PathResult, ScoredCover };

/**
 * Late afternoon — solar elevation ≈ 32.4°, azimuth 86.5° west of north.
 *
 * 18:00 put the sun at 11.03°, and at 11° a 12 m shop row throws a 62 m shadow
 * across a map whose playable extent is 68 × 80 m. A deterministic raycast
 * census against the physics colliders (2 m grid, 1435 ground samples) measured
 * **187 lit / 13.0%** at that hour: the level was standing inside its own
 * shadow, so the key direction was unreadable, and the facade turned *into* the
 * sun measured darker than the one turned away from it — the sun contributed
 * nothing to either, and the one facing away simply saw more open sky.
 *
 * 16.25 puts the disc at 32.4°: `tan(32.4°) = 0.635`, so the same shop row now
 * throws 19 m instead of 62 m and the census returns 45%+ of the ground lit,
 * with the shadows still long enough to run a third of the way across the
 * square and read as afternoon rather than noon.
 *
 * The amber the old comment was protecting does not need an 11° sun to exist.
 * It comes from three places that are all still in play at 32°: the sky's
 * multiple-scattering warm-up (`Sky.msStrength`), the solar transmittance
 * integral (which is still running through 1.9 air masses at this elevation,
 * against 1.0 at the zenith), and the grade. What an 11° sun uniquely provides
 * is *no direct light anywhere*, which is not a look — it is an outage.
 */
const TIME_OF_DAY = 16.25;

/** Sky fill tint. Cool, because sky fill is the cold half of the colour split. */
const AMBIENT_TINT = 0x7fa9ef;

/**
 * Sky-probe scale. Left at 3.2 **on measured evidence**, not by omission.
 *
 * The wave plan had this dropping to 1.0-1.5 once a real sky-visibility term
 * existed in the lighting patch, on the theory that an unoccluded probe at 3.2
 * was what flattened the key-to-fill ratio and collapsed the indoor/outdoor
 * exposure swing. The term now exists (`boSkyVisibility`). Swept live against
 * it on `square-north` at 16:15, exposure allowed to fully re-converge at each
 * step (`__WORLD__.setAmbient` does exactly this):
 *
 * ```
 *   probe  auto-exposure   sunlit vs shadowed plaza   street->warehouse swing
 *   3.2       1.90              0.17 stops                  1.52 stops
 *   2.2       2.16              0.17 stops                    —
 *   1.6       2.40              0.17 stops                    —
 *   1.5       2.45                —                         1.31 stops
 *   1.3       2.55              0.17 stops                    —
 *   1.2       2.61                —                         1.25 stops
 *   1.0       2.75              0.18 stops                    —
 * ```
 *
 * The ratio does not move at any value, because auto-exposure takes the change
 * straight back out — a 1.7× cut in fill buys a 1.45× rise in exposure and the
 * two patches stay the same distance apart on the tone curve. What the cut does
 * buy is darker interiors (warehouse frame mean 131.9 → 107.2) for a *narrower*
 * indoor/outdoor swing, which is the wrong direction on both counts.
 *
 * So the remaining flatness is not this number: it is that the metered
 * operating point puts both a sunlit and a shadowed cobble around display 160,
 * where the curve has no room left to separate them. That is an exposure-key
 * and tone-curve question (`Exposure.ts`, `Sky.ts`), and this constant should
 * only move once those do — measured against the same sweep, not assumed.
 */
const AMBIENT_INTENSITY = 3.2;

export class WorldSystem implements System {
  readonly name = 'world';
  readonly order = ORDER.WORLD;

  readonly root = new THREE.Group();
  readonly buildings = new THREE.Group();
  readonly propsRoot = new THREE.Group();
  readonly backdropRoot = new THREE.Group();
  readonly cloth = new ClothSystem();
  readonly lights = new PracticalLights();
  readonly culling = new WorldCulling();

  spawns: SpawnPoint[] = [];
  cover: CoverPoint[] = [];
  links: TraversalLink[] = [];
  bounds = new THREE.Box3(
    new THREE.Vector3(-MAP.half, -4, -MAP.half),
    new THREE.Vector3(MAP.half, 30, MAP.half),
  );

  /** Navigation query interface. Null until the navmesh has been built. */
  nav: NavQuery | null = null;
  navData: NavMeshData | null = null;

  private cat: MatCatalog | null = null;
  private clusters: PropCluster[] = [];
  private roofY: Record<string, number> = {};
  private renderApi: RenderAPI | null = null;
  private navDebug: THREE.Group | null = null;
  /**
   * Invisible stand-in for the sun.
   *
   * The sky system owns the real sun analytically, so the scene contains no
   * `DirectionalLight` at all — but the volumetric pass looks for one to decide
   * how much sunlight to scatter, and with none present it scatters its default
   * white at full strength, which fogs the whole map to a flat grey. This light
   * is `visible = false`, so three never uses it for shading and the renderer's
   * light-adoption pass never touches it; it exists purely so the volumetrics
   * have a correctly-coloured, correctly-oriented sun to sample.
   */
  private sunProxy = new THREE.DirectionalLight(0xffffff, 0);
  private buildStats = { terrainMs: 0, buildingsMs: 0, propsMs: 0, navMs: 0, triangles: 0, props: 0 };
  private _pathScratch: PathResult = { points: [], corridor: [], complete: false, length: 0 };
  private _tmpA = new THREE.Vector3();

  /* ------------------------------------------------------------------ init */

  async init(ctx: EngineContext): Promise<void> {
    const mats = ctx.engine.tryGet<MaterialSystem>('materials') ?? null;
    this.cat = new MatCatalog(mats);

    this.root.name = 'world';
    this.buildings.name = 'buildings';
    this.propsRoot.name = 'props';
    this.backdropRoot.name = 'backdrop';
    this.backdropRoot.layers.set(LAYERS.BACKDROP);
    this.root.add(this.buildings, this.propsRoot, this.backdropRoot, this.cloth.root);
    ctx.scene.add(this.root);

    const t0 = performance.now();

    /* --- ground ------------------------------------------------------- */
    const terrain = new Chunk();
    buildTerrain(terrain);
    const terrainGroup = new THREE.Group();
    terrainGroup.name = 'terrain';
    terrain.emit(terrainGroup, this.cat, {
      name: 'terrain', castShadow: false, receiveShadow: true,
      // Silt banked against every wall, spoil around every crater. This is what
      // grounds the whole map: without it the street is one uniform plane and
      // every building looks like it was dropped on to it.
      blend: (x, _y, z) => groundGrime(x, z),
    });
    this.root.add(terrainGroup);
    this.buildStats.terrainMs = performance.now() - t0;

    /* --- buildings ---------------------------------------------------- */
    const t1 = performance.now();
    const structures = new ChunkSet();
    const built = buildAllBuildings(structures);
    for (const [name, res] of Object.entries(built.blocks)) this.roofY[name] = res.roofY;
    buildBoundary(structures, this.root);
    this.buildStats.buildingsMs = performance.now() - t1;

    /* --- backdrop ----------------------------------------------------- */
    const backdrop = new Chunk();
    buildBackdrop(backdrop);
    backdrop.emit(this.backdropRoot, this.cat, {
      name: 'backdrop', castShadow: false, receiveShadow: false,
      layer: LAYERS.BACKDROP, noCollide: true, navIgnore: true,
    });
    for (const child of this.backdropRoot.children) child.layers.set(LAYERS.BACKDROP);

    /* --- props and set pieces ------------------------------------------ */
    const t2 = performance.now();
    const scatter = new PropScatter();
    dressWorld(scatter, structures, this.roofY);
    // One group per structure: the draw count stays low but every group has a
    // bounding sphere the culling system can actually reject.
    const structureGroups = structures.emitAll(this.buildings, this.cat, {
      // Blown render showing the masonry behind it, concentrated at the base
      // and around damage. Ground surfaces inside the same chunks (interior
      // slabs, the set pieces' debris) take the silt mask instead.
      blend: (x, y, z, key) => {
        if (key === 'asphalt' || key === 'asphaltWorn' || key === 'pavement'
          || key === 'cobble' || key === 'setts') return groundGrime(x, z);
        // Roof ballast: grit blown into drifts against the parapets, laid on a
        // wavelength of a couple of metres so a flat roof stops reading as one
        // uniform sheet from the rooftop route.
        if (key === 'roofFelt') return Math.min(1, fbm3(x * 0.42, y * 0.1, z * 0.42) * 1.5 - 0.25);
        return facadeDamage(x, y, z);
      },
    });
    this.clusters = scatter.build(this.propsRoot, this.cat);
    this.buildStats.props = scatter.count;
    this.buildStats.propsMs = performance.now() - t2;

    /* --- cloth -------------------------------------------------------- */
    this.cloth.build(levelCloth(), this.cat);

    /* --- lighting ----------------------------------------------------- */
    this.lights.init(ctx.scene);
    this.placePracticals();
    this.sunProxy.name = 'sun-proxy';
    this.sunProxy.visible = false;
    this.sunProxy.castShadow = false;
    this.sunProxy.position.set(-60, 26, 5);
    this.sunProxy.target.position.set(0, 0, 0);
    ctx.scene.add(this.sunProxy);

    /* --- spawns ------------------------------------------------------- */
    for (const s of SPAWN_POINTS) {
      this.spawns.push({
        position: new THREE.Vector3(s.x, groundHeightAt(s.x, s.z) + 0.05, s.z),
        yaw: THREE.MathUtils.degToRad(s.yaw),
        team: s.team,
      });
    }

    /* --- navigation --------------------------------------------------- */
    const t3 = performance.now();
    this.buildNavigation();
    this.buildStats.navMs = performance.now() - t3;

    /* --- visibility --------------------------------------------------- */
    for (const g of structureGroups) this.culling.addBuilding(g);
    for (const g of terrainGroup.children) {
      const mesh = g as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.geometry.computeBoundingSphere();
      const bs = mesh.geometry.boundingSphere;
      this.culling.add({
        object: mesh,
        centre: bs ? bs.center.clone() : new THREE.Vector3(),
        radius: bs ? bs.radius : 200,
        maxDistance: 1000,
        always: true,
      });
    }
    for (const c of this.clusters) this.culling.addPropCluster(c);

    /* --- environment -------------------------------------------------- */
    bus.on('game:ready', () => this.applyEnvironment(ctx));
    this.renderApi = ctx.engine.tryGet<System & RenderAPI>('render') ?? null;

    // Every camera in the level's shot list faces north, south or across the
    // square. At the hero hour the sun sits almost due west — outside all of
    // their frustums — which is how a map came back from review as "there is no
    // sun anywhere in the sky, at any hour". The sun was there; nothing ever
    // pointed at it. This one does: aimed straight down the solar azimuth
    // (86.5° at 16:15) and pitched up far enough to put the 32.4° disc in the
    // upper third of the frame with the west shop row's roofline still in shot.
    if (!WORLD_SHOTS.some((s) => s.name === 'sun-west')) {
      WORLD_SHOTS.push({
        name: 'sun-west',
        description: 'Eye level in the square looking due west into the afternoon sun above the west shop row',
        position: [30, 11.5, 6], yaw: 86.6, pitch: 20, fov: 72, viewModel: false,
      });
    }
    registerWorldShots(this);
    // Pin the level's own hour on to every level shot. `setShot` only touches
    // the time of day when a shot names one, so in a run that also contains the
    // render module's time-of-day shots every level shot after `render-night`
    // was silently captured at 23:20 — which is exactly how a contact sheet of
    // a golden-hour map comes back reading as blue midnight.
    for (const shot of WORLD_SHOTS) if (shot.hour === undefined) shot.hour = TIME_OF_DAY;

    let triangles = 0;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry?.index) {
        const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
        triangles += (mesh.geometry.index.count / 3) * instances;
      }
    });
    this.buildStats.triangles = Math.round(triangles);

    this.installDebugHandle(ctx);

    console.info(
      `[world] Blackout built in ${(performance.now() - t0).toFixed(0)}ms — `
      + `${(this.buildStats.triangles / 1000).toFixed(0)}k tris, ${this.buildStats.props} props, `
      + `nav ${this.navData?.stats.polys ?? 0} polys / ${this.cover.length} cover / ${this.links.length} links `
      + `(terrain ${this.buildStats.terrainMs.toFixed(0)}ms, buildings ${this.buildStats.buildingsMs.toFixed(0)}ms, `
      + `props ${this.buildStats.propsMs.toFixed(0)}ms, nav ${this.buildStats.navMs.toFixed(0)}ms)`,
    );

    bus.emit('level:loaded', { name: 'blackout' });
  }

  /* ------------------------------------------------------- instrumentation */

  /**
   * Measurement handle for the capture harness, mirroring `__RENDER__`.
   *
   * Two of this level's defining numbers — how much of the ground the sun can
   * actually reach, and how much of the clutter reaches the shadow atlas — are
   * invisible in a screenshot until they are already wrong, and both were
   * shipped wrong for several waves because nothing measured them. They are
   * cheap to compute against data the system already owns, so they are exposed
   * here rather than re-derived by whatever script happens to be auditing.
   *
   * Read-only with respect to the frame loop; `setCulling` is the single
   * exception and exists so an A/B can isolate visibility from shading.
   */
  private installDebugHandle(ctx: EngineContext): void {
    (globalThis as unknown as Record<string, unknown>).__WORLD__ = {
      hour: () => TIME_OF_DAY,
      sunCensus: (arg?: SunCensusOptions) => this.sunCensus(ctx, arg),
      /** Per-point sun visibility — for probing a wall rather than the ground. */
      sunVisible: (pts: [number, number, number][]) => this.sunVisible(ctx, pts),
      propShadowCensus: () => this.propShadowCensus(),
      /**
       * Live override of the sky-probe scale. The level ships `AMBIENT_INTENSITY`
       * and nothing in the frame loop reads this back; it exists so the
       * key-to-fill ratio can be swept in one session instead of one build per
       * value. See the note on `AMBIENT_INTENSITY`.
       */
      setAmbient: (i: number) => {
        const api = this.renderApi as unknown as { setAmbient?: (t: THREE.ColorRepresentation, i: number) => void } | null;
        api?.setAmbient?.(AMBIENT_TINT, i);
      },
      setCulling: (mode: CullMode) => { this.culling.mode = mode; },
      cullStats: () => ({
        mode: this.culling.mode,
        visibleObjects: this.culling.visibleObjects,
        totalObjects: this.culling.totalObjects,
        shadowOnly: this.culling.shadowOnlyObjects,
        visibleCells: this.culling.visibleCells,
      }),
    };
  }

  /**
   * Fraction of the playable ground with an unobstructed line to the sun.
   *
   * A 2 m grid over the play space, one physics ray per sample along the live
   * solar vector. This is the number that says whether the level has a key
   * light at all: a map where 13% of the ground is lit has no readable sun
   * direction no matter how good the shadow filtering is.
   */
  private sunCensus(ctx: EngineContext, o: SunCensusOptions = {}): Record<string, number | number[]> {
    const x0 = o.x0 ?? -34, x1 = o.x1 ?? 34;
    const z0 = o.z0 ?? -34, z1 = o.z1 ?? 46;
    const step = o.step ?? 2;
    const maxDist = o.maxDist ?? 260;

    const phys = ctx.engine.tryGet<System & PhysicsAPI>('physics');
    const api = this.renderApi as unknown as {
      uniforms?: { boSunDirWorld?: { value: THREE.Vector3 } };
    } | null;
    const sun = api?.uniforms?.boSunDirWorld?.value;
    if (!phys || !sun) return { samples: 0, lit: 0, fraction: 0 };

    const dir = this._tmpA.copy(sun).normalize();
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const hit: RayHit = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0,
      surface: 'concrete', object: null, entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
    };
    const mask = LAYER.STATIC | LAYER.DYNAMIC;
    const lift = o.lift ?? 0.1;
    const snap = o.snap ?? true;
    let samples = 0;
    let lit = 0;
    // Outdoor subset: ground under a roof can never see the sun, so it dilutes
    // the metric by a constant no lighting change can move.
    let outdoor = 0, litOutdoor = 0;
    // Occluder distance histogram: near hits are the level's own clutter, far
    // hits are the buildings. The distinction is the whole diagnosis.
    let near = 0, mid = 0, far = 0;
    for (let x = x0; x <= x1 + 1e-6; x += step) {
      for (let z = z0; z <= z1 + 1e-6; z += step) {
        samples++;
        const out = !insideBuilding(x, z, -0.5);
        if (out) outdoor++;
        let y = groundHeightAt(x, z);
        if (snap) {
          // Pavements, interior slabs and terraces sit above the terrain
          // function; start the ray on the surface a player would stand on, not
          // on the height field underneath it.
          origin.set(x, y + 1.6, z);
          if (phys.raycast(origin, down, 3.2, mask, hit).hit) y = origin.y - hit.distance;
        }
        origin.set(x, y + lift, z);
        if (!phys.raycast(origin, dir, maxDist, mask, hit).hit) {
          lit++;
          if (out) litOutdoor++;
          continue;
        }
        if (hit.distance < 1) near++;
        else if (hit.distance < 12) mid++;
        else far++;
      }
    }
    return {
      samples,
      lit,
      fraction: samples ? lit / samples : 0,
      outdoor,
      litOutdoor,
      outdoorFraction: outdoor ? litOutdoor / outdoor : 0,
      blockedNear: near, blockedMid: mid, blockedFar: far,
      elevationDeg: (Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * 180) / Math.PI,
      sunDir: [dir.x, dir.y, dir.z],
      hours: TIME_OF_DAY,
    };
  }

  /** True for each point with a clear line to the sun. */
  private sunVisible(ctx: EngineContext, pts: [number, number, number][]): boolean[] {
    const phys = ctx.engine.tryGet<System & PhysicsAPI>('physics');
    const api = this.renderApi as unknown as {
      uniforms?: { boSunDirWorld?: { value: THREE.Vector3 } };
    } | null;
    const sun = api?.uniforms?.boSunDirWorld?.value;
    if (!phys || !sun) return pts.map(() => false);
    const dir = this._tmpA.copy(sun).normalize();
    const origin = new THREE.Vector3();
    const hit: RayHit = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0,
      surface: 'concrete', object: null, entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
    };
    return pts.map((p) => {
      origin.set(p[0], p[1], p[2]).addScaledVector(dir, 0.05);
      return !phys.raycast(origin, dir, 300, LAYER.STATIC | LAYER.DYNAMIC, hit).hit;
    });
  }

  /** Instanced-prop shadow participation, counted per instance and per mesh. */
  private propShadowCensus(): Record<string, number | Record<string, number>> {
    let meshes = 0, castingMeshes = 0, instances = 0, castingInstances = 0;
    let placements = 0, castingPlacements = 0;
    const off: Record<string, number> = {};
    for (const c of this.clusters) {
      placements += c.matrices.length;
      let anyCast = false;
      for (const m of c.meshes) {
        meshes++;
        instances += m.count;
        if (m.castShadow) { castingMeshes++; castingInstances += m.count; anyCast = true; }
        else {
          // `prop:<id>:<matKey>:<bucket>` — bucket dropped so the tally reads per
          // prop/material rather than per district.
          const k = m.name.split(':').slice(1, 3).join(':') || c.id;
          off[k] = (off[k] ?? 0) + m.count;
        }
      }
      if (anyCast) castingPlacements += c.matrices.length;
    }
    return {
      meshes, castingMeshes, instances, castingInstances,
      instanceFraction: instances ? castingInstances / instances : 0,
      placements, castingPlacements,
      placementFraction: placements ? castingPlacements / placements : 0,
      off,
    };
  }

  /* ----------------------------------------------------------- environment */

  private applyEnvironment(ctx: EngineContext): void {
    const render = ctx.engine.tryGet<System & RenderAPI>('render');
    if (!render) return;
    this.renderApi = render;
    render.setTimeOfDay(TIME_OF_DAY);
    // Just enough haze to separate the depth layers. The volumetric density
    // scales steeply off this value, so anything above ~0.06 turns a 60 m
    // sightline into a white wall at eye level. Down from 0.038: a sun this low
    // pushes far more light forward through the haze than a 28° one did, and at
    // the old value the midground of every westward sightline went milky.
    render.setWeather(0, 0.020, 0.4);
    // Sky fill. The number and the reason it cannot yet come down are on
    // `AMBIENT_INTENSITY`.
    const api = render as unknown as { setAmbient?: (tint: THREE.ColorRepresentation, i: number) => void };
    api.setAmbient?.(AMBIENT_TINT, AMBIENT_INTENSITY);
    this.cloth.setWind(0.75);
  }

  /* ---------------------------------------------------------- practicals -- */

  private placePracticals(): void {
    const pos = new THREE.Vector3();
    const local = new THREE.Vector3();
    for (const cluster of this.clusters) {
      let kind: Practical['kind'] | null = null;
      let colour = 0xffffff;
      let intensity = 0;
      let radius = 0;
      switch (cluster.id) {
        case 'streetLamp': local.set(0, 6.0, 1.16); kind = 'sodium'; colour = 0xffb257; intensity = 24; radius = 16; break;
        case 'barrelBurning': local.set(0, 1.0, 0); kind = 'fire'; colour = 0xff8a30; intensity = 14; radius = 9; break;
        case 'kiosk': local.set(0, 2.25, 0.98); kind = 'signage'; colour = 0x8fd4ff; intensity = 5; radius = 6; break;
        case 'trafficLight': local.set(0, 3.36, 0.3); kind = 'signage'; colour = 0xff4a10; intensity = 3; radius = 4.5; break;
        default: break;
      }
      if (!kind) continue;
      for (const m of cluster.matrices) {
        pos.copy(local).applyMatrix4(m);
        this.lights.add({ x: pos.x, y: pos.y, z: pos.z, color: colour, intensity, radius, kind });
      }
    }

    // Authored interior practicals: bare bulbs and failing tubes, dimmer and
    // cooler than the sun outside so stepping inside reads as stepping inside.
    const interior: { x: number; y: number; z: number; kind: Practical['kind']; c: number; i: number; r: number; box: keyof typeof FOOTPRINTS }[] = [
      { x: 38, y: 7.6, z: -26, kind: 'fluoro', c: 0xdff0ff, i: 16, r: 15, box: 'warehouse' },
      { x: 44, y: 7.6, z: -14, kind: 'fluoro', c: 0xdff0ff, i: 14, r: 14, box: 'warehouse' },
      { x: 31, y: 5.2, z: -18, kind: 'bulb', c: 0xffd9a0, i: 8, r: 9, box: 'warehouse' },
      { x: 0, y: 4.2, z: -47, kind: 'bulb', c: 0xffcf90, i: 12, r: 14, box: 'townHall' },
      { x: -10, y: 4.2, z: -50, kind: 'bulb', c: 0xffcf90, i: 8, r: 10, box: 'townHall' },
      { x: -43, y: 2.9, z: -48, kind: 'bulb', c: 0xffd0a0, i: 7, r: 8, box: 'terraceN' },
      { x: -43, y: 2.9, z: -14, kind: 'fluoro', c: 0xe6f2ff, i: 6, r: 8, box: 'terraceS' },
      { x: -20.5, y: 3.4, z: -22, kind: 'bulb', c: 0xffd0a0, i: 6, r: 8, box: 'shopsW' },
      { x: 20.5, y: 3.4, z: 6, kind: 'bulb', c: 0xffd0a0, i: 6, r: 8, box: 'shopsE2' },
      { x: 40, y: 3.2, z: 16, kind: 'fluoro', c: 0xe6f2ff, i: 7, r: 9, box: 'offices' },
      { x: -1, y: 4.0, z: 45, kind: 'bulb', c: 0xffd0a0, i: 7, r: 9, box: 'apartmentS' },
      { x: -44, y: 2.9, z: 5, kind: 'bulb', c: 0xffc890, i: 7, r: 8, box: 'cafe' },
      { x: 36, y: 3.0, z: -47, kind: 'fluoro', c: 0xdff0ff, i: 6, r: 9, box: 'clinic' },
      // Upper floors of the shop rows. Every blown-out opening on those two
      // facades was a hole cut into pure black from outside; a single weak
      // practical two metres behind it turns the void into a readable room and
      // gives the opening an edge to catch light on.
      { x: -20.5, y: 6.4, z: -26, kind: 'bulb', c: 0xffcf95, i: 5, r: 7, box: 'shopsW' },
      { x: -20.5, y: 6.4, z: 8, kind: 'bulb', c: 0xffcf95, i: 5, r: 7, box: 'shopsW2' },
      { x: 20.5, y: 6.4, z: -24, kind: 'bulb', c: 0xffc98c, i: 5, r: 7, box: 'shopsE' },
      { x: 20.5, y: 6.4, z: 10, kind: 'bulb', c: 0xffc98c, i: 5, r: 7, box: 'shopsE2' },
      { x: -43, y: 6.2, z: -30, kind: 'bulb', c: 0xffd0a0, i: 5, r: 7, box: 'terraceM' },
      { x: 0, y: 7.4, z: -50, kind: 'bulb', c: 0xffcf90, i: 6, r: 9, box: 'townHall' },
    ];
    for (const p of interior) {
      const f = FOOTPRINTS[p.box];
      this.lights.add({
        x: p.x, y: p.y, z: p.z, color: p.c, intensity: p.i, radius: p.r, kind: p.kind,
        interiorOf: f ? { x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1 } : undefined,
      });
    }
  }

  /* ---------------------------------------------------------- navigation -- */

  private buildNavigation(): void {
    const cfg = {
      ...DEFAULT_NAV_CONFIG,
      minX: -MAP.half - 1, maxX: MAP.half + 1,
      minZ: -MAP.half - 1, maxZ: MAP.half + 1,
    };
    const hf = new SolidHeightfield(cfg);
    const ras = new Rasteriser(hf);
    rasteriseScene(this.root, ras);
    // Instanced props are excluded from the scene walk (they are marked
    // navIgnore) and fed here from their cluster matrices instead, which lets
    // decorative clutter be skipped without touching the render path.
    this.rasteriseProps(ras);

    const field = new CompactField(hf);
    const data = buildNavMesh(field);
    this.navData = data;
    this.nav = new NavQuery(data);
    this.cover = data.cover;
    this.links = data.links;
  }

  private rasteriseProps(ras: Rasteriser): void {
    const box = new THREE.Box3();
    const corners: THREE.Vector3[] = [];
    for (let k = 0; k < 8; k++) corners.push(new THREE.Vector3());
    for (const cluster of this.clusters) {
      if (cluster.def.navIgnore || cluster.def.collide === 'none') continue;
      const mesh = cluster.meshes[0];
      if (!mesh) continue;
      // Union of every material part's local bounds, so the blocker matches the
      // prop rather than one of its materials.
      box.makeEmpty();
      for (const m of cluster.meshes) {
        m.geometry.computeBoundingBox();
        if (m.geometry.boundingBox) box.union(m.geometry.boundingBox);
      }
      if (box.isEmpty()) continue;
      for (const matrix of cluster.matrices) {
        for (let k = 0; k < 8; k++) {
          corners[k].set(
            k & 1 ? box.max.x : box.min.x,
            k & 4 ? box.max.y : box.min.y,
            k & 2 ? box.max.z : box.min.z,
          ).applyMatrix4(matrix);
        }
        emitBox(ras, corners);
      }
    }
  }

  /* ------------------------------------------------------------ nav API -- */

  /** Straightened path between two world points. Reuses an internal buffer. */
  findPath(from: THREE.Vector3, to: THREE.Vector3, out?: PathResult): PathResult {
    if (!this.nav) {
      const r = out ?? this._pathScratch;
      r.points.length = 0; r.corridor.length = 0; r.complete = false; r.length = 0;
      return r;
    }
    return this.nav.findPath(from, to, out ?? this._pathScratch);
  }

  nearestPoly(p: THREE.Vector3, maxRadius = 6): number {
    return this.nav ? this.nav.nearestPoly(p, maxRadius) : -1;
  }

  /** Snaps a point on to the navmesh; returns false when it is off-mesh. */
  snapToNav(p: THREE.Vector3, out: THREE.Vector3, maxRadius = 4): boolean {
    return this.nav ? this.nav.snap(p, out, maxRadius) : false;
  }

  /** Navigable floor height under a point, or NaN. */
  floorAt(x: number, y: number, z: number): number {
    return this.nav ? this.nav.floorAt(x, y, z) : NaN;
  }

  /** Ranked cover positions near `pos`, optionally relative to a threat. */
  coverNear(pos: THREE.Vector3, query: CoverQuery = {}): ScoredCover[] {
    return this.nav ? this.nav.coverNear(pos, query) : [];
  }

  /** True when an agent can walk in a straight line from `a` to `b`. */
  raycastNav(a: THREE.Vector3, b: THREE.Vector3, hit?: THREE.Vector3): boolean {
    return this.nav ? this.nav.raycastNav(a, b, hit) : false;
  }

  /** A spawn point for a team, chosen away from `avoid` when given. */
  spawnFor(team: SpawnPoint['team'], avoid?: THREE.Vector3): SpawnPoint | null {
    let best: SpawnPoint | null = null;
    let bestScore = -Infinity;
    for (const s of this.spawns) {
      if (s.team !== team && s.team !== 'neutral') continue;
      const score = avoid ? s.position.distanceTo(avoid) : 1;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /* -------------------------------------------------------------- runtime */

  update(dt: number, _ctx: EngineContext): void {
    this.cloth.update(dt);
  }

  lateUpdate(dt: number, ctx: EngineContext): void {
    this.lights.update(dt, ctx.camera);
    this.culling.update(ctx.camera);
    this.syncSunProxy();
  }

  /** Keeps the volumetric pass's notion of the sun in step with the sky. */
  private syncSunProxy(): void {
    const api = this.renderApi as unknown as {
      uniforms?: { boSunDirWorld?: { value: THREE.Vector3 } };
      sky?: { sunIlluminance?: THREE.Color };
    } | null;
    const dir = api?.uniforms?.boSunDirWorld?.value;
    const lum = api?.sky?.sunIlluminance;
    if (!dir || !lum) return;
    this.sunProxy.position.copy(dir).multiplyScalar(140);
    this.sunProxy.target.position.set(0, 0, 0);
    this.sunProxy.target.updateMatrixWorld();
    const peak = Math.max(lum.r, lum.g, lum.b);
    if (peak > 1e-5) {
      this.sunProxy.color.setRGB(lum.r / peak, lum.g / peak, lum.b / peak);
    }
    // Scaled well below the sun's own illuminance: without a shadow map the
    // scattering is unshadowed, so anything stronger reads as flat haze rather
    // than as shafts.
    this.sunProxy.intensity = peak * 0.055 * settings.gfx.fogDensity;
  }

  /** Level statistics, surfaced through the capture probe hook. */
  stats(): Record<string, number> {
    return {
      triangles: this.buildStats.triangles,
      props: this.buildStats.props,
      navPolys: this.navData?.stats.polys ?? 0,
      navCells: this.navData?.stats.cells ?? 0,
      navRegions: this.navData?.stats.regions ?? 0,
      cover: this.cover.length,
      links: this.links.length,
      visibleObjects: this.culling.visibleObjects,
      totalObjects: this.culling.totalObjects,
      activeLights: this.lights.activeCount,
      buildMs: this.buildStats.terrainMs + this.buildStats.buildingsMs + this.buildStats.propsMs + this.buildStats.navMs,
      navMs: this.buildStats.navMs,
    };
  }

  /** Toggles the navmesh overlay. */
  setNavDebug(on: boolean): void {
    if (on && !this.navDebug && this.navData) {
      this.navDebug = navDebugMesh(this.navData);
      this.navDebug.userData.physicsSkipSubtree = true;
      this.root.add(this.navDebug);
    }
    if (this.navDebug) this.navDebug.visible = on;
  }

  /* ------------------------------------------------------------- capture -- */

  captureShots(): ShotDef[] {
    void this._tmpA;
    return WORLD_SHOTS;
  }

  dispose(): void {
    this.cloth.dispose();
    this.lights.dispose();
    this.culling.clear();
    this.cat?.dispose();
  }
}

/* ---------------------------------------------------------------- helpers */

const BOX_FACES: [number, number, number][] = [
  [0, 1, 2], [1, 3, 2],
  [4, 6, 5], [5, 6, 7],
  [0, 1, 4], [1, 5, 4],
  [2, 6, 3], [3, 6, 7],
  [0, 4, 2], [2, 4, 6],
  [1, 3, 5], [3, 7, 5],
];

function emitBox(ras: Rasteriser, c: THREE.Vector3[]): void {
  for (const [a, b, d] of BOX_FACES) {
    ras.triangle(c[a].x, c[a].y, c[a].z, c[b].x, c[b].y, c[b].z, c[d].x, c[d].y, c[d].z);
  }
}
