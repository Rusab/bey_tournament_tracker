-- =====================================================================
--  Player profiles, phase 1.
--
--  Additive only: one new table, one new column, a storage bucket and
--  some functions. Nothing that exists is removed or loosened, so the
--  app keeps working whether or not this has been run.
--
--  Run the whole file once in the Supabase SQL editor. Safe to re-run.
-- =====================================================================

-- ------------------------------------------------------------- real names
--
-- Private, next to the email, because it is private in the same way. The
-- profiles table is readable only by its owner and staff; organisers get at
-- real names through blader_real_name() below, which checks who is asking.

alter table profiles add column if not exists real_name text;

alter table profiles drop constraint if exists profiles_real_name_len;
alter table profiles add constraint profiles_real_name_len
  check (real_name is null or char_length(real_name) <= 80);

-- ---------------------------------------------------------------- bladers
--
-- The public half of a player: everything a stranger may see. One row per
-- account, created by ensure_profile() rather than by the client, so nobody
-- can make a row for somebody else.

create table if not exists bladers (
  id               uuid primary key references auth.users on delete cascade,
  blader_name      text not null,
  experience_years numeric(3,1),
  favorite_combo   text,
  -- A path inside the avatars bucket, never a URL. A URL could point
  -- anywhere, and every visitor's browser would fetch it; a path can only
  -- name a file in the owner's own folder.
  photo_path       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint bladers_name_len
    check (char_length(btrim(blader_name)) between 1 and 30),
  constraint bladers_experience
    check (experience_years is null or (experience_years >= 0 and experience_years <= 50)),
  constraint bladers_combo_len
    check (favorite_combo is null or char_length(favorite_combo) <= 80),
  constraint bladers_photo_own_folder
    check (photo_path is null or photo_path ~ ('^' || id::text || '/[A-Za-z0-9._-]+$'))
);

-- Unique ignoring case and surrounding spaces, so "Rusab" and " rusab " are
-- the same name.
create unique index if not exists bladers_name_unique on bladers (lower(btrim(blader_name)));

alter table bladers enable row level security;

drop policy if exists "bladers readable by anyone" on bladers;
create policy "bladers readable by anyone" on bladers for select using (true);

drop policy if exists "bladers edit own" on bladers;
create policy "bladers edit own" on bladers for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Row policies decide which rows; only column grants decide which columns.
-- No insert grant at all: rows come from ensure_profile().
revoke all on bladers from authenticated, anon;
grant select on bladers to anon, authenticated;
grant update (blader_name, experience_years, favorite_combo, photo_path) on bladers to authenticated;

-- Real name joins display name as the only profile columns a user may write.
grant update (display_name, real_name) on profiles to authenticated;

drop trigger if exists bladers_touch on bladers;
create trigger bladers_touch before update on bladers
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ name helpers

-- Whether a blader name is free, for the sign-up and profile forms. Bladers
-- are public already, so this reveals nothing a visitor could not read.
create or replace function public.blader_name_free(p_name text, p_except uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from bladers b
    where lower(btrim(b.blader_name)) = lower(btrim(p_name))
      and b.id is distinct from p_except
  );
$$;

-- A name nobody else has, for accounts created without choosing one: the
-- base itself if it is free, otherwise "base 2", "base 3" and so on, cut
-- short so the number still fits inside thirty characters.
create or replace function public.free_blader_name(p_base text, p_except uuid default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  base text := coalesce(nullif(btrim(p_base), ''), 'Blader');
  candidate text := left(base, 30);
  n int := 1;
begin
  while exists (
    select 1 from bladers b
    where lower(btrim(b.blader_name)) = lower(btrim(candidate))
      and b.id is distinct from p_except
  ) loop
    n := n + 1;
    candidate := left(base, 30 - char_length(' ' || n)) || ' ' || n;
  end loop;
  return candidate;
end $$;

-- Internal: the client has no use for it.
revoke execute on function public.free_blader_name(text, uuid) from public, anon, authenticated;

-- A real name, but only to someone allowed to see it: the player, an
-- approved host, or staff. Anyone else gets nothing back.
create or replace function public.blader_real_name(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select p.real_name from profiles p
  where p.id = p_id
    and (p_id = auth.uid() or public.is_approved() or public.is_staff());
$$;

revoke execute on function public.blader_real_name(uuid) from public, anon;
grant execute on function public.blader_real_name(uuid) to authenticated;

-- ---------------------------------------------------- creating the rows
--
-- Called by the app on every sign-in. Sign-up passes blader_name and
-- real_name as account metadata; they are read from there the first time,
-- and the part of the email before the @ stands in for anything missing.
-- A real name the player has since set is never overwritten.

create or replace function public.ensure_profile()
returns void language plpgsql security definer set search_path = public as $$
declare
  u_id    uuid;
  u_email text;
  u_meta  jsonb;
  local   text;
begin
  select id, email, raw_user_meta_data into u_id, u_email, u_meta
  from auth.users where id = auth.uid();
  if u_id is null then return; end if;

  local := split_part(coalesce(u_email, ''), '@', 1);

  insert into profiles (id, email, display_name)
  values (u_id, u_email, local)
  on conflict (id) do nothing;

  update profiles
     set real_name = coalesce(nullif(btrim(left(u_meta->>'real_name', 80)), ''), local)
   where id = u_id and real_name is null;

  if not exists (select 1 from bladers where id = u_id) then
    insert into bladers (id, blader_name)
    values (u_id, free_blader_name(coalesce(nullif(btrim(u_meta->>'blader_name'), ''), local), u_id))
    on conflict do nothing;
  end if;
end $$;

-- ------------------------------------------------------- existing accounts
--
-- Everyone who signed up before this ran, oldest first, so when two emails
-- share the part before the @ the earlier account keeps the plain name.
-- One row at a time, so each new name is seen by the next.

do $$
declare r record;
begin
  update profiles p
     set real_name = coalesce(nullif(btrim(left(u.raw_user_meta_data->>'real_name', 80)), ''),
                              split_part(coalesce(u.email, ''), '@', 1))
    from auth.users u
   where u.id = p.id and p.real_name is null;

  for r in
    select u.id, u.email, u.raw_user_meta_data as meta
    from auth.users u
    join profiles p on p.id = u.id
    where not exists (select 1 from bladers b where b.id = u.id)
    order by u.created_at, u.id
  loop
    insert into bladers (id, blader_name)
    values (r.id, free_blader_name(
      coalesce(nullif(btrim(r.meta->>'blader_name'), ''), split_part(coalesce(r.email, ''), '@', 1)),
      r.id))
    on conflict do nothing;
  end loop;
end $$;

-- ------------------------------------------- organisers by blader name
--
-- The directory groups tournaments under whoever runs them. Same shape as
-- before; it now prefers the organiser's blader name.

create or replace function public.public_events()
returns table (
  id uuid, name text, format text, owner_id uuid,
  organiser text, created_at timestamptz, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, e.format, e.owner_id,
         coalesce(nullif(btrim(b.blader_name), ''), nullif(trim(p.display_name), ''), 'Organiser'),
         e.created_at, e.updated_at
  from events e
  left join profiles p on p.id = e.owner_id
  left join bladers b on b.id = e.owner_id
  where not e.archived
  order by e.created_at desc;
$$;

-- ---------------------------------------------------------------- photos
--
-- Public, so a profile picture loads for any visitor without a policy.
-- Writes are confined to a folder named after the account doing them.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- A size and type ceiling enforced by storage itself, not only by the app.
-- Guarded, because these columns are newer than some projects: missing
-- them is no reason to roll the whole file back.
do $$
begin
  update storage.buckets
     set file_size_limit = 1048576,
         allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png']
   where id = 'avatars';
exception when others then
  raise notice 'avatars bucket limits not set (%); the app still shrinks photos itself', sqlerrm;
end $$;

drop policy if exists "avatars own insert" on storage.objects;
create policy "avatars own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars own update" on storage.objects;
create policy "avatars own update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars own delete" on storage.objects;
create policy "avatars own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- What it made:
select b.blader_name, p.real_name, p.email
from bladers b join profiles p on p.id = b.id
order by b.created_at;
