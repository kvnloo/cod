/**
 * Shared plumbing for every post pass: material construction with the common
 * GLSL prelude, define management that only triggers a recompile when something
 * actually changed, and lifetime management of owned materials.
 */

import * as THREE from 'three';
import type { PassContext, RenderPass } from '../Pass';
import { BLUE_NOISE, COMMON, FULLSCREEN_VERT } from './Shaders';
import type { PostResources } from './Shared';

export type Uniforms = Record<string, THREE.IUniform>;
export type DefineValue = string | number;

export interface MaterialSpec {
  name: string;
  fragment: string;
  uniforms: Uniforms;
  defines?: Record<string, DefineValue>;
  /** Prepends the blue-noise helpers (requires a `tBlueNoise` uniform). */
  blueNoise?: boolean;
  blending?: THREE.Blending;
}

export abstract class BasePass implements RenderPass {
  abstract readonly name: string;
  abstract readonly order: number;
  enabled = true;

  protected renderer!: THREE.WebGLRenderer;
  protected width = 1;
  protected height = 1;
  protected readonly res: PostResources;
  private owned: THREE.Material[] = [];

  constructor(res: PostResources) { this.res = res; }

  setup(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    this.onSetup();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.onResize(this.width, this.height);
  }

  abstract render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean;

  protected onSetup(): void { /* optional */ }
  protected onResize(_w: number, _h: number): void { /* optional */ }

  /** Builds a GLSL3 full-screen material with the common prelude attached. */
  protected makeMaterial(spec: MaterialSpec): THREE.ShaderMaterial {
    const prelude = COMMON + (spec.blueNoise ? BLUE_NOISE : '');
    const mat = new THREE.ShaderMaterial({
      name: spec.name,
      glslVersion: THREE.GLSL3,
      uniforms: spec.uniforms,
      defines: { ...(spec.defines ?? {}) },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: prelude + spec.fragment,
      depthTest: false,
      depthWrite: false,
      blending: spec.blending ?? THREE.NoBlending,
      toneMapped: false,
    });
    this.owned.push(mat);
    return mat;
  }

  protected own<T extends THREE.Material>(m: T): T {
    this.owned.push(m);
    return m;
  }

  /** Sets a define and flags a recompile only when the value really changed. */
  protected setDefine(mat: THREE.ShaderMaterial, key: string, value: DefineValue): void {
    const defines = mat.defines as Record<string, DefineValue> | undefined;
    if (!defines) return;
    if (defines[key] === value) return;
    defines[key] = value;
    mat.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.length = 0;
  }
}

/** Convenience for passes that just need to move pixels between targets. */
export function makeCopyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'post/copy',
    glslVersion: THREE.GLSL3,
    uniforms: { tInput: { value: null }, uScale: { value: 1 } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      in vec2 vUv;
      uniform sampler2D tInput;
      uniform float uScale;
      layout(location = 0) out vec4 fragColor;
      void main() { fragColor = texture(tInput, vUv) * uScale; }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

/** Marks a pass as unavailable this frame without breaking the graph. */
export const SKIP = false;
