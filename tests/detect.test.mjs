/*
 * Deck photo detection: the sizes tried for a tapped bey, the order beys
 * fill a deck, and the numbers sent to the database.
 *
 *   node tests/detect.test.mjs
 */
import { tapOptions, readingOrder, poolTokens, vectorText, CROP_MARGIN } from "../src/detect.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

{
  const first = tapOptions({ x: 500, y: 400 }, 1000);
  check("the first tap tries a spread of sizes", first.map((b) => Math.round(b.side)), [180, 240, 320, 420, 550]);
  check("all centred on the tap", first.every((b) => b.cx === 500 && b.cy === 400), true);
}

{
  const marked = [{ cx: 200, cy: 300, side: 250 }, { cx: 500, cy: 300, side: 270 }];
  const next = tapOptions({ x: 800, y: 300 }, 1000, marked);
  check("later taps try sizes around the beys already marked", next.map((b) => Math.round(b.side)), [216, 270, 338]);
}

{
  // Beys in a case, 220 apart: no crop may reach past halfway to the next one.
  const marked = [{ cx: 400, cy: 300, side: 240 }];
  const next = tapOptions({ x: 400, y: 520 }, 1000, marked);
  const most = 220 * CROP_MARGIN;
  check("a crop never reaches past halfway to its neighbour", next.every((b) => b.side <= most + 1e-9), true);
  check("sizes capped to the same value are tried once", new Set(next.map((b) => b.side)).size, next.length);
}

check("reading order: rows, then left to right",
  readingOrder([{ cx: 200, cy: 210, side: 80 }, { cx: 50, cy: 60, side: 80 }, { cx: 300, cy: 50, side: 80 }, { cx: 40, cy: 200, side: 80 }])
    .map((b) => b.cx),
  [50, 300, 40, 200]);
check("a column of beys reads top to bottom",
  readingOrder([{ cx: 400, cy: 800, side: 200 }, { cx: 400, cy: 300, side: 200 }, { cx: 405, cy: 560, side: 200 }])
    .map((b) => b.cy),
  [300, 560, 800]);

{
  // Two tokens of three numbers each.
  const h = new Float32Array([3, 4, 0, /* patch */ 0, 0, 2]);
  const v = poolTokens(h, 0, 2, 3);
  check("pooled numbers have length 1", Math.round(Math.hypot(...v) * 1e6) / 1e6, 1);
  check("class token first, patch mean second", Array.from(v, (x) => Math.round(x * 1000) / 1000),
    [0.424, 0.566, 0, 0, 0, 0.707]);
  check("sent as pgvector text", vectorText(new Float32Array([0.123456789, -1])), "[0.12346,-1]");
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
