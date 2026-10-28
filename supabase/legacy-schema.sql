-- =====================================================================
--  Legacy tournaments: ones played before (or outside) the app.
--
--  Only their podium is recorded - who came 1st, 2nd and 3rd - and the
--  deck each of them used, so they count on the Meta page too.
--
--    legacy_events   the tournament: name, date, organiser, singles or tag
--    legacy_places   one podium place: the place, the blader (linked to
--                    their profile, or just a name), and their deck
--
--  Who may do what:
--
--    everyone                          read them
--    an account with medal access      add, change and remove them
--    a blader on the podium            change their own deck there, any time
--
--  Run the whole file once in the SQL editor; safe to re-run. Needs
--  medals-schema.sql (for is_awarder) to have run first.
-- =====================================================================

create table if not exists legacy_events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  organiser   text,
  played_on   date,
  format      text not null default 'single',
  created_by  uuid default auth.uid() references auth.users on delete set null,
  created_at  timestamptz not null default now(),

  constraint legacy_events_name check (char_length(btrim(name)) between 1 and 80),
  constraint legacy_events_organiser check (organiser is null or char_length(organiser) <= 80),
  constraint legacy_events_format check (format in ('single', 'tag'))
);

create table if not exists legacy_places (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references legacy_events on delete cascade,
  place       int not null,
  name        text not null,
  blader_id   uuid references bladers on delete set null,
  -- For a tag team: the other member, who may edit the deck too.
  teammate_id uuid references bladers on delete set null,
  deck        jsonb,
  deck_by     uuid references auth.users on delete set null,
  deck_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint legacy_places_place check (place between 1 and 3),
  constraint legacy_places_name check (char_length(btrim(name)) between 1 and 60),
  constraint legacy_places_deck check (deck is null
    or (jsonb_typeof(deck) = 'array' and jsonb_array_length(deck) between 1 and 4)),
  constraint legacy_places_deck_size check (deck is null or pg_column_size(deck) < 8000)
);
create index if not exists legacy_places_event on legacy_places (event_id);

alter table legacy_events enable row level security;
alter table legacy_places enable row level security;

-- ------------------------------------------------------------- events

drop policy if exists "legacy events readable" on legacy_events;
create policy "legacy events readable" on legacy_events for select using (true);

drop policy if exists "legacy events added by awarder" on legacy_events;
create policy "legacy events added by awarder" on legacy_events for insert to authenticated
  with check (public.is_awarder());

drop policy if exists "legacy events changed by awarder" on legacy_events;
create policy "legacy events changed by awarder" on legacy_events for update to authenticated
  using (public.is_awarder()) with check (public.is_awarder());

drop policy if exists "legacy events removed by awarder" on legacy_events;
create policy "legacy events removed by awarder" on legacy_events for delete to authenticated
  using (public.is_awarder());

revoke all on legacy_events from anon, authenticated;
grant select on legacy_events to anon, authenticated;
grant insert (name, organiser, played_on, format) on legacy_events to authenticated;
grant update (name, organiser, played_on, format) on legacy_events to authenticated;
grant delete on legacy_events to authenticated;

-- ------------------------------------------------------------- places

drop policy if exists "legacy places readable" on legacy_places;
create policy "legacy places readable" on legacy_places for select using (true);

drop policy if exists "legacy places added by awarder" on legacy_places;
create policy "legacy places added by awarder" on legacy_places for insert to authenticated
  with check (public.is_awarder());

-- The awarder changes anything; a blader on the podium only their deck
-- (the trigger below holds them to that).
drop policy if exists "legacy places changed" on legacy_places;
create policy "legacy places changed" on legacy_places for update to authenticated
  using (public.is_awarder() or auth.uid() in (blader_id, teammate_id))
  with check (public.is_awarder() or auth.uid() in (blader_id, teammate_id));

drop policy if exists "legacy places removed by awarder" on legacy_places;
create policy "legacy places removed by awarder" on legacy_places for delete to authenticated
  using (public.is_awarder());

revoke all on legacy_places from anon, authenticated;
grant select on legacy_places to anon, authenticated;
grant insert (event_id, place, name, blader_id, teammate_id, deck) on legacy_places to authenticated;
grant update (place, name, blader_id, teammate_id, deck) on legacy_places to authenticated;
grant delete on legacy_places to authenticated;

-- A blader may change their deck and nothing else; who changed a deck, and
-- when, is recorded by the database.
create or replace function public.legacy_places_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_awarder() and (new.event_id, new.place, new.name, new.blader_id, new.teammate_id)
       is distinct from (old.event_id, old.place, old.name, old.blader_id, old.teammate_id) then
    raise exception 'Only the deck can be changed here.';
  end if;
  if new.deck is distinct from old.deck then
    new.deck_by := auth.uid();
    new.deck_at := now();
  end if;
  return new;
end $$;

drop trigger if exists legacy_places_guard on legacy_places;
create trigger legacy_places_guard before update on legacy_places
  for each row execute function public.legacy_places_guard();

select (select count(*) from legacy_events) as legacy_tournaments,
       (select count(*) from legacy_places) as podium_places;
