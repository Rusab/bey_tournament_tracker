-- =====================================================================
--  Medals, part 3: a blader can remove their own.
--
--  Only from their own profile, and only their own row: for a tag team,
--  the teammate's medal stays on the teammate's profile. Nobody can add
--  or change a medal this way; removing is all.
--
--  Additive only. Run the whole file once in the SQL editor; safe to
--  re-run. Needs medals-schema.sql to have run first.
-- =====================================================================

drop policy if exists "bladers remove their own medals" on medals;
create policy "bladers remove their own medals" on medals for delete to authenticated
  using (blader_id = auth.uid());

-- Delete was already granted to signed-in accounts by medals-schema.sql;
-- the policies decide which rows. Repeated here so this file stands alone.
grant delete on medals to authenticated;

-- What it made:
select policyname, cmd from pg_policies where tablename = 'medals' order by policyname;
