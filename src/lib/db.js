import { supabase } from "./supabase.js";

/*
 * Everything the app knows about accounts and stored tournaments.
 *
 * None of this is where permission is decided. The database decides, through
 * row policies and column grants, and these calls simply fail if they overstep.
 * What is here is only what the interface needs in order to not offer someone
 * a button that would be refused.
 */

/* ------------------------------------------------------------------ account */

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

/** Called with the session and the event that changed it, such as PASSWORD_RECOVERY. */
export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => fn(session || null, event));
  return () => data.subscription.unsubscribe();
}

export const signIn = (email, password) =>
  supabase.auth.signInWithPassword({ email: email.trim(), password });

/*
 * The confirmation link has to come back to whatever host this is running on.
 * Without a redirect given here, Supabase falls back to the project's Site
 * URL, which ships as http://localhost:3000 - so the link in the email walks
 * the new account off the live site and onto a machine that is not there, and
 * the address never gets confirmed.
 *
 * origin rather than a constant, so a signup from the workers.dev address and
 * one from a custom domain each come back to where they started. The URL must
 * still be on the project's redirect allow list; anything else is ignored and
 * falls back to the Site URL again.
 */
export const signUp = (email, password, { bladerName, realName } = {}) =>
  supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: window.location.origin,
      // Kept with the account until its first sign-in, when ensure_profile
      // copies them into place — there is no profile row to write to before
      // the address has been confirmed.
      data: { blader_name: bladerName || null, real_name: realName || null },
    },
  });

export const signOut = () => supabase.auth.signOut();

/*
 * The link in the email comes back to /reset, an address of its own, so the
 * app knows a reset is under way from where it landed. Supabase also says so
 * with an event, but only once and while still starting, which can be before
 * anything is listening. Covered by the allow-listed /** redirect.
 */
export const sendPasswordReset = (email) =>
  supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/reset`,
  });

/** Needs the session the reset link signs the person in with. */
export const setPassword = (password) => supabase.auth.updateUser({ password });

/**
 * The profile row is created here rather than by a trigger on auth.users,
 * which Supabase owns and newer projects refuse to let anyone hook.
 * Safe to call on every sign-in; it does nothing when the row exists.
 */
export async function loadProfile(userId) {
  const { error: rpcError } = await supabase.rpc("ensure_profile");
  if (rpcError) console.error(rpcError);

  /*
   * Filtered by id deliberately, rather than leaning on the row policy to
   * return one row. That policy is "your own row, or any row if you are
   * staff" — so for a staff account it returns everybody, maybeSingle fails
   * on the extra rows, and the profile comes back null. Which reads as "not
   * approved for hosting", on the one account that certainly is.
   */
  const { data, error } = await supabase
    .from("profiles").select("id, email, display_name, approved, is_staff")
    .eq("id", userId).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

export const setDisplayName = (name) =>
  supabase.from("profiles").update({ display_name: name }).select().maybeSingle();

/* -------------------------------------------------------------- tournaments */

const EVENT_COLS = "id, owner_id, name, format, archived, created_at, updated_at";

/**
 * Everything this account can act on: what they host, and what they referee.
 * Two queries rather than one, because a referee cannot see other people's
 * rows through a join they have no policy for.
 */
export async function myEvents(userId) {
  const mine = await supabase
    .from("events").select(EVENT_COLS).eq("owner_id", userId)
    .order("updated_at", { ascending: false });
  if (mine.error) { console.error(mine.error); return []; }

  const grants = await supabase.from("event_referees").select("event_id").eq("user_id", userId);
  if (grants.error) { console.error(grants.error); return mine.data.map(withRole("owner")); }

  const ids = grants.data.map((g) => g.event_id).filter((id) => !mine.data.some((e) => e.id === id));
  if (!ids.length) return mine.data.map(withRole("owner"));

  const reffed = await supabase
    .from("events").select(EVENT_COLS).in("id", ids)
    .order("updated_at", { ascending: false });
  if (reffed.error) { console.error(reffed.error); return mine.data.map(withRole("owner")); }

  return [...mine.data.map(withRole("owner")), ...reffed.data.map(withRole("referee"))];
}

const withRole = (role) => (e) => ({ ...e, role });

/**
 * Every live tournament, with the name of whoever runs it — the front door,
 * open to anyone. Archived ones are left out.
 */
export async function publicEvents() {
  const { data, error } = await supabase.rpc("public_events");
  if (error) { console.error(error); return []; }
  return data || [];
}

/** The whole tournament. Readable by anyone — a spectator needs no account. */
export async function loadEvent(id) {
  const { data, error } = await supabase
    .from("events").select(`${EVENT_COLS}, data`).eq("id", id).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

export async function createEvent({ name, format, data }) {
  const session = await currentSession();
  if (!session) return { error: new Error("Not signed in.") };
  const { data: row, error } = await supabase
    .from("events")
    .insert({ owner_id: session.user.id, name, format, data })
    .select(EVENT_COLS).maybeSingle();
  return { row, error };
}

/** Owners and referees both land here; the database decides which succeed. */
export async function saveEvent(id, patch) {
  const { data, error } = await supabase
    .from("events").update(patch).eq("id", id).select("updated_at").maybeSingle();
  if (error) { console.error(error); return null; }
  return data ? data.updated_at : null;
}

/** Just the timestamp — what the fallback poll asks for between changes. */
export async function eventStamp(id) {
  const { data, error } = await supabase
    .from("events").select("updated_at").eq("id", id).maybeSingle();
  if (error) return null;
  return data ? data.updated_at : null;
}

export const archiveEvent = (id, archived) => saveEvent(id, { archived });

export const deleteEvent = (id) => supabase.from("events").delete().eq("id", id);

/**
 * Realtime is the fast path, never the only one. A connected socket is not
 * proof that changes are arriving — a table missing from the publication
 * connects happily and then says nothing — so callers poll regardless.
 */
export function subscribeEvent(id, onChange, onStatus) {
  const ch = supabase
    .channel(`event:${id}`)
    .on("postgres_changes",
        { event: "*", schema: "public", table: "events", filter: `id=eq.${id}` },
        (payload) => { if (payload.new && payload.new.data) onChange(payload.new.data, payload.new.updated_at); })
    .subscribe((status) => { if (onStatus) onStatus(status); });
  return () => supabase.removeChannel(ch);
}

/* ----------------------------------------------------------------- referees */

/**
 * Owners cannot read other people's profiles — correctly — so the names come
 * back through a function that checks ownership of this event and nothing else.
 */
export async function eventReferees(eventId) {
  const { data, error } = await supabase.rpc("event_referee_list", { p_event: eventId });
  if (error) { console.error(error); return []; }
  return (data || []).map((r) => ({
    userId: r.user_id, email: r.email, name: r.display_name, addedAt: r.added_at,
  }));
}

/** Referees are invited by the address they signed up with. */
export async function addReferee(eventId, email) {
  const { data, error } = await supabase.rpc("find_user", { p_email: email });
  if (error) return { error };
  const found = Array.isArray(data) ? data[0] : data;
  if (!found) return { error: new Error("Nobody has signed up with that address yet.") };

  const ins = await supabase.from("event_referees").insert({ event_id: eventId, user_id: found.id });
  if (ins.error) {
    if (ins.error.code === "23505") return { error: new Error("They already have access.") };
    return { error: ins.error };
  }
  return { user: found };
}

/**
 * The same, for someone chosen from the bladers list rather than looked up by
 * email: the list already says who they are. The row policy still checks
 * that only the tournament's owner can grant it.
 */
export async function addRefereeById(eventId, userId) {
  const { error } = await supabase.from("event_referees").insert({ event_id: eventId, user_id: userId });
  if (!error) return {};
  if (error.code === "23505") return { error: new Error("They already have access.") };
  return { error };
}

export const removeReferee = (eventId, userId) =>
  supabase.from("event_referees").delete().eq("event_id", eventId).eq("user_id", userId);

/* ------------------------------------------------------------------ bladers */

/*
 * The public half of every account. The private half — email and real name —
 * stays in profiles, and a real name only ever comes back through
 * blader_real_name(), which returns nothing to anyone not allowed to see it.
 */

const BLADER_COLS = "id, blader_name, experience_years, favorite_combo, photo_path, created_at";
const AVATARS = "avatars";

/** Everyone registered, by name. Null if the list could not be loaded at all. */
export async function listBladers() {
  const { data, error } = await supabase
    .from("bladers").select(BLADER_COLS).order("blader_name");
  if (error) { console.error(error); return null; }
  return data || [];
}

export async function loadBlader(id) {
  const { data, error } = await supabase
    .from("bladers").select(BLADER_COLS).eq("id", id).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

/** A real name, or null for anyone the database will not show it to. */
export async function bladerRealName(id) {
  const { data, error } = await supabase.rpc("blader_real_name", { p_id: id });
  if (error) return null;
  return data || null;
}

/**
 * Whether nobody else has this name. Null when it could not be checked, in
 * which case the save is still refused by the database if it is taken.
 */
export async function bladerNameFree(name, except = null) {
  const { data, error } = await supabase.rpc("blader_name_free", { p_name: name, p_except: except });
  if (error) return null;
  return !!data;
}

/** No row back with no error means the row policy refused it. */
export async function saveBlader(id, patch) {
  const { data, error } = await supabase
    .from("bladers").update(patch).eq("id", id).select(BLADER_COLS).maybeSingle();
  if (error) return { error };
  if (!data) return { error: new Error("That profile could not be saved.") };
  return { row: data };
}

export async function saveRealName(id, realName) {
  const { error } = await supabase.from("profiles").update({ real_name: realName }).eq("id", id);
  return { error };
}

export const avatarUrl = (path) =>
  path ? supabase.storage.from(AVATARS).getPublicUrl(path).data.publicUrl : null;

/** Into the account's own folder — storage refuses any other. Returns the path. */
export async function uploadAvatar(userId, blob) {
  const ext = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }[blob.type] || "bin";
  const path = `${userId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(AVATARS).upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
  if (error) throw error;
  return path;
}

/** Best effort: a stray old photo costs a few kilobytes, not a broken profile. */
export async function removeAvatar(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(AVATARS).remove([path]);
  if (error) console.error(error);
}

/** Blader names for a handful of ids, as { id: name }. */
export async function bladerNames(ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return {};
  const { data, error } = await supabase.from("bladers").select("id, blader_name").in("id", want);
  if (error) { console.error(error); return {}; }
  return Object.fromEntries(data.map((r) => [r.id, r.blader_name]));
}

/* ------------------------------------------------------------------ linking */

/**
 * The profile behind an email, as { blader: { id, blader_name } }, or
 * { blader: null } when there is none — or none this account may look up. The
 * email itself never comes back. Answers approved hosts, and the owner and
 * referees of the tournament named.
 */
export async function findBlader(email, eventId = null) {
  const { data, error } = await supabase.rpc("find_blader", { p_email: email, p_event: eventId });
  if (error) return { error };
  const row = Array.isArray(data) ? data[0] : data;
  return { blader: row || null };
}

/**
 * Everyone registered, for choosing from. Real names come back only for
 * someone allowed to see them; for anyone else that field is null. Falls
 * back to the plain public list, without real names, if the function has not
 * been installed yet — the picker still works, matching on blader names alone.
 */
export async function bladerDirectory() {
  const { data, error } = await supabase.rpc("blader_directory");
  if (!error) return data || [];
  const plain = await listBladers();
  return plain ? plain.map((b) => ({ ...b, real_name: null })) : null;
}

/** Every tournament this blader was linked into, newest first, with its data. */
export async function bladerEvents(id) {
  const { data, error } = await supabase.rpc("blader_events", { p_id: id });
  if (error) { console.error(error); return null; }
  return data || [];
}

/* ------------------------------------------------------------------- series */

/*
 * A series ranks tournaments together. A tournament is in one once both the
 * series' owner and the tournament's host have agreed; series_link carries
 * the consent of whoever calls it, so the same call both asks and approves.
 */

const MEMBER_COLS = "series_id, event_id, owner_ok, host_ok, series:series_id(id, name, owner_id)";

/** Every series these tournaments are in, or have been asked into. */
export async function seriesOfEvents(eventIds) {
  if (!eventIds.length) return [];
  const { data, error } = await supabase.from("series_events").select(MEMBER_COLS).in("event_id", eventIds);
  if (error) { console.error(error); return null; }
  return data || [];
}

export async function loadSeries(id) {
  const { data, error } = await supabase
    .from("series").select("id, name, owner_id, created_at").eq("id", id).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

/** The tournaments in a series, with their data, newest first. */
export async function seriesEvents(seriesId) {
  const members = await supabase.from("series_events")
    .select("event_id, owner_ok, host_ok").eq("series_id", seriesId);
  if (members.error) { console.error(members.error); return null; }
  const ids = members.data.map((m) => m.event_id);
  if (!ids.length) return [];
  const evs = await supabase.from("events")
    .select("id, name, owner_id, created_at, format, data").in("id", ids)
    .order("created_at", { ascending: false });
  if (evs.error) { console.error(evs.error); return null; }
  const byId = Object.fromEntries(members.data.map((m) => [m.event_id, m]));
  return evs.data.map((e) => ({ ...e, approved: byId[e.id].owner_ok && byId[e.id].host_ok, ...byId[e.id] }));
}

/** Every tournament there is, archived ones included, for choosing one to link to. */
export async function everyEvent() {
  const { data, error } = await supabase
    .from("events").select("id, name, owner_id, created_at, format, archived")
    .order("created_at", { ascending: false });
  if (error) { console.error(error); return null; }
  return data || [];
}

export async function startSeries(name) {
  const { data, error } = await supabase.from("series").insert({ name }).select("id, name, owner_id").maybeSingle();
  if (error) return { error };
  if (!data) return { error: new Error("The series could not be started.") };
  return { series: data };
}

/** Ask, or agree. Returns { status: "approved" | "pending" }. */
export async function linkToSeries(seriesId, eventId) {
  const { data, error } = await supabase.rpc("series_link", { p_series: seriesId, p_event: eventId });
  if (error) return { error };
  return { status: data };
}

/** Take a tournament out, or turn a request down. */
export async function removeFromSeries(seriesId, eventId) {
  const { error } = await supabase.rpc("series_remove", { p_series: seriesId, p_event: eventId });
  return { error };
}

export async function deleteSeries(id) {
  const { error } = await supabase.from("series").delete().eq("id", id);
  return { error };
}

/** Requests waiting on this account's agreement. */
export async function seriesRequests() {
  const { data, error } = await supabase.rpc("series_requests");
  if (error) return [];
  return data || [];
}

/* ------------------------------------------------------------------- medals */

/*
 * Entered by hand, and only by an account given medal access — a permission
 * of its own, separate from hosting and from staff. The database enforces it;
 * these calls just fail for anyone else.
 */

const MEDAL_COLS = "id, blader_id, place, tournament_name, organiser_name, season, teammate_id, awarded_by, created_at";
// Categories came later; a database without that script reads the medals without them.
const MEDAL_COLS_NOW = MEDAL_COLS + ", category";

export async function listMedals(bladerId) {
  const ask = (cols) => supabase
    .from("medals").select(cols).eq("blader_id", bladerId)
    .order("created_at", { ascending: false });
  let { data, error } = await ask(MEDAL_COLS_NOW);
  if (error) ({ data, error } = await ask(MEDAL_COLS));
  if (error) { console.error(error); return null; }
  return data || [];
}

/** False on any failure, which includes the medals script not having run yet. */
export async function amAwarder() {
  const { data, error } = await supabase.rpc("is_awarder");
  if (error) return false;
  return !!data;
}

/**
 * One row per blader. A tag team medal goes to both members in the same
 * statement, so either both get it or neither does, each naming the other.
 */
export async function addMedal({ bladerId, teammateId, place, category, tournamentName, organiserName, season }) {
  const base = { place, category, tournament_name: tournamentName, organiser_name: organiserName, season };
  const rows = [{ ...base, blader_id: bladerId, teammate_id: teammateId || null }];
  if (teammateId) rows.push({ ...base, blader_id: teammateId, teammate_id: bladerId });
  const { error } = await supabase.from("medals").insert(rows);
  return { error };
}

export async function removeMedal(id) {
  const { data, error } = await supabase.from("medals").delete().eq("id", id).select("id");
  if (error) return { error };
  if (!data || !data.length) return { error: new Error("That medal could not be removed.") };
  return {};
}

/* ------------------------------------------------- medals sent for approval */

/*
 * Any blader can send a medal in, with a photo of each side as proof. It
 * waits, seen only by them and the medal approver, until it is approved -
 * which writes the real medal - or turned down. Either way the photos are
 * deleted. The photos are private: they are shown through links that
 * expire, never a public address.
 */

const PROOFS = "medal-proofs";
export const CLAIM_LIMIT = 5;
const CLAIM_COLS = "id, blader_id, place, category, tournament_name, organiser_name, season, teammate_id, front_path, back_path, created_at";

/** This blader's medals waiting for approval. Null if they could not be loaded. */
export async function myMedalClaims(userId) {
  const { data, error } = await supabase
    .from("medal_claims").select(CLAIM_COLS).eq("blader_id", userId)
    .order("created_at", { ascending: false });
  if (error) return null;
  return data || [];
}

/** Everything waiting, oldest first. Only the approver gets anything back. */
export async function medalClaimsWaiting() {
  const { data, error } = await supabase
    .from("medal_claims").select(CLAIM_COLS).order("created_at", { ascending: true });
  if (error) { console.error(error); return null; }
  return data || [];
}

export async function medalClaimCount() {
  const { count, error } = await supabase
    .from("medal_claims").select("id", { count: "exact", head: true });
  return error ? 0 : count || 0;
}

async function uploadProof(userId, blob, side) {
  const ext = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }[blob.type] || "bin";
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${side}.${ext}`;
  const { error } = await supabase.storage.from(PROOFS).upload(path, blob, { contentType: blob.type });
  if (error) throw error;
  return path;
}

/**
 * Deletes photos whose claim is settled, then clears them off the list.
 * The list only lets go of a photo once its file is really gone, so
 * anything that fails here is tried again next time.
 */
async function dropProofs(paths) {
  if (!paths || !paths.length) return;
  const { error } = await supabase.storage.from(PROOFS).remove(paths);
  if (error) { console.error(error); return; }
  await supabase.rpc("clear_proof_trash", { p_paths: paths });
}

/** Photos left over from an earlier delete that did not finish. */
export async function sweepProofs() {
  const { data, error } = await supabase.rpc("proof_trash");
  if (!error && data && data.length) await dropProofs(data);
}

export async function submitMedalClaim(userId, c, front, back) {
  const up = [];
  try {
    up.push(await uploadProof(userId, front, "front"));
    up.push(await uploadProof(userId, back, "back"));
  } catch (err) {
    if (up.length) await supabase.storage.from(PROOFS).remove(up);
    return { error: new Error("The photos could not be uploaded. Try again.") };
  }
  const { error } = await supabase.rpc("submit_medal_claim", {
    p_place: c.place, p_category: c.category, p_tournament: c.tournamentName,
    p_organiser: c.organiserName, p_season: c.season, p_teammate: c.teammateId || null,
    p_front: up[0], p_back: up[1],
  });
  if (error) {
    await supabase.storage.from(PROOFS).remove(up);   // sent for nothing
    return { error };
  }
  return {};
}

export async function withdrawMedalClaim(id) {
  const { data, error } = await supabase.rpc("withdraw_medal_claim", { p_id: id });
  if (error) return { error };
  await dropProofs(data);
  return {};
}

/** The approver's decision. The photos go either way. */
export async function reviewMedalClaim(id, approve) {
  const { data, error } = await supabase.rpc("review_medal_claim", { p_id: id, p_approve: approve });
  if (error) return { error };
  await dropProofs(data);
  return {};
}

/** Links to the private photos, good for ten minutes. */
export async function proofLinks(paths) {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(PROOFS).createSignedUrls(paths, 600);
  if (error || !data) return {};
  const out = {};
  data.forEach((d) => { if (d.signedUrl) out[d.path] = d.signedUrl; });
  return out;
}

/* -------------------------------------------------------------------- parts */

/*
 * The parts catalogue. Everyone reads it; only the account given parts
 * access changes it. Pictures are public, in their own bucket.
 */

const PART_COLS = "id, kind, name, abbr, fused, metal, aliases, image_path, updated_at";
const PART_IMAGES = "part-images";

/** Null if it could not be loaded, which includes the parts script not having run. */
export async function loadParts() {
  const { data, error } = await supabase.from("parts").select(PART_COLS);
  if (error) return null;
  return data || [];
}

export async function amPartsManager() {
  const { data, error } = await supabase.rpc("is_parts_manager");
  if (error) return false;
  return !!data;
}

/** A new part when there is no id. No row back with no error means the policy refused it. */
export async function savePart(id, fields) {
  const q = id
    ? supabase.from("parts").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id)
    : supabase.from("parts").insert(fields);
  const { data, error } = await q.select(PART_COLS).maybeSingle();
  if (error) {
    return { error: error.code === "23505" ? new Error("There is already a part by that name.") : error };
  }
  if (!data) return { error: new Error("That part could not be saved.") };
  return { row: data };
}

export async function deletePart(id) {
  const { data, error } = await supabase.from("parts").delete().eq("id", id).select("id");
  if (error) return { error };
  if (!data || !data.length) return { error: new Error("That part could not be deleted.") };
  return {};
}

export const partImageUrl = (path) =>
  path ? supabase.storage.from(PART_IMAGES).getPublicUrl(path).data.publicUrl : null;

export async function uploadPartImage(kind, blob) {
  const ext = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }[blob.type] || "bin";
  const path = `${kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from(PART_IMAGES).upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
  if (error) throw error;
  return path;
}

export async function removePartImage(path) {
  if (path) await supabase.storage.from(PART_IMAGES).remove([path]);
}

/** Every tournament's decks, for finding part names typed into them. */
export async function allTournamentDecks() {
  const rows = await supabase.from("event_decks").select("event_id, player_id, deck");
  if (!rows.error) {
    const ids = [...new Set(rows.data.map((r) => r.event_id))];
    const names = ids.length ? await supabase.from("events").select("id, name").in("id", ids) : { data: [] };
    const nameOf = Object.fromEntries((names.data || []).map((e) => [e.id, e.name]));
    return ids.map((id) => ({
      id, name: nameOf[id] || "A tournament",
      players: rows.data.filter((r) => r.event_id === id).map((r) => ({ id: r.player_id, deck: r.deck })),
    }));
  }
  // Before decks-schema.sql has run, decks are still in the tournament data.
  const { data, error } = await supabase.from("events").select("id, name, data");
  if (error) { console.error(error); return null; }
  return (data || []).map((e) => ({
    id: e.id, name: e.name,
    players: ((e.data && e.data.players) || []).filter((p) => p.deck && p.deck.length),
  }));
}

/* -------------------------------------------------------------------- decks */

/*
 * Decks live in their own table, and the database decides who sees one:
 * the tournament's organisers and the linked blader always, everyone else
 * once a match has been scored. Null back means the table is not there
 * yet, and decks are still kept in the tournament data.
 */

/** { playerId: deck } for one tournament, holding only the decks this account may see. */
export async function loadDecks(eventId) {
  const { data, error } = await supabase.from("event_decks").select("player_id, deck").eq("event_id", eventId);
  if (error) return null;
  return Object.fromEntries((data || []).map((r) => [r.player_id, r.deck]));
}

/** { eventId: { playerId: deck } } for several tournaments. */
export async function decksForEvents(eventIds) {
  if (!eventIds.length) return {};
  const { data, error } = await supabase.from("event_decks").select("event_id, player_id, deck").in("event_id", eventIds);
  if (error) return null;
  const out = {};
  (data || []).forEach((r) => { (out[r.event_id] = out[r.event_id] || {})[r.player_id] = r.deck; });
  return out;
}

/** An empty deck removes the row. Refused when the database does not allow this account to change it. */
export async function saveDeck(eventId, playerId, deck) {
  if (!deck || !deck.length) {
    const { error } = await supabase.from("event_decks").delete().eq("event_id", eventId).eq("player_id", playerId);
    return { error };
  }
  const up = await supabase.from("event_decks").update({ deck })
    .eq("event_id", eventId).eq("player_id", playerId).select("player_id");
  if (up.error) return { error: up.error };
  if (up.data && up.data.length) return {};
  const ins = await supabase.from("event_decks").insert({ event_id: eventId, player_id: playerId, deck });
  if (ins.error) {
    return { error: ins.error.code === "42501"
      ? new Error("This deck can no longer be changed here: the tournament has started.") : ins.error };
  }
  return {};
}

/* -------------------------------------------------------------------- staff */

export async function pendingHosts() {
  const { data, error } = await supabase.rpc("pending_hosts");
  if (error) { console.error(error); return []; }
  return data || [];
}

export const approveHost = (id, value) =>
  supabase.rpc("set_approved", { target: id, value });

/* ---------------------------------------------------------------- detection */

/*
 * Deck photo detection. References are lists of numbers describing what
 * each blade looks like; the database names the closest blades to a bey.
 * Photos bladers send in sit in a private bucket until the parts manager
 * approves them (they become references) or turns them down (deleted).
 */

const DECK_PHOTOS = "deck-photos";
export const DECK_PHOTO_LIMIT = 10;

/** The closest blades to one bey, best first. Null if detection is not set up. */
export async function matchParts(vector, model, count = 3) {
  const { data, error } = await supabase.rpc("match_parts", { p_query: vector, p_model: model, p_count: count });
  if (error) { console.error(error); return null; }
  return data || [];
}

/** { partId: { catalogue, photos } }. Null if the detection script has not run. */
export async function refCounts(model) {
  const { data, error } = await supabase.rpc("part_ref_counts", { p_model: model });
  if (error) return null;
  return Object.fromEntries((data || []).map((r) => [r.part_id, { catalogue: r.catalogue, photos: r.photos }]));
}

/** Swaps a part's catalogue references for new ones. Photo references stay. */
export async function replaceCatalogueRefs(partId, model, vectors) {
  const del = await supabase.from("part_refs").delete()
    .eq("part_id", partId).eq("source", "catalogue").eq("model", model);
  if (del.error) return { error: del.error };
  if (!vectors.length) return {};
  const { error } = await supabase.from("part_refs").insert(
    vectors.map((embedding) => ({ part_id: partId, source: "catalogue", model, embedding })));
  return error ? { error } : {};
}

/** Sends a confirmed deck photo in for checking. boxes carry their part_id and numbers (e). */
export async function submitDeckPhoto(userId, blob, boxes, model) {
  const ext = { "image/webp": "webp", "image/jpeg": "jpg" }[blob.type] || "jpg";
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const up = await supabase.storage.from(DECK_PHOTOS).upload(path, blob, { contentType: blob.type });
  if (up.error) return { error: new Error("The photo could not be uploaded.") };
  const { error } = await supabase.rpc("submit_deck_photo", { p_path: path, p_boxes: boxes, p_model: model });
  if (error) {
    await supabase.storage.from(DECK_PHOTOS).remove([path]);
    return { error };
  }
  return {};
}

const PHOTO_COLS = "id, user_id, photo_path, boxes, model, created_at";

/** Photos waiting, oldest first. Only the parts manager gets anything back. */
export async function deckPhotosWaiting() {
  const { data, error } = await supabase.from("deck_photos").select(PHOTO_COLS)
    .eq("status", "waiting").order("created_at", { ascending: true }).limit(30);
  if (error) { console.error(error); return null; }
  return data || [];
}

export async function deckPhotoCount() {
  const { count, error } = await supabase.from("deck_photos")
    .select("id", { count: "exact", head: true }).eq("status", "waiting");
  return error ? 0 : count || 0;
}

/** labels: one part id (or null to leave out) per box, or null to keep the blader's. */
export async function reviewDeckPhoto(id, approve, labels = null) {
  const { data, error } = await supabase.rpc("review_deck_photo", { p_id: id, p_approve: approve, p_labels: labels });
  if (error) return { error };
  if (data) await supabase.storage.from(DECK_PHOTOS).remove([data]);
  return {};
}

/** Links to the private photos, good for ten minutes. */
export async function deckPhotoLinks(paths) {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(DECK_PHOTOS).createSignedUrls(paths, 600);
  if (error || !data) return {};
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

/* --------------------------------------------------------------------- meta */

/**
 * Every tournament with its data and its decks, for the meta table. Decks
 * come back only where this viewer may see them - for a visitor, the
 * tournaments that have started. Null if the tournaments could not be loaded.
 */
export async function metaEvents() {
  const { data, error } = await supabase.from("events")
    .select("id, name, created_at, format, data").order("created_at", { ascending: false });
  if (error) { console.error(error); return null; }
  const decks = (await decksForEvents((data || []).map((e) => e.id))) || {};
  return (data || []).map((e) => ({ ...e, decks: decks[e.id] || {} }));
}
