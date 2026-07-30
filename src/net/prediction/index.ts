/**
 * Client-side prediction and server reconciliation.
 *
 * The authority boundary is a callback and a struct, not a class hierarchy:
 * the client hands finished commands to a `CommandSink` and receives
 * `AuthoritativeUpdate`s. Whether the other end of that boundary is a peer host
 * over a DataChannel, a headless Node process or a dedicated server is entirely
 * invisible from here, which is the point — moving the host later must not touch
 * gameplay code.
 */

export {
  InputBuffer,
} from './InputBuffer';

export {
  Predictor,
  type PredictorOptions,
} from './Predictor';

export {
  Reconciler,
} from './Reconciler';

export {
  AuthoritativeMovement,
  type AuthoritativeMovementOptions,
  type TickReport,
} from './AuthoritativeMovement';

export {
  ClientPrediction,
  type ClientPredictionOptions,
} from './ClientPrediction';

/* The seam between movement-space, authority-space and the wire. Bridge code
 * must go through these; a raw button mask crossing a boundary is a bug that
 * the type system cannot see. */
export {
  BUTTON_LAYOUT_HOST_EXT,
  HOST_EXT_BUTTON_MASK,
  TickSeqMap,
  authoritativeUpdateFromEntity,
  fromHostInput,
  fromNetInput,
  hostToPlayerButtons,
  movementFlags,
  movementStateFromEntity,
  netToPlayerButtons,
  playerToHostButtons,
  playerToNetButtons,
  toHostInput,
  toNetInput,
  writeEntityFromMovement,
} from './HostBridge';

/* The client's copy of the host tick clock. Stamping commands from the newest
 * snapshot tick instead of this is a measurable source of mispredictions. */
export {
  TickEstimator,
  type TickEstimatorOptions,
} from './TickEstimator';

/* The host's movement step: the identical state machine the client predicts. */
export {
  MovementStepper,
  type MovementStepperOptions,
  type MovementStepperStats,
} from './MovementStepper';

export {
  DEFAULT_RECONCILE_OPTIONS,
  createPredictionMetrics,
  resetPredictionMetrics,
  correctionsPerSecond,
  meanCorrectionMeters,
  meanAppliedCorrectionMeters,
  meanErrorMeters,
  meanReplayDepth,
  formatPredictionMetrics,
  type AuthoritativeUpdate,
  type CommandSink,
  type MovementSim,
  type PredictionMetrics,
  type ReconcileOptions,
  type ReconcileOutcome,
  type ReconcileResult,
} from './types';

/* Re-exported from src/player so the net layer is a single import site for
 * everything on the wire. These types are owned by the movement module. */
export {
  BTN,
  COMMAND_BYTES,
  COMMAND_BATCH_HEADER_BYTES,
  commandBatchBytes,
  createMoveCommand,
  copyMoveCommand,
  encodeCommandBatch,
  decodeCommandBatch,
  quantizeMoveCommand,
  type MoveCommand,
} from '../../player/MoveCommand';

export {
  MOVE_STATES,
  SURFACE_ORDER,
  createMovementState,
  copyMovementState,
  moveStateIndex,
  moveStateFromIndex,
  surfaceIndex,
  surfaceFromIndex,
  positionError,
  velocityError,
  type MovementState,
} from '../../player/MovementState';

export type { PlayerNetDriver } from '../../player/NetDriver';
