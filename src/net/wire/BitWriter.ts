/**
 * BitWriter — bit-granular writer over a growable ArrayBuffer.
 *
 * Bandwidth is the hard limit on player count, so nothing here is byte-aligned:
 * a boolean costs exactly 1 bit, a 3-value enum costs 2, a quantised angle costs
 * 12. Bits are packed LSB-first inside each byte and bytes run in stream order,
 * which is the exact mirror of {@link BitReader}.
 *
 * Two features exist specifically for the netcode above:
 *
 *  - {@link BitWriter.mark} / {@link BitWriter.rollback} let the snapshot encoder
 *    speculatively write an entity, notice it blew the per-packet byte budget,
 *    and un-write it exactly. Budgeting without rollback means either a second
 *    size-estimation code path (which drifts from the real one) or overshooting
 *    the MTU.
 *  - {@link BitWriter.overflowed} makes a full buffer a *reported* condition
 *    rather than an exception. Serialisation runs on the host for every client
 *    every tick; it must degrade, not throw.
 *
 * No allocation happens per write; the backing store doubles on demand.
 */

/** Explicit little-endian scratch so the wire format is endian-independent. */
const SCRATCH = new DataView(new ArrayBuffer(8));

let textEncoder: TextEncoder | null = null;
function encoder(): TextEncoder {
  if (!textEncoder) textEncoder = new TextEncoder();
  return textEncoder;
}

export interface BitWriterOptions {
  /** Initial byte capacity. Defaults to 1200 — one WebRTC datagram. */
  capacity?: number;
  /** Grow the backing buffer on demand. Default true. */
  growable?: boolean;
  /** Hard ceiling in bytes; writes past it set `overflowed`. Default 1 MiB. */
  maxBytes?: number;
}

export class BitWriter {
  private bytes: Uint8Array;
  /** Bits not yet flushed to `bytes`, held in the low `accBits` bits. */
  private acc = 0;
  private accBits = 0;
  /** Count of whole bytes already flushed into `bytes`. */
  private pos = 0;

  private readonly growable: boolean;
  private readonly maxBytes: number;

  /** Set when a write did not fit. Once true, all further writes are dropped. */
  overflowed = false;

  constructor(options: BitWriterOptions = {}) {
    const capacity = Math.max(1, options.capacity ?? 1200);
    this.growable = options.growable ?? true;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.bytes = new Uint8Array(capacity);
  }

  /** Total bits written so far. */
  get bitLength(): number {
    return this.pos * 8 + this.accBits;
  }

  /** Bytes the stream would occupy if finished right now (partial byte counts). */
  get byteLength(): number {
    return this.pos + (this.accBits > 0 ? 1 : 0);
  }

  /** Reuse the writer for another packet without reallocating. */
  reset(): void {
    this.acc = 0;
    this.accBits = 0;
    this.pos = 0;
    this.overflowed = false;
  }

  /** Bit position usable with {@link rollback}. */
  mark(): number {
    return this.bitLength;
  }

  /**
   * Truncate the stream back to a position previously returned by {@link mark}.
   * Bits after the mark are discarded; the writer is byte-for-byte identical to
   * the moment the mark was taken.
   */
  rollback(bitPos: number): void {
    if (bitPos > this.bitLength) return;
    const p = bitPos >>> 3;
    const b = bitPos & 7;
    if (p < this.pos) {
      // The partial byte was already flushed; recover its low bits.
      this.acc = b === 0 ? 0 : this.bytes[p] & ((1 << b) - 1);
      this.pos = p;
      this.accBits = b;
    } else {
      this.acc = b === 0 ? 0 : this.acc & ((1 << b) - 1);
      this.accBits = b;
    }
    // A rollback can un-do an overflow only if we are now inside the buffer.
    if (this.overflowed && this.byteLength < this.bytes.length) this.overflowed = false;
  }

  private ensure(extraBytes: number): boolean {
    const need = this.pos + extraBytes + 1;
    if (need <= this.bytes.length) return true;
    if (!this.growable || need > this.maxBytes) {
      this.overflowed = true;
      return false;
    }
    let cap = this.bytes.length;
    while (cap < need) cap *= 2;
    if (cap > this.maxBytes) cap = this.maxBytes;
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    return true;
  }

  /**
   * Write the low `bits` bits of `value` (1..32). Values are treated as
   * unsigned; use {@link writeInt} for signed.
   */
  writeBits(value: number, bits: number): void {
    if (bits <= 0) return;
    if (this.overflowed) return;
    if (!this.ensure((bits + 7) >>> 3)) return;

    let v = value >>> 0;
    if (bits < 32) v = v & (((1 << bits) >>> 0) - 1);
    let remaining = bits;
    while (remaining > 0) {
      const take = Math.min(8 - this.accBits, remaining);
      const chunk = v & ((1 << take) - 1);
      this.acc |= chunk << this.accBits;
      this.accBits += take;
      v = take >= 32 ? 0 : v >>> take;
      remaining -= take;
      if (this.accBits === 8) {
        this.bytes[this.pos++] = this.acc & 0xff;
        this.acc = 0;
        this.accBits = 0;
      }
    }
  }

  writeBool(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  /** Unsigned integer in `bits` bits. Values outside the range are masked. */
  writeUint(value: number, bits: number): void {
    this.writeBits(value, bits);
  }

  /** Two's-complement signed integer in `bits` bits. */
  writeInt(value: number, bits: number): void {
    this.writeBits(value | 0, bits);
  }

  /**
   * Variable-length unsigned integer, 7 payload bits + 1 continuation bit per
   * group. 1 byte up to 127, 2 to 16383, 5 for a full uint32. Not byte aligned.
   */
  writeVarUint(value: number): void {
    let v = value >>> 0;
    for (;;) {
      const group = v & 0x7f;
      v = v >>> 7;
      if (v === 0) {
        this.writeBits(group, 8); // continuation bit 0 in position 7
        return;
      }
      this.writeBits(group | 0x80, 8);
    }
  }

  /** Zig-zag encoded signed varint: small magnitudes cost few bits either sign. */
  writeVarInt(value: number): void {
    const v = value | 0;
    this.writeVarUint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  /** Exact IEEE-754 single. 32 bits. Escape hatch — prefer a quantised codec. */
  writeFloat32(value: number): void {
    SCRATCH.setFloat32(0, value, true);
    this.writeBits(SCRATCH.getUint32(0, true), 32);
  }

  /** Exact IEEE-754 double. 64 bits. For wall-clock timestamps only. */
  writeFloat64(value: number): void {
    SCRATCH.setFloat64(0, value, true);
    this.writeBits(SCRATCH.getUint32(0, true), 32);
    this.writeBits(SCRATCH.getUint32(4, true), 32);
  }

  /** Unsigned integer up to 2^53-1, split into two 32-bit halves. */
  writeUint53(value: number): void {
    const v = Math.max(0, Math.floor(value));
    const lo = v >>> 0;
    const hi = Math.floor(v / 4294967296) >>> 0;
    this.writeBits(lo, 32);
    this.writeBits(hi, 21);
  }

  /** Raw bytes, bit-packed (does not force alignment). */
  writeBytes(src: Uint8Array): void {
    for (let i = 0; i < src.length; i++) this.writeBits(src[i], 8);
  }

  /** varuint byte-length prefix + UTF-8 payload. */
  writeString(value: string): void {
    const encoded = encoder().encode(value);
    this.writeVarUint(encoded.length);
    this.writeBytes(encoded);
  }

  /** Pad with zero bits up to the next byte boundary. */
  align(): void {
    if (this.accBits > 0) this.writeBits(0, 8 - this.accBits);
  }

  /**
   * Copy of the stream, padded to a whole byte. Non-destructive — the writer can
   * continue to be used afterwards.
   */
  toBytes(): Uint8Array {
    const n = this.byteLength;
    const out = new Uint8Array(n);
    out.set(this.bytes.subarray(0, this.pos));
    if (this.accBits > 0) out[this.pos] = this.acc & 0xff;
    return out;
  }

  /**
   * Zero-copy view of the stream. Only valid until the next write and invalid
   * after a grow — use for immediate hand-off to a transport, `toBytes()` to
   * retain.
   */
  viewBytes(): Uint8Array {
    if (this.accBits > 0) this.bytes[this.pos] = this.acc & 0xff;
    return this.bytes.subarray(0, this.byteLength);
  }
}
