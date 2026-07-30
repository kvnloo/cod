/**
 * Public surface of the session layer — everything that surrounds a match.
 *
 * `src/session/types.ts` is the shared vocabulary (ids, profiles, lobby state,
 * launch config); each subdirectory owns one concern and re-exports through
 * here. Today that is `lobby/`: room codes, parties, ready-up, voting, team
 * balancing and host migration.
 *
 * Everything under here is host-authoritative and JSON-serialisable by
 * construction, so it can be driven over the wire by `src/net/` without a
 * translation layer, and it runs headlessly in node — see
 * `tools/session-lobby.mjs`.
 */

export * from './types';
export * from './lobby';
