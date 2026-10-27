-- =====================================================================
--  Medals, part 2: categories, and medals sent in for approval.
--
--  Every medal gets a category. Only Ranked Locals is open for now
--  (Unranked Locals was retired); the rest are known to the database so they can be
--  opened later by editing medal_category_open() alone.
--
--  Any account with a blader profile can send a medal in, with a photo
--  of each side of it as proof. It waits in medal_claims, which only the
--  sender and the medal approver can see, so it never shows on a public
--  profile. The approver accepts it, which writes the real medal, or
--  turns it down. Either way the claim and its photos are deleted.
--
--  Nobody may have more than five waiting at once.
--
--  Photos live in a private bucket. The database cannot delete storage
--  files itself, so a resolved claim's photos are listed in
--  medal_proof_trash; the app deletes the files and then clears the list,
--  and an entry only clears once its file is really gone, so a failed
--  delete is retried the next time the approvals open.
--
--  Additive only. Run the whole file once in the SQL editor; safe to
--  re-run. Needs medals-schema.sql to have run first.
-- =====================================================================

-- ----------------------------------------------------------- categories

alter table medals add column if not exists category text;

alter table medals drop constraint if exists medals_category;
alter table medals add constraint medals_category check (category is null or category in
  ('unranked_local', 'ranked_local', 'league', 's1', 'g3', 'g2', 'g1', 'gp'));

-- The categories that can be chosen today. Open another by adding it here.
-- Unranked Locals was retired: medals already filed under it keep it.
create or replace function public.medal_category_open(p text)
returns boolean language sql immutable as $$
  select coalesce(p in ('ranked_local'), false);
$$;

-- Medals given directly by the approver carry an open category too.
-- Medals given before categories existed keep a null one.
drop policy if exists "awarders add medals" on medals;
create policy "awarders add medals" on medals for insert to authenticated
  with check (public.is_awarder() and awarded_by = auth.uid() and public.medal_category_open(category));

grant insert (blader_id, place, tournament_name, organiser_name, season, teammate_id, category)
  on medals to authenticated;

-- ------------------------------------------------------- waiting medals

create table if not exists medal_claims (
  id              uuid primary key default gen_random_uuid(),
  blader_id       uuid not null references bladers on delete cascade,  -- who sent it, for themselves
  place           text not null,
  category        text not null,
  tournament_name text not null,
  organiser_name  text not null,
  season          text not null default 'S1',
  teammate_id     uuid references bladers on delete set null,
  front_path      text not null,
  back_path       text not null,
  created_at      timestamptz not null default now(),

  constraint claims_place check (place in ('first', 'second', 'third', 'swiss')),
  constraint claims_category check (category in
    ('unranked_local', 'ranked_local', 'league', 's1', 'g3', 'g2', 'g1', 'gp')),
  constraint claims_tournament_len check (char_length(btrim(tournament_name)) between 1 and 80),
  constraint claims_organiser_len check (char_length(btrim(organiser_name)) between 1 and 60),
  constraint claims_season_len check (char_length(btrim(season)) between 1 and 20),
  constraint claims_not_own_teammate check (teammate_id is null or teammate_id <> blader_id),
  constraint claims_two_photos check (front_path <> back_path)
);

create index if not exists medal_claims_blader_idx on medal_claims (blader_id);

alter table medal_claims enable row level security;

drop policy if exists "claims seen by sender and approver" on medal_claims;
create policy "claims seen by sender and approver" on medal_claims for select to authenticated
  using (blader_id = auth.uid() or public.is_awarder());

-- Read only. Sending, withdrawing and deciding all go through the
-- functions below, which apply the rules the table alone cannot.
revoke all on medal_claims from anon, authenticated;
grant select on medal_claims to authenticated;

-- Photos whose claim is settled, waiting for the app to delete the file.
create table if not exists medal_proof_trash (
  path     text primary key,
  added_at timestamptz not null default now()
);
alter table medal_proof_trash enable row level security;
revoke all on medal_proof_trash from anon, authenticated;

-- ---------------------------------------------------------------- photos

insert into storage.buckets (id, name, public)
values ('medal-proofs', 'medal-proofs', false)
on conflict (id) do update set public = false;

do $$
begin
  update storage.buckets
     set file_size_limit = 2097152,
         allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png']
   where id = 'medal-proofs';
exception when others then
  raise notice 'medal-proofs bucket limits not set (%); the app still shrinks photos itself', sqlerrm;
end $$;

-- How many photos sit in this account's folder. Used to cap uploads, so
-- nobody can fill the bucket with photos they never send in.
create or replace function public.my_proof_count()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from storage.objects
  where bucket_id = 'medal-proofs' and (storage.foldername(name))[1] = auth.uid()::text;
$$;
revoke execute on function public.my_proof_count() from public, anon;
grant execute on function public.my_proof_count() to authenticated;

drop policy if exists "medal proofs own insert" on storage.objects;
create policy "medal proofs own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'medal-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.my_proof_count() < 12);

drop policy if exists "medal proofs read" on storage.objects;
create policy "medal proofs read" on storage.objects for select to authenticated
  using (bucket_id = 'medal-proofs'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_awarder()));

drop policy if exists "medal proofs delete" on storage.objects;
create policy "medal proofs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'medal-proofs'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_awarder()));

-- ------------------------------------------------------------- functions

-- Send a medal in. Both photos must already be uploaded to the sender's
-- own folder. Five waiting is the most anyone may have.
create or replace function public.submit_medal_claim(
  p_place text, p_category text, p_tournament text, p_organiser text, p_season text,
  p_teammate uuid, p_front text, p_back text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in to send a medal in.'; end if;
  if not exists (select 1 from bladers where id = me) then
    raise exception 'Make your blader profile first.';
  end if;
  if not public.medal_category_open(p_category) then
    raise exception 'That category is not open yet.';
  end if;
  if p_front is null or p_back is null or p_front = p_back
     or p_front not like me::text || '/%' or p_back not like me::text || '/%' then
    raise exception 'A photo of each side of the medal is needed.';
  end if;
  if (select count(*) from storage.objects
      where bucket_id = 'medal-proofs' and name in (p_front, p_back)) <> 2 then
    raise exception 'The medal photos did not upload. Try again.';
  end if;
  if p_teammate is not null and (p_teammate = me
     or not exists (select 1 from bladers where id = p_teammate)) then
    raise exception 'That teammate could not be found.';
  end if;

  -- One sender at a time, so two sends at once cannot both slip under the cap.
  perform pg_advisory_xact_lock(hashtext('medal_claims:' || me::text));
  if (select count(*) from medal_claims where blader_id = me) >= 5 then
    raise exception 'You already have 5 medals waiting for approval. Send more once those are decided.';
  end if;

  insert into medal_claims (blader_id, place, category, tournament_name, organiser_name,
                            season, teammate_id, front_path, back_path)
  values (me, p_place, p_category, btrim(p_tournament), btrim(p_organiser),
          coalesce(nullif(btrim(p_season), ''), 'S1'), p_teammate, p_front, p_back)
  returning id into new_id;
  return new_id;
end $$;

-- Take back a medal you sent, before it is decided. Returns its photos.
create or replace function public.withdraw_medal_claim(p_id uuid)
returns setof text language plpgsql security definer set search_path = public as $$
declare c medal_claims;
begin
  delete from medal_claims where id = p_id and blader_id = auth.uid() returning * into c;
  if c.id is null then return; end if;
  insert into medal_proof_trash (path) values (c.front_path), (c.back_path) on conflict do nothing;
  return next c.front_path; return next c.back_path;
end $$;

-- The approver's decision. Approving writes the medal - for a tag team,
-- to both members, each naming the other. Either way the claim goes, and
-- its photos are returned for deleting.
create or replace function public.review_medal_claim(p_id uuid, p_approve boolean)
returns setof text language plpgsql security definer set search_path = public as $$
declare c medal_claims;
begin
  if not public.is_awarder() then raise exception 'Only the medal approver can decide this.'; end if;
  delete from medal_claims where id = p_id returning * into c;
  if c.id is null then return; end if;
  if p_approve then
    insert into medals (blader_id, place, tournament_name, organiser_name, season, teammate_id, category, awarded_by)
    values (c.blader_id, c.place, c.tournament_name, c.organiser_name, c.season, c.teammate_id, c.category, auth.uid());
    if c.teammate_id is not null then
      insert into medals (blader_id, place, tournament_name, organiser_name, season, teammate_id, category, awarded_by)
      values (c.teammate_id, c.place, c.tournament_name, c.organiser_name, c.season, c.blader_id, c.category, auth.uid());
    end if;
  end if;
  insert into medal_proof_trash (path) values (c.front_path), (c.back_path) on conflict do nothing;
  return next c.front_path; return next c.back_path;
end $$;

-- Photos still to delete. The approver sees them all; a sender, their own.
create or replace function public.proof_trash()
returns setof text language sql stable security definer set search_path = public as $$
  select path from medal_proof_trash
  where public.is_awarder() or path like auth.uid()::text || '/%';
$$;

-- Clears entries, but only those whose file is really gone.
create or replace function public.clear_proof_trash(p_paths text[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from medal_proof_trash t
  where t.path = any(p_paths)
    and (public.is_awarder() or t.path like auth.uid()::text || '/%')
    and not exists (select 1 from storage.objects o where o.bucket_id = 'medal-proofs' and o.name = t.path);
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.submit_medal_claim(text, text, text, text, text, uuid, text, text) from public, anon;
revoke execute on function public.withdraw_medal_claim(uuid) from public, anon;
revoke execute on function public.review_medal_claim(uuid, boolean) from public, anon;
revoke execute on function public.proof_trash() from public, anon;
revoke execute on function public.clear_proof_trash(text[]) from public, anon;
grant execute on function public.submit_medal_claim(text, text, text, text, text, uuid, text, text) to authenticated;
grant execute on function public.withdraw_medal_claim(uuid) to authenticated;
grant execute on function public.review_medal_claim(uuid, boolean) to authenticated;
grant execute on function public.proof_trash() to authenticated;
grant execute on function public.clear_proof_trash(text[]) to authenticated;

-- What it made:
select (select count(*) from medal_claims) as waiting,
       (select public from storage.buckets where id = 'medal-proofs') as proofs_public;
