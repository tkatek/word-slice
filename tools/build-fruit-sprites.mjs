// Asset pipeline for the word_slice_frute_assets pack: reads the extracted
// originals in assets/fruits/uncuted + assets/fruits/cuted, normalizes them
// (chroma-keys solid near-black AI backgrounds, clamps the generator's
// alpha-253 bodies to opaque, trims transparent margins, area-average
// downscales to sprite size), and writes game-ready PNGs into
// assets/fruits/sprites/<group>/. Originals are never modified.
// Zero dependencies: node:fs + node:zlib only. Run: node tools/build-fruit-sprites.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC_ROOT = path.resolve('assets/fruits');
const OUT_ROOT = path.join(SRC_ROOT, 'sprites');
const GROUPS = ['uncuted', 'cuted'];
// Fruits render at ~124 CSS px; 480 px covers ~4x retina with headroom.
const MAX_EDGE = 480;

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

/** Decodes, normalizes, trims, and downscales one sprite. Returns a report row. */
function processSprite(srcPath, destPath) {
  const img = decodePng(fs.readFileSync(srcPath));
  const srcPx = img.width * img.height;

  // Border scan: an opaque near-black ring means the generator returned a
  // solid background that must be chroma-keyed away.
  let borderTotal = 0, borderBlack = 0;
  const ring = (x, y) => {
    const o = (y * img.width + x) * 4;
    borderTotal++;
    if (img.rgba[o + 3] > 200 && isNearBlack(img.rgba, o)) borderBlack++;
  };
  for (let x = 0; x < img.width; x += 4) { ring(x, 0); ring(x, img.height - 1); }
  for (let y = 0; y < img.height; y += 4) { ring(0, y); ring(img.width - 1, y); }
  let keyed = 0;
  const hadBlackBg = borderBlack / borderTotal > 0.9;
  if (hadBlackBg) {
    for (let o = 0; o < img.rgba.length; o += 4) {
      if (img.rgba[o + 3] > 0 && isNearBlack(img.rgba, o)) { img.rgba[o + 3] = 0; keyed++; }
    }
  }
  // Generator saves fruit bodies at alpha 253 — clamp near-opaque to full.
  for (let o = 3; o < img.rgba.length; o += 4) {
    if (img.rgba[o] >= 230) img.rgba[o] = 255;
  }
  // Trim transparent margins so the sprite box equals the visible body —
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
  const trimmed = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.rgba.copy(trimmed, y * w * 4, ((minY + y) * img.width + minX) * 4, ((minY + y) * img.width + minX + w) * 4);
  }
  // Area-average downscale (straight-alpha weighted keeps colors true).
  let out = trimmed;
  if (Math.max(w, h) > MAX_EDGE) {
    const scale = MAX_EDGE / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const dst = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor((x * w) / nw), sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor(((x + 1) * w) / nw)));
        const sy0 = Math.floor((y * h) / nh), sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor(((y + 1) * h) / nh)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const o = (sy * w + sx) * 4, al = trimmed[o + 3];
            r += trimmed[o] * al; g += trimmed[o + 1] * al; b += trimmed[o + 2] * al; a += al; n++;
          }
        }
        const o = (y * nw + x) * 4;
        if (a > 0) {
          dst[o] = Math.round(r / a); dst[o + 1] = Math.round(g / a); dst[o + 2] = Math.round(b / a);
        }
        dst[o + 3] = Math.round(a / n);
      }
    }
    w = nw; h = nh; out = dst;
  }
  fs.writeFileSync(destPath, encodePng(w, h, out));
  let opaque = 0;
  for (let o = 3; o < out.length; o += 4) if (out[o] > 200) opaque++;
  return {
    source: `${img.width}x${img.height}`,
    blackBg: hadBlackBg,
    keyedPct: Math.round((keyed / srcPx) * 100),
    trimmed: `${w}x${h}`,
    aspect: (w / h).toFixed(2),
    kbOut: Math.round(fs.statSync(destPath).size / 1024),
    opaquePct: Math.round((opaque / (w * h)) * 100),
  };
}

const FRUITS = ['watermelon', 'pineapple', 'apple', 'orange', 'strawberry', 'blueberry', 'banana', 'pear', 'lemon', 'kiwi'];
const missing = [];
for (const group of GROUPS) {
  fs.mkdirSync(path.join(OUT_ROOT, group), { recursive: true });
  for (const fruit of FRUITS) {
    const src = path.join(SRC_ROOT, group, `${fruit}.png`);
    if (!fs.existsSync(src)) { missing.push(src); continue; }
    const row = processSprite(src, path.join(OUT_ROOT, group, `${fruit}.png`));
    console.log(`${group}/${fruit.padEnd(11)} ${row.source.padStart(10)} -> ${row.trimmed.padStart(8)} aspect ${row.aspect.padStart(5)}  blackBg:${row.blackBg ? 'YES key ' + row.keyedPct + '%' : 'no '}  opaque:${String(row.opaquePct).padStart(3)}%  ${row.kbOut} KB`);
  }
}
if (missing.length) {
  console.error(`MISSING SOURCES:\n  ${missing.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('All 20 sprites written to assets/fruits/sprites/.');
}
