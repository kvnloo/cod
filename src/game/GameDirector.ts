/**
 * GameDirector — the engine `System` wrapper around the match layer.
 *
 * Its whole job is plumbing: resolve capabilities into `GameServices`, stand up
 * a fallback combat sim if no actor backend exists yet, translate input actions
 * into match commands, and pump `MatchRunner` on the fixed and variable steps.
 * All of the actual game logic lives in `Match.ts` and below, with no engine
 * dependency, so it can be tested headlessly.
 */

import type * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { input } from '../core/Input';
import { Rand, rng } from '../core/Rand';
import { CAPTURE_MODE } from '../core/Capture';
import { BotFallback } from './BotFallback';
import { CharacterSystem } from '../characters/CharacterSystem';
import type { CharacterFactory } from '../characters/types';
import { MatchRunner } from './Match';
import { AIActorBridge, resolveServices, type GameServices } from './Services';
import type { DirectorAPI, DirectorSnapshot, GameModeId, MatchPhase, Archetype } from './types';
import { ARCHETYPES } from './Archetypes';
import { combat } from './Combat';
import './events';
import './DebugScene';

/** What the weapon system looks like from here. Structural: no import. */
interface WeaponsLike {
  setDamageResolver(
    fn: ((
      entityId: number, amount: number, headshot: boolean, point: THREE.Vector3,
      direction: THREE.Vector3, fromPlayer: boolean,
      zone?: import('../physics/types').HitZone,
    ) => { killed: boolean; applied: number; armor?: boolean }) | null,
  ): void;
}

const VALID_MODES: readonly GameModeId[] = ['operation', 'tdm', 'firefight'];

function paramMode(): GameModeId | null {
  const p = new URLSearchParams(globalThis.location?.search ?? '').get('mode');
  return p && (VALID_MODES as readonly string[]).includes(p) ? (p as GameModeId) : null;
}

/** `?actors=fallback` forces the stand-in sim even when the AI module is live. */
function paramActors(): string {
  return new URLSearchParams(globalThis.location?.search ?? '').get('actors') ?? '';
}

/** True when the archetype table puts plates or a suit over at least one zone. */
/**
 * Armour hitmarker is zone-local: only light when the *resolved* zone has a
 * multi below 1 (plate on chest, suit on limbs, visor on head). An armoured
 * archetype hit in bare flesh must not flash the metal marker.
 */
function zoneHasArmor(archetype: string, zone: import('./types').HitZone | undefined): boolean {
  const p = ARCHETYPES[archetype as Archetype];
  if (!p) return false;
  const z = zone && zone !== 'none' ? zone : 'chest';
  return p.armor[z] < 1 - 1e-6;
}

function paramSeed(): number {
  const p = new URLSearchParams(globalThis.location?.search ?? '').get('seed');
  const n = Number(p);
  return Number.isFinite(n) && n !== 0 ? n : 1337;
}

export class GameDirector implements System, DirectorAPI {
  readonly name = 'director';
  readonly order = ORDER.GAMEPLAY;

  match!: MatchRunner;
  services!: GameServices;
  private fallback: BotFallback | null = null;
  /** Set when the real AI stack is the actor backend; null when it is not. */
  aiBridge: AIActorBridge | null = null;
  /** Which backend actually got installed. Readable at runtime, on purpose. */
  actorBackend: 'ai' | 'fallback' | 'none' = 'none';
  private weapons: WeaponsLike | null = null;
  /**
   * True for exactly one fixed step after an `explosion`.
   *
   * `AISystem` damages its own agents from the `explosion` event. Ballistics
   * *also* walks the blast sphere and calls the damage resolver. Without this
   * every grenade would be applied twice. The flag is raised by the event and
   * cleared at the top of the next `fixedUpdate`, which brackets exactly the
   * window in which the two can collide (ballistics runs at `ORDER.BALLISTICS`,
   * this system at `ORDER.GAMEPLAY`, same step).
   */
  private blastInFlight = false;
  private unbindBlast: (() => void) | null = null;
  private tick = 0;
  private started = false;
  /**
   * A character factory the director owns only because `main.ts` does not
   * register `CharacterSystem` yet. The moment it does, `tryGet('characters')`
   * wins and none of this runs.
   */
  private ownedCharacters: CharacterSystem | null = null;
  private charactersResolved = false;

  async init(ctx: EngineContext): Promise<void> {
    const seed = paramSeed();
    this.services = resolveServices(ctx, new Rand(seed));

    /*
     * Backend selection.
     *
     * `resolveServices` hands back the real AI stack wrapped in an
     * `AIActorBridge` whenever `src/ai/` is registered and still has the shape
     * the bridge expects. `BotFallback` is now genuinely a fallback: it only
     * gets built when there is no AI system at all (headless tests, a build
     * with the module stripped) — or when `?actors=fallback` asks for it, which
     * exists so the two backends can be A/B'd in the same build.
     */
    if (paramActors() === 'fallback') this.services.actors = null;
    if (this.services.actors instanceof AIActorBridge) {
      this.aiBridge = this.services.actors;
      this.actorBackend = 'ai';
    } else if (!this.services.actors) {
      this.fallback = new BotFallback(this.services, this.services.rng.fork('bots'));
      this.services.actors = this.fallback;
      this.actorBackend = 'fallback';
    } else {
      this.actorBackend = 'ai';
    }
    console.info(`[game] actor backend: ${this.actorBackend}`
      + (this.aiBridge ? ` (${this.aiBridge.ai.cover.points.length} cover points)` : ''));

    if (this.aiBridge) this.installDamageResolver(ctx);

    /*
     * `ownsFallback` means "the actor backend already answers the `explosion`
     * event itself, do not apply blast damage a second time". That is true of
     * `BotFallback` (it subscribes) and equally true of `AISystem`. Any other
     * backend keeps the old behaviour.
     */
    this.match = new MatchRunner(this.services, this.fallback !== null || this.aiBridge !== null);
    this.match.attachBus((key, fn) => bus.on(key, fn));
    this.match.seed = seed;

    // Expose for automation and the debug scene; the harness drives this.
    (globalThis as unknown as { __BLACKOUT_GAME__?: GameDirector }).__BLACKOUT_GAME__ = this;

    const forced = paramMode();
    if (forced || !CAPTURE_MODE) {
      // In capture mode we stay idle unless a mode was explicitly requested, so
      // the director never spawns soldiers into another module's shots.
      this.startMatch(forced ?? 'operation', seed);
    }
  }

  /**
   * Routes the player's rounds into enemy health.
   *
   * Without a resolver `Ballistics` still publishes `damage:dealt` and the AI
   * module's own listener applies it — but every hit reports `killed: false`,
   * so the hitmarker never reads as a kill and the armour flag is never set.
   * More importantly there is no single place that owns the arbitration.
   *
   * With one installed, the game layer owns it: the resolver applies the hit,
   * returns the truth, and `Agent.claimBusEcho` swallows the `damage:dealt`
   * echo that follows on the same call stack so nothing lands twice. Damage
   * *amounts* still come entirely from `src/weapons/` — per-zone multipliers
   * and range falloff — which is exactly where they belong.
   */
  private installDamageResolver(ctx: EngineContext): void {
    const w = ctx.engine.tryGet('weapons') as unknown as WeaponsLike | undefined;
    if (!w || typeof w.setDamageResolver !== 'function') return;
    this.weapons = w;
    this.unbindBlast = bus.on('explosion', () => { this.blastInFlight = true; });

    w.setDamageResolver((entityId, amount, headshot, point, direction, fromPlayer, zone) => {
      const bridge = this.aiBridge;
      if (!bridge) return { killed: false, applied: amount };
      const view = bridge.viewOf(entityId);
      if (!view) return { killed: false, applied: amount };

      /*
       * Blast damage arrives here from `Ballistics.detonate`'s overlap sweep,
       * always with a straight-up direction, in the same fixed step as the
       * `explosion` event that `AISystem` has already applied. Report it, do
       * not apply it, and claim the echo so it cannot be applied a third time.
       */
      if (this.blastInFlight && !headshot
        && direction.x === 0 && direction.z === 0 && direction.y === 1) {
        view.agent.claimBusEcho(amount, !view.alive);
        return { killed: !view.alive, applied: amount };
      }

      // Prefer the physics-resolved band (arm/leg/stomach/neck/…) over the
      // binary headshot flag so flinch, ragdoll and priced damage match the
      // collider that actually stopped the round.
      const resolvedZone = (zone && zone !== 'none')
        ? zone
        : (headshot ? 'head' as const : undefined);
      const killed = bridge.hurt(view, amount, {
        headshot, point, direction, fromPlayer,
        source: fromPlayer ? 'player' : 'ai',
        zone: resolvedZone,
      });
      // Per resolved zone: plate torso / visor / suit limb, not archetype-wide.
      const markZone = resolvedZone ?? (headshot ? 'head' as const : 'chest' as const);
      return { killed, applied: amount, armor: zoneHasArmor(view.archetype, markZone) };
    });
  }

  /* --------------------------------------------------------------- API -- */

  get mode(): GameModeId { return this.match?.mode.id ?? 'operation'; }
  get phase(): MatchPhase { return this.match?.phase ?? 'idle'; }

  snapshot(): DirectorSnapshot { return this.match.snapshot(); }

  startMatch(mode: GameModeId, seed?: number): void {
    this.started = true;
    this.match.start(mode, seed);
  }

  endMatch(win: boolean): void { this.match.finish(win); }

  /* ------------------------------------------------------------ update -- */

  fixedUpdate(dt: number, _ctx: EngineContext): void {
    if (!this.started) return;
    this.tick++;
    // The fallback sim runs before the match so deaths land in the same step
    // the match then reacts to.
    this.fallback?.fixedUpdate(dt, this.tick);
    this.match.fixedUpdate(dt);
    // Corpses are the director's to clean up; see `AIActorBridge.reap`.
    if (this.aiBridge && (this.tick & 63) === 0) this.aiBridge.reap();
    this.blastInFlight = false;
  }

  update(dt: number, ctx: EngineContext): void {
    // Nothing is resolved or ticked until a match is actually running, so an
    // idle director never perturbs another module's capture run.
    if (!this.started) return;
    this.ensureCharacters(ctx);
    this.ownedCharacters?.update(dt);
    this.readInput();
    this.match.update(dt);
  }

  lateUpdate(dt: number, ctx: EngineContext): void {
    if (!this.started) return;
    this.ownedCharacters?.lateUpdate(dt, ctx);
  }

  /**
   * Resolves the character factory on the first frame — not in `init`, because
   * the renderer boots after gameplay and the character materials need it.
   */
  private ensureCharacters(ctx: EngineContext): void {
    if (this.charactersResolved) return;
    this.charactersResolved = true;
    let factory = ctx.engine.tryGet<System & CharacterFactory>('characters') ?? null;
    if (!factory) {
      try {
        const cs = new CharacterSystem();
        cs.init(ctx);
        void cs.warm(['militia', 'pmc', 'spetsnaz']).catch(() => { });
        this.ownedCharacters = cs;
        factory = cs;
      } catch (err) {
        console.warn('[game] character factory unavailable; using stand-in bodies', err);
        factory = null;
      }
    }
    this.fallback?.setFactory(factory);
    /*
     * `AISystem.characterFactory()` probes the engine registry and then this
     * global. `main.ts` does not register `CharacterSystem`, so without the
     * hand-off every AI agent would fall back to the untextured proxy rig even
     * though a real factory exists — one line, and enemies get skinned bodies.
     */
    if (factory) {
      (globalThis as unknown as { __CHARACTERS__?: CharacterFactory }).__CHARACTERS__ = factory;
    }
  }

  /**
   * Input → match commands. Bindings avoid the weapon slots so the weapon
   * system keeps 1/2/3 outside of a buy phase.
   */
  private readInput(): void {
    if (input.pressed('pause')) {
      this.match.setPaused(!this.match.isPaused);
      return;
    }
    if (this.match.isPaused) return;

    this.match.setInteracting(input.held('use'));

    if (this.match.killstreaks.marking) {
      if (input.pressed('use')) this.match.command('confirmMark');
      else if (input.pressed('melee')) this.match.command('cancelMark');
      return;
    }

    // Tactical = stim mid-fight (CoD heal). Killstreak activates only when
    // stim cannot spend a charge (full HP, zero charges, already injecting).
    if (input.pressed('tactical')) {
      const spent = combat.vitals.useStim();
      if (!spent) this.match.command('activateKillstreak');
    }
    if (input.pressed('flashlight')) this.match.command('cycleKillstreak');

    if (this.match.phase === 'intermission') {
      if (input.pressed('slot1')) this.match.command('buy1');
      if (input.pressed('slot2')) this.match.command('buy2');
      if (input.pressed('slot3')) this.match.command('buy3');
    }
  }

  dispose(): void {
    this.unbindBlast?.();
    this.unbindBlast = null;
    this.weapons?.setDamageResolver(null);
    this.weapons = null;
    this.match?.dispose();
    this.fallback?.dispose();
    this.aiBridge?.dispose();
    this.ownedCharacters?.dispose?.();
  }
}

export { rng };
