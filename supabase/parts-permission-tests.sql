-- =====================================================================
--  Do the parts catalogue permissions hold?
--
--  Impersonates a visitor, an ordinary account and the parts manager,
--  and checks what each may do to the catalogue and its pictures.
--
--  Everything is rolled back at the end, so your data is left exactly
--  as it was. Safe to re-run.
--
--  Run parts-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists parts_results;
create temp table parts_results (n int, checked text, expected text, actual text, pass boolean);

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
  m uuid;    -- the parts manager
  x uuid;    -- an ordinary account
  part_id uuid;
  add_sql text;
  results parts_results[] := '{}';
  r parts_results;
  step int := 0;
  n int;
begin
  select id into m from profiles where can_manage_parts order by id limit 1;
  select id into x from profiles where not can_manage_parts order by id limit 1;
  if m is null or x is null then
    insert into parts_results values (0, 'the parts manager and an ordinary account', 'yes',
      'missing - run parts-schema.sql first', false);
    return;
  end if;

  add_sql := format('insert into parts (kind, name) values (%L, %L)', 'blade', '__parts test__');
  select id into part_id from parts where kind = 'blade' and name = 'Dran Sword';

  begin
    step := step + 1;
    select count(*) into n from profiles where can_manage_parts;
    results := results || row(step, 'accounts holding parts access', 'exactly 1', n::text, n = 1)::parts_results;

    step := step + 1;
    select count(*) into n from parts;
    results := results || row(step, 'the catalogue starts with the built-in parts', 'at least 188', n::text, n >= 188)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(null, 'select 1 from parts');
    results := results || row(step, 'visitor reads the catalogue', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(null, add_sql);
    results := results || row(step, 'visitor adds a part', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(x, add_sql);
    results := results || row(step, 'ordinary account adds a part', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(x, format('update parts set name = %L where id = %L', 'Renamed', part_id));
    results := results || row(step, 'ordinary account renames a part', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(x, format('delete from parts where id = %L', part_id));
    results := results || row(step, 'ordinary account deletes a part', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(x, format('update profiles set can_manage_parts = true where id = %L', x));
    results := results || row(step, 'ordinary account gives itself parts access', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(x, format(
      'insert into storage.objects (bucket_id, name) values (%L, %L)', 'part-images', '__parts-test.png'));
    results := results || row(step, 'ordinary account uploads a part picture', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, add_sql);
    results := results || row(step, 'parts manager adds a part', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, format('insert into parts (kind, name) values (%L, %L)', 'blade', 'dran sword'));
    results := results || row(step, 'parts manager adds a second Dran Sword', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, format('insert into parts (kind, name) values (%L, %L)', 'sticker', '__x__'));
    results := results || row(step, 'parts manager adds a kind of part that does not exist', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, format(
      'update parts set aliases = array[%L] where id = %L', 'Dran Sord', part_id));
    results := results || row(step, 'parts manager adds an alias', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, format('delete from parts where id = %L', part_id));
    results := results || row(step, 'parts manager deletes a part', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::parts_results;

    step := step + 1;
    n := pg_temp.attempt(m, format(
      'insert into storage.objects (bucket_id, name) values (%L, %L)', 'part-images', '__parts-test.png'));
    results := results || row(step, 'parts manager uploads a part picture', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::parts_results;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(step + 1, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::parts_results;
    end if;
  end;

  foreach r in array results loop
    insert into parts_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from parts_results order by n;
