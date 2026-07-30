/**
 * Public surface of the character module.
 *
 *   import { CharacterSystem } from './characters';
 *   const chars = engine.get<CharacterSystem>('characters');
 *   const soldier = chars.create({ faction: 'pmc', loadout: 'rifleman', seed: 7 });
 *   scene.add(soldier.object);
 *
 * `CharacterSystem` implements both `System` and `CharacterFactory`, so it can
 * be registered in `main.ts` alongside the other systems and handed to AI as a
 * factory without any adapter.
 */

export { CharacterSystem } from './CharacterSystem';
export { Character, type CharacterHost } from './Character';
export { CharacterMaterials } from './Materials';
export { buildWeaponProp, type PropKind } from './Prop';
export { makeAppearance, appearanceMass, FACTION_STYLES, type Appearance } from './Appearance';
export { buildRig, BONE_INDEX, BONE_PARENT, RIG, type RigInstance, type Proportions } from './Rig';
export { buildSoldier, type SoldierGeometry } from './geom/Soldier';
export { SLOT, SLOT_COUNT, type SlotId } from './geom/Builder';
export { buildHitboxes, hitboxTransform, hitboxDebug } from './Hitboxes';
export { Animator, type Locomotion, type CarryPose } from './anim/Animator';
export { FootIK, flatGround, heightFieldProbe, type GroundProbe, type GroundSample } from './anim/FootIK';
export { clip, clips, STRIDE } from './anim/clips';
export { Clip, maskOf, type ClipDef, type KeySpec, type PoseSpec } from './anim/Clip';
export { Pose } from './anim/Pose';
export type {
  AnimName, BoneName, CharacterFaction, CharacterLoadout, CharacterOptions, HitBox,
  Character as CharacterAPI, CharacterFactory,
} from './types';
export { BONES } from './types';
