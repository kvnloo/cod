/**
 * Public surface of the authoritative host.
 *
 * Everything here is Three.js-free and DOM-free: the same build runs in a browser
 * peer, in a node test and in a headless dedicated server. `src/net/NetSystem.ts`
 * is the only file that bridges it to the engine.
 */

export * from './types';
export * from './ports';
export { AuthorityCore, DEFAULT_AUTHORITY_CONFIG } from './Authority';
export type { Authority, AuthorityConfig, AuthorityStats } from './Authority';
export { PeerHost } from './PeerHost';
export type { PeerHostOptions, PeerHostStats } from './PeerHost';
export { PeerSession } from './PeerSession';
export type { PeerSessionOptions, SessionRole, SessionStats, SnapshotSink, InputSource } from './PeerSession';
export {
  MigrationCoordinator, electHost, DEFAULT_MIGRATION_POLICY,
} from './HostMigration';
export type {
  MigrationPolicy, MigrationPhase, MigrationStatus, MigrationHooks,
  ElectionInput, ElectionResult,
} from './HostMigration';
export {
  DeltaSnapshotWriter, SnapshotReader, DEFAULT_WRITER_OPTIONS, applyDelta,
  fieldScale, FIELD_SCALE,
} from './SnapshotWriter';
export type { SnapshotWriterOptions } from './SnapshotWriter';
export { ArenaSim, DEFAULT_ARENA } from './DefaultSim';
export type { ArenaConfig } from './DefaultSim';
export { JsonCodec, jsonCodec } from './Codec';
export { TickRand, RNG_SALT } from './TickRand';
export {
  exportCheckpoint, importCheckpoint, verifyCheckpoint, cloneWorldState,
} from './Checkpoint';
export {
  LoopbackNetwork, PERFECT_LINK, TYPICAL_LINK,
} from './testing/LoopbackTransport';
export type { LinkConditions } from './testing/LoopbackTransport';
import './NetEvents';
