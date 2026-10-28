-- =====================================================================
--  Do the deck rules hold?
--
--  Makes a test tournament with two players - one linked to an account,
--  one not - and checks who may see and change their decks before and
--  after the first match is scored. Everything is rolled back at the
--  end, so your data is left exactly as it was. Safe to re-run.
--
--  Run decks-schema.sql first, then the whole of this file.
-- =====================================================================

drop table if exists deck_results;
create temp table deck_results (n int, checked text, expected text, actual text, pass boolean);

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
  h uuid;   -- hosts the test tournament
  x uuid;   -- linked to player p1
  y uuid;   -- somebody else
  e uuid;
  results deck_results[] := '{}';
  r deck_results;
  step int := 0;
  n int;
  see text;
  put_p1 text; put_p2 text;
begin
  select id into h from profiles where approved order by id limit 1;
  select id into x from profiles where id <> h and not can_manage_parts order by id limit 1;
  select id into y from profiles where id not in (h, x) and not can_manage_parts order by id limit 1;
  if h is null or x is null or y is null then
    insert into deck_results values (0, 'a host and two other accounts to test with', 'yes', 'missing', false);
    return;
  end if;

  begin
    insert into events (owner_id, name, data) values (h, '__deck test__', jsonb_build_object(
      'players', jsonb_build_array(
        jsonb_build_object('id', 'p1', 'name', 'Linked', 'profileId', x,
          'deck', jsonb_build_array(jsonb_build_object('type', 'bx', 'blade', 'Dran Sword'))),
        jsonb_build_object('id', 'p2', 'name', 'Not linked')),
      'groupMatches', jsonb_build_array(jsonb_build_object('id', 'm1', 'events', '[]'::jsonb))))
    returning id into e;

    step := step + 1;
    select count(*) into n from events where id = e and jsonb_path_exists(data, '$.players[*].deck');
    results := results || row(step, 'a deck written into new tournament data is taken out', '0', n::text, n = 0)::deck_results;

    -- An old copy of the app saving a deck into the data: it moves to the table.
    update events set data = jsonb_set(data, '{players,1,deck}',
      jsonb_build_array(jsonb_build_object('type', 'bx', 'blade', 'Wizard Rod'))) where id = e;
    step := step + 1;
    select count(*) into n from event_decks where event_id = e and player_id = 'p2';
    results := results || row(step, 'a deck saved into the data moves to its own table', '1', n::text, n = 1)::deck_results;
    step := step + 1;
    select count(*) into n from events where id = e and jsonb_path_exists(data, '$.players[*].deck');
    results := results || row(step, 'and is gone from the public data', '0', n::text, n = 0)::deck_results;

    insert into event_decks (event_id, player_id, deck)
    values (e, 'p1', jsonb_build_array(jsonb_build_object('type', 'bx', 'blade', 'Dran Sword')));

    see := format('select 1 from event_decks where event_id = %L and player_id = %L', e, 'p1');
    put_p1 := format('update event_decks set deck = %L where event_id = %L and player_id = %L',
      '[{"type":"bx","blade":"Hells Scythe"}]', e, 'p1');
    put_p2 := format('update event_decks set deck = %L where event_id = %L and player_id = %L',
      '[{"type":"bx","blade":"Hells Scythe"}]', e, 'p2');

    ---------------------------------------------------- before it starts

    step := step + 1; n := pg_temp.attempt(null, see);
    results := results || row(step, 'before the start: visitor sees a deck', 'hidden',
      case when n > 0 then 'SEEN' else 'hidden' end, n <= 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(y, see);
    results := results || row(step, 'before the start: another account sees it', 'hidden',
      case when n > 0 then 'SEEN' else 'hidden' end, n <= 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(x, see);
    results := results || row(step, 'before the start: the linked blader sees their own', 'seen',
      case when n > 0 then 'seen' else 'HIDDEN' end, n > 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(h, see);
    results := results || row(step, 'before the start: the host sees it', 'seen',
      case when n > 0 then 'seen' else 'HIDDEN' end, n > 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(x, put_p1);
    results := results || row(step, 'before the start: the linked blader changes their own', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(x, put_p2);
    results := results || row(step, 'the linked blader changes somebody else''s', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(y, put_p1);
    results := results || row(step, 'another account changes a deck', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(null, put_p1);
    results := results || row(step, 'visitor changes a deck', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;

    -------------------------------------------- the first match is scored

    update events set data = jsonb_set(data, '{groupMatches,0,events}', '[{"side":1,"type":"spin","pts":1}]')
    where id = e;

    step := step + 1; n := pg_temp.attempt(null, see);
    results := results || row(step, 'after the start: visitor sees a deck', 'seen',
      case when n > 0 then 'seen' else 'HIDDEN' end, n > 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(x, put_p1);
    results := results || row(step, 'after the start: the linked blader changes their own', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;
    step := step + 1; n := pg_temp.attempt(h, put_p1);
    results := results || row(step, 'after the start: the host changes it', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::deck_results;
    -- An organiser unticks "Lock bladers' own decks" mid-tournament.
    update events set data = data || '{"decksLocked": false}'::jsonb where id = e;
    step := step + 1; n := pg_temp.attempt(x, put_p1);
    results := results || row(step, 'lock unticked after the start: the linked blader changes their own', 'allowed',
      case when n > 0 then 'allowed' else 'REFUSED' end, n > 0)::deck_results;
    update events set data = data || '{"decksLocked": true}'::jsonb where id = e;
    step := step + 1; n := pg_temp.attempt(x, put_p1);
    results := results || row(step, 'lock ticked again: the linked blader changes their own', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;

    step := step + 1; n := pg_temp.attempt(h, format(
      'update event_decks set deck = %L where event_id = %L and player_id = %L', '[]', e, 'p1'));
    results := results || row(step, 'a deck with nothing in it', 'refused',
      case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0)::deck_results;

    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then
      perform set_config('role', 'postgres', true);
      results := results || row(step + 1, 'the tests ran to the end', 'yes', 'stopped: ' || sqlerrm, false)::deck_results;
    end if;
  end;

  foreach r in array results loop
    insert into deck_results values (r.n, r.checked, r.expected, r.actual, r.pass);
  end loop;
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from deck_results order by n;
