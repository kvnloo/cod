/**
 * Gloved hands and forearms.
 *
 * Every screenshot ever taken of a modern military shooter has a gloved hand
 * wrapped over the handguard. It is the most recognisable shape in the genre,
 * it is the frame's only *scale reference*, and — because it occludes the
 * receiver and the buttstock — it is what makes the weapon read as **held**
 * rather than as a model floating in front of the lens. A first-person frame
 * without hands is a weapon viewer, not a soldier.
 *
 * The hands are built as ordinary weapon parts, in weapon-local space, so:
 *
 *   • they merge into the same one-draw-call-per-(part, material) scheme,
 *   • they inherit every layer of the view-model animation for free — idle
 *     sway, ADS, recoil, sprint, draw and melee all move the rig, and the
 *     hands are *on* the rig,
 *   • the reload can slide the support hand off the handguard by animating a
 *     single node, exactly like the magazine.
 *
 * Nothing here is a humanoid skeleton. A hand that grips a cylinder is fully
 * described by the cylinder's axis, a radius, and the angles at which each
 * digit starts and stops wrapping — so that is the parameterisation, and both
 * hands, on eight weapons, come out of one function.
 *
 * Only the *view-space* build gets hands: the catalogue, the dropped-weapon
 * pickup and the third-person mesh all share this builder and none of them
 * wants a pair of severed forearms attached.
 */

import * as THREE from 'three';
import type { MaterialKey } from '../types';
import type { RigBuilder } from './Builder';
import type { BuildCtx } from './Parts';
import { ball, loft, xf, type LoftRing } from './Geo';

/* ------------------------------------------------------------- parameters */

/** Adult male hand in a tactical glove, in metres. */
const HAND = {
  /** Spacing between adjacent finger centres. */
  fingerPitch: 0.0206,
  /** Radius of a gloved finger at the proximal phalanx. */
  fingerR: 0.0118,
  /** Radial thickness of the back of the hand over the gripped object. */
  palmT: 0.0330,
  /** How far the palm shell wraps, either side of its centre, in radians. */
  palmArc: 0.92,
  /** Half-length of the palm along the gripped axis. */
  palmHalf: 0.0455,
  /** Radius of the wrist. */
  wristR: 0.0355,
  /**
   * Radius of the forearm at the far end.
   *
   * A forearm in a rolled combat-shirt sleeve is ~10 cm across. At 0.043 the
   * arm read as a stick and the eye never registered it as a limb, which is
   * half of why the rifle looked unsupported.
   */
  armR: 0.0520,
};

export interface HandSpec {
  /** Name of the rig part the hand becomes. */
  name: string;
  /** Rig part this hand hangs off — `pump` for a shotgun forend, else `receiver`. */
  parent: string;
  /** A point on the axis of the gripped object, weapon-local. */
  at: THREE.Vector3;
  /** Unit vector along the gripped object. */
  axis: THREE.Vector3;
  /** Unit vector perpendicular to `axis` defining θ = 0. */
  ref: THREE.Vector3;
  /** Radius of the gripped object. */
  radius: number;
  /** θ at the centre of the palm. */
  palmTheta: number;
  /** How far the palm shell wraps either side of `palmTheta`, radians. */
  palmArc: number;
  /** θ where the fingers leave the palm, and where their tips end. */
  fingerFrom: number;
  fingerTo: number;
  /** θ of the thumb's root and tip. */
  thumbFrom: number;
  thumbTo: number;
  /** Axial offset of the first (index) finger from `at`. */
  fingerAxial: number;
  /** Sign of the axial step from index to little finger. */
  fingerStep: number;
  /** Axial offset of the thumb's root, and of its tip. */
  thumbAxial: number;
  thumbAxialTip: number;
  /**
   * Axial offset of the wrist. A support hand on a horizontal handguard trails
   * its wrist *behind* the little finger; a firing hand on a vertical grip
   * trails it *above* the index finger. One number covers both.
   */
  wristAxial: number;
  /**
   * Trigger position, weapon-local. When present the index finger is broken
   * out of the wrap and laid along the trigger instead.
   */
  trigger?: THREE.Vector3;
  /** Direction the forearm runs away from the wrist. */
  armDir: THREE.Vector3;
  /** Length of the forearm run. */
  armLength: number;
  /** Overall size multiplier. */
  scale?: number;
}

/* ---------------------------------------------------------------- helpers */

const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Unit radial direction at angle θ in the (ref, axis × ref) frame. */
function radial(out: THREE.Vector3, ref: THREE.Vector3, ref2: THREE.Vector3, theta: number): THREE.Vector3 {
  return out.copy(ref).multiplyScalar(Math.cos(theta)).addScaledVector(ref2, Math.sin(theta));
}

/** Point at (θ, radius, axial offset) on the gripped cylinder. */
function onGrip(
  out: THREE.Vector3, s: HandSpec, ref2: THREE.Vector3,
  theta: number, r: number, axial: number,
): THREE.Vector3 {
  radial(_d, s.ref, ref2, theta);
  return out.copy(s.at).addScaledVector(_d, r).addScaledVector(s.axis, axial);
}

function v3(p: THREE.Vector3): [number, number, number] { return [p.x, p.y, p.z]; }

/* ------------------------------------------------------------------ build */

/**
 * A digit wrapped around the gripped cylinder.
 *
 * The finger is swept in *polar* coordinates about the grip axis, which is the
 * whole trick: three joint bulges and a taper fall out of modulating the radius
 * and the section size along the sweep, and the finger can never intersect the
 * thing it is holding because its distance from the axis is an explicit term.
 */
function digit(
  b: RigBuilder, s: HandSpec, ref2: THREE.Vector3, mat: MaterialKey,
  from: number, to: number, axial: number, r0: number, taper: number,
  lift: number, steps = 7,
): void {
  const rings: LoftRing[] = [];
  const k = s.scale ?? 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = from + (to - from) * t;
    // Knuckles: the finger is fattest just past each joint and pinches at it.
    const joint = 0.5 - 0.5 * Math.cos(t * Math.PI * 3.0);
    const rad = r0 * (1 - taper * t) * (0.90 + joint * 0.16);
    // A finger leaves the hand at the *outside* of the knuckle and closes onto
    // the object as it wraps. Starting it flush with the surface — the obvious
    // implementation — buries the whole digit inside the palm's silhouette, and
    // the hand then reads as one featureless lump instead of as a fist.
    const stand = s.radius + lift + rad
      + HAND.palmT * k * 0.74 * (1 - t) ** 1.35
      + joint * 0.0011 * k;
    onGrip(_p, s, ref2, theta, stand, axial);
    rings.push({ at: v3(_p), w: rad, h: rad * 0.94, sq: 4.2 });
  }
  b.add(loft(rings, 9, true, true, v3(s.axis)), mat);
}

/**
 * The trigger finger: it leaves the wrap at the knuckle, runs forward along the
 * receiver and lands its pad on the face of the trigger. A firing hand whose
 * index finger is curled with the other three is the single most common tell
 * that a first-person hand was posed by a programmer rather than an animator.
 */
function triggerFinger(
  b: RigBuilder, s: HandSpec, ref2: THREE.Vector3, mat: MaterialKey, target: THREE.Vector3,
): void {
  const k = s.scale ?? 1;
  const r = HAND.fingerR * k;
  onGrip(_p, s, ref2, s.fingerFrom, s.radius + r * 1.15, s.fingerAxial);
  const root = _p.clone();
  // Knuckle sits proud of the grip; the finger then curves in to the trigger
  // face and the tip continues a little past it.
  _t.copy(target).sub(root);
  const len = _t.length();
  _t.normalize();
  // Bow the middle of the finger outward, away from the receiver.
  radial(_d, s.ref, ref2, s.fingerFrom + 0.35);
  const rings: LoftRing[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bow = Math.sin(t * Math.PI) * 0.0075 * k;
    _p.copy(root).addScaledVector(_t, len * t * 1.06).addScaledVector(_d, bow);
    const rad = r * (1 - 0.30 * t) * (i === 0 ? 1.06 : 1.0);
    rings.push({ at: v3(_p), w: rad, h: rad * 0.94, sq: 4.2 });
  }
  b.add(loft(rings, 9, true, true, v3(s.axis)), mat);
}

/** Builds one complete gloved hand plus its forearm. */
export function buildHand(b: RigBuilder, s: HandSpec): void {
  const k = s.scale ?? 1;
  const ref2 = new THREE.Vector3().crossVectors(s.axis, s.ref).normalize();
  const glove: MaterialKey = 'glove';

  b.part(s.name, v3(s.at), s.parent);

  /* --- back of the hand: a shell hugging the gripped object -------------- */
  // Built as a sweep *around* the grip rather than along it, so it curves onto
  // the object instead of hanging off it as a slab.
  {
    const rings: LoftRing[] = [];
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = s.palmTheta - s.palmArc + 2 * s.palmArc * t;
      // Thickest across the knuckles, thinning toward the heel and the thumb.
      const bulk = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) ** 0.45;
      const thick = HAND.palmT * k * (0.44 + bulk * 0.56);
      onGrip(_p, s, ref2, theta, s.radius + thick * 0.5, 0);
      rings.push({
        at: v3(_p),
        w: thick * 0.5,
        // Long along the grip axis: this is the width of a hand.
        h: HAND.palmHalf * k * (0.80 + bulk * 0.20),
        sq: 3.4,
      });
    }
    b.add(loft(rings, 14, true, true, v3(s.axis)), glove);
  }

  /* --- heel of the hand -------------------------------------------------- */
  // The hand does not end where it touches the object: the heel and the thenar
  // pad stand out past the grip on the palm side, and that overhang is what
  // gives the hand an outline of its own instead of the grip's.
  {
    const rings: LoftRing[] = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const axial = s.wristAxial * (0.20 + t * 1.05);
      const swing = s.palmTheta - 0.30 * t;
      const bulk = Math.sin(Math.min(1, 0.18 + t * 0.9) * Math.PI) ** 0.5;
      onGrip(_p, s, ref2, swing, s.radius + HAND.palmT * k * (0.52 + 0.20 * t), axial);
      rings.push({
        at: v3(_p),
        w: HAND.palmT * k * (0.52 + bulk * 0.28),
        h: HAND.palmHalf * k * (0.66 + bulk * 0.30),
        sq: 3.2,
      });
    }
    b.add(loft(rings, 14, true, true, v3(s.axis)), glove);
  }

  /* --- knuckles ---------------------------------------------------------- */
  // Four separate domes where the fingers leave the hand. This is the read:
  // at 60 cm the eye cannot resolve a fingernail, but it resolves the row of
  // knuckles instantly, and a row of four bumps is unmistakably a fist.
  for (let i = 0; i < 4; i++) {
    const axial = s.fingerAxial + s.fingerStep * HAND.fingerPitch * k * i;
    const kr = HAND.fingerR * k * (i === 3 ? 0.86 : i === 0 ? 1.02 : 1.0);
    const theta = s.fingerFrom + (s.palmTheta - s.fingerFrom) * 0.34;
    // Sunk into the back of the hand, not perched on it. At 0.64 the domes
    // stood a centimetre proud of the palm shell and — with the shell's own
    // silhouette hidden behind the handguard — the eye read four detached
    // spheres floating beside the rifle instead of a fist.
    onGrip(_p, s, ref2, theta, s.radius + HAND.palmT * k * 0.46, axial);
    b.add(xf(ball(kr * 0.80, 10), { pos: v3(_p) }), glove);
  }
  // Reinforced knuckle strap across them.
  {
    const rings: LoftRing[] = [];
    const steps = 4;
    const theta = s.fingerFrom + (s.palmTheta - s.fingerFrom) * 0.34;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const axial = s.fingerAxial + s.fingerStep * HAND.fingerPitch * k * 3.35 * (t - 0.06);
      onGrip(_p, s, ref2, theta, s.radius + HAND.palmT * k * 0.72, axial);
      rings.push({ at: v3(_p), w: HAND.fingerR * k * 0.62, h: HAND.fingerR * k * 0.42, sq: 4.0 });
    }
    b.add(loft(rings, 8, true, true, v3(s.axis)), 'gloveKnuckle');
  }

  /* --- four fingers ------------------------------------------------------ */
  for (let i = 0; i < 4; i++) {
    const axial = s.fingerAxial + s.fingerStep * HAND.fingerPitch * k * i;
    // The little finger is shorter and thinner and does not reach as far round.
    const shorten = i === 3 ? 0.20 : i === 0 ? 0.04 : 0;
    const r = HAND.fingerR * k * (i === 3 ? 0.84 : i === 2 ? 0.94 : 1.0);
    if (i === 0 && s.trigger) { triggerFinger(b, s, ref2, glove, s.trigger); continue; }
    digit(
      b, s, ref2, glove, s.fingerFrom,
      s.fingerFrom + (s.fingerTo - s.fingerFrom) * (1 - shorten),
      axial, r, 0.24, 0.0006 * k,
    );
    // Fingernail-end cap: a small ball stops the loft's flat end reading as a
    // cut-off tube on the one silhouette the eye actually studies.
    onGrip(_p, s, ref2, s.fingerFrom + (s.fingerTo - s.fingerFrom) * (1 - shorten),
      s.radius + 0.0006 * k + r * 0.76, axial);
    b.add(xf(ball(r * 0.74, 9), { pos: v3(_p) }), glove);
  }

  /* --- thumb ------------------------------------------------------------- */
  {
    const r = HAND.fingerR * k * 1.22;
    const rings: LoftRing[] = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const theta = s.thumbFrom + (s.thumbTo - s.thumbFrom) * t;
      // The thumb rolls off the pad of the hand, so it starts further out.
      const rad = r * (1.05 - 0.30 * t);
      const stand = s.radius + rad + (1 - t) * HAND.palmT * k * 0.32;
      const axial = s.thumbAxial + (s.thumbAxialTip - s.thumbAxial) * t;
      onGrip(_p, s, ref2, theta, stand, axial);
      rings.push({ at: v3(_p), w: rad, h: rad * 0.98, sq: 4.0 });
    }
    b.add(loft(rings, 10, true, true, v3(s.axis)), glove);
    onGrip(_p, s, ref2, s.thumbTo, s.radius + r * 0.75 * 1.05, s.thumbAxialTip);
    b.add(xf(ball(r * 0.66, 9), { pos: v3(_p) }), glove);
  }

  /* --- wrist, cuff and forearm ------------------------------------------ */
  // The forearm is the part that carries the frame: it runs out of the bottom
  // of the picture and gives the composition a foreground layer. It starts at
  // the heel of the hand, not at the grip axis, so it never spears the weapon.
  {
    const arm = s.armDir.clone().normalize();
    radial(_d, s.ref, ref2, s.palmTheta);
    _p.copy(s.at)
      .addScaledVector(_d, s.radius + HAND.palmT * k * 0.34)
      .addScaledVector(s.axis, s.wristAxial);
    const wrist = _p.clone();

    // Glove cuff: a short flared collar, the seam between hand and sleeve.
    const cuff: LoftRing[] = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      _p.copy(wrist).addScaledVector(arm, t * 0.052 * k);
      const rr = HAND.wristR * k * (0.98 + t * 0.16);
      cuff.push({ at: v3(_p), w: rr, h: rr * 0.86, sq: 2.7 });
    }
    b.add(loft(cuff, 16, true, false, v3(s.axis)), glove);

    // Sleeve: cloth, drooping very slightly under its own weight and swelling
    // toward the elbow. Ends well past the near plane, so it always leaves the
    // frame rather than terminating in mid-air.
    const sleeve: LoftRing[] = [];
    const n = 11;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      _p.copy(wrist).addScaledVector(arm, (0.030 + t * s.armLength) * k);
      _p.y -= t * t * 0.014 * k;
      // Ripstop does not lie smooth over a forearm: it bunches at the wrist,
      // slackens over the belly of the muscle and pulls in again toward the
      // elbow. Without that the sleeve is a cardboard tube with a cloth
      // texture on it, which is exactly how it read.
      const fold = 1 + Math.sin(t * 9.4 + 0.7) * 0.035 + Math.sin(t * 4.1) * 0.028;
      const rr = HAND.wristR * k * (1.02 + t * (HAND.armR / HAND.wristR - 1.0)) * fold;
      sleeve.push({ at: v3(_p), w: rr, h: rr * (0.92 - t * 0.06), sq: 2.6 });
    }
    b.add(loft(sleeve, 20, false, true, v3(s.axis)), 'sleeve');
  }

  b.use('receiver');
}

/* ------------------------------------------------------------- assemblies */

const UP = new THREE.Vector3(0, 1, 0);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const FWD = new THREE.Vector3(0, 0, -1);

/**
 * Fits both hands to whatever the assembly recorded.
 *
 * Angles are quoted in the (ref, axis × ref) frame of the thing being held, so
 * they read as what they are — "the fingers wrap from below-left round under
 * the tube to below-right" — instead of as a pile of transform matrices.
 */
export function hands(ctx: BuildCtx): void {
  if (!ctx.viewSpace) return;
  const { b } = ctx;

  /* --- support hand ----------------------------------------------------- */
  // A modern rifle carries a rail along the whole top of the handguard, so the
  // support hand cannot wrap over the top: it goes underneath, palm on the
  // near flank, fingers round the bottom, thumb laid alongside the rail. That
  // is also the only pose from which the hand is visible to the shooter, which
  // is why it is the pose every first-person shooter uses.
  const sup = ctx.support;
  if (sup) {
    buildHand(b, {
      name: 'handLeft',
      parent: sup.node,
      at: sup.at.clone(),
      axis: sup.axis.clone().normalize(),
      ref: LEFT.clone(),
      radius: sup.radius,
      // The eye is above and to the left of the handguard, so the back of the
      // hand is put on that flank: it is the only face the shooter can see.
      palmTheta: 0.50,
      // Wrapped further round: the shell now reaches from below the tube up to
      // the rail on the near flank, so the hand has a continuous silhouette
      // against the world instead of four knuckle domes peering out from under
      // the handguard with nothing joining them up.
      palmArc: 0.98,
      // Fingers break out just below the horizontal — the first joint of each
      // stays on the visible flank, and only then do they curl underneath.
      fingerFrom: -0.34,
      fingerTo: -2.78,
      // Thumb-forward grip: the thumb comes up over the near shoulder of the
      // handguard and points down-range alongside the rail. It is the one part
      // of the support hand that sits *above* the tube's horizon from the
      // shooter's eye, so it is what actually reads at a glance — and it is
      // the pose every modern shooter animates.
      thumbFrom: 1.34,
      thumbTo: 1.18,
      thumbAxial: 0.004,
      thumbAxialTip: 0.082,
      fingerAxial: 0.030,
      fingerStep: -1,
      wristAxial: -0.034,
      // Down *and back toward the shoulder*. Straight down was anatomically
      // defensible and visually useless: the arm left the bottom of the frame
      // within a couple of centimetres of the wrist and the eye never saw a
      // limb at all. Raked back, the forearm becomes the long diagonal mass
      // running out of the lower-left of every Call of Duty frame — which is
      // the shape that tells you the rifle is being *held*.
      armDir: new THREE.Vector3(-0.34, -0.70, 0.63),
      armLength: 0.40,
    });
  }

  /* --- firing hand ------------------------------------------------------ */
  const grip = ctx.grip;
  if (grip) {
    const axis = grip.down.clone().normalize();
    const at = grip.top.clone().addScaledVector(axis, grip.length * 0.44);
    buildHand(b, {
      name: 'handRight',
      parent: 'receiver',
      at,
      axis,
      // θ = 0 points out of the right-hand side of the weapon; θ = 90° is the
      // back strap of the grip.
      ref: RIGHT.clone(),
      radius: grip.radius,
      palmTheta: 0.42,
      palmArc: 0.86,
      fingerFrom: -0.62,
      fingerTo: -2.86,
      thumbFrom: 1.32,
      thumbTo: 2.46,
      thumbAxial: -0.004,
      thumbAxialTip: -0.020,
      fingerAxial: -0.026,
      fingerStep: 1,
      wristAxial: -0.052,
      trigger: ctx.triggerFace?.clone(),
      // Same reasoning as the support arm: the firing forearm runs down and
      // back to a shoulder that is behind the camera, so it wants a real
      // rearward rake rather than dropping vertically out of shot.
      armDir: new THREE.Vector3(0.30, -0.70, 0.65),
      armLength: 0.34,
    });
  }
}

/* Kept so a helper that stops being used cannot silently rot. */
void UP; void FWD;
