/**
 * AMD FidelityFX Contrast Adaptive Sharpening.
 *
 * CAS sharpens by an amount derived from local contrast, so flat regions are
 * left alone and high-contrast edges are not given the halo that a fixed
 * unsharp mask produces. It runs after tonemapping, on display-referred values,
 * which is where the filter is defined.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const CAS_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uSharpness;
layout(location = 0) out vec4 fragColor;

vec3 T(float x, float y) { return texture(tInput, vUv + vec2(x, y) * uTexel).rgb; }

void main() {
  vec3 a = T(-1.0, -1.0), b = T(0.0, -1.0), c = T(1.0, -1.0);
  vec3 d = T(-1.0,  0.0), e = T(0.0,  0.0), f = T(1.0,  0.0);
  vec3 g = T(-1.0,  1.0), h = T(0.0,  1.0), i = T(1.0,  1.0);

  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mn2 = min(mn, min(min(a, c), min(g, i)));
  mn += mn2;

  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 mx2 = max(mx, max(max(a, c), max(g, i)));
  mx += mx2;

  vec3 rcpMx = 1.0 / max(mx, vec3(1e-4));
  vec3 amp = clamp(min(mn, 2.0 - mx) * rcpMx, 0.0, 1.0);
  amp = sqrt(amp);

  float peak = -1.0 / mix(8.0, 5.0, sat(uSharpness));
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / (1.0 + 4.0 * w);

  vec3 result = ((b + d + f + h) * w + e) * rcpW;
  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;

export class CasPass extends BasePass {
  readonly name = 'cas';
  readonly order = PASS_ORDER.SHARPEN;

  private cas!: THREE.ShaderMaterial;

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.cas = this.makeMaterial({
      name: 'cas/sharpen',
      fragment: CAS_FRAG,
      uniforms: {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uSharpness: { value: 0.35 },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || g.sharpen <= 0.001) return false;
    const u = this.cas.uniforms;
    u.tInput.value = input;
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    u.uSharpness.value = Math.min(1, g.sharpen);
    ctx.blit(this.cas, output);
    return true;
  }
}
