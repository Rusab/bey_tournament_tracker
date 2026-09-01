import React, { useState, useEffect, useMemo } from "react";
import {
  Shuffle, Plus, X, Trophy, Users, Swords, Table2, Settings,
  Undo2, ArrowLeft, Trash2, AlertTriangle, GitBranch, ChevronRight, Check, Medal, Lock, Unlock, Eye,
  Image as ImageIcon,
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

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
const ROW_ID = "current"; // one row holds the live tournament

const uid = () => Math.random().toString(36).slice(2, 9);

/* ------------------------------------------------------------------
   Persistence adapter. Everything the app saves goes through here.
   Backed by Supabase: the "tournaments" table + row-level security
   policies are what actually stop writes from anyone not signed in —
   see SETUP.md.
------------------------------------------------------------------ */
const store = {
  async load() {
    const { data, error } = await supabase
      .from("tournaments").select("data").eq("id", ROW_ID).maybeSingle();
    if (error) { console.error(error); return null; }
    return data ? data.data : null;
  },
  async save(value) {
    const { error } = await supabase
      .from("tournaments")
      .upsert({ id: ROW_ID, data: value, updated_at: new Date().toISOString() });
    if (error) { console.error(error); return false; }
    return true;
  },
  // Spectators get pushed updates instead of polling. onStatus reports whether
  // the realtime channel actually connected — if it didn't (realtime not enabled
  // on the table, flaky network), the app falls back to a slow poll.
  subscribe(onChange, onStatus) {
    const ch = supabase
      .channel("tournament")
      .on("postgres_changes",
          { event: "*", schema: "public", table: "tournaments", filter: `id=eq.${ROW_ID}` },
          (payload) => { if (payload.new && payload.new.data) onChange(payload.new.data); })
      .subscribe((status) => { if (onStatus) onStatus(status); });
    return () => supabase.removeChannel(ch);
  },
};

/* ------------------------------------------------------------------
   Background image.

   The picture never goes into the tournament record — that blob is
   re-sent to every spectator on every score, so only the URL lives
   there. It is also shrunk in the browser before it is uploaded, so a
   12MP phone photo costs a spectator ~100KB, not ~6MB.
------------------------------------------------------------------ */
const BG_BUCKET = "tournament-bg";
const BG_MAX_DIM = 1400;   // plenty behind a 90% dark veil
const BG_QUALITY = 0.62;

/** Downscale and re-encode, preferring WebP and falling back to JPEG. */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, BG_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const encode = (type) => new Promise((res) => canvas.toBlob(res, type, BG_QUALITY));
  // Safari only learned canvas WebP in 16.4; anything older silently hands
  // back a PNG, which would be far bigger than the original.
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg");
  return blob;
}

async function uploadBackground(file) {
  const blob = await shrinkImage(file);
  if (!blob) throw new Error("Could not read that image.");
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const path = `bg-${Date.now()}-${uid()}.${ext}`;
  const { error } = await supabase.storage
    .from(BG_BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
  if (error) throw error;
  return supabase.storage.from(BG_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** The arena background, optionally with a photo faded in behind it. */
function arenaBgFor(url) {
  if (!url) return arenaBg;
  return `radial-gradient(115% 70% at 0% 0%, ${C.magenta}1F, transparent 58%),
   radial-gradient(115% 70% at 100% 0%, ${C.cyan}1C, transparent 58%),
   linear-gradient(${C.base}E8, ${C.base}E8),
   url("${url}") center / cover no-repeat, ${C.base}`;
}

const TABS = ["groups", "matches", "table", "bracket", "players"];
const TAB_KEY = "bx:tab";

/** Last tab this device was on, so a refresh doesn't bounce you to Groups. */
function initialTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (TABS.includes(saved)) return saved;
  } catch (e) { /* private mode */ }
  return "table";
}

function scoreOf(m) {
  let s1 = 0, s2 = 0;
  (m.events || []).forEach((e) => (e.side === 1 ? (s1 += e.pts) : (s2 += e.pts)));
  return { s1, s2 };
}

function winnerOf(m) {
  if (!m) return null;
  if (m.p1 && !m.p2) return m.p1;
  if (m.p2 && !m.p1) return m.p2;
  if (!m.done) return null;
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

function computeStandings(playerIds, matches, nameOf) {
  const rec = {};
  playerIds.forEach((id) => {
    rec[id] = { id, played: 0, wins: 0, losses: 0, pf: 0, pa: 0, winMargin: 0 };
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
  });
  return Object.values(rec).sort(
    (x, y) =>
      y.wins - x.wins ||
      y.winMargin - x.winMargin ||
      (y.pf - y.pa) - (x.pf - x.pa) ||
      y.pf - x.pf ||
      nameOf(x.id).localeCompare(nameOf(y.id))
  );
}

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
  for (let r = 0; r < rounds.length - 1; r++) {
    rounds[r].forEach((m, i) => {
      const w = winnerOf(m);
      const tgt = rounds[r + 1][Math.floor(i / 2)];
      const slot = i % 2 === 0 ? "p1" : "p2";
      if (tgt[slot] !== w) { tgt[slot] = w; tgt.events = []; tgt.done = false; }
    });
  }
  rounds[0].forEach((m) => {
    if ((m.p1 && !m.p2) || (m.p2 && !m.p1)) m.done = true;
  });

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

const arenaBg = `radial-gradient(115% 70% at 0% 0%, ${C.magenta}1F, transparent 58%),
   radial-gradient(115% 70% at 100% 0%, ${C.cyan}1C, transparent 58%), ${C.base}`;

const Style = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap');
    .bx { font-family: 'Barlow', system-ui, sans-serif; }
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
    /* Undo sits in the sheet header on desktop, but within thumb reach on phones. */
    .bx-undo-fab { display: none; }
    @media (max-width: 640px) {
      .bx-undo-fab { display: inline-flex; }
      .bx-undo-head { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { .bx *, .bx-enter { animation: none !important; transition: none !important; } }
  `}</style>
);

const shell = { background: arenaBg, backgroundAttachment: "fixed", color: C.ink, minHeight: "100vh" };

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

/* ================================================================== */
/*  App                                                                */
/* ================================================================== */

export default function App() {
  const [t, setT] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [scoring, setScoring] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [role, setRole] = useState("spectator");
  const [showGate, setShowGate] = useState(false);
  const [live, setLive] = useState(false);
  const isAdmin = role === "admin";

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* private mode */ }
  }, [tab]);

  useEffect(() => {
    (async () => {
      const saved = await store.load();
      if (saved) setT(saved);
      setLoaded(true);
    })();

    // Supabase's own session is the source of truth for admin access —
    // not anything held in this browser's state.
    supabase.auth.getSession().then(({ data }) => {
      setRole(data.session ? "admin" : "spectator");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setRole(session ? "admin" : "spectator");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Spectators get pushed updates instead of polling; the admin's own
    // edits stay authoritative so they don't get overwritten mid-edit.
    return store.subscribe(
      (incoming) => { if (!isAdmin) setT(incoming); },
      (status) => setLive(status === "SUBSCRIBED")
    );
  }, [isAdmin]);

  // Phones drop websockets when the screen locks or the tab goes background.
  // Coming back into view re-reads once, so you never stare at a stale board.
  useEffect(() => {
    if (isAdmin) return;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await store.load();
      if (fresh) setT(fresh);
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [isAdmin]);

  // Fallback only for when realtime never connected — a slow poll rather than
  // a dead scoreboard. Costs nothing while the websocket is healthy.
  useEffect(() => {
    if (isAdmin || live) return;
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const fresh = await store.load();
      if (fresh) setT(fresh);
    }, 30000);
    return () => clearInterval(id);
  }, [isAdmin, live]);

  useEffect(() => {
    if (!loaded || !t || !isAdmin) return;
    store.save(t);
  }, [t, loaded, isAdmin]);

  const nameOf = useMemo(() => {
    const map = {};
    (t?.players || []).forEach((p) => (map[p.id] = p.name));
    return (id) => map[id] || "—";
  }, [t]);

  if (!loaded) {
    return (
      <div className="bx" style={{ ...shell, display: "grid", placeItems: "center" }}>
        <Style /><span style={{ color: C.muted }}>Loading…</span>
      </div>
    );
  }

  if (!t) {
    if (!isAdmin) {
      return (
        <>
          <Style />
          <NotLive onUnlock={() => setShowGate(true)} />
          {showGate && <AdminGate onClose={() => setShowGate(false)}
            onPass={() => setShowGate(false)} />}
        </>
      );
    }
    return <><Style /><Setup onCreate={(v) => { setT(v); setTab("groups"); }} /></>;
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
    <div className="bx" style={{ ...shell, background: arenaBgFor(t.bgUrl) }}>
      <Style />

      <header style={{
        position: "sticky", top: 0, zIndex: 20, background: C.base,
        borderBottom: `1px solid ${C.line}`, padding: "13px 16px",
        display: "flex", alignItems: "center", gap: 12,
      }}>
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
            {!isAdmin && (
              <span title={live ? "Updating live" : "Reconnecting…"} style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: live ? C.green : C.muted,
                boxShadow: live ? `0 0 6px ${C.green}` : "none",
              }} />
            )}
            <span>{t.players.length} bladers · {t.groups.length} group{t.groups.length > 1 ? "s" : ""} · top {t.advance} advance</span>
          </div>
        </div>
        <button
          onClick={() => (isAdmin ? supabase.auth.signOut() : setShowGate(true))}
          aria-label={isAdmin ? "Leave admin mode" : "Enter admin mode"}
          className="bx-d"
          style={{
            background: isAdmin ? `${C.magenta}1F` : "transparent",
            border: `1px solid ${isAdmin ? C.magenta : C.line}`,
            color: isAdmin ? C.magenta : C.muted, cursor: "pointer",
            padding: "6px 9px", borderRadius: 3, fontSize: 13, fontWeight: 700,
            display: "flex", alignItems: "center", gap: 5,
          }}>
          {isAdmin ? <Unlock size={14} /> : <Lock size={14} />}
          {isAdmin ? "Admin" : "View"}
        </button>
        {isAdmin && (
          <button onClick={() => setShowSetup(true)} aria-label="Tournament settings"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 6 }}>
            <Settings size={20} />
          </button>
        )}
      </header>

      <main style={{ padding: "18px 16px 96px", maxWidth: 720, margin: "0 auto" }}>
        {tab === "groups" && <GroupsView t={t} update={update} nameOf={nameOf} isAdmin={isAdmin} />}
        {tab === "matches" && <MatchesView t={t} nameOf={nameOf} isAdmin={isAdmin}
          onScore={(id) => setScoring({ kind: "group", id })} />}
        {tab === "table" && <TableView t={t} nameOf={nameOf} update={update} isAdmin={isAdmin} onPlayer={setDetail} />}
        {tab === "bracket" && <BracketView t={t} nameOf={nameOf} isAdmin={isAdmin}
          onScore={(id) => setScoring({ kind: "ko", id })} />}
        {tab === "players" && <PlayersView t={t} nameOf={nameOf} allMatches={allMatches} onPlayer={setDetail} />}
      </main>

      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20,
        background: C.surface, borderTop: `1px solid ${C.line}`,
        display: "grid", gridTemplateColumns: "repeat(5,1fr)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        {[
          ["groups", Users, "Groups"],
          ["matches", Swords, "Matches"],
          ["table", Table2, "Table"],
          ["bracket", GitBranch, "Bracket"],
          ["players", Trophy, "Bladers"],
        ].map(([k, Icon, label]) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)}
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
          onReset={() => { setT(null); setShowSetup(false); }} />
      )}
      {showGate && (
        <AdminGate onClose={() => setShowGate(false)} onPass={() => setShowGate(false)} />
      )}
    </div>
  );
}

/* ================================================================== */
/*  Background picker                                                  */
/* ================================================================== */

function BackgroundPicker({ value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so picking the same file twice still fires
    if (!file) return;
    setErr(""); setNote(""); setBusy(true);
    try {
      const url = await uploadBackground(file);
      onChange(url);
      setNote(`Shrunk from ${(file.size / 1048576).toFixed(1)}MB before upload.`);
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
          background: value ? `url("${value}") center / cover no-repeat` : C.base,
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
  const [bulk, setBulk] = useState("");
  const [players, setPlayers] = useState([]);
  const [entry, setEntry] = useState("");
  const [numGroups, setNumGroups] = useState(2);
  const [advance, setAdvance] = useState(2);
  const [koSize, setKoSize] = useState(8);
  const [third, setThird] = useState(true);
  const [points, setPoints] = useState(defaultPoints());
  const [bgUrl, setBgUrl] = useState(null);

  const addPlayer = () => {
    const n = entry.trim();
    if (!n) return;
    setPlayers((p) => [...p, { id: uid(), name: n }]);
    setEntry("");
  };
  const addBulk = () => {
    const names = bulk.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setPlayers((p) => [...p, ...names.map((n) => ({ id: uid(), name: n }))]);
    setBulk("");
  };

  const qualifiers = numGroups * advance;
  const tooMany = koSize > 0 && qualifiers > koSize;
  const byes = koSize > 0 ? Math.max(0, koSize - qualifiers) : 0;
  const ready = players.length >= numGroups * 2 && name.trim() && !tooMany;

  const create = () => {
    const groups = Array.from({ length: numGroups }, (_, i) => ({
      id: "g" + i, name: "Group " + GROUP_LETTERS[i], playerIds: [],
    }));
    onCreate({
      name: name.trim(), players, groups, points, advance,
      koSize, thirdPlace: third, groupMatches: [], bracket: null, bgUrl,
    });
  };

  return (
    <div className="bx" style={{ ...shell, background: arenaBgFor(bgUrl) }}>
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

        <Field label="Background image (optional)"
          hint="Your event poster or a hall photo, faded far back behind the scoreboard. Resized in your browser before upload, so a big photo costs spectators nothing.">
          <BackgroundPicker value={bgUrl} onChange={setBgUrl} />
        </Field>

        <Field label={`Bladers (${players.length})`}>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={inputStyle} value={entry} onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPlayer()} placeholder="Add a name" />
            <Btn onClick={addPlayer} tone="primary" style={{ flexShrink: 0 }}><Plus size={16} />Add</Btn>
          </div>
          {players.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
              {players.map((p) => (
                <span key={p.id} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, background: C.surface,
                  border: `1px solid ${C.line}`, borderRadius: 3, padding: "6px 9px", fontSize: 14,
                }}>
                  {p.name}
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
            placeholder="Or paste a list — one name per line" />
          {bulk.trim() && <Btn onClick={addBulk} style={{ marginTop: 6 }}>Add pasted names</Btn>}
        </Field>

        <Field label="Number of groups">
          <Segmented value={numGroups} onChange={setNumGroups}
            options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: String(n) }))} />
        </Field>

        <Field label="Bladers advancing from each group">
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

        <Btn onClick={create} tone="primary" disabled={!ready}
          style={{ width: "100%", justifyContent: "center", padding: 15, fontSize: 18, marginTop: 8 }}>
          Create tournament <ChevronRight size={18} />
        </Btn>
        {!ready && players.length < numGroups * 2 && (
          <div style={{ color: C.muted, fontSize: 13, marginTop: 10, textAlign: "center" }}>
            Add at least {numGroups * 2} bladers for {numGroups} groups.
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
  };

  const moveTo = (playerId, gid) => {
    update((d) => {
      d.groups.forEach((g) => (g.playerIds = g.playerIds.filter((x) => x !== playerId)));
      if (gid) d.groups.find((g) => g.id === gid).playerIds.push(playerId);
      d.groupMatches = buildGroupMatches(d.groups, d.groupMatches);
      return d;
    });
    setMoving(null);
  };

  return (
    <div>
      <SectionHead title="Groups"
        sub={isAdmin
          ? "Tap a blader to move them. Results between two bladers who stay in the same group are kept."
          : "Who's in which group."}
        action={isAdmin ? <Btn onClick={draw} tone="primary"><Shuffle size={15} />Random draw</Btn> : null} />

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
          <div style={{ fontSize: 13.5, marginBottom: 9 }}>Move <strong>{nameOf(moving)}</strong> to</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {t.groups.map((g) => <Btn key={g.id} onClick={() => moveTo(moving, g.id)}>{g.name}</Btn>)}
            <Btn onClick={() => moveTo(moving, null)} tone="ghost">Unassign</Btn>
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
                  <Chip key={id} onClick={isAdmin ? () => setMoving(id) : undefined} active={moving === id}>{nameOf(id)}</Chip>
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

function MatchesView({ t, nameOf, onScore, isAdmin }) {
  if (!t.groupMatches.length) {
    return <EmptyState title="No fixtures yet"
      body="Make the group draw first — fixtures build themselves as soon as bladers are in groups." />;
  }
  return (
    <div>
      <SectionHead title="Group matches"
        sub={`Everyone plays everyone in their group, first to ${t.points.group}.` + (isAdmin ? " Tap a match to score it." : "")} />
      {t.groups.map((g, gi) => {
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

function MatchRow({ m, nameOf, onClick, label, locked }) {
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
      }}>{m.p2 ? nameOf(m.p2) : (m.p1 ? "Bye" : "TBD")}</span>
    </button>
  );
}

/* ================================================================== */
/*  Standings                                                          */
/* ================================================================== */

function TableView({ t, nameOf, update, onPlayer, isAdmin }) {
  const allPlayed = t.groupMatches.length > 0 && t.groupMatches.every((m) => m.done);

  const makeBracket = () => update((d) => {
    const quals = collectQualifiers(d.groups, d.groupMatches, d.advance, nameOf);
    d.bracket = buildBracket(quals, d.koSize, d.thirdPlace);
    return d;
  });

  if (!t.groupMatches.length) {
    return <EmptyState title="No standings yet" body="Draw the groups and the tables appear here." />;
  }

  return (
    <div>
      <SectionHead title="Standings" color={C.cyan}
        sub="Ranked by wins, then by total margin across won matches only. Tap a name for that blader's record." />

      {t.groups.map((g, gi) => {
        const ms = t.groupMatches.filter((m) => m.groupId === g.id);
        const rows = computeStandings(g.playerIds, ms, nameOf);
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
                    {["", "Blader", "P", "W", "L", "Margin", "+/−"].map((h, i) => (
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
                    const q = i < t.advance;
                    return (
                      <tr key={r.id} onClick={() => onPlayer(r.id)} style={{ cursor: "pointer" }}>
                        <td style={{ ...td, textAlign: "center", color: q ? C.gold : C.muted, fontWeight: 800, width: 26 }}>{i + 1}</td>
                        <td style={{ ...td, textAlign: "left", fontWeight: q ? 600 : 400, whiteSpace: "nowrap" }}>{nameOf(r.id)}</td>
                        <td style={td}>{r.played}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{r.wins}</td>
                        <td style={td}>{r.losses}</td>
                        <td style={{ ...td, color: C.cyan, fontWeight: 700 }}>{r.winMargin}</td>
                        <td style={{ ...td, color: C.muted }}>{r.pf - r.pa > 0 ? "+" : ""}{r.pf - r.pa}</td>
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
          <Btn onClick={makeBracket} tone={allPlayed ? "primary" : "default"}>
            <GitBranch size={15} />{t.bracket ? "Rebuild bracket" : "Build bracket"}
          </Btn>
        </div>
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
              <MatchRow key={m.id} m={m} nameOf={nameOf} locked={!isAdmin} onClick={() => onScore(m.id)} label={`M${i + 1}`} />
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
  const s1 = events.filter((e) => e.side === 1).reduce((a, e) => a + e.pts, 0);
  const s2 = events.filter((e) => e.side === 2).reduce((a, e) => a + e.pts, 0);
  const over = s1 >= target || s2 >= target;

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
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 60, background: arenaBgFor(t.bgUrl),
      backgroundAttachment: "fixed", overflowY: "auto",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
        borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, background: C.base, zIndex: 2,
      }}>
        <button onClick={onClose} aria-label="Back"
          style={{ background: "none", border: "none", color: C.ink, cursor: "pointer", display: "flex", padding: 4 }}>
          <ArrowLeft size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bx-d" style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.05 }}>First to {target}</div>
          <div style={{ fontSize: 11.5, color: C.muted }}>{stageLabel}</div>
        </div>
        <Btn onClick={() => setEvents([])} tone="ghost" style={{ padding: "7px 11px" }}>Reset</Btn>
        <span className="bx-undo-head">
          <Btn onClick={() => setEvents((v) => v.slice(0, -1))} tone="ghost" disabled={!events.length}
            style={{ padding: "7px 11px" }} aria-label="Undo last finish"><Undo2 size={15} /></Btn>
        </span>
      </div>

      {events.length > 0 && (
        <button
          onClick={() => setEvents((v) => v.slice(0, -1))}
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
          <Btn onClick={onClose} tone="ghost" style={{ flex: 1, justifyContent: "center", padding: 14 }}>Cancel</Btn>
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
      <SectionHead title="Bladers" color={C.green}
        sub="Every match a blader has played, group stage and knockout together. Tap for the full record." />
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

  const Stat = ({ label, value, color }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 3, padding: "11px 12px" }}>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 3 }}>{label}</div>
      <div className="bx-d" style={{ fontSize: 26, fontWeight: 800, color: color || C.ink, lineHeight: 1 }}>{value}</div>
    </div>
  );

  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 60, background: arenaBgFor(t.bgUrl),
      backgroundAttachment: "fixed", overflowY: "auto",
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

function SettingsSheet({ t, update, onClose, onReset }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 60, background: arenaBgFor(t.bgUrl),
      backgroundAttachment: "fixed", overflowY: "auto",
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

        <Field label="Background image"
          hint="Faded far behind the scoreboard. Resized in your browser before upload, so spectators load about 100KB no matter how big the original is.">
          <BackgroundPicker value={t.bgUrl || null}
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
          <div className="bx-d" style={{ fontSize: 19, fontWeight: 700, marginBottom: 5 }}>Start over</div>
          <div style={{ color: C.muted, fontSize: 13.5, marginBottom: 13, lineHeight: 1.5, maxWidth: "56ch" }}>
            Deletes this tournament and everything in it, then takes you back to setup.
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
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Access control                                                     */
/* ================================================================== */

/**
 * Real sign-in against Supabase auth. Success here only unlocks the admin
 * UI locally — the "tournaments" table's row-level security policies are
 * what actually reject writes from anyone without a valid session.
 */
function AdminGate({ onClose, onPass }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setWrong(false);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setWrong(true); setErrMsg(error.message); } else onPass();
  };

  return (
    <div className="bx" style={{
      position: "fixed", inset: 0, zIndex: 80, background: "#0B0718EE",
      display: "grid", placeItems: "center", padding: 20,
    }}>
      <div style={{
        width: "100%", maxWidth: 380, background: C.surface,
        border: `1px solid ${C.line}`, borderRadius: 4, padding: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <Blade color={C.magenta} h={24} />
          <h2 className="bx-d" style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Admin sign-in</h2>
        </div>
        <p style={{ color: C.muted, fontSize: 13.5, margin: "0 0 16px", lineHeight: 1.5 }}>
          Sign in to run the draw, score matches, and change settings.
        </p>
        <input
          style={{ ...inputStyle, marginBottom: 10, borderColor: wrong ? C.magenta : C.line }}
          type="email" value={email} autoFocus autoComplete="username"
          onChange={(e) => { setEmail(e.target.value); setWrong(false); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Email"
        />
        <input
          style={{ ...inputStyle, borderColor: wrong ? C.magenta : C.line }}
          type="password" value={password} autoComplete="current-password"
          onChange={(e) => { setPassword(e.target.value); setWrong(false); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Password"
        />
        {wrong && (
          <div style={{ color: C.magenta, fontSize: 13, marginTop: 8 }}>
            {errMsg || "Sign-in failed. Try again."}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <Btn onClick={onClose} tone="ghost" style={{ flex: 1, justifyContent: "center", padding: 12 }}>Cancel</Btn>
          <Btn onClick={submit} tone="primary" disabled={busy} style={{ flex: 1, justifyContent: "center", padding: 12 }}>
            {busy ? "Signing in…" : "Sign in"}
          </Btn>
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
