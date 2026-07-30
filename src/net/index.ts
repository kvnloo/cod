/**
 * Public entry point for the networking layer's CONTRACTS.
 *
 * This barrel deliberately re-exports only `types.ts` and `Protocol.ts`. Those
 * two files import nothing, so this module can be pulled into the browser
 * client, a headless Node authority or a test harness without dragging in
 * `three`, the renderer or any gameplay system.
 *
 * Implementation modules (transport, host, client, snapshot writer, interest
 * management, lag compensation, lobby) are imported by their own path:
 *
 *     import { PROTOCOL_VERSION, JsonCodec } from './net';        // contracts
 *     import { WebRtcTransport } from './net/WebRtcTransport';    // impl
 *
 * That keeps adding a module from ever breaking this barrel, and keeps the
 * contract layer free of heavy dependencies.
 *
 * Read `docs/NETCODE.md` before changing anything here.
 */

export * from './types';
export * from './Protocol';
