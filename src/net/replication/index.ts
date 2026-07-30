/**
 * Replication — what gets sent, to whom, and how often.
 *
 * This module is the server-authoritative half of the netcode's state channel.
 * It imports nothing from `three`, the DOM or any gameplay system, so the exact
 * same code runs in the browser peer that is hosting today and in a headless
 * Node authority tomorrow. That is the whole point of the boundary: moving the
 * host off a peer must not require a gameplay rewrite.
 *
 * The four pieces and how they compose:
 *
 *   Replicator       registry of replicated entities + per-client acknowledged
 *                    baselines. Samples game state through `ReplicationSource`;
 *                    never owns simulation truth.
 *   InterestManager  uniform spatial grid + forced relevance + priority/LOD
 *                    tiers. Answers "what may this client know about, ranked".
 *   BandwidthBudget  per-client token bucket, degradation ladder and per-group
 *                    byte attribution. Answers "how much may it cost".
 *   SnapshotBuilder  prices every candidate against that client's baseline,
 *                    fills the budget in priority order, encodes in id order.
 *   SnapshotApplier  the receiving half, kept in the same file as the writer so
 *                    the two formats cannot drift.
 *
 * Typical host wiring:
 *
 *     const registry = createDefaultRegistry();
 *     const rep      = new Replicator(registry);
 *     const interest = new InterestManager(rep);
 *     const budget   = new BandwidthBudget({ bytesPerSecond: 12000, tickRate: 20 });
 *     const builder  = new SnapshotBuilder(rep, interest, budget);
 *
 *     // per network tick:
 *     rep.capture(tick);
 *     for (const c of clients) {
 *       interest.setView(c.id, { pos, forward, team, controlled });
 *       const snap = builder.build(c.id, tick);
 *       if (snap.byteLength > 0) transport.send(c.id, snap.bytes);
 *     }
 *     // on ack from a client: rep.ack(clientId, tick)
 */

export * from './types';
export * from './Bits';
export * from './Schema';
export * from './Replicator';
export * from './Interest';
export * from './Budget';
export * from './SnapshotBuilder';
