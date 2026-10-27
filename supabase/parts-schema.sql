-- =====================================================================
--  The parts catalogue, in the database.
--
--  Every Beyblade X part the app knows, editable from the Parts screen by
--  the one account given parts access - so a new release can be added the
--  day it comes out, with a picture, without waiting on an app update.
--
--  Decks store part names. A part's aliases are other names that mean the
--  same part - a misspelling, an old name - so merging a stray name into
--  a part is just adding an alias, and decks that used it count toward
--  the right part without being rewritten. Renaming a part keeps the old
--  name as an alias for the same reason.
--
--  Additive only. Run the whole file once in the SQL editor; safe to
--  re-run - parts already there are left as they are. Needs
--  profiles-schema.sql to have run first.
-- =====================================================================

-- --------------------------------------------------------- parts access
--
-- Its own permission, like medal access. Nobody can give it to
-- themselves: users may only write their own name columns in profiles.

alter table profiles add column if not exists can_manage_parts boolean not null default false;

create or replace function public.is_parts_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select can_manage_parts from profiles where id = auth.uid()), false);
$$;
revoke execute on function public.is_parts_manager() from public, anon;
grant execute on function public.is_parts_manager() to authenticated;

-- ----------------------------------------------------------------- parts

create table if not exists parts (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  name       text not null,
  abbr       text,                                   -- the letters in a combo's name: Low Flat is LF
  fused      boolean not null default false,         -- a bit joined to its own ratchet
  metal      boolean not null default false,         -- a metal lock chip; a deck may hold one
  aliases    text[] not null default '{}',
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint parts_kind check (kind in ('blade', 'infinity_blade', 'lock_chip', 'main_blade',
    'metal_blade', 'over_blade', 'assist_blade', 'ratchet', 'bit')),
  constraint parts_name_len check (char_length(btrim(name)) between 1 and 40),
  constraint parts_abbr_len check (abbr is null or char_length(btrim(abbr)) between 1 and 6),
  constraint parts_aliases_count check (cardinality(aliases) <= 20)
);

-- One "Dran Sword" per kind, whatever the capitals.
create unique index if not exists parts_kind_name on parts (kind, lower(name));

alter table parts enable row level security;

drop policy if exists "parts readable by anyone" on parts;
create policy "parts readable by anyone" on parts for select using (true);

drop policy if exists "parts managers add" on parts;
create policy "parts managers add" on parts for insert to authenticated
  with check (public.is_parts_manager());

drop policy if exists "parts managers edit" on parts;
create policy "parts managers edit" on parts for update to authenticated
  using (public.is_parts_manager()) with check (public.is_parts_manager());

drop policy if exists "parts managers remove" on parts;
create policy "parts managers remove" on parts for delete to authenticated
  using (public.is_parts_manager());

revoke all on parts from anon, authenticated;
grant select on parts to anon, authenticated;
grant insert (kind, name, abbr, fused, metal, aliases, image_path) on parts to authenticated;
grant update (name, abbr, fused, metal, aliases, image_path, updated_at) on parts to authenticated;
grant delete on parts to authenticated;

-- ---------------------------------------------------------------- images
--
-- Public, so a part picture loads for any visitor. Only the parts
-- manager writes. Small: the app shrinks a picture to 256px first.

insert into storage.buckets (id, name, public)
values ('part-images', 'part-images', true)
on conflict (id) do nothing;

do $$
begin
  update storage.buckets
     set file_size_limit = 524288,
         allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg']
   where id = 'part-images';
exception when others then
  raise notice 'part-images bucket limits not set (%); the app still shrinks pictures itself', sqlerrm;
end $$;

drop policy if exists "part images managers add" on storage.objects;
create policy "part images managers add" on storage.objects for insert to authenticated
  with check (bucket_id = 'part-images' and public.is_parts_manager());

drop policy if exists "part images managers replace" on storage.objects;
create policy "part images managers replace" on storage.objects for update to authenticated
  using (bucket_id = 'part-images' and public.is_parts_manager())
  with check (bucket_id = 'part-images' and public.is_parts_manager());

drop policy if exists "part images managers remove" on storage.objects;
create policy "part images managers remove" on storage.objects for delete to authenticated
  using (bucket_id = 'part-images' and public.is_parts_manager());

-- ------------------------------------------------------ what it starts with
--
-- Everything in the app's built-in list (src/parts.js) as of October 2026.

insert into parts (kind, name, abbr, fused, metal) values
  ('blade', 'Black Shell', null, false, false),
  ('blade', 'Cobalt Dragoon', null, false, false),
  ('blade', 'Cobalt Drake', null, false, false),
  ('blade', 'Crimson Garuda', null, false, false),
  ('blade', 'Dran Dagger', null, false, false),
  ('blade', 'Dran Strike', null, false, false),
  ('blade', 'Dran Sword', null, false, false),
  ('blade', 'Dranzer Spiral', null, false, false),
  ('blade', 'Hells Chain', null, false, false),
  ('blade', 'Hells Scythe', null, false, false),
  ('blade', 'Knight Lance', null, false, false),
  ('blade', 'Knight Shield', null, false, false),
  ('blade', 'Leon Claw', null, false, false),
  ('blade', 'Mammoth Tusk', null, false, false),
  ('blade', 'Phoenix Feather', null, false, false),
  ('blade', 'Phoenix Wing', null, false, false),
  ('blade', 'Rhino Horn', null, false, false),
  ('blade', 'Samurai Calibur', null, false, false),
  ('blade', 'Samurai Steel', null, false, false),
  ('blade', 'Shark Edge', null, false, false),
  ('blade', 'Shelter Drake', null, false, false),
  ('blade', 'Sphinx Cowl', null, false, false),
  ('blade', 'Tricera Press', null, false, false),
  ('blade', 'Tyranno Beat', null, false, false),
  ('blade', 'Tyranno Roar', null, false, false),
  ('blade', 'Unicorn Sting', null, false, false),
  ('blade', 'Viper Tail', null, false, false),
  ('blade', 'Weiss Tiger', null, false, false),
  ('blade', 'Whale Wave', null, false, false),
  ('blade', 'Wizard Arrow', null, false, false),
  ('blade', 'Wyvern Gale', null, false, false),
  ('blade', 'Aero Pegasus', null, false, false),
  ('blade', 'Clock Mirage', null, false, false),
  ('blade', 'Dran Buster', null, false, false),
  ('blade', 'Ghost Circle', null, false, false),
  ('blade', 'Golem Rock', null, false, false),
  ('blade', 'Hells Hammer', null, false, false),
  ('blade', 'Impact Drake', null, false, false),
  ('blade', 'Knight Mail', null, false, false),
  ('blade', 'Leon Crest', null, false, false),
  ('blade', 'Meteor Dragoon', null, false, false),
  ('blade', 'Mummy Curse', null, false, false),
  ('blade', 'Orochi Cluster', null, false, false),
  ('blade', 'Phoenix Rudder', null, false, false),
  ('blade', 'Samurai Saber', null, false, false),
  ('blade', 'Scorpio Spear', null, false, false),
  ('blade', 'Shark Scale', null, false, false),
  ('blade', 'Shinobi Shadow', null, false, false),
  ('blade', 'Silver Wolf', null, false, false),
  ('blade', 'Wizard Rod', null, false, false),
  ('blade', 'Wyvern Hover', null, false, false),
  ('infinity_blade', 'Bullet Griffon', null, false, false),
  ('infinity_blade', 'Glory Valkyrie', null, false, false),
  ('lock_chip', 'Bahamut', null, false, false),
  ('lock_chip', 'Brachio', null, false, false),
  ('lock_chip', 'Cerberus', null, false, false),
  ('lock_chip', 'Dran', null, false, false),
  ('lock_chip', 'Emperor', null, false, true),
  ('lock_chip', 'Fox', null, false, false),
  ('lock_chip', 'Hells', null, false, false),
  ('lock_chip', 'Knight', null, false, false),
  ('lock_chip', 'Pegasus', null, false, false),
  ('lock_chip', 'Perseus', null, false, false),
  ('lock_chip', 'Ragna', null, false, false),
  ('lock_chip', 'Rhino', null, false, false),
  ('lock_chip', 'Sol', null, false, false),
  ('lock_chip', 'Unicorn', null, false, false),
  ('lock_chip', 'Valkyrie', null, false, true),
  ('lock_chip', 'Wizard', null, false, false),
  ('lock_chip', 'Wolf', null, false, false),
  ('main_blade', 'Arc', null, false, false),
  ('main_blade', 'Blast', null, false, false),
  ('main_blade', 'Brave', null, false, false),
  ('main_blade', 'Brush', null, false, false),
  ('main_blade', 'Dark', null, false, false),
  ('main_blade', 'Eclipse', null, false, false),
  ('main_blade', 'Flame', null, false, false),
  ('main_blade', 'Hunt', null, false, false),
  ('main_blade', 'Might', null, false, false),
  ('main_blade', 'Reaper', null, false, false),
  ('main_blade', 'Volt', null, false, false),
  ('metal_blade', 'Blitz', null, false, false),
  ('metal_blade', 'Delta', null, false, false),
  ('metal_blade', 'Fortress', null, false, false),
  ('metal_blade', 'Rage', null, false, false),
  ('metal_blade', 'Whip', null, false, false),
  ('over_blade', 'Break', 'B', false, false),
  ('over_blade', 'Flow', 'F', false, false),
  ('over_blade', 'Guard', 'G', false, false),
  ('over_blade', 'Outer', 'O', false, false),
  ('over_blade', 'Peak', 'P', false, false),
  ('assist_blade', 'Assault', 'A', false, false),
  ('assist_blade', 'Bumper', 'B', false, false),
  ('assist_blade', 'Charge', 'C', false, false),
  ('assist_blade', 'Dual', 'D', false, false),
  ('assist_blade', 'Erase', 'E', false, false),
  ('assist_blade', 'Free', 'F', false, false),
  ('assist_blade', 'Heavy', 'H', false, false),
  ('assist_blade', 'Jaggy', 'J', false, false),
  ('assist_blade', 'Knuckle', 'K', false, false),
  ('assist_blade', 'Odd', 'O', false, false),
  ('assist_blade', 'Round', 'R', false, false),
  ('assist_blade', 'Slash', 'S', false, false),
  ('assist_blade', 'Turn', 'T', false, false),
  ('assist_blade', 'Vertical', 'V', false, false),
  ('assist_blade', 'Wheel', 'W', false, false),
  ('ratchet', '0-60', null, false, false),
  ('ratchet', '0-70', null, false, false),
  ('ratchet', '0-80', null, false, false),
  ('ratchet', '1-50', null, false, false),
  ('ratchet', '1-60', null, false, false),
  ('ratchet', '1-70', null, false, false),
  ('ratchet', '1-80', null, false, false),
  ('ratchet', '2-60', null, false, false),
  ('ratchet', '2-70', null, false, false),
  ('ratchet', '2-80', null, false, false),
  ('ratchet', '3-60', null, false, false),
  ('ratchet', '3-70', null, false, false),
  ('ratchet', '3-80', null, false, false),
  ('ratchet', '3-85', null, false, false),
  ('ratchet', '4-50', null, false, false),
  ('ratchet', '4-55', null, false, false),
  ('ratchet', '4-60', null, false, false),
  ('ratchet', '4-70', null, false, false),
  ('ratchet', '4-80', null, false, false),
  ('ratchet', '5-60', null, false, false),
  ('ratchet', '5-70', null, false, false),
  ('ratchet', '5-80', null, false, false),
  ('ratchet', '6-60', null, false, false),
  ('ratchet', '6-70', null, false, false),
  ('ratchet', '6-80', null, false, false),
  ('ratchet', '7-55', null, false, false),
  ('ratchet', '7-60', null, false, false),
  ('ratchet', '7-80', null, false, false),
  ('ratchet', '8-70', null, false, false),
  ('ratchet', '9-60', null, false, false),
  ('ratchet', '9-65', null, false, false),
  ('ratchet', '9-70', null, false, false),
  ('ratchet', '9-80', null, false, false),
  ('ratchet', 'M-85', null, false, false),
  ('bit', 'Accel', 'A', false, false),
  ('bit', 'Ball', 'B', false, false),
  ('bit', 'Bound Spike', 'BS', false, false),
  ('bit', 'Cyclone', 'C', false, false),
  ('bit', 'Disk Ball', 'DB', false, false),
  ('bit', 'Elevate', 'E', false, false),
  ('bit', 'Flat', 'F', false, false),
  ('bit', 'Free Ball', 'FB', false, false),
  ('bit', 'Free Flat', 'FF', false, false),
  ('bit', 'Gear Ball', 'GB', false, false),
  ('bit', 'Gear Flat', 'GF', false, false),
  ('bit', 'Gear Needle', 'GN', false, false),
  ('bit', 'Gear Point', 'GP', false, false),
  ('bit', 'Gear Rush', 'GR', false, false),
  ('bit', 'Gear Unite', 'GU', false, false),
  ('bit', 'Glide', 'G', false, false),
  ('bit', 'Hexa', 'H', false, false),
  ('bit', 'High Needle', 'HN', false, false),
  ('bit', 'High Taper', 'HT', false, false),
  ('bit', 'Ignition', 'I', false, false),
  ('bit', 'Jolt', 'J', false, false),
  ('bit', 'Kick', 'K', false, false),
  ('bit', 'Level', 'L', false, false),
  ('bit', 'Low Flat', 'LF', false, false),
  ('bit', 'Low Orb', 'LO', false, false),
  ('bit', 'Low Rush', 'LR', false, false),
  ('bit', 'Merge', 'M', false, false),
  ('bit', 'Metal Needle', 'MN', false, false),
  ('bit', 'Narrow', 'Nr', false, false),
  ('bit', 'Needle', 'N', false, false),
  ('bit', 'Operate', 'Op', true, false),
  ('bit', 'Orb', 'O', false, false),
  ('bit', 'Point', 'P', false, false),
  ('bit', 'Quake', 'Q', false, false),
  ('bit', 'Rush', 'R', false, false),
  ('bit', 'Spike', 'S', false, false),
  ('bit', 'Taper', 'T', false, false),
  ('bit', 'Trans Kick', 'TK', false, false),
  ('bit', 'Trans Point', 'TP', false, false),
  ('bit', 'Turbo', 'Tr', true, false),
  ('bit', 'Under Flat', 'UF', false, false),
  ('bit', 'Under Needle', 'UN', false, false),
  ('bit', 'Unite', 'U', false, false),
  ('bit', 'Vortex', 'V', false, false),
  ('bit', 'Wall Ball', 'WB', false, false),
  ('bit', 'Wedge', 'W', false, false),
  ('bit', 'Yielding', 'Y', false, false),
  ('bit', 'Zap', 'Z', false, false)

on conflict (kind, lower(name)) do nothing;

-- --------------------------------------------------- the one account
--
-- Change the address if parts access should belong to a different
-- account; to take it away, set it to false.

update profiles set can_manage_parts = true where email = 'rusabcolabpro@gmail.com';

-- What it made:
select (select count(*) from parts) as parts,
       (select string_agg(email, ', ') from profiles where can_manage_parts) as managed_by;
