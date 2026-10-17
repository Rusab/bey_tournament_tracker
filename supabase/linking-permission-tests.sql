-- =====================================================================
--  Do the linking permissions hold?
--
--  The email lookup must answer only approved hosts and the referees of
--  the tournament they name, and must never hand back an email. The
--  tournament history must find a blader whether they played alone or
--  as a member of a team.
--
--  Makes one throwaway tournament and removes it at the end; every
--  attempt is rolled back. Your data is left exactly as it was.
--
--  Run linking-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists link_results;
create temp table link_results (n int, checked text, expected text, actual text, pass boolean);

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
  host_id     uuid;   -- approved to host
  ref_id      uuid;   -- will referee the test tournament
  stranger_id uuid;   -- unrelated to it
  host_email  text;
  host_name   text;
  ev_id       uuid;
  step int := 0;
  v text;
begin
  select id into host_id from profiles where approved order by id limit 1;
  select id into ref_id from profiles where not approved order by id limit 1;
  select id into stranger_id from profiles where not approved and id <> ref_id order by id limit 1;

  if host_id is null or ref_id is null or stranger_id is null then
    insert into link_results values (0, 'a host and two other accounts to test with', 'yes', 'not enough accounts', false);
    return;
  end if;

  select email into host_email from profiles where id = host_id;
  select blader_name into host_name from bladers where id = host_id;

  -- The referee plays as a blader; the host plays as the second member of a team.
  insert into events (owner_id, name, format, data)
  values (host_id, '__link test__', 'tag', jsonb_build_object(
    'name', '__link test__',
    'players', jsonb_build_array(
      jsonb_build_object('id', 'a', 'name', 'Solo', 'profileId', ref_id::text),
      jsonb_build_object('id', 'b', 'name', 'Team', 'members', jsonb_build_array('One', 'Two'),
                         'memberIds', jsonb_build_array(null, host_id::text))
    )))
  returning id into ev_id;
  insert into event_referees (event_id, user_id) values (ev_id, ref_id);

  --------------------------------------------------------- the lookup

  step := step + 1;
  v := pg_temp.read_as(null, format('select blader_name from public.find_blader(%L)', host_email));
  insert into link_results values (step, 'visitor looks up an email', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(stranger_id, format('select blader_name from public.find_blader(%L)', host_email));
  insert into link_results values (step, 'ordinary account looks up an email', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(stranger_id, format('select blader_name from public.find_blader(%L, %L)', host_email, ev_id));
  insert into link_results values (step, 'account looks up an email for a tournament it has nothing to do with', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(ref_id, format('select blader_name from public.find_blader(%L, %L)', host_email, ev_id));
  insert into link_results values (step, 'referee looks up an email for their tournament', 'a blader name',
    coalesce(v, 'nothing'), v = host_name);

  step := step + 1;
  v := pg_temp.read_as(ref_id, format('select blader_name from public.find_blader(%L)', host_email));
  insert into link_results values (step, 'referee looks up an email with no tournament named', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(host_id, format('select blader_name from public.find_blader(%L)', '  ' || upper(host_email) || ' '));
  insert into link_results values (step, 'host looks up an email, any case, stray spaces', 'a blader name',
    coalesce(v, 'nothing'), v = host_name);

  step := step + 1;
  v := pg_get_function_result('public.find_blader(text, uuid)'::regprocedure);
  insert into link_results values (step, 'the lookup can only ever return id and blader name', 'no email column',
    v, v not ilike '%email%');

  ---------------------------------------------------- tournament history

  step := step + 1;
  v := pg_temp.read_as(null, format('select count(*)::text from public.blader_events(%L) where id = %L', ref_id, ev_id));
  insert into link_results values (step, 'visitor sees a blader''s tournament (played alone)', '1',
    coalesce(v, 'nothing'), v = '1');

  step := step + 1;
  v := pg_temp.read_as(null, format('select count(*)::text from public.blader_events(%L) where id = %L', host_id, ev_id));
  insert into link_results values (step, 'visitor sees a blader''s tournament (team member)', '1',
    coalesce(v, 'nothing'), v = '1');

  step := step + 1;
  v := pg_temp.read_as(null, format('select count(*)::text from public.blader_events(%L) where id = %L', stranger_id, ev_id));
  insert into link_results values (step, 'a blader who was not in it does not get it', '0',
    coalesce(v, 'nothing'), v = '0');

  ---------------------------------------------------------------- tidy up

  delete from event_referees where event_id = ev_id;
  delete from events where id = ev_id;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from link_results order by n;
