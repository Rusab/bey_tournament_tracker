/*
 * Decks: the beyblades a player brings to a tournament, and the one rule a
 * deck has - no part may appear twice in it.
 *
 * A combo is { type, blade, main, over, assist, ratchet, bit }, holding only
 * the parts its type has:
 *
 *   bx   Basic and Unique Line         blade, ratchet, bit
 *   inf  Unique Line Infinity          blade, bit (Basic Line Infinity is a bx)
 *   cx   Custom Line                   lock chip, main blade, assist blade, ratchet, bit
 *   cxi  Custom Line Infinity          lock chip, main blade, over blade, assist blade, ratchet, bit
 *
 * Every part is optional - a deck is a record kept for interest, not a gate
 * on playing - and the ratchet especially, since a bit like Turbo carries its
 * own. Parts are stored by name, as typed or as chosen from the catalogue.
 */
import {
  BLADES, INFINITY_BLADES, LOCK_CHIPS, MAIN_BLADES, METAL_BLADES,
  OVER_BLADES, ASSIST_BLADES, RATCHETS, BITS,
} from "./parts.js";

export const COMBO_TYPES = {
  bx: { label: "BX / UX", slots: ["blade", "ratchet", "bit"] },
  inf: { label: "UX Infinity", slots: ["blade", "bit"] },
  cx: { label: "CX", slots: ["lock", "main", "assist", "ratchet", "bit"] },
  cxi: { label: "CX Infinity", slots: ["lock", "main", "over", "assist", "ratchet", "bit"] },
};

export const SLOT_LABEL = {
  lock: "Lock Chip", blade: "Blade", main: "Main Blade", over: "Over Blade",
  assist: "Assist Blade", ratchet: "Ratchet", bit: "Bit",
};

/** Three for a groups tournament or a league, four for a tag team. */
export const deckSize = (format) => (format === "tag" ? 4 : 3);

const named = (list) => list.map((x) => (typeof x === "string" ? { name: x } : x));

/** The catalogue entries offered for one part of one kind of combo. */
export function partOptions(type, slot) {
  if (slot === "lock") return LOCK_CHIPS;
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
 * "lf", "Low flat" and "LOW FLAT" all become "Low Flat", and so does any
 * alias the catalogue gives it: a misspelling merged in, or the name it had
 * before it was renamed. A name the catalogue does not know is kept as
 * typed, trimmed.
 */
export function canonicalPart(slot, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const hit = findPart(slot, v);
  return hit ? hit.name : v;
}

/** The catalogue entry a typed name means, or null if it is not in the catalogue. */
export function findPart(slot, value) {
  const n = norm(value);
  if (!n) return null;
  const list = allOf(slot);
  return list.find((p) => norm(p.name) === n)
    || list.find((p) => (p.aliases || []).some((a) => norm(a) === n))
    || list.find((p) => p.abbr && norm(p.abbr) === n)
    || null;
}

/** Which kind of catalogue part fills a slot of a combo of this type. */
export function kindOf(type, slot) {
  if (slot === "blade") return type === "inf" ? "infinity_blade" : "blade";
  if (slot === "main") return type === "cxi" ? "metal_blade" : "main_blade";
  return { lock: "lock_chip", over: "over_blade", assist: "assist_blade", ratchet: "ratchet", bit: "bit" }[slot] || null;
}

const abbrOf = (slot, name) => {
  const hit = allOf(slot).find((p) => p.name === name);
  return hit && hit.abbr ? hit.abbr : name;
};

/** Whether this lock chip is one of the metal ones, of which a deck may hold one. */
export const lockIsMetal = (lock) => {
  const name = canonicalPart("lock", lock);
  return !!LOCK_CHIPS.find((l) => l.name === name && l.metal);
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
  return tidy(`${p.lock || ""} ${p.main || ""} ${code}`);
}

/**
 * Everything that makes a deck illegal: [{ slot, part, combos, rule }], combos
 * being the indexes involved. An empty list is a legal deck.
 *
 * Two rules. No part may appear twice (rule "repeat") - and a part is the
 * same part on any line, so a 3-60 under a Basic Line blade clashes with a
 * 3-60 under a Custom Line one. Lock chips are the exception: they may repeat,
 * except that a deck holds at most one metal lock chip (rule "metal").
 */
export function deckConflicts(deck) {
  const seen = new Map();
  (deck || []).forEach((c, i) => {
    const p = cleanCombo(c);
    COMBO_TYPES[p.type].slots.forEach((slot) => {
      if (!p[slot] || slot === "lock") return;
      const key = `${slot}|${norm(p[slot])}`;
      if (!seen.has(key)) seen.set(key, { slot, part: p[slot], combos: [], rule: "repeat" });
      seen.get(key).combos.push(i);
    });
  });
  const out = [...seen.values()].filter((x) => x.combos.length > 1);

  const metal = (deck || []).map((c, i) => [cleanCombo(c), i])
    .filter(([p]) => p.lock && lockIsMetal(p.lock));
  if (metal.length > 1) {
    out.push({
      slot: "lock", rule: "metal", combos: metal.map(([, i]) => i),
      part: [...new Set(metal.map(([p]) => p.lock))].join(" and "),
    });
  }
  return out;
}
