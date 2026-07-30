/**
 * Procedural lens-dirt mask.
 *
 * Real lens dirt is three overlapping populations: broad greasy smudges from
 * fingers and cloth, fine radial scratches from wiping, and specks of dust that
 * catch light as tiny points. Layering all three (plus an edge bias, because the
 * centre of a lens gets cleaned and the rim does not) is what makes bloom read
 * as "light through a dirty optic" rather than "a blurred copy of the frame".
 *
 * Generated once with the seeded RNG so capture runs stay reproducible.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';

const SIZE = 512;

let cached: THREE.DataTexture | null = null;

function addBlob(
  buf: Float32Array, cx: number, cy: number, rx: number, ry: number,
  rot: number, amp: number, tint: [number, number, number],
): void {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const r = Math.ceil(Math.max(rx, ry)) + 1;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      const d = u * u + v * v;
      if (d >= 1) continue;
      const f = (1 - d) * (1 - d);
      const i = (y * SIZE + x) * 3;
      buf[i] += f * amp * tint[0];
      buf[i + 1] += f * amp * tint[1];
      buf[i + 2] += f * amp * tint[2];
    }
  }
}

function addScratch(
  buf: Float32Array, x0: number, y0: number, x1: number, y1: number,
  width: number, amp: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(2, Math.ceil(len));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    // Taper the ends so scratches do not look like stamped line segments.
    const taper = Math.sin(t * Math.PI);
    addBlob(buf, px, py, width, width, 0, amp * taper * 0.35, [1, 0.98, 0.94]);
  }
}

/** 512² RGBA8 dirt mask; R/G/B carry a slight chromatic difference. */
export function lensDirtTexture(): THREE.DataTexture {
  if (cached) return cached;
  const rand = new Rand('blackout.lensdirt');
  const buf = new Float32Array(SIZE * SIZE * 3);

  // 1 — broad smudges, biased toward the frame edge.
  for (let i = 0; i < 150; i++) {
    const a = rand.next() * Math.PI * 2;
    const rr = Math.pow(rand.next(), 0.55) * 0.72;
    const cx = SIZE * (0.5 + Math.cos(a) * rr);
    const cy = SIZE * (0.5 + Math.sin(a) * rr);
    const rx = rand.range(14, 78);
    const ry = rx * rand.range(0.35, 1.0);
    const amp = rand.range(0.05, 0.34);
    addBlob(buf, cx, cy, rx, ry, rand.next() * Math.PI, amp, [
      1, rand.range(0.9, 1.0), rand.range(0.82, 1.02),
    ]);
  }

  // 2 — wipe scratches: mostly radial, a few tangential.
  for (let i = 0; i < 46; i++) {
    const a = rand.next() * Math.PI * 2;
    const r0 = rand.range(0.05, 0.5) * SIZE;
    const r1 = r0 + rand.range(0.08, 0.42) * SIZE;
    const bend = rand.signed() * 0.5;
    const cx = SIZE * 0.5, cy = SIZE * 0.5;
    addScratch(
      buf,
      cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
      cx + Math.cos(a + bend) * r1, cy + Math.sin(a + bend) * r1,
      rand.range(0.9, 2.6), rand.range(0.35, 1.1),
    );
  }

  // 3 — dust specks.
  for (let i = 0; i < 2200; i++) {
    const cx = rand.next() * SIZE;
    const cy = rand.next() * SIZE;
    const r = rand.range(0.7, 2.6);
    addBlob(buf, cx, cy, r, r, 0, rand.range(0.25, 1.5), [1, 1, 1]);
  }

  // 4 — edge bias + fine grain, then encode.
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i3 = (y * SIZE + x) * 3;
      const i4 = (y * SIZE + x) * 4;
      const nx = (x / SIZE) * 2 - 1;
      const ny = (y / SIZE) * 2 - 1;
      const rad = Math.min(1, Math.hypot(nx, ny) / 1.414);
      const edge = 0.55 + 0.75 * rad * rad;
      const grain = 0.85 + 0.3 * rand.next();
      for (let c = 0; c < 3; c++) {
        const v = Math.min(1, buf[i3 + c] * edge * grain);
        data[i4 + c] = Math.round(Math.pow(v, 0.85) * 255);
      }
      data[i4 + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'lensDirt';
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
