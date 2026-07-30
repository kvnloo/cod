/**
 * The modular building kit.
 *
 * Everything architectural in Blackout is assembled from these pieces: walls
 * with real window and door openings (and therefore real reveals), floor slabs
 * with separate ceiling material, stairs with risers/goings at building-code
 * proportions, arcades, balconies, cornices, parapets, pitched and flat roofs,
 * fire escapes, shopfronts — plus the war damage set: ragged blown-out wall
 * tops, collapsed corners and exposed rebar.
 *
 * Every function writes into a `Chunk`, so a whole building is a handful of
 * merged meshes.
 *
 * Scale is authored to the real-world figures the visual bar calls out:
 * doors 2.1 m, storeys 3.2 m / 3.0 m, window sills 0.9 m, stair risers 0.17 m,
 * kerbs 0.15 m, wall thickness 0.35 m exterior / 0.14 m partition.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { MatKey } from '../MatCatalog';
import type { Chunk } from './Chunk';
import { FACE, V3, catenary } from './Mesher';

/* ---------------------------------------------------------------- frames -- */

const _x = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/**
 * Local frame for a wall segment: +X runs from A to B, +Y is up, +Z is the
 * exterior face (to the right when walking A→B).
 */
export class WallFrame {
  readonly length: number;
  readonly matrix = new THREE.Matrix4();
  constructor(
    readonly ax: number, readonly az: number,
    readonly bx: number, readonly bz: number,
  ) {
    const dx = bx - ax, dz = bz - az;
    this.length = Math.hypot(dx, dz);
    const inv = this.length > 1e-6 ? 1 / this.length : 0;
    _x.set(dx * inv, 0, dz * inv);
    _z.set(-dz * inv, 0, dx * inv);
    this.matrix.makeBasis(_x, _y, _z);
    this.matrix.setPosition(ax, 0, az);
  }
  /** World position of a point given in wall-local coordinates. */
  point(u: number, y: number, out = 0): THREE.Vector3 {
    return new THREE.Vector3(u, y, out).applyMatrix4(this.matrix);
  }
}

/** The four walls of a rectangular footprint, each with its exterior outward. */
export function rectWalls(x0: number, z0: number, x1: number, z1: number): WallFrame[] {
  return [
    new WallFrame(x1, z0, x0, z0), // north (faces -Z)
    new WallFrame(x0, z0, x0, z1), // west  (faces -X)
    new WallFrame(x0, z1, x1, z1), // south (faces +Z)
    new WallFrame(x1, z1, x1, z0), // east  (faces +X)
  ];
}

/* -------------------------------------------------------------- openings -- */

export type OpeningKind = 'window' | 'door' | 'hole' | 'arch' | 'shopfront' | 'garage';

export interface Opening {
  /** Centre of the opening measured along the wall from its start point. */
  u: number;
  width: number;
  /** Bottom of the opening (sill height for windows, 0 for doors). */
  sill: number;
  height: number;
  kind?: OpeningKind;
  /** 0 = intact glazing, 1 = completely blown out. */
  broken?: number;
  /** Suppress the sill/lintel trim (used for holes and arches). */
  noTrim?: boolean;
  /** Board the opening over with planks. */
  boarded?: boolean;
}

interface Rect { u0: number; u1: number; y0: number; y1: number; }

/** Decomposes a wall span into solid rectangles around its openings. */
function wallRects(length: number, y0: number, y1: number, openings: Opening[]): Rect[] {
  const rects: Rect[] = [];
  const sorted = [...openings]
    .map((o) => ({ o, u0: Math.max(0, o.u - o.width * 0.5), u1: Math.min(length, o.u + o.width * 0.5) }))
    .filter((e) => e.u1 > e.u0 && e.o.sill < y1 && e.o.sill + e.o.height > y0)
    .sort((a, b) => a.u0 - b.u0);

  let cursor = 0;
  for (const e of sorted) {
    if (e.u0 > cursor + 1e-4) rects.push({ u0: cursor, u1: e.u0, y0, y1 });
    const bottom = Math.max(y0, Math.min(y1, e.o.sill));
    const top = Math.max(y0, Math.min(y1, e.o.sill + e.o.height));
    if (bottom > y0 + 1e-4) rects.push({ u0: e.u0, u1: e.u1, y0, y1: bottom });
    if (top < y1 - 1e-4) rects.push({ u0: e.u0, u1: e.u1, y0: top, y1 });
    cursor = Math.max(cursor, e.u1);
  }
  if (cursor < length - 1e-4) rects.push({ u0: cursor, u1: length, y0, y1 });
  return rects;
}

/* ------------------------------------------------------------------ wall -- */

export interface WallOptions {
  key: MatKey;
  y0: number;
  y1: number;
  thickness?: number;
  openings?: Opening[];
  /** Distinct interior finish applied as a thin skin on the -Z face. */
  innerKey?: MatKey;
  /** Sill / lintel material. */
  trimKey?: MatKey;
  /** Skip the exterior face (walls buried against another building). */
  hideBack?: boolean;
  /** Randomised broken masonry along the top edge. */
  ragged?: { amplitude: number; seed: number; key?: MatKey; rebar?: boolean };
  /** Metres per texture repeat override. */
  uvScale?: number;
}

export function wall(chunk: Chunk, frame: WallFrame, opt: WallOptions): void {
  const t = opt.thickness ?? 0.35;
  const half = t * 0.5;
  const skin = opt.innerKey ? 0.025 : 0;
  /**
   * 4.2 m per texture repeat, not 2.2.
   *
   * The plaster and brick tiles carry metre-scale features — blown render
   * patches, water staining, aggregate. At 2.2 m a twelve-metre facade shows
   * the same tile five and a half times, and the eye reads the repetition as
   * one big mottled camouflage pattern rather than as a wall. Doubling the
   * repeat halves the count, doubles the feature size into something that reads
   * as real render damage, and still leaves ~5 mm texels at 1K — the shared
   * runtime detail layer covers everything finer than that.
   */
  const uv = opt.uvScale ?? 4.2;
  const rects = wallRects(frame.length, opt.y0, opt.y1, opt.openings ?? []);

  const main = chunk.m(opt.key);
  main.push(frame.matrix);
  for (const r of rects) {
    const w = (r.u1 - r.u0) * 0.5;
    const h = (r.y1 - r.y0) * 0.5;
    if (w < 1e-4 || h < 1e-4) continue;
    const faces = opt.hideBack ? FACE.ALL & ~FACE.NZ : FACE.ALL;
    main.box((r.u0 + r.u1) * 0.5, (r.y0 + r.y1) * 0.5, skin * 0.5, w, h, half - skin * 0.5, uv, faces);
  }
  main.pop();

  if (opt.innerKey) {
    const inner = chunk.m(opt.innerKey);
    inner.push(frame.matrix);
    for (const r of rects) {
      const w = (r.u1 - r.u0) * 0.5;
      const h = (r.y1 - r.y0) * 0.5;
      if (w < 1e-4 || h < 1e-4) continue;
      inner.box((r.u0 + r.u1) * 0.5, (r.y0 + r.y1) * 0.5, -half + skin * 0.5, w, h, skin * 0.5, uv, FACE.NZ);
    }
    inner.pop();
  }

  // Trim: a projecting sill under each window and a lintel over each opening.
  const trimKey = opt.trimKey;
  if (trimKey) {
    const trim = chunk.m(trimKey);
    trim.push(frame.matrix);
    for (const o of opt.openings ?? []) {
      if (o.noTrim) continue;
      const w = o.width * 0.5 + 0.09;
      if (o.kind !== 'door' && o.kind !== 'garage' && o.sill > opt.y0 + 0.2) {
        trim.box(o.u, o.sill - 0.045, half - 0.02, w, 0.05, half + 0.05, 1.2);
      }
      trim.box(o.u, o.sill + o.height + 0.09, half - 0.05, w, 0.09, half + 0.02, 1.2);
    }
    trim.pop();
  }

  if (opt.ragged) raggedTop(chunk, frame, opt.y1, t, opt.ragged);
}

/**
 * Broken masonry along the top of a wall — the single most valuable damage
 * silhouette. A stepped run of small blocks with a couple of bent rebar rods.
 */
export function raggedTop(
  chunk: Chunk, frame: WallFrame, y: number, thickness: number,
  o: { amplitude: number; seed: number; key?: MatKey; rebar?: boolean },
): void {
  const rand = new Rand(o.seed);
  const key = o.key ?? 'brickSoot';
  const mesher = chunk.m(key);
  mesher.push(frame.matrix);
  const step = 0.42;
  const n = Math.max(2, Math.floor(frame.length / step));
  const half = thickness * 0.5;

  /**
   * Damage is *localised*.
   *
   * Running the amplitude evenly along the whole eave turned a 25 m facade into
   * a regular sawtooth crest — a decorative motif, not blast damage, and at
   * distance it read as a repeating dentil course. Real shelling takes two or
   * three bites out of a parapet and leaves the rest standing. Each wall now
   * gets a small number of authored bite centres; between them the parapet is
   * intact and only lightly chipped.
   */
  const bites = 1 + Math.floor(frame.length / 11);
  const centres: number[] = [];
  const widths: number[] = [];
  for (let b = 0; b < bites; b++) {
    centres.push(((b + rand.range(0.25, 0.75)) / bites) * frame.length);
    widths.push(rand.range(1.6, 3.6));
  }
  const biteAt = (u: number): number => {
    let m = 0;
    for (let b = 0; b < centres.length; b++) {
      const t = Math.abs(u - centres[b]) / widths[b];
      if (t < 1) m = Math.max(m, 1 - t * t);
    }
    return m;
  };

  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) * (frame.length / n);
    // 0.1 baseline of chipping everywhere, the rest concentrated in the bites.
    const local = 0.1 + 0.9 * biteAt(u);
    const h = Math.max(0, o.amplitude * local * (0.2 + 0.8 * Math.pow(rand.next(), 1.4)));
    if (h < 0.03) continue;
    const w = (frame.length / n) * 0.5 * rand.range(0.9, 1.0);
    const d = half * rand.range(0.55, 1.0);
    mesher.box(u, y + h * 0.5, rand.range(-0.05, 0.05), w, h * 0.5, d, 1.6);
  }
  mesher.pop();

  if (o.rebar) {
    const bar = chunk.m('rust');
    bar.push(frame.matrix);
    const count = Math.max(1, Math.floor(frame.length / 2.6));
    for (let i = 0; i < count; i++) {
      const u = ((i + 0.5) / count) * frame.length + rand.range(-0.3, 0.3);
      if (biteAt(u) < 0.35) continue;      // rebar only where the wall is gone
      const len = rand.range(0.35, 0.95);
      const pts = [
        V3(u, y - 0.1, 0),
        V3(u + rand.range(-0.08, 0.08), y + len * 0.55, rand.range(-0.05, 0.05)),
        V3(u + rand.range(-0.35, 0.35), y + len, rand.range(-0.25, 0.25)),
      ];
      bar.tube(pts, 0.012, 4, false, 0.4);
    }
    bar.pop();
  }
}

/* ---------------------------------------------------------------- window -- */

export interface WindowOptions {
  frameKey?: MatKey;
  glassKey?: MatKey;
  /** Number of vertical panes. */
  cols?: number;
  rows?: number;
  /** Depth the frame sits back from the exterior face. */
  inset?: number;
  wallThickness?: number;
  /** 0 = intact, 1 = every pane gone. */
  broken?: number;
  seed?: number;
  boarded?: boolean;
  /** Draw curtains behind the glass. */
  curtainKey?: MatKey;
  /**
   * Hung shutters. A row of seven windows on an exact pitch with identical
   * frames is the loudest repeat a procedural facade produces; the structural
   * rhythm is correct and must stay, so the variation has to go into what is
   * *hung in* the openings. 'open' folds both leaves back against the render,
   * 'half' leaves one across the glass, 'closed' shuts the window up.
   */
  shutters?: 'none' | 'open' | 'half' | 'closed';
  shutterKey?: MatKey;
}

export function windowUnit(chunk: Chunk, frame: WallFrame, o: Opening, opt: WindowOptions = {}): void {
  const frameKey = opt.frameKey ?? 'woodPaint';
  const glassKey = opt.glassKey ?? 'glassDirty';
  const t = opt.wallThickness ?? 0.35;
  const inset = opt.inset ?? 0.11;
  const half = t * 0.5;
  const z = half - inset;
  const cols = opt.cols ?? 2;
  const rows = opt.rows ?? 2;
  const broken = opt.broken ?? o.broken ?? 0;
  const rand = new Rand(opt.seed ?? Math.floor(o.u * 977 + o.sill * 131));

  const w = o.width, h = o.height;
  const u0 = o.u - w * 0.5, u1 = o.u + w * 0.5;
  const y0 = o.sill, y1 = o.sill + h;
  const fb = 0.055;     // frame bar half-thickness
  const fd = 0.045;     // frame depth

  const f = chunk.m(frameKey);
  f.push(frame.matrix);
  // outer frame
  f.box(o.u, y0 + fb, z, w * 0.5, fb, fd, 0.9);
  f.box(o.u, y1 - fb, z, w * 0.5, fb, fd, 0.9);
  f.box(u0 + fb, (y0 + y1) * 0.5, z, fb, h * 0.5 - fb, fd, 0.9);
  f.box(u1 - fb, (y0 + y1) * 0.5, z, fb, h * 0.5 - fb, fd, 0.9);
  // mullions and transoms
  for (let c = 1; c < cols; c++) {
    const u = u0 + (w * c) / cols;
    f.box(u, (y0 + y1) * 0.5, z, 0.035, h * 0.5 - fb, fd * 0.9, 0.9);
  }
  for (let r = 1; r < rows; r++) {
    const y = y0 + (h * r) / rows;
    f.box(o.u, y, z, w * 0.5 - fb, 0.032, fd * 0.9, 0.9);
  }
  f.pop();

  // glazing, pane by pane so damage reads as individual broken panes
  const g = chunk.m(glassKey);
  g.push(frame.matrix);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (rand.next() < broken) continue;
      const pu0 = u0 + (w * c) / cols + fb;
      const pu1 = u0 + (w * (c + 1)) / cols - fb;
      const py0 = y0 + (h * r) / rows + fb;
      const py1 = y0 + (h * (r + 1)) / rows - fb;
      if (pu1 <= pu0 || py1 <= py0) continue;
      g.box((pu0 + pu1) * 0.5, (py0 + py1) * 0.5, z, (pu1 - pu0) * 0.5, (py1 - py0) * 0.5, 0.006, { unit: true });
    }
  }
  g.pop();

  // reveal lining so the wall thickness reads from inside
  const lining = chunk.m(frameKey);
  lining.push(frame.matrix);
  lining.box(o.u, y1 - 0.012, -half * 0.15, w * 0.5 - 0.02, 0.012, half * 0.85, 1.0, FACE.NY);
  lining.pop();

  if (opt.boarded || o.boarded) {
    const p = chunk.m('plank');
    p.push(frame.matrix);
    const boards = 3;
    for (let i = 0; i < boards; i++) {
      const y = y0 + h * ((i + 0.5) / boards) + rand.range(-0.06, 0.06);
      const tilt = rand.range(-0.09, 0.09);
      p.pushTRS(o.u, y, z + 0.05, 0, 0, tilt);
      p.box(0, 0, 0, w * 0.5 + 0.06, 0.075, 0.018, 1.0);
      p.pop();
    }
    p.pop();
  }

  if (opt.curtainKey && broken < 0.5 && rand.bool(0.55)) {
    const c = chunk.m(opt.curtainKey);
    c.push(frame.matrix);
    const cw = w * rand.range(0.3, 0.5);
    c.box(u0 + cw * 0.55, (y0 + y1) * 0.5 + 0.05, z - 0.09, cw * 0.5, h * 0.45, 0.02, 1.0);
    c.pop();
  }

  /* ------------------------------------------------------------ shutters */
  const sh = opt.shutters ?? 'none';
  if (sh !== 'none' && w > 0.7) {
    const s = chunk.m(opt.shutterKey ?? 'woodPaint');
    s.push(frame.matrix);
    const leafW = w * 0.5;
    const leafH = h + 0.05;
    const cy = (y0 + y1) * 0.5;
    const shutClosed = rand.bool() ? -1 : 1;
    for (const side of [-1, 1] as const) {
      // One leaf missing entirely on a fifth of them: a facade where every
      // pair is complete is still a stamped facade.
      if (rand.bool(0.16)) continue;
      const closed = sh === 'closed' || (sh === 'half' && side === shutClosed);
      // Folded back = ~π about the hinge, off true by a few degrees so the
      // leaf catches a different value from the wall behind it.
      const ang = closed ? side * rand.range(-0.05, 0.05) : side * rand.range(2.70, 3.05);
      const hingeU = o.u + side * (w * 0.5 + 0.035);
      s.pushTRS(hingeU, cy + rand.range(-0.015, 0.015), half + 0.04, ang, 0, rand.range(-0.02, 0.02));
      const cx = -side * leafW * 0.5;
      s.box(cx, 0, 0, leafW * 0.5, leafH * 0.5, 0.021, 0.55);
      // Louvres: five slats, so the leaf has a silhouette and a shadow ladder
      // rather than being a flat card.
      for (let i = 0; i < 5; i++) {
        const ly = (i / 4 - 0.5) * (leafH - 0.16);
        s.box(cx, ly, 0.023, leafW * 0.5 - 0.028, 0.021, 0.011, 0.35);
      }
      s.pop();
    }
    s.pop();
  }
}

/* ------------------------------------------------------------------ door -- */

export interface DoorOptions {
  frameKey?: MatKey;
  leafKey?: MatKey;
  wallThickness?: number;
  /** Radians the leaf hangs open; 0 removes it entirely. */
  open?: number;
  /** Hinge on the +u side instead of -u. */
  hingeRight?: boolean;
  missing?: boolean;
}

export function doorUnit(chunk: Chunk, frame: WallFrame, o: Opening, opt: DoorOptions = {}): void {
  const frameKey = opt.frameKey ?? 'woodPaint';
  const leafKey = opt.leafKey ?? 'wood';
  const t = opt.wallThickness ?? 0.35;
  const half = t * 0.5;
  const z = half - 0.09;
  const w = o.width, h = o.height;
  const u0 = o.u - w * 0.5, u1 = o.u + w * 0.5;

  const f = chunk.m(frameKey);
  f.push(frame.matrix);
  f.box(u0 + 0.05, o.sill + h * 0.5, z, 0.05, h * 0.5, 0.07, 0.8);
  f.box(u1 - 0.05, o.sill + h * 0.5, z, 0.05, h * 0.5, 0.07, 0.8);
  f.box(o.u, o.sill + h - 0.05, z, w * 0.5, 0.05, 0.07, 0.8);
  f.pop();

  if (opt.missing) return;
  const open = opt.open ?? 0;
  const leaf = chunk.m(leafKey);
  leaf.push(frame.matrix);
  const hingeU = opt.hingeRight ? u1 - 0.06 : u0 + 0.06;
  const dir = opt.hingeRight ? -1 : 1;
  leaf.pushTRS(hingeU, o.sill, z, -dir * open, 0, 0);
  leaf.box(dir * (w * 0.5 - 0.06), h * 0.5 - 0.03, 0, w * 0.5 - 0.07, h * 0.5 - 0.05, 0.024, 1.1);
  // recessed panels
  for (let i = 0; i < 2; i++) {
    leaf.box(dir * (w * 0.5 - 0.06), h * (0.28 + i * 0.42), 0.028, w * 0.28, h * 0.15, 0.008, 1.1);
  }
  leaf.pop();
  leaf.pop();
}

/* ------------------------------------------------------------ floor slab -- */

export function slab(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number,
  y: number, thickness = 0.28, ceilingKey?: MatKey, uvScale = 2.2,
): void {
  const m = chunk.m(key);
  const skin = ceilingKey ? 0.03 : 0;
  m.boxMinMax(
    Math.min(x0, x1), y - thickness + skin, Math.min(z0, z1),
    Math.max(x0, x1), y, Math.max(z0, z1),
    uvScale, ceilingKey ? FACE.ALL & ~FACE.NY : FACE.ALL,
  );
  if (ceilingKey) {
    const c = chunk.m(ceilingKey);
    c.boxMinMax(
      Math.min(x0, x1), y - thickness, Math.min(z0, z1),
      Math.max(x0, x1), y - thickness + skin, Math.max(z0, z1),
      uvScale, FACE.NY,
    );
  }
}

/** Slab with a rectangular hole cut for a stairwell or a shell crater. */
export function slabWithHole(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number,
  hx0: number, hz0: number, hx1: number, hz1: number,
  y: number, thickness = 0.28, ceilingKey?: MatKey,
): void {
  const xs = [Math.min(x0, x1), Math.max(Math.min(x0, x1), hx0), Math.min(Math.max(x0, x1), hx1), Math.max(x0, x1)];
  const zs = [Math.min(z0, z1), Math.max(Math.min(z0, z1), hz0), Math.min(Math.max(z0, z1), hz1), Math.max(z0, z1)];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      if (xs[i + 1] - xs[i] < 1e-3 || zs[j + 1] - zs[j] < 1e-3) continue;
      slab(chunk, key, xs[i], zs[j], xs[i + 1], zs[j + 1], y, thickness, ceilingKey);
    }
  }
}

/* ---------------------------------------------------------------- stairs -- */

export interface StairOptions {
  key: MatKey;
  /** Direction the flight climbs: +x, -x, +z, -z. */
  dir: '+x' | '-x' | '+z' | '-z';
  /** Start (bottom) of the flight, at the outside edge of the first riser. */
  x: number; z: number;
  yBottom: number; yTop: number;
  width: number;
  riser?: number;
  going?: number;
  /** Solid side walls instead of open stringers. */
  walls?: boolean;
  wallKey?: MatKey;
  railKey?: MatKey;
  railSides?: ('left' | 'right')[];
}

export function stairs(chunk: Chunk, opt: StairOptions): { length: number; endX: number; endZ: number } {
  const rise = opt.riser ?? 0.175;
  const going = opt.going ?? 0.285;
  const total = opt.yTop - opt.yBottom;
  const steps = Math.max(1, Math.round(total / rise));
  const r = total / steps;
  const length = steps * going;
  const hw = opt.width * 0.5;

  const yaw = opt.dir === '+x' ? 0 : opt.dir === '-x' ? Math.PI : opt.dir === '+z' ? -Math.PI / 2 : Math.PI / 2;
  const m = chunk.m(opt.key);
  m.pushTRS(opt.x, opt.yBottom, opt.z, yaw);
  for (let i = 0; i < steps; i++) {
    const y = r * (i + 1);
    // Tread plus the closed riser under it; a 2 cm nosing catches the key light.
    m.box(going * (i + 0.5), y - 0.03, 0, going * 0.5 + 0.02, 0.03, hw, 1.4);
    m.box(going * (i + 0.5), (y - 0.06) * 0.5, 0, going * 0.5, (y - 0.06) * 0.5, hw - 0.005, 1.4);
  }
  if (opt.walls) {
    const wk = chunk.m(opt.wallKey ?? opt.key);
    wk.push(m.matrix);
    for (const side of [-1, 1]) {
      wk.box(length * 0.5, total * 0.5 + 0.45, side * (hw + 0.09), length * 0.5, total * 0.5 + 0.45, 0.09, 1.6);
    }
    wk.pop();
  }
  m.pop();

  if (opt.railKey) {
    const rail = chunk.m(opt.railKey);
    rail.pushTRS(opt.x, opt.yBottom, opt.z, yaw);
    for (const side of opt.railSides ?? ['left', 'right']) {
      const s = side === 'left' ? -1 : 1;
      const zoff = s * (hw - 0.05);
      // handrail: one swept tube following the flight
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= steps; i += Math.max(1, Math.floor(steps / 4))) {
        pts.push(V3(going * i, r * i + 0.95, zoff));
      }
      pts.push(V3(length, total + 0.95, zoff));
      rail.tube(pts, 0.024, 6, true, 0.6);
      const posts = Math.max(2, Math.floor(steps / 3));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const u = t * length;
        const y = t * total;
        rail.box(u, y + 0.475, zoff, 0.018, 0.475, 0.018, 0.4);
      }
    }
    rail.pop();
  }

  const dx = opt.dir === '+x' ? length : opt.dir === '-x' ? -length : 0;
  const dz = opt.dir === '+z' ? length : opt.dir === '-z' ? -length : 0;
  return { length, endX: opt.x + dx, endZ: opt.z + dz };
}

/* --------------------------------------------------------------- railing -- */

export function railing(
  chunk: Chunk, key: MatKey, points: THREE.Vector3[], height = 1.05,
  style: 'pipe' | 'bar' | 'ornate' = 'pipe',
): void {
  if (points.length < 2) return;
  const m = chunk.m(key);
  const top = points.map((p) => V3(p.x, p.y + height, p.z));
  m.tube(top, 0.026, 6, true, 0.6);
  if (style !== 'ornate') {
    const mid = points.map((p) => V3(p.x, p.y + height * 0.52, p.z));
    m.tube(mid, 0.018, 5, true, 0.6);
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.round(len / 1.15));
    for (let k = 0; k <= n; k++) {
      if (k === n && i < points.length - 2) continue;
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      m.box(x, y + height * 0.5, z, 0.026, height * 0.5, 0.026, 0.5);
    }
    if (style === 'ornate') {
      const bal = Math.max(2, Math.round(len / 0.24));
      for (let k = 1; k < bal; k++) {
        const t = k / bal;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const z = a.z + (b.z - a.z) * t;
        m.pushTRS(x, y + (height - 0.06) * 0.5, z);
        m.cylinder(0.024, 0.02, height - 0.06, 5, false, false, 0.4);
        m.pop();
      }
    }
  }
}

/* --------------------------------------------------------------- balcony -- */

export interface BalconyOptions {
  slabKey: MatKey;
  railKey: MatKey;
  /** Wall-local centre and width. */
  u: number; width: number;
  y: number;
  depth?: number;
  wallThickness?: number;
  bracketKey?: MatKey;
  style?: 'pipe' | 'bar' | 'ornate';
}

export function balcony(chunk: Chunk, frame: WallFrame, opt: BalconyOptions): void {
  const depth = opt.depth ?? 1.15;
  const half = (opt.wallThickness ?? 0.35) * 0.5;
  const s = chunk.m(opt.slabKey);
  s.push(frame.matrix);
  s.box(opt.u, opt.y - 0.07, half + depth * 0.5, opt.width * 0.5, 0.07, depth * 0.5, 1.6);
  s.pop();

  if (opt.bracketKey) {
    const b = chunk.m(opt.bracketKey);
    b.push(frame.matrix);
    for (const side of [-1, 1]) {
      const u = opt.u + side * (opt.width * 0.5 - 0.16);
      b.pushTRS(u, opt.y - 0.14, half + depth * 0.45, 0, 0, 0);
      b.box(0, 0, 0, 0.05, 0.05, depth * 0.45, 0.5);
      b.pop();
      b.pushTRS(u, opt.y - 0.42, half + depth * 0.2, 0, 0, -0.9);
      b.box(0, 0, 0, 0.04, 0.04, 0.42, 0.5);
      b.pop();
    }
    b.pop();
  }

  const p0 = frame.point(opt.u - opt.width * 0.5 + 0.05, opt.y, half + 0.05);
  const p1 = frame.point(opt.u - opt.width * 0.5 + 0.05, opt.y, half + depth - 0.05);
  const p2 = frame.point(opt.u + opt.width * 0.5 - 0.05, opt.y, half + depth - 0.05);
  const p3 = frame.point(opt.u + opt.width * 0.5 - 0.05, opt.y, half + 0.05);
  railing(chunk, opt.railKey, [p0, p1, p2, p3], 1.02, opt.style ?? 'ornate');
}

/* ----------------------------------------------------------------- arches -- */

/**
 * A semicircular arch built from voussoirs, with the wall above it. Used for
 * the town-hall arcade, the passage through the south apartment block and the
 * market colonnade.
 */
export function archOpening(
  chunk: Chunk, frame: WallFrame, key: MatKey,
  u: number, width: number, springY: number, wallTop: number, thickness = 0.5,
  segments = 9, trimKey?: MatKey,
): void {
  const r = width * 0.5;
  const half = thickness * 0.5;
  const m = chunk.m(trimKey ?? key);
  m.push(frame.matrix);
  for (let i = 0; i < segments; i++) {
    const a0 = Math.PI * (i / segments);
    const a1 = Math.PI * ((i + 1) / segments);
    const am = (a0 + a1) * 0.5;
    const depth = 0.36;
    const cx = u - Math.cos(am) * (r + depth * 0.5);
    const cy = springY + Math.sin(am) * (r + depth * 0.5);
    const w = (Math.PI * r) / segments * 0.62;
    m.pushTRS(cx, cy, 0, 0, 0, am - Math.PI / 2);
    m.box(0, 0, 0, w, depth * 0.5, half, 1.2);
    m.pop();
  }
  m.pop();

  // spandrel wall above the arch
  const s = chunk.m(key);
  s.push(frame.matrix);
  const top = springY + r + 0.36;
  if (wallTop > top) {
    s.box(u, (top + wallTop) * 0.5, 0, r + 0.4, (wallTop - top) * 0.5, half, 2.2);
  }
  const cols = 7;
  for (let i = 0; i < cols; i++) {
    const t = (i + 0.5) / cols;
    const px = u - r + width * t;
    const dx = (px - u) / r;
    const yTop = springY + Math.sqrt(Math.max(0, 1 - dx * dx)) * r + 0.36;
    if (top > yTop) s.box(px, (yTop + top) * 0.5, 0, (width / cols) * 0.5, (top - yTop) * 0.5, half, 2.2);
  }
  s.pop();
}

export function column(
  chunk: Chunk, key: MatKey, x: number, z: number, y0: number, y1: number,
  radius = 0.24, style: 'round' | 'square' = 'round', capKey?: MatKey,
): void {
  const m = chunk.m(key);
  const h = y1 - y0;
  if (style === 'round') {
    m.pushTRS(x, y0 + h * 0.5, z);
    m.cylinder(radius, radius * 0.94, h, 12, false, false, 1.2);
    m.pop();
  } else {
    m.box(x, y0 + h * 0.5, z, radius, h * 0.5, radius, 1.2);
  }
  const cap = chunk.m(capKey ?? key);
  cap.box(x, y0 + 0.06, z, radius * 1.35, 0.06, radius * 1.35, 1.0);
  cap.box(x, y1 - 0.08, z, radius * 1.4, 0.08, radius * 1.4, 1.0);
}

/* --------------------------------------------------------------- cornice -- */

/**
 * Projecting horizontal band around a rectangular footprint. `sides` is a
 * bitmask — bit 0 = −Z, 1 = −X, 2 = +Z, 3 = +X — so party walls between
 * terraced blocks can be skipped instead of z-fighting.
 */
export function cornice(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number,
  y: number, projection = 0.16, height = 0.22, sides = 0b1111,
): void {
  const m = chunk.m(key);
  const p = projection;
  if (sides & 1) m.boxMinMax(x0 - p, y, z0 - p, x1 + p, y + height, z0 + 0.02, 1.4);
  if (sides & 4) m.boxMinMax(x0 - p, y, z1 - 0.02, x1 + p, y + height, z1 + p, 1.4);
  if (sides & 2) m.boxMinMax(x0 - p, y, z0 - p, x0 + 0.02, y + height, z1 + p, 1.4);
  if (sides & 8) m.boxMinMax(x1 - 0.02, y, z0 - p, x1 + p, y + height, z1 + p, 1.4);
}

/** Roof-edge wall with a coping stone on top. */
export function parapet(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number,
  y: number, height = 0.85, thickness = 0.26, copingKey?: MatKey,
  gaps: { x0: number; z0: number; x1: number; z1: number }[] = [],
): void {
  const t = thickness;
  const runs: [number, number, number, number][] = [
    [x0, z0, x1, z0 + t],
    [x0, z1 - t, x1, z1],
    [x0, z0 + t, x0 + t, z1 - t],
    [x1 - t, z0 + t, x1, z1 - t],
  ];
  const m = chunk.m(key);
  const c = chunk.m(copingKey ?? key);
  // Runs are subdivided so a gap removes only the span it covers — a doorway on
  // to the roof, a fire-escape landing — rather than a whole edge.
  for (const [ax, az, bx, bz] of runs) {
    const alongX = (bx - ax) > (bz - az);
    const len = alongX ? bx - ax : bz - az;
    const steps = Math.max(1, Math.round(len / 1.2));
    for (let i = 0; i < steps; i++) {
      const s0 = i / steps, s1 = (i + 1) / steps;
      const sx0 = alongX ? ax + (bx - ax) * s0 : ax;
      const sx1 = alongX ? ax + (bx - ax) * s1 : bx;
      const sz0 = alongX ? az : az + (bz - az) * s0;
      const sz1 = alongX ? bz : az + (bz - az) * s1;
      let skip = false;
      for (const g of gaps) {
        if (sx0 < g.x1 && sx1 > g.x0 && sz0 < g.z1 && sz1 > g.z0) { skip = true; break; }
      }
      if (skip) continue;
      m.boxMinMax(sx0, y, sz0, sx1, y + height - 0.07, sz1, 1.8);
      c.boxMinMax(sx0 - 0.04, y + height - 0.07, sz0 - 0.04, sx1 + 0.04, y + height, sz1 + 0.04, 1.2);
    }
  }
}

/* ------------------------------------------------------------------ roofs -- */

export function roofFlat(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number, y: number, thickness = 0.3,
  ceilingKey?: MatKey,
): void {
  slab(chunk, key, x0, z0, x1, z1, y, thickness, ceilingKey, 2.6);
}

/**
 * Pitched roof over a rectangular footprint with eaves. `axis` is the ridge
 * direction. Includes gable ends and a fascia board.
 */
export function roofPitched(
  chunk: Chunk, key: MatKey,
  x0: number, z0: number, x1: number, z1: number,
  eaveY: number, ridgeRise: number, overhang = 0.45,
  axis: 'x' | 'z' = 'x', gableKey?: MatKey, ridgeKey?: MatKey,
): void {
  const ox0 = x0 - overhang, ox1 = x1 + overhang;
  const oz0 = z0 - overhang, oz1 = z1 + overhang;
  const ridgeY = eaveY + ridgeRise;
  const m = chunk.m(key);

  if (axis === 'x') {
    const zm = (oz0 + oz1) * 0.5;
    const slopeThickness = 0.14;
    for (const side of [-1, 1]) {
      const zEdge = side < 0 ? oz0 : oz1;
      const a = V3(ox0, eaveY, zEdge);
      const b = V3(ox1, eaveY, zEdge);
      const c = V3(ox1, ridgeY, zm);
      const d = V3(ox0, ridgeY, zm);
      if (side < 0) m.quad(a, b, c, d, 1.1); else m.quad(d, c, b, a, 1.1);
      // underside so the eaves are not paper-thin
      const a2 = V3(ox0, eaveY - slopeThickness, zEdge);
      const b2 = V3(ox1, eaveY - slopeThickness, zEdge);
      const c2 = V3(ox1, ridgeY - slopeThickness, zm);
      const d2 = V3(ox0, ridgeY - slopeThickness, zm);
      if (side < 0) m.quad(d2, c2, b2, a2, 1.4); else m.quad(a2, b2, c2, d2, 1.4);
      // fascia at the eave
      m.boxMinMax(ox0, eaveY - slopeThickness, zEdge - 0.04, ox1, eaveY, zEdge + 0.04, 1.0);
    }
    // gable walls
    const g = chunk.m(gableKey ?? key);
    for (const ex of [x0, x1]) {
      const sign = ex === x0 ? -1 : 1;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const zA = oz0 + (zm - oz0) * t0, zB = oz0 + (zm - oz0) * t1;
        const yTop = eaveY + ridgeRise * ((t0 + t1) * 0.5);
        g.boxMinMax(ex - 0.16, eaveY - 0.2, zA, ex + 0.16, yTop, zB, 2.0);
        const zA2 = oz1 - (oz1 - zm) * t0, zB2 = oz1 - (oz1 - zm) * t1;
        g.boxMinMax(ex - 0.16, eaveY - 0.2, Math.min(zA2, zB2), ex + 0.16, yTop, Math.max(zA2, zB2), 2.0);
      }
      void sign;
    }
    const r = chunk.m(ridgeKey ?? key);
    r.boxMinMax(ox0, ridgeY - 0.06, zm - 0.11, ox1, ridgeY + 0.07, zm + 0.11, 0.8);
  } else {
    const xm = (ox0 + ox1) * 0.5;
    const slopeThickness = 0.14;
    for (const side of [-1, 1]) {
      const xEdge = side < 0 ? ox0 : ox1;
      const a = V3(xEdge, eaveY, oz1);
      const b = V3(xEdge, eaveY, oz0);
      const c = V3(xm, ridgeY, oz0);
      const d = V3(xm, ridgeY, oz1);
      if (side < 0) m.quad(a, b, c, d, 1.1); else m.quad(d, c, b, a, 1.1);
      const a2 = V3(xEdge, eaveY - slopeThickness, oz1);
      const b2 = V3(xEdge, eaveY - slopeThickness, oz0);
      const c2 = V3(xm, ridgeY - slopeThickness, oz0);
      const d2 = V3(xm, ridgeY - slopeThickness, oz1);
      if (side < 0) m.quad(d2, c2, b2, a2, 1.4); else m.quad(a2, b2, c2, d2, 1.4);
      m.boxMinMax(xEdge - 0.04, eaveY - slopeThickness, oz0, xEdge + 0.04, eaveY, oz1, 1.0);
    }
    const g = chunk.m(gableKey ?? key);
    for (const ez of [z0, z1]) {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const xA = ox0 + (xm - ox0) * t0, xB = ox0 + (xm - ox0) * t1;
        const yTop = eaveY + ridgeRise * ((t0 + t1) * 0.5);
        g.boxMinMax(xA, eaveY - 0.2, ez - 0.16, xB, yTop, ez + 0.16, 2.0);
        const xA2 = ox1 - (ox1 - xm) * t0, xB2 = ox1 - (ox1 - xm) * t1;
        g.boxMinMax(Math.min(xA2, xB2), eaveY - 0.2, ez - 0.16, Math.max(xA2, xB2), yTop, ez + 0.16, 2.0);
      }
    }
    const r = chunk.m(ridgeKey ?? key);
    r.boxMinMax(xm - 0.11, ridgeY - 0.06, oz0, xm + 0.11, ridgeY + 0.07, oz1, 0.8);
  }
}

/* ------------------------------------------------------------- attachments */

export function chimney(
  chunk: Chunk, key: MatKey, x: number, z: number, yBase: number, height: number,
  w = 0.62, d = 0.62, potKey?: MatKey,
): void {
  const m = chunk.m(key);
  m.box(x, yBase + height * 0.5, z, w * 0.5, height * 0.5, d * 0.5, 1.5);
  m.box(x, yBase + height + 0.06, z, w * 0.5 + 0.07, 0.06, d * 0.5 + 0.07, 1.0);
  const p = chunk.m(potKey ?? key);
  for (const s of [-1, 1]) {
    p.pushTRS(x + s * w * 0.2, yBase + height + 0.28, z);
    p.cylinder(0.11, 0.1, 0.44, 8, false, false, 0.5);
    p.pop();
  }
}

export function downpipe(
  chunk: Chunk, key: MatKey, x: number, z: number, y0: number, y1: number, radius = 0.055,
): void {
  const m = chunk.m(key);
  m.pushTRS(x, (y0 + y1) * 0.5, z);
  m.cylinder(radius, radius, y1 - y0, 8, false, false, 0.6);
  m.pop();
  for (let y = y0 + 0.8; y < y1; y += 1.9) {
    m.pushTRS(x, y, z);
    m.torus(radius + 0.018, 0.014, 8, 5, 0.3);
    m.pop();
  }
}

/** Gutter running along an eave. */
export function gutter(
  chunk: Chunk, key: MatKey, x0: number, z: number, x1: number, y: number, axis: 'x' | 'z' = 'x',
): void {
  const m = chunk.m(key);
  const len = Math.abs(x1 - x0);
  const mid = (x0 + x1) * 0.5;
  if (axis === 'x') {
    m.pushTRS(mid, y, z, 0, 0, Math.PI / 2);
    m.cylinder(0.075, 0.075, len, 8, false, false, 0.6, Math.PI, 0);
    m.pop();
  } else {
    m.pushTRS(z, y, mid, Math.PI / 2, 0, Math.PI / 2);
    m.cylinder(0.075, 0.075, len, 8, false, false, 0.6, Math.PI, 0);
    m.pop();
  }
}

/**
 * Steel fire escape: stacked landings joined by ladders, bolted to a facade.
 * This is the rooftop route's entry point on the west block.
 */
export function fireEscape(
  chunk: Chunk, frame: WallFrame, u: number, levels: number[], width = 1.6, depth = 1.35,
  gratingKey: MatKey = 'grate', steelKey: MatKey = 'rust',
): void {
  const g = chunk.m(gratingKey);
  const s = chunk.m(steelKey);
  g.push(frame.matrix);
  s.push(frame.matrix);
  const z0 = 0.2;
  for (let i = 0; i < levels.length; i++) {
    const y = levels[i];
    g.box(u, y - 0.03, z0 + depth * 0.5, width * 0.5, 0.03, depth * 0.5, 1.0);
    // railings
    for (const side of [-1, 1]) {
      s.box(u + side * width * 0.5, y + 0.5, z0 + depth * 0.5, 0.022, 0.5, depth * 0.5, 0.5, FACE.SIDES);
    }
    s.box(u, y + 0.5, z0 + depth, width * 0.5, 0.5, 0.022, 0.5, FACE.SIDES);
    s.box(u, y + 1.0, z0 + depth, width * 0.5 + 0.02, 0.025, 0.05, 0.4);
    // brackets into the wall
    for (const side of [-1, 1]) {
      s.pushTRS(u + side * (width * 0.5 - 0.1), y - 0.35, z0 + 0.3, 0, 0, -0.85);
      s.box(0, 0, 0, 0.035, 0.035, 0.5, 0.4);
      s.pop();
    }
    // ladder up to the next landing
    if (i + 1 < levels.length) {
      const yTop = levels[i + 1];
      const lu = u + width * 0.5 - 0.35;
      for (const side of [-1, 1]) {
        s.box(lu + side * 0.22, (y + yTop) * 0.5, z0 + depth - 0.22, 0.022, (yTop - y) * 0.5, 0.022, 0.4);
      }
      const rungs = Math.max(2, Math.round((yTop - y) / 0.3));
      for (let k = 1; k < rungs; k++) {
        const ry = y + ((yTop - y) * k) / rungs;
        s.box(lu, ry, z0 + depth - 0.22, 0.22, 0.012, 0.012, 0.3);
      }
    }
  }
  g.pop();
  s.pop();
}

/* ------------------------------------------------------------- shopfront -- */

export interface ShopfrontOptions {
  u: number;
  width: number;
  /** Height of the glazing above the stall riser. */
  height?: number;
  stallRiser?: number;
  frameKey?: MatKey;
  glassKey?: MatKey;
  fasciaKey?: MatKey;
  signKey?: MatKey;
  wallThickness?: number;
  broken?: number;
  seed?: number;
}

export function shopfront(chunk: Chunk, frame: WallFrame, opt: ShopfrontOptions): void {
  const t = opt.wallThickness ?? 0.35;
  const half = t * 0.5;
  const riser = opt.stallRiser ?? 0.55;
  const h = opt.height ?? 2.35;
  const frameKey = opt.frameKey ?? 'steelPaint';
  const glassKey = opt.glassKey ?? 'glassDirty';
  const rand = new Rand(opt.seed ?? 17);
  const z = half - 0.12;

  const stall = chunk.m('stoneTrim');
  stall.push(frame.matrix);
  stall.box(opt.u, riser * 0.5, half - 0.06, opt.width * 0.5, riser * 0.5, 0.06, 1.0);
  stall.pop();

  const f = chunk.m(frameKey);
  f.push(frame.matrix);
  f.box(opt.u, riser + 0.04, z, opt.width * 0.5, 0.04, 0.05, 0.7);
  f.box(opt.u, riser + h - 0.05, z, opt.width * 0.5, 0.05, 0.055, 0.7);
  const bays = Math.max(2, Math.round(opt.width / 1.35));
  for (let i = 0; i <= bays; i++) {
    const u = opt.u - opt.width * 0.5 + (opt.width * i) / bays;
    f.box(u, riser + h * 0.5, z, 0.045, h * 0.5, 0.05, 0.7);
  }
  f.pop();

  const g = chunk.m(glassKey);
  g.push(frame.matrix);
  for (let i = 0; i < bays; i++) {
    if (rand.next() < (opt.broken ?? 0.35)) continue;
    const u0 = opt.u - opt.width * 0.5 + (opt.width * i) / bays + 0.05;
    const u1 = opt.u - opt.width * 0.5 + (opt.width * (i + 1)) / bays - 0.05;
    g.box((u0 + u1) * 0.5, riser + h * 0.5, z, (u1 - u0) * 0.5, h * 0.5 - 0.06, 0.007, { unit: true });
  }
  g.pop();

  const fascia = chunk.m(opt.fasciaKey ?? 'woodPaint');
  fascia.push(frame.matrix);
  fascia.box(opt.u, riser + h + 0.28, half + 0.03, opt.width * 0.5 + 0.1, 0.28, 0.09, 1.0);
  fascia.pop();

  if (opt.signKey) {
    const sign = chunk.m(opt.signKey);
    sign.push(frame.matrix);
    sign.box(opt.u, riser + h + 0.28, half + 0.11, opt.width * 0.32, 0.15, 0.02, { unit: true });
    sign.pop();
  }
}

/* ------------------------------------------------------------- utilities -- */

/** Overhead cable strung between two anchors, with a slight catenary sag. */
export function cable(
  chunk: Chunk, key: MatKey, a: THREE.Vector3, b: THREE.Vector3, sag = 0.6, radius = 0.018,
): void {
  const pts = catenary(a, b, sag, 8);
  chunk.m(key).tube(pts, radius, 4, false, 0.5);
}

/** Wall-mounted pipe run with elbows. */
export function pipeRun(chunk: Chunk, key: MatKey, points: THREE.Vector3[], radius = 0.06): void {
  chunk.m(key).tube(points, radius, 8, true, 0.8);
}

const _tmpMat = _mat;
export { _tmpMat as scratchMatrix };
