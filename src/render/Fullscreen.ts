/**
 * Full-screen triangle blitter + a per-frame render-target pool.
 *
 * A single oversized triangle beats a quad: no diagonal seam, one primitive,
 * and perfectly coherent quad-shading across the whole screen.
 */

import * as THREE from 'three';

function makeTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // Clip-space triangle covering [-1,1]^2 after the ortho camera below.
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

export class FullscreenBlitter {
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = makeTriangle();
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();

  constructor() {
    this.mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld(true);
  }

  /**
   * Draws `material` over `target` (null = the canvas). Does not clear — the
   * caller owns clear state so passes can accumulate.
   */
  blit(
    renderer: THREE.WebGLRenderer,
    material: THREE.Material,
    target: THREE.WebGLRenderTarget | null,
    activeCubeFace = 0,
  ): void {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.mesh.material = material;
    const cube = (target as unknown as { isWebGLCubeRenderTarget?: boolean } | null)?.isWebGLCubeRenderTarget;
    if (target) renderer.setRenderTarget(target, cube ? activeCubeFace : undefined);
    else renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** Shader boilerplate every hand-written pass in this module shares. */
export const FS_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export interface PoolKey {
  width: number;
  height: number;
  half: boolean;
}

interface PoolEntry {
  target: THREE.WebGLRenderTarget;
  inUse: boolean;
  key: string;
}

/**
 * Scratch render targets handed to post passes through `PassContext.borrow`.
 * Everything is returned at the end of the frame; nothing survives across
 * frames, which keeps peak VRAM predictable.
 */
export class TargetPool {
  private entries: PoolEntry[] = [];
  private baseWidth = 1;
  private baseHeight = 1;

  resize(width: number, height: number): void {
    this.baseWidth = Math.max(1, width);
    this.baseHeight = Math.max(1, height);
    for (const e of this.entries) e.target.dispose();
    this.entries.length = 0;
  }

  borrow(scale = 1, half = true): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.round(this.baseWidth * scale));
    const h = Math.max(1, Math.round(this.baseHeight * scale));
    const key = `${w}x${h}x${half ? 'h' : 'b'}`;
    for (const e of this.entries) {
      if (!e.inUse && e.key === key) { e.inUse = true; return e.target; }
    }
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    target.texture.name = `pool:${key}`;
    this.entries.push({ target, inUse: true, key });
    return target;
  }

  releaseAll(): void {
    for (const e of this.entries) e.inUse = false;
  }

  /** Number of live targets — surfaced in the perf HUD. */
  get size(): number { return this.entries.length; }

  dispose(): void {
    for (const e of this.entries) e.target.dispose();
    this.entries.length = 0;
  }
}
