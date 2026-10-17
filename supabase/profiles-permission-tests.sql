-- =====================================================================
--  Do the profile permissions hold?
--
--  Impersonates a visitor, an ordinary account and an approved host in
--  turn, and checks what each may and may not do.
--
--  Every attempt runs inside a block that is rolled back afterwards,
--  whether it was meant to succeed or not, so nothing here changes your
--  data - not even a test that wrongly succeeds. Safe to re-run.
--
--  Run profiles-schema.sql first, then the whole of this file. The final
--  table is the answer.
-- =====================================================================

drop table if exists perm_results;
create temp table perm_results (n int, checked text, expected text, actual text, pass boolean);

-- Run one statement as someone, then undo it. Returns the rows it touched,
-- or -1 if it was refused outright. A null subject means a signed-out visitor.
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

-- Read one value as someone. '<refused>' if the read itself was refused.
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
  host_id   uuid;   -- approved + staff
  other_id  uuid;   -- an ordinary account, not approved to host
  host_name text;
  step int := 0;
  n int;
  v text;

begin
  select id into host_id  from profiles where approved and is_staff order by id limit 1;
  select id into other_id from profiles where not approved and id <> host_id order by id limit 1;

  if host_id is null then
    insert into perm_results values (0, 'an approved staff account exists', 'yes',
      'no - approve yourself first', false);
    return;
  end if;
  if other_id is null then
    insert into perm_results values (0, 'an account that is not approved to host', 'yes',
      'none - sign up a second account to test with', false);
    return;
  end if;

  insert into perm_results
  select 0, 'accounts under test', 'two different people',
         string_agg(p.email, ', ' order by p.approved desc), count(distinct p.id) = 2
  from profiles p where p.id in (host_id, other_id);

  select blader_name into host_name from bladers where id = host_id;

  -------------------------------------------------------- the backfill

  step := step + 1;
  select count(*) into n from profiles p where not exists (select 1 from bladers b where b.id = p.id);
  insert into perm_results values (step, 'every account has a blader row', '0 missing',
    n || ' missing', n = 0);

  step := step + 1;
  select count(*) into n from profiles where real_name is null;
  insert into perm_results values (step, 'every account has a real name', '0 missing',
    n || ' missing', n = 0);

  ---------------------------------------------------- a signed-out visitor

  step := step + 1;
  n := pg_temp.attempt(null, 'select 1 from bladers');
  insert into perm_results values (step, 'visitor reads the bladers list', 'allowed',
    case when n >= 0 then 'allowed' else 'REFUSED' end, n >= 0);

  step := step + 1;
  v := pg_temp.read_as(null, format('select public.blader_real_name(%L)', host_id));
  insert into perm_results values (step, 'visitor reads a real name', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(null, 'select email from profiles limit 1');
  insert into perm_results values (step, 'visitor reads an email', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(null, 'select public.blader_name_free(''__nobody has this__'')::text');
  insert into perm_results values (step, 'visitor checks a name is free (sign-up)', 'true',
    coalesce(v, 'nothing'), v = 'true');

  step := step + 1;
  n := pg_temp.attempt(null,
    format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'avatars', host_id || '/__perm__.webp'));
  insert into perm_results values (step, 'visitor uploads a photo', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  -------------------------------------------------- an ordinary account

  step := step + 1;
  v := pg_temp.read_as(other_id, format('select public.blader_real_name(%L)', host_id));
  insert into perm_results values (step, 'account reads someone else''s real name', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  v := pg_temp.read_as(other_id, format('select public.blader_real_name(%L)', other_id));
  insert into perm_results values (step, 'account reads its own real name', 'its name',
    coalesce(v, 'nothing'), v is not null and v <> '<refused>');

  step := step + 1;
  v := pg_temp.read_as(other_id, format('select email from profiles where id = %L', host_id));
  insert into perm_results values (step, 'account reads someone else''s email', 'nothing',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set blader_name = %L where id = %L', '__perm test name__', other_id));
  insert into perm_results values (step, 'account renames itself', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set blader_name = %L where id = %L', '__vandalised__', host_id));
  insert into perm_results values (step, 'account renames someone else', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set blader_name = %L where id = %L', '  ' || upper(host_name) || ' ', other_id));
  insert into perm_results values (step, 'account takes a name already used, in other case', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set id = gen_random_uuid() where id = %L', other_id));
  insert into perm_results values (step, 'account changes which account its row belongs to', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    'insert into bladers (id, blader_name) values (gen_random_uuid(), ''__made up__'')');
  insert into perm_results values (step, 'account creates a blader row', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set photo_path = %L where id = %L', other_id || '/me.webp', other_id));
  insert into perm_results values (step, 'account sets a photo in its own folder', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set photo_path = %L where id = %L', host_id || '/me.webp', other_id));
  insert into perm_results values (step, 'account uses a photo from someone else''s folder', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update bladers set photo_path = %L where id = %L', 'https://example.com/x.png', other_id));
  insert into perm_results values (step, 'account points its photo at another website', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update profiles set real_name = %L where id = %L', '__perm test__', other_id));
  insert into perm_results values (step, 'account changes its own real name', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update profiles set real_name = %L where id = %L', '__vandalised__', host_id));
  insert into perm_results values (step, 'account changes someone else''s real name', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update profiles set email = %L where id = %L', 'x@example.com', other_id));
  insert into perm_results values (step, 'account rewrites its stored email', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('update profiles set approved = true where id = %L', other_id));
  insert into perm_results values (step, 'account approves itself to host', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  step := step + 1;
  v := pg_temp.read_as(other_id, 'select public.free_blader_name(''x'')');
  insert into perm_results values (step, 'account calls the internal name generator', 'refused',
    coalesce(v, 'nothing'), v is null or v = '<refused>');

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'avatars', other_id || '/__perm__.webp'));
  insert into perm_results values (step, 'account uploads to its own photo folder', 'allowed',
    case when n > 0 then 'allowed' else 'REFUSED' end, n > 0);

  step := step + 1;
  n := pg_temp.attempt(other_id,
    format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'avatars', host_id || '/__perm__.webp'));
  insert into perm_results values (step, 'account uploads into someone else''s photo folder', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);

  --------------------------------------------------- an approved host

  step := step + 1;
  v := pg_temp.read_as(host_id, format('select public.blader_real_name(%L)', other_id));
  insert into perm_results values (step, 'organiser reads a player''s real name', 'their name',
    coalesce(v, 'nothing'), v is not null and v <> '<refused>');

  step := step + 1;
  n := pg_temp.attempt(host_id,
    format('update bladers set blader_name = %L where id = %L', '__vandalised__', other_id));
  insert into perm_results values (step, 'organiser renames a player', 'refused',
    case when n > 0 then 'ALLOWED' else 'refused' end, n <= 0);
end $$;

select n as "#", checked, expected, actual,
       case when pass then 'pass' else 'FAIL' end as result
from perm_results order by n;
