-- =====================================================================
--  Do the legacy tournament rules hold?
--
--  Makes a legacy tournament with a blader on its podium and checks who may
--  add, change and remove it, and that a blader may change their own deck
--  but nothing else. Everything is rolled back at the end, so your data is
--  left exactly as it was. Safe to re-run.
--
--  Run legacy-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists legacy_results;
create temp table legacy_results (n int, checked text, expected text, actual text, pass boolean);

create or replace function pg_temp.attempt(p_sub uuid, p_sql text)
returns int language plpgsql as $$
declare n int := -1;
begin
  begin
    if p_sub is null then
      perform set_config('role', 'anon', true);
      perform set_config('request.jwt.claims', '', true);
    else
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
    end if;
    execute p_sql;
    get diagnostics n = row_count;
    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then n := -1; end if;
  end;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

do $$
declare
  a uuid;   -- has medal access
  x uuid;   -- the blader on the podium
  t uuid;   -- their tag teammate
  y uuid;   -- somebody else
  e uuid;
  p uuid;
  results legacy_results[] := '{}';
  r legacy_results;
  step int := 0;
  n int;
  deck3 text := '[{"type":"bx","blade":"Dran Sword"},{"type":"bx","blade":"Wizard Rod"},{"type":"bx","blade":"Shark Scale"}]';
  deck5 text := '[{"type":"bx","blade":"A"},{"type":"bx","blade":"B"},{"type":"bx","blade":"C"},{"type":"bx","blade":"D"},{"type":"bx","blade":"E"}]';
begin
  select id into a from profiles where can_award_medals order by id limit 1;
  select b.id into x from bladers b join profiles pr on pr.id = b.id where not pr.can_award_medals order by b.id limit 1;
  select b.id into t from bladers b join profiles pr on pr.id = b.id where not pr.can_award_medals and b.id <> x order by b.id limit 1;
  select b.id into y from bladers b join profiles pr on pr.id = b.id where not pr.can_award_medals and b.id not in (x, t) order by b.id limit 1;
  if a is null or x is null or t is null or y is null then
    insert into legacy_results values (0, 'a medal manager and three other bladers to test with', 'yes', 'missing', false);
    return;
  end if;

  begin
    step := step + 1; n := pg_temp.attempt(null, $q$insert into legacy_events (name) values ('__legacy test__')$q$);
    results := results || row(step, 'a visitor adds a legacy tournament', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(x, $q$insert into legacy_events (name) values ('__legacy test__')$q$);
    results := results || row(step, 'a blader adds one', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(a, $q$insert into legacy_events (name) values ('__legacy test__')$q$);
    results := results || row(step, 'the medal manager adds one', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::legacy_results;

    insert into legacy_events (name, format) values ('__legacy test__', 'tag') returning id into e;
    insert into legacy_places (event_id, place, name, blader_id, teammate_id)
    values (e, 1, 'Team Test', x, t) returning id into p;

    step := step + 1; n := pg_temp.attempt(null, format('select 1 from legacy_places where id = %L', p));
    results := results || row(step, 'a visitor sees the podium', 'seen',
      case when n > 0 then 'seen' else 'HIDDEN' end, n > 0)::legacy_results;

    step := step + 1; n := pg_temp.attempt(x, format('update legacy_places set deck = %L where id = %L', deck3, p));
    results := results || row(step, 'the blader on the podium adds their deck', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(t, format('update legacy_places set deck = %L where id = %L', deck3, p));
    results := results || row(step, 'their teammate changes it', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(y, format('update legacy_places set deck = %L where id = %L', deck3, p));
    results := results || row(step, 'somebody else changes it', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(null, format('update legacy_places set deck = %L where id = %L', deck3, p));
    results := results || row(step, 'a visitor changes it', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(x, format('update legacy_places set place = 2 where id = %L', p));
    results := results || row(step, 'the blader changes their place', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(x, format('update legacy_places set teammate_id = %L where id = %L', y, p));
    results := results || row(step, 'the blader swaps their teammate', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(x, format('update legacy_events set name = %L where id = %L', 'renamed', e));
    results := results || row(step, 'the blader renames the tournament', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(a, format('update legacy_places set deck = %L where id = %L', deck5, p));
    results := results || row(step, 'a deck of five beyblades', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(a, format('update legacy_places set place = 2, name = %L where id = %L', 'Team Renamed', p));
    results := results || row(step, 'the medal manager changes the podium', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(x, format('delete from legacy_events where id = %L', e));
    results := results || row(step, 'the blader removes the tournament', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::legacy_results;
    step := step + 1; n := pg_temp.attempt(a, format('delete from legacy_events where id = %L', e));
    results := results || row(step, 'the medal manager removes it', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::legacy_results;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(step + 1, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::legacy_results;
    end if;
  end;

  foreach r in array results loop
    insert into legacy_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from legacy_results order by n;
