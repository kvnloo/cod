/**
 * Public surface of the material module.
 *
 * Other systems should import from here rather than reaching into individual
 * files, so the internals (forge passes, recipe files, GLSL blobs) stay free to
 * change.
 *
 *   import { MaterialSystem, applyInstanceVariation } from '../material';
 *
 * The common case is just:
 *
 *   const mats = ctx.engine.tryGet<MaterialSystem>('materials');
 *   mesh.material = mats.get('concrete', { scale: 3 });
 *
 * `scale` is metres per texture repeat and works on any geometry, because
 * every environment archetype defaults to triplanar projection.
 */

export { MaterialSystem } from './MaterialLibrary';
export {
  applyInstanceVariation, setBlendWeights, materialUniforms,
  extendStandardMaterial, EMISSIVE_MODES,
  type ShaderExtensionConfig, type ObUniforms,
} from './MaterialShaders';
export { TextureForge, FORGE_QUALITY, type ForgeRecipe, type PbrTextureSet } from './TextureForge';
export type {
  MaterialOptions, MaterialArchetype, DetailKind, EmissiveKind, WarmupProgress,
} from './types';
