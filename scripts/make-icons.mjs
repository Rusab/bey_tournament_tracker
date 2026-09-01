/**
 * Generates the PWA icons in public/ — no image library needed, just zlib.
 * Run with: node scripts/make-icons.mjs
 *
 * The mark is the app's own motif: a skewed magenta/cyan X on the arena
 * background, so the home-screen icon matches the header.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/* ---- minimal PNG encoder ---- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- drawing ---- */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Distance from point to a line segment, all in normalized 0..1 space. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const tt = clamp(len2 ? (wx * vx + wy * vy) / len2 : 0, 0, 1);
  const dx = px - (ax + tt * vx), dy = py - (ay + tt * vy);
  return Math.hypot(dx, dy);
}

/** src over dst, both [r,g,b] 0-255, alpha 0-1. */
function over(dst, src, a) {
  dst[0] += (src[0] - dst[0]) * a;
  dst[1] += (src[1] - dst[1]) * a;
  dst[2] += (src[2] - dst[2]) * a;
}

const BASE = [0x0b, 0x07, 0x18];
const MAGENTA = [0xff, 0x2d, 0x8a];
const CYAN = [0x29, 0xd3, 0xff];

/**
 * @param size    pixel dimensions
 * @param extent  half-length of the X arms, normalized — smaller keeps the
 *                mark inside a maskable icon's safe zone.
 */
function drawIcon(size, extent) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = extent;
  const thick = extent * 0.44;
  const skew = 0.055; // matches the app's skewX(-9deg) slant

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      const px = [...BASE];

      // corner glows, same as the app's arena background
      const dTL = Math.hypot(u, v), dTR = Math.hypot(1 - u, v);
      over(px, MAGENTA, clamp(1 - dTL / 0.95, 0, 1) * 0.17);
      over(px, CYAN, clamp(1 - dTR / 0.95, 0, 1) * 0.15);

      // two crossing blades
      const d1 = segDist(u, v, 0.5 - half + skew, 0.5 - half, 0.5 + half - skew, 0.5 + half);
      const d2 = segDist(u, v, 0.5 + half + skew, 0.5 - half, 0.5 - half - skew, 0.5 + half);
      const aa = 1.2 / size; // ~1px feather
      over(px, MAGENTA, clamp((thick - d1) / aa, 0, 1));
      over(px, CYAN, clamp((thick - d2) / aa, 0, 1));

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(px[0]);
      rgba[i + 1] = Math.round(px[1]);
      rgba[i + 2] = Math.round(px[2]);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, rgba);
}

mkdirSync(OUT, { recursive: true });

const files = [
  ["icon-192.png", 192, 0.25],
  ["icon-512.png", 512, 0.25],
  ["icon-maskable-512.png", 512, 0.185], // art inside the 80% safe zone
  ["apple-touch-icon.png", 180, 0.25],
  ["favicon-32.png", 32, 0.27],
];

for (const [name, size, extent] of files) {
  writeFileSync(join(OUT, name), drawIcon(size, extent));
  console.log("wrote", name, `(${size}x${size})`);
}
