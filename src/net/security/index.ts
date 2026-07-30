/**
 * `src/net/security` — the checks that assume the peer on the other end is
 * hostile.
 *
 * Everything else in `src/net/` is written for the case where the protocol is
 * being spoken correctly. This directory is written for the case where it is
 * not. It imports nothing at runtime (`import type` only), so it runs unchanged
 * in a browser peer, in a headless Node authority, and in the test harness.
 *
 * ## Install
 *
 * ```ts
 * import { HostGuard, ClientGuard, guardTransport } from './net/security';
 *
 * const guard = iAmHosting
 *   ? new HostGuard({ selfStableId: myId })
 *   : new ClientGuard({ selfStableId: myId });
 *
 * const session = new PeerSession({
 *   transport: guardTransport(rawTransport, guard, {
 *     codec: jsonCodec,
 *     now: () => myMonotonicMs,   // the SAME clock you pass to session.update()
 *   }),
 *   ...
 * });
 * ```
 *
 * There is no lifecycle wiring to forget. The guard learns whether this peer is
 * the authority from what it *sends* — a peer that emits a `welcome` or a
 * `hostAnnounce` is hosting, a peer that emits a `join` is not — so host
 * migration needs no callback and a freshly promoted host is never briefly
 * willing to be deposed. `setHosting()` exists only as an explicit override.
 *
 * A peer that may *become* the host — which is every peer in a peer-hosted match
 * — should install a `HostGuard`; it is a `ClientGuard` plus the host rules, and
 * the host rules cost nothing until client frames actually arrive.
 *
 * ## What it stops, and what it does not
 *
 * | Attack | Guard | Rule |
 * |---|---|---|
 * | Slot theft with a public `stableId` | `HostGuard` | identity is bound to the first transport peer that claims it |
 * | Join flood minting unbounded slots/entities | `HostGuard` | joins/window, identities/peer, lobby cap |
 * | 8000 commands in one datagram | `HostGuard` | per-frame cap + a token bucket at the tick rate |
 * | `tick: 1e12` muting a client forever | `HostGuard` | tick must be within `maxTickSkew` of host time |
 * | Diagonal input with `\|move\| = 1.414` | `HostGuard` | magnitude normalised, not just per-axis clamped |
 * | Non-iterable `cmds` throwing out of the dispatcher | `HostGuard` | rewritten to `[]` |
 * | Ping reflection off an unjoined peer | `HostGuard` | pings/second |
 * | Match takeover by forged `hostAnnounce` | `ClientGuard` | a live host is never deposed; claimant must be in the host's roster |
 * | Warm-standby state poisoning by forged `checkpoint` | `ClientGuard` | host-originated frames must come from the host link |
 * | Forged `welcome` redirecting a client | `ClientGuard` | only from the peer we actually sent a join to |
 *
 * **Not stopped, and no transport-level check can:** a malicious *host*. It owns
 * truth by construction (NETCODE.md §11). The guards narrow *who can become* the
 * host to peers the previous host published, and only once it has actually gone
 * silent — but a legitimately-elected hostile host is a dedicated-server problem,
 * not a validation problem.
 *
 * **Also not stopped:** wallhacks. `DeltaSnapshotWriter` replicates every entity
 * within 120 m with full health, ammo, weapon and aim, in an arena whose maximum
 * separation is 170 m and which has no occlusion test at all. No client-side fix
 * exists for data that is already on the wire; that one belongs in the writer.
 */

export {
  DEFAULT_SECURITY_POLICY, CLIENT_KINDS, HOST_KINDS, AUTHORITY_CLAIM_KINDS,
} from './types';
export type {
  SecurityPolicy, GuardVerdict, GuardStats, DropReason, PeerRecord,
} from './types';

export { ClientGuard } from './ClientGuard';
export type { ClientGuardOptions } from './ClientGuard';

export { HostGuard } from './HostGuard';
export type { HostGuardOptions } from './HostGuard';

export { guardTransport } from './GuardedTransport';
export type { GuardTransportOptions } from './GuardedTransport';
