/**
 * The clip library.
 *
 * Locomotion cycles are *generated* from a small gait description — stride
 * angles, knee flexion envelope, pelvic rotation, vertical travel — rather than
 * typed out keyframe by keyframe. Real walk cycles are smooth functions of
 * phase, so writing them as functions and sampling at eight phases gives a
 * better cycle than hand-placed keys, and it means walk/run/sprint/crouch-walk
 * differ by a dozen numbers instead of a hundred.
 *
 * Every cycle uses the same phase convention: **phase 0 is left heel strike**,
 * phase 0.5 is right heel strike. That is what lets the blend tree cross-fade
 * walk into run without the feet skating or double-stepping.
 *
 * Everything else — deaths, hit reactions, cover poses, vaults — is authored
 * explicitly, because those are performances, not cycles.
 */

import { Clip, type ClipDef, type KeySpec, type PoseSpec } from './Clip';
import type { AnimName } from '../types';

/* ------------------------------------------------------------------- gaits */

interface Gait {
  name: string;
  duration: number;
  /** Metres covered per full cycle (two steps) — drives phase/speed sync. */
  stride: number;
  /** Thigh swing amplitude, degrees. */
  hip: number;
  /** Constant thigh bias (crouch/prone pull the legs under the body). */
  hipBias: number;
  /** Knee flexion in stance and at the peak of swing. */
  kneeStance: number;
  kneeSwing: number;
  /** Ankle angles at contact / toe-off. */
  ankleContact: number;
  ankleToeOff: number;
  /** Vertical travel of the pelvis, metres (peak-to-peak / 2). */
  bob: number;
  /** Pelvis yaw and roll amplitudes, degrees. */
  pelvisYaw: number;
  pelvisRoll: number;
  /** Forward lean of the chest, degrees. */
  lean: number;
  /** Base hip height offset (crouch). */
  hipDrop: number;
  /** Arm swing amplitude; 0 leaves the arms to the weapon IK layer. */
  armSwing: number;
  /** Constant elbow flexion while the arms swing. */
  elbow: number;
  /** Sideways foot placement, degrees of abduction. */
  stance: number;
  /** Lateral pelvis sway, metres. */
  sway: number;
}

const PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

/** Thigh pitch at phase p. Negative is forward. */
function thighAngle(g: Gait, p: number): number {
  return -g.hip * Math.cos(p * Math.PI * 2) + g.hipBias;
}

/**
 * Knee flexion at phase p: a small loading bend just after contact, near
 * extension through stance, and a big flexion peak in mid-swing.
 */
function kneeAngle(g: Gait, p: number): number {
  const swing = Math.max(0, Math.sin((p - 0.5) * Math.PI * 2));
  const load = Math.exp(-(((p - 0.12) / 0.10) ** 2));
  return g.kneeStance + g.kneeSwing * swing ** 1.35 + g.kneeStance * 0.9 * load;
}

/** Ankle pitch: dorsiflexed at contact, plantarflexed at toe-off, neutral in swing. */
function ankleAngle(g: Gait, p: number): number {
  const contact = Math.exp(-(((p - 0.02) / 0.09) ** 2)) + Math.exp(-(((p - 1.0) / 0.09) ** 2));
  const toeOff = Math.exp(-(((p - 0.47) / 0.09) ** 2));
  const swing = Math.exp(-(((p - 0.72) / 0.16) ** 2));
  return g.ankleContact * contact + g.ankleToeOff * toeOff - 6 * swing;
}

function toeAngle(g: Gait, p: number): number {
  return -Math.max(0, g.ankleToeOff) * 1.1 * Math.exp(-(((p - 0.50) / 0.07) ** 2));
}

function gaitClip(g: Gait): ClipDef {
  const keys: KeySpec[] = [];
  for (const p of PHASES) {
    const pl = p;                       // left leg phase
    const pr = (p + 0.5) % 1;           // right leg phase
    const pose: PoseSpec = {
      upperLegL: [thighAngle(g, pl), 0, g.stance],
      lowerLegL: [kneeAngle(g, pl), 0, 0],
      footL: [ankleAngle(g, pl) - thighAngle(g, pl) * 0.1, 3, 0],
      toeL: [toeAngle(g, pl), 0, 0],
      upperLegR: [thighAngle(g, pr), 0, -g.stance],
      lowerLegR: [kneeAngle(g, pr), 0, 0],
      footR: [ankleAngle(g, pr) - thighAngle(g, pr) * 0.1, -3, 0],
      toeR: [toeAngle(g, pr), 0, 0],
      // Pelvis counter-rotates against the shoulders; the spine takes half of it.
      hips: [g.lean * 0.15, -g.pelvisYaw * Math.cos(p * Math.PI * 2), g.pelvisRoll * Math.sin(p * Math.PI * 2)],
      spine: [g.lean * 0.35, g.pelvisYaw * 0.45 * Math.cos(p * Math.PI * 2), -g.pelvisRoll * 0.3 * Math.sin(p * Math.PI * 2)],
      chest: [g.lean * 0.5, g.pelvisYaw * 0.75 * Math.cos(p * Math.PI * 2), -g.pelvisRoll * 0.2 * Math.sin(p * Math.PI * 2)],
      neck: [-g.lean * 0.55, 0, 0],
      head: [-g.lean * 0.30, 0, 0],
    };
    if (g.armSwing > 0) {
      const sw = Math.cos(p * Math.PI * 2) * g.armSwing;
      pose.shoulderL = [0, 0, 6];
      pose.shoulderR = [0, 0, -6];
      pose.upperArmL = [sw, 0, 10];
      pose.upperArmR = [-sw, 0, -10];
      pose.lowerArmL = [-g.elbow - Math.max(0, sw) * 0.35, 0, 0];
      pose.lowerArmR = [-g.elbow - Math.max(0, -sw) * 0.35, 0, 0];
      pose.handL = [-12, 0, 0];
      pose.handR = [-12, 0, 0];
    }
    keys.push({
      t: p,
      pose,
      offset: {
        hips: [
          Math.sin(p * Math.PI * 2) * g.sway,
          g.hipDrop - g.bob * Math.cos(p * Math.PI * 4),
          0,
        ],
      },
      ease: 'sine',
    });
  }
  return { name: g.name, duration: g.duration, loop: true, keys };
}

const WALK: Gait = {
  name: 'walk', duration: 1.06, stride: 1.44,
  hip: 22, hipBias: 1, kneeStance: 6, kneeSwing: 52,
  ankleContact: -8, ankleToeOff: 20, bob: 0.022,
  pelvisYaw: 5, pelvisRoll: 4, lean: 3, hipDrop: -0.01,
  armSwing: 0, elbow: 0, stance: 2.0, sway: 0.018,
};

const RUN: Gait = {
  name: 'run', duration: 0.74, stride: 2.55,
  hip: 32, hipBias: 2, kneeStance: 12, kneeSwing: 78,
  ankleContact: -6, ankleToeOff: 26, bob: 0.040,
  pelvisYaw: 7, pelvisRoll: 5, lean: 9, hipDrop: -0.03,
  armSwing: 0, elbow: 0, stance: 2.2, sway: 0.020,
};

const SPRINT: Gait = {
  name: 'sprint', duration: 0.64, stride: 3.7,
  hip: 42, hipBias: 3, kneeStance: 15, kneeSwing: 96,
  ankleContact: -4, ankleToeOff: 30, bob: 0.052,
  pelvisYaw: 9, pelvisRoll: 5, lean: 17, hipDrop: -0.05,
  armSwing: 38, elbow: 78, stance: 2.5, sway: 0.024,
};

const CROUCH_WALK: Gait = {
  name: 'crouchWalk', duration: 1.30, stride: 1.10,
  hip: 15, hipBias: -34, kneeStance: 58, kneeSwing: 34,
  ankleContact: -4, ankleToeOff: 10, bob: 0.014,
  pelvisYaw: 3, pelvisRoll: 2, lean: 11, hipDrop: -0.235,
  armSwing: 0, elbow: 0, stance: 5, sway: 0.010,
};

/* --------------------------------------------------------- static postures */

/** Relaxed standing: weight on one leg, slow shift, feet slightly turned out. */
const IDLE: ClipDef = {
  name: 'idle', duration: 5.2, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        hips: [1, 2, 1.5], spine: [1, -1, -0.8], chest: [-2, -2, 0],
        neck: [1, 1, 0], head: [0, 2, 0],
        upperLegL: [-2, 3, 3], lowerLegL: [5, 0, 0], footL: [-2, 7, 0],
        upperLegR: [3, -4, -4], lowerLegR: [8, 0, 0], footR: [-4, -9, 0],
        shoulderL: [0, 0, 3], shoulderR: [0, 0, -3],
      },
      offset: { hips: [0.012, -0.014, 0] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        hips: [1, -2, -1.5], spine: [1, 1, 0.8], chest: [-2, 2, 0],
        neck: [1, -1, 0], head: [0, -2, 0],
        upperLegL: [3, 4, 4], lowerLegL: [8, 0, 0], footL: [-4, 9, 0],
        upperLegR: [-2, -3, -3], lowerLegR: [5, 0, 0], footR: [-2, -7, 0],
        shoulderL: [0, 0, 3], shoulderR: [0, 0, -3],
      },
      offset: { hips: [-0.012, -0.014, 0] },
    },
  ],
};

/** Alert stance: knees soft, weight forward, shoulders squared. */
const IDLE_ALERT: ClipDef = {
  name: 'idleAlert', duration: 3.4, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        hips: [3, 0, 0], spine: [2, 0, 0], chest: [-3, 0, 0], neck: [-1, 0, 0],
        upperLegL: [-8, 4, 4], lowerLegL: [15, 0, 0], footL: [-7, 8, 0],
        upperLegR: [-4, -6, -5], lowerLegR: [12, 0, 0], footR: [-8, -12, 0],
        shoulderL: [0, 0, 5], shoulderR: [0, 0, -5],
      },
      offset: { hips: [0, -0.045, 0.01] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        hips: [3, 1, 0.6], spine: [2, -0.5, 0], chest: [-3, -0.5, 0], neck: [-1, 0, 0],
        upperLegL: [-7, 4, 4], lowerLegL: [14, 0, 0], footL: [-6, 8, 0],
        upperLegR: [-5, -6, -5], lowerLegR: [13, 0, 0], footR: [-9, -12, 0],
        shoulderL: [0, 0, 5], shoulderR: [0, 0, -5],
      },
      offset: { hips: [0, -0.052, 0.012] },
    },
  ],
};

const CROUCH_IDLE: ClipDef = {
  name: 'crouchIdle', duration: 4.4, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        hips: [8, 0, 0], spine: [4, 0, 0], chest: [-6, 0, 0], neck: [-4, 0, 0], head: [-2, 0, 0],
        upperLegL: [-62, 4, 7], lowerLegL: [88, 0, 0], footL: [-26, 8, 0], toeL: [-4, 0, 0],
        upperLegR: [-58, -5, -9], lowerLegR: [95, 0, 0], footR: [-36, -10, 0], toeR: [-4, 0, 0],
        shoulderL: [0, 0, 4], shoulderR: [0, 0, -4],
      },
      offset: { hips: [0, -0.245, 0.03] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        hips: [8, 1, 0], spine: [4, 0, 0], chest: [-6, 0, 0], neck: [-4, 0, 0], head: [-2, 0, 0],
        upperLegL: [-60, 4, 7], lowerLegL: [86, 0, 0], footL: [-25, 8, 0], toeL: [-4, 0, 0],
        upperLegR: [-60, -5, -9], lowerLegR: [97, 0, 0], footR: [-37, -10, 0], toeR: [-4, 0, 0],
        shoulderL: [0, 0, 4], shoulderR: [0, 0, -4],
      },
      offset: { hips: [0, -0.252, 0.03] },
    },
  ],
};

/** Prone: the root pitches forward and the whole body lies along +Z. */
const PRONE: ClipDef = {
  name: 'prone', duration: 5.0, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        root: [82, 0, 0],
        hips: [-4, 0, 0], spine: [-8, 0, 0], chest: [-14, 0, 0],
        neck: [-28, 0, 0], head: [-24, 0, 0],
        upperLegL: [6, 0, 12], lowerLegL: [16, 0, 0], footL: [12, 8, 0],
        upperLegR: [6, 0, -12], lowerLegR: [22, 0, 0], footR: [14, -8, 0],
        shoulderL: [0, 0, 12], shoulderR: [0, 0, -12],
      },
      offset: { root: [0, 0.20, -0.30] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        root: [82, 0, 0],
        hips: [-4, 0, 0], spine: [-8, 0, 0], chest: [-13, 0, 0],
        neck: [-28, 0, 0], head: [-24, 0, 0],
        upperLegL: [6, 0, 12], lowerLegL: [18, 0, 0], footL: [12, 8, 0],
        upperLegR: [6, 0, -12], lowerLegR: [20, 0, 0], footR: [14, -8, 0],
        shoulderL: [0, 0, 12], shoulderR: [0, 0, -12],
      },
      offset: { root: [0, 0.205, -0.30] },
    },
  ],
};

const PRONE_CRAWL: ClipDef = {
  name: 'proneCrawl', duration: 2.2, loop: true,
  keys: [0, 0.25, 0.5, 0.75].map((t): KeySpec => {
    const a = Math.sin(t * Math.PI * 2);
    const b = Math.cos(t * Math.PI * 2);
    return {
      t, ease: 'sine',
      pose: {
        root: [82, a * 3, 0],
        hips: [-4, -a * 6, b * 4], spine: [-8, a * 4, 0], chest: [-14, a * 6, 0],
        neck: [-28, -a * 4, 0], head: [-24, 0, 0],
        upperLegL: [6 - a * 16, 0, 12 + a * 10], lowerLegL: [16 + Math.max(0, a) * 40, 0, 0], footL: [12, 8, 0],
        upperLegR: [6 + a * 16, 0, -12 + a * 10], lowerLegR: [16 + Math.max(0, -a) * 40, 0, 0], footR: [12, -8, 0],
      },
      offset: { root: [0, 0.20, -0.30] },
    };
  }),
};

/* -------------------------------------------------------------- strafing */

/**
 * Side-steps. These are blended *against* the forward cycle by the blend tree,
 * so they carry the same phase convention and only the lateral character
 * differs: crossing step, wider stance, torso opened toward the direction of
 * travel.
 */
function strafeClip(name: string, dir: 1 | -1): ClipDef {
  const keys: KeySpec[] = [];
  for (const p of PHASES) {
    const lead = dir > 0 ? p : (p + 0.5) % 1;
    const trail = dir > 0 ? (p + 0.5) % 1 : p;
    const l = Math.cos(lead * Math.PI * 2);
    const tr = Math.cos(trail * Math.PI * 2);
    keys.push({
      t: p, ease: 'sine',
      pose: {
        upperLegL: [-6 * l, 0, dir * (10 + 8 * l)],
        lowerLegL: [10 + 34 * Math.max(0, Math.sin((lead - 0.5) * Math.PI * 2)) ** 1.3, 0, 0],
        footL: [-4, 4, -dir * 4],
        upperLegR: [-6 * tr, 0, dir * (10 + 8 * tr)],
        lowerLegR: [10 + 34 * Math.max(0, Math.sin((trail - 0.5) * Math.PI * 2)) ** 1.3, 0, 0],
        footR: [-4, -4, -dir * 4],
        hips: [2, dir * 6, dir * 3 * Math.sin(p * Math.PI * 2)],
        spine: [1, -dir * 3, 0],
        chest: [-3, -dir * 6, 0],
        neck: [-1, dir * 2, 0],
      },
      offset: { hips: [dir * 0.012, -0.012 - 0.016 * Math.cos(p * Math.PI * 4), 0] },
    });
  }
  return { name, duration: 1.1, loop: true, keys };
}

/* --------------------------------------------------------------- reactions */

/**
 * Impact flinches. Additive over locomotion, so they only carry the delta.
 *
 * The shape matters more than the size: a round arriving is a *snap* — 70–90 ms
 * to peak, an overshoot, then a slow recovery over half a second. Symmetric
 * ease-in-out over a third of a second reads as an animation playing. The whip
 * key after the peak is what makes the body look struck rather than posed.
 */
function hitClip(name: string, pose: PoseSpec, settle: PoseSpec = {}): ClipDef {
  return {
    name, duration: 0.78, loop: false,
    keys: [
      { t: 0, pose: {}, ease: 'out' },
      { t: 0.11, pose, ease: 'out' },
      { t: 0.30, pose: settle, ease: 'inOut' },
      { t: 1, pose: {}, ease: 'inOut' },
    ],
  };
}

const HIT_FRONT = hitClip('hitFront',
  {
    hips: [-7, 0, 0], spine: [-17, 0, 0], chest: [-26, 0, 0], neck: [20, 0, 0], head: [17, 0, 0],
    shoulderL: [0, 0, -12], shoulderR: [0, 0, 12],
    upperArmL: [8, 0, 10], upperArmR: [8, 0, -10],
    upperLegL: [6, 0, 0], lowerLegL: [10, 0, 0], upperLegR: [3, 0, 0], lowerLegR: [6, 0, 0],
  },
  { spine: [-6, 0, 0], chest: [-9, 0, 0], neck: [6, 0, 0], upperArmL: [3, 0, 4], upperArmR: [3, 0, -4] });
const HIT_BACK = hitClip('hitBack',
  {
    hips: [9, 0, 0], spine: [15, 0, 0], chest: [23, 0, 0], neck: [-22, 0, 0], head: [-18, 0, 0],
    shoulderL: [0, 0, 9], shoulderR: [0, 0, -9],
    upperArmL: [-12, 0, 8], upperArmR: [-12, 0, -8],
    upperLegL: [-5, 0, 0], upperLegR: [-8, 0, 0], lowerLegR: [9, 0, 0],
  },
  { spine: [6, 0, 0], chest: [8, 0, 0], neck: [-6, 0, 0] });
const HIT_LEFT = hitClip('hitLeft',
  {
    hips: [0, 0, -9], spine: [0, -8, -17], chest: [0, -13, -23], neck: [0, 10, 15], head: [0, 8, 12],
    shoulderL: [0, 0, -18], upperArmL: [6, 0, 16], upperArmR: [4, 0, -6],
    upperLegL: [0, 0, -5], upperLegR: [0, 0, -3],
  },
  { spine: [0, -3, -6], chest: [0, -4, -8] });
const HIT_RIGHT = hitClip('hitRight',
  {
    hips: [0, 0, 9], spine: [0, 8, 17], chest: [0, 13, 23], neck: [0, -10, -15], head: [0, -8, -12],
    shoulderR: [0, 0, 18], upperArmR: [6, 0, -16], upperArmL: [4, 0, 6],
    upperLegR: [0, 0, 5], upperLegL: [0, 0, 3],
  },
  { spine: [0, 3, 6], chest: [0, 4, 8] });

/* ------------------------------------------------------------------ deaths */

const DEATH_FRONT: ClipDef = {
  name: 'deathFront', duration: 1.05, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.18, ease: 'out',
      pose: {
        hips: [-6, 0, 0], spine: [-14, 0, 0], chest: [-20, 0, 0], neck: [14, 0, 0], head: [12, 0, 0],
        upperLegL: [-14, 0, 4], lowerLegL: [22, 0, 0],
        upperLegR: [-8, 0, -4], lowerLegR: [16, 0, 0],
        upperArmL: [-24, 0, 18], upperArmR: [-24, 0, -18],
        lowerArmL: [-40, 0, 0], lowerArmR: [-40, 0, 0],
      },
      offset: { hips: [0, -0.06, 0] },
    },
    {
      t: 0.52, ease: 'in',
      pose: {
        hips: [16, 3, 0], spine: [22, 0, 0], chest: [26, 0, 0], neck: [-16, 0, 0], head: [-10, 0, 0],
        upperLegL: [-46, 0, 8], lowerLegL: [72, 0, 0],
        upperLegR: [-38, 0, -8], lowerLegR: [64, 0, 0],
        upperArmL: [-10, 0, 34], upperArmR: [-10, 0, -34],
        lowerArmL: [-20, 0, 0], lowerArmR: [-20, 0, 0],
      },
      offset: { hips: [0, -0.42, 0.05] },
    },
    {
      t: 1, ease: 'out',
      pose: {
        root: [70, 4, 0],
        hips: [6, 4, 0], spine: [10, 0, 0], chest: [8, 0, 0], neck: [-30, 0, 0], head: [-14, 6, 0],
        upperLegL: [-20, 0, 14], lowerLegL: [46, 0, 0],
        upperLegR: [-12, 0, -10], lowerLegR: [30, 0, 0],
        upperArmL: [16, -10, 28], upperArmR: [2, 14, -54],
        lowerArmL: [-48, 0, 0], lowerArmR: [-10, 0, 0],
      },
      offset: { root: [0, 0.18, -0.24] },
    },
  ],
};

const DEATH_BACK: ClipDef = {
  name: 'deathBack', duration: 1.15, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.16, ease: 'out',
      pose: {
        hips: [6, 0, 0], spine: [12, 0, 0], chest: [18, 0, 0], neck: [-18, 0, 0], head: [-12, 0, 0],
        upperArmL: [24, -8, 16], upperArmR: [10, 6, -30],
        lowerArmL: [-46, 0, 0], lowerArmR: [-18, 0, 0],
        upperLegL: [8, 0, 4], upperLegR: [10, 0, -4],
      },
      offset: { hips: [0, -0.03, -0.04] },
    },
    {
      t: 0.55, ease: 'in',
      pose: {
        hips: [22, -4, 0], spine: [18, 0, 0], chest: [14, 0, 0], neck: [-14, 0, 0], head: [-8, 0, 0],
        upperLegL: [-30, 0, 8], lowerLegL: [40, 0, 0],
        upperLegR: [-26, 0, -6], lowerLegR: [52, 0, 0],
        // Asymmetric: one arm trapped across the body, one flung out. Two arms
        // abducted by the same angle is a starfish, and a starfish reads as a
        // clip playing rather than as a man going down.
        upperArmL: [34, -14, 22], upperArmR: [14, 10, -46],
        lowerArmL: [-64, 0, 0], lowerArmR: [-22, 0, 0],
      },
      offset: { hips: [0, -0.44, -0.10] },
    },
    {
      t: 1, ease: 'out',
      pose: {
        root: [-74, -5, 0],
        hips: [8, -6, 0], spine: [6, 0, 0], chest: [10, 0, 0], neck: [22, 0, 0], head: [18, -8, 0],
        upperLegL: [-16, 0, 12], lowerLegL: [24, 0, 0],
        upperLegR: [-10, 0, -14], lowerLegR: [36, 0, 0],
        upperArmL: [-10, -16, 30], upperArmR: [-2, 12, -62],
        lowerArmL: [-56, 0, 0], lowerArmR: [-14, 0, 0],
      },
      offset: { root: [0, 0.20, 0.26] },
    },
  ],
};

/** Head shot: instant loss of tone, the body folds where it stands. */
const DEATH_HEAD: ClipDef = {
  name: 'deathHead', duration: 0.85, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.12, ease: 'out',
      pose: {
        neck: [-26, 10, 0], head: [-20, 14, 8], chest: [6, 4, 0],
        upperArmL: [4, 0, 24], upperArmR: [4, 0, -24],
        lowerArmL: [-10, 0, 0], lowerArmR: [-10, 0, 0],
      },
    },
    {
      t: 0.48, ease: 'in',
      pose: {
        hips: [10, 6, 4], spine: [16, 0, 0], chest: [22, 0, 0], neck: [-24, 12, 0], head: [-26, 16, 10],
        upperLegL: [-52, 0, 10], lowerLegL: [86, 0, 0],
        upperLegR: [-44, 0, -8], lowerLegR: [78, 0, 0],
        upperArmL: [8, 0, 30], upperArmR: [8, 0, -28],
      },
      offset: { hips: [0, -0.48, 0.02] },
    },
    {
      t: 1, ease: 'out',
      pose: {
        root: [58, 16, 10],
        hips: [4, 8, 6], spine: [8, 0, 0], chest: [6, 0, 0], neck: [-28, 14, 0], head: [-20, 18, 12],
        upperLegL: [-26, 0, 20], lowerLegL: [60, 0, 0],
        upperLegR: [-14, 0, -16], lowerLegR: [44, 0, 0],
        upperArmL: [14, 0, 40], upperArmR: [10, 0, -36],
      },
      offset: { root: [0.06, 0.16, -0.20] },
    },
  ],
};

/* ------------------------------------------------------------------- cover */

const COVER_HIGH: ClipDef = {
  name: 'coverHigh', duration: 3.0, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        hips: [2, 14, 0], spine: [3, 8, 0], chest: [-4, 10, 0], neck: [-2, -6, 0], head: [0, -10, 0],
        upperLegL: [-14, 8, 5], lowerLegL: [22, 0, 0], footL: [-8, 10, 0],
        upperLegR: [-6, -10, -6], lowerLegR: [16, 0, 0], footR: [-10, -14, 0],
        shoulderL: [0, 0, 6], shoulderR: [0, 0, -6],
      },
      offset: { hips: [-0.03, -0.05, -0.02] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        hips: [2, 14, 0], spine: [3, 8, 0], chest: [-4, 10, 0], neck: [-2, -6, 0], head: [0, -10, 0],
        upperLegL: [-15, 8, 5], lowerLegL: [24, 0, 0], footL: [-9, 10, 0],
        upperLegR: [-6, -10, -6], lowerLegR: [17, 0, 0], footR: [-11, -14, 0],
        shoulderL: [0, 0, 6], shoulderR: [0, 0, -6],
      },
      offset: { hips: [-0.03, -0.062, -0.02] },
    },
  ],
};

const COVER_LOW: ClipDef = {
  name: 'coverLow', duration: 3.2, loop: true,
  keys: [
    {
      t: 0, ease: 'sine',
      pose: {
        hips: [12, 6, 0], spine: [8, 4, 0], chest: [-2, 6, 0], neck: [-8, -4, 0], head: [-4, -6, 0],
        upperLegL: [-84, 6, 10], lowerLegL: [104, 0, 0], footL: [-22, 10, 0],
        upperLegR: [-72, -8, -12], lowerLegR: [118, 0, 0], footR: [-46, -12, 0], toeR: [-16, 0, 0],
        shoulderL: [0, 0, 5], shoulderR: [0, 0, -5],
      },
      offset: { hips: [0, -0.36, 0.06] },
    },
    {
      t: 0.5, ease: 'sine',
      pose: {
        hips: [12, 6, 0], spine: [8, 4, 0], chest: [-2, 6, 0], neck: [-8, -4, 0], head: [-4, -6, 0],
        upperLegL: [-85, 6, 10], lowerLegL: [106, 0, 0], footL: [-23, 10, 0],
        upperLegR: [-72, -8, -12], lowerLegR: [119, 0, 0], footR: [-47, -12, 0], toeR: [-16, 0, 0],
        shoulderL: [0, 0, 5], shoulderR: [0, 0, -5],
      },
      offset: { hips: [0, -0.368, 0.06] },
    },
  ],
};

function peekClip(name: string, dir: 1 | -1): ClipDef {
  return {
    name, duration: 0.5, loop: false,
    keys: [
      { t: 0, pose: {}, ease: 'out' },
      {
        t: 1, ease: 'out',
        pose: {
          hips: [1, dir * 10, dir * 4],
          spine: [2, dir * 8, dir * 7],
          chest: [-2, dir * 12, dir * 9],
          neck: [0, dir * 4, -dir * 3],
          head: [0, dir * 6, -dir * 4],
          upperLegL: [-8, dir * 4, 6], upperLegR: [-8, dir * 4, -6],
          lowerLegL: [14, 0, 0], lowerLegR: [14, 0, 0],
        },
        offset: { hips: [dir * 0.09, -0.02, 0.03] },
      },
    ],
  };
}

/* ------------------------------------------------------------------ action */

/** Vaulting a low obstacle: plant, swing, land. */
const VAULT_LOW: ClipDef = {
  name: 'vaultLow', duration: 0.85, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.3, ease: 'out',
      pose: {
        hips: [16, 0, 0], spine: [12, 0, 0], chest: [-18, 0, 0], neck: [-16, 0, 0],
        upperLegL: [-64, 0, 8], lowerLegL: [70, 0, 0], footL: [-16, 0, 0],
        upperLegR: [26, 0, -6], lowerLegR: [58, 0, 0],
        upperArmL: [-58, 0, 22], lowerArmL: [-30, 0, 0],
        upperArmR: [-20, 0, -14], lowerArmR: [-70, 0, 0],
      },
      offset: { hips: [0, 0.16, 0.12] },
    },
    {
      t: 0.65, ease: 'inOut',
      pose: {
        hips: [22, 0, 0], spine: [10, 0, 0], chest: [-14, 0, 0], neck: [-14, 0, 0],
        upperLegL: [-30, 0, 10], lowerLegL: [40, 0, 0],
        upperLegR: [-60, 0, -10], lowerLegR: [86, 0, 0],
        upperArmL: [-30, 0, 30], lowerArmL: [-20, 0, 0],
        upperArmR: [-40, 0, -20], lowerArmR: [-50, 0, 0],
      },
      offset: { hips: [0, 0.10, 0.30] },
    },
    { t: 1, pose: { hips: [6, 0, 0], chest: [-8, 0, 0], upperLegL: [-18, 0, 4], lowerLegL: [26, 0, 0], upperLegR: [-10, 0, -4], lowerLegR: [20, 0, 0] }, offset: { hips: [0, -0.06, 0.34] }, ease: 'out' },
  ],
};

const VAULT_HIGH: ClipDef = {
  name: 'vaultHigh', duration: 1.15, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.28, ease: 'out',
      pose: {
        hips: [26, 0, 0], spine: [18, 0, 0], chest: [-26, 0, 0], neck: [-22, 0, 0],
        upperLegL: [-78, 0, 10], lowerLegL: [92, 0, 0],
        upperLegR: [10, 0, -8], lowerLegR: [70, 0, 0],
        upperArmL: [-96, 0, 20], lowerArmL: [-24, 0, 0],
        upperArmR: [-88, 0, -20], lowerArmR: [-28, 0, 0],
      },
      offset: { hips: [0, 0.34, 0.10] },
    },
    {
      t: 0.62, ease: 'inOut',
      pose: {
        hips: [34, 0, 0], spine: [16, 0, 0], chest: [-20, 0, 0],
        upperLegL: [-58, 0, 14], lowerLegL: [96, 0, 0],
        upperLegR: [-52, 0, -12], lowerLegR: [104, 0, 0],
        upperArmL: [-40, 0, 34], upperArmR: [-36, 0, -32],
      },
      offset: { hips: [0, 0.30, 0.36] },
    },
    { t: 1, pose: { hips: [10, 0, 0], chest: [-12, 0, 0], upperLegL: [-26, 0, 6], lowerLegL: [40, 0, 0], upperLegR: [-16, 0, -6], lowerLegR: [30, 0, 0] }, offset: { hips: [0, -0.10, 0.52] }, ease: 'out' },
  ],
};

/** Overhand grenade throw. Runs on the arm mask with hand IK disabled. */
const THROW: ClipDef = {
  name: 'throw', duration: 0.95, loop: false,
  keys: [
    { t: 0, pose: {}, ease: 'out' },
    {
      t: 0.34, ease: 'out',
      pose: {
        chest: [4, -18, 0], spine: [2, -10, 0], neck: [0, 10, 0],
        shoulderR: [0, -8, -10],
        upperArmR: [70, 0, -46], lowerArmR: [-96, 0, 0], handR: [-20, 0, 0],
        upperArmL: [-26, 0, 22], lowerArmL: [-70, 0, 0],
      },
    },
    {
      t: 0.56, ease: 'in',
      pose: {
        chest: [-10, 20, 0], spine: [-4, 12, 0], neck: [2, -10, 0],
        shoulderR: [0, 10, -4],
        upperArmR: [-104, 0, -22], lowerArmR: [-24, 0, 0], handR: [10, 0, 0],
        upperArmL: [-10, 0, 16], lowerArmL: [-50, 0, 0],
      },
    },
    { t: 1, pose: {}, ease: 'inOut' },
  ],
};

/* ------------------------------------------------------------------ export */

const DEFS: ClipDef[] = [
  gaitClip(WALK), gaitClip(RUN), gaitClip(SPRINT), gaitClip(CROUCH_WALK),
  IDLE, IDLE_ALERT, CROUCH_IDLE, PRONE, PRONE_CRAWL,
  strafeClip('strafeL', 1), strafeClip('strafeR', -1),
  HIT_FRONT, HIT_BACK, HIT_LEFT, HIT_RIGHT,
  DEATH_FRONT, DEATH_BACK, DEATH_HEAD,
  COVER_HIGH, COVER_LOW, peekClip('coverPeekL', 1), peekClip('coverPeekR', -1),
  VAULT_LOW, VAULT_HIGH, THROW,
];

let cache: Map<string, Clip> | null = null;

/** The shared, lazily compiled clip table. Clips are immutable and reused. */
export function clips(): Map<string, Clip> {
  if (cache) return cache;
  cache = new Map();
  for (const d of DEFS) cache.set(d.name, new Clip(d));
  return cache;
}

export function clip(name: AnimName | string): Clip | null {
  return clips().get(name) ?? null;
}

/** Metres travelled per full cycle, used to sync foot phase to real speed. */
export const STRIDE: Record<string, number> = {
  walk: WALK.stride, run: RUN.stride, sprint: SPRINT.stride,
  crouchWalk: CROUCH_WALK.stride, strafeL: 1.15, strafeR: 1.15, proneCrawl: 0.9,
};
