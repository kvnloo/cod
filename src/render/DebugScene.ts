/**
 * `?debug=render` — the renderer's own test bed.
 *
 * A lighting laboratory rather than a level: a PBR sphere matrix sweeping
 * roughness against metalness, an arch and colonnade that throw long shadows
 * across a textured ground plane, close geometry for contact shadows, and a
 * receding line of blocks that makes aerial perspective and cascade transitions
 * obvious. Shots are registered at four times of day plus detail views.
 *
 * Every texture here is generated in code — no binary assets anywhere.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { EngineContext } from '../core/Engine';
import { registerDebugScene, registerShots } from '../core/Shots';
import { tagSurface } from '../core/Surfaces';
import type { RenderSystem } from './Renderer';

/* --------------------------------------------------- procedural textures -- */

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Seeded value-noise field with tiling, evaluated on the CPU at bake time. */
class NoiseField {
  private perm: Uint8Array;
  constructor(seed: number | string) {
    const rand = new Rand(seed);
    const p = new Uint8Array(512);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rand.int(0, i);
      const t = base[i]; base[i] = base[j]; base[j] = t;
    }
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    this.perm = p;
  }

  private grad(ix: number, iy: number): number {
    return this.perm[(this.perm[ix & 255] + (iy & 255)) & 255] / 255;
  }

  value(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const a = this.grad(ix, iy);
    const b = this.grad(ix + 1, iy);
    const c = this.grad(ix, iy + 1);
    const d = this.grad(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  fbm(x: number, y: number, octaves: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value(x, y);
      norm += amp;
      x *= 2.03; y *= 2.01;
      amp *= 0.5;
    }
    return sum / norm;
  }
}

interface SurfaceOptions {
  size?: number;
  base: [number, number, number];
  variation: number;
  grainScale: number;
  roughLow: number;
  roughHigh: number;
  metal?: number;
  bumpStrength?: number;
  speckle?: number;
}

interface SurfaceMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
}

function makeSurface(seed: string, o: SurfaceOptions): SurfaceMaps {
  const size = o.size ?? 512;
  const n1 = new NoiseField(`${seed}:a`);
  const n2 = new NoiseField(`${seed}:b`);
  const rand = new Rand(`${seed}:s`);

  const albedo = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const orm = new Uint8Array(size * size * 4);

  const speckle = o.speckle ?? 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * o.grainScale;
      const v = (y / size) * o.grainScale;

      // Low-frequency variation is kept weak on purpose: anything whose period
      // matches the tile makes the repeat obvious across a large floor.
      const macro = n1.fbm(u * 1.0, v * 1.0, 3);
      const micro = n2.fbm(u * 4.5, v * 4.5, 5);
      const grime = Math.pow(n1.fbm(u * 2.1 + 11, v * 2.1 + 7, 5), 2.1);

      let k = 1 - o.variation * 0.5 + o.variation * (macro * 0.35 + micro * 0.65);
      k *= 1 - grime * 0.28;
      const sp = speckle > 0 && rand.next() < speckle ? rand.range(0.55, 1.5) : 1;
      k *= sp;

      albedo[i * 4] = Math.min(255, Math.max(0, o.base[0] * 255 * k));
      albedo[i * 4 + 1] = Math.min(255, Math.max(0, o.base[1] * 255 * k));
      albedo[i * 4 + 2] = Math.min(255, Math.max(0, o.base[2] * 255 * k));
      albedo[i * 4 + 3] = 255;

      height[i] = micro * 0.65 + macro * 0.35 - grime * 0.2;

      const rough = o.roughLow + (o.roughHigh - o.roughLow) * (0.35 + 0.65 * micro) * (1 - grime * 0.25);
      const ao = 1 - grime * 0.45 - (1 - micro) * 0.12;
      orm[i * 4] = Math.min(255, Math.max(0, ao * 255));
      orm[i * 4 + 1] = Math.min(255, Math.max(0, rough * 255));
      orm[i * 4 + 2] = Math.min(255, Math.max(0, (o.metal ?? 0) * 255));
      orm[i * 4 + 3] = 255;
    }
  }

  const strength = (o.bumpStrength ?? 1) * 3.2;
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
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv;
      normal[i * 4] = (nx * 0.5 + 0.5) * 255;
      normal[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i * 4 + 2] = (nz * inv * 0.5 + 0.5) * 255;
      normal[i * 4 + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return { map: mk(albedo, true), normalMap: mk(normal, false), ormMap: mk(orm, false) };
}

function surfaceMaterial(maps: SurfaceMaps, repeat: number, tint = 0xffffff): THREE.MeshStandardMaterial {
  // Clone so each material owns its own tiling; clones share the underlying
  // Source, so there is no extra GPU upload.
  const map = maps.map.clone();
  const normalMap = maps.normalMap.clone();
  const ormMap = maps.ormMap.clone();
  for (const t of [map, normalMap, ormMap]) {
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
  }
  return new THREE.MeshStandardMaterial({
    color: tint,
    map,
    normalMap,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 1,
  });
}

/* ------------------------------------------------------------------ scene -- */

export function registerRenderDebugScene(render: RenderSystem): void {
  registerDebugScene('render', (ctx: EngineContext) => {
    const scene = ctx.scene;

    // A debug scene owns the world for the whole capture run: gameplay systems
    // that drive the camera or spawn actors would fight the shot list.
    for (const name of ['player', 'ai', 'director', 'weapons']) {
      const sys = ctx.engine.tryGet(name);
      if (sys) sys.enabled = false;
    }

    // Take over the world completely.
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c.name === 'world') scene.remove(c);
      const l = c as THREE.Light;
      if (l.isLight && !c.name.startsWith('dyn')) scene.remove(c);
    }

    const root = new THREE.Group();
    root.name = 'render-debug';
    scene.add(root);

    const groundMaps = makeSurface('rd:ground', {
      base: [0.30, 0.29, 0.275], variation: 0.55, grainScale: 8,
      roughLow: 0.62, roughHigh: 0.98, bumpStrength: 1.3, speckle: 0.006,
    });
    const concreteMaps = makeSurface('rd:concrete', {
      base: [0.52, 0.505, 0.48], variation: 0.42, grainScale: 6,
      roughLow: 0.55, roughHigh: 0.95, bumpStrength: 0.9, speckle: 0.003,
    });
    const steelMaps = makeSurface('rd:steel', {
      base: [0.62, 0.63, 0.66], variation: 0.28, grainScale: 10,
      roughLow: 0.18, roughHigh: 0.62, metal: 0.92, bumpStrength: 0.5,
    });

    // --- ground: large enough that the true horizon is geometry, not the
    // sky's below-horizon term, which would otherwise cut a hard line.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400, 1, 1),
      surfaceMaterial(groundMaps, 520),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.castShadow = false;
    tagSurface(ground, 'asphalt');
    root.add(ground);

    // --- PBR matrix: roughness across, metalness up
    const sphereGeo = new THREE.SphereGeometry(0.42, 48, 32);
    const COLS = 7;
    const ROWS = 5;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(0.08, 0.12, 0.72),
          roughness: THREE.MathUtils.lerp(0.04, 1.0, c / (COLS - 1)),
          metalness: r / (ROWS - 1),
        });
        const m = new THREE.Mesh(sphereGeo, mat);
        m.position.set((c - (COLS - 1) / 2) * 1.15, 0.55 + r * 1.05, -3.2);
        m.castShadow = true;
        m.receiveShadow = true;
        root.add(m);
      }
    }

    // --- shadow-casting arch
    const pillarGeo = new THREE.BoxGeometry(0.9, 4.4, 0.9);
    const archMat = surfaceMaterial(concreteMaps, 3);
    for (const x of [-3.2, 3.2]) {
      const p = new THREE.Mesh(pillarGeo, archMat);
      p.position.set(x, 2.2, 4.5);
      p.castShadow = true;
      p.receiveShadow = true;
      tagSurface(p, 'concrete');
      root.add(p);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.85, 1.1), archMat);
    lintel.position.set(0, 4.85, 4.5);
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    root.add(lintel);

    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(2.35, 0.34, 20, 64, Math.PI),
      surfaceMaterial(steelMaps, 4),
    );
    arch.position.set(0, 4.4, 4.5);
    arch.castShadow = true;
    arch.receiveShadow = true;
    root.add(arch);

    // --- contact-shadow test: small props sitting flush on the ground
    const rand = new Rand('rd:props');
    const crateMat = surfaceMaterial(concreteMaps, 1.6, 0x9a8f7c);
    for (let i = 0; i < 14; i++) {
      const s = rand.range(0.28, 0.85);
      const box = new THREE.Mesh(new THREE.BoxGeometry(s, s * rand.range(0.6, 1.4), s), crateMat);
      const a = rand.range(0, Math.PI * 2);
      const d = rand.range(2.2, 9.0);
      box.position.set(Math.cos(a) * d, box.geometry.parameters.height / 2, Math.sin(a) * d + 1.5);
      box.rotation.y = rand.range(0, Math.PI);
      box.castShadow = true;
      box.receiveShadow = true;
      tagSurface(box, 'crate');
      root.add(box);
    }

    // A thin pole and a low rail: the classic case shadow maps cannot resolve.
    const poleMat = surfaceMaterial(steelMaps, 2);
    for (let i = 0; i < 5; i++) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.4, 12), poleMat);
      pole.position.set(-5.5 + i * 0.75, 0.7, 7.2);
      pole.castShadow = true;
      pole.receiveShadow = true;
      root.add(pole);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.06, 0.06), poleMat);
    rail.position.set(-4.0, 1.32, 7.2);
    rail.castShadow = true;
    root.add(rail);

    // --- surrounding skyline: cascade transitions + aerial perspective from
    // every shot angle, and a depth layer behind the hero subject.
    const distMat = surfaceMaterial(concreteMaps, 5, 0xb9b3a6);
    for (let i = 0; i < 54; i++) {
      const t = rand.next();
      const h = 4 + rand.range(0, 9) + t * 18;
      const w = 4 + rand.range(0, 9);
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * rand.range(0.7, 1.3)), distMat);
      const a = rand.range(0, Math.PI * 2);
      const d = 52 + t * 240 + rand.range(0, 30);
      b.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
      b.rotation.y = rand.range(0, Math.PI);
      b.castShadow = true;
      b.receiveShadow = true;
      tagSurface(b, 'concrete');
      root.add(b);
    }

    // --- decal test wall, facing +X so the morning sun rakes across it
    const wall = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 0.5), surfaceMaterial(concreteMaps, 2.4));
    wall.position.set(-13, 2.1, 1);
    wall.rotation.y = Math.PI / 2;
    wall.castShadow = true;
    wall.receiveShadow = true;
    tagSurface(wall, 'concrete');
    wall.name = 'decal-wall';
    root.add(wall);

    render.sky.groundAlbedo.setRGB(0.30, 0.29, 0.275);
    render.setAmbient(0xffffff, 1);
    render.setTimeOfDay(12);
    render.setWeather(0, 0.04, 0.25);
  });

  const wallDecals = (groups: string[]) => () => {
    render.decals.clear();
    const rand = new Rand('shot:decals');
    const n = new THREE.Vector3(1, 0, 0);
    // Two tight bursts plus scattered strays, the way a real firefight lands.
    for (let burst = 0; burst < 3; burst++) {
      const cz = rand.range(-3.2, 3.2);
      const cy = rand.range(1.0, 3.0);
      for (let i = 0; i < 16; i++) {
        render.addDecal({
          position: new THREE.Vector3(
            -12.74,
            THREE.MathUtils.clamp(cy + rand.normal() * 0.42, 0.25, 3.9),
            THREE.MathUtils.clamp(cz + rand.normal() * 0.55, -4.2, 4.2),
          ),
          normal: n,
          size: rand.range(0.20, 0.42),
          group: groups[rand.int(0, groups.length - 1)],
          lifetime: Infinity,
        });
      }
    }
    for (let i = 0; i < 22; i++) {
      render.addDecal({
        position: new THREE.Vector3(-12.74, rand.range(0.25, 4.0), rand.range(-4.2, 4.2)),
        normal: n,
        size: rand.range(0.16, 0.36),
        group: groups[rand.int(0, groups.length - 1)],
        lifetime: Infinity,
      });
    }
    // Blood and scorch on the ground for contrast.
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 12; i++) {
      render.addDecal({
        position: new THREE.Vector3(rand.range(-11.5, -7.5), 0.001, rand.range(-3.5, 3.5)),
        normal: up,
        size: rand.range(0.7, 1.8),
        group: rand.bool(0.6) ? 'blood' : 'scorch',
        lifetime: Infinity,
      });
    }
  };

  // Yaw convention (Capture uses YXZ euler): forward = (-sin yaw, ·, -cos yaw),
  // so yaw = atan2(-dx, -dz) for a desired look direction d.
  // The sun tracks the southern sky at latitude 34, so shadows always run
  // toward −Z. Cameras are placed so each shot actually shows its own light.
  registerShots([
    {
      name: 'render-noon',
      description: 'Render test bed at solar noon — hard overhead sun, tight shadows, deep blue sky',
      position: [6.0, 3.2, -15.5], yaw: 157, pitch: -6, fov: 62, hour: 12, viewModel: false,
    },
    {
      name: 'render-dawn',
      description: 'Render test bed at dawn — low sun straight ahead, long shadows toward camera',
      position: [-9.5, 2.5, 13.5], yaw: -34, pitch: -3, fov: 62, hour: 6.6, viewModel: false,
    },
    {
      name: 'render-dusk',
      description: 'Render test bed at golden hour — backlit, red sun, rim-lit silhouettes',
      position: [15.5, 2.9, 8.5], yaw: 66, pitch: -3, fov: 62, hour: 18.1, viewModel: false,
    },
    {
      name: 'render-night',
      description: 'Render test bed at night — moonlit, star field, exposure floored so night reads dark',
      position: [6.0, 3.2, -15.5], yaw: 157, pitch: -5, fov: 62, hour: 23.2, viewModel: false,
    },
    {
      name: 'render-pbr',
      description: 'PBR sphere matrix: roughness left→right, metalness bottom→top',
      position: [0, 2.65, 3.6], yaw: 0, pitch: 0, fov: 50, hour: 13.5, viewModel: false,
    },
    {
      name: 'render-shadow',
      description: 'Contact-shadow detail: thin poles and props grounded on the plane',
      position: [-3.0, 1.25, 12.5], yaw: 4, pitch: -6, fov: 55, hour: 8.6, viewModel: false,
    },
    {
      name: 'render-decals',
      description: 'Projected decal atlas sprayed across a sunlit concrete wall and the ground',
      position: [-6.2, 1.85, 1.0], yaw: 90, pitch: -6, fov: 55, hour: 9.5, viewModel: false,
      setup: wallDecals(['hard', 'metal', 'wood', 'glass']),
    },
    {
      name: 'render-sky',
      description: 'Sky dome looking into the low sun — disc, limb darkening and Mie halo',
      position: [0, 1.7, 10], yaw: 90, pitch: 13, fov: 75, hour: 16.8, viewModel: false,
    },
  ]);
}
