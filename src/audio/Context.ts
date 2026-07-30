/**
 * The bundle of services every sound-producing function needs.
 *
 * Passing this explicitly (rather than reaching for a module-level singleton)
 * is what lets the exact same synthesis code render into an
 * `OfflineAudioContext` for the numeric verification pass.
 */

import type { Rand } from '../core/Rand';
import type { Mixer } from './Mixer';
import type { VoicePool } from './Voices';
import type { ReverbRack } from './ReverbZones';
import type { SoundBank } from './Bank';

export interface SfxContext {
  ctx: BaseAudioContext;
  mixer: Mixer;
  pool: VoicePool;
  reverb: ReverbRack;
  bank: SoundBank;
  /** Deterministic stream. Never call `Math.random()`. */
  rand: Rand;
  /** True on the `low` preset: fewer layers, no convolution tails. */
  cheap: boolean;
  /** Scheduling clock. */
  now(): number;
}
