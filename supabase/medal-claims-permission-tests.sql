-- =====================================================================
--  Do the rules for medals sent in for approval hold?
--
--  Impersonates a visitor, two ordinary accounts with blader profiles,
--  and the medal approver, and checks what each may do: send a medal in,
--  see one, see its photos, take it back, and decide it.
--
--  Everything this file does - test photos, test claims, test medals -
--  is rolled back at the end, so your data is left exactly as it was.
--  Safe to re-run.
--
--  Run medal-claims-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists claim_results;
create temp table claim_results (n int, checked text, expected text, actual text, pass boolean);

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

-- Acting as someone for real, inside the block that is rolled back at the end.
create or replace function pg_temp.become(p_sub uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.unbecome()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end $$;

do $$
declare
  a uuid;    -- the medal approver
  x uuid;    -- sends a medal in
  y uuid;    -- somebody else
  front text; back text;
  claim_id uuid;
  send_sql text;
  results claim_results[] := '{}';
  step int := 0;
  n int;
  v text;
  r claim_results;
begin
  select id into a from profiles where can_award_medals order by id limit 1;
  select p.id into x from profiles p join bladers b on b.id = p.id
    where not p.can_award_medals order by p.id limit 1;
  select p.id into y from profiles p join bladers b on b.id = p.id
    where not p.can_award_medals and p.id <> x order by p.id limit 1;

  if a is null or x is null or y is null then
    insert into claim_results values (0, 'the approver and two ordinary bladers to test with', 'yes',
      'missing - needs medals-schema.sql run and at least two other bladers', false);
    return;
  end if;

  front := x::text || '/__claim-test-front.jpg';
  back  := x::text || '/__claim-test-back.jpg';
  send_sql := format('select public.submit_medal_claim(%L, %L, %L, %L, %L, null, %L, %L)',
    'first', 'ranked_local', '__claim test__', '__claim org__', 'S1', front, back);

  begin
    ------------------------------------------------- the photos go up first

    step := step + 1;
    n := pg_temp.attempt(x, format(
      'insert into storage.objects (bucket_id, name) values (%L, %L)', 'medal-proofs', y::text || '/__claim-test.jpg'));
    results := results || row(step, 'account uploads into somebody else''s folder', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    perform pg_temp.become(x);
    insert into storage.objects (bucket_id, name) values ('medal-proofs', front), ('medal-proofs', back);
    perform pg_temp.unbecome();

    step := step + 1;
    select count(*) into n from storage.objects where bucket_id = 'medal-proofs' and name in (front, back);
    results := results || row(step, 'account uploads both photos to its own folder', '2',
      n::text, n = 2)::claim_results;

    step := step + 1;
    select public from storage.buckets where id = 'medal-proofs' into v;
    results := results || row(step, 'the photo bucket is private', 'false', coalesce(v, 'missing'), v = 'false')::claim_results;

    --------------------------------------------------------- sending one in

    step := step + 1;
    n := pg_temp.attempt(null, send_sql);
    results := results || row(step, 'visitor sends a medal in', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, replace(send_sql, '''ranked_local''', '''g1'''));
    results := results || row(step, 'account sends one in a category that is coming soon', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, format('select public.submit_medal_claim(%L, %L, %L, %L, %L, null, %L, %L)',
      'first', 'ranked_local', '__claim test__', '__claim org__', 'S1',
      x::text || '/__never-front.jpg', x::text || '/__never-back.jpg'));
    results := results || row(step, 'account sends one without uploading the photos', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(y, send_sql);
    results := results || row(step, 'account sends one in using somebody else''s photos', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, format(
      'insert into medal_claims (blader_id, place, category, tournament_name, organiser_name, front_path, back_path) values (%L, %L, %L, %L, %L, %L, %L)',
      x, 'first', 'ranked_local', '__claim test__', '__claim org__', front, back));
    results := results || row(step, 'account writes a claim around the rules', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, format(
      'insert into medals (blader_id, place, tournament_name, organiser_name, category) values (%L, %L, %L, %L, %L)',
      x, 'first', '__claim test__', '__claim org__', 'ranked_local'));
    results := results || row(step, 'account gives itself a medal without approval', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, send_sql);
    results := results || row(step, 'account sends a medal in properly', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::claim_results;

    -- Now one for real, for the checks below.
    perform pg_temp.become(x);
    execute send_sql into claim_id;
    perform pg_temp.unbecome();

    ------------------------------------------------------- who can see it

    step := step + 1;
    v := pg_temp.read_as(null, 'select count(*)::text from medal_claims');
    results := results || row(step, 'visitor sees medals waiting', 'nothing',
      v, v is null or v = '<refused>' or v = '0')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(y, format('select count(*)::text from medal_claims where id = %L', claim_id));
    results := results || row(step, 'another account sees it', '0', v, v = '0')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(x, format('select count(*)::text from medal_claims where id = %L', claim_id));
    results := results || row(step, 'the sender sees it', '1', v, v = '1')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(a, format('select count(*)::text from medal_claims where id = %L', claim_id));
    results := results || row(step, 'the approver sees it', '1', v, v = '1')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(null, 'select count(*)::text from medals where tournament_name = ''__claim test__''');
    results := results || row(step, 'it is not on the public profile yet', '0', v, v = '0')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(y, format(
      'select count(*)::text from storage.objects where bucket_id = %L and name in (%L, %L)', 'medal-proofs', front, back));
    results := results || row(step, 'another account sees its photos', '0', v, v = '0')::claim_results;

    step := step + 1;
    v := pg_temp.read_as(a, format(
      'select count(*)::text from storage.objects where bucket_id = %L and name in (%L, %L)', 'medal-proofs', front, back));
    results := results || row(step, 'the approver sees its photos', '2', v, v = '2')::claim_results;

    ------------------------------------------------------- deciding it

    step := step + 1;
    n := pg_temp.attempt(x, format('select * from public.review_medal_claim(%L, true)', claim_id));
    results := results || row(step, 'the sender approves their own medal', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(y, format('select * from public.withdraw_medal_claim(%L)', claim_id));
    results := results || row(step, 'another account withdraws it', 'nothing withdrawn',
      case when n > 0 then 'WITHDRAWN' else 'nothing withdrawn' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(x, format('select * from public.withdraw_medal_claim(%L)', claim_id));
    results := results || row(step, 'the sender withdraws it', '2 photos to delete',
      n::text || ' photos to delete', n = 2)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(a, format('select * from public.review_medal_claim(%L, false)', claim_id));
    results := results || row(step, 'the approver turns it down', '2 photos to delete',
      n::text || ' photos to delete', n = 2)::claim_results;

    -- Approved for real.
    perform pg_temp.become(a);
    perform public.review_medal_claim(claim_id, true);
    perform pg_temp.unbecome();

    step := step + 1;
    select count(*) into n from medals
      where blader_id = x and tournament_name = '__claim test__' and category = 'ranked_local' and awarded_by = a;
    results := results || row(step, 'approving writes the medal', '1', n::text, n = 1)::claim_results;

    step := step + 1;
    v := pg_temp.read_as(null, 'select count(*)::text from medals where tournament_name = ''__claim test__''');
    results := results || row(step, 'and it is on the public profile', '1', v, v = '1')::claim_results;

    step := step + 1;
    select count(*) into n from medal_claims where id = claim_id;
    results := results || row(step, 'and it no longer waits', '0', n::text, n = 0)::claim_results;

    step := step + 1;
    select count(*) into n from medal_proof_trash where path in (front, back);
    results := results || row(step, 'and its photos are listed for deleting', '2', n::text, n = 2)::claim_results;

    step := step + 1;
    v := pg_temp.read_as(a, format('select public.clear_proof_trash(array[%L, %L])::text', front, back));
    results := results || row(step, 'the list keeps photos that are not deleted yet', '0 cleared',
      coalesce(v, '?') || ' cleared', v = '0')::claim_results;

    ---------------------------------------------------------- the limit of 5

    insert into medal_claims (blader_id, place, category, tournament_name, organiser_name, front_path, back_path)
    select x, 'second', 'ranked_local', '__claim test__', '__claim org__',
           x::text || '/__f' || g, x::text || '/__b' || g
    from generate_series(1, 5) g;

    step := step + 1;
    n := pg_temp.attempt(x, send_sql);
    results := results || row(step, 'a sixth medal while five are waiting', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    ------------------------------------------- the approver giving directly

    step := step + 1;
    n := pg_temp.attempt(a, format(
      'insert into medals (blader_id, place, tournament_name, organiser_name) values (%L, %L, %L, %L)',
      x, 'first', '__claim test__', '__claim org__'));
    results := results || row(step, 'approver gives a medal with no category', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(a, format(
      'insert into medals (blader_id, place, tournament_name, organiser_name, category) values (%L, %L, %L, %L, %L)',
      x, 'first', '__claim test__', '__claim org__', 'gp'));
    results := results || row(step, 'approver gives one in a category that is coming soon', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::claim_results;

    step := step + 1;
    n := pg_temp.attempt(a, format(
      'insert into medals (blader_id, place, tournament_name, organiser_name, category) values (%L, %L, %L, %L, %L)',
      x, 'first', '__claim test__', '__claim org__', 'ranked_local'));
    results := results || row(step, 'approver gives a Ranked Locals medal', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::claim_results;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(step + 1, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::claim_results;
    end if;
  end;

  -- Everything above is rolled back; only the results are kept.
  foreach r in array results loop
    insert into claim_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from claim_results order by n;
