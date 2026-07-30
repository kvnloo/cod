/**
 * src/net/wire — the serialisation layer for the networking spine.
 *
 * Four pieces, bottom up:
 *
 *   BitWriter / BitReader   bit-granular framing. A bool costs 1 bit.
 *   Quantize                lossy-but-bounded numeric encoders with stated
 *                           error bounds (positions to 0.391 cm, rotations to
 *                           0.274 deg, angles to 0.00275 deg).
 *   Serialize               schema-driven codecs. Encode and decode are the same
 *                           loop over the same declared field list, so they
 *                           cannot drift apart.
 *   Delta                   snapshot delta compression against a client's last
 *                           acked snapshot, with baselines and a byte budget.
 *
 * Nothing in here knows about WebRTC, three.js, or the game. It is pure data:
 * the same code serialises for a peer host today and a headless dedicated
 * server later.
 *
 * Measured on a realistic 24-entity match (tools/net-wire.mjs):
 * see that script's output for bytes/snapshot and kbit/s at 20 Hz.
 */

export {
  BitWriter,
  type BitWriterOptions,
} from './BitWriter';

export { BitReader } from './BitReader';

export {
  type NetVec3,
  type NetQuat,
  type Range,
  type WorldBounds,
  type WorldBoundsOptions,
  type PackedQuat,
  TAU,
  ANGLE_BITS_COARSE,
  ANGLE_BITS_PRECISE,
  QUAT_BITS_DEFAULT,
  DEFAULT_WORLD_BOUNDS,
  DEFAULT_VELOCITY_RANGE,
  makeRange,
  rangeForPrecision,
  rangeSignature,
  quantize,
  dequantize,
  snapToRange,
  makeWorldBounds,
  worldPrecisionCm,
  wrapAngle,
  quantizeAngle,
  dequantizeAngle,
  snapAngle,
  angleError,
  packSmallestThree,
  unpackSmallestThree,
  snapQuat,
  quatErrorRad,
  quatAngleBetween,
} from './Quantize';

export {
  type Codec,
  type FieldDef,
  type AnySchema,
  type StateOf,
  type PositionCodecOptions,
  type TieredVec3Options,
  type AngleCodecOptions,
  C,
  Schema,
  SchemaBuilder,
  SchemaRegistry,
  defineSchema,
  registerSchema,
  schemaRegistry,
  hash32,
  encodeOne,
  decodeOne,
  boolCodec,
  uintCodec,
  intCodec,
  varUintCodec,
  varIntCodec,
  float32Codec,
  scalarCodec,
  rangeCodec,
  unormCodec,
  angleCodec,
  angleFineCodec,
  angleCoarseCodec,
  enumCodec,
  flagsCodec,
  stringCodec,
  positionCodec,
  defaultPositionCodec,
  DEFAULT_POSITION_FULL_BITS,
  tieredVec3Codec,
  vec3Codec,
  vec3RawCodec,
  velocityCodec,
  quatCodec,
  defaultQuatCodec,
  optionalCodec,
  arrayCodec,
} from './Serialize';

export {
  type EntitySnapshotView,
  type DeltaEncoderOptions,
  type EncodeOptions,
  type EncodeResult,
  type ReplicatedEntity,
  type DecodedEntity,
  type DecodedSnapshot,
  type DecodeError,
  type DeltaDecoderOptions,
  DeltaEncoder,
  DeltaDecoder,
  BandwidthMeter,
  kbitPerSecond,
} from './Delta';
