// PWA icon generator:  node scripts/gen-icons.mjs
//
// The brandmark is five bars in a rounded square — geometry, not artwork — so it is drawn
// here rather than pulled in as a binary. That keeps the whole icon set reproducible from
// the tokens in styles/tokens.css, and keeps a build toolchain that installs nothing extra:
// zlib is in Node, and a PNG is a zlib stream wrapped in four chunks.
//
// Output lands in public/icons/ and is committed. Re-run it only when the mark changes.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── Brand values, mirrored from tokens.css ──────────────────────────────────
const INDIGO = [0x55, 0x46, 0xe8];
const SPARK = [0xff, 0x9e, 0x44];
const WHITE = [0xff, 0xff, 0xff];

// ── PNG ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgba is a Uint8ClampedArray of size w*h*4.
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline. Filter 0 (None) throughout — these are flat-colour
  // images, so deflate already finds the runs and a predictor buys nothing.
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ─────────────────────────────────────────────────────────────────
// Shapes are signed-distance tests sampled on a 4×4 grid per pixel. Supersampling rather
// than analytic coverage: at this size it is exact enough and it is twenty lines shorter.
const SS = 4;

// Distance from a point to a rounded rectangle, negative inside.
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function canvas(size) {
  return { size, px: new Uint8ClampedArray(size * size * 4) };
}

// Source-over composite of one shape, with `coverage` from the supersampled tests.
function fill(cv, [r, g, b], shape) {
  const { size, px } = cv;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          if (shape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS) < 0) hits += 1;
        }
      }
      if (hits === 0) continue;
      const a = hits / (SS * SS);
      const i = (y * size + x) * 4;
      const dst = px[i + 3] / 255;
      const out = a + dst * (1 - a);
      px[i] = (r * a + px[i] * dst * (1 - a)) / out;
      px[i + 1] = (g * a + px[i + 1] * dst * (1 - a)) / out;
      px[i + 2] = (b * a + px[i + 2] * dst * (1 - a)) / out;
      px[i + 3] = out * 255;
    }
  }
}

// The mark: five bars standing on a shared baseline, the centre one tallest and warm.
// Heights and the 3.5px-on-36px bar width are lifted from the .tile rule in components.css.
const BAR_HEIGHTS = [0.42, 0.78, 1, 0.58, 0.86];
const SPARK_INDEX = 2;

/**
 * @param size    canvas edge in px
 * @param inset   fraction of the canvas the mark is inset by — the maskable safe zone
 * @param bgRadius corner radius as a fraction of the canvas, 0.5 for a circle
 * @param bg      background colour, or null for transparent
 * @param barInk  colour of the four ordinary bars
 * @param sparkInk colour of the centre bar — the downbeat. Only a monochrome cut drops it.
 */
function drawMark({ size, inset, bgRadius, bg, barInk, sparkInk = SPARK }) {
  const cv = canvas(size);
  if (bg) fill(cv, bg, (x, y) => sdRoundRect(x, y, 0, 0, size, size, size * bgRadius));

  // The mark's own box, centred, after the inset.
  const box = size * (1 - inset * 2);
  const ox = size * inset;
  const oy = size * inset;

  // Five bars and four gaps across the box; the tile uses a ~3.5:2.5 bar-to-gap ratio.
  const unit = box / (5 * 3.5 + 4 * 2.5);
  const barW = unit * 3.5;
  const gap = unit * 2.5;
  const r = barW / 2;

  for (let i = 0; i < 5; i += 1) {
    const h = box * BAR_HEIGHTS[i];
    const x = ox + i * (barW + gap);
    const y = oy + (box - h);
    const ink = i === SPARK_INDEX ? sparkInk : barInk;
    fill(cv, ink, (px, py) => sdRoundRect(px, py, x, y, barW, h, r));
  }
  return cv;
}

function write(name, cv) {
  const file = join(OUT, name);
  writeFileSync(file, encodePng(cv.px, cv.size, cv.size));
  console.log(`  ✓ ${name}  ${cv.size}×${cv.size}`);
}

mkdirSync(OUT, { recursive: true });

// `any` icons are shown as drawn, so they carry their own rounded corners and their own
// margin — a launcher will not add either.
//
// The favicon is the mark in indigo on white; these invert it. A launcher icon is composited
// on a wallpaper or a white install sheet, where a white plate reads as no icon at all, so
// the whole app set is indigo-grounded and the mark carries in white.
write('icon-192.png', drawMark({ size: 192, inset: 0.24, bgRadius: 0.22, bg: INDIGO, barInk: WHITE }));
write('icon-512.png', drawMark({ size: 512, inset: 0.24, bgRadius: 0.22, bg: INDIGO, barInk: WHITE }));

// `maskable` icons are cropped to whatever silhouette the platform uses — down to a circle
// inscribed in the square. Everything that matters has to sit inside the middle 80%, and
// the background has to reach every corner or the crop shows a white wedge.
write('icon-maskable-192.png', drawMark({ size: 192, inset: 0.29, bgRadius: 0, bg: INDIGO, barInk: WHITE }));
write('icon-maskable-512.png', drawMark({ size: 512, inset: 0.29, bgRadius: 0, bg: INDIGO, barInk: WHITE }));

// iOS masks the touch icon itself and composites it on nothing, so it is square, opaque,
// and slightly tighter than the maskable pair.
write('apple-touch-icon.png', drawMark({ size: 180, inset: 0.24, bgRadius: 0, bg: INDIGO, barInk: WHITE }));

// The monochrome mark, for platforms that tint the icon themselves. The spark cannot
// survive a single-colour cut, so the downbeat is carried by height alone here.
write('icon-mono.png', drawMark({
  size: 512, inset: 0.22, bgRadius: 0, bg: null, barInk: [0, 0, 0], sparkInk: [0, 0, 0],
}));
