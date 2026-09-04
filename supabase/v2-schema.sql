-- =====================================================================
--  v2 — accounts, many tournaments, referees, formats
--
--  Additive on purpose. The existing `tournaments` table and its
--  policies are not touched, so the live app keeps serving Xtreme
--  Clash S2 while this is built alongside it.
--
--  Run the whole file once in the Supabase SQL editor.
-- =====================================================================

-- ---------------------------------------------------------------- profiles

create table if not exists profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text,
  display_name text,
  approved     boolean not null default false,  -- may host tournaments
  is_staff     boolean not null default false,  -- may approve other hosts
  created_at   timestamptz not null default now()
);

alter table profiles enable row level security;

-- Every account gets a profile, unapproved. Signing up is therefore safe on
-- its own: it grants the ability to be *added* as a referee, nothing more.
--
-- Deliberately not a trigger on auth.users. That schema belongs to Supabase
-- and newer projects refuse `create trigger` on it — and because the SQL
-- editor runs a script in one transaction, that single refusal rolls the
-- whole file back. The app calls this once after signing in instead.
create or replace function public.ensure_profile()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  select u.id, u.email, split_part(coalesce(u.email, ''), '@', 1)
  from auth.users u
  where u.id = auth.uid()
  on conflict (id) do nothing;
end $$;

-- Anyone who signed up before this file ran.
insert into profiles (id, email, display_name)
select id, email, split_part(coalesce(email, ''), '@', 1) from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------- events

create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users on delete cascade,
  name       text not null,
  format     text not null default 'knockout'
             check (format in ('knockout', 'tag', 'league')),
  data       jsonb not null,
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists event_referees (
  event_id uuid not null references events on delete cascade,
  user_id  uuid not null references auth.users on delete cascade,
  added_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists events_owner_idx on events (owner_id);
create index if not exists event_referees_user_idx on event_referees (user_id);

alter table events enable row level security;
alter table event_referees enable row level security;

-- ------------------------------------------------------- permission helpers
--
-- SECURITY DEFINER on purpose. A policy on `events` that reads
-- `event_referees` while a policy on `event_referees` reads `events`
-- recurses forever; these run as the owner and sidestep that.

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_staff from profiles where id = auth.uid()), false);
$$;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select approved from profiles where id = auth.uid()), false);
$$;

create or replace function public.owns_event(e uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from events where id = e and owner_id = auth.uid());
$$;

create or replace function public.refs_event(e uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from event_referees where event_id = e and user_id = auth.uid());
$$;

-- ---------------------------------------------------------------- policies

-- Scoreboards are public: a spectator scans a QR code and reads, no account.
drop policy if exists "events readable by anyone" on events;
create policy "events readable by anyone" on events for select using (true);

-- Only an approved host may start a tournament, and only in their own name.
drop policy if exists "approved hosts create" on events;
create policy "approved hosts create" on events for insert to authenticated
  with check (owner_id = auth.uid() and public.is_approved());

-- A referee runs the tournament they were given: scores, draws, bracket.
drop policy if exists "owner or referee edits" on events;
create policy "owner or referee edits" on events for update to authenticated
  using (owner_id = auth.uid() or public.refs_event(id))
  with check (owner_id = auth.uid() or public.refs_event(id));

drop policy if exists "owner deletes" on events;
create policy "owner deletes" on events for delete to authenticated
  using (owner_id = auth.uid());

-- Referees can see their own grants; owners see everyone they invited.
drop policy if exists "grants visible to both sides" on event_referees;
create policy "grants visible to both sides" on event_referees for select
  using (user_id = auth.uid() or public.owns_event(event_id));

drop policy if exists "owner grants access" on event_referees;
create policy "owner grants access" on event_referees for insert to authenticated
  with check (public.owns_event(event_id));

drop policy if exists "owner revokes access" on event_referees;
create policy "owner revokes access" on event_referees for delete to authenticated
  using (public.owns_event(event_id));

drop policy if exists "profiles readable by self and staff" on profiles;
create policy "profiles readable by self and staff" on profiles for select
  using (id = auth.uid() or public.is_staff());

drop policy if exists "profiles updatable by self" on profiles;
create policy "profiles updatable by self" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- --------------------------------------------------- column-level privileges
--
-- The policies above are not enough on their own.
--
-- A referee passes the events UPDATE check, and nothing in that check stops
-- them setting owner_id to themselves — which would hand them the tournament
-- outright. Likewise a user passes the profiles UPDATE check and could set
-- their own approved or is_staff to true. Policies decide which *rows* are
-- writable; only column grants decide which *columns* are.

revoke all on events from authenticated, anon;
grant select on events to authenticated, anon;
grant insert on events to authenticated;
grant update (name, format, data, archived) on events to authenticated;
grant delete on events to authenticated;

revoke all on event_referees from authenticated, anon;
grant select, insert, delete on event_referees to authenticated;

revoke all on profiles from authenticated, anon;
grant select on profiles to authenticated;
grant update (display_name) on profiles to authenticated;

-- ------------------------------------------------------------- staff actions

-- Approving a host is a staff action, so it goes through a function rather
-- than a column grant nobody else may hold.
create or replace function public.set_approved(target uuid, value boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may approve hosts';
  end if;
  update profiles set approved = value where id = target;
end $$;

-- Hosts add referees by email, which needs a lookup they cannot do directly
-- because profiles are private. Returns nothing at all to anyone who is not
-- an approved host, so it cannot be used to probe who has an account.
create or replace function public.find_user(p_email text)
returns table (id uuid, email text, display_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name
  from profiles p
  where lower(p.email) = lower(trim(p_email))
    and public.is_approved();
$$;

-- Who referees an event, with names. Owners cannot read other people's
-- profiles directly and should not be able to, so the guard is inside: the
-- list comes back only to the owner of that event.
create or replace function public.event_referee_list(p_event uuid)
returns table (user_id uuid, email text, display_name text, added_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.user_id, p.email, p.display_name, r.added_at
  from event_referees r
  join profiles p on p.id = r.user_id
  where r.event_id = p_event and public.owns_event(p_event)
  order by r.added_at;
$$;

-- The public directory: every live tournament with the name of whoever runs
-- it. Definer because profiles are not readable by a visitor and should not
-- be — this hands back display names and never email addresses.
create or replace function public.public_events()
returns table (
  id uuid, name text, format text, owner_id uuid,
  organiser text, created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, e.format, e.owner_id,
         coalesce(nullif(trim(p.display_name), ''), 'Organiser'),
         e.created_at, e.updated_at
  from events e
  left join profiles p on p.id = e.owner_id
  where not e.archived
  order by e.created_at desc;
$$;

-- Staff need the pending list to act on it.
create or replace function public.pending_hosts()
returns table (id uuid, email text, display_name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.created_at
  from profiles p
  where not p.approved and public.is_staff()
  order by p.created_at;
$$;

-- ------------------------------------------------------------------ upkeep

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists events_touch on events;
create trigger events_touch before update on events
  for each row execute function public.touch_updated_at();

-- Spectators follow along without polling. Catching everything, not just a
-- repeat run: the whole file is one transaction, and realtime is not worth
-- rolling the schema back over. The app polls as a fallback regardless.
do $$
begin
  alter publication supabase_realtime add table events;
exception when others then
  raise notice 'realtime not enabled for events (%), the poll still covers it', sqlerrm;
end $$;

-- =====================================================================
--  Last step, and it must be you: make yourself staff and approved,
--  or nobody can approve anybody.
--
--    update profiles
--       set approved = true, is_staff = true
--     where email = 'your-account@example.com';
-- =====================================================================
