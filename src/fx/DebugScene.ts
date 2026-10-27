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

/**
 * Per-mesh material instance.
 *
 * The renderer's velocity buffer keeps the previous-frame model matrix in a
 * uniform on the *material*, and three only re-uploads a material's uniforms
 * when it switches material between draws. Two meshes at different transforms
 * sharing one material therefore both render with whichever prev matrix was
 * uploaded first, and every mesh but that one gets a huge bogus screen-space
 * velocity — which the motion-blur pass smears across the whole stage. Giving
 * each static mesh its own (texture-sharing) clone keeps the test bed sharp.
 */
function own(mat: THREE.Material): THREE.Material {
  return mat.clone();
}

/* --------------------------------------------------------------- staging -- */

let engineRef: EngineContext['engine'] | null = null;
let fxRef: FXSystem | null = null;

/** Frames the capture harness settles after `setup()` returns. */
const SETTLE = 24 / 60;

/** Ambient defaults the stage returns to before every shot. */
const STAGE_DUST = 0.7;
const STAGE_LITTER = 0.35;

/**
 * Returns a shot `setup` that clears every effect, fires `spawn`, and arranges
 * for the captured frame to see the effect exactly `age` seconds old.
 */
function stage(age: number, spawn: () => void, prepare?: () => void): () => void {
  return () => {
    const fx = fxRef;
    if (!fx) return;
    fx.reset();
    // Shafts are level dressing rather than a fired effect, so `reset()` leaves
    // them alone — which means the shot that installs them has to be the shot
    // that takes them away again.
    fx.environment.clearShafts();
    // Ambient state is *not* part of reset(), so without this a shot that turns
    // the dust up leaks that setting into every shot captured after it.
    fx.environment.dust = STAGE_DUST;
    fx.environment.litter = STAGE_LITTER;
    fx.environment.fog = 0;
    fx.environment.rain = 0;
    fx.setWeather(0, 0, 0.3);
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
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Installs a rank of volumetric shafts across the current sightline.
 *
 * Anchored to the shot camera and to the renderer's live sun rather than to any
 * particular piece of level geometry, because the FX shots are captured against
 * whatever level happens to be loaded — the `?debug=fx` colonnade only exists
 * when someone asked for it explicitly. Each beam's "window" is parked upwind of
 * the sightline so the beam crosses in front of the camera on its way down, and
 * the shader ends it on whatever the depth buffer says is there.
 */
function installSunShafts(count = 11): void {
  const fx = fxRef;
  if (!fx) return;
  const cam = fx.camera;
  const travel = fx.sunDirection().negate().normalize();
  // A beam that is not descending has nowhere to land; bail rather than lay a
  // horizontal slab of haze across the whole frame.
  if (travel.y > -0.07) return;

  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const side = new THREE.Vector3().crossVectors(UP, fwd).normalize();

  const rand = new Rand('fx:shafts');
  const groundY = fx.floorUnder(cam.position.x, cam.position.y, cam.position.z);
  // Height of the "window" the beam comes through — a roofline, near enough.
  // Capped in *length*, not in height: as the sun drops the run to a roofline
  // grows without bound, and a sixty-metre box of haze laid across the square
  // is a slab of fog rather than a beam.
  const drop = 8.0;
  const run = Math.min(26, drop / -travel.y);
  for (let i = 0; i < count; i++) {
    // Anchor each beam by where it *lands*, spread down the sightline. A shaft
    // that ends on the ground in front of you reads as a beam; one that floats
    // in mid-air reads as fog.
    const land = cam.position.clone()
      .addScaledVector(fwd, 4.5 + i * 1.9)
      .addScaledVector(side, (i % 2 === 0 ? -1 : 1) * (0.6 + rand.next() * 3.6));
    land.y = groundY;
    const origin = land.clone().addScaledVector(travel, -run);
    fx.addLightShaft(origin, travel, UP, {
      // Narrow and bright beats wide and faint. A two-metre-wide beam at a
      // sixth of the scene's brightness is a smear of glare; a half-metre one
      // at three times that is a shaft of light with an edge you can point at.
      width: 0.34 + rand.next() * 0.42,
      height: 0.42 + rand.next() * 0.5,
      // Stop just past the ground; the depth test trims the rest.
      length: run + 2.5,
      color: 0xffdca2,
      intensity: 0.52,
      // Barely any axial decay: a beam this short is not losing much to
      // extinction, and fading it out mid-air is what makes a shaft read as a
      // smear of glare instead of light landing on the floor.
      falloff: 0.35,
      dust: 0.9,
      followSun: true,
    });
  }
}

function impact(
  point: THREE.Vector3, normal: THREE.Vector3, surface: SurfaceType,
  energy = 1600, incoming?: THREE.Vector3,
): void {
  bus.emit('bullet:impact', {
    point, normal, surface, energy, penetrated: false,
    incoming: incoming ?? normal.clone().negate(),
  });
}

/** A short burst of fire from `origin` toward `dir`, spaced like a real rifle.
 *  Delays are relative to *now* (when burst is invoked). `stage()` either
 *  schedules the whole burst near the end of the settle window or runs it
 *  immediately and steps — never double-apply SETTLE inside the delays. */
function burst(
  origin: THREE.Vector3, dir: THREE.Vector3, rounds: number,
  suppressed = false, weapon = 'ar_test', spacing = 0.083, firstIndex = 0,
): void {
  const fx = fxRef;
  if (!fx) return;
  for (let i = 0; i < rounds; i++) {
    const delay = i * spacing;
    const shot = firstIndex + i;
    const fire = (): void => {
      bus.emit('weapon:fire', { weaponId: weapon, origin, direction: dir, shotIndex: shot, suppressed });
    };
    if (delay <= 0.0001) fire();
    else fx.after(delay, fire);
  }
}

/* ----------------------------------------------------------------- scene -- */

export function registerFxDebugScene(fx: FXSystem, engine: EngineContext['engine']): void {
  fxRef = fx;
  // Every FX shot is registered against whatever level is loaded, so the engine
  // handle `stage()` needs to fast-forward an effect must be available even when
  // the `?debug=fx` test bed was never built. Without it every shot captured at
  // its 24-frame settle instead of the age it was authored for, which is why a
  // five-second smoke screen used to read as a small puff.
  engineRef = engine;

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
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), own(ground));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    tagSurface(floor, 'concrete');
    root.add(floor);

    // --- back wall ------------------------------------------------------
    const wall = new THREE.Mesh(new THREE.BoxGeometry(34, 6.5, 0.6), own(concrete));
    wall.position.set(-2, 3.25, -7.3);
    wall.castShadow = true;
    wall.receiveShadow = true;
    tagSurface(wall, 'concrete');
    root.add(wall);

    // A lip along the top so the wall throws a shadow onto itself.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(34.5, 0.35, 1.1), own(concrete));
    lip.position.set(-2, 6.6, -7.3);
    lip.castShadow = true;
    lip.receiveShadow = true;
    root.add(lip);

    // --- surface panels -------------------------------------------------
    const panel = (x: number, mat: THREE.Material, s: SurfaceType, w = 3.2, h = 2.6): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.16), own(mat));
      m.position.set(x, 1.7, -6.92);
      m.castShadow = true;
      m.receiveShadow = true;
      tagSurface(m, s);
      root.add(m);
      // A simple frame gives the panel an edge that catches the light.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.18, h + 0.18, 0.10), own(steel));
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
    const glassFrame = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.8, 0.10), own(steel));
    glassFrame.position.set(4, 1.7, -6.99);
    glassFrame.castShadow = true;
    root.add(glassFrame);

    // --- dirt patch -----------------------------------------------------
    const dirt = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.3, 0.20, 26), own(soil));
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
        new THREE.BoxGeometry(horiz ? 9.6 : 0.3, 0.22, horiz ? 0.3 : 9.6), own(concrete),
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
      const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s * rand.range(0.7, 1.1), s), own(timber));
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
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 14), own(steel));
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
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7, 1.2), own(concrete));
      pier.position.set(colonnadeX, 3.5, -8 + i * 5);
      pier.castShadow = true;
      pier.receiveShadow = true;
      root.add(pier);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 22), own(concrete));
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
      const b = new THREE.Mesh(new THREE.BoxGeometry(wdt, h, wdt * rand.range(0.7, 1.4)), own(distant));
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
    fx.environment.dust = STAGE_DUST;
    fx.environment.litter = STAGE_LITTER;
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

    // Shafts are installed per-shot (see `installSunShafts`), so they follow the
    // camera and the sun instead of being nailed to this one colonnade.
  });

  /* ------------------------------------------------------------- shots -- */

  const HOUR = 15.2;

  registerShots([
    {
      name: 'fx-impact-concrete',
      description: 'Concrete impact: pale dust puff, hanging plume and a scatter of chips off a sunlit wall',
      position: [-9.5, 2.4, -1.5], yaw: 35, pitch: -5, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.16, () => impact(V(-13.4, 1.85, -6.98), V(0, 0, 1), 'concrete')),
    },
    {
      name: 'fx-impact-metal',
      description: 'Steel impact: shower of cooling sparks with hot glow ribbons and a ricochet arc',
      position: [-4.2, 2.3, -2.0], yaw: 38, pitch: -5, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.10, () => impact(V(-8, 1.8, -6.83), V(0, 0, 1), 'metal')),
    },
    {
      name: 'fx-sparks',
      description: 'Steel hits at 450 ms: sparks arcing under gravity, skipping off the deck and cooling to red',
      position: [-4.6, 1.15, -2.6], yaw: 26, pitch: -8, fov: 46, hour: HOUR, viewModel: false,
      setup: stage(0.45, () => {
        const r = new Rand('fx:sparks');
        for (let i = 0; i < 3; i++) {
          impact(V(-8, 1.15 + r.range(-0.3, 0.5), -6.83), V(0, 0, 1), 'metal', 1800);
        }
      }),
    },
    {
      name: 'fx-impact-wood',
      description: 'Wood impact: pale splinters tumbling out of the board with a puff of sawdust',
      position: [3.6, 2.2, -2.2], yaw: 38, pitch: -4, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.14, () => impact(V(0, 1.8, -6.83), V(0, 0, 1), 'wood')),
    },
    {
      name: 'fx-impact-glass',
      description: 'Glass impact: shards thrown through the pane, fragments falling out of the hole',
      position: [7.6, 2.2, -2.4], yaw: 39, pitch: -4, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.14, () => impact(V(4, 1.8, -6.88), V(0, 0, 1), 'glass')),
    },
    {
      name: 'fx-impact-dirt',
      description: 'Dirt impact: heavy clods and a rising column of earth-coloured dust',
      position: [-11.9, 1.55, 2.6], yaw: 37, pitch: -19, fov: 50, hour: HOUR, viewModel: false,
      setup: stage(0.18, () => impact(V(-14, 0.22, 0), V(0, 1, 0), 'dirt')),
    },
    {
      name: 'fx-impact-water',
      description: 'Water impact: crown of droplets and two expanding rings on the surface',
      position: [14.3, 1.35, 3.9], yaw: 40, pitch: -18, fov: 48, hour: HOUR, viewModel: false,
      setup: stage(0.12, () => impact(V(12, 0.04, 1), V(0, 1, 0), 'water')),
    },
    {
      name: 'fx-impact-flesh',
      description: 'Flesh impact: fine red mist and droplets spraying back toward the shooter',
      position: [4.6, 1.75, 2.4], yaw: 37, pitch: -3, fov: 45, hour: HOUR, viewModel: false,
      setup: stage(0.12, () => impact(V(2, 1.5, -1.0), V(0, 0, 1), 'flesh', 1500, V(0, -0.05, -1))),
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
      description: 'Tracer rounds crossing the frame with velocity-correct length and glowing heads',
      // Broadside to the firing line. A tracer is a camera-facing beam, so a
      // camera looking *down* the line sees it edge-on and it vanishes.
      position: [8.0, 1.78, 9.2], yaw: 6, pitch: -1, fov: 58, hour: HOUR, viewModel: false,
      // Age must be >= SETTLE so `burst` runs during setup: it anchors its own
      // per-round delays to the settle window, and scheduling the burst itself
      // pushes every round past the captured frame.
      setup: stage(0.10, () => {
        // Sniper profile tracers every round. Burst delays are relative to the
        // staged spawn (near the end of settle), so rods are still mid-frame at
        // capture rather than 100 m past the camera.
        const dir = V(-1, 0.003, -0.028).normalize();
        burst(V(16.5, 1.70, 3.4), dir, 6, false, 'sniper_test', 0.014, 0);
      }),
    },
    {
      name: 'fx-casings',
      description: 'Ejected brass in flight and settled on the deck after a burst',
      position: [2.90, 1.15, 0.15], yaw: 57, pitch: -4, fov: 40, hour: HOUR, viewModel: false,
      setup: stage(0.42, () => burst(V(0, 1.45, -1.0), V(0, 0.02, -1).normalize(), 6)),
    },
    // --- the detonation, sampled five times across its life. An explosion is
    //     judged on the progression, never on one frame, so the same event is
    //     staged from the same camera at 40 ms / 170 ms / 500 ms / 1.0 s / 1.7 s.
    {
      name: 'fx-explosion-flash',
      description: 'Grenade at 40 ms: the flash and shock front, before the fireball has bloomed',
      position: [2.5, 2.4, 14.0], yaw: 12, pitch: -2, fov: 55, hour: HOUR, viewModel: false,
      setup: stage(0.04, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
    },
    {
      name: 'fx-explosion-fireball',
      description: 'Grenade at 170 ms: displaced fireball, shockwave ring, embers and thrown debris',
      position: [2.5, 2.4, 14.0], yaw: 12, pitch: -2, fov: 55, hour: HOUR, viewModel: false,
      setup: stage(0.17, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
    },
    {
      name: 'fx-explosion-wave',
      description: 'Grenade at 500 ms: fireball collapsing to soot, ground dust wave running out flat',
      position: [2.5, 2.4, 14.0], yaw: 12, pitch: -2, fov: 55, hour: HOUR, viewModel: false,
      setup: stage(0.5, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
    },
    {
      name: 'fx-explosion-rise',
      description: 'Grenade at 1.0 s: the column starting to lift, embers still arcing out of the dust',
      position: [2.5, 2.4, 14.0], yaw: 12, pitch: -2, fov: 55, hour: HOUR, viewModel: false,
      setup: stage(1.0, () => bus.emit('explosion', { point: V(0, 0.6, 2.0), radius: 6, power: 100, kind: 'frag' })),
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
      // The canister sits in open ground eight metres out, not up against the
      // far side of the square: half a screen that has grown *into* a building
      // is hidden behind it, and what is left reads as a veil.
      position: [1.0, 1.62, 13.0], yaw: 5, pitch: -2, fov: 60, hour: HOUR, viewModel: false,
      setup: stage(5.0, () => bus.emit('explosion', { point: V(0, 0.4, 5.2), radius: 5, power: 1, kind: 'smoke' })),
    },
    {
      name: 'fx-flashbang',
      description: 'Flashbang at 100 ms seen from across the street: bloom, the light it throws, and a bleach on the frame that falls off with distance',
      // The bloom disc and the flash light both live about 200 ms, so a frame
      // sampled at 280 ms had nothing left to show but the white-out.
      position: [3.0, 1.70, 15.0], yaw: 11, pitch: -2, fov: 58, hour: HOUR, viewModel: false,
      setup: stage(0.10, () => bus.emit('explosion', { point: V(0, 1.2, 2.0), radius: 4, power: 1, kind: 'flashbang' })),
    },
    {
      name: 'fx-lightshafts',
      description: 'Late-afternoon sun raking across the sightline in volumetric shafts, with dust drifting in the beams',
      // A low sun is the whole point: shafts are additive, so they only read
      // against a scene that has some shadow in it, and a near-horizontal beam
      // crosses the frame instead of stabbing straight down out of shot.
      // A low sun is the difference between a beam and a smear: it rakes the
      // sightline instead of stabbing down out of frame, it drops the square
      // into shadow so an additive beam has something dark to read against, and
      // it puts the key close enough to the view ray for the forward-scattering
      // lobe — which is most of a shaft's brightness — to actually fire.
      position: [4.0, 1.70, 2.0], yaw: 105, pitch: -3, fov: 62, hour: 17.1, viewModel: false,
      setup: stage(4.0, () => { /* ambient dust only */ }, () => {
        if (fxRef) { fxRef.environment.dust = 1.0; fxRef.environment.litter = 0.35; }
        installSunShafts();
      }),
    },
    {
      name: 'fx-rain',
      description: 'Rain: stretched streaks, splash rings on the deck and a wet, low-contrast sky',
      position: [4.0, 1.70, 8.0], yaw: 22, pitch: -3, fov: 62, hour: 16.5, viewModel: false,
      setup: stage(2.4, () => { /* steady state */ }, () => {
        // Wet air does not carry dust or loose paper — and in this frame the
        // ambient layers were the only thing you could see.
        if (fxRef) { fxRef.environment.dust = 0.1; fxRef.environment.litter = 0; }
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
