/**
 * Deterministic scripted input for headless prediction tests.
 *
 * Drives the real `input` singleton so the test exercises the real
 * `CommandBuilder` path — including toggle resolution and edge detection —
 * rather than hand-building commands and proving only that the parts we wrote
 * for the test agree with each other.
 *
 * Every value comes from a seeded `Rand`, so two runs at different latencies are
 * driven by byte-identical input and the only variable is the network.
 */

import { Rand } from '../../../core/Rand';
import { input } from '../../../core/Input';
import type { Action } from '../../../core/Input';

export interface ScriptedSample {
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
  actions: Action[];
}

/** Actions the script can hold, so releases are exhaustive. */
const SCRIPT_ACTIONS: readonly Action[] = ['jump', 'crouch', 'sprint', 'ads', 'leanLeft', 'leanRight', 'prone'];

/**
 * A repeatable movement program: strafing, direction reversals, sprint bursts,
 * jumps, crouch-slides and a look sweep. Exercises every branch of the movement
 * state machine, which is where prediction bugs actually live — nobody
 * mispredicts walking in a straight line.
 */
export function makeMovementScript(seed: number | string = 'prediction-script'): (tick: number, hz: number) => ScriptedSample {
  const rand = new Rand(seed);
  // Pre-roll a few hundred phase offsets so the motion is varied but fixed.
  const phase = new Float64Array(16);
  for (let i = 0; i < phase.length; i++) phase[i] = rand.range(0, Math.PI * 2);

  return (tick: number, hz: number): ScriptedSample => {
    const t = tick / hz;
    const moveY = Math.cos(t * 0.9 + phase[0]) > -0.25 ? 1 : -1;
    const moveX = Math.sin(t * 1.7 + phase[1]) > 0.35 ? 1
      : Math.sin(t * 1.7 + phase[1]) < -0.35 ? -1 : 0;

    const actions: Action[] = [];
    // Sprint in bursts of roughly a second.
    if (Math.sin(t * 1.1 + phase[2]) > 0.1) actions.push('sprint');
    // Jump for two ticks every ~1.7 s.
    const jumpPhase = (t * 0.59 + phase[3] / 6.283) % 1;
    if (jumpPhase < 0.02) actions.push('jump');
    // Crouch — combined with sprint this triggers slides.
    if (Math.sin(t * 0.77 + phase[4]) > 0.72) actions.push('crouch');
    if (Math.sin(t * 0.41 + phase[5]) > 0.93) actions.push('ads');
    if (Math.sin(t * 0.53 + phase[6]) > 0.88) actions.push('leanRight');

    return {
      moveX, moveY,
      yaw: Math.sin(t * 0.31 + phase[7]) * 2.4,
      pitch: Math.sin(t * 0.23 + phase[8]) * 0.4,
      actions,
    };
  };
}

/** Writes a sample into the shared input singleton. */
export function applyScriptedSample(sample: ScriptedSample): void {
  const release: Action[] = [];
  for (const a of SCRIPT_ACTIONS) {
    if (!sample.actions.includes(a)) release.push(a);
  }
  input.inject({
    moveX: sample.moveX,
    moveY: sample.moveY,
    hold: sample.actions,
    release,
  });
}

/** Clears everything the script may have latched. */
export function clearScriptedInput(): void {
  input.inject({ moveX: 0, moveY: 0, release: [...SCRIPT_ACTIONS] });
}
