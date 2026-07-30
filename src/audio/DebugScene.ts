/**
 * `?debug=audio` — the audio module's verification bench.
 *
 *   node tools/capture.mjs --debug audio --port 4215 --dist dist-audio
 *
 * Audio cannot be screenshotted, so this scene renders every sound through an
 * `OfflineAudioContext` — the *same* synthesis code the game runs, driving the
 * same mixer, voice pool and reverb rack — then plots the result and asserts on
 * it numerically. Each board is a 2×2 grid of panels sized so one screenshot at
 * 1920×1080 maps a 1024×576 canvas texel-for-texel, which is what makes the
 * spectrograms and metric tables legible in the capture.
 *
 * The claims this bench is designed to prove:
 *
 *  - every sound is non-silent, unclipped and well-formed
 *  - the six weapon families are spectrally distinct (overlay + centroid table)
 *  - distance changes structure, not just level: centroid falls, onset delay
 *    grows with d/343, and the tail lengthens
 *  - materials are distinguishable (metal rings, sand does not)
 *  - the generated impulse responses have the reverberation times their
 *    physical descriptions claim
 *  - occlusion measurably darkens a voice
 */

import * as THREE from 'three';
import { registerDebugScene, registerShots, DEBUG_SCENE } from '../core/Shots';
import type { EngineContext, System } from '../core/Engine';
import { Rand } from '../core/Rand';
import { settings } from '../core/Settings';

import type { SfxContext } from './Context';
import { Mixer } from './Mixer';
import { ReverbRack } from './ReverbZones';
import { VoicePool } from './Voices';
import { SoundBank } from './Bank';
import { Ambience } from './Ambience';
import { Tinnitus, playChatter, playGrunt, playHeartbeat } from './Vocals';
import { createWeaponState, playShot, playWhizzBy, type WeaponSoundState } from './WeaponSounds';
import {
  playCasing, playExplosion, playGlassShatter, playGrenadeBounce, playImpact, playRicochet,
} from './Impacts';
import { playFootstep, playLanding, playReload, playSlide, playWeaponSwitch } from './Foley';
import { playUi } from './Ui';
import { IMPULSE_IDS, IMPULSE_SPECS, renderImpulse } from './Impulses';
import { renderImpactMaterial } from './Bank';
import type { ImpulseId } from './types';
import {
  analyse, assert, assertOrder, estimateRt60, firstArrival, frameSpectrum,
  renderOffline, type Assertion, type SoundMetrics,
} from './Analysis';
import {
  ACCENT, GOOD, PANEL_H, PANEL_W, drawAssertionTable, drawCustomPanel, drawSoundPanel,
  drawSpectrumOverlay, drawWaveform, drawXy, newCanvas, type SpectrumSeries, type XySeries,
} from './Plots';

const SR = 44100;
const PANEL_H_WORLD = 1.0;
const PANEL_W_WORLD = PANEL_H_WORLD * (PANEL_W / PANEL_H);
const GAP = 0.03;
const BOARD_STRIDE = 6;
const BOARD_Y = 1.9;
const CAM_DIST = 2.62;
const CAM_FOV = 48;

/* -------------------------------------------------- offline render harness -- */

interface Rendered {
  left: Float32Array;
  right: Float32Array;
  mono: Float32Array;
  metrics: SoundMetrics;
}

interface RenderOpts {
  seconds?: number;
  ir?: ImpulseId;
  /** Extra listener occlusion forced on every voice, 0..1. */
  occlusion?: number;
  tickSeconds?: number;
  /** Build the stack the way the `low` preset does: no convolution, no
   *  multiband, no per-shot tail rack, fewer bank variants. */
  cheap?: boolean;
}

type Trigger = (sfx: SfxContext, weapons: WeaponSoundState, extras: {
  ambience: Ambience; tinnitus: Tinnitus; mixer: Mixer;
}) => void | ((elapsed: number) => void);

/**
 * Builds the real audio stack inside an `OfflineAudioContext` and renders one
 * trigger. Nothing is stubbed: the same `Mixer`, `ReverbRack`, `VoicePool` and
 * `SoundBank` the game uses are constructed here, so what is measured is what
 * ships.
 */
async function render(name: string, trigger: Trigger, opts: RenderOpts = {}): Promise<Rendered> {
  const seconds = opts.seconds ?? 2.4;
  let ticker: ((elapsed: number) => void) | null = null;

  const cheap = !!opts.cheap;
  const out = await renderOffline(seconds, SR, (octx) => {
    const mixer = new Mixer(octx, octx.destination, cheap);
    const reverb = new ReverbRack(octx, mixer, cheap
      ? { cheap: true, lengthScale: 0.5, densityScale: 0.45 } : {});
    const pool = new VoicePool(octx, mixer, reverb);
    const bank = new SoundBank(octx, cheap ? { variants: 2, lengthScale: 0.65 } : { variants: 4 });
    const weapons = createWeaponState(octx, mixer, cheap);
    const tinnitus = new Tinnitus(octx, mixer);

    const sfx: SfxContext = {
      ctx: octx, mixer, pool, reverb, bank,
      rand: new Rand(`bench:${name}`),
      cheap,
      now: () => octx.currentTime,
    };

    pool.setListener(0, 1.7, 0, 0, 0, -1, 0, 1, 0, 0.0005);
    if (opts.occlusion !== undefined) {
      const occ = opts.occlusion;
      pool.setOcclusionProbe(() => occ);
    }
    reverb.setZones([], opts.ir ?? 'streetCanyon');
    reverb.update(1, 0, 1.7, 0);
    weapons.tails.setImpulse(reverb.activeIr);

    const ambience = new Ambience(sfx, {});
    const r = trigger(sfx, weapons, { ambience, tinnitus, mixer });
    if (typeof r === 'function') ticker = r;
  }, 2, opts.tickSeconds ? { interval: opts.tickSeconds, fn: (dt) => ticker?.(dt) } : undefined);

  return { ...out, metrics: analyse(out.mono, out.sampleRate, out.left, out.right) };
}

/**
 * RMS of the first `len` seconds after the sound arrives.
 *
 * Whole-buffer RMS conflates level with duration: a close shot is a transient
 * in a 2.6 s window while a distant one is a 2 s tail, so the distant one
 * measures "louder" no matter how quiet it is. Windowing at the onset measures
 * the event, which is what "does distance make this quieter?" actually means.
 */
function onsetRmsDb(r: Rendered, len = 0.35): number {
  const start = Math.floor(r.metrics.onset * SR);
  const end = Math.min(r.mono.length, start + Math.floor(len * SR));
  let sum = 0;
  for (let i = start; i < end; i++) sum += r.mono[i] * r.mono[i];
  const n = Math.max(1, end - start);
  return 20 * Math.log10(Math.max(1e-9, Math.sqrt(sum / n)));
}

/** Average magnitude spectrum of a rendered sound, for the overlay plots. */
function averageSpectrum(data: Float32Array, size = 4096): { mag: Float32Array; binHz: number } {
  const bins = size >> 1;
  const acc = new Float32Array(bins);
  let frames = 0;
  const hop = size >> 2;
  for (let off = 0; off + size <= data.length; off += hop) {
    const m = frameSpectrum(data, off, size);
    let e = 0;
    for (let i = 0; i < bins; i++) e += m[i] * m[i];
    if (e < 1e-12) continue;
    for (let i = 0; i < bins; i++) acc[i] += m[i];
    frames++;
  }
  if (frames > 0) for (let i = 0; i < bins; i++) acc[i] /= frames;
  return { mag: acc, binHz: SR / size };
}

/* ------------------------------------------------------------ scene build -- */

interface PanelEntry {
  canvas: HTMLCanvasElement;
}

class Board {
  readonly panels: PanelEntry[] = [];
  constructor(readonly name: string, readonly description: string) { }
  add(canvas: HTMLCanvasElement): void { this.panels.push({ canvas }); }
}

function buildBoard(scene: THREE.Object3D, board: Board, index: number): void {
  const cx = index * BOARD_STRIDE;
  const geo = new THREE.PlaneGeometry(PANEL_W_WORLD, PANEL_H_WORLD);
  for (let i = 0; i < board.panels.length && i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const tex = new THREE.CanvasTexture(board.panels[i].canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex, toneMapped: false, depthWrite: true, side: THREE.FrontSide,
    }));
    mesh.position.set(
      cx + (col - 0.5) * (PANEL_W_WORLD + GAP),
      BOARD_Y + (0.5 - row) * (PANEL_H_WORLD + GAP),
      0,
    );
    scene.add(mesh);
  }
}

/* ------------------------------------------------------------------ build -- */

const BOARDS: Board[] = [];
const ASSERTIONS: Assertion[] = [];

function panel(
  title: string, subtitle: string, r: Rendered, notes: string[], status: 'pass' | 'fail' | 'info',
): HTMLCanvasElement {
  const c = newCanvas();
  drawSoundPanel(c, r.mono, SR, { title, subtitle, metrics: r.metrics, notes, status });
  return c;
}

/** Baseline sanity every rendered sound must satisfy. */
function wellFormed(name: string, r: Rendered, minPeakDb = -46): { ok: boolean; notes: string[] } {
  const m = r.metrics;
  const notes: string[] = [];
  let ok = true;
  if (m.peakDb < minPeakDb) { ok = false; notes.push(`FAIL silent: peak ${m.peakDb.toFixed(1)} dBFS < ${minPeakDb}`); }
  if (m.clipped) { ok = false; notes.push('FAIL clipped at 0 dBFS'); }
  if (!Number.isFinite(m.centroid) || m.centroid <= 0) { ok = false; notes.push('FAIL no spectral content'); }
  if (ok) notes.push(`OK non-silent, unclipped, centroid ${m.centroid.toFixed(0)} Hz`);
  ASSERTIONS.push(assert(`${name} well-formed`, ok, notes[notes.length - 1]));
  return { ok, notes };
}

registerDebugScene('audio', async (ctx: EngineContext) => {
  const engine = ctx.engine;
  for (const n of ['player', 'ai', 'director', 'weapons', 'fx', 'hud', 'world', 'physics']) {
    const sys = engine.tryGet(n);
    if (sys) sys.enabled = false;
  }
  // The audio system itself must not fight the bench for the AudioContext.
  const audioSys = engine.tryGet('audio');
  if (audioSys) audioSys.enabled = false;

  // Plots are data, not a photograph: strip everything that would soften them.
  settings.setGfx('taa', false);
  settings.setGfx('fxaaFallback', false);
  settings.setGfx('bloom', false);
  settings.setGfx('filmGrain', 0);
  settings.setGfx('vignette', 0);
  settings.setGfx('chromaticAberration', 0);
  settings.setGfx('dof', false);
  settings.setGfx('motionBlur', false);
  settings.setGfx('lensDirt', 0);
  settings.setGfx('ssao', false);
  settings.setGfx('ssr', false);
  settings.setGfx('volumetrics', false);
  settings.setGfx('shadows', false);
  settings.setGfx('sharpen', 0);
  settings.setGfx('colorGrade', false);
  settings.setGfx('tonemap', 'none');
  settings.setGfx('exposure', 1);
  settings.setGfx('renderScale', 1);
  settings.setGfx('maxPixelRatio', 1);
  settings.setGfx('fogDensity', 0);

  const render3d = engine.tryGet<System & {
    setTimeOfDay(h: number): void;
    setWeather(r: number, f: number, w: number): void;
    setExposureCompensation(v: number): void;
    viewModelScene: THREE.Object3D;
  }>('render');
  render3d?.setTimeOfDay(12);
  render3d?.setWeather(0, 0, 0);
  render3d?.setExposureCompensation(0);
  if (render3d) render3d.viewModelScene.visible = false;

  const scene = ctx.scene;
  for (let i = scene.children.length - 1; i >= 0; i--) {
    const c = scene.children[i];
    if (c.name === 'world') { scene.remove(c); continue; }
    if ((c as THREE.Light).isLight) scene.remove(c);
  }
  scene.fog = null;
  scene.background = new THREE.Color(0x05070a);

  const root = new THREE.Group();
  root.name = 'audio-debug';
  scene.add(root);

  const t0 = performance.now();
  console.info('[audio-bench] rendering sounds offline…');

  /* =================================================== weapons: families == */

  const families: Array<{ id: string; label: string; colour: string }> = [
    { id: 'ar', label: 'assault rifle', colour: '#f0a63c' },
    { id: 'smg', label: 'SMG', colour: '#4ad07a' },
    { id: 'sniper', label: 'sniper', colour: '#ff5a5a' },
    { id: 'shotgun', label: 'shotgun', colour: '#6aa9ff' },
    { id: 'lmg', label: 'LMG', colour: '#d07ae8' },
    { id: 'pistol', label: 'pistol', colour: '#f5e663' },
  ];

  const familyRenders = new Map<string, Rendered>();
  for (const f of families) {
    const r = await render(`weapon-${f.id}`, (sfx, weapons) => {
      playShot(sfx, weapons, { weaponId: f.id, x: 0, y: 1.7, z: -8 });
    }, { seconds: 2.2 });
    familyRenders.set(f.id, r);
  }

  const boardW1 = new Board('audio-weapons-a', 'Weapon reports at 8 m: rifle, SMG, sniper, shotgun');
  for (const id of ['ar', 'smg', 'sniper', 'shotgun']) {
    const f = families.find((x) => x.id === id)!;
    const r = familyRenders.get(id)!;
    const wf = wellFormed(`weapon ${id}`, r);
    boardW1.add(panel(f.label, '@ 8 m', r, [
      ...wf.notes,
      `band energy  <250 Hz ${(r.metrics.lowRatio * 100).toFixed(0)}%  ` +
      `250 Hz-2 kHz ${(r.metrics.midRatio * 100).toFixed(0)}%  >2 kHz ${(r.metrics.highRatio * 100).toFixed(0)}%`,
    ], wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardW1);

  const suppressed = await render('weapon-suppressed', (sfx, weapons) => {
    playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -8, suppressed: true });
  }, { seconds: 1.8 });
  const firstPerson = await render('weapon-fp', (sfx, weapons) => {
    playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: 0, firstPerson: true });
  }, { seconds: 2.0 });

  const boardW2 = new Board('audio-weapons-b', 'LMG, pistol, suppressed rifle and the first-person mix');
  for (const id of ['lmg', 'pistol']) {
    const f = families.find((x) => x.id === id)!;
    const r = familyRenders.get(id)!;
    const wf = wellFormed(`weapon ${id}`, r);
    boardW2.add(panel(f.label, '@ 8 m', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const ar = familyRenders.get('ar')!;
    // A suppressor does not make a gun "darker" — it removes the muzzle blast
    // and leaves the (bright) mechanical action, which is exactly why a
    // suppressed weapon sounds mechanical rather than muffled. So the claim to
    // test is that the *blast* energy collapses, not the brightness.
    const blastDb = (m: typeof ar.metrics): number => m.rmsDb + 10 * Math.log10(Math.max(1e-6, m.lowRatio));
    const quieter = suppressed.metrics.rmsDb < ar.metrics.rmsDb - 5;
    const noBlast = blastDb(suppressed.metrics) < blastDb(ar.metrics) - 8;
    ASSERTIONS.push(assert('suppressor removes the muzzle blast', quieter && noBlast,
      `rms ${suppressed.metrics.rmsDb.toFixed(1)} vs ${ar.metrics.rmsDb.toFixed(1)} dB, ` +
      `blast ${blastDb(suppressed.metrics).toFixed(1)} vs ${blastDb(ar.metrics).toFixed(1)} dB`));
    boardW2.add(panel('suppressed rifle', '@ 8 m', suppressed, [
      quieter ? `OK ${(ar.metrics.rmsDb - suppressed.metrics.rmsDb).toFixed(1)} dB quieter than unsuppressed` : 'FAIL not quieter',
      noBlast ? `OK blast energy down ${(blastDb(ar.metrics) - blastDb(suppressed.metrics)).toFixed(1)} dB; what is left is action noise`
        : 'FAIL muzzle blast still present',
    ], quieter && noBlast ? 'pass' : 'fail'));
    const wf = wellFormed('weapon first-person', firstPerson);
    boardW2.add(panel('rifle, first person', 'head-locked, mech layer at full', firstPerson, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardW2);

  /* ================================================== weapons: distance == */

  const distances = [5, 40, 120, 300];
  const distanceRenders: Rendered[] = [];
  for (const d of distances) {
    const r = await render(`weapon-d${d}`, (sfx, weapons) => {
      playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -d });
    }, { seconds: d > 150 ? 3.6 : 2.6 });
    distanceRenders.push(r);
  }

  const boardD = new Board('audio-weapon-distance', 'One rifle at 5, 40, 120 and 300 m — structure changes, not just level');
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    const r = distanceRenders[i];
    const expectedDelay = d / 343;
    const delayOk = Math.abs(r.metrics.onset - expectedDelay) < 0.06 + expectedDelay * 0.25;
    ASSERTIONS.push(assert(`propagation delay @ ${d} m`, delayOk,
      `onset ${(r.metrics.onset * 1000).toFixed(0)} ms, expected ≈ ${(expectedDelay * 1000).toFixed(0)} ms`));
    const wf = wellFormed(`weapon @${d}m`, r, -60);
    boardD.add(panel(`rifle @ ${d} m`, `${(expectedDelay * 1000).toFixed(0)} ms of flight`, r, [
      ...wf.notes,
      delayOk ? `OK arrival ${(r.metrics.onset * 1000).toFixed(0)} ms ≈ d/343` : `FAIL arrival ${(r.metrics.onset * 1000).toFixed(0)} ms`,
      'note: ~29 ms of the onset is Chrome\u2019s HRTF panner latency, constant for every',
      'world sound; first-person sounds bypass the panner and have none.',
    ], wf.ok && delayOk ? 'pass' : 'fail'));
  }
  BOARDS.push(boardD);

  /* =================================================== weapons: analysis == */

  const boardA = new Board('audio-weapon-analysis', 'Spectral distinctness of the weapon families and the distance model');

  {
    const series: SpectrumSeries[] = families.map((f) => {
      const s = averageSpectrum(familyRenders.get(f.id)!.mono);
      return { label: f.label, colour: f.colour, mag: s.mag, binHz: s.binHz };
    });
    const c = newCanvas();
    drawCustomPanel(c, 'family spectra', 'peak-normalised envelopes',
      (g, x, y, w, h) => drawSpectrumOverlay(g, x, y, w, h, series, 'magnitude, dB relative to each curve’s peak'),
      'info');
    boardA.add(c);
  }

  {
    // What makes two gunshots sound different is the *shape* of their spectral
    // envelope, not any one summary number. Two weapons can share a centroid
    // and be obviously different, or differ in centroid and still be twins. So
    // the claim tested here is the direct one: no two families have the same
    // spectral envelope, measured as the RMS difference between their
    // peak-normalised log spectra across 100 Hz – 12 kHz.
    const BANDS = 48;
    const F_LO = 100, F_HI = 12000;
    const envelopeOf = (r: Rendered): Float32Array => {
      const sp = averageSpectrum(r.mono, 4096);
      const out = new Float32Array(BANDS);
      let peak = -1e9;
      for (let b = 0; b < BANDS; b++) {
        const f0 = F_LO * Math.pow(F_HI / F_LO, b / BANDS);
        const f1 = F_LO * Math.pow(F_HI / F_LO, (b + 1) / BANDS);
        let acc = 0, n = 0;
        for (let i = Math.max(1, Math.floor(f0 / sp.binHz)); i <= Math.floor(f1 / sp.binHz) && i < sp.mag.length; i++) {
          acc += sp.mag[i] * sp.mag[i]; n++;
        }
        const db = 10 * Math.log10(Math.max(1e-14, n > 0 ? acc / n : 1e-14));
        out[b] = db;
        if (db > peak) peak = db;
      }
      for (let b = 0; b < BANDS; b++) out[b] = Math.max(out[b] - peak, -60);
      return out;
    };
    const envs = families.map((f) => envelopeOf(familyRenders.get(f.id)!));
    let minDist = Infinity;
    let worst = '';
    for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        let acc = 0;
        for (let b = 0; b < BANDS; b++) acc += (envs[i][b] - envs[j][b]) ** 2;
        const d = Math.sqrt(acc / BANDS);
        if (d < minDist) { minDist = d; worst = `${families[i].id}/${families[j].id}`; }
      }
    }
    const distinct = minDist > 2.0;
    ASSERTIONS.push(assert('weapon families are spectrally distinct', distinct,
      `closest pair ${worst}: ${minDist.toFixed(2)} dB RMS log-spectral distance (need > 2.0)`));

    const c = newCanvas();
    drawCustomPanel(c, 'family descriptors', 'centroid / rolloff / crest / decay', (g, x, y, w, h) => {
      const rows = families.map((f) => {
        const m = familyRenders.get(f.id)!.metrics;
        return {
          name: f.label,
          pass: true,
          detail: `centroid ${m.centroid.toFixed(0)} Hz   rolloff ${m.rolloff85.toFixed(0)} Hz   ` +
            `crest ${m.crestDb.toFixed(1)} dB   decay ${(m.decay60 * 1000).toFixed(0)} ms`,
        };
      });
      rows.push({
        name: 'closest spectral pair', pass: distinct,
        detail: `${worst}: ${minDist.toFixed(2)} dB RMS log-spectral distance (need > 2.0 dB)`,
      });
      drawAssertionTable(g, x, y, w, h, rows);
    }, distinct ? 'pass' : 'fail');
    boardA.add(c);
  }

  {
    // Level must fall with distance. Obvious, and exactly the kind of thing an
    // unattenuated reverb send silently breaks.
    // Peak, not windowed RMS: a distant report has a slow swell whose maximum
    // lands outside any fixed window, so RMS-in-a-window under-reads it.
    const levels = distances.map((d, i) => ({
      d, peak: distanceRenders[i].metrics.peakDb, rms: onsetRmsDb(distanceRenders[i], 0.9),
    }));
    let falls = true;
    for (let i = 1; i < levels.length; i++) if (levels[i].peak >= levels[i - 1].peak - 1) falls = false;
    ASSERTIONS.push({
      name: 'rifle level falls with distance',
      pass: falls,
      detail: levels.map((l) => `${l.d}m:${l.peak.toFixed(1)}dB`).join('  '),
    });
  }

  {
    const centroidSeries: XySeries = {
      label: 'centroid (Hz)', colour: ACCENT,
      points: distances.map((d, i) => [d, distanceRenders[i].metrics.centroid] as [number, number]),
    };
    const monotonic = assertOrder('centroid falls with distance',
      distances.map((d, i) => ({ label: `${d}m`, v: -distanceRenders[i].metrics.centroid })));
    ASSERTIONS.push({
      name: 'air absorption darkens with distance',
      pass: monotonic.pass,
      detail: distances.map((d, i) => `${d}m:${distanceRenders[i].metrics.centroid.toFixed(0)}Hz`).join('  '),
    });
    const c = newCanvas();
    drawCustomPanel(c, 'air absorption', 'spectral centroid vs distance',
      (g, x, y, w, h) => drawXy(g, x, y, w, h, [centroidSeries], 'distance (m)', 'Hz', true),
      monotonic.pass ? 'pass' : 'fail');
    boardA.add(c);
  }

  {
    const onsetSeries: XySeries = {
      label: 'measured onset (ms)', colour: GOOD,
      points: distances.map((d, i) => [d, distanceRenders[i].metrics.onset * 1000] as [number, number]),
    };
    const idealSeries: XySeries = {
      label: 'd / 343 (ms)', colour: '#6aa9ff',
      points: distances.map((d) => [d, (d / 343) * 1000] as [number, number]),
    };
    const c = newCanvas();
    drawCustomPanel(c, 'speed of sound', 'arrival time vs distance',
      (g, x, y, w, h) => drawXy(g, x, y, w, h, [onsetSeries, idealSeries], 'distance (m)', 'ms', true),
      'info');
    boardA.add(c);
  }
  BOARDS.push(boardA);

  /* ============================================================ impacts == */

  const impactMaterials: Array<{ surface: string; label: string }> = [
    { surface: 'concrete', label: 'concrete' },
    { surface: 'metal', label: 'steel' },
    { surface: 'wood', label: 'wood' },
    { surface: 'glass', label: 'glass' },
    { surface: 'sand', label: 'sand' },
    { surface: 'gravel', label: 'gravel' },
    { surface: 'flesh', label: 'flesh' },
    { surface: 'snow', label: 'snow' },
  ];
  const impactRenders = new Map<string, Rendered>();
  for (const m of impactMaterials) {
    const r = await render(`impact-${m.surface}`, (sfx) => {
      playImpact(sfx, { x: 0, y: 1.5, z: -4, surface: m.surface, energy: 1600 });
    }, { seconds: 1.6 });
    impactRenders.set(m.surface, r);
  }

  const boardI1 = new Board('audio-impacts-a', 'Bullet impacts: concrete, steel, wood, glass');
  for (const s of ['concrete', 'metal', 'wood', 'glass']) {
    const m = impactMaterials.find((x) => x.surface === s)!;
    const r = impactRenders.get(s)!;
    const wf = wellFormed(`impact ${s}`, r, -52);
    boardI1.add(panel(m.label, 'rifle round, 4 m', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardI1);

  const boardI2 = new Board('audio-impacts-b', 'Loose and soft materials plus ricochet');
  for (const s of ['sand', 'gravel', 'flesh']) {
    const m = impactMaterials.find((x) => x.surface === s)!;
    const r = impactRenders.get(s)!;
    const wf = wellFormed(`impact ${s}`, r, -54);
    boardI2.add(panel(m.label, 'rifle round, 4 m', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const r = await render('ricochet', (sfx) => {
      playRicochet(sfx, { x: 0, y: 1.6, z: -5, energy: 1500 });
    }, { seconds: 2.0 });
    const wf = wellFormed('ricochet', r, -52);
    const rings = r.metrics.decay60 > 0.12;
    ASSERTIONS.push(assert('ricochet whine sustains', rings, `decay60 ${(r.metrics.decay60 * 1000).toFixed(0)} ms`));
    boardI2.add(panel('ricochet', 'spang + tumbling whine', r, [
      ...wf.notes, rings ? `OK whine lasts ${(r.metrics.decay60 * 1000).toFixed(0)} ms` : 'FAIL no sustained whine',
    ], wf.ok && rings ? 'pass' : 'fail'));
  }
  {
    // Material identity is a property of the material, so it is measured dry:
    // through the reverberant mix every surface inherits the same tail and the
    // differences that matter disappear into it.
    const dry = (m: 'metal' | 'sand' | 'glass' | 'wood' | 'concrete') =>
      analyse(renderImpactMaterial(SR, m, 0), SR);
    const metal = dry('metal');
    const sand = dry('sand');
    const glass = dry('glass');
    const wood = dry('wood');
    ASSERTIONS.push(assert('steel rings far longer than sand (dry)',
      metal.decay60 > sand.decay60 * 1.8,
      `steel ${(metal.decay60 * 1000).toFixed(0)} ms vs sand ${(sand.decay60 * 1000).toFixed(0)} ms`));
    ASSERTIONS.push(assert('glass is the brightest material (dry)',
      glass.centroid > metal.centroid && glass.centroid > sand.centroid,
      `glass ${glass.centroid.toFixed(0)} Hz, steel ${metal.centroid.toFixed(0)} Hz, sand ${sand.centroid.toFixed(0)} Hz`));
    ASSERTIONS.push(assert('wood is darker than steel (dry)',
      wood.centroid < metal.centroid,
      `wood ${wood.centroid.toFixed(0)} Hz vs steel ${metal.centroid.toFixed(0)} Hz`));

    // A board of dry material responses: no mixer, no panner, no room. This is
    // where "steel rings and sand does not" is actually visible.
    const boardM = new Board('audio-materials',
      'Dry modal responses — the material itself, with no room in the way');
    const c = newCanvas();
    const series: SpectrumSeries[] = ([
      ['concrete', '#f0a63c'], ['metal', '#6aa9ff'], ['wood', '#d07ae8'],
      ['glass', '#4ad07a'], ['sand', '#f5e663'],
    ] as const).map(([m, colour]) => {
      const sp = averageSpectrum(renderImpactMaterial(SR, m, 0), 2048);
      return { label: m, colour, mag: sp.mag, binHz: sp.binHz };
    });
    drawCustomPanel(c, 'material spectra', 'dry modal response, peak-normalised',
      (g, x, y, w, h) => drawSpectrumOverlay(g, x, y, w, h, series, 'magnitude, dB below each material’s peak'),
      'info');
    boardM.add(c);

    for (const [mat, label] of [['metal', 'steel, dry'], ['glass', 'glass, dry'], ['sand', 'sand, dry']] as const) {
      const raw = renderImpactMaterial(SR, mat, 0);
      const met = analyse(raw, SR);
      const pc = newCanvas();
      drawSoundPanel(pc, raw, SR, {
        title: label,
        subtitle: 'modal bank, no mixer or room',
        metrics: met,
        notes: [
          `ring: ${(met.decay60 * 1000).toFixed(0)} ms to −60 dB, centroid ${met.centroid.toFixed(0)} Hz`,
          `crest ${met.crestDb.toFixed(1)} dB — how much of it is the contact click`,
        ],
        status: 'info',
      });
      boardM.add(pc);
    }
    BOARDS.push(boardM);
  }
  BOARDS.push(boardI2);

  /* ========================================================== footsteps == */

  const stepSurfaces = [
    { surface: 'concrete', label: 'concrete' },
    { surface: 'gravel', label: 'gravel' },
    { surface: 'metal', label: 'steel grating' },
    { surface: 'snow', label: 'snow' },
  ];
  const boardF = new Board('audio-footsteps', 'Footsteps per surface, sprinting gait');
  const stepMetrics: Array<{ label: string; m: SoundMetrics }> = [];
  for (const s of stepSurfaces) {
    const r = await render(`step-${s.surface}`, (sfx) => {
      playFootstep(sfx, { x: 0, y: 0.1, z: -1.5, surface: s.surface, gait: 'sprint' });
    }, { seconds: 1.4 });
    const wf = wellFormed(`footstep ${s.surface}`, r, -58);
    stepMetrics.push({ label: s.label, m: r.metrics });
    boardF.add(panel(s.label, 'sprint, 1.5 m', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardF);

  {
    const grav = stepMetrics.find((x) => x.label === 'gravel')!.m;
    const snow = stepMetrics.find((x) => x.label === 'snow')!.m;
    ASSERTIONS.push(assert('gravel steps are brighter than snow',
      grav.centroid > snow.centroid,
      `gravel ${grav.centroid.toFixed(0)} Hz vs snow ${snow.centroid.toFixed(0)} Hz`));
  }

  /* ============================================================== foley == */

  const boardFo = new Board('audio-foley', 'Weapon handling and movement foley');
  {
    const r = await render('reload', (sfx) => {
      playReload(sfx, 'ar', false, true);
    }, { seconds: 2.8 });
    const wf = wellFormed('reload', r, -54);
    // A reload is choreography: its audible events must span most of the
    // animation, not collapse into one hit.
    const spread = r.metrics.span > 1.4;
    ASSERTIONS.push(assert('reload is a timed sequence', spread,
      `audible events span ${(r.metrics.span * 1000).toFixed(0)} ms of a 2100 ms reload`));
    boardFo.add(panel('reload (empty)', 'assault rifle, 6 stages', r, [
      ...wf.notes, spread ? `OK stages span ${(r.metrics.span).toFixed(2)} s` : 'FAIL collapsed to one hit',
    ], wf.ok && spread ? 'pass' : 'fail'));
  }
  {
    const r = await render('switch', (sfx) => playWeaponSwitch(sfx, 'ar', 'sniper'), { seconds: 1.6 });
    const wf = wellFormed('weapon switch', r, -56);
    boardFo.add(panel('weapon switch', 'holster → raise', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const r = await render('slide', (sfx) => {
      const h = playSlide(sfx, 0, 0.4, -1, 'concrete', true);
      // Slides are held open; close it 0.9 s in so the render captures the tail.
      return () => { if (sfx.ctx.currentTime > 0.9) h.stop(); };
    }, { seconds: 2.0, tickSeconds: 0.2 });
    const wf = wellFormed('slide', r, -56);
    boardFo.add(panel('slide', 'concrete, 0.9 s hold', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const r = await render('landing', (sfx) => {
      playLanding(sfx, 0, 0.1, -1, 'concrete', 13, true);
    }, { seconds: 1.6 });
    const soft = await render('landing-soft', (sfx) => {
      playLanding(sfx, 0, 0.1, -1, 'concrete', 3.5, true);
    }, { seconds: 1.6 });
    const wf = wellFormed('landing', r, -52);
    // Absolute band ratios depend on the analysis window as much as the sound;
    // what matters is that a hard landing is measurably heavier than a soft one.
    // Level alone is a weak claim — the foley bus compressor deliberately
    // narrows it — so the assertion is on spectral weight, which compression
    // does not touch.
    const heavier = r.metrics.lowRatio > soft.metrics.lowRatio * 2
      && r.metrics.rmsDb > soft.metrics.rmsDb;
    ASSERTIONS.push(assert('landing weight scales with impact speed', heavier,
      `13 m/s: ${(r.metrics.lowRatio * 100).toFixed(1)}% sub @ ${r.metrics.rmsDb.toFixed(1)} dB, ` +
      `3.5 m/s: ${(soft.metrics.lowRatio * 100).toFixed(1)}% @ ${soft.metrics.rmsDb.toFixed(1)} dB`));
    boardFo.add(panel('hard landing', '13 m/s impact', r, [
      ...wf.notes,
      heavier ? `OK ${(r.metrics.lowRatio / Math.max(1e-4, soft.metrics.lowRatio)).toFixed(1)}× the sub energy of a 3.5 m/s landing`
        : 'FAIL no more weight than a soft landing',
    ], wf.ok && heavier ? 'pass' : 'fail'));
  }
  BOARDS.push(boardFo);

  /* ========================================================= explosions == */

  const boomDistances = [8, 60, 250];
  const boomRenders: Rendered[] = [];
  const boardE = new Board('audio-explosions', 'Explosion character at 8, 60 and 250 m, plus grenade foley');
  for (const d of boomDistances) {
    const r = await render(`boom-${d}`, (sfx) => {
      playExplosion(sfx, { x: 0, y: 1.2, z: -d, radius: 7, power: 1.4, kind: 'grenade' });
    }, { seconds: d > 100 ? 5.0 : 4.0 });
    boomRenders.push(r);
    const wf = wellFormed(`explosion @${d}m`, r, -58);
    boardE.add(panel(`explosion @ ${d} m`, `${((d / 343) * 1000).toFixed(0)} ms of flight`, r, [
      ...wf.notes,
      `lo ${(r.metrics.lowRatio * 100).toFixed(0)}%  mid ${(r.metrics.midRatio * 100).toFixed(0)}%  hi ${(r.metrics.highRatio * 100).toFixed(0)}%`,
    ], wf.ok ? 'pass' : 'fail'));
  }
  {
    const near = boomRenders[0].metrics;
    const far = boomRenders[2].metrics;
    ASSERTIONS.push(assert('distant explosions are low-frequency',
      far.lowRatio > near.lowRatio,
      `250 m: ${(far.lowRatio * 100).toFixed(0)}% low vs 8 m: ${(near.lowRatio * 100).toFixed(0)}%`));
    ASSERTIONS.push(assert('distant explosions arrive late',
      far.onset > near.onset + 0.4,
      `250 m onset ${(far.onset * 1000).toFixed(0)} ms vs 8 m ${(near.onset * 1000).toFixed(0)} ms`));
    ASSERTIONS.push(assertOrder('explosion level falls with distance',
      boomDistances.map((d, i) => ({ label: `${d}m`, v: -boomRenders[i].metrics.peakDb }))));

    const r = await render('grenade-casing', (sfx) => {
      playGrenadeBounce(sfx, 0, 0.2, -3, 'concrete', 0.6);
      playCasing(sfx, { x: 0.4, y: 0.1, z: -1.2, surface: 'concrete', size: 0.4, delay: 0.35 });
      playGlassShatter(sfx, -2, 1.4, -5, 0.7);
    }, { seconds: 2.6 });
    const wf = wellFormed('grenade + casing + glass', r, -56);
    boardE.add(panel('grenade / brass / glass', 'bounce, ejected case, pane', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardE);

  /* ==================================================== impulse responses == */

  interface IrInfo { id: ImpulseId; rt60: number; predelay: number; declared: number; }
  const irInfos: IrInfo[] = [];
  const irCanvases: HTMLCanvasElement[] = [];
  for (const id of IMPULSE_IDS) {
    const [l, r] = renderImpulse(SR, IMPULSE_SPECS[id], { seed: 3 });
    const mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) * 0.5;
    const rt60 = estimateRt60(mono, SR);
    const predelay = firstArrival(mono, SR, 0.05);
    const declared = IMPULSE_SPECS[id].rt60;
    irInfos.push({ id, rt60, predelay, declared });

    const c = newCanvas();
    const met = analyse(mono, SR, l, r);
    const ok = Math.abs(rt60 - declared) / declared < 0.55;
    ASSERTIONS.push(assert(`IR ${id} RT60 matches spec`, ok,
      `measured ${rt60.toFixed(2)} s vs declared ${declared.toFixed(2)} s`));
    drawSoundPanel(c, mono, SR, {
      title: id,
      subtitle: `RT60 ${rt60.toFixed(2)} s`,
      metrics: met,
      notes: [
        ok ? `OK measured RT60 ${rt60.toFixed(2)} s ≈ declared ${declared.toFixed(2)} s`
          : `FAIL RT60 ${rt60.toFixed(2)} s vs declared ${declared.toFixed(2)} s`,
        `first arrival ${(predelay * 1000).toFixed(1)} ms, declared predelay ${(IMPULSE_SPECS[id].predelay * 1000).toFixed(1)} ms`,
        `stereo correlation ${met.stereoCorrelation.toFixed(3)} (width ${IMPULSE_SPECS[id].width.toFixed(2)})`,
      ],
      status: ok ? 'pass' : 'fail',
    });
    irCanvases.push(c);
  }

  const boardIr1 = new Board('audio-impulses-a', 'Generated impulse responses: small room, hall, canyon, concrete');
  for (let i = 0; i < 4 && i < irCanvases.length; i++) boardIr1.add(irCanvases[i]);
  BOARDS.push(boardIr1);

  const boardIr2 = new Board('audio-impulses-b', 'Open field, tunnel, stairwell and the RT60 comparison');
  for (let i = 4; i < irCanvases.length; i++) boardIr2.add(irCanvases[i]);
  {
    const c = newCanvas();
    const measured: XySeries = {
      label: 'measured RT60 (s)', colour: ACCENT,
      points: irInfos.map((x, i) => [i, x.rt60] as [number, number]),
    };
    const declared: XySeries = {
      label: 'declared RT60 (s)', colour: '#6aa9ff',
      points: irInfos.map((x, i) => [i, x.declared] as [number, number]),
    };
    drawCustomPanel(c, 'reverberation times', irInfos.map((x) => x.id).join(' · '),
      (g, x, y, w, h) => drawXy(g, x, y, w, h, [measured, declared], 'impulse index', 'seconds', false),
      'info');
    boardIr2.add(c);
  }
  BOARDS.push(boardIr2);

  /* ================================================ occlusion + vocals ==== */

  const boardO = new Board('audio-occlusion-voice', 'Occlusion, voice synthesis and interface feedback');
  {
    const clear = await render('occl-clear', (sfx, weapons) => {
      playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -14 });
    }, { seconds: 2.2, occlusion: 0 });
    const blocked = await render('occl-blocked', (sfx, weapons) => {
      playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -14 });
    }, { seconds: 2.2, occlusion: 1 });
    const darker = blocked.metrics.centroid < clear.metrics.centroid * 0.8;
    const quieter = blocked.metrics.rmsDb < clear.metrics.rmsDb - 3;
    ASSERTIONS.push(assert('occlusion darkens and attenuates', darker && quieter,
      `centroid ${blocked.metrics.centroid.toFixed(0)} vs ${clear.metrics.centroid.toFixed(0)} Hz, ` +
      `rms ${blocked.metrics.rmsDb.toFixed(1)} vs ${clear.metrics.rmsDb.toFixed(1)} dB`));
    boardO.add(panel('rifle, line of sight', '14 m, unoccluded', clear, [
      `centroid ${clear.metrics.centroid.toFixed(0)} Hz`,
    ], 'info'));
    boardO.add(panel('rifle, through a wall', '14 m, occlusion 1.0', blocked, [
      darker ? `OK ${(100 - (blocked.metrics.centroid / clear.metrics.centroid) * 100).toFixed(0)}% darker` : 'FAIL not darker',
      quieter ? `OK ${(clear.metrics.rmsDb - blocked.metrics.rmsDb).toFixed(1)} dB quieter` : 'FAIL not quieter',
    ], darker && quieter ? 'pass' : 'fail'));
  }
  {
    const r = await render('vocals', (sfx) => {
      playGrunt(sfx, { kind: 'heavy', firstPerson: true });
    }, { seconds: 1.6 });
    const wf = wellFormed('damage grunt', r, -50);
    // A formant-synthesised voice must be tonal, not noise-like.
    const tonal = r.metrics.flatness < 0.35;
    ASSERTIONS.push(assert('grunt is voiced, not noise', tonal, `flatness ${r.metrics.flatness.toFixed(3)} (< 0.35)`));
    boardO.add(panel('damage grunt', 'formant synthesis, /a/', r, [
      ...wf.notes, tonal ? `OK voiced: flatness ${r.metrics.flatness.toFixed(3)}` : 'FAIL noise-like',
    ], wf.ok && tonal ? 'pass' : 'fail'));
  }
  {
    const r = await render('ui-chatter', (sfx, _w, extras) => {
      playChatter(sfx, { urgency: 0.8, radio: true, seed: 11 });
      playUi(sfx, 'kill', 1);
      playHeartbeat(sfx, extras.mixer, 0.9);
    }, { seconds: 2.4 });
    const wf = wellFormed('radio + UI + heartbeat', r, -54);
    boardO.add(panel('radio, hitmarker, pulse', 'chatter + kill blip + heartbeat', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  BOARDS.push(boardO);

  /* ======================================================= ambience/score == */

  const boardAm = new Board('audio-ambience', 'Procedural ambience bed and adaptive score at three tension levels');
  const tensions = [0.0, 0.45, 0.95];
  const ambMetrics: SoundMetrics[] = [];
  for (const ten of tensions) {
    const r = await render(`ambience-${ten}`, (sfx, _w, extras) => {
      const amb = extras.ambience;
      amb.setTension(ten);
      amb.setInterior(0);
      amb.setTimeOfDay(11);
      amb.start();
      amb.update(0.05);
      return (dt: number) => { amb.setTension(ten); amb.update(dt); };
    }, { seconds: 6.0, tickSeconds: 0.2 });
    ambMetrics.push(r.metrics);
    const wf = wellFormed(`ambience t=${ten}`, r, -60);
    boardAm.add(panel(`ambience, tension ${ten.toFixed(2)}`, '6 s of the live bed', r, [
      ...wf.notes,
      `lo ${(r.metrics.lowRatio * 100).toFixed(0)}%  mid ${(r.metrics.midRatio * 100).toFixed(0)}%  hi ${(r.metrics.highRatio * 100).toFixed(0)}%`,
    ], wf.ok ? 'pass' : 'fail'));
  }
  {
    const louder = ambMetrics[2].rmsDb > ambMetrics[0].rmsDb + 2;
    ASSERTIONS.push(assert('score responds to tension', louder,
      `calm ${ambMetrics[0].rmsDb.toFixed(1)} dB → combat ${ambMetrics[2].rmsDb.toFixed(1)} dB`));
    const c = newCanvas();
    const series: XySeries = {
      label: 'bed RMS (dBFS + 60)', colour: ACCENT,
      points: tensions.map((t, i) => [t, ambMetrics[i].rmsDb + 60] as [number, number]),
    };
    const centroid: XySeries = {
      label: 'centroid (Hz/10)', colour: GOOD,
      points: tensions.map((t, i) => [t, ambMetrics[i].centroid / 10] as [number, number]),
    };
    drawCustomPanel(c, 'adaptive score', 'level and brightness vs tension',
      (g, x, y, w, h) => drawXy(g, x, y, w, h, [series, centroid], 'tension', 'dBFS / Hz÷10', false),
      louder ? 'pass' : 'fail');
    boardAm.add(c);
  }
  BOARDS.push(boardAm);

  /* ============================================================ whizz-by == */

  const boardW = new Board('audio-supersonic', 'Supersonic pass, close and wide, with the Doppler sweep');
  for (const miss of [0.6, 6]) {
    const r = await render(`whizz-${miss}`, (sfx) => {
      playWhizzBy(sfx, {
        x: 0, y: 1.7, z: -miss, dx: 1, dy: 0, dz: 0, miss, speed: 860, delay: 0.05,
      });
    }, { seconds: 1.2 });
    const wf = wellFormed(`whizz ${miss} m`, r, -60);
    boardW.add(panel(`bullet pass, ${miss} m`, '860 m/s', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const r = await render('burst', (sfx, weapons) => {
      // The offline clock is frozen at 0 during the build, so the burst is
      // spaced by *distance*: each round is 28.6 m further away, which is
      // 83 ms of extra flight — the cadence of a 720 rpm rifle.
      for (let i = 0; i < 6; i++) {
        playShot(sfx, weapons, {
          weaponId: 'ar', x: 0, y: 1.7, z: -(6 + i * 28.6), shotIndex: i,
        });
      }
    }, { seconds: 3.0 });
    const wf = wellFormed('rifle burst', r, -52);
    boardW.add(panel('six rounds, spread in depth', 'shows per-shot variation + delay', r, wf.notes, wf.ok ? 'pass' : 'fail'));
  }
  {
    const r = await render('mixbus', (sfx, weapons, extras) => {
      // Ambience under an explosion: proves HDR ducking actually moves the bed.
      const amb = extras.ambience;
      amb.setTension(0.8);
      amb.start();
      amb.update(0.05);
      playShot(sfx, weapons, { weaponId: 'lmg', x: 3, y: 1.7, z: -10 });
      playExplosion(sfx, { x: 0, y: 1.2, z: -14, radius: 8, power: 1.6 });
      return (dt: number) => amb.update(dt);
    }, { seconds: 4.0, tickSeconds: 0.2 });
    const wf = wellFormed('mix under load', r, -40);
    ASSERTIONS.push(assert('master limiter holds the mix under 0 dBFS', !r.metrics.clipped,
      `peak ${r.metrics.peakDb.toFixed(2)} dBFS`));
    boardW.add(panel('full mix under load', 'bed + LMG + explosion, limiter engaged', r, [
      ...wf.notes,
      r.metrics.clipped ? 'FAIL limiter allowed clipping' : `OK limiter held peak at ${r.metrics.peakDb.toFixed(2)} dBFS`,
    ], wf.ok && !r.metrics.clipped ? 'pass' : 'fail'));
  }
  BOARDS.push(boardW);

  /* ================================================= quality path + deafness == */

  const boardQ = new Board('audio-quality', 'The `low` preset path and the flashbang deafness bus');
  {
    const lowShot = await render('low-weapon', (sfx, weapons) => {
      playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -8 });
    }, { seconds: 2.0, cheap: true });
    const wf = wellFormed('low-preset rifle', lowShot, -52);
    const ultra = familyRenders.get('ar')!;
    // The cheap path must still be recognisably the same weapon.
    const sameWeapon = Math.abs(lowShot.metrics.centroid - ultra.metrics.centroid)
      / Math.max(lowShot.metrics.centroid, ultra.metrics.centroid) < 0.55;
    ASSERTIONS.push(assert('low preset still sounds like the same weapon', sameWeapon,
      `low ${lowShot.metrics.centroid.toFixed(0)} Hz vs ultra ${ultra.metrics.centroid.toFixed(0)} Hz`));
    boardQ.add(panel('rifle, low preset', 'algorithmic reverb, no tail rack, no multiband', lowShot, [
      ...wf.notes,
      sameWeapon ? `OK centroid ${lowShot.metrics.centroid.toFixed(0)} Hz vs ${ultra.metrics.centroid.toFixed(0)} Hz on ultra`
        : 'FAIL low preset changes the weapon identity',
    ], wf.ok && sameWeapon ? 'pass' : 'fail'));

    const lowBoom = await render('low-boom', (sfx) => {
      playExplosion(sfx, { x: 0, y: 1.2, z: -20, radius: 7, power: 1.4 });
    }, { seconds: 3.0, cheap: true });
    const wf2 = wellFormed('low-preset explosion', lowBoom, -56);
    boardQ.add(panel('explosion, low preset', '20 m, cheap path', lowBoom, wf2.notes, wf2.ok ? 'pass' : 'fail'));

    const deaf = await render('deafened', (sfx, weapons, extras) => {
      // A flashbang has just gone off at the listener's feet.
      extras.mixer.addDeafness(1, 3);
      playShot(sfx, weapons, { weaponId: 'ar', x: 0, y: 1.7, z: -8 });
    }, { seconds: 2.2 });
    const muffled = deaf.metrics.centroid < ultra.metrics.centroid * 0.55;
    const ducked = deaf.metrics.rmsDb < ultra.metrics.rmsDb - 8;
    ASSERTIONS.push(assert('deafness bus muffles and ducks the mix', muffled && ducked,
      `centroid ${deaf.metrics.centroid.toFixed(0)} vs ${ultra.metrics.centroid.toFixed(0)} Hz, ` +
      `rms ${deaf.metrics.rmsDb.toFixed(1)} vs ${ultra.metrics.rmsDb.toFixed(1)} dB`));
    boardQ.add(panel('rifle, post-flashbang', 'deafness 1.0 — same shot through the damaged mix', deaf, [
      muffled ? `OK ${(100 - (deaf.metrics.centroid / ultra.metrics.centroid) * 100).toFixed(0)}% darker than the healthy mix` : 'FAIL not muffled',
      ducked ? `OK ${(ultra.metrics.rmsDb - deaf.metrics.rmsDb).toFixed(1)} dB down` : 'FAIL not attenuated',
    ], muffled && ducked ? 'pass' : 'fail'));

    const c = newCanvas();
    drawCustomPanel(c, 'quality + hearing paths', 'ultra vs low vs deafened', (g, x, y, w, h) => {
      const row = (name: string, m: SoundMetrics) => ({
        name, pass: true,
        detail: `rms ${m.rmsDb.toFixed(1)} dB  centroid ${m.centroid.toFixed(0)} Hz  ` +
          `rolloff ${m.rolloff85.toFixed(0)} Hz  decay ${(m.decay60 * 1000).toFixed(0)} ms`,
      });
      drawAssertionTable(g, x, y, w, h, [
        row('rifle @ 8 m, ultra', ultra.metrics),
        row('rifle @ 8 m, low', lowShot.metrics),
        row('rifle @ 8 m, deafened', deaf.metrics),
        row('explosion @ 20 m, low', lowBoom.metrics),
        { name: 'same weapon on low', pass: sameWeapon, detail: 'centroid within 55%' },
        { name: 'deafness muffles', pass: muffled, detail: 'centroid < 55% of healthy' },
        { name: 'deafness ducks', pass: ducked, detail: 'rms at least 8 dB down' },
      ]);
    }, sameWeapon && muffled && ducked ? 'pass' : 'fail');
    boardQ.add(c);
  }
  BOARDS.push(boardQ);

  /* ============================================================= summary == */

  const passed = ASSERTIONS.filter((a) => a.pass).length;
  const boardS = new Board('audio-summary', `Assertion summary: ${passed}/${ASSERTIONS.length} passing`);
  const perPanel = 14;
  for (let i = 0; i < ASSERTIONS.length; i += perPanel) {
    const slice = ASSERTIONS.slice(i, i + perPanel);
    const c = newCanvas();
    const allPass = slice.every((a) => a.pass);
    drawCustomPanel(
      c,
      `assertions ${i + 1}–${Math.min(i + perPanel, ASSERTIONS.length)}`,
      `${passed}/${ASSERTIONS.length} passing overall`,
      (g, x, y, w, h) => drawAssertionTable(g, x, y, w, h, slice),
      allPass ? 'pass' : 'fail',
    );
    boardS.add(c);
    if (boardS.panels.length === 4) break;
  }
  BOARDS.push(boardS);

  // Any remaining assertions get their own overflow board.
  if (ASSERTIONS.length > perPanel * 4) {
    const boardS2 = new Board('audio-summary-2', 'Assertion summary, continued');
    for (let i = perPanel * 4; i < ASSERTIONS.length; i += perPanel) {
      const slice = ASSERTIONS.slice(i, i + perPanel);
      const c = newCanvas();
      drawCustomPanel(c, `assertions ${i + 1}–${Math.min(i + perPanel, ASSERTIONS.length)}`, '',
        (g, x, y, w, h) => drawAssertionTable(g, x, y, w, h, slice),
        slice.every((a) => a.pass) ? 'pass' : 'fail');
      boardS2.add(c);
      if (boardS2.panels.length === 4) break;
    }
    BOARDS.push(boardS2);
  }

  /* ------------------------------------------------------------- assemble -- */

  for (let i = 0; i < BOARDS.length; i++) buildBoard(root, BOARDS[i], i);

  // A dark backdrop behind everything so the panels never sit on the skybox.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARDS.length * BOARD_STRIDE + 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x04060a, toneMapped: false }),
  );
  back.position.set(((BOARDS.length - 1) * BOARD_STRIDE) / 2, BOARD_Y, -0.6);
  root.add(back);

  registerShots(BOARDS.map((b, i) => ({
    name: b.name,
    description: b.description,
    position: [i * BOARD_STRIDE, BOARD_Y, CAM_DIST] as [number, number, number],
    yaw: 0, pitch: 0, fov: CAM_FOV, viewModel: false,
  })));

  const failed = ASSERTIONS.filter((a) => !a.pass);
  console.info(
    `[audio-bench] ${passed}/${ASSERTIONS.length} assertions passing, ` +
    `${BOARDS.length} boards, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
  for (const f of failed) console.warn(`[audio-bench] FAIL ${f.name}: ${f.detail}`);
});

/* --------------------------------------------------------------- shots -- */
/* Shots are registered by the build above (they depend on how many boards were
 * produced), but a wide establishing view is known up front. */

if (DEBUG_SCENE === 'audio') {
  registerShots([{
    name: 'audio-overview',
    description: 'Wide establishing view of the whole bench — every board at once',
    position: [48, BOARD_Y, 36],
    yaw: 0, pitch: 0, fov: 78, viewModel: false,
  }]);
}
