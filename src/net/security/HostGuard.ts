/**
 * Host-side admission control: identity binding and input rate limiting.
 *
 * Two holes, both reachable by any peer that can open a DataChannel.
 *
 * **1. Identity is a claim, not a credential.** `AuthorityCore.admit()` keys a
 * slot on `stableId`, and `PeerHost.onJoin()` re-points `peerToClient` /
 * `clientToPeer` at whichever peer claimed it last. Every player's `stableId`
 * *and* `peerId` is broadcast to every client inside `Snapshot.roster` and every
 * `checkpoint`. So the credential for taking over another player's slot — their
 * entity, score, kills, and their live input stream — is public information that
 * the host itself hands out, and the victim is not even told: their snapshots
 * simply stop. `IdentityGuard` binds a `stableId` to the first transport peer
 * that claims it and refuses a rebind while that peer is still connected.
 *
 * Trust-on-first-use, deliberately, because there is no shared secret in a peer
 * topology and inventing one would need a protocol change in a file this agent
 * does not own. TOFU is exactly the SSH known-hosts trade-off: it does not stop
 * an attacker who is *first*, and it completely stops one who is *second* — and
 * in a lobby the honest player is always first, because they are the reason the
 * slot exists. A reconnect after a genuine drop still works: the binding is
 * released when the transport reports the peer gone.
 *
 * **2. Nothing bounds how much input one frame may contain.** `submitInput()`
 * accepts an unbounded array, sorts it, then trims to `maxInputBuffer` with
 * repeated `Array.shift()` — O(n log n) plus O(n^2) memmove, inside the host's
 * tick budget, from one datagram. It also never checks that a command's `tick`
 * is anywhere near host time, so a single `tick: 1e12` poisons the duplicate
 * watermark and mutes that client forever. And `sanitise()` clamps `moveX` and
 * `moveZ` independently, so `|move|` can be 1.414 — `ArenaSim` happens to
 * normalise, but that is the *stepper's* choice, and `MovementStepper` plugs a
 * different one in.
 *
 * Both are fixed here, on the way in, before the authority allocates anything.
 */

import { ClientGuard, type ClientGuardOptions } from './ClientGuard';
import { CLIENT_KINDS, type GuardVerdict, type PeerRecord } from './types';
import type { ClientId, InputCommand, PeerId, StableId } from '../host/types';

export interface HostGuardOptions extends ClientGuardOptions {
  /** Ticks the authority is currently at. Keep it fresh via {@link noteTick}. */
  hostTick?: number;
}

export class HostGuard extends ClientGuard {
  /** Authority tick, used only for the command-tick sanity bound. -1 = unknown. */
  hostTick = -1;

  private peers = new Map<PeerId, PeerRecord>();
  /** stableId -> the peer that owns it right now. */
  private identityOwner = new Map<StableId, PeerId>();

  constructor(opts: HostGuardOptions) {
    super(opts);
    if (typeof opts.hostTick === 'number') this.hostTick = opts.hostTick;
  }

  /* ------------------------------------------------------ bookkeeping --- */

  noteTick(tick: number): void { this.hostTick = tick; }

  /** Frames the host is about to send. The welcome is where a slot is learned. */
  override outbound(to: PeerId, msg: Record<string, unknown>): void {
    super.outbound(to, msg);
    const kind = msg['t'];
    if (kind === 'welcome') {
      const rec = this.record(to);
      const cid = msg['clientId'];
      if (typeof cid === 'number') rec.clientId = cid;
      const tick = msg['tick'];
      if (typeof tick === 'number' && Number.isFinite(tick)) this.hostTick = tick;
    } else if (kind === 'snapshot') {
      const s = msg['s'] as Record<string, unknown> | undefined;
      const tick = s?.['tick'];
      if (typeof tick === 'number' && Number.isFinite(tick)) this.hostTick = tick;
    }
  }

  override peerLeft(peer: PeerId): void {
    super.peerLeft(peer);
    const rec = this.peers.get(peer);
    if (rec) for (const id of rec.identities) {
      if (this.identityOwner.get(id) === peer) this.identityOwner.delete(id);
    }
    this.peers.delete(peer);
  }

  /** Test/wiring hook: pre-bind a peer that was admitted before the guard existed. */
  bindPeer(peer: PeerId, stableId: StableId, clientId: ClientId): void {
    const rec = this.record(peer);
    if (!rec.identities.includes(stableId)) rec.identities.push(stableId);
    rec.clientId = clientId;
    this.identityOwner.set(stableId, peer);
  }

  /** Who currently owns an identity, if anyone. */
  ownerOf(stableId: StableId): PeerId | undefined { return this.identityOwner.get(stableId); }

  get admittedIdentities(): number { return this.identityOwner.size; }

  /* ---------------------------------------------------------- inbound --- */

  protected override onClientKind(
    from: PeerId, kind: string, m: Record<string, unknown>, nowMs: number,
  ): GuardVerdict {
    if (!CLIENT_KINDS.includes(kind)) {
      return this.drop('wrong-origin', from, kind, `'${kind}' is not client-originated`);
    }
    switch (kind) {
      case 'join': return this.onJoin(from, m, nowMs);
      case 'input': return this.onInput(from, m, nowMs);
      case 'ping': return this.onPing(from, nowMs);
      case 'bye': return this.count({ action: 'accept' }, from, kind);
      default: return this.drop('wrong-origin', from, kind, 'unreachable');
    }
  }

  /* ------------------------------------------------------------- join --- */

  private onJoin(from: PeerId, m: Record<string, unknown>, nowMs: number): GuardVerdict {
    const p = this.policy;
    const rec = this.record(from);

    const stableId = m['stableId'];
    if (typeof stableId !== 'string' || stableId.length === 0) {
      return this.drop('bad-shape', from, 'join', 'stableId missing or not a string');
    }
    if (stableId.length > p.maxStableIdLength) {
      return this.drop('bad-shape', from, 'join',
        `stableId is ${stableId.length} chars, max ${p.maxStableIdLength}`);
    }

    // Join rate. A real client sends one per handshake, plus one per migration.
    // Counted per ATTEMPT, not per success: a flood of refused joins is still a
    // flood, and each one costs a map lookup and a policy evaluation.
    rec.joinTimes = rec.joinTimes.filter((t) => nowMs - t < p.joinWindowMs);
    rec.joinTimes.push(nowMs);
    if (rec.joinTimes.length > p.maxJoinsPerWindow) {
      return this.drop('join-rate', from, 'join',
        `${rec.joinTimes.length} join attempts in ${p.joinWindowMs} ms from ${from}, cap ${p.maxJoinsPerWindow}`);
    }

    // Identity binding — the slot-theft fix.
    const owner = this.identityOwner.get(stableId);
    if (owner !== undefined && owner !== from) {
      return this.drop('identity-bound', from, 'join',
        `'${stableId}' is bound to ${owner}; ${from} may not claim it`);
    }

    if (owner === undefined) {
      if (!rec.identities.includes(stableId) && rec.identities.length >= p.maxIdentitiesPerPeer) {
        return this.drop('identity-per-peer', from, 'join',
          `${from} already claimed [${rec.identities.join(',')}]`);
      }
      if (this.identityOwner.size >= p.maxClients) {
        return this.drop('lobby-full', from, 'join',
          `${this.identityOwner.size} identities admitted, cap ${p.maxClients}`);
      }
    }

    if (!rec.identities.includes(stableId)) rec.identities.push(stableId);
    this.identityOwner.set(stableId, from);

    // A name is cosmetic and gets broadcast in every roster; truncate rather
    // than refuse, so a long nickname is not a disconnect.
    const name = m['name'];
    if (typeof name === 'string' && name.length > p.maxNameLength) {
      return this.count(
        { action: 'rewrite', message: { ...m, name: name.slice(0, p.maxNameLength) }, reason: 'bad-shape', detail: `name truncated ${name.length} -> ${p.maxNameLength}` },
        from, 'join',
      );
    }
    if (name !== undefined && typeof name !== 'string') {
      return this.count(
        { action: 'rewrite', message: { ...m, name: stableId }, reason: 'bad-shape', detail: 'name was not a string' },
        from, 'join',
      );
    }
    return this.count({ action: 'accept' }, from, 'join');
  }

  /* ------------------------------------------------------------ input --- */

  private onInput(from: PeerId, m: Record<string, unknown>, nowMs: number): GuardVerdict {
    const p = this.policy;
    const rec = this.record(from);

    // The slot must be the one we welcomed this peer into. PeerHost checks this
    // too; doing it here means a mismatch is *counted*, and it holds even if the
    // authority's own map is ever reshaped.
    const claimed = m['clientId'];
    if (rec.clientId !== 0 && claimed !== rec.clientId) {
      return this.drop('client-id-mismatch', from, 'input',
        `peer ${from} holds slot ${rec.clientId}, frame claims ${String(claimed)}`);
    }

    // Frame rate, before touching the payload.
    if (nowMs - rec.inputFramesMs >= 1000) { rec.inputFramesMs = nowMs; rec.inputFrames = 0; }
    if (++rec.inputFrames > p.maxInputFramesPerSecond) {
      return this.drop('frame-rate', from, 'input',
        `${rec.inputFrames} input frames in one second, cap ${p.maxInputFramesPerSecond}`);
    }

    const raw = m['cmds'];
    if (!Array.isArray(raw)) {
      // `AuthorityCore.submitInput` does `for (const c of cmds)`. A number or a
      // plain object throws a TypeError straight out of the transport's message
      // dispatch, which in the loopback path drops the rest of the batch.
      return this.count(
        { action: 'rewrite', message: { ...m, cmds: [] }, reason: 'bad-shape', detail: `cmds was ${typeName(raw)}, not an array` },
        from, 'input',
      );
    }

    // Command budget: the authority can never consume more than one per tick, so
    // anything past the bucket is provably waste before it is a threat.
    const budget = this.takeCommands(rec, raw.length, nowMs);
    const limit = Math.min(budget, p.maxCommandsPerFrame, raw.length);

    const out: InputCommand[] = [];
    let skew = 0;
    let shaped = 0;
    let magnitude = 0;
    // Keep the NEWEST commands: an over-long batch is a client catching up, and
    // the stale head of it is exactly the part the authority would discard.
    for (let i = raw.length - limit; i < raw.length; i++) {
      const c = raw[i] as Record<string, unknown> | null;
      const clean = this.sanitiseCommand(c);
      if (clean === 'bad') { shaped++; continue; }
      if (clean === 'skew') { skew++; continue; }
      if (clean.clampedMagnitude) magnitude++;
      out.push(clean.cmd);
    }

    if (out.length === raw.length && skew === 0 && shaped === 0 && magnitude === 0) {
      return this.count({ action: 'accept' }, from, 'input');
    }
    const reason = skew > 0 ? 'tick-skew'
      : shaped > 0 || magnitude > 0 ? 'bad-shape'
        : 'command-budget';
    return this.count(
      {
        action: 'rewrite',
        message: { ...m, cmds: out },
        reason,
        detail: `${raw.length} -> ${out.length} commands (budget ${budget}, skew ${skew}, malformed ${shaped}, magnitude-clamped ${magnitude})`,
      },
      from, 'input',
    );
  }

  /**
   * Returns a repaired command, or a rejection tag. Everything here is what the
   * authority's `isSaneCommand` + `sanitise` already do, **plus** the two things
   * they do not: a bound on `tick` relative to host time, and normalisation of
   * the move vector's magnitude rather than each axis alone.
   */
  private sanitiseCommand(c: Record<string, unknown> | null):
  { cmd: InputCommand; clampedMagnitude: boolean } | 'bad' | 'skew' {
    if (!c || typeof c !== 'object') return 'bad';
    const tick = c['tick'], seq = c['seq'];
    const moveX = c['moveX'], moveZ = c['moveZ'];
    const yaw = c['yaw'], pitch = c['pitch'], buttons = c['buttons'];
    if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < 0 || !Number.isSafeInteger(tick)) return 'bad';
    if (typeof moveX !== 'number' || !Number.isFinite(moveX)) return 'bad';
    if (typeof moveZ !== 'number' || !Number.isFinite(moveZ)) return 'bad';
    if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return 'bad';
    if (typeof pitch !== 'number' || !Number.isFinite(pitch)) return 'bad';
    if (typeof buttons !== 'number' || !Number.isInteger(buttons)) return 'bad';
    if (this.hostTick >= 0 && Math.abs(tick - this.hostTick) > this.policy.maxTickSkew) return 'skew';

    let mx = moveX < -1 ? -1 : moveX > 1 ? 1 : moveX;
    let mz = moveZ < -1 ? -1 : moveZ > 1 ? 1 : moveZ;
    let clampedMagnitude = false;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; clampedMagnitude = true; }

    return {
      clampedMagnitude,
      cmd: {
        tick,
        seq: typeof seq === 'number' && Number.isFinite(seq) ? seq | 0 : 0,
        moveX: mx,
        moveZ: mz,
        yaw,
        pitch,
        buttons: buttons & 0xffff,
      },
    };
  }

  /* ------------------------------------------------------------- ping --- */

  private onPing(from: PeerId, nowMs: number): GuardVerdict {
    const rec = this.record(from);
    if (nowMs - rec.pingsMs >= 1000) { rec.pingsMs = nowMs; rec.pings = 0; }
    if (++rec.pings > this.policy.maxPingsPerSecond) {
      // The host answers every ping with a pong, before any join check, so this
      // is unauthenticated reflection off the authority.
      return this.drop('ping-rate', from, 'ping',
        `${rec.pings} pings in one second from ${from}, cap ${this.policy.maxPingsPerSecond}`);
    }
    return this.count({ action: 'accept' }, from, 'ping');
  }

  /* ---------------------------------------------------------- helpers --- */

  private takeCommands(rec: PeerRecord, want: number, nowMs: number): number {
    const p = this.policy;
    const cap = p.commandsPerSecond * p.commandBurstSeconds;
    // -1 is the "never seen" sentinel. Using 0 would re-fill the bucket on every
    // call whenever the caller's clock starts at 0, which is exactly what a test
    // harness (and a freshly-started headless host) does.
    if (rec.commandTokensMs < 0) { rec.commandTokensMs = nowMs; rec.commandTokens = cap; }
    const elapsed = Math.max(0, nowMs - rec.commandTokensMs) / 1000;
    rec.commandTokensMs = nowMs;
    rec.commandTokens = Math.min(cap, rec.commandTokens + elapsed * p.commandsPerSecond);
    const granted = Math.min(want, Math.floor(rec.commandTokens));
    rec.commandTokens -= granted;
    return granted;
  }

  private record(peer: PeerId): PeerRecord {
    let r = this.peers.get(peer);
    if (!r) {
      r = {
        peerId: peer, identities: [], clientId: 0, joinTimes: [],
        commandTokens: 0, commandTokensMs: -1,
        inputFrames: 0, inputFramesMs: -1, pings: 0, pingsMs: -1, lastTick: -1,
      };
      this.peers.set(peer, r);
    }
    return r;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
