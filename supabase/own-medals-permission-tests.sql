-- =====================================================================
--  Can a blader remove their own medals - and only their own?
--
--  Two test medals are made, one for each of two ordinary bladers, and
--  everything is rolled back at the end, so your data is left exactly as
--  it was. Safe to re-run.
--
--  Run own-medals-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists own_medal_results;
create temp table own_medal_results (n int, checked text, expected text, actual text, pass boolean);

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
  x uuid; y uuid; a uuid;
  mx uuid; my uuid;
  results own_medal_results[] := '{}';
  r own_medal_results;
  n int;
begin
  select id into a from profiles where can_award_medals order by id limit 1;
  select p.id into x from profiles p join bladers b on b.id = p.id
    where not p.can_award_medals order by p.id limit 1;
  select p.id into y from profiles p join bladers b on b.id = p.id
    where not p.can_award_medals and p.id <> x order by p.id limit 1;
  if x is null or y is null then
    insert into own_medal_results values (0, 'two ordinary bladers to test with', 'yes', 'missing', false);
    return;
  end if;

  begin
    insert into medals (blader_id, place, tournament_name, organiser_name, category, awarded_by)
    values (x, 'first', '__own medal test__', '__x__', 'unranked_local', a) returning id into mx;
    insert into medals (blader_id, place, tournament_name, organiser_name, category, awarded_by)
    values (y, 'first', '__own medal test__', '__x__', 'unranked_local', a) returning id into my;

    n := pg_temp.attempt(null, format('delete from medals where id = %L', mx));
    results := results || row(1, 'visitor removes a medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::own_medal_results;

    n := pg_temp.attempt(y, format('delete from medals where id = %L', mx));
    results := results || row(2, 'blader removes somebody else''s medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::own_medal_results;

    n := pg_temp.attempt(x, format('delete from medals where id = %L', mx));
    results := results || row(3, 'blader removes their own medal', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::own_medal_results;

    n := pg_temp.attempt(x, format('update medals set place = %L where id = %L', 'second', mx));
    results := results || row(4, 'blader changes their own medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::own_medal_results;

    n := pg_temp.attempt(x, format(
      'insert into medals (blader_id, place, tournament_name, organiser_name, category) values (%L, %L, %L, %L, %L)',
      x, 'first', '__own medal test__', '__x__', 'unranked_local'));
    results := results || row(5, 'blader gives themselves a medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::own_medal_results;

    if a is not null then
      n := pg_temp.attempt(a, format('delete from medals where id = %L', my));
      results := results || row(6, 'medal approver removes a medal they gave', 'allowed',
        case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::own_medal_results;
    end if;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(99, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::own_medal_results;
    end if;
  end;

  foreach r in array results loop
    insert into own_medal_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from own_medal_results order by n;
