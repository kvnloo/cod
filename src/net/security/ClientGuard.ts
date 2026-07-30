/**
 * Client-side origin policy: who is allowed to tell this peer what the world is.
 *
 * The hole this closes is the sharpest one in the stack. `PeerSession.onMessage`
 * gates `snapshot`, `heartbeat` and `pong` on `from === this.hostPeerId`, but
 * `welcome`, `checkpoint`, `hostAnnounce` and `hostHandoff` are accepted from
 * **any** connected peer. `MigrationCoordinator.noteAnnounce` then treats a newer
 * epoch as proof of a new term, calls `yieldHost` on a running host and `follow`
 * on everyone else. One unauthenticated 90-byte frame takes the whole match:
 *
 *   { t: 'hostAnnounce', epoch: <current + 1>, hostStableId: 'me', tick: 0 }
 *
 * and one more poisons the warm-standby state every survivor would promote from:
 *
 *   { t: 'checkpoint', cp: <any world you like, checksum recomputed> }
 *
 * The checkpoint checksum is `fnv1a` over the body — a corruption guard, not a
 * signature, and the function is exported. So "a client cannot send a position"
 * is only true of `InputCommand`; a checkpoint is *nothing but* positions.
 *
 * Three rules, in the order they are cheapest to evaluate:
 *
 *  1. **Host-originated frames come from the host.** Everything except the two
 *     succession kinds must arrive on the link we handshook over.
 *  2. **A live host is never deposed.** A succession claim is only entertained
 *     after the incumbent has been silent for `hostQuietMs` — the same condition
 *     `MigrationCoordinator` itself uses to start an election. This is what makes
 *     the attack impossible rather than merely inconvenient, because the attacker
 *     cannot make the real host stop talking.
 *  3. **A claimant must be someone the real host published.** Peer identity is
 *     matched on `peerId`, which the transport attests, not on the `stableId` in
 *     the frame, which the attacker chooses.
 *
 * Deliberately NOT done here: verifying that the claimant is the peer
 * `electHost()` would have picked. Every survivor already computes that
 * independently, and duplicating the election inside the guard would make the
 * guard a second implementation of the thing it is protecting.
 */

import {
  AUTHORITY_CLAIM_KINDS, CLIENT_KINDS, DEFAULT_SECURITY_POLICY, HOST_KINDS,
  type DropReason, type GuardStats, type GuardVerdict, type SecurityPolicy,
} from './types';
import type { PeerId, StableId } from '../host/types';

export interface ClientGuardOptions {
  /** This peer's own identity. Used only for diagnostics. */
  selfStableId: StableId;
  policy?: Partial<SecurityPolicy>;
  /** Called on every refusal. Wire it to telemetry; the default is silence. */
  onDrop?: (reason: DropReason, from: PeerId, kind: string, detail: string) => void;
}

export class ClientGuard {
  readonly policy: SecurityPolicy;
  readonly selfStableId: StableId;

  readonly stats: GuardStats = {
    seen: 0, accepted: 0, rewritten: 0, dropped: 0, byReason: {}, byPeer: {},
  };

  /** The peer we completed a handshake with. Only this link speaks for the world. */
  hostPeer: PeerId | null = null;
  /** A peer we have sent a join to and not yet heard a welcome from. */
  pendingHostPeer: PeerId | null = null;
  /** Highest epoch we have accepted. */
  epoch = 0;
  /** Monotonic ms of the last frame attributable to the current host. */
  lastHostMs = 0;
  /** True once this peer is itself the authority; it then answers to nobody. */
  hosting = false;

  /** peerIds the *real* host has published in a roster. The claimant allowlist. */
  private knownPeers = new Set<PeerId>();
  private onDrop: ClientGuardOptions['onDrop'];

  constructor(opts: ClientGuardOptions) {
    this.selfStableId = opts.selfStableId;
    this.policy = { ...DEFAULT_SECURITY_POLICY, ...opts.policy };
    this.onDrop = opts.onDrop;
  }

  /* ------------------------------------------------------ plumbing --- */

  protected count(v: GuardVerdict, from: PeerId, kind: string): GuardVerdict {
    if (v.action === 'accept') { this.stats.accepted++; return v; }
    if (v.action === 'rewrite') this.stats.rewritten++; else this.stats.dropped++;
    this.stats.byReason[v.reason] = (this.stats.byReason[v.reason] ?? 0) + 1;
    this.stats.byPeer[from] = (this.stats.byPeer[from] ?? 0) + 1;
    this.onDrop?.(v.reason, from, kind, v.detail ?? '');
    return v;
  }

  protected drop(reason: DropReason, from: PeerId, kind: string, detail = ''): GuardVerdict {
    return this.count({ action: 'drop', reason, detail }, from, kind);
  }

  /** Transport told us a peer is gone. */
  peerLeft(peer: PeerId): void {
    if (this.pendingHostPeer === peer) this.pendingHostPeer = null;
    if (this.hostPeer === peer) {
      // Losing the link is proof of silence: let the succession window open now
      // rather than waiting out `hostQuietMs` on a socket we know is dead.
      this.lastHostMs = -this.policy.hostQuietMs;
    }
  }

  /**
   * Frames this peer is about to send. Two things are learned here, both from
   * facts rather than from configuration, so installing the guard needs no
   * lifecycle wiring in files this module does not own:
   *
   *  * sending a `join` means we are a client of `to`;
   *  * sending anything host-originated means we ARE the authority — no explicit
   *    `setHosting()` call is required, and no window exists where a freshly
   *    promoted host is still willing to be deposed by a datagram.
   */
  outbound(to: PeerId, msg: Record<string, unknown>): void {
    const kind = msg['t'];
    if (kind === 'join') {
      this.pendingHostPeer = to;
      this.hosting = false;
      return;
    }
    if (typeof kind === 'string' && HOST_KINDS.includes(kind)) {
      this.hosting = true;
      this.hostPeer = null;
      this.pendingHostPeer = null;
      const e = epochOf(msg);
      if (e !== null && e > this.epoch) this.epoch = e;
      // A host publishes the roster; that is where its own claimant allowlist
      // comes from, since it never receives one.
      this.learn(msg);
    }
  }

  /* -------------------------------------------------------- inbound --- */

  /**
   * @param from    transport-attested sender
   * @param msg     already decoded frame
   * @param nowMs   monotonic clock, same one used for `hostQuietMs`
   */
  inbound(from: PeerId, msg: unknown, nowMs: number): GuardVerdict {
    this.stats.seen++;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this.drop('bad-shape', from, '?', 'frame is not an object');
    }
    const m = msg as Record<string, unknown>;
    const kind = typeof m['t'] === 'string' ? (m['t'] as string) : '';
    if (!kind) return this.drop('bad-shape', from, '?', 'missing message kind');

    if (CLIENT_KINDS.includes(kind)) return this.onClientKind(from, kind, m, nowMs);
    if (!HOST_KINDS.includes(kind)) {
      return this.drop('bad-shape', from, kind, `unknown message kind '${kind}'`);
    }
    return this.onHostKind(from, kind, m, nowMs);
  }

  /** A ClientGuard-only peer should not be receiving client frames at all. */
  protected onClientKind(from: PeerId, kind: string, _m: Record<string, unknown>, _now: number): GuardVerdict {
    return this.drop('wrong-origin', from, kind, `client-originated '${kind}' arrived at a non-host peer`);
  }

  private onHostKind(from: PeerId, kind: string, m: Record<string, unknown>, nowMs: number): GuardVerdict {
    const isHost = this.hostPeer !== null && from === this.hostPeer;

    if (isHost) {
      this.lastHostMs = nowMs;
      this.learn(m);
      const e = epochOf(m);
      if (e !== null && e > this.epoch) this.epoch = e;
      return this.count({ action: 'accept' }, from, kind);
    }

    // ---- not the host we handshook with -----------------------------
    if (kind === 'welcome' || kind === 'reject') {
      // The one legitimate case for a stranger: the answer to a join we sent.
      if (from === this.pendingHostPeer) {
        if (kind === 'welcome') {
          this.hostPeer = from;
          this.pendingHostPeer = null;
          this.lastHostMs = nowMs;
          this.learn(m);
          const e = epochOf(m);
          if (e !== null && e > this.epoch) this.epoch = e;
        }
        return this.count({ action: 'accept' }, from, kind);
      }
      return this.drop('not-host', from, kind,
        `unsolicited '${kind}' from ${from}; we joined ${this.pendingHostPeer ?? this.hostPeer ?? 'nobody'}`);
    }

    if (!AUTHORITY_CLAIM_KINDS.includes(kind)) {
      // snapshot / checkpoint / pong / heartbeat from a non-host. `checkpoint` is
      // the dangerous one: it is the only client-reachable path that carries
      // positions and health, and PeerSession feeds it straight to the migration
      // coordinator with no sender check at all.
      return this.drop('not-host', from, kind, `'${kind}' from non-host peer ${from}`);
    }

    // ---- a succession claim ------------------------------------------
    if (this.hosting) {
      // We hold the term. Nobody takes it from us with a datagram; if we have
      // genuinely fallen behind, our own PeerHost stops being able to talk and
      // the other peers elect around us.
      return this.drop('host-alive', from, kind, 'we are the authority; a claim cannot depose us');
    }
    if (this.knownPeers.size > 0 && !this.knownPeers.has(from)) {
      return this.drop('unknown-peer', from, kind,
        `${from} is not in the roster the host published (${this.knownPeers.size} known peers)`);
    }
    const silentMs = nowMs - this.lastHostMs;
    if (this.hostPeer !== null && silentMs < this.policy.hostQuietMs) {
      return this.drop('host-alive', from, kind,
        `host ${this.hostPeer} spoke ${Math.round(silentMs)} ms ago; succession needs ${this.policy.hostQuietMs} ms of silence`);
    }
    const e = epochOf(m);
    if (e === null) return this.drop('bad-shape', from, kind, 'claim carries no usable epoch');
    if (e <= this.epoch) {
      // Stale claims are harmless (the coordinator ignores them) but counting
      // them is how a replay attempt becomes visible.
      return this.count({ action: 'accept' }, from, kind);
    }
    if (e - this.epoch > this.policy.maxEpochJump) {
      return this.drop('epoch-jump', from, kind,
        `epoch ${this.epoch} -> ${e} is a jump of ${e - this.epoch}, max ${this.policy.maxEpochJump}`);
    }

    this.epoch = e;
    this.hostPeer = from;
    this.lastHostMs = nowMs;
    this.learn(m);
    return this.count({ action: 'accept' }, from, kind);
  }

  /**
   * Absorb the roster out of an accepted host frame. This is the allowlist for
   * future succession claims, and it is only ever written from a frame that
   * already passed the origin test — a peer cannot introduce itself.
   */
  protected learn(m: Record<string, unknown>): void {
    const rosters: unknown[] = [];
    const snap = m['snapshot'] as Record<string, unknown> | undefined;
    const s = m['s'] as Record<string, unknown> | undefined;
    const cp = m['cp'] as Record<string, unknown> | undefined;
    if (snap && Array.isArray(snap['roster'])) rosters.push(snap['roster']);
    if (s && Array.isArray(s['roster'])) rosters.push(s['roster']);
    if (cp && Array.isArray(cp['roster'])) rosters.push(cp['roster']);
    for (const r of rosters) {
      for (const entry of r as Array<Record<string, unknown>>) {
        const pid = entry?.['peerId'];
        if (typeof pid === 'string' && pid.length > 0) this.knownPeers.add(pid);
      }
    }
  }

  /** Called by the app when this peer takes or gives up the authority. */
  setHosting(on: boolean, epoch: number): void {
    this.hosting = on;
    if (epoch > this.epoch) this.epoch = epoch;
    if (on) { this.hostPeer = null; this.pendingHostPeer = null; }
  }

  /** Peers the real host has published. Exposed for tests and diagnostics. */
  get rosterPeers(): readonly PeerId[] { return [...this.knownPeers]; }
}

function epochOf(m: Record<string, unknown>): number | null {
  const raw = m['epoch'] ?? (m['s'] as Record<string, unknown> | undefined)?.['epoch'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
