import { decodePNG, encodePNG, crop } from './png.mjs';
import path from 'node:path';

// node hotspot.mjs <label> <shot> [out.png] — finds the brightest 32x32 block
// and dumps a 240x160 crop round it, plus its peak/mean.
const label = process.argv[2];
const shot = process.argv[3];
const out = process.argv[4] || 'hot.png';
const img = decodePNG(path.join('/workspace/zer0/products/cod/shots', label, shot + '.png'));
const { width: w, height: h, channels: ch, data } = img;
const B = 16;
let best = -1, bx = 0, by = 0;
for (let by0 = 0; by0 + B < h; by0 += B) {
  for (let bx0 = 0; bx0 + B < w; bx0 += B) {
    let s = 0;
    for (let y = by0; y < by0 + B; y += 2) for (let x = bx0; x < bx0 + B; x += 2) {
      const o = (y * w + x) * ch;
      s += Math.max(data[o], data[o + 1], data[o + 2]);
    }
    if (s > best) { best = s; bx = bx0; by = by0; }
  }
}
const o = ((by + B / 2) * w + bx + B / 2) * ch;
console.log(`${label}/${shot}: hottest block at ${bx},${by} centre rgb ${data[o]},${data[o + 1]},${data[o + 2]}`);
const c = crop(img, Math.max(0, bx - 120), Math.max(0, by - 80), 240, 160, 2);
encodePNG(out, c.w, c.h, c.buf);
console.log('wrote', out);
