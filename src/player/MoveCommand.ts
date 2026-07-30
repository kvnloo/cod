/**
 * The input command — the only thing a client is allowed to send about itself.
 *
 * Everything the movement simulation needs for one fixed step lives here. The
 * server never trusts a client position; it re-runs `Movement.stepCommand` with
 * these commands and *that* result is the truth. Because the same struct drives
 * local prediction, reconciliation replay and the host, there is exactly one
 * movement code path (see `Movement.stepCommand`).
 *
 * Quantisation matters. The client quantises a command *before* predicting with
 * it, so the bits it predicts from are byte-identical to the bits the host
 * decodes. Skipping that step is the classic source of a permanent, tiny,
 * unfixable prediction error that shows up as jitter under load.
 */

/** Button bits. Held state, not edges — edges are derived by the simulation
 *  from the previous command so replay reproduces them exactly. */
export const BTN = {
  JUMP: 1 << 0,
  /** Already toggle-resolved by the client: the sim must never see a keybind. */
  CROUCH: 1 << 1,
  PRONE: 1 << 2,
  SPRINT: 1 << 3,
  ADS: 1 << 4,
  LEAN_L: 1 << 5,
  LEAN_R: 1 << 6,
  FIRE: 1 << 7,
  RELOAD: 1 << 8,
  MELEE: 1 << 9,
  USE: 1 << 10,
  GRENADE: 1 << 11,
  TACTICAL: 1 << 12,
  SWITCH: 1 << 13,
} as const;

export type ButtonMask = number;

export interface MoveCommand {
  /** Monotonic per-connection sequence number. Never reused. */
  seq: number;
  /** Client's estimate of the server tick this command should execute on. */
  tick: number;
  /** Duration of the step, seconds. Quantised to microseconds. */
  dt: number;
  /** Analog move intent, [-1..1], quantised to 1/127. */
  moveX: number;
  moveY: number;
  /** Absolute view angles at the moment the command was produced, radians. */
  yaw: number;
  pitch: number;
  buttons: ButtonMask;
}

export function createMoveCommand(): MoveCommand {
  return { seq: 0, tick: 0, dt: 1 / 120, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0 };
}

export function copyMoveCommand(dst: MoveCommand, src: MoveCommand): MoveCommand {
  dst.seq = src.seq;
  dst.tick = src.tick;
  dst.dt = src.dt;
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.buttons = src.buttons;
  return dst;
}

export function moveCommandsEqual(a: MoveCommand, b: MoveCommand): boolean {
  return a.seq === b.seq && a.tick === b.tick && a.dt === b.dt
    && a.moveX === b.moveX && a.moveY === b.moveY
    && a.yaw === b.yaw && a.pitch === b.pitch && a.buttons === b.buttons;
}

/* ------------------------------------------------------------ quantisation */

const TAU = Math.PI * 2;
/** Smallest and largest step a single command may represent, seconds. */
export const MIN_COMMAND_DT = 0.001;
export const MAX_COMMAND_DT = 0.065535;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** [-1..1] → 1/127 grid. */
export function quantizeAxis(v: number): number {
  return Math.round(clamp(v, -1, 1) * 127) / 127;
}

/** Radians → 16-bit angle grid over a full turn (0.0055 degrees). */
export function quantizeAngle(a: number): number {
  let x = a % TAU;
  if (x < 0) x += TAU;
  const q = Math.round((x / TAU) * 65536) & 0xffff;
  const out = (q / 65536) * TAU;
  return out > Math.PI ? out - TAU : out;
}

/** Seconds → whole microseconds, clamped to what the wire format can hold. */
export function quantizeDt(dt: number): number {
  return Math.round(clamp(dt, MIN_COMMAND_DT, MAX_COMMAND_DT) * 1e6) / 1e6;
}

/** Snaps a command onto the wire grid in place. Call before predicting. */
export function quantizeMoveCommand(cmd: MoveCommand): MoveCommand {
  cmd.dt = quantizeDt(cmd.dt);
  cmd.moveX = quantizeAxis(cmd.moveX);
  cmd.moveY = quantizeAxis(cmd.moveY);
  cmd.yaw = quantizeAngle(cmd.yaw);
  cmd.pitch = quantizeAngle(cmd.pitch);
  cmd.buttons = cmd.buttons >>> 0;
  return cmd;
}

/* ------------------------------------------------------------ wire format  */
/* A batch is header + N commands. Input is sent unreliably with the last few
 * commands repeated every packet, so a lost packet costs nothing as long as a
 * later one arrives — far cheaper than retransmission at these latencies. */

/** Bytes per command on the wire. */
export const COMMAND_BYTES = 10;
/** Bytes of batch header: baseSeq u32, baseTick u32, count u8. */
export const COMMAND_BATCH_HEADER_BYTES = 9;

export function commandBatchBytes(count: number): number {
  return COMMAND_BATCH_HEADER_BYTES + count * COMMAND_BYTES;
}

function angleToU16(a: number): number {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return Math.round((x / TAU) * 65536) & 0xffff;
}

function u16ToAngle(q: number): number {
  const out = (q / 65536) * TAU;
  return out > Math.PI ? out - TAU : out;
}

/**
 * Writes `count` commands starting at `offset`. Sequence and tick are stored
 * relative to the first command, so a batch costs 9 bytes of header no matter
 * how large the sequence numbers get. Returns the new offset.
 */
export function encodeCommandBatch(
  view: DataView, offset: number, cmds: readonly MoveCommand[], count: number,
): number {
  const n = Math.min(count, cmds.length, 255);
  const base = n > 0 ? cmds[0] : null;
  view.setUint32(offset, base ? base.seq >>> 0 : 0, true); offset += 4;
  view.setUint32(offset, base ? base.tick >>> 0 : 0, true); offset += 4;
  view.setUint8(offset, n); offset += 1;
  for (let i = 0; i < n; i++) {
    const c = cmds[i];
    view.setInt8(offset, Math.round(clamp(c.moveX, -1, 1) * 127)); offset += 1;
    view.setInt8(offset, Math.round(clamp(c.moveY, -1, 1) * 127)); offset += 1;
    view.setUint16(offset, angleToU16(c.yaw), true); offset += 2;
    view.setUint16(offset, angleToU16(c.pitch), true); offset += 2;
    view.setUint16(offset, c.buttons & 0xffff, true); offset += 2;
    view.setUint16(offset, Math.round(clamp(c.dt, MIN_COMMAND_DT, MAX_COMMAND_DT) * 1e6), true); offset += 2;
  }
  return offset;
}

/**
 * Reads a batch into `out` (grown as needed). Returns the number decoded;
 * `outOffset.value` is advanced past the batch.
 */
export function decodeCommandBatch(
  view: DataView, offset: number, out: MoveCommand[],
): { count: number; offset: number } {
  const baseSeq = view.getUint32(offset, true); offset += 4;
  const baseTick = view.getUint32(offset, true); offset += 4;
  const n = view.getUint8(offset); offset += 1;
  while (out.length < n) out.push(createMoveCommand());
  for (let i = 0; i < n; i++) {
    const c = out[i];
    c.seq = baseSeq + i;
    c.tick = baseTick + i;
    c.moveX = view.getInt8(offset) / 127; offset += 1;
    c.moveY = view.getInt8(offset) / 127; offset += 1;
    c.yaw = u16ToAngle(view.getUint16(offset, true)); offset += 2;
    c.pitch = u16ToAngle(view.getUint16(offset, true)); offset += 2;
    c.buttons = view.getUint16(offset, true); offset += 2;
    c.dt = view.getUint16(offset, true) / 1e6; offset += 2;
  }
  return { count: n, offset };
}
