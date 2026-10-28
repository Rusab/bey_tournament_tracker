/*
 * Deck photo detection, all in the browser.
 *
 *   1. findBeys: plain image processing finds each bey in a photo of the
 *      deck laid out on a plain surface - what differs from the surface,
 *      grouped into round-ish blobs.
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

/** Least-squares plane a + b·x + c·y through the given samples. */
function fitPlane(xs, ys, vs) {
  let n = 0, sx = 0, sy = 0, sv = 0, sxx = 0, syy = 0, sxy = 0, sxv = 0, syv = 0;
  for (let i = 0; i < vs.length; i++) {
    const x = xs[i], y = ys[i], v = vs[i];
    n++; sx += x; sy += y; sv += v; sxx += x * x; syy += y * y; sxy += x * y; sxv += x * v; syv += y * v;
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], r = [sv, sxv, syv];
  const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det(m);
  if (Math.abs(D) < 1e-9) return [sv / Math.max(1, n), 0, 0];
  const col = (k) => det(m.map((row, i) => row.map((x, j) => (j === k ? r[i] : x))));
  return [col(0) / D, col(1) / D, col(2) / D];
}

/** Otsu's threshold over values 0..255. */
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; at = t; }
  }
  return at;
}

/** Square dilation (grow) or erosion (shrink) of a 0/1 mask, radius r. */
function morph(mask, w, h, r, grow) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const want = grow ? 1 : 0;
  // Rows, then columns: a square is the two one-dimensional passes.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = !grow;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (mask[y * w + k] === want) { hit = grow; break; }
      }
      tmp[y * w + x] = hit ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let hit = !grow;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === want) { hit = grow; break; }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

/** Fills holes: background the photo's edge cannot reach becomes bey. */
function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (!seen[i] && !mask[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

/**
 * Finds beys in RGBA pixels. Returns square boxes { cx, cy, side } in those
 * pixels, in reading order, at most `max` of them.
 */
export function findBeysIn(px, w, h, max = 6) {
  const n = w * h;
  const Y = new Float32Array(n), U = new Float32Array(n), V = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    Y[i] = y; U[i] = b - y; V[i] = r - y;
  }

  // The surface, from the photo's edges. A plane rather than one colour,
  // so light falling off across a table does not read as a bey.
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const xs = [], ys = [], ids = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) { xs.push(x); ys.push(y); ids.push(y * w + x); }
    }
  }
  const plane = (ch) => fitPlane(xs, ys, ids.map((i) => ch[i]));
  const pY = plane(Y), pU = plane(U), pV = plane(V);

  // How far each pixel is from the surface. Brightness counts for less
  // than colour, so a soft shadow is not a bey.
  const dist = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const dy = Y[i] - (pY[0] + pY[1] * x + pY[2] * y);
      const du = U[i] - (pU[0] + pU[1] * x + pU[2] * y);
      const dv = V[i] - (pV[0] + pV[1] * x + pV[2] * y);
      const d = Math.min(255, Math.round(Math.sqrt(0.35 * dy * dy + du * du + dv * dv)));
      dist[i] = d; hist[d]++;
    }
  }
  const t = Math.max(16, otsu(hist, n));
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = dist[i] > t ? 1 : 0;

  // Close small gaps between a blade's pieces, fill it in, drop specks.
  const r = Math.max(1, Math.round(Math.min(w, h) * 0.012));
  mask = morph(morph(mask, w, h, r, true), w, h, r, false);
  mask = fillHoles(mask, w, h);
  mask = morph(morph(mask, w, h, 1, false), w, h, 1, true);

  // Connected blobs.
  const label = new Int32Array(n).fill(-1);
  const blobs = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const b = { area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    label[s] = blobs.length; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      b.area++;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      const near = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of near) if (j >= 0 && mask[j] && label[j] < 0) { label[j] = blobs.length; stack.push(j); }
    }
    blobs.push(b);
  }

  // Pieces of one bey whose boxes overlap become one.
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < blobs.length && !merged; a++) {
      for (let c = a + 1; c < blobs.length && !merged; c++) {
        const A = blobs[a], B = blobs[c];
        const pad = 0.05 * Math.max(A.x1 - A.x0, A.y1 - A.y0, B.x1 - B.x0, B.y1 - B.y0);
        if (A.x0 - pad <= B.x1 && B.x0 - pad <= A.x1 && A.y0 - pad <= B.y1 && B.y0 - pad <= A.y1) {
          blobs[a] = {
            area: A.area + B.area, x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0),
            x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1),
          };
          blobs.splice(c, 1);
          merged = true;
        }
      }
    }
  }

  // A bey seen from above is round: about as wide as tall, mostly filled.
  let found = blobs.filter((b) => {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    return b.area >= 0.003 * n && b.area / (bw * bh) >= 0.45
      && Math.max(bw, bh) / Math.min(bw, bh) <= 1.8
      && Math.max(bw / w, bh / h) <= 0.95;
  }).sort((a, b) => b.area - a.area).slice(0, max);
  // The beys in one deck are about the same size; much smaller is clutter.
  if (found.length) found = found.filter((b) => b.area >= 0.25 * found[0].area);

  const boxes = found.map((b) => ({
    cx: (b.x0 + b.x1 + 1) / 2, cy: (b.y0 + b.y1 + 1) / 2,
    side: Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) * CROP_MARGIN,
  }));
  return readingOrder(boxes);
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
export function findBeys(photo) {
  const scale = Math.min(1, 320 / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale)), h = Math.max(1, Math.round(photo.height * scale));
  const small = canvasOf(w, h);
  const g = small.getContext("2d", { willReadFrequently: true });
  g.drawImage(photo, 0, 0, w, h);
  return findBeysIn(g.getImageData(0, 0, w, h).data, w, h)
    .map((b) => ({ cx: b.cx / scale, cy: b.cy / scale, side: b.side / scale }));
}

/** One bey's square, ready for the model. Past the photo's edge is filled grey. */
export function cropBox(photo, box, size = DETECT_SIZE) {
  const c = canvasOf(size, size);
  const g = c.getContext("2d");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, size, size);
  g.drawImage(photo, box.cx - box.side / 2, box.cy - box.side / 2, box.side, box.side, 0, 0, size, size);
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
