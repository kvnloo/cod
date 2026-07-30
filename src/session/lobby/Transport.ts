/**
 * The seam between the lobby and the netcode layer.
 *
 * `src/net/` is being written in parallel and does not exist yet, so this file
 * declares the *narrowest possible* interface the lobby needs and ships a
 * working in-process implementation of it. When the real transport lands it
 * implements `LobbyTransport` and nothing in the lobby changes.
 *
 * What the lobby needs from netcode, and nothing more:
 *
 * | need                      | member            |
 * |---------------------------|-------------------|
 * | who am I                  | `localId`         |
 * | who is authoritative      | `hostId()`        |
 * | send a request to the host| `send()`          |
 * | publish state as the host | `broadcast()`     |
 * | receive requests as host  | `onCommand()`     |
 * | receive state as client   | `onMessage()`     |
 * | authority changed         | `onAuthority()`   |
 * | a peer vanished           | `onPeerLost()`    |
 * | connection quality        | `pingOf()`        |
 *
 * Delivery in `LocalTransportHub` is synchronous, which makes the harness
 * deterministic. The lobby does not care: every interaction is
 * command-in / state-out, so latency only changes when a client sees the
 * result, never what the result is.
 */

import type { LobbySnapshot, LobbyState, MatchConfig, PlayerId } from '../types';
import type { LobbyCommand, LobbyErrorCode } from './Commands';

/** Host → client traffic. */
export type LobbyMessage =
  | { t: 'state'; state: LobbyState }
  /** Handed to the peer that is taking over as host. */
  | { t: 'snapshot'; snapshot: LobbySnapshot }
  | { t: 'launch'; config: MatchConfig }
  | { t: 'error'; to: PlayerId; code: LobbyErrorCode; error: string }
  | { t: 'closed'; reason: string };

export interface LobbyTransport {
  readonly localId: PlayerId;
  hostId(): PlayerId;
  isHost(): boolean;
  /** Client → host. A host may call this on itself; it loops back. */
  send(cmd: LobbyCommand): void;
  /** Host → every connected peer. */
  broadcast(msg: LobbyMessage): void;
  /** Host → one peer. */
  sendTo(id: PlayerId, msg: LobbyMessage): void;
  /** Host side: a command arrived. `from` is transport-verified. */
  onCommand(fn: (cmd: LobbyCommand, from: PlayerId) => void): () => void;
  /** Client side: the host published something. */
  onMessage(fn: (msg: LobbyMessage) => void): () => void;
  /** Authority moved. Fires on every peer, including the new host. */
  onAuthority(fn: (hostId: PlayerId) => void): () => void;
  /** A peer's connection died. Host-side only. */
  onPeerLost(fn: (id: PlayerId) => void): () => void;
  /** Last measured round-trip in milliseconds, or -1 when unknown. */
  pingOf(id: PlayerId): number;
  close(): void;
}

/* ------------------------------------------------------ local implementation */

interface Peer {
  id: PlayerId;
  ping: number;
  connected: boolean;
  onCommand: Array<(cmd: LobbyCommand, from: PlayerId) => void>;
  onMessage: Array<(msg: LobbyMessage) => void>;
  onAuthority: Array<(hostId: PlayerId) => void>;
  onPeerLost: Array<(id: PlayerId) => void>;
}

/**
 * An in-process mesh. One hub, N transports — enough to run a full lobby with
 * bots, to run the offline/solo path where the local player is always the host,
 * and to drive `tools/session-lobby.mjs` without any network at all.
 */
export class LocalTransportHub {
  private peers = new Map<PlayerId, Peer>();
  private host: PlayerId;

  constructor(hostId: PlayerId) { this.host = hostId; }

  get hostId(): PlayerId { return this.host; }
  get peerIds(): PlayerId[] { return [...this.peers.keys()].filter((id) => this.peers.get(id)!.connected); }

  connect(id: PlayerId, ping = 20): LobbyTransport {
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { id, ping, connected: true, onCommand: [], onMessage: [], onAuthority: [], onPeerLost: [] };
      this.peers.set(id, peer);
    }
    peer.connected = true;
    peer.ping = ping;
    return this.transportFor(peer);
  }

  /** Simulates a peer vanishing: the host hears about it, the peer goes quiet. */
  disconnect(id: PlayerId): void {
    const peer = this.peers.get(id);
    if (!peer || !peer.connected) return;
    peer.connected = false;
    const host = this.peers.get(this.host);
    if (host && host.connected) for (const fn of [...host.onPeerLost]) fn(id);
  }

  /** Moves authority. Everyone still connected is told, new host included. */
  setHost(id: PlayerId): void {
    this.host = id;
    for (const peer of this.peers.values()) {
      if (!peer.connected) continue;
      for (const fn of [...peer.onAuthority]) fn(id);
    }
  }

  setPing(id: PlayerId, ms: number): void {
    const peer = this.peers.get(id);
    if (peer) peer.ping = ms;
  }

  private transportFor(peer: Peer): LobbyTransport {
    const hub = this;
    return {
      localId: peer.id,
      hostId: () => hub.host,
      isHost: () => hub.host === peer.id,
      send(cmd) {
        const host = hub.peers.get(hub.host);
        if (!host || !host.connected || !peer.connected) return;
        for (const fn of [...host.onCommand]) fn(cmd, peer.id);
      },
      broadcast(msg) {
        if (hub.host !== peer.id) return;
        for (const p of hub.peers.values()) {
          if (!p.connected) continue;
          for (const fn of [...p.onMessage]) fn(msg);
        }
      },
      sendTo(id, msg) {
        if (hub.host !== peer.id) return;
        const p = hub.peers.get(id);
        if (!p || !p.connected) return;
        for (const fn of [...p.onMessage]) fn(msg);
      },
      onCommand(fn) {
        peer.onCommand.push(fn);
        return () => { const i = peer.onCommand.indexOf(fn); if (i >= 0) peer.onCommand.splice(i, 1); };
      },
      onMessage(fn) {
        peer.onMessage.push(fn);
        return () => { const i = peer.onMessage.indexOf(fn); if (i >= 0) peer.onMessage.splice(i, 1); };
      },
      onAuthority(fn) {
        peer.onAuthority.push(fn);
        return () => { const i = peer.onAuthority.indexOf(fn); if (i >= 0) peer.onAuthority.splice(i, 1); };
      },
      onPeerLost(fn) {
        peer.onPeerLost.push(fn);
        return () => { const i = peer.onPeerLost.indexOf(fn); if (i >= 0) peer.onPeerLost.splice(i, 1); };
      },
      pingOf(id) { return hub.peers.get(id)?.ping ?? -1; },
      close() { hub.disconnect(peer.id); },
    };
  }
}

/**
 * The degenerate transport: one player, always the host, no peers. This is the
 * offline/solo path, and it is what the game boots with until netcode attaches.
 */
export function soloTransport(localId: PlayerId): LobbyTransport {
  return new LocalTransportHub(localId).connect(localId, 0);
}
