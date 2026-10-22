/*
 * The ranking image's shape: always 1080 wide, a post while it can be, a
 * story when it must, and taller only past that - the whole table always fits.
 *
 *   node tests/image.test.mjs
 */
import { layoutFor, WIDTH } from "../src/rankingImage.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

const HEAD = 380, FOOT = 150;
const fits = (n) => { const l = layoutFor(n); return HEAD + FOOT + n * l.rowH <= l.height; };

check("always 1080 wide", [1, 8, 16, 32, 64].map((n) => layoutFor(n).width), [WIDTH, WIDTH, WIDTH, WIDTH, WIDTH]);
check("a short table is a square post at full row height", layoutFor(4), { width: 1080, height: 1080, rowH: 64 });
check("a middling one grows towards 4:5", layoutFor(10).height, HEAD + FOOT + 10 * 64);
check("sixteen bladers still make a 4:5 post", layoutFor(16).height, 1350);
check("by squeezing the rows", layoutFor(16).rowH < 64, true);
check("thirty become a story", layoutFor(30).height, 1920);
check("sixty grow past a story", layoutFor(60).height > 1920, true);
check("rows never drop below a readable height", Math.min(...[16, 18, 30, 60, 120].map((n) => layoutFor(n).rowH)) >= 40, true);
for (const n of [1, 4, 12, 16, 17, 20, 25, 32, 33, 48, 100]) {
  check(`all ${n} rows fit`, fits(n), true);
}
{
  const h = [4, 10, 16, 18, 25, 32, 40].map((n) => layoutFor(n).height);
  check("never shorter for more bladers", h.every((x, i) => i === 0 || x >= h[i - 1]), true);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll image checks passed.");
process.exit(fails ? 1 : 0);
