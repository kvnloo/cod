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
  GLSL_AERIAL, GLSL_COMMON, GLSL_CONTACT, GLSL_CSM, GLSL_SH, GLSL_ATMOSPHERE,
} from './Glsl';
import type { RenderUniforms } from './RenderUniforms';

export type MaterialKind = 'standard' | 'lit' | 'unlit' | 'raw';

const PATCH_VERSION = 7;

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

const FRAG_PARS_LIT = [
  GLSL_COMMON,
  GLSL_ATMOSPHERE,
  GLSL_SH,
  GLSL_CSM,
  GLSL_CONTACT,
  GLSL_AERIAL,
  /* glsl */ `
uniform vec3 boSunDirWorld;
uniform vec3 boSunDirView;
uniform vec3 boSunColor;
uniform vec3 boAmbientSH[ 9 ];
uniform vec3 boAmbientTint;
uniform float boAmbientIntensity;
uniform mat4 projectionMatrix;
`,
].join('\n');

/** Analytic sun evaluated through three's own BRDF so every material feature works. */
const SUN_INJECT = /* glsl */ `
#if defined( RE_Direct )
{
	vec3 boWN = normalize( normal * mat3( viewMatrix ) );
	float boNdotL = dot( boWN, boSunDirWorld );
	if ( boNdotL > 0.0 && ( boSunColor.r + boSunColor.g + boSunColor.b ) > 0.0001 ) {
		float boVD = max( - vBoViewPos.z, 0.0 );
		float boShadow = boSunShadow( vBoWorldPos, boWN, boVD, boNdotL, gl_FragCoord.xy );
		if ( boShadow > 0.02 && boContactParams.x > 0.0 ) {
			boShadow = min( boShadow, boContactShadow(
				vBoViewPos, normalize( normal ), boSunDirView, boNdotL, projectionMatrix, gl_FragCoord.xy ) );
		}
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

		iblIrradiance += boShIrradiance( normalize( normal * mat3( viewMatrix ) ), boAmbientSH )
		               * boAmbientTint * boAmbientIntensity;

	#endif

#endif

#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )

	#ifdef USE_ANISOTROPY

		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );

	#else

		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );

	#endif

	#ifdef USE_CLEARCOAT

		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );

	#endif

#endif
`;

function mrtWrite(kind: MaterialKind, hasVelocity: boolean, aerial: boolean): string {
  const vel = hasVelocity
    ? `vec2 boCur = vBoClipCur.xy / max( abs( vBoClipCur.w ), 1e-5 ) * sign( vBoClipCur.w );
       vec2 boPrv = vBoClipPrev.xy / max( abs( vBoClipPrev.w ), 1e-5 ) * sign( vBoClipPrev.w );
       boGVelocity = ( boCur - boPrv ) * 0.5 * boResolution;`
    : `boGVelocity = vec2( 0.0 );`;

  if (kind === 'standard') {
    return /* glsl */ `
{
	${aerial ? `gl_FragColor.rgb = boAerialPerspective( gl_FragColor.rgb, vBoWorldPos, cameraPosition, boSunDirWorld );` : ''}
	float boAO = 1.0;
	#ifdef USE_AOMAP
		boAO = ambientOcclusion;
	#endif
	float boEm = boSat( boLuma( totalEmissiveRadiance ) * 4.0 );
	boGNormalRough = vec4( normalize( normal ) * 0.5 + 0.5, clamp( roughnessFactor, 0.0, 1.0 ) );
	boGMaterial = vec4( clamp( metalnessFactor, 0.0, 1.0 ), boAO, boMatId, boEm );
	${vel}
}
`;
  }
  if (kind === 'lit') {
    return /* glsl */ `
{
	boGNormalRough = vec4( normalize( normal ) * 0.5 + 0.5, 0.8 );
	boGMaterial = vec4( 0.0, 1.0, boMatId, 0.0 );
	${vel}
}
`;
  }
  // Unlit / unknown: neutral values so blending never corrupts the buffers.
  return /* glsl */ `
{
	boGNormalRough = vec4( 0.5, 0.5, 1.0, 1.0 );
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

  constructor(private uniforms: RenderUniforms) {
    this.sharedUniforms = uniforms.shared();
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
      const pars = wantSun ? FRAG_PARS_LIT : FRAG_PARS_COMMON;
      const varyings = hasVertexAnchor
        ? `${WORLD_VARYINGS}\n${VELOCITY_VARYINGS}`
        : '';

      let frag = `${MRT_DECL}\n${varyings}\n${pars}\n${shader.fragmentShader}`;

      if (wantSun) {
        frag = frag.replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>\n${SUN_INJECT}`,
        );
        frag = frag.replace('#include <lights_fragment_maps>', MAPS_REPLACE);
      }

      const write = mrtWrite(kind, hasVertexAnchor, wantAerial && hasVertexAnchor);
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
