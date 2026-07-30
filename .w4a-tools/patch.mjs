import { decodePNG } from './png.mjs';
import path from 'node:path';

// node patch.mjs <label> <shot> "name:x0,y0,x1,y1" ...
const label = process.argv[2];
const shot = process.argv[3];
const img = decodePNG(path.join('/workspace/zer0/products/cod/shots', label, shot + '.png'));
for (const spec of process.argv.slice(4)) {
  const [name, rect] = spec.split(':');
  const [x0, y0, x1, y1] = rect.split(',').map(Number);
  let r = 0, g = 0, b = 0, n = 0, mx = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * img.width + x) * img.channels;
    r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
    mx = Math.max(mx, img.data[o], img.data[o + 1], img.data[o + 2]);
  }
  console.log(`${label}/${shot} ${name.padEnd(12)} rgb ${(r / n).toFixed(0)},${(g / n).toFixed(0)},${(b / n).toFixed(0)}  peak ${mx}`);
}
