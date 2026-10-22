/*
 * A ranking drawn as a picture to post: the tournament's own background and
 * logo, its name, and the whole table.
 *
 * Drawn straight onto a canvas rather than photographed from the page, so it
 * comes out the same on every phone, at a fixed social-media width, with no
 * library to load and nothing sent anywhere. Uploaded images are fetched
 * with CORS (Supabase storage allows it), or the canvas could not be saved.
 */

const C = {
  base: "#0B0718", surface: "#170F2E", line: "#382559", ink: "#F3EDFF", muted: "#9C8CC4",
  magenta: "#FF2D8A", cyan: "#29D3FF", gold: "#FFC42E",
};
const PODIUM = { 1: C.gold, 2: "#C9CED6", 3: "#C87941" };
const DISPLAY = '"Saira Condensed", "Barlow", sans-serif';
const BODY = '"Barlow", system-ui, sans-serif';

export const WIDTH = 1080;
const PAD = 64;
const HEAD = 380;   // everything above the table
const FOOT = 150;   // everything below it

/*
 * How tall the picture is and how tall each row. A post is 1080 wide and
 * between square and 4:5 (1080 to 1350 tall); a story is 1080 x 1920. A short
 * table gets a post at full row height. A longer one squeezes its rows to
 * stay a post, then becomes a story, and only past that grows taller still -
 * the whole table always fits, however many bladers there are.
 */
export function layoutFor(rows) {
  const n = Math.max(1, rows);
  const need = (rowH) => HEAD + FOOT + n * rowH;
  if (need(64) <= 1350) return { width: WIDTH, height: Math.max(1080, need(64)), rowH: 64 };
  const postRow = Math.floor((1350 - HEAD - FOOT) / n);
  if (postRow >= 46) return { width: WIDTH, height: 1350, rowH: postRow };
  const storyRow = Math.min(64, Math.floor((1920 - HEAD - FOOT) / n));
  if (storyRow >= 40) return { width: WIDTH, height: 1920, rowH: storyRow };
  return { width: WIDTH, height: need(40), rowH: 40 };
}

function loadImage(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);   // a missing picture leaves the plain background
    // Its own address, so a copy the page already cached without CORS is not reused.
    img.src = url + (url.includes("?") ? "&" : "?") + "for=canvas";
  });
}

/** Text cut to fit, with an ellipsis. */
function fit(ctx, text, max) {
  const s = String(text);
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

function cover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * spec: {
 *   title, heading ("Final standings"), meta (a line under it),
 *   bgUrl, logoUrl,
 *   columns: [{ label, width }]   - the number columns, after rank and name
 *   rows: [{ rank, name, cells: [...] }],
 *   note (a line above the footer), site
 * }
 * Resolves to a PNG blob.
 */
export async function renderRankingImage(spec, { withImages = true } = {}) {
  try {
    await Promise.all([
      document.fonts.load(`800 80px ${DISPLAY}`), document.fonts.load(`700 30px ${DISPLAY}`),
      document.fonts.load(`500 28px ${BODY}`), document.fonts.load(`600 28px ${BODY}`),
    ]);
  } catch (e) { /* draws in fallback fonts */ }

  const [bg, logo] = withImages
    ? await Promise.all([loadImage(spec.bgUrl), loadImage(spec.logoUrl)])
    : [null, null];

  const rows = spec.rows || [];
  const { width: W, height: H, rowH } = layoutFor(rows.length);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // ---- the ground: their background, veiled dark, lit from the corners
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, W, H);
  if (bg) {
    cover(ctx, bg, W, H);
    ctx.fillStyle = "rgba(11, 7, 24, 0.84)";
    ctx.fillRect(0, 0, W, H);
  }
  [[0, 0, C.magenta], [W, 0, C.cyan]].forEach(([x, y, col]) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, W * 0.9);
    g.addColorStop(0, col + "33");
    g.addColorStop(1, col + "00");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

  // ---- the header: logo, the label, the name, what this is
  let textX = PAD;
  if (logo) {
    const box = 150;
    const s = Math.min(box / logo.width, box / logo.height);
    const lw = logo.width * s, lh = logo.height * s;
    ctx.drawImage(logo, PAD + (box - lw) / 2, 70 + (box - lh) / 2, lw, lh);
    textX = PAD + box + 34;
  }
  const textW = W - PAD - textX;

  ctx.save();
  ctx.translate(textX, 92);
  ctx.transform(1, 0, -0.5, 1, 0, 0);
  ctx.fillStyle = C.magenta;
  ctx.fillRect(0, 0, 44, 6);
  ctx.restore();
  ctx.fillStyle = C.cyan;
  ctx.font = `700 26px ${DISPLAY}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("BEYBLADE X", textX + 58, 101);

  let size = 84;
  ctx.font = `800 ${size}px ${DISPLAY}`;
  while (size > 44 && ctx.measureText(spec.title).width > textW) {
    size -= 2;
    ctx.font = `800 ${size}px ${DISPLAY}`;
  }
  const title = fit(ctx, spec.title, textW);
  const tw = Math.min(ctx.measureText(title).width, textW);
  const grad = ctx.createLinearGradient(textX, 0, textX + tw, 0);
  grad.addColorStop(0, C.magenta);
  grad.addColorStop(0.55, "#FFFFFF");
  grad.addColorStop(1, C.cyan);
  ctx.fillStyle = grad;
  ctx.fillText(title, textX, 186);

  ctx.font = `700 34px ${DISPLAY}`;
  ctx.fillStyle = C.gold;
  ctx.fillText(fit(ctx, String(spec.heading || "").toUpperCase(), textW), textX, 238);
  if (spec.meta) {
    ctx.font = `500 24px ${BODY}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, spec.meta, textW), textX, 276);
  }

  // ---- the table
  const cols = spec.columns || [];
  const numW = cols.reduce((a, c) => a + c.width, 0);
  const rankX = PAD + 40, nameX = PAD + 96, nameW = W - PAD * 2 - 96 - numW - 16;
  const colX = [];
  let x = W - PAD;
  for (let i = cols.length - 1; i >= 0; i--) { colX[i] = x; x -= cols[i].width; }

  const panelTop = HEAD - 84, panelBottom = HEAD + rows.length * rowH + 14;
  ctx.fillStyle = "rgba(11, 7, 24, 0.86)";
  ctx.fillRect(PAD - 18, panelTop, W - (PAD - 18) * 2, panelBottom - panelTop);

  let y = HEAD - 40;
  ctx.font = `600 22px ${BODY}`;
  ctx.fillStyle = C.muted;
  ctx.textAlign = "left";
  ctx.fillText("BLADER", nameX, y);
  ctx.textAlign = "right";
  cols.forEach((c, i) => ctx.fillText(c.label.toUpperCase(), colX[i] - 14, y));
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, y + 16, W - PAD * 2, 2);

  y = HEAD;
  const big = Math.round(rowH * 0.5);
  rows.forEach((r, i) => {
    const top = y + i * rowH;
    const mid = top + rowH / 2;
    const podium = PODIUM[r.rank];

    ctx.fillStyle = i % 2 ? "rgba(23, 15, 46, 0.9)" : "rgba(33, 22, 63, 0.9)";
    ctx.fillRect(PAD, top + 2, W - PAD * 2, rowH - 4);
    if (podium) {
      ctx.fillStyle = podium;
      ctx.fillRect(PAD, top + 2, 6, rowH - 4);
    }

    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.font = `800 ${big}px ${DISPLAY}`;
    ctx.fillStyle = podium || C.muted;
    ctx.fillText(String(r.rank), rankX, mid);

    ctx.textAlign = "left";
    ctx.font = `${podium ? 700 : 500} ${Math.round(rowH * 0.42)}px ${BODY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(fit(ctx, r.name, nameW), nameX, mid);

    ctx.textAlign = "right";
    (r.cells || []).forEach((v, ci) => {
      ctx.font = ci === 0 ? `800 ${big}px ${DISPLAY}` : `500 ${Math.round(rowH * 0.38)}px ${BODY}`;
      ctx.fillStyle = ci === 0 ? C.cyan : C.ink;
      ctx.fillText(String(v), colX[ci] - 14, mid);
    });
  });

  // ---- the foot
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const footY = H - 56;
  if (spec.note) {
    ctx.font = `600 26px ${BODY}`;
    ctx.fillStyle = C.gold;
    ctx.fillText(fit(ctx, spec.note, W - PAD * 2), PAD, footY - 46);
  }
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, footY - 26, W - PAD * 2, 2);
  ctx.font = `500 22px ${BODY}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(spec.site || "", PAD, footY + 6);
  ctx.textAlign = "right";
  ctx.font = `700 24px ${DISPLAY}`;
  ctx.fillStyle = C.magenta;
  ctx.fillText("BEYBLADE X TOURNAMENTS", W - PAD, footY + 6);

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be made."))), "image/png");
    } catch (e) {
      // A picture the browser would not let us read taints the canvas; draw again without them.
      if (withImages) renderRankingImage(spec, { withImages: false }).then(resolve, reject);
      else reject(e);
    }
  });
}
