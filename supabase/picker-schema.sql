-- =====================================================================
--  Choosing bladers from a list, and spotting likely matches.
--
--  One function: every blader, with their real name only for someone
--  allowed to see real names (the blader themselves, organisers, staff).
--  The picker and the "possible match" check both read from it, so a
--  referee choosing a blader never sees a real name, and a match on a
--  real name can only ever be offered to someone who could look it up.
--
--  Additive only. Run once in the SQL editor; safe to re-run. Needs
--  profiles-schema.sql to have run first.
-- =====================================================================

create or replace function public.blader_directory()
returns table (id uuid, blader_name text, photo_path text, real_name text)
language sql stable security definer set search_path = public as $$
  select b.id, b.blader_name, b.photo_path,
         case when b.id = auth.uid() or public.is_approved() or public.is_staff()
              then p.real_name end
  from bladers b
  left join profiles p on p.id = b.id
  order by lower(b.blader_name);
$$;

revoke execute on function public.blader_directory() from public, anon;
grant execute on function public.blader_directory() to authenticated;
