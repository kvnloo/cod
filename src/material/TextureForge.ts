/**
 * TextureForge — GPU procedural texture generator.
 *
 * A recipe is two GLSL functions:
 *
 *   void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1);
 *   void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o);
 *
 * and the forge runs three fullscreen passes over them:
 *
 *   1. HEIGHT   → RGBA16F ×2   h0 = (height, cavityHint, cellRnd, mask)
 *                              h1 = four recipe-defined auxiliary masks
 *   2. DERIVE   → RGBA8 ×2     normal-from-height (Sobel, two scales) + height,
 *                              and (AO, curvature, cavity, blurred height)
 *   3. SHADE    → RGBA8 ×3     albedo (sRGB), ORM(+height), normal(+height)
 *
 * Splitting height from shading is what makes the results read as photoscanned:
 * albedo is *derived from* the same occlusion and curvature the normal map is,
 * so grime lands in the crevices and wear lands on the edges instead of being
 * an unrelated noise layer.
 *
 * Only the pass-3 target survives; passes 1–2 render into pooled scratch
 * targets that are reused for every material.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise';
import { PATTERNS_GLSL } from './glsl/patterns';
import { FILTERS_GLSL } from './glsl/filters';

/* ------------------------------------------------------------------ types */

export interface ForgeQuality {
  /** Multiplier applied to every recipe's nominal resolution. */
  sizeScale: number;
  /** Hard cap on generated resolution. */
  maxSize: number;
  aoDirs: number;
  aoSteps: number;
  anisotropy: number;
}

export const FORGE_QUALITY: Record<string, ForgeQuality> = {
  cinematic: { sizeScale: 1.0, maxSize: 2048, aoDirs: 12, aoSteps: 12, anisotropy: 16 },
  ultra: { sizeScale: 1.0, maxSize: 2048, aoDirs: 10, aoSteps: 10, anisotropy: 16 },
  high: { sizeScale: 1.0, maxSize: 1024, aoDirs: 8, aoSteps: 8, anisotropy: 16 },
  medium: { sizeScale: 0.5, maxSize: 1024, aoDirs: 6, aoSteps: 6, anisotropy: 8 },
  low: { sizeScale: 0.5, maxSize: 512, aoDirs: 4, aoSteps: 4, anisotropy: 4 },
};

export interface RecipeGeometry {
  /** Metres of world covered by one texture repeat. Drives default UV scale. */
  tile: number;
  /** Peak-to-trough height of the displacement field, in metres. */
  depth: number;
}

export interface ForgeRecipe {
  id: string;
  /** GLSL declarations shared by both passes (helpers, consts). */
  common?: string;
  /** `void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1)` */
  height: string;
  /** `void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o)` */
  shade: string;
  /** Nominal resolution before quality scaling. */
  size?: number;
  seed?: number;
  geometry: RecipeGeometry;
  /** Extra normal-map gain on top of depth/tile. Default 1. */
  normalGain?: number;
  /** Weight of the wide (3-texel) gradient. 0.35 default; raise for soft forms. */
  normalWide?: number;
  /** AO cone radius in uv units. Default 0.03. */
  aoRadius?: number;
  /** 0 disables AO, 1 = full. Default 1. */
  aoStrength?: number;
  /** How much AO is multiplied into albedo. Default 0.35. */
  aoAlbedo?: number;
  /** Curvature gain. Default 1. */
  curvature?: number;
  uniforms?: Record<string, THREE.IUniform>;
}

/** The generated PBR stack for one archetype. */
export interface PbrTextureSet {
  id: string;
  /** sRGB albedo. */
  albedo: THREE.Texture;
  /** Linear: rgb = tangent-space normal, a = height. */
  normal: THREE.Texture;
  /** Linear: r = AO, g = roughness, b = metalness, a = height. */
  orm: THREE.Texture;
  size: number;
  tile: number;
  depth: number;
  dispose(): void;
}

/* -------------------------------------------------------------- shader src */

const VERT = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const PRELUDE = /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform float uSeed;
uniform float uTexel;
uniform float uSize;
uniform float uTime;
`;

const STRUCTS = /* glsl */ `
struct ObDerived {
  float height;
  float ao;
  float curv;     // +1 convex edge, -1 concave crevice
  float cavity;   // 0..1, how deep below the local average
  float blur;     // wide blur of height
};
struct ObOut {
  vec3 albedo;    // linear
  float rough;
  float metal;
  float ao;       // extra AO multiplied on top of the traced AO
  float alpha;    // opacity, written to albedo.a (glass, grates, foliage)
};
`;

/* ------------------------------------------------------------------ forge */

interface Scratch {
  height: THREE.WebGLRenderTarget;
  derive: THREE.WebGLRenderTarget;
}

export class TextureForge {
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh;
  private scratch = new Map<number, Scratch>();
  private materials: THREE.RawShaderMaterial[] = [];
  private targets: THREE.WebGLRenderTarget[] = [];

  quality: ForgeQuality = FORGE_QUALITY.high;

  constructor(private renderer: THREE.WebGLRenderer) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geo, new THREE.RawShaderMaterial());
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /* ------------------------------------------------------------ internals */

  private getScratch(size: number): Scratch {
    let s = this.scratch.get(size);
    if (s) return s;
    const height = new THREE.WebGLRenderTarget(size, size, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const derive = new THREE.WebGLRenderTarget(size, size, {
      count: 2,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    s = { height, derive };
    this.scratch.set(size, s);
    return s;
  }

  private draw(material: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    this.quad.material = material;
    r.setRenderTarget(target);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.setRenderTarget(prev);
    r.autoClear = prevAutoClear;
  }

  private makeMaterial(fragment: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: fragment,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.materials.push(m);
    return m;
  }

  /* ------------------------------------------------------------ public API */

  /** Resolution this recipe will actually be generated at. */
  resolve(recipe: ForgeRecipe): number {
    const q = this.quality;
    const nominal = recipe.size ?? 1024;
    const s = Math.round(nominal * q.sizeScale);
    return Math.max(128, Math.min(q.maxSize, 1 << Math.round(Math.log2(Math.max(1, s)))));
  }

  /**
   * Generates the full PBR stack for a recipe. Synchronous — the GPU work is
   * queued but never read back, so this costs a handful of draw calls.
   */
  generate(recipe: ForgeRecipe): PbrTextureSet {
    const q = this.quality;
    const size = this.resolve(recipe);
    const scratch = this.getScratch(size);
    const seed = recipe.seed ?? 1.0;
    const geo = recipe.geometry;

    const shared: Record<string, THREE.IUniform> = {
      uSeed: { value: seed },
      uTexel: { value: 1 / size },
      uSize: { value: size },
      uTime: { value: 0 },
      ...(recipe.uniforms ?? {}),
    };

    /* -------------------------------------------------- pass 1: height */
    const heightFrag = `${PRELUDE}
${STRUCTS}
layout(location = 0) out vec4 oH0;
layout(location = 1) out vec4 oH1;
${NOISE_GLSL}
${PATTERNS_GLSL}
${recipe.common ?? ''}
${recipe.height}
void main() {
  vec4 h0 = vec4(0.0, 0.0, 0.0, 0.0);
  vec4 h1 = vec4(0.0, 0.0, 0.0, 0.0);
  obHeightFn(vUv, h0, h1);
  oH0 = h0;
  oH1 = h1;
}`;
    const heightMat = this.makeMaterial(heightFrag, shared);
    this.draw(heightMat, scratch.height);

    /* -------------------------------------------------- pass 2: derive */
    const aspect = geo.depth / Math.max(geo.tile, 1e-4);
    const deriveUniforms: Record<string, THREE.IUniform> = {
      ...shared,
      obHeightTex: { value: scratch.height.textures[0] },
      obTexel: { value: 1 / size },
      obNormalStrength: { value: aspect * (recipe.normalGain ?? 1) * 1.0 },
      obNormalWide: { value: recipe.normalWide ?? 0.35 },
      obAoRadius: { value: recipe.aoRadius ?? 0.03 },
      obAoStrength: { value: recipe.aoStrength ?? 1 },
      obHeightAspect: { value: aspect },
      obCurvScale: { value: recipe.curvature ?? 1 },
      obAoDirs: { value: q.aoDirs },
      obAoSteps: { value: q.aoSteps },
    };
    const deriveFrag = `${PRELUDE}
${STRUCTS}
layout(location = 0) out vec4 oNormal;
layout(location = 1) out vec4 oDerived;
${NOISE_GLSL}
${FILTERS_GLSL}
void main() {
  float h = obH(vUv);
  vec3 n = obNormalFromHeight(vUv);
  float ao = obAoFromHeight(vUv);
  float curv = obCurvature(vUv);
  float cav = obCavity(vUv, obTexel * 6.0);
  float blur = obHeightBlur(vUv, obTexel * 18.0);
  oNormal = vec4(n * 0.5 + 0.5, h);
  oDerived = vec4(ao, curv * 0.5 + 0.5, cav, blur);
}`;
    const deriveMat = this.makeMaterial(deriveFrag, deriveUniforms);
    this.draw(deriveMat, scratch.derive);

    /* --------------------------------------------------- pass 3: shade */
    const target = new THREE.WebGLRenderTarget(size, size, {
      count: 3,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      anisotropy: q.anisotropy,
    });
    target.textures[0].colorSpace = THREE.SRGBColorSpace;
    target.textures[1].colorSpace = THREE.NoColorSpace;
    target.textures[2].colorSpace = THREE.NoColorSpace;
    target.textures[0].name = `${recipe.id}:albedo`;
    target.textures[1].name = `${recipe.id}:orm`;
    target.textures[2].name = `${recipe.id}:normal`;
    for (const t of target.textures) t.anisotropy = q.anisotropy;
    this.targets.push(target);

    const shadeUniforms: Record<string, THREE.IUniform> = {
      ...shared,
      uH0: { value: scratch.height.textures[0] },
      uH1: { value: scratch.height.textures[1] },
      uNrm: { value: scratch.derive.textures[0] },
      uDrv: { value: scratch.derive.textures[1] },
      uAoAlbedo: { value: recipe.aoAlbedo ?? 0.35 },
    };
    const shadeFrag = `${PRELUDE}
${STRUCTS}
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oOrm;
layout(location = 2) out vec4 oNormal;
uniform sampler2D uH0;
uniform sampler2D uH1;
uniform sampler2D uNrm;
uniform sampler2D uDrv;
uniform float uAoAlbedo;
${NOISE_GLSL}
${PATTERNS_GLSL}
${recipe.common ?? ''}
${recipe.shade}
void main() {
  vec4 h0 = texture(uH0, vUv);
  vec4 h1 = texture(uH1, vUv);
  vec4 nrm = texture(uNrm, vUv);
  vec4 drv = texture(uDrv, vUv);

  ObDerived d;
  d.height = h0.x;
  d.ao = drv.r;
  d.curv = drv.g * 2.0 - 1.0;
  d.cavity = drv.b;
  d.blur = drv.a;

  ObOut o;
  o.albedo = vec3(0.5);
  o.rough = 0.85;
  o.metal = 0.0;
  o.ao = 1.0;
  o.alpha = 1.0;

  obShadeFn(vUv, h0, h1, d, o);

  float ao = clamp(o.ao * d.ao, 0.0, 1.0);
  vec3 albedo = o.albedo * mix(1.0, ao, uAoAlbedo);

  oAlbedo = vec4(clamp(albedo, 0.0, 1.0), clamp(o.alpha, 0.0, 1.0));
  oOrm = vec4(ao, clamp(o.rough, 0.02, 1.0), clamp(o.metal, 0.0, 1.0), nrm.a);
  oNormal = vec4(nrm.rgb, nrm.a);
}`;
    const shadeMat = this.makeMaterial(shadeFrag, shadeUniforms);
    this.draw(shadeMat, target);

    heightMat.dispose();
    deriveMat.dispose();
    shadeMat.dispose();
    this.materials.splice(this.materials.indexOf(heightMat), 1);
    this.materials.splice(this.materials.indexOf(deriveMat), 1);
    this.materials.splice(this.materials.indexOf(shadeMat), 1);

    const set: PbrTextureSet = {
      id: recipe.id,
      albedo: target.textures[0],
      orm: target.textures[1],
      normal: target.textures[2],
      size,
      tile: geo.tile,
      depth: geo.depth,
      dispose: () => {
        const i = this.targets.indexOf(target);
        if (i >= 0) this.targets.splice(i, 1);
        target.dispose();
      },
    };
    return set;
  }

  /**
   * Renders a single fullscreen pass into a fresh single-attachment target.
   * Used for one-off maps (detail noise, screen masks, emissive panels).
   */
  generateSingle(opts: {
    id: string;
    size: number;
    fragment: string;
    uniforms?: Record<string, THREE.IUniform>;
    srgb?: boolean;
    mips?: boolean;
  }): THREE.Texture {
    const size = Math.max(16, Math.min(this.quality.maxSize, opts.size));
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: opts.mips === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: opts.mips !== false,
      anisotropy: this.quality.anisotropy,
    });
    rt.texture.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    rt.texture.name = opts.id;
    this.targets.push(rt);

    const frag = `${PRELUDE}
${STRUCTS}
layout(location = 0) out vec4 oCol;
${NOISE_GLSL}
${PATTERNS_GLSL}
${opts.fragment}`;
    const mat = this.makeMaterial(frag, {
      uSeed: { value: 1 },
      uTexel: { value: 1 / size },
      uSize: { value: size },
      uTime: { value: 0 },
      ...(opts.uniforms ?? {}),
    });
    this.draw(mat, rt);
    mat.dispose();
    this.materials.splice(this.materials.indexOf(mat), 1);
    return rt.texture;
  }

  setAnisotropy(a: number): void {
    this.quality = { ...this.quality, anisotropy: a };
    for (const t of this.targets) {
      for (const tex of t.textures) {
        if (tex.anisotropy !== a) { tex.anisotropy = a; tex.needsUpdate = true; }
      }
    }
  }

  dispose(): void {
    for (const s of this.scratch.values()) { s.height.dispose(); s.derive.dispose(); }
    this.scratch.clear();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.targets) t.dispose();
    this.targets.length = 0;
    this.quad.geometry.dispose();
  }
}
