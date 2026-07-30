/**
 * The client's record of what it told the server to do.
 *
 * Every command stays here until the host acknowledges it, because after a
 * correction those are exactly the commands that have to be replayed. Two
 * consequences fall out of that:
 *
 *   - the buffer has to hold at least one round-trip of input. At 120 Hz a
 *     250 ms RTT is 30 commands; the default 256 covers a 2-second stall.
 *   - the tail of the buffer is what gets resent every packet. Input goes out
 *     unreliably with the last N commands repeated, so a dropped datagram is
 *     invisible as long as a later one lands. Retransmitting input would arrive
 *     after it was needed and cost a round trip to discover.
 *
 * Storage is a flat ring of pre-allocated commands indexed by sequence. Nothing
 * here allocates after construction.
 */

import {
  copyMoveCommand, createMoveCommand, type MoveCommand,
} from '../../player/MoveCommand';

export class InputBuffer {
  readonly capacity: number;
  private readonly ring: MoveCommand[];
  /** Sequence stored in each slot, or -1 when the slot is empty. */
  private readonly slotSeq: Int32Array;
  /** Oldest retained (unacked) sequence. */
  private tailSeq = 0;
  /** One past the newest retained sequence. */
  private headSeq = 0;
  /** Commands evicted because the buffer filled before an ack arrived. */
  overflows = 0;

  constructor(capacity = 256) {
    if (capacity < 8 || (capacity & (capacity - 1)) !== 0) {
      throw new Error('[InputBuffer] capacity must be a power of two >= 8');
    }
    this.capacity = capacity;
    this.ring = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.ring[i] = createMoveCommand();
    this.slotSeq = new Int32Array(capacity).fill(-1);
  }

  /** Number of retained (unacked) commands. */
  get length(): number { return this.headSeq - this.tailSeq; }
  /** Oldest retained sequence; equals `newestSeq + 1` when empty. */
  get oldestSeq(): number { return this.tailSeq; }
  /** Newest retained sequence, or `oldestSeq - 1` when empty. */
  get newestSeq(): number { return this.headSeq - 1; }

  /**
   * Copies a command in. Sequences must be contiguous and increasing — the
   * client produces exactly one per fixed step, and the wire format encodes a
   * batch as a base sequence plus a count, which relies on that.
   */
  push(cmd: MoveCommand): void {
    if (this.length > 0 && cmd.seq !== this.headSeq) {
      throw new Error(`[InputBuffer] non-contiguous push: expected ${this.headSeq}, got ${cmd.seq}`);
    }
    if (this.length === 0) this.tailSeq = cmd.seq;
    if (this.length >= this.capacity) {
      // The server has not acked in a full buffer. Dropping the oldest is the
      // only option; it also means a correction older than this can no longer
      // be replayed and will resync instead. Counted so it is visible.
      this.slotSeq[this.tailSeq & (this.capacity - 1)] = -1;
      this.tailSeq++;
      this.overflows++;
    }
    const slot = cmd.seq & (this.capacity - 1);
    copyMoveCommand(this.ring[slot], cmd);
    this.slotSeq[slot] = cmd.seq;
    this.headSeq = cmd.seq + 1;
  }

  /** The stored command for `seq`, or null once it has been acked or evicted. */
  get(seq: number): MoveCommand | null {
    if (seq < this.tailSeq || seq >= this.headSeq) return null;
    const slot = seq & (this.capacity - 1);
    return this.slotSeq[slot] === seq ? this.ring[slot] : null;
  }

  has(seq: number): boolean { return this.get(seq) !== null; }

  /**
   * Retires everything up to and including `seq`. Returns how many were
   * retired. Acks that are older than the tail, or newer than anything pushed,
   * are ignored rather than trusted.
   */
  ackThrough(seq: number): number {
    if (seq < this.tailSeq) return 0;
    const end = Math.min(seq + 1, this.headSeq);
    let n = 0;
    for (let s = this.tailSeq; s < end; s++) {
      this.slotSeq[s & (this.capacity - 1)] = -1;
      n++;
    }
    this.tailSeq = end;
    return n;
  }

  /**
   * Fills `out` with every retained command strictly after `seq`, in order.
   * This is the replay list after a correction. Returns the count written.
   */
  collectAfter(seq: number, out: MoveCommand[]): number {
    let n = 0;
    for (let s = Math.max(seq + 1, this.tailSeq); s < this.headSeq; s++) {
      const c = this.get(s);
      if (!c) continue;
      out[n++] = c;
    }
    out.length = n;
    return n;
  }

  /**
   * Fills `out` with the newest `max` commands — the redundant tail sent every
   * packet. Returns the count written. Contiguous by construction.
   */
  tail(max: number, out: MoveCommand[]): number {
    const start = Math.max(this.tailSeq, this.headSeq - max);
    let n = 0;
    for (let s = start; s < this.headSeq; s++) {
      const c = this.get(s);
      if (!c) continue;
      out[n++] = c;
    }
    out.length = n;
    return n;
  }

  clear(nextSeq = 0): void {
    this.slotSeq.fill(-1);
    this.tailSeq = nextSeq;
    this.headSeq = nextSeq;
  }
}
