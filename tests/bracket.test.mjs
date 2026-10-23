/*
 * The knockout: seeding, how rounds feed each other, and setting rounds by hand.
 *
 * App.jsx is one file with no exports, so the functions under test are lifted
 * out of it by name and evaluated on their own. What runs here is the code that
 * ships, not a copy of it.
 *
 *   node tests/bracket.test.mjs
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

function grab(name) {
  for (const p of [`function ${name}(`, `const ${name} = `]) {
    const at = src.indexOf(p);
    if (at < 0) continue;
    if (p.startsWith("function")) {
      let i = src.indexOf("{", at), d = 0;
      for (; i < src.length; i++) {
        if (src[i] === "{") d++;
        else if (src[i] === "}") { d--; if (!d) return src.slice(at, i + 1); }
      }
    } else {
      let d = 0;
      for (let i = at; i < src.length; i++) {
        const c = src[i];
        if ("{([".includes(c)) d++;
        else if ("})]".includes(c)) d--;
        else if (c === ";" && d === 0) return src.slice(at, i + 1);
      }
    }
  }
  throw new Error("not found in App.jsx: " + name);
}

const names = ["scoreOf", "winnerOf", "defaultFeed", "validFeed", "feedFor", "setRound",
  "propagate", "bracketOrder", "seedOrder", "avoidSameGroup", "roundsAfterFirst", "thirdPlaceMatch", "buildBracket"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { seedOrder, buildBracket, propagate, setRound, validFeed, feedFor } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

/* ---- helpers ---- */

const pairs = (n, q) => {
  const o = seedOrder(n, q);
  const out = [];
  for (let i = 0; i < n; i += 2) out.push([o[i], o[i + 1]]);
  return out;
};

// Seeds s1..sN, each in a group of its own so avoidSameGroup never fires and
// what is measured is the seeding and the wiring alone.
const fresh = (n, q = n) => buildBracket(
  [...Array(q)].map((_, i) => ({ id: "s" + (i + 1), groupId: "g" + i, placement: i + 1 })),
  n, true);

const seed = (id) => (id ? Number(String(id).slice(1)) : null);

// The better seed takes every match, 1-0.
const win = (m) => {
  m.events = [{ side: seed(m.p1) < seed(m.p2) ? 1 : 2, type: "spin", pts: 1 }];
  m.done = true;
};

const playRound = (b, r) => {
  b.rounds[r].forEach((m) => { if (m.p1 && m.p2) win(m); });
  return propagate(b);
};

const playAll = (b) => {
  for (let r = 0; r < b.rounds.length; r++) b = playRound(b, r);
  return b;
};

const show = (b, r) => b.rounds[r].map((m) => `${seed(m.p1)}v${seed(m.p2)}`);

/* ---- seeding: split in half, listed first-last-inwards, byes off the top ---- */

check("a four is listed 1v3, 2v4", pairs(4), [[1, 3], [2, 4]]);
check("an eight is listed 1v5, 4v8, 2v6, 3v7", pairs(8), [[1, 5], [4, 8], [2, 6], [3, 7]]);
check("a sixteen pairs i with i+8", pairs(16).every(([a, b]) => b - a === 8), true);
for (const n of [2, 4, 8, 16]) {
  check(`every seed of ${n} is placed once`,
    seedOrder(n).slice().sort((a, b) => a - b), [...Array(n)].map((_, i) => i + 1));
}
check("6 into 8: the top two sit out",
  pairs(8, 6).filter((p) => p[1] === null).map((p) => p[0]).sort(), [1, 2]);

/* ---- default wiring: match 1 meets match 3, match 2 meets match 4 ---- */

{
  let b = playRound(fresh(8), 0);
  check("default semis are M1 v M3 and M2 v M4", show(b, 1), ["1v2", "4v3"]);
  b = playAll(fresh(8));
  check("default final", show(b, 2), ["1v3"]);
  check("third place is the two beaten semi-finalists",
    [seed(b.third.p1), seed(b.third.p2)].sort(), [2, 4]);
}

/* ---- validFeed: only a whole arrangement counts ---- */

check("the default is valid", validFeed([[0, 2], [1, 3]], 2), true);
check("a rewiring is valid", validFeed([[0, 1], [2, 3]], 2), true);
check("a match used twice is not", validFeed([[0, 0], [2, 3]], 2), false);
check("a match left out is not", validFeed([[0, 1], [2, 2]], 2), false);
check("out of range is not", validFeed([[0, 1], [2, 4]], 2), false);
check("the wrong length is not", validFeed([[0, 1]], 2), false);
check("nothing at all is not", validFeed(undefined, 2), false);

/* ---- rewiring a later round by hand ---- */

{
  // Semis as M1 v M2 and M3 v M4 instead of the default.
  let b = setRound(fresh(8), 1, [[0, 1], [2, 3]]);
  check("the feed is stored", feedFor(b, 1), [[0, 1], [2, 3]]);
  check("and marked as set by hand", b.edited[1], true);
  b = playRound(b, 0);
  check("rewired semis follow it", show(b, 1), ["1v4", "2v3"]);
  b = playAll(b);
  check("the final follows the rewired semis", show(b, 2), ["1v2"]);
  check("third place follows them too",
    [seed(b.third.p1), seed(b.third.p2)].sort(), [3, 4]);
}

{
  // Setting the default by hand is the same as not setting it.
  const b = setRound(setRound(fresh(8), 1, [[0, 1], [2, 3]]), 1, [[0, 2], [1, 3]]);
  check("going back to the default removes the feed", b.feeds[1], undefined);
  check("and unmarks the round", b.edited[1], false);
}

{
  // A broken feed in the data is ignored, not obeyed half-way.
  const b = fresh(8);
  b.feeds = { 1: [[0, 0], [1, 2]] };
  check("a broken feed falls back to the default", feedFor(b, 1), [[0, 2], [1, 3]]);
}

{
  // Rewiring after a semi has been played clears that result if its players change.
  let b = playRound(fresh(8), 0);
  win(b.rounds[1][0]);
  b = propagate(b);
  check("semi 1 has a result", b.rounds[1][0].done, true);
  b = setRound(b, 1, [[0, 1], [2, 3]]);
  check("rewiring clears it", [b.rounds[1][0].done, b.rounds[1][0].events.length], [false, 0]);
  check("and puts the new pair in", show(b, 1), ["1v4", "2v3"]);
}

{
  // Swapping the two sides of the same pairing changes nobody's opponent.
  let b = playRound(fresh(8), 0);
  b = setRound(b, 1, [[2, 0], [1, 3]]);
  check("p1 and p2 swap sides", show(b, 1), ["2v1", "4v3"]);
}

/* ---- setting the opening round by hand ---- */

{
  let b = fresh(8);
  // M1 becomes s1 v s8, M2 becomes s4 v s5 - a straight swap of opponents.
  b = setRound(b, 0, [["s1", "s8"], ["s4", "s5"], ["s2", "s6"], ["s3", "s7"]]);
  check("the opening round takes the names given", show(b, 0), ["1v8", "4v5", "2v6", "3v7"]);
  check("and is marked as set by hand", b.edited[0], true);
}

{
  // A match that keeps its players keeps its result; one that changes loses it.
  let b = fresh(8);
  win(b.rounds[0][0]);   // 1 v 5
  win(b.rounds[0][1]);   // 4 v 8
  b = propagate(b);
  b = setRound(b, 0, [["s1", "s5"], ["s4", "s6"], ["s2", "s8"], ["s3", "s7"]]);
  check("an untouched match keeps its result", b.rounds[0][0].done, true);
  check("a changed match loses it", b.rounds[0][1].done, false);
  check("and what it fed is emptied", b.rounds[1][1].p1, null);
  check("while what the kept match fed stays", seed(b.rounds[1][0].p1), 1);
}

{
  // Emptying a slot makes a bye, which goes through on its own.
  let b = setRound(fresh(8), 0, [["s1", null], ["s4", "s8"], ["s2", "s6"], ["s3", "s7"]]);
  check("an empty slot is a bye", b.rounds[0][0].done, true);
  check("and the bye goes through", seed(b.rounds[1][0].p1), 1);
}

{
  // The input bracket is never changed in place.
  const before = fresh(8);
  const snap = JSON.stringify(before);
  setRound(before, 0, [["s1", "s8"], ["s4", "s5"], ["s2", "s6"], ["s3", "s7"]]);
  setRound(before, 1, [[0, 1], [2, 3]]);
  check("setRound leaves its input alone", JSON.stringify(before), snap);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll bracket checks passed.");
process.exit(fails ? 1 : 0);
