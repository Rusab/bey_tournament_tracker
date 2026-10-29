-- =====================================================================
--  Make an account the app's administrator.
--
--  Sign up in the app first (and confirm the email), then put that
--  account's email address below and run the whole file. It gives the
--  account every permission the app has:
--
--    approved            may create tournaments
--    is_staff            approves other accounts for hosting
--    can_award_medals    gives medals, approves medals sent in, manages
--                        legacy tournaments
--    can_manage_parts    edits the parts catalogue and the deck detector,
--                        approves deck photos
--
--  Each one is separate, so they can be handed to different people later:
--  run the matching line with their email. To take one away, set it to
--  false. Safe to re-run. Needs every *-schema.sql file to have run first.
-- =====================================================================

update profiles
   set approved = true,
       is_staff = true,
       can_award_medals = true,
       can_manage_parts = true
 where lower(email) = lower('your-email@example.com');   -- <- your account

-- Who holds what now. Your account should be listed with every column true.
select email, approved, is_staff, can_award_medals, can_manage_parts
from profiles
where approved or is_staff or can_award_medals or can_manage_parts
order by email;
