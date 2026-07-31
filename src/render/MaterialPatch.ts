/**
 * Shader surgery.
 *
 * Every material in the scene is rewritten on the fly so that *any*
 * `MeshStandardMaterial` an artist or another subsystem creates automatically:
 *
 *   • writes the full MRT G-buffer (view normal + roughness, screen-space
 *     velocity, metalness/AO/matID/emissive),
 *   • is lit by the renderer's analytic sun with cascaded PCSS shadows and
 *     screen-space contact shadows,
 *   • takes its diffuse ambient from the sky SH probe rather than a flat term,
 *   • and receives aerial perspective consistent with the sky.
 *
 * Nothing else in the codebase has to know any of that exists — which is the
 * entire point. Materials that are not lit (basic/points/sprite) still get the
 * G-buffer writes so the extra attachments never contain garbage.
 */

import * as THREE from 'three';
import {
  GLSL_AERIAL, GLSL_COMMON, GLSL_CONTACT, GLSL_CSM, GLSL_SH, GLSL_SKYOCC, GLSL_SUN,
  GLSL_ATMOSPHERE,
} from './Glsl';
import type { RenderUniforms } from './RenderUniforms';

export type MaterialKind = 'standard' | 'lit' | 'unlit' | 'raw';

const PATCH_VERSION = 10;

/**
 * Diagnostic: replaces the shaded colour with the sun-visibility term
 * (red = cascaded shadow, green = N·L > 0). Flip to `true`, rebuild, capture.
 * Never ship as `true`.
 */
const DEBUG_SHADOW = false;

interface PatchState {
  version: number;
  hook: THREE.Material['onBeforeCompile'];
  shader?: { uniforms: Record<string, THREE.IUniform> };
  matId: THREE.IUniform;
  prevMatrix: THREE.IUniform;
  kind: MaterialKind;
}

interface BOUserData {
  boPatch?: PatchState;
  boSkipMRT?: boolean;
  boMatId?: number;
  boNoSun?: boolean;
}

export function classifyMaterial(m: THREE.Material): MaterialKind | null {
  const mm = m as unknown as Record<string, boolean>;
  if (mm.isRawShaderMaterial) return null;
  if (mm.isMeshStandardMaterial || mm.isMeshPhysicalMaterial) return 'standard';
  if (mm.isMeshLambertMaterial || mm.isMeshPhongMaterial || mm.isMeshToonMaterial) return 'lit';
  if (mm.isShaderMaterial) return 'raw';
  if (
    mm.isMeshBasicMaterial || mm.isPointsMaterial || mm.isSpriteMaterial ||
    mm.isLineBasicMaterial || mm.isMeshMatcapMaterial || mm.isMeshNormalMaterial
  ) return 'unlit';
  return null;
}

/* ------------------------------------------------------------------ GLSL -- */

const MRT_DECL = /* glsl */ `
layout(location = 1) out vec4 boGNormalRough;
layout(location = 2) out vec2 boGVelocity;
layout(location = 3) out vec4 boGMaterial;
uniform vec2 boResolution;
uniform float boMatId;
`;

const VELOCITY_VARYINGS = /* glsl */ `
varying vec4 vBoClipCur;
varying vec4 vBoClipPrev;
`;

const WORLD_VARYINGS = /* glsl */ `
varying vec3 vBoWorldPos;
varying vec3 vBoViewPos;
`;

const VERTEX_PARS = /* glsl */ `
uniform mat4 boViewProjectionNoJitter;
uniform mat4 boPrevViewProjection;
uniform mat4 boPrevModelMatrix;
`;

/** Recomputes the vertex position with the *previous* frame's transform. */
const VERTEX_BODY = /* glsl */ `
{
	vec4 boLocal = vec4( transformed, 1.0 );
	vec4 boPrevLocal = vec4( position, 1.0 );

	#ifdef USE_SKINNING
	{
		mat4 bx = getBoneMatrix( skinIndex.x );
		mat4 by = getBoneMatrix( skinIndex.y );
		mat4 bz = getBoneMatrix( skinIndex.z );
		mat4 bw = getBoneMatrix( skinIndex.w );
		vec4 sv = bindMatrix * vec4( position, 1.0 );
		vec4 sk = vec4( 0.0 );
		sk += bx * sv * skinWeight.x;
		sk += by * sv * skinWeight.y;
		sk += bz * sv * skinWeight.z;
		sk += bw * sv * skinWeight.w;
		boPrevLocal = vec4( ( bindMatrixInverse * sk ).xyz, 1.0 );
	}
	#endif

	#ifdef USE_BATCHING
		boLocal = batchingMatrix * boLocal;
		boPrevLocal = batchingMatrix * boPrevLocal;
	#endif
	#ifdef USE_INSTANCING
		boLocal = instanceMatrix * boLocal;
		boPrevLocal = instanceMatrix * boPrevLocal;
	#endif

	vec4 boWorld = modelMatrix * boLocal;
	vBoWorldPos = boWorld.xyz;
	vBoViewPos = mvPosition.xyz;
	vBoClipCur = boViewProjectionNoJitter * boWorld;
	vBoClipPrev = boPrevViewProjection * ( boPrevModelMatrix * boPrevLocal );
}
`;

const FRAG_PARS_COMMON = GLSL_COMMON;

/** Aerial perspective on its own — a material can want fog without the sun. */
const FRAG_PARS_AERIAL = [GLSL_ATMOSPHERE, GLSL_SUN, GLSL_AERIAL].join('\n');

const FRAG_PARS_LIT = [
  GLSL_ATMOSPHERE,
  GLSL_SUN,
  GLSL_SH,
  GLSL_CSM,
  GLSL_CONTACT,
  GLSL_SKYOCC,
  /* glsl */ `
uniform vec3 boAmbientSH[ 9 ];
uniform vec3 boAmbientTint;
uniform float boAmbientIntensity;
uniform mat4 projectionMatrix;
float boDbgShadow = 1.0;
float boDbgLit = 0.0;
/**
 * Sun visibility at this fragment, in [0,1]. Written by SUN_INJECT (which runs
 * at lights_fragment_begin) and consumed by MAPS_REPLACE (at
 * lights_fragment_maps, immediately after) so the one-bounce ground fill can
 * be gated on it without paying for a second cascade lookup. A surface with
 * N·L <= 0 receives no direct sun by definition, so it reads 0 without a
 * lookup at all.
 */
float boSunVis = 0.0;
/**
 * Sky visibility at this fragment, in [0,1]. Written by MAPS_REPLACE and read
 * by both the specular IBL below it and the debug view in the G-buffer write.
 */
float boSkyVisFrag = 1.0;

/**
 * Diffuse albedo of "the ground", used for the one-bounce fill below. Dusty
 * asphalt/stone sits around 0.18-0.22 and is slightly warm; the exact number is
 * not critical, the presence of the term is.
 */
const vec3 BO_GROUND_ALBEDO = vec3( 0.20, 0.175, 0.135 );
`,
].join('\n');

/**
 * Geometric specular anti-aliasing (Kaplanyan et al. / Frostbite's variant).
 *
 * A high-frequency normal map under a tight NDF produces single-pixel highlight
 * sparkle: the sub-pixel normal distribution is far wider than the material's
 * own roughness, so each pixel randomly lands on or off a mirror lobe. TAA
 * cannot settle it because the jitter keeps re-rolling which pixels win, and the
 * result is the crawling glitter you see on cobbles, roof tiles and brick.
 *
 * Widening the NDF by the pixel-footprint normal variance converts that variance
 * into roughness, which is exactly what a correctly filtered material would have
 * had. Injected after the normal is final and before `lights_physical_fragment`
 * builds `material`, so it also reaches the G-buffer roughness that SSR reads.
 */
const SPEC_AA_INJECT = /* glsl */ `
{
	vec3 boDnDx = dFdx( normal );
	vec3 boDnDy = dFdy( normal );
	float boVariance = 0.25 * ( dot( boDnDx, boDnDx ) + dot( boDnDy, boDnDy ) );
	float boKernel = min( 2.0 * boVariance, 0.18 );
	float boAlpha = roughnessFactor * roughnessFactor;
	roughnessFactor = sqrt( clamp( boAlpha + boKernel, 0.0, 1.0 ) );
}
`;

/** Analytic sun evaluated through three's own BRDF so every material feature works. */
const SUN_INJECT = /* glsl */ `
#if defined( RE_Direct )
{
	vec3 boWN = normalize( normal * mat3( viewMatrix ) );
	float boNdotL = dot( boWN, boSunDirWorld );
	if ( boNdotL > 0.0 && ( boSunColor.r + boSunColor.g + boSunColor.b ) > 0.0001 ) {
		float boVD = max( - vBoViewPos.z, 0.0 );
		float boShadow = boSunShadow( vBoWorldPos, boWN, boVD, boNdotL, gl_FragCoord.xy );
		// A contact shadow is a proximity cue, not a sun-visibility cue: the old
		// 0.02 gate let only the ~2.5% of the frame the cascades already called
		// fully lit ever receive one.
		if ( boShadow > 0.002 && boContactParams.x > 0.0 ) {
			boShadow = min( boShadow, boContactShadow(
				vBoViewPos, normalize( normal ), boSunDirView, boNdotL, projectionMatrix, gl_FragCoord.xy ) );
		}
		boDbgShadow = boShadow;
		boSunVis = boShadow;
		boDbgLit = 1.0;
		IncidentLight boSun;
		boSun.direction = boSunDirView;
		boSun.color = boSunColor * boShadow;
		boSun.visible = true;
		RE_Direct( boSun, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
}
#endif
`;

/** Replaces three's env-map irradiance with the sky SH probe. */
const MAPS_REPLACE = /* glsl */ `
#if defined( RE_IndirectDiffuse )

	#ifdef USE_LIGHTMAP

		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		irradiance += lightMapTexel.rgb * lightMapIntensity;

	#endif

	#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG )

		vec3 boIndN = normalize( normal * mat3( viewMatrix ) );

		// Sky fill, off the SH probe — scaled by how much sky this point can
		// actually see.
		//
		// Without the visibility term the probe is a flat, unoccluded 3.2x fill
		// applied identically to the open plaza, the back of a terrace flat and
		// the middle of a 23x25 m warehouse, which is why auto-exposure moved
		// 0.05 stops walking from one to the other. Interiors that meter the same
		// as the street are VISUAL-BAR tell #4 on their own.
		float boSkyVis = boSkyVisibility( vBoViewPos, normalize( normal ),
		                                  projectionMatrix, gl_FragCoord.xy );
		boSkyVisFrag = boSkyVis;
		vec3 boIndirect = boShIrradiance( boIndN, boAmbientSH ) * boSkyVis;

		// Ground bounce.
		//
		// The SH probe is projected from the sky dome bake alone, so its lower
		// hemisphere is empty. A wall on the shadow side of a building was
		// therefore lit by the half of the sky it can see and by absolutely
		// nothing else, which is why those walls fell away to a couple of per
		// cent grey a few metres up; the underside of an awning, a balcony or a
		// vehicle received nothing at all and read as a hole cut in the scene.
		//
		// Real streets do not work like that: in daylight the ground is the
		// second brightest thing in the frame and throws a warm fill straight
		// back up every vertical surface. One Lambert bounce is enough — the
		// irradiance landing on the ground (sun, cosine-weighted by its
		// elevation, plus the sky's own downward irradiance), reflected by a
		// dusty street albedo, weighted by how much of the receiver's hemisphere
		// lies below the horizon. Ground-facing-up surfaces get none of it, so
		// this cannot flatten the cast shadows on the plaza.
		// The catch was that this used the *unshadowed* sun and the *unoccluded*
		// sky, for every receiver in the level. On a map where most of the ground
		// is in shade that is a systematic warm lift on every vertical and
		// downward-facing surface: measured sunlit gravel came out at linear
		// R:B 3.50 and *shadowed* gravel at 6.09, so the shadows were twice as warm
		// as the key and the golden-hour split was inverted. Worse, a ceiling
		// (n.y = -1) took the term at full weight, which is how interior-flat's
		// ceiling ended up brighter than its own floor.
		//
		// So the "ground" is now the ground *here*: it sees the sky this receiver
		// sees, and it is lit by the sun if the receiver is lit or if the receiver
		// stands somewhere open enough for the street in front of it to be. A
		// ceiling in a closed room is neither, and stops pretending it is looking at
		// a sunlit plaza. Neither gate reaches zero — multiply-scattered light does
		// not, and zeroing it would re-open the "underside of an awning reads as a
		// hole cut in the scene" problem this term exists to fix.
		float boGroundLit = max( boSunVis, boSkyVis * boSkyVis );
		vec3 boGroundIrr =
			  boShIrradiance( vec3( 0.0, 1.0, 0.0 ), boAmbientSH ) * mix( 0.18, 1.0, boSkyVis )
			+ boSunColor * max( boSunDirWorld.y, 0.0 ) * mix( 0.10, 1.0, boGroundLit );
		boIndirect += boGroundIrr * BO_GROUND_ALBEDO * max( 0.5 - 0.5 * boIndN.y, 0.0 );

		iblIrradiance += boIndirect * boAmbientTint * boAmbientIntensity;

	#endif

#endif

#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )

	// Specular sky radiance is sky too — a warehouse wall cannot reflect a dome
	// it cannot see, and scene.environmentIntensity is driven from the same 3.2
	// ambient scale, so leaving this ungated re-admits most of what the diffuse
	// term just removed.
	#ifdef USE_ANISOTROPY

		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy ) * boSkyVisFrag;

	#else

		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * boSkyVisFrag;

	#endif

	#ifdef USE_CLEARCOAT

		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );

	#endif

#endif
`;

/**
 * G-buffer normal encoding.
 *
 * `gbuffer:normalRoughness` is an RGBA16F attachment and every consumer —
 * `GtaoPass`, `SsrPass` and the passes module's own reference writer in
 * `LabMaterial` — reads `nr.xyz` as a *raw signed* view-space normal and uses
 * `length(n) < 0.1` as the "nothing was written here" sentinel. Writing
 * `n * 0.5 + 0.5` instead pushed every normal into the positive octant (a wall
 * facing (-1,0,0) arrived as (0,0.5,0.5)), which made GTAO's horizon integral
 * over-occlude by up to 5x on flat, unoccluded surfaces and made SSR's backface
 * rejection meaningless. It also made the sentinel unreachable — the shortest
 * encoded vector is 0.37 long. Raw it is.
 */
function mrtWrite(kind: MaterialKind, hasVelocity: boolean, aerial: boolean, sun = false): string {
  const vel = hasVelocity
    ? `vec2 boCur = vBoClipCur.xy / max( abs( vBoClipCur.w ), 1e-5 ) * sign( vBoClipCur.w );
       vec2 boPrv = vBoClipPrev.xy / max( abs( vBoClipPrev.w ), 1e-5 ) * sign( vBoClipPrev.w );
       boGVelocity = ( boCur - boPrv ) * 0.5 * boResolution;`
    : `boGVelocity = vec2( 0.0 );`;

  if (kind === 'standard') {
    return /* glsl */ `
{
	${aerial ? `gl_FragColor.rgb = boAerialPerspective( gl_FragColor.rgb, vBoWorldPos, cameraPosition, boSunDirWorld );` : ''}
	${sun && DEBUG_SHADOW ? `gl_FragColor.rgb = vec3( boDbgShadow, boDbgLit, 0.0 ) * 0.35;` : ''}
	${sun ? `// A negative sky-occlusion strength paints the visibility term itself, so
	// "is this uniform even bound" is a screenshot instead of an argument.
	if ( boSkyOccParams.x < -0.5 ) gl_FragColor.rgb = vec3( boSkyVisFrag * 0.35 );` : ''}
	float boAO = 1.0;
	#ifdef USE_AOMAP
		boAO = ambientOcclusion;
	#endif
	float boEm = boSat( boLuma( totalEmissiveRadiance ) * 4.0 );
	boGNormalRough = vec4( normalize( normal ), clamp( roughnessFactor, 0.0, 1.0 ) );
	boGMaterial = vec4( clamp( metalnessFactor, 0.0, 1.0 ), boAO, boMatId, boEm );
	${vel}
}
`;
  }
  if (kind === 'lit') {
    return /* glsl */ `
{
	boGNormalRough = vec4( normalize( normal ), 0.8 );
	boGMaterial = vec4( 0.0, 1.0, boMatId, 0.0 );
	${vel}
}
`;
  }
  // Unlit / unknown: the zero-length sentinel, so AO and SSR skip these pixels
  // instead of occluding a sprite against itself.
  return /* glsl */ `
{
	boGNormalRough = vec4( 0.0, 0.0, 0.0, 1.0 );
	boGMaterial = vec4( 0.0, 1.0, boMatId, 1.0 );
	${vel}
}
`;
}

/* --------------------------------------------------------------- patcher -- */

export interface PatchOptions {
  /** Material id written to the G-buffer (0.5 world, 0.85 view model, 1 sky). */
  matId?: number;
  /** Apply the analytic sun + shadows (false for the view-model scene, which
   *  gets its own rig, and for anything explicitly unlit). */
  sun?: boolean;
  /** Apply distance fog / aerial perspective. */
  aerial?: boolean;
}

export class MaterialPatcher {
  /** Materials we have already rewritten this session. */
  private seen = new WeakSet<THREE.Material>();
  private sharedUniforms: Record<string, THREE.IUniform>;
  private warned = new Set<string>();

  /**
   * Sky-occlusion controls: x strength, y radius (m), z floor, w response
   * exponent. Owned here rather than in `RenderUniforms` because nothing in the
   * frame loop drives it — it is a shading-model constant, not per-frame state —
   * and because only materials this patcher rewrites declare it.
   *
   * Strength ships at 1.0, i.e. the term is live. `World.setAmbient`'s intensity
   * can only come down once this exists; before it, dropping the ambient just
   * made outdoors flat and dark.
   */
  readonly skyOcc: THREE.IUniform = { value: new THREE.Vector4(1.0, 16.0, 0.12, 1.9) };

  constructor(private uniforms: RenderUniforms) {
    this.sharedUniforms = uniforms.shared();
    // Live handles for the capture harness, mirroring `__DOF__`. `skyOcc` is the
    // shared Vector4 itself, so poking `.y` from a probe retunes every material
    // in the scene on the next frame with no rebuild. `cascades` exists because
    // the shadow bias is a function of the live cascade texel size and there was
    // previously no way to read that number back out of a running frame — which
    // is how a bias of 1.82 m survived in the far cascade.
    const g = globalThis as unknown as Record<string, unknown>;
    g.__SKYOCC__ = this.skyOcc.value;
    g.__SHADING__ = {
      skyOcc: this.skyOcc.value,
      csmInfo: () => uniforms.boCsmInfo.value.toArray(),
      cascades: () => uniforms.boCsmParams.value.map((v) => {
        // Mirrors boCascadeSample: slope-scaled bias in metres, clamped.
        const bias = (ndl: number) => {
          const slope = Math.min(Math.tan(Math.acos(Math.min(Math.max(ndl, 0.05), 1))), 2);
          return Math.min(Math.max(v.z * (0.85 + 1.25 * slope), v.z * 0.85), Math.max(0.06, v.z * 1.5));
        };
        return {
          extent: v.x, zRange: v.y, texelW: v.z, splitFar: v.w,
          biasFlatGroundM: +bias(0.191).toFixed(4),
          biasSteepM: +bias(0.9).toFixed(4),
        };
      }),
    };
  }

  /** True when the material now carries our injection. */
  patch(material: THREE.Material, opts: PatchOptions = {}): PatchState | null {
    const ud = material.userData as BOUserData;
    if (ud.boSkipMRT) return null;

    const existing = ud.boPatch;
    if (existing && existing.version === PATCH_VERSION && material.onBeforeCompile === existing.hook) {
      return existing;
    }

    const kind = classifyMaterial(material);
    if (kind === null) {
      const key = material.type;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(`[render] material "${key}" left unpatched — it will not write the G-buffer`);
      }
      return null;
    }

    const wantSun = kind === 'standard' && opts.sun !== false && !ud.boNoSun;
    const wantAerial = kind === 'standard' && opts.aerial !== false;

    const matId: THREE.IUniform = { value: ud.boMatId ?? opts.matId ?? 0.5 };
    const prevMatrix: THREE.IUniform = { value: new THREE.Matrix4() };

    const previousHook = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile')
      ? material.onBeforeCompile
      : null;

    const state: PatchState = {
      version: PATCH_VERSION,
      hook: () => { /* replaced below */ },
      matId,
      prevMatrix,
      kind,
    };

    const shared = this.sharedUniforms;

    const hook: THREE.Material['onBeforeCompile'] = (shader, renderer) => {
      previousHook?.call(material, shader, renderer);

      const hasVertexAnchor = shader.vertexShader.includes('#include <project_vertex>');

      // --- uniforms -----------------------------------------------------
      for (const k in shared) shader.uniforms[k] = shared[k];
      shader.uniforms.boMatId = matId;
      shader.uniforms.boPrevModelMatrix = prevMatrix;
      if (wantSun) shader.uniforms.boSkyOccParams = this.skyOcc;

      // --- vertex -------------------------------------------------------
      if (hasVertexAnchor) {
        shader.vertexShader =
          `${WORLD_VARYINGS}\n${VELOCITY_VARYINGS}\n${VERTEX_PARS}\n${shader.vertexShader}`
            .replace(
              '#include <project_vertex>',
              `#include <project_vertex>\n${VERTEX_BODY}`,
            );
      }

      // --- fragment -----------------------------------------------------
      const pars = [
        FRAG_PARS_COMMON,
        wantSun ? FRAG_PARS_LIT : '',
        wantAerial && hasVertexAnchor ? FRAG_PARS_AERIAL : '',
      ].join('\n');
      const varyings = hasVertexAnchor
        ? `${WORLD_VARYINGS}\n${VELOCITY_VARYINGS}`
        : '';

      let frag = `${MRT_DECL}\n${varyings}\n${pars}\n${shader.fragmentShader}`;

      if (kind === 'standard' && frag.includes('#include <normal_fragment_maps>')) {
        frag = frag.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n${SPEC_AA_INJECT}`,
        );
      }

      if (wantSun) {
        frag = frag.replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>\n${SUN_INJECT}`,
        );
        frag = frag.replace('#include <lights_fragment_maps>', MAPS_REPLACE);
      }

      const write = mrtWrite(kind, hasVertexAnchor, wantAerial && hasVertexAnchor, wantSun);
      if (frag.includes('#include <fog_fragment>')) {
        frag = frag.replace('#include <fog_fragment>', `#include <fog_fragment>\n${write}`);
      } else {
        // Last resort: append just before the closing brace of main().
        const i = frag.lastIndexOf('}');
        frag = i >= 0 ? `${frag.slice(0, i)}\n${write}\n}` : frag;
      }

      shader.fragmentShader = frag;
      state.shader = shader as unknown as { uniforms: Record<string, THREE.IUniform> };
    };

    state.hook = hook;
    material.onBeforeCompile = hook;
    // Keeps patched/unpatched variants of the same material class in separate
    // program slots; constant string means settings changes never recompile.
    material.customProgramCacheKey = () => `bo${PATCH_VERSION}:${kind}:${wantSun ? 1 : 0}:${wantAerial ? 1 : 0}`;
    material.needsUpdate = true;
    ud.boPatch = state;
    this.seen.add(material);
    return state;
  }

  /** Per-object previous-frame model matrix, consumed by the velocity buffer. */
  setPrevMatrix(material: THREE.Material, m: THREE.Matrix4): void {
    const st = (material.userData as BOUserData).boPatch;
    if (st) (st.prevMatrix.value as THREE.Matrix4).copy(m);
  }

  setMatId(material: THREE.Material, id: number): void {
    const st = (material.userData as BOUserData).boPatch;
    if (st) st.matId.value = id;
    (material.userData as BOUserData).boMatId = id;
  }
}

/** Marks a material so the patcher leaves it completely alone. */
export function skipPatch<T extends THREE.Material>(m: T): T {
  (m.userData as BOUserData).boSkipMRT = true;
  return m;
}
