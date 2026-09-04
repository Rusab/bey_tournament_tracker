-- =====================================================================
--  Does the permission model actually hold?
--
--  Impersonates each account in turn and asserts what it may and may not
--  do. Every statement that is supposed to be refused is wrapped so the
--  refusal is recorded rather than aborting the run.
--
--  Creates a throwaway tournament, tests against it, and deletes it —
--  your own data is never touched. Safe to re-run.
--
--  Run the whole file. The final table is the answer.
-- =====================================================================

drop table if exists rls_results;
create temp table rls_results (
  n int, checked text, expected text, actual text, pass boolean
);

do $$
declare
  host_id   uuid;   -- approved + staff
  other_id  uuid;   -- signed up, not approved
  ref_id    uuid;   -- will be made a referee
  ev_id     uuid;
  step      int := 0;

  ok boolean;
begin
  select id into host_id  from profiles where approved and is_staff limit 1;
  select id into other_id from profiles where not approved order by created_at limit 1;
  select id into ref_id   from profiles where not approved order by created_at desc limit 1;

  if host_id is null or other_id is null then
    insert into rls_results values (0, 'accounts present',
      'an approved host and at least one unapproved account',
      'missing — approve yourself first', false);
    return;
  end if;

  -- A tournament to test against, owned by the host.
  insert into events (owner_id, name, format, data)
  values (host_id, '__permission test__', 'knockout', '{"name":"__permission test__"}'::jsonb)
  returning id into ev_id;

  insert into event_referees (event_id, user_id) values (ev_id, ref_id);

  ---------------------------------------------------------------- anon

  step := step + 1;
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    perform 1 from events limit 1;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  insert into rls_results values (step, 'anon reads scoreboards', 'allowed',
    case when ok then 'allowed' else 'refused' end, ok);

  step := step + 1;
  perform set_config('role', 'anon', true);
  begin
    perform 1 from profiles limit 1;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  insert into rls_results values (step, 'anon reads profiles', 'refused',
    case when ok then 'allowed' else 'refused' end, not ok);

  ------------------------------------------------- an unapproved account

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  begin
    insert into events (owner_id, name, format, data)
    values (other_id, '__should not exist__', 'knockout', '{}'::jsonb);
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  insert into rls_results values (step, 'unapproved account hosts a tournament', 'refused',
    case when ok then 'ALLOWED' else 'refused' end, not ok);

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  begin
    update profiles set approved = true where id = other_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  select approved into ok from profiles where id = other_id;
  insert into rls_results values (step, 'account approves itself', 'refused',
    case when ok then 'ALLOWED' else 'refused' end, not ok);

  ------------------------------------------------------------ a referee

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', ref_id, 'role', 'authenticated')::text, true);
  begin
    update events set data = '{"scored":true}'::jsonb where id = ev_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  insert into rls_results values (step, 'referee scores their tournament', 'allowed',
    case when ok then 'allowed' else 'REFUSED' end, ok);

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', ref_id, 'role', 'authenticated')::text, true);
  begin
    update events set owner_id = ref_id where id = ev_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  select (owner_id = host_id) into ok from events where id = ev_id;
  insert into rls_results values (step, 'referee takes ownership', 'refused',
    case when ok then 'refused' else 'ALLOWED' end, ok);

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', ref_id, 'role', 'authenticated')::text, true);
  begin
    delete from events where id = ev_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  select exists (select 1 from events where id = ev_id) into ok;
  insert into rls_results values (step, 'referee deletes the tournament', 'refused',
    case when ok then 'refused' else 'ALLOWED' end, ok);

  ------------------------------------------------------- a stranger to it

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  begin
    update events set data = '{"vandalised":true}'::jsonb where id = ev_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  select (data ? 'vandalised') into ok from events where id = ev_id;
  insert into rls_results values (step, 'stranger edits someone else''s tournament', 'refused',
    case when ok then 'ALLOWED' else 'refused' end, not ok);

  --------------------------------------------------------------- the host

  step := step + 1;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', host_id, 'role', 'authenticated')::text, true);
  begin
    update events set name = '__renamed__' where id = ev_id;
    ok := true;
  exception when others then ok := false;
  end;
  perform set_config('role', 'postgres', true);
  insert into rls_results values (step, 'host renames their tournament', 'allowed',
    case when ok then 'allowed' else 'REFUSED' end, ok);

  ---------------------------------------------------------------- tidy up

  perform set_config('role', 'postgres', true);
  delete from event_referees where event_id = ev_id;
  delete from events where id = ev_id;
  delete from events where name = '__should not exist__';
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from rls_results order by n;
