import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Shuffle, Plus, X, Trophy, Users, Swords, Table2, Settings,
  Undo2, ArrowLeft, Trash2, AlertTriangle, GitBranch, ChevronRight, Check, Medal, Lock, Unlock, Eye,
  Image as ImageIcon, Download, Crown,
} from "lucide-react";
import { supabase } from "./lib/supabase.js";
import {
  loadEvent, eventStamp, saveEvent, subscribeEvent,
  currentSession, onAuthChange, loadProfile, signIn, signUp, signOut,
  myEvents, createEvent, archiveEvent, deleteEvent,
  eventReferees, addReferee, removeReferee, pendingHosts, approveHost,
} from "./lib/db.js";

/* ================================================================== */
/*  Domain                                                             */
/* ================================================================== */

const FINISHES = [
  { key: "spin", label: "Spin", pts: 1 },
  { key: "over", label: "Over", pts: 2 },
  { key: "burst", label: "Burst", pts: 2 },
  { key: "xtreme", label: "Xtreme", pts: 3 },
];

/* A penalty isn't a finish — it's a point awarded to the blader who didn't
   commit it — so it scores like one but is kept separate everywhere it's
   listed or tallied. */
const PENALTY = { key: "penalty", label: "Penalty", pts: 1 };

/** Everything that can put a point on the board. */
const AWARDS = [...FINISHES, PENALTY];

/** Tolerates unknown keys so old saved tournaments never crash the view. */
const awardOf = (key) => AWARDS.find((a) => a.key === key);

const GROUP_LETTERS = "ABCDEFGH".split("");

/*
 * A league is one group holding everyone, played as a round robin, with no
 * knockout after it — so the fixtures, the scoring and the match views are the
 * ones already here. The only genuinely new part is ranking on league points
 * rather than on wins.
 */
const isLeague = (t) => t && t.format === "league";
const defaultLeaguePoints = () => ({ win: "3", draw: "1" });

/** Which tabs a format has: no groups to draw, and no bracket to build. */
const tabsFor = (t) =>
  isLeague(t) ? ["matches", "table", "players"] : TABS;

/* A team is a competitor like any other; only the wording changes. */
const isTag = (t) => t && t.format === "tag";
const oneWord = (t) => (isTag(t) ? "team" : "blader");
const manyWord = (t) => (isTag(t) ? "Teams" : "Bladers");
const membersOf = (t, id) => {
  const p = (t.players || []).find((x) => x.id === id);
  return p && p.members && p.members.length ? p.members : null;
};

const uid = () => Math.random().toString(36).slice(2, 9);

/*
 * The board reads and writes one tournament, named by id. Which tournaments an
 * account may write is not decided here at all — the database decides, through
 * row policies and column grants — so `canEdit` below only governs what the
 * interface offers, never what is permitted.
 */
const storeFor = (eventId) => ({
  loadRow: () => loadEvent(eventId),
  stamp: () => eventStamp(eventId),
  save: (value) => saveEvent(eventId, { data: value }),
  subscribe: (onChange, onStatus) => subscribeEvent(eventId, onChange, onStatus),
});

/** How often to ask "has anything changed?" when realtime is quiet. */
const POLL_MS = 15000;

/* ------------------------------------------------------------------
   Background image.

   The picture never goes into the tournament record — that blob is
   re-sent to every spectator on every score, so only the URL lives
   there. It is also shrunk in the browser before it is uploaded, so a
   12MP phone photo costs a spectator ~100KB, not ~6MB.
------------------------------------------------------------------ */
const BG_BUCKET = "tournament-bg";

const IMAGE_KINDS = {
  // A backdrop sits behind a 90% dark veil, so it can be compressed hard.
  bg: { maxDim: 1400, quality: 0.62, alpha: false, prefix: "bg" },
  // A logo is drawn ~30px tall, but must keep its transparency — a JPEG
  // fallback would fill the cut-out with black.
  logo: { maxDim: 320, quality: 0.9, alpha: true, prefix: "logo" },
};

const EXT = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" };

/** Downscale and re-encode, preferring WebP for size. */
async function shrinkImage(file, kind) {
  const k = IMAGE_KINDS[kind];
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, k.maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  // Left transparent, so a logo's cut-out survives the round trip.
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const encode = (type) => new Promise((res) => canvas.toBlob(res, type, k.quality));
  // Safari only learned canvas WebP in 16.4; older versions quietly hand back
  // a PNG. That's the right fallback for a logo, but far too big for a photo.
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") {
    blob = k.alpha
      ? (blob && blob.type === "image/png" ? blob : await encode("image/png"))
      : await encode("image/jpeg");
  }
  return blob;
}

async function uploadImage(file, kind) {
  const blob = await shrinkImage(file, kind);
  if (!blob) throw new Error("Could not read that image.");
  const path = `${IMAGE_KINDS[kind].prefix}-${Date.now()}-${uid()}.${EXT[blob.type] || "bin"}`;
  const { error } = await supabase.storage
    .from(BG_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
  if (error) throw error;
  return supabase.storage.from(BG_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * The arena background as separate longhand properties. Deliberately not the
 * `background` shorthand: mixing it with backgroundAttachment makes React warn,
 * and the two fight each other across rerenders.
 */
function arenaStyle(url) {
  const layers = url
    // The dark veil sits above the photo — that's what fades it right back.
    ? `${arenaBg}, linear-gradient(${C.base}E8, ${C.base}E8), url("${url}")`
    : arenaBg;
  return {
    backgroundImage: layers,
    backgroundColor: C.base,
    // Deliberately NOT background-attachment: fixed. On mobile that repaints a
    // viewport-sized background on every scroll frame, and the sticky header
    // and bottom bar visibly lag behind the scroll as a result. The board keeps
    // a still backdrop by painting it into a fixed layer instead — see Backdrop.
    backgroundAttachment: "scroll",
    backgroundPosition: "center",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
  };
}

/** The still arena backdrop, as its own compositor layer behind everything. */
function Backdrop({ url }) {
  return (
    <div aria-hidden="true" style={{
      position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
      ...arenaStyle(url),
    }} />
  );
}

const TABS = ["groups", "matches", "table", "bracket", "players"];
const TAB_KEY = "bx:tab";
const GROUP_KEY = "bx:group";
const ALL_GROUPS = "all";

/** Last tab this device was on, so a refresh doesn't bounce you to Groups. */
function initialTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (TABS.includes(saved)) return saved;
  } catch (e) { /* private mode */ }
  return "table";
}

function initialGroup() {
  try { return localStorage.getItem(GROUP_KEY) || ALL_GROUPS; }
  catch (e) { return ALL_GROUPS; }
}

/**
 * Filter for which group to show. One choice shared by Matches and Standings,
 * so running Group B means both tabs stay on Group B.
 */
function GroupPicker({ t, value, onChange }) {
  if (t.groups.length < 2) return null;
  const i = t.groups.findIndex((g) => g.id === value);
  return (
    <div style={{ marginBottom: 16 }}>
      <Segmented
        value={value} onChange={onChange}
        tone={i >= 0 ? GROUP_COLORS[i % GROUP_COLORS.length] : C.magenta}
        options={[
          { value: ALL_GROUPS, label: "All" },
          // "Group A" reads as just "A" here; the section below spells it out.
          ...t.groups.map((g) => ({ value: g.id, label: g.name.replace(/^group\s+/i, "") })),
        ]}
      />
    </div>
  );
}

function scoreOf(m) {
  let s1 = 0, s2 = 0;
  (m.events || []).forEach((e) => (e.side === 1 ? (s1 += e.pts) : (s2 += e.pts)));
  return { s1, s2 };
}

/**
 * Nothing is won until the match is finished — including a walkover, which
 * propagate() marks done up front.
 *
 * An empty slot is only a bye in the opening round. Later on it means the match
 * feeding that slot has not been played yet, and treating it as a walkover
 * marched a blader through the semi-final and crowned a champion while the
 * quarter-finals were still being scored.
 */
function winnerOf(m) {
  if (!m || !m.done) return null;
  if (m.p1 && !m.p2) return m.p1;
  if (m.p2 && !m.p1) return m.p2;
  const { s1, s2 } = scoreOf(m);
  if (s1 === s2) return null;
  return s1 > s2 ? m.p1 : m.p2;
}

/* ---- stages ---- */

function stagesFor(koSize, thirdPlace) {
  const s = [{ key: "group", label: "Group stage" }];
  if (koSize >= 16) s.push({ key: "r16", label: "Round of 16" });
  if (koSize >= 8) s.push({ key: "qf", label: "Quarter-finals" });
  if (koSize >= 4) s.push({ key: "sf", label: "Semi-finals" });
  if (koSize >= 2) s.push({ key: "final", label: "Final" });
  if (koSize >= 4 && thirdPlace) s.push({ key: "third", label: "Third place" });
  return s;
}

const defaultPoints = () => ({ group: 4, r16: 4, qf: 5, sf: 5, final: 7, third: 5 });

function stageKeyForTeams(teams) {
  if (teams >= 16) return "r16";
  if (teams === 8) return "qf";
  if (teams === 4) return "sf";
  return "final";
}

/** Which stage a match belongs to, and therefore how many points win it. */
function stageOf(m, t) {
  if (m.groupId) return "group";
  if (m.id === "k:third") return "third";
  const rounds = t.bracket ? t.bracket.rounds : [];
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i].some((x) => x.id === m.id)) return stageKeyForTeams(rounds[i].length * 2);
  }
  return "group";
}

const targetFor = (m, t) => t.points[stageOf(m, t)] ?? t.points.group;

/* ---- fixtures ---- */

function roundRobin(ids) {
  const arr = [...ids];
  if (arr.length < 2) return [];
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  const out = [];
  let list = arr.slice();
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) out.push([a, b]);
    }
    list = [list[0], list[n - 1], ...list.slice(1, n - 1)];
  }
  return out;
}

const pairKey = (gid, a, b) => `g:${gid}:${[a, b].sort().join("~")}`;

function buildGroupMatches(groups, existing = []) {
  const prev = new Map(existing.map((m) => [m.id, m]));
  const out = [];
  groups.forEach((g) => {
    roundRobin(g.playerIds).forEach(([a, b]) => {
      const id = pairKey(g.id, a, b);
      const old = prev.get(id);
      out.push(old ? { ...old, p1: a, p2: b } : { id, groupId: g.id, p1: a, p2: b, events: [], done: false });
    });
  });
  return out;
}

/**
 * @param lp  league points, e.g. { win: "3", draw: "1" }. When given, the table
 *            ranks on points earned rather than on wins. A draw is all but
 *            impossible while a match runs to a target, but it costs nothing to
 *            count and would otherwise silently score zero.
 */
function computeStandings(playerIds, matches, nameOf, lp) {
  const rec = {};
  playerIds.forEach((id) => {
    rec[id] = { id, played: 0, wins: 0, losses: 0, draws: 0, pts: 0, pf: 0, pa: 0, winMargin: 0 };
  });
  matches.forEach((m) => {
    if (!m.done) return;
    const a = rec[m.p1], b = rec[m.p2];
    if (!a || !b) return;
    const { s1, s2 } = scoreOf(m);
    a.played++; b.played++;
    a.pf += s1; a.pa += s2; b.pf += s2; b.pa += s1;
    if (s1 > s2) { a.wins++; b.losses++; a.winMargin += s1 - s2; }
    else if (s2 > s1) { b.wins++; a.losses++; b.winMargin += s2 - s1; }
    else { a.draws++; b.draws++; }
  });

  if (lp) {
    Object.values(rec).forEach((r) => { r.pts = r.wins * num(lp.win) + r.draws * num(lp.draw); });
  }

  return Object.values(rec).sort(
    (x, y) =>
      (lp ? y.pts - x.pts : 0) ||
      y.wins - x.wins ||
      y.winMargin - x.winMargin ||
      (y.pf - y.pa) - (x.pf - x.pa) ||
      y.pf - x.pf ||
      nameOf(x.id).localeCompare(nameOf(y.id))
  );
}

/* ---- end of tournament ---- */

/**
 * The best record of the group stage, across every group rather than within
 * one. Most wins takes it; margin separates a tie; anyone still level is a
 * king alongside the others rather than being split by something arbitrary.
 */
function swissKings(t) {
  const rec = {};
  t.players.forEach((p) => { rec[p.id] = { id: p.id, name: p.name, wins: 0, margin: 0, played: 0 }; });

  t.groupMatches.forEach((m) => {
    if (!m.done || !m.p1 || !m.p2) return;
    const a = rec[m.p1], b = rec[m.p2];
    if (!a || !b) return;
    const { s1, s2 } = scoreOf(m);
    a.played++; b.played++;
    if (s1 > s2) { a.wins++; a.margin += s1 - s2; }
    else if (s2 > s1) { b.wins++; b.margin += s2 - s1; }
  });

  const played = Object.values(rec).filter((r) => r.played > 0);
  if (!played.length) return [];
  const topWins = Math.max(...played.map((r) => r.wins));
  const onWins = played.filter((r) => r.wins === topWins);
  const topMargin = Math.max(...onWins.map((r) => r.margin));
  return onWins.filter((r) => r.margin === topMargin);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/** Every stage starts at zero: a bonus nobody sets should change nothing. */
const defaultScoring = () => ({
  perWin: "3",
  perMargin: "1",
  stages: Object.fromEntries(
    ["group", "r16", "qf", "sf", "final", "third"].map((k) => [k, { play: "0", win: "0" }])
  ),
});

/**
 * Ranks every blader by a scoring scheme the organiser chooses, which need not
 * agree with who lifted the trophy.
 *
 * A match pays its stage's bonus for playing, and to the winner: the points
 * for a win, the stage's bonus for winning, and their margin times its weight.
 * Byes are skipped — nobody played, so nobody is paid.
 */
function finalStandings(t, cfg) {
  const all = [
    ...t.groupMatches,
    ...(t.bracket ? t.bracket.rounds.flat() : []),
    ...(t.bracket && t.bracket.third ? [t.bracket.third] : []),
  ];

  const rec = {};
  t.players.forEach((p) => {
    rec[p.id] = {
      id: p.id, name: p.name, total: 0, played: 0, wins: 0, losses: 0,
      margin: 0, pf: 0, pa: 0, bonus: 0,
    };
  });

  all.forEach((m) => {
    if (!m.done || !m.p1 || !m.p2) return;
    const a = rec[m.p1], b = rec[m.p2];
    if (!a || !b) return;
    const st = cfg.stages[stageOf(m, t)] || { play: 0, win: 0 };
    const { s1, s2 } = scoreOf(m);

    [[a, s1, s2], [b, s2, s1]].forEach(([r, mine, theirs]) => {
      r.played++; r.pf += mine; r.pa += theirs;
      r.total += num(st.play);
      r.bonus += num(st.play);
      if (mine > theirs) {
        r.wins++;
        r.margin += mine - theirs;
        r.total += num(cfg.perWin) + num(st.win) + (mine - theirs) * num(cfg.perMargin);
        r.bonus += num(st.win);
      } else if (theirs > mine) {
        r.losses++;
      }
    });
  });

  const rows = Object.values(rec)
    .filter((r) => r.played > 0)
    .sort((x, y) =>
      y.total - x.total || y.wins - x.wins || y.margin - x.margin || x.name.localeCompare(y.name));

  // Equal totals share a rank, and the next one skips accordingly.
  let rank = 0, prev = null;
  rows.forEach((r, i) => {
    if (prev === null || r.total !== prev) rank = i + 1;
    r.rank = rank;
    prev = r.total;
  });
  return rows;
}

/* ---- CSV export ---- */

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(",");

/**
 * The whole tournament as one file: the ranking, how it was arrived at, and
 * every match point by point, so the record survives the app.
 */
function buildFinalCSV(t, cfg, rows, kings) {
  const nameOf = (id) => (t.players.find((p) => p.id === id) || {}).name || "—";
  const groupName = (id) => (t.groups.find((g) => g.id === id) || {}).name || "";
  const stageLabel = (key) =>
    (stagesFor(t.koSize, t.thirdPlace).find((s) => s.key === key) || {}).label || key;

  const out = [];
  out.push(csvRow([t.name, "final standings"]));
  out.push(csvRow(["Generated", new Date().toISOString()]));
  out.push("");

  out.push(csvRow(["FINAL RANKING"]));
  out.push(csvRow(["Rank", "Blader", "Total", "Played", "Won", "Lost", "Winning margin",
    "Points for", "Points against", "Of which bonuses"]));
  rows.forEach((r) => out.push(csvRow([r.rank, r.name, r.total, r.played, r.wins, r.losses,
    r.margin, r.pf, r.pa, r.bonus])));
  out.push("");

  out.push(csvRow([kings.length > 1 ? "SWISS KINGS" : "SWISS KING"]));
  out.push(csvRow(["Blader", "Group-stage wins", "Winning margin"]));
  kings.forEach((k) => out.push(csvRow([k.name, k.wins, k.margin])));
  out.push("");

  out.push(csvRow(["SCORING USED"]));
  out.push(csvRow(["Points for each win", cfg.perWin]));
  out.push(csvRow(["Points per point of winning margin", cfg.perMargin]));
  out.push(csvRow(["Stage", "Bonus for playing", "Bonus for winning"]));
  stagesFor(t.koSize, t.thirdPlace).forEach((s) => {
    const st = cfg.stages[s.key] || {};
    out.push(csvRow([s.label, st.play, st.win]));
  });
  out.push("");

  out.push(csvRow(["MATCHES"]));
  out.push(csvRow(["Stage", "Group", "Blader A", "Blader B", "Score A", "Score B",
    "Winner", "Points in order"]));

  const all = [
    ...t.groupMatches,
    ...(t.bracket ? t.bracket.rounds.flat() : []),
    ...(t.bracket && t.bracket.third ? [t.bracket.third] : []),
  ];
  all.forEach((m) => {
    if (!m.p1 && !m.p2) return;
    const { s1, s2 } = scoreOf(m);
    const w = winnerOf(m);
    const seq = (m.events || [])
      .map((e, i) => `${i + 1}. ${nameOf(e.side === 1 ? m.p1 : m.p2)} ${(awardOf(e.type) || { label: e.type }).label} +${e.pts}`)
      .join("; ");
    out.push(csvRow([
      stageLabel(stageOf(m, t)), groupName(m.groupId),
      m.p1 ? nameOf(m.p1) : "", m.p2 ? nameOf(m.p2) : "",
      m.done ? s1 : "", m.done ? s2 : "",
      w ? nameOf(w) : (m.done ? "draw" : "not played"),
      seq,
    ]));
  });

  return out.join("\n");
}

function downloadCSV(filename, text) {
  // The BOM is what stops Excel mangling names with accents in them.
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s) => (s || "tournament").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---- bracket ---- */

function seedOrder(n) {
  let arr = [1, 2];
  while (arr.length < n) {
    const len = arr.length * 2 + 1;
    const out = [];
    arr.forEach((s) => { out.push(s); out.push(len - s); });
    arr = out;
  }
  return arr;
}

function roundName(teams) {
  if (teams >= 16) return "Round of " + teams;
  if (teams === 8) return "Quarter-finals";
  if (teams === 4) return "Semi-finals";
  return "Final";
}

function collectQualifiers(groups, groupMatches, advance, nameOf) {
  const out = [];
  groups.forEach((g) => {
    const ms = groupMatches.filter((m) => m.groupId === g.id);
    computeStandings(g.playerIds, ms, nameOf)
      .slice(0, advance)
      .forEach((row, i) => out.push({ ...row, groupId: g.id, placement: i + 1 }));
  });
  return out.sort(
    (x, y) =>
      x.placement - y.placement ||
      y.wins - x.wins ||
      y.winMargin - x.winMargin ||
      (y.pf - y.pa) - (x.pf - x.pa) ||
      nameOf(x.id).localeCompare(nameOf(y.id))
  );
}

function avoidSameGroup(pairs) {
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i];
    if (!a.p1 || !a.p2 || a.p1.groupId !== a.p2.groupId) continue;
    for (let j = 0; j < pairs.length; j++) {
      if (i === j) continue;
      const b = pairs[j];
      if (!b.p1 || !b.p2) continue;
      if (b.p2.placement !== a.p2.placement) continue;
      if (a.p1.groupId !== b.p2.groupId && b.p1.groupId !== a.p2.groupId) {
        const tmp = a.p2; a.p2 = b.p2; b.p2 = tmp;
        break;
      }
    }
  }
  return pairs;
}

function buildBracket(qualifiers, size, thirdPlace) {
  const order = seedOrder(size);
  const slots = order.map((s) => qualifiers[s - 1] || null);
  let first = [];
  for (let i = 0; i < size; i += 2) first.push({ p1: slots[i], p2: slots[i + 1] });
  first = avoidSameGroup(first);

  const rounds = [
    first.map((p, i) => ({
      id: `k:0:${i}`, p1: p.p1 ? p.p1.id : null, p2: p.p2 ? p.p2.id : null,
      events: [], done: false,
    })),
  ];
  let n = size / 4, r = 1;
  while (n >= 1) {
    rounds.push(Array.from({ length: n }, (_, i) => ({
      id: `k:${r}:${i}`, p1: null, p2: null, events: [], done: false,
    })));
    n = n / 2; r++;
  }
  return propagate({
    size, rounds,
    third: thirdPlace && size >= 4
      ? { id: "k:third", p1: null, p2: null, events: [], done: false } : null,
  });
}

function propagate(bracket) {
  const rounds = bracket.rounds.map((r) => r.map((m) => ({ ...m })));

  // Settle the genuine byes first. An unopposed blader in the opening round is
  // through without playing, and this has to happen before the loop below or
  // winnerOf — which now insists on a finished match — would not advance them.
  rounds[0].forEach((m) => {
    if ((m.p1 && !m.p2) || (m.p2 && !m.p1)) m.done = true;
  });

  for (let r = 0; r < rounds.length - 1; r++) {
    rounds[r].forEach((m, i) => {
      const w = winnerOf(m);
      const tgt = rounds[r + 1][Math.floor(i / 2)];
      const slot = i % 2 === 0 ? "p1" : "p2";
      if (tgt[slot] !== w) { tgt[slot] = w; tgt.events = []; tgt.done = false; }
    });
  }

  let third = bracket.third;
  if (third && rounds.length >= 2) {
    const semis = rounds[rounds.length - 2];
    const losers = semis.map((m) => {
      const w = winnerOf(m);
      if (!w || !m.p1 || !m.p2) return null;
      return w === m.p1 ? m.p2 : m.p1;
    });
    const [l1, l2] = losers;
    if (third.p1 !== l1 || third.p2 !== l2) {
      third = { ...third, p1: l1, p2: l2, events: [], done: false };
    }
  }
  return { ...bracket, rounds, third };
}

/* ================================================================== */
/*  Theme                                                              */
/* ================================================================== */

const C = {
  base: "#0B0718",
  surface: "#170F2E",
  raised: "#21163F",
  line: "#382559",
  ink: "#F3EDFF",
  muted: "#9C8CC4",
  magenta: "#FF2D8A",
  cyan: "#29D3FF",
  gold: "#FFC42E",
  green: "#3DDC84",
};

const GROUP_COLORS = [C.magenta, C.cyan, C.gold, C.green, "#A855F7", "#FF6B35", "#2DD4BF", "#F472B6"];

/* Image layers only — the base colour is applied as backgroundColor, so these
   can be composed with a tournament's photo without shorthand conflicts. */
const arenaBg = `radial-gradient(115% 70% at 0% 0%, ${C.magenta}1F, transparent 58%),
   radial-gradient(115% 70% at 100% 0%, ${C.cyan}1C, transparent 58%)`;

const Style = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap');
    /* Rubber-band scrolling drags fixed bars with it, so switch it off. */
    html, body { overscroll-behavior: none; }
    .bx { font-family: 'Barlow', system-ui, sans-serif; }
    /* dvh follows the browser chrome as it collapses; vh does not, which leaves
       the page taller than the screen and the bottom bar adrift. */
    .bx { min-height: 100dvh; }
    .bx-d { font-family: 'Saira Condensed', 'Barlow', sans-serif; letter-spacing: .015em; }
    .bx-slant { transform: skewX(-9deg); }
    .bx *::-webkit-scrollbar { height: 6px; width: 6px; }
    .bx *::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 3px; }
    .bx input, .bx select, .bx textarea { font-family: inherit; }
    .bx button { -webkit-tap-highlight-color: transparent; }
    .bx button:focus-visible, .bx input:focus-visible, .bx textarea:focus-visible {
      outline: 2px solid ${C.cyan}; outline-offset: 2px;
    }
    @keyframes bx-clash { from { opacity: 0; transform: translateY(14px) skewX(-9deg); }
                          to   { opacity: 1; transform: translateY(0) skewX(-9deg); } }
    .bx-enter { animation: bx-clash .5s cubic-bezier(.16,1,.3,1) both; }
    /* Tab changes slide in from the side you came from, so a swipe feels
       connected to the thing it moved. */
    @keyframes bx-tab-next { from { opacity: 0; transform: translate3d(26px,0,0); }
                             to   { opacity: 1; transform: translate3d(0,0,0); } }
    @keyframes bx-tab-prev { from { opacity: 0; transform: translate3d(-26px,0,0); }
                             to   { opacity: 1; transform: translate3d(0,0,0); } }
    /* No fill-mode on purpose. "both" would leave the end transform applied
       forever, and a transformed ancestor becomes the containing block for any
       position:fixed child, misplacing the dialogs. "backwards" is worse still:
       if the animation is throttled — a backgrounded tab — the content sits at
       the opening frame, invisible. With no fill, anything other than "playing"
       shows the content exactly as it normally looks. */
    .bx-tab-next { animation: bx-tab-next .2s cubic-bezier(.16,1,.3,1); }
    .bx-tab-prev { animation: bx-tab-prev .2s cubic-bezier(.16,1,.3,1); }
    /* Undo sits in the sheet header on desktop, but within thumb reach on phones. */
    .bx-undo-fab { display: none; }
    @media (max-width: 640px) {
      .bx-undo-fab { display: inline-flex; }
      .bx-undo-head { display: none; }
      /* Icon alone on phones, so the tournament name gets the room. */
      .bx-role-label { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { .bx *, .bx-enter { animation: none !important; transition: none !important; } }
  `}</style>
);

const shell = { ...arenaStyle(null), color: C.ink, minHeight: "100vh" };

const card = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 4,
  padding: 14,
};

function Btn({ children, onClick, tone = "default", disabled, style, ...rest }) {
  const tones = {
    default: { background: C.raised, color: C.ink, border: `1px solid ${C.line}` },
    primary: { background: C.magenta, color: "#14020A", border: `1px solid ${C.magenta}` },
    cool: { background: C.cyan, color: "#031820", border: `1px solid ${C.cyan}` },
    ghost: { background: "transparent", color: C.muted, border: `1px solid ${C.line}` },
    danger: { background: "transparent", color: C.magenta, border: `1px solid ${C.magenta}55` },
  };
  return (
    <button onClick={onClick} disabled={disabled} className="bx-d"
      style={{
        ...tones[tone], padding: "10px 15px", borderRadius: 3, fontWeight: 700,
        fontSize: 15, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.38 : 1, display: "inline-flex", alignItems: "center",
        gap: 7, textTransform: "none", ...style,
      }} {...rest}>
      {children}
    </button>
  );
}

function Blade({ color = C.magenta, h = 22 }) {
  return <span className="bx-slant" style={{
    display: "inline-block", width: 5, height: h, background: color, flexShrink: 0,
  }} />;
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 18 }}>
      <div className="bx-d" style={{ fontSize: 15, color: C.ink, marginBottom: 7, fontWeight: 600 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 1.45, maxWidth: "58ch" }}>{hint}</div>}
    </label>
  );
}

const inputStyle = {
  width: "100%", background: C.base, border: `1px solid ${C.line}`, borderRadius: 3,
  color: C.ink, padding: "11px 12px", fontSize: 15, boxSizing: "border-box",
};

function Segmented({ value, onChange, options, tone = C.magenta }) {
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} onClick={() => onChange(o.value)} className="bx-d"
            style={{
              flex: "1 1 auto", minWidth: 60, padding: "10px 8px", borderRadius: 3,
              fontSize: 15, fontWeight: 700, cursor: "pointer",
              background: on ? tone : C.base,
              color: on ? "#14020A" : C.muted,
              border: `1px solid ${on ? tone : C.line}`,
            }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SectionHead({ title, sub, action, color = C.magenta }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <Blade color={color} h={26} />
          <h2 className="bx-d" style={{ fontSize: 27, fontWeight: 800, margin: 0, lineHeight: 1 }}>{title}</h2>
        </div>
        {action}
      </div>
      {sub && <p style={{ color: C.muted, fontSize: 13.5, margin: "8px 0 0 15px", lineHeight: 1.5, maxWidth: "62ch" }}>{sub}</p>}
    </div>
  );
}

function EmptyState({ title, body }) {
  return (
    <div style={{ ...card, textAlign: "center", padding: "44px 20px" }}>
      <div className="bx-d" style={{ fontSize: 21, fontWeight: 700, marginBottom: 7 }}>{title}</div>
      <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, maxWidth: "44ch", margin: "0 auto" }}>{body}</div>
    </div>
  );
}

/**
 * Confirmation for anything that throws away scores. Pass no onConfirm to
 * make it a dead end — used where an action is refused outright rather than
 * merely risky.
 */
function Confirm({ title, body, confirmLabel = "Confirm", tone = "primary", onConfirm, onClose }) {
  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 90, background: "#0B0718EE",
      display: "grid", placeItems: "center", padding: 20,
    }}>
      <div style={{
        width: "100%", maxWidth: 400, background: C.surface,
        border: `1px solid ${C.line}`, borderRadius: 4, padding: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Blade color={onConfirm ? C.gold : C.magenta} h={24} />
          <h2 className="bx-d" style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{title}</h2>
        </div>
        <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: "0 0 18px" }}>{body}</p>
        <div style={{ display: "flex", gap: 8 }}>
          {onConfirm ? (
            <>
              <Btn onClick={onClose} tone="ghost" style={{ flex: 1, justifyContent: "center", padding: 12 }}>Cancel</Btn>
              <Btn onClick={onConfirm} tone={tone} style={{ flex: 1, justifyContent: "center", padding: 12 }}>
                {confirmLabel}
              </Btn>
            </>
          ) : (
            <Btn onClick={onClose} tone="ghost" style={{ flex: 1, justifyContent: "center", padding: 12 }}>Got it</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- swipe between tabs ---------------------------------------- */

const SWIPE_MIN_X = 60;      // shorter than this is a tap that wandered
const SWIPE_MAX_MS = 700;    // slower than this is a drag, not a flick
const SWIPE_X_OVER_Y = 1.6;  // must be decisively horizontal
const SWIPE_EDGE = 20;       // leave the OS its back-gesture strip

/**
 * True if the touch began inside something that scrolls sideways on its own —
 * the standings tables, for instance. Those swipes belong to that element.
 */
function inHorizontalScroller(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const ox = getComputedStyle(n).overflowX;
    if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) return true;
  }
  return false;
}

/**
 * True if the touch began inside a sheet, dialog or the bottom bar. They are
 * all position:fixed and are DOM children of the board, so without this a
 * swipe inside the score sheet would flip the tab behind it.
 */
function inOverlay(el, root) {
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (getComputedStyle(n).position === "fixed") return true;
  }
  return false;
}

/**
 * Swipe rightwards to go back, the direction every platform uses for it.
 * Returns handlers to spread onto a full-screen sheet.
 *
 * Same thresholds as the tab swipe, so a scroll or a stray drag is not read as
 * a dismissal, and touches inside a dialog or a sideways-scrolling table belong
 * to those instead.
 */
function useSwipeBack(onBack) {
  const start = useRef(null);
  return {
    onTouchStart: (e) => {
      const p = e.touches.length === 1 ? e.touches[0] : null;
      start.current =
        p && p.clientX > SWIPE_EDGE
          && !inOverlay(e.target, e.currentTarget)
          && !inHorizontalScroller(e.target)
          ? { x: p.clientX, y: p.clientY, at: Date.now() }
          : null;
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - s.x;
      const dy = e.changedTouches[0].clientY - s.y;
      if (Date.now() - s.at > SWIPE_MAX_MS) return;
      if (dx < SWIPE_MIN_X) return; // rightwards only — leftwards means nothing here
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_X_OVER_Y) return;
      onBack();
    },
  };
}

/** Matches that already hold a score — what a redraw or reset would destroy. */
function scoredCount(t) {
  const all = [
    ...t.groupMatches,
    ...(t.bracket ? t.bracket.rounds.flat() : []),
    ...(t.bracket && t.bracket.third ? [t.bracket.third] : []),
  ];
  return all.filter((m) => (m.events || []).length > 0).length;
}

/* ================================================================== */
/*  The board — one tournament                                         */
/* ================================================================== */

/**
 * @param eventId  which tournament to read and write
 * @param canEdit  whether to offer the controls. The database decides what is
 *                 actually permitted; this only decides what is shown.
 * @param onExit   back to the list, when there is a list to go back to
 */
function Board({ eventId, canEdit, isOwner, onExit, onReferees, onDelete }) {
  const [t, setT] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [scoring, setScoring] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showFinal, setShowFinal] = useState(false);
  const [live, setLive] = useState(false);
  const [slide, setSlide] = useState(null); // direction of the last tab change
  const [group, setGroup] = useState(initialGroup);
  const isAdmin = canEdit;
  const store = useMemo(() => storeFor(eventId), [eventId]);

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* private mode */ }
  }, [tab]);

  // The remembered tab may not exist in this format — a league has no bracket.
  useEffect(() => {
    if (t && !tabsFor(t).includes(tab)) setTab(tabsFor(t)[0]);
  }, [t, tab]);

  useEffect(() => {
    try { localStorage.setItem(GROUP_KEY, group); } catch (e) { /* private mode */ }
  }, [group]);

  // A remembered group id can outlive the tournament it belonged to — after a
  // redraw or a fresh setup the ids differ, and the filter would hide the lot.
  useEffect(() => {
    if (!t || group === ALL_GROUPS) return;
    if (!t.groups.some((g) => g.id === group)) setGroup(ALL_GROUPS);
  }, [t, group]);

  // What this device last wrote or accepted, so it can tell a genuine change
  // from the echo of its own save coming back around.
  const lastJson = useRef(null);
  const lastStamp = useRef(null);

  /** Take a version of the board from the server, unless it's our own echo. */
  const applyIncoming = (incoming, stamp) => {
    if (stamp) lastStamp.current = stamp;
    const json = JSON.stringify(incoming);
    if (json === lastJson.current) return;
    lastJson.current = json; // adopt it, so we don't bounce it straight back
    setT(incoming);
  };

  useEffect(() => {
    let live = true;
    setLoaded(false);
    (async () => {
      const row = await store.loadRow();
      if (!live) return;                 // the tournament changed under us
      if (row) {
        lastStamp.current = row.updated_at;
        lastJson.current = JSON.stringify(row.data);
        setT(row.data);
      } else {
        setT(null);
      }
      setLoaded(true);
    })();
    return () => { live = false; };
  }, [store]);

  // Every device follows the board, admin phones included — scoring on the PC
  // has to show up on the phone in your pocket. Only this device's own save is
  // skipped, so an edit in progress is never stomped by its own echo.
  useEffect(() => {
    return store.subscribe(
      (incoming, stamp) => applyIncoming(incoming, stamp),
      (status) => setLive(status === "SUBSCRIBED")
    );
  }, [store]);

  // The safety net, and it runs even when realtime claims to be connected:
  // a connected socket is not proof that row changes are being delivered.
  // Checking the timestamp is cheap; the board is only pulled when it moved.
  useEffect(() => {
    if (!loaded) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const stamp = await store.stamp();
      if (!stamp || stamp === lastStamp.current) return;
      const row = await store.loadRow();
      if (row) applyIncoming(row.data, row.updated_at);
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick); // phones kill sockets on lock
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [loaded, store]);

  useEffect(() => {
    if (!loaded || !t || !isAdmin) return;
    const json = JSON.stringify(t);
    if (json === lastJson.current) return; // nothing actually changed
    lastJson.current = json;
    store.save(t).then((stamp) => {
      if (stamp) lastStamp.current = stamp;
      // Write failed: forget what we "saved" so the next edit tries again
      // rather than sitting on a change the server never took.
      else lastJson.current = null;
    });
  }, [t, loaded, isAdmin, store]);

  const nameOf = useMemo(() => {
    const map = {};
    (t?.players || []).forEach((p) => (map[p.id] = p.name));
    return (id) => map[id] || "—";
  }, [t]);

  /** Change tab, remembering which way we travelled so the view can slide in. */
  const goTab = (next) => {
    if (next === tab) return;
    setSlide(TABS.indexOf(next) > TABS.indexOf(tab) ? "next" : "prev");
    setTab(next);
    // Land at the top of the new tab. Besides being the expected behaviour, it
    // stops the browser having to clamp a scroll position that no longer fits
    // a shorter page — a clamp mid-animation visibly shunts the fixed bars.
    window.scrollTo(0, 0);
  };

  // Swipe left/right across the board to change tabs. Measured on touchend
  // only — nothing is preventDefault-ed, so vertical scrolling stays native.
  // Bound to the full-height root, not <main>: a short page (an unbuilt
  // bracket, say) leaves most of the screen outside <main> entirely.
  const swipe = useRef(null);

  const onTouchStart = (e) => {
    const p = e.touches.length === 1 ? e.touches[0] : null;
    swipe.current =
      p && p.clientX > SWIPE_EDGE && p.clientX < window.innerWidth - SWIPE_EDGE
        && !inOverlay(e.target, e.currentTarget)
        && !inHorizontalScroller(e.target)
        ? { x: p.clientX, y: p.clientY, at: Date.now() }
        : null;
  };

  const onTouchEnd = (e) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || e.changedTouches.length !== 1) return;

    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Date.now() - start.at > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_X) return;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_X_OVER_Y) return; // a scroll, not a swipe

    const list = tabsFor(t);
    const next = list.indexOf(tab) + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < list.length) goTab(list[next]); // no wrap-around
  };

  if (!loaded) {
    return (
      <div className="bx" style={{ ...shell, display: "grid", placeItems: "center" }}>
        <Style /><span style={{ color: C.muted }}>Loading…</span>
      </div>
    );
  }

  // A tournament always exists by the time the board opens — it is created from
  // the list, not from in here. An empty one means the row was deleted while
  // somebody was looking at it.
  if (!t) {
    return (
      <>
        <Style />
        <NotLive onUnlock={onExit} />
      </>
    );
  }

  const allMatches = [
    ...t.groupMatches,
    ...(t.bracket ? t.bracket.rounds.flat() : []),
    ...(t.bracket && t.bracket.third ? [t.bracket.third] : []),
  ];

  const update = (fn) => setT((prev) => fn(structuredClone(prev)));

  const saveScore = (kind, id, events, done) => {
    update((d) => {
      if (kind === "group") {
        const m = d.groupMatches.find((x) => x.id === id);
        if (m) { m.events = events; m.done = done; }
      } else {
        if (d.bracket.third && d.bracket.third.id === id) {
          d.bracket.third.events = events; d.bracket.third.done = done;
        } else {
          d.bracket.rounds.forEach((r) => r.forEach((m) => {
            if (m.id === id) { m.events = events; m.done = done; }
          }));
        }
        d.bracket = propagate(d.bracket);
      }
      return d;
    });
  };

  const scoringMatch = scoring ? allMatches.find((m) => m.id === scoring.id) : null;

  return (
    <div className="bx" style={{ color: C.ink, minHeight: "100vh", backgroundColor: C.base }}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <Style />
      <Backdrop url={t.bgUrl} />

      <header style={{
        position: "sticky", top: 0, zIndex: 20, background: C.base,
        borderBottom: `1px solid ${C.line}`, padding: "13px 16px",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        {t.logoUrl && (
          <img src={t.logoUrl} alt="" style={{
            height: 56, width: "auto", maxWidth: 126, objectFit: "contain", flexShrink: 0,
          }} />
        )}
        <div style={{
          width: 5, alignSelf: "stretch",
          background: `linear-gradient(${C.magenta}, ${C.cyan})`, transform: "skewX(-9deg)",
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{
            fontSize: 22, fontWeight: 800, whiteSpace: "nowrap", lineHeight: 1.05,
            overflow: "hidden", textOverflow: "ellipsis",
          }}>{t.name}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
            <span title={live ? "Updating live" : "Checking every few seconds"} style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: live ? C.green : C.gold,
              boxShadow: live ? `0 0 6px ${C.green}` : "none",
            }} />
            <span>{t.players.length} bladers · {t.groups.length} group{t.groups.length > 1 ? "s" : ""} · top {t.advance} advance</span>
          </div>
        </div>
        {onExit && (
          <button onClick={onExit} aria-label="All tournaments" className="bx-d"
            style={{
              background: "transparent", border: `1px solid ${C.line}`,
              color: C.muted, cursor: "pointer",
              padding: "6px 9px", borderRadius: 3, fontSize: 13, fontWeight: 700,
              display: "flex", alignItems: "center", gap: 5,
            }}>
            <ArrowLeft size={14} />
            <span className="bx-role-label">All</span>
          </button>
        )}
        {isAdmin && (
          <button onClick={() => setShowSetup(true)} aria-label="Tournament settings"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 6 }}>
            <Settings size={20} />
          </button>
        )}
      </header>

      <main style={{
        padding: "18px 16px 96px", maxWidth: 720, margin: "0 auto",
        position: "relative", zIndex: 1, // above the fixed backdrop
        // The sliding content must never reach the page's scroll geometry:
        // a sideways overflow, even a clipped one, is enough to make the
        // browser re-place the fixed bottom bar mid-animation. "clip" rather
        // than "hidden" so it does not become a scroll container and break
        // the sticky bars. -y visible keeps the page scrolling normally.
        overflowX: "clip", overflowY: "visible",
      }}>
        {/* Keyed on the tab so the entrance animation restarts on every change. */}
        <div key={tab} className={slide === "next" ? "bx-tab-next" : slide === "prev" ? "bx-tab-prev" : undefined}>
          {tab === "groups" && <GroupsView t={t} update={update} nameOf={nameOf} isAdmin={isAdmin} />}
          {tab === "matches" && <MatchesView t={t} nameOf={nameOf} isAdmin={isAdmin}
            group={group} setGroup={setGroup}
            onScore={(id) => setScoring({ kind: "group", id })} />}
          {tab === "table" && <TableView t={t} nameOf={nameOf} update={update} isAdmin={isAdmin}
            group={group} setGroup={setGroup} onPlayer={setDetail} onFinal={() => setShowFinal(true)} />}
          {tab === "bracket" && <BracketView t={t} nameOf={nameOf} isAdmin={isAdmin}
            onScore={(id) => setScoring({ kind: "ko", id })} />}
          {tab === "players" && <PlayersView t={t} nameOf={nameOf} allMatches={allMatches} onPlayer={setDetail} />}
        </div>
      </main>

      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20,
        background: C.surface, borderTop: `1px solid ${C.line}`,
        display: "grid", gridTemplateColumns: `repeat(${tabsFor(t).length},1fr)`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        {[
          ["groups", Users, "Groups"],
          ["matches", Swords, "Matches"],
          ["table", Table2, isLeague(t) ? "League" : "Table"],
          ["bracket", GitBranch, "Bracket"],
          ["players", Trophy, manyWord(t)],
        ].filter(([k]) => tabsFor(t).includes(k)).map(([k, Icon, label]) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => goTab(k)}
              style={{
                background: "none", border: "none", cursor: "pointer", position: "relative",
                padding: "11px 4px 13px", color: on ? C.magenta : C.muted,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              }}>
              {on && <span style={{
                position: "absolute", top: 0, left: "26%", right: "26%", height: 3,
                background: C.magenta, transform: "skewX(-16deg)",
              }} />}
              <Icon size={19} />
              <span className="bx-d" style={{ fontSize: 12, fontWeight: 700 }}>{label}</span>
            </button>
          );
        })}
      </nav>

      {scoringMatch && (
        <ScoreSheet
          match={scoringMatch} t={t} nameOf={nameOf}
          onClose={() => setScoring(null)}
          onSave={(events, done) => { saveScore(scoring.kind, scoring.id, events, done); setScoring(null); }}
        />
      )}
      {detail && (
        <PlayerSheet playerId={detail} t={t} nameOf={nameOf}
          allMatches={allMatches} onClose={() => setDetail(null)} />
      )}
      {showSetup && isAdmin && (
        <SettingsSheet t={t} update={update} onClose={() => setShowSetup(false)}
          onReferees={isOwner ? onReferees : null}
          canDelete={isOwner}
          onReset={() => { setShowSetup(false); if (onDelete) onDelete(); }} />
      )}
      {showFinal && isAdmin && (
        <FinalStandingsSheet t={t} onClose={() => setShowFinal(false)} />
      )}
    </div>
  );
}

/* ================================================================== */
/*  Image picker                                                       */
/* ================================================================== */

function ImagePicker({ value, onChange, kind = "bg" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const isLogo = kind === "logo";

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so picking the same file twice still fires
    if (!file) return;
    setErr(""); setNote(""); setBusy(true);
    try {
      const url = await uploadImage(file, kind);
      onChange(url);
      setNote(`Shrunk from ${(file.size / 1048576).toFixed(2)}MB before upload.`);
    } catch (ex) {
      console.error(ex);
      setErr(ex.message || "Upload failed. Check the storage bucket exists.");
    }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{
          width: 76, height: 52, borderRadius: 3, flexShrink: 0,
          border: `1px solid ${C.line}`,
          // A logo is shown whole; a backdrop is shown as it will be cropped.
          background: value
            ? `url("${value}") center / ${isLogo ? "contain" : "cover"} no-repeat`
            : C.base,
          display: "grid", placeItems: "center",
        }}>
          {!value && <ImageIcon size={17} color={C.line} />}
        </div>

        <label style={{
          display: "inline-flex", alignItems: "center", gap: 7, cursor: busy ? "wait" : "pointer",
          background: C.raised, border: `1px solid ${C.line}`, borderRadius: 3,
          padding: "10px 15px", fontSize: 15, fontWeight: 700, opacity: busy ? 0.5 : 1,
        }} className="bx-d">
          <ImageIcon size={15} />
          {busy ? "Uploading…" : value ? "Replace" : "Choose image"}
          <input type="file" accept="image/*" onChange={pick} disabled={busy}
            style={{ display: "none" }} />
        </label>

        {value && !busy && (
          <Btn onClick={() => { onChange(null); setNote(""); }} tone="ghost">Remove</Btn>
        )}
      </div>
      {note && <div style={{ color: C.green, fontSize: 12.5, marginTop: 8 }}>{note}</div>}
      {err && <div style={{ color: C.magenta, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

/* ================================================================== */
/*  Stage points editor                                                */
/* ================================================================== */

function StagePoints({ koSize, thirdPlace, points, onChange }) {
  const stages = stagesFor(koSize, thirdPlace);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {stages.map((s, i) => (
        <div key={s.key} style={{
          background: C.base, border: `1px solid ${C.line}`, borderRadius: 3, padding: "11px 12px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <Blade color={GROUP_COLORS[i % GROUP_COLORS.length]} h={15} />
            <span className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>{s.label}</span>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>
              first to {points[s.key]}
            </span>
          </div>
          <Segmented
            value={points[s.key]}
            onChange={(v) => onChange({ ...points, [s.key]: v })}
            options={[3, 4, 5, 7, 9].map((n) => ({ value: n, label: String(n) }))}
            tone={GROUP_COLORS[i % GROUP_COLORS.length]}
          />
        </div>
      ))}
    </div>
  );
}

/* ================================================================== */
/*  Setup                                                              */
/* ================================================================== */

function Setup({ onCreate }) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("knockout");
  const [bulk, setBulk] = useState("");
  const [players, setPlayers] = useState([]);
  const [entry, setEntry] = useState("");
  const [numGroups, setNumGroups] = useState(2);
  const [advance, setAdvance] = useState(2);
  const [koSize, setKoSize] = useState(8);
  const [third, setThird] = useState(true);
  const [points, setPoints] = useState(defaultPoints());
  const [leaguePoints, setLeaguePoints] = useState(defaultLeaguePoints());
  const [bgUrl, setBgUrl] = useState(null);
  const [logoUrl, setLogoUrl] = useState(null);

  /*
   * One line becomes one competitor. In a tag tournament "Ronin: Ayo, Bex"
   * carries its members along, but it stays a single entrant everywhere else —
   * the draw, the bracket and the scoring never learn the difference.
   */
  const parseEntry = (line) => {
    const [head, tail] = String(line).split(/:(.+)/);
    // A colon with nothing after it does not split, so it would otherwise stay
    // stuck to the name and the team would be called "Ronin:".
    const nm = (head || "").trim().replace(/:+$/, "").trim();
    if (!nm) return null;
    const members = (tail || "").split(",").map((x) => x.trim()).filter(Boolean);
    return members.length ? { id: uid(), name: nm, members } : { id: uid(), name: nm };
  };

  const addPlayer = () => {
    const one = parseEntry(entry);
    if (!one) return;
    setPlayers((p) => [...p, one]);
    setEntry("");
  };
  const addBulk = () => {
    // Commas separate members, so a pasted list splits on line breaks alone.
    const rows = bulk.split(/\n/).map(parseEntry).filter(Boolean);
    if (!rows.length) return;
    setPlayers((p) => [...p, ...rows]);
    setBulk("");
  };

  const league = format === "league";
  const qualifiers = numGroups * advance;
  const tooMany = !league && koSize > 0 && qualifiers > koSize;
  const byes = koSize > 0 ? Math.max(0, koSize - qualifiers) : 0;

  /* The smallest knockout that would hold this many qualifiers, offered as a
     one-tap fix rather than leaving the arithmetic to be worked out. */
  const fits = [2, 4, 8, 16].find((n) => n >= qualifiers);

  /*
   * Why the button is disabled, in the order worth fixing. A greyed-out
   * button with the reason somewhere further up the page reads as broken.
   */
  const least = league ? 2 : numGroups * 2;   // a league needs only an opponent
  const blocker = !name.trim()
    ? "Give the tournament a name first."
    : players.length < least
      ? league
        ? `A league needs at least two ${format === "tag" ? "teams" : "bladers"}, and there ${players.length === 1 ? "is 1" : "are " + players.length}.`
        : `${numGroups} groups need at least ${least} bladers, and there ${players.length === 1 ? "is" : "are"} ${players.length}.`
      : tooMany
        ? `${numGroups} groups × ${advance} advancing makes ${qualifiers} qualifiers, and the knockout only has ${koSize} places.`
        : null;
  const ready = !blocker;

  const create = () => {
    /*
     * A league is one group holding everyone, so its fixtures exist the moment
     * it is created — there is no draw to make. Everything downstream then
     * treats it as the group stage of a tournament that has no knockout.
     */
    if (league) {
      const table = [{ id: "g0", name: "League", playerIds: players.map((p) => p.id) }];
      onCreate({
        name: name.trim(), format, players, groups: table, points,
        leaguePoints, advance: 1, koSize: 0, thirdPlace: false,
        groupMatches: buildGroupMatches(table), bracket: null, bgUrl, logoUrl,
      });
      return;
    }

    const groups = Array.from({ length: numGroups }, (_, i) => ({
      id: "g" + i, name: "Group " + GROUP_LETTERS[i], playerIds: [],
    }));
    onCreate({
      name: name.trim(), format, players, groups, points, advance,
      koSize, thirdPlace: third, groupMatches: [], bracket: null, bgUrl, logoUrl,
    });
  };

  return (
    <div className="bx" style={{ ...shell, ...arenaStyle(bgUrl) }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "44px 18px 70px" }}>

        <div className="bx-enter" style={{ marginBottom: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ width: 30, height: 3, background: C.magenta, transform: "skewX(-30deg)" }} />
            <span className="bx-d" style={{ fontSize: 15, color: C.cyan, fontWeight: 700 }}>
              Beyblade X tournament manager
            </span>
          </div>
          <h1 className="bx-d" style={{
            fontSize: 52, fontWeight: 800, margin: 0, lineHeight: .92,
            background: `linear-gradient(100deg, ${C.magenta} 0%, #FFFFFF 48%, ${C.cyan} 100%)`,
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>
            Let it rip
          </h1>
          <p style={{ color: C.muted, margin: "12px 0 0", fontSize: 15.5, lineHeight: 1.55, maxWidth: "56ch" }}>
            Set up the groups, the points, and where the knockout begins. Everything stays
            editable once the draw is made.
          </p>
        </div>

        <Field label="Tournament name">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Xtreme Clash S2" />
        </Field>

        <Field label="Format"
          hint={format === "league"
            ? "Everyone plays everyone once, ranked on league points. No groups to draw and no knockout."
            : "A tag team is one competitor with a name and members — it draws, plays and scores exactly as a single blader does."}>
          <Segmented value={format} onChange={setFormat} options={[
            { value: "knockout", label: "Groups & knockout" },
            { value: "tag", label: "Tag team" },
            { value: "league", label: "League" },
          ]} />
        </Field>

        <Field label="Organiser logo (optional)"
          hint="Shown beside the tournament name in the header. A PNG with a transparent background looks best — transparency is kept.">
          <ImagePicker kind="logo" value={logoUrl} onChange={setLogoUrl} />
        </Field>

        <Field label="Background image (optional)"
          hint="Your event poster or a hall photo, faded far back behind the scoreboard. Resized in your browser before upload, so a big photo costs spectators nothing.">
          <ImagePicker kind="bg" value={bgUrl} onChange={setBgUrl} />
        </Field>

        <Field label={`${format === "tag" ? "Teams" : "Bladers"} (${players.length})`}>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={inputStyle} value={entry} onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPlayer()}
              placeholder={format === "tag" ? "Ronin: Ayo, Bex" : "Add a name"} />
            <Btn onClick={addPlayer} tone="primary" style={{ flexShrink: 0 }}><Plus size={16} />Add</Btn>
          </div>
          {players.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {players.map((p) => (
                <span key={p.id} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, background: C.surface,
                  border: `1px solid ${C.line}`, borderRadius: 3, padding: "6px 9px", fontSize: 14,
                }}>
                  <span>
                    {p.name}
                    {p.members && (
                      <span style={{ color: C.muted, fontSize: 12 }}> · {p.members.join(", ")}</span>
                    )}
                  </span>
                  <button onClick={() => setPlayers((v) => v.filter((x) => x.id !== p.id))}
                    aria-label={`Remove ${p.name}`}
                    style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 0, display: "flex" }}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea style={{ ...inputStyle, marginTop: 10, minHeight: 66, resize: "vertical" }}
            value={bulk} onChange={(e) => setBulk(e.target.value)}
            placeholder={format === "tag"
              ? "Or paste a list — one team per line, as Name: member, member"
              : "Or paste a list — one name per line"} />
          {bulk.trim() && <Btn onClick={addBulk} style={{ marginTop: 6 }}>Add pasted names</Btn>}
        </Field>

        {format === "league" ? (
          <>
            <Block title="League points"
              hint="A match run to a target rarely ends level, but a draw is counted rather than quietly scoring nothing.">
              <div style={{ display: "flex", gap: 10 }}>
                <NumField label="For a win" value={leaguePoints.win}
                  onChange={(v) => setLeaguePoints((l) => ({ ...l, win: v }))} />
                <NumField label="For a draw" value={leaguePoints.draw}
                  onChange={(v) => setLeaguePoints((l) => ({ ...l, draw: v }))} />
              </div>
            </Block>

            <Field label="Points to win a match"
              hint="Every fixture runs to this target. A finish that would overshoot is capped.">
              <Segmented value={points.group}
                onChange={(v) => setPoints((p) => ({ ...p, group: v }))}
                options={[3, 4, 5, 7, 9].map((n) => ({ value: n, label: String(n) }))} />
            </Field>
          </>
        ) : (
          <>
        <Field label="Number of groups">
          <Segmented value={numGroups} onChange={setNumGroups}
            options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: String(n) }))} />
        </Field>

        <Field label={`${format === "tag" ? "Teams" : "Bladers"} advancing from each group`}>
          <Segmented value={advance} onChange={setAdvance}
            options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} />
        </Field>

        <Field label="Knockout stage starts at">
          <Segmented value={koSize} onChange={setKoSize} options={[
            { value: 16, label: "Ro16" }, { value: 8, label: "Quarters" },
            { value: 4, label: "Semis" }, { value: 2, label: "Final" }, { value: 0, label: "None" },
          ]} />
        </Field>

        {koSize > 0 && (
          <div style={{
            background: tooMany ? `${C.magenta}18` : C.surface,
            border: `1px solid ${tooMany ? C.magenta : C.line}`, borderRadius: 3,
            padding: "11px 13px", fontSize: 13.5, color: tooMany ? C.magenta : C.muted,
            marginBottom: 18, display: "flex", gap: 9, lineHeight: 1.45,
          }}>
            {tooMany && <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
            <span>
              {numGroups} groups × {advance} advancing = {qualifiers} qualifiers for {koSize} slots.
              {tooMany && " Reduce the groups or how many advance, or start the knockout later."}
              {!tooMany && byes > 0 && ` The ${byes} top seed${byes > 1 ? "s" : ""} will get a bye.`}
            </span>
          </div>
        )}

        {koSize >= 4 && (
          <label style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 22, cursor: "pointer" }}>
            <input type="checkbox" checked={third} onChange={(e) => setThird(e.target.checked)}
              style={{ width: 17, height: 17, accentColor: C.magenta }} />
            <span style={{ fontSize: 14.5 }}>Play a third-place match</span>
          </label>
        )}

        <Field label="Points to win a match"
          hint="Each stage runs on its own target. A finish that would overshoot is capped — on a first-to-4 match, an Xtreme at 2–1 finishes it 4–1, not 5–1.">
          <StagePoints koSize={koSize} thirdPlace={third} points={points} onChange={setPoints} />
        </Field>
          </>
        )}

        <Btn onClick={create} tone="primary" disabled={!ready}
          style={{ width: "100%", justifyContent: "center", padding: 15, fontSize: 18, marginTop: 8 }}>
          Create tournament <ChevronRight size={18} />
        </Btn>

        {blocker && (
          <div style={{
            marginTop: 12, padding: "12px 14px", borderRadius: 3,
            background: `${C.gold}14`, border: `1px solid ${C.gold}55`,
            display: "flex", gap: 10, alignItems: "flex-start",
          }}>
            <AlertTriangle size={16} color={C.gold} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              {blocker}
              {tooMany && fits && (
                <div style={{ marginTop: 10 }}>
                  <Btn onClick={() => setKoSize(fits)} tone="cool" style={{ padding: "8px 12px", fontSize: 14 }}>
                    Start the knockout at {roundName(fits).toLowerCase()}
                  </Btn>
                </div>
              )}
              {tooMany && !fits && (
                <div style={{ marginTop: 6, color: C.muted }}>
                  More than 16 qualifiers is beyond the biggest knockout — reduce the
                  groups, or how many advance from each.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Groups                                                             */
/* ================================================================== */

function GroupsView({ t, update, nameOf, isAdmin }) {
  const [moving, setMoving] = useState(null);
  const [ask, setAsk] = useState(null);         // null | "redraw" | "blocked"
  const [pending, setPending] = useState(null); // a move/remove awaiting confirmation
  const [entry, setEntry] = useState("");
  const assigned = new Set(t.groups.flatMap((g) => g.playerIds));
  const unassigned = t.players.filter((p) => !assigned.has(p.id));

  const draw = () => {
    update((d) => {
      const ids = d.players.map((p) => p.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      d.groups.forEach((g) => (g.playerIds = []));
      ids.forEach((id, i) => d.groups[i % d.groups.length].playerIds.push(id));
      d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
      return d;
    });
    setAsk(null);
  };

  const scored = scoredCount(t);
  const alreadyDrawn = t.groups.some((g) => g.playerIds.length > 0);

  // A redraw once scores exist is never what someone means to do mid-event, so
  // it is refused rather than merely confirmed — clearing the results has to be
  // a separate, deliberate act.
  const onDrawClick = () => {
    if (scored > 0) setAsk("blocked");
    else if (alreadyDrawn) setAsk("redraw");
    else draw();
  };

  /* ---- roster changes ---- */

  const groupOf = (pid) => t.groups.find((g) => g.playerIds.includes(pid));

  /** Results this blader already has. Moving or removing them discards these. */
  const playedBy = (pid) =>
    t.groupMatches.filter((m) => (m.p1 === pid || m.p2 === pid) && (m.events || []).length > 0).length;

  const bracketMatches = (b) =>
    b ? [...b.rounds.flat(), ...(b.third ? [b.third] : [])] : [];

  const inBracket = (pid) =>
    bracketMatches(t.bracket).some((m) => m.p1 === pid || m.p2 === pid);

  const addPlayer = () => {
    const name = entry.trim();
    if (!name) return;
    // Placed outside the groups, so putting them somewhere stays a decision.
    update((d) => { d.players.push({ id: uid(), name }); return d; });
    setEntry("");
  };

  const moveTo = (playerId, gid) => {
    update((d) => {
      d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== playerId)));
      if (gid) d.groups.find((g) => g.id === gid).playerIds.push(playerId);
      // Fixtures against their old group cease to exist, and with them any
      // results those fixtures held.
      d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
      return d;
    });
    setMoving(null); setPending(null);
  };

  const removePlayer = (playerId) => {
    update((d) => {
      d.players = d.players.filter((p) => p.id !== playerId);
      d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== playerId)));
      d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
      // A bracket holding a blader who no longer exists is a fiction.
      if (bracketMatches(d.bracket).some((m) => m.p1 === playerId || m.p2 === playerId)) {
        d.bracket = null;
      }
      return d;
    });
    setMoving(null); setPending(null);
  };

  // Same group in, same group out costs nothing, so it skips the warning.
  const askMove = (playerId, gid) => {
    const from = groupOf(playerId);
    if (gid && from && from.id === gid) { setMoving(null); return; }
    if (playedBy(playerId) > 0) setPending({ kind: "move", pid: playerId, gid });
    else moveTo(playerId, gid);
  };

  const askRemove = (playerId) => {
    if (playedBy(playerId) > 0 || inBracket(playerId)) setPending({ kind: "remove", pid: playerId });
    else removePlayer(playerId);
  };

  return (
    <div>
      <SectionHead title="Groups"
        sub={isAdmin
          ? "Tap a blader to move them. Results between two bladers who stay in the same group are kept."
          : "Who's in which group."}
        action={isAdmin ? (
          <Btn onClick={onDrawClick} tone={scored > 0 ? "ghost" : "primary"}>
            <Shuffle size={15} />Random draw
          </Btn>
        ) : null} />

      {ask === "redraw" && (
        <Confirm
          title="Redraw the groups?"
          body="Everyone is reshuffled at random and all fixtures are rebuilt. The current group arrangement is lost."
          confirmLabel="Redraw" onConfirm={draw} onClose={() => setAsk(null)}
        />
      )}
      {ask === "blocked" && (
        <Confirm
          title="Results are already in"
          body={`${scored} match${scored > 1 ? "es have" : " has"} been scored. Redrawing would wipe ${scored > 1 ? "those results" : "that result"}, so it's blocked here. To start over, reset the match results in Settings first.`}
          onClose={() => setAsk(null)}
        />
      )}

      {pending && (
        <Confirm
          title={pending.kind === "remove" ? "Remove this blader?" : "Move them now?"}
          tone="danger" confirmLabel={pending.kind === "remove" ? "Remove" : "Move anyway"}
          body={(() => {
            const n = playedBy(pending.pid);
            const who = nameOf(pending.pid);
            const played = `${n} match${n > 1 ? "es" : ""} ${who} ${n > 1 ? "have" : "has"} already played`;
            if (pending.kind === "remove") {
              return `${who} leaves the tournament, and ${played} ${n > 1 ? "go" : "goes"} with them.`
                + (inBracket(pending.pid)
                  ? " They are in the knockout bracket, so the bracket is removed too — rebuild it from the Table tab."
                  : "");
            }
            const to = pending.gid ? (t.groups.find((g) => g.id === pending.gid) || {}).name : "no group";
            return `Moving ${who} to ${to} rebuilds their fixtures, so ${played} ${n > 1 ? "are" : "is"} discarded.`;
          })()}
          onConfirm={() => (pending.kind === "remove"
            ? removePlayer(pending.pid)
            : moveTo(pending.pid, pending.gid))}
          onClose={() => setPending(null)}
        />
      )}

      {isAdmin && (
        <div style={{ ...card, marginBottom: 14 }}>
          <div className="bx-d" style={{ fontSize: 16, fontWeight: 700, marginBottom: 9 }}>Add a blader</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={inputStyle} value={entry} onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPlayer()} placeholder="Name" />
            <Btn onClick={addPlayer} tone="primary" style={{ flexShrink: 0 }}><Plus size={16} />Add</Btn>
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8, lineHeight: 1.45, maxWidth: "56ch" }}>
            They arrive outside the groups. Tap them below to place them — everyone
            already in that group picks up a new fixture against them.
          </div>
        </div>
      )}

      {unassigned.length > 0 && (
        <div style={{ ...card, borderColor: `${C.gold}77`, marginBottom: 14 }}>
          <div className="bx-d" style={{ fontSize: 16, color: C.gold, fontWeight: 700, marginBottom: 9 }}>
            Not in a group yet
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {unassigned.map((p) => (
              <Chip key={p.id} onClick={isAdmin ? () => setMoving(p.id) : undefined} active={moving === p.id}>{p.name}</Chip>
            ))}
          </div>
        </div>
      )}

      {isAdmin && moving && (
        <div style={{
          position: "sticky", top: 70, zIndex: 15, background: C.raised,
          border: `1px solid ${C.magenta}`, borderRadius: 4, padding: 12, marginBottom: 14,
        }}>
          <div style={{ fontSize: 13.5, marginBottom: 9 }}>
            Move <strong>{nameOf(moving)}</strong> to
            {playedBy(moving) > 0 && (
              <span style={{ color: C.gold }}> — {playedBy(moving)} played match{playedBy(moving) > 1 ? "es" : ""} at stake</span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {t.groups.map((g) => <Btn key={g.id} onClick={() => askMove(moving, g.id)}>{g.name}</Btn>)}
            <Btn onClick={() => askMove(moving, null)} tone="ghost">Unassign</Btn>
            <Btn onClick={() => askRemove(moving)} tone="danger"><Trash2 size={14} />Remove</Btn>
            <Btn onClick={() => setMoving(null)} tone="ghost">Cancel</Btn>
          </div>
        </div>
      )}

      {t.groups.map((g, gi) => {
        const col = GROUP_COLORS[gi % GROUP_COLORS.length];
        return (
          <div key={g.id} style={{ ...card, marginBottom: 12, borderLeft: `4px solid ${col}` }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 11 }}>
              <span className="bx-d" style={{ fontSize: 19, fontWeight: 800, color: col }}>{g.name}</span>
              <span style={{ color: C.muted, fontSize: 13 }}>{g.playerIds.length} bladers</span>
            </div>
            {g.playerIds.length === 0 ? (
              <div style={{ color: C.muted, fontSize: 13.5 }}>{isAdmin ? "Empty. Run the draw or move bladers in." : "Not drawn yet."}</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {g.playerIds.map((id) => (
                  <Chip key={id} onClick={isAdmin ? () => setMoving(id) : undefined} active={moving === id}>
                    {nameOf(id)}
                    {membersOf(t, id) && (
                      <span style={{ color: C.muted, fontSize: 11.5 }}> · {membersOf(t, id).join(", ")}</span>
                    )}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Chip({ children, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.magenta : C.raised,
      color: active ? "#14020A" : C.ink,
      border: `1px solid ${active ? C.magenta : C.line}`,
      borderRadius: 3, padding: "8px 11px", fontSize: 14, cursor: "pointer", fontWeight: 500,
    }}>{children}</button>
  );
}

/* ================================================================== */
/*  Matches                                                            */
/* ================================================================== */

function MatchesView({ t, nameOf, onScore, isAdmin, group, setGroup }) {
  if (!t.groupMatches.length) {
    return <EmptyState title="No fixtures yet"
      body="Make the group draw first — fixtures build themselves as soon as bladers are in groups." />;
  }
  return (
    <div>
      <SectionHead title={isLeague(t) ? "Fixtures" : "Group matches"}
        sub={(isLeague(t)
          ? `Everyone plays everyone once, first to ${t.points.group}.`
          : `Everyone plays everyone in their group, first to ${t.points.group}.`)
          + (isAdmin ? " Tap a match to score it." : "")} />
      <GroupPicker t={t} value={group} onChange={setGroup} />
      {/* Indexed over every group, not the filtered set, so each keeps its colour. */}
      {t.groups.map((g, gi) => {
        if (group !== ALL_GROUPS && g.id !== group) return null;
        const ms = t.groupMatches.filter((m) => m.groupId === g.id);
        if (!ms.length) return null;
        const done = ms.filter((m) => m.done).length;
        const col = GROUP_COLORS[gi % GROUP_COLORS.length];
        return (
          <div key={g.id} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
              <Blade color={col} h={17} />
              <span className="bx-d" style={{ fontSize: 18, fontWeight: 700 }}>{g.name}</span>
              <span style={{
                marginLeft: "auto", fontSize: 12.5,
                color: done === ms.length ? C.green : C.muted,
              }}>{done}/{ms.length} played</span>
            </div>
            {ms.map((m) => <MatchRow key={m.id} m={m} nameOf={nameOf} locked={!isAdmin} onClick={() => onScore(m.id)} />)}
          </div>
        );
      })}
    </div>
  );
}

/** byePossible: only the opening round, where an empty slot really is a bye. */
function MatchRow({ m, nameOf, onClick, label, locked, byePossible }) {
  const { s1, s2 } = scoreOf(m);
  const w = winnerOf(m);
  const both = m.p1 && m.p2 && !locked;
  return (
    <button onClick={both ? onClick : undefined} disabled={!both}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10,
        background: C.surface, border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${m.done ? C.green : C.raised}`,
        borderRadius: 3, padding: "12px", marginBottom: 6,
        cursor: both ? "pointer" : "default", textAlign: "left", color: C.ink,
      }}>
      {label && <span className="bx-d" style={{ fontSize: 12, color: C.muted, width: 28, flexShrink: 0 }}>{label}</span>}
      <span style={{
        flex: 1, fontSize: 14.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", fontWeight: w === m.p1 ? 700 : 400,
        color: m.p1 ? (w === m.p1 ? C.magenta : C.ink) : C.muted,
      }}>{m.p1 ? nameOf(m.p1) : "TBD"}</span>
      <span className="bx-d" style={{
        fontSize: 19, fontWeight: 800, flexShrink: 0,
        color: m.done ? C.ink : C.muted, minWidth: 50, textAlign: "center",
      }}>{m.done ? `${s1}–${s2}` : "vs"}</span>
      <span style={{
        flex: 1, fontSize: 14.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", textAlign: "right", fontWeight: w === m.p2 ? 700 : 400,
        color: m.p2 ? (w === m.p2 ? C.cyan : C.ink) : C.muted,
      }}>{m.p2 ? nameOf(m.p2) : (m.p1 && byePossible ? "Bye" : "TBD")}</span>
    </button>
  );
}

/* ================================================================== */
/*  Standings                                                          */
/* ================================================================== */

function TableView({ t, nameOf, update, onPlayer, isAdmin, group, setGroup, onFinal }) {
  const allPlayed = t.groupMatches.length > 0 && t.groupMatches.every((m) => m.done);
  const [ask, setAsk] = useState(false);

  const makeBracket = () => {
    update((d) => {
      const quals = collectQualifiers(d.groups, d.groupMatches, d.advance, nameOf);
      d.bracket = buildBracket(quals, d.koSize, d.thirdPlace);
      return d;
    });
    setAsk(false);
  };

  // Knockout scores already entered — what a rebuild would wipe.
  const koScored = t.bracket
    ? [...t.bracket.rounds.flat(), ...(t.bracket.third ? [t.bracket.third] : [])]
        .filter((m) => (m.events || []).length > 0).length
    : 0;

  // A league has no group stage to be king of; its table already says who won.
  const kings = allPlayed && !isLeague(t) ? swissKings(t) : [];

  // The trophy is lifted, or there was never a knockout to lift one in.
  const champion = t.bracket
    ? winnerOf(t.bracket.rounds[t.bracket.rounds.length - 1][0])
    : null;
  const finished = t.koSize > 0 ? !!champion : allPlayed;

  if (!t.groupMatches.length) {
    return <EmptyState title="No standings yet" body="Draw the groups and the tables appear here." />;
  }

  return (
    <div>
      <SectionHead title={isLeague(t) ? "League table" : "Standings"} color={C.cyan}
        sub={isLeague(t)
          ? `${num(t.leaguePoints && t.leaguePoints.win)} for a win, ${num(t.leaguePoints && t.leaguePoints.draw)} for a draw, then winning margin. Tap a name for that ${oneWord(t)}'s record.`
          : `Ranked by wins, then by total margin across won matches only. Tap a name for that ${oneWord(t)}'s record.`} />

      {kings.length > 0 && (
        <div style={{
          border: `1px solid ${C.cyan}`, borderRadius: 4, marginBottom: 16,
          background: `linear-gradient(100deg, ${C.cyan}1E, ${C.magenta}10)`,
          padding: "14px 16px", display: "flex", alignItems: "center", gap: 13,
        }}>
          <Crown size={26} color={C.cyan} style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: C.cyan }}>
              {kings.length > 1 ? "Swiss Kings" : "Swiss King"}
            </div>
            <div className="bx-d" style={{ fontSize: 23, fontWeight: 800, lineHeight: 1.1 }}>
              {kings.map((k) => k.name).join(" & ")}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              Best of the group stage — {kings[0].wins} win{kings[0].wins === 1 ? "" : "s"}, margin {kings[0].margin}
              {kings.length > 1 && ", shared"}
            </div>
          </div>
        </div>
      )}

      <GroupPicker t={t} value={group} onChange={setGroup} />

      {t.groups.map((g, gi) => {
        if (group !== ALL_GROUPS && g.id !== group) return null;
        const ms = t.groupMatches.filter((m) => m.groupId === g.id);
        const rows = computeStandings(g.playerIds, ms, nameOf, isLeague(t) ? t.leaguePoints : null);
        const col = GROUP_COLORS[gi % GROUP_COLORS.length];
        return (
          <div key={g.id} style={{ ...card, marginBottom: 14, padding: 0, overflow: "hidden", borderLeft: `4px solid ${col}` }}>
            <div className="bx-d" style={{ fontSize: 18, fontWeight: 800, padding: "12px 14px 9px", color: col }}>
              {g.name}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ color: C.muted, fontSize: 12 }}>
                    {(isLeague(t)
                      ? ["", manyWord(t).replace(/s$/, ""), "P", "W", "L", "Pts", "Margin"]
                      : ["", manyWord(t).replace(/s$/, ""), "P", "W", "L", "Margin", "+/−"]
                    ).map((h, i) => (
                      <th key={i} style={{
                        textAlign: i === 1 ? "left" : i === 0 ? "center" : "right",
                        padding: "7px 10px", fontWeight: 600,
                        borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const q = isLeague(t) ? i === 0 : i < t.advance;
                    return (
                      <tr key={r.id} onClick={() => onPlayer(r.id)} style={{ cursor: "pointer" }}>
                        <td style={{ ...td, textAlign: "center", color: q ? C.gold : C.muted, fontWeight: 800, width: 26 }}>{i + 1}</td>
                        <td style={{ ...td, textAlign: "left", fontWeight: q ? 600 : 400, whiteSpace: "nowrap" }}>{nameOf(r.id)}</td>
                        <td style={td}>{r.played}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{r.wins}</td>
                        <td style={td}>{r.losses}</td>
                        {isLeague(t) ? (
                          <>
                            <td style={{ ...td, color: C.cyan, fontWeight: 800 }}>{r.pts}</td>
                            <td style={{ ...td, color: C.muted }}>{r.winMargin}</td>
                          </>
                        ) : (
                          <>
                            <td style={{ ...td, color: C.cyan, fontWeight: 700 }}>{r.winMargin}</td>
                            <td style={{ ...td, color: C.muted }}>{r.pf - r.pa > 0 ? "+" : ""}{r.pf - r.pa}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55, marginBottom: 20, maxWidth: "62ch" }}>
        Margin counts only matches a blader won — the sum of their winning point differences. It breaks
        ties on wins before anything else does.
      </div>

      {t.koSize > 0 && isAdmin && (
        <div style={{ ...card, borderColor: allPlayed ? `${C.magenta}88` : C.line }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>
            {t.bracket ? "Rebuild the knockout bracket" : "Build the knockout bracket"}
          </div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5 }}>
            {allPlayed
              ? `Seeds the top ${t.advance} from each group into the ${roundName(t.koSize).toLowerCase()}.`
              : `${t.groupMatches.filter((m) => !m.done).length} group matches still to play. You can build early, but the seeding will change.`}
            {t.bracket && " Rebuilding clears any knockout results already entered."}
          </div>
          <Btn onClick={() => (t.bracket ? setAsk(true) : makeBracket())}
            tone={allPlayed ? "primary" : "default"}>
            <GitBranch size={15} />{t.bracket ? "Rebuild bracket" : "Build bracket"}
          </Btn>
        </div>
      )}

      {finished && isAdmin && (
        <div style={{ ...card, borderColor: `${C.gold}88`, marginTop: 14 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>
            Generate final standings
          </div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "58ch" }}>
            Rank every blader on your own scoring — points per win and per margin, plus
            what each stage pays for playing and for winning. The champion need not come
            out on top. Downloads a CSV of the whole tournament with it.
          </div>
          <Btn onClick={onFinal} tone="primary"><Medal size={15} />Generate final standings</Btn>
        </div>
      )}

      {ask && (
        <Confirm
          title="Rebuild the bracket?"
          body={koScored > 0
            ? `The bracket is reseeded from the current standings, and the ${koScored} knockout match${koScored > 1 ? "es" : ""} already scored ${koScored > 1 ? "are" : "is"} cleared.`
            : "The bracket is reseeded from the current standings. Nothing has been scored in the knockout yet, so no results are lost."}
          confirmLabel="Rebuild" tone={koScored > 0 ? "danger" : "primary"}
          onConfirm={makeBracket} onClose={() => setAsk(false)}
        />
      )}
    </div>
  );
}

const td = {
  padding: "10px", textAlign: "right",
  borderBottom: `1px solid ${C.line}55`, whiteSpace: "nowrap",
};

/* ================================================================== */
/*  Bracket                                                            */
/* ================================================================== */

function BracketView({ t, nameOf, onScore, isAdmin }) {
  if (t.koSize === 0) {
    return <EmptyState title="Group stage only" body="This tournament was set up without a knockout stage." />;
  }
  if (!t.bracket) {
    return <EmptyState title="Bracket not built"
      body={isAdmin ? "Finish the group matches, then build the bracket from the Table tab." : "It appears here once the group stage wraps up."} />;
  }

  const finalMatch = t.bracket.rounds[t.bracket.rounds.length - 1][0];
  const champ = winnerOf(finalMatch);
  const runnerUp = champ && finalMatch.p1 && finalMatch.p2
    ? (champ === finalMatch.p1 ? finalMatch.p2 : finalMatch.p1) : null;
  const third = t.bracket.third ? winnerOf(t.bracket.third) : null;

  return (
    <div>
      <SectionHead title="Knockout" color={C.gold}
        sub={isAdmin ? "Winners move up automatically. Re-scoring a match re-opens everything after it." : "Live bracket."} />

      {champ && (
        <div style={{
          border: `1px solid ${C.gold}`,
          background: `linear-gradient(100deg, ${C.gold}22, ${C.magenta}12)`,
          borderRadius: 4, padding: "18px 16px", marginBottom: 20,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: runnerUp ? 14 : 0 }}>
            <Trophy size={32} color={C.gold} style={{ flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 12.5, color: C.gold }}>Champion</div>
              <div className="bx-d" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{nameOf(champ)}</div>
            </div>
          </div>
          {runnerUp && (
            <div style={{ display: "flex", gap: 20, paddingLeft: 46, fontSize: 14, flexWrap: "wrap" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Medal size={15} color={C.muted} /> 2nd {nameOf(runnerUp)}
              </span>
              {third && (
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Medal size={15} color="#C87941" /> 3rd {nameOf(third)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {t.bracket.rounds.map((r, ri) => {
        const teams = r.length * 2;
        return (
          <div key={ri} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
              <Blade color={C.gold} h={17} />
              <span className="bx-d" style={{ fontSize: 18, fontWeight: 700 }}>{roundName(teams)}</span>
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>
                first to {t.points[stageKeyForTeams(teams)]}
              </span>
            </div>
            {r.map((m, i) => (
              <MatchRow key={m.id} m={m} nameOf={nameOf} locked={!isAdmin} byePossible={ri === 0}
                onClick={() => onScore(m.id)} label={`M${i + 1}`} />
            ))}
          </div>
        );
      })}

      {t.bracket.third && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
            <Blade color="#C87941" h={17} />
            <span className="bx-d" style={{ fontSize: 18, fontWeight: 700 }}>Third place</span>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>
              first to {t.points.third}
            </span>
          </div>
          <MatchRow m={t.bracket.third} nameOf={nameOf} locked={!isAdmin} onClick={() => onScore(t.bracket.third.id)} />
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Scoring                                                            */
/* ================================================================== */

function ScoreSheet({ match, t, nameOf, onClose, onSave }) {
  const target = targetFor(match, t);
  const stage = stageOf(match, t);
  const stageLabel = (stagesFor(t.koSize, t.thirdPlace).find((s) => s.key === stage) || {}).label || "Match";

  const [events, setEvents] = useState(match.events || []);
  const [askReset, setAskReset] = useState(false);
  const [askLeave, setAskLeave] = useState(false);
  const [askUndo, setAskUndo] = useState(false);
  const s1 = events.filter((e) => e.side === 1).reduce((a, e) => a + e.pts, 0);
  const s2 = events.filter((e) => e.side === 2).reduce((a, e) => a + e.pts, 0);
  const over = s1 >= target || s2 >= target;

  // Nothing here is written until Save, so every way out of this sheet throws
  // away whatever has been tapped in. Ask first — the swipe especially is easy
  // to trigger by accident, and Cancel sits right beside Save.
  const dirty = JSON.stringify(events) !== JSON.stringify(match.events || []);
  const tryClose = () => (dirty ? setAskLeave(true) : onClose());
  const swipeBack = useSwipeBack(tryClose);

  const undo = () => setEvents((v) => v.slice(0, -1));

  /*
   * Undo is a rapid correction while scoring, so it stays instant — asking
   * after every mis-tap would make it useless. The exception is the first
   * touch to a result that is already saved: that is editing history, not
   * correcting a typo. Once that edit is confirmed, undo goes quiet again.
   */
  const tryUndo = () => (match.done && !dirty ? setAskUndo(true) : undo());

  const add = (side, f) => {
    if (over) return;
    const cur = side === 1 ? s1 : s2;
    const pts = Math.min(f.pts, target - cur); // cap at the stage target
    if (pts <= 0) return;
    setEvents((v) => [...v, { side, type: f.key, pts, raw: f.pts }]);
  };

  const Side = ({ side, color }) => {
    const val = side === 1 ? s1 : s2;

    const awardBtn = (f, extra) => {
      const award = Math.min(f.pts, target - val);
      const capped = !over && award > 0 && award < f.pts;
      return (
        <button key={f.key} onClick={() => add(side, f)} disabled={over} className="bx-d"
          style={{
            background: C.raised, border: `1px solid ${capped ? C.gold + "88" : C.line}`,
            borderRadius: 3, color: over ? C.muted : C.ink, padding: "12px 4px",
            fontSize: 15, fontWeight: 700, cursor: over ? "not-allowed" : "pointer",
            opacity: over ? 0.4 : 1, ...extra,
          }}>
          {f.label}
          <span style={{ color: capped ? C.gold : C.muted, fontWeight: 600 }}> +{over ? f.pts : award}</span>
        </button>
      );
    };

    return (
      <div style={{
        flex: 1, background: `${color}12`, border: `1px solid ${color}55`,
        borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", minWidth: 0,
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600, color, marginBottom: 2,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{nameOf(side === 1 ? match.p1 : match.p2)}</div>
        <div className="bx-d" style={{
          fontSize: 62, fontWeight: 800, lineHeight: .95, color, marginBottom: 10,
        }}>{val}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {FINISHES.map((f) => awardBtn(f))}
        </div>
        {/* Set apart from the finishes — the point comes from the opponent's foul. */}
        {awardBtn(PENALTY, {
          marginTop: 6, background: "transparent",
          borderStyle: "dashed", fontSize: 14, padding: "10px 4px",
        })}
      </div>
    );
  };

  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={tryClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.05 }}>First to {target}</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>{stageLabel}</div>
        </div>
        <Btn onClick={() => (events.length ? setAskReset(true) : null)} tone="ghost"
          disabled={!events.length} style={{ padding: "7px 11px" }}>Reset</Btn>
        <span className="bx-undo-head">
          <Btn onClick={tryUndo} tone="ghost" disabled={!events.length}
            style={{ padding: "7px 11px" }} aria-label="Undo last finish"><Undo2 size={15} /></Btn>
        </span>
      </div>

      {askUndo && (
        <Confirm
          title="Change a saved result?"
          body={`This match is saved as ${scoreOf(match).s1}–${scoreOf(match).s2}. Undoing takes the last point back off it — nothing changes for anyone else until you save again.`}
          confirmLabel="Undo" tone="danger"
          onConfirm={() => { undo(); setAskUndo(false); }}
          onClose={() => setAskUndo(false)}
        />
      )}

      {askLeave && (
        <Confirm
          title="Leave without saving?"
          body={match.done
            ? `This match goes back to the saved ${scoreOf(match).s1}–${scoreOf(match).s2}. What you have tapped in here is discarded.`
            : `Nothing is saved for this match yet, so the ${s1}–${s2} on screen is discarded.`}
          confirmLabel="Discard" tone="danger"
          onConfirm={onClose} onClose={() => setAskLeave(false)}
        />
      )}

      {askReset && (
        <Confirm
          title="Clear this match?"
          body={`All ${events.length} point${events.length > 1 ? "s" : ""} scored in this match ${events.length > 1 ? "are" : "is"} removed and the scoreboard goes back to 0–0.`}
          confirmLabel="Clear" tone="danger"
          onConfirm={() => { setEvents([]); setAskReset(false); }}
          onClose={() => setAskReset(false)}
        />
      )}

      {events.length > 0 && (
        <button
          onClick={tryUndo}
          className="bx-d bx-undo-fab" aria-label="Undo last finish"
          style={{
            position: "fixed", left: "50%", transform: "translateX(-50%)",
            bottom: "calc(env(safe-area-inset-bottom) + 24px)", zIndex: 70,
            alignItems: "center", gap: 8, padding: "14px 26px", borderRadius: 999,
            background: C.raised, color: C.ink, border: `1px solid ${C.line}`,
            fontSize: 16, fontWeight: 700, cursor: "pointer",
            boxShadow: "0 8px 24px #00000077",
          }}>
          <Undo2 size={17} />Undo
        </button>
      )}

      <div style={{
        padding: "16px 16px 110px", maxWidth: 720, margin: "0 auto",
        width: "100%", boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <Side side={1} color={C.magenta} />
          <div className="bx-d" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 26, fontWeight: 800, color: C.line, width: 20, flexShrink: 0,
          }}>✕</div>
          <Side side={2} color={C.cyan} />
        </div>

        {over && (
          <div style={{
            marginTop: 14, padding: "13px 14px", borderRadius: 4,
            background: `${C.green}16`, border: `1px solid ${C.green}66`,
            fontSize: 14.5, display: "flex", alignItems: "center", gap: 9,
          }}>
            <Check size={17} color={C.green} />
            <span><strong>{nameOf(s1 > s2 ? match.p1 : match.p2)}</strong> takes it {Math.max(s1, s2)}–{Math.min(s1, s2)}</span>
          </div>
        )}

        {events.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 7 }}>Finish log</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {events.map((e, i) => {
                const col = e.side === 1 ? C.magenta : C.cyan;
                const capped = e.raw && e.pts < e.raw;
                return (
                  <span key={i} style={{
                    fontSize: 12, padding: "4px 8px", borderRadius: 3,
                    background: `${col}18`, color: col, border: `1px solid ${col}44`,
                  }}>
                    {(awardOf(e.type) || { label: e.type }).label} +{e.pts}
                    {capped && <span style={{ color: C.gold }}> (capped from {e.raw})</span>}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <Btn onClick={tryClose} tone="ghost" style={{ flex: 1, justifyContent: "center", padding: 14 }}>Cancel</Btn>
          <Btn onClick={() => onSave(events, over)} tone="primary" disabled={!over}
            style={{ flex: 2, justifyContent: "center", padding: 14, fontSize: 17 }}>Save result</Btn>
        </div>
        {!over && (
          <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>
            Save unlocks when a blader reaches {target}.
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Blader records                                                     */
/* ================================================================== */

function playerStats(pid, allMatches, t) {
  const zeroed = () => Object.fromEntries(AWARDS.map((a) => [a.key, 0]));
  const st = {
    played: 0, wins: 0, losses: 0, pf: 0, pa: 0, winMargin: 0,
    finishes: zeroed(),
    conceded: zeroed(),
    log: [],
  };
  allMatches.forEach((m) => {
    if (!m.done || (m.p1 !== pid && m.p2 !== pid)) return;
    if (!m.p1 || !m.p2) return;
    const me = m.p1 === pid ? 1 : 2;
    const { s1, s2 } = scoreOf(m);
    const my = me === 1 ? s1 : s2, opp = me === 1 ? s2 : s1;
    st.played++; st.pf += my; st.pa += opp;
    const won = my > opp;
    if (won) { st.wins++; st.winMargin += my - opp; } else if (opp > my) st.losses++;
    const tally = (bucket, type) => { if (bucket[type] != null) bucket[type]++; };
    (m.events || []).forEach((e) => {
      tally(e.side === me ? st.finishes : st.conceded, e.type);
    });
    const key = stageOf(m, t);
    const label = (stagesFor(t.koSize, t.thirdPlace).find((s) => s.key === key) || {}).label || "Match";
    st.log.push({
      id: m.id, opp: me === 1 ? m.p2 : m.p1, my, oppScore: opp, won, stage: label,
      // Every point of the match in the order it was scored, from this blader's side.
      sequence: (m.events || []).map((e) => ({ type: e.type, pts: e.pts, mine: e.side === me })),
    });
  });
  return st;
}

function PlayersView({ t, nameOf, allMatches, onPlayer }) {
  const rows = t.players
    .map((p) => ({ p, st: playerStats(p.id, allMatches, t) }))
    .sort((a, b) => b.st.wins - a.st.wins || b.st.winMargin - a.st.winMargin || a.p.name.localeCompare(b.p.name));

  return (
    <div>
      <SectionHead title={manyWord(t)} color={C.green}
        sub={`Every match a ${oneWord(t)} has played, group stage and knockout together. Tap for the full record.`} />
      {rows.map(({ p, st }) => (
        <button key={p.id} onClick={() => onPlayer(p.id)} style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3,
          padding: "13px", marginBottom: 6, cursor: "pointer", color: C.ink, textAlign: "left",
        }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{p.name}</span>
          <span style={{ fontSize: 13, color: C.muted }}>{st.played} played</span>
          <span className="bx-d" style={{ fontSize: 17, fontWeight: 800, minWidth: 46, textAlign: "right" }}>
            <span style={{ color: C.green }}>{st.wins}</span>
            <span style={{ color: C.muted }}>–</span>
            <span style={{ color: C.magenta }}>{st.losses}</span>
          </span>
          <ChevronRight size={16} color={C.muted} />
        </button>
      ))}
    </div>
  );
}

function PlayerSheet({ playerId, t, nameOf, allMatches, onClose }) {
  const st = playerStats(playerId, allMatches, t);
  const group = t.groups.find((g) => g.playerIds.includes(playerId));
  const gi = t.groups.findIndex((g) => g.playerIds.includes(playerId));
  const col = gi >= 0 ? GROUP_COLORS[gi % GROUP_COLORS.length] : C.magenta;

  const swipeBack = useSwipeBack(onClose);

  const Stat = ({ label, value, color }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3, padding: "11px 12px" }}>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>{label}</div>
      <div className="bx-d" style={{ fontSize: 26, fontWeight: 800, color: color || C.ink, lineHeight: 1 }}>{value}</div>
    </div>
  );

  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <Blade color={col} h={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.05 }}>{nameOf(playerId)}</div>
          {group && <div style={{ fontSize: 12, color: col }}>{group.name}</div>}
          {membersOf(t, playerId) && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>
              {membersOf(t, playerId).join(" · ")}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(94px,1fr))", gap: 8, marginBottom: 22 }}>
          <Stat label="Played" value={st.played} />
          <Stat label="Won" value={st.wins} color={C.green} />
          <Stat label="Lost" value={st.losses} color={C.magenta} />
          <Stat label="Win margin" value={st.winMargin} color={C.cyan} />
          <Stat label="Points for" value={st.pf} />
          <Stat label="Against" value={st.pa} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
          <Blade color={C.cyan} h={16} />
          <h3 className="bx-d" style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>Finishes</h3>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(66px,1fr))",
          gap: 7, marginBottom: 22,
        }}>
          {AWARDS.map((f) => (
            <div key={f.key} style={{
              background: C.surface, borderRadius: 3, padding: "11px 6px", textAlign: "center",
              border: `1px solid ${C.line}`,
              borderStyle: f.key === PENALTY.key ? "dashed" : "solid",
            }}>
              <div className="bx-d" style={{ fontSize: 24, fontWeight: 800 }}>{st.finishes[f.key]}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.label}</div>
              <div style={{ fontSize: 10.5, color: C.line }}>{st.conceded[f.key]} against</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
          <Blade color={C.gold} h={16} />
          <h3 className="bx-d" style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>Match by match</h3>
        </div>
        {st.log.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 14 }}>No completed matches yet.</div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10, lineHeight: 1.5, maxWidth: "62ch" }}>
              Each match lists every point in the order it was scored — <span style={{ color: C.green }}>green
              theirs</span>, <span style={{ color: C.magenta }}>magenta the opponent's</span>.
            </div>
            {st.log.map((r) => (
              <div key={r.id} style={{
                background: C.surface, border: `1px solid ${C.line}`,
                borderLeft: `3px solid ${r.won ? C.green : C.magenta}`,
                borderRadius: 3, padding: "12px", marginBottom: 6,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, color: C.muted, width: 76, flexShrink: 0, lineHeight: 1.2 }}>{r.stage}</span>
                  <span style={{ flex: 1, fontSize: 14.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {nameOf(r.opp)}
                  </span>
                  <span className="bx-d" style={{ fontSize: 18, fontWeight: 800, color: r.won ? C.green : C.magenta }}>
                    {r.my}–{r.oppScore}
                  </span>
                </div>
                {r.sequence.length > 0 && (
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10,
                    paddingTop: 10, borderTop: `1px solid ${C.line}66`,
                  }}>
                    {r.sequence.map((e, i) => {
                      const a = awardOf(e.type);
                      const col = e.mine ? C.green : C.magenta;
                      return (
                        <span key={i} style={{
                          fontSize: 11.5, padding: "3px 7px", borderRadius: 3,
                          background: `${col}16`, color: col, border: `1px solid ${col}44`,
                          borderStyle: e.type === PENALTY.key ? "dashed" : "solid", whiteSpace: "nowrap",
                        }}>
                          {i + 1}. {(a || { label: e.type }).label} +{e.pts}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Settings                                                           */
/* ================================================================== */

const SCORING_KEY = "bx:scoring";

function loadScoring() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCORING_KEY));
    if (saved && saved.stages) return { ...defaultScoring(), ...saved };
  } catch (e) { /* nothing usable stored */ }
  return defaultScoring();
}

/**
 * Final standings on the organiser's own terms. The ranking recalculates as
 * the weights are typed, so a scheme can be felt out rather than guessed at,
 * and the CSV carries the whole tournament out with it.
 */
/*
 * Defined out here on purpose. Declared inside the sheet, this is a new
 * component type on every render, so React tears the input down and builds it
 * again on each keystroke — the field loses focus and a phone's keypad shuts
 * every time a digit is typed.
 *
 * A div rather than a label, too: these sit inside a labelled block, and a
 * label within a label sends a tap to the wrong field.
 */
function NumField({ label, aria, value, onChange }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 5 }}>{label}</div>
      <input
        type="number" inputMode="decimal" step="any" value={value} aria-label={aria || label}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, padding: "9px 10px", fontSize: 15 }}
      />
    </div>
  );
}

/** A labelled block that is not a <label>, so it can hold several inputs. */
function Block({ title, hint, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="bx-d" style={{ fontSize: 15, color: C.ink, marginBottom: 7, fontWeight: 600 }}>{title}</div>
      {children}
      {hint && <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 1.45, maxWidth: "58ch" }}>{hint}</div>}
    </div>
  );
}

function FinalStandingsSheet({ t, onClose }) {
  const [cfg, setCfg] = useState(loadScoring);
  const swipeBack = useSwipeBack(onClose);

  useEffect(() => {
    try { localStorage.setItem(SCORING_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  }, [cfg]);

  const stages = stagesFor(t.koSize, t.thirdPlace);
  const kings = useMemo(() => swissKings(t), [t]);
  const rows = useMemo(() => finalStandings(t, cfg), [t, cfg]);

  const setStage = (key, field, v) =>
    setCfg((c) => ({ ...c, stages: { ...c.stages, [key]: { ...c.stages[key], [field]: v } } }));

  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div className="bx-d" style={{ fontSize: 22, fontWeight: 800 }}>Final standings</div>
      </div>

      {/* The Swiss King belongs on the Standings tab; here it is only carried
          into the CSV. This page is for setting the weights. */}
      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
        <Block title="Every win is worth"
          hint="Margin counts only for the blader who won, the same margin shown in Standings. Both are added to whatever the stage below pays.">
          <div style={{ display: "flex", gap: 10 }}>
            <NumField label="Points per win" value={cfg.perWin}
              onChange={(v) => setCfg((c) => ({ ...c, perWin: v }))} />
            <NumField label="Points per margin point" value={cfg.perMargin}
              onChange={(v) => setCfg((c) => ({ ...c, perMargin: v }))} />
          </div>
        </Block>

        <Block title="Stage bonuses"
          hint="Left column is paid for turning up to that stage, right for winning there. Leave a stage at 0 to pay nothing for it.">
          <div style={{ display: "grid", gap: 8 }}>
            {stages.map((s, i) => (
              <div key={s.key} style={{
                background: C.base, border: `1px solid ${C.line}`, borderRadius: 3, padding: "10px 12px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                  <Blade color={GROUP_COLORS[i % GROUP_COLORS.length]} h={14} />
                  <span className="bx-d" style={{ fontSize: 15.5, fontWeight: 700 }}>{s.label}</span>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <NumField label="For playing" aria={`${s.label}, bonus for playing`}
                    value={cfg.stages[s.key].play}
                    onChange={(v) => setStage(s.key, "play", v)} />
                  <NumField label="For winning" aria={`${s.label}, bonus for winning`}
                    value={cfg.stages[s.key].win}
                    onChange={(v) => setStage(s.key, "win", v)} />
                </div>
              </div>
            ))}
          </div>
        </Block>

        <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "26px 0 10px" }}>
          <Blade color={C.gold} h={18} />
          <h3 className="bx-d" style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>The ranking</h3>
          <Btn onClick={() => setCfg(defaultScoring())} tone="ghost"
            style={{ marginLeft: "auto", padding: "6px 10px", fontSize: 13 }}>Reset weights</Btn>
        </div>

        <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ color: C.muted, fontSize: 12 }}>
                  {["", "Blader", "Total", "P", "W", "Margin"].map((h, i) => (
                    <th key={i} style={{
                      textAlign: i === 1 ? "left" : i === 0 ? "center" : "right",
                      padding: "8px 10px", fontWeight: 600,
                      borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ ...td, textAlign: "center", width: 28, fontWeight: 800, color: r.rank <= 3 ? C.gold : C.muted }}>{r.rank}</td>
                    <td style={{ ...td, textAlign: "left", whiteSpace: "nowrap", fontWeight: r.rank <= 3 ? 600 : 400 }}>{r.name}</td>
                    <td style={{ ...td, color: C.cyan, fontWeight: 800 }}>{Math.round(r.total * 100) / 100}</td>
                    <td style={td}>{r.played}</td>
                    <td style={td}>{r.wins}</td>
                    <td style={{ ...td, color: C.muted }}>{r.margin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {rows.length === 0 && (
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 18 }}>
            No completed matches to rank yet.
          </div>
        )}

        <Btn tone="primary" disabled={rows.length === 0}
          onClick={() => downloadCSV(`${slug(t.name)}-final-standings.csv`, buildFinalCSV(t, cfg, rows, kings))}
          style={{ width: "100%", justifyContent: "center", padding: 15, fontSize: 17 }}>
          <Download size={18} />Download the CSV
        </Btn>
        <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, lineHeight: 1.5, maxWidth: "58ch" }}>
          The file holds this ranking, the weights behind it, the Swiss King, and every
          match point by point — so nothing is lost when the tournament is cleared.
        </div>
      </div>
    </div>
  );
}

function SettingsSheet({ t, update, onClose, onReset, onReferees, canDelete }) {
  const [confirm, setConfirm] = useState(false);
  const [askClear, setAskClear] = useState(false);
  const scored = scoredCount(t);

  /* Scores go, the shape of the tournament stays. The bracket goes too: it was
     seeded from standings that no longer exist, so it would be a fiction. */
  const clearResults = () => {
    update((d) => {
      d.groupMatches.forEach((m) => { m.events = []; m.done = false; });
      d.bracket = null;
      return d;
    });
    setAskClear(false);
  };

  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div className="bx-d" style={{ fontSize: 22, fontWeight: 800 }}>Settings</div>
      </div>

      <div style={{ padding: 16, maxWidth: 620, margin: "0 auto" }}>
        <Field label="Tournament name">
          <input style={inputStyle} value={t.name}
            onChange={(e) => update((d) => { d.name = e.target.value; return d; })} />
        </Field>

        <Field label="Organiser logo"
          hint="Shown beside the tournament name. A PNG with a transparent background looks best — transparency is kept.">
          <ImagePicker kind="logo" value={t.logoUrl || null}
            onChange={(url) => update((d) => { d.logoUrl = url; return d; })} />
        </Field>

        <Field label="Background image"
          hint="Faded far behind the scoreboard. Resized in your browser before upload, so spectators load about 100KB no matter how big the original is.">
          <ImagePicker kind="bg" value={t.bgUrl || null}
            onChange={(url) => update((d) => { d.bgUrl = url; return d; })} />
        </Field>

        <Field label="Points to win a match"
          hint="Changing a stage target applies to matches scored from now on. Results already saved keep their scores.">
          <StagePoints koSize={t.koSize} thirdPlace={t.thirdPlace} points={t.points}
            onChange={(p) => update((d) => { d.points = p; return d; })} />
        </Field>

        <Field label="Bladers advancing from each group">
          <Segmented value={t.advance} onChange={(v) => update((d) => { d.advance = v; return d; })}
            options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} />
        </Field>

        <Field label="Knockout stage starts at" hint="Rebuild the bracket from the Table tab after changing this.">
          <Segmented value={t.koSize} onChange={(v) => update((d) => { d.koSize = v; return d; })}
            options={[
              { value: 16, label: "Ro16" }, { value: 8, label: "Quarters" },
              { value: 4, label: "Semis" }, { value: 2, label: "Final" }, { value: 0, label: "None" },
            ]} />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 24, cursor: "pointer" }}>
          <input type="checkbox" checked={t.thirdPlace}
            onChange={(e) => update((d) => { d.thirdPlace = e.target.checked; return d; })}
            style={{ width: 17, height: 17, accentColor: C.magenta }} />
          <span style={{ fontSize: 14.5 }}>Play a third-place match</span>
        </label>

        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 26, paddingTop: 20 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Reset match results</div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
            Wipes every score but keeps the bladers and the groups. Do this before
            redrawing the groups — {scored > 0
              ? `${scored} match${scored > 1 ? "es have" : " has"} been scored so far.`
              : "nothing has been scored yet."}
          </div>
          <Btn onClick={() => setAskClear(true)} tone="danger" disabled={scored === 0}>
            <Undo2 size={15} />Reset results
          </Btn>
        </div>

        {onReferees && (
          <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 26, paddingTop: 20 }}>
            <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Referees</div>
            <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
              Someone you trust to run this tournament — scores, draws and the bracket.
              They cannot rename it, delete it, or take it over.
            </div>
            <Btn onClick={onReferees}><Users size={15} />Manage referees</Btn>
          </div>
        )}

        {canDelete && (
        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 26, paddingTop: 20 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Start over</div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
            Deletes this tournament and everything in it, and returns you to your list.
          </div>
          {confirm ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={onReset} tone="danger"><Trash2 size={15} />Delete for good</Btn>
              <Btn onClick={() => setConfirm(false)} tone="ghost">Keep it</Btn>
            </div>
          ) : (
            <Btn onClick={() => setConfirm(true)} tone="danger"><Trash2 size={15} />Delete tournament</Btn>
          )}
        </div>
        )}
      </div>

      {askClear && (
        <Confirm
          title="Reset every result?"
          body={`${scored > 1 ? `All ${scored} scored matches are` : "The one scored match is"} cleared and the knockout bracket is removed — bladers, groups and settings stay as they are. The bracket can be rebuilt from the Table tab.`}
          confirmLabel="Clear every score" tone="danger"
          onConfirm={clearResults} onClose={() => setAskClear(false)}
        />
      )}
    </div>
  );
}

/* ================================================================== */
/*  Access control                                                     */
/* ================================================================== */

/**
 * Signing in, and signing up. Registering on its own grants nothing: the
 * account exists, unapproved, and can be added as a referee. Hosting waits
 * on approval, which is a staff action in the database.
 */
function AuthScreen({ onDone }) {
  const [mode, setMode] = useState("in");   // "in" | "up"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);     // { tone, text }
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true); setMsg(null);
    const { error } = mode === "in"
      ? await signIn(email, password)
      : await signUp(email, password);
    setBusy(false);
    if (error) { setMsg({ tone: C.magenta, text: error.message }); return; }
    if (mode === "up") {
      setMsg({ tone: C.green, text: "Account made. If the address needs confirming, check your email — then sign in." });
      setMode("in");
      return;
    }
    onDone();
  };

  return (
    <div className="bx" style={{ ...shell, display: "grid", placeItems: "center", padding: 20 }}>
      <Style />
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ width: 30, height: 3, background: C.magenta, transform: "skewX(-30deg)" }} />
          <span className="bx-d" style={{ fontSize: 15, color: C.cyan, fontWeight: 700 }}>
            Beyblade X tournaments
          </span>
        </div>
        <h1 className="bx-d" style={{
          fontSize: 42, fontWeight: 800, margin: "0 0 18px", lineHeight: .95,
          background: `linear-gradient(100deg, ${C.magenta} 0%, #FFFFFF 48%, ${C.cyan} 100%)`,
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
        }}>
          {mode === "in" ? "Sign in" : "Sign up"}
        </h1>

        <input
          style={{ ...inputStyle, marginBottom: 10 }} type="email" autoComplete="username"
          value={email} onChange={(e) => { setEmail(e.target.value); setMsg(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Email"
        />
        <input
          style={inputStyle} type="password"
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          value={password} onChange={(e) => { setPassword(e.target.value); setMsg(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Password"
        />
        {msg && (
          <div style={{ color: msg.tone, fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>{msg.text}</div>
        )}

        <Btn onClick={submit} tone="primary" disabled={busy}
          style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 17, marginTop: 16 }}>
          {busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
        </Btn>

        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13.5 }}>
            {mode === "in" ? "No account yet? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}


/** What a spectator sees before the organiser has created anything. */
function NotLive({ onUnlock }) {
  return (
    <div className="bx" style={{ ...shell, display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <Eye size={30} color={C.muted} />
        </div>
        <h1 className="bx-d" style={{
          fontSize: 40, fontWeight: 800, margin: "0 0 10px", lineHeight: .95,
          background: `linear-gradient(100deg, ${C.magenta}, #FFFFFF 50%, ${C.cyan})`,
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
        }}>No tournament live</h1>
        <p style={{ color: C.muted, fontSize: 15, lineHeight: 1.55, margin: "0 0 22px" }}>
          Check back once the organiser opens the draw. Standings and the bracket appear here as
          matches are scored.
        </p>
        <Btn onClick={onUnlock} tone="ghost" style={{ padding: "12px 18px" }}>
          <Lock size={15} />I'm the organiser
        </Btn>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Shell — accounts, the list of tournaments, and what opens          */
/* ================================================================== */

const FORMAT_LABEL = { knockout: "Groups & knockout", tag: "Tag team", league: "League" };

function SheetFrame({ title, onClose, children }) {
  const swipeBack = useSwipeBack(onClose);
  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(null), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div className="bx-d" style={{ fontSize: 22, fontWeight: 800 }}>{title}</div>
      </div>
      <div style={{ padding: 16, maxWidth: 620, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

function RefereeSheet({ event, onClose }) {
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => eventReferees(event.id).then(setRows);
  useEffect(() => { refresh(); }, [event.id]);

  const add = async () => {
    if (busy || !email.trim()) return;
    setBusy(true); setMsg(null);
    const { user, error } = await addReferee(event.id, email);
    setBusy(false);
    if (error) { setMsg({ tone: C.magenta, text: error.message }); return; }
    setMsg({ tone: C.green, text: user.email + " can now run this tournament." });
    setEmail("");
    refresh();
  };

  return (
    <SheetFrame title="Referees" onClose={onClose}>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.55, marginBottom: 18, maxWidth: "58ch" }}>
        A referee runs <strong style={{ color: C.ink }}>{event.name}</strong> — scores, the draw,
        the bracket. They cannot rename it, delete it, or take it over, and that is enforced by
        the database rather than by hiding the buttons.
      </div>

      <Block title="Add someone"
        hint="They need an account already, and the address is the one they signed up with. Being a referee needs no approval.">
        <div style={{ display: "flex", gap: 8 }}>
          <input style={inputStyle} type="email" value={email} placeholder="their@email.com"
            onChange={(e) => { setEmail(e.target.value); setMsg(null); }}
            onKeyDown={(e) => e.key === "Enter" && add()} />
          <Btn onClick={add} tone="primary" disabled={busy} style={{ flexShrink: 0 }}>
            <Plus size={16} />Add
          </Btn>
        </div>
        {msg && <div style={{ color: msg.tone, fontSize: 13, marginTop: 9, lineHeight: 1.5 }}>{msg.text}</div>}
      </Block>

      {rows === null ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Nobody else has access yet.</div>
      ) : rows.map((r) => (
        <div key={r.userId} style={{ ...card, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name || r.email}</div>
            <div style={{ fontSize: 12, color: C.muted }}>{r.email}</div>
          </div>
          <Btn tone="danger" style={{ padding: "7px 11px" }}
            onClick={async () => { await removeReferee(event.id, r.userId); refresh(); }}>
            Remove
          </Btn>
        </div>
      ))}
    </SheetFrame>
  );
}

function ApprovalsSheet({ onClose }) {
  const [rows, setRows] = useState(null);
  const refresh = () => pendingHosts().then(setRows);
  useEffect(() => { refresh(); }, []);

  return (
    <SheetFrame title="Waiting to host" onClose={onClose}>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.55, marginBottom: 18, maxWidth: "58ch" }}>
        Approving lets someone create their own tournaments. It gives them no access to yours.
      </div>
      {rows === null ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Nobody is waiting.</div>
      ) : rows.map((r) => (
        <div key={r.id} style={{ ...card, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5 }}>{r.display_name || r.email}</div>
            <div style={{ fontSize: 12, color: C.muted }}>{r.email}</div>
          </div>
          <Btn tone="primary" style={{ padding: "7px 11px" }}
            onClick={async () => { await approveHost(r.id, true); refresh(); }}>
            <Check size={15} />Approve
          </Btn>
        </div>
      ))}
    </SheetFrame>
  );
}

/** Everything this account can act on, and the way into a new one. */
function TournamentList({ profile, events, onOpen, onNew, onSignOut, onApprovals }) {
  const mine = events.filter((e) => e.role === "owner");
  const reffed = events.filter((e) => e.role === "referee");

  const Row = ({ e }) => (
    <button onClick={() => onOpen(e)} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 12, textAlign: "left",
      background: C.surface, border: `1px solid ${C.line}`,
      borderLeft: `3px solid ${e.archived ? C.line : C.magenta}`,
      borderRadius: 3, padding: 13, marginBottom: 7, cursor: "pointer", color: C.ink,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bx-d" style={{
          fontSize: 17, fontWeight: 700, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{e.name}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {FORMAT_LABEL[e.format] || e.format}
          {e.role === "referee" ? " · refereeing" : ""}
          {e.archived ? " · archived" : ""}
        </div>
      </div>
      <ChevronRight size={16} color={C.muted} />
    </button>
  );

  return (
    <div className="bx" style={{ ...shell, ...arenaStyle(null) }}>
      <Style />
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "34px 16px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="bx-d" style={{ fontSize: 34, fontWeight: 800, margin: 0, lineHeight: 1 }}>
              Tournaments
            </h1>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 5 }}>{profile ? profile.email : ""}</div>
          </div>
          {profile && profile.is_staff && (
            <Btn onClick={onApprovals} tone="ghost" style={{ padding: "7px 11px" }}>
              <Users size={15} />Approvals
            </Btn>
          )}
          <Btn onClick={onSignOut} tone="ghost" style={{ padding: "7px 11px" }}>Sign out</Btn>
        </div>

        {profile && profile.approved ? (
          <Btn onClick={onNew} tone="primary"
            style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 16, marginBottom: 22 }}>
            <Plus size={17} />New tournament
          </Btn>
        ) : (
          <div style={{
            background: `${C.gold}14`, border: `1px solid ${C.gold}55`, borderRadius: 3,
            padding: "13px 15px", marginBottom: 22, display: "flex", gap: 10,
          }}>
            <AlertTriangle size={16} color={C.gold} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              This account is waiting to be approved for hosting. It can still be added as a
              referee on somebody else&rsquo;s tournament meanwhile, and anything you referee
              appears here.
            </div>
          </div>
        )}

        {events.length === 0 && (
          <div style={{ ...card, textAlign: "center", padding: "40px 20px" }}>
            <div className="bx-d" style={{ fontSize: 20, fontWeight: 700, marginBottom: 7 }}>Nothing here yet</div>
            <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, maxWidth: "40ch", margin: "0 auto" }}>
              {profile && profile.approved
                ? "Start one, and it appears here with a link to share."
                : "Once you are approved, or somebody adds you as a referee."}
            </div>
          </div>
        )}

        {mine.length > 0 && (
          <div>
            <div className="bx-d" style={{ fontSize: 14, color: C.muted, margin: "0 0 8px" }}>Yours</div>
            {mine.map((e) => <Row key={e.id} e={e} />)}
          </div>
        )}
        {reffed.length > 0 && (
          <div>
            <div className="bx-d" style={{ fontSize: 14, color: C.muted, margin: "18px 0 8px" }}>Refereeing</div>
            {reffed.map((e) => <Row key={e.id} e={e} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Decides what you are looking at: a shared scoreboard, the sign-in, your list,
 * or one tournament. A `?t=` link opens that tournament for anyone, signed in or
 * not, which is what a spectator scanning a QR code needs.
 */
export default function App() {
  const [session, setSession] = useState(undefined);   // undefined while unknown
  const [profile, setProfile] = useState(null);
  const [events, setEvents] = useState([]);
  const [openId, setOpenId] = useState(() => new URLSearchParams(location.search).get("t"));
  const [making, setMaking] = useState(false);
  const [sheet, setSheet] = useState(null);            // "referees" | "approvals"

  useEffect(() => {
    currentSession().then(setSession);
    return onAuthChange(setSession);
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); setEvents([]); return; }
    loadProfile(session.user.id).then(setProfile);
    myEvents(session.user.id).then(setEvents);
  }, [session]);

  // The address bar is the navigation, so a tournament's link is shareable and
  // the browser's own back button behaves.
  useEffect(() => {
    const onPop = () => setOpenId(new URLSearchParams(location.search).get("t"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openEvent = (id) => {
    history.pushState({}, "", "?t=" + id);
    setOpenId(id);
  };
  const backToList = () => {
    history.pushState({}, "", location.pathname);
    setOpenId(null);
  };
  const refreshEvents = () =>
    session ? myEvents(session.user.id).then(setEvents) : Promise.resolve();

  const open = events.find((e) => e.id === openId);

  if (session === undefined) {
    return (
      <div className="bx" style={{ ...shell, display: "grid", placeItems: "center" }}>
        <Style /><span style={{ color: C.muted }}>Loading…</span>
      </div>
    );
  }

  // A shared link opens the board for anyone. The controls are offered only
  // where this account owns or referees it; the database decides the rest.
  if (openId) {
    return (
      <>
        <Board
          eventId={openId}
          canEdit={!!open}
          isOwner={open ? open.role === "owner" : false}
          onExit={session ? backToList : null}
          onReferees={open && open.role === "owner" ? () => setSheet("referees") : null}
          onDelete={async () => {
            await deleteEvent(openId);
            await refreshEvents();
            backToList();
          }}
        />
        {sheet === "referees" && open && (
          <RefereeSheet event={open} onClose={() => setSheet(null)} />
        )}
      </>
    );
  }

  if (!session) return <AuthScreen onDone={() => {}} />;

  if (making) {
    return (
      <>
        <Style />
        <Setup onCreate={async (v) => {
          const { row, error } = await createEvent({
            name: v.name, format: v.format || "knockout", data: v,
          });
          setMaking(false);
          if (error) { console.error(error); return; }
          await refreshEvents();
          if (row) openEvent(row.id);
        }} />
      </>
    );
  }

  return (
    <>
      <TournamentList
        profile={profile}
        events={events}
        onOpen={(e) => openEvent(e.id)}
        onNew={() => setMaking(true)}
        onApprovals={() => setSheet("approvals")}
        onSignOut={async () => { await signOut(); setOpenId(null); }}
      />
      {sheet === "approvals" && <ApprovalsSheet onClose={() => setSheet(null)} />}
    </>
  );
}
