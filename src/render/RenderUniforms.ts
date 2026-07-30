/**
 * The single set of shared uniform objects every patched material references.
 *
 * Because three reads `uniform.value` at draw time, handing the *same* object
 * to every material means the sun, the cascades, the sky cubemap and the fog can
 * all be updated once per frame with no per-material bookkeeping and zero
 * allocation in the hot path.
 */

import * as THREE from 'three';

export const CSM_MAX = 4;

function m4(): THREE.Matrix4 { return new THREE.Matrix4(); }
function v4(x = 0, y = 0, z = 0, w = 0): THREE.Vector4 { return new THREE.Vector4(x, y, z, w); }

export class RenderUniforms {
  /* --- sun ------------------------------------------------------------- */
  readonly boSunDirWorld = { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() };
  readonly boSunDirView = { value: new THREE.Vector3(0, 1, 0) };
  /** Perpendicular illuminance of the sun (already colour × intensity). */
  readonly boSunColor = { value: new THREE.Color(1, 1, 1) };

  /* --- cascaded shadow maps -------------------------------------------- */
  readonly boShadowAtlas: { value: THREE.Texture | null } = { value: null };
  readonly boCsmMatrix = { value: [m4(), m4(), m4(), m4()] };
  readonly boCsmTile = { value: [v4(), v4(), v4(), v4()] };
  readonly boCsmParams = { value: [v4(), v4(), v4(), v4()] };
  /** x cascade count, y tan(sun angular radius), z shadow distance, w map size */
  readonly boCsmInfo = { value: v4(0, 0.01, 120, 2048) };
  readonly boShadowStrength = { value: 1 };
  /** Rotates the shadow/contact kernels each frame so TAA can average them. */
  readonly boFrameJitter = { value: 0 };

  /* --- contact shadows / depth ----------------------------------------- */
  readonly boSceneDepth: { value: THREE.Texture | null } = { value: null };
  /** x strength, y ray length (m), z steps, w thickness (m) */
  readonly boContactParams = { value: v4(0, 0.35, 12, 0.5) };
  /** x near, y far, z 1/width, w 1/height */
  readonly boCameraParams = { value: v4(0.02, 900, 1 / 1920, 1 / 1080) };

  /* --- environment ------------------------------------------------------ */
  readonly boSkyCube: { value: THREE.CubeTexture | THREE.Texture | null } = { value: null };
  readonly boAmbientSH = {
    value: Array.from({ length: 9 }, () => new THREE.Vector3()),
  };
  readonly boAmbientTint = { value: new THREE.Color(1, 1, 1) };
  readonly boAmbientIntensity = { value: 1 };

  /* --- fog / aerial perspective ---------------------------------------- */
  /** x density, y height falloff, z sun in-scatter amount, w mie g */
  readonly boFogParams = { value: v4(0.0016, 0.06, 1.6, 0.76) };
  /** x base height, y max opacity, z inscatter boost, w weather grey */
  readonly boFogParams2 = { value: v4(0, 0.96, 1, 0) };
  readonly boFogTint = { value: new THREE.Color(0.7, 0.72, 0.76) };

  /* --- reprojection ----------------------------------------------------- */
  readonly boPrevViewProjection = { value: m4() };
  readonly boViewProjectionNoJitter = { value: m4() };
  readonly boResolution = { value: new THREE.Vector2(1920, 1080) };
  readonly boTime = { value: 0 };

  /** Uniforms shared by every patched material (excludes per-material ids). */
  shared(): Record<string, THREE.IUniform> {
    return {
      boSunDirWorld: this.boSunDirWorld,
      boSunDirView: this.boSunDirView,
      boSunColor: this.boSunColor,
      boShadowAtlas: this.boShadowAtlas,
      boCsmMatrix: this.boCsmMatrix,
      boCsmTile: this.boCsmTile,
      boCsmParams: this.boCsmParams,
      boCsmInfo: this.boCsmInfo,
      boShadowStrength: this.boShadowStrength,
      boFrameJitter: this.boFrameJitter,
      boSceneDepth: this.boSceneDepth,
      boContactParams: this.boContactParams,
      boCameraParams: this.boCameraParams,
      boSkyCube: this.boSkyCube,
      boAmbientSH: this.boAmbientSH,
      boAmbientTint: this.boAmbientTint,
      boAmbientIntensity: this.boAmbientIntensity,
      boFogParams: this.boFogParams,
      boFogParams2: this.boFogParams2,
      boFogTint: this.boFogTint,
      boPrevViewProjection: this.boPrevViewProjection,
      boViewProjectionNoJitter: this.boViewProjectionNoJitter,
      boResolution: this.boResolution,
      boTime: this.boTime,
    } as Record<string, THREE.IUniform>;
  }
}
