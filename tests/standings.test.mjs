/*
 * Final standings: equal totals share a rank, and the next total takes the
 * next number - 1, 2, 2, 3, not 1, 2, 2, 4.
 *
 *   node tests/standings.test.mjs
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

const names = ["num", "scoreOf", "winnerOf", "stageKeyForTeams", "stageOf", "finalStandings"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { finalStandings } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

const pts = (n, side) => [...Array(n)].map(() => ({ side, type: "spin", pts: 1 }));
const beats = (id, winner, by) =>
  ({ id, groupId: "g0", p1: winner, p2: "z", done: true, events: [...pts(by, 1)] });

/* Scored on winning margin alone, so each total is just the margin of one
 * win over the same opponent: 5, 3, 3, 2, 2, 1, and the opponent on 0. */
const t = {
  koSize: 0,
  players: ["a", "b", "c", "d", "e", "f", "z"].map((id) => ({ id, name: id.toUpperCase() })),
  groups: [{ id: "g0", name: "Group A", playerIds: ["a", "b", "c", "d", "e", "f", "z"] }],
  groupMatches: [
    beats("m1", "a", 5), beats("m2", "b", 3), beats("m3", "c", 3),
    beats("m4", "d", 2), beats("m5", "e", 2), beats("m6", "f", 1),
  ],
  bracket: null,
};
const cfg = { perWin: "0", perMargin: "1", stages: {} };
const rows = finalStandings(t, cfg);

check("totals as built", rows.map((r) => r.total), [5, 3, 3, 2, 2, 1, 0]);
check("ties share a rank and the next takes the next number",
  rows.map((r) => r.rank), [1, 2, 2, 3, 3, 4, 5]);
check("no number is skipped", [...new Set(rows.map((r) => r.rank))], [1, 2, 3, 4, 5]);

{
  const solo = finalStandings({ ...t, groupMatches: [beats("m1", "a", 5), beats("m2", "b", 3)] }, cfg);
  check("with no ties, ranks simply count up", solo.map((r) => r.rank), [1, 2, 3]);
}
{
  const all = finalStandings({ ...t, groupMatches: [beats("m1", "a", 2), beats("m2", "b", 2)] }, cfg);
  check("everyone level shares first", all.filter((r) => r.total === 2).map((r) => r.rank), [1, 1]);
  check("and whoever is behind them is second", all.find((r) => r.id === "z").rank, 2);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll standings checks passed.");
process.exit(fails ? 1 : 0);
