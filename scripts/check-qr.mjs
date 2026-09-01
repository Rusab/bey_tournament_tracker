/**
 * Proves the generated codes still scan with a logo sitting over the middle.
 * Run with: node scripts/check-qr.mjs
 *
 * Each code is decoded at several pixel sizes, which stands in for how small it
 * can be printed, or how far away a phone can be, before it stops reading.
 */
import sharp from "sharp";
import jsQR from "jsqr";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = "https://bey-tournament-tracker.rusabsarmun.workers.dev";
const SIZES = [1400, 800, 500, 300, 200, 140, 100];

async function decodeAt(file, px) {
  const { data } = await sharp(join(ROOT, file))
    .flatten({ background: "#ffffff" })   // a camera sees it on paper, not on alpha
    .resize(px, px)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const got = jsQR(new Uint8ClampedArray(data), px, px);
  return got ? got.data : null;
}

let failures = 0;
for (const file of ["qr-light.png", "qr-dark.png"]) {
  const row = [];
  for (const px of SIZES) {
    const got = await decodeAt(file, px);
    const ok = got === EXPECTED;
    if (!ok && px >= 200) failures++; // below 200px is beyond a fair ask
    row.push(`${px}:${ok ? "OK" : got ? "WRONG" : "--"}`);
  }
  console.log(file.padEnd(14), row.join("  "));
}

console.log(failures === 0
  ? "\nAll codes read back the correct URL at every realistic size."
  : `\n${failures} failure(s) at sizes that matter — do not ship.`);
process.exit(failures === 0 ? 0 : 1);
