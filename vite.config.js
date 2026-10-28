import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * The deck detector's runtime (onnxruntime-web) is loaded from jsDelivr at
 * the version transformers.js pins, so the 21MB copy the bundler finds
 * would only ever be a fallback nobody reaches. Left out of the site.
 */
const dropOnnxWasm = {
  name: "drop-onnx-wasm",
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    }
  },
};

export default defineConfig({
  plugins: [react(), dropOnnxWasm],
});
