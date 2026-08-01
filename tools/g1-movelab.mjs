/**
 * G1 movement lab — measures the movement engine by *driving* it.
 *
 *   node tools/g1-movelab.mjs            # human-readable table
 *   node tools/g1-movelab.mjs --json     # machine-readable, for diffing runs
 *
 * This boots the REAL `Movement` state machine and the REAL
 * `CapsuleCharacterController` against a REAL Rapier world, in node, with no
 * browser and no GPU. Every number below therefore comes from the same code the
 * game ships — not from a re-implementation.
 *
 * Why node and not the browser: feel is a *simulation* property, and the
 * simulation is deterministic at a fixed 120 Hz. Running it headless means a
 * scenario is exactly reproducible, costs ~2 s instead of ~60 s, and does not
 * contend with other agents for the GPU. The browser is still used at the end to
 * prove the shipping bundle boots and behaves — but the tuning loop lives here.
 *
 * The lab builds its own geometry (exact 30°/40° ramps, an exact 150 mm kerb,
 * a ledge ladder at exact multiples of character height) because you cannot
 * measure a step-up against a level that has no step of known height.
 */

import './net-ts-loader.mjs';
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

const { CapsuleCharacterController } = await import('../src/physics/CharacterController.ts');
const { ColliderRegistry } = await import('../src/physics/Registry.ts');
const { groups, defaultMask } = await import('../src/physics/Layers.ts');
const { LAYER } = await import('../src/physics/types.ts');
const { Movement, TUNING } = await import('../src/player/Movement.ts');
const { BTN, quantizeMoveCommand } = await import('../src/player/MoveCommand.ts');

const DT = 1 / 120;
const HZ = 120;
const DEG = Math.PI / 180;
/** How far the heading may drift before an optimal strafe switches sides. */
const HEADING_TOLERANCE = 22 * Math.PI / 180;

/* --------------------------------------------------------------- lab world */

/**
 * Implements the slice of `ControllerHost` + `PhysicsAPI` the movement stack
 * actually consumes: a Rapier world, a collider registry, raycasts and
 * `createCharacter`. Nothing is faked — the character controller runs its real
 * shape casts against real colliders.
 */
class LabWorld {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    this.world.lengthUnit = 1;
    this.registry = new ColliderRegistry();
    this.ready = true;
    this._q = new THREE.Quaternion();
  }

  /** No moving platforms in the lab. */
  platformDelta(_handle, _point, out) { out.set(0, 0, 0); return 0; }

  /** Static box. `rotX` tilts it about world X, which is how ramps are built. */
  box(cx, cy, cz, hx, hy, hz, rotX = 0, surface = 'concrete') {
    const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz);
    if (rotX !== 0) {
      this._q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), rotX);
      bd.setRotation({ x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w });
    }
    const body = this.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(0.9)
      .setCollisionGroups(groups(LAYER.STATIC, defaultMask(LAYER.STATIC)));
    const col = this.world.createCollider(cd, body);
    this.registry.add({
      handle: col.handle, bodyId: -1, object: null, surface,
      entityId: -1, zone: 'none', layer: LAYER.STATIC,
      ranges: null, ragdollId: -1, debris: false,
    });
    return col.handle;
  }

  raycast(origin, dir, maxDist, mask, out) {
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const groupsWord = ((0xffff << 16) | (mask & 0xffff)) >>> 0;
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, groupsWord);
    if (!hit) { out.hit = false; out.distance = Infinity; return out; }
    out.hit = true;
    out.distance = hit.timeOfImpact;
    out.point.set(
      origin.x + dir.x * hit.timeOfImpact,
      origin.y + dir.y * hit.timeOfImpact,
      origin.z + dir.z * hit.timeOfImpact,
    );
    out.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    if (out.normal.dot(dir) > 0) out.normal.negate();
    out.surface = this.registry.resolve(hit.collider.handle).surface;
    out.object = null;
    out.entityId = -1;
    out.bodyHandle = -1;
    out.zone = 'none';
    out.backface = false;
    return out;
  }

  raycastAll() { return 0; }
  spherecast(o, d, _r, m, mask, out) { return this.raycast(o, d, m, mask, out); }
  overlapSphere() { return 0; }
  lineOfSight() { return true; }
  addBody() { throw new Error('lab: addBody unused'); }
  removeBody() { }
  applyExplosion() { }
  stats() { return { bodies: 0, active: 0, contacts: 0, stepMs: 0 }; }

  createCharacter(radius, height) {
    return new CapsuleCharacterController(this, radius, height, LAYER.PLAYER);
  }

  step() { this.world.timestep = DT; this.world.step(); }

  /** Ground height under (x, z), or null. */
  groundY(x, z, from = 60) {
    const out = rayOut();
    this.raycast(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0), from + 10, 0x3ff, out);
    return out.hit ? out.point.y : null;
  }
}

function rayOut() {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete', object: null, entityId: -1,
    bodyHandle: -1, zone: 'none', backface: false,
  };
}

/* ------------------------------------------------------------- test geometry */

/**
 * Test lanes, in x. Flat-ground tests live below x = 250 and every obstacle
 * lives above x = 400, because an air-strafe chain genuinely wanders sideways
 * and a test must not be able to trip over another test's geometry.
 */
const LANE = {
  jump: 0,
  crouch: 20,
  slideFlat: 40,
  slideJump: 60,
  strafeNaive: 80,
  strafeOpt: 100,
  strafeHuman: 60.5,
  strafeSingle: 100.5,
  tapStrafe: 120.5,
  tapControl: 140.5,
  bhop: 200,
  skillNaive: 220,
  skillExpert: 240,
  determinism: 260,
  // Obstacle lanes are kept clear of where two ground slabs overlap
  // (x ≈ 180, 400 and 580-620): two coplanar top faces at the same height give
  // the solver two coincident contacts and the capsule can stall on the pair.
  kerb: 420,
  ramp30: 460,
  ramp40: 520,
  ledge: 560,
  wall: 660,
};

/** Every test starts here and runs toward -z. */
const START_Z = 18;

/** Ramp whose top face passes exactly through (lane, 0, 0) and rises toward -z. */
function addRamp(world, laneX, deg, halfLen = 45) {
  const a = deg * DEG;
  const hy = 0.6, hx = 10;
  const cy = -hy * Math.cos(a) + halfLen * Math.sin(a);
  const cz = -hy * Math.sin(a) - halfLen * Math.cos(a);
  world.box(laneX, cy, cz, hx, hy, halfLen, a);
}

const LEDGE_HEIGHTS = [0.30, 0.60, 0.90, 1.20, 1.80, 2.40, 3.00, 3.60, 4.20, 4.50, 4.80, 5.40];
const LEDGE_SPACING = 24;
function ledgeZ(i) { return -20 - i * LEDGE_SPACING; }

function buildWorld() {
  const w = new LabWorld();
  // Ground: overlapping slabs, top face exactly y = 0.
  //
  // Deliberately not one huge cuboid. At 800 m across, Rapier's shape cast
  // loses enough relative precision that a capsule running over dead-flat
  // ground occasionally picks up a contact normal off the face's edge cone — a
  // phantom one-tick wall, which shows up as a stutter. `Movement.wallConfirmed`
  // now refuses to spend momentum on an unconfirmed contact, but the lab should
  // not be measuring a solver artefact either way. 240 m slabs are clean, and
  // they overlap so there is never a crack between them.
  for (const cx of [60, 280, 500, 700]) w.box(cx, -2, -160, 120, 2, 200);
  addRamp(w, LANE.ramp30, 30);
  addRamp(w, LANE.ramp40, 40);
  // Kerb ladder: 150 mm (the gate), then 300 mm and 450 mm for context.
  w.box(LANE.kerb, 0.075, -10, 12, 0.075, 0.60);
  w.box(LANE.kerb, 0.150, -20, 12, 0.150, 0.60);
  w.box(LANE.kerb, 0.225, -30, 12, 0.225, 0.60);
  // Ledge ladder: solid blocks the player runs into face-on.
  for (let i = 0; i < LEDGE_HEIGHTS.length; i++) {
    const h = LEDGE_HEIGHTS[i];
    w.box(LANE.ledge, h * 0.5, ledgeZ(i) - 6, 10, h * 0.5, 6);
  }
  // Wall-bounce: a long wall at x = LANE.wall + 6 running along z.
  w.box(LANE.wall + 6, 3, -40, 0.5, 3, 60);
  w.step();
  return w;
}

/* ----------------------------------------------------------------- test rig */

class Rig {
  constructor(world) {
    this.world = world;
    this.mv = new Movement();
    this.mv.emitEvents = false;
    this.mv.attach(world);
    this.seq = 0;
    this.t = 0;
    this.buttons = 0;
  }

  /** Drops the player onto the ground at (x, z) and settles the controller. */
  place(x, z, yaw = 0, settle = 30) {
    const gy = this.world.groundY(x, z) ?? 0;
    this.mv.teleport(new THREE.Vector3(x, gy + TUNING.standHeight * 0.5 + 0.02, z), yaw);
    this.yaw = yaw;
    this.seq = 0;
    this.t = 0;
    for (let i = 0; i < settle; i++) this.step({ yaw });
    return this;
  }

  step(o = {}) {
    this.world.step();
    const cmd = quantizeMoveCommand({
      seq: this.seq, tick: this.seq, dt: DT,
      moveX: o.moveX ?? 0, moveY: o.moveY ?? 0,
      yaw: o.yaw ?? this.yaw ?? 0, pitch: 0,
      buttons: o.buttons ?? 0,
    });
    this.seq++;
    this.t += DT;
    if (o.yaw !== undefined) this.yaw = o.yaw;
    return this.mv.stepCommand(cmd);
  }

  get pos() { return this.mv.position; }
  get vel() { return this.mv.velocity; }
  get hs() { return Math.hypot(this.mv.velocity.x, this.mv.velocity.z); }
  get feet() { return this.mv.position.y - this.mv.height * 0.5; }
  get grounded() { return this.mv.out.grounded; }
  get state() { return this.mv.out.state; }
}

/** Runs `n` steps with a constant input, returns per-step samples. */
function run(rig, n, inputAt, sample) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const inp = typeof inputAt === 'function' ? inputAt(i, rig) : inputAt;
    const res = rig.step(inp);
    if (sample) out.push(sample(i, rig, res));
  }
  return out;
}

/** Sprints forward until the horizontal speed plateaus, returns that speed. */
function windUp(rig, steps, tac = false) {
  const btn = BTN.SPRINT;
  run(rig, steps, () => ({ moveY: 1, buttons: btn }));
  void tac;
  return rig.hs;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

/* -------------------------------------------------------------- scenarios -- */

const results = {};

/* 1 — kerb: a 150 mm step must cost no airtime and almost no speed. */
function testKerb(world) {
  const out = { heights: [] };
  for (const [h, z] of [[0.15, -10], [0.30, -20], [0.45, -30]]) {
    // Start the run-up a fixed distance in front of this kerb, so every height
    // is approached at the same settled speed over the same distance.
    const rig = new Rig(world).place(LANE.kerb, z + 22, 0);
    const v0 = windUp(rig, 200);
    let airTicks = 0, minSpeed = Infinity, maxVy = 0, crossed = false, speedAfter = 0;
    let peakRise = 0;
    const startFeet = rig.feet;
    run(rig, 420, () => ({ moveY: 1, buttons: BTN.SPRINT }), (i, r) => {
      const z0 = r.pos.z;
      if (z0 < z + 1.2 && z0 > z - 4.0) {
        if (!r.grounded) airTicks++;
        maxVy = Math.max(maxVy, r.vel.y);
        minSpeed = Math.min(minSpeed, r.hs);
        peakRise = Math.max(peakRise, r.feet - startFeet - h);
        crossed = true;
      }
      if (z0 < z - 2.0 && z0 > z - 4.0) speedAfter = r.hs;
    });
    out.heights.push({
      stepHeight: h, crossed, finalZ: r2(rig.pos.z), finalFeet: r3(rig.feet), targetZ: z, entrySpeed: r3(v0), minSpeed: r3(minSpeed),
      exitSpeed: r3(speedAfter), speedLossPct: r1(100 * (1 - minSpeed / v0)),
      airborneTicks: airTicks, peakUpwardVy: r3(maxVy), overshootAboveStep: r3(peakRise),
    });
  }
  return out;
}

/* 2 — slopes: the audit certified 4.55 m/s with zero airborne ticks.
 *
 * Measured from the actual per-tick displacement, not from `velocity`. On a
 * ramp the movement code keeps `velocity` horizontal and the controller
 * reprojects the motion onto the surface, so reading the velocity vector tells
 * you what the player asked for and the displacement tells you what they got.
 * The certified claim is about what they got. */
function testSlopes(world) {
  const out = [];
  for (const [deg, lane] of [[30, LANE.ramp30], [40, LANE.ramp40]]) {
    const rig = new Rig(world).place(lane, START_Z, 0);
    run(rig, 520, () => ({ moveY: 1 }));            // run (not sprint) onto the ramp
    let air = 0, n = 0, sum = 0, sumH = 0, minS = Infinity, maxS = 0;
    let prev = rig.pos.clone();
    const outliers = [];
    run(rig, 900, () => ({ moveY: 1 }), (i, r) => {
      const dx = r.pos.x - prev.x, dy = r.pos.y - prev.y, dz = r.pos.z - prev.z;
      prev.copy(r.pos);
      if (r.pos.z < -5 && r.pos.z > -25) {
        n++;
        const s = Math.sqrt(dx * dx + dy * dy + dz * dz) / DT;
        const h = Math.sqrt(dx * dx + dz * dz) / DT;
        sum += s; sumH += h;
        minS = Math.min(minS, s); maxS = Math.max(maxS, s);
        if ((s < 4.55 * 0.88 || s > 4.55 * 1.12) && outliers.length < 12) {
          const rr = r.mv.result;
          outliers.push({ tick: i, z: r2(r.pos.z), disp: r3(s), dy: r3(dy), hs: r3(r.hs), state: r.state,
            blocked: rr.blocked, stepped: rr.stepped, stepRise: r3(rr.stepRise), gn: r3(rr.groundNormal.y) });
        }
        if (!r.grounded) air++;
      }
    });
    out.push({
      slopeDeg: deg, meanSpeed: r3(sum / Math.max(1, n)),
      minSpeed: r3(minS), maxSpeed: r3(maxS),
      meanHorizontal: r3(sumH / Math.max(1, n)),
      expectedHorizontal: r3(4.55 * Math.cos(deg * DEG)),
      airborneTicks: air, samples: n,
      outlierTicks: outliers.length, outliers,
    });
  }
  return out;
}

/* 3 — jump: apex height and air time must stay CoD-correct. */
function testJump(world) {
  const rig = new Rig(world).place(LANE.jump, START_Z, 0);
  run(rig, 60, {});
  const y0 = rig.feet;
  let apex = 0, air = 0, started = false;
  run(rig, 200, (i) => ({ buttons: i < 3 ? BTN.JUMP : 0 }), (i, r) => {
    if (!r.grounded) { started = true; air++; apex = Math.max(apex, r.feet - y0); }
  });
  return { apexM: r3(apex), airTimeS: r3(air / HZ), airTicks: air, started };
}

/* 4 — crouch transition must keep the feet planted. */
function testCrouch(world) {
  const rig = new Rig(world).place(LANE.crouch, START_Z, 0);
  run(rig, 60, {});
  const base = rig.feet;
  let worst = 0;
  run(rig, 90, () => ({ buttons: BTN.CROUCH }), (i, r) => {
    worst = Math.max(worst, Math.abs(r.feet - base));
  });
  run(rig, 90, () => ({}), (i, r) => {
    worst = Math.max(worst, Math.abs(r.feet - base));
  });
  return { worstFootDriftMm: r2(worst * 1000) };
}

/* 5 — slide on flat: entry, peak, distance, duration. */
function testSlideFlat(world) {
  const rig = new Rig(world).place(LANE.slideFlat, START_Z, 0);
  const entry = windUp(rig, 260);
  const p0 = rig.pos.clone();
  let peak = 0, ticks = 0, ended = -1, exitSpeed = 0;
  const dist = () => Math.hypot(rig.pos.x - p0.x, rig.pos.z - p0.z);
  run(rig, 400, () => ({ moveY: 1, buttons: BTN.CROUCH }), (i, r) => {
    if (r.state === 'slide') { ticks++; peak = Math.max(peak, r.hs); }
    else if (ticks > 0 && ended < 0) { ended = i; exitSpeed = r.hs; }
  });
  return {
    entrySpeed: r3(entry), peakSpeed: r3(peak),
    durationS: r3(ticks / HZ), distanceM: r3(ended > 0 ? 0 : 0) || undefined,
    slideDistanceM: r3(distanceFromRun(rig, p0, ended)),
    exitSpeed: r3(exitSpeed),
  };
}
function distanceFromRun(rig, p0, ended) {
  void ended;
  return Math.hypot(rig.pos.x - p0.x, rig.pos.z - p0.z);
}

/* 6 — slide downhill must ACCELERATE. */
function testSlideDownhill(world) {
  const out = [];
  for (const [deg, lane] of [[30, LANE.ramp30], [40, LANE.ramp40]]) {
    const rig = new Rig(world);
    // Start high on the ramp, face downhill (+z).
    rig.place(lane, -26, Math.PI);
    const entry = windUp(rig, 140);
    let peak = 0, ticks = 0, entrySlide = -1;
    run(rig, 300, () => ({ moveY: 1, buttons: BTN.CROUCH }), (i, r) => {
      if (r.state === 'slide') {
        ticks++;
        if (entrySlide < 0) entrySlide = r.hs;
        peak = Math.max(peak, r.hs);
      }
    });
    out.push({
      slopeDeg: deg, sprintSpeed: r3(entry), slideEntry: r3(entrySlide),
      peakSpeed: r3(peak), accelerated: peak > entrySlide + 0.05,
      durationS: r3(ticks / HZ),
    });
  }
  return out;
}

/* 7 — slide-jump chain: three chained slide-jumps must keep >= 90% of speed. */
function testSlideJumpChain(world) {
  const rig = new Rig(world).place(LANE.slideJump, START_Z, 0);
  const v0 = windUp(rig, 260);
  const chain = [];
  let i = 0;
  for (let hop = 0; hop < 3; hop++) {
    // slide for 0.30 s
    for (let k = 0; k < 36; k++) { rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.CROUCH }); i++; }
    // jump out of the slide
    rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.CROUCH | BTN.JUMP });
    rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP });
    // fly until we land again
    let air = 0;
    while (!rig.grounded && air < 200) { rig.step({ moveY: 1, buttons: BTN.SPRINT }); air++; }
    chain.push({ hop: hop + 1, speedAfterLanding: r3(rig.hs), airTicks: air });
  }
  return { startSpeed: r3(v0), chain, retentionPct: r1(100 * rig.hs / v0) };
}

/* 8 — air-strafe: optimal vs naive. The GAP is the skill expression.
 *
 * "Optimal" is computed, not guessed. Each airborne tick the script solves for
 * the wish direction that maximises the speed gain under the capped-wish model
 *
 *     Δv ≈ a·cos θ,   a = min(k·dt, cap − v·cos θ)
 *
 * whose optimum sits at v·cos θ = cap − k·dt, then derives the view yaw that
 * puts the strafe key on that direction. That is exactly what a perfect
 * strafe-jumper does with their mouse, and the script records the turn rate it
 * needed so we can say whether a human could produce it.
 *
 * "Naive" holds sprint and forward and jumps on the same rhythm. */
function strafeChain(world, lane, mode, hops = 5, humanTurnCapDegPerSec = Infinity) {
  const rig = new Rig(world).place(lane, START_Z, 0);
  const base = windUp(rig, 320);
  let peak = base, yaw = 0, dir = 1, maxTurnRate = 0, airTicks = 0;
  const perHop = [];
  const capW = TUNING.airWishCap;
  const kdt = TUNING.airAccel * DT;
  let pathLen = 0, prevP = rig.pos.clone();

  for (let hop = 0; hop < hops; hop++) {
    rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP, yaw });
    let air = 0;
    while (!rig.grounded && air < 240) {
      if (mode === 'naive') {
        rig.step({ moveY: 1, buttons: BTN.SPRINT, yaw });
      } else {
        const v = rig.vel, sp = Math.hypot(v.x, v.z);
        // Target angle between velocity and the wish direction.
        const target = Math.acos(THREE.MathUtils.clamp((capW - kdt) / Math.max(sp, 1e-4), -1, 1));
        const vAng = Math.atan2(v.x, -v.z);            // yaw-space angle of velocity
        // Flip the strafe side whenever the heading has drifted off the line —
        // strafe-jumping is an S-curve about a straight course, not a spiral.
        if (vAng * dir > HEADING_TOLERANCE) dir = -dir;
        const wishAng = vAng + target * dir;
        const wx = Math.sin(wishAng), wz = -Math.cos(wishAng);
        // moveX = dir puts the wish on the right (dir=+1) or left (dir=-1) vector.
        const want = dir > 0 ? Math.atan2(-wz, wx) : Math.atan2(wz, -wx);
        let d = want - yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const lim = humanTurnCapDegPerSec * DEG * DT;
        if (d > lim) d = lim; else if (d < -lim) d = -lim;
        maxTurnRate = Math.max(maxTurnRate, Math.abs(d) / DT / DEG);
        yaw += d;
        rig.step({ moveX: dir, moveY: 0, buttons: BTN.SPRINT, yaw });
      }
      pathLen += Math.hypot(rig.pos.x - prevP.x, rig.pos.z - prevP.z);
      prevP.copy(rig.pos);
      peak = Math.max(peak, rig.hs);
      air++; airTicks++;
    }
    perHop.push({ hop: hop + 1, airTicks: air, speed: r3(rig.hs) });
  }
  return {
    base, peak, final: rig.hs, perHop, airTicks,
    maxTurnRateDegPerSec: r1(maxTurnRate), pathLen,
  };
}

function testAirStrafe(world) {
  const naive = strafeChain(world, LANE.strafeNaive, 'naive');
  const opt = strafeChain(world, LANE.strafeOpt, 'strafe');
  // A turn rate a human can actually produce: 400 °/s is a flick, and a good
  // player sustains it through a strafe. Reported so the "optimal" number is
  // not a robot-only figure.
  const human = strafeChain(world, LANE.strafeHuman, 'strafe', 5, 400);
  // Base sprint = the plateau a player reaches by holding sprint + forward.
  // Reported against both that and TUNING.sprintSpeed, because "base sprint"
  // could reasonably mean either and the harder reading is the honest one.
  const plateau = naive.base;
  return {
    groundPlateau: r3(plateau),
    tuningSprintSpeed: TUNING.sprintSpeed,
    naivePeak: r3(naive.peak), naiveRatio: r3(naive.peak / plateau),
    optimalPeak: r3(opt.peak), optimalRatio: r3(opt.peak / plateau),
    optimalRatioVsTuningSprint: r3(opt.peak / TUNING.sprintSpeed),
    humanCappedPeak: r3(human.peak), humanCappedRatio: r3(human.peak / plateau),
    optimalTurnRateDegPerSec: opt.maxTurnRateDegPerSec,
    gapRatio: r3(opt.peak / Math.max(0.001, naive.peak)),
    naiveHops: naive.perHop, optimalHops: opt.perHop,
  };
}

/* 9 — single-jump air-strafe gain, isolated from any hop chaining. */
function testSingleAirStrafe(world) {
  const one = strafeChain(world, LANE.strafeSingle, 'strafe', 1);
  return {
    entrySpeed: r3(one.base), peakSpeed: r3(one.peak),
    gain: r3(one.peak - one.base), airTicks: one.airTicks,
  };
}

/* 10 — tap-strafe: a mid-air re-press of forward should redirect, not brake. */
function testTapStrafe(world) {
  const rig = new Rig(world).place(LANE.tapStrafe, START_Z, 0);
  const v0 = windUp(rig, 300);
  rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP });
  let yaw = 0, air = 0;
  const dirBefore = new THREE.Vector3(rig.vel.x, 0, rig.vel.z).normalize();
  const TURN = Math.PI / 40;
  let taps = 0;
  while (!rig.grounded && air < 240) {
    if (air < 40) yaw += TURN;
    const tap = air % 4 < 2;    // release/re-press forward: the tap-strafe input
    if (tap && air % 4 === 0) taps++;
    rig.step({ moveY: tap ? 1 : 0, buttons: BTN.SPRINT, yaw });
    air++;
  }
  const dirAfter = new THREE.Vector3(rig.vel.x, 0, rig.vel.z).normalize();
  const turnedDeg = Math.acos(THREE.MathUtils.clamp(dirBefore.dot(dirAfter), -1, 1)) / DEG;

  // Control: the same 180° of mouse with forward simply HELD. Continuous air
  // control still curves you, but far less — the gap is the mechanic.
  const ctl = new Rig(world).place(LANE.tapControl, START_Z, 0);
  const c0 = windUp(ctl, 300);
  ctl.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP });
  const cBefore = new THREE.Vector3(ctl.vel.x, 0, ctl.vel.z).normalize();
  let cy = 0, ca = 0;
  while (!ctl.grounded && ca < 240) {
    if (ca < 40) cy += TURN;
    ctl.step({ moveY: 1, buttons: BTN.SPRINT, yaw: cy });
    ca++;
  }
  const cAfter = new THREE.Vector3(ctl.vel.x, 0, ctl.vel.z).normalize();

  return {
    entrySpeed: r3(v0), exitSpeed: r3(rig.hs),
    redirectDeg: r1(turnedDeg), retentionPct: r1(100 * rig.hs / v0),
    taps, airTicks: air,
    heldForwardRedirectDeg: r1(Math.acos(THREE.MathUtils.clamp(cBefore.dot(cAfter), -1, 1)) / DEG),
    heldForwardRetentionPct: r1(100 * ctl.hs / c0),
  };
}

/* 11 — bunny-hop retention over consecutive well-timed jumps. */
function testBhop(world) {
  const rig = new Rig(world).place(LANE.bhop, START_Z, 0);
  const v0 = windUp(rig, 300);
  const speeds = [];
  for (let hop = 0; hop < 6; hop++) {
    rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP });
    let air = 0;
    while (!rig.grounded && air < 240) { rig.step({ moveY: 1, buttons: BTN.SPRINT }); air++; }
    speeds.push(r3(rig.hs));
  }
  return { startSpeed: r3(v0), perHopSpeed: speeds, retentionPct: r1(100 * rig.hs / v0) };
}

/* 12 — mantle ladder: which ledge heights succeed. */
function testMantle(world) {
  const rows = [];
  for (let i = 0; i < LEDGE_HEIGHTS.length; i++) {
    const h = LEDGE_HEIGHTS[i];
    const z = ledgeZ(i);
    const rig = new Rig(world).place(LANE.ledge, z + 4.5, 0);
    const startFeet = rig.feet;
    let sawMantle = false, mantleTicks = 0, endFeet = startFeet, kind = '', climbHeight = 0;
    run(rig, 480, (k) => ({
      moveY: 1,
      // Jump is re-pressed on a rhythm so the edge keeps re-arming: a climb is
      // started by jumping into the wall, exactly as in Apex.
      buttons: BTN.SPRINT | (k > 20 && k % 24 < 4 ? BTN.JUMP : 0),
    }), (k, r) => {
      if (r.mv.out.mantleStarted) { kind = r.mv.out.mantleKind; climbHeight = r.mv.out.mantleHeight; }
      if (r.state === 'mantle') { sawMantle = true; mantleTicks++; }
      endFeet = Math.max(endFeet, r.feet);
    });
    rows.push({
      ledgeHeightM: h, ratioOfCharacterHeight: r2(h / TUNING.standHeight),
      mantled: sawMantle, mantleTicks, mantleSeconds: r3(mantleTicks / HZ),
      kind, reportedHeightM: r3(climbHeight),
      climbedM: r3(endFeet - startFeet), onTop: endFeet > startFeet + h - 0.12,
    });
  }
  return rows;
}

/* 13 — wall-bounce: shallow-angle wall contact while airborne. */
function testWallBounce(world) {
  const wallX = LANE.wall + 6 - 0.5;      // the face, not the centre
  const rig = new Rig(world).place(wallX - 11, -20, 0);
  // Face 22° into the wall (the wall runs along z; our side's normal is -x).
  const yaw = -22 * DEG;
  // Run up to speed on a line that closes on the wall, then jump with just
  // enough room left that the contact happens airborne.
  let guard = 0;
  while (wallX - rig.pos.x > 1.2 && guard++ < 900) rig.step({ moveY: 1, buttons: BTN.SPRINT, yaw });
  const before = rig.hs;
  const dirBefore = new THREE.Vector3(rig.vel.x, 0, rig.vel.z).normalize();
  rig.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP, yaw });
  let air = 0, bounceSpeed = -1, bounced = false;
  const dirAfter = new THREE.Vector3();
  while (!rig.grounded && air < 240) {
    rig.step({ moveY: 1, buttons: BTN.SPRINT, yaw });
    if (rig.mv.out.wallBounce) {
      bounced = true;
      bounceSpeed = rig.hs;
      // Sampled on the bounce tick: the mechanic's output, before the player's
      // own held-forward input starts steering again.
      dirAfter.set(rig.vel.x, 0, rig.vel.z).normalize();
    }
    air++;
  }
  if (!bounced) dirAfter.set(rig.vel.x, 0, rig.vel.z).normalize();
  const speedAfterBounce = bounced ? bounceSpeed : rig.hs;

  // Control: the same approach with the bounce suppressed by coming in steep
  // (70° into the wall), which must NOT bounce — a wall-bounce has to be a
  // shallow-angle mechanic or it is just a trampoline.
  const ctl = new Rig(world).place(wallX - 11, -20, 0);
  const steepYaw = -60 * DEG;
  let g2 = 0;
  while (wallX - ctl.pos.x > 1.2 && g2++ < 900) ctl.step({ moveY: 1, buttons: BTN.SPRINT, yaw: steepYaw });
  const beforeSteep = ctl.hs;
  ctl.step({ moveY: 1, buttons: BTN.SPRINT | BTN.JUMP, yaw: steepYaw });
  let a2 = 0, steepBounced = false;
  while (!ctl.grounded && a2 < 240) {
    ctl.step({ moveY: 1, buttons: BTN.SPRINT, yaw: steepYaw });
    if (ctl.mv.out.wallBounce) steepBounced = true;
    a2++;
  }

  return {
    approachSpeed: r3(before), speedAtBounce: r3(bounceSpeed), speedAfter: r3(speedAfterBounce),
    speedAtLanding: r3(rig.hs),
    retentionPct: r1(100 * speedAfterBounce / before),
    turnedDeg: r1(Math.acos(THREE.MathUtils.clamp(dirBefore.dot(dirAfter), -1, 1)) / DEG),
    bounced, bounceCount: rig.mv.wallBounceCount,
    steepApproachSpeed: r3(beforeSteep), steepBounced, steepAngleDeg: 60,
    steepRetentionPct: r1(100 * ctl.hs / beforeSteep),
  };
}

/* 14 — skill gap: distance covered in 8 s, naive vs expert.
 *
 * Naive: hold sprint + forward, which is what the game asks of you.
 * Expert: sprint → slide → jump out of the slide → air-strafe → land already
 * holding crouch so the next slide starts on the landing tick. This is the
 * canonical Apex traversal loop and the whole point of the package. */
function testSkillGap(world) {
  const SECONDS = 8;
  const N = SECONDS * HZ;

  const a = new Rig(world).place(LANE.skillNaive, START_Z, 0);
  const pa = a.pos.clone();
  run(a, N, () => ({ moveY: 1, buttons: BTN.SPRINT }));
  const naive = Math.hypot(a.pos.x - pa.x, a.pos.z - pa.z);

  const b = new Rig(world).place(LANE.skillExpert, START_Z, 0);
  windUp(b, 140);
  const pb = b.pos.clone();
  let yaw = 0, dir = 1, i = 140;
  const capW = TUNING.airWishCap, kdt = TUNING.airAccel * DT;
  let peak = 0;
  while (i < N) {
    // Slide until it stops paying (0.30 s on the flat).
    for (let k = 0; k < 36 && i < N; k++, i++) {
      b.step({ moveY: 1, buttons: BTN.SPRINT | BTN.CROUCH, yaw });
      peak = Math.max(peak, b.hs);
    }
    // Jump out of the slide.
    b.step({ moveY: 1, buttons: BTN.SPRINT | BTN.CROUCH | BTN.JUMP, yaw }); i++;
    // Air-strafe for the whole flight.
    let air = 0;
    while (!b.grounded && i < N && air < 240) {
      const v = b.vel, sp = Math.hypot(v.x, v.z);
      const target = Math.acos(THREE.MathUtils.clamp((capW - kdt) / Math.max(sp, 1e-4), -1, 1));
      const vAng = Math.atan2(v.x, -v.z);
      if (vAng * dir > HEADING_TOLERANCE) dir = -dir;
      const wishAng = vAng + target * dir;
      const wx = Math.sin(wishAng), wz = -Math.cos(wishAng);
      const want = dir > 0 ? Math.atan2(-wz, wx) : Math.atan2(wz, -wx);
      let d = want - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const lim = 400 * DEG * DT;                    // human-achievable turn rate
      if (d > lim) d = lim; else if (d < -lim) d = -lim;
      yaw += d;
      b.step({ moveX: dir, moveY: 0, buttons: BTN.SPRINT | BTN.CROUCH, yaw });
      peak = Math.max(peak, b.hs);
      i++; air++;
    }
  }
  const expert = Math.hypot(b.pos.x - pb.x, b.pos.z - pb.z);
  const expertSeconds = (N - 140) / HZ;
  return {
    seconds: SECONDS,
    naiveDistanceM: r2(naive), naiveMeanSpeed: r3(naive / SECONDS),
    expertDistanceM: r2(expert), expertMeanSpeed: r3(expert / expertSeconds),
    expertPeakSpeed: r3(peak),
    skillGapPct: r1(100 * ((expert / expertSeconds) / (naive / SECONDS) - 1)),
  };
}

/* 15 — determinism: the same script twice must land on the same bits. */
function testDeterminism(world) {
  const scriptOne = (lane) => {
    const rig = new Rig(world).place(lane, START_Z, 0);
    let yaw = 0;
    for (let i = 0; i < 900; i++) {
      yaw += Math.sin(i * 0.017) * 0.01;
      rig.step({
        moveX: Math.sin(i * 0.05), moveY: Math.cos(i * 0.031),
        yaw, buttons: (i % 97 < 6 ? BTN.JUMP : 0) | (i % 53 < 20 ? BTN.CROUCH : 0) | BTN.SPRINT,
      });
    }
    return rig;
  };
  const a = scriptOne(LANE.determinism);
  const b = scriptOne(LANE.determinism);
  const sa = a.mv.capture(), sb = b.mv.capture();
  const keys = Object.keys(sa);
  const diffs = keys.filter((k) => sa[k] !== sb[k]);
  return { fields: keys.length, differing: diffs, deterministic: diffs.length === 0 };
}

/* ------------------------------------------------------------------- main -- */

const world = buildWorld();

results.tuning = {
  runSpeed: TUNING.runSpeed, sprintSpeed: TUNING.sprintSpeed,
  tacSprintSpeed: TUNING.tacSprintSpeed, standHeight: TUNING.standHeight,
  jumpVelocity: TUNING.jumpVelocity, gravity: TUNING.gravity,
};
results.kerb = testKerb(world);
results.slopes = testSlopes(world);
results.jump = testJump(world);
results.crouch = testCrouch(world);
results.slideFlat = testSlideFlat(world);
results.slideDownhill = testSlideDownhill(world);
results.slideJumpChain = testSlideJumpChain(world);
results.airStrafe = testAirStrafe(world);
results.singleAirStrafe = testSingleAirStrafe(world);
results.tapStrafe = testTapStrafe(world);
results.bhop = testBhop(world);
results.mantle = testMantle(world);
results.wallBounce = testWallBounce(world);
results.skillGap = testSkillGap(world);
results.determinism = testDeterminism(world);

/* ------------------------------------------------------------------ gates -- */

const G = [];
const gate = (name, pass, measured) => G.push({ gate: name, pass: !!pass, measured });

const kerb15 = results.kerb.heights.find((h) => h.stepHeight === 0.15);
gate('kerb 150 mm: 0 airborne ticks', kerb15.airborneTicks === 0, `${kerb15.airborneTicks} ticks`);
gate('kerb 150 mm: < 5% horizontal speed lost', kerb15.speedLossPct < 5,
  `${kerb15.speedLossPct}% (entry ${kerb15.entrySpeed} → min ${kerb15.minSpeed} m/s)`);
gate('kerb 150 mm: no upward velocity injected', kerb15.peakUpwardVy < 0.05,
  `peak vy ${kerb15.peakUpwardVy} m/s`);

for (const s of results.slopes) {
  gate(`slope ${s.slopeDeg}°: |v| = 4.55 m/s`, Math.abs(s.meanSpeed - 4.55) < 0.06,
    `mean ${s.meanSpeed} m/s (min ${s.minSpeed}, max ${s.maxSpeed})`);
  gate(`slope ${s.slopeDeg}°: 0 airborne ticks`, s.airborneTicks === 0, `${s.airborneTicks} ticks`);
  gate(`slope ${s.slopeDeg}°: horizontal = 4.55·cos θ`,
    Math.abs(s.meanHorizontal - s.expectedHorizontal) < 0.06,
    `${s.meanHorizontal} vs ${s.expectedHorizontal} m/s`);
  // Smoothness. The user's complaint was "not smooth", which is a per-tick
  // property and invisible in a mean. A hitch here is a solver artefact, not a
  // design choice, so it gets a gate of its own.
  gate(`slope ${s.slopeDeg}°: < 1% of ticks off-pace by >12%`,
    s.outlierTicks / Math.max(1, s.samples) < 0.01,
    `${s.outlierTicks}/${s.samples} ticks (worst ${s.minSpeed}–${s.maxSpeed} m/s vs 4.55)`);
  gate(`slope ${s.slopeDeg}°: no tick exceeds 1.4x pace`,
    s.maxSpeed < 4.55 * 1.4,
    `worst tick ${s.maxSpeed} m/s`);
}

gate('jump apex 0.732 m', Math.abs(results.jump.apexM - 0.732) < 0.02, `${results.jump.apexM} m`);
gate('jump air time 0.517 s', Math.abs(results.jump.airTimeS - 0.517) < 0.02, `${results.jump.airTimeS} s`);
gate('crouch keeps feet planted < 5 mm', results.crouch.worstFootDriftMm < 5,
  `${results.crouch.worstFootDriftMm} mm`);

gate('slide accelerates downhill (30°)', results.slideDownhill[0].accelerated,
  `entry ${results.slideDownhill[0].slideEntry} → peak ${results.slideDownhill[0].peakSpeed} m/s`);
gate('slide accelerates downhill (40°)', results.slideDownhill[1].accelerated,
  `entry ${results.slideDownhill[1].slideEntry} → peak ${results.slideDownhill[1].peakSpeed} m/s`);
gate('3 chained slide-jumps retain >= 90%', results.slideJumpChain.retentionPct >= 90,
  `${results.slideJumpChain.retentionPct}%`);
gate('optimal air-strafe >= 1.35x base sprint', results.airStrafe.optimalRatio >= 1.35,
  `${results.airStrafe.optimalRatio}x of the ${results.airStrafe.groundPlateau} m/s ground plateau `
  + `(${results.airStrafe.optimalPeak} m/s; ${results.airStrafe.optimalRatioVsTuningSprint}x of TUNING.sprintSpeed)`);
gate('naive jump <= 1.05x base sprint', results.airStrafe.naiveRatio <= 1.05,
  `${results.airStrafe.naiveRatio}x (${results.airStrafe.naivePeak} m/s)`);
gate('human-rate air-strafe (400 °/s cap) >= 1.25x', results.airStrafe.humanCappedRatio >= 1.25,
  `${results.airStrafe.humanCappedRatio}x (${results.airStrafe.humanCappedPeak} m/s)`);

const maxOk = results.mantle.filter((m) => m.mantled).reduce((a, m) => Math.max(a, m.ledgeHeightM), 0);
const target = 2.5 * TUNING.standHeight;
gate(`mantle succeeds up to 2.5x height (${r2(target)} m)`, maxOk >= target - 0.05,
  `highest mantled ${maxOk} m`);
const above = results.mantle.filter((m) => m.ledgeHeightM > target + 0.15);
gate('mantle fails cleanly above 2.5x height', above.length > 0 && above.every((m) => !m.mantled),
  above.map((m) => `${m.ledgeHeightM}m:${m.mantled ? 'MANTLED' : 'refused'}`).join(' '));

gate('tap-strafe redirects >= 90°', results.tapStrafe.redirectDeg >= 90,
  `${results.tapStrafe.redirectDeg}° at ${results.tapStrafe.retentionPct}% speed (${results.tapStrafe.taps} taps)`);
gate('tap-strafe keeps >= 95% of speed', results.tapStrafe.retentionPct >= 95,
  `${results.tapStrafe.retentionPct}%`);
gate('tap-strafe out-turns held-forward air control', results.tapStrafe.redirectDeg > results.tapStrafe.heldForwardRedirectDeg + 25,
  `tap ${results.tapStrafe.redirectDeg}° vs held ${results.tapStrafe.heldForwardRedirectDeg}°`);
gate('wall-bounce fires on a shallow contact', results.wallBounce.bounced,
  `${results.wallBounce.bounceCount} bounce(s), turned ${results.wallBounce.turnedDeg}°`);
gate('wall-bounce redirects >= 30°', results.wallBounce.turnedDeg >= 30,
  `${results.wallBounce.turnedDeg}° off a 22° approach`);
gate('wall-bounce retains >= 85% speed', results.wallBounce.bounced && results.wallBounce.retentionPct >= 85,
  `${results.wallBounce.retentionPct}% (${results.wallBounce.approachSpeed} → ${results.wallBounce.speedAfter} m/s)`);
gate('steep wall contact does NOT bounce', !results.wallBounce.steepBounced,
  `60° approach: ${results.wallBounce.steepBounced ? 'BOUNCED' : 'absorbed'}, kept ${results.wallBounce.steepRetentionPct}%`);
gate('bunny-hop retains >= 95% over 6 hops', results.bhop.retentionPct >= 95,
  `${results.bhop.retentionPct}%`);
gate('skill gap >= 25%', results.skillGap.skillGapPct >= 25,
  `expert ${results.skillGap.expertMeanSpeed} vs naive ${results.skillGap.naiveMeanSpeed} m/s (+${results.skillGap.skillGapPct}%)`);
gate('deterministic replay', results.determinism.deterministic,
  results.determinism.differing.join(',') || 'all fields identical');

results.gates = G;

/* ----------------------------------------------------------------- output -- */

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n=== G1 MOVEMENT LAB ===\n');
  console.log('KERB');
  for (const h of results.kerb.heights) {
    console.log(`  ${pad(h.stepHeight + ' m', 8)} air ${pad(h.airborneTicks, 4)} loss ${pad(h.speedLossPct + '%', 8)} vy ${pad(h.peakUpwardVy, 8)} entry ${h.entrySpeed} → ${h.exitSpeed} m/s`);
  }
  console.log('\nSLOPES');
  for (const s of results.slopes) {
    console.log(`  ${pad(s.slopeDeg + '°', 5)} |v| ${pad(s.meanSpeed, 7)} horiz ${pad(s.meanHorizontal, 7)} (want ${s.expectedHorizontal}) air ${s.airborneTicks}`);
  }
  console.log(`\nJUMP    apex ${results.jump.apexM} m, air ${results.jump.airTimeS} s`);
  console.log(`CROUCH  worst foot drift ${results.crouch.worstFootDriftMm} mm`);
  console.log(`\nSLIDE flat  entry ${results.slideFlat.entrySpeed} peak ${results.slideFlat.peakSpeed} dist ${results.slideFlat.slideDistanceM} m dur ${results.slideFlat.durationS} s exit ${results.slideFlat.exitSpeed}`);
  for (const d of results.slideDownhill) {
    console.log(`SLIDE ${d.slopeDeg}°   entry ${d.slideEntry} → peak ${d.peakSpeed} m/s  accel=${d.accelerated}  ${d.durationS} s`);
  }
  console.log(`\nSLIDE-JUMP  start ${results.slideJumpChain.startSpeed} → ${results.slideJumpChain.retentionPct}%  ${JSON.stringify(results.slideJumpChain.chain)}`);
  console.log(`AIR-STRAFE  plateau ${results.airStrafe.groundPlateau}  naive ${results.airStrafe.naivePeak} (${results.airStrafe.naiveRatio}x)  optimal ${results.airStrafe.optimalPeak} (${results.airStrafe.optimalRatio}x)  human-400°/s ${results.airStrafe.humanCappedPeak} (${results.airStrafe.humanCappedRatio}x)  needed ${results.airStrafe.optimalTurnRateDegPerSec}°/s`);
  console.log(`SINGLE JUMP strafe gain ${results.singleAirStrafe.gain} m/s (${results.singleAirStrafe.entrySpeed} → ${results.singleAirStrafe.peakSpeed})`);
  console.log(`TAP-STRAFE  ${results.tapStrafe.redirectDeg}° redirect, ${results.tapStrafe.retentionPct}% speed  (held-forward control: ${results.tapStrafe.heldForwardRedirectDeg}°)`);
  console.log(`BHOP        ${results.bhop.perHopSpeed.join(' → ')}  (${results.bhop.retentionPct}%)`);
  console.log(`WALL-BOUNCE ${results.wallBounce.approachSpeed} → ${results.wallBounce.speedAfter} m/s (${results.wallBounce.retentionPct}%), turned ${results.wallBounce.turnedDeg}°, fired=${results.wallBounce.bounced}; steep 60° bounced=${results.wallBounce.steepBounced}`);
  console.log('\nMANTLE');
  for (const m of results.mantle) {
    console.log(`  ${pad(m.ledgeHeightM + ' m', 8)} ${pad(m.ratioOfCharacterHeight + 'x', 7)} ${m.mantled ? 'CLIMB' : ' --- '} ${pad(m.mantleSeconds + ' s', 9)} ${pad(m.kind || '-', 8)} rose ${m.climbedM} m`);
  }
  console.log(`\nSKILL GAP   naive ${results.skillGap.naiveMeanSpeed} m/s (${results.skillGap.naiveDistanceM} m) vs expert ${results.skillGap.expertMeanSpeed} m/s (peak ${results.skillGap.expertPeakSpeed})  (+${results.skillGap.skillGapPct}%)`);
  console.log('\n=== GATES ===');
  let fails = 0;
  for (const g of G) {
    if (!g.pass) fails++;
    console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${pad(g.gate, 46)} ${g.measured}`);
  }
  console.log(`\n${G.length - fails}/${G.length} gates pass\n`);
  process.exitCode = fails ? 1 : 0;
}
