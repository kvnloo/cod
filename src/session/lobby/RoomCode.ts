/**
 * Shareable room codes.
 *
 * A code has to survive being read aloud over voice chat, so the alphabet is
 * Crockford base32: no `I`, `L`, `O` or `U`. Decoding maps the shapes people
 * actually type — `I`/`l` → `1`, `O`/`o` → `0` — back onto the alphabet, which
 * means `k4m9tq`, `K4M-9TQ` and `K4M 9TQ` are all the same room.
 *
 * 6 characters is 32^6 ≈ 1.07 billion codes: enough that a random draw
 * collides only after tens of thousands of live lobbies, and short enough to
 * dictate in one breath.
 */

import type { Rand } from '../../core/Rand';
import { hashString } from '../../core/Rand';
import type { RoomCode } from '../types';

/** Crockford base32, minus the ambiguous letters. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** Characters people type when they meant something else. */
const CONFUSIONS: Record<string, string> = {
  I: '1', L: '1', O: '0', U: 'V',
};

/** Draws a fresh code from a seeded stream. Never uses `Math.random`. */
export function makeRoomCode(rand: Rand, length = CODE_LENGTH): RoomCode {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[rand.int(0, CODE_ALPHABET.length - 1)];
  return out;
}

/**
 * Derives a code deterministically from a string — used so that a lobby id and
 * its code always agree, and so a migrated host regenerates the same code.
 */
export function codeFromSeed(seed: string, length = CODE_LENGTH): RoomCode {
  let h = hashString(seed);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[h % CODE_ALPHABET.length];
    // splitmix-style re-mix so consecutive characters do not correlate.
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (i + 1)) >>> 0;
    h = (Math.imul(h ^ (h >>> 12), 0x297a2d39)) >>> 0;
  }
  return out;
}

/**
 * Canonical form of whatever the player typed, or `''` when it cannot be a
 * code. Callers should compare canonical forms, never raw input.
 */
export function normalizeRoomCode(raw: string): RoomCode {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (ch === '-' || ch === ' ' || ch === '_') continue;
    const mapped = CONFUSIONS[ch] ?? ch;
    if (CODE_ALPHABET.indexOf(mapped) < 0) return '';
    out += mapped;
    if (out.length > CODE_LENGTH) return '';
  }
  return out.length === CODE_LENGTH ? out : '';
}

export function isRoomCode(raw: string): boolean {
  return normalizeRoomCode(raw).length === CODE_LENGTH;
}

/** `K4M9TQ` → `K4M-9TQ`. Display only; never store the formatted form. */
export function formatRoomCode(code: RoomCode): string {
  const c = normalizeRoomCode(code) || code.toUpperCase();
  const half = Math.ceil(c.length / 2);
  return `${c.slice(0, half)}-${c.slice(half)}`;
}

/** `lby_k4m9tq` — the lobby id that pairs with a code. */
export function lobbyIdForCode(code: RoomCode): string {
  return `lby_${code.toLowerCase()}`;
}
