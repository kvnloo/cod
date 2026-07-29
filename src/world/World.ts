/**
 * WorldSystem — level geometry, props, lighting design, streaming and navigation
 * data.
 *
 * STUB: a grey-box arena so the renderer and player have something to work with.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { tagSurface } from '../core/Surfaces';
import type { MaterialSystem } from '../material/MaterialLibrary';
import type { ShotDef } from '../core/CaptureAPI';

export interface SpawnPoint { position: THREE.Vector3; yaw: number; team: 'player' | 'enemy' | 'neutral'; }
export interface CoverPoint { position: THREE.Vector3; normal: THREE.Vector3; height: 'low' | 'high'; }

export class WorldSystem implements System {
  readonly name = 'world';
  readonly order = ORDER.WORLD;

  readonly root = new THREE.Group();
  spawns: SpawnPoint[] = [];
  cover: CoverPoint[] = [];
  bounds = new THREE.Box3(new THREE.Vector3(-60, -2, -60), new THREE.Vector3(60, 30, 60));

  async init(ctx: EngineContext): Promise<void> {
    const mats = ctx.engine.tryGet<MaterialSystem>('materials');
    this.root.name = 'world';
    ctx.scene.add(this.root);

    const groundMat = mats?.get('concrete', { scale: 4 }) ?? new THREE.MeshStandardMaterial({ color: 0x8a8a8a });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160, 1, 1), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    tagSurface(ground, 'concrete');
    this.root.add(ground);

    // A few blocks so there is depth, occlusion and shadow contact to judge.
    const blockMat = mats?.get('brick') ?? new THREE.MeshStandardMaterial({ color: 0x8a4c3a });
    for (let i = 0; i < 12; i++) {
      const w = 2 + (i % 4), h = 2 + ((i * 7) % 6), d = 2 + ((i * 3) % 5);
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
      const a = (i / 12) * Math.PI * 2;
      b.position.set(Math.cos(a) * 14, h / 2, Math.sin(a) * 14);
      b.rotation.y = a;
      b.castShadow = true;
      b.receiveShadow = true;
      tagSurface(b, 'brick');
      this.root.add(b);
    }

    this.spawns.push({ position: new THREE.Vector3(0, 1.7, 8), yaw: 180, team: 'player' });

    // Provisional lighting so the grey-box is legible before the real lighting
    // rig replaces it.
    const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
    sun.position.set(24, 34, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 120;
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    ctx.scene.add(sun);
    ctx.scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x54402c, 0.6));
    ctx.scene.background = new THREE.Color(0x8fb2d9);
    ctx.scene.fog = new THREE.FogExp2(0x93b4d6, 0.008);
  }

  /** Camera shots this level exposes to the capture harness. */
  captureShots(): ShotDef[] {
    return [
      {
        name: 'overview', description: 'Wide establishing shot of the play space',
        position: [22, 9, 24], yaw: -135, pitch: -14, fov: 70, viewModel: false,
      },
      {
        name: 'eye-level', description: 'Player eye-level view down the main lane',
        position: [0, 1.72, 16], yaw: 180, pitch: -2, fov: 80,
      },
    ];
  }
}
