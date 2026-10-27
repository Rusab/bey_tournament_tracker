-- =====================================================================
--  Unranked Locals is no longer a medal category that can be chosen.
--
--  Medals already filed under it keep it, and a medal sent in under it
--  before today can still be approved. New ones, sent in or given
--  directly, must be Ranked Locals. Safe to re-run.
-- =====================================================================

create or replace function public.medal_category_open(p text)
returns boolean language sql immutable as $$
  select coalesce(p in ('ranked_local'), false);
$$;

-- What is open now: should be true, then false.
select public.medal_category_open('ranked_local') as ranked_locals,
       public.medal_category_open('unranked_local') as unranked_locals;
