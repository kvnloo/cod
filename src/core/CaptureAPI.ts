/**
 * Deterministic capture contract.
 *
 * `tools/harness.mjs` drives the game exclusively through this interface. Every
 * automated screenshot, perf gate and visual-critique pass depends on it, so the
 * shape here is a hard contract: extend it, never break it.
 */

export interface ShotOptions {
  /** Override time of day in hours [0..24). */
  hour?: number;
  /** Override weather intensity [0..1]. */
  weather?: number;
  /** Field of view in degrees. */
  fov?: number;
  /** Force the view model (weapon) on or off. */
  viewModel?: boolean;
  /** Extra settle frames after the camera moves (temporal AA / volumetrics). */
  settle?: number;
}

export interface ShotDef {
  name: string;
  /** Human description used by critic agents to judge intent. */
  description: string;
  position: [number, number, number];
  /** Euler yaw/pitch in degrees. */
  yaw: number;
  pitch: number;
  fov?: number;
  hour?: number;
  viewModel?: boolean;
  /** Optional world setup executed before the frame is rendered. */
  setup?: () => void | Promise<void>;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
  jsHeapMb: number;
}

export interface ProfileResult {
  frames: number;
  durationMs: number;
  avgFps: number;
  meanMs: number;
  p50: number;
  p95: number;
  p99: number;
  worstMs: number;
  gpuMeanMs: number;
  drawCalls: number;
  triangles: number;
}

export interface BlackoutCaptureAPI {
  /** Flipped true once the first fully-shaded frame has been presented. */
  readyFlag: boolean;
  version: string;
  listShots(): string[];
  shotInfo(name: string): ShotDef | null;
  setShot(name: string, opts?: ShotOptions): Promise<void>;
  /** Advance the fixed-step simulation without waiting on rAF. */
  step(frames: number, dt: number): Promise<void>;
  setHUD(on: boolean): void;
  setQuality(preset: string): void;
  stats(): FrameStats;
  beginProfile(): void;
  endProfile(): ProfileResult;
  /** Escape hatch for one-off automation; returns JSON-serialisable data. */
  probe(key: string, arg?: unknown): unknown;
  /**
   * Injects synthetic input, then advances `frames` steps. Lets the harness
   * capture action moments — firing, aiming, sprinting — deterministically.
   */
  act(steps: ScriptedStep[]): Promise<void>;
}

/** One beat of a scripted capture sequence. */
export interface ScriptedStep {
  /** Actions to hold for the duration of this step. */
  hold?: string[];
  /** Actions to press once at the start of this step. */
  press?: string[];
  /** Mouse delta applied each frame of this step. */
  lookX?: number;
  lookY?: number;
  /** Analog movement applied each frame, -1..1. */
  moveX?: number;
  moveY?: number;
  frames?: number;
  dt?: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __BLACKOUT__: BlackoutCaptureAPI | undefined;
}

export {};
