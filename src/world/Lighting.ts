/**
 * Lighting design.
 *
 * The sky owns the key light, so this module owns everything else: the
 * practical lights that make interiors read as interiors, and the fires that
 * give the square its warm accents against a cool late-afternoon sky.
 *
 * ## Why a pool
 *
 * Three.js bakes the light count into every shader it compiles, so a level
 * cannot simply add forty point lights — that is forty per-fragment loops on
 * every surface in the game, and changing the count mid-fight recompiles the
 * world. Instead the level authors forty *practical light definitions* and a
 * small fixed pool of real point lights is re-pointed at the most relevant ones
 * each frame, cross-fading so nothing pops. This is exactly how shipped
 * engines handle light relevance, and it means the pool size can track the
 * quality preset without the level changing.
 *
 * ## Why the photocell lives here
 *
 * A street lamp is not "on"; it is *switched by how dark it is outside*, and
 * so is its lens. Running the light and the glowing fixture off two different
 * rules is exactly how you end up with lit bulbs in a noon frame, so this
 * module owns both: it reads the sun's illuminance out of the renderer's
 * shared uniform block, turns it into a single `night` value, gates the point
 * lights with it and hands the same value to `setPracticalNight` so every lamp
 * lens, sign panel and ember in the material catalogue follows.
 *
 * Gating the *score* as well as the intensity matters more than it looks: with
 * the lamps switched off at 16:00 the whole pool is free for the interior
 * practicals, which is what puts light inside the shops and the warehouse in a
 * daylight frame.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import { setPracticalNight } from './MatCatalog';

export type PracticalKind = 'sodium' | 'bulb' | 'fire' | 'fluoro' | 'signage';

export interface Practical {
  x: number; y: number; z: number;
  color: number;
  /** Peak intensity in the renderer's point-light units. */
  intensity: number;
  radius: number;
  kind: PracticalKind;
  /** Only relevant when the camera is inside this radius of the volume. */
  interiorOf?: { x0: number; z0: number; x1: number; z1: number };
}

/**
 * Every slot is a `PointLight`, and that is not a simplification.
 *
 * The obvious way to model a hooded street lamp is a downward `SpotLight`, and
 * that is what this pool used to do. Measured on the real GPU, a `SpotLight` in
 * this renderer contributes **exactly nothing**: with four lamps holding cone
 * slots at intensity 60 the road under them read (13,16,23) — pure ambient —
 * and multiplying the intensity by ten did not change a single pixel. Swapping
 * the same practicals into point slots lit the whole square. Something in the
 * MRT material injection drops three's spot loop, and that file belongs to the
 * render module; until it does, a cone slot is a slot that throws nothing away
 * in a night frame, which is precisely the "it glows but it lights nothing"
 * note the critics filed.
 *
 * An omni light in the lens is also not as wrong as it looks. A lamp head is
 * ~2.5 m out from the facade and 6 m up, so the wall takes about four times the
 * road's irradiance — a bright patch on the render beside the column, which is
 * what a real sodium lamp does. `KIND_DROP` sinks the emitter clear of its own
 * hood so the fixture itself does not sit in its own 1/d² singularity.
 */
interface Slot {
  light: THREE.PointLight;
  current: Practical | null;
  target: Practical | null;
  fade: number;
  seed: number;
}

const FLICKER = new Float32Array(256);
{
  const r = new Rand(0xf1ce);
  for (let i = 0; i < FLICKER.length; i++) FLICKER[i] = r.next();
}

/**
 * Per-kind gain on the authored intensity.
 *
 * The level authors a plausible *relative* brightness; this is where it is
 * calibrated against the renderer's absolute scale (perpendicular sun ≈ 16
 * units, full moon ≈ 0.2). Calibrated by measurement, not by arithmetic: at
 * 36× the road under a lamp came back at sRGB (176,128,77) against an unlit
 * road at (27,31,40) — a floodlit square, not a street at night. 6× lands the
 * centre of the pool around three stops over ambient, which is where a real
 * sodium lamp sits, and keeps the render behind the column short of clipping.
 */
const KIND_GAIN: Record<PracticalKind, number> = {
  sodium: 6.0,
  signage: 1.5,
  bulb: 1.0,
  fluoro: 0.9,
  fire: 1.15,
};

/**
 * How much of its peak a practical's *light* still throws in full daylight.
 *
 * This is deliberately not `DAY_FLOOR` from the material catalogue. That table
 * answers "how bright does the fixture *look*", and a fire barrel at noon still
 * shows a trace of orange in its throat (0.09) — but it does not *light* the
 * tarmac around it, because 3 kW of burning pallet against 100 klx of sun is
 * nothing. Running the pool off the material's floor is what let five ember
 * lights hold half the slots in a noon frame while every shop interior on the
 * square stayed a black hole: measured at 12:00, the whole pool was fires at
 * intensity ~1 and not one interior practical was assigned.
 */
const KIND_LIGHT_FLOOR: Record<PracticalKind, number> = {
  sodium: 0,
  signage: 0,
  /**
   * Room lighting is on around the clock, but it is not *worth* much against
   * the sun, and it is the one class that can be caught over-exposing in a
   * daylight frame: the shop bulbs sit a metre or two behind their shopfronts,
   * they cast no shadows, and at full strength the one on the east row washed
   * its roller shutter from (164,142,109) to (224,195,132) — a lit panel on a
   * sunlit facade, which is the note the critics filed against the windows.
   * Just under half is enough to keep a room from being a black hole seen
   * through its own opening while leaving it, correctly, darker than the
   * street outside.
   */
  bulb: 0.45,
  fluoro: 0.45,
  fire: 0,
};

/**
 * Metres to sink the emitter below the authored fixture position.
 *
 * The sodium practical is authored at the lens, which is sandwiched between the
 * lens box and the hood 10 cm above it. An omni light there puts those two
 * surfaces 0.1 m from a 150 cd source — six thousand units of irradiance, a
 * white blob with a white bloom and no lamp inside it. Half a metre down is
 * clear of both, is still inside the hood's shadow line as far as the eye is
 * concerned, and biases the pool towards the road.
 */
const KIND_DROP: Record<PracticalKind, number> = {
  sodium: 0.5, signage: 0, bulb: 0, fluoro: 0, fire: 0,
};

/**
 * Largest share of the pool any one fixture kind may hold.
 *
 * Pure relevance ranking is wrong for lighting design. Street lamps are the
 * brightest thing in a night frame and there are a dozen of them around the
 * square, so an unconstrained ranking hands them *every* slot — measured: ten
 * of ten at 23:00 — and the fire barrels and lit shop windows that give the
 * frame its foreground and its depth all go out. Reserving shares keeps the
 * three layers a night street needs: lamps down the road, a fire in the near
 * ground, and light behind the windows.
 */
const KIND_SHARE: Record<PracticalKind, number> = {
  sodium: 0.4, fire: 0.3, bulb: 0.7, fluoro: 0.5, signage: 0.2,
};

/** Daylight-aware gain for a practical's point light. */
function lightGain(kind: PracticalKind, night: number): number {
  const floor = KIND_LIGHT_FLOOR[kind];
  return KIND_GAIN[kind] * (floor + (1 - floor) * night);
}

/**
 * Sun illuminance (in the sky module's units) at which the street lighting is
 * fully on / fully off. 12:00 reads ~13.7, the level's 16:15 reads ~12.0,
 * golden hour at 18:06 reads ~5.0 and any night hour reads ~0.2, so this ramp
 * leaves the lamps dead through the whole working day, warming just past a
 * third at golden hour and full once the sun is down.
 */
const NIGHT_FULL = 0.8;
const NIGHT_NONE = 7.5;

export class PracticalLights {
  readonly practicals: Practical[] = [];
  private slots: Slot[] = [];
  private scene: THREE.Scene | null = null;
  private budget = 0;
  private time = 0;
  private scored: { p: Practical; score: number }[] = [];
  /** Reused per-kind tally for the share caps — the update loop allocates nothing. */
  private kindCount: Record<PracticalKind, number> =
    { sodium: 0, signage: 0, bulb: 0, fluoro: 0, fire: 0 };
  private tmp = new THREE.Vector3();
  private lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  /** Live handle on the renderer's shared sun-illuminance uniform. */
  private sunUniform: { value: THREE.Color } | null = null;
  private sunProbeAt = -1;
  private night = 1;
  private lastNight = 1;

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.setBudget(budgetForPreset());
    // Introspection for the capture harness: "which practicals actually hold a
    // slot right now, and how much are they throwing". Diagnosing "it glows but
    // it lights nothing" from a screenshot alone costs a build per guess.
    (globalThis as unknown as { __PRACTICALS__?: () => unknown }).__PRACTICALS__ = () => ({
      night: this.night,
      slots: this.slots.map((s) => ({
        fade: +s.fade.toFixed(3),
        i: +s.light.intensity.toFixed(2),
        of: s.current ? s.current.kind : null,
        at: s.current ? [s.current.x, s.current.y, s.current.z] : null,
      })),
    });
  }

  add(p: Practical): void { this.practicals.push(p); }

  /** Changing the pool size recompiles shaders, so only do it on preset change. */
  setBudget(n: number): void {
    if (n === this.budget || !this.scene) return;
    this.budget = n;
    for (const s of this.slots) {
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `practical:${i}`;
      light.castShadow = false;
      this.scene.add(light);
      this.slots.push({ light, current: null, target: null, fade: 0, seed: i * 37 + 11 });
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    const want = budgetForPreset();
    if (want !== this.budget) this.setBudget(want);
    this.time += dt;

    /* --- the photocell ------------------------------------------------ */
    this.night = this.readNight();
    setPracticalNight(this.night);
    if (!this.slots.length) return;

    camera.getWorldPosition(this.tmp);
    const cam = this.tmp;

    // A teleport (respawn, spectator jump, a capture setting up a new shot)
    // invalidates every assignment at once. Cross-fading through that takes
    // most of a second, during which the pool is still lighting the *old*
    // neighbourhood — which is exactly why a settled capture could come back
    // with lamps that glow but throw nothing.
    // The photocell crossing dusk invalidates the whole pool the same way: every
    // street lamp in the level suddenly outranks every interior. Cross-fading
    // through that costs about a second, and none of the lights involved were
    // contributing anything on either side of the switch, so it is a hard cut.
    const swung = Math.abs(this.night - this.lastNight) > 0.15;
    this.lastNight = this.night;
    const jumped = this.lastCam.distanceToSquared(cam) > 15 * 15;
    this.lastCam.copy(cam);
    if (jumped || swung) for (const s of this.slots) { s.target = null; s.current = null; s.fade = 0; }

    /* --- score every practical by relevance --------------------------- */
    this.scored.length = 0;
    for (const p of this.practicals) {
      const gain = lightGain(p.kind, this.night);
      // A switched-off lamp — or a fire barrel at noon — must not hold a slot:
      // at 16:00 that is what frees the whole pool for the interiors.
      if (gain < 0.02) continue;
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > (p.radius + 42) * (p.radius + 42)) continue;
      let score = (p.intensity * gain * p.radius) / (d2 + 4);
      if (p.interiorOf) {
        const inside = cam.x > p.interiorOf.x0 - 3 && cam.x < p.interiorOf.x1 + 3
          && cam.z > p.interiorOf.z0 - 3 && cam.z < p.interiorOf.z1 + 3;
        score *= inside ? 3.0 : 0.35;
      }
      this.scored.push({ p, score });
    }
    this.scored.sort((a, b) => b.score - a.score);

    /* --- sticky assignment with a cross-fade --------------------------- */
    const n = this.slots.length;
    const held = this.kindCount;
    for (const k in held) held[k as PracticalKind] = 0;
    const wanted = new Set<Practical>();
    for (let i = 0; i < this.scored.length && wanted.size < n; i++) {
      const p = this.scored[i].p;
      const cap = Math.max(1, Math.round(n * KIND_SHARE[p.kind]));
      if (held[p.kind] >= cap) continue;
      held[p.kind]++;
      wanted.add(p);
    }

    // Drop first, *then* take stock of what is still held. Building the held
    // set before the drop pass leaves a practical that was just released
    // looking occupied for a frame, so a fixture that walked from one slot to
    // another blinked out on the way.
    for (const s of this.slots) if (s.target && !wanted.has(s.target)) s.target = null;
    const assigned = new Set<Practical>();
    for (const s of this.slots) if (s.target) assigned.add(s.target);

    for (const s of this.slots) {
      if (s.target) continue;
      // A slot whose fixture has just been switched off by the photocell is
      // already throwing nothing, so there is nothing to cross-fade *out* of.
      // Holding it for the full second the ramp takes is what blacked out every
      // practical in the frame for a second when the hour crossed dusk.
      if (s.current && lightGain(s.current.kind, this.night) < 0.02) s.fade = 0;
      if (s.fade > 0.02) continue;      // still fading the previous one out
      for (const p of wanted) {
        if (assigned.has(p)) continue;
        s.target = p;
        s.current = p;
        assigned.add(p);
        break;
      }
    }

    // 8 rather than 5.5: the whole pool has to converge inside the 24 frames a
    // capture settles for, or a shot comes back with the previous vantage's
    // lights still half up.
    const k = 1 - Math.exp(-dt * 8);
    for (const s of this.slots) {
      const to = s.target ? 1 : 0;
      s.fade += (to - s.fade) * k;
      const p = s.current;
      if (!p || s.fade < 0.004) { s.light.intensity = 0; continue; }
      s.light.position.set(p.x, p.y - KIND_DROP[p.kind], p.z);
      s.light.color.setHex(p.color);
      s.light.distance = p.radius;
      s.light.intensity = p.intensity * lightGain(p.kind, this.night)
        * s.fade * modulation(p, this.time, s.seed);
    }
  }

  /** 0 = full daylight, 1 = the sun is down. */
  get nightFactor(): number { return this.night; }

  /**
   * Reads the sun's illuminance out of the renderer's shared uniform block.
   *
   * There is no cross-module contract for "how bright is the sun right now" —
   * `RenderAPI` only lets you *set* the hour — but every material the renderer
   * patches is handed the *same* uniform objects, so one is a live handle on
   * the value. Found once and cached; until the first material has compiled we
   * hold the last reading, which starts at night so a level that somehow never
   * finds it still lights its lamps rather than going dark for ever.
   */
  private readNight(): number {
    // Nothing is patched until the first material compiles, so probe every
    // frame at first and back off to twice a second if it never turns up.
    if (!this.sunUniform && (this.time < 1 || this.time - this.sunProbeAt > 0.5)) {
      this.sunProbeAt = this.time;
      this.sunUniform = findSunUniform(this.scene);
    }
    const c = this.sunUniform?.value;
    if (!c) return this.night;
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const t = THREE.MathUtils.clamp((lum - NIGHT_FULL) / (NIGHT_NONE - NIGHT_FULL), 0, 1);
    return 1 - t * t * (3 - 2 * t);
  }

  /** Live light count, for the perf overlay. */
  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.light.intensity > 0.001) n++;
    return n;
  }

  dispose(): void {
    for (const s of this.slots) {
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    this.budget = 0;
    delete (globalThis as { __PRACTICALS__?: unknown }).__PRACTICALS__;
  }
}

/* --------------------------------------------------------- sun discovery -- */

interface PatchedMaterial extends THREE.Material {
  userData: {
    boPatch?: { shader?: { uniforms: Record<string, { value: unknown }> } };
  };
}

/** First `boSunColor` uniform reachable from the scene, or null pre-compile. */
function findSunUniform(scene: THREE.Scene | null): { value: THREE.Color } | null {
  if (!scene) return null;
  let found: { value: THREE.Color } | null = null;
  scene.traverse((o) => {
    if (found) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const u = (m as PatchedMaterial).userData?.boPatch?.shader?.uniforms?.boSunColor;
      const value = u?.value as THREE.Color | undefined;
      if (value && (value as THREE.Color).isColor) { found = u as { value: THREE.Color }; return; }
    }
  });
  return found;
}

/** Deterministic, allocation-free flicker per light kind. */
function modulation(p: Practical, t: number, seed: number): number {
  switch (p.kind) {
    case 'fire': {
      const i = (seed + Math.floor(t * 21)) % FLICKER.length;
      const j = (i + 1) % FLICKER.length;
      const f = (t * 21) % 1;
      const n = FLICKER[i] * (1 - f) + FLICKER[j] * f;
      return 0.62 + 0.5 * n + 0.06 * Math.sin(t * 7.3 + seed);
    }
    case 'fluoro': {
      // 100 Hz ripple plus an occasional failing-ballast stutter.
      const ripple = 0.94 + 0.06 * Math.sin(t * 628);
      const stutter = Math.sin(t * 0.7 + seed) > 0.987 ? 0.25 : 1;
      return ripple * stutter;
    }
    case 'signage':
      return 0.85 + 0.15 * Math.sin(t * 3.1 + seed);
    case 'sodium':
      return 0.97 + 0.03 * Math.sin(t * 1.7 + seed);
    default:
      return 1;
  }
}

function budgetForPreset(): number {
  switch (settings.preset) {
    case 'low': return 2;
    case 'medium': return 5;
    case 'high': return 8;
    default: return 10;
  }
}
