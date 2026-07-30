/**
 * Debug scene 'materials' — the material module's own visual test bed.
 *
 *   node tools/capture.mjs --debug materials --port 4203 --dist dist-mat
 *
 * Five stations laid out along +Z so each gets its own tight camera shot:
 *
 *   z ≈ 0    swatch grid — every archetype as a lit sphere (BRDF response)
 *            beside a flat panel (layout + tiling), with a name plate
 *   z ≈ 34   hero panels for close-ups at 0.6 m, which is where procedural
 *            textures usually fall apart
 *   z ≈ 68   large tiled ground beds viewed at a grazing angle: the only
 *            honest test for seams, mip shimmer and parallax
 *   z ≈ 104  200 instanced crates + a vertex-colour concrete→dirt blend
 *   z ≈ 140  animated emissives, shot at night
 *
 * Lighting comes from the renderer's own sky and IBL — this scene only sets the
 * time of day — so what you see is what the game will see.
 */

import * as THREE from 'three';
import { registerDebugScene, registerShots, DEBUG_SCENE } from '../core/Shots';
import type { EngineContext, System } from '../core/Engine';
import type { MaterialSystem } from './MaterialLibrary';
import { applyInstanceVariation, setBlendWeights } from './MaterialShaders';
import { Rand } from '../core/Rand';
import { settings } from '../core/Settings';
import { MASONRY_ARCHETYPES } from './recipes/masonry';
import { METAL_ARCHETYPES } from './recipes/metals';
import { WOOD_ARCHETYPES } from './recipes/wood';
import { GROUND_ARCHETYPES } from './recipes/ground';
import { SOFT_ARCHETYPES } from './recipes/soft';
import { MISC_ARCHETYPES } from './recipes/misc';

const COLS = 7;
const CELL_X = 1.5;
const CELL_Y = 1.5;

const ARCHETYPE_COUNT =
  MASONRY_ARCHETYPES.length + METAL_ARCHETYPES.length + WOOD_ARCHETYPES.length +
  GROUND_ARCHETYPES.length + SOFT_ARCHETYPES.length + MISC_ARCHETYPES.length;
const GRID_ROWS = Math.ceil(ARCHETYPE_COUNT / COLS);
const GRID_W = COLS * CELL_X;
const GRID_H = GRID_ROWS * CELL_Y;
const GRID_Y = 1.2 + GRID_H / 2;

const HERO_Z = 34;
const HERO_IDS = ['concrete', 'brick', 'asphalt', 'metal', 'wood', 'gravel', 'tile', 'sandbag', 'plaster', 'metalThin'];
const HERO_STEP = 5;

const BED_Z = 68;
const BED_IDS = ['asphalt', 'gravel', 'dirt', 'tile', 'diamondPlate', 'sand'];
const BED_STEP = 12;

const SHOW_Z = 104;
const EM_Z = 140;

/* ----------------------------------------------------------------- label */

function labelTexture(text: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8,10,12,0.9)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e8eef4';
  g.font = '600 44px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* ----------------------------------------------------------------- build */

registerDebugScene('materials', async (ctx: EngineContext) => {
  const engine = ctx.engine;
  const scene = ctx.scene;
  const mats = engine.tryGet<MaterialSystem & System>('materials');
  const render = engine.tryGet<System & {
    renderer: THREE.WebGLRenderer;
    setTimeOfDay(h: number): void;
    setWeather(r: number, f: number, w: number): void;
  }>('render');
  if (!mats || !render) { console.warn('[materials] debug scene needs the material + render systems'); return; }

  // A debug scene owns the world for the whole capture run: gameplay systems
  // that drive the camera or spawn actors would fight the shot list.
  for (const name of ['player', 'ai', 'director', 'weapons', 'fx', 'hud']) {
    const sys = engine.tryGet(name);
    if (sys) sys.enabled = false;
  }

  // Take over the world, but leave the renderer's own sky/light rig alone.
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const c = scene.children[i];
    if (c.name === 'world') { scene.remove(c); continue; }
    const l = c as THREE.Light;
    if (l.isLight && !c.name.startsWith('dyn')) scene.remove(c);
  }
  scene.fog = null;

  render.setTimeOfDay(10.5);
  render.setWeather(0, 0, 0.25);

  // Motion blur and DoF are judged by the render module, not here, and both
  // smear the swatches when the shot camera teleports. Turn them off so what
  // lands in the screenshot is the material and nothing else.
  settings.setGfx('motionBlur', false);
  settings.setGfx('dof', false);

  const list = mats.listArchetypes();
  await mats.warmup(list.map((a) => a.id), (p) => {
    if (p.done % 8 === 0) console.info(`[materials] warmup ${p.done}/${p.total} ${p.current}`);
  });

  const root = new THREE.Group();
  root.name = 'materials-debug';
  scene.add(root);

  /* ------------------------------------------------------------- ground */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900, 1, 1),
    mats.material('concrete', { triplanar: true, scale: 3 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  /* ---------------------------------------------------------- swatch grid */
  const panelGeo = new THREE.PlaneGeometry(1.05, 1.05, 1, 1);
  const sphereGeo = new THREE.SphereGeometry(0.30, 64, 48);
  const labelGeo = new THREE.PlaneGeometry(1.15, 0.20);

  for (let i = 0; i < list.length; i++) {
    const arch = list[i];
    const cx = (i % COLS - (COLS - 1) / 2) * CELL_X;
    const cy = GRID_Y + ((GRID_ROWS - 1) / 2 - Math.floor(i / COLS)) * CELL_Y;

    const mat = mats.material(arch.id, {});

    const panel = new THREE.Mesh(panelGeo, mat);
    panel.position.set(cx, cy + 0.13, 0);
    panel.receiveShadow = true;
    root.add(panel);

    const sph = new THREE.Mesh(sphereGeo, mat);
    sph.position.set(cx, cy + 0.13, 0.52);
    sph.castShadow = true;
    sph.receiveShadow = true;
    root.add(sph);

    const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({
      map: labelTexture(arch.label), transparent: true, toneMapped: false, depthWrite: false,
    }));
    label.position.set(cx, cy - 0.52, 0.02);
    root.add(label);
  }

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_W + 4, GRID_H + 4),
    mats.material('plaster', { scale: 3 }),
  );
  backdrop.position.set(0, GRID_Y, -0.35);
  backdrop.receiveShadow = true;
  root.add(backdrop);

  /* ----------------------------------------------------------- hero panels */
  const heroGeo = new THREE.PlaneGeometry(2.2, 2.2);
  const heroSphere = new THREE.SphereGeometry(0.55, 96, 64);
  for (let i = 0; i < HERO_IDS.length; i++) {
    const m = mats.material(HERO_IDS[i], {});
    const p = new THREE.Mesh(heroGeo, m);
    p.position.set(i * HERO_STEP, 1.6, HERO_Z);
    p.receiveShadow = true;
    root.add(p);
    const s = new THREE.Mesh(heroSphere, m);
    s.position.set(i * HERO_STEP + 1.5, 1.6, HERO_Z + 0.9);
    s.castShadow = true; s.receiveShadow = true;
    root.add(s);
  }

  /* -------------------------------------------------------------- tiling */
  for (let i = 0; i < BED_IDS.length; i++) {
    const g = new THREE.PlaneGeometry(11, 22, 1, 1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 5, uv.getY(k) * 10);
    uv.needsUpdate = true;
    const plane = new THREE.Mesh(g, mats.material(BED_IDS[i], {}));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(i * BED_STEP, 0.01, BED_Z);
    plane.receiveShadow = true;
    root.add(plane);

    // A block to throw a shadow across the bed and give the eye a depth cue.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.4, 0.5),
      mats.material('concrete', { triplanar: true, scale: 2 }),
    );
    wall.position.set(i * BED_STEP + 2.5, 0.7, BED_Z + 4);
    wall.castShadow = true; wall.receiveShadow = true;
    root.add(wall);
  }

  /* ------------------------------------------------- instancing + blending */
  const rand = new Rand('materials-debug');
  const crateGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
  const crateMat = mats.material('crate', { instanced: true });
  const CRATES = 200;
  const crates = new THREE.InstancedMesh(crateGeo, crateMat, CRATES);
  applyInstanceVariation(crates.geometry, CRATES, () => rand.next());
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < CRATES; i++) {
    const gx = i % 20, gz = Math.floor(i / 20);
    pos.set((gx - 9.5) * 0.78, 0.36 + (gz % 3) * 0.71, (Math.floor(gz / 3) - 1.5) * 0.78);
    e.set(0, rand.range(-0.22, 0.22), 0);
    q.setFromEuler(e);
    m4.compose(pos, q, one);
    crates.setMatrixAt(i, m4);
  }
  crates.instanceMatrix.needsUpdate = true;
  crates.castShadow = true;
  crates.receiveShadow = true;
  crates.position.set(-9, 0, SHOW_Z);
  root.add(crates);

  const blendGeo = new THREE.PlaneGeometry(14, 14, 96, 96);
  setBlendWeights(blendGeo, (x, y) => {
    const n = Math.sin(x * 0.55) * 0.5 + Math.cos(y * 0.42) * 0.5;
    return THREE.MathUtils.clamp(0.5 + n * 0.8 + (x + y) * 0.035, 0, 1);
  });
  const blendPlane = new THREE.Mesh(
    blendGeo,
    mats.material('concrete', { blendWith: 'dirt', scale: 2.5, blendScale: 2 }),
  );
  blendPlane.rotation.x = -Math.PI / 2;
  blendPlane.position.set(14, 0.02, SHOW_Z);
  blendPlane.receiveShadow = true;
  root.add(blendPlane);

  /* ------------------------------------------------------------- emissives */
  const emIds = ['fluorescent', 'monitor', 'strobe', 'hotMetal'];
  const emBack = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 7),
    mats.material('plaster', { scale: 3 }),
  );
  emBack.position.set(4.5, 3, EM_Z - 0.35);
  emBack.receiveShadow = true;
  root.add(emBack);
  for (let i = 0; i < emIds.length; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), mats.material(emIds[i], {}));
    p.position.set(i * 3.2 - 0.3, 1.9, EM_Z);
    root.add(p);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.28), new THREE.MeshBasicMaterial({
      map: labelTexture(emIds[i]), transparent: true, toneMapped: false, depthWrite: false,
    }));
    label.position.set(i * 3.2 - 0.3, 0.95, EM_Z + 0.01);
    root.add(label);
  }

  console.info(`[materials] debug scene ready — ${list.length} archetypes`);
});

/* ------------------------------------------------------------------ shots */
/* Registered only when the debug scene is requested, so the default shot list
 * the other modules capture against stays clean. */

if (DEBUG_SCENE === 'materials') {
  const gridDist = (GRID_H * 0.5 + 0.6) / Math.tan(THREE.MathUtils.degToRad(26));
  const shots = [
    {
      name: 'mat-grid',
      description: 'Every material archetype: lit sphere plus flat panel, name plate under each',
      position: [0, GRID_Y, gridDist] as [number, number, number],
      yaw: 0, pitch: 0, fov: 52, viewModel: false, hour: 10.5,
    },
    {
      name: 'mat-grid-top',
      description: 'Top three rows of the swatch grid at close range',
      position: [0, GRID_Y + GRID_H * 0.28, 4.4] as [number, number, number],
      yaw: 0, pitch: 0, fov: 50, viewModel: false, hour: 10.5,
    },
    {
      name: 'mat-grid-mid',
      description: 'Middle rows of the swatch grid at close range',
      position: [0, GRID_Y, 4.4] as [number, number, number],
      yaw: 0, pitch: 0, fov: 50, viewModel: false, hour: 10.5,
    },
    {
      name: 'mat-grid-bottom',
      description: 'Bottom rows of the swatch grid at close range',
      position: [0, GRID_Y - GRID_H * 0.28, 4.4] as [number, number, number],
      yaw: 0, pitch: 0, fov: 50, viewModel: false, hour: 10.5,
    },
    {
      name: 'mat-tiling',
      description: 'Grazing view across large tiled ground beds — seams, mip shimmer, parallax',
      position: [-4, 1.7, BED_Z + 12] as [number, number, number],
      yaw: -72, pitch: -11, fov: 72, viewModel: false, hour: 9,
    },
    {
      name: 'mat-tiling-far',
      description: 'Long grazing view down the tiling beds to check distance filtering',
      position: [-7, 2.6, BED_Z + 16] as [number, number, number],
      yaw: -80, pitch: -7, fov: 62, viewModel: false, hour: 16,
    },
    {
      name: 'mat-instancing',
      description: '200 instanced crates sharing one material, varied by instance attributes',
      position: [-9, 2.6, SHOW_Z + 7] as [number, number, number],
      yaw: 0, pitch: -14, fov: 58, viewModel: false, hour: 15,
    },
    {
      name: 'mat-blend',
      description: 'Vertex-colour height blend between concrete and dirt',
      position: [14, 3.6, SHOW_Z + 9] as [number, number, number],
      yaw: 0, pitch: -24, fov: 60, viewModel: false, hour: 9,
    },
    {
      name: 'mat-emissive',
      description: 'Animated emissives at night: fluorescent tube, CRT monitor, hazard strobe, hot metal',
      position: [4.5, 1.9, EM_Z + 4.2] as [number, number, number],
      yaw: 0, pitch: 0, fov: 58, viewModel: false, hour: 21.5,
    },
  ];

  for (let i = 0; i < HERO_IDS.length; i++) {
    shots.push({
      name: `mat-close-${HERO_IDS[i]}`,
      description: `${HERO_IDS[i]} at 0.75 m — crevice grime, edge wear, two-scale normal detail`,
      position: [i * HERO_STEP, 1.6, HERO_Z + 0.75] as [number, number, number],
      yaw: 0, pitch: 0, fov: 52, viewModel: false, hour: 10.5,
    });
    shots.push({
      name: `mat-sphere-${HERO_IDS[i]}`,
      description: `${HERO_IDS[i]} on a sphere at 1.4 m — BRDF response and curvature-driven wear`,
      position: [i * HERO_STEP + 1.5, 1.6, HERO_Z + 2.3] as [number, number, number],
      yaw: 0, pitch: 0, fov: 46, viewModel: false, hour: 10.5,
    });
  }

  registerShots(shots);
}
