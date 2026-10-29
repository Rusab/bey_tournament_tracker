-- =====================================================================
--  Tournament backgrounds and organiser logos.
--
--  One public bucket holds both. The app shrinks each picture in the
--  browser before uploading it (a background to 1400px, a logo to 320px
--  with its transparency kept), and only the picture's address is saved
--  on the tournament.
--
--  Anyone can see the pictures; any signed-in account can upload one.
--  Run the whole file once in the SQL editor; safe to re-run.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('tournament-bg', 'tournament-bg', true)
on conflict (id) do nothing;

drop policy if exists "bg admin insert" on storage.objects;
create policy "bg admin insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'tournament-bg');

drop policy if exists "bg admin update" on storage.objects;
create policy "bg admin update" on storage.objects
  for update to authenticated using (bucket_id = 'tournament-bg');

drop policy if exists "bg admin delete" on storage.objects;
create policy "bg admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'tournament-bg');
