/*
 * Decks: the beyblades a player brings to a tournament, and the one rule a
 * deck has - no part may appear twice in it.
 *
 * A combo is { type, blade, main, over, assist, ratchet, bit }, holding only
 * the parts its type has:
 *
 *   bx   Basic and Unique Line         blade, ratchet, bit
 *   inf  Unique Line Infinity          blade, bit (Basic Line Infinity is a bx)
 *   cx   Custom Line                   main blade, assist blade, ratchet, bit
 *   cxi  Custom Line Infinity          main blade, over blade, assist blade, ratchet, bit
 *
 * Every part is optional - a deck is a record kept for interest, not a gate
 * on playing - and the ratchet especially, since a bit like Turbo carries its
 * own. Parts are stored by name, as typed or as chosen from the catalogue.
 */
import {
  BLADES, INFINITY_BLADES, MAIN_BLADES, METAL_BLADES,
  OVER_BLADES, ASSIST_BLADES, RATCHETS, BITS,
} from "./parts.js";

export const COMBO_TYPES = {
  bx: { label: "BX / UX", slots: ["blade", "ratchet", "bit"] },
  inf: { label: "UX Infinity", slots: ["blade", "bit"] },
  cx: { label: "CX", slots: ["main", "assist", "ratchet", "bit"] },
  cxi: { label: "CX Infinity", slots: ["main", "over", "assist", "ratchet", "bit"] },
};

export const SLOT_LABEL = {
  blade: "Blade", main: "Main Blade", over: "Over Blade",
  assist: "Assist Blade", ratchet: "Ratchet", bit: "Bit",
};

/** Three for a groups tournament or a league, four for a tag team. */
export const deckSize = (format) => (format === "tag" ? 4 : 3);

const named = (list) => list.map((x) => (typeof x === "string" ? { name: x } : x));

/** The catalogue entries offered for one part of one kind of combo. */
export function partOptions(type, slot) {
  if (slot === "blade") return named(type === "inf" ? INFINITY_BLADES : BLADES);
  if (slot === "main") return named(type === "cxi" ? METAL_BLADES : MAIN_BLADES);
  if (slot === "over") return OVER_BLADES;
  if (slot === "assist") return ASSIST_BLADES;
  if (slot === "ratchet") return named(RATCHETS);
  if (slot === "bit") return BITS;
  return [];
}

/** Everything of one kind, whatever the line, for recognising a typed name. */
const allOf = (slot) => {
  if (slot === "blade") return named([...BLADES, ...INFINITY_BLADES]);
  if (slot === "main") return named([...MAIN_BLADES, ...METAL_BLADES]);
  return partOptions("cxi", slot);
};

/** Case, spaces and dashes do not make a different part: "3-60" is "360". */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A typed part as the catalogue names it, if it is in the catalogue - so
 * "lf", "Low flat" and "LOW FLAT" all become "Low Flat". A name the catalogue
 * does not know is kept as typed, trimmed.
 */
export function canonicalPart(slot, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const n = norm(v);
  const hit = allOf(slot).find((p) => norm(p.name) === n || (p.abbr && norm(p.abbr) === n));
  return hit ? hit.name : v;
}

const abbrOf = (slot, name) => {
  const hit = allOf(slot).find((p) => p.name === name);
  return hit && hit.abbr ? hit.abbr : name;
};

/** Whether this bit comes fused with its own ratchet. */
export const bitHasRatchet = (bit) => {
  const name = canonicalPart("bit", bit);
  return !!BITS.find((b) => b.name === name && b.fused);
};

export const emptyCombo = (type = "bx") => ({ type });

/** Only the parts this combo's type has, each in catalogue form, blanks dropped. */
export function cleanCombo(c) {
  const type = COMBO_TYPES[c && c.type] ? c.type : "bx";
  const out = { type };
  COMBO_TYPES[type].slots.forEach((slot) => {
    const v = canonicalPart(slot, c[slot]);
    if (v) out[slot] = v;
  });
  // A bit with a ratchet of its own leaves no room for another.
  if (out.bit && bitHasRatchet(out.bit)) delete out.ratchet;
  return out;
}

export const comboIsEmpty = (c) => COMBO_TYPES[c.type].slots.every((s) => !c[s]);

/** A deck ready to keep: every combo cleaned, empty ones left out. */
export const cleanDeck = (deck) => (deck || []).map(cleanCombo).filter((c) => !comboIsEmpty(c));

/**
 * A combo written the way the hobby writes it:
 *   Dran Sword 3-60F, Glory Valkyrie R, Brave S6-60V, Blitz BK1-50I.
 * A part not in the catalogue has no letter to stand for it, so it is
 * written out in full.
 */
export function comboLabel(c) {
  const p = cleanCombo(c);
  // A part the catalogue knows is written as its letters; one it does not, in full.
  const piece = (slot) => {
    if (!p[slot]) return "";
    const a = abbrOf(slot, p[slot]);
    return a === p[slot] ? ` ${a} ` : a;
  };
  const tidy = (s) => s.replace(/ +/g, " ").trim();
  if (p.type === "bx") return tidy(`${p.blade || ""} ${p.ratchet || ""}${piece("bit")}`);
  if (p.type === "inf") return tidy(`${p.blade || ""} ${piece("bit")}`);
  const code = `${p.type === "cxi" ? piece("over") : ""}${piece("assist")}${p.ratchet || ""}${piece("bit")}`;
  return tidy(`${p.main || ""} ${code}`);
}

/**
 * Every part that appears more than once in a deck: [{ slot, part, combos }],
 * combos being the indexes it appears in. An empty list is a legal deck.
 *
 * A part is the same part on any line - a 3-60 is a 3-60 whether it sits
 * under a Basic Line blade or a Custom Line one - so parts are compared by
 * kind, not by combo type.
 */
export function deckConflicts(deck) {
  const seen = new Map();
  (deck || []).forEach((c, i) => {
    const p = cleanCombo(c);
    COMBO_TYPES[p.type].slots.forEach((slot) => {
      if (!p[slot]) return;
      const key = `${slot}|${norm(p[slot])}`;
      if (!seen.has(key)) seen.set(key, { slot, part: p[slot], combos: [] });
      seen.get(key).combos.push(i);
    });
  });
  return [...seen.values()].filter((x) => x.combos.length > 1);
}
