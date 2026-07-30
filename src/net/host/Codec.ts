/**
 * Default wire codec: JSON over UTF-8.
 *
 * Deliberately the boring choice. The codec is a port (`Codec` in `ports.ts`), so
 * the binary/bit-packed writer belongs behind the same interface and can be
 * dropped in without the authority or the migration code changing a line. Until
 * that lands, JSON keeps the wire inspectable in devtools, keeps the tests
 * readable, and still reports honest byte counts for the bandwidth budget.
 */

import type { Codec } from './ports';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class JsonCodec implements Codec {
  readonly name = 'json';
  encode(msg: unknown): Uint8Array { return enc.encode(JSON.stringify(msg)); }
  decode(data: Uint8Array): unknown { return JSON.parse(dec.decode(data)); }
}

export const jsonCodec = new JsonCodec();
