/**
 * Procedurally generated cinematic grade, baked into a 3D LUT.
 *
 * The LUT operates on display-referred, sRGB-encoded values (i.e. after the
 * tonemapper), which is exactly where a film LUT sits in a real colour pipeline
 * and keeps the 32³ grid's precision where the eye is. Each cell is graded on
 * the CPU once and uploaded as a `Data3DTexture` — no binary asset, and the
 * whole look is a handful of numbers a designer can tune.
 *
 * The default is the modern-shooter look: teal-shifted shadows, warm highlights,
 * a filmic S-curve with a slightly crushed toe, and highlight desaturation so
 * blown areas bleach toward white instead of clipping to a hue.
 */

import * as THREE from 'three';

export interface GradeSettings {
  /** Filmic S-curve amount around the mid-grey pivot. */
  contrast: number;
  /** Extra log-space contrast (gamma about the pivot). */
  gamma: number;
  saturation: number;
  /** Multiplicative tint applied at the black end. */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  shadowStrength: number;
  highlightStrength: number;
  /** Toe lift/crush: positive lifts blacks (haze), negative crushes them. */
  lift: number;
  gain: number;
  /** How quickly bright pixels bleach toward white. */
  highlightDesat: number;
  /** Colour-temperature shift baked into the LUT, in [-1,1] (warm positive). */
  warmth: number;
}

export const DEFAULT_GRADE: GradeSettings = {
  contrast: 0.22,
  gamma: 1.04,
  saturation: 1.06,
  shadowTint: [0.88, 0.99, 1.10],
  highlightTint: [1.07, 1.0, 0.9],
  shadowStrength: 0.34,
  highlightStrength: 0.34,
  // A hair of toe lift. Shipped games keep shadows deep but never at zero —
  // a true 0,0,0 shadow is the giveaway that nothing bounced into it.
  lift: 0.0015,
  gain: 1.01,
  highlightDesat: 0.22,
  warmth: 0.05,
};

const SIZE = 32;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Applies the grade to one linear RGB triple, in place. */
function gradeLinear(rgb: Float32Array, g: GradeSettings): void {
  const pivot = 0.18;

  // 1 — log-space gamma about mid grey (overall contrast).
  for (let i = 0; i < 3; i++) {
    const v = Math.max(rgb[i], 1e-5);
    rgb[i] = Math.pow(2, Math.log2(pivot) + (Math.log2(v) - Math.log2(pivot)) * g.gamma);
  }

  // 2 — filmic S-curve in display space; pinned at 0 and 1 so nothing clips.
  for (let i = 0; i < 3; i++) {
    const d = Math.min(1, Math.max(0, linearToSrgb(rgb[i])));
    const s = smoothstep(d);
    rgb[i] = srgbToLinear(d + (s - d) * g.contrast);
  }

  // 3 — split toning by luminance. `dl` MUST be clamped: pow() of a negative
  // base is NaN, and a single NaN cell bakes a black hole into the LUT that
  // every pixel above display white then lands in.
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const dl = Math.min(1, Math.max(0, linearToSrgb(lum)));
  const shadowW = Math.pow(1 - dl, 2.2) * g.shadowStrength;
  const highW = Math.pow(dl, 2.0) * g.highlightStrength;
  for (let i = 0; i < 3; i++) {
    const st = 1 + (g.shadowTint[i] - 1) * shadowW;
    const ht = 1 + (g.highlightTint[i] - 1) * highW;
    rgb[i] *= st * ht;
  }

  // 4 — warmth (a plain R/B trade, kept small; the real white balance lives in
  //     linear space before the tonemapper).
  rgb[0] *= 1 + g.warmth * 0.06;
  rgb[2] *= 1 - g.warmth * 0.06;

  // 5 — saturation about the new luminance.
  const lum2 = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  for (let i = 0; i < 3; i++) rgb[i] = lum2 + (rgb[i] - lum2) * g.saturation;

  // 6 — lift / gain.
  for (let i = 0; i < 3; i++) rgb[i] = Math.max(0, rgb[i] * g.gain + g.lift);

  // 7 — highlight bleach: real film loses saturation before it clips.
  const lum3 = Math.min(1, Math.max(0, 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]));
  const bleach = Math.pow(lum3, 5) * g.highlightDesat;
  for (let i = 0; i < 3; i++) rgb[i] += (1 - rgb[i]) * bleach;

  // Belt and braces: never let a non-finite value reach the texture.
  for (let i = 0; i < 3; i++) if (!Number.isFinite(rgb[i])) rgb[i] = 0;
}

let cache: { tex: THREE.Data3DTexture; key: string } | null = null;

export function gradeLutTexture(settings: GradeSettings): THREE.Data3DTexture {
  const key = JSON.stringify(settings);
  if (cache && cache.key === key) return cache.tex;
  if (cache) cache.tex.dispose();

  const data = new Uint8Array(SIZE * SIZE * SIZE * 4);
  const rgb = new Float32Array(3);
  let p = 0;
  for (let b = 0; b < SIZE; b++) {
    for (let gI = 0; gI < SIZE; gI++) {
      for (let r = 0; r < SIZE; r++) {
        rgb[0] = srgbToLinear(r / (SIZE - 1));
        rgb[1] = srgbToLinear(gI / (SIZE - 1));
        rgb[2] = srgbToLinear(b / (SIZE - 1));
        gradeLinear(rgb, settings);
        data[p++] = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[0]))) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[1]))) * 255);
        data[p++] = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgb[2]))) * 255);
        data[p++] = 255;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  tex.name = 'colorGradeLUT';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  cache = { tex, key };
  return tex;
}

export const LUT_SIZE = SIZE;

/**
 * White-balance LMS coefficients (Unity's formulation) for a temperature/tint
 * pair in [-100,100]. Applied in linear space before the tonemapper.
 */
export function whiteBalanceCoeffs(temperature: number, tint: number, out: THREE.Vector3): THREE.Vector3 {
  const t1 = temperature / 65;
  const t2 = tint / 65;
  const x = 0.31271 - t1 * (t1 < 0 ? 0.1 : 0.05);
  const y = (2.87 * x - 3 * x * x - 0.27509507) + t2 * 0.05;

  const Y = 1;
  const X = (Y * x) / y;
  const Z = (Y * (1 - x - y)) / y;
  const L = 0.7328 * X + 0.4296 * Y - 0.1624 * Z;
  const M = -0.7036 * X + 1.6975 * Y + 0.0061 * Z;
  const S = 0.003 * X + 0.0136 * Y + 0.9834 * Z;

  return out.set(0.949237 / L, 1.03542 / M, 1.08728 / S);
}
