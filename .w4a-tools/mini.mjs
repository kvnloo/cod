import { decodePNG, encodePNG } from './png.mjs';
import path from 'node:path';

// node mini.mjs <label> <shot1,shot2,...> <outfile> [cols] [tileW]
const label = process.argv[2];
const shots = process.argv[3].split(',');
const out = process.argv[4];
const cols = Number(process.argv[5] || 2);
const tileW = Number(process.argv[6] || 640);

const tiles = shots.map((s) => {
  const img = decodePNG(path.join('/workspace/zer0/products/cod/shots', label, s + '.png'));
  const scale = img.width / tileW;
  const tw = tileW;
  const th = Math.round(img.height / scale);
  const buf = Buffer.alloc(tw * th * 3);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(x * scale), sx1 = Math.min(img.width, Math.floor((x + 1) * scale));
      const sy0 = Math.floor(y * scale), sy1 = Math.min(img.height, Math.floor((y + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * img.width + sx) * img.channels;
        r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
      }
      const o = (y * tw + x) * 3;
      buf[o] = r / n; buf[o + 1] = g / n; buf[o + 2] = b / n;
    }
  }
  return { w: tw, h: th, buf };
});

const rows = Math.ceil(tiles.length / cols);
const th = Math.max(...tiles.map((t) => t.h));
const W = cols * tileW, H = rows * th;
const canvas = Buffer.alloc(W * H * 3);
tiles.forEach((t, i) => {
  const cx = (i % cols) * tileW, cy = Math.floor(i / cols) * th;
  for (let y = 0; y < t.h; y++) {
    t.buf.copy(canvas, ((cy + y) * W + cx) * 3, y * t.w * 3, y * t.w * 3 + t.w * 3);
  }
});
encodePNG(out, W, H, canvas);
console.log(out, W, H, shots.join(' | '));
