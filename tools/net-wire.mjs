#!/usr/bin/env node
/**
 * Headless verification for src/net/wire.
 *
 * You cannot verify netcode from a screenshot. This exercises the bit stream,
 * every quantiser, the schema layer and the snapshot delta encoder against a
 * simulated 24-entity match, and prints the numbers that decide player count:
 * bytes per snapshot and the implied kbit/s.
 *
 *   node tools/net-wire.mjs [--ticks 600] [--seed 1337] [--hz 20]
 *
 * TypeScript is loaded directly via node's native type stripping; the resolve
 * hook below just supplies the `.ts` extension that the bundler-style imports
 * in src/ omit.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL) {
      const base = new URL(spec, ctx.parentURL).href;
      for (const ext of ['.ts', '/index.ts']) {
        if (existsSync(fileURLToPath(base + ext))) return next(spec + ext, ctx);
      }
    }
    return next(spec, ctx);
  },
});

const wire = await import('../src/net/wire/index.ts');
const { Rand } = await import('../src/core/Rand.ts');

const {
  BitWriter, BitReader,
  C, defineSchema, SchemaRegistry, StateOf,
  DeltaEncoder, DeltaDecoder, BandwidthMeter, kbitPerSecond,
  DEFAULT_WORLD_BOUNDS, DEFAULT_VELOCITY_RANGE, worldPrecisionCm,
  quantizeAngle, dequantizeAngle, angleError, ANGLE_BITS_PRECISE, ANGLE_BITS_COARSE,
  packSmallestThree, unpackSmallestThree, quatErrorRad, quatAngleBetween,
  quantize, dequantize, makeRange, rangeForPrecision,
  DEFAULT_POSITION_FULL_BITS,
} = wire;

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};
const TICKS = flag('ticks', 600);
const SEED = flag('seed', 1337);
const HZ = flag('hz', 20);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? '   ' + detail : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '   ' + detail : ''}`);
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);
const f = (v, d = 3) => Number(v).toFixed(d);

/* -------------------------------------------------------------------------- */
/* 1. bit stream                                                              */
/* -------------------------------------------------------------------------- */

section('1. BitWriter / BitReader');

{
  const rnd = new Rand(SEED ^ 0x11);
  const ops = [];
  const w = new BitWriter({ capacity: 16 });
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const kind = rnd.int(0, 6);
    if (kind === 0) {
      const v = rnd.bool();
      ops.push(['bool', v]);
      w.writeBool(v);
    } else if (kind === 1) {
      const bits = rnd.int(1, 32);
      const v = bits === 32 ? rnd.u32() : rnd.u32() >>> (32 - bits);
      ops.push(['uint', v >>> 0, bits]);
      w.writeBits(v, bits);
    } else if (kind === 2) {
      const bits = rnd.int(2, 32);
      const lo = -Math.pow(2, bits - 1);
      const hi = Math.pow(2, bits - 1) - 1;
      const v = rnd.int(lo, hi);
      ops.push(['int', v, bits]);
      w.writeInt(v, bits);
    } else if (kind === 3) {
      const v = rnd.u32() >>> rnd.int(0, 31);
      ops.push(['varuint', v >>> 0]);
      w.writeVarUint(v);
    } else if (kind === 4) {
      const v = (rnd.u32() >>> rnd.int(0, 31)) | 0;
      const s = rnd.bool() ? v : -v;
      ops.push(['varint', s | 0]);
      w.writeVarInt(s);
    } else if (kind === 5) {
      const v = Math.fround(rnd.signed() * 1e6);
      ops.push(['f32', v]);
      w.writeFloat32(v);
    } else {
      const v = rnd.range(-1e12, 1e12);
      ops.push(['f64', v]);
      w.writeFloat64(v);
    }
  }
  const bytes = w.toBytes();
  const r = new BitReader(bytes);
  let bad = 0;
  let firstBad = '';
  for (const op of ops) {
    let got;
    if (op[0] === 'bool') got = r.readBool();
    else if (op[0] === 'uint') got = r.readBits(op[2]);
    else if (op[0] === 'int') got = r.readInt(op[2]);
    else if (op[0] === 'varuint') got = r.readVarUint();
    else if (op[0] === 'varint') got = r.readVarInt();
    else if (op[0] === 'f32') got = r.readFloat32();
    else got = r.readFloat64();
    if (got !== op[1]) {
      bad++;
      if (!firstBad) firstBad = `${op[0]} want ${op[1]} got ${got}`;
    }
  }
  check(`bitstream fuzz round-trip (${N} ops, ${bytes.length} bytes)`, bad === 0 && !r.overflowed,
    bad ? firstBad : `bits=${w.bitLength}`);
}

{
  // A bool must cost exactly one bit.
  const w = new BitWriter();
  for (let i = 0; i < 64; i++) w.writeBool(i % 3 === 0);
  check('64 booleans occupy 8 bytes', w.byteLength === 8, `${w.byteLength} bytes`);
}

{
  const w = new BitWriter();
  w.writeBits(0x2a, 7);
  const mark = w.mark();
  w.writeBits(0xffff, 16);
  w.writeBool(true);
  w.rollback(mark);
  w.writeBits(0x5, 5);
  const r = new BitReader(w.toBytes());
  check('rollback restores the stream exactly',
    r.readBits(7) === 0x2a && r.readBits(5) === 0x5 && w.bitLength === 12,
    `bits=${w.bitLength}`);
}

{
  const r = new BitReader(new Uint8Array([0xff, 0xff]));
  r.readBits(16);
  const v = r.readBits(8);
  check('over-read flags overflow instead of throwing', r.overflowed && v === 0);
}

{
  const w = new BitWriter();
  const s = 'héllo·wörld ✓ 你好';
  w.writeBool(true);
  w.writeString(s);
  const r = new BitReader(w.toBytes());
  r.readBool();
  check('unaligned UTF-8 string round-trip', r.readString() === s);
}

/* -------------------------------------------------------------------------- */
/* 2. quantisation error bounds                                               */
/* -------------------------------------------------------------------------- */

section('2. Quantize — stated error bounds');

{
  const rnd = new Rand(SEED ^ 0x22);
  const cases = [
    ['position X/Z', DEFAULT_WORLD_BOUNDS.x],
    ['position Y  ', DEFAULT_WORLD_BOUNDS.y],
    ['velocity    ', DEFAULT_VELOCITY_RANGE],
    ['unorm(8)    ', makeRange(0, 1, 8)],
  ];
  for (const [name, range] of cases) {
    let maxErr = 0;
    for (let i = 0; i < 200000; i++) {
      const v = rnd.range(range.min, range.max);
      const back = dequantize(range, quantize(range, v));
      const e = Math.abs(back - v);
      if (e > maxErr) maxErr = e;
    }
    check(`${name} within stated bound`, maxErr <= range.error * (1 + 1e-9),
      `bits=${range.bits} step=${f(range.step, 6)} bound=${f(range.error, 6)} measured=${f(maxErr, 6)}`);
  }

  const pcm = worldPrecisionCm();
  console.log(`  position precision: x=${f(pcm.x, 4)} cm  y=${f(pcm.y, 4)} cm  z=${f(pcm.z, 4)} cm` +
    `   (full position = ${DEFAULT_POSITION_FULL_BITS} bits)`);

  // endpoints exactly representable
  const r01 = makeRange(0, 1, 8);
  check('range endpoints are exact',
    dequantize(r01, quantize(r01, 0)) === 0 && dequantize(r01, quantize(r01, 1)) === 1);

  // out-of-range clamps rather than wraps
  const clamped = dequantize(DEFAULT_WORLD_BOUNDS.x, quantize(DEFAULT_WORLD_BOUNDS.x, 99999));
  check('out-of-bounds clamps to the world bound', clamped === DEFAULT_WORLD_BOUNDS.x.max,
    `${clamped}`);

  const derived = rangeForPrecision(-64, 64, 0.005);
  let dMax = 0;
  for (let i = 0; i < 50000; i++) {
    const v = rnd.range(-64, 64);
    dMax = Math.max(dMax, Math.abs(dequantize(derived, quantize(derived, v)) - v));
  }
  check('rangeForPrecision honours the request', dMax <= 0.005,
    `asked 5mm, got ${derived.bits} bits, measured ${f(dMax * 1000, 4)} mm`);
}

{
  const rnd = new Rand(SEED ^ 0x23);
  for (const bits of [ANGLE_BITS_PRECISE, ANGLE_BITS_COARSE]) {
    let maxErr = 0;
    for (let i = 0; i < 200000; i++) {
      const a = rnd.range(-Math.PI, Math.PI);
      const back = dequantizeAngle(quantizeAngle(a, bits), bits);
      let e = Math.abs(back - a);
      if (e > Math.PI) e = Math.PI * 2 - e; // wrap
      if (e > maxErr) maxErr = e;
    }
    const bound = angleError(bits);
    check(`angle(${bits}) within stated bound`, maxErr <= bound * (1 + 1e-9),
      `bound=${f(bound * 180 / Math.PI, 5)}deg measured=${f(maxErr * 180 / Math.PI, 5)}deg`);
  }
}

{
  const rnd = new Rand(SEED ^ 0x24);
  for (const bits of [10, 12]) {
    let maxErr = 0;
    for (let i = 0; i < 200000; i++) {
      // uniform random rotation (Shoemake)
      const u1 = rnd.next(), u2 = rnd.next(), u3 = rnd.next();
      const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
      const q = {
        x: s1 * Math.sin(2 * Math.PI * u2),
        y: s1 * Math.cos(2 * Math.PI * u2),
        z: s2 * Math.sin(2 * Math.PI * u3),
        w: s2 * Math.cos(2 * Math.PI * u3),
      };
      const back = unpackSmallestThree(packSmallestThree(q, bits), bits);
      const e = quatAngleBetween(q, back);
      if (e > maxErr) maxErr = e;
    }
    const bound = quatErrorRad(bits);
    check(`quat smallest-three (${bits} bits/comp, ${2 + 3 * bits} bits total)`,
      maxErr <= bound,
      `bound=${f(bound * 180 / Math.PI, 4)}deg measured=${f(maxErr * 180 / Math.PI, 4)}deg`);
  }
}

/* -------------------------------------------------------------------------- */
/* 3. schemas                                                                 */
/* -------------------------------------------------------------------------- */

section('3. Serialize — schema round-trip');

const registry = new SchemaRegistry();

const PlayerSchema = registry.register(
  defineSchema('player')
    .field('pos', C.position())
    .field('vel', C.velocity)
    .field('yaw', C.angleFine)
    .field('pitch', C.angleFine)
    .field('health', C.uint(8))
    .field('armor', C.uint(8))
    .field('weapon', C.enum(24))
    .field('stance', C.enum(4))
    .field('moveState', C.enum(8))
    .field('flags', C.flags(8))
    .field('team', C.enum(4))
    .field('score', C.uint(12))
    .build(),
);

const ProjectileSchema = registry.register(
  defineSchema('projectile')
    .field('pos', C.position())
    .field('vel', C.velocity)
    .field('rot', C.quat())
    .field('kind', C.enum(8))
    .field('fuse', C.scalar(0, 10, 10))
    .field('ownerId', C.uint(6))
    .build(),
);

const PickupSchema = registry.register(
  defineSchema('pickup')
    .field('pos', C.position())
    .field('kind', C.enum(16))
    .field('state', C.enum(4))
    .field('holder', C.optional(C.uint(6)))
    .build(),
);

console.log(`  registry: ${registry.size} schemas, protocolHash=0x${registry.protocolHash.toString(16)}`);
console.log(`  maxBits/entity: player=${PlayerSchema.maxBits} projectile=${ProjectileSchema.maxBits} pickup=${PickupSchema.maxBits}`);

{
  const rnd = new Rand(SEED ^ 0x31);
  const mk = () => ({
    pos: { x: rnd.range(-56, 56), y: rnd.range(0, 20), z: rnd.range(-56, 56) },
    vel: { x: rnd.range(-10, 10), y: rnd.range(-20, 10), z: rnd.range(-10, 10) },
    yaw: rnd.range(-Math.PI, Math.PI),
    pitch: rnd.range(-1.5, 1.5),
    health: rnd.int(0, 100),
    armor: rnd.int(0, 100),
    weapon: rnd.int(0, 23),
    stance: rnd.int(0, 3),
    moveState: rnd.int(0, 7),
    flags: rnd.int(0, 255),
    team: rnd.int(0, 3),
    score: rnd.int(0, 4095),
  });

  let worstPos = 0, worstVel = 0, worstAng = 0, exactBad = 0, sumBits = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const s = mk();
    const w = new BitWriter({ capacity: 64 });
    PlayerSchema.encode(w, s, null);
    sumBits += w.bitLength;
    const got = PlayerSchema.decode(new BitReader(w.toBytes()), null);
    worstPos = Math.max(worstPos,
      Math.abs(got.pos.x - s.pos.x), Math.abs(got.pos.y - s.pos.y), Math.abs(got.pos.z - s.pos.z));
    worstVel = Math.max(worstVel,
      Math.abs(got.vel.x - s.vel.x), Math.abs(got.vel.y - s.vel.y), Math.abs(got.vel.z - s.vel.z));
    let ay = Math.abs(got.yaw - s.yaw); if (ay > Math.PI) ay = 2 * Math.PI - ay;
    worstAng = Math.max(worstAng, ay, Math.abs(got.pitch - s.pitch));
    if (got.health !== s.health || got.weapon !== s.weapon || got.flags !== s.flags ||
        got.score !== s.score || got.team !== s.team || got.stance !== s.stance) exactBad++;
  }
  check('player full encode: lossless fields exact', exactBad === 0, `${exactBad} mismatches`);
  check('player full encode: position within 0.391 cm', worstPos <= DEFAULT_WORLD_BOUNDS.x.error,
    `measured ${f(worstPos * 100, 4)} cm`);
  check('player full encode: velocity within bound', worstVel <= DEFAULT_VELOCITY_RANGE.error,
    `measured ${f(worstVel * 1000, 4)} mm/s`);
  check('player full encode: angles within bound', worstAng <= angleError(ANGLE_BITS_PRECISE),
    `measured ${f(worstAng * 180 / Math.PI, 5)} deg`);
  console.log(`  full player snapshot = ${f(sumBits / N, 1)} bits (${f(sumBits / N / 8, 2)} bytes)`);
}

{
  // The invariant the whole delta scheme rests on: snapshot() is exactly what
  // the far end decodes, and it is idempotent.
  const rnd = new Rand(SEED ^ 0x32);
  let bad = 0, notIdempotent = 0;
  for (let i = 0; i < 5000; i++) {
    const s = {
      pos: { x: rnd.range(-56, 56), y: rnd.range(0, 20), z: rnd.range(-56, 56) },
      vel: { x: rnd.range(-10, 10), y: rnd.range(-20, 10), z: rnd.range(-10, 10) },
      rot: (() => {
        const u1 = rnd.next(), u2 = rnd.next(), u3 = rnd.next();
        const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
        return {
          x: s1 * Math.sin(2 * Math.PI * u2), y: s1 * Math.cos(2 * Math.PI * u2),
          z: s2 * Math.sin(2 * Math.PI * u3), w: s2 * Math.cos(2 * Math.PI * u3),
        };
      })(),
      kind: rnd.int(0, 7),
      fuse: rnd.range(0, 10),
      ownerId: rnd.int(0, 63),
    };
    const snapped = ProjectileSchema.snapshot(s);
    const w = new BitWriter({ capacity: 64 });
    ProjectileSchema.encode(w, s, null);
    const got = ProjectileSchema.decode(new BitReader(w.toBytes()), null);
    if (JSON.stringify(got) !== JSON.stringify(snapped)) bad++;

    // Same, one delta hop later: decode against a baseline must also land
    // exactly on snapshot() of the new raw state.
    const moved = {
      ...s,
      pos: { x: s.pos.x + rnd.signed() * 0.3, y: s.pos.y + rnd.signed() * 0.3, z: s.pos.z + rnd.signed() * 0.3 },
      vel: { x: s.vel.x + rnd.signed() * 0.5, y: s.vel.y - 0.49, z: s.vel.z + rnd.signed() * 0.5 },
      fuse: Math.max(0, s.fuse - 0.05),
    };
    const w2 = new BitWriter({ capacity: 64 });
    ProjectileSchema.encode(w2, moved, snapped);
    const got2 = ProjectileSchema.decode(new BitReader(w2.toBytes()), snapped);
    if (JSON.stringify(got2) !== JSON.stringify(ProjectileSchema.snapshot(moved))) notIdempotent++;
  }
  check('full encode: decode(encode(v)) === snapshot(v)', bad === 0, `${bad} mismatches`);
  check('delta encode: decode(encode(v, base)) === snapshot(v)', notIdempotent === 0,
    `${notIdempotent} mismatches`);
}

{
  // Field-level delta: unchanged fields must cost exactly one mask bit.
  const base = PlayerSchema.snapshot({
    pos: { x: 3, y: 1, z: -4 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0.5, pitch: 0, health: 100, armor: 50, weapon: 3,
    stance: 1, moveState: 2, flags: 0b1010, team: 1, score: 250,
  });
  const w0 = new BitWriter();
  const any0 = PlayerSchema.encode(w0, base, base);
  check('identical state encodes to the mask only',
    w0.bitLength === PlayerSchema.fields.length && any0 === false,
    `${w0.bitLength} bits for ${PlayerSchema.fields.length} fields`);

  const moved = { ...base, pos: { x: base.pos.x + 0.35, y: base.pos.y, z: base.pos.z + 0.2 } };
  const w1 = new BitWriter();
  PlayerSchema.encode(w1, moved, base);
  const got = PlayerSchema.decode(new BitReader(w1.toBytes()), base);
  const okDelta = Math.abs(got.pos.x - moved.pos.x) <= DEFAULT_WORLD_BOUNDS.x.error &&
                  Math.abs(got.pos.z - moved.pos.z) <= DEFAULT_WORLD_BOUNDS.z.error &&
                  got.health === base.health && got.yaw === base.yaw;
  check('walking player delta decodes correctly', okDelta,
    `${w1.bitLength} bits (vs ${PlayerSchema.maxBits} full)`);

  const teleported = { ...base, pos: { x: -400, y: 120, z: 380 } };
  const w2 = new BitWriter();
  PlayerSchema.encode(w2, teleported, base);
  const got2 = PlayerSchema.decode(new BitReader(w2.toBytes()), base);
  check('teleport falls back to full precision tier',
    Math.abs(got2.pos.x - (-400)) <= DEFAULT_WORLD_BOUNDS.x.error &&
    Math.abs(got2.pos.y - 120) <= DEFAULT_WORLD_BOUNDS.y.error &&
    Math.abs(got2.pos.z - 380) <= DEFAULT_WORLD_BOUNDS.z.error,
    `${w2.bitLength} bits`);
}

{
  // Schema drift detection.
  const a = new SchemaRegistry();
  a.register(defineSchema('e').field('pos', C.position()).field('hp', C.uint(8)).build());
  const b = new SchemaRegistry();
  b.register(defineSchema('e').field('pos', C.position()).field('hp', C.uint(7)).build());
  check('protocolHash detects a changed field width', a.protocolHash !== b.protocolHash,
    `0x${a.protocolHash.toString(16)} vs 0x${b.protocolHash.toString(16)}`);
  const c = new SchemaRegistry();
  c.register(defineSchema('e').field('pos', C.position()).field('hp', C.uint(8)).build());
  check('protocolHash is stable across identical declarations', a.protocolHash === c.protocolHash);
}

/* -------------------------------------------------------------------------- */
/* 4. realistic 24-entity match                                               */
/* -------------------------------------------------------------------------- */

section(`4. Delta — 24-entity match, ${TICKS} ticks @ ${HZ} Hz`);

const MAP_HALF = 56;

function buildWorld(seed) {
  const rnd = new Rand(seed);
  const ents = [];
  for (let i = 0; i < 12; i++) {
    ents.push({
      id: i + 1,
      schema: PlayerSchema,
      priority: 100,
      heading: rnd.range(-Math.PI, Math.PI),
      speed: rnd.range(2.5, 7),
      state: {
        pos: { x: rnd.range(-MAP_HALF, MAP_HALF), y: 0, z: rnd.range(-MAP_HALF, MAP_HALF) },
        vel: { x: 0, y: 0, z: 0 },
        yaw: rnd.range(-Math.PI, Math.PI),
        pitch: rnd.range(-0.4, 0.4),
        health: 100, armor: rnd.int(0, 100), weapon: rnd.int(0, 23),
        stance: 0, moveState: 1, flags: 0, team: i % 2, score: 0,
      },
    });
  }
  for (let i = 0; i < 8; i++) {
    ents.push({
      id: 100 + i,
      schema: ProjectileSchema,
      priority: 60,
      spin: rnd.range(2, 9),
      state: {
        pos: { x: rnd.range(-MAP_HALF, MAP_HALF), y: rnd.range(1, 12), z: rnd.range(-MAP_HALF, MAP_HALF) },
        vel: { x: rnd.range(-25, 25), y: rnd.range(-5, 15), z: rnd.range(-25, 25) },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        kind: rnd.int(0, 7),
        fuse: rnd.range(1, 9),
        ownerId: rnd.int(1, 12),
      },
    });
  }
  for (let i = 0; i < 4; i++) {
    ents.push({
      id: 200 + i,
      schema: PickupSchema,
      priority: 10,
      state: {
        pos: { x: rnd.range(-MAP_HALF, MAP_HALF), y: 0.5, z: rnd.range(-MAP_HALF, MAP_HALF) },
        kind: i, state: 0, holder: null,
      },
    });
  }
  return { rnd, ents };
}

function stepWorld(world, dt, tick) {
  const { rnd, ents } = world;
  for (const e of ents) {
    if (e.schema === PlayerSchema) {
      e.heading += rnd.signed() * 0.6 * dt;
      const sp = e.speed * (0.6 + 0.4 * Math.sin(tick * 0.05 + e.id));
      const vx = Math.cos(e.heading) * sp;
      const vz = Math.sin(e.heading) * sp;
      const p = e.state.pos;
      p.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, p.x + vx * dt));
      p.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, p.z + vz * dt));
      // occasional jump
      const jump = (tick + e.id * 7) % 97 === 0;
      p.y = jump ? 1.1 : Math.max(0, p.y - 6 * dt);
      e.state.vel.x = vx; e.state.vel.z = vz;
      e.state.vel.y = jump ? 4.5 : Math.max(-20, e.state.vel.y - 9.81 * dt);
      e.state.yaw = e.heading + rnd.signed() * 0.02;
      e.state.pitch = Math.max(-1.4, Math.min(1.4, e.state.pitch + rnd.signed() * 0.05));
      e.state.moveState = sp > 5 ? 2 : 1;
      if (tick % 53 === e.id % 53) e.state.health = Math.max(1, e.state.health - rnd.int(5, 25));
      if (tick % 311 === e.id % 311) { e.state.weapon = rnd.int(0, 23); e.state.score += 100; }
      e.state.flags = (e.state.flags & ~1) | (sp > 5 ? 1 : 0);
    } else if (e.schema === ProjectileSchema) {
      const p = e.state.pos, v = e.state.vel;
      v.y -= 9.81 * dt;
      p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
      if (p.y < 0.2) { p.y = 0.2; v.y = -v.y * 0.35; v.x *= 0.6; v.z *= 0.6; }
      p.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, p.x));
      p.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, p.z));
      const a = tick * 0.05 * e.spin;
      const s = Math.sin(a * 0.5), c = Math.cos(a * 0.5);
      e.state.rot = { x: s * 0.577, y: s * 0.577, z: s * 0.577, w: c };
      e.state.fuse = Math.max(0, e.state.fuse - dt);
    } else {
      if (tick % 200 === 0) e.state.state = (e.state.state + 1) % 4;
      if (tick % 400 === 0) e.state.holder = e.state.holder === null ? rnd.int(1, 12) : null;
    }
  }
}

function views(world) {
  return world.ents.map((e) => ({
    id: e.id, schema: e.schema, state: e.state, priority: e.priority,
  }));
}

/** Deep exact comparison of two replicated worlds. */
function worldsIdentical(expected, actual) {
  if (!expected || !actual) return 'missing world';
  if (expected.size !== actual.size) return `size ${expected.size} vs ${actual.size}`;
  for (const [id, ex] of expected) {
    const ac = actual.get(id);
    if (!ac) return `id ${id} missing`;
    if (ac.schema !== ex.schema) return `id ${id} schema differs`;
    for (const fd of ex.schema.fields) {
      const a = ex.state[fd.key], b = ac.state[fd.key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        return `id ${id} field ${fd.key}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
      }
    }
  }
  return null;
}

/**
 * Runs the match through an encoder/decoder pair over a channel with
 * `latencyTicks` one-way delay and `loss` packet loss.
 */
function runMatch({ latencyTicks = 2, loss = 0, maxBytes = undefined, label }) {
  const world = buildWorld(SEED);
  const enc = new DeltaEncoder({ historyTicks: 64, registry });
  const dec = new DeltaDecoder({ historyTicks: 64, registry });
  const rnd = new Rand(SEED ^ 0x99);
  const meter = new BandwidthMeter(TICKS + 8);
  const dt = 1 / HZ;

  const inFlight = [];   // { arriveTick, bytes }
  const ackFlight = [];  // { arriveTick, tick }

  let baselines = 0;
  let dropped = 0;
  let decodeErrors = 0;
  let divergence = null;
  let checkedTicks = 0;
  let budgetTicks = 0;
  let maxPacket = 0;
  let firstDeltaBytes = 0;
  let baselineBytes = 0;

  for (let tick = 0; tick < TICKS; tick++) {
    stepWorld(world, dt, tick);

    // deliver acks that have arrived
    for (let i = ackFlight.length - 1; i >= 0; i--) {
      if (ackFlight[i].arriveTick <= tick) { enc.ack(ackFlight[i].tick); ackFlight.splice(i, 1); }
    }

    const w = new BitWriter({ capacity: 1400 });
    const res = enc.encode(w, tick, views(world), maxBytes !== undefined ? { maxBytes } : {});
    const bytes = w.toBytes();
    if (res.isBaseline) { baselines++; if (!baselineBytes) baselineBytes = bytes.length; }
    else if (!firstDeltaBytes) firstDeltaBytes = bytes.length;
    if (res.budgetExceeded) budgetTicks++;
    if (maxBytes !== undefined && bytes.length > maxBytes + 8) {
      divergence = divergence || `budget breach: ${bytes.length} > ${maxBytes}`;
    }
    meter.add(bytes.length);
    maxPacket = Math.max(maxPacket, bytes.length);

    if (loss > 0 && rnd.next() < loss) { dropped++; }
    else inFlight.push({ arriveTick: tick + latencyTicks, bytes, tick });

    // deliver packets
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].arriveTick > tick) continue;
      const pkt = inFlight[i];
      inFlight.splice(i, 1);
      const snap = dec.decode(new BitReader(pkt.bytes));
      if (!snap) { decodeErrors++; continue; }
      ackFlight.push({ arriveTick: tick + latencyTicks, tick: snap.tick });

      const expected = enc.expectedView(snap.tick);
      const diff = worldsIdentical(expected, snap.entities);
      checkedTicks++;
      if (diff && !divergence) divergence = `tick ${snap.tick}: ${diff}`;
    }
  }

  return { enc, dec, meter, baselines, dropped, decodeErrors, divergence, checkedTicks,
    budgetTicks, maxPacket, baselineBytes, firstDeltaBytes, label };
}

{
  const r = runMatch({ latencyTicks: 2, loss: 0, label: 'clean' });
  const mean = r.meter.mean;
  console.log(`  baseline (full) snapshot .... ${r.baselineBytes} bytes`);
  console.log(`  delta snapshot mean ......... ${f(mean, 1)} bytes  (${f(mean / 24, 2)} bytes/entity)`);
  console.log(`  delta snapshot p50 / p95 .... ${r.meter.percentile(0.5)} / ${r.meter.percentile(0.95)} bytes`);
  console.log(`  delta snapshot max .......... ${r.maxPacket} bytes`);
  console.log(`  downstream per client ....... ${f(kbitPerSecond(mean, HZ), 1)} kbit/s @ ${HZ} Hz`);
  console.log(`                                ${f(kbitPerSecond(mean, 30), 1)} kbit/s @ 30 Hz`);
  console.log(`  host upstream, 12 clients ... ${f(kbitPerSecond(mean, HZ) * 12 / 1000, 2)} Mbit/s @ ${HZ} Hz`);
  const naive = (12 * 12 + 8 * 6 + 4 * 4) * 4; // every field as a float32/int32
  console.log(`  naive float32 equivalent .... ${naive} bytes  =>  ${f(mean / naive * 100, 1)}% of naive`);
  console.log(`  baselines sent .............. ${r.baselines}   decode errors: ${r.decodeErrors}`);

  check('no divergence between host and client baselines over the match',
    r.divergence === null, r.divergence || `${r.checkedTicks} snapshots compared bit-exactly`);
  check('exactly one baseline snapshot on a clean link', r.baselines === 1, `${r.baselines}`);
  check('no decode errors on a clean link', r.decodeErrors === 0, `${r.decodeErrors}`);
  check('delta beats naive float32 encoding by >4x', mean * 4 < naive,
    `${f(naive / mean, 1)}x smaller`);
}

/* -------------------------------------------------------------------------- */
/* 5. packet loss                                                             */
/* -------------------------------------------------------------------------- */

section('5. Delta — 20% packet loss, 100 ms RTT');

{
  const r = runMatch({ latencyTicks: 1, loss: 0.2, label: 'lossy' });
  console.log(`  packets dropped ............. ${r.dropped}`);
  console.log(`  baselines re-sent ........... ${r.baselines}`);
  console.log(`  decode errors ............... ${r.decodeErrors}`);
  console.log(`  mean snapshot ............... ${f(r.meter.mean, 1)} bytes ` +
    `(${f(kbitPerSecond(r.meter.mean, HZ), 1)} kbit/s)`);
  check('lossy link never diverges', r.divergence === null,
    r.divergence || `${r.checkedTicks} snapshots compared bit-exactly`);
  check('lossy link decodes every delivered packet', r.decodeErrors === 0, `${r.decodeErrors}`);
  check('recovers without spamming baselines', r.baselines <= 3, `${r.baselines} baselines`);
}

/* -------------------------------------------------------------------------- */
/* 6. bandwidth budget                                                        */
/* -------------------------------------------------------------------------- */

section('6. Delta — hard 200-byte budget');

{
  const r = runMatch({ latencyTicks: 2, loss: 0, maxBytes: 200, label: 'budget' });
  console.log(`  ticks that hit the cap ...... ${r.budgetTicks} / ${TICKS}`);
  console.log(`  largest packet .............. ${r.maxPacket} bytes (cap 200)`);
  console.log(`  mean snapshot ............... ${f(r.meter.mean, 1)} bytes`);
  check('budget is respected', r.maxPacket <= 208, `${r.maxPacket} bytes`);
  check('budget-limited stream still never diverges', r.divergence === null,
    r.divergence || `${r.checkedTicks} snapshots compared bit-exactly`);
  check('budget-limited stream has no decode errors', r.decodeErrors === 0, `${r.decodeErrors}`);
}

{
  // Tight cap: priority must decide who gets through.
  const world = buildWorld(SEED);
  const enc = new DeltaEncoder({ historyTicks: 64, registry });
  const w = new BitWriter({ capacity: 1400 });
  const res = enc.encode(w, 0, views(world), { maxBytes: 60 });
  const wroteHighPriority = res.entitiesWritten > 0;
  const dec = new DeltaDecoder({ registry });
  const snap = dec.decode(new BitReader(w.toBytes()));
  let allPlayers = true;
  if (snap) for (const [, e] of snap.entities) if (e.schema !== PlayerSchema) allPlayers = false;
  check('under a 60-byte cap only the highest-priority entities are sent',
    wroteHighPriority && allPlayers && res.entitiesSkipped > 0,
    `wrote ${res.entitiesWritten}, skipped ${res.entitiesSkipped}, ${w.toBytes().length} bytes`);
}

/* -------------------------------------------------------------------------- */
/* 7. hostile input                                                           */
/* -------------------------------------------------------------------------- */

section('7. Robustness — corrupt and hostile packets');

{
  const world = buildWorld(SEED);
  const enc = new DeltaEncoder({ historyTicks: 64, registry });
  const w = new BitWriter({ capacity: 1400 });
  enc.encode(w, 0, views(world), {});
  const good = w.toBytes();

  const rnd = new Rand(SEED ^ 0x77);
  let threw = 0, decoded = 0, rejected = 0;
  for (let i = 0; i < 5000; i++) {
    const copy = good.slice(0, rnd.int(1, good.length));
    const flips = rnd.int(1, 24);
    for (let k = 0; k < flips; k++) {
      const b = rnd.int(0, copy.length - 1);
      copy[b] ^= 1 << rnd.int(0, 7);
    }
    const dec = new DeltaDecoder({ registry });
    try {
      const s = dec.decode(new BitReader(copy));
      if (s) decoded++; else rejected++;
    } catch (err) {
      threw++;
    }
  }
  check('5000 corrupted packets never throw', threw === 0,
    `decoded=${decoded} rejected=${rejected} threw=${threw}`);

  let threw2 = 0;
  for (let i = 0; i < 5000; i++) {
    const n = rnd.int(0, 400);
    const buf = new Uint8Array(n);
    for (let k = 0; k < n; k++) buf[k] = rnd.int(0, 255);
    const dec = new DeltaDecoder({ registry });
    try { dec.decode(new BitReader(buf)); } catch { threw2++; }
  }
  check('5000 random-garbage packets never throw', threw2 === 0, `${threw2} throws`);

  // A peer on a different build must be refused, not silently misread.
  const other = new SchemaRegistry();
  other.register(defineSchema('player').field('pos', C.position()).field('hp', C.uint(8)).build());
  const dec = new DeltaDecoder({ registry: other });
  const got = dec.decode(new BitReader(good));
  check('baseline from a mismatched build is rejected',
    got === null && dec.lastError === 'protocol-mismatch', `lastError=${dec.lastError}`);
}

/* -------------------------------------------------------------------------- */
/* 8. determinism                                                             */
/* -------------------------------------------------------------------------- */

section('8. Determinism');

{
  const a = runMatch({ latencyTicks: 2, loss: 0.15, label: 'det-a' });
  const b = runMatch({ latencyTicks: 2, loss: 0.15, label: 'det-b' });
  check('two runs with the same seed produce identical byte totals',
    a.meter.total === b.meter.total && a.dropped === b.dropped,
    `${a.meter.total} bytes / ${a.dropped} drops both runs`);
}

/* -------------------------------------------------------------------------- */
/* 9. join under loss — the cost of betting on an unacked baseline             */
/* -------------------------------------------------------------------------- */

section('9. Join with the first baselines dropped');

/**
 * The encoder assumes an unacked baseline arrived and deltas against it. This
 * is the case where that bet is WRONG: the first `dropFirst` packets are lost,
 * so the client holds nothing and every delta against the lost baseline is
 * undecodable. It must recover in bounded time and never, ever diverge.
 */
function runJoinLoss(dropFirst, retry) {
  const world = buildWorld(SEED);
  const enc = new DeltaEncoder({ historyTicks: 64, registry, baselineRetryTicks: retry });
  const dec = new DeltaDecoder({ historyTicks: 64, registry });
  const dt = 1 / HZ;
  const lat = 2;
  const inFlight = [], ackFlight = [];
  let wasted = 0, baselines = 0, syncTick = -1, divergence = null, checked = 0, bytes = 0;

  for (let tick = 0; tick < 200; tick++) {
    stepWorld(world, dt, tick);
    for (let i = ackFlight.length - 1; i >= 0; i--) {
      if (ackFlight[i].arriveTick <= tick) { enc.ack(ackFlight[i].tick); ackFlight.splice(i, 1); }
    }
    const w = new BitWriter({ capacity: 1400 });
    const res = enc.encode(w, tick, views(world));
    const pkt = w.toBytes();
    bytes += pkt.length;
    if (res.isBaseline) baselines++;
    if (tick >= dropFirst) inFlight.push({ arriveTick: tick + lat, bytes: pkt });

    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].arriveTick > tick) continue;
      const p = inFlight[i]; inFlight.splice(i, 1);
      const snap = dec.decode(new BitReader(p.bytes));
      if (!snap) { wasted++; continue; }         // undecodable: client stays silent
      if (syncTick < 0) syncTick = snap.tick;
      ackFlight.push({ arriveTick: tick + lat, tick: snap.tick });
      const diff = worldsIdentical(enc.expectedView(snap.tick), snap.entities);
      checked++;
      if (diff && !divergence) divergence = `tick ${snap.tick}: ${diff}`;
    }
  }
  return { wasted, baselines, syncTick, divergence, checked, bytes };
}

{
  const r = runJoinLoss(3, 8);
  console.log(`  first 3 packets dropped, retry=8`);
  console.log(`  undecodable packets ......... ${r.wasted}`);
  console.log(`  baselines sent .............. ${r.baselines}`);
  console.log(`  client synced at tick ....... ${r.syncTick}`);
  check('a lost join baseline still syncs the client', r.syncTick >= 0, `tick ${r.syncTick}`);
  check('recovery is bounded by baselineRetryTicks', r.syncTick <= 3 + 8 + 1, `tick ${r.syncTick}`);
  check('a wrong bet wastes only the undecodable window', r.wasted <= 8, `${r.wasted} packets`);
  check('never diverges after recovering from a lost baseline',
    r.divergence === null, r.divergence || `${r.checked} snapshots bit-exact`);

  // The whole point of the optimism: a clean join must cost exactly one world.
  const clean = runJoinLoss(0, 8);
  check('a clean join costs exactly one full world', clean.baselines === 1,
    `${clean.baselines} baselines`);
  // retry=0 disables the bet: a full world every tick until the first ack.
  // That is the cost the optimism removes, and it scales with RTT.
  const spammy = runJoinLoss(0, 0);
  const saved = spammy.bytes - clean.bytes;
  console.log(`  join burst, 4-tick RTT: optimistic=${clean.baselines} baseline(s), ` +
    `pessimistic=${spammy.baselines}`);
  console.log(`  bytes saved per joining client .. ${saved}` +
    `   (12 clients at match start: ${(saved * 12 / 1024).toFixed(1)} KiB)`);
  check('optimism removes the per-RTT baseline burst', clean.baselines === 1 && spammy.baselines > 1,
    `${clean.baselines} vs ${spammy.baselines} baselines`);
  check('pessimistic mode never hands out an undecodable delta', spammy.wasted === 0,
    `${spammy.wasted} wasted`);
}

/* -------------------------------------------------------------------------- */

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed) {
  for (const n of failures) console.log(`  - ${n}`);
  process.exit(1);
}
