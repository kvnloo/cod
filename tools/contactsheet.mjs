#!/usr/bin/env node
/**
 * Builds a labelled contact sheet from a shot directory so a reviewer can take in
 * a whole pass at once, and optional A/B pairs for side-by-side comparison.
 *
 * Compositing happens in the browser (canvas) because we already have Chromium —
 * no image library needed.
 *
 *   node tools/contactsheet.mjs --label pass3
 *   node tools/contactsheet.mjs --label pass3 --vs pass2      # A/B pairs
 *   node tools/contactsheet.mjs --label pass3 --cols 3 --cell 900
 */
import { chromium } from 'playwright';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findChrome, GPU_ARGS, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const label = String(flag('label', 'latest'));
const vs = flag('vs') ? String(flag('vs')) : null;
const cols = Number(flag('cols', vs ? 2 : 3));
const cell = Number(flag('cell', 860));

async function loadDir(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.png') && !f.startsWith('_'));
  files.sort();
  const out = [];
  for (const f of files) {
    const buf = await readFile(path.join(dir, f));
    out.push({ name: path.basename(f, '.png'), data: `data:image/png;base64,${buf.toString('base64')}` });
  }
  return out;
}

async function main() {
  const dirA = path.join(ROOT, 'shots', label);
  const a = await loadDir(dirA);
  if (!a.length) throw new Error(`no PNGs in ${dirA}`);

  let items;
  if (vs) {
    const b = await loadDir(path.join(ROOT, 'shots', vs));
    const byName = new Map(b.map((x) => [x.name, x]));
    items = a.flatMap((x) => {
      const pair = byName.get(x.name);
      return pair
        ? [{ ...pair, name: `${x.name} — ${vs}` }, { ...x, name: `${x.name} — ${label}` }]
        : [{ ...x, name: `${x.name} — ${label}` }];
    });
  } else {
    items = a;
  }

  const rows = Math.ceil(items.length / cols);
  const pad = 14;
  const labelH = 30;
  const cellH = Math.round((cell * 9) / 16);
  const width = cols * cell + (cols + 1) * pad;
  const height = rows * (cellH + labelH) + (rows + 1) * pad;

  const browser = await chromium.launch({ executablePath: findChrome(), args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: Math.min(width, 6000), height: Math.min(height, 6000) } });

  await page.setContent(`<body style="margin:0;background:#0b0d11"></body>`);
  const buf = await page.evaluate(
    async ({ items, cols, cell, cellH, pad, labelH, width, height }) => {
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const g = c.getContext('2d');
      g.fillStyle = '#0b0d11';
      g.fillRect(0, 0, width, height);
      for (let i = 0; i < items.length; i++) {
        const col = i % cols, row = (i / cols) | 0;
        const x = pad + col * (cell + pad);
        const y = pad + row * (cellH + labelH + pad);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = items[i].data; });
        // contain-fit
        const s = Math.min(cell / img.width, cellH / img.height);
        const w = img.width * s, h = img.height * s;
        g.drawImage(img, x + (cell - w) / 2, y + (cellH - h) / 2, w, h);
        g.strokeStyle = '#222a35'; g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, cell - 1, cellH - 1);
        g.fillStyle = '#93a3b8';
        g.font = '500 17px ui-monospace, monospace';
        g.fillText(items[i].name, x + 2, y + cellH + 20);
      }
      return c.toDataURL('image/png').split(',')[1];
    },
    { items, cols, cell, cellH, pad, labelH, width, height },
  );

  const outDir = path.join(ROOT, 'shots', '_sheets');
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, vs ? `${label}-vs-${vs}.png` : `${label}.png`);
  await writeFile(out, Buffer.from(buf, 'base64'));
  await browser.close();
  console.log(`[sheet] ${items.length} images → ${path.relative(ROOT, out)} (${width}x${height})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
