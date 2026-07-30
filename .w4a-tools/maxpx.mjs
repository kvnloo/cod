import { decodePNG } from './png.mjs';
import path from 'node:path';
const img = decodePNG(path.join('/workspace/zer0/products/cod/shots', process.argv[2], process.argv[3] + '.png'));
const { width: w, height: h, channels: ch, data } = img;
let best = -1, bx = 0, by = 0, n255 = 0, n250 = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const o = (y * w + x) * ch;
  const v = data[o] + data[o + 1] + data[o + 2];
  if (data[o] >= 254 && data[o + 1] >= 254) n255++;
  if (Math.max(data[o], data[o + 1], data[o + 2]) >= 250) n250++;
  if (v > best) { best = v; bx = x; by = y; }
}
const o = (by * w + bx) * ch;
console.log(`${process.argv[3]}: max ${data[o]},${data[o + 1]},${data[o + 2]} at ${bx},${by}; px>=254(rg) ${n255}; px>=250 ${n250}`);
