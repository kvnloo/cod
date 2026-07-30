/**
 * `?debug=fx` — the effects test bed.
 *
 * A deliberately neutral stage: mid-grey ground, a long back wall carrying one
 * panel of every surface family the impact system keys off, a dirt patch, a
 * water pool, crates and pipes for foreground silhouette, a colonnade of
 * window slots that throw light shafts, and a receding skyline so every shot
 * has depth behind the effect.
 *
 * Each registered shot stages exactly one effect and captures it at the frame
 * where it reads best. The harness runs `setup()` and then settles 24 frames at
 * 1/60, so an effect that wants to be N seconds old either fires immediately
 * and the scene is stepped forward, or is scheduled to fire part-way through
 * the settle — which is what `stage()` below arranges.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { EngineContext } from '../core/Engine';
import { registerDebugScene, registerShots } from '../core/Shots';
import { bus } from '../core/EventBus';
import { tagSurface, type SurfaceType } from '../core/Surfaces';
import type { FXSystem } from './FX';

/* ------------------------------------------------- procedural surfaces -- */

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

class Noise {
  private perm: Uint8Array;
  constructor(seed: string) {
    const rand = new Rand(seed);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rand.int(0, i);
      const t = base[i]; base[i] = base[j]; base[j] = t;
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    this.perm = p;
  }
  private g(x: number, y: number): number {
    return this.perm[(this.perm[x & 255] + (y & 255)) & 255] / 255;
  }
  value(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = fade(x - ix), fy = fade(y - iy);
    const a = this.g(ix, iy), b = this.g(ix + 1, iy);
    const c = this.g(ix, iy + 1), d = this.g(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  fbm(x: number, y: number, oct: number): number {
    let amp = 0.5, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.value(x, y);
      norm += amp;
      x *= 2.03; y *= 2.01; amp *= 0.5;
    }
    return sum / norm;
  }
}

interface SurfaceSpec {
  base: [number, number, number];
  variation: number;
  scale: number;
  roughLow: number;
  roughHigh: number;
  metal?: number;
  bump?: number;
  streaks?: number;
}

function makeMaterial(
  seed: string, spec: SurfaceSpec, repeat: number | [number, number], size = 256,
): THREE.MeshStandardMaterial {
  const n1 = new Noise(`${seed}:a`);
  const n2 = new Noise(`${seed}:b`);
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * spec.scale;
      const v = (y / size) * spec.scale;
      const macro = n1.fbm(u, v, 3);
      const micro = n2.fbm(u * 4.7, v * 4.7, 5);
      const grime = Math.pow(n1.fbm(u * 2.2 + 13, v * 2.2 + 5, 5), 2.2);
      // Gravity streaking: grime runs downward, which is what makes a wall
      // read as weathered rather than noisy.
      const streak = spec.streaks
        ? Math.pow(n2.fbm(u * 0.9 + 31, v * 9.0, 4), 2.0) * spec.streaks
        : 0;
      let k = 1 - spec.variation * 0.5 + spec.variation * (macro * 0.4 + micro * 0.6);
      k *= 1 - grime * 0.3 - streak * 0.35;
      albedo[i * 4] = Math.min(255, Math.max(0, spec.base[0] * 255 * k));
      albedo[i * 4 + 1] = Math.min(255, Math.max(0, spec.base[1] * 255 * k));
      albedo[i * 4 + 2] = Math.min(255, Math.max(0, spec.base[2] * 255 * k));
      albedo[i * 4 + 3] = 255;
      height[i] = micro * 0.7 + macro * 0.3 - grime * 0.25;
      const rough = spec.roughLow + (spec.roughHigh - spec.roughLow) * (0.3 + 0.7 * micro) * (1 - grime * 0.2);
      const ao = 1 - grime * 0.4 - (1 - micro) * 0.1;
      orm[i * 4] = Math.min(255, Math.max(0, ao * 255));
      orm[i * 4 + 1] = Math.min(255, Math.max(0, rough * 255));
      orm[i * 4 + 2] = Math.min(255, Math.max(0, (spec.metal ?? 0) * 255));
      orm[i * 4 + 3] = 255;
    }
  }

  const strength = (spec.bump ?? 1) * 3.0;
  const normal = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const d = height[((y - 1 + size) % size) * size + x];
      const uu = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (d - uu) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv; ny *= inv;
      normal[i * 4] = (nx * 0.5 + 0.5) * 255;
      normal[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i * 4 + 2] = (inv * 0.5 + 0.5) * 255;
      normal[i * 4 + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    if (Array.isArray(repeat)) t.repeat.set(repeat[0], repeat[1]);
    else t.repeat.set(repeat, repeat);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const orm2 = mk(orm, false);
  return new THREE.MeshStandardMaterial({
    map: mk(albedo, true),
    normalMap: mk(normal, false),
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: orm2,
    metalnessMap: orm2,
    aoMap: orm2,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 1,
  });
}

/* --------------------------------------------------------------- staging -- */

let engineRef: EngineContext['engine'] | null = null;
let fxRef: FXSystem | null = null;

/** Frames the capture harness settles after `setup()` returns. */
const SETTLE = 24 / 60;

/**
 * Returns a shot `setup` that clears every effect, fires `spawn`, and arranges
 * for the captured frame to see the effect exactly `age` seconds old.
 */
function stage(age: number, spawn: () => void, prepare?: () => void): () => void {
  return () => {
    const fx = fxRef;
    if (!fx) return;
    fx.reset();
    prepare?.();
    if (age >= SETTLE) {
      spawn();
      const extra = Math.round((age - SETTLE) * 60);
      for (let i = 0; i < extra; i++) engineRef?.stepFrame(1 / 60);
    } else {
      fx.after(SETTLE - age, spawn);
    }
  };
}

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function impact(
  point: THREE.Vector3, normal: THREE.Vector3, surface: SurfaceType,
  energy = 1600, incoming?: THREE.Vector3,
): void {
  bus.emit('bullet:impact', {
    point, normal, surface, energy, penetrated: false,
    incoming: incoming ?? normal.clone().negate(),
  });
}

/** A short burst of fire from `origin` toward `dir`, spaced like a real rifle. */
function burst(
  origin: THREE.Vector3, dir: THREE.Vector3, rounds: number,
  suppressed = false, weapon = 'ar_test', spacing = 0.083, firstIndex = 0,
): void {
  const fx = fxRef;
  if (!fx) return;
  for (let i = 0; i < rounds; i++) {
    const delay = (rounds - 1 - i) * spacing;
    const shot = firstIndex + i;
    if (delay <= 0.0001) {
      bus.emit('weapon:fire', { weaponId: weapon, origin, direction: dir, shotIndex: shot, suppressed });
    } else {
      fx.after(SETTLE - delay, () => {
        bus.emit('weapon:fire', { weaponId: weapon, origin, direction: dir, shotIndex: shot, suppressed });
      });
    }
  }
}

/* ----------------------------------------------------------------- scene -- */

export function registerFxDebugScene(fx: FXSystem): void {
  fxRef = fx;

  registerDebugScene('fx', (ctx: EngineContext) => {
    engineRef = ctx.engine;
    const scene = ctx.scene;

    for (const name of ['player', 'ai', 'director', 'weapons']) {
      const sys = ctx.engine.tryGet(name);
      if (sys) sys.enabled = false;
    }
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c.name === 'world') scene.remove(c);
      const l = c as THREE.Light;
      if (l.isLight && !c.name.startsWith('dyn')) scene.remove(c);
    }

    const root = new THREE.Group();
    root.name = 'fx-debug';
    scene.add(root);

    const rand = new Rand('fx:debug');

    const concrete = makeMaterial('fx:concrete', {
      base: [0.52, 0.508, 0.482], variation: 0.13, scale: 3.0,
      roughLow: 0.62, roughHigh: 0.96, bump: 1.0,
    }, [11, 2.2]);
    const ground = makeMaterial('fx:ground', {
      base: [0.28, 0.272, 0.256], variation: 0.20, scale: 5,
      roughLow: 0.7, roughHigh: 0.99, bump: 1.3,
    }, 220);
    const steel = makeMaterial('fx:steel', {
      base: [0.58, 0.59, 0.61], variation: 0.26, scale: 9,
      roughLow: 0.20, roughHigh: 0.55, metal: 0.95, bump: 0.5,
    }, [3, 2.4]);
    const timber = makeMaterial('fx:timber', {
      base: [0.36, 0.255, 0.15], variation: 0.55, scale: 4,
      roughLow: 0.55, roughHigh: 0.9, bump: 1.1,
    }, [3, 2.4]);
    const soil = makeMaterial('fx:soil', {
      base: [0.24, 0.19, 0.13], variation: 0.6, scale: 7,
      roughLow: 0.8, roughHigh: 1.0, bump: 1.5,
    }, 6);
    const canvasMat = makeMaterial('fx:canvas', {
      base: [0.42, 0.39, 0.30], variation: 0.4, scale: 10,
      roughLow: 0.85, roughHigh: 1.0, bump: 1.0,
    }, [4, 3.2]);

    // --- ground ---------------------------------------------------------
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), ground);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    tagSurface(floor, 'concrete');
    root.add(floor);

    // --- back wall ------------------------------------------------------
    const wall = new THREE.Mesh(new THREE.BoxGeometry(34, 6.5, 0.6), concrete);
    wall.position.set(-2, 3.25, -7.3);
    wall.castShadow = true;
    wall.receiveShadow = true;
    tagSurface(wall, 'concrete');
    root.add(wall);

    // A lip along the top so the wall throws a shadow onto itself.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(34.5, 0.35, 1.1), concrete);
    lip.position.set(-2, 6.6, -7.3);
    lip.castShadow = true;
    lip.receiveShadow = true;
    root.add(lip);

    // --- surface panels -------------------------------------------------
    const panel = (x: number, mat: THREE.Material, s: SurfaceType, w = 3.2, h = 2.6): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.16), mat);
      m.position.set(x, 1.7, -6.92);
      m.castShadow = true;
      m.receiveShadow = true;
      tagSurface(m, s);
      root.add(m);
      // A simple frame gives the panel an edge that catches the light.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, h + 0.18, 0.10), steel);
      frame.position.set(x, 1.7, -6.99);
      frame.castShadow = true;
      frame.receiveShadow = true;
      root.add(frame);
    };
    panel(-8, steel, 'metal');
    panel(0, timber, 'wood');
    panel(8, canvasMat, 'sandbag');

    // Glass pane: thin, transmissive-looking, in its own frame.
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 2.6, 0.05),
      new THREE.MeshStandardMaterial({
        color: 0x9fb6bf, roughness: 0.06, metalness: 0.0,
        transparent: true, opacity: 0.30, envMapIntensity: 2.0,
      }),
    );
    glass.position.set(4, 1.7, -6.9);
    glass.receiveShadow = false;
    tagSurface(glass, 'glass');
    glass.layers.set(4);
    root.add(glass);
    const glassFrame = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.8, 0.10), steel);
    glassFrame.position.set(4, 1.7, -6.99);
    glassFrame.castShadow = true;
    root.add(glassFrame);

    // --- dirt patch -----------------------------------------------------
    const dirt = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.3, 0.20, 26), soil);
    dirt.position.set(-14, 0.11, 0);
    dirt.receiveShadow = true;
    dirt.castShadow = true;
    tagSurface(dirt, 'dirt');
    root.add(dirt);

    // --- water pool -----------------------------------------------------
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshStandardMaterial({
        color: 0x16232a, roughness: 0.035, metalness: 0.1, envMapIntensity: 1.6,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(12, 0.03, 1);
    water.receiveShadow = true;
    tagSurface(water, 'water');
    root.add(water);
    // A shallow kerb so the pool sits in something.
    for (let i = 0; i < 4; i++) {
      const horiz = i < 2;
      const kerb = new THREE.Mesh(
        new THREE.BoxGeometry(horiz ? 9.6 : 0.3, 0.22, horiz ? 0.3 : 9.6), concrete,
      );
      kerb.position.set(
        12 + (horiz ? 0 : (i === 2 ? -4.65 : 4.65)),
        0.11,
        1 + (horiz ? (i === 0 ? -4.65 : 4.65) : 0),
      );
      kerb.castShadow = true;
      kerb.receiveShadow = true;
      root.add(kerb);
    }

    // --- crates, barrels, pipes: foreground silhouette ------------------
    for (let i = 0; i < 12; i++) {
      const s = rand.range(0.55, 1.05);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s * rand.range(0.7, 1.1), s), timber);
      const a = rand.range(-2.4, 2.4);
      crate.position.set(
        -6 + a * 3.6 + rand.range(-2, 2),
        (crate.geometry.parameters.height as number) / 2,
        rand.range(-5.5, 6),
      );
      crate.rotation.y = rand.range(0, Math.PI);
      crate.castShadow = true;
      crate.receiveShadow = true;
      tagSurface(crate, 'crate');
      root.add(crate);
    }
    for (let i = 0; i < 5; i++) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 14), steel);
      pipe.position.set(-13 + i * 1.1, 1.7, -6.4);
      pipe.castShadow = true;
      pipe.receiveShadow = true;
      tagSurface(pipe, 'pipe');
      root.add(pipe);
    }

    // --- a torso stand-in so flesh hits have something to sit on --------
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.24, 0.62, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0x39402f, roughness: 0.85, metalness: 0 }),
    );
    torso.position.set(2, 1.35, -1.2);
    torso.castShadow = true;
    torso.receiveShadow = true;
    tagSurface(torso, 'flesh');
    root.add(torso);

    // --- colonnade with window slots for the light shafts ---------------
    const colonnadeX = -22;
    for (let i = 0; i < 5; i++) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7, 1.2), concrete);
      pier.position.set(colonnadeX, 3.5, -8 + i * 5);
      pier.castShadow = true;
      pier.receiveShadow = true;
      root.add(pier);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 22), concrete);
    lintel.position.set(colonnadeX, 7.4, 2);
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    root.add(lintel);

    // --- receding skyline: depth behind every sightline -----------------
    const distant = makeMaterial('fx:distant', {
      base: [0.45, 0.44, 0.42], variation: 0.14, scale: 3.0,
      roughLow: 0.7, roughHigh: 0.95, bump: 0.7,
    }, [4, 6]);
    for (let i = 0; i < 46; i++) {
      const t = rand.next();
      const h = 5 + rand.range(0, 10) + t * 20;
      const wdt = 5 + rand.range(0, 10);
      const b = new THREE.Mesh(new THREE.BoxGeometry(wdt, h, wdt * rand.range(0.7, 1.4)), distant);
      const a = rand.range(0, Math.PI * 2);
      const dd = 60 + t * 240 + rand.range(0, 40);
      b.position.set(Math.cos(a) * dd, h / 2, Math.sin(a) * dd);
      b.rotation.y = rand.range(0, Math.PI);
      b.castShadow = true;
      b.receiveShadow = true;
      tagSurface(b, 'concrete');
      root.add(b);
    }

    // --- environment defaults -------------------------------------------
    fx.defaultGroundY = 0;
    fx.environment.dust = 0.7;
    fx.environment.litter = 0.2;
    fx.environment.fog = 0;
    fx.environment.rain = 0;

    const render = ctx.engine.tryGet('render') as unknown as {
      setTimeOfDay?(h: number): void;
      setWeather?(r: number, f: number, w: number): void;
      setAmbient?(tint: number, i: number): void;
      sky?: { groundAlbedo?: THREE.Color };
    } | undefined;
    render?.sky?.groundAlbedo?.setRGB(0.27, 0.265, 0.25);
    render?.setAmbient?.(0xffffff, 1);
    render?.setTimeOfDay?.(15.2);
    render?.setWeather?.(0, 0.0, 0.3);

    // Light shafts raking through the colonnade. The sun sits to the south
    // (+Z) so a shaft heading +X and −Z lands on the open ground.
    const shaftDir = new THREE.Vector3(1, -0.55, -0.32).normalize();
    for (let i = 0; i < 4; i++) {
      fx.addLightShaft(
        V(colonnadeX + 0.6, 5.4, -5.5 + i * 5),
        shaftDir,
        V(0, 1, 0),
        {
          width: 3.4, height: 2.4, length: 20,
          color: 0xffeccc, intensity: 0.055, falloff: 1.5, dust: 0.9,
        },
      );
    }
  });

  /* ------------------------------------------------------------- shots -- */

  const HOUR = 15.2;

  registerShots([
    {
      name: 'fx-impact-concrete',
      description: 'Concrete impact: pale dust puff, hanging plume and a scatter of chips off a sunlit wall',
      position: [-9.5, 2.4, -1.5], yaw: 35, pitch: -5, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.34, () => impact(V(-13.4, 1.85, -6.98), V(0, 0, 1), 'concrete')),
    },
    {
      name: 'fx-impact-metal',
      description: 'Steel impact: shower of cooling sparks with hot glow ribbons and a ricochet arc',
      position: [-4.2, 2.3, -2.0], yaw: 38, pitch: -5, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.13, () => impact(V(-8, 1.8, -6.83), V(0, 0, 1), 'metal')),
    },
    {
      name: 'fx-impact-wood',
      description: 'Wood impact: pale splinters tumbling out of the board with a puff of sawdust',
      position: [3.6, 2.2, -2.2], yaw: 38, pitch: -4, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.26, () => impact(V(0, 1.8, -6.83), V(0, 0, 1), 'wood')),
    },
    {
      name: 'fx-impact-glass',
      description: 'Glass impact: shards thrown through the pane, fragments falling out of the hole',
      position: [7.6, 2.2, -2.4], yaw: 39, pitch: -4, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.30, () => impact(V(4, 1.8, -6.88), V(0, 0, 1), 'glass')),
    },
    {
      name: 'fx-impact-dirt',
      description: 'Dirt impact: heavy clods and a rising column of earth-coloured dust',
      position: [-11.9, 1.55, 2.6], yaw: 37, pitch: -19, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.40, () => impact(V(-14, 0.22, 0), V(0, 1, 0), 'dirt')),
    },
    {
      name: 'fx-impact-water',
      description: 'Water impact: crown of droplets and two expanding rings on the surface',
      position: [14.3, 1.35, 3.9], yaw: 40, pitch: -18, fov: 48, hour: HOUR, viewModel: false,
      setup: stage(0.22, () => impact(V(12, 0.04, 1), V(0, 1, 0), 'water')),
    },
    {
      name: 'fx-impact-flesh',
      description: 'Flesh impact: fine red mist and droplets spraying back toward the shooter',
      position: [4.6, 1.75, 2.4], yaw: 37, pitch: -3, fov: 45, hour: HOUR, viewModel: false,
      setup: stage(0.17, () => impact(V(2, 1.5, -1.0), V(0, 0, 1), 'flesh', 1500, V(0, -0.05, -1))),
    },
    {
      name: 'fx-muzzle',
      description: 'Rifle muzzle flash: core, star, gas cone, smoke ring and the light it throws',
      position: [-2.4, 1.55, 0.9], yaw: -46, pitch: -3, fov: 42, hour: HOUR, viewModel: false,
      setup: stage(0.012, () => burst(V(0, 1.5, -1.0), V(0, 0.02, -1).normalize(), 4)),
    },
    {
      name: 'fx-muzzle-suppressed',
      description: 'Suppressed muzzle: small dim core and a gassy exhale instead of a flash',
      position: [-2.4, 1.55, 0.9], yaw: -46, pitch: -3, fov: 42, hour: HOUR, viewModel: false,
      setup: stage(0.03, () => burst(V(0, 1.5, -1.0), V(0, 0.02, -1).normalize(), 4, true)),
    },
    {
      name: 'fx-tracers',
      description: 'Tracer rounds receding down the firing line with velocity-correct length and glowing heads',
      position: [17.0, 1.76, 2.7], yaw: 88, pitch: -1, fov: 52, hour: HOUR, viewModel: false,
      setup: stage(0.02, () => {
        // Every round is a tracer and they are 30 ms apart, so four of them sit
        // evenly down the firing line at capture instead of one blur.
        const dir = V(-1, 0.003, -0.028).normalize();
        burst(V(15.5, 1.62, 2.1), dir, 4, false, 'ar_test', 0.03, 0);
      }),
    },
    {
      name: 'fx-casings',
      description: 'Ejected brass in flight and settled on the deck after a burst',
      position: [2.90, 1.15, 0.15], yaw: 57, pitch: -4, fov: 40, hour: HOUR, viewModel: false,
      setup: stage(0.42, () => burst(V(0, 1.45, -1.0), V(0, 0.02, -1).normalize(), 6)),
    },
    {
      name: 'fx-explosion-fireball',
      description: 'Grenade at 170 ms: displaced fireball, shockwave ring, embers and thrown debris',
      position: [2.5, 2.4, 14.0], yaw: 12, pitch: -2, fov: 55, hour: HOUR, viewModel: false,
      setup: stage(0.17, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
    },
    {
      name: 'fx-explosion-smoke',
      description: 'The same detonation at 1.7 s: buoyant smoke column leaning into the wind over the dust wave',
      position: [4.0, 3.0, 17.0], yaw: 15, pitch: 4, fov: 60, hour: HOUR, viewModel: false,
      setup: stage(1.7, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
    },
    {
      name: 'fx-smoke-grenade',
      description: 'Smoke screen at 5 s: a lit volume with a bright and a dark side that genuinely blocks the wall behind it',
      position: [1.0, 1.70, 13.0], yaw: 5, pitch: 1, fov: 60, hour: HOUR, viewModel: false,
      setup: stage(5.0, () => bus.emit('explosion', { point: V(0, 0.4, 2.0), radius: 5, power: 1, kind: 'smoke' })),
    },
    {
      name: 'fx-flashbang',
      description: 'Flashbang bloom coordinated with the renderer screen white-out',
      position: [3.0, 1.70, 15.0], yaw: 11, pitch: -2, fov: 58, hour: HOUR, viewModel: false,
      setup: stage(0.28, () => bus.emit('explosion', { point: V(0, 1.2, 2.0), radius: 4, power: 1, kind: 'flashbang' })),
    },
    {
      name: 'fx-lightshafts',
      description: 'Volumetric shafts through the colonnade with dust motes drifting in the beams',
      position: [-12.0, 2.0, 8.0], yaw: 39, pitch: 5, fov: 65, hour: HOUR, viewModel: false,
      setup: stage(4.0, () => { /* ambient dust only */ }, () => {
        if (fxRef) { fxRef.environment.dust = 1.0; fxRef.environment.litter = 0.35; }
      }),
    },
    {
      name: 'fx-rain',
      description: 'Rain: stretched streaks, splash rings on the deck and a wet, low-contrast sky',
      position: [4.0, 1.70, 8.0], yaw: 22, pitch: -3, fov: 62, hour: 16.5, viewModel: false,
      setup: stage(2.4, () => { /* steady state */ }, () => {
        fxRef?.setWeather(0.75, 0.35, 0.5);
      }),
    },
    {
      name: 'fx-fire',
      description: 'Burning wreck: flame tongues, rising embers, oily smoke column and flickering light',
      position: [-3.5, 1.70, 7.0], yaw: 42, pitch: -4, fov: 55, hour: 19.4, viewModel: false,
      setup: stage(3.0, () => { /* steady state */ }, () => {
        fxRef?.addFire(V(-8.5, 0.25, 1.5), 0.8, 1.3);
        fxRef?.addFire(V(-7.4, 0.15, 2.6), 0.45, 0.8);
      }),
    },
    {
      name: 'fx-suppression',
      description: 'Incoming fire: near-miss wall dust, whizz-by streaks and lingering suppression haze',
      position: [-9.6, 1.65, -3.2], yaw: 25, pitch: -1, fov: 68, hour: HOUR, viewModel: false,
      setup: stage(0.75, () => {
        const r = new Rand('fx:suppress');
        for (let i = 0; i < 9; i++) {
          const x = -12 + r.range(-1.4, 2.6);
          const y = 1.1 + r.range(-0.5, 1.4);
          impact(V(x, y, -6.98), V(0, 0, 1), 'concrete', 1500);
        }
        for (let i = 0; i < 4; i++) {
          bus.emit('ai:fire', {
            id: i,
            origin: V(-9.6 + r.range(-1, 1), 1.65, -22),
            direction: V(r.range(-0.02, 0.02), r.range(-0.01, 0.01), 1).normalize(),
          });
        }
      }),
    },
    {
      name: 'fx-hero-smoke',
      description: 'Backlit smoke volume: wrapped lighting, self-shadowing and a bright scattering rim',
      position: [4.0, 1.80, 0.5], yaw: 132, pitch: 2, fov: 55, hour: 16.4, viewModel: false,
      setup: stage(3.2, () => bus.emit('explosion', { point: V(-1.5, 0.4, 5.5), radius: 4.5, power: 1, kind: 'smoke' })),
    },
    {
      name: 'fx-overview',
      description: 'Wide view of the effects stage: panels, pool, colonnade and skyline depth',
      position: [14.0, 7.5, 20.0], yaw: 36, pitch: -12, fov: 62, hour: HOUR, viewModel: false,
      setup: stage(0.4, () => { /* ambient only */ }),
    },
  ]);
}
