/**
 * Procedurally generated blue-noise mask + low-discrepancy sequences.
 *
 * Nothing is loaded from disk: the mask is produced with Ulichney's
 * void-and-cluster algorithm at boot (≈60ms for 64x64) and cached for the
 * lifetime of the page. Four decorrelated channels are produced by toroidally
 * rolling the base mask by co-prime offsets — blue noise decorrelates within a
 * couple of texels, so the channels are effectively independent at any pixel.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';

const SIZE = 64;
const N = SIZE * SIZE;

/** Gaussian energy kernel; sigma 1.9 is Ulichney's recommendation. */
function buildKernel(sigma: number, radius: number): { w: Float32Array; radius: number } {
  const d = radius * 2 + 1;
  const w = new Float32Array(d * d);
  const inv = 1 / (2 * sigma * sigma);
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      w[(y + radius) * d + (x + radius)] = Math.exp(-(x * x + y * y) * inv);
    }
  }
  return { w, radius };
}

const KERNEL = buildKernel(1.9, 6);

function splat(energy: Float32Array, index: number, sign: number): void {
  const r = KERNEL.radius;
  const d = r * 2 + 1;
  const px = index % SIZE;
  const py = (index / SIZE) | 0;
  for (let y = -r; y <= r; y++) {
    const wy = ((py + y) % SIZE + SIZE) % SIZE;
    const row = wy * SIZE;
    const krow = (y + r) * d;
    for (let x = -r; x <= r; x++) {
      const wx = ((px + x) % SIZE + SIZE) % SIZE;
      energy[row + wx] += sign * KERNEL.w[krow + (x + r)];
    }
  }
}

/** Index of the tightest cluster (max energy where `state === want`). */
function findExtreme(energy: Float32Array, state: Uint8Array, want: number, maximise: boolean): number {
  let best = -1;
  let bestVal = maximise ? -Infinity : Infinity;
  for (let i = 0; i < N; i++) {
    if (state[i] !== want) continue;
    const e = energy[i];
    if (maximise ? e > bestVal : e < bestVal) { bestVal = e; best = i; }
  }
  return best;
}

/** Ulichney void-and-cluster. Returns ranks in [0, N). */
function voidAndCluster(seed: string): Float32Array {
  const rand = new Rand(seed);
  const state = new Uint8Array(N);
  const energy = new Float32Array(N);
  const rank = new Int32Array(N).fill(-1);

  // --- initial binary pattern: ~1/10 of the pixels, randomly placed.
  const initial = Math.floor(N / 10);
  let placed = 0;
  while (placed < initial) {
    const i = rand.int(0, N - 1);
    if (state[i] === 1) continue;
    state[i] = 1;
    splat(energy, i, 1);
    placed++;
  }

  // --- phase 0: relax the pattern until moving the tightest cluster into the
  //     largest void becomes a no-op.
  for (let iter = 0; iter < 4096; iter++) {
    const cluster = findExtreme(energy, state, 1, true);
    state[cluster] = 0;
    splat(energy, cluster, -1);
    const empty = findExtreme(energy, state, 0, false);
    if (empty === cluster) { state[cluster] = 1; splat(energy, cluster, 1); break; }
    state[empty] = 1;
    splat(energy, empty, 1);
  }

  // Snapshot the prototype pattern; phases 1 and 2 both start from it.
  const prototype = state.slice();
  const protoEnergy = energy.slice();

  // --- phase 1: rank the prototype's points from `ones-1` down to 0.
  for (let r = initial - 1; r >= 0; r--) {
    const cluster = findExtreme(energy, state, 1, true);
    if (cluster < 0) break;
    state[cluster] = 0;
    splat(energy, cluster, -1);
    rank[cluster] = r;
  }

  // --- phase 2: fill voids from `ones` to N/2.
  state.set(prototype);
  energy.set(protoEnergy);
  for (let r = initial; r < N / 2; r++) {
    const empty = findExtreme(energy, state, 0, false);
    if (empty < 0) break;
    state[empty] = 1;
    splat(energy, empty, 1);
    rank[empty] = r;
  }

  // --- phase 3: from N/2 to N-1 the roles invert — work on the complement so
  //     the *minority* phase (now the zeros) stays well distributed.
  energy.fill(0);
  for (let i = 0; i < N; i++) if (state[i] === 0) splat(energy, i, 1);
  for (let r = N / 2; r < N; r++) {
    const cluster = findExtreme(energy, state, 0, true);
    if (cluster < 0) break;
    state[cluster] = 1;
    splat(energy, cluster, -1);
    rank[cluster] = r;
  }

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = (rank[i] < 0 ? 0 : rank[i]) / (N - 1);
  return out;
}

let cached: THREE.DataTexture | null = null;

/**
 * 64x64 RGBA8 blue-noise mask. Channels are decorrelated rolls of one mask,
 * which is both cheaper to build and sufficient for per-pixel sample offsets.
 */
export function blueNoiseTexture(): THREE.DataTexture {
  if (cached) return cached;
  const base = voidAndCluster('blackout.bluenoise');
  const offsets: Array<[number, number]> = [[0, 0], [23, 41], [37, 11], [53, 29]];
  const data = new Uint8Array(N * 4);
  for (let c = 0; c < 4; c++) {
    const [ox, oy] = offsets[c];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = ((y + oy) % SIZE) * SIZE + ((x + ox) % SIZE);
        data[(y * SIZE + x) * 4 + c] = Math.min(255, Math.round(base[s] * 255));
      }
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'blueNoise64';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

/* -------------------------------------------------------- sequences ------- */

/** Radical inverse in an arbitrary base — the guts of Halton. */
export function radicalInverse(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * f;
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * Halton(2,3) sub-pixel jitter in NDC for TAA, centred on zero.
 *
 * `RenderSystem` should call this to build `PassContext.jitter`:
 *   haltonJitter(frame, settings.gfx.taaSamples, width, height, out)
 */
export function haltonJitter(
  frame: number, samples: number, width: number, height: number, out: THREE.Vector2,
): THREE.Vector2 {
  const i = (frame % Math.max(1, samples)) + 1;
  const x = radicalInverse(i, 2) - 0.5;
  const y = radicalInverse(i, 3) - 0.5;
  // NDC spans 2 units across `width` pixels.
  out.set((x * 2) / Math.max(1, width), (y * 2) / Math.max(1, height));
  return out;
}

/** Hammersley point set — used for GGX importance sampling in SSR. */
export function hammersley(i: number, n: number, out: [number, number]): [number, number] {
  out[0] = i / n;
  out[1] = radicalInverse(i, 2);
  return out;
}
