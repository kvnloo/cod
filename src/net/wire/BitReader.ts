/**
 * BitReader — the exact mirror of {@link BitWriter}.
 *
 * Reading past the end of the buffer never throws: it sets {@link
 * BitReader.overflowed} and returns zeros. That is deliberate. A host decodes
 * input packets from every client every tick, and clients decode packets from a
 * host they cannot trust to be non-buggy. A truncated or corrupted packet must
 * be a discarded packet, not a crashed process. Callers check `overflowed`
 * (and any schema-level sanity) before applying a decoded result.
 */

/** Explicit little-endian scratch so the wire format is endian-independent. */
const SCRATCH = new DataView(new ArrayBuffer(8));

let textDecoder: TextDecoder | null = null;
function decoder(): TextDecoder {
  if (!textDecoder) textDecoder = new TextDecoder();
  return textDecoder;
}

export class BitReader {
  private bytes: Uint8Array;
  private bitPos = 0;
  private readonly bitEnd: number;

  /** Set when a read ran past the end of the buffer. Sticky. */
  overflowed = false;

  constructor(data: Uint8Array | ArrayBuffer, byteOffset = 0, byteLength?: number) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const off = Math.min(byteOffset, u8.length);
    const len = byteLength === undefined ? u8.length - off : Math.min(byteLength, u8.length - off);
    this.bytes = u8.subarray(off, off + len);
    this.bitEnd = len * 8;
  }

  get bitsRead(): number {
    return this.bitPos;
  }

  get bitsRemaining(): number {
    return Math.max(0, this.bitEnd - this.bitPos);
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  /** True while the stream is intact and has bits left. */
  get ok(): boolean {
    return !this.overflowed;
  }

  reset(): void {
    this.bitPos = 0;
    this.overflowed = false;
  }

  /** Skip forward `bits` bits. */
  skipBits(bits: number): void {
    this.bitPos += bits;
    if (this.bitPos > this.bitEnd) {
      this.bitPos = this.bitEnd;
      this.overflowed = true;
    }
  }

  /** Read `bits` bits (1..32) as an unsigned integer. */
  readBits(bits: number): number {
    if (bits <= 0) return 0;
    if (this.bitPos + bits > this.bitEnd) {
      this.bitPos = this.bitEnd;
      this.overflowed = true;
      return 0;
    }
    let out = 0;
    let written = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byteIndex = this.bitPos >>> 3;
      const bitOffset = this.bitPos & 7;
      const take = Math.min(8 - bitOffset, remaining);
      const chunk = (this.bytes[byteIndex] >>> bitOffset) & ((1 << take) - 1);
      // Multiply rather than shift: `chunk << 31` would go negative.
      out += chunk * Math.pow(2, written);
      written += take;
      this.bitPos += take;
      remaining -= take;
    }
    return out >>> 0;
  }

  readBool(): boolean {
    return this.readBits(1) !== 0;
  }

  readUint(bits: number): number {
    return this.readBits(bits);
  }

  /**
   * Two's-complement signed integer in `bits` bits.
   *
   * Uses Math.pow rather than shifts: `1 << 31` is negative in JS, which
   * silently corrupted every 31-bit signed value in the first version of this.
   */
  readInt(bits: number): number {
    const raw = this.readBits(bits);
    if (bits >= 32) return raw | 0;
    const half = Math.pow(2, bits - 1);
    return raw >= half ? raw - Math.pow(2, bits) : raw;
  }

  readVarUint(): number {
    let out = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const group = this.readBits(8);
      out += (group & 0x7f) * Math.pow(2, shift);
      if ((group & 0x80) === 0) break;
      shift += 7;
    }
    return out >>> 0;
  }

  readVarInt(): number {
    const v = this.readVarUint();
    return (v >>> 1) ^ -(v & 1);
  }

  readFloat32(): number {
    SCRATCH.setUint32(0, this.readBits(32), true);
    return SCRATCH.getFloat32(0, true);
  }

  readFloat64(): number {
    SCRATCH.setUint32(0, this.readBits(32), true);
    SCRATCH.setUint32(4, this.readBits(32), true);
    return SCRATCH.getFloat64(0, true);
  }

  readUint53(): number {
    const lo = this.readBits(32);
    const hi = this.readBits(21);
    return hi * 4294967296 + lo;
  }

  /** `n` bit-packed bytes. Returns a fresh array. */
  readBytes(n: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, n));
    for (let i = 0; i < out.length; i++) out[i] = this.readBits(8);
    return out;
  }

  /**
   * varuint length + UTF-8 payload. `maxBytes` guards against a corrupt length
   * causing a huge allocation; exceeding it flags overflow and returns ''.
   */
  readString(maxBytes = 1024): string {
    const n = this.readVarUint();
    if (n > maxBytes || n * 8 > this.bitsRemaining) {
      this.overflowed = true;
      return '';
    }
    return decoder().decode(this.readBytes(n));
  }

  /** Advance to the next byte boundary. */
  align(): void {
    const rem = this.bitPos & 7;
    if (rem !== 0) this.skipBits(8 - rem);
  }
}
