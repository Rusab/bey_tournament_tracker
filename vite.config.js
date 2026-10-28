import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";

/*
 * The deck detector runs from this site alone: the model sits in
 * public/models, and the onnxruntime files it needs are copied into
 * public/ort from the installed transformers.js, so they always match it.
 * Fetching them from Hugging Face or a CDN failed in some browsers.
 *
 * The bundler also finds its own hashed copy of the runtime; that one is
 * never used (the app points the runtime at /ort/), so it is left out.
 */
const ORT_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
const detectorRuntime = {
  name: "detector-runtime",
  buildStart() {
    mkdirSync("public/ort", { recursive: true });
    for (const f of ORT_FILES) {
      const from = `node_modules/@huggingface/transformers/dist/${f}`, to = `public/ort/${f}`;
      let same = false;
      try { same = statSync(to).size === statSync(from).size; } catch { same = false; }
      if (!same) copyFileSync(from, to);
    }
  },
  // The dev server will not let code import a file from public/, so it
  // hands these two over itself.
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const name = (req.url || "").split("?")[0].replace(/^\/ort\//, "");
      if (!req.url.startsWith("/ort/") || !ORT_FILES.includes(name)) return next();
      res.setHeader("Content-Type", name.endsWith(".mjs") ? "text/javascript" : "application/wasm");
      res.end(readFileSync(`node_modules/@huggingface/transformers/dist/${name}`));
    });
  },
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    }
  },
};

export default defineConfig({
  plugins: [react(), detectorRuntime],
});
