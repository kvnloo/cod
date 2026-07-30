/**
 * Networking's vocabulary on the shared event bus.
 *
 * Added by interface merging rather than by editing `src/core/EventBus.ts`: the
 * bus is a contract twenty people depend on, and the net stack should be able to
 * appear and disappear without touching it. Importing this module anywhere in the
 * program makes the `net:*` keys type-check everywhere.
 *
 * HUD, killfeed, scoreboard and FX consume these as pure listeners — nothing in
 * the net stack knows they exist.
 */

import type { MigrationPhase } from './HostMigration';
import type { SessionRole } from './PeerSession';

declare module '../../core/EventBus' {
  interface GameEvents {
    /** Connection state, emitted whenever anything in it changes. */
    'net:status': {
      role: SessionRole;
      phase: MigrationPhase;
      hostName: string;
      epoch: number;
      players: number;
      tick: number;
      /** True while the local peer holds authority. */
      authoritative: boolean;
    };
    /** Link quality for the HUD's connection pip. */
    'net:quality': {
      rttMs: number;
      jitterMs: number;
      lossPct: number;
      snapshotHz: number;
      bytesPerSec: number;
      inputBuffer: number;
    };
    /** A player entered the match (including after a migration re-handshake). */
    'net:peer:join': { clientId: number; name: string; team: number };
    'net:peer:leave': { clientId: number; name: string; reason: string };
    /** Host migration progress — the UI should show this, not hide it. */
    'net:migration': {
      phase: MigrationPhase;
      hostName: string;
      epoch: number;
      reason: string;
      /** Migrations completed this match. */
      count: number;
    };
    /**
     * An authoritative gameplay fact replicated from the host. FX/audio/HUD
     * listen to this exactly as they listen to local gameplay events.
     */
    'net:event': {
      kind: string; a: number; b: number;
      x: number; y: number; z: number; n: number; s?: string;
    };
  }
}

export { };
