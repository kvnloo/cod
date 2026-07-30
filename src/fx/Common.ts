/**
 * Shared plumbing for the FX module.
 *
 * Nothing here talks to gameplay: the FX system is a pure listener on the event
 * bus, so everything it needs from the rest of the engine is either read from a
 * contract interface (`RenderAPI`, `SurfaceProps`) or duck-typed defensively so
 * a sibling module that is mid-rewrite can never break the effects.
 */

import * as THREE from 'three';
import type { SurfaceType } from '../core/Surfaces';
import type { RenderAPI } from '../render/types';

/* --------------------------------------------------------------- scratch -- */

/**
 * A tiny stack of reusable vectors. Effects run in the hot path and must not
 * allocate; `vec()` hands out a rotating scratch that is valid for the current
 * statement only.
 */
class ScratchPool<T> {
  private items: T[];
  private cursor = 0;
  constructor(make: () => T, count: number) {
    this.items = Array.from({ length: count }, make);
  }
  next(): T {
    const v = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    return v;
  }
}

const V3 = new ScratchPool(() => new THREE.Vector3(), 32);
const QT = new ScratchPool(() => new THREE.Quaternion(), 8);
const CL = new ScratchPool(() => new THREE.Color(), 16);

export function vec(x = 0, y = 0, z = 0): THREE.Vector3 { return V3.next().set(x, y, z); }
export function quat(): THREE.Quaternion { return QT.next(); }
export function col(r = 0, g = 0, b = 0): THREE.Color { return CL.next().setRGB(r, g, b); }

/* ------------------------------------------------------------------ math -- */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep01 = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** Builds an orthonormal basis around `n`. `n` must be unit length. */
export function basisFromNormal(n: THREE.Vector3, outT: THREE.Vector3, outB: THREE.Vector3): void {
  // Duff et al. branchless ONB — no degenerate case at the poles.
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  outT.set(1 + sign * n.x * n.x * a, sign * b, -sign * n.x);
  outB.set(b, sign + n.y * n.y * a, -n.y);
}

/**
 * Random direction inside a cone around `dir`.
 * `spread` is the cosine-weighted half angle in radians; 0 = perfectly aligned,
 * PI/2 = a full hemisphere.
 */
export function coneDir(
  rand: { next(): number },
  dir: THREE.Vector3, spread: number, out: THREE.Vector3,
  t: THREE.Vector3, b: THREE.Vector3,
): THREE.Vector3 {
  basisFromNormal(dir, t, b);
  const cosMax = Math.cos(clamp(spread, 0, Math.PI));
  const cz = lerp(cosMax, 1, rand.next());
  const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
  const phi = rand.next() * Math.PI * 2;
  out.set(
    t.x * Math.cos(phi) * sz + b.x * Math.sin(phi) * sz + dir.x * cz,
    t.y * Math.cos(phi) * sz + b.y * Math.sin(phi) * sz + dir.y * cz,
    t.z * Math.cos(phi) * sz + b.z * Math.sin(phi) * sz + dir.z * cz,
  );
  return out;
}

/** Blackbody-ish colour ramp for hot particles, temperature in [0,1]. */
export function hotColor(t: number, out: { r: number; g: number; b: number }): void {
  // 0 = dull red ember, 0.5 = orange, 1 = white-hot with a blue-ish edge.
  const x = clamp01(t);
  out.r = lerp(0.65, 1.0, clamp01(x * 2.4));
  out.g = lerp(0.06, 0.98, clamp01((x - 0.06) * 1.55));
  out.b = lerp(0.012, 0.85, clamp01((x - 0.55) * 2.3));
}

/* -------------------------------------------------------------- surfaces -- */

export type SurfaceFamily =
  | 'masonry' | 'metal' | 'wood' | 'soil' | 'glass' | 'water'
  | 'flesh' | 'soft' | 'foliage' | 'snow';

const FAMILY: Partial<Record<SurfaceType, SurfaceFamily>> = {
  concrete: 'masonry', asphalt: 'masonry', brick: 'masonry', stone: 'masonry',
  plaster: 'masonry', tile: 'masonry',
  metal: 'metal', metalThin: 'metal', grate: 'metal', pipe: 'metal',
  armor: 'metal', helmet: 'metal',
  wood: 'wood', woodThin: 'wood', plywood: 'wood', crate: 'wood',
  dirt: 'soil', sand: 'soil', gravel: 'soil', grass: 'soil', mud: 'soil',
  snow: 'snow', ice: 'glass',
  glass: 'glass', glassThick: 'glass',
  water: 'water', puddle: 'water',
  fabric: 'soft', sandbag: 'soil', carpet: 'soft', cardboard: 'soft',
  rubber: 'soft', plastic: 'soft',
  flesh: 'flesh',
  foliage: 'foliage',
};

export function surfaceFamily(s: string): SurfaceFamily {
  return FAMILY[s as SurfaceType] ?? 'masonry';
}

/** Dust / debris tint per family, in linear space. */
export const FAMILY_TINT: Record<SurfaceFamily, [number, number, number]> = {
  masonry: [0.62, 0.60, 0.56],
  metal: [0.48, 0.48, 0.50],
  wood: [0.42, 0.29, 0.16],
  soil: [0.40, 0.31, 0.21],
  glass: [0.72, 0.80, 0.85],
  water: [0.62, 0.72, 0.80],
  flesh: [0.30, 0.03, 0.025],
  soft: [0.40, 0.37, 0.33],
  foliage: [0.20, 0.30, 0.11],
  snow: [0.88, 0.90, 0.94],
};

/* ------------------------------------------------------------- host types -- */

/**
 * What the FX module needs from the renderer. Everything beyond `RenderAPI` is
 * optional and probed at runtime, so FX still works against a bare renderer.
 */
export interface FxRenderHost extends RenderAPI {
  uniforms?: { shared(): Record<string, THREE.IUniform> };
  sky?: { wind?: number; rain?: number; fogAmount?: number };
  /** Frame-graph handle, probed defensively — see FXSystem.render(). */
  graph?: {
    gbuffer?: {
      color: THREE.Texture;
      target: { textures: THREE.Texture[] };
    };
  };
}

export interface FxPhysicsHost {
  readonly ready: boolean;
  raycast(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: FxRayHit, ignoreEntity?: number,
  ): FxRayHit;
}

export interface FxRayHit {
  hit: boolean;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceType;
}

/** Layer constants mirrored so FX never imports the renderer implementation. */
export const FX_LAYER_TRANSPARENT = 4;

/* --------------------------------------------------------------- helpers -- */

/** Fills a Float32Array quad ([-0.5,0.5]) used as the base for every sprite. */
export function makeQuadGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Minimal full-screen-triangle blitter — FX owns its own so it never reaches
 *  into the renderer's private frame graph. */
export class FxBlitter {
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld(true);
  }

  blit(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void { this.geometry.dispose(); }
}

export const FS_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Marks a material so the renderer's G-buffer patcher leaves it alone — FX
 *  shaders declare their own MRT outputs. Mirrors `render/MaterialPatch`. */
export function fxSkipPatch<T extends THREE.Material>(m: T): T {
  (m.userData as { boSkipMRT?: boolean }).boSkipMRT = true;
  return m;
}

/**
 * G-buffer tail every FX fragment shader must emit.
 *
 * Blending is per-attachment in WebGL2, so writing a fully transparent black to
 * attachments 1..3 leaves the renderer's normal / velocity / material buffers
 * untouched under both premultiplied-alpha and additive blending. Without this
 * the extra attachments would receive undefined values and SSAO/SSR/TAA would
 * tear wherever a particle drew.
 */
export const GBUFFER_PASSTHROUGH_DECL = /* glsl */ `
layout(location = 1) out vec4 fxGNormal;
layout(location = 2) out vec4 fxGVelocity;
layout(location = 3) out vec4 fxGMaterial;
`;

export const GBUFFER_PASSTHROUGH_WRITE = /* glsl */ `
	fxGNormal = vec4( 0.0 );
	fxGVelocity = vec4( 0.0 );
	fxGMaterial = vec4( 0.0 );
`;
