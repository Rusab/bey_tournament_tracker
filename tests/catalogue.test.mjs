/*
 * The parts catalogue swapped in from the database: aliases, renames and
 * the deck rules reading whichever catalogue is in use.
 *
 *   node tests/catalogue.test.mjs
 */
import * as P from "../src/parts.js";
import { canonicalPart, findPart, kindOf, comboLabel, deckConflicts, bitHasRatchet, lockIsMetal } from "../src/deck.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

// A database catalogue: the built-in parts, plus a new blade and a merged misspelling.
const rows = [];
P.PART_KINDS.forEach((k) => P.partsOf(k.key).forEach((p) =>
  rows.push({ id: k.key + p.name, kind: k.key, name: p.name, abbr: p.abbr || null, fused: !!p.fused, metal: !!p.metal, aliases: [] })));
rows.push({ id: "new", kind: "blade", name: "Hells Nether", abbr: null, aliases: ["Hell's Nether", "Hels Nether"] });
rows.find((r) => r.kind === "bit" && r.name === "Low Flat").aliases = ["Lowflat"];

check("an empty catalogue is refused, keeping the built-in one", P.setCatalogue([]), false);
check("so Hells Nether is not known yet", findPart("blade", "Hells Nether"), null);

check("a database catalogue is taken", P.setCatalogue(rows), true);
check("a new blade is offered", P.partsOf("blade").some((p) => p.name === "Hells Nether"), true);
check("an alias means the part", canonicalPart("blade", "hell's nether"), "Hells Nether");
check("another alias too", canonicalPart("blade", "Hels Nether"), "Hells Nether");
check("a merged misspelling of a bit", canonicalPart("bit", "lowflat"), "Low Flat");
check("letters still work", canonicalPart("bit", "LF"), "Low Flat");
check("a name nobody knows is kept as typed", canonicalPart("blade", "  Mystery Blade "), "Mystery Blade");
check("and is not a catalogue part", findPart("blade", "Mystery Blade"), null);

check("a combo written with an alias reads as the part",
  comboLabel({ type: "bx", blade: "Hell's Nether", ratchet: "3-60", bit: "lowflat" }), "Hells Nether 3-60LF");
check("an alias and its part are the same part in a deck",
  deckConflicts([{ type: "bx", blade: "Hells Nether" }, { type: "bx", blade: "hell's nether" }]).map((c) => c.part),
  ["Hells Nether"]);
check("fused bits still have their ratchet", bitHasRatchet("Turbo"), true);
check("metal lock chips are still metal", lockIsMetal("Emperor"), true);
check("lists are kept in order", P.partsOf("ratchet").slice(0, 3).map((p) => p.name), ["0-60", "0-70", "0-80"]);

check("deck slots map to catalogue kinds",
  [kindOf("bx", "blade"), kindOf("inf", "blade"), kindOf("cx", "main"), kindOf("cxi", "main"), kindOf("cxi", "over"), kindOf("cx", "lock")],
  ["blade", "infinity_blade", "main_blade", "metal_blade", "over_blade", "lock_chip"]);

P.resetCatalogue();
check("back to the built-in catalogue", findPart("blade", "Hells Nether"), null);
check("which still knows Dran Sword", canonicalPart("blade", "dran sword"), "Dran Sword");

console.log(fails ? `\n${fails} FAILED` : "\nAll catalogue checks passed.");
process.exit(fails ? 1 : 0);
