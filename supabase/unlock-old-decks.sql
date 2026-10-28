-- =====================================================================
--  Lets linked bladers add or change their own decks in every tournament
--  saved before the "Lock bladers' own decks" setting existed. Those had
--  no setting, so they counted as locked once started; this unticks it.
--
--  Tournaments that already have the setting are left alone. Re-lock any
--  tournament by ticking the box in its Settings. Needs
--  decks-lock-setting.sql to have run first. Safe to re-run.
-- =====================================================================

update events set data = data || '{"decksLocked": false}'::jsonb
where jsonb_typeof(data->'decksLocked') is distinct from 'boolean';

-- Every tournament and whether bladers' own decks are locked (all false now).
select name, (data->>'decksLocked')::boolean as decks_locked from events order by created_at desc;
