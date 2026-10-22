-- =====================================================================
--  Series: tournaments ranked together, a saga or a lifetime ranking.
--
--  A series has an owner and any number of tournaments. A tournament can
--  sit in more than one series. It counts in a series only once both the
--  series' owner and the tournament's host have agreed to it - whoever
--  asks has agreed already, so there is never more than one person to
--  wait for, and nobody waits at all when they own both.
--
--  Joining and leaving go through functions, which decide whose consent
--  a call carries. Nobody can write membership rows directly, so nobody
--  can mark consent on someone else's behalf.
--
--  Additive only. Run once in the SQL editor; safe to re-run. Needs the
--  v2 schema (events, is_approved) and profiles-schema.sql (bladers).
-- =====================================================================

create table if not exists series (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  constraint series_name_len check (char_length(btrim(name)) between 1 and 80)
);

create table if not exists series_events (
  series_id    uuid not null references series on delete cascade,
  event_id     uuid not null references events on delete cascade,
  owner_ok     boolean not null default false,   -- the series' owner has agreed
  host_ok      boolean not null default false,   -- the tournament's host has agreed
  requested_by uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  primary key (series_id, event_id)
);

create index if not exists series_events_event_idx on series_events (event_id);

alter table series enable row level security;
alter table series_events enable row level security;

-- Rankings are public, so which tournaments make up a series is too.
drop policy if exists "series readable by anyone" on series;
create policy "series readable by anyone" on series for select using (true);
drop policy if exists "series members readable by anyone" on series_events;
create policy "series members readable by anyone" on series_events for select using (true);

-- Only an approved host starts a series, and only in their own name: the
-- owner comes from the default, and is not a column anyone may write.
drop policy if exists "hosts start series" on series;
create policy "hosts start series" on series for insert to authenticated
  with check (owner_id = auth.uid() and public.is_approved());
drop policy if exists "owners rename series" on series;
create policy "owners rename series" on series for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "owners delete series" on series;
create policy "owners delete series" on series for delete to authenticated
  using (owner_id = auth.uid());

revoke all on series, series_events from authenticated, anon;
grant select on series, series_events to anon, authenticated;
grant insert (name) on series to authenticated;
grant update (name) on series to authenticated;
grant delete on series to authenticated;
-- series_events: read only. Every change goes through the functions below.

-- ------------------------------------------------------ joining and leaving

-- Ask for a tournament to be in a series, or agree to it. The call carries
-- the consent of whoever makes it: the series' owner, the tournament's
-- host, or both. Anyone else is refused. Returns 'approved' or 'pending'.
create or replace function public.series_link(p_series uuid, p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s_owner uuid;
  e_owner uuid;
  result text;
begin
  select owner_id into s_owner from series where id = p_series;
  if s_owner is null then raise exception 'no such series'; end if;
  select owner_id into e_owner from events where id = p_event;
  if e_owner is null then raise exception 'no such tournament'; end if;
  if me is null or (me <> s_owner and me <> e_owner) then
    raise exception 'only the series owner or the tournament''s host can do that';
  end if;

  insert into series_events (series_id, event_id, owner_ok, host_ok, requested_by)
  values (p_series, p_event, me = s_owner, me = e_owner, me)
  on conflict (series_id, event_id) do update
    set owner_ok = series_events.owner_ok or excluded.owner_ok,
        host_ok  = series_events.host_ok  or excluded.host_ok;

  select case when owner_ok and host_ok then 'approved' else 'pending' end into result
  from series_events where series_id = p_series and event_id = p_event;
  return result;
end $$;

-- Take a tournament out of a series, or turn down a request. Either side
-- may: the series' owner, or the tournament's host.
create or replace function public.series_remove(p_series uuid, p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s_owner uuid;
  e_owner uuid;
begin
  select owner_id into s_owner from series where id = p_series;
  select owner_id into e_owner from events where id = p_event;
  if me is null or (me is distinct from s_owner and me is distinct from e_owner) then
    raise exception 'only the series owner or the tournament''s host can do that';
  end if;
  delete from series_events where series_id = p_series and event_id = p_event;
end $$;

revoke execute on function public.series_link(uuid, uuid) from public, anon;
revoke execute on function public.series_remove(uuid, uuid) from public, anon;
grant execute on function public.series_link(uuid, uuid) to authenticated;
grant execute on function public.series_remove(uuid, uuid) to authenticated;

-- What is waiting on the person asking: requests whose missing consent is
-- theirs to give. Not security definer - everything it reads is public -
-- so it can show nobody anything they could not read for themselves.
create or replace function public.series_requests()
returns table (
  series_id uuid, series_name text, event_id uuid, event_name text,
  event_host text, series_owner text, asks text
)
language sql stable set search_path = public as $$
  select se.series_id, s.name, se.event_id, e.name,
         coalesce(nullif(btrim(bh.blader_name), ''), 'Organiser'),
         coalesce(nullif(btrim(bo.blader_name), ''), 'Organiser'),
         case when not se.owner_ok and s.owner_id = auth.uid() then 'series' else 'tournament' end
  from series_events se
  join series s on s.id = se.series_id
  join events e on e.id = se.event_id
  left join bladers bh on bh.id = e.owner_id
  left join bladers bo on bo.id = s.owner_id
  where (not se.owner_ok and s.owner_id = auth.uid())
     or (not se.host_ok and e.owner_id = auth.uid())
  order by se.created_at;
$$;
