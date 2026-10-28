-- =====================================================================
--  Fill the legacy tournaments from the medals already given out.
--
--  Every medal names its tournament, organiser, place and blader (and, for
--  a tag team, the teammate). This makes one legacy tournament for each
--  tournament named on a 1st, 2nd or 3rd place medal, with those places on
--  its podium, each linked to its blader - so they can add their decks.
--
--    - Swiss medals are left out: they are not a podium place.
--    - A tournament with the same name as one run in the app is left out:
--      the app already has its real results.
--    - A tournament already in the legacy list (same name and organiser)
--      is left alone, so this is safe to run again after more medals.
--    - A tag team's two medals become one podium place, "A & B".
--    - Medals have no date, so dates are left empty: add them from Edit.
--
--  Also links names typed into legacy podiums by hand to the blader with
--  exactly that name, where one exists.
--
--  Run legacy-schema.sql first, then the whole of this file.
-- =====================================================================

do $$
declare
  r record;
  ev uuid;
begin
  for r in
    select min(btrim(m.tournament_name)) as name,
           min(btrim(m.organiser_name)) as organiser,
           bool_or(m.teammate_id is not null) as tag,
           lower(btrim(m.tournament_name)) as tkey,
           lower(btrim(m.organiser_name)) as okey
    from medals m
    where m.place in ('first', 'second', 'third')
      and not exists (select 1 from events e where lower(btrim(e.name)) = lower(btrim(m.tournament_name)))
    group by lower(btrim(m.tournament_name)), lower(btrim(m.organiser_name))
  loop
    if exists (select 1 from legacy_events le
               where lower(btrim(le.name)) = r.tkey and lower(coalesce(btrim(le.organiser), '')) = r.okey) then
      continue;
    end if;

    insert into legacy_events (name, organiser, format)
    values (r.name, r.organiser, case when r.tag then 'tag' else 'single' end)
    returning id into ev;

    -- One place per blader, or per tag team (whichever member's medal comes first).
    insert into legacy_places (event_id, place, name, blader_id, teammate_id)
    select distinct on (case m.place when 'first' then 1 when 'second' then 2 else 3 end, least(m.blader_id, coalesce(m.teammate_id, m.blader_id)),
                            greatest(m.blader_id, coalesce(m.teammate_id, m.blader_id)))
           ev,
           case m.place when 'first' then 1 when 'second' then 2 else 3 end,
           left(case when tb.id is not null then b.blader_name || ' & ' || tb.blader_name else b.blader_name end, 60),
           m.blader_id,
           m.teammate_id
    from medals m
    join bladers b on b.id = m.blader_id
    left join bladers tb on tb.id = m.teammate_id
    where m.place in ('first', 'second', 'third')
      and lower(btrim(m.tournament_name)) = r.tkey
      and lower(btrim(m.organiser_name)) = r.okey
    order by case m.place when 'first' then 1 when 'second' then 2 else 3 end, least(m.blader_id, coalesce(m.teammate_id, m.blader_id)),
             greatest(m.blader_id, coalesce(m.teammate_id, m.blader_id)), m.created_at;
  end loop;
end $$;

-- Names typed by hand: linked to the blader of exactly that name. (Blader
-- names are unique, so there is never more than one.) The deck guard only
-- lets the medal manager relink a place, and this editor runs as nobody,
-- so it steps aside for this one update.
alter table legacy_places disable trigger legacy_places_guard;
update legacy_places lp set blader_id = b.id
from bladers b
where lp.blader_id is null and lower(btrim(b.blader_name)) = lower(btrim(lp.name));
alter table legacy_places enable trigger legacy_places_guard;

-- What is there now.
select le.name as tournament, le.organiser, le.format,
       string_agg(lp.place || ': ' || lp.name || case when lp.blader_id is null then ' (not linked)' else '' end,
                  ' | ' order by lp.place, lp.name) as podium
from legacy_events le
left join legacy_places lp on lp.event_id = le.id
group by le.id, le.name, le.organiser, le.format, le.created_at
order by le.created_at desc;
