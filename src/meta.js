/*
 * The meta: which blades and combos are played most, and which win most,
 * across every tournament in the app.
 *
 * Deck credit: whatever a blader's entry earned - a podium place, a place
 * in the knockout, its match wins and losses - counts for every blade and
 * every combo in the deck they entered with. A blade twice in one deck (it
 * cannot be, but an old deck might say so) counts once.
 *
 * Input is a list of entries, one per blader per tournament with a deck:
 *   { eventId, deck: [combo...], place: 1|2|3|null, topCut: bool, wins, losses }
 */
import { cleanCombo, comboLabel, comboIsEmpty } from "./deck.js";

/** Podium points: what orders the table by default. */
export const PODIUM_POINTS = { 1: 3, 2: 2, 3: 1 };
/** A win rate needs at least this many decks behind it to be shown. */
export const MIN_DECKS = 5;

/**
 * A beyblade's blade, as the hobby names it: the blade itself, or for the
 * Custom Line its lock chip and main blade ("Pegasus Blast"). part and slot
 * say which catalogue part's picture to show.
 */
export function bladeOf(combo) {
  const c = cleanCombo(combo || {});
  if (c.type === "cx" || c.type === "cxi") {
    if (!c.main) return null;
    return { name: [c.lock, c.main].filter(Boolean).join(" "), slot: "main", part: c.main, type: c.type };
  }
  return c.blade ? { name: c.blade, slot: "blade", part: c.blade, type: c.type } : null;
}

const blank = (key, extra) => ({
  key, ...extra, decks: 0, first: 0, second: 0, third: 0, topCut: 0, wins: 0, losses: 0, events: new Set(),
});

function credit(row, e) {
  row.decks++;
  if (e.place === 1) row.first++;
  else if (e.place === 2) row.second++;
  else if (e.place === 3) row.third++;
  if (e.topCut) row.topCut++;
  row.wins += e.wins || 0;
  row.losses += e.losses || 0;
  row.events.add(e.eventId);
}

function finish(row, total) {
  const played = row.wins + row.losses;
  return {
    ...row,
    events: row.events.size,
    points: row.first * PODIUM_POINTS[1] + row.second * PODIUM_POINTS[2] + row.third * PODIUM_POINTS[3],
    usage: total ? row.decks / total : 0,
    // Too few decks and one lucky run tops the chart.
    winRate: row.decks >= MIN_DECKS && played ? row.wins / played : null,
  };
}

export const SORTS = {
  points: (a, b) => b.points - a.points || b.topCut - a.topCut || b.decks - a.decks,
  decks: (a, b) => b.decks - a.decks || b.points - a.points,
  topCut: (a, b) => b.topCut - a.topCut || b.points - a.points || b.decks - a.decks,
  // Rows with too few decks for a rate go last, most decks first.
  winRate: (a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.decks - a.decks,
};

export function sortRows(rows, by = "points") {
  const cmp = SORTS[by] || SORTS.points;
  return [...rows].sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** { decks, events, blades, combos }, blades and combos in podium order. */
export function metaTable(entries) {
  const withDecks = (entries || []).filter((e) => (e.deck || []).some((c) => !comboIsEmpty(cleanCombo(c))));
  const blades = new Map(), combos = new Map();

  withDecks.forEach((e) => {
    const seenBlades = new Set(), seenCombos = new Set();
    e.deck.forEach((raw) => {
      const c = cleanCombo(raw);
      if (comboIsEmpty(c)) return;
      const b = bladeOf(c);
      if (b && !seenBlades.has(b.name.toLowerCase())) {
        seenBlades.add(b.name.toLowerCase());
        const k = b.name.toLowerCase();
        if (!blades.has(k)) blades.set(k, blank(k, { name: b.name, slot: b.slot, part: b.part, type: b.type }));
        credit(blades.get(k), e);
      }
      const label = comboLabel(c);
      const ck = label.toLowerCase();
      if (!seenCombos.has(ck)) {
        seenCombos.add(ck);
        if (!combos.has(ck)) combos.set(ck, blank(ck, { name: label, combo: c, blade: b ? b.name.toLowerCase() : null }));
        credit(combos.get(ck), e);
      }
    });
  });

  const total = withDecks.length;
  return {
    decks: total,
    events: new Set(withDecks.map((e) => e.eventId)).size,
    blades: sortRows([...blades.values()].map((r) => finish(r, total))),
    combos: sortRows([...combos.values()].map((r) => finish(r, total))),
  };
}
