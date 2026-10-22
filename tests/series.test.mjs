/*
 * A series' grand total ranking.
 *
 *   node tests/series.test.mjs
 */
import { seriesRanking, identityOf } from "../src/series.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

/* A tournament: its players, and a confirmed ranking of [id, name, rank, total, wins]. */
const event = (id, date, players, rows, confirmed = true) => ({
  id, name: `Event ${id}`, created_at: date,
  data: {
    players,
    finalRanking: confirmed ? {
      rows: rows.map(([pid, name, rank, total, wins = 0]) =>
        ({ id: pid, name, rank, total, played: 3, wins, margin: wins * 2 })),
    } : undefined,
  },
});

/* ---- adding up ---- */
const e1 = event("1", "2026-01-01",
  [{ id: "a", name: "Ayo", profileId: "P1" }, { id: "b", name: "Bex", profileId: "P2" }, { id: "c", name: "Cy" }],
  [["a", "Ayo", 1, 10, 3], ["b", "Bex", 2, 6, 2], ["c", "Cy", 3, 2, 1]]);
const e2 = event("2", "2026-02-01",
  // Different player ids and spellings, the same people by profile.
  [{ id: "x", name: "AyoStorm", profileId: "P1" }, { id: "y", name: "Bex", profileId: "P2" }, { id: "z", name: "Dee" }],
  [["y", "Bex", 1, 9, 3], ["x", "AyoStorm", 2, 4, 1], ["z", "Dee", 3, 1, 0]]);

{
  const { rows, counted, waiting } = seriesRanking([e2, e1]);
  check("totals add up across tournaments by profile",
    rows.map((r) => [r.name, r.total]), [["Bex", 15], ["AyoStorm", 14], ["Cy", 2], ["Dee", 1]]);
  check("ranked by grand total", rows.map((r) => r.rank), [1, 2, 3, 4]);
  check("tournaments played each", rows.map((r) => r.tournaments), [2, 2, 1, 1]);
  check("best finish each", rows.map((r) => r.best), [1, 1, 3, 3]);
  check("the newest tournament's name is used", rows[1].name, "AyoStorm");
  check("wins add up too", rows.find((r) => r.name === "Bex").wins, 5);
  check("every tournament counted", counted.map((e) => e.id), ["1", "2"]);
  check("none waiting", waiting.length, 0);
}

/* ---- ties ---- */
{
  const tie = event("3", "2026-03-01",
    [{ id: "a", name: "Ayo" }, { id: "b", name: "Bex" }, { id: "c", name: "Cy" }],
    [["a", "Ayo", 1, 5, 2], ["b", "Bex", 1, 5, 1], ["c", "Cy", 2, 3, 0]]);
  const { rows } = seriesRanking([tie]);
  check("equal grand totals share a rank", rows.map((r) => r.rank), [1, 1, 2]);
  check("and are ordered by wins among themselves", rows.map((r) => r.name), ["Ayo", "Bex", "Cy"]);
}

/* ---- only confirmed rankings count ---- */
{
  const unconfirmed = event("4", "2026-04-01", [{ id: "a", name: "Ayo", profileId: "P1" }],
    [["a", "Ayo", 1, 50]], false);
  const { rows, counted, waiting } = seriesRanking([e1, unconfirmed]);
  check("a tournament without a confirmed ranking adds nothing",
    rows.find((r) => r.profileId === "P1").total, 10);
  check("and is reported as waiting", waiting.map((e) => e.id), ["4"]);
  check("while the rest are counted", counted.map((e) => e.id), ["1"]);
}

/* ---- players without a profile ---- */
{
  const later = event("5", "2026-05-01", [{ id: "q", name: "cy" }], [["q", "cy", 1, 7]]);
  const { rows } = seriesRanking([e1, later]);
  check("an unlinked name is matched by name, any case", rows.find((r) => r.key === "name:cy").total, 9);
  check("and says so", rows.find((r) => r.key === "name:cy").byName, true);
}
{
  // Ayo with no profile in an old tournament, linked in a newer one.
  const old = event("6", "2025-12-01", [{ id: "o", name: "Ayo" }], [["o", "Ayo", 1, 8, 2]]);
  const { rows } = seriesRanking([old, e1]);
  const ayo = rows.filter((r) => r.name === "Ayo" || r.profileId === "P1");
  check("a name-only entry merges into the one profiled blader with that name", ayo.length, 1);
  check("carrying its points", ayo[0].total, 18);
  check("and its tournament", ayo[0].tournaments, 2);
}
{
  // Two different profiled bladers both called Rin: an unlinked Rin is not guessed at.
  const a = event("7", "2026-01-01", [{ id: "r1", name: "Rin", profileId: "R1" }], [["r1", "Rin", 1, 5]]);
  const b = event("8", "2026-02-01", [{ id: "r2", name: "Rin", profileId: "R2" }], [["r2", "Rin", 1, 4]]);
  const c = event("9", "2026-03-01", [{ id: "r3", name: "Rin" }], [["r3", "Rin", 1, 3]]);
  const { rows } = seriesRanking([a, b, c]);
  check("an ambiguous name is left apart", rows.length, 3);
}

/* ---- teams ---- */
{
  const t1 = event("10", "2026-01-01", [{ id: "t", name: "Ronin", members: ["A", "B"] }], [["t", "Ronin", 1, 6]]);
  const t2 = event("11", "2026-02-01", [{ id: "u", name: "ronin", members: ["A", "B"] }], [["u", "ronin", 2, 4]]);
  const { rows } = seriesRanking([t1, t2]);
  check("a team is followed by its name across tournaments", [rows.length, rows[0].total, rows[0].team], [1, 10, true]);
}

check("identity prefers the profile", identityOf({ players: [{ id: "a", name: "Ayo", profileId: "P1" }] }, { id: "a", name: "Ayo" }).key, "profile:P1");
check("an empty series ranks nobody", seriesRanking([]).rows, []);

console.log(fails ? `\n${fails} FAILED` : "\nAll series checks passed.");
process.exit(fails ? 1 : 0);
