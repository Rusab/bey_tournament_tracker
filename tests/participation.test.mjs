/*
 * A blader's record in a tournament, as the profile's Tournaments tab shows it,
 * and the small helpers that decide what counts as an email or a link.
 *
 *   node tests/participation.test.mjs
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

const names = ["isLeague", "num", "scoreOf", "winnerOf", "tieKey", "tieWinner", "tieOrder",
  "computeStandings", "everyMatch", "ordinal", "roundName", "participation",
  "looksLikeEmail", "linkedIds", "isLinked"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { participation, looksLikeEmail, linkedIds, isLinked } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

const pts = (n, side) => [...Array(n)].map(() => ({ side, type: "spin", pts: 1 }));
const played = (id, p1, p2, s1, s2, extra = {}) =>
  ({ id, p1, p2, done: true, events: [...pts(s1, 1), ...pts(s2, 2)], ...extra });
const open = (id, p1, p2) => ({ id, p1, p2, done: false, events: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---- a group stage and a final ----
 * Ayo beats Bex 4-1 in Group A, Cy beats Team D 4-2 in Group B, then Ayo
 * beats Cy 4-3 in the final. Team D is a tag team, its second member linked. */
const final2 = {
  format: "knockout", koSize: 2, advance: 1,
  players: [
    { id: "a", name: "Ayo", profileId: "P1" },
    { id: "b", name: "Bex", profileId: "P2" },
    { id: "c", name: "Cy", profileId: "P3" },
    { id: "d", name: "Team D", members: ["Dee", "Dan"], memberIds: [null, "P5"] },
  ],
  groups: [
    { id: "g0", name: "Group A", playerIds: ["a", "b"] },
    { id: "g1", name: "Group B", playerIds: ["c", "d"] },
  ],
  groupMatches: [
    played("m1", "a", "b", 4, 1, { groupId: "g0" }),
    played("m2", "c", "d", 4, 2, { groupId: "g1" }),
  ],
  bracket: { size: 2, third: null, rounds: [[played("k:0:0", "a", "c", 4, 3)]] },
};

{
  const r = participation(final2, "P1");
  check("the winner is Champion", r.place, "Champion");
  check("and settled", r.settled, true);
  check("their record covers groups and knockout", [r.played, r.wins, r.losses], [2, 2, 0]);
  check("points scored and conceded", [r.pf, r.pa], [8, 4]);
  check("their group place", [r.group.name, r.group.pos, r.group.of], ["Group A", 1, 2]);
}
check("the beaten finalist is Runner-up", participation(final2, "P3").place, "Runner-up");
check("out in the groups", participation(final2, "P2").place, "Group stage");
check("which is settled once the groups are done", participation(final2, "P2").settled, true);
{
  const r = participation(final2, "P5");
  check("a team member is found through the team", r && r.place, "Group stage");
  check("and the team is named", r && r.team, "Team D");
}
check("someone not in it gets nothing", participation(final2, "NOBODY"), null);

{
  const t = clone(final2);
  t.bracket.rounds[0][0] = open("k:0:0", "a", "c");
  const r = participation(t, "P1");
  check("a final not yet played", r.place, "In the final");
  check("is not settled", r.settled, false);
}
{
  const t = clone(final2);
  t.bracket = null;
  check("no bracket yet: still in the group stage", participation(t, "P1").place, "Group stage");
  check("and not settled", participation(t, "P1").settled, false);
}

/* ---- semi-finals and third place ---- */
const semis = {
  ...clone(final2),
  koSize: 4, advance: 2,
  bracket: {
    size: 4,
    rounds: [
      [played("k:0:0", "a", "b", 4, 2), played("k:0:1", "c", "d", 4, 1)],
      [open("k:1:0", "a", "c")],
    ],
    third: open("k:third", "b", "d"),
  },
};
{
  const r = participation(semis, "P2");
  check("beaten in a semi, third place to play", r.place, "Semi-finalist");
  check("is not settled yet", r.settled, false);
}
check("still in it, waiting for the final", participation(semis, "P1").place, "In the final");
{
  const t = clone(semis);
  t.bracket.third = played("k:third", "b", "d", 4, 0);
  check("winning third place", participation(t, "P2").place, "3rd place");
  check("losing it is 4th, for a team member too", participation(t, "P5").place, "4th place");
}
{
  const t = clone(semis);
  t.bracket.third = null;
  check("without a third-place match a semi loser is settled", participation(t, "P2").settled, true);
}

/* ---- a league ----
 * Ayo beats both, Bex beats Cy. Three points a win. */
const league = {
  format: "league", koSize: 0, advance: 1, leaguePoints: { win: "3", draw: "1" },
  players: [
    { id: "a", name: "Ayo", profileId: "P1" },
    { id: "b", name: "Bex", profileId: "P2" },
    { id: "c", name: "Cy", profileId: "P3" },
  ],
  groups: [{ id: "g0", name: "League", playerIds: ["a", "b", "c"] }],
  groupMatches: [
    played("m1", "a", "b", 4, 1, { groupId: "g0" }),
    played("m2", "a", "c", 4, 2, { groupId: "g0" }),
    played("m3", "b", "c", 4, 3, { groupId: "g0" }),
  ],
  bracket: null,
};
{
  const r = participation(league, "P1");
  check("top of the league", r.place, "1st of 3");
  check("with league points", r.group.pts, 6);
  check("and settled when every fixture is played", r.settled, true);
}
check("bottom of the league", participation(league, "P3").place, "3rd of 3");
{
  const t = clone(league);
  t.groupMatches[2] = open("m3", "b", "c");
  t.groupMatches[2].groupId = "g0";
  check("a league with a fixture left is not settled", participation(t, "P1").settled, false);
}

/* ---- what counts as an email ---- */
check("a plain address", looksLikeEmail("ayo@example.com"), true);
check("with stray spaces round it", looksLikeEmail("  ayo@example.com "), true);
check("a name", looksLikeEmail("Ayo"), false);
check("no domain dot", looksLikeEmail("ayo@example"), false);
check("nothing before the @", looksLikeEmail("@example.com"), false);
check("two @", looksLikeEmail("a@b@example.com"), false);
check("a space inside", looksLikeEmail("a yo@example.com"), false);
check("a trailing dot", looksLikeEmail("ayo@example.com."), false);

/* ---- who is linked ---- */
check("links are gathered from bladers and team members",
  [...linkedIds(final2.players)].sort(), ["P1", "P2", "P3", "P5"]);
check("an unlinked player", isLinked({ id: "x", name: "X" }), false);
check("a team with one linked member", isLinked({ members: ["A", "B"], memberIds: [null, "Q"] }), true);

console.log(fails ? `\n${fails} FAILED` : "\nAll participation checks passed.");
process.exit(fails ? 1 : 0);
