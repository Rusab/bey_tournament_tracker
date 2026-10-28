/*
 * Deck photo detection, all in the browser.
 *
 *   1. The blader taps each bey (or drags from its middle to its edge).
 *      For a tap, a few crop sizes are tried and the model's best match
 *      picks the size.
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

/* ----------------------------------------------------------- marking beys */

/*
 * The blader marks each bey: a tap on its middle, or a drag from its middle
 * to its edge. A drag gives the size; for a tap, a few sizes are tried and
 * the model's best match decides.
 */

/**
 * The crops to try for a tapped bey at point {x, y}: around the size of the
 * beys already marked, or else a spread of likely sizes. Never so big that
 * it reaches past halfway to another bey (beys do not overlap).
 */
export function tapOptions(point, minDim, others = []) {
  const near = Math.min(Infinity, ...others.map((o) => Math.hypot(o.cx - point.x, o.cy - point.y)));
  const most = near * CROP_MARGIN;
  const sides = others.map((o) => o.side).sort((a, b) => a - b);
  const base = sides.length ? sides[Math.floor(sides.length / 2)] : 0;
  const steps = base ? [0.8, 1, 1.25].map((k) => base * k) : [0.18, 0.24, 0.32, 0.42, 0.55].map((k) => k * minDim);
  const out = [];
  for (const want of steps) {
    const side = Math.min(want, most);
    if (!out.length || side > out[out.length - 1].side * 1.08) out.push({ cx: point.x, cy: point.y, side });
  }
  return out;
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
