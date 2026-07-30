/**
 * GameDirector — the engine `System` wrapper around the match layer.
 *
 * Its whole job is plumbing: resolve capabilities into `GameServices`, stand up
 * a fallback combat sim if no actor backend exists yet, translate input actions
 * into match commands, and pump `MatchRunner` on the fixed and variable steps.
 * All of the actual game logic lives in `Match.ts` and below, with no engine
 * dependency, so it can be tested headlessly.
 */

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
import { resolveServices, type GameServices } from './Services';
import type { DirectorAPI, DirectorSnapshot, GameModeId, MatchPhase } from './types';
import './events';
import './DebugScene';

const VALID_MODES: readonly GameModeId[] = ['operation', 'tdm', 'firefight'];

function paramMode(): GameModeId | null {
  const p = new URLSearchParams(globalThis.location?.search ?? '').get('mode');
  return p && (VALID_MODES as readonly string[]).includes(p) ? (p as GameModeId) : null;
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

    // No actor backend yet → stand up our own so the whole game layer is
    // playable and verifiable. The moment `ai` implements `ActorAPI` this is
    // never constructed.
    if (!this.services.actors) {
      this.fallback = new BotFallback(this.services, this.services.rng.fork('bots'));
      this.services.actors = this.fallback;
    }

    this.match = new MatchRunner(this.services, this.fallback !== null);
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

    if (input.pressed('tactical')) this.match.command('activateKillstreak');
    if (input.pressed('flashlight')) this.match.command('cycleKillstreak');

    if (this.match.phase === 'intermission') {
      if (input.pressed('slot1')) this.match.command('buy1');
      if (input.pressed('slot2')) this.match.command('buy2');
      if (input.pressed('slot3')) this.match.command('buy3');
    }
  }

  dispose(): void {
    this.match?.dispose();
    this.fallback?.dispose();
    this.ownedCharacters?.dispose?.();
  }
}

export { rng };
