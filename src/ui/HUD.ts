/**
 * HUDSystem — combat HUD, menus, killfeed, scoreboard.
 *
 * Structure inside `#ui-root`:
 *
 *   #ob-desat      CSS saturation plate (low-health desaturation of the frame)
 *   #ob-hud-canvas single 2D canvas: everything that animates per frame
 *   #ob-dom-layer  subtitles, scoreboard and the menu stack
 *
 * The system is a pure listener: it subscribes to the bus, reads the camera
 * transform out of the engine context, and never calls into another gameplay
 * system. That is what lets `?debug=ui` populate a full mid-combat HUD with
 * nothing but events.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { input } from '../core/Input';
import { settings } from '../core/Settings';
import type { RenderAPI } from '../render/types';

import { clamp01, damp, setMotionAmount } from './Anim';
import type { DrawCtx } from './Draw';
import { setCheapMode, text } from './Draw';
import { HudModel } from './Model';
import { hex, hudScale, PALETTES, rgba, type Palette } from './Theme';
import { ui } from './UiSettings';
import './UiEvents';
import type { UiObjectiveMarker, UiPromptRequest, UiScreenName, UiSubtitleRequest } from './UiEvents';
import { installStyle } from './Style';

import type { Widget } from './widgets/Widget';
import { Crosshair } from './widgets/Crosshair';
import { Scrim } from './widgets/Scrim';
import { HitMarkers } from './widgets/HitMarkers';
import { DamageIndicators } from './widgets/DamageIndicators';
import { AmmoPanel } from './widgets/AmmoPanel';
import { Vitals } from './widgets/Vitals';
import { Compass } from './widgets/Compass';
import { Minimap } from './widgets/Minimap';
import { Killfeed, type KillfeedRecord } from './widgets/Killfeed';
import { Banners } from './widgets/Banners';
import { ScorePopups } from './widgets/ScorePopups';
import { FloatingNumbers } from './widgets/FloatingNumbers';
import { Prompts } from './widgets/Prompts';
import { Vignette } from './widgets/Vignette';
import { Scoreboard } from './widgets/Scoreboard';
import { Subtitles } from './widgets/Subtitles';

import { MenuStack } from './menus/MenuStack';
import { MainMenu } from './menus/MainMenu';
import { PauseMenu } from './menus/PauseMenu';
import { SettingsMenu } from './menus/SettingsMenu';
import { LoadoutMenu, type EquippedLoadout } from './menus/LoadoutMenu';
import { SummaryMenu, demoSummary, type MatchSummary } from './menus/SummaryMenu';
import { registerUiDebugScene } from './DebugScene';

interface Scheduled { at: number; fn: () => void; }

export class HUDSystem implements System {
  readonly name = 'hud';
  readonly order = ORDER.UI;

  root = document.getElementById('ui-root') as HTMLElement;

  readonly model = new HudModel();

  private canvas!: HTMLCanvasElement;
  private ctx2d!: CanvasRenderingContext2D;
  private domLayer!: HTMLElement;
  private desat!: HTMLElement;

  private widgets: Widget[] = [];
  private crosshair!: Crosshair;
  private hitMarkers!: HitMarkers;
  private damageIndicators!: DamageIndicators;
  private killfeedWidget!: Killfeed;
  private banners!: Banners;
  private scorePopups!: ScorePopups;
  private floatingNumbers!: FloatingNumbers;
  private promptsWidget!: Prompts;
  private minimap!: Minimap;
  private vignette!: Vignette;

  private scoreboard!: Scoreboard;
  private subtitles!: Subtitles;
  private menus!: MenuStack;
  private settingsScreen!: SettingsMenu;
  private loadoutScreen!: LoadoutMenu;
  private summaryScreen!: SummaryMenu;

  private renderApi: RenderAPI | null = null;
  private engineRef: EngineContext | null = null;

  private width = 1920;
  private height = 1080;
  private dpr = 1;
  private elapsed = 0;
  private hudAlpha = 1;
  private scheduled: Scheduled[] = [];
  private lastCssSignature = '';
  private disposers: Array<() => void> = [];
  private wasScoreboardHeld = false;
  /** Non-null forces the scoreboard state, overriding the Tab hold. */
  private scoreboardForce: boolean | null = null;

  /* ------------------------------------------------------------- init -- */

  async init(ctx: EngineContext): Promise<void> {
    this.engineRef = ctx;
    if (!this.root) {
      // Defensive: the HUD must never be the reason the game fails to boot.
      this.root = document.createElement('div');
      this.root.id = 'ui-root';
      document.body.appendChild(this.root);
    }
    installStyle();
    ui.load();
    setMotionAmount(ui.prefs.motion);

    // The desaturation plate must blend with the WebGL canvas, so it lives
    // beside it inside #app rather than inside the (stacking-context-forming)
    // #ui-root. Its visibility is slaved to the HUD root so `setHUD(false)`
    // still removes it from a capture.
    this.desat = document.createElement('div');
    this.desat.id = 'ob-desat';
    this.desat.style.zIndex = '5';
    (this.root.parentElement ?? this.root).appendChild(this.desat);

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'ob-hud-canvas';
    this.root.appendChild(this.canvas);
    const c = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!c) throw new Error('[hud] 2D context unavailable');
    this.ctx2d = c;

    this.domLayer = document.createElement('div');
    this.domLayer.id = 'ob-dom-layer';
    this.root.appendChild(this.domLayer);

    this.renderApi = ctx.engine.tryGet<System & RenderAPI>('render') ?? null;
    this.model.attach(ctx);

    const pal = (): Palette => PALETTES[ui.prefs.colorBlind] ?? PALETTES.off;

    /* ------------------------------------------------------ widgets -- */
    this.minimap = new Minimap(pal);
    this.minimap.attachScene(ctx.scene);
    this.crosshair = new Crosshair(pal);
    this.hitMarkers = new HitMarkers(pal);
    this.damageIndicators = new DamageIndicators(pal);
    this.killfeedWidget = new Killfeed(pal);
    this.banners = new Banners(pal);
    this.scorePopups = new ScorePopups(pal);
    this.floatingNumbers = new FloatingNumbers(pal);
    this.promptsWidget = new Prompts(pal);

    this.vignette = new Vignette(pal, () => this.renderApi, this.desat);

    this.widgets = [
      new Scrim(),
      this.vignette,
      this.floatingNumbers,
      this.minimap,
      new Compass(pal),
      this.killfeedWidget,
      new Vitals(pal),
      new AmmoPanel(pal),
      this.scorePopups,
      this.banners,
      this.promptsWidget,
      this.damageIndicators,
      this.crosshair,
      this.hitMarkers,
    ];

    /* --------------------------------------------------- dom layers -- */
    this.subtitles = new Subtitles();
    this.domLayer.appendChild(this.subtitles.root);

    this.scoreboard = new Scoreboard();
    this.domLayer.appendChild(this.scoreboard.root);

    this.menus = new MenuStack(this.domLayer);
    this.settingsScreen = new SettingsMenu(this.menus);
    this.loadoutScreen = new LoadoutMenu(this.menus, (l) => this.applyLoadout(l));
    this.summaryScreen = new SummaryMenu(this.menus, () => {
      this.menus.replace('main');
    });
    this.menus.register(new MainMenu(this.menus, {
      deploy: () => { this.menus.closeAll(); bus.emit('game:start', { mode: 'domination' }); },
      loadout: () => this.menus.push('loadout'),
      settings: () => this.menus.push('settings'),
      quit: () => bus.emit('notify', { text: 'Quit is disabled in the browser build', kind: 'warn' }),
    }));
    this.menus.register(new PauseMenu(this.menus, {
      resume: () => this.menus.closeAll(),
      loadout: () => this.menus.push('loadout'),
      settings: () => this.menus.push('settings'),
      restart: () => { this.menus.closeAll(); bus.emit('game:start', { mode: this.model.match.mode }); },
      quit: () => this.menus.replace('main'),
    }, () => this.model));
    this.menus.register(this.settingsScreen);
    this.menus.register(this.loadoutScreen);
    this.menus.register(this.summaryScreen);

    this.settingsScreen.applyBinds(false);
    this.applyLoadout(this.loadoutScreen.current());

    /* ---------------------------------------------------- listeners -- */
    this.disposers.push(bus.on('ui:screen', () => this.syncInputGate()));
    this.disposers.push(bus.on('game:over', (e) => {
      const data = demoSummary(e.win, `summary-${e.score}`);
      data.win = e.win;
      this.summaryScreen.setData(data);
      window.setTimeout(() => this.menus.replace('summary'), 2200);
    }));
    this.disposers.push(bus.on('level:loaded', () => this.minimap.rebuild()));

    const onKey = (e: KeyboardEvent): void => this.onKeyDown(e);
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));

    registerUiDebugScene(this, ctx);
    this.resize(
      this.root.clientWidth || window.innerWidth,
      this.root.clientHeight || window.innerHeight,
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  /* ------------------------------------------------------------ frame -- */

  update(dt: number, ctx: EngineContext): void {
    // `dt` is the *scaled* simulation delta: pause drives the time scale to 0 and
    // a kill can drop it to a fraction for slow-mo. Neither should touch the
    // interface — a paused menu still has to run its entrance and its count-up,
    // and a hit marker must punch at the same speed in slow-mo. Presentation
    // therefore runs on the unscaled clock; only the model (which owns the match
    // timer) keeps the scaled one.
    const udt = ctx.time.deltaReal > 0 ? ctx.time.deltaReal : dt;
    this.elapsed += udt;
    this.model.update(dt, ctx);

    // Deferred callbacks (used by capture setups to stage animation states).
    if (this.scheduled.length) {
      for (let i = this.scheduled.length - 1; i >= 0; i--) {
        if (this.elapsed >= this.scheduled[i].at) {
          const s = this.scheduled[i];
          this.scheduled.splice(i, 1);
          s.fn();
        }
      }
    }

    const menuOpen = this.menus.isOpen;
    this.model.menuOpen = menuOpen;

    // `CaptureAPI.setHUD(false)` hides #ui-root; the blend plate lives outside
    // it, so mirror the state explicitly.
    const rootHidden = this.root.style.display === 'none';
    const wantVis = rootHidden ? 'hidden' : '';
    if (this.desat.style.visibility !== wantVis) this.desat.style.visibility = wantVis;

    /* ------------------------------------------------- scoreboard --- */
    const held = this.scoreboardForce ?? (input.held('scoreboard') && !menuOpen);
    if (held !== this.wasScoreboardHeld) {
      this.wasScoreboardHeld = held;
      this.scoreboard.setOpen(held);
      this.model.scoreboardOpen = held;
    }
    if (this.scoreboard.isOpen) this.scoreboard.update(this.model);

    /* ---------------------------------------------------- pause key -- */
    if (!menuOpen && input.pressed('pause')) this.menus.push('pause');

    this.subtitles.setSuppressed(menuOpen);
    this.subtitles.update(udt);
    this.menus.tick(udt);

    for (const w of this.widgets) w.update(udt, this.model);

    // The scoreboard is a full-frame read; the combat HUD steps back behind it
    // rather than competing with the table for the same pixels.
    const targetAlpha = menuOpen
      ? 0
      : clamp01(ui.prefs.hudOpacity) * (this.scoreboard.isOpen ? 0.34 : 1);
    this.hudAlpha = damp(this.hudAlpha, targetAlpha, 12, udt);

    this.syncCssVariables();
    this.draw(udt, ctx);
  }

  private draw(dt: number, ctx: EngineContext): void {
    const c = this.ctx2d;
    const w = this.width;
    const h = this.height;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (this.hudAlpha <= 0.004) return;

    const cheap = settings.preset === 'low';
    setCheapMode(cheap);
    const d: DrawCtx = {
      c, w, h,
      s: hudScale(h),
      dpr: this.dpr,
      t: this.elapsed,
      dt,
      alpha: this.hudAlpha,
      cheap,
    };

    for (const widget of this.widgets) widget.draw(d, this.model);

    if (settings.game.showFps) this.drawPerf(d, ctx);
  }

  private drawPerf(d: DrawCtx, ctx: EngineContext): void {
    const p = PALETTES[ui.prefs.colorBlind] ?? PALETTES.off;
    const fps = ctx.engine.fps;
    const ms = ctx.engine.frameMs;
    const good = fps >= 58 ? p.good : fps >= 40 ? p.warn : p.hostile;
    text(d.c, `${fps.toFixed(0)} FPS  ${ms.toFixed(1)} MS`, d.w - 12 * d.s, 15 * d.s, {
      size: 11 * d.s, weight: 600, family: 'mono', tracking: 0.8 * d.s, align: 'right',
      color: rgba(good, 0.9), shadow: 1,
    });
  }

  /* --------------------------------------------------------- plumbing -- */

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // The HUD canvas is cheap to rasterise; cap the backing store so a 4K
    // display with a 2× DPR does not cost more than it is worth.
    this.dpr = Math.min(Math.max(1, pixelRatio), settings.preset === 'low' ? 1 : 2);
    if (!this.canvas) return;
    const bw = Math.round(this.width * this.dpr);
    const bh = Math.round(this.height * this.dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    for (const w of this.widgets) w.resize?.(this.width, this.height, this.dpr);
    this.lastCssSignature = '';
  }

  /** Pushes palette / scale / opacity into the stylesheet's custom properties. */
  private syncCssVariables(): void {
    const p = PALETTES[ui.prefs.colorBlind] ?? PALETTES.off;
    const menuScale = Math.min(
      Math.max(Math.min(this.width / 1920, this.height / 1080), 0.6), 2.2,
    );
    const sig = `${ui.prefs.colorBlind}|${menuScale.toFixed(3)}|${ui.prefs.hudOpacity}|${ui.prefs.motion}`;
    if (sig === this.lastCssSignature) return;
    this.lastCssSignature = sig;
    const s = this.root.style;
    s.setProperty('--ob-u', `${menuScale.toFixed(4)}px`);
    s.setProperty('--ob-ink', hex(p.ink));
    s.setProperty('--ob-dim', hex(p.inkDim));
    s.setProperty('--ob-faint', hex(p.inkFaint));
    s.setProperty('--ob-accent', hex(p.accent));
    s.setProperty('--ob-hostile', hex(p.hostile));
    s.setProperty('--ob-friendly', hex(p.friendly));
    s.setProperty('--ob-good', hex(p.good));
    s.setProperty('--ob-warn', hex(p.warn));
    s.setProperty('--ob-opacity', String(ui.prefs.hudOpacity));
    this.root.classList.toggle('ob-reduced', ui.prefs.motion < 0.2);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented && !this.menus.isOpen) return;
    if (e.code === 'Escape') {
      if (this.menus.isOpen) {
        e.preventDefault();
        this.menus.back();
      }
      return;
    }
    if (e.code === 'F1' && this.menus.isOpen) {
      e.preventDefault();
      this.menus.closeAll();
    }
  }

  /** Menus take over input; gameplay must not read the keyboard behind them. */
  private syncInputGate(): void {
    const open = this.menus.isOpen;
    if (open) {
      input.releaseAll();
      input.enabled = false;
      input.exitLock();
    } else {
      input.enabled = true;
    }
    this.root.style.pointerEvents = open ? 'auto' : 'none';
  }

  private applyLoadout(l: EquippedLoadout): void {
    const w = this.model.weapon;
    w.id = l.weapon.id;
    w.name = l.weapon.name;
    w.kind = l.weapon.kind;
    w.magSize = l.weapon.magSize;
    w.ammo = Math.min(w.ammo || l.weapon.magSize, l.weapon.magSize);
    w.reserve = l.weapon.reserve;
    w.fireMode = l.weapon.fireMode;
    const att = l.attachments.MUZZLE ?? l.attachments.OPTIC ?? l.attachments.BARREL;
    w.attachment = (att ?? '').toUpperCase();
    this.model.ammoTicker.set(w.ammo, true);
    this.model.reserveTicker.set(w.reserve, true);
  }

  /* ------------------------------------------------------- public API -- */

  /** Full-width objective banner. */
  banner(title: string, sub = '', kind: 'objective' | 'warn' | 'reward' = 'objective'): void {
    this.banners.banner(title, sub, kind);
  }

  /** Small centre flourish, e.g. "ENEMY DOWN". */
  flourish(title: string, sub = ''): void {
    this.banners.flourish(title, sub);
  }

  /** Shows (or clears, with null) the interaction prompt. */
  prompt(req: UiPromptRequest | null): void {
    this.promptsWidget.show(req);
  }

  /** Sets the hold-ring progress explicitly, for gameplay-driven holds. */
  promptProgress(v: number): void {
    this.promptsWidget.setProgress(v);
  }

  subtitle(req: UiSubtitleRequest): void {
    this.subtitles.say(req);
  }

  killfeed(rec: KillfeedRecord): void {
    this.killfeedWidget.push(rec);
  }

  setObjective(marker: UiObjectiveMarker): void {
    this.model.objectives.set(marker.id, marker);
  }

  clearObjective(id?: string): void {
    if (id) this.model.objectives.delete(id);
    else this.model.objectives.clear();
  }

  hitmarker(kind: 'normal' | 'armor' | 'crit' | 'kill'): void {
    this.hitMarkers.spawn(kind);
  }

  /**
   * Adds a directional damage indicator at a world bearing, in radians, and
   * fires the matching reticle punch and edge flash. Used by scripted sequences
   * that must not go through `damage:taken` (which would also drive the player's
   * own health and the renderer's full-screen damage effect).
   */
  damageFrom(bearingRadians: number, strength01 = 0.6, flash = true): void {
    this.damageIndicators.add(bearingRadians, strength01);
    if (flash) {
      this.crosshair.shock();
      this.vignette.flash();
    }
  }

  scorePopup(amount: number, reason: string): void {
    this.scorePopups.add(amount, reason);
    this.model.score += amount;
    this.model.xp.set(this.model.score);
  }

  openScreen(name: UiScreenName): void {
    if (name === 'none') this.menus.closeAll();
    else this.menus.replace(name);
  }

  closeMenus(): void { this.menus.closeAll(); }

  /**
   * Forces the scoreboard open or closed, overriding the Tab hold until
   * `releaseScoreboard()` is called. Used by scripted sequences and captures.
   */
  setScoreboard(open: boolean): void {
    this.scoreboardForce = open;
    this.scoreboard.setOpen(open, true);
    this.model.scoreboardOpen = open;
    this.wasScoreboardHeld = open;
    if (open) this.scoreboard.update(this.model);
  }

  /** Hands the scoreboard back to the Tab key. */
  releaseScoreboard(): void { this.scoreboardForce = null; }

  showSummary(data: MatchSummary): void {
    this.summaryScreen.setData(data);
    this.menus.replace('summary');
  }

  get loadout(): LoadoutMenu { return this.loadoutScreen; }

  rebuildMinimap(): void { this.minimap.rebuild(); }

  /**
   * Clears every transient element — killfeed, banners, popups, markers,
   * indicators, prompts, subtitles, blips. Used at round start and between
   * capture shots so each one is independent of the last.
   */
  resetTransients(): void {
    this.killfeedWidget.clear();
    this.banners.clear();
    this.scorePopups.clear();
    this.floatingNumbers.clear();
    this.hitMarkers.clear();
    this.damageIndicators.clear();
    this.minimap.clearBlips();
    this.promptsWidget.show(null);
    this.subtitles.clear();
    this.scheduled.length = 0;
  }

  /** Runs `fn` after `delay` seconds of HUD time. Used by capture setups. */
  schedule(delay: number, fn: () => void): void {
    this.scheduled.push({ at: this.elapsed + delay, fn });
  }

  /** Seconds of HUD time since boot. */
  get time(): number { return this.elapsed; }

  dispose(): void {
    for (const w of this.widgets) w.dispose?.();
    this.subtitles.dispose();
    this.model.dispose();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

/** Re-exported so gameplay modules can build killfeed records without deep imports. */
export type { KillfeedRecord } from './widgets/Killfeed';
export type { MatchSummary, ScoreLine } from './menus/SummaryMenu';
export { demoSummary } from './menus/SummaryMenu';
