/**
 * Motion primitives.
 *
 * The HUD's character comes almost entirely from how things arrive and leave, so
 * every animated quantity goes through one of these rather than a linear lerp:
 *
 *   Spring   — physical second-order response; overshoots and settles.
 *   Envelope — attack/decay curve for one-shot punches (hit markers, banners).
 *   Ticker   — numeric readouts that roll toward a target with a punch on change.
 *
 * All of them are allocation-free once constructed and are integrated with a
 * semi-implicit Euler step that is stable at any frame rate (sub-stepped when the
 * frame is long).
 */

/* ------------------------------------------------------------- easings ---- */

export const Ease = {
  linear: (t: number): number => t,
  inQuad: (t: number): number => t * t,
  outQuad: (t: number): number => t * (2 - t),
  inOutQuad: (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number): number => t * t * t,
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t: number): number => 1 - Math.pow(1 - t, 4),
  outQuint: (t: number): number => 1 - Math.pow(1 - t, 5),
  outExpo: (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t: number): number => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const p = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * p) + 1;
  },
  /** Sharp attack, long tail — the shape most HUD punches want. */
  punch: (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 0;
    return Math.pow(1 - t, 2.2) * Math.sin(t * Math.PI * 0.9) * 2.4;
  },
  /** 0→1→0 hump. */
  bump: (t: number): number => {
    if (t <= 0 || t >= 1) return 0;
    return Math.sin(t * Math.PI);
  },
} as const;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return b === a ? 0 : clamp01((v - a) / (b - a));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `lambda` is 1/e per second. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Shortest signed angular difference in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* -------------------------------------------------------- reduced motion -- */

/**
 * Global motion scalar. 1 = full choreography, 0 = accessibility mode where
 * everything cuts instead of moving. Widgets multiply travel distances and
 * overshoot by this; durations are shortened by `motionTime()`.
 */
let motionAmount = 1;

export function setMotionAmount(v: number): void { motionAmount = clamp01(v); }
export function motion(): number { return motionAmount; }
/** Scales a duration: reduced motion makes transitions fast but not instant. */
export function motionTime(seconds: number): number {
  return seconds * (0.28 + 0.72 * motionAmount);
}

/* -------------------------------------------------------------- spring ---- */

export interface SpringConfig {
  /** Natural frequency in Hz-ish units. Higher = snappier. */
  stiffness: number;
  /** 1 = critically damped, <1 overshoots, >1 sluggish. */
  damping: number;
}

export const SPRING = {
  /** Crisp UI motion with a hint of overshoot. */
  snappy: { stiffness: 220, damping: 0.72 } as SpringConfig,
  /** Weighty panels. */
  heavy: { stiffness: 90, damping: 0.9 } as SpringConfig,
  /** Bouncy, for rewards. */
  pop: { stiffness: 340, damping: 0.5 } as SpringConfig,
  /** No overshoot — tracking values like crosshair spread. */
  tight: { stiffness: 300, damping: 1.0 } as SpringConfig,
} as const;

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  stiffness: number;
  damping: number;

  constructor(initial = 0, cfg: SpringConfig = SPRING.snappy) {
    this.value = initial;
    this.target = initial;
    this.stiffness = cfg.stiffness;
    this.damping = cfg.damping;
  }

  configure(cfg: SpringConfig): this {
    this.stiffness = cfg.stiffness;
    this.damping = cfg.damping;
    return this;
  }

  /** Jumps without animating. */
  set(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  to(v: number): void { this.target = v; }

  /** Adds an instantaneous velocity impulse — the "punch". */
  kick(v: number): void { this.velocity += v * motionAmount; }

  step(dt: number): number {
    if (motionAmount <= 0.001) { this.value = this.target; this.velocity = 0; return this.value; }
    // Sub-step so a stiff spring stays stable through a long frame.
    const maxStep = 1 / 120;
    let remaining = dt > 0.25 ? 0.25 : dt;
    const k = this.stiffness;
    const c = 2 * this.damping * Math.sqrt(k);
    while (remaining > 0) {
      const h = remaining > maxStep ? maxStep : remaining;
      remaining -= h;
      const a = (this.target - this.value) * k - this.velocity * c;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }

  get settled(): boolean {
    return this.value === this.target && this.velocity === 0;
  }
}

/* ------------------------------------------------------------ envelope ---- */

/**
 * A one-shot attack/hold/release envelope. `fire()` restarts it; `level` is the
 * 0..1 output, shaped by the supplied curves.
 */
export class Envelope {
  t = -1;
  constructor(
    public attack = 0.06,
    public hold = 0.12,
    public release = 0.35,
    public attackEase: (t: number) => number = Ease.outQuart,
    public releaseEase: (t: number) => number = Ease.outCubic,
  ) { }

  fire(): void { this.t = 0; }
  stop(): void { this.t = -1; }
  get active(): boolean { return this.t >= 0; }

  step(dt: number): number {
    if (this.t < 0) return 0;
    this.t += dt;
    const a = motionTime(this.attack);
    const h = motionTime(this.hold);
    const r = motionTime(this.release);
    if (this.t >= a + h + r) { this.t = -1; return 0; }
    return this.level;
  }

  get level(): number {
    if (this.t < 0) return 0;
    const a = motionTime(this.attack);
    const h = motionTime(this.hold);
    const r = motionTime(this.release);
    if (this.t < a) return this.attackEase(a <= 0 ? 1 : this.t / a);
    if (this.t < a + h) return 1;
    return 1 - this.releaseEase(r <= 0 ? 1 : (this.t - a - h) / r);
  }

  /** Normalised progress across the whole envelope, for scale/blur ramps. */
  get progress(): number {
    if (this.t < 0) return 1;
    const total = motionTime(this.attack + this.hold + this.release);
    return total <= 0 ? 1 : clamp01(this.t / total);
  }
}

/* -------------------------------------------------------------- ticker ---- */

/**
 * A numeric readout that rolls toward its target and punches when it changes.
 * Used by the ammo counter and the XP tally.
 */
export class Ticker {
  display: number;
  target: number;
  readonly punch = new Spring(0, SPRING.pop);
  /** −1 when the last change decreased the value, +1 when it increased. */
  direction = 0;
  private rate: number;

  constructor(initial = 0, ratePerSecond = 90) {
    this.display = initial;
    this.target = initial;
    this.rate = ratePerSecond;
  }

  set(v: number, instant = false): void {
    if (v === this.target) return;
    this.direction = v > this.target ? 1 : -1;
    this.target = v;
    if (instant) this.display = v;
    this.punch.kick(this.direction > 0 ? 26 : 20);
  }

  step(dt: number): number {
    this.punch.to(0);
    this.punch.step(dt);
    const diff = this.target - this.display;
    if (diff === 0) return this.display;
    const step = Math.max(1, Math.abs(diff) * 0.5, this.rate * dt);
    if (Math.abs(diff) <= step) this.display = this.target;
    else this.display += Math.sign(diff) * step;
    return this.display;
  }
}

/* --------------------------------------------------------------- pools ---- */

/**
 * Fixed-capacity pool of reusable records. HUD widgets allocate their working
 * set once at construction and never again, so the GC never runs mid-firefight.
 */
export class Pool<T> {
  readonly items: T[];
  constructor(capacity: number, make: () => T, private reset: (item: T) => void) {
    this.items = new Array<T>(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = make();
  }

  /** Returns the first inactive item (per the caller's own predicate), or the oldest. */
  acquire(isFree: (item: T) => boolean, olderThan: (a: T, b: T) => boolean): T {
    let oldest = this.items[0];
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (isFree(it)) { this.reset(it); return it; }
      if (olderThan(it, oldest)) oldest = it;
    }
    this.reset(oldest);
    return oldest;
  }
}
