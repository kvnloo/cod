/**
 * Bit-level writer/reader plus quantization helpers.
 *
 * Snapshots are bit-packed, not byte-packed: a 12-field entity update spends 12
 * bits on its dirty mask rather than 2 bytes, a boolean costs 1 bit, and a
 * quantized yaw costs 12. Across 60 entities x 20 Hz that difference is on the
 * order of several KB/s per client, which is exactly the budget we are fighting
 * for.
 *
 * Layout is MSB-first within each byte so a hex dump reads in field order.
 * Everything here is dependency-free and runs identically in Node and the
 * browser.
 */

export class BitWriter {
  private buf: Uint8Array;
  private bits = 0;

  constructor(initialBytes = 2048) {
    this.buf = new Uint8Array(Math.max(8, initialBytes));
  }

  get bitLength(): number { return this.bits; }
  get byteLength(): number { return (this.bits + 7) >> 3; }

  reset(): void {
    this.buf.fill(0, 0, this.byteLength);
    this.bits = 0;
  }

  /** Current bit position — pass to `rollback` or `patchBits`. */
  mark(): number { return this.bits; }

  /** Discards everything written since `mark`, zeroing the abandoned bits. */
  rollback(mark: number): void {
    if (mark >= this.bits) return;
    const startByte = mark >> 3;
    const endByte = (this.bits + 7) >> 3;
    const keep = mark & 7;
    this.buf[startByte] &= (0xff << (8 - keep)) & 0xff;
    for (let i = startByte + 1; i < endByte; i++) this.buf[i] = 0;
    this.bits = mark;
  }

  private ensure(byteIndex: number): void {
    if (byteIndex < this.buf.length) return;
    let n = this.buf.length * 2;
    while (n <= byteIndex) n *= 2;
    const nb = new Uint8Array(n);
    nb.set(this.buf);
    this.buf = nb;
  }

  /** Writes the low `bits` (1..32) of `value`, MSB first. */
  writeBits(value: number, bits: number): void {
    if (bits <= 0) return;
    let v = value >>> 0;
    if (bits < 32) v = (v & ((1 << bits) - 1)) >>> 0;
    let remaining = bits;
    while (remaining > 0) {
      const byteIndex = this.bits >> 3;
      const offset = this.bits & 7;
      const space = 8 - offset;
      const take = space < remaining ? space : remaining;
      const chunk = (v >>> (remaining - take)) & ((1 << take) - 1);
      this.ensure(byteIndex);
      this.buf[byteIndex] |= (chunk << (space - take)) & 0xff;
      this.bits += take;
      remaining -= take;
    }
  }

  /** Overwrites `bits` at an earlier position — used to back-patch counts. */
  patchBits(pos: number, value: number, bits: number): void {
    let v = value >>> 0;
    if (bits < 32) v = (v & ((1 << bits) - 1)) >>> 0;
    let p = pos;
    let remaining = bits;
    while (remaining > 0) {
      const byteIndex = p >> 3;
      const offset = p & 7;
      const space = 8 - offset;
      const take = space < remaining ? space : remaining;
      const chunk = (v >>> (remaining - take)) & ((1 << take) - 1);
      const shift = space - take;
      const mask = (((1 << take) - 1) << shift) & 0xff;
      this.ensure(byteIndex);
      this.buf[byteIndex] = ((this.buf[byteIndex] & ~mask) & 0xff) | ((chunk << shift) & 0xff);
      p += take;
      remaining -= take;
    }
  }

  writeBool(v: boolean): void { this.writeBits(v ? 1 : 0, 1); }

  /** 7 bits payload + continuation bit per byte. */
  writeVarUint(value: number): void {
    let v = value >>> 0;
    while (v >= 0x80) {
      this.writeBits(0x80 | (v & 0x7f), 8);
      v = v >>> 7;
    }
    this.writeBits(v, 8);
  }

  /** Zigzag then varuint — small magnitudes near zero cost one byte. */
  writeVarInt(value: number): void {
    const v = value | 0;
    this.writeVarUint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  writeFloat32(v: number): void {
    f32[0] = v;
    this.writeBits(u32[0], 32);
  }

  /** Copy of the written bytes, zero-padded to a byte boundary. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.byteLength);
  }
}

export class BitReader {
  private buf: Uint8Array;
  private bits = 0;
  readonly bitCapacity: number;

  constructor(bytes: Uint8Array) {
    this.buf = bytes;
    this.bitCapacity = bytes.length * 8;
  }

  get bitPosition(): number { return this.bits; }
  get bytesRead(): number { return (this.bits + 7) >> 3; }
  get exhausted(): boolean { return this.bits >= this.bitCapacity; }

  readBits(bits: number): number {
    if (bits <= 0) return 0;
    let out = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byteIndex = this.bits >> 3;
      const offset = this.bits & 7;
      const space = 8 - offset;
      const take = space < remaining ? space : remaining;
      const byte = byteIndex < this.buf.length ? this.buf[byteIndex] : 0;
      const chunk = (byte >>> (space - take)) & ((1 << take) - 1);
      out = ((out * (1 << take)) + chunk) >>> 0;
      this.bits += take;
      remaining -= take;
    }
    return out >>> 0;
  }

  readBool(): boolean { return this.readBits(1) === 1; }

  readVarUint(): number {
    let shift = 0;
    let out = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.readBits(8);
      out = (out + (b & 0x7f) * Math.pow(2, shift)) >>> 0;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return out >>> 0;
  }

  readVarInt(): number {
    const u = this.readVarUint();
    return ((u >>> 1) ^ -(u & 1)) | 0;
  }

  readFloat32(): number {
    u32[0] = this.readBits(32);
    return f32[0];
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Number of bits needed to represent `values` distinct values. */
export function bitsForValues(values: number): number {
  let n = 1;
  while ((1 << n) < values && n < 32) n++;
  return n;
}

/** Round-half-away-from-zero quantization. Deterministic, no Math.random. */
export function quantize(v: number, step: number): number {
  const q = v / step;
  return q >= 0 ? Math.floor(q + 0.5) : -Math.floor(-q + 0.5);
}

export function dequantize(q: number, step: number): number {
  return q * step;
}

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Smallest-three quaternion packing. Drops the largest component (recoverable
 * from unit length), sends its index plus the other three at 10 bits each over
 * [-1/sqrt2, 1/sqrt2]. 32 bits total, ~0.1 degree of error.
 */
const QUAT_RANGE = 0.7071067811865476;
const QUAT_LEVELS = 1023;

export function packQuat(x: number, y: number, z: number, w: number, out: Int32Array, offset: number): void {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z), aw = Math.abs(w);
  let largest = 0;
  let lv = ax;
  if (ay > lv) { largest = 1; lv = ay; }
  if (az > lv) { largest = 2; lv = az; }
  if (aw > lv) { largest = 3; lv = aw; }
  const sign = ((largest === 0 ? x : largest === 1 ? y : largest === 2 ? z : w) < 0) ? -1 : 1;
  const c = [x * sign, y * sign, z * sign, w * sign];
  let k = 0;
  out[offset] = largest;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const n = clampInt(Math.round(((c[i] + QUAT_RANGE) / (2 * QUAT_RANGE)) * QUAT_LEVELS), 0, QUAT_LEVELS);
    out[offset + 1 + k] = n;
    k++;
  }
}

export function unpackQuat(words: Int32Array, offset: number, out: { x: number; y: number; z: number; w: number }): void {
  const largest = words[offset] & 3;
  const c = [0, 0, 0, 0];
  let k = 0;
  let sumSq = 0;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const v = (words[offset + 1 + k] / QUAT_LEVELS) * (2 * QUAT_RANGE) - QUAT_RANGE;
    c[i] = v;
    sumSq += v * v;
    k++;
  }
  c[largest] = Math.sqrt(Math.max(0, 1 - sumSq));
  out.x = c[0]; out.y = c[1]; out.z = c[2]; out.w = c[3];
}
