/**
 * Builds a shareable QR code for your copy of the app, light and dark.
 *
 *   node scripts/make-qr.mjs https://your-site.workers.dev
 *   node scripts/make-qr.mjs https://your-site.workers.dev path/to/logo.png
 *
 * The logo is optional: a file, or an image's web address. Writes
 * qr-light and qr-dark (SVG and PNG) in the project folder; they are not
 * committed. Check they scan with scripts/check-qr.mjs.
 *
 * Error correction is level H (30% recoverable), which is what lets a logo sit
 * in the middle: the cleared area is only ~7% of the modules, well inside what
 * H can reconstruct, so the code still scans with the centre covered.
 */
import QRCode from "qrcode";
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const [URL_TO_ENCODE, LOGO_SOURCE] = process.argv.slice(2);
if (!URL_TO_ENCODE) {
  console.error("usage: node scripts/make-qr.mjs <your-site-address> [logo file or address]");
  process.exit(2);
}

const QUIET = 4;          // modules of margin — below 4 and scanners struggle
const LOGO_SPAN = 0.26;   // logo width as a fraction of the code

/**
 * Scanning is a contrast problem, not a colour one. The app's own #FF2D8A and
 * #29D3FF are bright: against near-black they are 6:1 and 10:1, comfortably
 * readable, but against white they fall to 2.6:1 and 1.7:1 and decoders start
 * failing. The light sheet therefore uses deepened versions of the same hues.
 */
const THEMES = {
  light: {
    bg: "#FFFFFF", plate: "#FFFFFF", plateEdge: "#00000014",
    from: "#B3005E", to: "#005E7A",
  },
  dark: {
    bg: "#0B0718", plate: "#0B0718", plateEdge: "#FFFFFF1F",
    from: "#FF2D8A", to: "#29D3FF",
  },
};

/**
 * The logo may be WebP, which SVG rasterisers handle inconsistently, so it is
 * converted to PNG before being embedded.
 */
async function fetchLogo(source) {
  let raw;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`logo fetch failed: ${res.status}`);
    raw = Buffer.from(await res.arrayBuffer());
  } else {
    raw = readFileSync(source);
  }
  const png = await sharp(raw).resize(512, 512, { fit: "inside" }).png().toBuffer();
  return { dataUri: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length };
}

function buildSVG(qr, logoUri, theme) {
  const n = qr.modules.size;
  const bits = qr.modules.data;
  const total = n + QUIET * 2;
  const t = THEMES[theme];

  const dark = (x, y) => bits[y * n + x] === 1;

  // The three corner eyes are drawn as one shape each, not module by module.
  const inFinder = (x, y) =>
    (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

  // Cleared square in the middle, where the logo goes.
  const span = Math.round(n * LOGO_SPAN);
  const from = Math.floor((n - span) / 2);
  const to = from + span;
  const inLogo = (x, y) => !!logoUri && x >= from - 1 && x < to + 1 && y >= from - 1 && y < to + 1;

  const parts = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!dark(x, y) || inFinder(x, y) || inLogo(x, y)) continue;
      parts.push(`<rect x="${x + QUIET}" y="${y + QUIET}" width="1" height="1" rx=".28"/>`);
    }
  }

  // Eye: 7x7 ring, 5x5 hole, 3x3 pupil.
  const eye = (ox, oy) => `
    <rect x="${ox + QUIET}" y="${oy + QUIET}" width="7" height="7" rx="2"/>
    <rect x="${ox + QUIET + 1}" y="${oy + QUIET + 1}" width="5" height="5" rx="1.4" fill="${t.bg}"/>
    <rect x="${ox + QUIET + 2}" y="${oy + QUIET + 2}" width="3" height="3" rx=".9"/>`;

  const logoBox = span + 2;
  const logoAt = from + QUIET - 1;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * 40}" height="${total * 40}" viewBox="0 0 ${total} ${total}" shape-rendering="geometricPrecision">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.from}"/>
      <stop offset="1" stop-color="${t.to}"/>
    </linearGradient>
    <clipPath id="logoClip">
      <rect x="${logoAt}" y="${logoAt}" width="${logoBox}" height="${logoBox}" rx="1.6"/>
    </clipPath>
  </defs>
  <rect width="${total}" height="${total}" fill="${t.bg}"/>
  <g fill="url(#g)">
${parts.join("\n")}
${eye(0, 0)}${eye(n - 7, 0)}${eye(0, n - 7)}
  </g>
${logoUri ? `  <rect x="${logoAt}" y="${logoAt}" width="${logoBox}" height="${logoBox}" rx="1.6" fill="${t.plate}" stroke="${t.plateEdge}" stroke-width=".12"/>
  <image href="${logoUri}" x="${logoAt}" y="${logoAt}" width="${logoBox}" height="${logoBox}"
         preserveAspectRatio="xMidYMid meet" clip-path="url(#logoClip)"/>` : ""}
</svg>`;
}

const logo = LOGO_SOURCE ? await fetchLogo(LOGO_SOURCE) : null;
const qr = QRCode.create(URL_TO_ENCODE, { errorCorrectionLevel: "H" });

console.log(`url        ${URL_TO_ENCODE}`);
console.log(`version    ${qr.version} (${qr.modules.size}x${qr.modules.size} modules)`);
console.log(logo ? `logo       ${(logo.bytes / 1024).toFixed(1)}KB embedded` : "logo       none");

const PNG_PX = 1400; // plenty for print at poster size

for (const theme of Object.keys(THEMES)) {
  const svg = buildSVG(qr, logo && logo.dataUri, theme);
  writeFileSync(join(ROOT, `qr-${theme}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 300 })
    .resize(PNG_PX, PNG_PX)
    .png()
    .toFile(join(ROOT, `qr-${theme}.png`));
  console.log(`wrote      qr-${theme}.svg + qr-${theme}.png (${PNG_PX}px)`);
}
