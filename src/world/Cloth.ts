/**
 * Wind-moved cloth: awnings, tarpaulins, banners and curtains.
 *
 * Nothing makes a static level read as *alive* more cheaply than a few square
 * metres of moving fabric. These are the only vertex-animated surfaces in the
 * level; they are deliberately few and small (about 2 500 vertices in total, one
 * pass per frame) and their amplitude is kept low so the renderer's temporal
 * passes do not smear them.
 *
 * The motion is a deterministic sum of incommensurate sines driven by the
 * shared clock — no RNG per frame, so a capture is reproducible.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import { settings } from '../core/Settings';
import { tagSurface } from '../core/Surfaces';
import type { MatCatalog, MatKey } from './MatCatalog';

type ClothKind = 'hang' | 'awning' | 'banner';

interface Panel {
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
  rest: Float32Array;
  nx: number;
  ny: number;
  kind: ClothKind;
  phase: number;
  stiffness: number;
  amplitude: number;
}

export interface ClothSpec {
  kind: ClothKind;
  x: number; y: number; z: number;
  yaw: number;
  width: number;
  /** Drop for 'hang'/'banner', projection for 'awning'. */
  length: number;
  key: MatKey;
  /** Extra sag in the middle, metres. */
  sag?: number;
  /** Torn: the lower corner is cut away. */
  torn?: boolean;
}

export class ClothSystem {
  readonly root = new THREE.Group();
  private panels: Panel[] = [];
  private time = 0;
  private wind = 0.55;

  constructor() {
    this.root.name = 'cloth';
  }

  setWind(w: number): void { this.wind = THREE.MathUtils.clamp(w, 0, 2); }

  build(specs: ClothSpec[], cat: MatCatalog): void {
    const rand = new Rand(0xc10714);
    for (const spec of specs) {
      const nx = spec.kind === 'awning' ? 8 : 7;
      const ny = spec.kind === 'awning' ? 6 : 9;
      const geo = new THREE.BufferGeometry();
      const verts = new Float32Array((nx + 1) * (ny + 1) * 3);
      const uvs = new Float32Array((nx + 1) * (ny + 1) * 2);
      const idx: number[] = [];

      for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
          const u = i / nx;
          const v = j / ny;
          const k = (j * (nx + 1) + i) * 3;
          const x = (u - 0.5) * spec.width;
          let y: number, z: number;
          if (spec.kind === 'awning') {
            // Pinned along v = 0 at the wall, sloping down and out.
            y = -v * spec.length * 0.34;
            z = v * spec.length;
          } else {
            const sag = (spec.sag ?? 0) * Math.sin(Math.PI * u);
            y = -v * spec.length - sag * v;
            z = 0;
          }
          verts[k] = x; verts[k + 1] = y; verts[k + 2] = z;
          const t = (j * (nx + 1) + i) * 2;
          uvs[t] = u; uvs[t + 1] = v;
        }
      }
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (spec.torn && i > nx - 3 && j > ny - 3) continue;   // ragged corner
          const a = j * (nx + 1) + i;
          const b = a + 1;
          const c = a + nx + 1;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const mesh = new THREE.Mesh(geo, cat.get(spec.key));
      mesh.position.set(spec.x, spec.y, spec.z);
      mesh.rotation.y = spec.yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      mesh.name = `cloth:${spec.kind}`;
      const ud = mesh.userData as Record<string, unknown>;
      ud.noCollide = true;
      ud.navIgnore = true;
      tagSurface(mesh, 'fabric');
      this.root.add(mesh);

      this.panels.push({
        mesh,
        positions: geo.getAttribute('position') as THREE.BufferAttribute,
        rest: verts.slice(),
        nx, ny,
        kind: spec.kind,
        phase: rand.range(0, Math.PI * 2),
        stiffness: spec.kind === 'awning' ? 0.55 : 1.0,
        amplitude: spec.kind === 'banner' ? 0.16 : 0.1,
      });
    }
  }

  update(dt: number): void {
    this.time += dt;
    // The 'low' preset freezes cloth: it is the cheapest thing to give up.
    if (settings.preset === 'low') return;
    const t = this.time;
    const w = this.wind;

    for (const p of this.panels) {
      const arr = p.positions.array as Float32Array;
      const rest = p.rest;
      const stride = p.nx + 1;
      for (let j = 0; j <= p.ny; j++) {
        const v = j / p.ny;
        // Pinned edge does not move; motion grows quadratically with distance.
        const gain = v * v * p.amplitude * w * p.stiffness;
        if (gain < 1e-5) continue;
        for (let i = 0; i <= p.nx; i++) {
          const k = (j * stride + i) * 3;
          const u = i / p.nx;
          const ph = p.phase + u * 3.1;
          const flap = Math.sin(t * 2.3 + ph) * 0.6
            + Math.sin(t * 3.9 + ph * 1.7) * 0.28
            + Math.sin(t * 1.1 + ph * 0.6) * 0.5;
          const gust = 0.6 + 0.4 * Math.sin(t * 0.37 + p.phase);
          arr[k] = rest[k] + flap * gain * 0.35 * gust;
          arr[k + 1] = rest[k + 1] + Math.abs(flap) * gain * 0.18 * gust;
          arr[k + 2] = rest[k + 2] + flap * gain * gust;
        }
      }
      p.positions.needsUpdate = true;
      p.mesh.geometry.computeVertexNormals();
    }
  }

  dispose(): void {
    for (const p of this.panels) p.mesh.geometry.dispose();
    this.panels.length = 0;
    this.root.clear();
  }
}

/**
 * The level's cloth placements: shop awnings over the square's shopfronts,
 * tarpaulins on the scaffolded facades, banners across the lanes and curtains
 * hanging out of the blown-open windows.
 */
export function levelCloth(): ClothSpec[] {
  const out: ClothSpec[] = [];
  const rand = new Rand(0xa11e);

  // Awnings over the shop rows facing the square.
  const awningKeys: MatKey[] = ['canvasRed', 'canvasGreen', 'canvasCream'];
  for (let i = 0; i < 3; i++) {
    const z = -30 + i * 8;
    out.push({
      kind: 'awning', x: -15.0, y: 3.35, z, yaw: -Math.PI / 2,
      width: 3.6, length: 1.5, key: awningKeys[i % 3], torn: rand.bool(0.4),
    });
  }
  for (let i = 0; i < 3; i++) {
    const z = -2 + i * 7;
    out.push({
      kind: 'awning', x: -15.0, y: 3.35, z, yaw: -Math.PI / 2,
      width: 3.6, length: 1.5, key: awningKeys[(i + 1) % 3], torn: rand.bool(0.4),
    });
  }
  for (let i = 0; i < 3; i++) {
    const z = -30 + i * 8;
    out.push({
      kind: 'awning', x: 15.0, y: 3.35, z, yaw: Math.PI / 2,
      width: 3.6, length: 1.5, key: awningKeys[(i + 2) % 3], torn: rand.bool(0.4),
    });
  }
  for (let i = 0; i < 3; i++) {
    const z = -2 + i * 7;
    out.push({
      kind: 'awning', x: 15.0, y: 3.35, z, yaw: Math.PI / 2,
      width: 3.6, length: 1.5, key: awningKeys[i % 3], torn: rand.bool(0.4),
    });
  }
  // Café awning on lane A.
  out.push({ kind: 'awning', x: -36.6, y: 3.3, z: 3.0, yaw: Math.PI / 2, width: 5.0, length: 1.8, key: 'canvasRed' });

  // Tarpaulins hanging off balconies and scaffold.
  const tarps: [number, number, number, number][] = [
    [-36.5, 6.6, -50.0, Math.PI / 2],
    [-36.5, 9.7, -27.0, Math.PI / 2],
    [-36.5, 6.5, -13.0, Math.PI / 2],
    [-15.2, 7.1, -19.0, -Math.PI / 2],
    [15.2, 7.1, 12.0, Math.PI / 2],
    [29.8, 6.8, 20.0, -Math.PI / 2],
    [-11.6, 4.9, 41.0, 0],
    [11.6, 7.8, 36.2, 0],
  ];
  for (const [x, y, z, yaw] of tarps) {
    out.push({
      kind: 'hang', x, y, z, yaw,
      width: rand.range(1.5, 2.6), length: rand.range(1.6, 2.9),
      key: rand.pick(awningKeys), sag: 0.12, torn: rand.bool(0.5),
    });
  }

  // Banners hung off facades rather than floating mid-street: a banner with no
  // visible fixing reads as a bug, not as dressing.
  out.push({ kind: 'banner', x: -14.6, y: 6.4, z: -22.0, yaw: -Math.PI / 2, width: 2.6, length: 3.4, key: 'canvasRed', sag: 0.05 });
  out.push({ kind: 'banner', x: 14.6, y: 6.4, z: -4.0, yaw: Math.PI / 2, width: 2.6, length: 3.2, key: 'canvasGreen', sag: 0.05 });
  out.push({ kind: 'banner', x: -36.2, y: 6.2, z: -46.0, yaw: Math.PI / 2, width: 2.2, length: 3.0, key: 'canvasCream', sag: 0.05 });
  out.push({ kind: 'banner', x: 29.4, y: 6.6, z: 14.0, yaw: -Math.PI / 2, width: 2.4, length: 3.2, key: 'canvasRed', sag: 0.05 });

  // Curtains blowing out of blown-open windows.
  const curtains: [number, number, number, number][] = [
    [-36.7, 6.4, -33.0, Math.PI / 2],
    [-36.7, 9.6, -19.0, Math.PI / 2],
    [16.6, 5.2, -20.0, -Math.PI / 2],
    [-1.0, 8.6, 35.6, 0],
    [40.0, 7.4, 3.8, 0],
  ];
  for (const [x, y, z, yaw] of curtains) {
    out.push({ kind: 'hang', x, y, z, yaw, width: 0.9, length: 1.6, key: 'canvasCream', sag: 0.05, torn: true });
  }

  return out;
}
