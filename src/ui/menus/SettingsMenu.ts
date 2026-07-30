/**
 * Settings.
 *
 * Every control here writes straight through to `src/core/Settings.ts` (or to the
 * UI-owned preferences), so what the player changes is what the renderer reads on
 * the next frame. Choosing a quality preset rewrites the whole graphics block, so
 * the screen listens for `quality:changed` and refreshes every control rather
 * than letting the UI drift out of sync with the engine.
 *
 * Control rebinding writes directly into `input.bindings` and persists the map,
 * capturing keys on the capture phase so the game's own key handler never sees
 * the press.
 */

import { bus } from '../../core/EventBus';
import { input, type Action } from '../../core/Input';
import { PRESETS, settings, type QualityPreset } from '../../core/Settings';
import { setMotionAmount } from '../Anim';
import type { ColorBlindMode } from '../Theme';
import { ui } from '../UiSettings';
import {
  bindRow, clear, el, prettyKey, sectionHeading, segmentRow, sliderRow, stagger,
  toggleRow, type Control,
} from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';

type TabName = 'graphics' | 'gameplay' | 'audio' | 'controls' | 'access';

const TABS: Array<{ id: TabName; label: string }> = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
  { id: 'access', label: 'Accessibility' },
];

const BINDABLE: Array<{ action: Action; label: string }> = [
  { action: 'forward', label: 'Move Forward' },
  { action: 'back', label: 'Move Back' },
  { action: 'left', label: 'Move Left' },
  { action: 'right', label: 'Move Right' },
  { action: 'jump', label: 'Jump / Mantle' },
  { action: 'crouch', label: 'Crouch' },
  { action: 'prone', label: 'Prone' },
  { action: 'sprint', label: 'Sprint' },
  { action: 'reload', label: 'Reload' },
  { action: 'use', label: 'Use / Interact' },
  { action: 'melee', label: 'Melee' },
  { action: 'grenade', label: 'Lethal Equipment' },
  { action: 'tactical', label: 'Tactical Equipment' },
  { action: 'switchWeapon', label: 'Swap Weapon' },
  { action: 'leanLeft', label: 'Lean Left' },
  { action: 'leanRight', label: 'Lean Right' },
  { action: 'inspect', label: 'Inspect Weapon' },
  { action: 'flashlight', label: 'Flashlight' },
  { action: 'scoreboard', label: 'Scoreboard' },
  { action: 'pause', label: 'Pause' },
];

export class SettingsMenu extends Screen {
  private tab: TabName = 'graphics';
  private panels = new Map<TabName, HTMLElement>();
  private controls: Control[] = [];
  private tabButtons = new Map<TabName, HTMLButtonElement>();
  private capturing = false;

  constructor(host: ScreenHost) {
    super('settings', host);
    bus.on('quality:changed', () => this.refreshAll());
  }

  /** Right-hand aside: what the current graphics profile actually resolves to. */
  private readonly profileNode = el('div', {});

  private refreshAll(): void {
    for (const c of this.controls) c.refresh();
    this.renderProfile();
  }

  private renderProfile(): void {
    const host = this.profileNode;
    while (host.firstChild) host.removeChild(host.firstChild);
    const g = settings.gfx;
    const onOff = (v: boolean): string => (v ? 'ON' : 'OFF');

    host.appendChild(el('div', {
      class: 'ob-result',
      style: { fontSize: 'calc(var(--ob-u)*40)', letterSpacing: '.16em' },
      text: settings.preset.toUpperCase(),
    }));
    host.appendChild(el('div', {
      class: 'ob-result-sub', text: 'Resolved graphics profile',
    }));
    host.appendChild(el('div', { class: 'ob-sb-bar' }));

    const rows: Array<[string, string]> = [
      ['Render Scale', `${Math.round(g.renderScale * 100)}%`],
      ['Temporal AA', g.taa ? `${g.taaSamples} samples` : 'OFF'],
      ['Shadows', g.shadows ? `${g.shadowCascades} × ${g.shadowMapSize}` : 'OFF'],
      ['Contact Shadows', onOff(g.contactShadows)],
      ['Ambient Occlusion', onOff(g.ssao)],
      ['Reflections', g.ssr ? `${g.ssrSteps} steps` : 'OFF'],
      ['Volumetrics', g.volumetrics ? `${g.volumetricSteps} steps` : 'OFF'],
      ['Bloom', onOff(g.bloom)],
      ['Motion Blur', onOff(g.motionBlur)],
      ['Draw Distance', `${Math.round(g.drawDistance)} m`],
    ];
    for (const [name, value] of rows) {
      host.appendChild(el('div', { class: 'ob-break' },
        el('div', { class: 'ob-break-name', text: name }),
        el('div', { class: 'ob-break-count', text: '' }),
        el('div', { class: 'ob-break-pts', style: { fontSize: 'calc(var(--ob-u)*13)' }, text: value }),
      ));
    }
    host.appendChild(el('div', {
      class: 'ob-row-help',
      style: { marginTop: 'calc(var(--ob-u)*14)' },
      text: 'Changing any control below moves the profile to CUSTOM. '
        + 'Presets are tuned so LOW holds 60 fps on integrated graphics.',
    }));
  }

  protected build(): void {
    const parts = menuFrame(this, 'SETTINGS', 'System Configuration', 'cols-2');
    // The control rows cap out around 1180 design px; on a 16:9 screen that
    // leaves a third of the panel empty. An active-profile aside fills it with
    // something useful instead of void.
    parts.body.style.gridTemplateColumns = 'minmax(0,1fr) calc(var(--ob-u)*312)';

    const tabs = el('div', { class: 'ob-tabs' });
    for (const t of TABS) {
      const b = el('button', {
        class: 'ob-tab', type: 'button', text: t.label.toUpperCase(),
        on: {
          click: () => this.select(t.id),
          mouseenter: () => bus.emit('ui:sound', { cue: 'menuMove' }),
        },
      });
      this.tabButtons.set(t.id, b);
      tabs.appendChild(b);
    }

    const host = el('div', {
      class: 'ob-panel',
      style: { display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', minHeight: '0' },
    }, tabs);

    const body = el('div', { class: 'ob-scroll' });
    host.appendChild(body);

    this.panels.set('graphics', this.graphicsPanel());
    this.panels.set('gameplay', this.gameplayPanel());
    this.panels.set('audio', this.audioPanel());
    this.panels.set('controls', this.controlsPanel());
    this.panels.set('access', this.accessPanel());
    for (const p of this.panels.values()) {
      p.style.display = 'none';
      body.appendChild(p);
    }

    parts.body.appendChild(stagger(host, 0));
    host.classList.add('ob-stagger');

    const aside = el('div', { class: 'ob-panel ob-stagger' },
      el('div', { class: 'ob-panel-title' }, el('span', { text: 'Active Profile' })),
      this.profileNode,
    );
    stagger(aside, 1);
    parts.body.appendChild(aside);
    this.renderProfile();

    parts.footerLeft.append(
      keyHint('ESC', 'Back'),
      keyHint('R', 'Restore Defaults'),
    );
    parts.footerRight.textContent = '';
    parts.footerRight.appendChild(el('button', {
      class: 'ob-btn is-danger', type: 'button', text: 'Restore Defaults',
      on: {
        click: () => {
          settings.setPreset(settings.preset);
          Object.assign(settings.game, { ...settings.game });
          ui.reset();
          this.applyBinds(true);
          this.refreshAll();
          bus.emit('ui:sound', { cue: 'menuSelect' });
        },
      },
    }));

    this.select('graphics');
  }

  override onOpen(): void {
    this.applyBinds(false);
    this.refreshAll();
  }

  private select(tab: TabName): void {
    this.tab = tab;
    for (const [id, panel] of this.panels) panel.style.display = id === tab ? '' : 'none';
    for (const [id, btn] of this.tabButtons) btn.classList.toggle('is-on', id === tab);
    bus.emit('ui:sound', { cue: 'menuSelect' });
  }

  private track(c: Control): HTMLElement {
    this.controls.push(c);
    return c.root;
  }

  /* ----------------------------------------------------------- panels -- */

  private graphicsPanel(): HTMLElement {
    const p = el('div', {});
    const pct = (v: number): string => `${Math.round(v * 100)}%`;

    p.append(
      this.track(segmentRow<QualityPreset>({
        name: 'Quality Preset',
        help: 'Presets rewrite every graphics value below.',
        options: (Object.keys(PRESETS) as QualityPreset[])
          .reverse()
          .map((k) => ({ value: k, label: k })),
        get: () => settings.preset,
        set: (v) => settings.setPreset(v),
      })),
      this.track(sliderRow({
        name: 'Render Scale', help: 'Internal resolution multiplier.',
        min: 0.5, max: 1.5, step: 0.05,
        get: () => settings.gfx.renderScale,
        set: (v) => settings.setGfx('renderScale', v),
        format: pct,
      })),
      this.track(sliderRow({
        name: 'Max Pixel Ratio', min: 1, max: 3, step: 0.25,
        get: () => settings.gfx.maxPixelRatio,
        set: (v) => settings.setGfx('maxPixelRatio', v),
        format: (v) => `${v.toFixed(2)}×`,
      })),
      this.track(sliderRow({
        name: 'Draw Distance', min: 150, max: 1200, step: 25,
        get: () => settings.gfx.drawDistance,
        set: (v) => settings.setGfx('drawDistance', v),
        format: (v) => `${v.toFixed(0)} m`,
      })),

      sectionHeading('Anti-Aliasing'),
      this.track(toggleRow({
        name: 'Temporal AA', help: 'Accumulates jittered samples over time.',
        get: () => settings.gfx.taa, set: (v) => settings.setGfx('taa', v),
      })),
      this.track(sliderRow({
        name: 'TAA Samples', min: 4, max: 32, step: 1,
        get: () => settings.gfx.taaSamples, set: (v) => settings.setGfx('taaSamples', v),
      })),
      this.track(toggleRow({
        name: 'FXAA Fallback',
        get: () => settings.gfx.fxaaFallback, set: (v) => settings.setGfx('fxaaFallback', v),
      })),
      this.track(sliderRow({
        name: 'Sharpening', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.sharpen, set: (v) => settings.setGfx('sharpen', v), format: pct,
      })),

      sectionHeading('Shadows'),
      this.track(toggleRow({
        name: 'Shadows', get: () => settings.gfx.shadows, set: (v) => settings.setGfx('shadows', v),
      })),
      this.track(segmentRow({
        name: 'Cascades',
        options: [{ value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }],
        get: () => String(settings.gfx.shadowCascades),
        set: (v) => settings.setGfx('shadowCascades', Number(v)),
      })),
      this.track(segmentRow({
        name: 'Shadow Resolution',
        options: [
          { value: '1024', label: '1K' }, { value: '1536', label: '1.5K' },
          { value: '2048', label: '2K' }, { value: '4096', label: '4K' },
        ],
        get: () => String(settings.gfx.shadowMapSize),
        set: (v) => settings.setGfx('shadowMapSize', Number(v)),
      })),
      this.track(sliderRow({
        name: 'Soft Shadows', help: 'Penumbra width — 0 is hard PCF.',
        min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.pcssSoftness, set: (v) => settings.setGfx('pcssSoftness', v), format: pct,
      })),
      this.track(toggleRow({
        name: 'Contact Shadows',
        get: () => settings.gfx.contactShadows, set: (v) => settings.setGfx('contactShadows', v),
      })),

      sectionHeading('Ambient Occlusion & Reflections'),
      this.track(toggleRow({
        name: 'Ambient Occlusion',
        get: () => settings.gfx.ssao, set: (v) => settings.setGfx('ssao', v),
      })),
      this.track(sliderRow({
        name: 'AO Quality', min: 0.25, max: 1.5, step: 0.05,
        get: () => settings.gfx.ssaoQuality, set: (v) => settings.setGfx('ssaoQuality', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'AO Intensity', min: 0, max: 2, step: 0.05,
        get: () => settings.gfx.ssaoIntensity, set: (v) => settings.setGfx('ssaoIntensity', v), format: pct,
      })),
      this.track(toggleRow({
        name: 'Screen-Space Reflections',
        get: () => settings.gfx.ssr, set: (v) => settings.setGfx('ssr', v),
      })),
      this.track(sliderRow({
        name: 'SSR Steps', min: 8, max: 96, step: 4,
        get: () => settings.gfx.ssrSteps, set: (v) => settings.setGfx('ssrSteps', v),
      })),

      sectionHeading('Atmosphere'),
      this.track(toggleRow({
        name: 'Volumetric Lighting',
        get: () => settings.gfx.volumetrics, set: (v) => settings.setGfx('volumetrics', v),
      })),
      this.track(sliderRow({
        name: 'Volumetric Steps', min: 8, max: 128, step: 4,
        get: () => settings.gfx.volumetricSteps, set: (v) => settings.setGfx('volumetricSteps', v),
      })),
      this.track(sliderRow({
        name: 'Fog Density', min: 0, max: 2, step: 0.05,
        get: () => settings.gfx.fogDensity, set: (v) => settings.setGfx('fogDensity', v), format: pct,
      })),

      sectionHeading('Post Processing'),
      this.track(toggleRow({
        name: 'Bloom', get: () => settings.gfx.bloom, set: (v) => settings.setGfx('bloom', v),
      })),
      this.track(sliderRow({
        name: 'Bloom Intensity', min: 0, max: 1.5, step: 0.05,
        get: () => settings.gfx.bloomIntensity, set: (v) => settings.setGfx('bloomIntensity', v), format: pct,
      })),
      this.track(toggleRow({
        name: 'Motion Blur',
        get: () => settings.gfx.motionBlur, set: (v) => settings.setGfx('motionBlur', v),
      })),
      this.track(sliderRow({
        name: 'Motion Blur Strength', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.motionBlurStrength,
        set: (v) => settings.setGfx('motionBlurStrength', v), format: pct,
      })),
      this.track(toggleRow({
        name: 'Depth of Field', get: () => settings.gfx.dof, set: (v) => settings.setGfx('dof', v),
      })),
      this.track(sliderRow({
        name: 'Chromatic Aberration', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.chromaticAberration,
        set: (v) => settings.setGfx('chromaticAberration', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Film Grain', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.filmGrain, set: (v) => settings.setGfx('filmGrain', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Vignette', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.vignette, set: (v) => settings.setGfx('vignette', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Lens Dirt', min: 0, max: 1, step: 0.05,
        get: () => settings.gfx.lensDirt, set: (v) => settings.setGfx('lensDirt', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Exposure', min: 0.25, max: 2.5, step: 0.05,
        get: () => settings.gfx.exposure, set: (v) => settings.setGfx('exposure', v),
        format: (v) => `${v.toFixed(2)}×`,
      })),
      this.track(segmentRow({
        name: 'Tonemap',
        options: [
          { value: 'agx', label: 'AgX' }, { value: 'aces', label: 'ACES' },
          { value: 'reinhard', label: 'Reinhard' }, { value: 'none', label: 'None' },
        ],
        get: () => settings.gfx.tonemap,
        set: (v) => settings.setGfx('tonemap', v as 'agx' | 'aces' | 'reinhard' | 'none'),
      })),
      this.track(toggleRow({
        name: 'Colour Grading',
        get: () => settings.gfx.colorGrade, set: (v) => settings.setGfx('colorGrade', v),
      })),

      sectionHeading('Detail'),
      this.track(segmentRow({
        name: 'Anisotropic Filtering',
        options: [
          { value: '1', label: 'Off' }, { value: '4', label: '4×' },
          { value: '8', label: '8×' }, { value: '16', label: '16×' },
        ],
        get: () => String(settings.gfx.anisotropy),
        set: (v) => settings.setGfx('anisotropy', Number(v)),
      })),
      this.track(sliderRow({
        name: 'Max Decals', min: 32, max: 1024, step: 32,
        get: () => settings.gfx.maxDecals, set: (v) => settings.setGfx('maxDecals', v),
      })),
      this.track(sliderRow({
        name: 'Max Particles', min: 2000, max: 60000, step: 1000,
        get: () => settings.gfx.maxParticles, set: (v) => settings.setGfx('maxParticles', v),
        format: (v) => `${(v / 1000).toFixed(0)}k`,
      })),
      this.track(sliderRow({
        name: 'Foliage Density', min: 0, max: 1.5, step: 0.05,
        get: () => settings.gfx.foliageDensity,
        set: (v) => settings.setGfx('foliageDensity', v), format: pct,
      })),
    );
    return p;
  }

  private gameplayPanel(): HTMLElement {
    const p = el('div', {});
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    p.append(
      this.track(sliderRow({
        name: 'Field of View', help: 'Vertical FOV in degrees.',
        min: 60, max: 120, step: 1,
        get: () => settings.game.fov, set: (v) => settings.setGame('fov', v),
        format: (v) => `${v.toFixed(0)}°`,
      })),
      this.track(sliderRow({
        name: 'ADS Field of View', min: 0.5, max: 1, step: 0.02,
        get: () => settings.game.adsFovScale, set: (v) => settings.setGame('adsFovScale', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Mouse Sensitivity', min: 0.1, max: 4, step: 0.05,
        get: () => settings.game.sensitivity, set: (v) => settings.setGame('sensitivity', v),
        format: (v) => v.toFixed(2),
      })),
      this.track(sliderRow({
        name: 'ADS Sensitivity', min: 0.2, max: 1.5, step: 0.02,
        get: () => settings.game.adsSensitivityScale,
        set: (v) => settings.setGame('adsSensitivityScale', v), format: pct,
      })),
      this.track(toggleRow({
        name: 'Invert Vertical Look',
        get: () => settings.game.invertY, set: (v) => settings.setGame('invertY', v),
      })),
      this.track(toggleRow({
        name: 'Toggle Aim',
        get: () => settings.game.toggleAds, set: (v) => settings.setGame('toggleAds', v),
      })),
      this.track(toggleRow({
        name: 'Toggle Crouch',
        get: () => settings.game.toggleCrouch, set: (v) => settings.setGame('toggleCrouch', v),
      })),
      this.track(toggleRow({
        name: 'Automatic Sprint',
        get: () => settings.game.autoSprint, set: (v) => settings.setGame('autoSprint', v),
      })),

      sectionHeading('Camera'),
      this.track(sliderRow({
        name: 'Camera Shake', min: 0, max: 1.5, step: 0.05,
        get: () => settings.game.cameraShake, set: (v) => settings.setGame('cameraShake', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Weapon Bob', min: 0, max: 1.5, step: 0.05,
        get: () => settings.game.weaponBob, set: (v) => settings.setGame('weaponBob', v), format: pct,
      })),

      sectionHeading('Interface'),
      this.track(sliderRow({
        name: 'HUD Scale', min: 0.7, max: 1.4, step: 0.05,
        get: () => settings.game.hudScale, set: (v) => settings.setGame('hudScale', v), format: pct,
      })),
      this.track(segmentRow({
        name: 'Crosshair',
        options: [
          { value: 'dynamic', label: 'Dynamic' }, { value: 'cross', label: 'Static' },
          { value: 'dot', label: 'Dot' }, { value: 'none', label: 'Off' },
        ],
        get: () => settings.game.crosshairStyle,
        set: (v) => settings.setGame('crosshairStyle', v as 'dynamic' | 'dot' | 'cross' | 'none'),
      })),
      this.track(toggleRow({
        name: 'Damage Numbers',
        get: () => settings.game.showDamageNumbers,
        set: (v) => { settings.setGame('showDamageNumbers', v); ui.set('damageNumbers', v); },
      })),
      this.track(toggleRow({
        name: 'Blood Effects',
        get: () => settings.game.showBlood, set: (v) => settings.setGame('showBlood', v),
      })),
      this.track(toggleRow({
        name: 'Frame Rate Counter',
        get: () => settings.game.showFps, set: (v) => settings.setGame('showFps', v),
      })),
    );
    return p;
  }

  private audioPanel(): HTMLElement {
    const p = el('div', {});
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    p.append(
      this.track(sliderRow({
        name: 'Master Volume', min: 0, max: 1, step: 0.01,
        get: () => settings.game.masterVolume, set: (v) => settings.setGame('masterVolume', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Effects Volume', min: 0, max: 1, step: 0.01,
        get: () => settings.game.sfxVolume, set: (v) => settings.setGame('sfxVolume', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Music Volume', min: 0, max: 1, step: 0.01,
        get: () => settings.game.musicVolume, set: (v) => settings.setGame('musicVolume', v), format: pct,
      })),
      sectionHeading('Dialogue'),
      this.track(toggleRow({
        name: 'Subtitles', help: 'Captions for radio traffic and squad callouts.',
        get: () => ui.prefs.subtitles, set: (v) => ui.set('subtitles', v),
      })),
      this.track(sliderRow({
        name: 'Subtitle Size', min: 0.75, max: 1.6, step: 0.05,
        get: () => ui.prefs.subtitleSize, set: (v) => ui.set('subtitleSize', v), format: pct,
      })),
    );
    return p;
  }

  private controlsPanel(): HTMLElement {
    const p = el('div', {});
    p.appendChild(el('div', {
      class: 'ob-row-help',
      style: { padding: 'calc(var(--ob-u)*4) 0 calc(var(--ob-u)*10)' },
      text: 'Select a binding then press any key. ESC cancels.',
    }));
    for (const b of BINDABLE) {
      p.appendChild(this.track(bindRow({
        name: b.label,
        get: () => this.codeFor(b.action),
        onCapture: (done) => this.captureKey(b.action, done),
      })));
    }
    return p;
  }

  private accessPanel(): HTMLElement {
    const p = el('div', {});
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    p.append(
      this.track(segmentRow<ColorBlindMode>({
        name: 'Colourblind Mode',
        help: 'Swaps the semantic palette for a dichromat-safe set.',
        options: [
          { value: 'off', label: 'Off' }, { value: 'protanopia', label: 'Protan' },
          { value: 'deuteranopia', label: 'Deutan' }, { value: 'tritanopia', label: 'Tritan' },
        ],
        get: () => ui.prefs.colorBlind,
        set: (v) => ui.set('colorBlind', v),
      })),
      this.track(sliderRow({
        name: 'HUD Opacity', min: 0.25, max: 1, step: 0.05,
        get: () => ui.prefs.hudOpacity, set: (v) => ui.set('hudOpacity', v), format: pct,
      })),
      this.track(sliderRow({
        name: 'Interface Motion',
        help: '0% cuts between states instead of animating.',
        min: 0, max: 1, step: 0.05,
        get: () => ui.prefs.motion,
        set: (v) => { ui.set('motion', v); setMotionAmount(v); },
        format: pct,
      })),
      this.track(segmentRow({
        name: 'Crosshair Colour',
        options: [
          { value: 'default', label: 'White' }, { value: 'accent', label: 'Amber' },
          { value: 'green', label: 'Green' }, { value: 'cyan', label: 'Cyan' },
          { value: 'magenta', label: 'Magenta' },
        ],
        get: () => ui.prefs.crosshairColor,
        set: (v) => ui.set('crosshairColor', v as typeof ui.prefs.crosshairColor),
      })),
      this.track(toggleRow({
        name: 'Always Show Centre Dot',
        get: () => ui.prefs.centreDot, set: (v) => ui.set('centreDot', v),
      })),

      sectionHeading('Elements'),
      this.track(toggleRow({
        name: 'Minimap', get: () => ui.prefs.showMinimap, set: (v) => ui.set('showMinimap', v),
      })),
      this.track(toggleRow({
        name: 'Compass', get: () => ui.prefs.showCompass, set: (v) => ui.set('showCompass', v),
      })),
      this.track(toggleRow({
        name: 'Killfeed', get: () => ui.prefs.showKillfeed, set: (v) => ui.set('showKillfeed', v),
      })),
      this.track(toggleRow({
        name: 'Directional Damage Indicators',
        get: () => ui.prefs.damageIndicators, set: (v) => ui.set('damageIndicators', v),
      })),
      this.track(toggleRow({
        name: 'Low Health Effects',
        help: 'Desaturation and a pulsing vignette when critically wounded.',
        get: () => ui.prefs.lowHealthEffects, set: (v) => ui.set('lowHealthEffects', v),
      })),
      this.track(sliderRow({
        name: 'Low Ammo Warning', help: 'Magazines remaining before the reserve flashes.',
        min: 0, max: 4, step: 0.5,
        get: () => ui.prefs.lowAmmoMagazines, set: (v) => ui.set('lowAmmoMagazines', v),
        format: (v) => `${v.toFixed(1)} mags`,
      })),
      this.track(segmentRow({
        name: 'Units',
        options: [{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }],
        get: () => ui.prefs.units,
        set: (v) => ui.set('units', v as 'metric' | 'imperial'),
      })),
    );
    return p;
  }

  /* --------------------------------------------------------- bindings -- */

  private codeFor(action: Action): string {
    for (const [code, a] of Object.entries(input.bindings)) {
      if (a === action) return code;
    }
    return '';
  }

  private captureKey(action: Action, done: (code: string | null) => void): void {
    if (this.capturing) { done(null); return; }
    this.capturing = true;
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.removeEventListener('keydown', handler, true);
      this.capturing = false;
      if (e.code === 'Escape') { done(null); return; }
      // Clear any other action already using this code, then rebind.
      const next: Record<string, Action> = {};
      for (const [code, a] of Object.entries(input.bindings)) {
        if (code === e.code) continue;
        if (a === action) continue;
        next[code] = a;
      }
      next[e.code] = action;
      input.bindings = next;
      ui.setBind(action, e.code);
      bus.emit('ui:sound', { cue: 'menuSelect' });
      done(e.code);
      this.refreshAll();
    };
    window.addEventListener('keydown', handler, true);
  }

  /** Applies persisted rebindings on top of the defaults. */
  applyBinds(reset: boolean): void {
    if (reset) { ui.clearBinds(); return; }
    const binds = ui.prefs.binds;
    if (!binds || Object.keys(binds).length === 0) return;
    const next: Record<string, Action> = {};
    const overridden = new Set(Object.keys(binds));
    for (const [code, a] of Object.entries(input.bindings)) {
      if (overridden.has(a)) continue;
      next[code] = a;
    }
    for (const [action, code] of Object.entries(binds)) {
      next[code] = action as Action;
    }
    input.bindings = next;
  }
}
