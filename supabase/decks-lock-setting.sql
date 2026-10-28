-- =====================================================================
--  Bladers' own deck editing follows the tournament's
--  "Lock bladers' own decks" setting instead of simply locking at the
--  start. The app ticks it when the first match is scored and unticks
--  it if every score is cleared; organisers can untick it by hand.
--
--  Safe to re-run. Needs decks-schema.sql to have run first. (Already in
--  decks-schema.sql for a fresh database.)
-- =====================================================================

-- Whether bladers' own deck editing is locked. The tournament's
-- "Lock bladers' own decks" setting (decksLocked in its data) decides;
-- a tournament saved before that setting existed is locked once started.
create or replace function public.decks_locked(e uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select case when jsonb_typeof(data->'decksLocked') = 'boolean'
                               then (data->>'decksLocked')::boolean end
                   from events where id = e), public.event_started(e));
$$;
revoke execute on function public.decks_locked(uuid) from public;
grant execute on function public.decks_locked(uuid) to anon, authenticated;

drop policy if exists "decks added when allowed" on event_decks;
create policy "decks added when allowed" on event_decks for insert to authenticated
  with check (public.runs_event(event_id)
              or (public.deck_is_mine(event_id, player_id) and not public.decks_locked(event_id)));

drop policy if exists "decks changed when allowed" on event_decks;
create policy "decks changed when allowed" on event_decks for update to authenticated
  using (public.runs_event(event_id)
         or (public.deck_is_mine(event_id, player_id) and not public.decks_locked(event_id)))
  with check (public.runs_event(event_id)
              or (public.deck_is_mine(event_id, player_id) and not public.decks_locked(event_id)));

drop policy if exists "decks removed when allowed" on event_decks;
create policy "decks removed when allowed" on event_decks for delete to authenticated
  using (public.runs_event(event_id)
         or (public.deck_is_mine(event_id, player_id) and not public.decks_locked(event_id)));

