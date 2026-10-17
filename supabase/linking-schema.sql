-- =====================================================================
--  Player profiles, phase 3: linking tournament players to profiles.
--
--  A tournament player can carry the id of the profile they belong to:
--  `profileId` on a blader, and `memberIds` alongside a tag team's
--  `members`, one per member, in the same order. Both live in the
--  tournament's own data, so nothing here changes a table - this file
--  only adds two functions.
--
--  Additive only. Run once in the SQL editor; safe to re-run. Needs
--  profiles-schema.sql to have run first.
-- =====================================================================

-- ------------------------------------------------- finding a profile
--
-- An email in, a blader name out - never the email back, and nothing at all
-- unless the caller is an approved host (setting up a tournament, which has
-- no id yet) or owns or referees the tournament named.

create or replace function public.find_blader(p_email text, p_event uuid default null)
returns table (id uuid, blader_name text)
language sql stable security definer set search_path = public as $$
  select b.id, b.blader_name
  from profiles p
  join bladers b on b.id = p.id
  where lower(p.email) = lower(btrim(p_email))
    and (
      public.is_approved()
      or (p_event is not null and (public.owns_event(p_event) or public.refs_event(p_event)))
    );
$$;

revoke execute on function public.find_blader(text, uuid) from public, anon;
grant execute on function public.find_blader(text, uuid) to authenticated;

-- --------------------------------------------- a blader's tournaments
--
-- Every tournament someone was linked into, as a blader or as a member of
-- a team, archived ones included: a finished tournament is still history.
-- Not security definer - tournaments and bladers are public already, so it
-- runs with the caller's own rights and can show nothing they could not
-- read for themselves.

create or replace function public.blader_events(p_id uuid)
returns table (
  id uuid, name text, format text, organiser text,
  created_at timestamptz, archived boolean, data jsonb
)
language sql stable set search_path = public as $$
  select e.id, e.name, e.format,
         coalesce(nullif(btrim(b.blader_name), ''), 'Organiser'),
         e.created_at, e.archived, e.data
  from events e
  left join bladers b on b.id = e.owner_id
  where e.data->'players' @> jsonb_build_array(jsonb_build_object('profileId', p_id::text))
     or e.data->'players' @> jsonb_build_array(jsonb_build_object('memberIds', jsonb_build_array(p_id::text)))
  order by e.created_at desc;
$$;
