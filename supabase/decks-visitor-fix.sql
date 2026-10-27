-- Lets signed-out visitors read decks once a tournament has started.
-- The deck read rule asks is_parts_manager() of every viewer; visitors
-- were not allowed to run it, so every visitor read was refused. It
-- answers false for them. Safe to re-run. (Already in decks-schema.sql.)
grant execute on function public.is_parts_manager() to anon;
