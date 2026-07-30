/**
 * Vocabulary for the security layer.
 *
 * This directory imports **nothing at runtime** — only `import type`. Like
 * `src/net/types.ts` it therefore runs unchanged in a browser peer, in a headless
 * Node authority and in `tools/net-cheat.mjs`. That matters: the guards are the
 * one part of the stack that must still be running when the host moves to a
 * dedicated box, because that is where the threat model gets *bigger*, not
 * smaller (a public server accepts frames from strangers).
 */

import type { ClientId, PeerId, StableId, Tick } from '../host/types';

/** Why a frame was refused. Every one of these is counted, never silently eaten. */
export type DropReason =
  /** A client sent a message kind only a host may send (or vice versa). */
  | 'wrong-origin'
  /** Host-originated frame from a peer that is not the host we handshook with. */
  | 'not-host'
  /** A host claim while the current host is demonstrably still alive. */
  | 'host-alive'
  /** A host claim from a peer that is not in the roster the real host published. */
  | 'unknown-peer'
  /** Epoch jumped further than a legal succession could move it. */
  | 'epoch-jump'
  /** `stableId` is already bound to a different, still-connected transport peer. */
  | 'identity-bound'
  /** This peer has already claimed as many distinct identities as it may. */
  | 'identity-per-peer'
  /** Join attempts from this peer exceeded the rate limit. */
  | 'join-rate'
  /** The lobby is full. */
  | 'lobby-full'
  /** `clientId` in the frame is not the slot this peer was welcomed into. */
  | 'client-id-mismatch'
  /** Structurally malformed: wrong type, missing field, absurd length. */
  | 'bad-shape'
  /** Frame is larger than the policy permits. */
  | 'oversize'
  /** Input frames arriving faster than the policy permits. */
  | 'frame-rate'
  /** Commands arriving faster than the authority can ever consume them. */
  | 'command-budget'
  /** Ping/pong reflection abuse. */
  | 'ping-rate'
  /** A command whose tick is nowhere near host time. */
  | 'tick-skew';

/** What the guard decided about one frame. */
export type GuardVerdict =
  /** Forward the original bytes unchanged. */
  | { action: 'accept' }
  /**
   * Forward a repaired frame instead. Used where dropping would punish a
   * legitimate but noisy client (an over-long input batch is truncated, not
   * discarded — a client catching up after a stall is not an attacker).
   */
  | { action: 'rewrite'; message: Record<string, unknown>; reason: DropReason; detail?: string }
  /** Do not deliver this frame to the application at all. */
  | { action: 'drop'; reason: DropReason; detail?: string };

export interface GuardStats {
  seen: number;
  accepted: number;
  rewritten: number;
  dropped: number;
  /** Drop/rewrite counts keyed by {@link DropReason}. */
  byReason: Record<string, number>;
  /** Peers that have tripped the policy at all, and how often. */
  byPeer: Record<string, number>;
}

/**
 * Every knob, in one object, with the reasoning in the comment. Defaults are
 * sized for the as-built 30 Hz host with 3x input redundancy; a 60 Hz host
 * should raise `commandsPerSecond` with `tickRate`.
 */
export interface SecurityPolicy {
  /* ---- identity ---- */
  /** Hard cap on distinct identities admitted to a match. */
  maxClients: number;
  /**
   * Distinct `stableId`s one transport peer may claim over the life of the
   * connection. 2 rather than 1 so a genuine re-identify (a player changing
   * account mid-session) still works, while a join flood cannot mint slots.
   */
  maxIdentitiesPerPeer: number;
  /** Join frames per peer per `joinWindowMs`. A real client sends one per handshake. */
  maxJoinsPerWindow: number;
  joinWindowMs: number;
  /** Longest acceptable `stableId`. Anything longer is a payload, not an identity. */
  maxStableIdLength: number;
  /** Display names longer than this are truncated (never dropped — it is cosmetic). */
  maxNameLength: number;

  /* ---- input ---- */
  /**
   * Commands the authority may see in one frame. The host drains exactly one per
   * tick, so anything above `inputRedundancy` is already waste; 32 leaves room
   * for a client catching up after a long stall.
   */
  maxCommandsPerFrame: number;
  /**
   * Sustained command budget per peer. The authority can never consume more than
   * `tickRate` per second, and redundancy multiplies what is legitimately *sent*.
   * Default 180 = 60 Hz x 3 redundancy, which is above any honest 30 Hz client.
   */
  commandsPerSecond: number;
  /** Seconds of budget a quiet client may bank. Covers a jitter burst. */
  commandBurstSeconds: number;
  /** Input frames per second per peer, independent of how full they are. */
  maxInputFramesPerSecond: number;
  /** Ping frames per second per peer. The host answers every one, so this is reflection. */
  maxPingsPerSecond: number;
  /**
   * Ticks a command may be away from the host's own tick. Generous (20 s at
   * 30 Hz) because this is a sanity bound, not a lag-compensation decision; its
   * job is to stop `tick: 1e12` poisoning the duplicate-rejection watermark.
   */
  maxTickSkew: number;
  /** Frames above this many bytes are refused undecoded. */
  maxFrameBytes: number;

  /* ---- authority claims ---- */
  /**
   * How long the current host must have been silent before ANY other peer may
   * claim the term. Mirrors `MigrationPolicy.hostTimeoutMs`: an election is only
   * legitimate once the host has actually stopped talking, so a live host can
   * never be deposed by a message.
   */
  hostQuietMs: number;
  /**
   * Largest legal epoch increment in one claim. A real succession is +1; the
   * slack covers a double failure where two terms are lost in a row.
   */
  maxEpochJump: number;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  maxClients: 16,
  maxIdentitiesPerPeer: 2,
  maxJoinsPerWindow: 4,
  joinWindowMs: 10_000,
  maxStableIdLength: 64,
  maxNameLength: 32,

  maxCommandsPerFrame: 32,
  commandsPerSecond: 180,
  commandBurstSeconds: 1,
  maxInputFramesPerSecond: 120,
  maxPingsPerSecond: 20,
  maxTickSkew: 600,
  maxFrameBytes: 64 * 1024,

  hostQuietMs: 1200,
  maxEpochJump: 4,
};

/** Message kinds a client is allowed to originate (`ClientToHost` in host/types). */
export const CLIENT_KINDS: readonly string[] = ['join', 'input', 'ping', 'bye'];

/** Message kinds only a host may originate (`HostToClient` in host/types). */
export const HOST_KINDS: readonly string[] = [
  'welcome', 'reject', 'snapshot', 'checkpoint', 'pong', 'heartbeat',
  'hostAnnounce', 'hostHandoff',
];

/** Kinds that assert authority. These are the match-takeover surface. */
export const AUTHORITY_CLAIM_KINDS: readonly string[] = ['hostAnnounce', 'hostHandoff', 'welcome'];

/** One peer's security bookkeeping on the host side. */
export interface PeerRecord {
  peerId: PeerId;
  /** Identities this peer has claimed, in claim order. */
  identities: StableId[];
  /** Slot the host welcomed this peer into, or 0 before the welcome goes out. */
  clientId: ClientId;
  joinTimes: number[];
  /** Token bucket state for commands. */
  commandTokens: number;
  commandTokensMs: number;
  inputFrames: number;
  inputFramesMs: number;
  pings: number;
  pingsMs: number;
  lastTick: Tick;
}
