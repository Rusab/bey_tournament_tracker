-- =====================================================================
--  Do the medal permissions hold?
--
--  Impersonates a visitor, an ordinary account, an organiser without
--  medal access, and the account with it, and checks what each may do.
--
--  Every attempt is rolled back whether it was meant to succeed or not.
--  One test medal is made at the start and removed at the end, so your
--  data is left exactly as it was. Safe to re-run.
--
--  Run medals-schema.sql first, then the whole of this file.
--
--  Once medal-claims-schema.sql has run, every new medal needs a
--  category, so "medal giver adds a medal" here fails by design. Use
--  medal-claims-permission-tests.sql from then on.
-- =====================================================================

drop table if exists medal_results;
create temp table medal_results (n int, checked text, expected text, actual text, pass boolean);

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

create or replace function pg_temp.read_as(p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v text;
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
    execute p_sql into v;
    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then v := '<refused>'; end if;
  end;
  perform set_config('role', 'postgres', true);
  return v;
end $$;

do $$
declare
  awarder_id uuid;   -- holds medal access
  host_id    uuid;   -- approved to host, but no medal access
  other_id   uuid;   -- an ordinary account
  medal_id   uuid;   -- the one test medal
  step int := 0;
  n int;
  v text;
  add_sql text;
begin
  select id into awarder_id from profiles where can_award_medals order by id limit 1;
  select id into host_id from profiles
    where approved and not can_award_medals and id <> awarder_id order by id limit 1;
  select id into other_id from profiles
    where not approved and not can_award_medals order by id limit 1;

  if awarder_id is null then
    insert into medal_results values (0, 'an account with medal access', 'yes',
      'none - run medals-schema.sql first', false);
    return;
  end if;
  if other_id is null then
    insert into medal_results values (0, 'an ordinary account to test with', 'yes', 'none', false);
    return;
  end if;

  step := step + 1;
  select count(*) into n from profiles where can_award_medals;
  insert into medal_results values (step, 'accounts holding medal access', 'exactly 1',
    n::text, n = 1);

  -- The medal the removal tests aim at, given by the awarder to the ordinary account.
  insert into medals (blader_id, place, tournament_name, organiser_name, awarded_by)
  values (other_id, 'first', '__medal test__', '__medal test__', awarder_id)
  returning id into medal_id;

  add_sql := format(
    'insert into medals (blader_id, place, tournament_name, organiser_name) values (%L, %L, %L, %L)',
    other_id, 'second', '__should not exist__', '__x__');

  ---------------------------------------------------- a signed-out visitor

  step := step + 1;
  n := pg_temp.attempt(null, 'select 1 from medals');
  insert into medal_results values (step, 'visitor reads medals', 'allowed',
    case when n >= 0 then 'allowed' else 'REFUSED' end, n >= 0);

  step := step + 1;
  n := pg_temp.attempt(null, add_sql);
  insert into medal_results values (step, 'visitor adds a medal', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  v := pg_temp.read_as(null, 'select public.is_awarder()::text');
  insert into medal_results values (step, 'visitor asks whether it may give medals', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  -------------------------------------------------- an ordinary account

  step := step + 1;
  n := pg_temp.attempt(other_id, add_sql);
  insert into medal_results values (step, 'account gives itself a medal', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id, format('delete from medals where id = %L', medal_id));
  insert into medal_results values (step, 'account removes a medal', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update profiles set can_award_medals = true where id = %L', other_id));
  insert into medal_results values (step, 'account gives itself medal access', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  v := pg_temp.read_as(other_id, 'select public.is_awarder()::text');
  insert into medal_results values (step, 'account is told it may not give medals', 'false',
    coalesce(v, 'nothing'), v = 'false');

  ------------------------------------- an organiser without medal access

  if host_id is null then
    step := step + 1;
    insert into medal_results values (step, 'organiser without medal access', 'tested',
      'skipped - no approved host without medal access exists', true);
  else
    step := step + 1;
    n := pg_temp.attempt(host_id, add_sql);
    insert into medal_results values (step, 'organiser without medal access adds a medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

    step := step + 1;
    n := pg_temp.attempt(host_id, format('delete from medals where id = %L', medal_id));
    insert into medal_results values (step, 'organiser without medal access removes a medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);
  end if;

  ------------------------------------------- the account with medal access

  step := step + 1;
  n := pg_temp.attempt(awarder_id, add_sql);
  insert into medal_results values (step, 'medal giver adds a medal', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(awarder_id, format(
    'insert into medals (blader_id, place, tournament_name, organiser_name, awarded_by) values (%L, %L, %L, %L, %L)',
    other_id, 'second', '__x__', '__x__', other_id));
  insert into medal_results values (step, 'medal giver records a medal as from someone else', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(awarder_id, format(
    'insert into medals (blader_id, place, tournament_name, organiser_name) values (%L, %L, %L, %L)',
    other_id, 'gold', '__x__', '__x__'));
  insert into medal_results values (step, 'medal giver uses a place that does not exist', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(awarder_id,
    format('update medals set place = %L where id = %L', 'third', medal_id));
  insert into medal_results values (step, 'medal giver quietly changes a medal', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(awarder_id, format('delete from medals where id = %L', medal_id));
  insert into medal_results values (step, 'medal giver removes a medal they gave', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  v := pg_temp.read_as(awarder_id, 'select public.is_awarder()::text');
  insert into medal_results values (step, 'medal giver is told it may give medals', 'true',
    coalesce(v, 'nothing'), v = 'true');

  ---------------------------------------------------------------- tidy up

  delete from medals where id = medal_id;
  delete from medals where tournament_name in ('__medal test__', '__should not exist__', '__x__');
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from medal_results order by n;
