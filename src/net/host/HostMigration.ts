/**
 * Host migration — keeping the match alive when the machine holding the truth
 * closes its laptop.
 *
 * The part everyone gets wrong is trying to *fetch* state from the host at the
 * moment it dies. You cannot: it is already gone. So authoritative state is
 * mirrored continuously (`PeerHost.maybeSendCheckpoint`) to every host-capable
 * peer. When the host stops talking, at least one survivor already holds a
 * checkpoint that is at most `checkpointIntervalTicks` old, and migration is a
 * local promotion rather than a rescue operation.
 *
 * The rest is agreement:
 *
 *  * **Election is a pure function** of the last roster the host published. Every
 *    survivor computes the same winner from the same input with no negotiation
 *    round — lowest `stableId` among candidates with acceptable connectivity, and
 *    connectivity is measured with the *host's* numbers so everyone agrees.
 *  * **Terms are numbered.** Each host term has an epoch; a new host takes
 *    `epoch + 1`. Clients ignore anything from an older epoch, which is what
 *    stops a briefly-suspended old host from re-asserting itself.
 *  * **Claims are verified, not assumed.** If the winner does not announce within
 *    `claimTimeoutMs` (it was dead too, or partitioned away), it is excluded and
 *    the election runs again. That loop is why a double failure does not end the
 *    match.
 *  * **Ties are broken downward.** If two peers promote simultaneously in the
 *    same epoch, the one with the higher `stableId` yields. Split-brain resolves
 *    in one message rather than forking the match.
 */

import { verifyCheckpoint } from './Checkpoint';
import type { HostCheckpoint, RosterEntry, StableId, Tick } from './types';

export interface MigrationPolicy {
  /** Silence from the host for this long starts an election. */
  hostTimeoutMs: number;
  /** An elected candidate must announce within this or it is excluded. */
  claimTimeoutMs: number;
  /** Candidates whose host-measured RTT exceeds this are not preferred. */
  maxRttMs: number;
  /** Candidates whose mirrored checkpoint is this far behind are not preferred. */
  maxCheckpointLagTicks: number;
  /** Below this many surviving peers (including self) the match ends. */
  minPeersToContinue: number;
}

export const DEFAULT_MIGRATION_POLICY: MigrationPolicy = {
  hostTimeoutMs: 1500,
  claimTimeoutMs: 1200,
  maxRttMs: 220,
  maxCheckpointLagTicks: 180,
  minPeersToContinue: 1,
};

export interface ElectionInput {
  roster: readonly RosterEntry[];
  /** The host that just died — never a candidate for its own succession. */
  outgoingHost: StableId;
  /** Candidates already tried and found unreachable this round. */
  excluded: ReadonlySet<StableId>;
  /** Newest checkpoint tick anyone is known to hold; freshness is judged against it. */
  referenceTick: Tick;
  policy: MigrationPolicy;
}

export interface ElectionResult {
  winner: StableId | null;
  /** Which relaxation pass produced the winner: 0 = all criteria met. */
  tier: number;
  considered: number;
  reason: string;
}

/**
 * Deterministic election. Same inputs → same winner on every peer, no messages.
 *
 * Three passes, strictest first: fresh state *and* good link, then fresh state
 * with any link, then any peer holding any state at all. Degrading rather than
 * failing is deliberate — a laggy host is a bad match, but no host is no match.
 */
export function electHost(input: ElectionInput): ElectionResult {
  const { roster, outgoingHost, excluded, referenceTick, policy } = input;
  const base = roster.filter((r) =>
    r.hostCapable
    && r.connected
    && r.stableId !== outgoingHost
    && !excluded.has(r.stableId));

  const tiers: Array<(r: RosterEntry) => boolean> = [
    (r) => r.checkpointTick >= 0
      && referenceTick - r.checkpointTick <= policy.maxCheckpointLagTicks
      && r.rttMs <= policy.maxRttMs,
    (r) => r.checkpointTick >= 0
      && referenceTick - r.checkpointTick <= policy.maxCheckpointLagTicks,
    (r) => r.checkpointTick >= 0,
  ];

  for (let tier = 0; tier < tiers.length; tier++) {
    const pool = base.filter(tiers[tier]);
    if (pool.length === 0) continue;
    // Lowest stable id wins. Lexicographic, not numeric, so ids can be opaque
    // strings; the only requirement is that every peer sorts them the same way.
    let best = pool[0];
    for (const r of pool) if (r.stableId < best.stableId) best = r;
    return {
      winner: best.stableId, tier, considered: base.length,
      reason: tier === 0 ? 'fresh state, good link'
        : tier === 1 ? 'fresh state, degraded link'
          : 'stale state accepted',
    };
  }
  return { winner: null, tier: -1, considered: base.length, reason: base.length ? 'no candidate holds state' : 'no candidates' };
}

export type MigrationPhase =
  /** Normal operation: a host is talking to us. */
  | 'following'
  /** Host silent; we picked a winner and are waiting for it to announce. */
  | 'electing'
  /** We are the winner and have handed a checkpoint to the app to resume from. */
  | 'promoting'
  /** We are the host. */
  | 'hosting'
  /** No viable successor. The match is over. */
  | 'orphaned';

export interface MigrationStatus {
  phase: MigrationPhase;
  hostStableId: StableId;
  epoch: number;
  /** Wall-clock ms since the last message attributable to the current host. */
  hostSilenceMs: number;
  checkpointTick: Tick;
  candidate: StableId | null;
  migrations: number;
  lastReason: string;
}

export interface MigrationHooks {
  /** We won. Build a host from this checkpoint at this epoch and start it. */
  promote(checkpoint: HostCheckpoint, epoch: number): void;
  /** Someone else won (or a graceful handoff named them). Re-handshake with them. */
  follow(hostStableId: StableId, epoch: number): void;
  /** We were hosting and lost a tie or saw a newer epoch. Shut our host down. */
  yieldHost?(toStableId: StableId, epoch: number): void;
  /** No successor is possible. */
  abandon?(reason: string): void;
  onStatus?(status: MigrationStatus): void;
}

/**
 * Runs on every peer, host or client. The peer feeds it what it hears; it decides
 * who hosts next and tells the app through {@link MigrationHooks}.
 *
 * It never touches a transport or a simulation, which is why it is testable
 * head-lessly and why the same instance works for a browser peer, a spectator or
 * a headless bot.
 */
export class MigrationCoordinator {
  readonly policy: MigrationPolicy;
  phase: MigrationPhase = 'following';
  hostStableId: StableId = '';
  epoch = 0;
  migrations = 0;
  lastReason = 'init';

  private lastHostMs: number;
  private electionStartedMs = 0;
  private candidate: StableId | null = null;
  private excluded = new Set<StableId>();
  private roster: RosterEntry[] = [];
  private checkpoint: HostCheckpoint | null = null;
  private rejectedCheckpoints = 0;

  constructor(
    readonly selfStableId: StableId,
    private hooks: MigrationHooks,
    policy: Partial<MigrationPolicy> = {},
    nowMs = 0,
  ) {
    this.policy = { ...DEFAULT_MIGRATION_POLICY, ...policy };
    this.lastHostMs = nowMs;
  }

  /* ------------------------------------------------------ inputs --- */

  /** We are the host from now on (fresh match or successful promotion). */
  setHosting(epoch: number, nowMs: number): void {
    this.phase = 'hosting';
    this.hostStableId = this.selfStableId;
    this.epoch = epoch;
    this.lastHostMs = nowMs;
    this.candidate = null;
    this.excluded.clear();
    this.emit();
  }

  /**
   * A handshake with `hostStableId` has completed. Adopts the term *silently* —
   * we are already talking to them, so there is nothing to re-handshake.
   */
  adoptHost(nowMs: number, epoch: number, hostStableId: StableId): void {
    if (epoch < this.epoch) return;
    this.hostStableId = hostStableId;
    this.epoch = epoch;
    this.lastHostMs = nowMs;
    this.candidate = null;
    this.excluded.clear();
    this.phase = 'following';
    this.lastReason = `handshake with ${hostStableId} @epoch ${epoch}`;
    this.emit();
  }

  /** Any traffic from the current host proves it is alive. */
  noteHostAlive(nowMs: number, epoch: number, hostStableId: StableId): void {
    if (epoch < this.epoch) return; // stale term — ignore entirely
    if (this.hostStableId === '') { this.adoptHost(nowMs, epoch, hostStableId); return; }
    if (epoch > this.epoch || hostStableId !== this.hostStableId) {
      this.acceptHost(hostStableId, epoch, nowMs, 'observed newer term');
      return;
    }
    this.lastHostMs = nowMs;
  }

  /** Latest mirrored authoritative state. Rejected outright if the checksum fails. */
  noteCheckpoint(cp: HostCheckpoint): boolean {
    if (!verifyCheckpoint(cp)) { this.rejectedCheckpoints++; return false; }
    if (this.checkpoint && cp.tick < this.checkpoint.tick && cp.epoch <= this.checkpoint.epoch) return false;
    this.checkpoint = cp;
    if (cp.roster.length) this.roster = cp.roster.map((r) => ({ ...r }));
    return true;
  }

  noteRoster(roster: readonly RosterEntry[]): void {
    if (!roster || roster.length === 0) return;
    this.roster = roster.map((r) => ({ ...r }));
  }

  /** A peer announcing a host term. Also the split-brain resolver. */
  noteAnnounce(nowMs: number, epoch: number, hostStableId: StableId): void {
    if (epoch < this.epoch) return;
    if (this.phase === 'hosting' || this.phase === 'promoting') {
      if (hostStableId === this.selfStableId) return;
      const loses = epoch > this.epoch
        || (epoch === this.epoch && hostStableId < this.selfStableId);
      if (!loses) return;
      this.lastReason = `yielded to ${hostStableId} @epoch ${epoch}`;
      this.hooks.yieldHost?.(hostStableId, epoch);
      this.acceptHost(hostStableId, epoch, nowMs, this.lastReason);
      return;
    }
    this.acceptHost(hostStableId, epoch, nowMs, `announce from ${hostStableId}`);
  }

  /** The outgoing host named a successor and flushed final state. */
  noteHandoff(nowMs: number, epoch: number, successor: StableId, cp: HostCheckpoint): void {
    this.noteCheckpoint(cp);
    if (successor === this.selfStableId) {
      this.promoteSelf(epoch, nowMs, 'graceful handoff');
    } else {
      this.candidate = successor;
      this.phase = 'electing';
      this.electionStartedMs = nowMs;
      this.lastReason = `awaiting graceful successor ${successor}`;
      this.emit();
    }
  }

  /** Transport-level: this peer's connection is gone. */
  notePeerLost(stableId: StableId, nowMs: number): void {
    for (const r of this.roster) if (r.stableId === stableId) r.connected = false;
    if (stableId === this.hostStableId && this.phase === 'following') {
      // Do not wait out the full silence timeout when the link itself died.
      this.lastHostMs = nowMs - this.policy.hostTimeoutMs;
    }
    if (stableId === this.candidate && this.phase === 'electing') {
      this.electionStartedMs = nowMs - this.policy.claimTimeoutMs;
    }
  }

  /* ------------------------------------------------------- drive --- */

  /** Call every frame with a monotonic clock in ms. */
  update(nowMs: number): void {
    if (this.phase === 'hosting' || this.phase === 'orphaned') return;

    if (this.phase === 'following') {
      if (nowMs - this.lastHostMs < this.policy.hostTimeoutMs) return;
      this.beginElection(nowMs, `host ${this.hostStableId || '?'} silent for ${Math.round(nowMs - this.lastHostMs)}ms`);
      return;
    }

    if (this.phase === 'electing') {
      if (nowMs - this.electionStartedMs < this.policy.claimTimeoutMs) return;
      if (this.candidate) this.excluded.add(this.candidate);
      this.beginElection(nowMs, `candidate ${this.candidate ?? '?'} failed to claim`);
      return;
    }

    if (this.phase === 'promoting') {
      // The app is expected to call setHosting() once its host is running. If it
      // has not after the claim window, something upstream is broken — say so
      // loudly rather than sitting in a half-migrated state.
      if (nowMs - this.electionStartedMs > this.policy.claimTimeoutMs * 2) {
        this.phase = 'orphaned';
        this.lastReason = 'promotion never completed';
        this.hooks.abandon?.(this.lastReason);
        this.emit();
      }
    }
  }

  private beginElection(nowMs: number, why: string): void {
    const survivors = this.roster.filter((r) => r.connected && r.stableId !== this.hostStableId);
    if (survivors.length + 0 < this.policy.minPeersToContinue) {
      this.phase = 'orphaned';
      this.lastReason = `${why}; no survivors`;
      this.hooks.abandon?.(this.lastReason);
      this.emit();
      return;
    }

    const result = electHost({
      roster: this.roster,
      outgoingHost: this.hostStableId,
      excluded: this.excluded,
      referenceTick: this.referenceTick(),
      policy: this.policy,
    });

    if (!result.winner) {
      this.phase = 'orphaned';
      this.lastReason = `${why}; ${result.reason}`;
      this.hooks.abandon?.(this.lastReason);
      this.emit();
      return;
    }

    this.candidate = result.winner;
    this.lastReason = `${why}; elected ${result.winner} (${result.reason})`;

    if (result.winner === this.selfStableId) {
      this.promoteSelf(this.epoch + 1, nowMs, this.lastReason);
    } else {
      this.phase = 'electing';
      this.electionStartedMs = nowMs;
      this.emit();
    }
  }

  private promoteSelf(epoch: number, nowMs: number, why: string): void {
    if (!this.checkpoint) {
      this.phase = 'orphaned';
      this.lastReason = `${why}; but we hold no checkpoint`;
      this.hooks.abandon?.(this.lastReason);
      this.emit();
      return;
    }
    this.phase = 'promoting';
    this.electionStartedMs = nowMs;
    this.migrations++;
    this.lastReason = why;
    this.emit();
    this.hooks.promote(this.checkpoint, Math.max(epoch, this.checkpoint.epoch + 1));
  }

  private acceptHost(hostStableId: StableId, epoch: number, nowMs: number, why: string): void {
    const changed = hostStableId !== this.hostStableId || epoch !== this.epoch;
    this.hostStableId = hostStableId;
    this.epoch = epoch;
    this.lastHostMs = nowMs;
    this.candidate = null;
    this.excluded.clear();
    const wasMigrating = this.phase !== 'following';
    this.phase = 'following';
    if (changed) {
      this.lastReason = why;
      if (wasMigrating) this.migrations++;
      this.hooks.follow(hostStableId, epoch);
    }
    this.emit();
  }

  /** Freshest checkpoint tick anyone is known to hold. */
  private referenceTick(): Tick {
    let t = this.checkpoint?.tick ?? -1;
    for (const r of this.roster) if (r.checkpointTick > t) t = r.checkpointTick;
    return t;
  }

  get latestCheckpoint(): HostCheckpoint | null { return this.checkpoint; }
  get rejectedCheckpointCount(): number { return this.rejectedCheckpoints; }

  status(nowMs = this.lastHostMs): MigrationStatus {
    return {
      phase: this.phase,
      hostStableId: this.hostStableId,
      epoch: this.epoch,
      hostSilenceMs: Math.max(0, nowMs - this.lastHostMs),
      checkpointTick: this.checkpoint?.tick ?? -1,
      candidate: this.candidate,
      migrations: this.migrations,
      lastReason: this.lastReason,
    };
  }

  private emit(): void { this.hooks.onStatus?.(this.status()); }
}
