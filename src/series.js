/*
 * A series' grand total: the confirmed final ranking of every tournament in
 * it, added together blader by blader.
 *
 * Only confirmed rankings count. A tournament whose ranking has not been
 * confirmed yet is reported as waiting, not quietly ranked on whatever its
 * results happen to say today. Each tournament's totals are taken as it
 * confirmed them, with its own weights.
 *
 * The same blader is recognised across tournaments by the profile their
 * player was linked to. A player with no profile is known by their name; if
 * that name belongs to exactly one profiled blader elsewhere in the series,
 * the two are the same person and are merged. If it could be more than one,
 * they are left apart rather than guessed at.
 */

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;

/** Who a ranking row stands for, the same way in every tournament it appears in. */
export function identityOf(data, row) {
  const p = ((data && data.players) || []).find((x) => x.id === row.id);
  if (p && p.members && p.members.length) return { key: `team:${norm(p.name)}`, team: true };
  if (p && p.profileId) return { key: `profile:${p.profileId}`, profileId: p.profileId };
  return { key: `name:${norm(row.name)}`, byName: true };
}

/**
 * events: [{ id, name, created_at, data }], in any order.
 * Returns { rows, counted, waiting }: rows ranked 1, 2, 2, 3 by grand total;
 * counted, the tournaments that went into it; waiting, those still without a
 * confirmed ranking.
 */
export function seriesRanking(events) {
  const ordered = [...(events || [])].sort((a, b) =>
    String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const counted = [], waiting = [];
  const rec = new Map();

  ordered.forEach((e) => {
    const fr = e.data && e.data.finalRanking;
    if (!fr || !Array.isArray(fr.rows) || !fr.rows.length) { waiting.push(e); return; }
    counted.push(e);
    fr.rows.forEach((r) => {
      const who = identityOf(e.data, r);
      if (!rec.has(who.key)) {
        rec.set(who.key, {
          key: who.key, profileId: who.profileId || null, byName: !!who.byName, team: !!who.team,
          name: r.name, names: new Set(), total: 0, played: 0, wins: 0, margin: 0, results: [],
        });
      }
      const x = rec.get(who.key);
      x.name = r.name;                       // the newest tournament's spelling wins
      x.names.add(norm(r.name));
      x.total += num(r.total);
      x.played += num(r.played);
      x.wins += num(r.wins);
      x.margin += num(r.margin);
      x.results.push({ eventId: e.id, event: e.name, rank: r.rank, total: num(r.total) });
    });
  });

  // A name with no profile joins the one profiled blader who went by it.
  [...rec.values()].filter((x) => x.byName).forEach((x) => {
    const n = x.key.slice("name:".length);
    const owners = [...rec.values()].filter((y) => y.profileId && y.names.has(n));
    if (owners.length !== 1) return;
    const y = owners[0];
    y.total += x.total; y.played += x.played; y.wins += x.wins; y.margin += x.margin;
    y.results = [...x.results, ...y.results];
    rec.delete(x.key);
  });

  const rows = [...rec.values()].map((x) => ({
    key: x.key, profileId: x.profileId, byName: x.byName, team: x.team, name: x.name,
    total: round2(x.total), played: x.played, wins: x.wins, margin: round2(x.margin),
    tournaments: x.results.length,
    best: Math.min(...x.results.map((r) => num(r.rank) || Infinity)),
    results: x.results,
  }));

  rows.sort((a, b) =>
    b.total - a.total || b.wins - a.wins || b.margin - a.margin || a.name.localeCompare(b.name));

  // Equal grand totals share a rank, and the next takes the next number.
  let rank = 0, prev = null;
  rows.forEach((r) => {
    if (prev === null || r.total !== prev) rank += 1;
    r.rank = rank;
    prev = r.total;
  });

  return { rows, counted, waiting };
}
