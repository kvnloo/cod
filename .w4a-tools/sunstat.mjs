import { decodePNG } from './png.mjs';
import path from 'node:path';

const dirs = process.argv[2].split(',');
const shots = process.argv[3].split(',');

function stat(file) {
  let img;
  try { img = decodePNG(file); } catch { return null; }
  const { width: w, height: h, channels: ch, data } = img;
  const px = (x, y) => { const o = (y * w + x) * ch; return [data[o], data[o + 1], data[o + 2]]; };
  // sky band: top 12% of frame
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = 0; y < Math.floor(h * 0.12); y++) for (let x = 0; x < w; x += 3) {
    const [r, g, b] = px(x, y); sr += r; sg += g; sb += b; sn++;
  }
  // lower 40%
  let gr = 0, gg = 0, gb2 = 0, gn = 0;
  for (let y = Math.floor(h * 0.6); y < h; y++) for (let x = 0; x < w; x += 3) {
    const [r, g, b] = px(x, y); gr += r; gg += g; gb2 += b; gn++;
  }
  // clipped + histogram
  let clip = 0, near = 0, n = 0;
  const lums = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const [r, g, b] = px(x, y);
    const mx = Math.max(r, g, b);
    if (mx >= 254) clip++;
    if (mx >= 245) near++;
    n++;
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  lums.sort((a, b) => a - b);
  const pc = (p) => lums[Math.min(lums.length - 1, Math.floor(lums.length * p))];
  return {
    sky: [sr / sn, sg / sn, sb / sn].map((v) => +v.toFixed(1)),
    skyRB: +((sr - sb) / sn).toFixed(1),
    ground: [gr / gn, gg / gn, gb2 / gn].map((v) => +v.toFixed(1)),
    clipPct: +(100 * clip / n).toFixed(4),
    nearPct: +(100 * near / n).toFixed(4),
    p: [pc(0.01), pc(0.1), pc(0.5), pc(0.9), pc(0.99), pc(0.999)].map((v) => Math.round(v)),
  };
}

for (const shot of shots) {
  console.log('== ' + shot);
  for (const d of dirs) {
    const s = stat(path.join('/workspace/zer0/products/cod/shots', d, shot + '.png'));
    if (!s) { console.log(`  ${d.padEnd(14)} (missing)`); continue; }
    console.log(`  ${d.padEnd(14)} sky ${JSON.stringify(s.sky).padEnd(22)} R-B ${String(s.skyRB).padStart(7)}  gnd ${JSON.stringify(s.ground).padEnd(22)} clip ${String(s.clipPct).padStart(7)}% near ${String(s.nearPct).padStart(7)}% pct ${JSON.stringify(s.p)}`);
  }
}
