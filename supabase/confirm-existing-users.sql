-- =====================================================================
--  Confirm the accounts that predate working confirmation emails.
--
--  Sign-ups were made while "Confirm email" was off, so nobody ever
--  had an address to verify. Turning it on leaves them all sitting
--  unconfirmed and unable to sign in, through no fault of their own.
--
--  This marks them confirmed in place. No email is sent.
--
--  It is a claim made on their behalf, so run it while the list below
--  is still only people you recognise -- it asserts that each address
--  belongs to whoever signed up with it, which is the thing the email
--  would otherwise have proved.
-- =====================================================================

-- Look first. These are the accounts the update would touch.
select id, email, created_at
from auth.users
where email_confirmed_at is null
order by created_at;

-- Then confirm them.
--
-- email_confirmed_at is the column that decides this. confirmed_at is
-- generated from it and from the phone column, and writing to it is
-- rejected -- leave it alone and it follows.
update auth.users
   set email_confirmed_at = now()
 where email_confirmed_at is null;

-- What is left unconfirmed afterwards: should be nothing.
select count(*) as still_unconfirmed
from auth.users
where email_confirmed_at is null;
