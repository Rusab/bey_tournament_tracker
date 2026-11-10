/*
 * Removing a photo's background, all in the browser, for podium posters.
 *
 * The model is MODNet (Apache-2.0), made for portraits of people, in its
 * 12MB half-precision form, served from this site (public/models/modnet).
 * The 6MB quantised form was tried and left holes in clothing; the larger
 * ones (RMBG, BiRefNet) are 40MB and up, too big to serve from here and,
 * for RMBG, under a licence that is not open.
 *
 * Nothing downloads until it is first asked for; the browser keeps the
 * model after that. It runs in a background worker, like the deck scanner.
 */

const MODEL_ID = "modnet";
const MAX_SIDE = 1600;   // big photos are shrunk first: the model sees 512 anyway

let loading = null;

/**
 * The model, downloaded once. onProgress gets 0..1 while the file comes
 * down. The first caller's onProgress is the one used.
 */
export function loadCutter(onProgress) {
  if (!loading) {
    loading = (async () => {
      const tf = await import("@huggingface/transformers");
      // Everything from this site: no Hugging Face, no CDN.
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = "/models/";
      tf.env.backends.onnx.wasm.wasmPaths = "/ort/";
      tf.env.backends.onnx.wasm.proxy = true;
      const [model, processor] = await Promise.all([
        tf.AutoModel.from_pretrained(MODEL_ID, {
          dtype: "fp16", device: "wasm",
          progress_callback: (p) => {
            if (onProgress && p.status === "progress" && /\.onnx$/.test(p.file || "") && p.total) {
              onProgress(p.loaded / p.total);
            }
          },
        }),
        tf.AutoProcessor.from_pretrained(MODEL_ID),
      ]);
      return { tf, model, processor };
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/**
 * The photo with its background made transparent, as a canvas the same
 * shape as the photo (shrunk if it was very large).
 */
export async function cutOut(img, onProgress) {
  const { tf, model, processor } = await loadCutter(onProgress);

  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, c.width, c.height);

  const image = tf.RawImage.fromCanvas(c);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  const mask = await tf.RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(c.width, c.height);

  const px = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < mask.data.length; i++) px.data[i * 4 + 3] = mask.data[i];
  g.putImageData(px, 0, 0);
  return c;
}
