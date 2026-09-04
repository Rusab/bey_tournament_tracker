-- =====================================================================
--  Bring the v1 tournament across into v2.
--
--  v1 kept one tournament in one row of `tournaments`, id 'current',
--  belonging to nobody. v2 wants it owned by an account and listed
--  alongside everything else.
--
--  Run once, in the Supabase SQL editor. Change the email on the last
--  line to whichever account should own it. Nothing is deleted: the old
--  row stays where it is, so this can be run, checked, and abandoned.
-- =====================================================================

insert into events (owner_id, name, format, data, created_at, updated_at)
select
  p.id,
  coalesce(nullif(trim(t.data->>'name'), ''), 'Xtreme Clash S2'),
  'knockout',
  t.data,
  coalesce(t.updated_at, now()),
  coalesce(t.updated_at, now())
from tournaments t
cross join profiles p
where t.id = 'current'
  and p.email = 'rusabcolabpro@gmail.com'   -- <- the owner
  -- Safe to re-run: a second copy is not made.
  and not exists (
    select 1 from events e where e.owner_id = p.id and e.data = t.data
  );

-- What landed:
select id, name, format, created_at from events order by created_at desc;
