-- =====================================================================
--  Deck photo detection.
--
--  A blader photographs their deck; the app finds each bey in the photo,
--  turns it into a list of 768 numbers in the browser (DINOv2-small), and
--  asks the database which catalogue blades look most like it.
--
--    part_refs     what each blade looks like, as those numbers. Made by
--                  the parts manager from catalogue pictures, and from
--                  bladers' photos once approved. Readable by everyone.
--    deck_photos   photos bladers send in after confirming a detection.
--                  Nothing in one is used until the parts manager approves
--                  it; turned down, it is deleted. Approved photos are
--                  kept, with their boxes and labels, as a training set.
--
--  Run the whole file once in the SQL editor; safe to re-run. Needs
--  parts-schema.sql to have run first.
-- =====================================================================

create extension if not exists vector with schema extensions;

-- The blade kinds a top-down photo can show.
create or replace function public.detectable_kind(k text)
returns boolean language sql immutable as $$
  select k in ('blade', 'infinity_blade', 'main_blade', 'metal_blade');
$$;

-- ---------------------------------------------------------- deck photos

create table if not exists deck_photos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  photo_path  text not null,
  -- [{x, y, w, h, part_id, e}] - the box as fractions of the photo, the
  -- blade the blader confirmed, and its 768 numbers (dropped on approval).
  boxes       jsonb not null,
  model       text not null,
  status      text not null default 'waiting',
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,

  constraint deck_photos_status check (status in ('waiting', 'approved')),
  constraint deck_photos_boxes check (jsonb_typeof(boxes) = 'array' and jsonb_array_length(boxes) between 1 and 6),
  constraint deck_photos_size check (pg_column_size(boxes) < 200000)
);
create index if not exists deck_photos_waiting on deck_photos (created_at) where status = 'waiting';

alter table deck_photos enable row level security;

drop policy if exists "deck photos seen by sender and parts manager" on deck_photos;
create policy "deck photos seen by sender and parts manager" on deck_photos for select to authenticated
  using (user_id = auth.uid() or public.is_parts_manager());

-- Written only through the functions below.
revoke all on deck_photos from anon, authenticated;
grant select on deck_photos to authenticated;

-- ------------------------------------------------------------ references

create table if not exists part_refs (
  id         bigint generated always as identity primary key,
  part_id    uuid not null references parts on delete cascade,
  source     text not null default 'catalogue',
  model      text not null,
  embedding  extensions.vector(768) not null,
  photo_id   uuid references deck_photos on delete cascade,
  created_at timestamptz not null default now(),

  constraint part_refs_source check (source in ('catalogue', 'photo'))
);
create index if not exists part_refs_part on part_refs (part_id);

alter table part_refs enable row level security;

drop policy if exists "part refs readable" on part_refs;
create policy "part refs readable" on part_refs for select using (true);

drop policy if exists "part refs added by parts manager" on part_refs;
create policy "part refs added by parts manager" on part_refs for insert to authenticated
  with check (public.is_parts_manager());

drop policy if exists "part refs removed by parts manager" on part_refs;
create policy "part refs removed by parts manager" on part_refs for delete to authenticated
  using (public.is_parts_manager());

revoke all on part_refs from anon, authenticated;
grant select on part_refs to anon, authenticated;
grant insert (part_id, source, model, embedding) on part_refs to authenticated;
grant delete on part_refs to authenticated;

-- The closest blades to one bey: each part scores its best reference.
create or replace function public.match_parts(p_query extensions.vector, p_model text, p_count int default 3)
returns table (part_id uuid, kind text, name text, image_path text, similarity real)
language sql stable set search_path = public, extensions as $$
  select p.id, p.kind, p.name, p.image_path, max(1 - (r.embedding <=> p_query))::real as similarity
  from part_refs r join parts p on p.id = r.part_id
  where r.model = p_model and public.detectable_kind(p.kind)
  group by p.id, p.kind, p.name, p.image_path
  order by similarity desc
  limit least(greatest(p_count, 1), 10);
$$;
revoke execute on function public.match_parts(extensions.vector, text, int) from public;
grant execute on function public.match_parts(extensions.vector, text, int) to anon, authenticated;

-- How many references each part has, for the Parts screen.
create or replace function public.part_ref_counts(p_model text)
returns table (part_id uuid, catalogue int, photos int)
language sql stable set search_path = public as $$
  select part_id, (count(*) filter (where source = 'catalogue'))::int,
         (count(*) filter (where source = 'photo'))::int
  from part_refs where model = p_model group by part_id;
$$;
grant execute on function public.part_ref_counts(text) to anon, authenticated;

-- ---------------------------------------------------------------- photos

insert into storage.buckets (id, name, public)
values ('deck-photos', 'deck-photos', false)
on conflict (id) do update set public = false;

do $$
begin
  update storage.buckets
     set file_size_limit = 2097152,
         allowed_mime_types = array['image/webp', 'image/jpeg']
   where id = 'deck-photos';
exception when others then
  raise notice 'deck-photos bucket limits not set (%); the app still shrinks photos itself', sqlerrm;
end $$;

-- Files in this account's folder not yet approved. Caps uploads, so
-- nobody can fill the bucket with photos they never send in.
create or replace function public.my_open_deck_photos()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from storage.objects o
  where o.bucket_id = 'deck-photos' and (storage.foldername(o.name))[1] = auth.uid()::text
    and not exists (select 1 from deck_photos d where d.photo_path = o.name and d.status = 'approved');
$$;
revoke execute on function public.my_open_deck_photos() from public, anon;
grant execute on function public.my_open_deck_photos() to authenticated;

drop policy if exists "deck photos own insert" on storage.objects;
create policy "deck photos own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'deck-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.my_open_deck_photos() < 12);

drop policy if exists "deck photos read" on storage.objects;
create policy "deck photos read" on storage.objects for select to authenticated
  using (bucket_id = 'deck-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_parts_manager()));

drop policy if exists "deck photos delete" on storage.objects;
create policy "deck photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'deck-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_parts_manager()));

-- ------------------------------------------------------------- functions

-- Send a confirmed photo in. The photo must already be in the sender's folder.
create or replace function public.submit_deck_photo(p_path text, p_boxes jsonb, p_model text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  b jsonb;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in to send a photo.'; end if;
  if p_path is null or p_path not like me::text || '/%' or p_path like '%..%' then
    raise exception 'The photo did not upload. Try again.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'deck-photos' and name = p_path) then
    raise exception 'The photo did not upload. Try again.';
  end if;
  if (select count(*) from deck_photos where user_id = me and status = 'waiting') >= 10 then
    raise exception 'You already have 10 photos waiting to be checked.';
  end if;
  if jsonb_typeof(p_boxes) <> 'array' or jsonb_array_length(p_boxes) not between 1 and 6 then
    raise exception 'A photo needs between 1 and 6 beys.';
  end if;
  if p_model is null or char_length(p_model) > 40 then raise exception 'Unknown detector.'; end if;

  for b in select x from jsonb_array_elements(p_boxes) x loop
    if jsonb_typeof(b->'x') <> 'number' or jsonb_typeof(b->'y') <> 'number'
       or jsonb_typeof(b->'w') <> 'number' or jsonb_typeof(b->'h') <> 'number'
       or (b->>'x')::numeric not between 0 and 1 or (b->>'y')::numeric not between 0 and 1
       or (b->>'w')::numeric not between 0 and 1 or (b->>'h')::numeric not between 0 and 1 then
      raise exception 'A box is outside the photo.';
    end if;
    if not exists (select 1 from parts p where p.id::text = b->>'part_id' and public.detectable_kind(p.kind)) then
      raise exception 'Every bey needs a blade from the catalogue.';
    end if;
    if jsonb_typeof(b->'e') <> 'array' or jsonb_array_length(b->'e') <> 768
       or jsonb_path_exists(b, '$.e[*] ? (@.type() != "number")') then
      raise exception 'A bey''s detection data is damaged.';
    end if;
  end loop;

  insert into deck_photos (user_id, photo_path, boxes, model)
  values (me, p_path, p_boxes, p_model) returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.submit_deck_photo(text, jsonb, text) from public, anon;
grant execute on function public.submit_deck_photo(text, jsonb, text) to authenticated;

-- Take back a photo still waiting. Hands back the file for the app to delete.
create or replace function public.withdraw_deck_photo(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare path text;
begin
  delete from deck_photos where id = p_id and user_id = auth.uid() and status = 'waiting'
  returning photo_path into path;
  return path;
end $$;
revoke execute on function public.withdraw_deck_photo(uuid) from public, anon;
grant execute on function public.withdraw_deck_photo(uuid) to authenticated;

-- The parts manager's decision. p_labels, when given, is one entry per box:
-- a part id (to keep or correct the blader's label) or null to leave that
-- box out. Approving turns each kept box into a reference and keeps the
-- photo; turning it down deletes the row and hands back the file to delete.
create or replace function public.review_deck_photo(p_id uuid, p_approve boolean, p_labels jsonb default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  d deck_photos;
  b jsonb;
  i int := 0;
  label text;
  kept jsonb := '[]'::jsonb;
begin
  if not public.is_parts_manager() then raise exception 'Only the parts manager can check photos.'; end if;
  select * into d from deck_photos where id = p_id and status = 'waiting' for update;
  if not found then raise exception 'That photo has already been decided.'; end if;

  if not p_approve then
    delete from deck_photos where id = p_id;
    return d.photo_path;
  end if;

  if p_labels is not null and (jsonb_typeof(p_labels) <> 'array'
     or jsonb_array_length(p_labels) <> jsonb_array_length(d.boxes)) then
    raise exception 'One label per box is needed.';
  end if;

  for b in select x from jsonb_array_elements(d.boxes) x loop
    label := case when p_labels is null then b->>'part_id' else p_labels->>i end;
    i := i + 1;
    if label is null then continue; end if;
    if not exists (select 1 from parts p where p.id::text = label and public.detectable_kind(p.kind)) then
      raise exception 'Every kept box needs a blade from the catalogue.';
    end if;
    insert into part_refs (part_id, source, model, embedding, photo_id)
    values (label::uuid, 'photo', d.model, ((b->'e')::text)::extensions.vector, d.id);
    kept := kept || jsonb_build_array((b - 'e') || jsonb_build_object('part_id', label));
  end loop;

  if jsonb_array_length(kept) = 0 then raise exception 'Keep at least one box, or turn the photo down.'; end if;
  update deck_photos set status = 'approved', reviewed_at = now(), boxes = kept where id = p_id;
  return null;
end $$;
revoke execute on function public.review_deck_photo(uuid, boolean, jsonb) from public, anon;
grant execute on function public.review_deck_photo(uuid, boolean, jsonb) to authenticated;

-- What it made.
select (select count(*) from part_refs) as references_stored,
       (select count(*) from deck_photos where status = 'waiting') as photos_waiting;
