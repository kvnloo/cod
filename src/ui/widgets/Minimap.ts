/**
 * Minimap — top left.
 *
 * The map is generated, not authored: on first draw the widget walks the scene
 * graph, projects every mesh's oriented bounding box onto the ground plane and
 * keeps the convex footprint. Those polygons are then drawn as *vectors* every
 * frame, so the map is pin sharp at any zoom and any display density — a baked
 * raster looks like mush once it is scaled down into a 190 px panel.
 *
 * Runtime layer: north-up map, rotating player arrow with a vision cone, enemy
 * blips that appear when hostiles fire and fade over a few seconds, objective
 * diamonds clamped to the border when off-map, and a header carrying the mode,
 * the score and the match clock.
 */

import * as THREE from 'three';
import { bus } from '../../core/EventBus';
import { settings } from '../../core/Settings';
import { clamp01, Ease, motion, Spring, SPRING } from '../Anim';
import {
  chamferPath, clockString, corners, hairWidth, measureText, text, trianglePath,
} from '../Draw';
import type { DrawCtx } from '../Draw';
import { objectiveMarker } from '../Glyphs';
import type { HudModel } from '../Model';
import { FONT_COND, lift, rgba, type Palette } from '../Theme';
import { LAYOUT, MARGIN } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

interface Blip {
  x: number;
  z: number;
  age: number;
  life: number;
  kind: 'fire' | 'explosion' | 'death';
}

interface Footprint {
  /** Flat [x,z,…] convex hull in world space. */
  pts: number[];
  /** Vertical extent, used to shade taller structures lighter. */
  height: number;
  /** World-space AABB, precomputed so the per-frame cull is four compares. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const BLIP_CAPACITY = 32;
/** Metres visible across the minimap. */
const VIEW_METRES = 86;
/** Footprints taller than this read as structure; below it, as low cover. */
const STRUCTURE_HEIGHT = 2.6;

export class Minimap implements Widget {
  readonly name = 'minimap';

  private prints: Footprint[] = [];
  private built = false;
  private scene: THREE.Scene | null = null;

  private readonly blips: Blip[] = [];
  private blipCursor = 0;
  private readonly off: Array<() => void> = [];
  private readonly appear = new Spring(1, SPRING.heavy);
  private t = 0;
  /**
   * Footprints are composited through this rather than painted straight on to
   * the HUD. Overlapping translucent quads accumulate alpha, which is exactly
   * why the map used to read as pale blobs instead of buildings; drawing them
   * opaque into a buffer and compositing the buffer once fixes it.
   */
  private buf: HTMLCanvasElement | null = null;
  private bctx: CanvasRenderingContext2D | null = null;

  constructor(private pal: () => Palette) {
    for (let i = 0; i < BLIP_CAPACITY; i++) {
      this.blips.push({ x: 0, z: 0, age: 99, life: 3.2, kind: 'fire' });
    }
    this.off.push(bus.on('ai:fire', (e) => this.addBlip(e.origin.x, e.origin.z, 'fire')));
    this.off.push(bus.on('explosion', (e) => this.addBlip(e.point.x, e.point.z, 'explosion')));
    this.off.push(bus.on('entity:death', (e) => {
      if (e.byPlayer) this.addBlip(e.point.x, e.point.z, 'death');
    }));
    this.off.push(bus.on('level:loaded', () => { this.built = false; }));
  }

  /** Forces a rebuild of the footprint set (debug scenes call this). */
  rebuild(): void { this.built = false; }

  attachScene(scene: THREE.Scene): void { this.scene = scene; }

  /** Clears transient blips — used between capture shots. */
  clearBlips(): void {
    for (let i = 0; i < BLIP_CAPACITY; i++) this.blips[i].age = 99;
  }

  private addBlip(x: number, z: number, kind: Blip['kind']): void {
    const b = this.blips[this.blipCursor];
    this.blipCursor = (this.blipCursor + 1) % BLIP_CAPACITY;
    b.x = x; b.z = z; b.age = 0; b.kind = kind;
    b.life = kind === 'fire' ? 3.4 : kind === 'explosion' ? 2.4 : 4.5;
  }

  update(dt: number, _m: HudModel): void {
    this.t += dt;
    this.appear.step(dt);
    for (let i = 0; i < BLIP_CAPACITY; i++) {
      const b = this.blips[i];
      if (b.age < b.life) b.age += dt;
    }
  }

  /* ------------------------------------------------------- footprints -- */

  private build(): void {
    this.built = true;
    const scene = this.scene;
    if (!scene) return;

    const local = new THREE.Box3();
    const corner = new THREE.Vector3();
    const out: Footprint[] = [];

    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      // Skip the first-person view model and the sky dome.
      if (mesh.layers.mask & ((1 << 1) | (1 << 3))) return;
      const geo = mesh.geometry;
      if (!geo) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const gb = geo.boundingBox;
      if (!gb) return;
      local.copy(gb);
      mesh.updateWorldMatrix(true, false);

      const pts: number[] = [];
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 8; i++) {
        corner.set(
          i & 1 ? local.max.x : local.min.x,
          i & 2 ? local.max.y : local.min.y,
          i & 4 ? local.max.z : local.min.z,
        ).applyMatrix4(mesh.matrixWorld);
        pts.push(corner.x, corner.z);
        if (corner.y < minY) minY = corner.y;
        if (corner.y > maxY) maxY = corner.y;
      }
      const hull = convexHull(pts);
      const area = polygonArea(hull);
      const height = maxY - minY;
      // Ground planes and decals are the map background, not features on it;
      // anything absurdly large is a skybox or a terrain sheet.
      if (area < 0.5 || height < 0.35 || area > 2400) return;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < hull.length; i += 2) {
        if (hull[i] < minX) minX = hull[i];
        if (hull[i] > maxX) maxX = hull[i];
        if (hull[i + 1] < minZ) minZ = hull[i + 1];
        if (hull[i + 1] > maxZ) maxZ = hull[i + 1];
      }
      out.push({ pts: hull, height, minX, maxX, minZ, maxZ });
    });

    // Tallest last so buildings read on top of low cover.
    out.sort((a, b) => a.height - b.height);
    this.prints = out;
  }

  /* --------------------------------------------------------- draw ------ */

  draw(d: DrawCtx, m: HudModel): void {
    if (!ui.prefs.showMinimap) return;
    if (!this.built) this.build();

    const p = this.pal();
    const c = d.c;
    const s = d.s;
    const size = LAYOUT.minimapSize * s;
    const x = MARGIN * s;
    const headerH = 26 * s;
    const y = MARGIN * s * 0.7 + headerH;

    const alpha = d.alpha * (1 - m.ads * 0.82);
    if (alpha <= 0.01) return;

    c.save();
    c.globalAlpha = alpha;
    c.translate(-(1 - this.appear.value) * 26 * s * motion(), 0);

    /* --------------------------------------------------- header ------- */
    this.drawHeader(d, m, x, y - headerH, size, headerH, p);

    /* --------------------------------------------------- panel -------- */
    const cut = 13 * s;
    chamferPath(c, x, y, size, size, cut);
    c.fillStyle = 'rgba(5,9,15,0.74)';
    c.fill();

    c.save();
    chamferPath(c, x, y, size, size, cut);
    c.clip();

    const pxPerM = size / VIEW_METRES;
    const cx = x + size / 2;
    const cy = y + size / 2;
    const px = m.position.x;
    const pz = m.position.z;

    /* --------------------------------------------- building footprints - */
    this.compositeMap(d, size, x, y, cx, cy, px, pz, pxPerM);

    /* --------------------------------------------------- grid --------- */
    // Drawn over the map bed, not under it, so the graticule reads as an
    // overlay on a chart rather than as texture in the ground.
    c.strokeStyle = rgba(p.hair, 0.07);
    c.lineWidth = hairWidth(d.dpr);
    const gridStep = 20 * pxPerM;
    const gx0 = cx - ((px % 20) * pxPerM) - Math.ceil(size / 2 / gridStep) * gridStep;
    for (let gx = gx0; gx < x + size + gridStep; gx += gridStep) {
      c.beginPath(); c.moveTo(gx, y); c.lineTo(gx, y + size); c.stroke();
    }
    const gy0 = cy - ((pz % 20) * pxPerM) - Math.ceil(size / 2 / gridStep) * gridStep;
    for (let gy = gy0; gy < y + size + gridStep; gy += gridStep) {
      c.beginPath(); c.moveTo(x, gy); c.lineTo(x + size, gy); c.stroke();
    }

    /* --------------------------------------------------- range rings -- */
    c.strokeStyle = rgba(p.hair, 0.11);
    c.lineWidth = hairWidth(d.dpr);
    for (const r of [20, 40]) {
      c.beginPath();
      c.arc(cx, cy, r * pxPerM, 0, Math.PI * 2);
      c.stroke();
    }

    /* --------------------------------------------------- blips -------- */
    for (let i = 0; i < BLIP_CAPACITY; i++) {
      const b = this.blips[i];
      if (b.age >= b.life) continue;
      const t = b.age / b.life;
      const bx = cx + (b.x - px) * pxPerM;
      const by = cy + (b.z - pz) * pxPerM;
      const tint = b.kind === 'death' ? p.inkDim : b.kind === 'explosion' ? p.warn : p.hostile;
      const a = 1 - Ease.inQuad(t);

      if (t < 0.45) {
        const rt = t / 0.45;
        c.strokeStyle = rgba(tint, (1 - rt) * 0.65);
        c.lineWidth = Math.max(1, 1.5 * s);
        c.beginPath();
        c.arc(bx, by, (3 + Ease.outQuart(rt) * 17) * s, 0, Math.PI * 2);
        c.stroke();
      }

      c.globalAlpha = alpha * a;
      if (b.kind === 'death') {
        c.strokeStyle = rgba(tint, 0.9);
        c.lineWidth = Math.max(1, 1.6 * s);
        c.beginPath();
        c.moveTo(bx - 3.5 * s, by - 3.5 * s); c.lineTo(bx + 3.5 * s, by + 3.5 * s);
        c.moveTo(bx + 3.5 * s, by - 3.5 * s); c.lineTo(bx - 3.5 * s, by + 3.5 * s);
        c.stroke();
      } else {
        c.fillStyle = rgba(tint, 1);
        c.beginPath();
        c.moveTo(bx, by - 5.2 * s);
        c.lineTo(bx + 5.2 * s, by);
        c.lineTo(bx, by + 5.2 * s);
        c.lineTo(bx - 5.2 * s, by);
        c.closePath();
        c.fill();
        c.strokeStyle = 'rgba(3,6,11,0.9)';
        c.lineWidth = Math.max(1, 1.1 * s);
        c.stroke();
      }
      c.globalAlpha = alpha;
    }

    /* --------------------------------------------- objective markers -- */
    for (const obj of m.objectives.values()) {
      if (!obj.position) continue;
      let ox = cx + (obj.position.x - px) * pxPerM;
      let oy = cy + (obj.position.z - pz) * pxPerM;
      const pad = 13 * s;
      const clampedX = Math.max(x + pad, Math.min(x + size - pad, ox));
      const clampedY = Math.max(y + pad, Math.min(y + size - pad, oy));
      const clipped = clampedX !== ox || clampedY !== oy;
      ox = clampedX; oy = clampedY;
      const tint = obj.kind === 'hostile' ? p.hostile : obj.kind === 'friendly' ? p.friendly : p.accent;
      objectiveMarker(
        c, ox, oy, 8.5 * s, rgba(tint, clipped ? 0.8 : 1), obj.label,
        obj.progress ?? 0, true, `700 ${(11 * s).toFixed(1)}px ${FONT_COND}`,
      );
    }

    /* --------------------------------------------------- player ------- */
    const yaw = (m.bearing * Math.PI) / 180;
    const fovRad = (settings.game.fov * Math.PI) / 180;
    const coneR = 15 * pxPerM;
    c.save();
    c.translate(cx, cy);
    c.rotate(yaw);
    const cone = c.createRadialGradient(0, 0, 0, 0, 0, coneR);
    cone.addColorStop(0, rgba(p.ink, 0.34));
    cone.addColorStop(1, rgba(p.ink, 0));
    c.fillStyle = cone;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, coneR, -Math.PI / 2 - fovRad * 0.62, -Math.PI / 2 + fovRad * 0.62);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(2,5,10,0.9)';
    trianglePath(c, 0, 0, 9.6 * s, 0);
    c.fill();
    c.fillStyle = rgba(lift(p.ink, 0.35), 1);
    trianglePath(c, 0, 0, 7.6 * s, 0);
    c.fill();
    c.restore();

    c.restore(); // clip

    /* --------------------------------------------------- frame -------- */
    chamferPath(c, x, y, size, size, cut);
    c.strokeStyle = rgba(p.hair, 0.34);
    c.lineWidth = Math.max(1, hairWidth(d.dpr) * 1.6);
    c.stroke();
    c.strokeStyle = rgba(p.hair, 0.62);
    c.lineWidth = Math.max(1, 1.2 * s);
    corners(c, x, y, size, size, 16 * s);

    // North tick.
    c.strokeStyle = rgba(p.ink, 0.55);
    c.lineWidth = Math.max(1, 1.2 * s);
    c.beginPath();
    c.moveTo(x + size / 2, y); c.lineTo(x + size / 2, y + 5 * s);
    c.stroke();
    text(c, 'N', x + size / 2, y + 16 * s, {
      size: 12 * s, weight: 700, family: 'cond', align: 'center', tracking: 1 * s,
      color: rgba(p.ink, 0.95), shadow: Math.max(1, 1.2 * s), outline: 2.4 * s,
    });

    // Scale legend.
    text(c, `${Math.round(VIEW_METRES / 2)}M`, x + size - 8 * s, y + size - 8 * s, {
      size: 10 * s, weight: 600, family: 'mono', align: 'right',
      color: rgba(p.inkDim, 0.9), shadow: 1, outline: 2.2 * s,
    });

    c.restore();
  }

  /**
   * Renders the map bed and every visible footprint into an offscreen buffer,
   * then composites it once.
   *
   * Two tiers read very differently on a 200 px panel: structures (anything a
   * player cannot shoot over) are solid silhouettes with a lit edge, and low
   * cover is a dim outline only. Painting them opaque into the buffer means two
   * overlapping walls stay one value instead of stacking into a bright blob.
   */
  private compositeMap(
    d: DrawCtx, size: number, x: number, y: number,
    cx: number, cy: number, px: number, pz: number, pxPerM: number,
  ): void {
    const bw = Math.max(2, Math.ceil(size * d.dpr));
    if (!this.buf) {
      this.buf = document.createElement('canvas');
      this.bctx = this.buf.getContext('2d');
    }
    const buf = this.buf;
    const b = this.bctx;
    if (!buf || !b) return;
    if (buf.width !== bw || buf.height !== bw) { buf.width = bw; buf.height = bw; }

    b.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
    b.clearRect(0, 0, size, size);

    // Map bed: a cool slate that the sunlit street reads as negative space
    // against. Slightly lighter toward the centre so the panel has some form.
    const bed = b.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.75);
    bed.addColorStop(0, 'rgb(30,38,50)');
    bed.addColorStop(1, 'rgb(18,24,33)');
    b.fillStyle = bed;
    b.fillRect(0, 0, size, size);

    const half = VIEW_METRES * 0.5 + 6;
    const wMinX = px - half, wMaxX = px + half;
    const wMinZ = pz - half, wMaxZ = pz + half;
    // Buffer-local centre: the panel origin is (0,0) in here.
    const ox = cx - x;
    const oy = cy - y;

    const trace = (fp: Footprint): void => {
      b.beginPath();
      for (let k = 0; k < fp.pts.length; k += 2) {
        const vx = ox + (fp.pts[k] - px) * pxPerM;
        const vy = oy + (fp.pts[k + 1] - pz) * pxPerM;
        if (k === 0) b.moveTo(vx, vy); else b.lineTo(vx, vy);
      }
      b.closePath();
    };

    // Pass 1 — low cover, dim and outline-led.
    b.lineWidth = Math.max(1, 1 * d.s);
    for (let i = 0; i < this.prints.length; i++) {
      const fp = this.prints[i];
      if (fp.height >= STRUCTURE_HEIGHT) continue;
      if (fp.maxX < wMinX || fp.minX > wMaxX || fp.maxZ < wMinZ || fp.minZ > wMaxZ) continue;
      trace(fp);
      b.fillStyle = 'rgb(44,54,68)';
      b.fill();
      b.strokeStyle = 'rgb(74,88,106)';
      b.stroke();
    }

    // Pass 2 — structures, opaque, value keyed to height so the terrace reads
    // as taller than the market stalls.
    for (let i = 0; i < this.prints.length; i++) {
      const fp = this.prints[i];
      if (fp.height < STRUCTURE_HEIGHT) continue;
      if (fp.maxX < wMinX || fp.minX > wMaxX || fp.maxZ < wMinZ || fp.minZ > wMaxZ) continue;
      const tall = clamp01((fp.height - STRUCTURE_HEIGHT) / 9);
      trace(fp);
      b.fillStyle = `rgb(${(54 + tall * 22) | 0},${(64 + tall * 26) | 0},${(80 + tall * 30) | 0})`;
      b.fill();
    }

    // Pass 3 — one edge pass over the structures. Separated from the fill so an
    // edge is never buried under the next building's body.
    b.lineWidth = Math.max(1, 1.05 * d.s);
    b.strokeStyle = 'rgba(158,180,206,0.42)';
    for (let i = 0; i < this.prints.length; i++) {
      const fp = this.prints[i];
      if (fp.height < STRUCTURE_HEIGHT) continue;
      if (fp.maxX < wMinX || fp.minX > wMaxX || fp.maxZ < wMinZ || fp.minZ > wMaxZ) continue;
      trace(fp);
      b.stroke();
    }

    // Just short of opaque: enough to read as a chart, enough transparency that
    // the panel still feels like part of the frame.
    const g = d.c;
    const prev = g.globalAlpha;
    g.globalAlpha = prev * 0.94;
    g.drawImage(buf, 0, 0, bw, bw, x, y, size, size);
    g.globalAlpha = prev;
  }

  private drawHeader(
    d: DrawCtx, m: HudModel, x: number, y: number, w: number, h: number, p: Palette,
  ): void {
    const c = d.c;
    const s = d.s;
    const clock = clockString(m.match.timeLeft);
    const clockOpts = {
      size: 17 * s, weight: 600, family: 'mono' as const, tracking: 0.5 * s,
    };
    const clockW = measureText(c, clock, clockOpts);
    text(c, clock, x + w, y + h - 8 * s, {
      ...clockOpts, align: 'right',
      color: rgba(m.match.timeLeft < 30 ? p.hostile : p.ink, 0.97),
      shadow: Math.max(1, 1.4 * s),
    });

    // Fit the mode label into whatever the clock leaves, shrinking the type
    // rather than letting the two collide.
    const label = m.match.label || m.match.mode.toUpperCase();
    const room = w - clockW - 12 * s;
    let size = 15 * s;
    let tracking = 3 * s;
    for (let i = 0; i < 6; i++) {
      if (measureText(c, label, { size, weight: 700, family: 'cond', tracking }) <= room) break;
      size *= 0.92;
      tracking *= 0.8;
    }
    text(c, label, x, y + h - 8 * s, {
      size, weight: 700, family: 'cond', tracking,
      color: rgba(p.accent, 0.98), shadow: Math.max(1, 1.4 * s),
    });
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}

/* ------------------------------------------------------------- geometry -- */

function polygonArea(flat: number[]): number {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Andrew's monotone chain over a flat [x,z,x,z,…] list. */
function convexHull(flat: number[]): number[] {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  pts.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const pt = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  const outFlat: number[] = [];
  for (const h of hull) outFlat.push(h[0], h[1]);
  return outFlat.length >= 6 ? outFlat : flat;
}
