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

export function onAuthChange(fn) {
  const { data } = supabase.auth.onAuthStateChange((_e, session) => fn(session || null));
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

/* -------------------------------------------------------------------- staff */

export async function pendingHosts() {
  const { data, error } = await supabase.rpc("pending_hosts");
  if (error) { console.error(error); return []; }
  return data || [];
}

export const approveHost = (id, value) =>
  supabase.rpc("set_approved", { target: id, value });
