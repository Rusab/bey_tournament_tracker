-- =====================================================================
--  Do the detection rules hold?
--
--  Checks who may store references, that matching finds the closest
--  blade, and the deck photo queue: sending, privacy, the waiting limit,
--  and the parts manager's decision. Everything is rolled back at the
--  end, so your data is left exactly as it was. Safe to re-run.
--
--  Run detection-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists detect_results;
create temp table detect_results (n int, checked text, expected text, actual text, pass boolean);

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

-- The same, but the change is kept (for steps later checks build on).
create or replace function pg_temp.keep(p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare out text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  begin
    execute p_sql into out;
  exception when others then
    out := 'error: ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return out;
end $$;

-- 768 numbers, all 0 but a 1 at position k.
create or replace function pg_temp.unit(k int) returns real[] language plpgsql as $$
declare a real[] := array_fill(0::real, array[768]);
begin a[k] := 1; return a; end $$;

do $$
declare
  m uuid;   -- the parts manager
  x uuid;   -- a blader
  y uuid;   -- somebody else
  b1 uuid; b2 uuid; rat uuid;
  results detect_results[] := '{}';
  step int := 0;
  n int;
  r detect_results;
  photo uuid;
  path text;
  boxes jsonb;
  out text;
begin
  select id into m from profiles where can_manage_parts order by id limit 1;
  select id into x from profiles where not can_manage_parts order by id limit 1;
  select id into y from profiles where not can_manage_parts and id <> x order by id limit 1;
  if m is null or x is null or y is null then
    insert into detect_results values (0, 'a parts manager and two other accounts to test with', 'yes', 'missing', false);
    return;
  end if;

  begin
    insert into parts (kind, name) values ('blade', '__test blade one__') returning id into b1;
    insert into parts (kind, name) values ('blade', '__test blade two__') returning id into b2;
    insert into parts (kind, name) values ('ratchet', '__9-99__') returning id into rat;

    ------------------------------------------------------------ references

    step := step + 1; n := pg_temp.attempt(null, format(
      'insert into part_refs (part_id, model, embedding) values (%L, %L, %L::real[]::extensions.vector)', b1, 'test', pg_temp.unit(1)));
    results := results || row(step, 'visitor stores a reference', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format(
      'insert into part_refs (part_id, model, embedding) values (%L, %L, %L::real[]::extensions.vector)', b1, 'test', pg_temp.unit(1)));
    results := results || row(step, 'a blader stores a reference', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(m, format(
      'insert into part_refs (part_id, model, embedding) values (%L, %L, %L::real[]::extensions.vector)', b1, 'test', pg_temp.unit(1)));
    results := results || row(step, 'the parts manager stores a reference', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::detect_results;

    insert into part_refs (part_id, model, embedding) values
      (b1, 'test', pg_temp.unit(1)::extensions.vector),
      (b2, 'test', pg_temp.unit(2)::extensions.vector),
      (rat, 'test', pg_temp.unit(3)::extensions.vector);

    step := step + 1;
    select name into out from public.match_parts(
      (array_fill(0::real, array[1]) || array[0.9::real] || array_fill(0::real, array[766]))::extensions.vector, 'test', 3) limit 1;
    results := results || row(step, 'matching names the closest blade', '__test blade two__', coalesce(out, 'nothing'),
      out = '__test blade two__')::detect_results;
    step := step + 1;
    select count(*) into n from public.match_parts(pg_temp.unit(3)::extensions.vector, 'test', 5) where name = '__9-99__';
    results := results || row(step, 'a ratchet is never offered for a bey', '0', n::text, n = 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(null,
      'select 1 from part_refs limit 1');
    results := results || row(step, 'visitor reads references', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::detect_results;

    ------------------------------------------------------------ deck photos

    path := x::text || '/__test__.jpg';
    insert into storage.objects (bucket_id, name, owner) values ('deck-photos', path, x);
    boxes := jsonb_build_array(
      jsonb_build_object('x', 0.1, 'y', 0.2, 'w', 0.3, 'h', 0.3, 'part_id', b1, 'e', to_jsonb(pg_temp.unit(5))),
      jsonb_build_object('x', 0.5, 'y', 0.2, 'w', 0.3, 'h', 0.3, 'part_id', b2, 'e', to_jsonb(pg_temp.unit(6))));

    step := step + 1; n := pg_temp.attempt(y, format(
      'select public.submit_deck_photo(%L, %L::jsonb, %L)', path, boxes, 'test'));
    results := results || row(step, 'sending a photo from someone else''s folder', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format(
      'select public.submit_deck_photo(%L, %L::jsonb, %L)', x::text || '/missing.jpg', boxes, 'test'));
    results := results || row(step, 'sending a photo that was never uploaded', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format(
      'select public.submit_deck_photo(%L, %L::jsonb, %L)', path,
      jsonb_set(boxes, '{0,part_id}', to_jsonb(rat)), 'test'));
    results := results || row(step, 'a bey labelled with a ratchet', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format(
      'select public.submit_deck_photo(%L, %L::jsonb, %L)', path,
      jsonb_set(boxes, '{0,e}', '[1,2,3]'), 'test'));
    results := results || row(step, 'a bey with damaged numbers', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;

    out := pg_temp.keep(x, format('select public.submit_deck_photo(%L, %L::jsonb, %L)::text', path, boxes, 'test'));
    step := step + 1;
    results := results || row(step, 'the blader sends their photo', 'sent',
      case when out like 'error%' then out else 'sent' end, out not like 'error%')::detect_results;
    photo := out::uuid;

    step := step + 1; n := pg_temp.attempt(y, format('select 1 from deck_photos where id = %L', photo));
    results := results || row(step, 'another account sees it', 'hidden',
      case when n > 0 then 'SEEN' else 'hidden' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(null, format('select 1 from deck_photos where id = %L', photo));
    results := results || row(step, 'a visitor sees it', 'hidden',
      case when n > 0 then 'SEEN' else 'hidden' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(m, format('select 1 from deck_photos where id = %L', photo));
    results := results || row(step, 'the parts manager sees it', 'seen',
      case when n > 0 then 'seen' else 'HIDDEN' end, n > 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format('update deck_photos set status = %L where id = %L', 'approved', photo));
    results := results || row(step, 'the blader approves their own photo', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1; n := pg_temp.attempt(x, format('select public.review_deck_photo(%L, true)', photo));
    results := results || row(step, 'the blader approves it through the review', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    step := step + 1;
    out := pg_temp.keep(y, format('select coalesce(public.withdraw_deck_photo(%L), %L)', photo, 'nothing'));
    results := results || row(step, 'another account withdraws it', 'nothing',
      out, out = 'nothing' and exists (select 1 from deck_photos where id = photo))::detect_results;

    -- Ten waiting is the limit.
    insert into deck_photos (user_id, photo_path, boxes, model)
    select x, path, boxes, 'test' from generate_series(1, 9);
    step := step + 1; n := pg_temp.attempt(x, format(
      'select public.submit_deck_photo(%L, %L::jsonb, %L)', path, boxes, 'test'));
    results := results || row(step, 'an eleventh photo waiting', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::detect_results;
    delete from deck_photos where user_id = x and id <> photo;

    -- The parts manager corrects box 2 to blade one and approves.
    out := pg_temp.keep(m, format('select coalesce(public.review_deck_photo(%L, true, %L::jsonb), %L)',
      photo, jsonb_build_array(b1, b1), 'kept'));
    step := step + 1;
    results := results || row(step, 'the parts manager approves, correcting a label', 'kept', out, out = 'kept')::detect_results;
    step := step + 1;
    select count(*) into n from part_refs where photo_id = photo and part_id = b1 and source = 'photo';
    results := results || row(step, 'both boxes became references of the corrected blade', '2', n::text, n = 2)::detect_results;
    step := step + 1;
    select count(*) into n from deck_photos where id = photo and status = 'approved'
      and not jsonb_path_exists(boxes, '$[*].e');
    results := results || row(step, 'the photo is kept, without its numbers', '1', n::text, n = 1)::detect_results;
    step := step + 1;
    out := pg_temp.keep(x, format('select coalesce(public.withdraw_deck_photo(%L), %L)', photo, 'nothing'));
    results := results || row(step, 'an approved photo cannot be withdrawn', 'nothing', out, out = 'nothing')::detect_results;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(step + 1, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::detect_results;
    end if;
  end;

  foreach r in array results loop
    insert into detect_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from detect_results order by n;
