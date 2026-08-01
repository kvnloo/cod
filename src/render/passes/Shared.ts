/**
 * Resources shared between post passes.
 *
 * Passes never reach into each other; they publish and consume named slots on a
 * single `PostResources` instance that `createPasses()` owns. That keeps the
 * chain decoupled while still letting SSR reuse GTAO's bent normals and the lens
 * pass reuse bloom's pyramid.
 */

import * as THREE from 'three';
import { bus } from '../../core/EventBus';
import type { ScreenEffectRequest } from '../types';
import { blueNoiseTexture } from './BlueNoise';

export interface TargetSpec {
  type?: THREE.TextureDataType;
  format?: THREE.PixelFormat;
  filter?: THREE.MagnificationTextureFilter;
  wrap?: THREE.Wrapping;
  depth?: boolean;
  count?: number;
}

/**
 * Named, size-aware render-target cache. Targets persist across frames (temporal
 * effects need that) and are reallocated only when their dimensions change.
 */
export class TargetPool {
  private map = new Map<string, THREE.WebGLRenderTarget>();

  get(key: string, width: number, height: number, spec: TargetSpec = {}): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const existing = this.map.get(key);
    if (existing && existing.width === w && existing.height === h) return existing;
    if (existing) { existing.dispose(); this.map.delete(key); }

    const filter = spec.filter ?? THREE.LinearFilter;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: spec.type ?? THREE.HalfFloatType,
      format: spec.format ?? THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      wrapS: spec.wrap ?? THREE.ClampToEdgeWrapping,
      wrapT: spec.wrap ?? THREE.ClampToEdgeWrapping,
      depthBuffer: spec.depth ?? false,
      stencilBuffer: false,
      generateMipmaps: false,
      count: spec.count ?? 1,
    });
    rt.texture.name = key;
    for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
    this.map.set(key, rt);
    return rt;
  }

  /** Drops targets whose key starts with `prefix` (used on quality changes). */
  release(prefix: string): void {
    for (const [k, v] of [...this.map]) {
      if (k.startsWith(prefix)) { v.dispose(); this.map.delete(k); }
    }
  }

  get bytes(): number {
    let total = 0;
    for (const rt of this.map.values()) total += rt.width * rt.height * 8 * rt.textures.length;
    return total;
  }

  dispose(): void {
    for (const rt of this.map.values()) rt.dispose();
    this.map.clear();
  }
}

/** Transient screen effects accumulated from gameplay events. */
export class ScreenFxState {
  /** Additive flash: rgb intensity, decays exponentially. */
  readonly flash = new THREE.Vector3();
  flashDecay = 6;
  /** Flashbang: 0..1 whiteout with its own long recovery curve. */
  blind = 0;
  blindTime = 0;
  /** Directional damage vignette. */
  damage = 0;
  readonly damageDir = new THREE.Vector2(0, 1);
  /** Concussion (radial blur + aberration + wobble). */
  concussion = 0;
  concussionTime = 0;
  /** Lens spatter 0..1 per kind. */
  blood = 0;
  water = 0;
  dirt = 0;
  /** True while aiming down sights — drives DoF strength. */
  ads = 0;

  private detach: Array<() => void> = [];

  constructor() {
    this.detach.push(bus.on('damage:taken', (p) => {
      const mag = Math.min(1, p.amount / 45);
      // Soft-cap so stacked hits never full-wash the frame. CoD keeps the
      // centre clear for aim; only the rim and impact bearing go red.
      this.damage = Math.min(0.72, this.damage + mag * 0.42);
      // Project the incoming direction onto a screen-ish 2D compass.
      const d = p.fromDirection;
      if (d) {
        const len = Math.hypot(d.x, d.z) || 1;
        this.damageDir.set(d.x / len, d.z / len);
      }
      if (p.lethal) this.blood = Math.min(0.55, this.blood + 0.28);
      else this.blood = Math.min(0.45, this.blood + mag * 0.16);
    }));
    this.detach.push(bus.on('explosion', (p) => {
      const power = Math.min(1, p.power / 60);
      if (p.kind === 'flashbang') {
        this.blind = Math.max(this.blind, 1);
        this.blindTime = 0;
      }
      this.concussion = Math.min(1.4, this.concussion + power);
      this.concussionTime = 0;
      this.flash.addScalar(power * 1.5);
      this.dirt = Math.min(1, this.dirt + power * 0.4);
    }));
    this.detach.push(bus.on('weapon:ads', (p) => { this.adsTarget = p.active ? 1 : 0; }));
    this.detach.push(bus.on('weapon:fire', (p) => {
      if (!p.suppressed) this.flash.addScalar(0.05);
    }));
  }

  private adsTarget = 0;

  request(req: ScreenEffectRequest): void {
    if (req.flash) {
      const c = new THREE.Color(req.flash.color ?? 0xffffff);
      this.flash.x += c.r * req.flash.intensity;
      this.flash.y += c.g * req.flash.intensity;
      this.flash.z += c.b * req.flash.intensity;
      if (req.flash.decay) this.flashDecay = req.flash.decay;
      if (req.flash.intensity >= 3) { this.blind = Math.min(1, this.blind + req.flash.intensity / 6); this.blindTime = 0; }
    }
    if (req.damage) {
      this.damage = Math.min(0.72, this.damage + req.damage.intensity * 0.55);
      const d = req.damage.direction;
      if (d) {
        const len = Math.hypot(d.x, d.z) || 1;
        this.damageDir.set(d.x / len, d.z / len);
      }
    }
    if (req.concussion) {
      this.concussion = Math.min(1.5, this.concussion + req.concussion.intensity);
      this.concussionTime = 0;
    }
    if (req.spatter) {
      const v = req.spatter.intensity;
      if (req.spatter.kind === 'blood') this.blood = Math.min(0.55, this.blood + v * 0.55);
      else if (req.spatter.kind === 'water') this.water = Math.min(1, this.water + v);
      else this.dirt = Math.min(1, this.dirt + v);
    }
  }

  update(dt: number): void {
    const d = Math.min(0.1, Math.max(0, dt));
    this.flash.multiplyScalar(Math.exp(-this.flashDecay * d));
    if (this.flash.lengthSq() < 1e-5) this.flash.set(0, 0, 0);

    // Flashbang: saturated whiteout for ~0.6s, then a long non-linear recovery.
    if (this.blind > 0) {
      this.blindTime += d;
      const t = this.blindTime;
      const hold = 0.55;
      const recover = 4.2;
      this.blind = t < hold ? 1 : Math.max(0, Math.pow(1 - (t - hold) / recover, 2.2));
    }
    // Decay fast enough that a single hit is gone in ~1 s, not a sticky wash.
    this.damage = Math.max(0, this.damage - d * 1.15);
    if (this.concussion > 0) {
      this.concussionTime += d;
      this.concussion = Math.max(0, this.concussion - d * 0.42);
    }
    this.blood = Math.max(0, this.blood - d * 0.06);
    this.water = Math.max(0, this.water - d * 0.09);
    this.dirt = Math.max(0, this.dirt - d * 0.05);
    this.ads += (this.adsTarget - this.ads) * Math.min(1, d * 9);
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }
}

/** Uniform block matching the `AUTO_EXPOSURE` GLSL chunk. */
export function exposureUniforms(): Record<string, THREE.IUniform> {
  return {
    tAdapt: { value: null },
    uAdaptEnabled: { value: 0 },
    uExposureBase: { value: 1 },
    uKey: { value: 0.11 },
    uMinExposure: { value: 0.2 },
    uMaxExposure: { value: 4.5 },
  };
}

/** Copies the tonemapper's exposure parameters into a pre-tonemap material. */
export function applyExposureUniforms(
  material: THREE.ShaderMaterial, res: PostResources, base: number,
): void {
  const p = res.exposureParams;
  const u = material.uniforms;
  u.tAdapt.value = res.adaptation;
  u.uAdaptEnabled.value = res.adaptation && p.auto ? 1 : 0;
  u.uExposureBase.value = Math.max(0, base);
  u.uKey.value = p.key;
  u.uMinExposure.value = p.min;
  u.uMaxExposure.value = p.max;
}

/** Everything the pass library shares. Created once by `createPasses()`. */
export class PostResources {
  readonly pool = new TargetPool();
  readonly blueNoise = blueNoiseTexture();
  readonly fx = new ScreenFxState();

  /** GTAO outputs — rgb = view-space bent normal, a = visibility. */
  gtao: THREE.Texture | null = null;
  /** Screen-space reflection colour, pre-composite. */
  ssr: THREE.Texture | null = null;
  /** Blurred mip pyramid of the scene colour, shared by SSR and DoF/lens. */
  colorPyramid: THREE.Texture[] = [];
  /** Bloom result before compositing (used again by the lens pass). */
  bloom: THREE.Texture | null = null;
  bloomStrength = 0;
  /** Dilated velocity from TAA — reused by motion blur and volumetrics. */
  velocity: THREE.Texture | null = null;
  /** Signed circle-of-confusion, in pixels, produced by DoF. */
  coc: THREE.Texture | null = null;
  /** GPU-resident average log2 luminance (1x1) written by the tonemap pass. */
  adaptation: THREE.Texture | null = null;
  /**
   * Exposure parameters the tonemap pass will use this frame. Bloom and the lens
   * pass run *before* tonemapping but must threshold in the same exposed units,
   * so they resolve the identical curve from `adaptation` (one frame stale,
   * which is imperceptible for eye adaptation).
   */
  readonly exposureParams = { base: 1, key: 0.11, min: 0.2, max: 4.5, auto: 1 };

  dispose(): void {
    this.pool.dispose();
    this.fx.dispose();
    this.blueNoise.dispose();
  }
}
