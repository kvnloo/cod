/**
 * Transport shims for the netcode seam.
 *
 * `src/net/` is being built in parallel and owns the wire. Matchmaking only
 * needs "deliver this object to the host" and "tell me what the host said", so
 * that is the whole interface (`MatchmakingTransport` in `types.ts`).
 *
 *  - `LoopbackTransport` — solo play and the offline front end. The local
 *    player is the host, messages come straight back.
 *  - `TransportHub` — an in-memory star network used by the simulation and by
 *    the verification tool to prove the authority split actually holds: a
 *    client's `joinQueue` must produce a *message*, never a local mutation.
 *
 * When the real transport lands, implement the same four members over it and
 * nothing else in this module changes.
 */

import type { MatchmakingMessage, MatchmakingTransport, PlayerId } from './types';

type Sub = (msg: MatchmakingMessage, from: PlayerId) => void;

export class LoopbackTransport implements MatchmakingTransport {
  readonly isHost = true;
  private subs = new Set<Sub>();

  constructor(readonly localPlayerId: PlayerId = 'local') { }

  send(msg: MatchmakingMessage): void {
    for (const fn of [...this.subs]) {
      try { fn(msg, this.localPlayerId); } catch (err) { console.error('[mm] transport handler threw', err); }
    }
  }

  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
}

/** In-memory star topology: every client talks only to the host. */
export class TransportHub {
  private subs = new Map<PlayerId, Set<Sub>>();
  /** Every message that crossed the wire — the tool asserts on this. */
  readonly traffic: Array<{ from: PlayerId; msg: MatchmakingMessage }> = [];

  constructor(readonly hostId: PlayerId) { }

  transportFor(playerId: PlayerId): MatchmakingTransport {
    const hub = this;
    return {
      isHost: playerId === hub.hostId,
      localPlayerId: playerId,
      send(msg: MatchmakingMessage): void { hub.route(playerId, msg); },
      subscribe(fn: Sub): () => void {
        let set = hub.subs.get(playerId);
        if (!set) { set = new Set(); hub.subs.set(playerId, set); }
        set.add(fn);
        return () => { set!.delete(fn); };
      },
    };
  }

  private route(from: PlayerId, msg: MatchmakingMessage): void {
    this.traffic.push({ from, msg });
    if (from === this.hostId) {
      for (const [id, set] of this.subs) {
        if (id === this.hostId) continue;
        for (const fn of [...set]) fn(msg, from);
      }
    } else {
      for (const fn of [...(this.subs.get(this.hostId) ?? [])]) fn(msg, from);
    }
  }
}
