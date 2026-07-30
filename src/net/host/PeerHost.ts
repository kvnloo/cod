/**
 * A browser peer acting as the authoritative host.
 *
 * `PeerHost` is `AuthorityCore` + a `Transport` + the handshake. That is the whole
 * difference between "peer hosting for four friends with no infrastructure" and
 * "dedicated server": a dedicated build constructs the identical object with a
 * socket-backed transport and `kind: 'dedicated'`, and the simulation, the
 * protocol, the replication and the clients are byte-for-byte the same. There is
 * no peer-specific gameplay path to unwind later — that was the point.
 *
 * The host is also a player, so its own input goes through the same command queue
 * as everyone else's. If the host's input took a shortcut, the host would
 * silently be playing a different game from its opponents.
 */

import type { AuthorityObserver, Codec, SimStepper, SnapshotWriter, Transport } from './ports';
import { AuthorityCore, type Authority, type AuthorityConfig } from './Authority';
import { jsonCodec } from './Codec';
import {
  PROTOCOL_VERSION,
  type ClientId, type ClientToHost, type HostCheckpoint, type HostToClient,
  type InputCommand, type PeerId, type RosterEntry, type StableId, type Tick,
  type WorldState,
} from './types';

export interface PeerHostOptions {
  /** This peer's persistent identity. Also the tiebreak key for host election. */
  stableId: StableId;
  displayName: string;
  transport: Transport;
  codec?: Codec;
  sim?: SimStepper;
  writer?: SnapshotWriter;
  config?: Partial<AuthorityConfig>;
  /** 'dedicated' when the same code runs headless with no local player. */
  kind?: 'peer-host' | 'dedicated';
  /** Send a snapshot every N ticks. 1 = every tick. */
  snapshotIntervalTicks?: number;
  /** Unreliable liveness beacon interval in ticks; clients use it to detect host death. */
  heartbeatIntervalTicks?: number;
  /** Resume an existing match instead of starting a fresh one (host migration). */
  resume?: { checkpoint: HostCheckpoint; epoch: number };
}

export interface PeerHostStats {
  bytesSentToClients: number;
  snapshotsSent: number;
  checkpointsSent: number;
  clients: number;
}

export class PeerHost implements Authority {
  readonly kind: 'peer-host' | 'dedicated';
  readonly hostStableId: StableId;
  readonly core: AuthorityCore;
  readonly transport: Transport;

  private codec: Codec;
  private unsubs: Array<() => void> = [];
  private peerToClient = new Map<PeerId, ClientId>();
  private clientToPeer = new Map<ClientId, PeerId>();
  private pendingPing = new Map<ClientId, { id: number; sentMs: number }>();
  private snapshotIntervalTicks: number;
  private heartbeatIntervalTicks: number;
  private lastSnapshotTick = -1;
  private lastCheckpointTick = -1;
  private lastHeartbeatTick = -1;
  private lastPingTick = -1;
  private started = false;
  private wallMs = 0;
  private rosterDirty = true;

  localClientId: ClientId = 0;

  readonly stats: PeerHostStats = {
    bytesSentToClients: 0, snapshotsSent: 0, checkpointsSent: 0, clients: 0,
  };

  constructor(opts: PeerHostOptions) {
    this.kind = opts.kind ?? 'peer-host';
    this.hostStableId = opts.stableId;
    this.transport = opts.transport;
    this.codec = opts.codec ?? jsonCodec;
    this.snapshotIntervalTicks = Math.max(1, opts.snapshotIntervalTicks ?? 1);
    this.heartbeatIntervalTicks = Math.max(1, opts.heartbeatIntervalTicks ?? 5);
    this.core = new AuthorityCore(opts.config, opts.sim, opts.writer);

    if (opts.resume) {
      this.core.resumeFrom(opts.resume.checkpoint, opts.resume.epoch);
    }

    // The host plays too. Admitting it through the normal path means there is
    // exactly one code path for "a player exists".
    if (this.kind === 'peer-host') {
      this.localClientId = this.core.admit(opts.stableId, opts.displayName, this.transport.localId, true);
      this.core.setConnInfo(this.localClientId, { rttMs: 0, checkpointTick: this.core.tick, hostCapable: true });
    }
  }

  /* ------------------------------------------------ Authority ------ */

  get tickRate(): number { return this.core.config.tickRate; }
  get tick(): Tick { return this.core.tick; }
  get epoch(): number { return this.core.epoch; }
  get running(): boolean { return this.started; }
  get state(): Readonly<WorldState> { return this.core.state; }

  observe(o: AuthorityObserver): () => void { return this.core.observe(o); }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(this.transport.onMessage((from, data) => this.onMessage(from, data)));
    this.unsubs.push(this.transport.onPeerLeave((peer, reason) => this.onPeerLeave(peer, reason)));
    // Anyone already connected must be told a new term has begun; on migration
    // this is what triggers the clients' re-handshake.
    this.announce();
  }

  stop(): void {
    this.started = false;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  dispose(): void { this.stop(); }

  /**
   * Drive the host. Call this from the engine's fixed step (browser) or from a
   * setInterval / busy loop (headless). Returns ticks simulated.
   */
  advance(dtSeconds: number): number {
    if (!this.started) return 0;
    this.wallMs += dtSeconds * 1000;
    const ran = this.core.advance(dtSeconds);
    if (ran > 0) {
      this.maybeSendSnapshots();
      this.maybeSendCheckpoint();
      this.maybeHeartbeat();
      this.maybePing();
    }
    return ran;
  }

  submitLocalInput(cmd: InputCommand): void {
    if (this.localClientId) this.core.submitInput(this.localClientId, [cmd]);
  }

  roster(): RosterEntry[] { return this.core.roster(); }

  exportCheckpoint(): HostCheckpoint { return this.core.exportCheckpoint(); }

  /* -------------------------------------------------- handshake ---- */

  private onMessage(from: PeerId, data: Uint8Array): void {
    let msg: ClientToHost;
    try {
      msg = this.codec.decode(data) as ClientToHost;
    } catch {
      return; // malformed frame from a peer is not the host's problem
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'join': return this.onJoin(from, msg);
      case 'input': {
        const clientId = this.peerToClient.get(from);
        if (!clientId || clientId !== msg.clientId) return; // never trust the id in the packet alone
        this.core.submitInput(clientId, msg.cmds ?? []);
        if (typeof msg.ackTick === 'number') this.core.acknowledge(clientId, msg.ackTick);
        if (typeof msg.ackCheckpoint === 'number') {
          this.core.setConnInfo(clientId, { checkpointTick: msg.ackCheckpoint });
          this.rosterDirty = true;
        }
        return;
      }
      case 'ping': {
        const clientId = this.peerToClient.get(from);
        this.sendTo(from, { t: 'pong', id: msg.id, clientMs: msg.clientMs, hostMs: this.wallMs, tick: this.core.tick }, 'unreliable');
        if (clientId) {
          const p = this.pendingPing.get(clientId);
          if (p && p.id === msg.id) {
            this.core.setConnInfo(clientId, { rttMs: Math.max(0, this.wallMs - p.sentMs) });
            this.pendingPing.delete(clientId);
            this.rosterDirty = true;
          }
        }
        return;
      }
      case 'bye': {
        const clientId = this.peerToClient.get(from);
        if (clientId) this.releasePeer(from, clientId, 'bye');
        return;
      }
      default: return;
    }
  }

  private onJoin(from: PeerId, msg: Extract<ClientToHost, { t: 'join' }>): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.sendTo(from, { t: 'reject', reason: `protocol ${msg.v} != ${PROTOCOL_VERSION}` }, 'reliable');
      return;
    }
    if (typeof msg.stableId !== 'string' || msg.stableId.length === 0) {
      this.sendTo(from, { t: 'reject', reason: 'bad identity' }, 'reliable');
      return;
    }
    // A re-handshake after migration arrives here too, and resolves to the same
    // slot because `admit` keys on stableId. The player does not respawn, does
    // not lose their score, and does not notice.
    const clientId = this.core.admit(msg.stableId, msg.name || msg.stableId, from, true);
    const prevPeer = this.clientToPeer.get(clientId);
    if (prevPeer && prevPeer !== from) this.peerToClient.delete(prevPeer);
    this.peerToClient.set(from, clientId);
    this.clientToPeer.set(clientId, from);
    this.rosterDirty = true;
    this.stats.clients = this.clientToPeer.size;

    const snapshot = this.core.snapshotFor(clientId, true);
    this.sendTo(from, {
      t: 'welcome', v: PROTOCOL_VERSION, epoch: this.core.epoch,
      hostStableId: this.hostStableId, clientId,
      tickRate: this.core.config.tickRate, tick: this.core.tick,
      seed: this.core.state.seed, snapshot,
    }, 'reliable');
    // A joiner is a standby host candidate the moment it has state.
    this.sendTo(from, { t: 'checkpoint', cp: this.core.exportCheckpoint() }, 'reliable');
  }

  private onPeerLeave(peer: PeerId, reason: string): void {
    const clientId = this.peerToClient.get(peer);
    if (clientId) this.releasePeer(peer, clientId, reason);
  }

  private releasePeer(peer: PeerId, clientId: ClientId, reason: string): void {
    this.peerToClient.delete(peer);
    this.clientToPeer.delete(clientId);
    this.pendingPing.delete(clientId);
    this.core.drop(clientId, reason);
    this.rosterDirty = true;
    this.stats.clients = this.clientToPeer.size;
  }

  /* ------------------------------------------------ replication ---- */

  private maybeSendSnapshots(): void {
    if (this.core.tick - this.lastSnapshotTick < this.snapshotIntervalTicks) return;
    this.lastSnapshotTick = this.core.tick;
    const includeRoster = this.rosterDirty;
    for (const [clientId, peer] of this.clientToPeer) {
      const s = this.core.snapshotFor(clientId, includeRoster);
      this.sendTo(peer, { t: 'snapshot', s }, 'unreliable');
      this.stats.snapshotsSent++;
    }
    this.rosterDirty = false;
    this.core.flushEvents();
  }

  /**
   * Warm standby. Every host-capable peer is continuously handed a full copy of
   * authoritative state. You cannot fetch state from a host that has already
   * gone, so it has to already be out there before it is needed — this is the
   * single most important line in the migration story.
   */
  private maybeSendCheckpoint(): void {
    const interval = this.core.config.checkpointIntervalTicks;
    if (this.core.tick - this.lastCheckpointTick < interval) return;
    this.lastCheckpointTick = this.core.tick;
    if (this.clientToPeer.size === 0) return;
    const cp = this.core.exportCheckpoint();
    for (const [, peer] of this.clientToPeer) {
      this.sendTo(peer, { t: 'checkpoint', cp }, 'reliable');
      this.stats.checkpointsSent++;
    }
  }

  private maybeHeartbeat(): void {
    if (this.core.tick - this.lastHeartbeatTick < this.heartbeatIntervalTicks) return;
    this.lastHeartbeatTick = this.core.tick;
    const msg: HostToClient = {
      t: 'heartbeat', epoch: this.core.epoch, tick: this.core.tick, hostStableId: this.hostStableId,
    };
    for (const [, peer] of this.clientToPeer) this.sendTo(peer, msg, 'unreliable');
  }

  private maybePing(): void {
    if (this.core.tick - this.lastPingTick < this.core.config.tickRate) return;
    this.lastPingTick = this.core.tick;
    for (const [clientId, peer] of this.clientToPeer) {
      const id = (this.core.tick & 0xffff) >>> 0;
      this.pendingPing.set(clientId, { id, sentMs: this.wallMs });
      this.sendTo(peer, { t: 'pong', id, clientMs: 0, hostMs: this.wallMs, tick: this.core.tick }, 'unreliable');
    }
  }

  /** Tell everyone a new host term has begun. Clients respond by re-handshaking. */
  announce(): void {
    const msg: HostToClient = {
      t: 'hostAnnounce', epoch: this.core.epoch, hostStableId: this.hostStableId, tick: this.core.tick,
    };
    const data = this.codec.encode(msg);
    for (const peer of this.transport.peers()) {
      this.transport.send(peer, data, 'reliable');
      this.stats.bytesSentToClients += data.byteLength;
    }
  }

  /**
   * Graceful handoff: hand the freshest possible state to a named successor and
   * tell everyone who it is. Migration then costs one round trip instead of a
   * heartbeat timeout.
   */
  handoff(successor: StableId): boolean {
    const cp = this.core.exportCheckpoint();
    const msg: HostToClient = { t: 'hostHandoff', epoch: this.core.epoch + 1, successor, cp };
    const data = this.codec.encode(msg);
    let sent = 0;
    for (const peer of this.transport.peers()) { this.transport.send(peer, data, 'reliable'); sent++; }
    this.stats.bytesSentToClients += data.byteLength * sent;
    this.stop();
    return sent > 0;
  }

  private sendTo(peer: PeerId, msg: HostToClient, channel: 'reliable' | 'unreliable'): void {
    const data = this.codec.encode(msg);
    this.transport.send(peer, data, channel);
    this.stats.bytesSentToClients += data.byteLength;
  }
}
