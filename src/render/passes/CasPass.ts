/**
 * AMD FidelityFX Contrast Adaptive Sharpening.
 *
 * CAS sharpens by an amount derived from local contrast, so flat regions are
 * left alone and high-contrast edges get less gain than a fixed unsharp mask
 * would give them. It runs after tonemapping, on display-referred values, which
 * is where the filter is defined.
 *
 * Stock CAS still overshoots on *thin* dark features: a cable one pixel wide
 * against the sky leaves both flanking pixels brighter than the sky itself,
 * which is the pale outline that gives a sharpening filter away instantly. The
 * adaptive amplitude cannot prevent it, because from the flanking pixel's point
 * of view the neighbourhood really does contain a strong dark sample. So the
 * result is clamped to the local 3x3 range, with a few percent of the local
 * range as slack so genuine micro-contrast still gains a little bite.
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
uniform float uOvershoot;
uniform float uMaxOvershoot;
layout(location = 0) out vec4 fragColor;

vec3 T(float x, float y) { return texture(tInput, vUv + vec2(x, y) * uTexel).rgb; }

void main() {
  vec3 a = T(-1.0, -1.0), b = T(0.0, -1.0), c = T(1.0, -1.0);
  vec3 d = T(-1.0,  0.0), e = T(0.0,  0.0), f = T(1.0,  0.0);
  vec3 g = T(-1.0,  1.0), h = T(0.0,  1.0), i = T(1.0,  1.0);

  // True local range, kept separate from the doubled min/max CAS uses for its
  // adaptive amplitude below.
  vec3 lo = min(min(min(a, b), min(c, d)), min(min(e, f), min(min(g, h), i)));
  vec3 hi = max(max(max(a, b), max(c, d)), max(max(e, f), max(max(g, h), i)));

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

  // Ringing clamp. Slack scales with the local range, so flat texture (tiny
  // range) is still free to gain contrast while a wire against the sky cannot
  // push a pixel past the sky it sits in.
  //
  // The proportional term alone is not enough on its own. A cable at L=58
  // against a sky at L=212 has a local range of 154 levels, so 5% of it is 7.7
  // levels of licence — and the filter takes about half of that, leaving the
  // pixels either side of the wire 3-4 levels brighter than the sky they sit
  // in. That is the pale outline. uMaxOvershoot caps the slack in absolute
  // display levels, which leaves ordinary micro-contrast (range of a few tens
  // of levels, so under the cap already) exactly as it was and only bites on
  // the high-contrast edges where haloing is visible.
  vec3 slack = min((hi - lo) * uOvershoot, vec3(uMaxOvershoot));
  result = clamp(result, lo - slack, hi + slack);

  fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;

/**
 * Overshoot allowed past the local 3x3 range, as a fraction of that range.
 * 0 is a hard no-ring clamp and looks slightly flat-topped; 0.05 keeps the
 * "crisper" impression on ordinary texture, where the local range is small
 * enough that this term stays under MAX_OVERSHOOT and therefore governs.
 */
const OVERSHOOT = 0.05;
/**
 * Hard ceiling on that overshoot, in display levels out of 255. Two levels is
 * under the threshold at which a one-pixel bright line beside a dark wire is
 * distinguishable from the surrounding sky, and it is well above the amount of
 * gain any genuine micro-contrast (a few tens of levels of local range) ever
 * asks for, so texture keeps all of its bite.
 */
const MAX_OVERSHOOT = 2.0 / 255;

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
        uOvershoot: { value: OVERSHOOT },
        uMaxOvershoot: { value: MAX_OVERSHOOT },
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
    u.uOvershoot.value = OVERSHOOT;
    u.uMaxOvershoot.value = MAX_OVERSHOOT;
    ctx.blit(this.cas, output);
    return true;
  }
}
