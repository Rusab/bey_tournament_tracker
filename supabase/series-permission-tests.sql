-- =====================================================================
--  Do the series permissions hold?
--
--  Two approved hosts and an outsider. Every attempt is rolled back; the
--  throwaway tournaments and series made for the test are removed at the
--  end. Your data is left exactly as it was.
--
--  Run series-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists series_results;
create temp table series_results (n int, checked text, expected text, actual text, pass boolean);

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
  h1 uuid;   -- an approved host, who owns the test series
  h2 uuid;   -- another approved host
  x  uuid;   -- an outsider, not approved
  e1 uuid;   -- h1's tournament
  e2 uuid;   -- h2's tournament
  s_own uuid;      -- h1's series, holding only h1's tournament
  s_asked uuid;    -- h1's series, which h1 has asked h2's tournament to join
  s_offered uuid;  -- h1's series, which h2 has asked to join
  s_empty uuid;    -- h1's series, empty
  step int := 0;
  v text;
  n int;
begin
  select id into h1 from profiles where approved order by is_staff desc, id limit 1;
  select id into h2 from profiles where approved and id <> h1 order by id limit 1;
  select id into x  from profiles where not approved and not is_staff order by id limit 1;
  if h1 is null or h2 is null or x is null then
    insert into series_results values (0, 'two approved hosts and an outsider', 'yes', 'not enough accounts', false);
    return;
  end if;

  insert into events (owner_id, name, format, data) values (h1, '__series test 1__', 'knockout', '{}'::jsonb) returning id into e1;
  insert into events (owner_id, name, format, data) values (h2, '__series test 2__', 'knockout', '{}'::jsonb) returning id into e2;
  insert into series (name, owner_id) values ('__series own__', h1) returning id into s_own;
  insert into series (name, owner_id) values ('__series asked__', h1) returning id into s_asked;
  insert into series (name, owner_id) values ('__series offered__', h1) returning id into s_offered;
  insert into series (name, owner_id) values ('__series empty__', h1) returning id into s_empty;
  insert into series_events (series_id, event_id, owner_ok, host_ok) values (s_own, e1, true, true);
  insert into series_events (series_id, event_id, owner_ok, host_ok) values (s_asked, e2, true, false);
  insert into series_events (series_id, event_id, owner_ok, host_ok) values (s_offered, e2, false, true);

  ------------------------------------------------------- starting a series

  step := step + 1;
  n := pg_temp.attempt(x, 'insert into series (name) values (''__x__'')');
  insert into series_results values (step, 'outsider starts a series', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(h1, 'insert into series (name) values (''__x__'')');
  insert into series_results values (step, 'host starts a series', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(h1, format('insert into series (name, owner_id) values (%L, %L)', '__x__', h2));
  insert into series_results values (step, 'host starts a series in someone else''s name', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(h2, format('update series set name = %L where id = %L', '__renamed__', s_own));
  insert into series_results values (step, 'host renames someone else''s series', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  ------------------------------------------------------------- linking

  step := step + 1;
  v := pg_temp.read_as(h1, format('select public.series_link(%L, %L)', s_empty, e1));
  insert into series_results values (step, 'owner adds their own tournament', 'approved',
    coalesce(v, 'nothing'), v = 'approved');

  step := step + 1;
  v := pg_temp.read_as(h1, format('select public.series_link(%L, %L)', s_empty, e2));
  insert into series_results values (step, 'owner adds another host''s tournament', 'pending',
    coalesce(v, 'nothing'), v = 'pending');

  step := step + 1;
  v := pg_temp.read_as(h2, format('select public.series_link(%L, %L)', s_empty, e2));
  insert into series_results values (step, 'host asks to join someone else''s series', 'pending',
    coalesce(v, 'nothing'), v = 'pending');

  step := step + 1;
  v := pg_temp.read_as(x, format('select public.series_link(%L, %L)', s_empty, e1));
  insert into series_results values (step, 'outsider links a tournament', 'refused',
    coalesce(v, 'nothing'), v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(h2, format('select public.series_link(%L, %L)', s_empty, e1));
  insert into series_results values (step, 'host links a tournament that is not theirs into a series that is not theirs', 'refused',
    coalesce(v, 'nothing'), v = '<refused>');

  ------------------------------------------------------------ approving

  step := step + 1;
  v := pg_temp.read_as(h2, format('select public.series_link(%L, %L)', s_asked, e2));
  insert into series_results values (step, 'tournament''s host approves being asked', 'approved',
    coalesce(v, 'nothing'), v = 'approved');

  step := step + 1;
  v := pg_temp.read_as(h1, format('select public.series_link(%L, %L)', s_offered, e2));
  insert into series_results values (step, 'series owner approves an offer', 'approved',
    coalesce(v, 'nothing'), v = 'approved');

  step := step + 1;
  v := pg_temp.read_as(h1, format('select public.series_link(%L, %L)', s_asked, e2));
  insert into series_results values (step, 'the asker cannot approve on the other''s behalf', 'pending',
    coalesce(v, 'nothing'), v = 'pending');

  step := step + 1;
  v := pg_temp.read_as(x, format('select public.series_link(%L, %L)', s_asked, e2));
  insert into series_results values (step, 'outsider approves', 'refused',
    coalesce(v, 'nothing'), v = '<refused>');

  step := step + 1;
  n := pg_temp.attempt(h2, format(
    'insert into series_events (series_id, event_id, owner_ok, host_ok) values (%L, %L, true, true)', s_empty, e2));
  insert into series_results values (step, 'host writes a membership row directly', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(h1, format(
    'update series_events set host_ok = true where series_id = %L and event_id = %L', s_asked, e2));
  insert into series_results values (step, 'owner marks the other host''s consent directly', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  ------------------------------------------------------------- requests

  step := step + 1;
  v := pg_temp.read_as(h2, format('select count(*)::text from public.series_requests() where series_id = %L', s_asked));
  insert into series_results values (step, 'the asked host sees the request', '1',
    coalesce(v, 'nothing'), v = '1');

  step := step + 1;
  v := pg_temp.read_as(h1, format('select count(*)::text from public.series_requests() where series_id = %L', s_asked));
  insert into series_results values (step, 'the asker is not asked to approve their own request', '0',
    coalesce(v, 'nothing'), v = '0');

  step := step + 1;
  v := pg_temp.read_as(h1, format('select count(*)::text from public.series_requests() where series_id = %L', s_offered));
  insert into series_results values (step, 'the series owner sees an offer to join', '1',
    coalesce(v, 'nothing'), v = '1');

  step := step + 1;
  v := pg_temp.read_as(x, 'select count(*)::text from public.series_requests()');
  insert into series_results values (step, 'outsider has no requests', '0',
    coalesce(v, 'nothing'), v = '0');

  ------------------------------------------------------------- removing

  step := step + 1;
  v := pg_temp.read_as(x, format('select public.series_remove(%L, %L)::text', s_own, e1));
  insert into series_results values (step, 'outsider removes a tournament', 'refused',
    coalesce(v, 'nothing'), v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(h2, format('select public.series_remove(%L, %L)::text', s_asked, e2));
  insert into series_results values (step, 'a host turns down a request for their tournament', 'allowed',
    coalesce(v, 'ok'), v is distinct from '<refused>');

  step := step + 1;
  v := pg_temp.read_as(null, format('select count(*)::text from series_events where series_id = %L', s_own));
  insert into series_results values (step, 'visitor sees what a series holds', '1',
    coalesce(v, 'nothing'), v = '1');

  ---------------------------------------------------------------- tidy up

  delete from series where id in (s_own, s_asked, s_offered, s_empty);
  delete from series where name = '__x__';
  delete from events where id in (e1, e2);
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from series_results order by n;
