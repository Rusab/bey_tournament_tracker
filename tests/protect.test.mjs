/*
 * Protect played matches: what a change would wipe.
 *
 *   node tests/protect.test.mjs
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

const names = ["num", "scoreOf", "winnerOf", "defaultFeed", "validFeed", "feedFor", "propagate", "setRound",
  "roundsAfterFirst", "thirdPlaceMatch", "roundRobin", "pairKey", "buildGroupMatches",
  "allMatchesOf", "lostResults", "protects"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { propagate, setRound, roundsAfterFirst, thirdPlaceMatch, buildGroupMatches, lostResults, protects } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

const win = (side) => [1, 2, 3, 4].map(() => ({ side, type: "spin", pts: 1 }));
const clone = (x) => structuredClone(x);
const ids = (ms) => ms.map((m) => m.id).sort();

/* A group of four, with every match played except those involving D. */
function groupStage() {
  const groups = [{ id: "a", name: "Group A", playerIds: ["A", "B", "C", "D"] }];
  const groupMatches = buildGroupMatches(groups, []);
  groupMatches.forEach((m) => {
    if (m.p1 !== "D" && m.p2 !== "D") { m.events = win(1); m.done = true; }
  });
  return { groups, groupMatches, bracket: null, players: ["A", "B", "C", "D"].map((id) => ({ id })) };
}
const remove = (pid) => (d) => {
  d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== pid)));
  d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
  return d;
};

/* ---- the group stage ---- */
{
  const t = groupStage();
  check("removing a blader with nothing played wipes nothing", lostResults(t, remove("D")(clone(t))), []);
  const after = remove("D")(clone(t));
  check("and every surviving fixture keeps its sides and its result",
    after.groupMatches.map((m) => [m.id, m.p1, m.p2, m.events.length]),
    t.groupMatches.filter((m) => m.p1 !== "D" && m.p2 !== "D").map((m) => [m.id, m.p1, m.p2, m.events.length]));
  const lost = lostResults(t, remove("A")(clone(t)));
  check("removing one who has played names exactly their played matches",
    ids(lost), ids(t.groupMatches.filter((m) => (m.p1 === "A" || m.p2 === "A") && m.events.length)));
  // Clear A's matches one by one, as a referee would.
  const cleared = clone(t);
  cleared.groupMatches.forEach((m) => { if (m.p1 === "A" || m.p2 === "A") { m.events = []; m.done = false; } });
  check("once they are reset, removing them wipes nothing", lostResults(cleared, remove("A")(clone(cleared))), []);
}
{
  const t = groupStage();
  const m = t.groupMatches.find((x) => x.events.length);
  const after = clone(t);
  after.groupMatches.find((x) => x.id === m.id).events = [];
  check("clearing a match is a lost result to anyone else", ids(lostResults(t, after)), [m.id]);
  check("but not to the match being cleared", lostResults(t, after, [m.id]), []);
}

{
  // Everything played. Once A's matches are reset and A leaves, the round
  // robin lists B and D the other way round; their result must not flip.
  const t = groupStage();
  t.groupMatches.forEach((m) => { m.events = m.p1 === "A" || m.p2 === "A" ? [] : win(1); m.done = !!m.events.length; });
  const bd = t.groupMatches.find((m) => [m.p1, m.p2].sort().join() === "B,D");
  const after = remove("A")(clone(t));
  const bd2 = after.groupMatches.find((m) => m.id === bd.id);
  check("a surviving result keeps its winner when the fixture list is rebuilt", [bd2.p1, bd2.p2], [bd.p1, bd.p2]);
  check("so removing A wipes nothing", lostResults(t, after), []);
}

/* ---- the knockout ---- */
function knockout() {
  const rounds = [
    [{ id: "k:0:0", p1: "A", p2: "B", events: [], done: false }, { id: "k:0:1", p1: "C", p2: "D", events: [], done: false }],
    ...roundsAfterFirst(4),
  ];
  let b = propagate({ size: 4, rounds, third: thirdPlaceMatch(4, true) });
  const score = (id, side) => {
    b = clone(b);
    [...b.rounds.flat(), b.third].forEach((m) => { if (m.id === id) { m.events = win(side); m.done = true; } });
    b = propagate(b);
  };
  score("k:0:0", 1); score("k:0:1", 1); score("k:1:0", 1); score("k:third", 2);
  return { groups: [], groupMatches: [], bracket: b };
}
const scoreIn = (id, events) => (d) => {
  [...d.bracket.rounds.flat(), d.bracket.third].forEach((m) => {
    if (m.id === id) { m.events = events; m.done = events.length > 0; }
  });
  d.bracket = propagate(d.bracket);
  return d;
};
{
  const t = knockout();
  check("the final and third place are played", [t.bracket.rounds[1][0].p1, t.bracket.rounds[1][0].p2, t.bracket.third.p1], ["A", "C", "B"]);
  check("clearing a semi while the final has a result wipes the final and third place",
    ids(lostResults(t, scoreIn("k:0:0", [])(clone(t)), ["k:0:0"])), ["k:1:0", "k:third"]);
  check("re-scoring a semi the other way does too",
    ids(lostResults(t, scoreIn("k:0:0", win(2))(clone(t)), ["k:0:0"])), ["k:1:0", "k:third"]);
  check("re-scoring a semi to the same winner wipes nothing",
    lostResults(t, scoreIn("k:0:0", win(1).slice(0, 4))(clone(t)), ["k:0:0"]), []);
  const step1 = scoreIn("k:1:0", [])(clone(t));
  check("the final can be cleared on its own", lostResults(t, step1, ["k:1:0"]), []);
  const step2 = scoreIn("k:third", [])(clone(step1));
  check("then third place", lostResults(step1, step2, ["k:third"]), []);
  check("and then the semi", lostResults(step2, scoreIn("k:0:0", [])(clone(step2)), ["k:0:0"]), []);
}
{
  const t = knockout();
  const swap = (d) => { d.bracket = setRound(d.bracket, 0, [["A", "C"], ["B", "D"]]); return d; };
  check("setting the opening round by hand wipes everything it changes",
    ids(lostResults(t, swap(clone(t)))), ["k:0:0", "k:0:1", "k:1:0", "k:third"]);
  check("dropping the bracket wipes every knockout result",
    ids(lostResults(t, ((d) => { d.bracket = null; return d; })(clone(t)))), ["k:0:0", "k:0:1", "k:1:0", "k:third"]);
  check("a change that touches no result wipes nothing",
    lostResults(t, ((d) => { d.name = "Renamed"; return d; })(clone(t))), []);
}

/* ---- the switch ---- */
check("on unless switched off", [protects({}), protects({ protectResults: true }), protects({ protectResults: false })], [true, true, false]);

console.log(fails ? `\n${fails} FAILED` : "\nAll protection checks passed.");
process.exit(fails ? 1 : 0);
