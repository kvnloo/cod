/**
 * Audio contract.
 *
 * The rest of the game talks to audio through the event bus; this interface
 * exists for the two things the bus cannot express: the level publishing its
 * reverb zones, and debug/capture tooling asking the mixer what it is doing.
 */

import type { Vector3 } from 'three';

/** Mixer categories. Each is a bus with its own compressor and duck behaviour. */
export type BusName =
  | 'weapon' | 'impact' | 'explosion' | 'foley' | 'voice'
  | 'ambience' | 'music' | 'ui' | 'reverb' | 'deaf';

/** Procedurally generated impulse responses available to the reverb rack. */
export type ImpulseId =
  | 'smallRoom'
  | 'largeHall'
  | 'streetCanyon'
  | 'indoorConcrete'
  | 'openField'
  | 'tunnel'
  | 'stairwell';

export interface ImpulseSpec {
  id: ImpulseId;
  /** Broadband RT60 in seconds. */
  rt60: number;
  /** Gap before the first reflection, seconds. */
  predelay: number;
  /** Per-band RT60 multipliers: [low, lowMid, highMid, high]. */
  bandDecay: [number, number, number, number];
  /** Discrete early reflections: [time s, gain, pan −1..1]. */
  early: Array<[number, number, number]>;
  /** Density of the diffuse tail, 0..1 (open field is sparse, hall is dense). */
  density: number;
  /** Overall wet level this environment justifies. */
  wet: number;
  /** Flutter-echo period in seconds, 0 for none (concrete corridors have one). */
  flutter: number;
  /** Stereo width of the tail, 0..1. */
  width: number;
  /** Extra lowpass on the whole tail — outdoors is darker at a distance. */
  tone: number;
}

/** A world-space box that selects an impulse response. */
export interface ReverbZoneDesc {
  id: string;
  ir: ImpulseId;
  /** Box centre. */
  center: [number, number, number];
  /** Box half-extents. */
  half: [number, number, number];
  /** Blend distance outside the box over which the zone fades in, metres. */
  feather?: number;
  /** Wet-level multiplier for this specific zone. */
  wet?: number;
  /** Higher wins when boxes overlap. */
  priority?: number;
}

export type Gait = 'walk' | 'run' | 'sprint' | 'crouch' | 'prone';

export interface AudioStats {
  running: boolean;
  contextState: string;
  sampleRate: number;
  activeVoices: number;
  peakVoices: number;
  starvedVoices: number;
  zone: string;
  irLoaded: number;
  bankBuffers: number;
  tension: number;
  deafness: number;
  cpuMs: number;
}

export interface AudioAPI {
  readonly ready: boolean;
  /** Web Audio needs a gesture on some platforms; safe to call repeatedly. */
  resume(): Promise<void>;
  /** Levels are 0..1 and multiply the settings-driven values. */
  setBusVolume(bus: BusName, value: number): void;
  /** Publishes the level's acoustic zoning. Replaces any previous set. */
  setReverbZones(zones: ReverbZoneDesc[]): void;
  /** Zone id under a world position, for tooling and AI awareness. */
  zoneAt(p: Vector3): string;
  /** Force the combat-tension parameter (0..1); the director may drive this. */
  setTension(v: number): void;
  stats(): AudioStats;
}

/** How much of a source is blocked by geometry, evaluated per voice. */
export interface OcclusionProbe {
  /** Returns 0 (clear) .. 1 (fully blocked). */
  (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): number;
}
