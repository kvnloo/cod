/**
 * Menu stylesheet.
 *
 * Injected once at boot into a single <style> tag. Everything is driven by custom
 * properties that the HUD system rewrites when the palette, the HUD scale or the
 * accessibility options change, so a colourblind palette switch or a scale change
 * costs one property write rather than a re-render.
 *
 * Visual rules: chamfered corners via clip-path, 1px hairlines, condensed
 * uppercase type with wide tracking, one accent colour, no rounded "web" chrome,
 * and no pure white anywhere.
 */

import { FONT_COND, FONT_MONO, FONT_SANS } from './Theme';

export const STYLE_ID = 'ob-ui-style';

export const CSS = `
#ui-root {
  --ob-u: 1px;
  --ob-ink: #dce6f4;
  --ob-dim: #92a2b8;
  --ob-faint: #5c6a7d;
  --ob-accent: #ffc24b;
  --ob-hostile: #ff4a3a;
  --ob-friendly: #55c8ff;
  --ob-good: #63e6a8;
  --ob-warn: #ff8a2b;
  --ob-hair: rgba(157,178,204,.22);
  --ob-hair-strong: rgba(157,178,204,.42);
  --ob-panel: rgba(8,12,18,.72);
  --ob-panel-solid: #080c12;
  --ob-opacity: 1;
  --ob-ease: cubic-bezier(.16,1,.3,1);
  --ob-cond: ${FONT_COND};
  --ob-sans: ${FONT_SANS};
  --ob-mono: ${FONT_MONO};
  font-family: var(--ob-sans);
}

#ui-root * { box-sizing: border-box; }

#ob-hud-canvas,
#ob-desat {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

#ob-desat {
  background: #808080;
  mix-blend-mode: saturation;
  opacity: 0;
  z-index: 1;
}

#ob-hud-canvas { z-index: 2; }
#ob-dom-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; }

/* ------------------------------------------------------------ subtitles -- */

.ob-subs {
  position: absolute;
  left: 50%;
  bottom: calc(var(--ob-u) * 132);
  transform: translateX(-50%);
  width: min(72%, calc(var(--ob-u) * 900));
  text-align: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity .22s var(--ob-ease);
}
.ob-subs.is-on { opacity: calc(var(--ob-opacity)); }
.ob-subs-line {
  display: inline-block;
  padding: calc(var(--ob-u) * 5) calc(var(--ob-u) * 22) calc(var(--ob-u) * 5) calc(var(--ob-u) * 14);
  /* Fades out to the right rather than ending on a hard rectangle edge — a
     square plate floating over the frame is the giveaway that this is a web
     page and not a game. */
  background: linear-gradient(90deg, rgba(4,7,12,.8) 0%, rgba(4,7,12,.74) 62%, rgba(4,7,12,0) 100%);
  border-left: 2px solid var(--ob-accent);
  font-family: var(--ob-sans);
  font-size: calc(var(--ob-u) * 17);
  font-weight: 500;
  line-height: 1.34;
  letter-spacing: .012em;
  color: var(--ob-ink);
  text-shadow: 0 1px 3px rgba(0,0,0,.95), 0 0 calc(var(--ob-u)*7) rgba(0,0,0,.7);
}
.ob-subs-speaker {
  font-family: var(--ob-cond);
  font-weight: 700;
  letter-spacing: .18em;
  color: var(--ob-accent);
  margin-right: calc(var(--ob-u) * 8);
}

/* ----------------------------------------------------------- scoreboard -- */

.ob-scoreboard {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s var(--ob-ease);
}
.ob-scoreboard.is-open { opacity: calc(var(--ob-opacity)); }
.ob-scoreboard-inner {
  width: min(92%, calc(var(--ob-u) * 1180));
  background: linear-gradient(180deg, rgba(6,10,16,.93), rgba(4,7,12,.88));
  border: 1px solid var(--ob-hair);
  clip-path: polygon(0 calc(var(--ob-u)*14), calc(var(--ob-u)*14) 0, 100% 0, 100% calc(100% - var(--ob-u)*14), calc(100% - var(--ob-u)*14) 100%, 0 100%);
  padding: calc(var(--ob-u) * 22) calc(var(--ob-u) * 26);
  transform: translateY(calc(var(--ob-u) * 10)) scale(.985);
  transition: transform .22s var(--ob-ease);
}
.ob-scoreboard.is-open .ob-scoreboard-inner { transform: none; }
.ob-sb-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: calc(var(--ob-u)*14); }
.ob-sb-title { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*26); font-weight: 700; letter-spacing: .24em; color: var(--ob-ink); }
.ob-sb-mode { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*13); letter-spacing: .34em; color: var(--ob-faint); }
.ob-sb-score { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*30); font-weight: 700; letter-spacing: .1em; }
.ob-sb-teams { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--ob-u)*22); }
.ob-sb-team-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*14); letter-spacing: .3em; margin-bottom: calc(var(--ob-u)*6); }
table.ob-sb { width: 100%; border-collapse: collapse; font-family: var(--ob-cond); }
table.ob-sb th {
  font-size: calc(var(--ob-u)*10.5); letter-spacing: .22em; font-weight: 600;
  color: var(--ob-faint); text-align: right; padding: calc(var(--ob-u)*4) calc(var(--ob-u)*5);
  border-bottom: 1px solid var(--ob-hair);
}
table.ob-sb th:first-child, table.ob-sb td:first-child { text-align: left; }
table.ob-sb td {
  font-size: calc(var(--ob-u)*15); color: var(--ob-ink); text-align: right;
  padding: calc(var(--ob-u)*4) calc(var(--ob-u)*5);
  border-bottom: 1px solid rgba(157,178,204,.08);
  letter-spacing: .06em;
}
table.ob-sb tr.is-me td { color: var(--ob-accent); background: rgba(255,194,75,.07); }
.ob-sb-bar { height: 2px; background: var(--ob-hair); margin: calc(var(--ob-u)*10) 0; }

/* ---------------------------------------------------------------- menus -- */

.ob-screen {
  position: absolute;
  inset: 0;
  display: none;
  pointer-events: auto;
  opacity: 0;
  transition: opacity .28s var(--ob-ease);
  background:
    linear-gradient(100deg, rgba(3,6,10,.94) 0%, rgba(3,6,10,.88) 34%, rgba(4,7,12,.62) 62%, rgba(4,7,12,.5) 100%),
    radial-gradient(120% 120% at 22% 34%, rgba(6,10,16,.22) 0%, rgba(2,4,7,.55) 100%);
}
.ob-screen.is-mounted { display: block; }
.ob-screen.is-open { opacity: 1; }
.ob-screen::after {
  content: '';
  position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(255,255,255,.016) 0 1px, transparent 1px 3px);
  mix-blend-mode: overlay;
}

.ob-vine {
  position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(82% 82% at 46% 50%, transparent 40%, rgba(0,0,0,.5) 100%);
}

.ob-topbar {
  position: absolute;
  top: calc(var(--ob-u)*30); left: calc(var(--ob-u)*46); right: calc(var(--ob-u)*46);
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: calc(var(--ob-u)*12);
  border-bottom: 1px solid var(--ob-hair);
}
.ob-brand { display: flex; align-items: baseline; gap: calc(var(--ob-u)*12); }
.ob-brand-mark {
  font-family: var(--ob-cond); font-weight: 700; font-size: calc(var(--ob-u)*22);
  letter-spacing: .36em; color: var(--ob-ink);
}
.ob-brand-sub {
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10); letter-spacing: .3em;
  color: var(--ob-faint); text-transform: uppercase;
}
.ob-topbar-right { display: flex; align-items: center; gap: calc(var(--ob-u)*18); }
.ob-chip {
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10.5); letter-spacing: .18em;
  color: var(--ob-dim); border: 1px solid var(--ob-hair); padding: calc(var(--ob-u)*3) calc(var(--ob-u)*9);
}

.ob-body {
  position: absolute;
  top: calc(var(--ob-u)*104); left: calc(var(--ob-u)*46); right: calc(var(--ob-u)*46);
  bottom: calc(var(--ob-u)*74);
  display: grid;
  gap: calc(var(--ob-u)*28);
}
.ob-body.cols-2 { grid-template-columns: minmax(0,0.9fr) minmax(0,1.6fr); }
.ob-body.cols-nav { grid-template-columns: calc(var(--ob-u)*330) minmax(0,1fr); }

.ob-footer {
  position: absolute;
  left: calc(var(--ob-u)*46); right: calc(var(--ob-u)*46); bottom: calc(var(--ob-u)*26);
  display: flex; align-items: center; justify-content: space-between;
  padding-top: calc(var(--ob-u)*10);
  border-top: 1px solid var(--ob-hair);
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*11.5);
  letter-spacing: .24em; color: var(--ob-faint);
}
.ob-keyhints { display: flex; gap: calc(var(--ob-u)*20); }
.ob-keyhint b {
  display: inline-block; min-width: calc(var(--ob-u)*18); text-align: center;
  border: 1px solid var(--ob-hair-strong); color: var(--ob-dim);
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10);
  padding: 0 calc(var(--ob-u)*4); margin-right: calc(var(--ob-u)*7);
}

/* nav list */
.ob-nav { display: flex; flex-direction: column; gap: calc(var(--ob-u)*2); }
.ob-nav-item {
  position: relative;
  display: flex; align-items: center; gap: calc(var(--ob-u)*14);
  padding: calc(var(--ob-u)*11) calc(var(--ob-u)*16) calc(var(--ob-u)*11) calc(var(--ob-u)*20);
  background: linear-gradient(90deg, rgba(157,178,204,.055), rgba(157,178,204,0));
  border: 0; border-left: 2px solid transparent;
  color: var(--ob-dim);
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*23); font-weight: 600;
  letter-spacing: .2em; text-transform: uppercase; text-align: left;
  cursor: pointer;
  transition: color .18s var(--ob-ease), transform .28s var(--ob-ease), background .2s var(--ob-ease), border-color .2s var(--ob-ease);
}
.ob-nav-item .ob-nav-idx {
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10); letter-spacing: .1em;
  color: var(--ob-faint); transition: color .18s var(--ob-ease);
}
.ob-nav-item:hover, .ob-nav-item:focus-visible {
  color: var(--ob-ink); transform: translateX(calc(var(--ob-u)*9));
  border-left-color: var(--ob-accent);
  background: linear-gradient(90deg, rgba(255,194,75,.12), rgba(255,194,75,0));
  outline: none;
}
.ob-nav-item:hover .ob-nav-idx { color: var(--ob-accent); }
.ob-nav-item[disabled] { opacity: .35; cursor: default; transform: none; }
.ob-nav-item .ob-nav-note {
  margin-left: auto; font-family: var(--ob-cond); font-size: calc(var(--ob-u)*11);
  letter-spacing: .22em; color: var(--ob-faint);
}

/* panels */
.ob-panel {
  position: relative;
  background: var(--ob-panel);
  border: 1px solid var(--ob-hair);
  clip-path: polygon(0 calc(var(--ob-u)*12), calc(var(--ob-u)*12) 0, 100% 0, 100% calc(100% - var(--ob-u)*12), calc(100% - var(--ob-u)*12) 100%, 0 100%);
  padding: calc(var(--ob-u)*18) calc(var(--ob-u)*20);
  min-height: 0;
  overflow: hidden;
}
.ob-panel-title {
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*12); font-weight: 600;
  letter-spacing: .34em; color: var(--ob-faint); text-transform: uppercase;
  padding-bottom: calc(var(--ob-u)*8); margin-bottom: calc(var(--ob-u)*12);
  border-bottom: 1px solid var(--ob-hair);
  display: flex; justify-content: space-between; align-items: center;
}
.ob-scroll { overflow-y: auto; overflow-x: hidden; max-height: 100%; scrollbar-width: thin; scrollbar-color: var(--ob-hair-strong) transparent; }
.ob-scroll::-webkit-scrollbar { width: calc(var(--ob-u)*5); }
.ob-scroll::-webkit-scrollbar-thumb { background: var(--ob-hair-strong); }

/* settings rows */
.ob-row {
  /* No max-width: with the active-profile aside taking the right third, capping
     the rows left a second, pointless gutter inside the panel. */
  display: grid; grid-template-columns: minmax(0,1fr) calc(var(--ob-u)*280);
  align-items: center; gap: calc(var(--ob-u)*18);
  padding: calc(var(--ob-u)*7) 0;
  border-bottom: 1px solid rgba(157,178,204,.07);
}
.ob-row-label { min-width: 0; }
.ob-row-name {
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*16); font-weight: 600;
  letter-spacing: .13em; color: var(--ob-ink); text-transform: uppercase;
}
.ob-row-help {
  font-family: var(--ob-sans); font-size: calc(var(--ob-u)*11.5); color: var(--ob-faint);
  margin-top: calc(var(--ob-u)*2); line-height: 1.35;
}
.ob-row-control { display: flex; align-items: center; gap: calc(var(--ob-u)*10); justify-content: flex-end; }

.ob-slider { -webkit-appearance: none; appearance: none; width: 100%; height: calc(var(--ob-u)*16); background: transparent; cursor: pointer; }
.ob-slider::-webkit-slider-runnable-track { height: calc(var(--ob-u)*3); background: rgba(157,178,204,.16); }
.ob-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: calc(var(--ob-u)*4); height: calc(var(--ob-u)*15);
  background: var(--ob-accent); margin-top: calc(var(--ob-u)*-6);
  box-shadow: 0 0 calc(var(--ob-u)*10) rgba(255,194,75,.5);
  transition: transform .12s var(--ob-ease);
}
.ob-slider:hover::-webkit-slider-thumb { transform: scaleY(1.18); }
.ob-slider::-moz-range-track { height: calc(var(--ob-u)*3); background: rgba(157,178,204,.16); }
.ob-slider::-moz-range-thumb { width: calc(var(--ob-u)*4); height: calc(var(--ob-u)*15); border: 0; background: var(--ob-accent); }
.ob-slider-value {
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*12); color: var(--ob-dim);
  min-width: calc(var(--ob-u)*54); text-align: right;
}

.ob-seg { display: flex; border: 1px solid var(--ob-hair); }
.ob-seg button {
  flex: 1 1 auto; background: transparent; border: 0; cursor: pointer;
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*12); font-weight: 600;
  letter-spacing: .18em; text-transform: uppercase; color: var(--ob-dim);
  padding: calc(var(--ob-u)*6) calc(var(--ob-u)*10);
  transition: background .16s var(--ob-ease), color .16s var(--ob-ease);
  white-space: nowrap;
}
.ob-seg button + button { border-left: 1px solid var(--ob-hair); }
.ob-seg button:hover { color: var(--ob-ink); background: rgba(157,178,204,.08); }
.ob-seg button.is-on { color: #05070b; background: var(--ob-accent); }

.ob-toggle {
  position: relative; width: calc(var(--ob-u)*46); height: calc(var(--ob-u)*18);
  border: 1px solid var(--ob-hair-strong); background: rgba(157,178,204,.06);
  cursor: pointer; padding: 0;
  transition: border-color .18s var(--ob-ease), background .18s var(--ob-ease);
}
.ob-toggle i {
  position: absolute; top: calc(var(--ob-u)*2); left: calc(var(--ob-u)*2);
  width: calc(var(--ob-u)*18); height: calc(var(--ob-u)*12);
  background: var(--ob-dim);
  transition: transform .2s var(--ob-ease), background .2s var(--ob-ease);
}
.ob-toggle.is-on { border-color: var(--ob-accent); background: rgba(255,194,75,.14); }
.ob-toggle.is-on i { transform: translateX(calc(var(--ob-u)*22)); background: var(--ob-accent); }

.ob-bind {
  min-width: calc(var(--ob-u)*120);
  font-family: var(--ob-mono); font-size: calc(var(--ob-u)*11.5); letter-spacing: .12em;
  color: var(--ob-ink); background: rgba(157,178,204,.06);
  border: 1px solid var(--ob-hair); padding: calc(var(--ob-u)*5) calc(var(--ob-u)*10);
  cursor: pointer; text-transform: uppercase;
  transition: border-color .16s var(--ob-ease), color .16s var(--ob-ease), background .16s var(--ob-ease);
}
.ob-bind:hover { border-color: var(--ob-hair-strong); color: var(--ob-ink); }
.ob-bind.is-listening { border-color: var(--ob-accent); color: var(--ob-accent); background: rgba(255,194,75,.1); animation: ob-pulse 1s infinite; }
@keyframes ob-pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }

/* tabs */
.ob-tabs { display: flex; gap: calc(var(--ob-u)*4); margin-bottom: calc(var(--ob-u)*14); border-bottom: 1px solid var(--ob-hair); }
.ob-tab {
  background: transparent; border: 0; border-bottom: 2px solid transparent;
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*15); font-weight: 600;
  letter-spacing: .22em; text-transform: uppercase; color: var(--ob-faint);
  padding: calc(var(--ob-u)*7) calc(var(--ob-u)*16); cursor: pointer;
  transition: color .16s var(--ob-ease), border-color .16s var(--ob-ease);
}
.ob-tab:hover { color: var(--ob-dim); }
.ob-tab.is-on { color: var(--ob-ink); border-bottom-color: var(--ob-accent); }

/* buttons */
.ob-btn {
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*14); font-weight: 600;
  letter-spacing: .22em; text-transform: uppercase;
  color: var(--ob-ink); background: rgba(157,178,204,.07);
  border: 1px solid var(--ob-hair); cursor: pointer;
  padding: calc(var(--ob-u)*8) calc(var(--ob-u)*20);
  transition: background .16s var(--ob-ease), color .16s var(--ob-ease), border-color .16s var(--ob-ease), transform .16s var(--ob-ease);
}
.ob-btn:hover { background: rgba(255,194,75,.14); border-color: var(--ob-accent); color: var(--ob-ink); }
.ob-btn:active { transform: translateY(1px); }
.ob-btn.is-primary { background: var(--ob-accent); color: #05070b; border-color: var(--ob-accent); }
.ob-btn.is-primary:hover { filter: brightness(1.12); }
.ob-btn.is-danger:hover { background: rgba(255,74,58,.16); border-color: var(--ob-hostile); }

/* loadout */
.ob-weapon-list { display: flex; flex-direction: column; gap: calc(var(--ob-u)*3); }
.ob-weapon-item {
  display: grid; grid-template-columns: calc(var(--ob-u)*34) minmax(0,1fr) auto;
  align-items: center; gap: calc(var(--ob-u)*10);
  background: rgba(157,178,204,.04); border: 0; border-left: 2px solid transparent;
  padding: calc(var(--ob-u)*8) calc(var(--ob-u)*12);
  cursor: pointer; text-align: left; color: var(--ob-dim);
  transition: background .16s var(--ob-ease), color .16s var(--ob-ease), border-color .16s var(--ob-ease), transform .2s var(--ob-ease);
}
.ob-weapon-item:hover { color: var(--ob-ink); background: rgba(157,178,204,.09); transform: translateX(calc(var(--ob-u)*4)); }
.ob-weapon-item.is-on { color: var(--ob-ink); border-left-color: var(--ob-accent); background: linear-gradient(90deg, rgba(255,194,75,.14), rgba(255,194,75,.02)); }
.ob-weapon-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*18); font-weight: 600; letter-spacing: .16em; }
.ob-weapon-class { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*9.5); letter-spacing: .18em; color: var(--ob-faint); }
.ob-weapon-lvl { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10); color: var(--ob-faint); }

.ob-stat { display: grid; grid-template-columns: calc(var(--ob-u)*104) minmax(0,1fr) calc(var(--ob-u)*34); align-items: center; gap: calc(var(--ob-u)*10); padding: calc(var(--ob-u)*3) 0; }
.ob-stat-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*12); letter-spacing: .2em; color: var(--ob-dim); text-transform: uppercase; }
.ob-stat-track { position: relative; height: calc(var(--ob-u)*6); background: rgba(157,178,204,.12); }
.ob-stat-fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, rgba(255,194,75,.55), var(--ob-accent)); transition: width .5s var(--ob-ease); }
.ob-stat-delta { position: absolute; top: 0; bottom: 0; background: rgba(99,230,168,.5); transition: all .5s var(--ob-ease); }
.ob-stat-val { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*11); color: var(--ob-dim); text-align: right; }

.ob-attachments { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: calc(var(--ob-u)*8); }
.ob-att {
  background: rgba(157,178,204,.05); border: 1px solid var(--ob-hair);
  padding: calc(var(--ob-u)*8); cursor: pointer; text-align: left; color: var(--ob-dim);
  transition: border-color .16s var(--ob-ease), background .16s var(--ob-ease), color .16s var(--ob-ease);
  clip-path: polygon(0 calc(var(--ob-u)*7), calc(var(--ob-u)*7) 0, 100% 0, 100% 100%, 0 100%);
}
.ob-att:hover { border-color: var(--ob-hair-strong); color: var(--ob-ink); background: rgba(157,178,204,.1); }
.ob-att.is-filled { border-color: rgba(255,194,75,.5); color: var(--ob-ink); background: rgba(255,194,75,.08); }
.ob-att-slot { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*8.5); letter-spacing: .2em; color: var(--ob-faint); }
.ob-att-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*13); font-weight: 600; letter-spacing: .1em; margin-top: calc(var(--ob-u)*3); }

.ob-schematic { width: 100%; height: 100%; display: block; }

/* summary */
.ob-summary-grid { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,1fr); gap: calc(var(--ob-u)*26); height: 100%; }
.ob-result {
  font-family: var(--ob-cond); font-weight: 700; letter-spacing: .3em; text-transform: uppercase;
  font-size: calc(var(--ob-u)*70); line-height: .95; color: var(--ob-ink);
}
.ob-result.is-win { color: var(--ob-accent); text-shadow: 0 0 calc(var(--ob-u)*40) rgba(255,194,75,.28); }
.ob-result.is-loss { color: var(--ob-hostile); text-shadow: 0 0 calc(var(--ob-u)*40) rgba(255,74,58,.22); }
.ob-result-sub { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*14); letter-spacing: .34em; color: var(--ob-faint); margin-top: calc(var(--ob-u)*6); }
.ob-break { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: calc(var(--ob-u)*8); padding: calc(var(--ob-u)*5) 0; border-bottom: 1px solid rgba(157,178,204,.08); align-items: baseline; }
.ob-break-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*14); letter-spacing: .16em; color: var(--ob-dim); text-transform: uppercase; }
.ob-break-count { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*11); color: var(--ob-faint); }
.ob-break-pts { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*16); font-weight: 700; color: var(--ob-ink); min-width: calc(var(--ob-u)*66); text-align: right; }
.ob-xpbar { position: relative; height: calc(var(--ob-u)*8); background: rgba(157,178,204,.12); margin-top: calc(var(--ob-u)*8); }
.ob-xpbar i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, rgba(255,194,75,.5), var(--ob-accent)); }
.ob-medals { display: flex; flex-wrap: wrap; gap: calc(var(--ob-u)*8); margin-top: calc(var(--ob-u)*10); }
.ob-medal {
  border: 1px solid rgba(255,194,75,.4); background: rgba(255,194,75,.08);
  padding: calc(var(--ob-u)*5) calc(var(--ob-u)*10);
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*11.5); letter-spacing: .2em;
  color: var(--ob-accent); text-transform: uppercase;
}

/* player card */
.ob-card { display: flex; align-items: center; gap: calc(var(--ob-u)*14); }
.ob-rank {
  width: calc(var(--ob-u)*52); height: calc(var(--ob-u)*52);
  display: grid; place-items: center;
  border: 1px solid rgba(255,194,75,.45); color: var(--ob-accent);
  font-family: var(--ob-cond); font-size: calc(var(--ob-u)*24); font-weight: 700;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: rgba(255,194,75,.08);
}
.ob-card-name { font-family: var(--ob-cond); font-size: calc(var(--ob-u)*22); font-weight: 600; letter-spacing: .2em; color: var(--ob-ink); }
.ob-card-meta { font-family: var(--ob-mono); font-size: calc(var(--ob-u)*10); letter-spacing: .16em; color: var(--ob-faint); margin-top: calc(var(--ob-u)*2); }

/* entrance stagger */
.ob-screen.is-open .ob-stagger {
  animation: ob-in .5s var(--ob-ease) both;
  animation-delay: calc(var(--i, 0) * 45ms);
}
@keyframes ob-in {
  from { opacity: 0; transform: translateY(calc(var(--ob-u)*14)); }
  to { opacity: 1; transform: none; }
}
.ob-screen.is-open .ob-stagger-x {
  animation: ob-in-x .55s var(--ob-ease) both;
  animation-delay: calc(var(--i, 0) * 38ms);
}
@keyframes ob-in-x {
  from { opacity: 0; transform: translateX(calc(var(--ob-u)*-22)); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .ob-screen.is-open .ob-stagger,
  .ob-screen.is-open .ob-stagger-x { animation-duration: .01ms; animation-delay: 0ms; }
}
#ui-root.ob-reduced .ob-screen.is-open .ob-stagger,
#ui-root.ob-reduced .ob-screen.is-open .ob-stagger-x { animation-duration: .01ms; animation-delay: 0ms; }
#ui-root.ob-reduced * { transition-duration: .05s !important; }
`;

export function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
