/**
 * One peer's membership in a match: connect, handshake, send inputs, receive
 * snapshots, survive the host disappearing.
 *
 * This is the piece that makes "peer acting as host" work without a special
 * gameplay path. Every peer runs a `PeerSession`. Exactly one of them also has a
 * `PeerHost` attached; the others are clients. When the host dies, one client
 * attaches a `PeerHost` of its own — same class, resumed from a mirrored
 * checkpoint — and everyone else re-handshakes. Nothing about the simulation, the
 * protocol or the client code knows which machine happens to be authoritative.
 *
 * Deliberately free of Three.js and the DOM so it can be driven from a node test
 * (see `tools/net-host-migration.mjs`) or from a headless dedicated build.
 *
 * **Topology assumption:** a full mesh. Peers hold DataChannels to each other,
 * not just to the host. Without that a successor would have no way to reach the
 * survivors and migration is impossible — which is exactly why it must be the
 * transport's job to keep the mesh up, not the host's.
 */

import { MigrationCoordinator, type MigrationPolicy, type MigrationStatus } from './HostMigration';
import { PeerHost, type PeerHostOptions } from './PeerHost';
import { jsonCodec } from './Codec';
import type { Codec, SimStepper, SnapshotWriter, Transport } from './ports';
import type { AuthorityConfig } from './Authority';
import {
  PROTOCOL_VERSION, emptyCommand,
  type ClientId, type ClientToHost, type HostToClient, type InputCommand,
  type NetEvent, type PeerId, type RosterEntry, type Snapshot, type StableId,
  type Tick,
} from './types';

/**
 * Where received authoritative state goes. The client-side prediction /
 * reconciliation / interpolation layer implements this; the session only moves
 * bytes and never interprets them.
 */
export interface SnapshotSink {
  onWelcome?(info: {
    clientId: ClientId; epoch: number; tick: Tick; tickRate: number;
    seed: number; hostStableId: StableId; migrated: boolean;
  }): void;
  onSnapshot?(s: Snapshot): void;
  onEvent?(ev: NetEvent): void;
  onDisconnect?(reason: string): void;
}

/** Supplies this peer's intent for a tick. Returning null sends a neutral command. */
export type InputSource = (tick: Tick) => InputCommand | null;

export interface PeerSessionOptions {
  stableId: StableId;
  displayName: string;
  transport: Transport;
  codec?: Codec;
  sink?: SnapshotSink;
  input?: InputSource;
  policy?: Partial<MigrationPolicy>;
  hostConfig?: Partial<AuthorityConfig>;
  sim?: SimStepper;
  writer?: SnapshotWriter;
  /** How many past commands to resend in each input packet. Cheap loss recovery. */
  inputRedundancy?: number;
  /** How far ahead of the last observed host tick this peer stamps its commands. */
  inputLeadTicks?: number;
}

export type SessionRole = 'offline' | 'host' | 'client';

export interface SessionStats {
  role: SessionRole;
  epoch: number;
  hostStableId: StableId;
  clientId: ClientId;
  lastSnapshotTick: Tick;
  snapshotsReceived: number;
  inputsSent: number;
  migrations: number;
  bytesSent: number;
  bytesReceived: number;
  phase: MigrationStatus['phase'];
}

export class PeerSession {
  readonly stableId: StableId;
  readonly displayName: string;
  readonly transport: Transport;
  readonly migration: MigrationCoordinator;

  host: PeerHost | null = null;
  clientId: ClientId = 0;
  epoch = 0;
  hostPeerId: PeerId | null = null;

  private codec: Codec;
  private sink: SnapshotSink;
  private inputSource: InputSource;
  private opts: PeerSessionOptions;
  private unsubs: Array<() => void> = [];
  private roster: RosterEntry[] = [];
  private lastSnapshotTick: Tick = -1;
  private ackCheckpointTick: Tick = -1;
  private pendingCmds: InputCommand[] = [];
  private nowMs = 0;
  private accumulator = 0;
  private seq = 0;
  private tickRate: number;
  private everWelcomed = false;
  /** stableId of the host that last welcomed us — "did the authority change?". */
  private welcomedHost: StableId = '';
  /** Peer we have sent a join to and not yet heard a welcome from. */
  private pendingJoinPeer: PeerId | null = null;

  readonly counters = {
    snapshotsReceived: 0, inputsSent: 0, welcomes: 0, checkpoints: 0,
    announces: 0, rejects: 0,
  };

  onStatus: ((s: SessionStats) => void) | null = null;

  constructor(opts: PeerSessionOptions) {
    this.opts = opts;
    this.stableId = opts.stableId;
    this.displayName = opts.displayName;
    this.transport = opts.transport;
    this.codec = opts.codec ?? jsonCodec;
    this.sink = opts.sink ?? {};
    this.inputSource = opts.input ?? (() => null);
    this.tickRate = opts.hostConfig?.tickRate ?? 30;

    this.migration = new MigrationCoordinator(opts.stableId, {
      promote: (cp, epoch) => this.promote(cp, epoch),
      follow: (hostStableId, epoch) => this.follow(hostStableId, epoch),
      yieldHost: (to) => this.yieldHost(to),
      abandon: (reason) => this.sink.onDisconnect?.(reason),
      onStatus: () => this.report(),
    }, opts.policy, 0);

    this.unsubs.push(this.transport.onMessage((from, data) => this.onMessage(from, data)));
    this.unsubs.push(this.transport.onPeerLeave((peer) => this.onPeerLeave(peer)));
  }

  /* --------------------------------------------------- lifecycle --- */

  /** Start a fresh match with this peer as the first host. */
  hostMatch(seed = 1337): PeerHost {
    const options: PeerHostOptions = {
      stableId: this.stableId,
      displayName: this.displayName,
      transport: this.transport,
      codec: this.codec,
      sim: this.opts.sim,
      writer: this.opts.writer,
      config: { ...this.opts.hostConfig, seed },
    };
    this.host = new PeerHost(options);
    this.host.start();
    this.clientId = this.host.localClientId;
    this.epoch = this.host.epoch;
    this.tickRate = this.host.tickRate;
    this.hostPeerId = this.transport.localId;
    this.migration.setHosting(this.epoch, this.nowMs);
    this.report();
    return this.host;
  }

  /** Join a match hosted by `peer`. The transport must already have a link to it. */
  joinMatch(peer: PeerId): void {
    this.hostPeerId = peer;
    this.sendJoin(peer);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.host?.dispose();
    this.host = null;
  }

  get role(): SessionRole {
    if (this.host) return 'host';
    return this.hostPeerId ? 'client' : 'offline';
  }

  /* -------------------------------------------------------- loop --- */

  /**
   * Drive the session. `dtSeconds` advances the host simulation (if we are the
   * host) and the input cadence (if we are a client); `nowMs` is a monotonic
   * clock used for timeouts.
   */
  update(dtSeconds: number, nowMs: number): void {
    this.nowMs = nowMs;
    if (this.host) {
      this.host.advance(dtSeconds);
      this.epoch = this.host.epoch;
      // The host is its own client: feed the same command stream.
      this.accumulator += dtSeconds;
      const step = 1 / this.tickRate;
      while (this.accumulator >= step) {
        this.accumulator -= step;
        this.host.submitLocalInput(this.nextCommand(this.host.tick));
      }
    } else if (this.hostPeerId) {
      this.accumulator += dtSeconds;
      const step = 1 / this.tickRate;
      while (this.accumulator >= step) {
        this.accumulator -= step;
        this.queueCommand();
        // Flush per queued command, not per call. `update` is driven from the
        // engine's fixed step (120 Hz) while the tick rate is 30 Hz, so flushing
        // once per call sent four identical input packets per tick — upstream
        // bandwidth proportional to frame rate rather than tick rate, measured at
        // 59/119/238 packets per second for a 60/120/240 Hz caller and 470 kbit/s
        // up against a 59 kbit/s budget (docs/NETCODE.md §4). See
        // tools/net-sim.mjs §9a.
        this.flushInput();
      }
    }
    this.migration.update(nowMs);
  }

  /* ------------------------------------------------------ inputs --- */

  private nextCommand(tick: Tick): InputCommand {
    const c = this.inputSource(tick) ?? emptyCommand(tick, this.seq);
    c.tick = tick;
    c.seq = this.seq++;
    return c;
  }

  private queueCommand(): void {
    const lead = this.opts.inputLeadTicks ?? 3;
    const tick = Math.max(0, this.lastSnapshotTick + lead);
    this.pendingCmds.push(this.nextCommand(tick));
    const keep = Math.max(1, this.opts.inputRedundancy ?? 3);
    while (this.pendingCmds.length > keep) this.pendingCmds.shift();
  }

  private flushInput(): void {
    if (!this.hostPeerId || !this.clientId || this.pendingCmds.length === 0) return;
    const msg: ClientToHost = {
      t: 'input', clientId: this.clientId,
      cmds: this.pendingCmds.map((c) => ({ ...c })),
      ackTick: this.lastSnapshotTick,
      ackCheckpoint: this.ackCheckpointTick,
    };
    this.send(this.hostPeerId, msg, 'unreliable');
    this.counters.inputsSent++;
  }

  /* ---------------------------------------------------- messages --- */

  private onMessage(from: PeerId, data: Uint8Array): void {
    let msg: HostToClient;
    try { msg = this.codec.decode(data) as HostToClient; } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'welcome': {
        if (msg.v !== PROTOCOL_VERSION) return;
        if (msg.epoch < this.epoch) return;
        this.hostPeerId = from;
        this.clientId = msg.clientId;
        this.epoch = msg.epoch;
        this.tickRate = msg.tickRate;
        this.lastSnapshotTick = msg.tick;
        this.counters.welcomes++;
        this.hostPeerIdFor(msg.hostStableId, from);
        // Silent adopt: we just finished the handshake, so there is nothing to
        // re-handshake. Going through `noteHostAlive` here would fire `follow`
        // and start the join over again.
        this.migration.adoptHost(this.nowMs, msg.epoch, msg.hostStableId);
        this.pendingJoinPeer = null;
        // "Migrated" means the authority actually changed hands. A second
        // welcome from the *same* host is a re-handshake, not a migration:
        // reporting it as one would toast the player and reset their prediction
        // for nothing.
        const migrated = this.everWelcomed && msg.hostStableId !== this.welcomedHost;
        this.everWelcomed = true;
        this.welcomedHost = msg.hostStableId;
        this.sink.onWelcome?.({
          clientId: msg.clientId, epoch: msg.epoch, tick: msg.tick,
          tickRate: msg.tickRate, seed: msg.seed, hostStableId: msg.hostStableId,
          migrated,
        });
        this.applySnapshot(msg.snapshot);
        this.report();
        return;
      }
      case 'reject': {
        this.counters.rejects++;
        this.sink.onDisconnect?.(msg.reason);
        return;
      }
      case 'snapshot': {
        if (from !== this.hostPeerId) return;
        if (msg.s.epoch < this.epoch) return; // stale term
        this.migration.noteHostAlive(this.nowMs, msg.s.epoch, this.migration.hostStableId);
        this.applySnapshot(msg.s);
        return;
      }
      case 'heartbeat': {
        // Only the host we have handshaken with counts as liveness. A beacon from
        // a peer we have not joined yet must not short-circuit the handshake.
        if (from !== this.hostPeerId) return;
        this.migration.noteHostAlive(this.nowMs, msg.epoch, msg.hostStableId);
        return;
      }
      case 'checkpoint': {
        if (this.migration.noteCheckpoint(msg.cp)) {
          this.counters.checkpoints++;
          this.ackCheckpointTick = msg.cp.tick;
          this.roster = msg.cp.roster.map((r) => ({ ...r }));
        }
        return;
      }
      case 'pong': {
        if (from !== this.hostPeerId) return;
        // The host's unsolicited pong (`clientMs === 0`, see PeerHost.maybePing)
        // doubles as an RTT probe; bounce it back exactly once so the host can
        // time the round trip.
        //
        // A pong that echoes a non-zero `clientMs` is the host *answering* that
        // bounce. Replying to it again is what made ping/pong echo for ever:
        // maybePing opened a fresh chain every second, no chain ever terminated,
        // and the message rate grew by ~30/s for every second the match lasted —
        // 157 050 keepalive messages and 62 % of all encoded bytes over a 30 s
        // four-player match on a lossless link. Only packet loss broke a chain,
        // so the better the connection the worse the flood. Measured in
        // tools/net-sim.mjs §9b.
        if (msg.clientMs === 0) {
          this.send(from, { t: 'ping', id: msg.id, clientMs: this.nowMs || 1 }, 'unreliable');
        }
        this.migration.noteHostAlive(this.nowMs, this.epoch, this.migration.hostStableId);
        return;
      }
      case 'hostAnnounce': {
        this.counters.announces++;
        this.hostPeerIdFor(msg.hostStableId, from);
        this.migration.noteAnnounce(this.nowMs, msg.epoch, msg.hostStableId);
        return;
      }
      case 'hostHandoff': {
        this.hostPeerIdFor(msg.successor, from);
        this.migration.noteHandoff(this.nowMs, msg.epoch, msg.successor, msg.cp);
        return;
      }
      default: return;
    }
  }

  private onPeerLeave(peer: PeerId): void {
    // Never wait on a join we sent to a peer that has since gone.
    if (this.pendingJoinPeer === peer) this.pendingJoinPeer = null;
    const entry = this.roster.find((r) => r.peerId === peer);
    if (entry) this.migration.notePeerLost(entry.stableId, this.nowMs);
    if (peer === this.hostPeerId) {
      this.hostPeerId = null;
      // Losing the link to the host is stronger evidence than silence; the
      // coordinator collapses the timeout so the election starts immediately.
      if (entry) this.migration.notePeerLost(entry.stableId, this.nowMs);
      else this.migration.notePeerLost(this.migration.hostStableId, this.nowMs);
    }
    this.report();
  }

  private applySnapshot(s: Snapshot): void {
    this.counters.snapshotsReceived++;
    if (s.tick > this.lastSnapshotTick) this.lastSnapshotTick = s.tick;
    if (s.roster && s.roster.length) {
      this.roster = s.roster.map((r) => ({ ...r }));
      this.migration.noteRoster(this.roster);
    }
    this.sink.onSnapshot?.(s);
    if (this.sink.onEvent) for (const ev of s.events) this.sink.onEvent(ev);
  }

  /* --------------------------------------------------- migration --- */

  /** We were elected. Stand up a host from the mirrored checkpoint. */
  private promote(cp: import('./types').HostCheckpoint, epoch: number): void {
    const options: PeerHostOptions = {
      stableId: this.stableId,
      displayName: this.displayName,
      transport: this.transport,
      codec: this.codec,
      sim: this.opts.sim,
      writer: this.opts.writer,
      config: this.opts.hostConfig,
      resume: { checkpoint: cp, epoch },
    };
    this.host = new PeerHost(options);
    this.host.start();
    this.pendingJoinPeer = null;
    // Re-admit ourselves against our own authority: same stableId, so the same
    // slot, entity, score and team come straight back.
    this.clientId = this.host.core.admit(this.stableId, this.displayName, this.transport.localId, true);
    this.host.localClientId = this.clientId;
    this.epoch = this.host.epoch;
    this.hostPeerId = this.transport.localId;
    this.pendingCmds.length = 0;
    this.migration.setHosting(this.epoch, this.nowMs);
    this.everWelcomed = true;
    this.welcomedHost = this.stableId;
    this.sink.onWelcome?.({
      clientId: this.clientId, epoch: this.epoch, tick: this.host.tick,
      tickRate: this.host.tickRate, seed: this.host.state.seed,
      hostStableId: this.stableId, migrated: true,
    });
    this.report();
  }

  /** Someone else was elected (or named). Re-handshake against them. */
  private follow(hostStableId: StableId, epoch: number): void {
    this.epoch = epoch;
    if (this.host) { this.host.dispose(); this.host = null; }
    const peer = this.peerIdFor(hostStableId);
    if (!peer) { this.sink.onDisconnect?.(`no route to new host ${hostStableId}`); return; }
    this.hostPeerId = peer;
    // A join already in flight to this same peer is enough. Without this, a
    // heartbeat that overtakes our welcome restarts the handshake, and the
    // duplicate welcome resets client prediction mid-join for no reason. Joins
    // go out on the reliable channel, so there is nothing to retry.
    if (this.pendingJoinPeer === peer) { this.report(); return; }
    this.pendingCmds.length = 0;
    this.sendJoin(peer);
    this.report();
  }

  private yieldHost(to: StableId): void {
    if (!this.host) return;
    this.host.dispose();
    this.host = null;
    this.hostPeerId = this.peerIdFor(to);
  }

  private peerIdFor(stableId: StableId): PeerId | null {
    const entry = this.roster.find((r) => r.stableId === stableId);
    if (entry && entry.peerId && entry.peerId !== this.transport.localId) return entry.peerId;
    const cp = this.migration.latestCheckpoint;
    const fromCp = cp?.roster.find((r) => r.stableId === stableId);
    if (fromCp?.peerId && fromCp.peerId !== this.transport.localId) return fromCp.peerId;
    return null;
  }

  /** Learn a stableId → peerId mapping from a message we just received. */
  private hostPeerIdFor(stableId: StableId, peer: PeerId): void {
    const entry = this.roster.find((r) => r.stableId === stableId);
    if (entry) entry.peerId = peer;
    else this.roster.push({
      clientId: 0, stableId, peerId: peer, name: stableId, team: 0,
      connected: true, rttMs: 0, checkpointTick: -1, hostCapable: true,
    });
  }

  private sendJoin(peer: PeerId): void {
    this.pendingJoinPeer = peer;
    this.send(peer, {
      t: 'join', v: PROTOCOL_VERSION, stableId: this.stableId,
      name: this.displayName, epoch: this.epoch,
      resumeClientId: this.clientId || undefined,
    }, 'reliable');
  }

  private send(peer: PeerId, msg: ClientToHost, channel: 'reliable' | 'unreliable'): void {
    this.transport.send(peer, this.codec.encode(msg), channel);
  }

  /* -------------------------------------------------------- info --- */

  stats(): SessionStats {
    return {
      role: this.role,
      epoch: this.epoch,
      hostStableId: this.migration.hostStableId,
      clientId: this.clientId,
      lastSnapshotTick: this.host ? this.host.tick : this.lastSnapshotTick,
      snapshotsReceived: this.counters.snapshotsReceived,
      inputsSent: this.counters.inputsSent,
      migrations: this.migration.migrations,
      bytesSent: this.transport.bytesSent,
      bytesReceived: this.transport.bytesReceived,
      phase: this.migration.phase,
    };
  }

  private report(): void { this.onStatus?.(this.stats()); }
}
