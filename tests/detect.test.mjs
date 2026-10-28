/*
 * Finding beys in a deck photo, on made-up photos: round shapes on a plain
 * surface with uneven light and grain.
 *
 *   node tests/detect.test.mjs
 */
import { findBeysIn, readingOrder, poolTokens, vectorText } from "../src/detect.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

// A seeded random, so a failure can be replayed.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/**
 * A w×h photo: a surface lit brighter on one side, grain, and beys drawn as
 * discs with a darker ring and a few gaps (a blade is not a solid disc).
 */
function photo(w, h, beys, { surface = [205, 196, 180], light = 40, shadow = false } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lit = light * (x / w - 0.5);
      let c = surface.map((s) => s + lit + (rand() - 0.5) * 14);
      if (shadow) {
        for (const b of beys) {
          const d = Math.hypot(x - b.x - b.r * 0.25, y - b.y - b.r * 0.25);
          if (d < b.r * 1.1) c = c.map((v) => v * 0.85);
        }
      }
      for (const b of beys) {
        const d = Math.hypot(x - b.x, y - b.y);
        const ang = Math.atan2(y - b.y, x - b.x);
        const gap = d > b.r * 0.7 && Math.sin(ang * 3) > 0.85;   // three notches in the rim
        if (d < b.r && !gap) c = d > b.r * 0.8 ? b.color.map((v) => v * 0.6) : b.color;
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

const near = (box, b) => Math.hypot(box.cx - b.x, box.cy - b.y) < b.r * 0.3
  && box.side > b.r * 1.6 && box.side < b.r * 2 * 1.5;   // a rim the colour of the table can be missed

{
  const beys = [
    { x: 60, y: 110, r: 36, color: [200, 30, 40] },
    { x: 160, y: 105, r: 38, color: [30, 60, 200] },
    { x: 260, y: 115, r: 35, color: [40, 40, 40] },
  ];
  const got = findBeysIn(photo(320, 220, beys), 320, 220);
  check("three beys in a row are found", got.length, 3);
  check("each box sits on its bey, in left-to-right order", got.map((g, i) => near(g, beys[i])), [true, true, true]);
}

{
  const beys = [
    { x: 80, y: 70, r: 40, color: [230, 230, 235] },     // a white bey on a light table
    { x: 220, y: 80, r: 40, color: [180, 140, 30] },
    { x: 150, y: 210, r: 42, color: [20, 120, 60] },
  ];
  const got = findBeysIn(photo(320, 280, beys, { surface: [120, 110, 100], shadow: true }), 320, 280);
  check("with soft shadows, still three", got.length, 3);
  check("two on top, then the one below", got.map((g) => beys.findIndex((b) => near(g, b))), [0, 1, 2]);
}

{
  const got = findBeysIn(photo(320, 220, []), 320, 220);
  check("an empty table finds nothing", got.length, 0);
}

{
  // Specks: crumbs much smaller than any bey.
  const beys = [
    { x: 90, y: 110, r: 40, color: [200, 30, 40] },
    { x: 230, y: 110, r: 40, color: [30, 60, 200] },
    { x: 160, y: 30, r: 4, color: [0, 0, 0] },
  ];
  const got = findBeysIn(photo(320, 220, beys), 320, 220);
  check("a crumb is not a bey", got.length, 2);
}

check("reading order: rows, then left to right",
  readingOrder([{ cx: 200, cy: 210, side: 80 }, { cx: 50, cy: 60, side: 80 }, { cx: 300, cy: 50, side: 80 }, { cx: 40, cy: 200, side: 80 }])
    .map((b) => b.cx),
  [50, 300, 40, 200]);

{
  // Two tokens of three numbers each.
  const h = new Float32Array([3, 4, 0, /* patch */ 0, 0, 2]);
  const v = poolTokens(h, 0, 2, 3);
  const len = Math.hypot(...v);
  check("pooled numbers have length 1", Math.round(len * 1e6) / 1e6, 1);
  check("class token first, patch mean second", Array.from(v, (x) => Math.round(x * 1000) / 1000),
    [0.424, 0.566, 0, 0, 0, 0.707]);
  check("sent as pgvector text", vectorText(new Float32Array([0.123456789, -1])), "[0.12346,-1]");
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
