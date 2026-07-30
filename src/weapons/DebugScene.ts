/**
 * Debug scene 'weapons' — the weapon module's own visual test bed.
 *
 *   node tools/capture.mjs --debug weapons --port 4212 --dist dist-weap
 *
 * Four stations along +Z, each framed by its own shots:
 *
 *   z ≈ 0    the lineup: all eight weapons side-on at a common scale
 *   z ≈ 14   hero turntable: one weapon per bay at 3/4, plus receiver close-ups
 *   z ≈ 30   attachment matrix: one weapon wearing every optic / muzzle / grip
 *   z ≈ 44   first-person framing: the actual view-model pose, hip and ADS,
 *            rendered in the world so the shot list can see it
 *
 * Lighting is the renderer's own sky and IBL — what you see here is what the
 * game sees.
 */

import * as THREE from 'three';
import { DEBUG_SCENE, registerDebugScene, registerShots } from '../core/Shots';
import type { EngineContext, System } from '../core/Engine';
import type { ShotDef } from '../core/CaptureAPI';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import type { MaterialSystem } from '../material/MaterialLibrary';
import { WEAPONS, weaponDef } from './Catalog';
import { attachment, resolveLoadout } from './Attachments';
import { WeaponMaterials } from './WeaponMaterials';
import { buildWeaponMesh } from './mesh/Models';
import { RigBuilder, type WeaponRig } from './mesh/Builder';
import { ViewModel, type ViewModelState } from './ViewModel';
import { resolveStats } from './Attachments';
import type { WeaponSystem } from './Weapons';

const LINEUP_Z = 0;
const HERO_Z = 14;
const ATT_Z = 30;
const FP_Z = 44;
const BAY = 1.15;
const STAND_Y = 1.42;

interface RenderLike extends System {
  renderer: THREE.WebGLRenderer;
  setTimeOfDay(h: number): void;
  setWeather(r: number, f: number, w: number): void;
  viewModelScene: THREE.Scene;
  viewModelCamera: THREE.PerspectiveCamera;
  addDynamicLight(req: {
    position: THREE.Vector3; color: number; intensity: number; radius: number;
    lifetime: number; decay?: 'exp' | 'linear' | 'flash' | 'flicker';
  }): void;
  /** Set false so the studio rig below is not silenced by the sky system. */
  adoptSceneLights: boolean;
}

/** Weapon-local −Z becomes world +X: the classic side-on catalogue pose. */
function sidePose(g: THREE.Group): void { g.rotation.set(0, -Math.PI / 2, 0); }

function heroPose(g: THREE.Group): void { g.rotation.set(0.06, -Math.PI / 2 + 0.55, 0.02); }

function labelTexture(text: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 72;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(6,8,10,0.92)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#dfe7ee';
  g.font = '600 34px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function label(text: string, at: [number, number, number], width = 0.6): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * (72 / 512)),
    new THREE.MeshBasicMaterial({ map: labelTexture(text), transparent: true, toneMapped: false, depthWrite: false }),
  );
  m.position.set(at[0], at[1], at[2]);
  return m;
}

/**
 * Engine handle used to over-settle each shot.
 *
 * The harness renders 24 frames after moving the camera, which is not enough
 * for TAA to flush its history: the leftover 8% of the previous frame reads as
 * translucent sheets hanging off the weapon, and on a close-up hero shot that
 * is indistinguishable from broken geometry. Every shot here therefore pumps
 * extra frames of its own before the screenshot is taken.
 */
let shotEngine: EngineContext['engine'] | null = null;

function settleFrames(n: number): void {
  const e = shotEngine;
  if (!e) return;
  for (let i = 0; i < n; i++) e.stepFrame(1 / 60);
}

/** The live view model the first-person shots scrub through. */
let fpViewModel: ViewModel | null = null;
let fpMaterials: WeaponMaterials | null = null;
let fpRender: RenderLike | null = null;
let fpCamera: THREE.Camera | null = null;

/**
 * Deferred work that runs *after* a shot has settled, immediately before the
 * screenshot. Temporal effects need a long settle; a 40 ms muzzle flash does
 * not survive one, so anything genuinely transient is staged here instead.
 */
let afterSettle: (() => void) | null = null;

/** Pops the queued post-settle callback, if any. */
function takeAfterSettle(): (() => void) | null {
  const f = afterSettle;
  afterSettle = null;
  return f;
}

/**
 * Fires a real muzzle flash light so a still can answer "does the flash light
 * the weapon?".
 *
 * The light is queued rather than added: it has a flash's actual 90 ms life, so
 * adding it during setup would leave it long dead by the time the frame is
 * captured — and a long-lived stand-in would bleed into every shot after it,
 * because the pool is global and nothing clears it between shots.
 */
function holdMuzzleFlash(intensity = 190): void {
  afterSettle = () => {
    const vm = fpViewModel;
    const render = fpRender;
    const camera = fpCamera;
    if (!vm || !render || !camera) return;
    camera.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    vm.muzzleWorld(camera, p);
    render.addDynamicLight({
      position: p, color: 0xffc27a, intensity, radius: 5.0, lifetime: 0.26, decay: 'linear',
    });
    // …and the view model's own emitter, which is the one that actually lights
    // the barrel and the hands. The pooled world light is mirrored into view
    // space at 85%, but it competes for a shared slot; this one cannot lose.
    vm.holdFlash(34);
  };
}

function equipFp(id: string, attachmentIds?: string[]): void {
  const vm = fpViewModel;
  if (!vm) return;
  const def = weaponDef(id);
  const list = resolveLoadout(def, attachmentIds ?? def.attachments);
  vm.equip(def, list, resolveStats(def, list));
}

const FP_STATE: ViewModelState = {
  ads: 0, sprint: 0, speed01: 0, stepPhase: 0, grounded: true, crouch: 0,
  lookDX: 0, lookDY: 0, strafe: 0, forward: 0, lowReady: 0,
  boltLocked: false, ammo: 30,
};

/**
 * Advances the view model by `seconds` at 120 Hz with a fixed input state.
 * Long enough settles let springs reach rest; short ones catch a pose mid-flight.
 */
function scrub(seconds: number, patch: Partial<ViewModelState> = {}): void {
  const vm = fpViewModel;
  if (!vm) return;
  Object.assign(FP_STATE, patch);
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) vm.update(dt, FP_STATE);
  if (DEBUG_PROBE) {
    console.error(`[fp-probe] def=${vm.def?.id} rig=${vm.rig ? 'y' : 'n'} pos=${vm.root.position.toArray().map((v) => v.toFixed(3)).join(',')} ads=${vm.adsBlend.toFixed(2)}`);
  }
}
/** Set from the URL (`&probe=1`) to dump view-model transforms into the log. */
const DEBUG_PROBE = new URLSearchParams(globalThis.location?.search ?? '').get('probe') === '1';

function resetFp(): void {
  Object.assign(FP_STATE, {
    ads: 0, sprint: 0, speed01: 0, stepPhase: 0, grounded: true, crouch: 0,
    lookDX: 0, lookDY: 0, strafe: 0, forward: 0, lowReady: 0,
    boltLocked: false, ammo: 30,
  });
  fpViewModel?.cancelAction();
  scrub(1.2);
}

/**
 * Sight-alignment probe.
 *
 * "Looks centred" is not a measurement. This projects the live rig's own sight
 * point — and the reticle quad, when one is fitted — through the *actual*
 * view-model camera and reports normalised device coordinates, so a half-degree
 * of cant shows up as a number instead of as a feeling. Read it from the
 * harness with `__wpnProbe()`.
 */
function installProbe(render: RenderLike): void {
  const v = new THREE.Vector3();
  (globalThis as unknown as { __wpnProbe?: () => unknown }).__wpnProbe = () => {
    const vm = fpViewModel;
    const cam = render.viewModelCamera;
    if (!vm?.rig || !cam) return null;
    render.viewModelScene.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    const out: Record<string, unknown> = { weapon: vm.def?.id ?? null, ads: vm.adsBlend };
    const sight = vm.rig.point('sight');
    if (sight) {
      v.copy(sight);
      vm.rig.root.localToWorld(v);
      v.project(cam);
      out.sightNdc = [Number(v.x.toFixed(5)), Number(v.y.toFixed(5))];
    }
    const ret = vm.rig.reticle;
    if (ret) {
      ret.mesh.updateMatrixWorld(true);
      v.set(0, 0, 0).applyMatrix4(ret.mesh.matrixWorld).project(cam);
      out.reticleNdc = [Number(v.x.toFixed(5)), Number(v.y.toFixed(5))];
      out.reticleVisible = ret.mesh.visible;
      out.reticleFade = (ret.mesh.material as THREE.ShaderMaterial).uniforms.uFade?.value ?? null;
      out.reticleScale = ret.mesh.scale.x;
      out.reticleWorld = ret.mesh.getWorldPosition(new THREE.Vector3()).toArray();
      const chain: string[] = [];
      let p: THREE.Object3D | null = ret.mesh;
      while (p) { chain.push(`${p.name || p.type}:${p.visible ? 'v' : 'H'}`); p = p.parent; }
      out.chain = chain.join(' < ');
      let inScene = false;
      render.viewModelScene.traverse((o) => { if (o === ret.mesh) inScene = true; });
      out.inViewModelScene = inScene;
    }
    return out;
  };
}

registerDebugScene('weapons', async (ctx: EngineContext) => {
  const engine = ctx.engine;
  const scene = ctx.scene;
  const render = engine.tryGet<RenderLike>('render');
  const mats = engine.tryGet<MaterialSystem & System>('materials');
  if (!render) { console.warn('[weapons] debug scene needs the render system'); return; }

  for (const name of ['player', 'ai', 'director', 'fx', 'hud', 'weapons']) {
    const sys = engine.tryGet(name);
    if (sys) sys.enabled = false;
  }
  render.viewModelScene.visible = false;

  for (let i = scene.children.length - 1; i >= 0; i--) {
    const c = scene.children[i];
    if (c.name === 'world') { scene.remove(c); continue; }
    const l = c as THREE.Light;
    if (l.isLight && !c.name.startsWith('dyn')) scene.remove(c);
  }
  scene.fog = null;
  render.setTimeOfDay(15.4);
  render.setWeather(0, 0, 0.2);
  // Motion blur and depth of field smear the subject whenever the shot camera
  // teleports, and the harness re-applies a quality preset *after* the scene is
  // built — so turning them off once is not enough.
  const stripPost = (): void => {
    settings.gfx.motionBlur = false;
    settings.gfx.dof = false;
  };
  stripPost();
  bus.on('quality:changed', stripPost);
  shotEngine = engine;

  // A weapon is a dark, mostly-metal object: the sky alone renders it as a
  // silhouette. This is a product-photography rig — key, fill, rim — so the
  // form and the finish are actually legible in a still.
  render.adoptSceneLights = false;
  // Weapons are now authored at their real values — parkerised steel is around
  // 5% reflectance — so the rig has to be a *studio* rig, several stops over
  // the sky, or every catalogue shot is a silhouette against a bright horizon.
  const key = new THREE.DirectionalLight(0xfff1de, 3.4);
  key.position.set(-6, 7, 9);
  const fill = new THREE.DirectionalLight(0xc8d8f0, 1.05);
  fill.position.set(8, 2.5, 5);
  const rim = new THREE.DirectionalLight(0xffe7c8, 2.4);
  rim.position.set(3, 5, -9);
  for (const l of [key, fill, rim]) {
    l.castShadow = false;
    l.name = 'dyn-weapon-studio';
    ctx.scene.add(l, l.target);
  }

  // Share the live WeaponSystem's material library and, crucially, its *own*
  // view model. The system is disabled here, but it has already built a weapon
  // into the view-model scene during init — a second one would leave the first
  // sitting at the origin, i.e. wrapped around the camera.
  const ws = engine.tryGet<WeaponSystem & System>('weapons');
  const weaponMats = ws?.materials ?? new WeaponMaterials();
  weaponMats.warmup(render.renderer);
  fpMaterials = weaponMats;
  void fpMaterials;

  const root = new THREE.Group();
  root.name = 'weapons-debug';
  scene.add(root);

  /* ---------------------------------------------------------------- floor */
  const floorMat = mats?.material('asphalt', { triplanar: true, scale: 3 })
    ?? new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.9 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  const standMat = mats?.material('metal', { triplanar: true, scale: 1.2 })
    ?? new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.8 });

  const rigs: WeaponRig[] = [];

  const place = (rig: WeaponRig, at: [number, number, number], pose: (g: THREE.Group) => void): THREE.Group => {
    const holder = new THREE.Group();
    holder.position.set(at[0], at[1], at[2]);
    pose(holder);
    holder.add(rig.root);
    for (const m of rig.meshes) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = true; }
    root.add(holder);
    rigs.push(rig);
    return holder;
  };

  /* -------------------------------------------------------------- lineup */
  const n = WEAPONS.length;
  for (let i = 0; i < n; i++) {
    const def = WEAPONS[i];
    const rig = buildWeaponMesh(def, resolveLoadout(def, def.attachments), weaponMats, 'world');
    const x = (i - (n - 1) / 2) * BAY;
    place(rig, [x, STAND_Y, LINEUP_Z], sidePose);
    // Stand: a slim post so the weapon is not floating in a void.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, STAND_Y - 0.10, 12), standMat);
    post.position.set(x, (STAND_Y - 0.10) / 2, LINEUP_Z + 0.02);
    post.castShadow = true; post.receiveShadow = true;
    root.add(post);
    root.add(label(def.short, [x, STAND_Y - 0.20, LINEUP_Z + 0.05], 0.52));
    console.info(`[weapons] ${def.id.padEnd(14)} ${rig.triangles.toFixed(0)} tris  ${rig.drawCalls} draws  parts=${rig.nodes.size}`);
  }

  /* ---------------------------------------------------------------- hero */
  RigBuilder.debugSplit = DEBUG_PROBE;
  for (let i = 0; i < n; i++) {
    const def = WEAPONS[i];
    const rig = buildWeaponMesh(def, resolveLoadout(def, def.attachments), weaponMats, 'world');
    place(rig, [i * 4, STAND_Y, HERO_Z], heroPose);
    if (DEBUG_PROBE && def.id !== 'ar_vkr7') { for (const m of rig.meshes) m.visible = false; }
    if (DEBUG_PROBE && def.id === 'ar_vkr7') {
      // Flat-shade every (part, material) pair in its own hue so a stray
      // polygon can be traced back to the code that emitted it.
      const box = new THREE.Box3();
      for (let k = 0; k < rig.meshes.length; k++) {
        const m = rig.meshes[k];
        box.setFromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute);
        const size = box.getSize(new THREE.Vector3());
        const hue = (k * 0.3819) % 1;
        m.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(hue, 0.85, 0.5), roughness: 0.6, metalness: 0,
        });
        console.error(`[part] ${k} hue=${hue.toFixed(3)} ${m.name.padEnd(22)} size=${size.toArray().map((v) => v.toFixed(3)).join(',')}`);
      }
      // Pick helper: shoot a ray through a normalised device coordinate and
      // report which submitted geometry owns the surface. This is how a stray
      // polygon gets traced back to one line of builder code.
      const rc = new THREE.Raycaster();
      (globalThis as unknown as { __wpnPick?: (x: number, y: number) => string }).__wpnPick =
        (x: number, y: number) => {
          rc.setFromCamera(new THREE.Vector2(x, y), ctx.camera);
          const hits = rc.intersectObjects(rig.meshes, true);
          return hits.slice(0, 4).map((h) => `${h.object.name}@${h.distance.toFixed(3)}`).join(' | ');
        };
    }
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.55, STAND_Y - 0.14, 0.4), standMat);
    plinth.position.set(i * 4, (STAND_Y - 0.14) / 2, HERO_Z + 0.06);
    plinth.castShadow = true; plinth.receiveShadow = true;
    root.add(plinth);
  }

  RigBuilder.debugSplit = false;

  /* --------------------------------------------------------- attachments */
  const attSets: Array<{ label: string; ids: string[] }> = [
    { label: 'IRONS', ids: ['optic_irons'] },
    { label: 'RED DOT', ids: ['optic_reddot'] },
    { label: 'HOLO', ids: ['optic_holo'] },
    { label: 'ACOG 4x', ids: ['optic_acog'] },
    { label: 'LR-9 9x', ids: ['optic_sniper'] },
    { label: 'SUPPRESSED', ids: ['optic_reddot', 'muzzle_suppressor', 'under_grip'] },
    { label: 'COMP + GRIP', ids: ['optic_holo', 'muzzle_comp', 'under_angled', 'laser_visible'] },
    { label: 'DRUM + BRAKE', ids: ['optic_reddot', 'muzzle_brake', 'mag_drum', 'stock_heavy'] },
    { label: 'NO STOCK', ids: ['optic_reddot', 'muzzle_flash', 'stock_none', 'mag_extended'] },
  ];
  const attDef = weaponDef('ar_vkr7');
  for (let i = 0; i < attSets.length; i++) {
    const set = attSets[i];
    const list = set.ids.map(attachment).filter((a): a is NonNullable<typeof a> => !!a);
    const rig = buildWeaponMesh(attDef, resolveLoadout(attDef, list.map((a) => a.id)), weaponMats, 'world');
    const x = (i - (attSets.length - 1) / 2) * BAY;
    place(rig, [x, STAND_Y, ATT_Z], sidePose);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, STAND_Y - 0.10, 12), standMat);
    post.position.set(x, (STAND_Y - 0.10) / 2, ATT_Z + 0.02);
    post.castShadow = true; post.receiveShadow = true;
    root.add(post);
    root.add(label(set.label, [x, STAND_Y - 0.22, ATT_Z + 0.05], 0.58));
  }

  /* ------------------------------------------------- first-person station */
  // Not a mock-up: this is the real `ViewModel`, in the renderer's real
  // view-model scene, driven by the real animation code. Each shot's `setup`
  // scrubs it to a chosen moment, which is the only honest way to photograph a
  // procedural animation.
  const vm = ws?.viewModel ?? new ViewModel(weaponMats);
  if (!ws) render.viewModelScene.add(vm.root);
  vm.setVisible(true);
  fpViewModel = vm;

  // An enclosed set per bay: three walls close in, a lit floor and some
  // clutter. A first-person weapon photographed against an open sky reads as a
  // silhouette — the value of these shots is the *contrast* between the model
  // and a real environment.
  // Dark walls: a first-person weapon photographed against bright concrete is
  // a silhouette, and the renderer's exposure is fixed in capture mode.
  const wallMat = mats?.material('metal', { triplanar: true, scale: 2, tint: 0x5a5f5c })
    ?? new THREE.MeshStandardMaterial({ color: 0x3a3d3c });
  const floorMat2 = mats?.material('asphalt', { triplanar: true, scale: 2, tint: 0x8a8a8a })
    ?? new THREE.MeshStandardMaterial({ color: 0x2a2b2c });
  const crateMat = mats?.material('crate', {}) ?? new THREE.MeshStandardMaterial({ color: 0x8a6a3a });
  const drumMat = mats?.material('metalThin', {}) ?? new THREE.MeshStandardMaterial({ color: 0x6a6a66 });

  for (let i = 0; i < 4; i++) {
    const cx = i * 8;
    const set = new THREE.Group();
    set.position.set(cx, 0, FP_Z);
    root.add(set);

    const wall = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      set.add(m);
    };
    wall(7.0, 3.6, 0.35, 0, 1.8, -4.4);          // back wall
    wall(0.35, 3.6, 6.0, -3.3, 1.8, -1.6);       // left wall
    wall(0.35, 3.6, 6.0, 3.3, 1.8, -1.6);        // right wall
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.3, 6.0), wallMat);
    ceil.position.set(0, 3.5, -1.6);
    ceil.receiveShadow = true; ceil.castShadow = true;
    set.add(ceil);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(7.0, 6.4), floorMat2);
    fl.rotation.x = -Math.PI / 2;
    fl.position.set(0, 0.01, -1.6);
    fl.receiveShadow = true;
    set.add(fl);

    for (const [x, z, ry] of [[1.5, -2.6, 0.3], [2.0, -3.4, -0.5], [1.35, -3.3, 0.9]] as const) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), crateMat);
      c.position.set(x, 0.37, z);
      c.rotation.y = ry;
      c.castShadow = true; c.receiveShadow = true;
      set.add(c);
    }
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 22), drumMat);
    drum.position.set(-2.0, 0.45, -3.2);
    drum.castShadow = true; drum.receiveShadow = true;
    set.add(drum);
    const drum2 = drum.clone();
    drum2.position.set(-2.55, 0.45, -2.5);
    set.add(drum2);

    // A warm practical light so the set has direction and the weapon has a rim.
    const lamp = new THREE.PointLight(0xffd2a0, 14.0, 10, 2);
    lamp.position.set(-1.6, 2.9, -2.0);
    lamp.name = 'dyn-fp-lamp';
    set.add(lamp);
  }
  equipFp('ar_vkr7');
  installProbe(render);
  fpRender = render;
  fpCamera = ctx.camera;

  const totalTris = rigs.reduce((a, r) => a + r.triangles, 0);
  console.info(`[weapons] debug scene ready — ${rigs.length} rigs, ${(totalTris / 1000).toFixed(1)}k tris total`);
});

/* ------------------------------------------------------------------ shots */

if (DEBUG_SCENE === 'weapons') {
  const shots: ShotDef[] = [
    {
      name: 'wpn-lineup',
      description: 'All eight weapons side-on at a common scale — silhouette and proportion check',
      position: [0, STAND_Y, 6.6], yaw: 0, pitch: 0, fov: 48, viewModel: false, hour: 10.2,
    },
    {
      name: 'wpn-lineup-left',
      description: 'Left half of the lineup at closer range',
      position: [-2.3, STAND_Y, 3.4], yaw: 0, pitch: 0, fov: 46, viewModel: false, hour: 10.2,
    },
    {
      name: 'wpn-lineup-right',
      description: 'Right half of the lineup at closer range',
      position: [2.3, STAND_Y, 3.4], yaw: 0, pitch: 0, fov: 46, viewModel: false, hour: 10.2,
    },
    {
      name: 'wpn-attachments',
      description: 'One rifle wearing nine different attachment loadouts — mesh changes with stats',
      position: [0, STAND_Y, ATT_Z + 7.2], yaw: 0, pitch: 0, fov: 48, viewModel: false, hour: 10.2,
    },
    {
      name: 'wpn-attachments-optics',
      description: 'Optic family close-up: irons, red dot, holographic, ACOG, 9× scope',
      position: [-2.3, STAND_Y, ATT_Z + 2.6], yaw: 0, pitch: 0, fov: 42, viewModel: false, hour: 10.2,
    },
    {
      name: 'wpn-attachments-muzzle',
      description: 'Muzzle and underbarrel family: suppressor, compensator, brake, drum, no stock',
      position: [2.3, STAND_Y, ATT_Z + 2.6], yaw: 0, pitch: 0, fov: 42, viewModel: false, hour: 10.2,
    },
  ];

  for (let i = 0; i < WEAPONS.length; i++) {
    const def = WEAPONS[i];
    shots.push({
      name: `wpn-hero-${def.cls}`,
      description: `${def.name} — 3/4 hero at 1.1 m, the framing a first-person model is judged at`,
      position: [i * 4 + 0.28, STAND_Y + 0.10, HERO_Z + 1.05], yaw: -6, pitch: -4,
      fov: 40, viewModel: false, hour: 10.2,
    });
    shots.push({
      name: `wpn-detail-${def.cls}`,
      description: `${def.name} — receiver, controls and optic at 0.42 m`,
      position: [i * 4 + 0.02, STAND_Y + 0.06, HERO_Z + 0.44], yaw: -4, pitch: -6,
      fov: 34, viewModel: false, hour: 10.2,
    });
  }

  /* --- first person: the live rig, scrubbed to a chosen moment ---------- */
  const fpAt = (i: number): [number, number, number] => [i * 8, 1.62, FP_Z];
  const fp = (
    name: string, description: string, bay: number,
    setup: () => void, fov = 80,
  ): ShotDef => ({
    // Mid-afternoon: the view-model rig is keyed off the sky, so this is the
    // hour at which the weapon's own materials read most honestly.
    name, description, position: fpAt(bay), yaw: 0, pitch: -7, fov,
    viewModel: true, hour: 15.4, setup,
  });

  shots.push(
    fp('wpn-fp-hip', 'VKR-7 view model at rest, hip pose — the default screen framing', 0, () => {
      equipFp('ar_vkr7'); resetFp();
    }),
    fp('wpn-fp-ads', 'VKR-7 fully aimed: the sight is solved onto the eye axis, not hand-placed', 0, () => {
      equipFp('ar_vkr7'); resetFp(); scrub(1.0, { ads: 1 });
    }, 58),
    fp('wpn-fp-sprint', 'VKR-7 sprint pose — canted, lowered, out of the way', 0, () => {
      equipFp('ar_vkr7'); resetFp(); scrub(0.8, { sprint: 1, speed01: 1, stepPhase: 0.3 });
    }),
    fp('wpn-fp-lowready', 'VKR-7 pulled to low ready by a wall in front of the muzzle', 0, () => {
      equipFp('ar_vkr7'); resetFp(); scrub(0.8, { lowReady: 1 });
    }),
    fp('wpn-fp-recoil', 'VKR-7 two frames after a shot: kick, muzzle climb and the bolt back', 0, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.onFire(0.98, 0.02);
      scrub(0.035);
    }),
    fp('wpn-fp-reload-magout', 'VKR-7 mid empty reload — magazine falling clear, bolt held back', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startReload(true, 2.6);
      scrub(0.85, { boltLocked: true, ammo: 0 });
    }),
    fp('wpn-fp-reload-magin', 'VKR-7 seating the fresh magazine', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startReload(true, 2.6);
      scrub(1.55, { boltLocked: true, ammo: 0 });
    }),
    fp('wpn-fp-inspect', 'VKR-7 inspect, rolled over to read the receiver', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startInspect(2.6);
      scrub(0.85);
    }),
    fp('wpn-fp-melee', 'VKR-7 melee bash at full extension', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startMelee(0.72);
      scrub(0.30);
    }),
    fp('wpn-fp-sniper-ads', 'Longbow aimed through the 9x scope — eye relief and sight alignment', 2, () => {
      equipFp('sr_longbow'); resetFp(); scrub(1.4, { ads: 1 });
    }, 44),
    fp('wpn-fp-smg-hip', 'Hornet SMG hip pose', 2, () => {
      equipFp('smg_hornet'); resetFp();
    }),
    fp('wpn-fp-shotgun-hip', 'Breaker 12 hip pose', 3, () => {
      equipFp('sg_breaker'); resetFp();
    }),
    fp('wpn-fp-pistol-ads', 'Sidewinder aimed — irons on the slide, solved onto the eye axis', 3, () => {
      equipFp('pi_sidewinder'); resetFp(); scrub(0.9, { ads: 1 });
    }, 66),
    fp('wpn-fp-launcher-hip', 'Ravager RPG shouldered', 3, () => {
      equipFp('lch_ravager'); resetFp();
    }),
    fp('wpn-fp-draw', 'VKR-7 mid-draw, coming up from the low carry', 2, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startDraw(0.62);
      scrub(0.22);
    }),

    /* --- optics: the reticle is the thing being photographed here -------- */
    fp('wpn-fp-ads-reddot', 'Red dot aimed — 2 MOA collimated dot on the eye axis', 0, () => {
      equipFp('ar_vkr7', ['optic_reddot']); resetFp(); scrub(1.0, { ads: 1 });
    }, 58),
    fp('wpn-fp-ads-holo', 'Holographic aimed — 65 MOA ring and centre dot', 0, () => {
      equipFp('ar_vkr7', ['optic_holo']); resetFp(); scrub(1.0, { ads: 1 });
    }, 58),
    fp('wpn-fp-ads-acog', 'ACOG aimed — etched chevron and ranging post', 0, () => {
      equipFp('ar_vkr7', ['optic_acog']); resetFp(); scrub(1.2, { ads: 1 });
    }, 50),
    fp('wpn-fp-ads-irons', 'Iron sights aimed — post in the notch, nothing illuminated', 0, () => {
      equipFp('ar_vkr7', ['optic_irons']); resetFp(); scrub(1.0, { ads: 1 });
    }, 58),
    fp('wpn-fp-ads-offaxis', 'Red dot with the weapon still settling — the dot slides, as a collimated sight must', 0, () => {
      equipFp('ar_vkr7', ['optic_reddot']); resetFp();
      scrub(1.0, { ads: 1 });
      scrub(0.06, { ads: 1, lookDX: 34, lookDY: -12 });
    }, 58),

    /* --- the flash has to light the weapon, not just the world ---------- */
    fp('wpn-fp-flash', 'VKR-7 one frame into a shot, lit by a held muzzle flash at the crown', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.onFire(0.98, 0.02);
      scrub(0.030);
      holdMuzzleFlash(190);
    }),
    fp('wpn-fp-flash-ads', 'Aimed, lit by the muzzle flash — the hood and barrel catch it', 1, () => {
      equipFp('ar_vkr7'); resetFp(); scrub(1.0, { ads: 1 });
      fpViewModel?.onFire(0.98, 0.02);
      scrub(0.030, { ads: 1 });
      holdMuzzleFlash(190);
    }, 58),

    /* --- reload: the parts have to actually move ------------------------ */
    fp('wpn-fp-reload-magfall', 'VKR-7 empty reload, magazine clear of the well and tumbling', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startReload(true, 2.6);
      scrub(0.62, { boltLocked: true, ammo: 0 });
    }, 70),
    fp('wpn-fp-reload-boltdrop', 'VKR-7 the instant the bolt is released and runs home', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startReload(true, 2.6);
      scrub(2.02, { boltLocked: true, ammo: 0 });
    }, 70),
    fp('wpn-fp-charge', 'VKR-7 charging handle and bolt at full travel during the inspect', 1, () => {
      equipFp('ar_vkr7'); resetFp();
      fpViewModel?.startInspect(2.6);
      scrub(1.56);
    }, 70),
  );

  // Give every shot the extra settle it needs, without repeating it fifteen times.
  for (const sh of shots) {
    const inner = sh.setup;
    sh.setup = async () => {
      afterSettle = null;
      await inner?.();
      settleFrames(56);
      // Transient effects go in last, on a short settle that TAA can still
      // resolve but that is far too short for them to decay away.
      const post = takeAfterSettle();
      if (post) { post(); settleFrames(3); }
    };
  }

  registerShots(shots);
}
