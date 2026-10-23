/*
 * The Paired Groups bracket template.
 *
 *   node tests/paired.test.mjs
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

const names = ["num", "scoreOf", "winnerOf", "tieKey", "tieWinner", "tieOrder", "computeStandings",
  "defaultFeed", "validFeed", "feedFor", "propagate", "roundsAfterFirst", "thirdPlaceMatch",
  "pairedFits", "pairingOrder", "buildPairedBracket", "groupShort", "pairedPreview", "treeOrder"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { pairedFits, pairingOrder, buildPairedBracket, pairedPreview, propagate, feedFor, treeOrder } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

/* Groups whose players finish in id order: in Group A, A1 beats everyone,
 * A2 beats all but A1, and so on. */
const pts = (n, side) => [...Array(n)].map(() => ({ side, type: "spin", pts: 1 }));
function setUp(letters, size) {
  const groups = letters.map((L) => ({
    id: "g" + L, name: "Group " + L, playerIds: [...Array(size)].map((_, i) => `${L}${i + 1}`),
  }));
  const groupMatches = [];
  groups.forEach((g) => {
    const ids = g.playerIds;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      groupMatches.push({ id: `${ids[i]}-${ids[j]}`, groupId: g.id, p1: ids[i], p2: ids[j], done: true, events: pts(3, 1) });
    }
  });
  return { groups, groupMatches };
}
const nameOf = (id) => id;
const first = (b) => b.rounds[0].map((m) => [m.p1, m.p2]);
const winAll = (b, r) => {
  b.rounds[r].forEach((m) => { if (m.p1 && m.p2) { m.events = pts(3, 1); m.done = true; } });
  return propagate(b);
};

/* ---- the example: four groups of four into a round of 16 ---- */
{
  const { groups, groupMatches } = setUp(["A", "B", "C", "D"], 4);
  const b = buildPairedBracket(groups, groupMatches, 4, 16, false, nameOf, null);
  check("round of 16 as asked: A v B then C v D, 1 v 3 and 2 v 4", first(b), [
    ["A1", "B3"], ["A2", "B4"], ["A3", "B1"], ["A4", "B2"],
    ["C1", "D3"], ["C2", "D4"], ["C3", "D1"], ["C4", "D2"],
  ]);
  check("quarter-finals wired M1 v M7, M2 v M8, M3 v M5, M4 v M6",
    feedFor(b, 1), [[0, 6], [1, 7], [2, 4], [3, 5]]);
  const after = winAll(b, 0);
  check("so the quarter-finals hold the right winners",
    after.rounds[1].map((m) => [m.p1, m.p2]), [["A1", "C3"], ["A2", "C4"], ["A3", "C1"], ["A4", "C2"]]);
  check("the semis keep the usual wiring", feedFor(b, 2), [[0, 2], [1, 3]]);
  check("every qualifier is placed exactly once",
    first(b).flat().sort(), groups.flatMap((g) => g.playerIds).sort());
  check("marked as this template", b.template, "paired");
  check("and offered as these lines", pairedPreview(groups, 4), [
    "M1 A1 v B3   M2 A2 v B4   M3 A3 v B1   M4 A4 v B2",
    "M5 C1 v D3   M6 C2 v D4   M7 C3 v D1   M8 C4 v D2",
    "then M1 v M7, M2 v M8, M3 v M5, M4 v M6",
  ]);
}

/* ---- choosing the pairs ---- */
{
  const { groups, groupMatches } = setUp(["A", "B", "C", "D"], 4);
  const b = buildPairedBracket(groups, groupMatches, 4, 16, false, nameOf, null, ["gA", "gC", "gB", "gD"]);
  check("A with C and B with D", first(b).slice(0, 4), [["A1", "C3"], ["A2", "C4"], ["A3", "C1"], ["A4", "C2"]]);
  check("then B with D", first(b).slice(4), [["B1", "D3"], ["B2", "D4"], ["B3", "D1"], ["B4", "D2"]]);
  check("the preview follows the chosen pairs",
    pairedPreview(groups, 4, ["gA", "gC", "gB", "gD"])[0], "M1 A1 v C3   M2 A2 v C4   M3 A3 v C1   M4 A4 v C2");
  check("a pairing that leaves a group out falls back to A-B, C-D",
    pairingOrder(groups, ["gA", "gA", "gB", "gD"]), ["gA", "gB", "gC", "gD"]);
  check("as does no pairing at all", pairingOrder(groups, undefined), ["gA", "gB", "gC", "gD"]);
}

/* ---- other shapes ---- */
{
  const { groups, groupMatches } = setUp(["A", "B"], 2);
  const b = buildPairedBracket(groups, groupMatches, 2, 4, true, nameOf, null);
  check("two groups of two is the classic cross", first(b), [["A1", "B2"], ["A2", "B1"]]);
  check("with one pair there is nothing to cross, so the final is as usual", feedFor(b, 1), [[0, 1]]);
  check("and a third-place match when asked for", !!b.third, true);
}
{
  const { groups, groupMatches } = setUp(["A", "B"], 4);
  const b = buildPairedBracket(groups, groupMatches, 4, 8, false, nameOf, null);
  check("two groups of four into quarter-finals",
    first(b), [["A1", "B3"], ["A2", "B4"], ["A3", "B1"], ["A4", "B2"]]);
}
{
  const { groups, groupMatches } = setUp(["A", "B", "C", "D", "E", "F", "G", "H"], 2);
  const b = buildPairedBracket(groups, groupMatches, 2, 16, false, nameOf, null);
  check("eight groups of two pair off in fours",
    first(b).slice(0, 4), [["A1", "B2"], ["A2", "B1"], ["C1", "D2"], ["C2", "D1"]]);
  check("and cross block with block", feedFor(b, 1), [[0, 3], [1, 2], [4, 7], [5, 6]]);
}

/* ---- the tree view draws every match level with the two that feed it ---- */
const drawsClean = (b) => {
  const order = treeOrder(b);
  return b.rounds.every((r, ri) =>
    [...order[ri]].sort((x, y) => x - y).join() === r.map((_, i) => i).join()
    && (ri === 0 || order[ri].every((j, k) =>
      JSON.stringify(feedFor(b, ri)[j]) === JSON.stringify([order[ri - 1][2 * k], order[ri - 1][2 * k + 1]]))));
};
{
  const { groups, groupMatches } = setUp(["A", "B", "C", "D"], 4);
  const b = buildPairedBracket(groups, groupMatches, 4, 16, false, nameOf, null);
  check("the crossed round of 16 is drawn M1, M7, M3, M5, M2, M8, M4, M6", treeOrder(b)[0], [0, 6, 2, 4, 1, 7, 3, 5]);
  check("so no line crosses another", drawsClean(b), true);
  const plain = buildPairedBracket(...Object.values(setUp(["A", "B"], 4)), 4, 8, true, nameOf, null);
  check("an uncrossed bracket follows the usual M1 v M3, M2 v M4 wiring", treeOrder(plain)[0], [0, 2, 1, 3]);
  check("and a hand-set feed still draws clean",
    drawsClean({ ...plain, feeds: { 1: [[0, 3], [2, 1]] } }), true);
}

/* ---- when it is offered ---- */
const g = (n) => [...Array(n)].map((_, i) => ({ id: "g" + i }));
check("four groups of four filling sixteen", pairedFits(g(4), 4, 16), true);
check("not when qualifiers would leave byes", pairedFits(g(4), 3, 16), false);
check("not for an odd number of groups", pairedFits(g(3), 4, 12), false);
check("not for a single group", pairedFits(g(1), 4, 4), false);

console.log(fails ? `\n${fails} FAILED` : "\nAll paired-groups checks passed.");
process.exit(fails ? 1 : 0);
