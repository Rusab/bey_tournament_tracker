-- =====================================================================
--  Player profiles, phase 2: medals.
--
--  Medals are entered by hand, and only by accounts given medal access.
--  That access is its own permission: being approved to host does not
--  grant it, and neither does being staff. It is set below for exactly
--  one account.
--
--  Additive only. Run the whole file once in the SQL editor; safe to
--  re-run. Needs profiles-schema.sql to have run first.
-- =====================================================================

-- --------------------------------------------------------- medal access
--
-- Nobody can give it to themselves: users may only write display_name and
-- real_name in profiles, so this column is out of reach of every account.

alter table profiles add column if not exists can_award_medals boolean not null default false;

create or replace function public.is_awarder()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select can_award_medals from profiles where id = auth.uid()), false);
$$;

revoke execute on function public.is_awarder() from public, anon;
grant execute on function public.is_awarder() to authenticated;

-- ---------------------------------------------------------------- medals

create table if not exists medals (
  id              uuid primary key default gen_random_uuid(),
  blader_id       uuid not null references bladers on delete cascade,
  place           text not null,
  tournament_name text not null,
  organiser_name  text not null,
  season          text not null default 'S1',
  -- For a tag team: the other member, who gets a medal row of their own.
  teammate_id     uuid references bladers on delete set null,
  -- Filled in by the database from whoever is signed in. Not writable, so
  -- nobody can record a medal as having come from somebody else.
  awarded_by      uuid default auth.uid() references auth.users on delete set null,
  created_at      timestamptz not null default now(),

  constraint medals_place check (place in ('first', 'second', 'third', 'swiss')),
  constraint medals_tournament_len check (char_length(btrim(tournament_name)) between 1 and 80),
  constraint medals_organiser_len check (char_length(btrim(organiser_name)) between 1 and 60),
  constraint medals_season_len check (char_length(btrim(season)) between 1 and 20),
  constraint medals_not_own_teammate check (teammate_id is null or teammate_id <> blader_id)
);

create index if not exists medals_blader_idx on medals (blader_id);

alter table medals enable row level security;

drop policy if exists "medals readable by anyone" on medals;
create policy "medals readable by anyone" on medals for select using (true);

drop policy if exists "awarders add medals" on medals;
create policy "awarders add medals" on medals for insert to authenticated
  with check (public.is_awarder() and awarded_by = auth.uid());

-- Taken back by whoever gave it, or by staff - and either way only while
-- they still hold medal access.
drop policy if exists "awarders remove medals" on medals;
create policy "awarders remove medals" on medals for delete to authenticated
  using (public.is_awarder() and (awarded_by = auth.uid() or public.is_staff()));

-- No update at all: a mistake is removed and entered again, so a medal is
-- never quietly changed after the fact.
revoke all on medals from authenticated, anon;
grant select on medals to anon, authenticated;
grant insert (blader_id, place, tournament_name, organiser_name, season, teammate_id)
  on medals to authenticated;
grant delete on medals to authenticated;

-- --------------------------------------------------- the one account
--
-- Change the address if medal access should belong to a different
-- account. To give it to someone else later, run the same statement with
-- their address; to take it away, set it to false.

update profiles set can_award_medals = true where email = 'rusabcolabpro@gmail.com';

-- Who holds it now. Should be exactly one row.
select email, can_award_medals from profiles where can_award_medals;
