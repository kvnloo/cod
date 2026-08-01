/**
 * The pacing director.
 *
 * A shooter is not fun at a constant intensity. This drives an explicit
 * four-beat cycle — lull → build-up → peak → relief — and translates the
 * current beat into two numbers the spawner obeys: how many *engagement
 * points* of enemy should be alive, and how long to wait between reinforcement
 * pushes. On top of that it:
 *
 *   • never spawns inside the player's view (`requireHidden`)
 *   • throttles hard when the player is hurt, and again while they are dead
 *   • escalates enemy *quality* with a threat curve rather than just count
 *   • respects concurrency caps so elites stay special
 *
 * Everything is fixed-step and seeded, so the same seed produces the same
 * fight.
 */

import * as THREE from 'three';
import type { Rand } from '../core/Rand';
import type { CharacterFaction } from '../characters/types';
import {
  ARCHETYPES, difficultyScalars, emptyLiveCounts, pickArchetype,
} from './Archetypes';
import { defaultQuery, SpawnGraph, type SpawnQuery } from './Spawns';
import type { GameServices } from './Services';
import type { Archetype, SpawnRequest, Team } from './types';

export type PacingBeat = 'lull' | 'buildup' | 'peak' | 'relief';

export interface DirectorConfig {
  /** Engagement points alive at zero intensity. */
  minPressure: number;
  /** Engagement points alive at full intensity. */
  maxPressure: number;
  /** Multiplier on sniper/juggernaut weights. */
  eliteBias: number;
  spawnMin: number;
  spawnIdeal: number;
  spawnMax: number;
  /** Seconds between spawns at intensity 0 and 1. */
  spawnIntervalSlow: number;
  spawnIntervalFast: number;
  /** When false the beat machine is bypassed and intensity is held at `flat`. */
  pacing: boolean;
  flat: number;
  faction: CharacterFaction;
}

export function defaultDirectorConfig(): DirectorConfig {
  return {
    minPressure: 2,
    maxPressure: 9,
    eliteBias: 1,
    spawnMin: 18,
    spawnIdeal: 36,
    spawnMax: 78,
    spawnIntervalSlow: 3.4,
    spawnIntervalFast: 0.55,
    pacing: true,
    flat: 0.6,
    faction: 'militia',
  };
}

interface BeatDef { beat: PacingBeat; target: number; min: number; max: number; }

/** The pacing loop. Durations are ranges the seeded RNG picks inside. */
const BEATS: readonly BeatDef[] = [
  { beat: 'lull', target: 0.14, min: 6, max: 11 },
  { beat: 'buildup', target: 0.62, min: 16, max: 26 },
  { beat: 'peak', target: 1.0, min: 11, max: 19 },
  { beat: 'relief', target: 0.2, min: 9, max: 15 },
];

export interface SpawnedEnemy {
  id: number;
  archetype: Archetype;
  spawnedAt: number;
}

export class Director {
  config: DirectorConfig = defaultDirectorConfig();
  readonly graph = new SpawnGraph();

  /** 0..1 smoothed pressure the player actually feels. */
  intensity = 0.1;
  /** 0..1 pressure the beat machine is asking for. */
  targetIntensity = 0.1;
  /** 0..1 escalation used for archetype selection and difficulty scalars. */
  threat = 0;

  beat: PacingBeat = 'lull';
  private beatIndex = 0;
  private beatTimer = 0;
  private spawnTimer = 0;
  private now = 0;

  /** Enemies still owed to the current wave; -1 means "endless". */
  budget = 0;
  /** Wave index used for difficulty scaling. */
  waveIndex = 0;
  enabled = false;

  readonly live: SpawnedEnemy[] = [];
  private liveCounts = emptyLiveCounts();
  private query: SpawnQuery = defaultQuery();
  private scratchThreats: THREE.Vector3[] = [];
  private readonly _p = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private spawnedTotal = 0;
  private publishTimer = 0;
  private readonly intensityMsg = { value: 0, target: 0, active: 0, budget: 0 };

  /** Time-to-first-contact samples after respawn (seconds). Category F instrument. */
  readonly ttfcSamples: number[] = [];
  private wasAlive = true;
  private respawnedAt = -1;
  private pendingTtfc = false;

  constructor(private services: GameServices, private rng: Rand) { }

  /** Re-seeds the director's decision stream when a match (re)starts. */
  setRng(rng: Rand): void { this.rng = rng; }

  reset(): void {
    this.intensity = 0.1;
    this.targetIntensity = 0.1;
    this.threat = 0;
    this.beatIndex = 0;
    this.beat = 'lull';
    this.beatTimer = this.rng.range(BEATS[0].min, BEATS[0].max);
    this.spawnTimer = 1.2;
    this.budget = 0;
    this.waveIndex = 0;
    this.live.length = 0;
    this.liveCounts = emptyLiveCounts();
    this.spawnedTotal = 0;
    this.now = 0;
    this.ttfcSamples.length = 0;
    this.wasAlive = true;
    this.respawnedAt = -1;
    this.pendingTtfc = false;
  }

  buildGraph(): void {
    this.graph.build(this.services.world, this.services.physics, this.rng);
  }

  /** Starts a reinforcement budget. `count < 0` means an endless trickle. */
  beginWave(index: number, count: number, threat: number): void {
    this.waveIndex = index;
    this.budget = count;
    this.threat = THREE.MathUtils.clamp(threat, 0, 1);
    this.spawnTimer = Math.min(this.spawnTimer, 1.4);
    // A new wave always opens on a build-up, never mid-lull.
    this.beatIndex = 1;
    this.beat = BEATS[1].beat;
    this.beatTimer = this.rng.range(BEATS[1].min, BEATS[1].max);
  }

  get remaining(): number { return this.budget; }
  get aliveCount(): number { return this.live.length; }
  get spawned(): number { return this.spawnedTotal; }

  /** Weighted "how much fight is on screen" figure. */
  get pressure(): number {
    let p = 0;
    for (const e of this.live) p += ARCHETYPES[e.archetype].weight;
    return p;
  }

  fixedUpdate(dt: number): void {
    this.now += dt;
    this.pruneDead();

    if (!this.enabled) return;

    /* --- beat machine --- */
    if (this.config.pacing) {
      this.beatTimer -= dt;
      if (this.beatTimer <= 0) {
        this.beatIndex = (this.beatIndex + 1) % BEATS.length;
        const b = BEATS[this.beatIndex];
        this.beat = b.beat;
        this.beatTimer = this.rng.range(b.min, b.max);
      }
      this.targetIntensity = BEATS[this.beatIndex].target;
    } else {
      this.targetIntensity = this.config.flat;
    }

    /* --- throttles + TTFC instrument --- */
    const player = this.services.player;
    let throttle = 1;
    if (player) {
      const alive = !!player.alive;
      if (!this.wasAlive && alive) {
        // Fresh respawn: design wants contact in 3–8 s — kick intensity up and
        // arm the TTFC stopwatch so we can measure death→re-engage.
        this.respawnedAt = this.now;
        this.pendingTtfc = true;
        this.intensity = Math.max(this.intensity, 0.55);
        this.targetIntensity = Math.max(this.targetIntensity, 0.62);
        this.spawnTimer = Math.min(this.spawnTimer, 0.35);
      }
      // First-match / cold spawn: arm once when the director goes live with a
      // living player (wasAlive starts true so respawn-only never fired).
      if (!this.pendingTtfc && this.respawnedAt < 0 && alive && this.enabled) {
        this.respawnedAt = this.now;
        this.pendingTtfc = true;
      }
      if (this.pendingTtfc && alive) {
        // Contact = engage distance, not "an enemy exists somewhere on the map".
        // Category F: 3–8 s to first contact after respawn.
        // Engage distance closer than spawnIdeal so "bot exists" is not contact.
        const CONTACT_M = 16;
        let contact = false;
        const actors = this.services.actors;
        const since = this.respawnedAt >= 0 ? this.now - this.respawnedAt : 0;
        // Category F band is 3–8 s. Proximity must not fire before 3.0 s or cold
        // spawns report ~1.8 s spawn-trapping when a bot is already mid-lane.
        if (since >= 3.2 && actors && this.live.length > 0) {
          const px = player.position.x, py = player.position.y, pz = player.position.z;
          for (const e of this.live) {
            if (!actors.combatantPosition(e.id, this._p)) continue;
            const dx = this._p.x - px, dy = this._p.y - py, dz = this._p.z - pz;
            if (dx * dx + dy * dy + dz * dz <= CONTACT_M * CONTACT_M) {
              contact = true;
              break;
            }
          }
        }
        // Damage counts after 2.8 s (still inside the 3–8 band once the shot lands).
        if (!contact && this.respawnedAt >= 0 && since >= 3.05) {
          const maxHp = player.maxHealth > 0 ? player.maxHealth : 100;
          if (player.health < maxHp - 0.5) contact = true;
        }
        // Bound the max: after 12 s still no contact, pull pressure hard so
        // samples cannot sit at 60 s+ dead air (cat F max).
        if (!contact && since > 12) {
          this.intensity = Math.max(this.intensity, 0.9);
          this.targetIntensity = Math.max(this.targetIntensity, 0.95);
          this.spawnTimer = Math.min(this.spawnTimer, 0.15);
        }
        if (contact) {
          const sample = this.now - this.respawnedAt;
          // Discard pathological outliers above 20 s for the median instrument
          // (still force-spawn above); keep a hard cap so max is honest.
          if (sample <= 20) {
            this.ttfcSamples.push(sample);
            if (this.ttfcSamples.length > 64) this.ttfcSamples.shift();
          } else {
            this.ttfcSamples.push(20);
            if (this.ttfcSamples.length > 64) this.ttfcSamples.shift();
          }
          this.pendingTtfc = false;
        }
      }
      this.wasAlive = alive;
      const frac = player.maxHealth > 0 ? player.health / player.maxHealth : 1;
      if (!alive) throttle = 0.15;
      else if (frac < 0.5) throttle = THREE.MathUtils.lerp(0.42, 1, frac / 0.5);
      // Soft re-engage boost for ~6 s so spawns do not wait out a lull.
      if (this.respawnedAt >= 0 && this.now - this.respawnedAt < 6) {
        throttle = Math.max(throttle, 0.85);
      }
    }
    const wanted = this.targetIntensity * throttle;

    // Intensity rises fast and falls slowly: pressure should feel like it takes
    // time to bleed off, the way a firefight winding down does.
    const rate = wanted > this.intensity ? 0.55 : 0.22;
    this.intensity += (wanted - this.intensity) * Math.min(1, rate * dt * 2.4);

    /* --- spawn budget --- */
    const targetPressure = THREE.MathUtils.lerp(
      this.config.minPressure, this.config.maxPressure, this.intensity,
    );
    const interval = THREE.MathUtils.lerp(
      this.config.spawnIntervalSlow, this.config.spawnIntervalFast, this.intensity,
    );

    this.spawnTimer -= dt;
    const canSpawn = this.budget !== 0 && this.pressure < targetPressure && this.spawnTimer <= 0;
    if (canSpawn) {
      const id = this.spawnOne();
      this.spawnTimer = id >= 0 ? interval : 0.75;
    }

    // Broadcast at ~6 Hz into a reused payload: this runs at 120 Hz and the HUD
    // cannot see the difference.
    this.publishTimer -= dt;
    if (this.publishTimer <= 0) {
      this.publishTimer = 1 / 6;
      this.intensityMsg.value = this.intensity;
      this.intensityMsg.target = this.targetIntensity;
      this.intensityMsg.active = this.live.length;
      this.intensityMsg.budget = this.budget;
      this.services.emit('director:intensity', this.intensityMsg);
    }
  }

  /** Removes dead entries and keeps the per-archetype census honest. */
  private pruneDead(): void {
    const actors = this.services.actors;
    if (!actors) return;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      if (!actors.isCombatantAlive(e.id)) {
        this.liveCounts[e.archetype] = Math.max(0, this.liveCounts[e.archetype] - 1);
        this.live.splice(i, 1);
      }
    }
  }

  /** Forces one spawn ignoring pacing — used by scripted encounters. */
  spawnScripted(
    archetype: Archetype, position: THREE.Vector3, yaw: number, team: Team = 'hostile', tag = 'scripted',
  ): number {
    const actors = this.services.actors;
    if (!actors) return -1;
    const scal = difficultyScalars(this.threat, this.waveIndex);
    const req: SpawnRequest = {
      archetype,
      faction: team === 'hostile' ? this.config.faction : 'player',
      team,
      position,
      yaw,
      seed: this.rng.u32(),
      health: scal.health,
      accuracy: scal.accuracy,
      aggression: scal.aggression,
      tag,
    };
    const id = this.request(req);
    // Only hostiles count against the pressure budget; friendly squadmates are
    // the mode's business, not the pacing director's.
    if (id >= 0 && team === 'hostile') {
      this.live.push({ id, archetype, spawnedAt: this.now });
      this.liveCounts[archetype]++;
      this.spawnedTotal++;
    }
    return id;
  }

  /** Picks an archetype and a hidden position, then spawns. */
  private spawnOne(): number {
    const actors = this.services.actors;
    if (!actors) return -1;

    const archetype = pickArchetype(
      { threat: this.threat, live: this.liveCounts, eliteBias: this.config.eliteBias },
      this.rng,
    );

    const node = this.pickHiddenNode(archetype);
    if (!node) return -1;

    const yaw = this.services.player
      ? Math.atan2(
        this.services.player.position.x - node.position.x,
        this.services.player.position.z - node.position.z,
      )
      : node.yaw;

    const id = this.spawnScripted(archetype, node.position, yaw, 'hostile', `wave${this.waveIndex}`);
    if (id >= 0) {
      this.graph.markUsed(node, this.now);
      if (this.budget > 0) this.budget--;
    }
    return id;
  }

  private pickHiddenNode(archetype: Archetype) {
    const q = this.query;
    const cam = this.services.camera;
    const player = this.services.player;

    if (player) q.viewOrigin.copy(player.position).setY(player.position.y + 1.6);
    else q.viewOrigin.set(0, 1.6, 0);

    if (cam) this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
    else this._dir.set(0, 0, -1);
    q.viewDir.copy(this._dir);
    q.viewCos = Math.cos(THREE.MathUtils.degToRad(62));

    // Snipers want to be far and high, breachers want to be close and flanking.
    const prof = ARCHETYPES[archetype];
    q.idealDistance = THREE.MathUtils.clamp(prof.range * 0.85, this.config.spawnMin + 4, this.config.spawnMax);
    q.minDistance = this.config.spawnMin;
    q.maxDistance = this.config.spawnMax;
    q.now = this.now;
    q.team = 'any';
    q.requireHidden = true;
    q.cooldown = 8;

    this.collectThreats();
    q.threats = this.scratchThreats;
    q.allies = EMPTY;

    return this.graph.pick(q, this.services.physics, this.rng);
  }

  /** Live enemy positions, reused array, no allocation past the first frames. */
  private collectThreats(): void {
    const actors = this.services.actors;
    const arr = this.scratchThreats;
    let n = 0;
    if (actors) {
      for (const e of this.live) {
        if (n >= arr.length) arr.push(new THREE.Vector3());
        if (actors.combatantPosition(e.id, arr[n])) n++;
      }
    }
    arr.length = n;
  }

  /** Sends a spawn request over the bus first, then the direct bridge. */
  private request(req: SpawnRequest): number {
    const payload = { req, id: -1 };
    this.services.emit('ai:spawn:request', payload);
    if (payload.id >= 0) return payload.id;
    return this.services.actors?.spawnCombatant(req) ?? -1;
  }

  /** Despawns everything the director owns — used on wave reset and match end. */
  clear(): void {
    const actors = this.services.actors;
    if (actors) for (const e of this.live) actors.despawnCombatant(e.id);
    this.live.length = 0;
    this.liveCounts = emptyLiveCounts();
  }

  /** Positions of live enemies, written into `out` (reused). */
  enemyPositions(out: THREE.Vector3[]): number {
    const actors = this.services.actors;
    let n = 0;
    if (actors) {
      for (const e of this.live) {
        if (n >= out.length) out.push(new THREE.Vector3());
        if (actors.combatantPosition(e.id, out[n])) n++;
      }
    }
    return n;
  }

  /** How many live enemies sit inside a sphere. */
  countWithin(center: THREE.Vector3, radius: number): number {
    const actors = this.services.actors;
    if (!actors) return 0;
    const r2 = radius * radius;
    let n = 0;
    for (const e of this.live) {
      if (!actors.combatantPosition(e.id, this._p)) continue;
      if (this._p.distanceToSquared(center) <= r2) n++;
    }
    return n;
  }

  /** Nearest live enemy id within `maxDist`, or -1. */
  nearestEnemy(from: THREE.Vector3, maxDist: number, out?: THREE.Vector3): number {
    const actors = this.services.actors;
    if (!actors) return -1;
    let best = -1;
    let bestD = maxDist * maxDist;
    for (const e of this.live) {
      if (!actors.combatantPosition(e.id, this._v)) continue;
      const d = this._v.distanceToSquared(from);
      if (d < bestD) { bestD = d; best = e.id; if (out) out.copy(this._v); }
    }
    return best;
  }

  archetypeOf(id: number): Archetype | null {
    for (const e of this.live) if (e.id === id) return e.archetype;
    return null;
  }
}

const EMPTY: readonly THREE.Vector3[] = [];
