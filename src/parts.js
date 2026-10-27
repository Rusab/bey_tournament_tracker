/*
 * The Beyblade X parts catalogue.
 *
 * Takara Tomy names, as used in tournament play. Compiled in October 2026
 * from beyblade.wiki's part lists:
 *   https://beyblade.wiki/list-of-beyblade-x-blades/
 *   https://beyblade.wiki/list-of-beyblade-x-ratchets/
 *   https://beyblade.wiki/list-of-beyblade-x-bits/
 *   https://beyblade.wiki/list-of-beyblade-x-main-blades/
 *   https://beyblade.wiki/list-of-beyblade-x-assist-blades/
 *   https://beyblade.wiki/list-of-beyblade-x-over-blades/
 * and, where a list was silent, from the official product names in
 *   https://beyblade.wiki/beyblade-x-list/
 *
 * This is a suggestion list, not a gate: any part box also takes a name typed
 * in, so a part missing here never stops a deck from being entered.
 *
 * The catalogue now lives in the database (supabase/parts-schema.sql) and is
 * edited from the app's Parts screen. These lists are the built-in fallback,
 * used until the database copy loads and whenever it cannot be reached;
 * setCatalogue() swaps the database copy in.
 *
 * Abbreviations are the letters used in a combo's written name, as in
 * "Dran Sword 3-60F" or "Bahamut Blitz BK1-50I".
 */

/*
 * Basic Line (BX) and Unique Line (UX) blades: blade, ratchet, bit. Dran
 * Strike is Basic Line Infinity, which keeps its ratchet, so it is here.
 */
export let BLADES = [
  // Basic Line
  "Black Shell", "Cobalt Dragoon", "Cobalt Drake", "Crimson Garuda", "Dran Dagger",
  "Dran Strike", "Dran Sword", "Dranzer Spiral", "Hells Chain", "Hells Scythe", "Knight Lance",
  "Knight Shield", "Leon Claw", "Mammoth Tusk", "Phoenix Feather", "Phoenix Wing",
  "Rhino Horn", "Samurai Calibur", "Samurai Steel", "Shark Edge", "Shelter Drake",
  "Sphinx Cowl", "Tricera Press", "Tyranno Beat", "Tyranno Roar", "Unicorn Sting",
  "Viper Tail", "Weiss Tiger", "Whale Wave", "Wizard Arrow", "Wyvern Gale",
  // Unique Line
  "Aero Pegasus", "Clock Mirage", "Dran Buster", "Ghost Circle", "Golem Rock",
  "Hells Hammer", "Impact Drake", "Knight Mail", "Leon Crest", "Meteor Dragoon",
  "Mummy Curse", "Orochi Cluster", "Phoenix Rudder", "Samurai Saber", "Scorpio Spear",
  "Shark Scale", "Shinobi Shadow", "Silver Wolf", "Wizard Rod", "Wyvern Hover",
];

/* Unique Line Infinity blades (UX-19, UX-20): blade and bit, no ratchet. */
export let INFINITY_BLADES = ["Bullet Griffon", "Glory Valkyrie", { name: "HellsNether", aliases: ["Hells Nether", "Hell's Nether"] }];

/*
 * Custom Line lock chips, Infinity included
 * (https://beyblade.wiki/beyblade-x-lock-chips/). A lock chip may repeat in a
 * deck, but only one of the metal ones - Emperor, or Valkyrie from Valkyrie
 * Volt - may be in a deck at all.
 */
export let LOCK_CHIPS = [
  { name: "Bahamut" }, { name: "Brachio" }, { name: "Cerberus" }, { name: "Croco" }, { name: "Dran" },
  { name: "Emperor", metal: true }, { name: "Fox" }, { name: "Hells" }, { name: "Knight" },
  { name: "Pegasus" }, { name: "Perseus" }, { name: "Ragna" }, { name: "Rhino" },
  { name: "Sol" }, { name: "Unicorn" }, { name: "Valkyrie", metal: true }, { name: "Wizard" },
  { name: "Wolf" },
];

/* Custom Line (CX) main blades: lock chip, main blade, assist blade, ratchet, bit. */
export let MAIN_BLADES = [
  "Arc", "Blast", "Brave", "Brush", "Dark", "Eclipse", "Flame", "Hunt", "Might", "Reaper", "Volt",
];

/*
 * Custom Line Infinity main blades - the metal half of an Expand Blade, worn
 * with an over blade. Not on any of the lists; taken from the product names
 * CX-13 to CX-18 and confirmed by hand (CX-13 is Blitz, not "Bliz").
 */
export let METAL_BLADES = ["Blitz", "Delta", "Fortress", "Rage", "Tread", "Whip"];

/* Custom Line Infinity over blades. */
export let OVER_BLADES = [
  { name: "Break", abbr: "B" }, { name: "Flow", abbr: "F" }, { name: "Guard", abbr: "G" },
  { name: "Outer", abbr: "O" }, { name: "Peak", abbr: "P" }, { name: "Tough", abbr: "T" },
];

/* Custom Line assist blades, Infinity included. Brachio Whip's W is Wheel. */
export let ASSIST_BLADES = [
  { name: "Assault", abbr: "A" }, { name: "Bumper", abbr: "B" }, { name: "Charge", abbr: "C" },
  { name: "Dual", abbr: "D" }, { name: "Erase", abbr: "E" }, { name: "Free", abbr: "F" },
  { name: "Heavy", abbr: "H" }, { name: "Jaggy", abbr: "J" }, { name: "Knuckle", abbr: "K" },
  { name: "Odd", abbr: "O" }, { name: "Quell", abbr: "Q" }, { name: "Round", abbr: "R" }, { name: "Slash", abbr: "S" },
  { name: "Turn", abbr: "T" }, { name: "Vertical", abbr: "V" }, { name: "Wheel", abbr: "W" },
];

/* Ratchets fit every line that has one. */
export let RATCHETS = [
  "0-60", "0-70", "0-80", "1-50", "1-60", "1-70", "1-80", "2-60", "2-70", "2-80",
  "3-60", "3-70", "3-80", "3-85", "4-50", "4-55", "4-60", "4-70", "4-80", "5-60",
  "5-50", "5-70", "5-80", "6-60", "6-70", "6-80", "7-55", "7-60", "7-80", "8-70", "9-60",
  "9-65", "9-70", "9-80", "M-85",
];

/*
 * Bits fit every line. A bit marked `fused` comes joined to its own ratchet,
 * so a combo using it has no separate ratchet: Turbo (CX-07, Pegasus Blast
 * ATr) and Operate. Mark any other fused bit the same way.
 */
export let BITS = [
  { name: "Accel", abbr: "A" }, { name: "Ball", abbr: "B" }, { name: "Bound Spike", abbr: "BS" },
  { name: "Cyclone", abbr: "C" }, { name: "Disk Ball", abbr: "DB" }, { name: "Elevate", abbr: "E" },
  { name: "Flat", abbr: "F" }, { name: "Free Ball", abbr: "FB" }, { name: "Free Flat", abbr: "FF" },
  { name: "Gear Ball", abbr: "GB" }, { name: "Gear Flat", abbr: "GF" }, { name: "Gear Needle", abbr: "GN" },
  { name: "Gear Point", abbr: "GP" }, { name: "Gear Rush", abbr: "GR" }, { name: "Gear Unite", abbr: "GU" },
  { name: "Glide", abbr: "G" }, { name: "Hexa", abbr: "H" }, { name: "High Needle", abbr: "HN" },
  { name: "High Taper", abbr: "HT" }, { name: "Ignition", abbr: "I" }, { name: "Jolt", abbr: "J" },
  { name: "Kick", abbr: "K" }, { name: "Level", abbr: "L" }, { name: "Low Flat", abbr: "LF" },
  { name: "Low Orb", abbr: "LO" }, { name: "Low Rush", abbr: "LR" }, { name: "Merge", abbr: "M" },
  { name: "Metal Needle", abbr: "MN" }, { name: "Narrow", abbr: "Nr" }, { name: "Needle", abbr: "N" },
  { name: "Operate", abbr: "Op", fused: true }, { name: "Orb", abbr: "O" }, { name: "Point", abbr: "P" },
  { name: "Quake", abbr: "Q" }, { name: "Rush", abbr: "R" }, { name: "Spike", abbr: "S" },
  { name: "Taper", abbr: "T" }, { name: "Trans Kick", abbr: "TK" }, { name: "Trans Point", abbr: "TP" },
  { name: "Turbo", abbr: "Tr", fused: true }, { name: "Under Flat", abbr: "UF" }, { name: "Under Needle", abbr: "UN" },
  { name: "Unite", abbr: "U" }, { name: "Vortex", abbr: "V" }, { name: "Wall Ball", abbr: "WB" },
  { name: "Wedge", abbr: "W" }, { name: "Yielding", abbr: "Y" }, { name: "Zap", abbr: "Z" },
];

/* ------------------------------------------------------------ the catalogue */

/** The kinds of part, as the database names them, and the list each fills. */
export const PART_KINDS = [
  { key: "blade", label: "Blades", hint: "Basic and Unique Line" },
  { key: "infinity_blade", label: "Infinity Blades", hint: "Unique Line Infinity" },
  { key: "lock_chip", label: "Lock Chips", hint: "Custom Line" },
  { key: "main_blade", label: "Main Blades", hint: "Custom Line" },
  { key: "metal_blade", label: "Metal Blades", hint: "Custom Line Infinity" },
  { key: "over_blade", label: "Over Blades", hint: "Custom Line Infinity", abbr: true },
  { key: "assist_blade", label: "Assist Blades", hint: "Custom Line", abbr: true },
  { key: "ratchet", label: "Ratchets" },
  { key: "bit", label: "Bits", abbr: true },
];

const asPart = (x) => (typeof x === "string" ? { name: x } : x);
const BUILT_IN = {
  blade: BLADES, infinity_blade: INFINITY_BLADES, lock_chip: LOCK_CHIPS, main_blade: MAIN_BLADES,
  metal_blade: METAL_BLADES, over_blade: OVER_BLADES, assist_blade: ASSIST_BLADES, ratchet: RATCHETS, bit: BITS,
};

function install(byKind) {
  BLADES = byKind.blade; INFINITY_BLADES = byKind.infinity_blade; LOCK_CHIPS = byKind.lock_chip;
  MAIN_BLADES = byKind.main_blade; METAL_BLADES = byKind.metal_blade; OVER_BLADES = byKind.over_blade;
  ASSIST_BLADES = byKind.assist_blade; RATCHETS = byKind.ratchet; BITS = byKind.bit;
}

/**
 * Swaps in the catalogue from the database: rows of
 * { id, kind, name, abbr, fused, metal, aliases, image_path }. Returns false,
 * and keeps the built-in lists, if there is nothing to swap in.
 */
export function setCatalogue(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const byKind = Object.fromEntries(PART_KINDS.map((k) => [k.key, []]));
  rows.forEach((r) => {
    if (!byKind[r.kind]) return;
    const part = { id: r.id, name: r.name };
    if (r.abbr) part.abbr = r.abbr;
    if (r.fused) part.fused = true;
    if (r.metal) part.metal = true;
    if (r.aliases && r.aliases.length) part.aliases = r.aliases;
    if (r.image_path) part.image = r.image_path;
    byKind[r.kind].push(part);
  });
  Object.values(byKind).forEach((list) =>
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
  install(byKind);
  return true;
}

/** Back to the built-in lists. */
export const resetCatalogue = () => install(BUILT_IN);

/** Every part of one kind in the catalogue now in use, as { name, abbr?, ... }. */
export function partsOf(kind) {
  const now = {
    blade: BLADES, infinity_blade: INFINITY_BLADES, lock_chip: LOCK_CHIPS, main_blade: MAIN_BLADES,
    metal_blade: METAL_BLADES, over_blade: OVER_BLADES, assist_blade: ASSIST_BLADES, ratchet: RATCHETS, bit: BITS,
  }[kind] || [];
  return now.map(asPart);
}
