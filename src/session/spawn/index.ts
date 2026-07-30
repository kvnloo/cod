/**
 * Spawn system — public surface.
 *
 * `src/game/Spawns.ts` is the game-layer adapter over this module; everything
 * below is engine-agnostic and testable headlessly. Nothing here imports the
 * engine, the bus or `three` (except `DebugView`, which is opt-in).
 */

export * from './types';
export * from './Math';
export { InfluenceField, defaultInfluenceConfig, type InfluenceConfig } from './InfluenceField';
export { SpawnZones, defaultZoneConfig, type SpawnZone, type ZoneConfig } from './SpawnZones';
export { SpawnScorer, EYE_HEIGHT, CHEST_HEIGHT, type ScoreContext, type RelaxTier } from './SpawnScorer';
export { defaultWeights, policyFor, type SpawnPolicy, type SpawnWeights } from './Policies';
export {
  SpawnMetrics, type SpawnQualityReport, type SpawnRecord,
} from './SpawnMetrics';
export { SpawnDirector, type SpawnDirectorOptions } from './SpawnDirector';
export {
  LocalAuthority, grantFrom, requestMsgFrom,
  type SpawnAuthority, type SpawnGrant, type SpawnRequestMsg,
} from './Authority';
export {
  influenceSnapshot, pointDebug, zoneDebug, influenceColor, asciiInfluence, asciiHeat,
  type InfluenceSnapshot, type PointDebug, type ZoneDebug,
} from './DebugField';
export { baselinePick, baselineQuery, type BaselineQuery } from './Baseline';
export {
  runSpawnSim, defaultSimOptions, buildSimPoints, SimWorld,
  type SimOptions, type SimResult, type SimMode, type Selector,
} from './Sim';
