/*
 * Decks: how a combo is written, how typed parts are recognised, and the rule
 * that no part appears twice in one deck.
 *
 *   node tests/deck.test.mjs
 */
import {
  comboLabel, canonicalPart, cleanDeck, deckConflicts, deckSize, partOptions, COMBO_TYPES, bitHasRatchet,
  lockIsMetal,
} from "../src/deck.js";
import * as P from "../src/parts.js";

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

/* ---- the shape of each line ---- */
check("BX and UX are blade, ratchet, bit", COMBO_TYPES.bx.slots, ["blade", "ratchet", "bit"]);
check("UX Infinity has no ratchet", COMBO_TYPES.inf.slots, ["blade", "bit"]);
check("BX Infinity keeps its ratchet: Dran Strike is a BX / UX blade",
  [partOptions("bx", "blade").some((p) => p.name === "Dran Strike"),
   partOptions("inf", "blade").some((p) => p.name === "Dran Strike")],
  [true, false]);
check("Dran Strike FF with a ratchet (BX-49)",
  comboLabel({ type: "bx", blade: "Dran Strike", ratchet: "3-60", bit: "Free Flat" }), "Dran Strike 3-60FF");
check("CX is lock chip, main blade, assist blade, ratchet, bit",
  COMBO_TYPES.cx.slots, ["lock", "main", "assist", "ratchet", "bit"]);
check("CX Infinity adds the over blade",
  COMBO_TYPES.cxi.slots, ["lock", "main", "over", "assist", "ratchet", "bit"]);
check("three combos for groups and leagues", [deckSize("knockout"), deckSize("league")], [3, 3]);
check("four for a tag team", deckSize("tag"), 4);

/* ---- written as the hobby writes them, matched against real products ---- */
check("Dran Sword 3-60F (BX-01)", comboLabel({ type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "Flat" }), "Dran Sword 3-60F");
check("Glory Valkyrie R (UX Infinity)", comboLabel({ type: "inf", blade: "Glory Valkyrie", bit: "Rush" }), "Glory Valkyrie R");
check("Brave S6-60V (CX-01, less its lock chip)",
  comboLabel({ type: "cx", main: "Brave", assist: "Slash", ratchet: "6-60", bit: "Vortex" }), "Brave S6-60V");
check("Blitz BK1-50I (CX-13)",
  comboLabel({ type: "cxi", main: "Blitz", over: "Break", assist: "Knuckle", ratchet: "1-50", bit: "Ignition" }), "Blitz BK1-50I");
check("Blast ATr - Turbo carries its own ratchet (CX-07)",
  comboLabel({ type: "cx", main: "Blast", assist: "Assault", bit: "Turbo" }), "Blast ATr");
check("Wizard Rod 1-60Nr (two-letter bit)",
  comboLabel({ type: "bx", blade: "Wizard Rod", ratchet: "1-60", bit: "Narrow" }), "Wizard Rod 1-60Nr");
check("a part not in the catalogue is written in full",
  comboLabel({ type: "bx", blade: "Brand New", ratchet: "3-60", bit: "Mystery" }), "Brand New 3-60 Mystery");
check("a half-built combo shows what it has", comboLabel({ type: "bx", blade: "Dran Sword" }), "Dran Sword");
check("parts a type does not have are ignored",
  comboLabel({ type: "inf", blade: "Glory Valkyrie", ratchet: "3-60", bit: "Rush" }), "Glory Valkyrie R");

/* ---- typed parts recognised ---- */
check("a bit by its letters", canonicalPart("bit", "lf"), "Low Flat");
check("a bit in any case", canonicalPart("bit", "LOW flat"), "Low Flat");
check("a ratchet without its dash", canonicalPart("ratchet", "360"), "3-60");
check("a ratchet with a space", canonicalPart("ratchet", "3 60"), "3-60");
check("an assist blade by its letter", canonicalPart("assist", "k"), "Knuckle");
check("an unknown part is kept, trimmed", canonicalPart("bit", "  Mystery "), "Mystery");
check("blank is blank", canonicalPart("bit", "   "), "");
check("an Infinity blade is still recognised as a blade", canonicalPart("blade", "glory valkyrie"), "Glory Valkyrie");

/* ---- no part twice ---- */
const ok = [
  { type: "bx", blade: "Wizard Rod", ratchet: "1-60", bit: "Narrow" },
  { type: "bx", blade: "Shark Scale", ratchet: "3-60", bit: "Low Rush" },
  { type: "inf", blade: "Glory Valkyrie", bit: "Rush" },
];
check("a legal deck has no conflicts", deckConflicts(ok), []);
check("the same blade twice",
  deckConflicts([...ok.slice(0, 2), { type: "bx", blade: "wizard rod", ratchet: "5-60", bit: "Point" }])
    .map((x) => [x.slot, x.part, x.combos]),
  [["blade", "Wizard Rod", [0, 2]]]);
check("the same ratchet across two lines is still the same part",
  deckConflicts([ok[0], { type: "cx", main: "Brave", assist: "Slash", ratchet: "1-60", bit: "Vortex" }])
    .map((x) => [x.slot, x.part]),
  [["ratchet", "1-60"]]);
check("the same bit typed two ways",
  deckConflicts([
    { type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "LF" },
    { type: "bx", blade: "Shark Edge", ratchet: "4-60", bit: "low flat" },
  ]).map((x) => [x.slot, x.part]),
  [["bit", "Low Flat"]]);
check("several conflicts are all reported",
  deckConflicts([
    { type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "Flat" },
    { type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "Ball" },
  ]).map((x) => x.slot),
  ["blade", "ratchet"]);
check("blank parts never conflict",
  deckConflicts([{ type: "bx", blade: "Dran Sword" }, { type: "bx", blade: "Shark Edge" }]), []);
check("a Turbo combo without a ratchet does not clash with one that has none",
  deckConflicts([
    { type: "cx", main: "Blast", assist: "Assault", bit: "Turbo" },
    { type: "inf", blade: "Glory Valkyrie", bit: "Rush" },
  ]), []);

/* ---- what is kept ---- */
check("empty combos are left out, parts put in catalogue form",
  cleanDeck([
    { type: "bx", blade: "dran sword", ratchet: "360", bit: "f" },
    { type: "cx" },
    { type: "inf", blade: "Glory Valkyrie", ratchet: "3-60", bit: "R" },
  ]),
  [
    { type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "Flat" },
    { type: "inf", blade: "Glory Valkyrie", bit: "Rush" },
  ]);

/* ---- the catalogue itself ---- */
const dupes = (list) => {
  const n = list.map((x) => (typeof x === "string" ? x : x.name).toLowerCase());
  return n.filter((x, i) => n.indexOf(x) !== i);
};
for (const [name, list] of Object.entries(P)) {
  check(`no name listed twice in ${name}`, dupes(list), []);
}
for (const [name, list] of [["OVER_BLADES", P.OVER_BLADES], ["ASSIST_BLADES", P.ASSIST_BLADES], ["BITS", P.BITS]]) {
  const a = list.map((x) => x.abbr.toLowerCase());
  check(`no two ${name} share letters`, a.filter((x, i) => a.indexOf(x) !== i), []);
}
check("Infinity blades are offered only for Infinity combos",
  partOptions("bx", "blade").some((p) => p.name === "Glory Valkyrie"), false);
check("metal blades are offered only for CX Infinity",
  [partOptions("cx", "main").some((p) => p.name === "Blitz"), partOptions("cxi", "main").some((p) => p.name === "Blitz")],
  [false, true]);

/* ---- bits fused with a ratchet ---- */
check("Turbo comes with its own ratchet", bitHasRatchet("Turbo"), true);
check("by its letters too", bitHasRatchet("tr"), true);
check("an ordinary bit does not", bitHasRatchet("Flat"), false);
check("a ratchet left in a fused-bit combo is dropped",
  cleanDeck([{ type: "cx", main: "Blast", assist: "Assault", ratchet: "3-60", bit: "Turbo" }]),
  [{ type: "cx", main: "Blast", assist: "Assault", bit: "Turbo" }]);
check("so it cannot clash with a ratchet used elsewhere",
  deckConflicts([
    { type: "cx", main: "Blast", assist: "Assault", ratchet: "3-60", bit: "Turbo" },
    { type: "bx", blade: "Dran Sword", ratchet: "3-60", bit: "Flat" },
  ]), []);
check("and is not written into its name",
  comboLabel({ type: "cx", main: "Blast", assist: "Assault", ratchet: "3-60", bit: "Turbo" }), "Blast ATr");

/* ---- lock chips ---- */
check("Dran Brave S6-60V, the full product name (CX-01)",
  comboLabel({ type: "cx", lock: "Dran", main: "Brave", assist: "Slash", ratchet: "6-60", bit: "Vortex" }), "Dran Brave S6-60V");
check("Bahamut Blitz BK1-50I (CX-13)",
  comboLabel({ type: "cxi", lock: "Bahamut", main: "Blitz", over: "Break", assist: "Knuckle", ratchet: "1-50", bit: "Ignition" }),
  "Bahamut Blitz BK1-50I");
check("Pegasus Blast ATr (CX-07)",
  comboLabel({ type: "cx", lock: "pegasus", main: "Blast", assist: "A", bit: "Tr" }), "Pegasus Blast ATr");
check("Emperor and Valkyrie are the metal lock chips",
  [lockIsMetal("Emperor"), lockIsMetal("valkyrie"), lockIsMetal("Dran")], [true, true, false]);
check("the same lock chip twice is allowed",
  deckConflicts([
    { type: "cx", lock: "Dran", main: "Brave", assist: "Slash", ratchet: "6-60", bit: "Vortex" },
    { type: "cx", lock: "Dran", main: "Arc", assist: "Round", ratchet: "4-55", bit: "Low Orb" },
  ]), []);
check("one metal lock chip is allowed",
  deckConflicts([
    { type: "cx", lock: "Emperor", main: "Might", assist: "Heavy", bit: "Operate" },
    { type: "cx", lock: "Dran", main: "Brave", assist: "Slash", ratchet: "6-60", bit: "Vortex" },
  ]), []);
check("two metal lock chips are not",
  deckConflicts([
    { type: "cx", lock: "Emperor", main: "Might", assist: "Heavy", bit: "Operate" },
    { type: "cx", lock: "Valkyrie", main: "Volt", assist: "Slash", ratchet: "6-60", bit: "Vortex" },
  ]).map((x) => [x.rule, x.part, x.combos]),
  [["metal", "Emperor and Valkyrie", [0, 1]]]);
check("nor the same metal lock chip twice",
  deckConflicts([
    { type: "cx", lock: "Emperor", main: "Might", assist: "Heavy", bit: "Operate" },
    { type: "cxi", lock: "Emperor", main: "Blitz", over: "Break", assist: "Knuckle", ratchet: "1-50", bit: "Ignition" },
  ]).map((x) => x.rule),
  ["metal"]);
check("Operate comes fused with its own ratchet", bitHasRatchet("Operate"), true);

console.log(fails ? `\n${fails} FAILED` : "\nAll deck checks passed.");
process.exit(fails ? 1 : 0);
