/**
 * `NetSystem` — the engine-facing face of the whole net stack.
 *
 * Three jobs, and nothing else:
 *
 *  1. **Be a `System`.** Register it in `src/main.ts` next to the others and it
 *     schedules the net stack in the correct order relative to physics, player
 *     and rendering.
 *  2. **Order the stack.** Per fixed step: receive → reconcile the newest
 *     authoritative snapshot → sample local input → predict → step the host (if
 *     we hold authority) → send. Per frame: interpolate remote entities. Getting
 *     that order wrong is how netcode acquires a permanent one-tick of input lag
 *     that nobody can find later.
 *  3. **Report to the UI through the bus.** `net:status`, `net:quality`,
 *     `net:migration`, `net:peer:*`, `net:event`. HUD and FX are pure listeners.
 *
 * **Offline is the default and offline is free.** With no transport attached the
 * system holds no state, allocates nothing per frame and returns from
 * `fixedUpdate` on the first line. The single-player game behaves exactly as it
 * did before this file existed — that is a hard requirement, not an aspiration.
 *
 * Everything heavy lives in `src/net/host/`, which is deliberately Three.js-free
 * so the identical simulation can run in a headless Node host later. This file is
 * the only place the two worlds touch.
 */

import { ORDER, type EngineContext, type System } from '../core/Engine';
import { bus } from '../core/EventBus';
import { input } from '../core/Input';

import './host/NetEvents';
import { PeerSession, type SessionStats, type SnapshotSink } from './host/PeerSession';
import { LoopbackNetwork, PERFECT_LINK, type LinkConditions } from './host/testing/LoopbackTransport';
import type { AuthorityConfig } from './host/Authority';
import type { PeerHost } from './host/PeerHost';
import type { MigrationPolicy, MigrationPhase } from './host/HostMigration';
import type { Codec, SimStepper, SnapshotWriter, Transport } from './host/ports';
import {
  BTN, emptyCommand,
  type InputCommand, type NetEvent, type PeerId, type Snapshot, type StableId, type Tick,
} from './host/types';

/**
 * The client-side prediction / reconciliation module (owned by the client layer).
 * `NetSystem` guarantees the call order; it does not care how either is done.
 */
export interface ClientPredictor {
  /** Newest authoritative state has arrived — rewind and replay unacknowledged input. */
  reconcile?(snapshot: Snapshot): void;
  /** A command has just been produced locally; advance the predicted state by it. */
  predict?(cmd: InputCommand, dt: number): void;
  /** Match (re)joined, including after a host migration: rebuild from scratch. */
  reset?(info: { clientId: number; tick: Tick; tickRate: number; seed: number; migrated: boolean }): void;
}

/** Presentation-rate smoothing of entities the local peer does not control. */
export interface RemoteInterpolator {
  /** `renderTimeMs` is host time minus the interpolation delay. */
  interpolate(dt: number, renderTimeMs: number): void;
}

export interface NetAttachOptions {
  transport: Transport;
  /** Persistent identity. Also the host-election tiebreak key, so it must be unique and stable. */
  stableId: StableId;
  displayName: string;
  codec?: Codec;
  sim?: SimStepper;
  writer?: SnapshotWriter;
  hostConfig?: Partial<AuthorityConfig>;
  policy?: Partial<MigrationPolicy>;
  /** Render entities this far behind the authoritative clock. ~2 snapshot intervals. */
  interpolationDelayMs?: number;
}

export interface NetStatus {
  role: SessionStats['role'];
  phase: MigrationPhase;
  hostName: string;
  epoch: number;
  players: number;
  tick: number;
  authoritative: boolean;
}

const OFFLINE_STATUS: NetStatus = {
  role: 'offline', phase: 'following', hostName: '', epoch: 0,
  players: 0, tick: 0, authoritative: false,
};

export class NetSystem implements System {
  readonly name = 'net';
  /** Immediately after input, before physics/player/weapons consume the frame. */
  readonly order = ORDER.INPUT + 10;
  enabled = true;

  session: PeerSession | null = null;
  predictor: ClientPredictor | null = null;
  interpolator: RemoteInterpolator | null = null;

  /** Override to feed the authority something other than the default keyboard mapping. */
  inputSource: ((tick: Tick) => InputCommand | null) | null = null;
  /** Additional consumer of authoritative snapshots (the replication/view layer). */
  snapshotSink: SnapshotSink | null = null;

  private ctx: EngineContext | null = null;
  private opts: NetAttachOptions | null = null;
  private nowMs = 0;
  private status: NetStatus = { ...OFFLINE_STATUS };
  private lastStatusKey = '';
  private qualityAccum = 0;
  private snapshotsAtWindowStart = 0;
  private bytesAtWindowStart = 0;
  private interpolationDelayMs = 100;
  private latestSnapshot: Snapshot | null = null;
  /** The `PeerHost` instance whose events we are currently relaying, if any. */
  private boundHost: PeerHost | null = null;
  private unbindHost: (() => void) | null = null;
  /** Client slots already announced on the bus, so a rebind does not re-announce. */
  private announcedPeers = new Set<number>();

  /* ------------------------------------------------------ System --- */

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    // Offline: nothing is created, nothing is scheduled, nothing is emitted.
  }

  fixedUpdate(dt: number, _ctx: EngineContext): void {
    const session = this.session;
    if (!session) return; // offline fast path — single player is untouched

    this.nowMs += dt * 1000;

    // 1. receive + reconcile happen inside the session's message pump, which is
    //    driven by the transport; `update` then advances the host (if we hold
    //    authority) and emits this peer's input for the tick.
    session.update(dt, this.nowMs);

    // 2. interpolation/prediction hand-off: whatever arrived during the pump is
    //    now the newest authoritative state.
    if (this.latestSnapshot && this.predictor?.reconcile) {
      this.predictor.reconcile(this.latestSnapshot);
      this.latestSnapshot = null;
    }

    this.publishStatus();
  }

  update(dt: number, _ctx: EngineContext): void {
    if (!this.session) return;
    if (this.interpolator) {
      const tickRate = this.session.host?.tickRate ?? 30;
      const hostMs = (this.session.host?.tick ?? this.session.stats().lastSnapshotTick) * (1000 / tickRate);
      this.interpolator.interpolate(dt, hostMs - this.interpolationDelayMs);
    }
    this.qualityAccum += dt;
    if (this.qualityAccum >= 0.5) { this.publishQuality(this.qualityAccum); this.qualityAccum = 0; }
  }

  dispose(): void { this.disconnect('disposed'); }

  /* ---------------------------------------------------- lifecycle -- */

  /** Become the first host of a new match. */
  hostMatch(options: NetAttachOptions, seed = 1337): PeerSession {
    const session = this.attach(options);
    session.hostMatch(seed);
    this.publishStatus(true);
    return session;
  }

  /** Join a match already hosted by `hostPeer`. The transport must have a link to it. */
  joinMatch(options: NetAttachOptions, hostPeer: PeerId): PeerSession {
    const session = this.attach(options);
    session.joinMatch(hostPeer);
    this.publishStatus(true);
    return session;
  }

  /** Tear the net stack down and return to offline single-player behaviour. */
  disconnect(reason = 'disconnected'): void {
    if (!this.session) return;
    this.unbindHost?.();
    this.unbindHost = null;
    this.boundHost = null;
    this.announcedPeers.clear();
    this.session.dispose();
    this.session = null;
    this.opts = null;
    this.latestSnapshot = null;
    this.status = { ...OFFLINE_STATUS };
    this.lastStatusKey = '';
    bus.emit('net:status', { ...this.status });
    bus.emit('notify', { text: `Disconnected: ${reason}`, kind: 'warn' });
  }

  get online(): boolean { return this.session !== null; }
  /** True when this machine is the authority. Gameplay systems should branch on this, not on "am I the host peer". */
  get authoritative(): boolean { return this.session?.host != null; }
  get netStatus(): NetStatus { return { ...this.status }; }

  /**
   * Convenience for local testing and for the capture harness: two or more
   * sessions in one process over an in-memory link, with real latency and loss.
   */
  static loopback(seed = 0xc0ffee, conditions: LinkConditions = PERFECT_LINK): LoopbackNetwork {
    return new LoopbackNetwork(seed, conditions);
  }

  /* ------------------------------------------------------ private -- */

  private attach(options: NetAttachOptions): PeerSession {
    this.disconnect('reconnecting');
    this.opts = options;
    this.interpolationDelayMs = options.interpolationDelayMs ?? 100;

    const sink: SnapshotSink = {
      onWelcome: (info) => {
        this.predictor?.reset?.({
          clientId: info.clientId, tick: info.tick, tickRate: info.tickRate,
          seed: info.seed, migrated: info.migrated,
        });
        this.snapshotSink?.onWelcome?.(info);
        if (info.migrated) {
          bus.emit('notify', { text: `Host migrated to ${info.hostStableId}`, kind: 'warn' });
        }
      },
      onSnapshot: (s) => {
        this.latestSnapshot = s;
        this.snapshotSink?.onSnapshot?.(s);
      },
      onEvent: (ev) => {
        this.relayEvent(ev);
        this.snapshotSink?.onEvent?.(ev);
      },
      onDisconnect: (reason) => {
        this.snapshotSink?.onDisconnect?.(reason);
        bus.emit('notify', { text: `Connection lost: ${reason}`, kind: 'warn' });
      },
    };

    const session = new PeerSession({
      stableId: options.stableId,
      displayName: options.displayName,
      transport: options.transport,
      codec: options.codec,
      sim: options.sim,
      writer: options.writer,
      hostConfig: options.hostConfig,
      policy: options.policy,
      sink,
      input: (tick) => this.sampleInput(tick),
    });

    // On the host, authoritative events never travel over a transport — relay
    // them onto the bus directly so FX/audio/HUD behave identically either way.
    //
    // `report()` fires on every roster/migration change, so this must be
    // idempotent: binding a second observer to the same host would double every
    // hit, kill and spawn the HUD and FX layers see. Promotion after a migration
    // creates a *new* PeerHost, which is the one case where we do rebind.
    const bindHostObserver = (): void => {
      const host = session.host;
      if (!host || host === this.boundHost) return;
      this.unbindHost?.();
      this.boundHost = host;
      this.unbindHost = host.observe({
        onEvent: (ev) => this.relayEvent(ev),
        onPlayerJoin: (clientId, _stableId, name) => {
          this.announceJoin(clientId, name, host.core.slot(clientId)?.team ?? 0);
        },
        onPlayerLeave: (clientId, reason) => {
          this.announcedPeers.delete(clientId);
          const name = host.core.slot(clientId)?.name ?? String(clientId);
          bus.emit('net:peer:leave', { clientId, name, reason });
        },
      });
      // Slots that already exist have no join event to observe: our own slot is
      // admitted before this binding runs, and a host promoted by migration
      // inherits the whole roster from a checkpoint. Announce them now or the UI
      // never learns those players exist.
      for (const [clientId, slot] of host.core.state.players) {
        this.announceJoin(clientId, slot.name, slot.team);
      }
    };
    session.onStatus = (s) => {
      if (s.role === 'host') bindHostObserver();
      this.publishStatus();
    };

    this.session = session;
    bindHostObserver();
    return session;
  }

  private announceJoin(clientId: number, name: string, team: number): void {
    if (this.announcedPeers.has(clientId)) return;
    this.announcedPeers.add(clientId);
    bus.emit('net:peer:join', { clientId, name, team });
  }

  private relayEvent(ev: NetEvent): void {
    bus.emit('net:event', {
      kind: ev.kind, a: ev.a, b: ev.b, x: ev.x, y: ev.y, z: ev.z, n: ev.n, s: ev.s,
    });
  }

  /**
   * Default local input: core actions plus the camera's current yaw/pitch.
   * Replaceable via `inputSource` so the player module can send its own richer
   * command without this file having to know anything about it.
   */
  private sampleInput(tick: Tick): InputCommand {
    if (this.inputSource) {
      const custom = this.inputSource(tick);
      if (custom) return custom;
    }
    const cmd = emptyCommand(tick);
    const a = input.state.actions;
    let x = input.state.moveX;
    let z = input.state.moveY;
    if (a.has('forward')) z += 1;
    if (a.has('back')) z -= 1;
    if (a.has('right')) x += 1;
    if (a.has('left')) x -= 1;
    cmd.moveX = Math.max(-1, Math.min(1, x));
    cmd.moveZ = Math.max(-1, Math.min(1, z));
    let buttons = 0;
    if (a.has('fire') || input.state.triggerFire > 0.5) buttons |= BTN.FIRE;
    if (a.has('ads') || input.state.triggerAds > 0.5) buttons |= BTN.ADS;
    if (a.has('jump')) buttons |= BTN.JUMP;
    if (a.has('crouch')) buttons |= BTN.CROUCH;
    if (a.has('sprint')) buttons |= BTN.SPRINT;
    if (a.has('reload')) buttons |= BTN.RELOAD;
    if (a.has('use')) buttons |= BTN.USE;
    if (a.has('melee')) buttons |= BTN.MELEE;
    cmd.buttons = buttons;
    const cam = this.ctx?.camera;
    if (cam) { cmd.yaw = cam.rotation.y; cmd.pitch = cam.rotation.x; }
    this.predictor?.predict?.(cmd, 1 / (this.session?.host?.tickRate ?? 30));
    return cmd;
  }

  private publishStatus(force = false): void {
    const session = this.session;
    if (!session) return;
    const s = session.stats();
    const players = session.host
      ? session.host.core.state.players.size
      : session.migration.latestCheckpoint?.players.length ?? 0;
    const next: NetStatus = {
      role: s.role,
      phase: s.phase,
      hostName: s.hostStableId,
      epoch: s.epoch,
      players,
      tick: s.lastSnapshotTick,
      authoritative: session.host != null,
    };
    // Tick changes every frame; keying on it would spam the bus.
    const key = `${next.role}|${next.phase}|${next.hostName}|${next.epoch}|${next.players}|${next.authoritative}`;
    this.status = next;
    if (!force && key === this.lastStatusKey) return;
    const migrated = this.lastStatusKey !== '' && key !== this.lastStatusKey;
    this.lastStatusKey = key;
    bus.emit('net:status', { ...next });
    if (migrated && (next.phase === 'electing' || next.phase === 'promoting' || next.phase === 'orphaned')) {
      const st = session.migration.status(this.nowMs);
      bus.emit('net:migration', {
        phase: st.phase, hostName: st.hostStableId, epoch: st.epoch,
        reason: st.lastReason, count: st.migrations,
      });
    }
  }

  private publishQuality(windowSeconds: number): void {
    const session = this.session;
    if (!session) return;
    const s = session.stats();
    const snaps = s.snapshotsReceived - this.snapshotsAtWindowStart;
    const bytes = s.bytesSent + s.bytesReceived - this.bytesAtWindowStart;
    this.snapshotsAtWindowStart = s.snapshotsReceived;
    this.bytesAtWindowStart = s.bytesSent + s.bytesReceived;

    const tickRate = session.host?.tickRate ?? 30;
    const expected = tickRate * windowSeconds;
    const self = session.host
      ? session.host.roster().find((r) => r.stableId === session.stableId)
      : session.migration.latestCheckpoint?.roster.find((r) => r.stableId === session.stableId);
    const inputBuffer = session.host
      ? session.host.core.inputHealth(session.clientId).queued
      : 0;

    bus.emit('net:quality', {
      rttMs: self?.rttMs ?? 0,
      jitterMs: 0,
      lossPct: session.host ? 0 : Math.max(0, 1 - snaps / Math.max(1, expected)) * 100,
      snapshotHz: snaps / windowSeconds,
      bytesPerSec: bytes / windowSeconds,
      inputBuffer,
    });
  }
}

export type { PeerSession, SessionStats, SnapshotSink } from './host/PeerSession';
export type { Transport, Codec } from './host/ports';
export { LoopbackNetwork } from './host/testing/LoopbackTransport';
