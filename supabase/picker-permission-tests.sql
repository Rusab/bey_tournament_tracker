-- =====================================================================
--  Does the blader list keep real names to the right people?
--
--  Reads only; nothing is written. Run picker-schema.sql first, then the
--  whole of this file.
-- =====================================================================

drop table if exists picker_results;
create temp table picker_results (n int, checked text, expected text, actual text, pass boolean);

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
  host_id  uuid;   -- approved to host
  other_id uuid;   -- an ordinary account
  total int;
  step int := 0;
  v text;
begin
  select id into host_id from profiles where approved order by id limit 1;
  select id into other_id from profiles where not approved and not is_staff order by id limit 1;
  select count(*) into total from bladers;

  if host_id is null or other_id is null then
    insert into picker_results values (0, 'a host and an ordinary account', 'yes', 'not enough accounts', false);
    return;
  end if;

  step := step + 1;
  v := pg_temp.read_as(null, 'select count(*)::text from public.blader_directory()');
  insert into picker_results values (step, 'visitor reads the list', 'refused',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(other_id, 'select count(*)::text from public.blader_directory()');
  insert into picker_results values (step, 'ordinary account gets every blader', total::text,
    coalesce(v, 'nothing'), v = total::text);

  step := step + 1;
  v := pg_temp.read_as(other_id, format(
    'select count(*)::text from public.blader_directory() where real_name is not null and id <> %L', other_id));
  insert into picker_results values (step, 'ordinary account sees other people''s real names', '0',
    coalesce(v, 'nothing'), v = '0');

  step := step + 1;
  v := pg_temp.read_as(other_id, format(
    'select count(*)::text from public.blader_directory() where real_name is not null and id = %L', other_id));
  insert into picker_results values (step, 'ordinary account sees its own real name', '1',
    coalesce(v, 'nothing'), v = '1');

  step := step + 1;
  v := pg_temp.read_as(host_id, 'select count(*)::text from public.blader_directory() where real_name is not null');
  insert into picker_results values (step, 'organiser sees real names', total::text,
    coalesce(v, 'nothing'), v = total::text);

  step := step + 1;
  v := pg_get_function_result('public.blader_directory()'::regprocedure);
  insert into picker_results values (step, 'the list never carries an email', 'no email column',
    v, v not ilike '%email%');
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from picker_results order by n;
