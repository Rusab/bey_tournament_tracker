-- =====================================================================
--  Decks, in their own table.
--
--  Until now a deck lived inside its tournament's data, which anyone can
--  read, so a deck could be dug out before the tournament began. Here
--  each deck is a row of its own, and the database decides who sees it:
--
--    the tournament's host and referees    always
--    the blader linked to that player      always
--    the parts manager                     always (for the Unknown names check)
--    everybody else                        once a match has been scored
--
--  And who may change it:
--
--    the host and referees                 at any time
--    the linked blader                     until the tournament starts
--
--  A tournament has started once any match in it holds a score.
--
--  Existing decks are moved out of the tournament data when this runs,
--  and a trigger keeps any deck an old copy of the app writes into the
--  data out of it from then on.
--
--  Run the whole file once in the SQL editor; safe to re-run. Needs
--  v2-schema.sql and parts-schema.sql to have run first.
-- =====================================================================

-- ------------------------------------------------------------- helpers

create or replace function public.runs_event(e uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.owns_event(e) or public.refs_event(e);
$$;

-- Started: any group, league or knockout match holds a finish.
create or replace function public.event_started(e uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_path_exists(data, '$.groupMatches[*].events[0]')
        or jsonb_path_exists(data, '$.bracket.rounds[*][*].events[0]')
        or jsonb_path_exists(data, '$.bracket.third.events[0]')
    from events where id = e), false);
$$;

-- Whether the signed-in account is linked to this player: the blader, or a
-- member of the team.
create or replace function public.deck_is_mine(e uuid, p text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from events ev, jsonb_array_elements(coalesce(ev.data->'players', '[]'::jsonb)) pl
    where ev.id = e and pl->>'id' = p
      and (pl->>'profileId' = auth.uid()::text
           or coalesce(pl->'memberIds', '[]'::jsonb) ? auth.uid()::text));
$$;

revoke execute on function public.runs_event(uuid) from public;
revoke execute on function public.event_started(uuid) from public;
revoke execute on function public.deck_is_mine(uuid, text) from public;
grant execute on function public.runs_event(uuid) to anon, authenticated;
grant execute on function public.event_started(uuid) to anon, authenticated;
grant execute on function public.deck_is_mine(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------- decks

create table if not exists event_decks (
  event_id   uuid not null references events on delete cascade,
  player_id  text not null,
  deck       jsonb not null,
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id),

  constraint decks_shape check (jsonb_typeof(deck) = 'array' and jsonb_array_length(deck) between 1 and 4),
  constraint decks_size check (pg_column_size(deck) < 8000)
);

alter table event_decks enable row level security;

drop policy if exists "decks seen when allowed" on event_decks;
create policy "decks seen when allowed" on event_decks for select
  using (public.runs_event(event_id) or public.deck_is_mine(event_id, player_id)
         or public.event_started(event_id) or public.is_parts_manager());

drop policy if exists "decks added when allowed" on event_decks;
create policy "decks added when allowed" on event_decks for insert to authenticated
  with check (public.runs_event(event_id)
              or (public.deck_is_mine(event_id, player_id) and not public.event_started(event_id)));

drop policy if exists "decks changed when allowed" on event_decks;
create policy "decks changed when allowed" on event_decks for update to authenticated
  using (public.runs_event(event_id)
         or (public.deck_is_mine(event_id, player_id) and not public.event_started(event_id)))
  with check (public.runs_event(event_id)
              or (public.deck_is_mine(event_id, player_id) and not public.event_started(event_id)));

drop policy if exists "decks removed when allowed" on event_decks;
create policy "decks removed when allowed" on event_decks for delete to authenticated
  using (public.runs_event(event_id)
         or (public.deck_is_mine(event_id, player_id) and not public.event_started(event_id)));

revoke all on event_decks from anon, authenticated;
grant select on event_decks to anon, authenticated;
grant insert (event_id, player_id, deck) on event_decks to authenticated;
grant update (deck) on event_decks to authenticated;
grant delete on event_decks to authenticated;

-- Who changed it and when is recorded by the database, never sent in.
create or replace function public.decks_stamp()
returns trigger language plpgsql as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists decks_stamp on event_decks;
create trigger decks_stamp before insert or update on event_decks
  for each row execute function public.decks_stamp();

-- ------------------------------------------- decks out of the public data
--
-- Any deck found in a tournament's data is copied into event_decks - unless
-- that player already has a row there, so an old copy of the app cannot
-- overwrite a newer deck - and then taken out of the data.

create or replace function public.events_move_decks()
returns trigger language plpgsql security definer set search_path = public as $$
declare pl jsonb;
begin
  if jsonb_typeof(new.data->'players') = 'array'
     and jsonb_path_exists(new.data, '$.players[*].deck') then
    if tg_op = 'UPDATE' then
      for pl in select x from jsonb_array_elements(new.data->'players') x loop
        if pl ? 'id' and jsonb_typeof(pl->'deck') = 'array'
           and jsonb_array_length(pl->'deck') between 1 and 4 then
          insert into event_decks (event_id, player_id, deck)
          values (new.id, pl->>'id', pl->'deck')
          on conflict (event_id, player_id) do nothing;
        end if;
      end loop;
    end if;
    new.data := jsonb_set(new.data, '{players}', (
      select coalesce(jsonb_agg(x - 'deck' order by i), '[]'::jsonb)
      from jsonb_array_elements(new.data->'players') with ordinality as t(x, i)));
  end if;
  return new;
end $$;

drop trigger if exists events_move_decks on events;
create trigger events_move_decks before insert or update of data on events
  for each row execute function public.events_move_decks();

-- Moves every deck already in a tournament's data.
update events set data = data where jsonb_path_exists(data, '$.players[*].deck');

-- What it made: decks moved, and decks still left in the data (should be 0).
select (select count(*) from event_decks) as decks,
       (select count(*) from events where jsonb_path_exists(data, '$.players[*].deck')) as left_in_data;
