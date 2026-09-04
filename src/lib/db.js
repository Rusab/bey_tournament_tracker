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

export const signUp = (email, password) =>
  supabase.auth.signUp({ email: email.trim(), password });

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

/* -------------------------------------------------------------------- staff */

export async function pendingHosts() {
  const { data, error } = await supabase.rpc("pending_hosts");
  if (error) { console.error(error); return []; }
  return data || [];
}

export const approveHost = (id, value) =>
  supabase.rpc("set_approved", { target: id, value });
