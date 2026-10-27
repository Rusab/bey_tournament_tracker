import React, { useState, useEffect, useMemo, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import {
  Shuffle, Plus, X, Trophy, Users, Swords, Table2, Settings,
  Undo2, ArrowLeft, Trash2, AlertTriangle, GitBranch, ChevronRight, Check, Medal, Lock, Unlock, Eye,
  Image as ImageIcon, Download, Crown, Pencil, User, Search, Camera, Link2, List, Network, Clock, Send,
} from "lucide-react";
import { supabase, arrival } from "./lib/supabase.js";
import {
  COMBO_TYPES, SLOT_LABEL, deckSize, partOptions, emptyCombo, cleanDeck, comboLabel, deckConflicts,
  bitHasRatchet,
} from "./deck.js";
import {
  loadEvent, eventStamp, saveEvent, subscribeEvent,
  currentSession, onAuthChange, loadProfile, signIn, signUp, signOut,
  sendPasswordReset, setPassword,
  myEvents, publicEvents, createEvent, archiveEvent, deleteEvent,
  eventReferees, addReferee, addRefereeById, removeReferee, pendingHosts, approveHost,
  listBladers, loadBlader, bladerRealName, bladerNameFree, saveBlader, saveRealName,
  avatarUrl, uploadAvatar, removeAvatar,
  bladerNames, listMedals, amAwarder, addMedal, removeMedal,
  findBlader, bladerEvents, bladerDirectory,
  seriesOfEvents, loadSeries, seriesEvents, everyEvent, startSeries, linkToSeries,
  removeFromSeries, deleteSeries, seriesRequests,
  CLAIM_LIMIT, myMedalClaims, medalClaimsWaiting, medalClaimCount, submitMedalClaim,
  withdrawMedalClaim, reviewMedalClaim, proofLinks, sweepProofs,
} from "./lib/db.js";
import { seriesRanking } from "./series.js";
import { renderRankingImage } from "./rankingImage.js";

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

/* Nor is a self-KO. The point comes from the other bey going out on its own,
   and what it is worth is the organiser's to set, so the value here is only
   the default and the label. */
const SELF = { key: "self", label: "Self-KO", pts: 1 };

/** What a self-KO is worth here, and whether it is used at all. */
const defaultSelfKO = () => ({ enabled: true, pts: 1 });
const selfKOFor = (t) => {
  const s = t && t.selfKO;
  if (!s) return defaultSelfKO();          // tournaments made before the option
  return { enabled: s.enabled !== false, pts: Math.max(1, num(s.pts) || 1) };
};

/** Everything that can put a point on the board. */
const AWARDS = [...FINISHES, PENALTY, SELF];

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
 * A tournament player can be linked to a profile: `profileId` on a blader,
 * and on a team `memberIds`, one per member in the same order as `members`.
 * Both are optional — an unlinked player is exactly what it always was, and
 * everything that draws, scores or ranks still reads only the name.
 */
const looksLikeEmail = (s) => {
  const v = String(s || "").trim();
  const at = v.indexOf("@");
  return at > 0 && at === v.lastIndexOf("@") && !v.includes(" ")
    && v.indexOf(".", at) > at + 1 && !v.endsWith(".");
};

/** Every profile already linked somewhere among these players. */
const linkedIds = (players) =>
  new Set((players || []).flatMap((p) => [p.profileId, ...(p.memberIds || [])]).filter(Boolean));

const isLinked = (p) => !!(p.profileId || (p.memberIds || []).some(Boolean));

/**
 * The small link beside a player with a blader profile, for everyone to see:
 * a visitor can tell who is a registered blader and who was entered by name
 * alone. A team carries it when any of its members is linked.
 */
function LinkMark({ t, id, size = 12 }) {
  const p = ((t && t.players) || []).find((x) => x.id === id);
  if (!p || !isLinked(p)) return null;
  return (
    <span title="Linked to a blader profile" aria-label="linked to a blader profile"
      style={{ display: "inline-flex", verticalAlign: "-1px", marginLeft: 5 }}>
      <Link2 size={size} color={C.cyan} />
    </span>
  );
}

/*
 * Names compared for likeness, not equality: case, spacing, punctuation and
 * accents are dropped, and letters and digits of any script are kept, so a
 * Bengali name is compared as faithfully as a Latin one.
 */
const normName = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
const nameWords = (s) => String(s || "").toLowerCase().normalize("NFKD")
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How alike two names are. 3: the same. 2: one inside the other, or a slip of
 * a letter or two. 1: a word in common, such as a first name. 0: not alike.
 * Short names need to be nearer: two letters out of four is a different name.
 */
function nameLikeness(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return 2;
  const longest = Math.max(x.length, y.length);
  const d = editDistance(x, y);
  // Under six letters a slip must keep the first letter: Ayon may be Ayan, Joy is not Roy.
  if ((longest >= 6 && d <= 2) || (longest >= 3 && d <= 1 && x[0] === y[0])) return 2;
  const words = new Set(nameWords(b));
  if (nameWords(a).some((w) => words.has(w))) return 1;
  return 0;
}

/**
 * Bladers a typed name might mean, best first, at most five. Measured against
 * both their blader name and, where it is visible to us, their real name.
 * Anyone already in the tournament is left out.
 */
function matchBladers(name, directory, taken = new Set()) {
  const out = [];
  (directory || []).forEach((b) => {
    if (taken.has(b.id)) return;
    const byName = nameLikeness(name, b.blader_name);
    const byReal = b.real_name ? nameLikeness(name, b.real_name) : 0;
    const score = Math.max(byName, byReal);
    if (score > 0) out.push({ blader: b, score, on: byName >= byReal ? "blader name" : "real name" });
  });
  return out
    .sort((p, q) => q.score - p.score || p.blader.blader_name.localeCompare(q.blader.blader_name))
    .slice(0, 5);
}

/**
 * One typed line into a player, looking up any email in it. A blader is a
 * name or an email. A team is "Name: member, member", each member a name or
 * an email. Resolves to { player }, { error } or {} for a blank line.
 *
 * `taken` is never changed here: a line that fails part-way must not leave
 * its first member marked as already in, or adding it again would be refused.
 */
async function resolveEntry(line, { eventId, taken }) {
  const raw = String(line || "").trim();
  if (!raw) return {};
  const mine = new Set();
  const lookup = async (email) => {
    const { blader, error } = await findBlader(email.trim(), eventId);
    if (error) return { error: "Emails could not be looked up just now." };
    if (!blader) return { error: `No account uses ${email.trim()}.` };
    if (taken.has(blader.id) || mine.has(blader.id)) {
      return { error: `${blader.blader_name} is already in this tournament.` };
    }
    mine.add(blader.id);
    return { blader };
  };

  // Same split as always: a colon makes a team, whatever the format.
  if (raw.includes(":")) {
    const [head, tail] = raw.split(/:(.+)/);
    const name = (head || "").trim().replace(/:+$/, "").trim();
    if (!name) return {};
    const members = [], memberIds = [];
    for (const m of (tail || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (looksLikeEmail(m)) {
        const r = await lookup(m);
        if (r.error) return { error: r.error };
        members.push(r.blader.blader_name); memberIds.push(r.blader.id);
      } else {
        members.push(m); memberIds.push(null);
      }
    }
    const player = { id: uid(), name };
    if (members.length) {
      player.members = members;
      if (memberIds.some(Boolean)) player.memberIds = memberIds;
    }
    return { player };
  }

  if (looksLikeEmail(raw)) {
    const r = await lookup(raw);
    if (r.error) return { error: r.error };
    return { player: { id: uid(), name: r.blader.blader_name, profileId: r.blader.id } };
  }
  return { player: { id: uid(), name: raw } };
}

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
  // Shown at most ~120px across, usually 36; a little headroom for sharp screens.
  avatar: { maxDim: 400, quality: 0.8, alpha: false, prefix: "avatar" },
  // A medal photo has to show the medal clearly enough to check it.
  proof: { maxDim: 1600, quality: 0.82, alpha: false, prefix: "proof" },
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

  /*
   * Sets decide a best-of, and they are recorded on the match so that the
   * winner can be read anywhere — propagate() advances a bracket without ever
   * seeing the tournament, and so has no target to replay against.
   *
   * Points cannot stand in: a side can take more points across the match and
   * still lose it, by winning one set heavily and losing two narrowly.
   */
  if (m.sets && m.sets.length) {
    let w1 = 0, w2 = 0;
    m.sets.forEach((s) => { if (s.s1 > s.s2) w1++; else if (s.s2 > s.s1) w2++; });
    if (w1 === w2) return null;
    return w1 > w2 ? m.p1 : m.p2;
  }

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

/** How many sets a stage is played over. Absent or 1 means a single set. */
const defaultBestOf = () => ({ group: 1, r16: 1, qf: 1, sf: 1, final: 1, third: 1 });
const bestOfFor = (m, t) => Math.max(1, (t.bestOf && t.bestOf[stageOf(m, t)]) || 1);
const setsToWin = (bestOf) => Math.floor(bestOf / 2) + 1;

/**
 * How a stage is played, in words. A round headed "first to 7" while its one
 * match reads 2-0 looks like a single set that ended 2-0, so a stage played
 * over sets has to say so where the score is read.
 */
function stageLine(t, key) {
  const n = Math.max(1, (t.bestOf && t.bestOf[key]) || 1);
  const pts = t.points[key];
  return n > 1 ? `best of ${n}, sets of ${pts}` : `first to ${pts}`;
}

/**
 * Which set each finish landed in — the same replay as splitSets, keeping the
 * set number rather than the score, so a match log can be broken up by set.
 */
function setIndexOf(events, target, bestOf) {
  const need = setsToWin(bestOf);
  const out = [];
  let cur = { s1: 0, s2: 0 }, w1 = 0, w2 = 0, at = 0;
  for (const e of events || []) {
    out.push(at);
    if (w1 >= need || w2 >= need) continue;
    if (e.side === 1) cur.s1 += e.pts; else cur.s2 += e.pts;
    if (cur.s1 >= target || cur.s2 >= target) {
      if (cur.s1 > cur.s2) w1++; else if (cur.s2 > cur.s1) w2++;
      cur = { s1: 0, s2: 0 }; at++;
    }
  }
  return out;
}

/** Sets each side took, from the summary stored on a finished match. */
function setWins(m) {
  let w1 = 0, w2 = 0;
  (m.sets || []).forEach((s) => { if (s.s1 > s.s2) w1++; else if (s.s2 > s.s1) w2++; });
  return { w1, w2 };
}

/**
 * Replays the finishes into sets, each run to `target`.
 *
 * Sets are derived rather than stored, so undo stays "drop the last finish"
 * and everything downstream recomputes — no separate set state to get out of
 * step with the finish log.
 *
 * It stops the moment the match is won: take the first two of three and the
 * third is never played, so it is not counted and the points are those of the
 * two sets actually contested.
 */
function splitSets(events, target, bestOf) {
  const need = setsToWin(bestOf);
  const sets = [];
  let cur = { s1: 0, s2: 0 };
  let w1 = 0, w2 = 0;

  for (const e of events || []) {
    if (w1 >= need || w2 >= need) break;
    if (e.side === 1) cur.s1 += e.pts; else cur.s2 += e.pts;
    if (cur.s1 >= target || cur.s2 >= target) {
      sets.push(cur);
      if (cur.s1 > cur.s2) w1++; else if (cur.s2 > cur.s1) w2++;
      cur = { s1: 0, s2: 0 };
    }
  }

  const decided = w1 >= need || w2 >= need;
  return { sets, current: cur, w1, w2, need, decided };
}

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
      // A surviving fixture keeps its own sides: the round robin can list the
      // pair the other way round once someone leaves, and flipping p1 and p2
      // under a saved result would hand the win to the loser.
      out.push(old ? { ...old } : { id, groupId: g.id, p1: a, p2: b, events: [], done: false });
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
/*
 * Two bladers the table cannot separate.
 *
 * Until now the order between them came from their names, which decides who
 * goes through on the alphabet. Instead the organiser plays a tie-breaker and
 * records who won it. Only the winner is kept: a tie-breaker settles the
 * order and nothing else, so its score would be a number with no meaning
 * anywhere — not in the table, not in margins, not in the final standings.
 */
const tieKey = (a, b) => [a, b].sort().join("~");
const tieWinner = (ties, a, b) => (ties && ties[tieKey(a, b)]) || null;
const tieOrder = (ties, a, b) => {
  const w = tieWinner(ties, a, b);
  return w ? (w === a ? -1 : 1) : 0;
};

/** Level on every measure the table has, in the order it applies them. */
const levelOn = (x, y, lp) =>
  (lp ? x.pts === y.pts : true) &&
  x.wins === y.wins &&
  x.winMargin === y.winMargin &&
  x.pf - x.pa === y.pf - y.pa &&
  x.pf === y.pf;

function computeStandings(playerIds, matches, nameOf, lp, ties) {
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

    /*
     * Who won is winnerOf's call, not the point totals'. Over a best-of, the
     * side with more points can be the side that lost. The margin stays in
     * points either way, so a dominant win still outranks a scrape.
     */
    const w = winnerOf(m);
    if (w === m.p1) { a.wins++; b.losses++; a.winMargin += s1 - s2; }
    else if (w === m.p2) { b.wins++; a.losses++; b.winMargin += s2 - s1; }
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
      tieOrder(ties, x.id, y.id) ||
      nameOf(x.id).localeCompare(nameOf(y.id))
  );
}

/**
 * The ties an organiser actually has to settle: pairs nothing separates, in
 * the places that decide something. A tie for a place nobody qualifies from
 * changes nothing and is left alone; one that straddles the cut, or sits
 * among the qualifiers where it sets the seeding, is theirs to break.
 *
 * Only groups that have finished are asked about. Half-played, everybody is
 * level with everybody and the question is meaningless.
 */
function pendingTies(t, nameOf) {
  if (isLeague(t) || !t.koSize) return [];
  const out = [];
  t.groups.forEach((g) => {
    const ms = t.groupMatches.filter((m) => m.groupId === g.id);
    if (!ms.length || !ms.every((m) => m.done)) return;
    const rows = computeStandings(g.playerIds, ms, nameOf, null, t.tieBreaks);
    rows.forEach((r, i) => {
      if (i === 0 || i - 1 >= t.advance) return;
      const prev = rows[i - 1];
      if (!levelOn(prev, r, null)) return;
      out.push({
        key: tieKey(prev.id, r.id),
        group: g.name,
        a: prev.id, b: r.id,
        place: i,                        // the place the two are level on
        cut: i === t.advance,            // ... and only one of them goes through
        winner: tieWinner(t.tieBreaks, prev.id, r.id),
      });
    });
  });
  return out;
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
    const w = winnerOf(m);
    a.played++; b.played++;
    if (w === m.p1) { a.wins++; a.margin += s1 - s2; }
    else if (w === m.p2) { b.wins++; b.margin += s2 - s1; }
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

    const won = winnerOf(m);
    [[a, s1, s2, m.p1], [b, s2, s1, m.p2]].forEach(([r, mine, theirs, who]) => {
      r.played++; r.pf += mine; r.pa += theirs;
      r.total += num(st.play);
      r.bonus += num(st.play);
      if (won === who) {
        r.wins++;
        r.margin += mine - theirs;
        r.total += num(cfg.perWin) + num(st.win) + (mine - theirs) * num(cfg.perMargin);
        r.bonus += num(st.win);
      } else if (won) {
        r.losses++;   // somebody won it, and it was not this one
      }
    });
  });

  const rows = Object.values(rec)
    .filter((r) => r.played > 0)
    .sort((x, y) =>
      y.total - x.total || y.wins - x.wins || y.margin - x.margin || x.name.localeCompare(y.name));

  // Equal totals share a rank, and the next total takes the next number:
  // 1, 2, 2, 3 - not 1, 2, 2, 4.
  let rank = 0, prev = null;
  rows.forEach((r) => {
    if (prev === null || r.total !== prev) rank += 1;
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

/** Group fixtures, bracket and third-place playoff, as one list. */
const everyMatch = (t) => [
  ...t.groupMatches,
  ...(t.bracket ? t.bracket.rounds.flat() : []),
  ...(t.bracket && t.bracket.third ? [t.bracket.third] : []),
].filter((m) => m.p1 || m.p2);

/**
 * Every match as CSV rows, header first, played or not. Shared by both
 * exports, so a result reads identically whichever one produced it.
 */
function matchCSVRows(t) {
  const nameOf = (id) => (t.players.find((p) => p.id === id) || {}).name || "—";
  const groupName = (id) => (t.groups.find((g) => g.id === id) || {}).name || "";
  const stageLabel = (key) =>
    (stagesFor(t.koSize, t.thirdPlace).find((x) => x.key === key) || {}).label || key;

  const out = [csvRow(["Stage", "Group", "Blader A", "Blader B", "Score A", "Score B",
    "Sets", "Winner", "Points in order"])];

  everyMatch(t).forEach((m) => {
    const { s1, s2 } = scoreOf(m);
    const w = winnerOf(m);
    const seq = (m.events || [])
      .map((e, i) => `${i + 1}. ${nameOf(e.side === 1 ? m.p1 : m.p2)} ${(awardOf(e.type) || { label: e.type }).label} +${e.pts}`)
      .join("; ");
    // Score A and B stay the points across the whole match; the set column
    // carries what actually decided it, so neither reading is lost.
    const sets = (m.sets || []).map((x) => `${x.s1}-${x.s2}`).join(" ");
    out.push(csvRow([
      stageLabel(stageOf(m, t)), groupName(m.groupId),
      m.p1 ? nameOf(m.p1) : "", m.p2 ? nameOf(m.p2) : "",
      m.done ? s1 : "", m.done ? s2 : "",
      sets,
      w ? nameOf(w) : (m.done ? "draw" : "not played"),
      seq,
    ]));
  });
  return out;
}

/**
 * The results on their own, at any point in the tournament. Matches still to
 * come are listed rather than left out, so the file says what is outstanding
 * as well as what has happened.
 */
function buildMatchesCSV(t) {
  const all = everyMatch(t);
  const played = all.filter((m) => m.done).length;

  const out = [];
  out.push(csvRow([t.name, "match results"]));
  out.push(csvRow(["Generated", new Date().toISOString()]));
  out.push(csvRow(["Played", `${played} of ${all.length}`]));
  out.push("");
  out.push(csvRow(["MATCHES"]));
  matchCSVRows(t).forEach((r) => out.push(r));
  return out.join("\n");
}

/**
 * The whole tournament as one file: the ranking, how it was arrived at, and
 * every match point by point, so the record survives the app.
 */
function buildFinalCSV(t, cfg, rows, kings) {
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
  matchCSVRows(t).forEach((r) => out.push(r));

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

/**
 * Who meets whom in the first round, as a flat list of seeds: slot, opponent,
 * slot, opponent.
 *
 * The field is split down the middle and the halves played off against each
 * other in order — the best seed takes the best of the bottom half, the second
 * takes the second, and so on. In a four that is 1 v 3 and 2 v 4; in an eight,
 * 1 v 5 through 4 v 8.
 *
 * Byes come off the top, so a short field still rewards the seeds that earned
 * it. The seeds left after the byes close up and split the same way, which is
 * why the split is taken from `byes` rather than from 1.
 */
function seedOrder(n, entrants) {
  const half = n / 2;
  const byes = Math.max(0, Math.min(half, n - (entrants == null ? n : entrants)));

  // Pair j: the j-th seed of the top half against the j-th of the bottom,
  // with the byes taken off the top before the halves are cut.
  const pair = (j) => [j, j <= byes ? null : half + (j - byes)];

  return bracketOrder(half).flatMap(pair);
}

/**
 * Where each pair is listed. Asked for: first, last, and inwards — so a round
 * of four reads 1 v 5, 4 v 8, 2 v 6, 3 v 7 rather than 1, 2, 3, 4.
 *
 * Note this is the organiser's layout, and it is not the one that keeps the
 * top seeds apart. Paired with the round wiring below, which sends match 1
 * against match 3, the two best seeds meet in the semi-final rather than the
 * final. That is the arrangement that was asked for.
 */
function bracketOrder(m) {
  let arr = [1];
  while (arr.length < m) {
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

function collectQualifiers(groups, groupMatches, advance, nameOf, ties) {
  const out = [];
  groups.forEach((g) => {
    const ms = groupMatches.filter((m) => m.groupId === g.id);
    computeStandings(g.playerIds, ms, nameOf, null, ties)
      .slice(0, advance)
      .forEach((row, i) => out.push({ ...row, groupId: g.id, placement: i + 1 }));
  });
  return out.sort(
    (x, y) =>
      x.placement - y.placement ||
      y.wins - x.wins ||
      y.winMargin - x.winMargin ||
      (y.pf - y.pa) - (x.pf - x.pa) ||
      tieOrder(ties, x.id, y.id) ||
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
  const order = seedOrder(size, qualifiers.length);
  const slots = order.map((s) => (s == null ? null : qualifiers[s - 1] || null));
  let first = [];
  for (let i = 0; i < size; i += 2) first.push({ p1: slots[i], p2: slots[i + 1] });
  first = avoidSameGroup(first);

  const rounds = [
    first.map((p, i) => ({
      id: `k:0:${i}`, p1: p.p1 ? p.p1.id : null, p2: p.p2 ? p.p2.id : null,
      events: [], done: false,
    })),
    ...roundsAfterFirst(size),
  ];
  return propagate({ size, rounds, third: thirdPlaceMatch(size, thirdPlace), template: "standard" });
}

/** Every round after the first, empty, for a bracket of this size. */
function roundsAfterFirst(size) {
  const out = [];
  let n = size / 4, r = 1;
  while (n >= 1) {
    out.push(Array.from({ length: n }, (_, i) => ({
      id: `k:${r}:${i}`, p1: null, p2: null, events: [], done: false,
    })));
    n = n / 2; r++;
  }
  return out;
}

const thirdPlaceMatch = (size, thirdPlace) => (thirdPlace && size >= 4
  ? { id: "k:third", p1: null, p2: null, events: [], done: false } : null);

/*
 * The Paired Groups template. Groups are paired - A with B and C with D
 * unless chosen otherwise - and each pair plays the 1 v 3, 2 v 4 rule
 * across itself:
 *
 *   M1 A1 v B3    M2 A2 v B4    M3 A3 v B1    M4 A4 v B2
 *   M5 C1 v D3    M6 C2 v D4    M7 C3 v D1    M8 C4 v D2
 *
 * Each pair's matches are a block, and the next round crosses the blocks
 * the same way, treating each block's matches as a group of their own:
 * M1 v M7, M2 v M8, M3 v M5, M4 v M6. Later rounds keep the usual wiring.
 *
 * With two qualifiers a group it is the classic A1 v B2, A2 v B1, and it
 * works for any even number of groups. It needs every qualifier to have a
 * place, so it is only offered when the qualifiers fill the bracket exactly.
 *
 * `order` is the groups' ids in pairing order: the first two are a pair,
 * then the next two, and so on.
 */
function pairedFits(groups, advance, koSize) {
  const n = (groups || []).length;
  return n >= 2 && n % 2 === 0 && advance >= 1 && n * advance === koSize;
}

/** A pairing order that names every group exactly once, or the groups as they are. */
function pairingOrder(groups, wanted) {
  const ids = groups.map((g) => g.id);
  const ok = Array.isArray(wanted) && wanted.length === ids.length
    && new Set(wanted).size === ids.length && wanted.every((id) => ids.includes(id));
  return ok ? wanted : ids;
}

function buildPairedBracket(groups, groupMatches, advance, koSize, thirdPlace, nameOf, ties, order) {
  const k = advance, off = Math.floor(k / 2);
  const inOrder = pairingOrder(groups, order).map((id) => groups.find((g) => g.id === id));
  const ranked = inOrder.map((g) =>
    computeStandings(g.playerIds, groupMatches.filter((m) => m.groupId === g.id), nameOf, null, ties)
      .slice(0, k).map((r) => r.id));

  const first = [];
  for (let gi = 0; gi + 1 < inOrder.length; gi += 2) {
    const x = ranked[gi], y = ranked[gi + 1];
    for (let j = 0; j < k; j++) first.push([x[j] || null, y[(j + off) % k] || null]);
  }

  const rounds = [
    first.map(([p1, p2], i) => ({ id: `k:0:${i}`, p1, p2, events: [], done: false })),
    ...roundsAfterFirst(koSize),
  ];

  // Cross the blocks into the next round, if there are blocks to cross.
  const feeds = {};
  const blocks = inOrder.length / 2;
  if (rounds.length > 1 && blocks % 2 === 0) {
    const f = [];
    for (let b = 0; b < blocks; b += 2) {
      for (let i = 0; i < k; i++) f.push([b * k + i, (b + 1) * k + ((i + off) % k)]);
    }
    if (validFeed(f, rounds[1].length)) feeds[1] = f;
  }

  return propagate({ size: koSize, rounds, third: thirdPlaceMatch(koSize, thirdPlace), feeds, template: "paired" });
}

/** "Group A" is A in a match line; any other name is kept whole. */
const groupShort = (g) => String((g && g.name) || "").replace(/^Group\s+/i, "");

/** The template's first round and next-round wiring, as lines to read before building. */
function pairedPreview(groups, advance, order) {
  const k = advance, off = Math.floor(k / 2);
  const inOrder = pairingOrder(groups, order).map((id) => groups.find((g) => g.id === id));
  const lines = [];
  let m = 1;
  for (let gi = 0; gi + 1 < inOrder.length; gi += 2) {
    const a = groupShort(inOrder[gi]), b = groupShort(inOrder[gi + 1]);
    const row = [];
    for (let j = 0; j < k; j++) row.push(`M${m++} ${a}${j + 1} v ${b}${((j + off) % k) + 1}`);
    lines.push(row.join("   "));
  }
  const blocks = inOrder.length / 2;
  if (blocks % 2 === 0) {
    const row = [];
    for (let bb = 0; bb < blocks; bb += 2) {
      for (let i = 0; i < k; i++) row.push(`M${bb * k + i + 1} v M${(bb + 1) * k + ((i + off) % k) + 1}`);
    }
    lines.push(`then ${row.join(", ")}`);
  }
  return lines;
}

/*
 * Which matches of the round before feed each match of round r, as
 * [[sourceForP1, sourceForP2], ...] indexing into that earlier round.
 *
 * By default a round is split down the middle — match j takes the winners of
 * j and j + half — so match 1 meets match 3 and match 2 meets match 4. An
 * organiser can rewire any round by hand; that arrangement is kept on the
 * bracket and used instead, as long as it is a whole one: every earlier match
 * used exactly once. Anything less falls back to the default rather than
 * leaving a winner with nowhere to go.
 */
const defaultFeed = (next) => Array.from({ length: next }, (_, j) => [j, j + next]);

function validFeed(f, next) {
  if (!Array.isArray(f) || f.length !== next) return false;
  const all = f.flat();
  return all.length === next * 2
    && all.every((x) => Number.isInteger(x) && x >= 0 && x < next * 2)
    && new Set(all).size === next * 2;
}

function feedFor(bracket, r) {
  const next = bracket.rounds[r].length;
  const f = bracket.feeds && bracket.feeds[r];
  return validFeed(f, next) ? f : defaultFeed(next);
}

/**
 * A round set by hand.
 *
 * The opening round takes names: [[p1, p2], ...]. A match whose players
 * change loses its result, and propagate then clears whatever it fed. Later
 * rounds take a feed instead, and propagate re-places their players from it
 * — clearing a result the same way wherever the players change. A feed that
 * matches the default is stored as no feed at all, so going back to the
 * default really is going back.
 */
function setRound(bracket, r, value) {
  const b = { ...bracket, rounds: bracket.rounds.map((x) => x.map((m) => ({ ...m }))) };
  if (r === 0) {
    b.rounds[0].forEach((m, i) => {
      const [p1, p2] = value[i];
      if ((m.p1 || null) !== p1 || (m.p2 || null) !== p2) {
        m.p1 = p1; m.p2 = p2; m.events = []; m.done = false; m.sets = null;
      }
    });
    b.edited = { ...(b.edited || {}), 0: true };
  } else {
    const plain = JSON.stringify(value) === JSON.stringify(defaultFeed(b.rounds[r].length));
    b.feeds = { ...(b.feeds || {}) };
    if (plain) delete b.feeds[r]; else b.feeds[r] = value;
    b.edited = { ...(b.edited || {}), [r]: !plain };
  }
  return propagate(b);
}

function propagate(bracket) {
  const rounds = bracket.rounds.map((r) => r.map((m) => ({ ...m })));

  // Settle the genuine byes first. An unopposed blader in the opening round is
  // through without playing, and this has to happen before the loop below or
  // winnerOf — which now insists on a finished match — would not advance them.
  rounds[0].forEach((m) => {
    if ((m.p1 && !m.p2) || (m.p2 && !m.p1)) m.done = true;
  });

  // Each later match is filled from the earlier matches its feed names.
  for (let r = 0; r < rounds.length - 1; r++) {
    const feed = feedFor(bracket, r + 1);
    rounds[r + 1].forEach((tgt, j) => {
      ["p1", "p2"].forEach((slot, k) => {
        const src = rounds[r][feed[j][k]];
        const w = src ? winnerOf(src) : null;
        if (tgt[slot] !== w) { tgt[slot] = w; tgt.events = []; tgt.done = false; }
      });
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
    @keyframes bx-tab-next { from { opacity: 0; transform: translate3d(16px,0,0); }
                             to   { opacity: 1; transform: translate3d(0,0,0); } }
    @keyframes bx-tab-prev { from { opacity: 0; transform: translate3d(-16px,0,0); }
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

/*
 * iOS runs a home-screen app under the status bar: the page asks for that with
 * viewport-fit=cover and a translucent bar, and gets the clock and battery
 * drawn over whatever sits at the top of the screen — including, until now,
 * the sign-in button. Anything pinned to the top edge has to hold itself off
 * by the inset the device reports. In a browser tab that inset is zero and
 * nothing moves, which is why this only ever showed up once installed.
 */
const safeTop = (extra) => `calc(env(safe-area-inset-top) + ${extra})`;

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

/** Every match in the tournament: the group stage, the bracket, the third-place match. */
function allMatchesOf(t) {
  return [
    ...((t && t.groupMatches) || []),
    ...(t && t.bracket ? t.bracket.rounds.flat() : []),
    ...(t && t.bracket && t.bracket.third ? [t.bracket.third] : []),
  ];
}

/*
 * Protect played matches.
 *
 * A saved result is only ever taken away by opening that match and saving it
 * empty. Any other change — a redraw, a rebuilt bracket, a blader moved or
 * removed, a knockout round set by hand — is refused while it would wipe
 * a result, and the matches in the way are listed.
 *
 * lostResults compares the tournament before and after a change and returns
 * the matches that held a result and no longer hold the same one: gone, its
 * finishes changed, or its players changed. `allow` names the matches the
 * change is meant to touch — the one being scored.
 */
function lostResults(before, after, allow = []) {
  const now = new Map(allMatchesOf(after).map((m) => [m.id, m]));
  const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  return allMatchesOf(before).filter((m) => {
    if (!(m.events || []).length || allow.includes(m.id)) return false;
    const n = now.get(m.id);
    return !n || !same(n.events, m.events) || (n.p1 || null) !== (m.p1 || null) || (n.p2 || null) !== (m.p2 || null);
  });
}

const protects = (t) => !!t && t.protectResults !== false;

/** Where a match sits and how it stands, for listing the ones in the way. */
function matchLabel(t, m, nameOf) {
  let where = "Match", order = 0;
  if (m.groupId) {
    const g = t.groups.find((x) => x.id === m.groupId);
    where = g ? g.name : "Group";
  } else if (m.id === "k:third") {
    where = "Third place"; order = 9000; // fed by the semis, so cleared before them
  } else if (t.bracket) {
    t.bracket.rounds.forEach((r, ri) => r.forEach((x, i) => {
      if (x.id === m.id) {
        where = r.length === 1 ? "Final" : `${roundName(r.length * 2)} M${i + 1}`;
        order = 1000 + ri * 10;
      }
    }));
  }
  const { s1, s2 } = scoreOf(m);
  const who = `${m.p1 ? nameOf(m.p1) : "TBD"} v ${m.p2 ? nameOf(m.p2) : "TBD"}`;
  return { id: m.id, kind: m.groupId ? "group" : "ko", where, who, score: `${s1}–${s2}`, order };
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
  const [editRound, setEditRound] = useState(null);   // knockout round being set by hand
  const [blocked, setBlocked] = useState(null);       // a change refused: { what, ids, fromScore }
  // List or tree, remembered on this device only: a viewer's preference.
  const [bracketView, setBracketView] = useState(() => {
    try { return localStorage.getItem(BRACKET_VIEW_KEY) === "tree" ? "tree" : "list"; } catch (e) { return "list"; }
  });
  const pickBracketView = (v) => {
    setBracketView(v);
    try { localStorage.setItem(BRACKET_VIEW_KEY, v); } catch (e) { /* private mode */ }
  };
  const [detail, setDetail] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showFinal, setShowFinal] = useState(false);
  const [live, setLive] = useState(false);
  const [slide, setSlide] = useState(null); // direction of the last tab change
  const [group, setGroup] = useState(initialGroup);
  const isAdmin = canEdit;
  const store = useMemo(() => storeFor(eventId), [eventId]);
  // Who is looking, for the series card: which side of a request is theirs.
  const [meId, setMeId] = useState(null);
  useEffect(() => { currentSession().then((x) => setMeId(x ? x.user.id : null)); }, []);

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

  const protect = protects(t);

  /*
   * Whether a change may go ahead. With Protect played matches on, one that
   * would wipe a saved result is refused and the matches in the way are
   * shown instead. Views ask first so they can skip their own warnings;
   * update() asks again, so nothing gets past it.
   */
  const check = (fn, what = "This change", allow = [], fromScore = false) => {
    if (!protect) return true;
    const lost = lostResults(t, fn(structuredClone(t)), allow);
    if (!lost.length) return true;
    setBlocked({ what, ids: lost.map((m) => m.id), fromScore });
    return false;
  };

  const update = (fn, opts = {}) => {
    if (!check(fn, opts.what, opts.allow, opts.fromScore)) return false;
    setT((prev) => fn(structuredClone(prev)));
    return true;
  };

  /*
   * The sets are stored beside the finishes because propagate() and every
   * table read the winner without ever seeing the tournament, and so have no
   * target to replay the finishes against.
   */
  const saveScore = (kind, id, events, done, sets) => {
    const put = (m) => { m.events = events; m.done = done; m.sets = sets && sets.length > 1 ? sets : null; };
    return update((d) => {
      if (kind === "group") {
        const m = d.groupMatches.find((x) => x.id === id);
        if (m) put(m);
      } else {
        if (d.bracket.third && d.bracket.third.id === id) {
          put(d.bracket.third);
        } else {
          d.bracket.rounds.forEach((r) => r.forEach((m) => {
            if (m.id === id) put(m);
          }));
        }
        d.bracket = propagate(d.bracket);
      }
      return d;
    }, { what: events.length ? "Saving this result" : "Clearing this result", allow: [id], fromScore: true });
  };

  const saveRound = (r, value) => {
    if (update((d) => { d.bracket = setRound(d.bracket, r, value); return d; }, { what: "Changing these matchups" })) {
      setEditRound(null);
    }
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
        paddingTop: safeTop("13px"),
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
        padding: "18px 16px 96px", margin: "0 auto",
        // A tree needs the room a reading column doesn't: a Round of 16 is four columns wide.
        maxWidth: tab === "bracket" && bracketView === "tree" ? 1180 : 720,
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
          {tab === "groups" && <GroupsView t={t} update={update} check={check} nameOf={nameOf} isAdmin={isAdmin} eventId={eventId} />}
          {tab === "matches" && <MatchesView t={t} nameOf={nameOf} isAdmin={isAdmin}
            group={group} setGroup={setGroup}
            onScore={(id) => setScoring({ kind: "group", id })} />}
          {tab === "table" && <TableView t={t} nameOf={nameOf} update={update} check={check} isAdmin={isAdmin}
            group={group} setGroup={setGroup} onPlayer={setDetail} onFinal={() => setShowFinal(true)}
            eventId={eventId} isOwner={isOwner} meId={meId} />}
          {tab === "bracket" && <BracketView t={t} nameOf={nameOf} isAdmin={isAdmin}
            onScore={(id) => setScoring({ kind: "ko", id })}
            view={bracketView} onView={pickBracketView}
            onEditRound={isAdmin ? setEditRound : null} />}
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
          onSave={(events, done, sets) => { if (saveScore(scoring.kind, scoring.id, events, done, sets)) setScoring(null); }}
        />
      )}
      {editRound !== null && isAdmin && t.bracket && t.bracket.rounds[editRound] && (
        <BracketEditor t={t} round={editRound} nameOf={nameOf} protect={protect}
          onClose={() => setEditRound(null)}
          onSave={(value) => saveRound(editRound, value)} />
      )}
      {detail && (
        <PlayerSheet playerId={detail} t={t} nameOf={nameOf}
          allMatches={allMatches} onClose={() => setDetail(null)}
          isAdmin={isAdmin} update={update} eventId={eventId} />
      )}
      {showSetup && isAdmin && (
        <SettingsSheet t={t} update={update} onClose={() => setShowSetup(false)}
          isOwner={isOwner}
          onReferees={isOwner ? onReferees : null}
          canDelete={isOwner}
          onReset={() => { setShowSetup(false); if (onDelete) onDelete(); }} />
      )}
      {showFinal && isAdmin && (
        <FinalStandingsSheet t={t} update={update} onClose={() => setShowFinal(false)} />
      )}
      {blocked && (
        <ResultsInTheWay t={t} nameOf={nameOf} block={blocked} isOwner={isOwner}
          onClose={() => setBlocked(null)}
          onOpen={blocked.fromScore ? null : (row) => {
            setBlocked(null); setShowSetup(false); setEditRound(null);
            setScoring({ kind: row.kind, id: row.id });
          }} />
      )}
    </div>
  );
}

/**
 * The matches standing in the way of a change, latest first: a knockout
 * match can only be cleared once the match it feeds is empty, so the list
 * reads in the order to clear them.
 */
function ResultsInTheWay({ t, nameOf, block, isOwner, onClose, onOpen }) {
  const rows = allMatchesOf(t).filter((m) => block.ids.includes(m.id))
    .map((m) => matchLabel(t, m, nameOf))
    .sort((a, b) => b.order - a.order);
  const n = rows.length;
  const ko = rows.some((r) => r.kind === "ko");
  return createPortal(
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 95, background: "#0B0718EE",
      display: "grid", placeItems: "center", padding: 20, color: C.ink,
    }}>
      <div style={{
        width: "100%", maxWidth: 440, maxHeight: "86vh", overflowY: "auto", background: C.surface,
        border: `1px solid ${C.line}`, borderRadius: 4, padding: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Blade color={C.magenta} h={24} />
          <h2 className="bx-d" style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>
            Reset {n > 1 ? "these matches" : "this match"} first
          </h2>
        </div>
        <p style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, margin: "0 0 14px" }}>
          {block.what} would wipe {n > 1 ? `${n} saved results` : "a saved result"}. Played matches are
          protected, so a result only goes when you clear it yourself: open the match, press
          Reset, then save it as not played.
          {ko && " Work down from the top: a knockout match can't be cleared while the match it feeds still has a result."}
        </p>
        <div style={{ marginBottom: 16 }}>
          {rows.map((r) => (
            <button key={r.id} onClick={onOpen ? () => onOpen(r) : undefined} disabled={!onOpen}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                background: C.raised, border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.gold}`,
                borderRadius: 3, padding: "10px 12px", marginBottom: 6, color: C.ink,
                cursor: onOpen ? "pointer" : "default",
              }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="bx-d" style={{ display: "block", fontSize: 12, color: C.muted }}>{r.where}</span>
                <span style={{ display: "block", fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.who}</span>
              </span>
              <span className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>{r.score}</span>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginBottom: 14 }}>
          {onOpen ? "Tap a match to open it. " : ""}
          {isOwner
            ? "To make bulk changes instead, switch off Protect played matches in Settings."
            : "The host can switch off Protect played matches in Settings."}
        </div>
        <Btn onClick={onClose} tone="ghost" style={{ width: "100%", justifyContent: "center", padding: 12 }}>Got it</Btn>
      </div>
    </div>,
    document.body,
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

function StagePoints({ koSize, thirdPlace, points, onChange, bestOf, onBestOf }) {
  const stages = stagesFor(koSize, thirdPlace);
  const of = (key) => Math.max(1, (bestOf && bestOf[key]) || 1);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {stages.map((s, i) => {
        const tone = GROUP_COLORS[i % GROUP_COLORS.length];
        const n = of(s.key);
        return (
          <div key={s.key} style={{
            background: C.base, border: `1px solid ${C.line}`, borderRadius: 3, padding: "11px 12px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
              <Blade color={tone} h={15} />
              <span className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>{s.label}</span>
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>
                {n > 1
                  ? `${n} sets of ${points[s.key]}, first to ${setsToWin(n)}`
                  : `first to ${points[s.key]}`}
              </span>
            </div>
            <Segmented
              value={points[s.key]}
              onChange={(v) => onChange({ ...points, [s.key]: v })}
              options={[3, 4, 5, 7, 9, 10].map((x) => ({ value: x, label: String(x) }))}
              tone={tone}
            />
            {onBestOf && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
                  Played over
                </div>
                <Segmented
                  value={n}
                  onChange={(v) => onBestOf({ ...(bestOf || {}), [s.key]: v })}
                  options={[
                    { value: 1, label: "One set" },
                    { value: 3, label: "Best of 3" },
                    { value: 5, label: "Best of 5" },
                  ]}
                  tone={tone}
                />
              </div>
            )}
          </div>
        );
      })}
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
  const [bestOf, setBestOf] = useState(defaultBestOf());
  const [selfKO, setSelfKO] = useState(defaultSelfKO());
  const [bgUrl, setBgUrl] = useState(null);
  const [logoUrl, setLogoUrl] = useState(null);

  const [entryMsg, setEntryMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [reviewing, setReviewing] = useState(null);   // a pasted list waiting on match decisions

  const addPlayer = async () => {
    if (adding || !entry.trim()) return;
    setAdding(true); setEntryMsg(null);
    const r = await resolveEntry(entry, { eventId: null, taken: linkedIds(players) });
    setAdding(false);
    if (r.error) { setEntryMsg(r.error); return; }
    if (!r.player) return;
    setPlayers((p) => [...p, r.player]);
    setEntry("");
  };
  /*
   * Commas separate members, so a pasted list splits on line breaks alone.
   * Lines that fail stay in the box with the reason, so they can be fixed
   * and added again; the rest go in.
   */
  /*
   * Each pasted name that is not already an email is checked against everyone
   * registered. If any look like a match, nothing is added until each has
   * been confirmed or turned down; closing that review adds nothing at all.
   */
  const addBulk = async () => {
    if (adding) return;
    const lines = bulk.split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return;
    setAdding(true); setEntryMsg(null);
    const taken = linkedIds(players);
    const dir = await bladerDirectory();
    const added = [], left = [], why = [], checks = [];
    for (const line of lines) {
      const r = await resolveEntry(line, { eventId: null, taken });
      if (r.error) { left.push(line); why.push(r.error); continue; }
      if (!r.player) continue;
      const p = r.player;
      [p.profileId, ...(p.memberIds || [])].filter(Boolean).forEach((id) => taken.add(id));
      const names = p.members
        ? p.members.map((m, i) => ({ member: i, label: m, linked: !!(p.memberIds || [])[i] }))
        : [{ member: null, label: p.name, linked: !!p.profileId }];
      names.filter((x) => !x.linked).forEach((x) => {
        const candidates = matchBladers(x.label, dir, taken);
        if (candidates.length) {
          checks.push({
            key: `${added.length}:${x.member === null ? "p" : x.member}`,
            at: added.length, member: x.member, label: x.label,
            team: p.members ? p.name : null, candidates,
          });
        }
      });
      added.push(p);
    }
    setAdding(false);
    const rest = { left, why };
    if (checks.length) { setReviewing({ added, checks, ...rest }); return; }
    finishBulk(added, rest);
  };

  const finishBulk = (added, { left, why }) => {
    if (added.length) setPlayers((p) => [...p, ...added]);
    setBulk(left.join("\n"));
    setEntryMsg(why.length ? why.join(" ") : null);
  };

  // Confirmed matches link the player, under the blader name; turned-down ones stay as typed.
  const applyReview = (choice) => {
    const { added, checks } = reviewing;
    const out = added.map((p) => ({ ...p, members: p.members && [...p.members],
      memberIds: p.memberIds ? [...p.memberIds] : p.members ? p.members.map(() => null) : undefined }));
    checks.forEach((c) => {
      const b = choice[c.key];
      if (!b) return;
      const p = out[c.at];
      if (c.member === null) { p.name = b.blader_name; p.profileId = b.id; }
      else { p.members[c.member] = b.blader_name; p.memberIds[c.member] = b.id; }
    });
    out.forEach((p) => { if (p.memberIds && !p.memberIds.some(Boolean)) delete p.memberIds; });
    out.forEach((p) => { if (!p.members) delete p.members; if (p.memberIds === undefined) delete p.memberIds; });
    const r = reviewing;
    setReviewing(null);
    finishBulk(out, r);
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
        name: name.trim(), format, players, groups: table, points, bestOf: defaultBestOf(), selfKO,
        leaguePoints, advance: 1, koSize: 0, thirdPlace: false,
        groupMatches: buildGroupMatches(table), bracket: null, bgUrl, logoUrl,
      });
      return;
    }

    const groups = Array.from({ length: numGroups }, (_, i) => ({
      id: "g" + i, name: "Group " + GROUP_LETTERS[i], playerIds: [],
    }));
    onCreate({
      name: name.trim(), format, players, groups, points, bestOf, selfKO, advance,
      koSize, thirdPlace: third, groupMatches: [], bracket: null, bgUrl, logoUrl,
    });
  };

  return (
    <div className="bx" style={{ ...shell, ...arenaStyle(bgUrl) }}>
      <div style={{
        maxWidth: 620, margin: "0 auto", padding: "44px 18px 70px", paddingTop: safeTop("44px"),
      }}>

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
            placeholder="Enter name" />
        </Field>

        <Field label="Self-KO"
          hint="A bey that goes out on its own hands the point to the other side. Turn it off to score only the finishes above it.">
          <label style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={selfKO.enabled}
              onChange={(e) => setSelfKO((v) => ({ ...v, enabled: e.target.checked }))}
              style={{ width: 17, height: 17, accentColor: C.magenta }} />
            <span style={{ fontSize: 14.5 }}>Count a self-KO</span>
          </label>
          {selfKO.enabled && (
            <Segmented value={selfKO.pts}
              onChange={(v) => setSelfKO((x) => ({ ...x, pts: v }))}
              options={[{ value: 1, label: "Worth 1" }, { value: 2, label: "Worth 2" }]} />
          )}
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
              placeholder={format === "tag" ? "Ronin: Ayo, bex@email.com" : "A name, or their email"} />
            <Btn onClick={addPlayer} tone="primary" disabled={adding} style={{ flexShrink: 0 }}><Plus size={16} />Add</Btn>
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 6, lineHeight: 1.45 }}>
            Type the email someone signed up with instead of a name to link their blader profile.
          </div>
          {format !== "tag" && (
            <Btn tone="ghost" onClick={() => setPicking(true)} style={{ marginTop: 8 }}>
              <Users size={15} />Choose from registered bladers
            </Btn>
          )}
          {entryMsg && (
            <div style={{ fontSize: 13, color: C.magenta, marginTop: 6, lineHeight: 1.45 }}>{entryMsg}</div>
          )}
          {picking && (
            <BladerPicker taken={linkedIds(players)} onClose={() => setPicking(false)}
              onPick={(b) => {
                setPlayers((p) => [...p, { id: uid(), name: b.blader_name, profileId: b.id }]);
                setPicking(false);
              }} />
          )}
          {reviewing && (
            <MatchReview checks={reviewing.checks} onDone={applyReview}
              onClose={() => setReviewing(null)} />
          )}
          {players.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {players.map((p) => (
                <span key={p.id} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, background: C.surface,
                  border: `1px solid ${C.line}`, borderRadius: 3, padding: "6px 9px", fontSize: 14,
                }}>
                  <span>
                    {isLinked(p) && <Link2 size={12} color={C.cyan} style={{ marginRight: 4, verticalAlign: "-1px" }} />}
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
          {bulk.trim() && (
            <Btn onClick={addBulk} disabled={adding} style={{ marginTop: 6 }}>
              {adding ? "Checking names…" : "Add pasted names"}
            </Btn>
          )}
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
                options={[3, 4, 5, 7, 9, 10].map((n) => ({ value: n, label: String(n) }))} />
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
          <StagePoints koSize={koSize} thirdPlace={third} points={points} onChange={setPoints}
            bestOf={bestOf} onBestOf={setBestOf} />
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

function GroupsView({ t, update, check, nameOf, isAdmin, eventId }) {
  const [moving, setMoving] = useState(null);
  const [ask, setAsk] = useState(null);         // null | "redraw" | "blocked"
  const [pending, setPending] = useState(null); // a move/remove awaiting confirmation
  const [entry, setEntry] = useState("");
  const assigned = new Set(t.groups.flatMap((g) => g.playerIds));
  const unassigned = t.players.filter((p) => !assigned.has(p.id));

  // A bracket seeded from the old groups would be a fiction, so it goes too.
  const drawFn = (d) => {
    const ids = d.players.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    d.groups.forEach((g) => (g.playerIds = []));
    ids.forEach((id, i) => d.groups[i % d.groups.length].playerIds.push(id));
    d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
    d.bracket = null;
    return d;
  };
  const draw = () => { update(drawFn, { what: "Redrawing the groups" }); setAsk(null); };
  const protect = protects(t);

  const scored = scoredCount(t);
  const alreadyDrawn = t.groups.some((g) => g.playerIds.length > 0);

  // A redraw once scores exist is never what someone means to do mid-event, so
  // it is refused rather than merely confirmed — clearing the results has to be
  // a separate, deliberate act.
  const onDrawClick = () => {
    // The draw is random, so the check assumes the worst: every fixture goes.
    const everyFixture = (d) => { d.groupMatches = []; d.bracket = null; return d; };
    if (protect ? !check(everyFixture, "Redrawing the groups") : scored > 0) {
      if (!protect) setAsk("blocked");
      return;
    }
    if (alreadyDrawn) setAsk("redraw");
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

  const [entryMsg, setEntryMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);

  const addPlayer = async () => {
    if (adding || !entry.trim()) return;
    setAdding(true); setEntryMsg(null);
    const r = await resolveEntry(entry, { eventId, taken: linkedIds(t.players) });
    setAdding(false);
    if (r.error) { setEntryMsg(r.error); return; }
    if (!r.player) return;
    // Placed outside the groups, so putting them somewhere stays a decision.
    update((d) => { d.players.push(r.player); return d; });
    setEntry("");
  };

  const moveFn = (playerId, gid) => (d) => {
    d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== playerId)));
    if (gid) d.groups.find((g) => g.id === gid).playerIds.push(playerId);
    // Fixtures against their old group cease to exist, and with them any
    // results those fixtures held.
    d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
    return d;
  };
  const moveTo = (playerId, gid) => {
    update(moveFn(playerId, gid), { what: `Moving ${nameOf(playerId)}` });
    setMoving(null); setPending(null);
  };

  const removeFn = (playerId) => (d) => {
    d.players = d.players.filter((p) => p.id !== playerId);
    d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== playerId)));
    d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
    // A bracket holding a blader who no longer exists is a fiction.
    if (bracketMatches(d.bracket).some((m) => m.p1 === playerId || m.p2 === playerId)) {
      d.bracket = null;
    }
    return d;
  };
  const removePlayer = (playerId) => {
    update(removeFn(playerId), { what: `Removing ${nameOf(playerId)}` });
    setMoving(null); setPending(null);
  };

  // Same group in, same group out costs nothing, so it skips the warning.
  const askMove = (playerId, gid) => {
    const from = groupOf(playerId);
    if (gid && from && from.id === gid) { setMoving(null); return; }
    if (!check(moveFn(playerId, gid), `Moving ${nameOf(playerId)}`)) return;
    if (playedBy(playerId) > 0) setPending({ kind: "move", pid: playerId, gid });
    else moveTo(playerId, gid);
  };

  const askRemove = (playerId) => {
    if (!check(removeFn(playerId), `Removing ${nameOf(playerId)}`)) return;
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
          body={"Everyone is reshuffled at random and all fixtures are rebuilt. The current group arrangement is lost."
            + (t.bracket ? " The knockout bracket is removed too — rebuild it from the Table tab." : "")}
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
              onKeyDown={(e) => e.key === "Enter" && addPlayer()} placeholder="A name, or their email" />
            <Btn onClick={addPlayer} tone="primary" disabled={adding} style={{ flexShrink: 0 }}><Plus size={16} />Add</Btn>
          </div>
          {!isTag(t) && (
            <Btn tone="ghost" onClick={() => setPicking(true)} style={{ marginTop: 8 }}>
              <Users size={15} />Choose from registered bladers
            </Btn>
          )}
          {entryMsg && (
            <div style={{ fontSize: 13, color: C.magenta, marginTop: 8, lineHeight: 1.45 }}>{entryMsg}</div>
          )}
          {picking && (
            <BladerPicker taken={linkedIds(t.players)} onClose={() => setPicking(false)}
              onPick={(b) => {
                update((d) => { d.players.push({ id: uid(), name: b.blader_name, profileId: b.id }); return d; });
                setPicking(false);
              }} />
          )}
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
          position: "sticky", top: safeTop("70px"), zIndex: 15, background: C.raised,
          border: `1px solid ${C.magenta}`, borderRadius: 4, padding: 12, marginBottom: 14,
        }}>
          <div style={{ fontSize: 13.5, marginBottom: 9 }}>
            Move <strong>{nameOf(moving)}</strong> to
            {playedBy(moving) > 0 && (
              <span style={{ color: C.gold }}> — {playedBy(moving)} played match{playedBy(moving) > 1 ? "es" : ""} {protect ? "to reset first" : "at stake"}</span>
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
                    {nameOf(id)}<LinkMark t={t} id={id} />
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
          ? `Everyone plays everyone once, ${stageLine(t, "group")}.`
          : `Everyone plays everyone in their group, ${stageLine(t, "group")}.`)
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
            {ms.map((m) => <MatchRow key={m.id} m={m} nameOf={nameOf} locked={!isAdmin}
              bestOf={bestOfFor(m, t)} onClick={() => onScore(m.id)} />)}
          </div>
        );
      })}
    </div>
  );
}

/** byePossible: only the opening round, where an empty slot really is a bye. */
function MatchRow({ m, nameOf, onClick, label, locked, byePossible, bestOf, pending }) {
  const { s1, s2 } = scoreOf(m);
  const w = winnerOf(m);
  const both = m.p1 && m.p2 && !locked;
  /*
   * A match played over sets shows how many each side took, which on its own
   * reads exactly like a points score. Underneath it gets one box per set the
   * match could have run to — a best of three shows three, and the third
   * stays empty when two straight sets settled it, which is the point: the
   * shape of the match is visible without reading anything.
   */
  const slots = Math.max(1, bestOf || 1);
  const sets = slots > 1 && m.sets && m.sets.length ? m.sets : null;
  return (
    <button onClick={both ? onClick : undefined} disabled={!both}
      style={{
        width: "100%", display: "block",
        background: C.surface, border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${m.done ? C.green : C.raised}`,
        borderRadius: 3, padding: "12px", marginBottom: 6,
        cursor: both ? "pointer" : "default", textAlign: "left", color: C.ink,
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {label && <span className="bx-d" style={{ fontSize: 12, color: C.muted, width: 28, flexShrink: 0 }}>{label}</span>}
      <span style={{
        flex: 1, fontSize: 14.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", fontWeight: w === m.p1 ? 700 : 400,
        color: m.p1 ? (w === m.p1 ? C.magenta : C.ink) : C.muted,
      }}>{m.p1 ? nameOf(m.p1) : (m.p2 && byePossible ? "Bye" : (pending ? pending[0] : "TBD"))}</span>
      <span className="bx-d" style={{
        fontSize: 19, fontWeight: 800, flexShrink: 0,
        color: m.done ? C.ink : C.muted, minWidth: 50, textAlign: "center",
      }}>{m.done ? (m.sets && m.sets.length ? `${setWins(m).w1}–${setWins(m).w2}` : `${s1}–${s2}`) : "vs"}</span>
      <span style={{
        flex: 1, fontSize: 14.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", textAlign: "right", fontWeight: w === m.p2 ? 700 : 400,
        color: m.p2 ? (w === m.p2 ? C.cyan : C.ink) : C.muted,
      }}>{m.p2 ? nameOf(m.p2) : (m.p1 && byePossible ? "Bye" : (pending ? pending[1] : "TBD"))}</span>
      </div>
      {sets && (
        <div style={{
          display: "grid", gap: 4, marginTop: 8,
          gridTemplateColumns: `repeat(${slots}, 1fr)`,
        }}>
          {Array.from({ length: slots }, (_, i) => {
            const st = sets[i];
            const to1 = st && st.s1 > st.s2;
            const col = !st ? C.muted : to1 ? C.magenta : C.cyan;
            return (
              <div key={i} style={{
                borderRadius: 3, padding: "5px 4px", textAlign: "center",
                border: `1px solid ${st ? col + "55" : C.line}`,
                background: st ? `${col}14` : "transparent",
              }}>
                <div style={{ fontSize: 10, color: C.muted, letterSpacing: .3 }}>Set {i + 1}</div>
                <div className="bx-d" style={{
                  fontSize: 14, fontWeight: 700, color: st ? col : C.line, marginTop: 1,
                }}>{st ? `${st.s1}–${st.s2}` : "–"}</div>
              </div>
            );
          })}
        </div>
      )}
    </button>
  );
}

/* ================================================================== */
/*  Standings                                                          */
/* ================================================================== */

function TableView({ t, nameOf, update, check, onPlayer, isAdmin, group, setGroup, onFinal, eventId, isOwner, meId }) {
  const allPlayed = t.groupMatches.length > 0 && t.groupMatches.every((m) => m.done);
  const everything = everyMatch(t);
  const playedCount = everything.filter((m) => m.done).length;
  const [ask, setAsk] = useState(false);

  const ties = isAdmin ? pendingTies(t, nameOf) : [];
  const unsettled = ties.filter((x) => !x.winner).length;

  /* Recorded against the pair, not the group or the place, so it survives
     everything around it changing — a rebuild, a late result, another
     blader added. Choosing the name already chosen clears it. */
  const setTie = (a, b, winner) => update((d) => {
    const next = { ...(d.tieBreaks || {}) };
    if (winner) next[tieKey(a, b)] = winner; else delete next[tieKey(a, b)];
    d.tieBreaks = next;
    return d;
  });

  const canPair = pairedFits(t.groups, t.advance, t.koSize);
  const [template, setTemplate] = useState(
    () => (t.bracketTemplate === "paired" && canPair ? "paired" : "standard"));
  const [pairs, setPairs] = useState(() => pairingOrder(t.groups, t.groupPairs));

  // Choosing a group for a place swaps it with wherever it was, so every group stays in exactly one pair.
  const placeGroup = (i, gid) => setPairs((cur) => {
    const next = [...cur];
    const j = next.indexOf(gid);
    if (j >= 0) next[j] = next[i];
    next[i] = gid;
    return next;
  });

  const buildFn = (d) => {
    const paired = template === "paired" && pairedFits(d.groups, d.advance, d.koSize);
    if (paired) {
      const order = pairingOrder(d.groups, pairs);
      d.bracket = buildPairedBracket(d.groups, d.groupMatches, d.advance, d.koSize, d.thirdPlace, nameOf, d.tieBreaks, order);
      d.groupPairs = order;
    } else {
      const quals = collectQualifiers(d.groups, d.groupMatches, d.advance, nameOf, d.tieBreaks);
      d.bracket = buildBracket(quals, d.koSize, d.thirdPlace);
    }
    d.bracketTemplate = paired ? "paired" : "standard";
    return d;
  };
  const makeBracket = () => {
    update(buildFn, { what: t.bracket ? "Rebuilding the bracket" : "Building the bracket" });
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
        const rows = computeStandings(g.playerIds, ms, nameOf,
          isLeague(t) ? t.leaguePoints : null, t.tieBreaks);
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
                        <td style={{ ...td, textAlign: "left", fontWeight: q ? 600 : 400, whiteSpace: "nowrap" }}>{nameOf(r.id)}<LinkMark t={t} id={r.id} /></td>
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

      {ties.length > 0 && (
        <div style={{ ...card, borderColor: `${C.gold}88`, marginBottom: 14 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>
            Tie-breaker{ties.length > 1 ? "s" : ""}
          </div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "58ch" }}>
            Nothing in the table separates these. Play them off and tap whoever won — the
            score is not kept, only the result, and the standings and the seeding follow it.
            Tapping the same name again undoes the decision.
          </div>
          {ties.map((x) => (
            <div key={x.key} style={{
              background: C.base, border: `1px solid ${C.line}`, borderRadius: 3,
              padding: "10px 11px", marginBottom: 7,
            }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 7 }}>
                {x.group} · level on place {x.place}
                {x.cut ? " — the last one through" : ""}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[x.a, x.b].map((id) => (
                  <Btn key={id} tone={x.winner === id ? "primary" : "default"}
                    onClick={() => setTie(x.a, x.b, x.winner === id ? null : id)}
                    style={{ justifyContent: "center" }}>
                    {x.winner === id && <Check size={14} />}{nameOf(id)}
                  </Btn>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

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
            {unsettled > 0 && ` ${unsettled} tie-breaker${unsettled > 1 ? "s are" : " is"} still
              unsettled; without ${unsettled > 1 ? "them" : "it"} those places fall back to
              alphabetical order.`}
          </div>
          {canPair && (
            <div style={{ marginBottom: 13 }}>
              <div className="bx-d" style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 7 }}>Template</div>
              <Segmented value={template} onChange={setTemplate} tone={C.magenta} options={[
                { value: "standard", label: "Standard seeding" },
                { value: "paired", label: "Paired Groups" },
              ]} />
              {template === "paired" && t.groups.length > 2 && (
                <div style={{ marginTop: 10 }}>
                  {Array.from({ length: pairs.length / 2 }, (_, pi) => (
                    <div key={pi} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      {[0, 1].map((side) => (
                        <Fragment key={side}>
                          {side === 1 && <span style={{ color: C.muted, fontSize: 13 }}>paired with</span>}
                          <select style={{ ...inputStyle, padding: "8px 10px", fontSize: 14, flex: 1 }}
                            value={pairs[pi * 2 + side]}
                            onChange={(e) => placeGroup(pi * 2 + side, e.target.value)}>
                            {t.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </Fragment>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8, lineHeight: 1.55 }}>
                {template === "standard"
                  ? "Every qualifier seeded by group place and record, the field split down the middle."
                  : pairedPreview(t.groups, t.advance, pairs).map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </div>
          )}
          <Btn onClick={() => {
            if (t.bracket && !check(buildFn, "Rebuilding the bracket")) return;
            if (t.bracket) setAsk(true); else makeBracket();
          }}
            tone={allPlayed ? "primary" : "default"}>
            <GitBranch size={15} />{t.bracket ? "Rebuild bracket" : "Build bracket"}
          </Btn>
        </div>
      )}

      {t.finalRanking && isAdmin ? (
        <div style={{ ...card, borderColor: `${C.green}88`, marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <Check size={17} color={C.green} />
            <div className="bx-d" style={{ fontSize: 19, fontWeight: 700 }}>Final ranking confirmed</div>
          </div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "58ch" }}>
            Saved {new Date(t.finalRanking.confirmedAt).toLocaleString()}. Open it to see the ranking or
            download the CSV; it only changes if you unlock it.
          </div>
          <Btn onClick={onFinal} tone="primary"><Medal size={15} />View final ranking</Btn>
        </div>
      ) : finished && isAdmin && (
        <div style={{ ...card, borderColor: `${C.gold}88`, marginTop: 14 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>
            Generate final standings
          </div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "58ch" }}>
            Rank every blader on your own scoring — points per win and per margin, plus
            what each stage pays for playing and for winning. The champion need not come
            out on top. Confirm the ranking to save it for good, and download a CSV of the whole tournament.
          </div>
          <Btn onClick={onFinal} tone="primary"><Medal size={15} />Generate final standings</Btn>
        </div>
      )}

      <SeriesCard eventId={eventId} eventName={t.name} isOwner={isOwner} meId={meId} />

      {/* Not gated on the tournament being finished, and not on being an
          admin: taking the results away mid-run is the whole point, and a
          spectator wanting the numbers costs nobody anything. */}
      <div style={{ ...card, marginTop: 14 }}>
        <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>
          Match results
        </div>
        <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "58ch" }}>
          Every match as it stands — {playedCount} of {everything.length} played — with the
          score, the sets, the winner, and every point in the order it was scored.
          Matches still to come are listed too.
        </div>
        <Btn onClick={() => downloadCSV(`${slug(t.name)}-match-results.csv`, buildMatchesCSV(t))}>
          <Download size={15} />Download match results
        </Btn>
      </div>

      {ask && (
        <Confirm
          title="Rebuild the bracket?"
          body={(koScored > 0
            ? `The bracket is reseeded from the current standings, and the ${koScored} knockout match${koScored > 1 ? "es" : ""} already scored ${koScored > 1 ? "are" : "is"} cleared.`
            : "The bracket is reseeded from the current standings. Nothing has been scored in the knockout yet, so no results are lost.")
            + (t.bracket && t.bracket.edited && Object.values(t.bracket.edited).some(Boolean)
              ? " Matchups you set by hand are replaced too."
              : "")}
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

const BRACKET_VIEW_KEY = "bx:bracketView";

function BracketView({ t, nameOf, onScore, isAdmin, onEditRound, view, onView }) {
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
        sub={isAdmin ? "Winners move up automatically. Re-scoring a match re-opens everything after it." : "Live bracket."}
        action={<ViewSwitch value={view} onChange={onView} />} />

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

      {view === "tree" && (
        <BracketTree t={t} nameOf={nameOf} isAdmin={isAdmin} onScore={onScore} onEditRound={onEditRound} />
      )}

      {view === "list" && t.bracket.rounds.map((r, ri) => {
        const teams = r.length * 2;
        // A final fed by two semis has only one arrangement, so it has no editor.
        const editable = onEditRound && (ri === 0 || r.length >= 2);
        const edited = t.bracket.edited && t.bracket.edited[ri];
        const feed = ri > 0 ? feedFor(t.bracket, ri) : null;
        return (
          <div key={ri} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, flexWrap: "wrap" }}>
              <Blade color={C.gold} h={17} />
              <span className="bx-d" style={{ fontSize: 18, fontWeight: 700 }}>{roundName(teams)}</span>
              {edited && (
                <span style={{ fontSize: 11, color: C.gold, border: `1px solid ${C.gold}55`, borderRadius: 3, padding: "1px 6px" }}>
                  set by hand
                </span>
              )}
              <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>
                {stageLine(t, stageKeyForTeams(teams))}
              </span>
              {editable && (
                <button onClick={() => onEditRound(ri)} aria-label={`Edit ${roundName(teams)} matchups`}
                  style={{
                    background: "none", border: `1px solid ${C.line}`, borderRadius: 3, color: C.muted,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", fontSize: 12.5,
                  }}>
                  <Pencil size={13} />Edit
                </button>
              )}
            </div>
            {r.map((m, i) => (
              <MatchRow key={m.id} m={m} nameOf={nameOf} locked={!isAdmin} byePossible={ri === 0}
                pending={feed ? [`Winner M${feed[i][0] + 1}`, `Winner M${feed[i][1] + 1}`] : null}
                bestOf={bestOfFor(m, t)} onClick={() => onScore(m.id)} label={`M${i + 1}`} />
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
              {stageLine(t, "third")}
            </span>
          </div>
          <MatchRow m={t.bracket.third} nameOf={nameOf} locked={!isAdmin}
            bestOf={bestOfFor(t.bracket.third, t)} onClick={() => onScore(t.bracket.third.id)} />
        </div>
      )}
    </div>
  );
}

function ViewSwitch({ value, onChange }) {
  const opt = (v, Icon, label) => {
    const on = value === v;
    return (
      <button onClick={() => onChange(v)} aria-pressed={on} className="bx-d"
        style={{
          display: "flex", alignItems: "center", gap: 5, padding: "7px 10px", fontSize: 13.5, fontWeight: 700,
          cursor: "pointer", border: "none", borderRadius: 2,
          background: on ? C.gold : "transparent", color: on ? "#14020A" : C.muted,
        }}>
        <Icon size={14} />{label}
      </button>
    );
  };
  return (
    <div role="group" aria-label="Bracket view" style={{
      display: "flex", gap: 2, padding: 2, border: `1px solid ${C.line}`, borderRadius: 3, background: C.base,
    }}>
      {opt("list", List, "List")}
      {opt("tree", Network, "Tree")}
    </div>
  );
}

/*
 * The order to draw each round's matches in, so every match sits level with
 * the two that feed it and no line crosses another. Worked back from the
 * final through each round's feed, which is why a bracket set by hand or
 * built from Paired Groups still draws as a clean tree: the two matches
 * feeding display slot k always land in slots 2k and 2k+1.
 */
function treeOrder(bracket) {
  const n = bracket.rounds.length;
  const order = Array(n);
  order[n - 1] = bracket.rounds[n - 1].map((_, i) => i);
  for (let r = n - 1; r > 0; r--) {
    const feed = feedFor(bracket, r);
    order[r - 1] = order[r].flatMap((j) => feed[j]);
  }
  return order;
}

/** Where each qualifier finished in their group, as "A1", "B2" — for the opening round. */
function seedTags(t, nameOf) {
  const out = {};
  if (!t.groups || !t.groups.length || isLeague(t)) return out;
  collectQualifiers(t.groups, t.groupMatches, t.advance, nameOf, t.tieBreaks).forEach((q) => {
    const short = groupShort(t.groups.find((g) => g.id === q.groupId));
    out[q.id] = `${short.length <= 2 ? short : short.slice(0, 3)}${q.placement}`;
  });
  return out;
}

const TREE = { W: 172, GAP: 30, CELL: 86, H: 72, HEAD: 44 };

function BracketTree({ t, nameOf, isAdmin, onScore, onEditRound }) {
  const b = t.bracket;
  const order = treeOrder(b);
  const tags = seedTags(t, nameOf);
  const { W, GAP, CELL, H, HEAD } = TREE;
  const width = b.rounds.length * (W + GAP) - GAP;
  const height = HEAD + b.rounds[0].length * CELL;
  const x = (r) => r * (W + GAP);
  const cy = (r, k) => HEAD + (k + 0.5) * CELL * 2 ** r;

  // An elbow from each match to the one it feeds, gold once it has a winner.
  const lines = [];
  for (let r = 0; r + 1 < b.rounds.length; r++) {
    order[r + 1].forEach((_, k) => {
      [0, 1].forEach((side) => {
        const src = b.rounds[r][order[r][2 * k + side]];
        const x1 = x(r) + W, xm = x1 + GAP / 2, x2 = x(r + 1);
        lines.push({ key: `${r}:${k}:${side}`, lit: !!(src && winnerOf(src)),
          d: `M${x1} ${cy(r, 2 * k + side)} H${xm} V${cy(r + 1, k)} H${x2}` });
      });
    });
  }
  lines.sort((a, c) => a.lit - c.lit); // lit ones drawn last, on top

  return (
    <div style={{ marginBottom: 24 }}>
      {/* On a phone it scrolls sideways; the board widens the page for it on a big screen. */}
      <div style={{ overflowX: "auto", paddingBottom: 8 }}>
        <div style={{ position: "relative", width, height, margin: "0 auto" }}>
          <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
            {lines.map((l) => (
              <path key={l.key} d={l.d} fill="none"
                stroke={l.lit ? C.gold : C.line} strokeWidth={l.lit ? 2 : 1.5} />
            ))}
          </svg>
          {b.rounds.map((r, ri) => {
            const teams = r.length * 2;
            const editable = onEditRound && (ri === 0 || r.length >= 2);
            const feed = ri > 0 ? feedFor(b, ri) : null;
            return (
              <Fragment key={ri}>
                <div style={{ position: "absolute", left: x(ri), top: 0, width: W, display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="bx-d" style={{ fontSize: 15, fontWeight: 700, color: C.gold, whiteSpace: "nowrap" }}>{roundName(teams)}</div>
                    <div style={{ fontSize: 11.5, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {stageLine(t, stageKeyForTeams(teams))}
                    </div>
                  </div>
                  {editable && (
                    <button onClick={() => onEditRound(ri)} aria-label={`Edit ${roundName(teams)} matchups`}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 3, color: C.muted, cursor: "pointer", display: "flex", padding: 5 }}>
                      <Pencil size={12} />
                    </button>
                  )}
                </div>
                {order[ri].map((mi, k) => (
                  <div key={r[mi].id} style={{ position: "absolute", left: x(ri), top: cy(ri, k) - H / 2, width: W, height: H }}>
                    <TreeCard m={r[mi]} label={`M${mi + 1}`} nameOf={nameOf} locked={!isAdmin}
                      tags={ri === 0 ? tags : null} bye={ri === 0}
                      pending={feed ? [`Winner M${feed[mi][0] + 1}`, `Winner M${feed[mi][1] + 1}`] : null}
                      onClick={() => onScore(r[mi].id)} />
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      {Object.keys(tags).length > 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
          A1 is the winner of Group A, B2 the runner-up of Group B, and so on.
        </div>
      )}
    </div>
  );
}

/** One match in the tree: two lines, the winner lit, tappable to score. */
function TreeCard({ m, label, nameOf, locked, tags, bye, pending, onClick }) {
  const w = winnerOf(m);
  const both = m.p1 && m.p2 && !locked;
  const played = m.done && m.p1 && m.p2;
  const sets = played && m.sets && m.sets.length ? setWins(m) : null;
  const { s1, s2 } = scoreOf(m);
  const line = (id, side) => {
    const other = side === 1 ? m.p2 : m.p1;
    const text = id ? nameOf(id) : (bye && other ? "Bye" : (pending ? pending[side - 1] : "TBD"));
    const won = id && w === id;
    const col = side === 1 ? C.magenta : C.cyan;
    const tag = id && tags ? tags[id] : null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 24 }}>
        {tags && (
          <span className="bx-d" style={{
            fontSize: 11, fontWeight: 700, width: 26, flexShrink: 0, textAlign: "center",
            color: tag ? C.gold : C.line, border: `1px solid ${tag ? C.gold + "55" : C.line}`, borderRadius: 2, padding: "1px 0",
          }}>{tag || "–"}</span>
        )}
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontWeight: won ? 700 : 400,
          color: !id ? C.muted : won ? col : played ? C.muted : C.ink,
        }}>{text}</span>
        {played && (
          <span className="bx-d" style={{ fontSize: 14, fontWeight: 800, color: won ? col : C.muted, flexShrink: 0 }}>
            {sets ? (side === 1 ? sets.w1 : sets.w2) : (side === 1 ? s1 : s2)}
          </span>
        )}
      </div>
    );
  };
  return (
    <button onClick={both ? onClick : undefined} disabled={!both} style={{
      width: "100%", height: "100%", display: "block", textAlign: "left", color: C.ink,
      background: C.surface, border: `1px solid ${w ? C.gold + "66" : C.line}`,
      borderLeft: `3px solid ${m.done && m.p1 && m.p2 ? C.green : C.raised}`,
      borderRadius: 3, padding: "3px 8px", cursor: both ? "pointer" : "default",
    }}>
      <div className="bx-d" style={{ fontSize: 10.5, color: C.muted, lineHeight: 1.2 }}>{label}</div>
      {line(m.p1, 1)}
      {line(m.p2, 2)}
    </button>
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
  /*
   * Sets are replayed from the finish log rather than tracked alongside it, so
   * undo stays "drop the last finish" and there is no second piece of state to
   * fall out of step. A best of 1 is the same code path with one set.
   */
  const bestOf = bestOfFor(match, t);
  const selfKO = selfKOFor(t);
  const run = splitSets(events, target, bestOf);
  const over = run.decided;
  // Reset on a match that has a saved result: saving now clears it.
  const clearing = !events.length && (match.events || []).length > 0;

  // The big numbers are the set being played — or the last one, once the match
  // is over, since the set in progress resets to nothing the moment it closes.
  const shown = over && run.sets.length ? run.sets[run.sets.length - 1] : run.current;
  const s1 = shown.s1;
  const s2 = shown.s2;

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

  /*
   * The cap is worked out inside the updater, against the events as they are
   * at that moment. Taken from the rendered score instead, two taps landing in
   * the same frame both read the score before either of them counted, and a
   * first-to-7 set could finish 9-0.
   *
   * Capped against the set in progress, not the match: each set runs to the
   * target on its own.
   */
  const add = (side, f) => {
    setEvents((prev) => {
      const now = splitSets(prev, target, bestOf);
      if (now.decided) return prev;
      const cur = side === 1 ? now.current.s1 : now.current.s2;
      const pts = Math.min(f.pts, target - cur);
      if (pts <= 0) return prev;
      return [...prev, { side, type: f.key, pts, raw: f.pts }];
    });
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
        {/* Set apart from the finishes: these are points the other side gave
            away, not points won on the beystadium. */}
        <div style={{
          display: "grid", gap: 6, marginTop: 6,
          gridTemplateColumns: selfKO.enabled ? "1fr 1fr" : "1fr",
        }}>
          {awardBtn(PENALTY, {
            background: "transparent", borderStyle: "dashed", fontSize: 14, padding: "10px 4px",
          })}
          {selfKO.enabled && awardBtn({ ...SELF, pts: selfKO.pts }, {
            background: "transparent", borderStyle: "dashed", fontSize: 14, padding: "10px 4px",
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        paddingTop: safeTop("13px"),
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={tryClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.05 }}>
            {bestOf > 1
              ? `Set ${Math.min(run.sets.length + (over ? 0 : 1), bestOf)} · first to ${target}`
              : `First to ${target}`}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted }}>
            {stageLabel}
            {bestOf > 1 && ` · best of ${bestOf}, sets ${run.w1}–${run.w2}`}
          </div>
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

        {bestOf > 1 && run.sets.length > 0 && (
          <div style={{
            marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
          }}>
            <span style={{ fontSize: 12.5, color: C.muted }}>Sets</span>
            {run.sets.map((st, i) => (
              <span key={i} className="bx-d" style={{
                fontSize: 13.5, fontWeight: 700, padding: "4px 9px", borderRadius: 3,
                border: `1px solid ${st.s1 > st.s2 ? C.magenta : C.cyan}55`,
                background: `${st.s1 > st.s2 ? C.magenta : C.cyan}14`,
                color: st.s1 > st.s2 ? C.magenta : C.cyan,
              }}>{st.s1}–{st.s2}</span>
            ))}
            {!over && (
              <span style={{ fontSize: 12.5, color: C.muted }}>
                first to {run.need} set{run.need > 1 ? "s" : ""} takes it
              </span>
            )}
          </div>
        )}

        {over && (
          <div style={{
            marginTop: 14, padding: "13px 14px", borderRadius: 4,
            background: `${C.green}16`, border: `1px solid ${C.green}66`,
            fontSize: 14.5, display: "flex", alignItems: "center", gap: 9,
          }}>
            <Check size={17} color={C.green} />
            <span>
              <strong>{nameOf(run.w1 > run.w2 ? match.p1 : match.p2)}</strong> takes it{" "}
              {bestOf > 1
                ? `${Math.max(run.w1, run.w2)}–${Math.min(run.w1, run.w2)} in sets`
                : `${Math.max(s1, s2)}–${Math.min(s1, s2)}`}
            </span>
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
          <Btn onClick={() => (clearing ? onSave([], false, []) : onSave(events, over, run.sets))}
            tone={clearing ? "danger" : "primary"} disabled={!over && !clearing}
            style={{ flex: 2, justifyContent: "center", padding: 14, fontSize: 17 }}>
            {clearing ? "Save as not played" : "Save result"}
          </Btn>
        </div>
        {clearing && (
          <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, textAlign: "center", lineHeight: 1.5 }}>
            Saving clears this match's result, as if it had never been played.
          </div>
        )}
        {!over && !clearing && (
          <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>
            {bestOf > 1
              ? `Save unlocks when someone takes ${run.need} set${run.need > 1 ? "s" : ""}.`
              : `Save unlocks when a ${oneWord(t)} reaches ${target}.`}
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
    const setAt = setIndexOf(m.events, targetFor(m, t), bestOfFor(m, t));
    st.log.push({
      id: m.id, opp: me === 1 ? m.p2 : m.p1, my, oppScore: opp, won, stage: label,
      sets: (m.sets || []).map((x) => (me === 1 ? { s1: x.s1, s2: x.s2 } : { s1: x.s2, s2: x.s1 })),
      // Every point of the match in the order it was scored, from this blader's
      // side, tagged with the set it fell in.
      sequence: (m.events || []).map((e, i) => ({
        type: e.type, pts: e.pts, mine: e.side === me, set: setAt[i] || 0,
      })),
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
      {t.players.some(isLinked) && (
        <div style={{ fontSize: 12.5, color: C.muted, margin: "-6px 0 12px 15px", display: "flex", alignItems: "center", gap: 5 }}>
          <Link2 size={13} color={C.cyan} />has a blader profile; the others were entered by name.
        </div>
      )}
      {rows.map(({ p, st }) => (
        <button key={p.id} onClick={() => onPlayer(p.id)} style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3,
          padding: "13px", marginBottom: 6, cursor: "pointer", color: C.ink, textAlign: "left",
        }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{p.name}<LinkMark t={t} id={p.id} /></span>
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

/**
 * Linking a player, or each member of a team, to a profile by the email they
 * signed up with. Only for whoever runs the tournament. The tournament keeps
 * the name it already uses; the link only says whose profile this is.
 */
function LinkPanel({ t, playerId, update, eventId }) {
  const p = t.players.find((x) => x.id === playerId);
  const [emails, setEmails] = useState({});
  const [names, setNames] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [picking, setPicking] = useState(null);    // the slot a blader is being chosen for
  const [byEmail, setByEmail] = useState(null);    // the slot showing the email field

  const slots = !p ? [] : p.members && p.members.length
    ? p.members.map((m, i) => ({ key: `m${i}`, label: m, id: (p.memberIds || [])[i] || null, member: i }))
    : [{ key: "p", label: p.name, id: p.profileId || null, member: null }];

  const ids = slots.map((s) => s.id).filter(Boolean).join(",");
  useEffect(() => { bladerNames(ids ? ids.split(",") : []).then(setNames); }, [ids]);

  if (!p) return null;

  const write = (slot, id) => update((d) => {
    const q = d.players.find((x) => x.id === playerId);
    if (!q) return d;
    if (slot.member === null) {
      if (id) q.profileId = id; else delete q.profileId;
    } else {
      const next = (q.memberIds || q.members.map(() => null)).slice();
      while (next.length < q.members.length) next.push(null);
      next[slot.member] = id;
      if (next.some(Boolean)) q.memberIds = next; else delete q.memberIds;
    }
    return d;
  });

  const link = async (slot) => {
    const email = (emails[slot.key] || "").trim();
    if (!looksLikeEmail(email)) { setMsg("That does not look like an email address."); return; }
    setBusy(slot.key); setMsg(null);
    const { blader, error } = await findBlader(email, eventId);
    setBusy(null);
    if (error) { setMsg("Emails could not be looked up just now."); return; }
    if (!blader) { setMsg(`No account uses ${email}.`); return; }
    if (linkedIds(t.players).has(blader.id)) { setMsg(`${blader.blader_name} is already linked in this tournament.`); return; }
    write(slot, blader.id);
    setEmails((e) => ({ ...e, [slot.key]: "" }));
  };

  return (
    <div style={{ ...card, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link2 size={16} color={C.cyan} />
        <div className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>Blader profile</div>
      </div>
      {slots.map((s) => (
        <div key={s.key} style={{ marginBottom: 10 }}>
          {slots.length > 1 && <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 5 }}>{s.label}</div>}
          {s.id ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, fontSize: 14.5 }}>
                Linked to <strong>{names[s.id] || "a profile"}</strong>
              </div>
              <Btn tone="ghost" style={{ padding: "6px 10px", fontSize: 13 }} onClick={() => write(s, null)}>Unlink</Btn>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Btn tone="primary" onClick={() => { setPicking(s); setMsg(null); }}>
                  <Link2 size={15} />Link
                </Btn>
                {byEmail !== s.key && (
                  <button onClick={() => setByEmail(s.key)} style={{
                    background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, padding: 0,
                  }}>or use their email</button>
                )}
              </div>
              {byEmail === s.key && (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input style={inputStyle} type="email" placeholder="The email they signed up with"
                    value={emails[s.key] || ""}
                    onChange={(e) => { setEmails((x) => ({ ...x, [s.key]: e.target.value })); setMsg(null); }}
                    onKeyDown={(e) => e.key === "Enter" && link(s)} />
                  <Btn tone="primary" disabled={busy === s.key} style={{ flexShrink: 0 }} onClick={() => link(s)}>Link</Btn>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {msg && <div style={{ fontSize: 13, color: C.magenta, lineHeight: 1.45 }}>{msg}</div>}
      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.45 }}>
        A linked {slots.length > 1 ? "member" : "blader"} gets this tournament on the Tournaments tab of their profile.
      </div>
      {picking && (
        <BladerPicker title={`Link ${picking.label}`} taken={linkedIds(t.players)}
          onClose={() => setPicking(null)}
          onPick={(b) => { write(picking, b.id); setPicking(null); }} />
      )}
    </div>
  );
}

/**
 * Choosing a blader from everyone registered. Rendered into the page itself
 * rather than where it is used, so one opened from inside the scoreboard is
 * not drawn beneath the scoreboard's header and tab bar.
 *
 * Real names show, and can be searched, only for someone allowed to see them;
 * the list itself decides that.
 */
function BladerPicker({ title = "Choose a blader", taken, takenLabel = "already in this tournament", onPick, onClose }) {
  const [rows, setRows] = useState(undefined);
  const [q, setQ] = useState("");
  useEffect(() => { bladerDirectory().then(setRows); }, []);

  const needle = q.trim().toLowerCase();
  const shown = (rows || []).filter((r) => !needle
    || r.blader_name.toLowerCase().includes(needle)
    || (r.real_name && r.real_name.toLowerCase().includes(needle)));

  return createPortal(
    <SheetFrame title={title} onClose={onClose}>
      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} color={C.muted} style={{ position: "absolute", left: 12, top: 13 }} />
        <input style={{ ...inputStyle, paddingLeft: 34 }} value={q} autoFocus
          placeholder="Search bladers" onChange={(e) => setQ(e.target.value)} />
      </div>
      {rows === undefined ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : rows === null ? (
        <div style={{ color: C.muted, fontSize: 14 }}>The bladers list could not be loaded.</div>
      ) : shown.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Nobody by that name.</div>
      ) : shown.map((r) => {
        const used = taken && taken.has(r.id);
        return (
          <button key={r.id} disabled={used} onClick={() => onPick(r)} style={{
            width: "100%", display: "flex", alignItems: "center", gap: 12, textAlign: "left",
            background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3,
            padding: "10px 12px", marginBottom: 6, color: C.ink,
            cursor: used ? "default" : "pointer", opacity: used ? 0.45 : 1,
          }}>
            <Avatar path={r.photo_path} name={r.blader_name} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="bx-d" style={{ fontSize: 16, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.blader_name}
              </div>
              {(r.real_name || used) && (
                <div style={{ fontSize: 12, color: C.muted }}>
                  {[r.real_name, used ? takenLabel : null].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </SheetFrame>,
    document.body,
  );
}

/**
 * Pasted names that look like someone registered, one at a time: confirm the
 * blader it is, or keep the name as typed. A blader confirmed for one name is
 * not offered for another, since one person cannot enter twice.
 */
function MatchReview({ checks, onDone, onClose }) {
  const [choice, setChoice] = useState({});   // key -> blader, or false for "keep as typed"
  const chosenFor = (id) => Object.keys(choice).find((k) => choice[k] && choice[k].id === id);
  const decide = (key, value) => setChoice((x) => {
    const next = { ...x };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  });
  const undecided = checks.filter((c) => !(c.key in choice)).length;

  const finish = (all) => {
    const out = { ...choice };
    if (all) checks.forEach((c) => { if (!(c.key in out)) out[c.key] = false; });
    onDone(out);
  };

  return createPortal(
    <SheetFrame title="Possible matches" onClose={onClose}>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 16, maxWidth: "58ch" }}>
        Some pasted names look like bladers who have signed up. Confirm who each one is to link
        their profile, or keep the name as typed. Nothing is added until you finish.
      </div>

      {checks.map((c) => (
        <div key={c.key} style={{ ...card, marginBottom: 10 }}>
          <div className="bx-d" style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>“{c.label}”</div>
          {c.team && <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>in team {c.team}</div>}
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {c.candidates.map(({ blader: b, on }) => {
              const picked = choice[c.key] && choice[c.key].id === b.id;
              const elsewhere = !picked && chosenFor(b.id);
              return (
                <button key={b.id} disabled={!!elsewhere}
                  onClick={() => decide(c.key, picked ? undefined : b)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, textAlign: "left", padding: "8px 10px",
                    background: picked ? `${C.green}1A` : C.base, color: C.ink, borderRadius: 3,
                    border: `1px solid ${picked ? C.green : C.line}`,
                    cursor: elsewhere ? "default" : "pointer", opacity: elsewhere ? 0.45 : 1,
                  }}>
                  <Avatar path={b.photo_path} name={b.blader_name} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{b.blader_name}</div>
                    <div style={{ fontSize: 11.5, color: C.muted }}>
                      {b.real_name ? `${b.real_name} · ` : ""}looks like their {on}
                      {elsewhere ? " · chosen for another name" : ""}
                    </div>
                  </div>
                  {picked && <Check size={16} color={C.green} />}
                </button>
              );
            })}
            <button onClick={() => decide(c.key, choice[c.key] === false ? undefined : false)}
              style={{
                padding: "8px 10px", borderRadius: 3, textAlign: "left", fontSize: 13.5, cursor: "pointer",
                background: choice[c.key] === false ? `${C.magenta}14` : "transparent", color: C.ink,
                border: `1px solid ${choice[c.key] === false ? C.magenta : C.line}`,
              }}>
              None of these — keep “{c.label}” as a name
            </button>
          </div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <Btn tone="primary" disabled={undecided > 0} onClick={() => finish(false)}>
          <Check size={15} />{undecided > 0 ? `${undecided} still to decide` : "Add them"}
        </Btn>
        {undecided > 0 && (
          <Btn onClick={() => finish(true)}>Keep the rest as names</Btn>
        )}
        <Btn tone="ghost" onClick={onClose}>Cancel</Btn>
      </div>
    </SheetFrame>,
    document.body,
  );
}

/**
 * The beyblades a player brought, as the hobby writes them. Anyone can see a
 * deck once it is entered; only whoever runs the tournament can enter it.
 */
function DeckSection({ t, playerId, canEdit, update }) {
  const [editing, setEditing] = useState(false);
  const p = t.players.find((x) => x.id === playerId);
  if (!p) return null;
  const deck = p.deck || [];
  if (!deck.length && !canEdit) return null;

  const save = (next) => {
    update((d) => {
      const q = d.players.find((x) => x.id === playerId);
      if (q) { if (next.length) q.deck = next; else delete q.deck; }
      return d;
    });
    setEditing(false);
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <Blade color={C.gold} h={16} />
        <h3 className="bx-d" style={{ fontSize: 19, fontWeight: 700, margin: 0, flex: 1 }}>Deck</h3>
        {canEdit && (
          <Btn tone="ghost" style={{ padding: "5px 10px", fontSize: 13 }} onClick={() => setEditing(true)}>
            <Pencil size={13} />{deck.length ? "Edit" : "Add deck"}
          </Btn>
        )}
      </div>
      {deck.length ? deck.map((c, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 10, background: C.surface,
          border: `1px solid ${C.line}`, borderRadius: 3, padding: "9px 12px", marginBottom: 6,
        }}>
          <span className="bx-d" style={{ fontSize: 13, color: C.muted, width: 16 }}>{i + 1}</span>
          <span className="bx-d" style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{comboLabel(c)}</span>
          <span style={{ fontSize: 11.5, color: C.muted }}>{COMBO_TYPES[c.type].label}</span>
        </div>
      )) : (
        <div style={{ color: C.muted, fontSize: 13.5 }}>No deck entered. It is optional.</div>
      )}
      {editing && (
        <DeckEditor title={`${p.name}'s deck`} format={t.format} deck={deck}
          onSave={save} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/**
 * Entering a deck. Each beyblade picks its line, which decides its parts, and
 * each part box suggests from the catalogue but takes anything typed — letters
 * too, so "LF" is Low Flat and "360" is 3-60. Nothing is saved while any part
 * appears twice: that is the one rule a deck has.
 */
function DeckEditor({ title, format, deck, onSave, onClose }) {
  const size = deckSize(format);
  const [combos, setCombos] = useState(() => {
    const d = (deck || []).map((c) => ({ ...c }));
    while (d.length < size) d.push(emptyCombo());
    return d;
  });

  const conflicts = deckConflicts(combos);
  const clash = (i, slot) => conflicts.find((x) => x.slot === slot && x.combos.includes(i));
  const change = (i, patch) => setCombos((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return createPortal(
    <SheetFrame title={title} onClose={onClose}>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 16, maxWidth: "58ch" }}>
        Up to {size} beyblades. No part can appear twice in one deck. Choose from the list, or type
        any part — letters work too, like LF or 3-60.
      </div>

      {Object.keys(COMBO_TYPES).flatMap((type) => COMBO_TYPES[type].slots.map((slot) => (
        <datalist key={`${type}-${slot}`} id={`parts-${type}-${slot}`}>
          {partOptions(type, slot).map((o) => <option key={o.name} value={o.name} />)}
        </datalist>
      )))}

      {combos.map((c, i) => (
        <div key={i} style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <div className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>Beyblade {i + 1}</div>
            <div className="bx-d" style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.cyan, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {comboLabel(c)}
            </div>
            <button onClick={() => change(i, { ...Object.fromEntries(Object.keys(SLOT_LABEL).map((k) => [k, ""])) })}
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12.5, padding: 0 }}>
              Clear
            </button>
          </div>
          <div style={{ marginBottom: 10 }}>
            <Segmented value={c.type} onChange={(type) => change(i, { type })} tone={C.cyan}
              options={[
                { value: "bx", label: "BX / UX" }, { value: "inf", label: "UX Infinity" },
                { value: "cx", label: "CX" }, { value: "cxi", label: "CX Infinity" },
              ]} />
          </div>
          {COMBO_TYPES[c.type].slots.map((slot) => {
            if (slot === "ratchet" && bitHasRatchet(c.bit)) {
              return (
                <div key={slot} style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
                  Ratchet: none needed — the bit below comes with its own.
                </div>
              );
            }
            const x = clash(i, slot);
            const others = x ? x.combos.filter((j) => j !== i).map((j) => j + 1) : [];
            return (
              <div key={slot} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
                  {SLOT_LABEL[slot]}
                  {slot === "ratchet" ? " (leave empty if the bit has its own)" : ""}
                  {slot === "lock" ? " (may repeat; only one metal lock chip per deck)" : ""}
                </div>
                <input style={{ ...inputStyle, padding: "9px 11px", borderColor: x ? C.magenta : C.line }}
                  list={`parts-${c.type}-${slot}`} value={c[slot] || ""}
                  onChange={(e) => change(i, { [slot]: e.target.value })} />
                {x && (
                  <div style={{ fontSize: 12, color: C.magenta, marginTop: 3 }}>
                    {x.rule === "metal"
                      ? `Only one metal lock chip per deck — beyblade ${others.join(" and ")} has one too.`
                      : `${x.part} is also in beyblade ${others.join(" and ")}.`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn tone="primary" disabled={conflicts.length > 0} onClick={() => onSave(cleanDeck(combos))}>
          <Check size={15} />{conflicts.length ? "Fix the marked parts first" : "Save deck"}
        </Btn>
        <Btn tone="ghost" onClick={onClose}>Cancel</Btn>
      </div>
    </SheetFrame>,
    document.body,
  );
}

function PlayerSheet({ playerId, t, nameOf, allMatches, onClose, isAdmin, update, eventId }) {
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
        paddingTop: safeTop("13px"),
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <Blade color={col} h={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.05 }}>
            {nameOf(playerId)}<LinkMark t={t} id={playerId} size={16} />
          </div>
          {group && <div style={{ fontSize: 12, color: col }}>{group.name}</div>}
          {membersOf(t, playerId) && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>
              {membersOf(t, playerId).map((m, i) => {
                const pl = t.players.find((x) => x.id === playerId);
                const linked = pl && pl.memberIds && pl.memberIds[i];
                return (
                  <Fragment key={i}>
                    {i > 0 ? " · " : ""}{m}
                    {linked && <Link2 size={11} color={C.cyan} style={{ marginLeft: 3, verticalAlign: "-1px" }} />}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
        {isAdmin && update && <LinkPanel t={t} playerId={playerId} update={update} eventId={eventId} />}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(94px,1fr))", gap: 8, marginBottom: 22 }}>
          <Stat label="Played" value={st.played} />
          <Stat label="Won" value={st.wins} color={C.green} />
          <Stat label="Lost" value={st.losses} color={C.magenta} />
          <Stat label="Win margin" value={st.winMargin} color={C.cyan} />
          <Stat label="Points for" value={st.pf} />
          <Stat label="Against" value={st.pa} />
        </div>

        <DeckSection t={t} playerId={playerId} canEdit={!!(isAdmin && update)} update={update} />

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
                {r.sets.length > 0 && (
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>
                    {r.sets.map((x) => `${x.s1}–${x.s2}`).join("   ")}
                    {"   ·   "}
                    {r.sets.filter((x) => x.s1 > x.s2).length}–{r.sets.filter((x) => x.s2 > x.s1).length} in sets
                  </div>
                )}
                {r.sequence.length > 0 && (
                  <div style={{
                    display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10,
                    paddingTop: 10, borderTop: `1px solid ${C.line}66`,
                  }}>
                    {r.sequence.map((e, i) => {
                      const a = awardOf(e.type);
                      const col = e.mine ? C.green : C.magenta;
                      const opens = r.sets.length > 1 && (i === 0 || r.sequence[i - 1].set !== e.set);
                      return (
                        <Fragment key={i}>
                        {opens && (
                          <span style={{
                            flexBasis: "100%", fontSize: 11, color: C.muted,
                            marginTop: i === 0 ? 0 : 5,
                          }}>Set {e.set + 1}</span>
                        )}
                        <span style={{
                          fontSize: 11.5, padding: "3px 7px", borderRadius: 3,
                          background: `${col}16`, color: col, border: `1px solid ${col}44`,
                          borderStyle: e.type === PENALTY.key ? "dashed" : "solid", whiteSpace: "nowrap",
                        }}>
                          {i + 1}. {(a || { label: e.type }).label} +{e.pts}
                        </span>
                        </Fragment>
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

/*
 * The ranking, once confirmed, is kept in the tournament as it stood: the
 * rows, the weights behind them and the Swiss King. It is never worked out
 * again, so a result corrected later, or a weight nudged on another phone,
 * cannot quietly reorder a ranking already announced.
 */
const rankingSnapshot = (rows) => rows.map((r) => ({
  rank: r.rank, id: r.id, name: r.name, total: r.total, played: r.played, wins: r.wins,
  losses: r.losses, margin: r.margin, pf: r.pf, pa: r.pa, bonus: r.bonus,
}));

/** Whether a fresh ranking would come out differently from the saved one. */
const rankingMoved = (saved, fresh) =>
  JSON.stringify(saved.map((r) => [r.id, r.rank, r.total]))
  !== JSON.stringify(fresh.map((r) => [r.id, r.rank, r.total]));

function FinalStandingsSheet({ t, onClose, update }) {
  const [cfg, setCfg] = useState(loadScoring);
  const [ask, setAsk] = useState(null);   // "confirm" | "unlock"
  const [imaging, setImaging] = useState(false);
  const swipeBack = useSwipeBack(onClose);

  useEffect(() => {
    try { localStorage.setItem(SCORING_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  }, [cfg]);

  const saved = t.finalRanking || null;
  const stages = stagesFor(t.koSize, t.thirdPlace);
  const liveKings = useMemo(() => swissKings(t), [t]);
  const live = useMemo(() => finalStandings(t, saved ? saved.cfg : cfg), [t, cfg, saved]);

  // Confirmed: what was saved. Not yet: what the weights give right now.
  const rows = saved ? saved.rows : live;
  const kings = saved ? saved.kings : liveKings;
  const usedCfg = saved ? saved.cfg : cfg;
  const moved = !!saved && rankingMoved(saved.rows, live);

  const confirmRanking = () => {
    update((d) => {
      d.finalRanking = {
        confirmedAt: new Date().toISOString(),
        cfg: JSON.parse(JSON.stringify(cfg)),
        rows: rankingSnapshot(live),
        kings: liveKings.map((k) => ({ id: k.id, name: k.name, wins: k.wins, margin: k.margin })),
      };
      return d;
    });
    setAsk(null);
  };
  const unlockRanking = () => {
    // The weights it was confirmed with come back, so unlocking alone moves nobody.
    setCfg(saved.cfg);
    update((d) => { delete d.finalRanking; return d; });
    setAsk(null);
  };

  const setStage = (key, field, v) =>
    setCfg((c) => ({ ...c, stages: { ...c.stages, [key]: { ...c.stages[key], [field]: v } } }));

  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        paddingTop: safeTop("13px"),
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
        {saved && (
          <div style={{ ...card, borderColor: `${C.green}88`, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <Check size={17} color={C.green} />
              <div className="bx-d" style={{ fontSize: 17, fontWeight: 700 }}>Ranking confirmed</div>
            </div>
            <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5 }}>
              Saved {new Date(saved.confirmedAt).toLocaleString()}, with {num(usedCfg.perWin)} per win
              and {num(usedCfg.perMargin)} per margin point. It stays exactly as it is whatever
              changes later, until it is unlocked.
            </div>
            {moved && (
              <div style={{ color: C.gold, fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>
                Results have changed since it was confirmed, and ranking them now would come out
                differently. The saved ranking has not moved; unlock it to rank again.
              </div>
            )}
          </div>
        )}

        {!saved && (<>
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
        </>)}

        <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "26px 0 10px" }}>
          <Blade color={C.gold} h={18} />
          <h3 className="bx-d" style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>The ranking</h3>
          {!saved && (
            <Btn onClick={() => setCfg(defaultScoring())} tone="ghost"
              style={{ marginLeft: "auto", padding: "6px 10px", fontSize: 13 }}>Reset weights</Btn>
          )}
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
                    <td style={{ ...td, textAlign: "left", whiteSpace: "nowrap", fontWeight: r.rank <= 3 ? 600 : 400 }}>{r.name}<LinkMark t={t} id={r.id} /></td>
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

        {!saved && update && (
          <Btn tone="primary" disabled={rows.length === 0} onClick={() => setAsk("confirm")}
            style={{ width: "100%", justifyContent: "center", padding: 15, fontSize: 17, marginBottom: 10 }}>
            <Check size={18} />Confirm ranking
          </Btn>
        )}
        <Btn tone={saved ? "primary" : "default"} disabled={rows.length === 0}
          onClick={() => downloadCSV(`${slug(t.name)}-final-standings.csv`, buildFinalCSV(t, usedCfg, rows, kings))}
          style={{ width: "100%", justifyContent: "center", padding: 15, fontSize: 17 }}>
          <Download size={18} />Download the CSV
        </Btn>
        <Btn disabled={rows.length === 0} onClick={() => setImaging(true)}
          style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 15.5, marginTop: 10 }}>
          <ImageIcon size={17} />Ranking image for social media
        </Btn>
        {imaging && (
          <RankingImageSheet fileName={`${slug(t.name)}-ranking.png`} onClose={() => setImaging(false)}
            spec={{
              title: t.name,
              heading: saved ? "Final standings" : "Standings · not yet confirmed",
              meta: [
                saved ? `Confirmed ${new Date(saved.confirmedAt).toLocaleDateString()}` : null,
                `${rows.length} ${manyWord(t).toLowerCase()}`,
              ].filter(Boolean).join("  ·  "),
              bgUrl: t.bgUrl, logoUrl: t.logoUrl,
              columns: [
                { label: "Total", width: 140 }, { label: "P", width: 80 },
                { label: "W", width: 80 }, { label: "Margin", width: 130 },
              ],
              rows: rows.map((r) => ({
                rank: r.rank, name: r.name,
                cells: [Math.round(r.total * 100) / 100, r.played, r.wins, r.margin],
              })),
              note: kings && kings.length
                ? `${kings.length > 1 ? "Swiss Kings" : "Swiss King"}: ${kings.map((k) => k.name).join(", ")}`
                : null,
              site: location.host,
            }} />
        )}
        {saved && update && (
          <Btn tone="ghost" onClick={() => setAsk("unlock")}
            style={{ width: "100%", justifyContent: "center", padding: 12, fontSize: 14.5, marginTop: 10 }}>
            <Unlock size={15} />Unlock to change the ranking
          </Btn>
        )}

        {ask === "confirm" && (
          <Confirm
            title="Confirm this ranking?"
            body="It is saved exactly as shown, with these weights, and stays that way even if a result or a weight changes later. You can unlock it again if you need to."
            confirmLabel="Confirm ranking" tone="primary"
            onConfirm={confirmRanking} onClose={() => setAsk(null)} />
        )}
        {ask === "unlock" && (
          <Confirm
            title="Unlock the ranking?"
            body={moved
              ? "The confirmed ranking is removed. Results have changed since it was saved, so the ranking will come out differently once unlocked."
              : "The confirmed ranking is removed and the weights can be changed again. Nothing moves until you change something."}
            confirmLabel="Unlock" tone="danger"
            onConfirm={unlockRanking} onClose={() => setAsk(null)} />
        )}
        <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, lineHeight: 1.5, maxWidth: "58ch" }}>
          The file holds this ranking, the weights behind it, the Swiss King, and every
          match point by point — so nothing is lost when the tournament is cleared.
        </div>
      </div>
    </div>
  );
}

function SettingsSheet({ t, update, onClose, onReset, onReferees, canDelete, isOwner }) {
  const [confirm, setConfirm] = useState(false);
  const [askClear, setAskClear] = useState(false);
  const scored = scoredCount(t);
  const protect = protects(t);
  const selfKO = selfKOFor(t);

  /* Scores go, the shape of the tournament stays. The bracket goes too: it was
     seeded from standings that no longer exist, so it would be a fiction. */
  const clearResults = () => {
    update((d) => {
      d.groupMatches.forEach((m) => { m.events = []; m.done = false; m.sets = null; });
      d.bracket = null;
      return d;
    }, { what: "Resetting every result" });
    setAskClear(false);
  };

  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(t.bgUrl), overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        paddingTop: safeTop("13px"),
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

        <Field label="Self-KO"
          hint="Applies to matches scored from now on. Results already saved keep whatever they recorded.">
          <label style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={selfKO.enabled}
              onChange={(e) => update((d) => {
                d.selfKO = { ...selfKOFor(d), enabled: e.target.checked }; return d;
              })}
              style={{ width: 17, height: 17, accentColor: C.magenta }} />
            <span style={{ fontSize: 14.5 }}>Count a self-KO</span>
          </label>
          {selfKO.enabled && (
            <Segmented value={selfKO.pts}
              onChange={(v) => update((d) => { d.selfKO = { ...selfKOFor(d), pts: v }; return d; })}
              options={[{ value: 1, label: "Worth 1" }, { value: 2, label: "Worth 2" }]} />
          )}
        </Field>

        <Field label="Points to win a match"
          hint="Changing a stage target applies to matches scored from now on. Results already saved keep their scores.">
          <StagePoints koSize={t.koSize} thirdPlace={t.thirdPlace} points={t.points}
            onChange={(p) => update((d) => { d.points = p; return d; })}
            bestOf={t.bestOf} onBestOf={(b) => update((d) => { d.bestOf = b; return d; })} />
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
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Protect played matches</div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
            While this is on, nothing can wipe a saved result — not a redraw, a rebuilt
            bracket, or moving or removing a blader. Clear the matches in the way first: open
            each one, press Reset, and save it as not played.
            {!isOwner && " Only the host can switch this off."}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: isOwner ? "pointer" : "default" }}>
            <input type="checkbox" checked={protect} disabled={!isOwner}
              onChange={(e) => update((d) => { d.protectResults = e.target.checked; return d; })}
              style={{ width: 17, height: 17, accentColor: C.magenta }} />
            <span style={{ fontSize: 14.5 }}>Protect played matches</span>
          </label>
        </div>

        <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 26, paddingTop: 20 }}>
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Reset match results</div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
            {protect
              ? "Wiping every score at once is off while played matches are protected. Switch protection off above to use it, or clear the matches one at a time."
              : "Wipes every score but keeps the bladers and the groups. Do this before redrawing the groups"}
            {!protect && <> — {scored > 0
              ? `${scored} match${scored > 1 ? "es have" : " has"} been scored so far.`
              : "nothing has been scored yet."}</>}
          </div>
          <Btn onClick={() => setAskClear(true)} tone="danger" disabled={scored === 0 || protect}>
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
function AuthScreen({ onDone, onBack, startMode = "in" }) {
  const [mode, setMode] = useState(startMode);   // "in" | "up" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bladerName, setBladerName] = useState("");
  const [realName, setRealName] = useState("");
  const [msg, setMsg] = useState(null);     // { tone, text }
  const [busy, setBusy] = useState(false);

  // Says the same whether or not an account uses the address, so the form
  // cannot be used to find out who has signed up.
  const sendReset = async () => {
    if (busy) return;
    if (!email.trim()) { setMsg({ tone: C.magenta, text: "Enter the email you signed up with." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await sendPasswordReset(email);
    setBusy(false);
    if (error && /rate|seconds/i.test(error.message || "")) {
      setMsg({ tone: C.magenta, text: "A link was sent a moment ago. Wait a minute before asking for another." });
      return;
    }
    if (error) { setMsg({ tone: C.magenta, text: "The reset email could not be sent just now. Try again shortly." }); return; }
    setMsg({ tone: C.green, text: "If an account uses that address, a reset link is on its way. Check your spam folder too." });
  };

  const submit = async () => {
    if (mode === "forgot") return sendReset();
    if (busy || !email.trim() || !password) return;
    const bn = bladerName.trim(), rn = realName.trim();
    if (mode === "up") {
      const bad = !bn || !rn ? "Blader name and real name are both needed."
        : bn.length > 30 ? "Keep the blader name to 30 characters."
        : rn.length > 80 ? "Keep the real name to 80 characters."
        : null;
      if (bad) { setMsg({ tone: C.magenta, text: bad }); return; }
    }
    setBusy(true); setMsg(null);
    if (mode === "up") {
      // Checked here so the person can choose again now. The database is still
      // the one that refuses a taken name; this only says so sooner.
      const free = await bladerNameFree(bn);
      if (free === false) {
        setBusy(false);
        setMsg({ tone: C.magenta, text: `Somebody is already "${bn}". Pick another blader name.` });
        return;
      }
    }
    const { error } = mode === "in"
      ? await signIn(email, password)
      : await signUp(email, password, { bladerName: bn, realName: rn });
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
    <div className="bx" style={{
      ...shell, display: "grid", placeItems: "center", padding: 20, paddingTop: safeTop("20px"),
    }}>
      <Style />
      <div style={{ width: "100%", maxWidth: 380 }}>
        {onBack && (
          <button onClick={onBack} className="bx-d" style={{
            background: "none", border: "none", color: C.muted, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6, padding: "0 0 14px", fontSize: 13.5,
          }}>
            <ArrowLeft size={15} />All tournaments
          </button>
        )}
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
          {mode === "in" ? "Sign in" : mode === "up" ? "Sign up" : "Reset password"}
        </h1>
        {mode === "forgot" && (
          <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            Enter the email you signed up with and we will send a link to choose a new password.
          </div>
        )}

        {mode === "up" && (
          <>
            <input
              style={{ ...inputStyle, marginBottom: 10 }} autoComplete="nickname" maxLength={30}
              value={bladerName} onChange={(e) => { setBladerName(e.target.value); setMsg(null); }}
              placeholder="Blader name"
            />
            <input
              style={{ ...inputStyle, marginBottom: 6 }} autoComplete="name" maxLength={80}
              value={realName} onChange={(e) => { setRealName(e.target.value); setMsg(null); }}
              placeholder="Real name"
            />
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.45 }}>
              Your blader name is public. Your real name is only shown to organisers.
            </div>
          </>
        )}
        <input
          style={{ ...inputStyle, marginBottom: 10 }} type="email" autoComplete="username"
          value={email} onChange={(e) => { setEmail(e.target.value); setMsg(null); }}
          onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Email"
        />
        {mode !== "forgot" && (
          <input
            style={inputStyle} type="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={password} onChange={(e) => { setPassword(e.target.value); setMsg(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Password"
          />
        )}
        {mode === "in" && (
          <div style={{ textAlign: "right", marginTop: 8 }}>
            <button onClick={() => { setMode("forgot"); setMsg(null); }}
              style={{ background: "none", border: "none", color: C.cyan, cursor: "pointer", fontSize: 13, padding: 0 }}>
              Forgot your password?
            </button>
          </div>
        )}
        {msg && (
          <div style={{ color: msg.tone, fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>{msg.text}</div>
        )}

        <Btn onClick={submit} tone="primary" disabled={busy}
          style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 17, marginTop: 16 }}>
          {busy ? "Working…" : mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Send reset link"}
        </Btn>

        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13.5 }}>
            {mode === "in" ? "No account yet? Sign up" : mode === "up" ? "Already have an account? Sign in" : "Back to sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * Where a password-reset link lands. The link has already signed the person
 * in by the time this shows, so all that is left is the new password. A link
 * that has expired or been used arrives with no session, and says so.
 */
function ResetPasswordScreen({ session, failure, onDone, onRequestNew }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const save = async () => {
    if (busy) return;
    const bad = pw.length < 6 ? "Use at least 6 characters."
      : pw !== again ? "The two passwords are not the same."
      : null;
    if (bad) { setMsg(bad); return; }
    setBusy(true); setMsg(null);
    const { error } = await setPassword(pw);
    setBusy(false);
    if (error) {
      setMsg(/different from the old/i.test(error.message || "")
        ? "That is your current password. Choose a different one."
        : error.message || "The password could not be changed.");
      return;
    }
    setDone(true);
  };

  const frame = (body) => (
    <div className="bx" style={{ ...shell, display: "grid", placeItems: "center", padding: 20, paddingTop: safeTop("20px") }}>
      <Style />
      <div style={{ width: "100%", maxWidth: 380 }}>
        <h1 className="bx-d" style={{
          fontSize: 40, fontWeight: 800, margin: "0 0 14px", lineHeight: .95,
          background: `linear-gradient(100deg, ${C.magenta} 0%, #FFFFFF 48%, ${C.cyan} 100%)`,
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
        }}>New password</h1>
        {body}
      </div>
    </div>
  );

  if (session === undefined) return frame(<div style={{ color: C.muted }}>Checking your link…</div>);

  if (!session) {
    return frame(
      <>
        <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 16 }}>
          This reset link has expired or has already been used.
          {failure ? <span style={{ color: C.muted }}> ({failure})</span> : null}
        </div>
        <Btn tone="primary" onClick={onRequestNew}
          style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 16 }}>
          Send a new link
        </Btn>
      </>
    );
  }

  if (done) {
    return frame(
      <>
        <div style={{ fontSize: 14.5, lineHeight: 1.55, marginBottom: 16, color: C.green }}>
          Your password has been changed, and you are signed in.
        </div>
        <Btn tone="primary" onClick={onDone}
          style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 16 }}>
          Continue
        </Btn>
      </>
    );
  }

  return frame(
    <>
      <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
        Choose a new password for {session.user.email}.
      </div>
      <input style={{ ...inputStyle, marginBottom: 10 }} type="password" autoComplete="new-password"
        value={pw} onChange={(e) => { setPw(e.target.value); setMsg(null); }} placeholder="New password" />
      <input style={inputStyle} type="password" autoComplete="new-password"
        value={again} onChange={(e) => { setAgain(e.target.value); setMsg(null); }}
        onKeyDown={(e) => e.key === "Enter" && save()} placeholder="New password again" />
      {msg && <div style={{ color: C.magenta, fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>{msg}</div>}
      <Btn tone="primary" onClick={save} disabled={busy}
        style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 17, marginTop: 16 }}>
        {busy ? "Saving…" : "Set new password"}
      </Btn>
    </>
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

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st. */
function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/**
 * Setting one knockout round by hand.
 *
 * The opening round is set by name: who plays whom. Every round after it is
 * set by where its players come from — which earlier match's winner fills
 * each slot — because those players are not known until the round before is
 * played. A semi-final arranged before the quarter-finals is necessarily an
 * arrangement of winners, not of people, and stays right whoever wins.
 *
 * Picking something already placed elsewhere swaps the two, so nobody can be
 * in two matches at once and no earlier match can be left feeding nothing.
 */
function BracketEditor({ t, round, nameOf, protect, onClose, onSave }) {
  const b = t.bracket;
  const ms = b.rounds[round];
  const opening = round === 0;
  const prev = opening ? null : b.rounds[round - 1];
  const name = roundName(ms.length * 2);

  const [pairs, setPairs] = useState(() => (opening
    ? ms.map((m) => [m.p1 || null, m.p2 || null])
    : feedFor(b, round).map((f) => [...f])));

  const place = (i, k, v) => setPairs((cur) => {
    const next = cur.map((p) => [...p]);
    const was = next[i][k];
    if (v !== null) {
      next.forEach((p, a) => p.forEach((x, c) => {
        if ((a !== i || c !== k) && x === v) next[a][c] = was;
      }));
    }
    next[i][k] = v;
    return next;
  });

  /*
   * Only who came through the group stage can be placed, each with where they
   * finished, listed group by group so the draw can be read straight off it.
   *
   * Anyone already sitting in this round who is not a qualifier — standings
   * shifted after the bracket was built, say — is kept on the list and
   * flagged, so the match still shows who is in it rather than going blank.
   */
  const choices = (() => {
    const quals = collectQualifiers(t.groups, t.groupMatches, t.advance, nameOf, t.tieBreaks);
    const order = (id) => t.groups.findIndex((g) => g.id === id);
    const out = quals
      .slice()
      .sort((x, y) => order(x.groupId) - order(y.groupId) || x.placement - y.placement)
      .map((q) => {
        const g = t.groups.find((x) => x.id === q.groupId);
        return { value: q.id, label: `${nameOf(q.id)} — ${g ? g.name : "Group"} ${ordinal(q.placement)}` };
      });
    ms.flatMap((m) => [m.p1, m.p2]).filter(Boolean).forEach((id) => {
      if (!out.some((o) => o.value === id)) {
        out.push({ value: id, label: `${nameOf(id)} — not a qualifier` });
      }
    });
    return out;
  })();

  const describe = (m) => {
    const w = winnerOf(m);
    if (w) return ` — ${nameOf(w)}`;
    if (m.p1 && m.p2) return ` — ${nameOf(m.p1)} v ${nameOf(m.p2)}`;
    if (m.p1 || m.p2) return ` — ${nameOf(m.p1 || m.p2)}`;
    return "";
  };

  // Results that saving would throw away.
  const current = opening ? null : feedFor(b, round);
  const changed = ms.map((m, i) => (opening
    ? (m.p1 || null) !== pairs[i][0] || (m.p2 || null) !== pairs[i][1]
    : JSON.stringify(current[i]) !== JSON.stringify(pairs[i])));
  const losing = ms.map((m, i) => (changed[i] && (m.events || []).length ? `M${i + 1}` : null)).filter(Boolean);

  const original = opening ? ms.flatMap((m) => [m.p1, m.p2]).filter(Boolean) : [];
  const placed = opening ? pairs.flat().filter(Boolean) : [];
  const dropped = original.filter((id) => !placed.includes(id));

  const plain = !opening && JSON.stringify(pairs) === JSON.stringify(defaultFeed(ms.length));
  const nothing = !changed.some(Boolean);
  // With played matches protected, everything this would wipe, down the bracket.
  const inTheWay = protect && !nothing
    ? lostResults(t, { ...t, bracket: setRound(b, round, pairs) }).map((m) => matchLabel(t, m, nameOf))
        .sort((x, y) => y.order - x.order)
    : [];

  const pick = (value, onChange, options) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, padding: "10px 10px", fontSize: 14.5 }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <SheetFrame title={`${name} matchups`} onClose={onClose}>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 16, maxWidth: "58ch" }}>
        {opening
          ? "Choose who plays whom from those who came through the groups. Picking someone already in another match swaps the two of them."
          : `Choose which ${roundName(prev.length * 2).toLowerCase()} winner fills each place. Picking one already used elsewhere swaps them, so every match still feeds exactly one place.`}
      </div>

      {pairs.map((pr, i) => (
        <div key={i} style={{
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3,
          padding: "11px 12px", marginBottom: 8,
        }}>
          <div className="bx-d" style={{ fontSize: 13, color: C.muted, marginBottom: 7 }}>
            M{i + 1}{(ms[i].events || []).length ? " · has a result" : ""}
          </div>
          {[0, 1].map((k) => (
            <div key={k}>
              {k === 1 && (
                <div className="bx-d" style={{ textAlign: "center", color: C.muted, fontSize: 13, margin: "4px 0" }}>v</div>
              )}
              {opening
                ? pick(pr[k] || "", (v) => place(i, k, v || null), [
                    { value: "", label: "— empty (bye) —" },
                    ...choices,
                  ])
                : pick(String(pr[k]), (v) => place(i, k, Number(v)),
                    prev.map((m, x) => ({ value: String(x), label: `Winner of M${x + 1}${describe(m)}` })))}
            </div>
          ))}
        </div>
      ))}

      {dropped.length > 0 && (
        <div style={{ fontSize: 13, color: C.gold, margin: "10px 0", lineHeight: 1.5 }}>
          No longer in the bracket: {dropped.map(nameOf).join(", ")}.
        </div>
      )}
      {inTheWay.length > 0 ? (
        <div style={{ fontSize: 13, color: C.magenta, margin: "10px 0", lineHeight: 1.5 }}>
          Played matches are protected, so {inTheWay.length > 1 ? "these need" : "this needs"} clearing
          first — open {inTheWay.length > 1 ? "each" : "it"}, press Reset and save it as not played,
          from the top down: {inTheWay.map((x) => `${x.where} (${x.who}, ${x.score})`).join("; ")}.
        </div>
      ) : !protect && losing.length > 0 && (
        <div style={{ fontSize: 13, color: C.magenta, margin: "10px 0", lineHeight: 1.5 }}>
          Saving clears the result of {losing.join(", ")}, and of anything {losing.length > 1 ? "they" : "it"} fed into.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <Btn onClick={() => onSave(pairs)} tone="primary" disabled={nothing || inTheWay.length > 0}>
          <Check size={15} />Save matchups
        </Btn>
        {!opening && !plain && (
          <Btn onClick={() => setPairs(defaultFeed(ms.length))}>Back to the default</Btn>
        )}
        <Btn onClick={onClose} tone="ghost">Cancel</Btn>
      </div>
    </SheetFrame>
  );
}

/**
 * A ranking as a picture to post. Made when the sheet opens, then shown, so
 * the Share tap that follows is a fresh one — phones only allow sharing
 * straight from a tap, not after waiting on the picture to be drawn. Share
 * sends it to Instagram, WhatsApp or Photos; Download saves the file; and on
 * any phone, pressing and holding the picture saves it too.
 */
function RankingImageSheet({ spec, fileName, onClose }) {
  const [blob, setBlob] = useState(null);
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let gone = false, made = null;
    renderRankingImage(spec).then((b) => {
      if (gone) return;
      made = URL.createObjectURL(b);
      setBlob(b); setUrl(made);
    }).catch((e) => { if (!gone) setErr(e.message || "The image could not be made."); });
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, []);

  const file = blob ? new File([blob], fileName, { type: "image/png" }) : null;
  const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));

  const share = async () => {
    try { await navigator.share({ files: [file], title: spec.title }); }
    catch (e) { if (e && e.name !== "AbortError") setErr("Sharing did not work here. Use Download instead."); }
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
  };

  return createPortal(
    <SheetFrame title="Ranking image" onClose={onClose}>
      {!url && !err && <div style={{ color: C.muted, fontSize: 14 }}>Drawing the image…</div>}
      {err && <div style={{ color: C.magenta, fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {url && (
        <>
          <img src={url} alt={`${spec.title} ranking`} style={{
            width: "100%", display: "block", borderRadius: 4, border: `1px solid ${C.line}`, marginBottom: 14,
          }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canShare && (
              <Btn tone="primary" onClick={share} style={{ flex: 1, justifyContent: "center", padding: 13 }}>
                <Download size={16} />Share
              </Btn>
            )}
            <Btn tone={canShare ? "default" : "primary"} onClick={download}
              style={{ flex: 1, justifyContent: "center", padding: 13 }}>
              <Download size={16} />Download PNG
            </Btn>
          </div>
          <div style={{ color: C.muted, fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
            On a phone you can also press and hold the image to save it to your photos.
          </div>
        </>
      )}
    </SheetFrame>,
    document.body,
  );
}

/* ================================================================== */
/*  Series                                                             */
/* ================================================================== */

/**
 * The series a tournament is in, shown to anyone. Its host also gets the way
 * to link it to an earlier tournament, and sees what is still waiting on
 * somebody's agreement, with the buttons for whatever is theirs to decide.
 */
function SeriesCard({ eventId, eventName, isOwner, meId }) {
  const [rows, setRows] = useState(undefined);
  const [owners, setOwners] = useState({});
  const [linking, setLinking] = useState(false);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = () => seriesOfEvents([eventId]).then(async (r) => {
    setRows(r);
    if (r) setOwners(await bladerNames(r.map((x) => x.series && x.series.owner_id)));
  });
  useEffect(() => { if (eventId) load(); }, [eventId]);

  if (!rows) return null;
  const live = rows.filter((r) => r.series && r.owner_ok && r.host_ok);
  const waiting = rows.filter((r) => r.series && !(r.owner_ok && r.host_ok));
  if (!live.length && !isOwner) return null;

  const act = async (fn) => {
    setMsg(null);
    const { error } = await fn();
    if (error) setMsg(error.message || "That did not go through.");
    load();
  };

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Trophy size={17} color={C.gold} />
        <div className="bx-d" style={{ fontSize: 19, fontWeight: 700 }}>Series</div>
      </div>

      {live.length === 0 && (
        <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 12, maxWidth: "58ch" }}>
          Link this tournament to an earlier one to rank them together — a saga, or a lifetime
          ranking across a whole series. Each tournament counts once its final ranking is confirmed.
        </div>
      )}

      {live.map((r) => (
        <div key={r.series_id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>{r.series.name}</div>
            <div style={{ fontSize: 12, color: C.muted }}>Run by {owners[r.series.owner_id] || "an organiser"}</div>
          </div>
          <Btn tone="primary" style={{ padding: "7px 11px", fontSize: 13.5 }} onClick={() => setOpen(r.series_id)}>
            Grand total
          </Btn>
        </div>
      ))}

      {isOwner && waiting.map((r) => {
        const mineToGive = (!r.host_ok) || (!r.owner_ok && r.series.owner_id === meId);
        return (
          <div key={r.series_id} style={{
            background: C.base, border: `1px solid ${C.gold}55`, borderRadius: 3, padding: "9px 11px", marginBottom: 8,
          }}>
            <div style={{ fontSize: 14 }}><strong>{r.series.name}</strong></div>
            <div style={{ fontSize: 12.5, color: C.muted, margin: "2px 0 8px" }}>
              {mineToGive
                ? `${owners[r.series.owner_id] || "Its organiser"} wants to add this tournament.`
                : `Waiting for ${owners[r.series.owner_id] || "the series' organiser"} to approve.`}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {mineToGive && (
                <Btn tone="primary" style={{ padding: "6px 10px", fontSize: 13 }}
                  onClick={() => act(() => linkToSeries(r.series_id, eventId))}>
                  <Check size={14} />Approve
                </Btn>
              )}
              <Btn tone="ghost" style={{ padding: "6px 10px", fontSize: 13 }}
                onClick={() => act(() => removeFromSeries(r.series_id, eventId))}>
                {mineToGive ? "Decline" : "Withdraw"}
              </Btn>
            </div>
          </div>
        );
      })}

      {isOwner && (
        <Btn tone="ghost" onClick={() => setLinking(true)} style={{ marginTop: 4 }}>
          <Link2 size={15} />Link to a previous tournament
        </Btn>
      )}
      {msg && <div style={{ color: C.magenta, fontSize: 13, marginTop: 8 }}>{msg}</div>}

      {linking && (
        <LinkTournamentSheet eventId={eventId} eventName={eventName}
          onClose={() => setLinking(false)} onDone={load} />
      )}
      {open && <SeriesSheet seriesId={open} meId={meId} onClose={() => { setOpen(null); load(); }} />}
    </div>
  );
}

/**
 * Choosing the earlier tournament. Joining a series it is already in, or
 * starting a new series with the two of them. If either belongs to another
 * organiser, it waits for their agreement and says so.
 */
function LinkTournamentSheet({ eventId, eventName, onClose, onDone }) {
  const [events, setEvents] = useState(undefined);
  const [hosts, setHosts] = useState({});
  const [inSeries, setInSeries] = useState({});
  const [q, setQ] = useState("");
  const [target, setTarget] = useState(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    (async () => {
      const evs = await everyEvent();
      if (!evs) { setEvents(null); return; }
      const others = evs.filter((e) => e.id !== eventId);
      setEvents(others);
      setHosts(await bladerNames(others.map((e) => e.owner_id)));
      const mem = (await seriesOfEvents(others.map((e) => e.id))) || [];
      const by = {};
      mem.filter((m) => m.series && m.owner_ok && m.host_ok).forEach((m) => {
        if (!by[m.event_id]) by[m.event_id] = [];
        by[m.event_id].push(m.series);
      });
      setInSeries(by);
    })();
  }, [eventId]);

  const pick = (e) => { setTarget(e); setNewName(`${e.name} Series`); setMsg(null); };

  const finish = (text) => { setBusy(false); setMsg({ ok: true, text }); onDone(); };
  const fail = (error) => { setBusy(false); setMsg({ ok: false, text: error.message || "That did not go through." }); };

  const join = async (sr) => {
    setBusy(true); setMsg(null);
    const r = await linkToSeries(sr.id, eventId);
    if (r.error) return fail(r.error);
    finish(r.status === "approved"
      ? `Linked. ${eventName} is now in ${sr.name}.`
      : `Asked. ${eventName} joins ${sr.name} once its organiser approves.`);
  };

  const start = async () => {
    const name = newName.trim();
    if (!name) { setMsg({ ok: false, text: "Give the series a name." }); return; }
    if (name.length > 80) { setMsg({ ok: false, text: "Keep the name to 80 characters." }); return; }
    setBusy(true); setMsg(null);
    const made = await startSeries(name);
    if (made.error) return fail(made.error);
    const theirs = await linkToSeries(made.series.id, target.id);
    if (theirs.error) return fail(theirs.error);
    const ours = await linkToSeries(made.series.id, eventId);
    if (ours.error) return fail(ours.error);
    finish(theirs.status === "approved"
      ? `Started ${name} with both tournaments.`
      : `Started ${name}. ${hosts[target.owner_id] || "Its organiser"} needs to approve adding ${target.name}; a request is waiting for them.`);
  };

  const needle = q.trim().toLowerCase();
  const shown = (events || []).filter((e) => !needle
    || e.name.toLowerCase().includes(needle)
    || (hosts[e.owner_id] || "").toLowerCase().includes(needle));

  return createPortal(
    <SheetFrame title="Link to a tournament" onClose={onClose}>
      {target ? (
        <>
          <button onClick={() => { setTarget(null); setMsg(null); }} style={{
            background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13.5,
            display: "flex", alignItems: "center", gap: 6, padding: "0 0 12px",
          }}><ArrowLeft size={15} />Choose another</button>

          <div style={{ ...card, marginBottom: 14 }}>
            <div className="bx-d" style={{ fontSize: 18, fontWeight: 700 }}>{target.name}</div>
            <div style={{ fontSize: 12.5, color: C.muted }}>
              {hosts[target.owner_id] || "Organiser"} · {new Date(target.created_at).toLocaleDateString()}
            </div>
          </div>

          {msg && (
            <div style={{ color: msg.ok ? C.green : C.magenta, fontSize: 13.5, lineHeight: 1.5, marginBottom: 14 }}>
              {msg.text}
            </div>
          )}

          {!(msg && msg.ok) && (
            <>
              {(inSeries[target.id] || []).length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div className="bx-d" style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Join a series it is in</div>
                  {inSeries[target.id].map((sr) => (
                    <Btn key={sr.id} disabled={busy} onClick={() => join(sr)}
                      style={{ width: "100%", justifyContent: "flex-start", marginBottom: 6 }}>
                      <Link2 size={15} />{sr.name}
                    </Btn>
                  ))}
                </div>
              )}
              <div className="bx-d" style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                {(inSeries[target.id] || []).length ? "Or start a new series with both" : "Start a series with both"}
              </div>
              <input style={{ ...inputStyle, marginBottom: 8 }} maxLength={80} value={newName}
                onChange={(e) => setNewName(e.target.value)} placeholder="Series name" />
              <Btn tone="primary" disabled={busy} onClick={start}>
                <Check size={15} />{busy ? "Linking…" : "Start series"}
              </Btn>
            </>
          )}
          {msg && msg.ok && <Btn tone="primary" onClick={onClose}>Done</Btn>}
        </>
      ) : (
        <>
          <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 14, maxWidth: "58ch" }}>
            Choose the earlier tournament. If it belongs to another organiser, they are asked to
            approve before the two are ranked together.
          </div>
          <div style={{ position: "relative", marginBottom: 14 }}>
            <Search size={15} color={C.muted} style={{ position: "absolute", left: 12, top: 13 }} />
            <input style={{ ...inputStyle, paddingLeft: 34 }} value={q}
              placeholder="Search tournaments or organisers" onChange={(e) => setQ(e.target.value)} />
          </div>
          {events === undefined ? (
            <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
          ) : events === null ? (
            <div style={{ color: C.muted, fontSize: 14 }}>Tournaments could not be loaded.</div>
          ) : shown.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 14 }}>No tournament by that name.</div>
          ) : shown.map((e) => (
            <button key={e.id} onClick={() => pick(e)} style={{
              width: "100%", textAlign: "left", display: "block", cursor: "pointer", color: C.ink,
              background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3, padding: "10px 12px", marginBottom: 6,
            }}>
              <div className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>{e.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                {hosts[e.owner_id] || "Organiser"} · {new Date(e.created_at).toLocaleDateString()}
                {e.archived ? " · archived" : ""}
                {(inSeries[e.id] || []).length ? ` · in ${inSeries[e.id].map((x) => x.name).join(", ")}` : ""}
              </div>
            </button>
          ))}
        </>
      )}
    </SheetFrame>,
    document.body,
  );
}

/**
 * A series' grand total: every tournament's confirmed ranking added up,
 * blader by blader. Tournaments without a confirmed ranking are listed as
 * waiting rather than counted on whatever their results say today.
 */
function SeriesSheet({ seriesId, meId, onClose }) {
  const [sr, setSr] = useState(undefined);
  const [imaging, setImaging] = useState(false);
  const [evs, setEvs] = useState(undefined);
  const [names, setNames] = useState({});
  const [ask, setAsk] = useState(null);   // { kind: "remove", event } | { kind: "delete" }

  const load = async () => {
    const one = await loadSeries(seriesId);
    setSr(one);
    const list = await seriesEvents(seriesId);
    setEvs(list);
    if (list) setNames(await bladerNames([...(list.map((e) => e.owner_id)), one && one.owner_id]));
  };
  useEffect(() => { load(); }, [seriesId]);

  const ranking = useMemo(() => (evs ? seriesRanking(evs.filter((e) => e.approved)) : null), [evs]);
  const owner = sr && meId && sr.owner_id === meId;

  const remove = async (e) => {
    setAsk(null);
    await removeFromSeries(seriesId, e.id);
    load();
  };
  const destroy = async () => {
    setAsk(null);
    await deleteSeries(seriesId);
    onClose();
  };

  const counted = ranking ? new Set(ranking.counted.map((e) => e.id)) : new Set();

  return createPortal(
    <SheetFrame title={sr ? sr.name : "Series"} onClose={onClose}>
      {sr === undefined || evs === undefined ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : !sr || !evs ? (
        <div style={{ color: C.muted, fontSize: 14 }}>This series could not be loaded.</div>
      ) : (
        <>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 16, lineHeight: 1.5 }}>
            Run by {names[sr.owner_id] || "an organiser"} · {ranking.counted.length} tournament
            {ranking.counted.length === 1 ? "" : "s"} counted
            {ranking.waiting.length ? ` · ${ranking.waiting.length} waiting for a confirmed ranking` : ""}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
            <Blade color={C.gold} h={18} />
            <h3 className="bx-d" style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Grand total</h3>
          </div>

          {ranking.rows.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 18, lineHeight: 1.5 }}>
              Nothing counted yet. A tournament counts once its final ranking is confirmed.
            </div>
          ) : (
            <div style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ color: C.muted, fontSize: 12 }}>
                      {["", "Blader", "Total", "T", "W", "Best"].map((h, i) => (
                        <th key={i} style={{
                          textAlign: i === 1 ? "left" : i === 0 ? "center" : "right",
                          padding: "8px 10px", fontWeight: 600, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.rows.map((r) => (
                      <tr key={r.key}>
                        <td style={{ ...td, textAlign: "center", width: 28, fontWeight: 800, color: r.rank <= 3 ? C.gold : C.muted }}>{r.rank}</td>
                        <td style={{ ...td, textAlign: "left", whiteSpace: "nowrap", fontWeight: r.rank <= 3 ? 600 : 400 }}>
                          {r.name}{r.byName ? <span style={{ color: C.muted }}> *</span> : null}
                        </td>
                        <td style={{ ...td, color: C.cyan, fontWeight: 800 }}>{r.total}</td>
                        <td style={td}>{r.tournaments}</td>
                        <td style={td}>{r.wins}</td>
                        <td style={{ ...td, color: C.muted }}>{Number.isFinite(r.best) ? ordinal(r.best) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {ranking.rows.length > 0 && (
            <Btn onClick={() => setImaging(true)} style={{ width: "100%", justifyContent: "center", padding: 13, marginBottom: 10 }}>
              <ImageIcon size={17} />Ranking image for social media
            </Btn>
          )}
          {imaging && (() => {
            // The newest counted tournament lends the series its look.
            const face = ranking.counted.slice().reverse()
              .find((e) => e.data && (e.data.bgUrl || e.data.logoUrl));
            return (
              <RankingImageSheet fileName={`${slug(sr.name)}-grand-total.png`} onClose={() => setImaging(false)}
                spec={{
                  title: sr.name,
                  heading: "Grand total",
                  meta: `${ranking.counted.length} tournament${ranking.counted.length === 1 ? "" : "s"}  ·  Run by ${names[sr.owner_id] || "the organiser"}`,
                  bgUrl: face ? face.data.bgUrl : null, logoUrl: face ? face.data.logoUrl : null,
                  columns: [
                    { label: "Total", width: 140 }, { label: "T", width: 80 },
                    { label: "W", width: 80 }, { label: "Best", width: 120 },
                  ],
                  rows: ranking.rows.map((r) => ({
                    rank: r.rank, name: r.name,
                    cells: [r.total, r.tournaments, r.wins, Number.isFinite(r.best) ? ordinal(r.best) : "—"],
                  })),
                  note: null,
                  site: location.host,
                }} />
            );
          })()}
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 22, maxWidth: "60ch" }}>
            Each tournament's confirmed totals, added together. T is tournaments played; Best is the
            highest finish.
            {ranking.rows.some((r) => r.byName) && " * has no linked profile, so is matched across tournaments by name."}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
            <Blade color={C.cyan} h={16} />
            <h3 className="bx-d" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Tournaments</h3>
          </div>
          {evs.map((e) => {
            const canRemove = meId && (meId === sr.owner_id || meId === e.owner_id);
            const state = !e.approved
              ? (e.owner_ok ? "waiting for its organiser to approve" : "waiting for the series' organiser to approve")
              : counted.has(e.id) ? "counted" : "ranking not confirmed yet";
            if (!e.approved && !canRemove) return null;
            return (
              <div key={e.id} style={{
                display: "flex", alignItems: "center", gap: 10, background: C.surface,
                border: `1px solid ${C.line}`, borderLeft: `3px solid ${state === "counted" ? C.green : C.gold}`,
                borderRadius: 3, padding: "9px 12px", marginBottom: 6,
              }}>
                <a href={`/?t=${e.id}`} style={{ flex: 1, minWidth: 0, color: C.ink, textDecoration: "none" }}>
                  <div className="bx-d" style={{ fontSize: 15.5, fontWeight: 700 }}>{e.name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {names[e.owner_id] || "Organiser"} · {new Date(e.created_at).toLocaleDateString()} · {state}
                  </div>
                </a>
                {canRemove && (
                  <button onClick={() => setAsk({ kind: "remove", event: e })} aria-label="Remove from series"
                    style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}

          {owner && (
            <Btn tone="danger" style={{ marginTop: 16 }} onClick={() => setAsk({ kind: "delete" })}>
              <Trash2 size={15} />Delete series
            </Btn>
          )}
        </>
      )}

      {ask && ask.kind === "remove" && (
        <Confirm title="Take this tournament out?"
          body={`${ask.event.name} stops counting towards ${sr.name}. The tournament itself, and its confirmed ranking, are not touched.`}
          confirmLabel="Take it out" tone="danger"
          onConfirm={() => remove(ask.event)} onClose={() => setAsk(null)} />
      )}
      {ask && ask.kind === "delete" && (
        <Confirm title="Delete this series?"
          body="The grand total goes. Every tournament in it, and each one's confirmed ranking, stays exactly as it is."
          confirmLabel="Delete series" tone="danger"
          onConfirm={destroy} onClose={() => setAsk(null)} />
      )}
    </SheetFrame>,
    document.body,
  );
}

/** Series requests waiting on this account, on the tournament list. */
function SeriesRequests() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(null);
  const load = () => seriesRequests().then(setRows);
  useEffect(() => { load(); }, []);
  if (!rows.length) return null;

  const decide = async (r, yes) => {
    setBusy(`${r.series_id}:${r.event_id}`);
    if (yes) await linkToSeries(r.series_id, r.event_id);
    else await removeFromSeries(r.series_id, r.event_id);
    setBusy(null);
    load();
  };

  return (
    <div style={{ ...card, borderColor: `${C.gold}88`, marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Trophy size={16} color={C.gold} />
        <div className="bx-d" style={{ fontSize: 17, fontWeight: 700 }}>Series requests</div>
        <span style={{ fontSize: 12, color: C.muted }}>{rows.length}</span>
      </div>
      {rows.map((r) => {
        const key = `${r.series_id}:${r.event_id}`;
        return (
          <div key={key} style={{ borderTop: `1px solid ${C.line}66`, padding: "10px 0" }}>
            <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 8 }}>
              {r.asks === "series"
                ? <><strong>{r.event_host}</strong> wants <strong>{r.event_name}</strong> ranked in your series <strong>{r.series_name}</strong>.</>
                : <><strong>{r.series_owner}</strong> wants your tournament <strong>{r.event_name}</strong> ranked in their series <strong>{r.series_name}</strong>.</>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn tone="primary" disabled={busy === key} style={{ padding: "6px 11px", fontSize: 13.5 }}
                onClick={() => decide(r, true)}><Check size={14} />Approve</Btn>
              <Btn tone="ghost" disabled={busy === key} style={{ padding: "6px 11px", fontSize: 13.5 }}
                onClick={() => decide(r, false)}>Decline</Btn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SheetFrame({ title, onClose, children }) {
  const swipeBack = useSwipeBack(onClose);
  return (
    <div className="bx" {...swipeBack} style={{
      position: "fixed", inset: 0, zIndex: 60, ...arenaStyle(null), overflowY: "auto",
      // Set here, not inherited: opened from the tournament list, a sheet sits
      // outside anything that sets the text colour and would draw in black.
      color: C.ink,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        paddingTop: safeTop("13px"),
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
  const [picking, setPicking] = useState(false);

  // Chosen from the list: the owner, and anyone already a referee, are greyed out.
  const pick = async (b) => {
    setPicking(false); setBusy(true); setMsg(null);
    const { error } = await addRefereeById(event.id, b.id);
    setBusy(false);
    if (error) { setMsg({ tone: C.magenta, text: error.message }); return; }
    setMsg({ tone: C.green, text: `${b.blader_name} can now run this tournament.` });
    refresh();
  };

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
        hint="Choose anyone who has signed up, or type the address they signed up with. Being a referee needs no approval.">
        <Btn tone="primary" disabled={busy} onClick={() => setPicking(true)}
          style={{ width: "100%", justifyContent: "center", marginBottom: 10 }}>
          <Users size={16} />Choose from registered bladers
        </Btn>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={inputStyle} type="email" value={email} placeholder="their@email.com"
            onChange={(e) => { setEmail(e.target.value); setMsg(null); }}
            onKeyDown={(e) => e.key === "Enter" && add()} />
          <Btn onClick={add} disabled={busy} style={{ flexShrink: 0 }}>
            <Plus size={16} />Add
          </Btn>
        </div>
        {msg && <div style={{ color: msg.tone, fontSize: 13, marginTop: 9, lineHeight: 1.5 }}>{msg.text}</div>}
        {picking && (
          <BladerPicker title="Choose a referee" takenLabel="already has access"
            taken={new Set([event.owner_id, ...(rows || []).map((r) => r.userId)])}
            onPick={pick} onClose={() => setPicking(false)} />
        )}
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

/* ================================================================== */
/*  Bladers                                                            */
/* ================================================================== */

/** A profile photo, or the blader's initials where there is none. */
function Avatar({ path, src, name, size = 40 }) {
  const url = src || avatarUrl(path);
  const [broken, setBroken] = useState(false);
  const initials = (name || "?").trim().split(" ").filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join("").toUpperCase() || "?";
  const ring = {
    width: size, height: size, borderRadius: "50%", flexShrink: 0,
    border: `1px solid ${C.line}`, overflow: "hidden", background: C.raised,
  };
  if (url && !broken) {
    return <img src={url} alt="" onError={() => setBroken(true)} style={{ ...ring, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div className="bx-d" style={{
      ...ring, display: "grid", placeItems: "center", color: C.cyan,
      fontSize: Math.round(size * 0.38), fontWeight: 800,
    }}>{initials}</div>
  );
}

const yearsText = (y) => {
  if (y === null || y === undefined || y === "") return null;
  const v = Number(y);
  return `${v} year${v === 1 ? "" : "s"}`;
};

/** Everyone registered, searchable by blader name. Public. */
function BladersSheet({ onOpen, onClose }) {
  const [rows, setRows] = useState(undefined);
  const [q, setQ] = useState("");
  useEffect(() => { listBladers().then(setRows); }, []);

  const shown = (rows || []).filter((r) =>
    r.blader_name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <SheetFrame title="Bladers" onClose={onClose}>
      <div style={{ position: "relative", marginBottom: 14 }}>
        <Search size={15} color={C.muted} style={{ position: "absolute", left: 12, top: 13 }} />
        <input style={{ ...inputStyle, paddingLeft: 34 }} value={q} placeholder="Search by blader name"
          onChange={(e) => setQ(e.target.value)} />
      </div>
      {rows === undefined ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : rows === null ? (
        <div style={{ color: C.muted, fontSize: 14 }}>The bladers list could not be loaded.</div>
      ) : shown.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 14 }}>{q ? "Nobody by that name." : "Nobody has signed up yet."}</div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
            {shown.length} blader{shown.length === 1 ? "" : "s"}
          </div>
          {shown.map((r) => (
            <button key={r.id} onClick={() => onOpen(r.id)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 12, textAlign: "left",
              background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3,
              padding: "10px 12px", marginBottom: 6, cursor: "pointer", color: C.ink,
            }}>
              <Avatar path={r.photo_path} name={r.blader_name} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="bx-d" style={{
                  fontSize: 16.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{r.blader_name}</div>
                {(yearsText(r.experience_years) || r.favorite_combo) && (
                  <div style={{ fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[yearsText(r.experience_years), r.favorite_combo].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <ChevronRight size={16} color={C.muted} />
            </button>
          ))}
        </>
      )}
    </SheetFrame>
  );
}

/**
 * One blader's profile. The real name row appears only when the database
 * hands one back, which it does for the blader, organisers and staff.
 */
function BladerSheet({ id, meId, canAward, isStaff, onClose, onEdit, onAward, onClaim, onOpenEvent }) {
  const [b, setB] = useState(undefined);
  const [tab, setTab] = useState("medals");
  const [real, setReal] = useState(null);
  const [medals, setMedals] = useState(undefined);
  const [names, setNames] = useState({});        // teammates, by id
  const [dropping, setDropping] = useState(null); // the medal being removed
  const [err, setErr] = useState(null);
  const [claims, setClaims] = useState(null);     // your own medals waiting for approval
  const [withdrawing, setWithdrawing] = useState(null);

  const loadMedals = () => listMedals(id).then(async (rows) => {
    setMedals(rows);
    if (rows) setNames(await bladerNames(rows.map((m) => m.teammate_id)));
  });

  const loadClaims = () => myMedalClaims(id).then(setClaims);

  useEffect(() => {
    loadBlader(id).then(setB);
    if (meId) bladerRealName(id).then(setReal);
    loadMedals();
    if (meId && meId === id) loadClaims();
  }, [id, meId]);

  // Taken back by whoever gave it, or by staff — the same rule the database applies.
  const canRemove = (m) => canAward && (m.awarded_by === meId || isStaff);

  const mine = meId && meId === id;
  const Row = ({ label, children, note }) => (
    <div style={{ padding: "11px 0", borderBottom: `1px solid ${C.line}55` }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 15.5 }}>{children}</div>
      {note && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>{note}</div>}
    </div>
  );

  return (
    <SheetFrame title={mine ? "Your profile" : "Blader"} onClose={onClose}>
      {b === undefined ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : !b ? (
        <div style={{ color: C.muted, fontSize: 14 }}>This profile could not be found.</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
            <Avatar path={b.photo_path} name={b.blader_name} size={84} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: C.cyan, marginBottom: 2 }}>Blader name</div>
              <div className="bx-d" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.02, wordBreak: "break-word" }}>
                {b.blader_name}
              </div>
            </div>
          </div>

          {real && (
            <Row label="Real name" note={mine ? "Only you, organisers and staff can see this." : null}>{real}</Row>
          )}
          <Row label="Experience">
            {yearsText(b.experience_years) || <span style={{ color: C.muted }}>Not given</span>}
          </Row>
          <Row label="Favourite combo">
            {b.favorite_combo || <span style={{ color: C.muted }}>Not given</span>}
          </Row>

          {(mine || canAward) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 18 }}>
              {mine && (
                <Btn onClick={onEdit} tone="primary"><Pencil size={15} />Edit profile</Btn>
              )}
              {/* The approver gives medals directly; everyone else sends theirs in. */}
              {canAward ? (
                <Btn onClick={() => onAward(b)}><Medal size={15} />Add medal</Btn>
              ) : mine && onClaim && claims !== null && (
                <Btn onClick={() => onClaim(b, claims.length)}><Medal size={15} />Add medal</Btn>
              )}
            </div>
          )}

          <div style={{ marginTop: 24, marginBottom: 16 }}>
            <Segmented value={tab} onChange={setTab} tone={C.cyan} options={[
              { value: "medals", label: "Medals" },
              { value: "tournaments", label: "Tournaments" },
            ]} />
          </div>

          {tab === "medals" ? (
            <div>
              {medals === undefined ? (
                <div style={{ color: C.muted, fontSize: 14 }}>Loading medals…</div>
              ) : medals === null ? (
                <div style={{ color: C.muted, fontSize: 14 }}>Medals could not be loaded.</div>
              ) : (
                <>
                  {mine && claims && claims.length > 0 && (
                    <WaitingMedals claims={claims} onWithdraw={setWithdrawing} />
                  )}
                  <MedalBoard medals={medals} names={names} canRemove={canRemove} onRemove={setDropping} />
                </>
              )}
              {err && <div style={{ color: C.magenta, fontSize: 13.5, marginTop: 10 }}>{err}</div>}
            </div>
          ) : (
            <Participation id={id} onOpenEvent={onOpenEvent} />
          )}
        </>
      )}

      {withdrawing && (
        <Confirm
          title="Withdraw this medal?"
          body={`${PLACE_LABEL[withdrawing.place]} at ${withdrawing.tournament_name} stops waiting for approval, and its photos are deleted. You can send it in again later.`}
          confirmLabel="Withdraw" tone="danger"
          onConfirm={async () => {
            const c = withdrawing;
            setWithdrawing(null); setErr(null);
            const { error } = await withdrawMedalClaim(c.id);
            if (error) setErr(error.message);
            loadClaims();
          }}
          onClose={() => setWithdrawing(null)}
        />
      )}
      {dropping && (
        <Confirm
          title="Remove this medal?"
          body={`${PLACE_LABEL[dropping.place]} at ${dropping.tournament_name}. It comes off ${b ? b.blader_name : "this"}'s profile`
            + (dropping.teammate_id ? "; their teammate keeps theirs unless you remove that one too." : ".")}
          confirmLabel="Remove" tone="danger"
          onConfirm={async () => {
            const m = dropping;
            setDropping(null); setErr(null);
            const { error } = await removeMedal(m.id);
            if (error) setErr(error.message);
            loadMedals();
          }}
          onClose={() => setDropping(null)}
        />
      )}
    </SheetFrame>
  );
}

/**
 * How one blader did in one tournament, worked out from the tournament's own
 * data so it can never disagree with it: their record, their place in the
 * group or league, and how far they went. Null if they were not in it.
 *
 * `settled` says whether that result can still change — a quarter-finalist
 * is settled once beaten, a beaten semi-finalist not until third place is
 * played, and anyone still in it not at all.
 */
function participation(t, bladerId) {
  const p = (t.players || []).find((x) =>
    x.profileId === bladerId || (x.memberIds || []).includes(bladerId));
  if (!p) return null;
  const pid = p.id;
  const nameOf = (id) => ((t.players || []).find((x) => x.id === id) || {}).name || "";

  let played = 0, wins = 0, losses = 0, pf = 0, pa = 0;
  everyMatch(t).forEach((m) => {
    if (!m.done || !m.p1 || !m.p2 || (m.p1 !== pid && m.p2 !== pid)) return;
    const { s1, s2 } = scoreOf(m);
    const mine = m.p1 === pid;
    played++; pf += mine ? s1 : s2; pa += mine ? s2 : s1;
    const w = winnerOf(m);
    if (w === pid) wins++; else if (w) losses++;
  });

  const league = isLeague(t);
  const g = (t.groups || []).find((x) => x.playerIds.includes(pid));
  let group = null;
  if (g) {
    const ms = (t.groupMatches || []).filter((m) => m.groupId === g.id);
    const rows = computeStandings(g.playerIds, ms, nameOf, league ? t.leaguePoints : null, t.tieBreaks);
    const i = rows.findIndex((r) => r.id === pid);
    group = {
      name: g.name, pos: i + 1, of: rows.length, pts: rows[i] ? rows[i].pts : 0,
      done: ms.length > 0 && ms.every((m) => m.done),
    };
  }
  const out = { team: p.members ? p.name : null, played, wins, losses, pf, pa, group, league, deck: p.deck || null };

  // No knockout: the table is the result.
  if (league || !t.koSize) {
    return { ...out, settled: !!(group && group.done), place: group ? `${ordinal(group.pos)} of ${group.of}` : "Not placed" };
  }

  const b = t.bracket;
  if (!b) return { ...out, settled: false, place: "Group stage" };

  const rounds = b.rounds;
  const final = rounds[rounds.length - 1][0];
  const champ = winnerOf(final);
  const thirdWinner = b.third && b.third.done ? winnerOf(b.third) : null;
  const inMatch = (m) => m && (m.p1 === pid || m.p2 === pid);

  if (champ === pid) return { ...out, settled: true, place: "Champion" };
  if (champ && inMatch(final)) return { ...out, settled: true, place: "Runner-up" };
  if (thirdWinner === pid) return { ...out, settled: true, place: "3rd place" };
  if (thirdWinner && inMatch(b.third)) return { ...out, settled: true, place: "4th place" };

  let deepest = -1, there = null;
  rounds.forEach((r, ri) => r.forEach((m) => { if (inMatch(m)) { deepest = ri; there = m; } }));

  // Never reached the bracket: out in the groups.
  if (deepest < 0) return { ...out, settled: !!(group && group.done), place: "Group stage" };

  const teams = rounds[deepest].length * 2;
  const w = winnerOf(there);
  if (there.done && w && w !== pid) {
    const place = teams === 4 ? "Semi-finalist" : teams === 8 ? "Quarter-finalist" : `Round of ${teams}`;
    // Beaten in a semi, with third place still to play for.
    return { ...out, settled: !(teams === 4 && b.third && !b.third.done), place };
  }
  return { ...out, settled: false, place: `In the ${roundName(teams).toLowerCase()}` };
}

const RESULT_COLOR = { Champion: C.gold, "Runner-up": "#C9CED6", "3rd place": "#C87941" };

/** The Tournaments tab: every tournament held in the app this blader was linked into. */
function Participation({ id, onOpenEvent }) {
  const [rows, setRows] = useState(undefined);
  useEffect(() => {
    bladerEvents(id).then((evs) => setRows(evs === null ? null : evs
      .map((e) => ({ e, r: participation(e.data || {}, id) }))
      .filter((x) => x.r)));
  }, [id]);

  if (rows === undefined) return <div style={{ color: C.muted, fontSize: 14 }}>Loading tournaments…</div>;
  if (rows === null) return <div style={{ color: C.muted, fontSize: 14 }}>Tournaments could not be loaded.</div>;
  if (!rows.length) {
    return (
      <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.5 }}>
        No tournaments yet. A tournament appears here once its organiser links this blader to it.
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        {rows.length} tournament{rows.length === 1 ? "" : "s"} held in the app
      </div>
      {rows.map(({ e, r }) => {
        const col = RESULT_COLOR[r.place] || C.ink;
        return (
          <button key={e.id} onClick={() => onOpenEvent && onOpenEvent(e.id)} style={{
            width: "100%", textAlign: "left", display: "block", cursor: onOpenEvent ? "pointer" : "default",
            background: C.surface, border: `1px solid ${C.line}`, borderLeft: `3px solid ${RESULT_COLOR[r.place] || C.line}`,
            borderRadius: 3, padding: "11px 12px", marginBottom: 7, color: C.ink,
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div className="bx-d" style={{ flex: 1, minWidth: 0, fontSize: 16.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.name}
              </div>
              <div className="bx-d" style={{ fontSize: 15, fontWeight: 800, color: col, flexShrink: 0 }}>{r.place}</div>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {FORMAT_LABEL[e.format] || e.format} · {e.organiser} · {new Date(e.created_at).toLocaleDateString()}
              {!r.settled && <span style={{ color: C.gold }}> · in progress</span>}
            </div>
            <div style={{ fontSize: 13, marginTop: 7, lineHeight: 1.5 }}>
              {r.team && <span style={{ color: C.cyan }}>With {r.team} · </span>}
              {r.group && !r.league && `${r.group.name}: ${ordinal(r.group.pos)} of ${r.group.of} · `}
              {r.league && `${r.group ? r.group.pts : 0} league points · `}
              {r.wins}W {r.losses}L · {r.pf} points scored, {r.pa} conceded
            </div>
            {r.deck && r.deck.length > 0 && (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.45 }}>
                Deck: {r.deck.map(comboLabel).join(" · ")}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/*
 * What kind of tournament a medal came from. Only the first two can be
 * chosen for now; the rest are shown, marked coming soon, so the ladder is
 * visible. Opening one later means flipping `open` here and adding it to
 * medal_category_open() in the database.
 */
const MEDAL_CATEGORIES = [
  { key: "unranked_local", label: "Unranked Locals", open: true },
  { key: "ranked_local", label: "Ranked Locals", open: true },
  { key: "league", label: "League" },
  { key: "s1", label: "S1" },
  { key: "g3", label: "G3" },
  { key: "g2", label: "G2" },
  { key: "g1", label: "G1" },
  { key: "gp", label: "GP" },
];
const categoryLabel = (k) => (MEDAL_CATEGORIES.find((c) => c.key === k) || {}).label || "No category";
const MEDAL_RULE_SEND = "Only pre-announced tournaments and pre-announced podiums are acceptable.";
const MEDAL_RULE_SHOW = "Only pre-announced podiums are displayed.";

function MedalRule({ text, style }) {
  return (
    <div style={{
      display: "flex", gap: 7, alignItems: "flex-start", fontSize: 12.5, color: C.gold, lineHeight: 1.45,
      ...style,
    }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />{text}
    </div>
  );
}

function CategoryPicker({ value, onChange }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 6 }}>
      {MEDAL_CATEGORIES.map((c) => {
        const on = value === c.key;
        return (
          <button key={c.key} onClick={() => c.open && onChange(c.key)} disabled={!c.open}
            aria-pressed={on} className="bx-d"
            style={{
              padding: "9px 8px", borderRadius: 3, textAlign: "center",
              fontSize: 14, fontWeight: 700, cursor: c.open ? "pointer" : "not-allowed",
              background: on ? C.gold : C.base, color: on ? "#14020A" : c.open ? C.ink : C.muted,
              border: `1px solid ${on ? C.gold : C.line}`, opacity: c.open ? 1 : 0.55,
            }}>
            {c.label}
            {!c.open && <div style={{ fontSize: 10.5, fontWeight: 500, marginTop: 1 }}>Coming soon</div>}
          </button>
        );
      })}
    </div>
  );
}

function CategoryTag({ category }) {
  if (!category) return null;
  return (
    <span style={{
      fontSize: 11, color: C.gold, border: `1px solid ${C.gold}55`, borderRadius: 3,
      padding: "1px 6px", whiteSpace: "nowrap",
    }}>{categoryLabel(category)}</span>
  );
}

const PLACES = ["first", "second", "third", "swiss"];
const PLACE_LABEL = { first: "1st Place", second: "2nd Place", third: "3rd Place", swiss: "Swiss Medal" };
const PLACE_COLOR = { first: C.gold, second: "#C9CED6", third: "#C87941", swiss: C.cyan };

/*
 * Seasons newest first, by the number in them, so S10 comes before S9.
 * Anything without a number keeps its place behind those that have one.
 */
const seasonOrder = (a, b) => {
  const na = parseInt(String(a).replace(/[^0-9]/g, ""), 10);
  const nb = parseInt(String(b).replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return String(a).localeCompare(String(b));
};

/**
 * A blader's podium record, one list per season. Each place shows how many,
 * and opens to the tournaments behind the number. With no medals at all the
 * S1 list still shows, at zero, so the shape of the record is always there.
 */
function MedalBoard({ medals: every, names, canRemove, onRemove }) {
  const [open, setOpen] = useState(null);   // "season|place"
  const [cat, setCat] = useState("all");
  const kinds = MEDAL_CATEGORIES.map((c) => c.key).filter((k) => every.some((m) => m.category === k));
  if (every.some((m) => !m.category)) kinds.push("none");
  const medals = cat === "all" ? every : every.filter((m) => (m.category || "none") === cat);
  const seasons = [...new Set(medals.map((m) => m.season))].sort(seasonOrder);
  if (!seasons.length) seasons.push("S1");

  return (
    <>
      {kinds.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <Segmented value={cat} onChange={(v) => { setCat(v); setOpen(null); }} tone={C.gold} options={[
            { value: "all", label: "All" },
            ...kinds.map((k) => ({ value: k, label: k === "none" ? "Other" : categoryLabel(k) })),
          ]} />
        </div>
      )}
      {seasons.map((season) => {
    const here = medals.filter((m) => m.season === season);
    return (
      <div key={season} style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
          <Blade color={C.gold} h={16} />
          <div className="bx-d" style={{ fontSize: 17, fontWeight: 700 }}>
            {season} Regular Tournament Podium List
          </div>
        </div>
        {PLACES.map((place) => {
          const list = here.filter((m) => m.place === place);
          const key = `${season}|${place}`;
          const isOpen = open === key && list.length > 0;
          const col = PLACE_COLOR[place];
          return (
            <div key={place} style={{
              background: C.surface, border: `1px solid ${C.line}`, borderLeft: `3px solid ${col}`,
              borderRadius: 3, marginBottom: 6,
            }}>
              <button onClick={() => setOpen(isOpen ? null : key)} disabled={!list.length}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
                  background: "none", border: "none", color: C.ink, textAlign: "left",
                  cursor: list.length ? "pointer" : "default",
                }}>
                <Medal size={17} color={col} />
                <span style={{ flex: 1, fontSize: 15 }}>{PLACE_LABEL[place]}</span>
                <span className="bx-d" style={{ fontSize: 20, fontWeight: 800, color: list.length ? C.ink : C.muted }}>
                  {list.length}
                </span>
                {list.length > 0 && (
                  <ChevronRight size={15} color={C.muted}
                    style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
                )}
              </button>
              {isOpen && (
                <div style={{ borderTop: `1px solid ${C.line}66`, padding: "4px 12px 8px" }}>
                  {list.map((m) => (
                    <div key={m.id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
                      borderBottom: `1px solid ${C.line}33`,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                          {m.tournament_name}<CategoryTag category={m.category} />
                        </div>
                        <div style={{ fontSize: 12, color: C.muted }}>
                          {m.organiser_name}
                          {m.teammate_id && names[m.teammate_id] ? ` · with ${names[m.teammate_id]}` : ""}
                        </div>
                      </div>
                      {canRemove(m) && (
                        <button onClick={() => onRemove(m)} aria-label="Remove medal"
                          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }}>
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
      })}
      <MedalRule text={MEDAL_RULE_SHOW} style={{ color: C.muted }} />
    </>
  );
}

/** Only on your own profile: medals you sent in that are not decided yet. */
function WaitingMedals({ claims, onWithdraw }) {
  return (
    <div style={{ ...card, borderColor: `${C.gold}66`, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Clock size={16} color={C.gold} />
        <div className="bx-d" style={{ fontSize: 16, fontWeight: 700 }}>Waiting for approval</div>
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: C.muted }}>{claims.length} of {CLAIM_LIMIT}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 8 }}>
        Only you can see these. They join your medals once approved.
      </div>
      {claims.map((c) => (
        <div key={c.id} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line}44`,
        }}>
          <Medal size={16} color={PLACE_COLOR[c.place]} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              {PLACE_LABEL[c.place]} · {c.tournament_name}<CategoryTag category={c.category} />
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>{c.organiser_name} · {c.season}</div>
          </div>
          <button onClick={() => onWithdraw(c)} aria-label="Withdraw"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4 }}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** One side of the medal, photographed. Shrunk before anything is uploaded. */
function ProofPicker({ label, blob, onPick, onError }) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const out = await shrinkImage(file, "proof");
      if (!out) throw new Error();
      onPick(out);
    } catch {
      onError("That photo could not be read. Try a JPEG or PNG.");
    }
  };
  return (
    <label style={{
      flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 6, cursor: "pointer", aspectRatio: "1 / 1", borderRadius: 3, overflow: "hidden", position: "relative",
      border: `1px dashed ${blob ? C.green : C.line}`, background: C.base, color: C.muted, fontSize: 13,
    }}>
      {url ? (
        <>
          <img src={url} alt={label} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          <span style={{
            position: "absolute", left: 0, right: 0, bottom: 0, padding: "5px 6px", textAlign: "center",
            background: "#0B0718CC", color: C.ink, fontSize: 12.5,
          }}>{label} · tap to change</span>
        </>
      ) : (
        <><Camera size={22} /><span>{label}</span></>
      )}
      <input type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />
    </label>
  );
}

/**
 * Giving a medal. Tournaments and organisers already in the app are offered
 * as suggestions, and picking a known tournament fills in who ran it; any
 * other name can still be typed, for events that were never run here.
 */
function MedalSheet({ blader, directory, onClose, onSaved, claim = false, waiting = 0 }) {
  const [place, setPlace] = useState("first");
  const [category, setCategory] = useState(null);
  const [front, setFront] = useState(null);
  const [back, setBack] = useState(null);
  const full = claim && waiting >= CLAIM_LIMIT;
  const [tournament, setTournament] = useState("");
  const [organiser, setOrganiser] = useState("");
  const [season, setSeason] = useState("S1");
  const [teammate, setTeammate] = useState("");
  const [others, setOthers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    listBladers().then((rows) => setOthers((rows || []).filter((r) => r.id !== blader.id)));
  }, [blader.id]);

  const tournaments = [...new Set((directory || []).map((e) => e.name))];
  const organisers = [...new Set((directory || []).map((e) => e.organiser))];

  const pickTournament = (v) => {
    setTournament(v);
    const hit = (directory || []).find((e) => e.name === v);
    if (hit && !organiser.trim()) setOrganiser(hit.organiser);
  };

  const save = async () => {
    const t = tournament.trim(), o = organiser.trim(), s = season.trim();
    const bad = !category ? "Which kind of tournament was it? Choose a category."
      : !t ? "Which tournament was it?"
      : t.length > 80 ? "Keep the tournament name to 80 characters."
      : !o ? "Who organised it?"
      : o.length > 60 ? "Keep the organiser to 60 characters."
      : !s ? "Which season?"
      : s.length > 20 ? "Keep the season to 20 characters."
      : claim && (!front || !back) ? "Add a photo of each side of the medal."
      : null;
    if (bad) { setMsg(bad); return; }
    setBusy(true); setMsg(null);
    const fields = {
      bladerId: blader.id, teammateId: teammate || null,
      place, category, tournamentName: t, organiserName: o, season: s,
    };
    const { error } = claim
      ? await submitMedalClaim(blader.id, fields, front, back)
      : await addMedal(fields);
    if (error) { setBusy(false); setMsg(error.message || "That medal could not be saved."); return; }
    onSaved();
  };

  return (
    <SheetFrame title={claim ? "Send a medal in" : "Add medal"} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Avatar path={blader.photo_path} name={blader.blader_name} size={44} />
        <div className="bx-d" style={{ fontSize: 20, fontWeight: 800 }}>{blader.blader_name}</div>
      </div>

      <MedalRule text={MEDAL_RULE_SEND} style={{
        marginBottom: 18, padding: "9px 11px", border: `1px solid ${C.gold}55`, borderRadius: 3, background: `${C.gold}12`,
      }} />

      {claim && (
        <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 18, maxWidth: "58ch" }}>
          It goes to the medal approver with your photos, and shows on your profile once
          approved. The photos are deleted as soon as it is decided. You can have up to {CLAIM_LIMIT} waiting
          at once — {waiting} {waiting === 1 ? "is" : "are"} waiting now.
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        <div className="bx-d" style={{ fontSize: 15, marginBottom: 7, fontWeight: 600 }}>Category</div>
        <CategoryPicker value={category} onChange={setCategory} />
      </div>

      <div style={{ marginBottom: 18 }}>
        <div className="bx-d" style={{ fontSize: 15, marginBottom: 7, fontWeight: 600 }}>Place</div>
        <Segmented value={place} onChange={setPlace} tone={PLACE_COLOR[place]}
          options={PLACES.map((p) => ({ value: p, label: p === "swiss" ? "Swiss" : PLACE_LABEL[p].replace(" Place", "") }))} />
      </div>

      <Field label="Tournament">
        <input style={inputStyle} maxLength={80} value={tournament} list="medal-tournaments"
          onChange={(e) => pickTournament(e.target.value)} placeholder="Tournament name" />
        <datalist id="medal-tournaments">{tournaments.map((n) => <option key={n} value={n} />)}</datalist>
      </Field>
      <Field label="Organiser">
        <input style={inputStyle} maxLength={60} value={organiser} list="medal-organisers"
          onChange={(e) => setOrganiser(e.target.value)} placeholder="Who ran it" />
        <datalist id="medal-organisers">{organisers.map((n) => <option key={n} value={n} />)}</datalist>
      </Field>
      <Field label="Season">
        <input style={inputStyle} maxLength={20} value={season} onChange={(e) => setSeason(e.target.value)} />
      </Field>
      <Field label={claim ? "Teammate" : "Also award to teammate"}
        hint={claim
          ? "Tag team only. Once approved, your partner gets the same medal on their own profile."
          : "Tag team only. Their partner gets the same medal on their own profile."}>
        <select style={inputStyle} value={teammate} onChange={(e) => setTeammate(e.target.value)}>
          <option value="">— nobody, singles —</option>
          {others.map((r) => <option key={r.id} value={r.id}>{r.blader_name}</option>)}
        </select>
      </Field>

      {claim && (
        <div style={{ marginBottom: 18 }}>
          <div className="bx-d" style={{ fontSize: 15, marginBottom: 7, fontWeight: 600 }}>Proof</div>
          <div style={{ display: "flex", gap: 8, maxWidth: 420 }}>
            <ProofPicker label="Front of the medal" blob={front} onPick={(x) => { setFront(x); setMsg(null); }} onError={setMsg} />
            <ProofPicker label="Back of the medal" blob={back} onPick={(x) => { setBack(x); setMsg(null); }} onError={setMsg} />
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 1.45 }}>
            A clear photo of each side. Only you and the medal approver can see them.
          </div>
        </div>
      )}

      {full && (
        <div style={{ color: C.gold, fontSize: 13.5, marginBottom: 12, lineHeight: 1.5 }}>
          You have {CLAIM_LIMIT} medals waiting for approval. Send more once those are decided.
        </div>
      )}
      {msg && <div style={{ color: C.magenta, fontSize: 13.5, marginBottom: 12, lineHeight: 1.5 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={save} tone="primary" disabled={busy || full}>
          {claim ? <Send size={15} /> : <Medal size={15} />}
          {busy ? (claim ? "Sending…" : "Saving…")
            : claim ? "Send for approval"
            : teammate ? "Award to both" : "Award medal"}
        </Btn>
        <Btn onClick={onClose} tone="ghost" disabled={busy}>Cancel</Btn>
      </div>
    </SheetFrame>
  );
}

/** Editing your own profile. Nothing is saved, photo included, until Save. */
function ProfileEditSheet({ meId, blader, onClose, onSaved }) {
  const [name, setName] = useState(blader.blader_name);
  const [real, setReal] = useState("");
  const [realLoaded, setRealLoaded] = useState(false);
  const [exp, setExp] = useState(blader.experience_years ?? "");
  const [combo, setCombo] = useState(blader.favorite_combo || "");
  const [photoBlob, setPhotoBlob] = useState(null);     // a new photo, not yet uploaded
  const [photoGone, setPhotoGone] = useState(false);    // the current one, removed
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    bladerRealName(meId).then((r) => { setReal(r || ""); setRealLoaded(true); });
  }, [meId]);

  const preview = useMemo(() => (photoBlob ? URL.createObjectURL(photoBlob) : null), [photoBlob]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pickPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const blob = await shrinkImage(file, "avatar");
      if (!blob) throw new Error();
      setPhotoBlob(blob); setPhotoGone(false); setMsg(null);
    } catch {
      setMsg({ tone: C.magenta, text: "That image could not be read. Try a JPEG or PNG." });
    }
  };

  const save = async () => {
    const bn = name.trim(), rn = real.trim();
    const years = exp === "" ? null : Number(exp);
    const bad = !bn ? "A blader name is needed."
      : bn.length > 30 ? "Keep the blader name to 30 characters."
      : !rn ? "A real name is needed."
      : rn.length > 80 ? "Keep the real name to 80 characters."
      : years !== null && !(years >= 0 && years <= 50) ? "Experience should be between 0 and 50 years."
      : combo.trim().length > 80 ? "Keep the favourite combo to 80 characters."
      : null;
    if (bad) { setMsg({ tone: C.magenta, text: bad }); return; }

    setBusy(true); setMsg(null);
    try {
      if (bn.toLowerCase() !== blader.blader_name.trim().toLowerCase()) {
        const free = await bladerNameFree(bn, meId);
        if (free === false) throw new Error(`Somebody is already "${bn}". Pick another blader name.`);
      }

      const old = blader.photo_path;
      let photo = photoGone ? null : old;
      if (photoBlob) photo = await uploadAvatar(meId, photoBlob);

      const { row, error } = await saveBlader(meId, {
        blader_name: bn,
        experience_years: years === null ? null : Math.round(years * 10) / 10,
        favorite_combo: combo.trim() || null,
        photo_path: photo,
      });
      if (error) {
        if (photoBlob) removeAvatar(photo);   // uploaded for a save that did not happen
        throw error.code === "23505"
          ? new Error(`Somebody is already "${bn}". Pick another blader name.`)
          : error;
      }

      const r2 = await saveRealName(meId, rn);
      if (r2.error) throw r2.error;

      if (old && old !== photo) removeAvatar(old);
      onSaved(row);
    } catch (err) {
      setMsg({ tone: C.magenta, text: err.message || "That could not be saved." });
      setBusy(false);
    }
  };

  const showing = photoBlob ? { src: preview } : photoGone ? {} : { path: blader.photo_path };

  return (
    <SheetFrame title="Edit profile" onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
        <Avatar {...showing} name={name} size={84} />
        <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-start" }}>
          <label style={{
            display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer",
            background: C.raised, border: `1px solid ${C.line}`, borderRadius: 3,
            padding: "8px 12px", fontSize: 14, color: C.ink,
          }}>
            <Camera size={15} />{blader.photo_path || photoBlob ? "Change photo" : "Add photo"}
            <input type="file" accept="image/*" onChange={pickPhoto} style={{ display: "none" }} />
          </label>
          {(photoBlob || (blader.photo_path && !photoGone)) && (
            <button onClick={() => { setPhotoBlob(null); setPhotoGone(true); }}
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13, padding: 0 }}>
              Remove photo
            </button>
          )}
        </div>
      </div>

      <Field label="Blader name" hint="Public. Nobody else can have the same one.">
        <input style={inputStyle} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Real name" hint="Only you, organisers and staff can see this.">
        <input style={inputStyle} maxLength={80} value={real} disabled={!realLoaded}
          placeholder={realLoaded ? "" : "Loading…"} onChange={(e) => setReal(e.target.value)} />
      </Field>
      <Field label="Experience (years)" hint="Optional.">
        <input style={inputStyle} type="number" inputMode="decimal" min={0} max={50} step={0.5}
          value={exp} onChange={(e) => setExp(e.target.value)} />
      </Field>
      <Field label="Favourite combo" hint="Optional. For example: Dran Sword 3-60 Flat.">
        <input style={inputStyle} maxLength={80} value={combo} onChange={(e) => setCombo(e.target.value)} />
      </Field>

      {msg && <div style={{ color: msg.tone, fontSize: 13.5, marginBottom: 12, lineHeight: 1.5 }}>{msg.text}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={save} tone="primary" disabled={busy || !realLoaded}>
          <Check size={15} />{busy ? "Saving…" : "Save"}
        </Btn>
        <Btn onClick={onClose} tone="ghost" disabled={busy}>Cancel</Btn>
      </div>
    </SheetFrame>
  );
}

function ApprovalsSheet({ isStaff, isAwarder, onClose }) {
  const [tab, setTab] = useState(isStaff ? "hosting" : "medals");
  const [hosts, setHosts] = useState(null);
  const [claims, setClaims] = useState(null);
  useEffect(() => {
    if (isStaff) pendingHosts().then(setHosts);
    if (isAwarder) medalClaimsWaiting().then((r) => setClaims(r || "error"));
  }, [isStaff, isAwarder]);
  const count = (x) => (Array.isArray(x) ? ` (${x.length})` : "");

  return (
    <SheetFrame title="Approvals" onClose={onClose}>
      {isStaff && isAwarder && (
        <div style={{ marginBottom: 18 }}>
          <Segmented value={tab} onChange={setTab} tone={C.cyan} options={[
            { value: "hosting", label: `Hosting${count(hosts)}` },
            { value: "medals", label: `Medals${count(claims)}` },
          ]} />
        </div>
      )}
      {tab === "hosting" && isStaff
        ? <HostApprovals rows={hosts} refresh={() => pendingHosts().then(setHosts)} />
        : <MedalApprovals rows={claims} refresh={() => medalClaimsWaiting().then((r) => setClaims(r || "error"))} />}
    </SheetFrame>
  );
}

function HostApprovals({ rows, refresh }) {
  return (
    <>
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
    </>
  );
}

/**
 * Medals sent in, oldest first, each with its two photos. Approving writes
 * the medal to the profile; turning it down drops it. Either way the claim
 * and its photos are deleted.
 */
function MedalApprovals({ rows, refresh }) {
  const [names, setNames] = useState({});
  const [links, setLinks] = useState({});
  const [busy, setBusy] = useState(null);       // the claim being decided
  const [refusing, setRefusing] = useState(null);
  const [err, setErr] = useState(null);

  // Photos left over from a delete that did not finish get another go.
  useEffect(() => { sweepProofs(); }, []);
  useEffect(() => {
    if (!Array.isArray(rows) || !rows.length) return;
    bladerNames(rows.flatMap((r) => [r.blader_id, r.teammate_id])).then(setNames);
    proofLinks(rows.flatMap((r) => [r.front_path, r.back_path])).then(setLinks);
  }, [rows]);

  const decide = async (c, approve) => {
    setBusy(c.id); setErr(null);
    const { error } = await reviewMedalClaim(c.id, approve);
    setBusy(null);
    if (error) setErr(error.message || "That could not be saved.");
    refresh();
  };

  const photo = (path, label) => (
    <a href={links[path]} target="_blank" rel="noreferrer" style={{
      flex: 1, minWidth: 0, aspectRatio: "1 / 1", borderRadius: 3, overflow: "hidden", position: "relative",
      border: `1px solid ${C.line}`, background: C.base, display: "grid", placeItems: "center",
      color: C.muted, fontSize: 12.5, textDecoration: "none",
    }}>
      {links[path]
        ? <img src={links[path]} alt={label} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        : "Loading…"}
      <span style={{
        position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 6px", textAlign: "center",
        background: "#0B0718CC", color: C.ink, fontSize: 12,
      }}>{label}</span>
    </a>
  );

  return (
    <>
      <div style={{ color: C.muted, fontSize: 13.5, lineHeight: 1.55, marginBottom: 10, maxWidth: "58ch" }}>
        Approving puts the medal on their profile. Either way the photos are deleted. Tap a photo to see it full size.
      </div>
      <MedalRule text={MEDAL_RULE_SEND} style={{ marginBottom: 16 }} />
      {err && <div style={{ color: C.magenta, fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {rows === null ? (
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      ) : rows === "error" ? (
        <div style={{ color: C.magenta, fontSize: 14, lineHeight: 1.5 }}>
          Medals waiting could not be loaded. If this is new, run medal-claims-schema.sql in Supabase.
        </div>
      ) : rows.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 14 }}>No medals are waiting.</div>
      ) : rows.map((c) => (
        <div key={c.id} style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${PLACE_COLOR[c.place]}` }}>
          <div className="bx-d" style={{ fontSize: 17, fontWeight: 800, marginBottom: 2 }}>
            {names[c.blader_id] || "A blader"}
            {c.teammate_id && <span style={{ color: C.muted, fontWeight: 600 }}> & {names[c.teammate_id] || "teammate"}</span>}
          </div>
          <div style={{ fontSize: 14.5, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 2 }}>
            <Medal size={15} color={PLACE_COLOR[c.place]} />{PLACE_LABEL[c.place]} · {c.tournament_name}
            <CategoryTag category={c.category} />
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
            {c.organiser_name} · {c.season} · sent {new Date(c.created_at).toLocaleDateString()}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, maxWidth: 420 }}>
            {photo(c.front_path, "Front")}
            {photo(c.back_path, "Back")}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn tone="primary" disabled={!!busy} onClick={() => decide(c, true)}>
              <Check size={15} />{busy === c.id ? "Saving…" : "Approve"}
            </Btn>
            <Btn tone="ghost" disabled={!!busy} onClick={() => setRefusing(c)}>
              <X size={15} />Turn down
            </Btn>
          </div>
        </div>
      ))}
      {refusing && (
        <Confirm
          title="Turn this medal down?"
          body={`${PLACE_LABEL[refusing.place]} at ${refusing.tournament_name} will not be added, and its photos are deleted. They can send it in again.`}
          confirmLabel="Turn down" tone="danger"
          onConfirm={() => { const c = refusing; setRefusing(null); decide(c, false); }}
          onClose={() => setRefusing(null)}
        />
      )}
    </>
  );
}


/**
 * The front door. Every live tournament, newest first, gathered under whoever
 * runs it — a visitor arrives here and clicks straight through to a board,
 * with no account and nothing to dismiss.
 *
 * Signing in is a button in the corner rather than a wall, because almost
 * everyone who opens this is here to watch, not to score.
 */
function Directory({ profile, me, mine, all, onOpen, onNew, onSignIn, onSignOut, onApprovals, onBladers, onProfile, awarder, waiting = 0 }) {
  const hosted = mine.filter((e) => e.role === "owner");
  const reffed = mine.filter((e) => e.role === "referee");

  // Anything listed above is kept out of the public list below, so a
  // tournament appears once — under the heading that says what you can do
  // to it, rather than twice with different implications.
  const own = new Set(mine.map((e) => e.id));
  const rest = all.filter((e) => !own.has(e.id));

  // Grouped by organiser, each group newest first, the groups themselves
  // ordered by whoever started something most recently.
  const groups = [];
  const byOwner = new Map();
  rest.forEach((e) => {
    if (!byOwner.has(e.owner_id)) {
      const g = { owner: e.owner_id, organiser: e.organiser, events: [] };
      byOwner.set(e.owner_id, g);
      groups.push(g);
    }
    byOwner.get(e.owner_id).events.push(e);
  });

  const Row = ({ e, accent }) => (
    <button onClick={() => onOpen(e)} style={{
      width: "100%", display: "flex", alignItems: "center", gap: 12, textAlign: "left",
      background: C.surface, border: `1px solid ${C.line}`,
      borderLeft: `3px solid ${accent || C.magenta}`,
      borderRadius: 3, padding: 13, marginBottom: 7, cursor: "pointer", color: C.ink,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bx-d" style={{
          fontSize: 17, fontWeight: 700, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{e.name}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {FORMAT_LABEL[e.format] || e.format}
          {e.created_at ? ` · ${new Date(e.created_at).toLocaleDateString()}` : ""}
        </div>
      </div>
      <ChevronRight size={16} color={C.muted} />
    </button>
  );

  // The heading a section is known by. What you can do to the tournaments
  // underneath is the thing being named, so the count sits with it.
  const Heading = ({ title, color, n, right }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
      <span style={{ width: 20, height: 3, background: color, transform: "skewX(-30deg)" }} />
      <span className="bx-d" style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: 12, color: C.muted }}>
        {n} tournament{n === 1 ? "" : "s"}
      </span>
      {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
    </div>
  );

  return (
    <div className="bx" style={{ ...shell, ...arenaStyle(null) }}>
      <Style />
      <div style={{
        maxWidth: 620, margin: "0 auto", padding: "30px 16px 60px", paddingTop: safeTop("30px"),
      }}>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 24 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 26, height: 3, background: C.magenta, transform: "skewX(-30deg)" }} />
              <span className="bx-d" style={{ fontSize: 13.5, color: C.cyan, fontWeight: 700 }}>
                Beyblade X
              </span>
            </div>
            <h1 className="bx-d" style={{
              fontSize: 36, fontWeight: 800, margin: 0, lineHeight: .95,
              background: `linear-gradient(100deg, ${C.magenta} 0%, #FFFFFF 55%, ${C.cyan} 100%)`,
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>Tournaments</h1>
          </div>

          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <Btn onClick={onBladers} tone="ghost" style={{ padding: "7px 11px" }} aria-label="Bladers">
              <Users size={14} /><span className="bx-role-label">Bladers</span>
            </Btn>
            {profile ? (
              <Btn onClick={onSignOut} tone="ghost" style={{ padding: "7px 11px" }} aria-label="Sign out">
                <Unlock size={14} /><span className="bx-role-label">Sign out</span>
              </Btn>
            ) : (
              <Btn onClick={onSignIn} tone="ghost" style={{ padding: "7px 11px" }} aria-label="Sign in">
                <Lock size={14} /><span className="bx-role-label">Sign in</span>
              </Btn>
            )}
          </div>
        </div>

        {profile && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
              {me ? (
                <button onClick={onProfile} style={{
                  display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
                  padding: 0, cursor: "pointer", color: C.ink, minWidth: 0,
                }}>
                  <Avatar path={me.photo_path} name={me.blader_name} size={28} />
                  <span className="bx-d" style={{ fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {me.blader_name}
                  </span>
                  <span style={{ fontSize: 12, color: C.muted }}>Profile</span>
                </button>
              ) : (
                <span className="bx-d" style={{ fontSize: 14, color: C.muted }}>
                  Signed in · {profile.email}
                </span>
              )}
              {(profile.is_staff || awarder) && (
                <Btn onClick={onApprovals} tone="ghost" style={{ padding: "5px 9px", fontSize: 13, marginLeft: "auto" }}>
                  Approvals
                  {waiting > 0 && (
                    <span className="bx-d" style={{
                      background: C.magenta, color: "#14020A", borderRadius: 9, minWidth: 18, height: 18,
                      fontSize: 11.5, fontWeight: 800, display: "inline-grid", placeItems: "center", padding: "0 5px",
                    }}>{waiting}</span>
                  )}
                </Btn>
              )}
            </div>

            {profile.approved ? (
              <Btn onClick={onNew} tone="primary"
                style={{ width: "100%", justifyContent: "center", padding: 13, fontSize: 15.5 }}>
                <Plus size={16} />New tournament
              </Btn>
            ) : (
              <div style={{
                background: `${C.gold}14`, border: `1px solid ${C.gold}55`, borderRadius: 3,
                padding: "12px 14px", display: "flex", gap: 10,
              }}>
                <AlertTriangle size={16} color={C.gold} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  This account is waiting to be approved for hosting. It can still be added as a
                  referee meanwhile.
                </div>
              </div>
            )}
          </div>
        )}

        {profile && <SeriesRequests />}

        {/* Yours to run. */}
        {hosted.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <Heading title="Hosted" color={C.magenta} n={hosted.length} />
            {hosted.map((e) => <Row key={e.id} e={e} accent={C.magenta} />)}
          </div>
        )}

        {/* Somebody else's, but you keep the score. */}
        {reffed.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <Heading title="Refereeing" color={C.gold} n={reffed.length} />
            {reffed.map((e) => <Row key={e.id} e={e} accent={C.gold} />)}
          </div>
        )}

        {/* Everything else, to watch. */}
        {rest.length > 0 && (
          <div>
            <Heading title="Watch" color={C.cyan} n={rest.length} />
            {groups.map((g) => (
              <div key={g.owner} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Blade color={C.cyan} h={14} />
                  <span className="bx-d" style={{ fontSize: 14, fontWeight: 700, color: C.muted }}>
                    {g.organiser}
                  </span>
                </div>
                {g.events.map((e) => <Row key={e.id} e={e} accent={C.cyan} />)}
              </div>
            ))}
          </div>
        )}

        {all.length === 0 && (
          <div style={{ ...card, textAlign: "center", padding: "40px 20px" }}>
            <div className="bx-d" style={{ fontSize: 20, fontWeight: 700, marginBottom: 7 }}>
              Nothing running yet
            </div>
            <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.55, maxWidth: "40ch", margin: "0 auto" }}>
              Tournaments appear here as organisers start them.
            </div>
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
  const [directory, setDirectory] = useState([]);      // every live tournament
  const [signingIn, setSigningIn] = useState(false);
  const [authMode, setAuthMode] = useState("in");
  // Landed from a reset link: told by the address, so it cannot be missed.
  const [recovering, setRecovering] = useState(() => arrival.path === "/reset");
  const resetFailure = useMemo(() => {
    const h = new URLSearchParams(String(arrival.hash || "").replace(/^#/, ""));
    return h.get("error_description") || null;
  }, []);
  const [me, setMe] = useState(null);                  // this account's public blader row
  const [viewBlader, setViewBlader] = useState(null);  // whose profile is open
  const [editing, setEditing] = useState(false);
  const [bladerVersion, setBladerVersion] = useState(0);  // bumped after an edit, to reload
  const [awarder, setAwarder] = useState(false);       // holds medal access
  const [awarding, setAwarding] = useState(null);      // the blader a medal is being given to
  const [claiming, setClaiming] = useState(null);      // { blader, waiting }: sending your own medal in
  const [waiting, setWaiting] = useState(0);           // hosts and medals waiting on this account

  useEffect(() => {
    currentSession().then(setSession);
    return onAuthChange((s, event) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
  }, []);

  // The directory is public, so it loads for everyone and does not wait on a
  // session that most visitors will never have.
  useEffect(() => { publicEvents().then(setDirectory); }, []);

  useEffect(() => {
    if (!session) { setProfile(null); setEvents([]); setMe(null); setAwarder(false); return; }
    // The blader row is made by ensure_profile, which loadProfile runs, so it
    // is only asked for once that has finished.
    loadProfile(session.user.id).then((p) => {
      setProfile(p);
      loadBlader(session.user.id).then(setMe);
      amAwarder().then(setAwarder);
    });
    myEvents(session.user.id).then(setEvents);
    setSigningIn(false);
  }, [session]);

  // The address bar is the navigation, so a tournament's link is shareable and
  // the browser's own back button behaves.
  useEffect(() => {
    const onPop = () => setOpenId(new URLSearchParams(location.search).get("t"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // What is waiting on this account to decide: shown on the Approvals button.
  const isStaff = !!(profile && profile.is_staff);
  const countWaiting = async () => {
    const [h, m] = await Promise.all([
      isStaff ? pendingHosts().then((r) => r.length) : 0,
      awarder ? medalClaimCount() : 0,
    ]);
    setWaiting(h + m);
  };
  useEffect(() => { if (isStaff || awarder) countWaiting(); else setWaiting(0); }, [isStaff, awarder]);

  const openEvent = (id) => {
    history.pushState({}, "", "?t=" + id);
    setOpenId(id);
  };
  const backToList = () => {
    history.pushState({}, "", location.pathname);
    setOpenId(null);
  };
  const refreshEvents = async () => {
    publicEvents().then(setDirectory);
    if (session) await myEvents(session.user.id).then(setEvents);
  };

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
          onExit={backToList}
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

  if (recovering) {
    const leave = () => { history.replaceState({}, "", "/"); setRecovering(false); };
    return (
      <ResetPasswordScreen session={session} failure={resetFailure}
        onDone={leave}
        onRequestNew={() => { leave(); setAuthMode("forgot"); setSigningIn(true); }} />
    );
  }

  if (signingIn && !session) {
    return <AuthScreen key={authMode} startMode={authMode}
      onDone={() => { setSigningIn(false); setAuthMode("in"); }}
      onBack={() => { setSigningIn(false); setAuthMode("in"); }} />;
  }

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
      <Directory
        profile={profile}
        me={me}
        onBladers={() => setSheet("bladers")}
        onProfile={() => session && setViewBlader(session.user.id)}
        mine={events}
        all={directory}
        onOpen={(e) => openEvent(e.id)}
        onNew={() => setMaking(true)}
        onApprovals={() => setSheet("approvals")}
        awarder={awarder} waiting={waiting}
        onSignIn={() => setSigningIn(true)}
        onSignOut={async () => { await signOut(); setOpenId(null); }}
      />
      {sheet === "approvals" && (
        <ApprovalsSheet isStaff={isStaff} isAwarder={awarder}
          onClose={() => { setSheet(null); setBladerVersion((v) => v + 1); countWaiting(); }} />
      )}
      {sheet === "bladers" && (
        <BladersSheet key={bladerVersion} onOpen={setViewBlader} onClose={() => setSheet(null)} />
      )}
      {viewBlader && (
        <BladerSheet key={`${viewBlader}:${bladerVersion}`} id={viewBlader}
          meId={session ? session.user.id : null}
          canAward={awarder} isStaff={!!(profile && profile.is_staff)}
          onClose={() => setViewBlader(null)} onEdit={() => setEditing(true)}
          onAward={setAwarding}
          onClaim={(b, n) => setClaiming({ blader: b, waiting: n })}
          onOpenEvent={(eid) => { setViewBlader(null); setSheet(null); openEvent(eid); }} />
      )}
      {awarding && awarder && (
        <MedalSheet blader={awarding} directory={directory}
          onClose={() => setAwarding(null)}
          onSaved={() => { setAwarding(null); setBladerVersion((v) => v + 1); }} />
      )}
      {claiming && session && (
        <MedalSheet claim blader={claiming.blader} waiting={claiming.waiting} directory={directory}
          onClose={() => setClaiming(null)}
          onSaved={() => { setClaiming(null); setBladerVersion((v) => v + 1); }} />
      )}
      {editing && me && session && (
        <ProfileEditSheet meId={session.user.id} blader={me}
          onClose={() => setEditing(false)}
          onSaved={(row) => {
            setMe(row);
            setEditing(false);
            setBladerVersion((v) => v + 1);
            refreshEvents();   // the directory names organisers by blader name
          }} />
      )}
    </>
  );
}
