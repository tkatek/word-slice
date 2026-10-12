// One-off asset pipeline: decode raw AI-generated fruit PNGs, remove solid
// black backgrounds (some generations came back opaque), trim transparent
// margins, and write normalized sprites into assets/fruits/.
// Zero dependencies: node:fs + node:zlib only. Run: node tools/prep-fruits.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC = 'C:\\Users\\HP\\Downloads';
const OUT = path.resolve('assets/fruits');

const FILES = {
  'watermelon.png': 'Image ChatGPT 12 oct. 2026, 20_41_54-1.png',
  'pineapple.png': 'Image ChatGPT 12 oct. 2026, 20_41_55-2.png',
  'orange.png': 'Image ChatGPT 12 oct. 2026, 20_41_56-3.png',
  'apple.png': 'Image ChatGPT 12 oct. 2026, 20_41_58-4.png',
  'strawberry.png': 'Image ChatGPT 12 oct. 2026, 20_41_59-5.png',
  'blueberry.png': 'Image ChatGPT 12 oct. 2026, 20_42_00-6.png',
  'banana.png': 'Image ChatGPT 12 oct. 2026, 20_42_01-7.png',
  'pear.png': 'Image ChatGPT 12 oct. 2026, 20_42_01-8.png',
  'lemon.png': 'Image ChatGPT 12 oct. 2026, 20_42_02-9.png',
  'kiwi.png': 'Image ChatGPT 12 oct. 2026, 20_42_03-10.png',
  'watermelon-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_29-4.png',
  'pineapple-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_28-3.png',
  'orange-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_25-1.png',
  'apple-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_26-2.png',
  'strawberry-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_32-5.png',
  'blueberry-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_33-6.png',
  'banana-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_34-7.png',
  'pear-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_35-8.png',
  'lemon-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_36-9.png',
  'kiwi-cut.png': 'Image ChatGPT 12 oct. 2026, 20_45_37-10.png',
};

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      line[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1];
        out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1];
        out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1];
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255;
      }
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

function encodePng(width, height, rgba) {
  const chunks = [];
  const push = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    chunks.push(Buffer.concat([len, body, crc]));
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  push('IHDR', ihdr);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  push('IDAT', zlib.deflateSync(raw, { level: 9 }));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

const isNearBlack = (rgba, o) => rgba[o] < 40 && rgba[o + 1] < 40 && rgba[o + 2] < 40;

fs.mkdirSync(OUT, { recursive: true });
const report = [];
for (const [dest, src] of Object.entries(FILES)) {
  const img = decodePng(fs.readFileSync(path.join(SRC, src)));
  // If the border ring is mostly opaque near-black, the generator returned a
  // solid background: chroma-key near-black pixels away.
  let borderTotal = 0, borderBlack = 0;
  const ring = (x, y) => {
    const o = (y * img.width + x) * 4;
    borderTotal++;
    if (img.rgba[o + 3] > 200 && isNearBlack(img.rgba, o)) borderBlack++;
  };
  for (let x = 0; x < img.width; x += 4) { ring(x, 0); ring(x, img.height - 1); }
  for (let y = 0; y < img.height; y += 4) { ring(0, y); ring(img.width - 1, y); }
  let keyed = 0;
  if (borderBlack / borderTotal > 0.9) {
    for (let o = 0; o < img.rgba.length; o += 4) {
      if (img.rgba[o + 3] > 0 && isNearBlack(img.rgba, o)) { img.rgba[o + 3] = 0; keyed++; }
    }
  }
  // Generator saves fruit bodies at alpha 253 — clamp near-opaque to full.
  for (let o = 3; o < img.rgba.length; o += 4) {
    if (img.rgba[o] >= 230) img.rgba[o] = 255;
  }
  // Trim transparent margins so the sprite box equals the fruit body —
  // the renderer then scales by engine radius without hidden padding.
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let w = maxX - minX + 1, h = maxY - minY + 1;
  const src0 = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.rgba.copy(src0, y * w * 4, ((minY + y) * img.width + minX) * 4, ((minY + y) * img.width + minX + w) * 4);
  }
  // Area-average downscale: sprites render at ~120px, keep 480px for retina.
  const MAX = 480;
  if (Math.max(w, h) > MAX) {
    const scale = MAX / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const dst = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor((x * w) / nw), sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor(((x + 1) * w) / nw)));
        const sy0 = Math.floor((y * h) / nh), sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor(((y + 1) * h) / nh)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const o = (sy * w + sx) * 4, al = src0[o + 3];
            // Straight multiply keeps colors true where alpha is partial.
            r += src0[o] * al; g += src0[o + 1] * al; b += src0[o + 2] * al; a += al; n++;
          }
        }
        const o = (y * nw + x) * 4;
        if (a > 0) {
          dst[o] = Math.round(r / a); dst[o + 1] = Math.round(g / a); dst[o + 2] = Math.round(b / a);
        }
        dst[o + 3] = Math.round(a / n);
      }
    }
    w = nw; h = nh; var out = dst;
  } else {
    var out = src0;
  }
  fs.writeFileSync(path.join(OUT, dest), encodePng(w, h, out));
  report.push(`${dest.padEnd(20)} ${img.width}x${img.height} -> ${w}x${h}  keyed:${(keyed / (img.width * img.height) * 100).toFixed(0)}%`);
}
console.log(report.join('\n'));
