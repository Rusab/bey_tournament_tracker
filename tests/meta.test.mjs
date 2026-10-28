/*
 * The meta table: deck credit, podium order, and win rates held back until
 * enough decks stand behind them.
 *
 *   node tests/meta.test.mjs
 */
import { metaTable, bladeOf, sortRows, MIN_DECKS } from "../src/meta.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

const bx = (blade, ratchet = "3-60", bit = "Flat") => ({ type: "bx", blade, ratchet, bit });
const cx = (lock, main, assist = "Slash", ratchet = "4-60", bit = "Low Flat") => ({ type: "cx", lock, main, assist, ratchet, bit });

check("a blade is named as itself", bladeOf(bx("Dran Sword")).name, "Dran Sword");
check("a custom line blade is its lock chip and main blade", bladeOf(cx("Pegasus", "Blast")).name, "Pegasus Blast");
check("its picture is the main blade's", [bladeOf(cx("Pegasus", "Blast")).slot, bladeOf(cx("Pegasus", "Blast")).part], ["main", "Blast"]);

const entries = [
  // Tournament A: Dran Sword wins it, Wizard Rod second, Pegasus Blast third.
  { eventId: "A", deck: [bx("Dran Sword"), bx("Wizard Rod", "9-60", "Ball")], place: 1, topCut: true, wins: 5, losses: 1 },
  { eventId: "A", deck: [bx("Wizard Rod"), bx("Hells Scythe")], place: 2, topCut: true, wins: 4, losses: 2 },
  { eventId: "A", deck: [cx("Pegasus", "Blast"), bx("Hells Scythe", "4-60", "Taper")], place: 3, topCut: true, wins: 3, losses: 3 },
  { eventId: "A", deck: [bx("Hells Scythe")], place: null, topCut: false, wins: 0, losses: 4 },
  // Tournament B: Wizard Rod wins.
  { eventId: "B", deck: [bx("Wizard Rod")], place: 1, topCut: true, wins: 3, losses: 0 },
  // A blader who entered no deck counts for nothing.
  { eventId: "B", deck: [], place: 2, topCut: true, wins: 2, losses: 1 },
];
const t = metaTable(entries);
const blade = (n) => t.blades.find((b) => b.name === n);

check("decks counted are entries with a deck", t.decks, 5);
check("tournaments with decks", t.events, 2);
check("a blade is credited once per deck, however many combos use it",
  [blade("Wizard Rod").decks, blade("Hells Scythe").decks], [3, 3]);
check("podium places by deck credit", [blade("Wizard Rod").first, blade("Wizard Rod").second], [2, 1]);
check("podium order: 3 for 1st, 2 for 2nd, 1 for 3rd",
  t.blades.map((b) => `${b.name} ${b.points}`),
  ["Wizard Rod 8", "Hells Scythe 3", "Dran Sword 3", "Pegasus Blast 1"]);
check("ties on points go to top cuts first",
  [blade("Hells Scythe").topCut, blade("Dran Sword").topCut], [2, 1]);
check("usage is a share of all decks", blade("Hells Scythe").usage, 3 / 5);
check("match wins and losses follow the deck", [blade("Hells Scythe").wins, blade("Hells Scythe").losses], [7, 9]);
check(`no win rate under ${MIN_DECKS} decks`, blade("Wizard Rod").winRate, null);

check("combos are told apart by every part",
  t.combos.filter((c) => c.blade === "wizard rod").map((c) => c.name).sort(),
  ["Wizard Rod 3-60F", "Wizard Rod 9-60B"]);
check("each combo knows its blade", t.combos.find((c) => c.name.startsWith("Pegasus")).blade, "pegasus blast");

{
  const many = Array.from({ length: 6 }, (_, i) => ({ eventId: "E" + i, deck: [bx("Shark Edge")], place: null, topCut: false, wins: 2, losses: 1 }));
  const m = metaTable([...many, ...entries]);
  const shark = m.blades.find((b) => b.name === "Shark Edge");
  check(`a win rate once ${MIN_DECKS} decks stand behind it`, Math.round(shark.winRate * 1000) / 1000, 0.667);
  check("sorted by win rate, rows without one go last",
    sortRows(m.blades, "winRate").map((b) => b.name)[0], "Shark Edge");
  check("sorted by decks", sortRows(m.blades, "decks")[0].name, "Shark Edge");
}

check("nothing in, nothing out", metaTable([]), { decks: 0, events: 0, blades: [], combos: [] });

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
