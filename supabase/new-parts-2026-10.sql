-- =====================================================================
--  New parts, October 2026: what HellsNether Z (UX-21) and CrocoTread
--  TQ5-50GN (CX-19) brought that the catalogue did not have.
--
--    HellsNether   ratchet-integrated blade, filed with the UX Infinity blades
--    Croco         lock chip
--    Tread         metal blade (Custom Line Infinity)
--    Tough  (T)    over blade
--    Quell  (Q)    assist blade
--    5-50          ratchet
--
--  Zap and Gear Needle are already in the catalogue. Safe to re-run:
--  parts already there are left as they are. Needs parts-schema.sql.
-- =====================================================================

insert into parts (kind, name, abbr) values
  ('infinity_blade', 'HellsNether', null),
  ('lock_chip', 'Croco', null),
  ('metal_blade', 'Tread', null),
  ('over_blade', 'Tough', 'T'),
  ('assist_blade', 'Quell', 'Q'),
  ('ratchet', '5-50', null)
on conflict (kind, lower(name)) do nothing;

-- Hells Nether, spelt as two words, means the same part.
update parts set aliases = array['Hells Nether', 'Hell''s Nether']
where kind = 'infinity_blade' and name = 'HellsNether' and cardinality(aliases) = 0;

select kind, name, abbr from parts
where (kind, name) in (('infinity_blade','HellsNether'), ('lock_chip','Croco'), ('metal_blade','Tread'),
                       ('over_blade','Tough'), ('assist_blade','Quell'), ('ratchet','5-50'));
