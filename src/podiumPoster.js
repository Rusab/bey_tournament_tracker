/*
 * A podium poster: one blader who finished on a tournament's podium, their
 * photo, the place, and the deck that got them there, drawn as a picture to
 * post. Three templates share the same parts:
 *
 *   classic    the photo on the left, the combos in a framed column beside it
 *   spotlight  the photo in the middle under the place written large, the
 *              combos as cards along the bottom
 *   split      the place and the name on the left over the combos, the photo
 *              on the right, cut by the X's red and green
 *
 * Like the ranking image, it is drawn straight onto a canvas, at a fixed
 * portrait size for social media, with nothing sent anywhere. The photo is
 * the organiser's own file and never leaves the browser.
 */

export const WIDTH = 1080, HEIGHT = 1350;

export const TEMPLATES = [
  { value: "classic", label: "Classic" },
  { value: "spotlight", label: "Spotlight" },
  { value: "split", label: "Split" },
];

/** The places a poster can be for, in podium order. */
export const PLACE_STYLE = {
  champion: { label: "Champion", color: "#FFC42E" },
  runnerUp: { label: "Runner-up", color: "#C9CED6" },
  third: { label: "3rd Place", color: "#D98C4F" },
  swiss: { label: "Swiss King", color: "#39E75F" },
};

const C = {
  base: "#060607", surface: "#0F1012", line: "#272A2F", ink: "#F3F4F6", muted: "#8B9098",
  red: "#FF2D44", green: "#39E75F",
};
const DISPLAY = '"Saira Condensed", "Barlow", sans-serif';
const BODY = '"Barlow", system-ui, sans-serif';

/* ---------------------------------------------------------------- pictures */

// Kept for the page's life: changing the template or moving the photo redraws
// without fetching every part picture again.
const pictures = new Map();
function loadImage(url, { cors = true } = {}) {
  if (!url) return Promise.resolve(null);
  if (!pictures.has(url)) {
    pictures.set(url, new Promise((resolve) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);   // a missing picture is drawn as its name
      // Its own address, so a copy the page already cached without CORS is not reused.
      img.src = cors ? url + (url.includes("?") ? "&" : "?") + "for=canvas" : url;
    }));
  }
  return pictures.get(url);
}

/** Whether a photo already has its background cut away (transparent round its edge). */
function isCutOut(img) {
  try {
    const n = 32, c = document.createElement("canvas");
    c.width = n; c.height = n;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data;
    let clear = 0, edge = 0;
    for (let i = 0; i < n; i++) {
      for (const [px, py] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]]) {
        edge++;
        if (d[(py * n + px) * 4 + 3] < 200) clear++;
      }
    }
    return clear / edge > 0.4;
  } catch (e) {
    return false;
  }
}

/*
 * The photo, fitted to its box by height and standing on the box's bottom
 * edge, then faded into the black: at the foot always, and at the sides too
 * when it still has its own background.
 */
function drawPhoto(ctx, photo, box) {
  if (!photo || !photo.img) return;
  const { img, zoom = 1, x: mx = 0, y: my = 0 } = photo;
  const oc = document.createElement("canvas");
  oc.width = Math.round(box.w); oc.height = Math.round(box.h);
  const o = oc.getContext("2d");
  const s = (box.h / img.height) * zoom;
  const iw = img.width * s, ih = img.height * s;
  const ix = (box.w - iw) / 2 + mx * box.w, iy = box.h - ih + my * box.h;
  o.drawImage(img, ix, iy, iw, ih);

  o.globalCompositeOperation = "destination-in";
  const down = o.createLinearGradient(0, 0, 0, box.h);
  down.addColorStop(0, "rgba(0,0,0,1)");
  down.addColorStop(box.fadeFrom || 0.72, "rgba(0,0,0,1)");
  down.addColorStop(1, "rgba(0,0,0,0)");
  o.fillStyle = down;
  o.fillRect(0, 0, box.w, box.h);
  if (!isCutOut(img)) {
    // Its own background: an oval vignette over the part of the photo that
    // shows, so no straight edge of it shows against the glow and honeycomb.
    const left = Math.max(0, ix), right = Math.min(box.w, ix + iw);
    const top = Math.max(0, iy), bottom = Math.min(box.h, iy + ih);
    const rx = (right - left) / 2, ry = ((bottom - top) / 2) * 1.12;
    const cx = (left + right) / 2, cy = top + (bottom - top) * 0.48;
    o.save();
    o.translate(cx, cy);
    o.scale(1, ry / rx);
    const oval = o.createRadialGradient(0, 0, 0, 0, 0, rx);
    oval.addColorStop(0, "rgba(0,0,0,1)");
    oval.addColorStop(0.62, "rgba(0,0,0,1)");
    oval.addColorStop(1, "rgba(0,0,0,0)");
    o.fillStyle = oval;
    o.fillRect(-cx, -cy * (rx / ry), box.w, box.h * (rx / ry));
    o.restore();
  }
  ctx.drawImage(oc, box.x, box.y);
}

/** A part picture fitted into a square; a missing one becomes a ring with its initials. */
function drawPart(ctx, img, name, x, y, size) {
  if (img) {
    const s = Math.min(size / img.width, size / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
    return;
  }
  ctx.save();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = C.muted;
  ctx.font = `700 ${Math.round(size * 0.28)}px ${DISPLAY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(name || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase(), x + size / 2, y + size / 2);
  ctx.restore();
}

/** A combo's parts side by side, as large as fits; returns how wide they came out. */
function drawParts(ctx, combo, x, y, size, maxW, align = "left") {
  const n = combo.parts.length;
  if (!n) return 0;
  const gap = size * 0.12;
  const s = Math.min(size, (maxW - gap * (n - 1)) / n);
  const total = n * s + (n - 1) * gap;
  let at = align === "center" ? x + (maxW - total) / 2 : x;
  combo.parts.forEach((p) => {
    drawPart(ctx, p.img, p.name, at, y + (size - s) / 2, s);
    at += s + gap;
  });
  return total;
}

/* -------------------------------------------------------------------- text */

function setFont(ctx, weight, size, family = DISPLAY, spacing = 0) {
  ctx.font = `${weight} ${Math.round(size)}px ${family}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${spacing}px`;
}

/** The largest size, down to `min`, at which the text fits `max` wide. */
function fitSize(ctx, text, weight, size, max, min, family = DISPLAY, spacing = 0) {
  let s = size;
  setFont(ctx, weight, s, family, spacing);
  while (s > min && ctx.measureText(text).width > max) {
    s -= 2;
    setFont(ctx, weight, s, family, spacing);
  }
  return s;
}

/** Text cut to fit, with an ellipsis. */
function clip(ctx, text, max) {
  const s = String(text);
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

/** Up to `lines` lines within `max` wide, the last one cut short if it must be. */
function wrap(ctx, text, max, lines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  words.forEach((w) => {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max || !cur) cur = next;
    else { out.push(cur); cur = w; }
  });
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = clip(ctx, out.slice(lines - 1).join(" "), max);
    return kept;
  }
  return out;
}

/* -------------------------------------------------------------- the ground */

/** Flat-topped hexagons, faint, as the app's own honeycomb. */
function honeycomb(ctx, alpha, box = { x: 0, y: 0, w: WIDTH, h: HEIGHT }) {
  const s = 34, h = s * Math.sqrt(3);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 1.5;
  for (let col = -1; col * s * 1.5 < box.w + s * 2; col++) {
    for (let row = -1; row * h < box.h + h; row++) {
      const cx = box.x + col * s * 1.5, cy = box.y + row * h + (col % 2 ? h / 2 : 0);
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        const px = cx + s * Math.cos(a), py = cy + s * Math.sin(a);
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

function glow(ctx, x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color + Math.round(alpha * 255).toString(16).padStart(2, "0"));
  g.addColorStop(1, color + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawLogo(ctx, logo, x, y, h, align = "left") {
  if (!logo) return;
  const w = (logo.width / logo.height) * h;
  ctx.drawImage(logo, align === "center" ? x - w / 2 : align === "right" ? x - w : x, y, w, h);
}

/* --------------------------------------------------------------- templates */

function classic(ctx, spec, place, combos, photo, logo) {
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  glow(ctx, 300, 700, 700, "#2A2D33", 0.9);
  glow(ctx, 260, 1100, 420, place.color, 0.12);

  drawPhoto(ctx, photo, { x: 0, y: 240, w: 640, h: 930 });

  // Which tournament, top left.
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = C.ink;
  fitSize(ctx, spec.tournament.toUpperCase(), 700, 40, 470, 24, DISPLAY, 2);
  ctx.fillText(spec.tournament.toUpperCase(), 70, 132);
  ctx.fillStyle = C.muted;
  setFont(ctx, 600, 24, BODY, 4);
  ctx.fillText(spec.kind.toUpperCase(), 70, 172);

  // The deck, framed on the right.
  ctx.fillStyle = C.ink;
  setFont(ctx, 800, 58, DISPLAY, 2);
  ctx.fillText("WINNING", 640, 112);
  ctx.fillText(combos.length > 1 ? "COMBOS" : "COMBO", 640, 170);

  const top = 230, bottom = 1140, left = 600, cut = 60;
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(WIDTH + 10, top); ctx.lineTo(left + cut, top); ctx.lineTo(left, top + cut);
  ctx.lineTo(left, bottom - cut); ctx.lineTo(left + cut, bottom); ctx.lineTo(WIDTH + 10, bottom);
  ctx.stroke();

  const n = Math.max(combos.length, 1);
  const rowH = (bottom - top - 40) / n;
  const pic = Math.min(170, rowH * 0.5);
  combos.forEach((c, i) => {
    const y0 = top + 30 + i * rowH;
    drawParts(ctx, c, 660, y0 + rowH * 0.06, pic, 360, "left");
    ctx.fillStyle = C.ink;
    const nameY = y0 + rowH * 0.06 + pic + 58;
    fitSize(ctx, c.name.toUpperCase(), 600, 32, 360, 18, BODY, 2);
    ctx.fillText(clip(ctx, c.name.toUpperCase(), 360), 660, nameY);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillRect(660, nameY + 26, 360, 2);
  });
  if (!combos.length) {
    ctx.fillStyle = C.muted;
    setFont(ctx, 500, 28, BODY);
    ctx.fillText("No deck on record", 660, top + 120);
  }

  // The place and the blader, bottom left.
  ctx.fillStyle = C.ink;
  fitSize(ctx, place.label, 800, 104, 520, 60, BODY);
  ctx.fillText(place.label, 70, 1010);
  ctx.fillStyle = place.color;
  ctx.fillRect(70, 1034, 470, 8);
  ctx.fillStyle = C.ink;
  fitSize(ctx, spec.name.toUpperCase(), 800, 150, 520, 56, DISPLAY);
  ctx.fillText(spec.name.toUpperCase(), 66, 1170);
  if (spec.members) {
    ctx.fillStyle = C.muted;
    setFont(ctx, 500, 26, BODY);
    ctx.fillText(clip(ctx, spec.members, 520), 70, 1206);
  }

  // The foot.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillRect(0, 1232, WIDTH, 2);
  drawLogo(ctx, logo, 58, 1250, 82);
  ctx.textAlign = "right";
  ctx.fillStyle = C.muted;
  setFont(ctx, 500, 24, BODY, 2);
  ctx.fillText(spec.site, WIDTH - 70, 1305);
}

function spotlight(ctx, spec, place, combos, photo, logo) {
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  honeycomb(ctx, 0.05);
  glow(ctx, WIDTH / 2, 620, 620, place.color, 0.3);
  glow(ctx, WIDTH / 2, 1350, 600, C.base, 1);

  drawLogo(ctx, logo, WIDTH / 2, 40, 74, "center");

  // The place, written large behind the photo.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const big = place.label.toUpperCase();
  fitSize(ctx, big, 800, 250, 1020, 120, DISPLAY);
  ctx.lineWidth = 3;
  ctx.strokeStyle = place.color + "88";
  ctx.strokeText(big, WIDTH / 2, 420);
  ctx.fillStyle = place.color + "1F";
  ctx.fillText(big, WIDTH / 2, 420);

  drawPhoto(ctx, photo, { x: 140, y: 190, w: 800, h: 790, fadeFrom: 0.68 });

  ctx.fillStyle = place.color;
  setFont(ctx, 700, 34, BODY, 8);
  ctx.fillText(place.label.toUpperCase(), WIDTH / 2, 896);
  ctx.fillStyle = C.ink;
  fitSize(ctx, spec.name.toUpperCase(), 800, 120, 980, 50, DISPLAY);
  ctx.fillText(spec.name.toUpperCase(), WIDTH / 2, 1000);
  ctx.fillStyle = C.muted;
  setFont(ctx, 600, 24, BODY, 3);
  const line = `${spec.tournament}  ·  ${spec.kind}`.toUpperCase();
  ctx.fillText(clip(ctx, line, 980), WIDTH / 2, 1042);

  // The combos, a card each.
  const n = Math.max(combos.length, 1), gap = 18, x0 = 50;
  const cw = (WIDTH - x0 * 2 - gap * (n - 1)) / n, top = 1072, ch = 230;
  combos.forEach((c, i) => {
    const x = x0 + i * (cw + gap);
    ctx.fillStyle = C.surface;
    ctx.fillRect(x, top, cw, ch);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, top + 1, cw - 2, ch - 2);
    ctx.fillStyle = place.color;
    ctx.fillRect(x, top, cw, 5);
    drawParts(ctx, c, x + 16, top + 22, Math.min(104, cw * 0.4), cw - 32, "center");
    ctx.fillStyle = C.ink;
    setFont(ctx, 600, 22, BODY, 1);
    ctx.textAlign = "center";
    wrap(ctx, c.name.toUpperCase(), cw - 28, 2).forEach((l, k) => ctx.fillText(l, x + cw / 2, top + 168 + k * 28));
  });
  if (!combos.length) {
    ctx.fillStyle = C.muted;
    setFont(ctx, 500, 28, BODY);
    ctx.fillText("No deck on record", WIDTH / 2, top + 120);
  }

  ctx.fillStyle = C.muted;
  setFont(ctx, 500, 20, BODY, 3);
  ctx.fillText(spec.site.toUpperCase(), WIDTH / 2, 1334);
}

function split(ctx, spec, place, combos, photo, logo) {
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  honeycomb(ctx, 0.04);

  // The X's two strokes, slanting through behind the photo.
  ctx.save();
  ctx.globalAlpha = 0.9;
  [[C.red, 0], [C.green, 70]].forEach(([col, off]) => {
    const g = ctx.createLinearGradient(0, HEIGHT, WIDTH, 0);
    g.addColorStop(0, col + "00");
    g.addColorStop(0.5, col + "55");
    g.addColorStop(1, col + "00");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(420 + off, HEIGHT); ctx.lineTo(470 + off, HEIGHT);
    ctx.lineTo(1080 + off, 120); ctx.lineTo(1030 + off, 120);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();
  glow(ctx, 820, 760, 520, place.color, 0.18);

  drawPhoto(ctx, photo, { x: 400, y: 170, w: 680, h: 1180, fadeFrom: 0.8 });

  drawLogo(ctx, logo, 56, 50, 66);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = place.color;
  fitSize(ctx, place.label.toUpperCase(), 800, 128, 600, 60, DISPLAY);
  ctx.fillText(place.label.toUpperCase(), 56, 280);
  ctx.fillStyle = C.ink;
  fitSize(ctx, spec.name.toUpperCase(), 800, 92, 600, 44, DISPLAY);
  ctx.fillText(spec.name.toUpperCase(), 56, 372);
  ctx.fillStyle = C.muted;
  setFont(ctx, 600, 24, BODY, 3);
  ctx.fillText(clip(ctx, spec.tournament.toUpperCase(), 580), 58, 418);
  ctx.fillText(clip(ctx, spec.kind.toUpperCase(), 580), 58, 452);

  // The deck, stacked down the left.
  const n = Math.max(combos.length, 1), top = 500, bottom = 1260, gap = 16;
  const ch = (bottom - top - gap * (n - 1)) / n, cw = 520;
  combos.forEach((c, i) => {
    const y = top + i * (ch + gap);
    ctx.fillStyle = "rgba(15,16,18,0.88)";
    ctx.fillRect(56, y, cw, ch);
    ctx.fillStyle = i % 2 ? C.green : C.red;
    ctx.fillRect(56, y, 6, ch);
    const pic = Math.min(ch * 0.58, 120);
    drawParts(ctx, c, 84, y + 16, pic, cw - 50, "left");
    ctx.fillStyle = C.ink;
    fitSize(ctx, c.name.toUpperCase(), 600, 28, cw - 50, 16, BODY, 1);
    ctx.fillText(clip(ctx, c.name.toUpperCase(), cw - 50), 84, y + 16 + pic + 40);
  });
  if (!combos.length) {
    ctx.fillStyle = C.muted;
    setFont(ctx, 500, 28, BODY);
    ctx.fillText("No deck on record", 60, top + 60);
  }

  ctx.fillStyle = C.muted;
  setFont(ctx, 500, 22, BODY, 3);
  ctx.fillText(spec.site.toUpperCase(), 58, 1316);
}

const DRAW = { classic, spotlight, split };

/* -------------------------------------------------------------- the poster */

/**
 * spec: {
 *   place: "champion" | "runnerUp" | "third" | "swiss",
 *   name, members (a tag team's bladers, or null),
 *   tournament, kind ("Ranked tournament" / "Casual tournament"),
 *   combos: [{ name, parts: [{ name, url }] }],
 *   logoUrl, site,
 * }
 * photo: { img, zoom, x, y } or null. Resolves to a PNG blob.
 */
export async function renderPodiumPoster(spec, template, photo) {
  try {
    await Promise.all([
      document.fonts.load(`800 120px ${DISPLAY}`), document.fonts.load(`700 40px ${DISPLAY}`),
      document.fonts.load(`500 28px ${BODY}`), document.fonts.load(`600 28px ${BODY}`),
      document.fonts.load(`800 100px ${BODY}`),
    ]);
  } catch (e) { /* draws in fallback fonts */ }

  const [logo, combos] = await Promise.all([
    // A logo on another site (the tournament's, in storage) needs CORS, or the poster
    // could not be saved; one drawn here (a data address) cannot take it.
    loadImage(spec.logoUrl, { cors: /^https?:/.test(spec.logoUrl || "") }),
    Promise.all((spec.combos || []).map(async (c) => ({
      name: c.name,
      parts: await Promise.all(c.parts.map(async (p) => ({ name: p.name, img: await loadImage(p.url) }))),
    }))),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  const place = PLACE_STYLE[spec.place] || PLACE_STYLE.champion;
  (DRAW[template] || classic)(ctx, spec, place, combos, photo, logo);

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The poster could not be made."))), "image/png");
    } catch (e) {
      reject(new Error("A part picture would not load for drawing. Try again in a moment."));
    }
  });
}
