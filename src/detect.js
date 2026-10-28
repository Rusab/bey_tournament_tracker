/*
 * Deck photo detection, all in the browser.
 *
 *   1. findBeys: each bey is found as a circle, on any background - a
 *      table, a mat, the slots of a deck case. Its size is then chosen by
 *      trying a few crops and keeping the one the model matches best.
 *   2. embed: each bey's square crop goes through DINOv2-small and comes
 *      out as 768 numbers (the class token and the average of the patch
 *      tokens, each scaled to length 1). Similar-looking blades give
 *      similar numbers.
 *   3. The database compares those numbers with stored references of
 *      every blade (match_parts) and names the closest.
 *
 * The model (24MB) downloads from this site the first time and is kept
 * by the browser after that. Nothing here runs until a scan is started.
 */

// onnx-community/dinov2-small, served from this site (public/models).
const MODEL_ID = "dinov2-small";
/** Stored with every reference; change it if the numbers ever change meaning. */
export const DETECT_MODEL = "dinov2-small-q8-v1";
export const DETECT_SIZE = 224;
/** A crop is this much wider than the bey, so its whole edge is in view. */
export const CROP_MARGIN = 1.15;
/** The blade kinds a top-down photo shows, and where each goes in a combo. */
export const DETECT_KINDS = {
  blade: { type: "bx", slot: "blade" },
  infinity_blade: { type: "inf", slot: "blade" },
  main_blade: { type: "cx", slot: "main" },
  metal_blade: { type: "cxi", slot: "main" },
};
/**
 * Whether the best match is clear enough to pick for the blader: close
 * enough, and clearly ahead of the next blade. In tests on catalogue
 * pictures a right answer scored about 0.9, with the next blade often
 * only 0.04 behind - so the lead matters more than the score.
 */
export const SURE_ENOUGH = 0.6;
export const CLEAR_LEAD = 0.03;
export const isSure = (matches) => !!(matches && matches[0] && matches[0].similarity >= SURE_ENOUGH
  && (!matches[1] || matches[0].similarity - matches[1].similarity >= CLEAR_LEAD));

/* ----------------------------------------------------------- finding beys */

/*
 * A bey seen from above is a circle, whatever it sits on - a table, a mat,
 * the slots of a deck case. So beys are found as circles: every edge in the
 * photo votes for the centres of the circles it could lie on (a Hough
 * transform), and the strongest centres are the candidates. A deck's beys
 * are all about the same size in one photo, which picks the right circles
 * out from the rest: a case's corners, a sleeve's checks, the small round
 * chip in the middle of each bey.
 */

/** A 3×3 box blur. */
function box(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { s += src[yy * w + xx]; n++; }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}
const blur = (src, w, h) => box(box(src, w, h), w, h);

/**
 * Circles in RGBA pixels, strongest first: { cx, cy, r, score }. score is
 * roughly the share of the circle's edge that the photo backs up.
 */
export function findCirclesIn(px, w, h) {
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const g = blur(gray, w, h);

  // Edges, and which way each one faces.
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      gx[i] = c + 2 * f + r - a - 2 * d - p;
      gy[i] = p + 2 * q + r - a - 2 * b - c;
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  // A share of the strongest edges, not a fixed share of all pixels: a
  // checked cloth is nearly all edges, and would push a silver blade's softer
  // outline out. Edges that are not round never pile up on one centre.
  const cut = Math.max(16, 0.2 * sorted[Math.floor(n * 0.98)]);

  // Votes, one plane per radius. An edge votes on both sides of itself:
  // a bey can be lighter or darker than what is around it.
  const m = Math.min(w, h);
  const rMin = Math.max(4, Math.round(m * 0.06)), rMax = Math.round(m * 0.34);
  const step = Math.max(1, Math.round((rMax - rMin) / 28));
  const radii = [];
  for (let r = rMin; r <= rMax; r += step) radii.push(r);
  const planes = radii.map(() => new Float32Array(n));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < cut) continue;
      const ux = gx[i] / mag[i], uy = gy[i] / mag[i];
      radii.forEach((r, k) => {
        for (const s of [1, -1]) {
          const cx = Math.round(x + s * r * ux), cy = Math.round(y + s * r * uy);
          if (cx >= 0 && cy >= 0 && cx < w && cy < h) planes[k][cy * w + cx] += 1;
        }
      });
    }
  }

  // A jagged blade's votes scatter, more the bigger it is; blurring gathers
  // them, with more passes for bigger circles. Each plane is then scaled so
  // a perfect circle scores about 1, whatever its size or blur.
  const passesFor = (r) => 2 + Math.floor(r / 14);
  const gain = {};
  const scored = planes.map((pl, k) => {
    const passes = passesFor(radii[k]);
    if (!gain[passes]) {
      // What one vote is worth at its own centre after this much blurring.
      const S = 2 * passes + 3, dot = new Float32Array(S * S);
      dot[(S * S - 1) / 2] = 1;
      let d = dot;
      for (let p = 0; p < passes; p++) d = box(d, S, S);
      gain[passes] = 1 / d[(S * S - 1) / 2];
    }
    let b = pl;
    for (let p = 0; p < passes; p++) b = box(b, w, h);
    const per = gain[passes] / (2 * Math.PI * radii[k]);
    for (let i = 0; i < n; i++) b[i] *= per;
    return b;
  });

  // Peaks: higher than everything near them, at their own size and the next.
  const found = [];
  for (let k = 0; k < radii.length; k++) {
    const pl = scored[k];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x, v = pl[i];
        if (v < 0.2) continue;
        let peak = true;
        for (let kk = Math.max(0, k - 1); kk <= Math.min(radii.length - 1, k + 1) && peak; kk++) {
          const o = scored[kk];
          for (let dy = -2; dy <= 2 && peak; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if ((dx || dy || kk !== k) && o[i + dy * w + dx] > v) { peak = false; break; }
            }
          }
        }
        if (peak) found.push({ cx: x + 0.5, cy: y + 0.5, r: radii[k], score: v });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);

  // The same circle found at neighbouring sizes and spots counts once.
  const out = [];
  for (const c of found) {
    if (out.some((o) => Math.hypot(o.cx - c.cx, o.cy - c.cy) < 0.4 * Math.min(o.r, c.r)
      && Math.max(o.r, c.r) / Math.min(o.r, c.r) < 1.3)) continue;
    out.push(c);
    if (out.length >= 80) break;
  }
  return out;
}

const overlap = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.85 * (a.r + b.r);

/**
 * From the circles, the deck: the set of up to `count` circles of about one
 * size, not overlapping, that the photo backs up best.
 *
 * Where each bey is comes out reliably; how big it is less so - a ring
 * inside a bey, or its shadow, can be the stronger circle. sizeOptions and
 * the model settle the size.
 */
export function pickDeck(circles, count) {
  const sets = circles.slice(0, 30).map((anchor) => {
    const chosen = [];
    for (const c of circles) {
      // Wide enough for one bey found by its rim and another by its body; a
      // centre chip is under half a bey across, so it stays out.
      if (c.r < anchor.r * 0.72 || c.r > anchor.r * 1.4) continue;
      if (chosen.some((o) => overlap(o, c))) continue;
      chosen.push(c);
      if (chosen.length >= count) break;
    }
    // Faint circles riding along with strong ones are clutter.
    const top = Math.max(...chosen.map((c) => c.score));
    const kept = chosen.filter((c) => c.score >= 0.45 * top);
    return { circles: kept, score: kept.reduce((s, c) => s + c.score, 0), r: anchor.r };
  });
  if (!sets.length) return [];
  sets.sort((a, b) => b.score - a.score);
  return sets[0].circles;
}

/** How much bigger than the circle found a bey might really be. */
export const SIZE_STEPS = [1, 1.4, 2, 2.8];

/**
 * The crops worth trying for one bey: the circle found and bigger ones, as
 * far as the nearest other bey allows (beys do not overlap). The model's
 * best match picks among them.
 */
export function sizeOptions(box, others) {
  const near = Math.min(Infinity, ...others.filter((o) => o !== box)
    .map((o) => Math.hypot(o.cx - box.cx, o.cy - box.cy)));
  const most = near * CROP_MARGIN;
  const out = [];
  for (const k of SIZE_STEPS) {
    const side = Math.min(box.side * k, most);
    if (!out.length || side > out[out.length - 1].side * 1.12) out.push({ cx: box.cx, cy: box.cy, side });
  }
  return out;
}

/**
 * Finds beys in RGBA pixels. Returns square boxes { cx, cy, side } in those
 * pixels, in reading order, at most `count` of them.
 */
export function findBeysIn(px, w, h, count = 3) {
  return readingOrder(pickDeck(findCirclesIn(px, w, h), count)
    .map((c) => ({ cx: c.cx, cy: c.cy, side: 2 * c.r * CROP_MARGIN })));
}

/** Top row first, left to right; a bey counts as a new row below half a bey's height. */
export function readingOrder(boxes) {
  const rest = [...boxes].sort((a, b) => a.cy - b.cy);
  const out = [];
  while (rest.length) {
    const top = rest[0];
    const row = rest.filter((b) => b.cy - top.cy < top.side / 2);
    row.sort((a, b) => a.cx - b.cx).forEach((b) => { out.push(b); rest.splice(rest.indexOf(b), 1); });
  }
  return out;
}

/* ---------------------------------------------------------- browser parts */

const canvasOf = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

/** A photo, decoded small enough to be gentle on a phone. */
export async function loadPhoto(blob, maxDim = 1600) {
  let bmp = null;
  try { bmp = await createImageBitmap(blob, { resizeWidth: maxDim, resizeQuality: "high" }); } catch { bmp = null; }
  if (!bmp) bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** findBeysIn on a photo canvas, worked at 320px and handed back at full size. */
export function findBeys(photo, count = 3) {
  const scale = Math.min(1, 320 / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale)), h = Math.max(1, Math.round(photo.height * scale));
  const small = canvasOf(w, h);
  const g = small.getContext("2d", { willReadFrequently: true });
  g.drawImage(photo, 0, 0, w, h);
  return findBeysIn(g.getImageData(0, 0, w, h).data, w, h, count)
    .map((b) => ({ cx: b.cx / scale, cy: b.cy / scale, side: b.side / scale }));
}

/**
 * One bey's square, ready for the model. Only the bey's circle is kept;
 * around it is filled with the light surface the references are staged on,
 * so a deck case or a busy desk does not count against the match. (On a
 * real photo this raised the right blade's score from about 0.6 to 0.75.)
 */
export function cropBox(photo, box, size = DETECT_SIZE) {
  const c = canvasOf(size, size);
  const g = c.getContext("2d");
  g.drawImage(photo, box.cx - box.side / 2, box.cy - box.side / 2, box.side, box.side, 0, 0, size, size);
  g.globalCompositeOperation = "destination-in";
  g.beginPath();
  g.arc(size / 2, size / 2, (size / 2 / CROP_MARGIN) * 1.06, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "destination-over";
  g.fillStyle = STAGINGS[0].background;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * A catalogue picture as the camera might see it: on a surface, turned.
 * Used to make references, so photos have something to match against
 * before any approved photo exists.
 */
export function stagedPicture(img, { background, angle }, size = DETECT_SIZE) {
  const c = canvasOf(size, size);
  const g = c.getContext("2d");
  g.fillStyle = background;
  g.fillRect(0, 0, size, size);
  const fit = size / CROP_MARGIN;
  const k = fit / Math.max(img.width, img.height);
  g.translate(size / 2, size / 2);
  g.rotate((angle * Math.PI) / 180);
  g.drawImage(img, (-img.width * k) / 2, (-img.height * k) / 2, img.width * k, img.height * k);
  return c;
}

/** The views made of each catalogue picture: two surfaces, five turns. */
export const STAGINGS = ["#e8e5df", "#2b2b30"].flatMap((background) =>
  [0, 72, 144, 216, 288].map((angle) => ({ background, angle })));

let loading = null;

/**
 * The model, downloaded once. onProgress gets 0..1 while the file comes
 * down. The first caller's onProgress is the one used.
 */
export function loadDetector(onProgress) {
  if (!loading) {
    loading = (async () => {
      const tf = await import("@huggingface/transformers");
      // Everything from this site: no Hugging Face, no CDN.
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = "/models/";
      tf.env.backends.onnx.wasm.wasmPaths = "/ort/";
      const model = await tf.AutoModel.from_pretrained(MODEL_ID, {
        dtype: "q8", device: "wasm",
        progress_callback: (p) => {
          if (onProgress && p.status === "progress" && /\.onnx$/.test(p.file || "") && p.total) {
            onProgress(p.loaded / p.total);
          }
        },
      });
      return { tf, model };
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** 768 numbers per square canvas (DETECT_SIZE across), each list of length 1. */
export async function embed(canvases) {
  const { tf, model } = await loadDetector();
  const S = DETECT_SIZE, plane = S * S;
  const out = [];
  for (let start = 0; start < canvases.length; start += 8) {
    const batch = canvases.slice(start, start + 8);
    const data = new Float32Array(batch.length * 3 * plane);
    batch.forEach((c, k) => {
      const px = c.getContext("2d").getImageData(0, 0, S, S).data;
      const off = k * 3 * plane;
      for (let i = 0; i < plane; i++) {
        for (let ch = 0; ch < 3; ch++) data[off + ch * plane + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
      }
    });
    const res = await model({ pixel_values: new tf.Tensor("float32", data, [batch.length, 3, S, S]) });
    const hs = res.last_hidden_state;
    const [, T, D] = hs.dims;
    for (let k = 0; k < batch.length; k++) out.push(poolTokens(hs.data, k * T * D, T, D));
  }
  return out;
}

/** Class token and the mean patch token, each scaled to length 1, side by side. */
export function poolTokens(h, base, T, D) {
  const cls = new Float32Array(D), avg = new Float32Array(D);
  for (let d = 0; d < D; d++) cls[d] = h[base + d];
  for (let t = 1; t < T; t++) for (let d = 0; d < D; d++) avg[d] += h[base + t * D + d];
  const unit = (v) => {
    let s = 0;
    for (let d = 0; d < D; d++) s += v[d] * v[d];
    const k = 1 / Math.sqrt(2 * (s || 1));   // the 2: the joined list ends up length 1
    for (let d = 0; d < D; d++) v[d] *= k;
    return v;
  };
  const v = new Float32Array(2 * D);
  v.set(unit(cls), 0); v.set(unit(avg), D);
  return v;
}

/** How the numbers travel: pgvector's text form, rounded to keep it small. */
export const vectorText = (v) => "[" + Array.from(v, (x) => +x.toFixed(5)).join(",") + "]";
