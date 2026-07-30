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
import { setPracticalNight, fixtureGain, type FixtureClass } from './MatCatalog';

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
 * A street lamp cannot be an omni light.
 *
 * The lens sits ~1.2 m off the facade and ~6 m above the road, so an omni
 * point light puts (6/1.2)² = 25× more energy on the wall than on the ground
 * under it. Turn it up far enough for the road to show a pool and the facade
 * behind has already clipped to white — which is exactly the "it glows but it
 * lights nothing" note. A real lamp has a hood: it is a downward cone with a
 * soft edge and a little spill on to the wall, so that is what it gets here.
 * Everything else (a bare bulb, a fire barrel, a sign box) really is omni.
 */
type SlotKind = 'point' | 'spot';

function slotKindFor(k: PracticalKind): SlotKind {
  return k === 'sodium' ? 'spot' : 'point';
}

interface Slot {
  kind: SlotKind;
  light: THREE.PointLight | THREE.SpotLight;
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

/** Which fixture switch each practical kind follows. */
const KIND_FIXTURE: Record<PracticalKind, FixtureClass> = {
  sodium: 'street',
  signage: 'signage',
  bulb: 'interior',
  fluoro: 'interior',
  fire: 'ember',
};

/**
 * Per-kind gain on the authored intensity.
 *
 * The level authors a plausible *relative* brightness; this is where it is
 * calibrated against the renderer's absolute scale (perpendicular sun ≈ 16
 * units, full moon ≈ 0.2). A sodium lamp 6 m up at the authored 24 cd lands
 * 0.67 on the road below — against a night sky already reading ~0.25 of
 * ambient, which is a suggestion of a lamp rather than the hard elliptical
 * pool a real street light throws. 3.6× puts the centre of the pool about
 * five times ambient. That is only affordable because the lamps are cones:
 * as omni lights this much would have clipped the facade behind every column
 * long before the road showed anything.
 */
const KIND_GAIN: Record<PracticalKind, number> = {
  sodium: 3.6,
  signage: 1.5,
  bulb: 1.25,
  fluoro: 1.1,
  fire: 1.15,
};

/**
 * Sun illuminance (in the sky module's units) at which the street lighting is
 * fully on / fully off. 12:00 reads ~13.7, the level's 16:15 reads ~12.0,
 * golden hour at 18:06 reads ~5.0 and any night hour reads ~0.2, so this ramp
 * leaves the lamps dead through the whole working day, warming just past a
 * third at golden hour and full once the sun is down.
 */
const NIGHT_FULL = 0.8;
const NIGHT_NONE = 7.5;

/** Half-angle of a street-lamp cone: ~17 m of road from a 6 m column. */
const SPOT_ANGLE = 0.95;
/** Soft enough that the pool has no visible rim on the tarmac. */
const SPOT_PENUMBRA = 0.85;
/**
 * Cone a spot slot opens up to when it is standing in for an omni fixture.
 *
 * In daylight there are no street lamps to place, and a cone-only slot sitting
 * idle would mean *fewer* lit interiors than before the lamps were switched
 * off. A bulb on a ceiling rose throws almost everything downwards anyway, so
 * a near-hemisphere with a fully soft edge is a fair stand-in and costs
 * nothing — the alternative is a bigger light count in every shader.
 */
const OMNI_ANGLE = 1.5;

export class PracticalLights {
  readonly practicals: Practical[] = [];
  private slots: Slot[] = [];
  private scene: THREE.Scene | null = null;
  private budget = 0;
  private time = 0;
  private scored: { p: Practical; score: number }[] = [];
  private tmp = new THREE.Vector3();
  private lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  /** Live handle on the renderer's shared sun-illuminance uniform. */
  private sunUniform: { value: THREE.Color } | null = null;
  private sunProbeAt = -1;
  private night = 1;

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.setBudget(budgetForPreset());
  }

  add(p: Practical): void { this.practicals.push(p); }

  /** Changing the pool size recompiles shaders, so only do it on preset change. */
  setBudget(n: number): void {
    if (n === this.budget || !this.scene) return;
    this.budget = n;
    for (const s of this.slots) {
      if ((s.light as THREE.SpotLight).isSpotLight) (s.light as THREE.SpotLight).target.removeFromParent();
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    // Roughly two omni fixtures per hooded street lamp: the level has far more
    // bulbs, barrels and sign boxes than it has lamp columns.
    const spots = Math.max(1, Math.round(n * 0.35));
    for (let i = 0; i < n; i++) {
      const kind: SlotKind = i < spots ? 'spot' : 'point';
      let light: THREE.PointLight | THREE.SpotLight;
      if (kind === 'spot') {
        const spot = new THREE.SpotLight(0xffffff, 0, 10, SPOT_ANGLE, SPOT_PENUMBRA, 2);
        // Straight down. The lens is horizontal glass under a hood, so the
        // cone axis is vertical and the wall only ever sees the penumbra.
        spot.target.position.set(0, -1, 0);
        this.scene.add(spot.target);
        light = spot;
      } else {
        light = new THREE.PointLight(0xffffff, 0, 10, 2);
      }
      light.name = `practical:${kind}:${i}`;
      light.castShadow = false;
      this.scene.add(light);
      this.slots.push({ kind, light, current: null, target: null, fade: 0, seed: i * 37 + 11 });
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
    const jumped = this.lastCam.distanceToSquared(cam) > 15 * 15;
    this.lastCam.copy(cam);
    if (jumped) for (const s of this.slots) { s.target = null; s.current = null; s.fade = 0; }

    /* --- score every practical by relevance --------------------------- */
    this.scored.length = 0;
    for (const p of this.practicals) {
      const gain = KIND_GAIN[p.kind] * fixtureGain(KIND_FIXTURE[p.kind], this.night);
      // A switched-off lamp must not hold a slot: at 16:00 that is what frees
      // the whole pool for the interiors.
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

    /* --- sticky assignment with a cross-fade ---------------------------
     * Relevance is one ranked list, but a practical can only go in a slot of
     * its own type, so the walk fills each type until that type runs out. */
    const wanted = new Set<Practical>();
    let freePoint = 0, freeSpot = 0;
    for (const s of this.slots) (s.kind === 'spot' ? freeSpot++ : freePoint++);
    for (const { p } of this.scored) {
      if (slotKindFor(p.kind) === 'spot') {
        if (freeSpot <= 0) continue;
        freeSpot--;
      } else if (freePoint > 0) {
        freePoint--;
      } else if (freeSpot > 0) {
        freeSpot--;                     // cone slot standing in for an omni
      } else continue;
      wanted.add(p);
    }

    const assigned = new Set<Practical>();
    for (const s of this.slots) if (s.target) assigned.add(s.target);

    for (const s of this.slots) {
      if (s.target && !wanted.has(s.target)) { s.target = null; }
    }
    // Two global rounds. Everything is placed in a slot of its own type first,
    // so the strongest omni fixtures get real point lights; only the overflow
    // ends up in a cone standing in for one. Doing this per-slot instead would
    // hand the nearest ceiling bulb to a cone and lose the wall and ceiling
    // wash that is most of what makes a room read as a room.
    for (let round = 0; round < 2; round++) {
      for (const s of this.slots) {
        if (round === 1 && s.kind !== 'spot') continue;
        if (s.target) continue;
        if (s.fade > 0.02) continue;    // still fading the previous one out
        for (const p of wanted) {
          if (assigned.has(p)) continue;
          if (round === 0 && slotKindFor(p.kind) !== s.kind) continue;
          s.target = p;
          s.current = p;
          assigned.add(p);
          break;
        }
      }
    }

    const k = 1 - Math.exp(-dt * 5.5);
    for (const s of this.slots) {
      const to = s.target ? 1 : 0;
      s.fade += (to - s.fade) * k;
      const p = s.current;
      if (!p || s.fade < 0.004) { s.light.intensity = 0; continue; }
      s.light.position.set(p.x, p.y, p.z);
      s.light.color.setHex(p.color);
      s.light.distance = p.radius;
      if (s.kind === 'spot') {
        const spot = s.light as THREE.SpotLight;
        const hooded = slotKindFor(p.kind) === 'spot';
        spot.angle = hooded ? SPOT_ANGLE : OMNI_ANGLE;
        spot.penumbra = hooded ? SPOT_PENUMBRA : 1;
        spot.target.position.set(p.x, p.y - 4, p.z);
        spot.target.updateMatrixWorld();
      }
      const gain = KIND_GAIN[p.kind] * fixtureGain(KIND_FIXTURE[p.kind], this.night);
      s.light.intensity = p.intensity * gain * s.fade * modulation(p, this.time, s.seed);
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
      if ((s.light as THREE.SpotLight).isSpotLight) (s.light as THREE.SpotLight).target.removeFromParent();
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    this.budget = 0;
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
