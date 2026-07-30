/**
 * Capture shots and debug scenes for the level.
 *
 * The shot list is the level's contract with the critic: every vantage that
 * matters — each lane at eye level, the rooftop route, two interiors, the hero
 * sightlines and one wide establishing shot — is here, so a regression in
 * composition, lighting or LOD shows up in the contact sheet.
 */

import * as THREE from 'three';
import type { ShotDef } from '../core/CaptureAPI';
import { registerDebugScene, registerShots } from '../core/Shots';
import type { EngineContext } from '../core/Engine';
import type { WorldSystem } from './World';
import { MatCatalog } from './MatCatalog';
import { Chunk } from './geom/Chunk';
import type { MaterialSystem } from '../material/MaterialLibrary';
import { allProps } from './props/Props';
import { Rand } from '../core/Rand';

export const WORLD_SHOTS: ShotDef[] = [
  {
    name: 'overview',
    description: 'High establishing shot of the whole square from the south-east, town hall and clock tower on the skyline',
    position: [40, 26, 42], yaw: 39.8, pitch: -18.6, fov: 62, viewModel: false,
  },
  {
    name: 'square-north',
    description: 'Player eye level in the centre of the square looking north at the town hall arcade, tram and craters in the midground',
    position: [1.5, 1.72, 14], yaw: 1.5, pitch: -1.5, fov: 80,
  },
  {
    name: 'square-south',
    description: 'Eye level from the town hall steps looking south down the full length of the square',
    position: [0, 2.95, -34.5], yaw: -179.4, pitch: -1.6, fov: 80,
  },
  {
    name: 'tram',
    description: 'Close on the toppled tram: foreground barrier, tram in the midground, shop row and skyline behind',
    position: [7.5, 1.72, 5.0], yaw: 37.7, pitch: -1.3, fov: 75,
  },
  {
    name: 'arcade',
    description: 'Under the town hall arcade looking out across the raised terrace into the square — deep shade against a bright exterior',
    position: [-4.6, 3.1, -41.5], yaw: -166.6, pitch: -1.6, fov: 78,
  },
  {
    name: 'lane-a',
    description: 'West street at eye level: terrace facades, fire escape, overhead cables and the café awning down the lane',
    position: [-30.0, 1.72, 20.0], yaw: 0.5, pitch: -1.5, fov: 80,
  },
  {
    name: 'lane-c',
    description: 'East street at eye level looking north past the warehouse roller door to the clinic',
    position: [30.5, 1.72, 24.0], yaw: 0.4, pitch: -1.5, fov: 80,
  },
  {
    name: 'rooftop',
    description: 'On the west terrace roof looking across the square — the rooftop flanking route with the clock tower centred',
    position: [-43.0, 10.6, -20.0], yaw: -58.8, pitch: -1.8, fov: 78,
  },
  {
    name: 'rooftop-route',
    description: 'Along the terrace roof to the north, plant and aerials breaking the skyline, blown roof hole in the foreground',
    position: [-43.5, 10.6, -8.0], yaw: 0.0, pitch: -5.0, fov: 80,
  },
  {
    name: 'warehouse',
    description: 'Warehouse interior from the mezzanine: trusses overhead, roller door light on the far wall, crates below',
    position: [44.0, 5.9, -25.0], yaw: 102.3, pitch: -14.7, fov: 78,
  },
  {
    name: 'interior-flat',
    description: 'Inside a first-floor terrace flat looking out of a blown-open window on to lane A — interior ambient against exterior key',
    position: [-44.5, 5.3, -14.5], yaw: -92.0, pitch: -2.8, fov: 80,
  },
  {
    name: 'market',
    description: 'Market stalls on the east side of the square, awnings catching the low sun, stalls layered into depth',
    position: [4.5, 1.72, -12.0], yaw: -25.6, pitch: -0.8, fov: 78,
  },
  {
    name: 'alley',
    description: 'Service alley behind the west shop row: dumpsters, fire escape, laundry lines and a tight sightline',
    position: [-27.5, 1.85, -7.6], yaw: -91.8, pitch: -1.5, fov: 80,
  },
  {
    name: 'arch-passage',
    description: 'Through the carriage arch under the south apartments, framing the square beyond',
    position: [-1.0, 1.72, 47.0], yaw: -0.8, pitch: -1.0, fov: 76,
  },
  {
    name: 'fountain',
    description: 'Dry fountain at the square centre with the arcade and terrace behind, low sun raking across the cobbles',
    position: [6.0, 1.72, -14.5], yaw: 40.2, pitch: -4.8, fov: 76,
  },
  {
    name: 'crater',
    description: 'Low over a shell crater and its standing water — reflection, wet dirt and rubble detail at close range',
    position: [9.2, 1.15, 3.5], yaw: 26.1, pitch: -14.2, fov: 70,
  },
  {
    name: 'skyline',
    description: 'Low angle on the clock tower with the distant city backdrop and mountain ridge behind',
    position: [2.0, 1.4, -28.0], yaw: 4.8, pitch: 24.0, fov: 72, viewModel: false,
  },
  {
    name: 'north-street',
    description: 'North cross street looking east past the clinic — the long flanking route with wrecks and barriers layered in',
    position: [-16.0, 1.72, -36.0], yaw: -89.5, pitch: -1.5, fov: 80,
  },
];

/** Registers the level's shots and its debug scenes. */
export function registerWorldShots(world: WorldSystem): void {
  registerShots(WORLD_SHOTS);
  registerDebugScene('nav', (ctx: EngineContext) => {
    world.setNavDebug(true);
    void ctx;
  });
  registerDebugScene('propgrid', (ctx: EngineContext) => buildPropGrid(ctx));
  registerShots([
    {
      name: 'nav-overview',
      description: 'Navmesh polygons, cover points and traversal links over the whole map',
      position: [0, 62, 46], yaw: 0.0, pitch: -50.0, fov: 62, viewModel: false,
    },
    {
      name: 'nav-square',
      description: 'Navmesh detail across the square: polygons around the tram, craters and barriers',
      position: [6, 16, 10], yaw: 15.3, pitch: -35.1, fov: 70, viewModel: false,
    },
    {
      name: 'prop-grid-a',
      description: 'Prop library sheet, first rows',
      position: [0, 4.2, 12], yaw: 0.0, pitch: -17.7, fov: 55, viewModel: false,
    },
    {
      name: 'prop-grid-b',
      description: 'Prop library sheet, later rows',
      position: [0, 4.2, -6], yaw: 0.0, pitch: -17.7, fov: 55, viewModel: false,
    },
  ]);
}

/**
 * Debug scene: every prop in the library on a lit turntable grid, so silhouette
 * and scale regressions are obvious at a glance.
 */
function buildPropGrid(ctx: EngineContext): void {
  const { engine, scene } = ctx;
  const mats = engine.tryGet<MaterialSystem>('materials') ?? null;
  const cat = new MatCatalog(mats);

  const world = engine.tryGet<WorldSystem>('world');
  if (world) world.root.visible = false;

  const group = new THREE.Group();
  group.name = 'prop-grid';
  const chunk = new Chunk();
  const props = allProps();
  const cols = 9;
  const spacing = 3.0;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const x = ((i % cols) - (cols - 1) / 2) * spacing;
    const z = -Math.floor(i / cols) * spacing + 12;
    const sub = new Chunk();
    p.build(sub, new Rand(`grid:${p.id}`));
    for (const key of sub.keys) {
      const src = sub.m(key);
      const dst = chunk.m(key);
      dst.pushTRS(x, 0, z);
      // Re-emit the prop's triangles under the grid transform.
      const base = dst.vertexCount;
      for (let v = 0; v < src.pos.length; v += 3) {
        dst.vertex(src.pos[v], src.pos[v + 1], src.pos[v + 2],
          src.nor[v], src.nor[v + 1], src.nor[v + 2],
          src.uv[(v / 3) * 2], src.uv[(v / 3) * 2 + 1]);
      }
      for (let k = 0; k < src.idx.length; k += 3) {
        dst.tri(base + src.idx[k], base + src.idx[k + 1], base + src.idx[k + 2]);
      }
      dst.pop();
    }
  }
  // Ground plate.
  chunk.m('concrete').grid(-18, -30, 18, 18, 18, 24, () => 0, 2.2);
  chunk.emit(group, cat, { name: 'propgrid' });
  scene.add(group);
}
