/**
 * Spawn authority.
 *
 * **The host picks. Clients ask and display.** A spawn point is a piece of
 * shared match state: two clients choosing locally would disagree, and a client
 * choosing for itself is the oldest cheat in multiplayer shooters. So this
 * module is written so that the selection code physically cannot run on a
 * client — `SpawnDirector.request()` on a non-host returns a `pending` decision
 * and forwards the request through `SpawnAuthority`.
 *
 * `src/net/` does not exist yet (it is being built in parallel). This is the
 * narrow contract the spawn system needs from it; the net layer should
 * implement `SpawnAuthority` over whatever transport it ends up with:
 *
 *   host  →  `SpawnGrant` broadcast to the requesting peer (and to everyone
 *            else who needs to render the body appearing)
 *   client → `SpawnRequestMsg` unicast to the host
 *
 * Both messages are plain data with no object references, so they serialise
 * with `JSON.stringify` or a binary writer without further work. Every grant
 * carries a monotonic `seq` so a re-sent grant is idempotent, and the `tick`
 * the host resolved it on so a client can place the body in the right frame of
 * a rollback buffer.
 *
 * Until the net layer exists, `LocalAuthority` is a host-only implementation
 * and everything works exactly as it does in single player.
 */

import type { SpawnDecision, SpawnRequestSpec, SpawnTeam } from './types';

/** Client → host. */
export interface SpawnRequestMsg {
  actorId: number;
  team: SpawnTeam;
  kind: 'player' | 'bot';
  /** Client's match time at the moment of the request; advisory only. */
  requestedAt: number;
  /** Optional zone hint, e.g. a squad-spawn button press. */
  zone: number;
  /** Client sequence number, echoed in the grant. */
  clientSeq: number;
}

/** Host → client. */
export interface SpawnGrant {
  actorId: number;
  pointId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Host sequence number; grants with a lower seq than the last applied are dropped. */
  seq: number;
  /** Host simulation tick the grant was resolved on. */
  tick: number;
  /** Echo of `SpawnRequestMsg.clientSeq`, or -1 for host-initiated spawns. */
  clientSeq: number;
}

export interface SpawnAuthority {
  /** True on the machine that owns match state. */
  readonly isHost: boolean;
  /** Stable id of this peer. */
  readonly localPeerId: number;
  /** Current authoritative tick, used to stamp grants. */
  readonly tick: number;
  /** Client → host. No-op on the host. */
  sendSpawnRequest?(msg: SpawnRequestMsg): void;
  /** Host → clients. No-op in single player. */
  broadcastGrant?(grant: SpawnGrant): void;
  /** Subscribe to grants arriving from the host. Returns an unsubscribe. */
  onGrant?(cb: (grant: SpawnGrant) => void): () => void;
}

/** Single-player / listen-server default: this machine is the host. */
export class LocalAuthority implements SpawnAuthority {
  readonly isHost = true;
  readonly localPeerId = 0;
  tick = 0;

  private listeners: Array<(grant: SpawnGrant) => void> = [];

  broadcastGrant(grant: SpawnGrant): void {
    for (const cb of this.listeners) cb(grant);
  }

  onGrant(cb: (grant: SpawnGrant) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

export function grantFrom(decision: SpawnDecision, actorId: number, tick: number, clientSeq = -1): SpawnGrant {
  return {
    actorId,
    pointId: decision.pointId,
    x: decision.position.x,
    y: decision.position.y,
    z: decision.position.z,
    yaw: decision.yaw,
    seq: decision.seq,
    tick,
    clientSeq,
  };
}

export function requestMsgFrom(req: SpawnRequestSpec, clientSeq: number): SpawnRequestMsg {
  return {
    actorId: req.actorId,
    team: req.team,
    kind: req.kind ?? 'bot',
    requestedAt: req.now,
    zone: req.zone ?? -1,
    clientSeq,
  };
}
