import { decodePNG, encodePNG, crop } from './png.mjs';
import path from 'node:path';
// node zoom.mjs <label> <shot> <x0> <y0> <w> <h> <zoom> <out>
const [label, shot, x0, y0, w, h, z, out] = process.argv.slice(2);
const img = decodePNG(path.join('/workspace/zer0/products/cod/shots', label, shot + '.png'));
const c = crop(img, +x0, +y0, +w, +h, +z);
encodePNG(out, c.w, c.h, c.buf);
// scanline through the middle
const my = +y0 + Math.floor(+h / 2);
const row = [];
for (let x = +x0; x < +x0 + +w; x += Math.max(1, Math.floor(+w / 24))) {
  const o = (my * img.width + x) * img.channels;
  row.push(`${x}:${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`);
}
console.log('scanline y=' + my, row.join(' '));
console.log('wrote', out, c.w, c.h);
