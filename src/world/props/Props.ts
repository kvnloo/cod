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
import { FACE, V2, V3, catenary } from '../geom/Mesher';

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

/**
 * The moulded jersey profile, parameterised.
 *
 * Three barriers of identical mesh, identical tint and near-identical yaw in a
 * straight line was the single strongest repeated-prop read on the map, and no
 * amount of per-instance hue variation fixes a silhouette that repeats exactly.
 * So the library carries three castings — a clean one, a chipped one with the
 * rebar showing, and one that has been knocked flat — and the placement code
 * mixes them.
 */
function jerseyProfile(c: Chunk, half: number, key: MatKey): void {
  const m = c.m(key);
  m.boxMinMax(-half, 0, -0.30, half, 0.10, 0.30, 1.4);
  for (let i = 0; i < 5; i++) {
    const t0 = i / 5, t1 = (i + 1) / 5;
    const w0 = 0.30 - t0 * 0.16;
    m.boxMinMax(-half, 0.10 + t0 * 0.34, -w0, half, 0.10 + t1 * 0.34, w0, 1.4);
  }
  m.boxMinMax(-half, 0.44, -0.115, half, 0.80, 0.115, 1.4);
  m.boxMinMax(-half - 0.02, 0.80, -0.13, half + 0.02, 0.84, 0.13, 1.0);
}

def({
  id: 'jerseyBarrier', radius: 1.1, height: 0.82, collide: 'box',
  build(c) {
    jerseyProfile(c, 1.0, 'concrete');
    const s = c.m('rust');
    for (const sx of [-1, 1]) {
      s.pushTRS(sx * 0.45, 0.845, 0, 0, 0, Math.PI / 2);
      s.torus(0.05, 0.012, 8, 5, 0.2, Math.PI);
      s.pop();
    }
  },
});

def({
  id: 'jerseyBarrierWorn', radius: 0.95, height: 0.82, collide: 'box',
  build(c, rand) {
    // Shorter casting, one end corner knocked off, reinforcement showing.
    jerseyProfile(c, 0.84, 'concreteDark');
    const m = c.m('concreteDark');
    // Spalled top corner: a stepped bite rather than a clean chamfer.
    for (let i = 0; i < 4; i++) {
      const t = i / 4;
      m.boxMinMax(-0.86 - 0.02, 0.80 - t * 0.22, -0.13, -0.86 + 0.06 + t * 0.12, 0.86 - t * 0.22, 0.13, 1.0);
    }
    const s = c.m('rust');
    for (let i = 0; i < 3; i++) {
      s.pushTRS(-0.84 + rand.range(-0.05, 0.05), 0.58 + i * 0.08, rand.range(-0.07, 0.07),
        rand.range(-0.4, 0.4), rand.range(-0.3, 0.3));
      s.cylinder(0.008, 0.008, rand.range(0.12, 0.3), 5, false, false, 0.2);
      s.pop();
    }
    s.pushTRS(0.45, 0.845, 0, 0, 0, Math.PI / 2);
    s.torus(0.05, 0.012, 8, 5, 0.2, Math.PI);
    s.pop();
  },
});

def({
  id: 'jerseyBarrierDown', radius: 1.1, height: 0.62, collide: 'box',
  build(c) {
    // Knocked over on its face: the profile now reads as a wedge, and its top
    // edge sits at knee height, so a run of barriers has a broken skyline.
    const g = c.m('concrete');
    g.pushTRS(0, 0.30, 0, 0.06, 0, Math.PI * 0.46);
    const sub = new Chunk();
    jerseyProfile(sub, 1.0, 'concrete');
    const src = sub.m('concrete');
    const base = g.vertexCount;
    for (let v = 0; v < src.pos.length; v += 3) {
      g.vertex(src.pos[v], src.pos[v + 1], src.pos[v + 2],
        src.nor[v], src.nor[v + 1], src.nor[v + 2],
        src.uv[(v / 3) * 2], src.uv[(v / 3) * 2 + 1]);
    }
    for (let k = 0; k < src.idx.length; k += 3) {
      g.tri(base + src.idx[k], base + src.idx[k + 1], base + src.idx[k + 2]);
    }
    g.pop();
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

/**
 * A sandbag emplacement.
 *
 * `sandbagRow` used to be built once from a fixed seed and instanced, so every
 * emplacement on the map was the same thirteen bags in the same three courses —
 * twelve identical sandbags in one stack is impossible to un-see. Three
 * different courses patterns, three different spill states and a plank
 * revetment on one of them break that without changing the cover volume.
 */
function sandbagStack(c: Chunk, rand: Rand, courses: number[], salt: number, spill: number): void {
  const m = c.m('sandbag');
  for (let r = 0; r < courses.length; r++) {
    const y = 0.16 + r * 0.28;
    const n = courses[r];
    const off = (r % 2) * 0.11 + (r === 2 ? -0.07 : 0);
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 0.46 + off;
      m.pushTRS(x, y, rand.range(-0.05, 0.05), rand.range(-0.22, 0.22), rand.range(-0.12, 0.12));
      m.lump(0.25, 8, 5,
        (k) => 0.66 + 0.5 * fract(Math.sin((k + r * 7 + i * 13 + salt * 37) * 12.9898) * 43758.5), 0.5);
      m.pop();
    }
  }
  for (let i = 0; i < spill; i++) {
    const x = rand.range(-1.0, 1.0);
    m.pushTRS(x, 0.12, rand.range(0.33, 0.6), rand.range(0, 6.28), rand.range(-0.6, 0.6), rand.range(-0.5, 0.5));
    m.lump(0.24, 8, 5,
      (k) => 0.66 + 0.5 * fract(Math.sin((k + i * 41 + salt * 11) * 12.9898) * 43758.5), 0.5);
    m.pop();
  }
}

def({
  id: 'sandbagRow', radius: 1.15, height: 0.95, collide: 'box',
  build(c, rand) { sandbagStack(c, rand, [5, 5, 4], 0, 0); },
});

def({
  id: 'sandbagRowLow', radius: 1.3, height: 0.7, collide: 'box',
  build(c, rand) {
    sandbagStack(c, rand, [6, 5], 3, 3);
    // Plank and picket revetment holding the front course.
    const w = c.m('plank');
    w.box(0, 0.24, -0.34, 1.28, 0.1, 0.022, 0.6);
    const p = c.m('wood');
    for (const sx of [-1, 0, 1]) p.box(sx * 1.1, 0.3, -0.36, 0.035, 0.3, 0.035, 0.3);
  },
});

def({
  id: 'sandbagPost', radius: 0.95, height: 1.24, collide: 'box',
  build(c, rand) {
    sandbagStack(c, rand, [4, 4, 3, 2], 7, 2);
    // Ammunition tin wedged into the top course.
    const s = c.m('steelPaint');
    s.pushTRS(0.34, 1.14, 0.02, 0.4);
    s.chamferBox(0, 0.1, 0, 0.24, 0.1, 0.13, 0.012, 0.5);
    s.pop();
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
      awn.quad(V3(-1.55, y0, z0), V3(1.55, y0, z0), V3(1.55, y1, z1), V3(-1.55, y1, z1), 1.0, false);
    }
    // Valance: one continuous strip with a scalloped lower edge. Eight separate
    // tabs with a 4 cm gap between them read as a comb of black and cream teeth
    // from 20 m, which is what the market row looked like across the square.
    for (let i = 0; i < 8; i++) {
      const x0 = -1.55 + i * 0.3875, x1 = x0 + 0.3875;
      const dip = 0.1 + 0.08 * Math.sin(i * 1.9);
      awn.quad(
        V3(x0, 2.28, -0.86), V3(x1, 2.28, -0.86),
        V3(x1, 2.28 - dip, -0.855), V3(x0, 2.28 - dip, -0.855), 1.0, false,
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

/**
 * The silt collar every piece of ground debris grows within a week.
 *
 * Thin debris is the one thing screen-space occlusion cannot help with: a
 * 4 mm glass shard has no cavity for AO to find, so it renders as a decal
 * pasted on the pavement. The contact has to be *modelled* — an irregular
 * millimetres-proud patch of silt washed up around the object plus a few grit
 * fragments tucked into the angle at its base. That reads at 2 m and it is
 * what the critic meant by "no contact darkening at all".
 */
function contactSkirt(c: Chunk, radius: number, rand: Rand, grit = 5): void {
  const d = c.m('dirt');
  const pts = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.72 + 0.5 * fract(Math.sin(a * 3.7 + radius * 17) * 43758.5));
    pts.push(V2(Math.cos(a) * r, Math.sin(a) * r));
  }
  d.extrude(pts, -0.03, 0.006, 1.4, true, false, false);
  const g = c.m('gravel');
  for (let i = 0; i < grit; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = radius * rand.range(0.45, 1.0);
    const s = rand.range(0.02, 0.055);
    g.pushTRS(Math.cos(a) * r, s * 0.35, Math.sin(a) * r, rand.range(0, 6.28), rand.range(-0.4, 0.4));
    g.box(0, 0, 0, s, s * 0.5, s * rand.range(0.7, 1.4), 0.3);
    g.pop();
  }
}

def({
  id: 'rubbleSmall', radius: 0.6, height: 0.35, collide: 'box',
  build(c, rand) {
    contactSkirt(c, 0.52, rand, 4);
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
    contactSkirt(c, 0.66, rand, 5);
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
  id: 'concreteChunk', radius: 0.5, height: 0.45, collide: 'box',
  build(c, rand) {
    // A slab out of a wall, not a clean plate: the main piece is chamfered so
    // its broken edges catch the key, and two smaller fragments sit against it
    // so the silhouette is never a single rectangle.
    contactSkirt(c, 0.42, rand, 4);
    const m = c.m('concreteDark');
    m.pushTRS(0, 0.17, 0, rand.next() * 3, rand.range(-0.28, 0.28), rand.range(-0.24, 0.24));
    m.chamferBox(0, 0, 0, rand.range(0.26, 0.4), rand.range(0.07, 0.13), rand.range(0.22, 0.34), 0.022, 0.7);
    m.pop();
    for (let i = 0; i < 2; i++) {
      const a = rand.range(0, Math.PI * 2), r = rand.range(0.24, 0.42);
      const s = rand.range(0.07, 0.14);
      m.pushTRS(Math.cos(a) * r, s * 0.7, Math.sin(a) * r, rand.next() * 3, rand.range(-0.4, 0.4), rand.range(-0.4, 0.4));
      m.chamferBox(0, 0, 0, s, s * 0.55, s * rand.range(0.8, 1.5), 0.012, 0.5);
      m.pop();
    }
    const bar = c.m('rust');
    for (let i = 0; i < 3; i++) {
      const x = -0.18 + i * 0.18;
      bar.tube([V3(x, 0.17, -0.3), V3(x + rand.range(-0.08, 0.08), 0.24, 0.42)], 0.009, 4, false, 0.3);
    }
  },
});

def({
  id: 'plankPile', radius: 1.1, height: 0.4, collide: 'box',
  build(c, rand) {
    contactSkirt(c, 0.62, rand, 4);
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
    contactSkirt(c, 0.34, rand, 3);
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
    contactSkirt(c, 0.58, rand, 6);
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
    contactSkirt(c, 0.5, rand, 3);
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
  id: 'ivy', radius: 0.8, height: 2.6, collide: 'none', noShadow: true, navIgnore: true,
  build(c, rand) {
    // A mat, not a mobile.
    //
    // Twelve big cards at random heights over a 1.7 m span read as paper kites
    // floating in front of the wall — one of the most obvious fake tells on the
    // map. Real ivy is a dense continuous sheet with a ragged upper edge and
    // runners reaching past it, so this is forty small overlapping cards packed
    // against the plane, with the density falling off toward the top.
    const m = c.m('foliage');
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const y = Math.pow(rand.next(), 0.75) * 2.25;
      const spread = 0.72 * (1 - 0.35 * (y / 2.25));
      m.pushTRS(
        rand.range(-spread, spread), y, rand.range(-0.02, 0.06),
        rand.range(-0.22, 0.22), 0, rand.range(-0.5, 0.5),
      );
      m.card(rand.range(0.26, 0.44), rand.range(0.24, 0.4), 0, false);
      m.pop();
      void t;
    }
    // Runners breaking the top edge so the sheet does not end on a straight line.
    const st = c.m('foliageDry');
    for (let i = 0; i < 5; i++) {
      st.pushTRS(rand.range(-0.6, 0.6), rand.range(1.9, 2.5), 0.03, rand.range(-0.2, 0.2), 0, rand.range(-0.7, 0.7));
      st.card(rand.range(0.16, 0.3), rand.range(0.3, 0.5), 0, false);
      st.pop();
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

/* ======================================================== facade colour == */

/**
 * Shop awning on a folding arm, faded and torn.
 *
 * The square was close to monochrome without these. An awning is the cheapest
 * saturated accent a European street has: it sits at first-floor height where
 * the low sun rakes across it, it throws a hard-edged shadow down the
 * shopfront, and its underside catches warm bounce off the pavement. Authored
 * facing +Z, hanging off the wall behind it.
 */
def({
  id: 'awning', radius: 1.6, height: 3.1, collide: 'none', navIgnore: true,
  build(c, rand) {
    const key: MatKey = rand.pick(['canvasRed', 'canvasGreen', 'canvasCream'] as const);
    const cloth = c.m(key);
    const arm = c.m('rust');
    const W = 1.5, drop = 1.05, out = 1.25;
    // Two folding arms and the roller bar.
    for (const sx of [-1, 1]) {
      arm.tube([V3(sx * W, 3.02, 0.06), V3(sx * W * 0.96, 2.72, out)], 0.022, 5, false, 0.4);
      arm.tube([V3(sx * W, 2.62, 0.06), V3(sx * W * 0.96, 2.72, out)], 0.018, 5, false, 0.4);
    }
    arm.pushTRS(0, 3.04, 0.06, 0, 0, Math.PI / 2);
    arm.cylinder(0.045, 0.045, W * 2.1, 8, true, false, 0.4);
    arm.pop();
    // Canopy: one continuous sheet with a slight sag across it, and a straight
    // valance hanging off the front bar. Splitting it into per-bay quads gave a
    // striped, venetian-blind read at distance — the awning has to be a single
    // plane of colour or it stops being an awning.
    const bays = 5;
    const sag = (k: number) => 0.05 * (1 - (k / W) * (k / W));
    for (let i = 0; i < bays; i++) {
      const u0 = -W + (i * 2 * W) / bays, u1 = -W + ((i + 1) * 2 * W) / bays;
      cloth.quad(
        V3(u0, 3.0, 0.08), V3(u1, 3.0, 0.08),
        V3(u1, 3.0 - drop - sag(u1), out), V3(u0, 3.0 - drop - sag(u0), out),
        1.4, false,
      );
    }
    // Valance, torn away at one end so the silhouette is not a clean rectangle.
    const tearAt = rand.range(-W * 0.4, W * 0.6);
    cloth.quad(
      V3(-W, 3.0 - drop - sag(-W), out), V3(tearAt, 3.0 - drop - sag(tearAt), out),
      V3(tearAt, 3.0 - drop - 0.24, out - 0.01), V3(-W, 3.0 - drop - 0.27, out - 0.01),
      1.2, false,
    );
    cloth.quad(
      V3(tearAt + 0.24, 3.0 - drop - sag(tearAt), out), V3(W, 3.0 - drop - sag(W), out),
      V3(W, 3.0 - drop - 0.26, out - 0.01), V3(tearAt + 0.24, 3.0 - drop - 0.12, out - 0.01),
      1.2, false,
    );
  },
});

/** Painted timber shop sign over a doorway — a second accent at eye level. */
def({
  id: 'shopSign', radius: 1.1, height: 2.9, collide: 'none', navIgnore: true,
  build(c, rand) {
    const board = c.m(rand.bool() ? 'paintRed' : 'woodPaint');
    board.chamferBox(0, 2.55, 0.12, 1.05, 0.26, 0.05, 0.015, 1.2);
    const trim = c.m('rust');
    for (const sx of [-1, 1]) trim.box(sx * 1.02, 2.55, 0.09, 0.02, 0.28, 0.05, 0.3);
    // Hanging bracket sign, perpendicular to the wall so it reads in silhouette.
    trim.tube([V3(0.9, 2.9, 0.06), V3(0.9, 2.9, 0.62), V3(0.9, 2.6, 0.62)], 0.016, 5, false, 0.3);
    const hang = c.m(rand.bool() ? 'paintYellow' : 'paintRed');
    hang.box(0.9, 2.34, 0.62, 0.012, 0.24, 0.3, { unit: true });
  },
});

/** Window flower box, mostly dead. Small, but it breaks every sill line. */
def({
  id: 'flowerBox', radius: 0.5, height: 0.5, collide: 'none', navIgnore: true, noShadow: true,
  build(c, rand) {
    const m = c.m('woodPaint');
    m.chamferBox(0, 0.11, 0, 0.45, 0.11, 0.13, 0.012, 0.4);
    const leaf = c.m(rand.bool(0.65) ? 'foliageDry' : 'foliage');
    for (let i = 0; i < 5; i++) {
      leaf.pushTRS(rand.range(-0.34, 0.34), 0.2, rand.range(-0.06, 0.06), rand.next() * 3.1, 0, rand.range(-0.3, 0.3));
      leaf.card(rand.range(0.24, 0.42), rand.range(0.2, 0.36), 0, false);
      leaf.pop();
    }
  },
});

/**
 * Fly-posted hoarding panel. Layered paper is the one place a war-torn street
 * is allowed to be genuinely bright, and it reads at 30 m as texture rather
 * than as a decal.
 */
def({
  id: 'posterPanel', radius: 1.0, height: 2.1, collide: 'box',
  build(c, rand) {
    const m = c.m('plywood');
    m.box(0, 1.0, 0, 0.95, 1.0, 0.03, 1.2);
    const post = c.m('plank');
    for (const sx of [-1, 1]) post.box(sx * 0.86, 1.0, -0.06, 0.05, 1.0, 0.05, 0.5);
    const inks: MatKey[] = ['paintRed', 'paintYellow', 'signGlow', 'canvasCream'];
    for (let i = 0; i < 7; i++) {
      const p = c.m(inks[rand.int(0, inks.length - 1)]);
      const w = rand.range(0.16, 0.3), h = rand.range(0.22, 0.4);
      p.pushTRS(rand.range(-0.72, 0.72), rand.range(0.35, 1.7), 0.032, 0, 0, rand.range(-0.09, 0.09));
      p.box(0, 0, 0, w, h, 0.004, { unit: true });
      p.pop();
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
