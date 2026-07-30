/**
 * The prop library: fifty-odd procedurally modelled objects with real
 * silhouettes.
 *
 * Every prop is authored centred on the origin in XZ and sitting on y = 0,
 * facing +Z. Props write into a `Chunk`, so one prop can use several materials
 * and the instancer will emit one `InstancedMesh` per material with a shared
 * transform list.
 *
 * Two rules the whole library follows, both straight off the visual bar:
 *  - **Chamfered edges** on anything the player gets close to. A 1–2 cm bevel is
 *    what makes a crate read as a made object rather than a textured cube.
 *  - **Broken silhouettes**: nothing is a plain box. Barrels get rolling hoops,
 *    crates get corner battens, barriers get their moulded taper and lifting
 *    slots, dumpsters get lids and casters.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { MatKey } from '../MatCatalog';
import { Chunk } from '../geom/Chunk';
import { FACE, V3, catenary } from '../geom/Mesher';

export interface PropDef {
  id: string;
  /** Builds the prop at the origin. */
  build(chunk: Chunk, rand: Rand): void;
  /** How physics should treat instances of this prop. */
  collide?: 'box' | 'none';
  /** Planar radius used for scatter spacing and nav marking. */
  radius: number;
  /** Height, for nav clearance and cover classification. */
  height: number;
  /** Instances never cast shadows (wires, ground clutter). */
  noShadow?: boolean;
  /** Suppress from the navigation voxelisation (thin decoration). */
  navIgnore?: boolean;
  /** LOD: distance past which the cheap silhouette version is used. */
  lodDistance?: number;
}

const P: Record<string, PropDef> = {};
function def(d: PropDef): void { P[d.id] = d; }
export function propDef(id: string): PropDef | undefined { return P[id]; }
export function allProps(): PropDef[] { return Object.values(P); }

/* ======================================================= crates & boxes == */

def({
  id: 'crateSmall', radius: 0.45, height: 0.62, collide: 'box',
  build(c) {
    const m = c.m('crate');
    m.chamferBox(0, 0.31, 0, 0.31, 0.31, 0.31, 0.018, 0.62);
    // corner battens
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      m.box(sx * 0.295, 0.31, sz * 0.295, 0.032, 0.30, 0.032, 0.4);
    }
    m.box(0, 0.615, 0, 0.30, 0.012, 0.30, 0.6, FACE.PY);
  },
});

def({
  id: 'crateLarge', radius: 0.78, height: 1.05, collide: 'box',
  build(c) {
    const m = c.m('crate');
    m.chamferBox(0, 0.52, 0, 0.55, 0.52, 0.45, 0.022, 1.1);
    for (const sy of [0.14, 0.9]) {
      m.box(0, sy, 0, 0.565, 0.045, 0.465, 0.5);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      m.box(sx * 0.53, 0.52, sz * 0.43, 0.038, 0.5, 0.038, 0.4);
    }
    const s = c.m('rust');
    for (const sx of [-1, 1]) s.box(sx * 0.56, 0.52, 0, 0.006, 0.06, 0.44, 0.3);
  },
});

def({
  id: 'ammoCrate', radius: 0.6, height: 0.42, collide: 'box',
  build(c) {
    const m = c.m('crate');
    m.chamferBox(0, 0.19, 0, 0.55, 0.19, 0.26, 0.015, 0.8);
    m.box(0, 0.4, 0, 0.56, 0.025, 0.27, 0.8);
    const s = c.m('rust');
    for (const sx of [-1, 1]) {
      s.box(sx * 0.5, 0.19, 0, 0.008, 0.18, 0.27, 0.3);
      s.box(sx * 0.575, 0.28, 0, 0.02, 0.05, 0.09, 0.2);
    }
    s.box(0, 0.42, 0, 0.09, 0.02, 0.05, 0.2);
  },
});

def({
  id: 'ammoBoxMetal', radius: 0.32, height: 0.28, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    m.chamferBox(0, 0.13, 0, 0.28, 0.13, 0.15, 0.012, 0.5);
    m.box(0, 0.265, 0, 0.285, 0.012, 0.155, 0.5);
    const h = c.m('rust');
    h.pushTRS(0, 0.30, 0, 0, 0, Math.PI / 2);
    h.torus(0.06, 0.008, 8, 5, 0.2, Math.PI);
    h.pop();
  },
});

def({
  id: 'toolbox', radius: 0.3, height: 0.28, collide: 'box',
  build(c) {
    const m = c.m('hazard');
    m.chamferBox(0, 0.12, 0, 0.26, 0.12, 0.13, 0.012, 0.4);
    const h = c.m('steel');
    h.box(0, 0.27, 0, 0.06, 0.012, 0.012, 0.2);
    for (const sx of [-1, 1]) h.box(sx * 0.05, 0.2, 0, 0.008, 0.08, 0.008, 0.2);
  },
});

def({
  id: 'cardboardStack', radius: 0.42, height: 0.7, collide: 'box',
  build(c, rand) {
    const m = c.m('plywood');
    let y = 0;
    for (let i = 0; i < 3; i++) {
      const w = 0.36 - i * 0.05, d = 0.28 - i * 0.03, h = 0.2;
      m.pushTRS(rand.range(-0.04, 0.04), y + h * 0.5, rand.range(-0.04, 0.04), rand.range(-0.25, 0.25));
      m.box(0, 0, 0, w, h * 0.5, d, 0.7);
      m.pop();
      y += h;
    }
  },
});

/* =========================================================== containers == */

def({
  id: 'barrel', radius: 0.32, height: 0.9, collide: 'box',
  build(c) {
    const m = c.m('rust');
    m.pushTRS(0, 0.44, 0);
    m.cylinder(0.29, 0.29, 0.88, 14, true, true, 0.9);
    m.pop();
    for (const y of [0.2, 0.44, 0.68]) {
      m.pushTRS(0, y, 0);
      m.cylinder(0.305, 0.305, 0.05, 14, false, false, 0.4);
      m.pop();
    }
    m.pushTRS(0, 0.885, 0);
    m.cylinder(0.30, 0.30, 0.03, 14, true, false, 0.4);
    m.pop();
    const cap = c.m('steel');
    cap.pushTRS(0.14, 0.905, 0.05);
    cap.cylinder(0.045, 0.045, 0.03, 8, true, false, 0.2);
    cap.pop();
  },
});

def({
  id: 'barrelBurning', radius: 0.34, height: 0.95, collide: 'box',
  build(c) {
    const m = c.m('rust');
    m.pushTRS(0, 0.44, 0);
    m.cylinder(0.29, 0.30, 0.88, 14, false, true, 0.9);
    m.pop();
    for (const y of [0.24, 0.6]) {
      m.pushTRS(0, y, 0);
      m.cylinder(0.31, 0.31, 0.05, 14, false, false, 0.4);
      m.pop();
    }
    // charred contents glowing in the mouth
    const g = c.m('ember');
    g.pushTRS(0, 0.82, 0);
    g.cylinder(0.27, 0.24, 0.07, 12, true, false, 0.3);
    g.pop();
  },
});

def({
  id: 'jerryCan', radius: 0.2, height: 0.46, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    m.chamferBox(0, 0.22, 0, 0.09, 0.22, 0.17, 0.02, 0.4);
    m.box(0, 0.46, 0, 0.06, 0.03, 0.1, 0.2);
    const h = c.m('steel');
    h.box(0, 0.47, 0, 0.05, 0.015, 0.02, 0.2);
  },
});

def({
  id: 'dumpster', radius: 1.2, height: 1.35, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    // tapered body
    m.pushTRS(0, 0.62, 0);
    m.box(0, 0, 0, 1.0, 0.5, 0.58, 1.2, FACE.ALL & ~FACE.PY);
    m.pop();
    m.box(0, 1.12, 0, 1.02, 0.03, 0.6, 1.2);
    // ribs
    for (let i = -2; i <= 2; i++) {
      m.box(i * 0.36, 0.62, 0.6, 0.035, 0.5, 0.025, 0.4);
      m.box(i * 0.36, 0.62, -0.6, 0.035, 0.5, 0.025, 0.4);
    }
    const lid = c.m('plastic');
    lid.pushTRS(0, 1.16, -0.32, 0, -0.35, 0);
    lid.box(0, 0, 0, 1.0, 0.03, 0.3, 1.0);
    lid.pop();
    lid.box(0, 1.17, 0.3, 1.0, 0.03, 0.3, 1.0);
    const w = c.m('rubber');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      w.pushTRS(sx * 0.85, 0.11, sz * 0.45, 0, 0, Math.PI / 2);
      w.cylinder(0.11, 0.11, 0.07, 10, true, true, 0.3);
      w.pop();
    }
  },
});

def({
  id: 'wheelieBin', radius: 0.42, height: 1.1, collide: 'box',
  build(c) {
    const m = c.m('plastic');
    m.pushTRS(0, 0.52, 0);
    m.box(0, 0, 0, 0.31, 0.5, 0.27, 0.8, FACE.ALL & ~FACE.PY);
    m.pop();
    m.pushTRS(0, 1.06, -0.05, 0, -0.2, 0);
    m.box(0, 0, 0, 0.32, 0.03, 0.29, 0.8);
    m.pop();
    const w = c.m('rubber');
    for (const sx of [-1, 1]) {
      w.pushTRS(sx * 0.27, 0.09, -0.19, 0, 0, Math.PI / 2);
      w.cylinder(0.09, 0.09, 0.05, 8, true, true, 0.2);
      w.pop();
    }
  },
});

def({
  id: 'binRound', radius: 0.28, height: 0.95, collide: 'box',
  build(c) {
    const m = c.m('grate');
    m.pushTRS(0, 0.52, 0);
    m.cylinder(0.24, 0.26, 0.72, 12, false, false, 0.6);
    m.pop();
    const s = c.m('rust');
    s.pushTRS(0, 0.9, 0);
    s.cylinder(0.27, 0.27, 0.05, 12, false, false, 0.3);
    s.pop();
    s.pushTRS(0, 0.08, 0);
    s.cylinder(0.09, 0.09, 0.16, 8, false, false, 0.3);
    s.pop();
    s.box(0, 0.01, 0, 0.22, 0.02, 0.22, 0.3);
  },
});

def({
  id: 'trashBag', radius: 0.32, height: 0.5, collide: 'none',
  build(c, rand) {
    const m = c.m('plastic');
    m.pushTRS(0, 0.24, 0, rand.next() * 3);
    m.lump(0.3, 9, 6, (i) => 0.72 + 0.38 * fract(Math.sin(i * 12.9898) * 43758.5), 0.6);
    m.pop();
    m.pushTRS(0, 0.46, 0);
    m.cylinder(0.07, 0.03, 0.12, 6, false, false, 0.2);
    m.pop();
  },
});

/* =============================================== pallets, spools, tyres == */

def({
  id: 'pallet', radius: 0.75, height: 0.14, collide: 'box',
  build(c) {
    const m = c.m('plank');
    for (let i = 0; i < 3; i++) {
      const z = -0.4 + i * 0.4;
      m.box(0, 0.045, z, 0.6, 0.045, 0.07, 0.6);
    }
    for (let i = 0; i < 6; i++) {
      const z = -0.4 + i * 0.16;
      m.box(0, 0.115, z, 0.6, 0.012, 0.06, 0.6);
    }
    for (let i = 0; i < 3; i++) {
      const z = -0.4 + i * 0.4;
      m.box(0, 0.006, z, 0.6, 0.012, 0.06, 0.6);
    }
  },
});

def({
  id: 'palletStack', radius: 0.78, height: 0.75, collide: 'box',
  build(c, rand) {
    const m = c.m('plank');
    for (let s = 0; s < 5; s++) {
      const yaw = rand.range(-0.06, 0.06);
      const y = s * 0.15;
      m.pushTRS(rand.range(-0.03, 0.03), y, rand.range(-0.03, 0.03), yaw);
      for (let i = 0; i < 3; i++) m.box(0, 0.045, -0.4 + i * 0.4, 0.6, 0.045, 0.07, 0.6);
      for (let i = 0; i < 6; i++) m.box(0, 0.115, -0.4 + i * 0.16, 0.6, 0.012, 0.06, 0.6);
      m.pop();
    }
  },
});

def({
  id: 'cableSpool', radius: 0.75, height: 1.4, collide: 'box',
  build(c) {
    const m = c.m('plank');
    for (const sz of [-1, 1]) {
      m.pushTRS(0, 0.7, sz * 0.32, 0, 0, Math.PI / 2);
      m.cylinder(0.7, 0.7, 0.07, 16, true, true, 0.7);
      m.pop();
    }
    const core = c.m('wood');
    core.pushTRS(0, 0.7, 0, 0, 0, Math.PI / 2);
    core.cylinder(0.26, 0.26, 0.62, 12, false, false, 0.5);
    core.pop();
    const cbl = c.m('rubber');
    cbl.pushTRS(0, 0.7, 0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 5; i++) cbl.torus(0.3 + i * 0.055, 0.028, 14, 6, 0.3);
    cbl.pop();
  },
});

def({
  id: 'tyre', radius: 0.36, height: 0.22, collide: 'box',
  build(c) {
    const m = c.m('rubber');
    m.pushTRS(0, 0.11, 0);
    m.torus(0.26, 0.11, 14, 8, 0.4);
    m.pop();
  },
});

def({
  id: 'tyreStack', radius: 0.4, height: 0.9, collide: 'box',
  build(c, rand) {
    const m = c.m('rubber');
    for (let i = 0; i < 4; i++) {
      m.pushTRS(rand.range(-0.05, 0.05), 0.11 + i * 0.21, rand.range(-0.05, 0.05), rand.next() * 3);
      m.torus(0.26, 0.11, 12, 7, 0.4);
      m.pop();
    }
  },
});

/* ========================================================= fortification == */

def({
  id: 'jerseyBarrier', radius: 1.1, height: 0.82, collide: 'box',
  build(c) {
    const m = c.m('concrete');
    // Moulded profile: wide foot, battered lower face, slim top.
    m.boxMinMax(-1.0, 0, -0.30, 1.0, 0.10, 0.30, 1.4);
    for (let i = 0; i < 5; i++) {
      const t0 = i / 5, t1 = (i + 1) / 5;
      const w0 = 0.30 - t0 * 0.16, w1 = 0.30 - t1 * 0.16;
      m.boxMinMax(-1.0, 0.10 + t0 * 0.34, -w0, 1.0, 0.10 + t1 * 0.34, w0, 1.4);
      void w1;
    }
    m.boxMinMax(-1.0, 0.44, -0.115, 1.0, 0.80, 0.115, 1.4);
    m.boxMinMax(-1.02, 0.80, -0.13, 1.02, 0.84, 0.13, 1.0);
    const s = c.m('rust');
    for (const sx of [-1, 1]) {
      s.pushTRS(sx * 0.45, 0.845, 0, 0, 0, Math.PI / 2);
      s.torus(0.05, 0.012, 8, 5, 0.2, Math.PI);
      s.pop();
    }
  },
});

def({
  id: 'concreteBlock', radius: 0.9, height: 1.0, collide: 'box',
  build(c) {
    const m = c.m('concreteDark');
    m.chamferBox(0, 0.5, 0, 0.8, 0.5, 0.55, 0.035, 1.6);
    const r = c.m('rust');
    for (const sx of [-1, 1]) {
      r.pushTRS(sx * 0.3, 1.0, 0, 0, 0, Math.PI / 2);
      r.torus(0.055, 0.011, 8, 5, 0.2, Math.PI);
      r.pop();
    }
  },
});

def({
  id: 'hedgehog', radius: 0.85, height: 1.15, collide: 'box',
  build(c) {
    const m = c.m('rust');
    const L = 0.72;
    // three mutually perpendicular beams through the centre
    const beams: [number, number, number][] = [[0.7, 0.7, 0], [0.7, -0.7, 0], [0, 0.7, 0.7]];
    for (const b of beams) {
      const d = new THREE.Vector3(b[0], b[1], b[2]).normalize();
      const yaw = Math.atan2(d.x, d.z);
      const pitch = Math.asin(-d.y);
      m.pushTRS(0, 0.58, 0, yaw, pitch, 0);
      m.box(0, 0, 0, 0.05, 0.05, L, 0.5);
      m.pop();
    }
    m.pushTRS(0, 0.58, 0);
    m.box(0, 0, 0, 0.09, 0.09, 0.09, 0.3);
    m.pop();
  },
});

def({
  id: 'sandbagRow', radius: 1.15, height: 0.95, collide: 'box',
  build(c, rand) {
    const m = c.m('sandbag');
    const rows = 3;
    for (let r = 0; r < rows; r++) {
      const y = 0.16 + r * 0.28;
      const n = 5 - Math.floor(r / 2);
      const off = (r % 2) * 0.11;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 0.46 + off;
        m.pushTRS(x, y, rand.range(-0.04, 0.04), rand.range(-0.16, 0.16), rand.range(-0.1, 0.1));
        m.lump(0.25, 8, 5, (k) => 0.66 + 0.5 * fract(Math.sin((k + r * 7 + i * 13) * 12.9898) * 43758.5), 0.5);
        m.pop();
      }
    }
  },
});

def({
  id: 'razorWire', radius: 0.45, height: 0.75, collide: 'none', noShadow: true, navIgnore: true,
  build(c) {
    const m = c.m('steel');
    const pts: THREE.Vector3[] = [];
    const coils = 5;
    for (let i = 0; i <= coils * 12; i++) {
      const t = i / 12;
      const a = t * Math.PI * 2;
      pts.push(V3(Math.cos(a) * 0.4, 0.38 + Math.sin(a) * 0.36, (t / coils - 0.5) * 1.6));
    }
    m.tube(pts, 0.012, 4, false, 0.3);
  },
});

def({
  id: 'chainlink', radius: 1.3, height: 2.1, collide: 'box', navIgnore: false,
  build(c) {
    const post = c.m('pipe');
    for (const sx of [-1, 1]) {
      post.pushTRS(sx * 1.2, 1.05, 0);
      post.cylinder(0.045, 0.045, 2.1, 8, true, false, 0.4);
      post.pop();
    }
    post.pushTRS(0, 2.05, 0, 0, 0, Math.PI / 2);
    post.cylinder(0.032, 0.032, 2.4, 8, false, false, 0.4);
    post.pop();
    const mesh = c.m('grate');
    mesh.box(0, 1.03, 0, 1.2, 0.98, 0.004, { scale: 0.55 }, FACE.PZ | FACE.NZ);
  },
});

def({
  id: 'fenceBoard', radius: 1.2, height: 1.85, collide: 'box',
  build(c, rand) {
    const post = c.m('wood');
    for (const sx of [-1, 1]) post.box(sx * 1.15, 0.9, 0, 0.055, 0.9, 0.055, 0.5);
    const board = c.m('plank');
    for (let i = 0; i < 11; i++) {
      if (rand.bool(0.12)) continue;
      const x = -1.1 + i * 0.22;
      const h = rand.range(1.55, 1.78);
      board.box(x, h * 0.5, 0, 0.098, h * 0.5, 0.018, 0.9);
    }
    const rail = c.m('wood');
    for (const y of [0.4, 1.35]) rail.box(0, y, -0.035, 1.15, 0.045, 0.02, 0.6);
  },
});

def({
  id: 'crowdBarrier', radius: 1.15, height: 1.1, collide: 'box',
  build(c) {
    const m = c.m('alu');
    m.pushTRS(0, 1.05, 0, 0, 0, Math.PI / 2);
    m.cylinder(0.022, 0.022, 2.2, 8, true, true, 0.4);
    m.pop();
    m.pushTRS(0, 0.55, 0, 0, 0, Math.PI / 2);
    m.cylinder(0.02, 0.02, 2.2, 8, true, true, 0.4);
    m.pop();
    for (let i = 0; i < 7; i++) {
      const x = -0.95 + i * 0.316;
      m.pushTRS(x, 0.8, 0);
      m.cylinder(0.014, 0.014, 0.5, 6, false, false, 0.3);
      m.pop();
    }
    for (const sx of [-1, 1]) {
      m.pushTRS(sx * 1.0, 0.52, 0);
      m.cylinder(0.024, 0.024, 1.05, 8, false, false, 0.4);
      m.pop();
      m.pushTRS(sx * 1.0, 0.03, 0, 0, 0, 0);
      m.box(0, 0, 0, 0.03, 0.03, 0.28, 0.3);
      m.pop();
    }
  },
});

def({
  id: 'bollard', radius: 0.14, height: 0.95, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    m.pushTRS(0, 0.46, 0);
    m.cylinder(0.09, 0.085, 0.9, 10, false, false, 0.5);
    m.pop();
    m.pushTRS(0, 0.92, 0);
    m.sphere(0.088, 10, 5, 0.4);
    m.pop();
    m.pushTRS(0, 0.03, 0);
    m.cylinder(0.12, 0.11, 0.06, 10, true, false, 0.3);
    m.pop();
  },
});

/* ====================================================== street furniture == */

def({
  id: 'streetLamp', radius: 0.35, height: 6.2, collide: 'box', lodDistance: 55,
  build(c) {
    const m = c.m('steelPaint');
    m.pushTRS(0, 0.13, 0);
    m.cylinder(0.15, 0.13, 0.26, 10, true, false, 0.4);
    m.pop();
    m.pushTRS(0, 2.9, 0);
    m.cylinder(0.075, 0.055, 5.4, 10, false, false, 0.9);
    m.pop();
    // curved arm
    const arm: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      arm.push(V3(0, 5.6 + Math.sin(t * 1.35) * 0.55, t * 1.15));
    }
    m.tube(arm, 0.045, 8, false, 0.6);
    const lens = c.m('lampSodium');
    lens.pushTRS(0, 6.02, 1.16, 0, 0.22, 0);
    lens.box(0, 0, 0, 0.16, 0.055, 0.26, { unit: true });
    lens.pop();
    const hood = c.m('alu');
    hood.pushTRS(0, 6.12, 1.16, 0, 0.22, 0);
    hood.box(0, 0, 0, 0.19, 0.055, 0.30, 0.4);
    hood.pop();
  },
});

def({
  id: 'trafficLight', radius: 0.3, height: 3.6, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    m.pushTRS(0, 1.7, 0);
    m.cylinder(0.065, 0.055, 3.4, 10, false, false, 0.8);
    m.pop();
    m.pushTRS(0, 0.09, 0);
    m.cylinder(0.13, 0.12, 0.18, 10, true, false, 0.3);
    m.pop();
    const head = c.m('plastic');
    head.chamferBox(0, 3.05, 0.14, 0.13, 0.42, 0.11, 0.015, 0.5);
    const lens = c.m('beacon');
    lens.pushTRS(0, 3.36, 0.26, 0, Math.PI / 2, 0);
    lens.cylinder(0.075, 0.075, 0.03, 10, true, false, 0.2);
    lens.pop();
    const dark = c.m('plastic');
    for (const y of [3.05, 2.74]) {
      dark.pushTRS(0, y, 0.26, 0, Math.PI / 2, 0);
      dark.cylinder(0.075, 0.075, 0.03, 10, true, false, 0.2);
      dark.pop();
    }
  },
});

def({
  id: 'roadSign', radius: 0.4, height: 2.6, collide: 'box',
  build(c) {
    const m = c.m('alu');
    m.pushTRS(0, 1.2, 0);
    m.cylinder(0.032, 0.032, 2.4, 8, false, false, 0.5);
    m.pop();
    const plate = c.m('paintYellow');
    plate.box(0, 2.25, 0.02, 0.36, 0.26, 0.012, { unit: true });
    const back = c.m('alu');
    back.box(0, 2.25, -0.01, 0.37, 0.27, 0.012, 0.3);
  },
});

def({
  id: 'bench', radius: 0.95, height: 0.86, collide: 'box',
  build(c) {
    const leg = c.m('rust');
    for (const sx of [-1, 1]) {
      leg.box(sx * 0.72, 0.21, 0.16, 0.035, 0.21, 0.22, 0.4);
      leg.box(sx * 0.72, 0.62, -0.2, 0.035, 0.22, 0.035, 0.4);
      leg.pushTRS(sx * 0.72, 0.42, -0.02, 0, 0, 0);
      leg.box(0, 0, 0, 0.03, 0.03, 0.24, 0.3);
      leg.pop();
    }
    const s = c.m('plank');
    for (let i = 0; i < 4; i++) {
      s.box(0, 0.45, -0.16 + i * 0.13, 0.78, 0.022, 0.055, 0.8);
    }
    for (let i = 0; i < 3; i++) {
      s.pushTRS(0, 0.62 + i * 0.13, -0.22, 0, -0.16, 0);
      s.box(0, 0, 0, 0.78, 0.055, 0.022, 0.8);
      s.pop();
    }
  },
});

def({
  id: 'planter', radius: 0.75, height: 0.85, collide: 'box',
  build(c, rand) {
    const m = c.m('concrete');
    m.chamferBox(0, 0.28, 0, 0.62, 0.28, 0.62, 0.03, 1.2);
    m.box(0, 0.58, 0, 0.64, 0.045, 0.64, 1.0);
    const soil = c.m('dirt');
    soil.box(0, 0.55, 0, 0.55, 0.02, 0.55, 0.8, FACE.PY);
    const leaf = c.m('foliage');
    for (let i = 0; i < 7; i++) {
      leaf.pushTRS(rand.range(-0.36, 0.36), 0.56, rand.range(-0.36, 0.36), rand.next() * 3.1);
      leaf.card(rand.range(0.4, 0.72), rand.range(0.35, 0.72), 0, false);
      leaf.pop();
    }
  },
});

def({
  id: 'fireHydrant', radius: 0.2, height: 0.78, collide: 'box',
  build(c) {
    const m = c.m('hazard');
    m.pushTRS(0, 0.32, 0);
    m.cylinder(0.11, 0.1, 0.6, 10, false, false, 0.4);
    m.pop();
    m.pushTRS(0, 0.66, 0);
    m.sphere(0.115, 10, 5, 0.3);
    m.pop();
    m.pushTRS(0, 0.05, 0);
    m.cylinder(0.16, 0.15, 0.1, 10, true, false, 0.3);
    m.pop();
    for (const s of [-1, 1]) {
      m.pushTRS(s * 0.11, 0.42, 0, 0, 0, Math.PI / 2);
      m.cylinder(0.055, 0.05, 0.09, 8, true, false, 0.2);
      m.pop();
    }
  },
});

def({
  id: 'postBox', radius: 0.3, height: 1.25, collide: 'box',
  build(c) {
    const m = c.m('paintRed');
    m.pushTRS(0, 0.72, 0);
    m.cylinder(0.24, 0.24, 1.0, 12, false, false, 0.7);
    m.pop();
    m.pushTRS(0, 1.23, 0);
    m.sphere(0.245, 12, 6, 0.4);
    m.pop();
    const s = c.m('concreteDark');
    s.pushTRS(0, 0.11, 0);
    s.cylinder(0.28, 0.26, 0.22, 12, true, false, 0.4);
    s.pop();
    const slot = c.m('plastic');
    slot.box(0, 1.02, 0.235, 0.11, 0.025, 0.02, 0.2);
  },
});

def({
  id: 'utilityPole', radius: 0.3, height: 8.4, collide: 'box', lodDistance: 70,
  build(c) {
    const m = c.m('wood');
    m.pushTRS(0, 4.1, 0);
    m.cylinder(0.155, 0.115, 8.2, 10, false, false, 1.4);
    m.pop();
    const arm = c.m('wood');
    for (const y of [7.4, 6.75]) {
      arm.pushTRS(0, y, 0, 0, 0, Math.PI / 2);
      arm.box(0, 0, 0, 0.055, 1.0, 0.05, 0.6);
      arm.pop();
    }
    const ins = c.m('glassDirty');
    for (const y of [7.52, 6.87]) {
      for (const x of [-0.75, -0.28, 0.28, 0.75]) {
        ins.pushTRS(x, y + 0.06, 0);
        ins.cylinder(0.045, 0.032, 0.11, 8, true, false, 0.15);
        ins.pop();
      }
    }
  },
});

def({
  id: 'tramMast', radius: 0.25, height: 7.2, collide: 'box',
  build(c) {
    const m = c.m('steelPaint');
    m.pushTRS(0, 3.5, 0);
    m.cylinder(0.09, 0.065, 7.0, 10, false, false, 1.2);
    m.pop();
    m.pushTRS(0, 0.11, 0);
    m.cylinder(0.16, 0.15, 0.22, 10, true, false, 0.3);
    m.pop();
    const arm: THREE.Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      arm.push(V3(0, 6.6 + t * 0.32, t * 1.9));
    }
    m.tube(arm, 0.035, 6, false, 0.5);
    const stay = c.m('steel');
    stay.tube([V3(0, 6.05, 0), V3(0, 6.75, 1.65)], 0.014, 4, false, 0.4);
  },
});

def({
  id: 'busShelter', radius: 2.1, height: 2.5, collide: 'box',
  build(c) {
    const m = c.m('alu');
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        m.box(sx * 1.85, 1.2, sz * 0.62, 0.05, 1.2, 0.05, 0.6);
      }
    }
    m.box(0, 2.44, 0, 1.95, 0.05, 0.75, 1.2);
    const g = c.m('glassDirty');
    g.box(0, 1.3, -0.62, 1.82, 1.05, 0.008, { unit: true });
    g.box(-1.85, 1.3, 0, 0.008, 1.05, 0.6, { unit: true });
    const seat = c.m('plank');
    seat.box(0.4, 0.48, -0.4, 1.0, 0.03, 0.16, 0.7);
  },
});

/* ======================================================== market & signs == */

def({
  id: 'marketStall', radius: 1.7, height: 2.35, collide: 'box',
  build(c, rand) {
    const frame = c.m('pipe');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      frame.pushTRS(sx * 1.4, 1.05, sz * 0.72);
      frame.cylinder(0.028, 0.028, 2.1, 8, false, false, 0.5);
      frame.pop();
    }
    for (const sz of [-1, 1]) {
      frame.pushTRS(0, 2.1, sz * 0.72, 0, 0, Math.PI / 2);
      frame.cylinder(0.026, 0.026, 2.8, 8, false, false, 0.5);
      frame.pop();
    }
    // ridged awning
    const canvasKey: MatKey = rand.bool() ? 'canvasRed' : 'canvasGreen';
    const awn = c.m(canvasKey);
    const seg = 6;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const z0 = -0.85 + t0 * 1.7, z1 = -0.85 + t1 * 1.7;
      const y0 = 2.32 - Math.pow(Math.abs(t0 - 0.5) * 2, 2) * 0.22;
      const y1 = 2.32 - Math.pow(Math.abs(t1 - 0.5) * 2, 2) * 0.22;
      awn.quad(V3(-1.55, y0, z0), V3(1.55, y0, z0), V3(1.55, y1, z1), V3(-1.55, y1, z1), 1.0, true);
    }
    // scalloped valance
    for (let i = 0; i < 8; i++) {
      const x = -1.5 + i * 0.42;
      awn.quad(
        V3(x, 2.1, -0.86), V3(x + 0.38, 2.1, -0.86),
        V3(x + 0.38, 2.28, -0.86), V3(x, 2.28, -0.86), 1.0, true,
      );
    }
    const table = c.m('plank');
    table.box(0, 0.9, 0, 1.4, 0.028, 0.62, 0.9);
    for (const sx of [-1, 1]) table.box(sx * 1.25, 0.44, 0, 0.04, 0.44, 0.5, 0.5, FACE.SIDES);
    const goods = c.m('crate');
    for (let i = 0; i < 4; i++) {
      goods.pushTRS(rand.range(-1.1, 1.1), 1.03, rand.range(-0.4, 0.4), rand.next() * 3);
      goods.box(0, 0, 0, rand.range(0.14, 0.24), 0.11, rand.range(0.12, 0.2), 0.4);
      goods.pop();
    }
  },
});

def({
  id: 'kiosk', radius: 1.6, height: 2.7, collide: 'box',
  build(c) {
    const m = c.m('sheet');
    m.chamferBox(0, 1.25, 0, 1.35, 1.25, 0.95, 0.03, 1.4);
    m.box(0, 2.56, 0, 1.5, 0.06, 1.1, 1.2);
    const g = c.m('glassDirty');
    g.box(0, 1.65, 0.96, 1.05, 0.55, 0.01, { unit: true });
    const sill = c.m('woodPaint');
    sill.box(0, 1.05, 1.0, 1.15, 0.05, 0.13, 0.6);
    const sign = c.m('signGlow');
    sign.box(0, 2.25, 0.98, 0.85, 0.2, 0.02, { unit: true });
  },
});

/* ===================================================== building services == */

def({
  id: 'acUnit', radius: 0.6, height: 0.72, collide: 'box',
  build(c) {
    const m = c.m('alu');
    m.chamferBox(0, 0.34, 0, 0.46, 0.34, 0.34, 0.02, 0.7);
    const g = c.m('grate');
    g.pushTRS(0, 0.34, 0.35, 0, Math.PI / 2, 0);
    g.cylinder(0.26, 0.26, 0.015, 14, true, false, 0.3);
    g.pop();
    const f = c.m('steel');
    f.pushTRS(0, 0.34, 0.33, 0, Math.PI / 2, 0);
    for (let i = 0; i < 4; i++) {
      f.pushTRS(0, 0, 0, (i / 4) * Math.PI * 2);
      f.box(0.13, 0, 0, 0.12, 0.03, 0.01, 0.2);
      f.pop();
    }
    f.pop();
    const brk = c.m('rust');
    for (const sx of [-1, 1]) brk.box(sx * 0.4, 0.06, 0, 0.06, 0.06, 0.36, 0.3);
  },
});

def({
  id: 'satelliteDish', radius: 0.55, height: 1.0, collide: 'box',
  build(c) {
    const m = c.m('plastic');
    m.pushTRS(0, 0.72, 0, 0.5, -0.7, 0);
    m.cylinder(0.44, 0.42, 0.055, 16, true, true, 0.6);
    m.pop();
    const arm = c.m('alu');
    arm.pushTRS(0, 0.36, 0);
    arm.cylinder(0.03, 0.03, 0.72, 8, false, false, 0.3);
    arm.pop();
    arm.box(0, 0.03, 0, 0.16, 0.03, 0.16, 0.3);
    arm.tube([V3(0, 0.72, 0), V3(0.16, 0.52, 0.3)], 0.018, 5, false, 0.3);
  },
});

def({
  id: 'roofTank', radius: 0.95, height: 1.9, collide: 'box',
  build(c) {
    const m = c.m('rust');
    m.pushTRS(0, 1.35, 0);
    m.cylinder(0.78, 0.78, 1.05, 14, true, true, 1.0);
    m.pop();
    for (const y of [1.0, 1.7]) {
      m.pushTRS(0, y, 0);
      m.cylinder(0.8, 0.8, 0.05, 14, false, false, 0.4);
      m.pop();
    }
    const leg = c.m('steel');
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      leg.box(Math.cos(a) * 0.6, 0.41, Math.sin(a) * 0.6, 0.045, 0.41, 0.045, 0.4);
    }
    leg.tube([V3(0, 0.82, 0.78), V3(0, 0.3, 1.05)], 0.035, 6, false, 0.3);
  },
});

def({
  id: 'ventDuct', radius: 1.3, height: 0.85, collide: 'box',
  build(c) {
    const m = c.m('sheet');
    m.box(0, 0.55, 0, 1.2, 0.24, 0.24, 0.9);
    for (let i = -2; i <= 2; i++) m.box(i * 0.5, 0.55, 0, 0.03, 0.27, 0.27, 0.3);
    const leg = c.m('rust');
    for (const sx of [-1, 1]) {
      leg.box(sx * 0.9, 0.16, 0, 0.035, 0.16, 0.14, 0.3);
    }
    const cowl = c.m('sheet');
    cowl.pushTRS(1.28, 0.55, 0, 0, 0, Math.PI / 2);
    cowl.cylinder(0.26, 0.2, 0.2, 12, true, false, 0.4);
    cowl.pop();
  },
});

def({
  id: 'pipeCluster', radius: 0.35, height: 3.4, collide: 'box',
  build(c) {
    const m = c.m('pipe');
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * 0.14;
      m.pushTRS(off, 1.7, 0);
      m.cylinder(0.055 - i * 0.008, 0.055 - i * 0.008, 3.4, 8, false, false, 0.8);
      m.pop();
    }
    const br = c.m('rust');
    for (const y of [0.6, 1.9, 3.1]) br.box(0, y, -0.06, 0.24, 0.025, 0.06, 0.3);
  },
});

def({
  id: 'antennaMast', radius: 0.3, height: 4.2, collide: 'box', noShadow: false,
  build(c) {
    const m = c.m('alu');
    m.pushTRS(0, 2.1, 0);
    m.cylinder(0.035, 0.018, 4.2, 6, false, false, 0.8);
    m.pop();
    for (const y of [2.5, 3.1, 3.6]) {
      m.pushTRS(0, y, 0, 0, 0, Math.PI / 2);
      m.cylinder(0.012, 0.012, 0.9 - (y - 2.5) * 0.4, 5, false, false, 0.3);
      m.pop();
    }
    const base = c.m('rust');
    base.box(0, 0.04, 0, 0.18, 0.04, 0.18, 0.3);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      base.tube([V3(0, 1.9, 0), V3(Math.cos(a) * 0.8, 0.05, Math.sin(a) * 0.8)], 0.008, 3, false, 0.3);
    }
  },
});

/* ================================================================ debris == */

def({
  id: 'rubbleSmall', radius: 0.6, height: 0.35, collide: 'box',
  build(c, rand) {
    const keys: MatKey[] = ['brickSoot', 'concreteDark'];
    for (let i = 0; i < 12; i++) {
      const m = c.m(keys[i % 2]);
      const s = rand.range(0.07, 0.2);
      m.pushTRS(rand.range(-0.45, 0.45), s * 0.6, rand.range(-0.45, 0.45),
        rand.next() * 3, rand.range(-0.4, 0.4), rand.range(-0.4, 0.4));
      m.box(0, 0, 0, s, s * rand.range(0.4, 0.8), s * rand.range(0.7, 1.4), 0.6);
      m.pop();
    }
  },
});

def({
  id: 'rubbleHeap', radius: 1.7, height: 1.15, collide: 'box',
  build(c, rand) {
    const keys: MatKey[] = ['brickSoot', 'concreteDark', 'concrete'];
    for (let i = 0; i < 58; i++) {
      const a = rand.next() * Math.PI * 2;
      const r = 1.5 * Math.sqrt(rand.next());
      const h = Math.max(0.06, (1 - r / 1.5) * 1.0 * rand.range(0.4, 1.1));
      const s = rand.range(0.11, 0.32);
      const m = c.m(keys[i % 3]);
      m.pushTRS(Math.cos(a) * r, h * 0.5, Math.sin(a) * r,
        rand.next() * 3, rand.range(-0.4, 0.4), rand.range(-0.4, 0.4));
      m.box(0, 0, 0, s, h * 0.5, s * rand.range(0.7, 1.5), 0.8);
      m.pop();
    }
    const bar = c.m('rust');
    for (let i = 0; i < 4; i++) {
      const a = rand.next() * Math.PI * 2;
      bar.tube([
        V3(Math.cos(a) * 0.4, 0.1, Math.sin(a) * 0.4),
        V3(Math.cos(a) * 0.8, 0.7, Math.sin(a) * 0.8),
        V3(Math.cos(a) * 1.3, 0.95, Math.sin(a) * 1.4),
      ], 0.012, 4, false, 0.3);
    }
  },
});

def({
  id: 'brickPile', radius: 0.8, height: 0.5, collide: 'box',
  build(c, rand) {
    const m = c.m('brick');
    for (let i = 0; i < 26; i++) {
      const a = rand.next() * Math.PI * 2;
      const r = 0.6 * Math.sqrt(rand.next());
      const y = (1 - r / 0.6) * 0.4 * rand.range(0.3, 1.0);
      m.pushTRS(Math.cos(a) * r, y + 0.035, Math.sin(a) * r,
        rand.next() * 3, rand.range(-0.3, 0.3), rand.range(-0.3, 0.3));
      m.box(0, 0, 0, 0.105, 0.033, 0.05, 0.5);
      m.pop();
    }
  },
});

def({
  id: 'concreteChunk', radius: 0.65, height: 0.55, collide: 'box',
  build(c, rand) {
    const m = c.m('concreteDark');
    m.pushTRS(0, 0.24, 0, rand.next() * 3, rand.range(-0.3, 0.3), rand.range(-0.3, 0.3));
    m.box(0, 0, 0, rand.range(0.34, 0.55), rand.range(0.1, 0.2), rand.range(0.3, 0.5), 1.2);
    m.pop();
    const bar = c.m('rust');
    for (let i = 0; i < 3; i++) {
      const x = -0.25 + i * 0.25;
      bar.tube([V3(x, 0.24, -0.4), V3(x + rand.range(-0.1, 0.1), 0.3, 0.55)], 0.011, 4, false, 0.3);
    }
  },
});

def({
  id: 'plankPile', radius: 1.1, height: 0.4, collide: 'box',
  build(c, rand) {
    const m = c.m('plank');
    for (let i = 0; i < 9; i++) {
      m.pushTRS(rand.range(-0.2, 0.2), 0.03 + i * 0.035, rand.range(-0.2, 0.2), rand.range(-0.5, 0.5));
      m.box(0, 0, 0, rand.range(0.6, 1.0), 0.017, rand.range(0.06, 0.11), 0.9);
      m.pop();
    }
  },
});

def({
  id: 'rebarBundle', radius: 0.55, height: 0.3, collide: 'box',
  build(c, rand) {
    const m = c.m('rust');
    for (let i = 0; i < 9; i++) {
      const y = 0.02 + Math.floor(i / 4) * 0.045;
      m.pushTRS(rand.range(-0.06, 0.06), y, (i % 4) * 0.05 - 0.075, rand.range(-0.1, 0.1));
      m.cylinder(0.014, 0.014, 1.0, 5, false, false, 0.4);
      m.pop();
    }
  },
});

def({
  id: 'glassShards', radius: 0.7, height: 0.05, collide: 'none', noShadow: true, navIgnore: true,
  build(c, rand) {
    // Alpha-tested window glass would punch holes in shards this small, so
    // scattered glass uses the wet, near-mirror puddle stack instead.
    const m = c.m('alu');
    for (let i = 0; i < 14; i++) {
      m.pushTRS(rand.range(-0.6, 0.6), 0.012, rand.range(-0.6, 0.6), rand.next() * 3, rand.range(-0.1, 0.1));
      m.box(0, 0, 0, rand.range(0.03, 0.11), 0.004, rand.range(0.03, 0.1), 0.6);
      m.pop();
    }
  },
});

def({
  id: 'paperDrift', radius: 0.6, height: 0.04, collide: 'none', noShadow: true, navIgnore: true,
  build(c, rand) {
    const m = c.m('plywood');
    for (let i = 0; i < 12; i++) {
      m.pushTRS(rand.range(-0.55, 0.55), 0.006 + i * 0.002, rand.range(-0.55, 0.55), rand.next() * 3, rand.range(-0.06, 0.06));
      m.box(0, 0, 0, 0.1, 0.002, 0.14, { unit: true });
      m.pop();
    }
  },
});

/* ============================================================ vegetation == */

def({
  id: 'bush', radius: 0.8, height: 1.2, collide: 'none',
  build(c, rand) {
    const m = c.m('foliage');
    for (let i = 0; i < 9; i++) {
      const a = rand.next() * Math.PI * 2;
      const r = rand.range(0, 0.42);
      m.pushTRS(Math.cos(a) * r, rand.range(0, 0.28), Math.sin(a) * r, rand.next() * 3.14, 0, rand.range(-0.25, 0.25));
      m.card(rand.range(0.7, 1.15), rand.range(0.6, 1.05), 0, false);
      m.pop();
    }
    const st = c.m('wood');
    st.pushTRS(0, 0.16, 0);
    st.cylinder(0.035, 0.02, 0.32, 5, false, false, 0.2);
    st.pop();
  },
});

def({
  id: 'weeds', radius: 0.4, height: 0.5, collide: 'none', noShadow: true, navIgnore: true,
  build(c, rand) {
    const m = c.m('foliageDry');
    for (let i = 0; i < 5; i++) {
      const a = rand.next() * Math.PI * 2;
      m.pushTRS(Math.cos(a) * rand.range(0, 0.2), 0, Math.sin(a) * rand.range(0, 0.2), rand.next() * 3.14, 0, rand.range(-0.2, 0.2));
      m.card(rand.range(0.3, 0.55), rand.range(0.25, 0.5), 0, false);
      m.pop();
    }
  },
});

def({
  id: 'ivy', radius: 0.9, height: 2.4, collide: 'none', noShadow: true, navIgnore: true,
  build(c, rand) {
    const m = c.m('foliage');
    for (let i = 0; i < 12; i++) {
      m.pushTRS(rand.range(-0.7, 0.7), rand.range(0, 1.7), rand.range(-0.04, 0.04), rand.range(-0.3, 0.3), 0, rand.range(-0.4, 0.4));
      m.card(rand.range(0.5, 0.85), rand.range(0.5, 0.85), 0, false);
      m.pop();
    }
  },
});

def({
  id: 'deadTree', radius: 1.6, height: 5.6, collide: 'box', lodDistance: 60,
  build(c, rand) {
    const m = c.m('wood');
    const trunk: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      trunk.push(V3(Math.sin(t * 2.1) * 0.18, t * 3.4, Math.cos(t * 1.7) * 0.12));
    }
    m.tube(trunk, 0.19, 8, false, 1.2);
    const branch = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number, rnd: Rand) => {
      const pts: THREE.Vector3[] = [from.clone()];
      const d = dir.clone();
      for (let i = 0; i < 3; i++) {
        d.x += rnd.range(-0.25, 0.25);
        d.z += rnd.range(-0.25, 0.25);
        d.y += rnd.range(-0.1, 0.05);
        d.normalize();
        pts.push(pts[pts.length - 1].clone().addScaledVector(d, len / 3));
      }
      m.tube(pts, r, 5, false, 0.8);
      if (depth > 0) {
        for (let k = 0; k < 2; k++) {
          const nd = d.clone();
          nd.x += rnd.range(-0.7, 0.7); nd.z += rnd.range(-0.7, 0.7); nd.y += rnd.range(0.1, 0.5);
          branch(pts[pts.length - 1], nd.normalize(), len * 0.62, r * 0.62, depth - 1, rnd);
        }
      }
    };
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rand.range(-0.4, 0.4);
      branch(
        V3(Math.sin(2.1) * 0.18 * 0.8, 2.5 + rand.range(-0.5, 0.6), Math.cos(1.7) * 0.12),
        V3(Math.cos(a), 0.9, Math.sin(a)).normalize(), 1.7, 0.075, 1, rand,
      );
    }
  },
});

/* ============================================================== ground ==== */

def({
  id: 'manhole', radius: 0.36, height: 0.03, collide: 'none', navIgnore: true, noShadow: true,
  build(c) {
    const m = c.m('rust');
    m.pushTRS(0, 0.015, 0);
    m.cylinder(0.33, 0.33, 0.03, 14, true, false, 0.5);
    m.pop();
    m.pushTRS(0, 0.032, 0);
    m.cylinder(0.28, 0.28, 0.008, 14, true, false, 0.3);
    m.pop();
  },
});

def({
  id: 'drainGrate', radius: 0.3, height: 0.03, collide: 'none', navIgnore: true, noShadow: true,
  build(c) {
    const m = c.m('grate');
    m.box(0, 0.015, 0, 0.24, 0.015, 0.16, 0.3);
    const f = c.m('rust');
    f.box(0, 0.012, 0, 0.28, 0.012, 0.2, 0.3, FACE.SIDES);
  },
});

def({
  id: 'sandPile', radius: 0.9, height: 0.55, collide: 'box',
  build(c, rand) {
    const m = c.m('gravel');
    m.pushTRS(0, -0.22, 0);
    m.lump(0.78, 10, 5, (i) => 0.55 + 0.35 * fract(Math.sin(i * 7.13) * 4137.5), 1.0);
    m.pop();
    void rand;
  },
});

/* --------------------------------------------------------------- helpers -- */

function fract(v: number): number { return v - Math.floor(v); }

export { fract, catenary };
