# v2 — accounts, many tournaments, referees, formats

Branch: `v2-accounts-and-formats`. Nothing here is deployed; `master` keeps
serving the live app until this is merged deliberately.

## Decisions taken

| | |
|---|---|
| **Tag team** | A team is one competitor. It has a name and a member list, and a match is a single score line, exactly as two bladers are today. |
| **League** | Single round robin — everyone plays everyone once — ranked on league points, with the points for a win and a draw configurable. No groups, no knockout. |
| **Referee** | Runs an assigned tournament: enters scores *and* makes draws and builds brackets. Cannot rename, delete, or take ownership. |
| **Hosting** | Anyone may sign up, but only an approved account can create tournaments. You approve. |

## The thing that made this necessary

Today's policies grant write access to **any authenticated user**:

```sql
create policy "admin update" on tournaments for update to authenticated using (true);
```

That is safe only because signing up is switched off. Opening registration
against those policies would let any stranger who registers overwrite or delete
every tournament. So the permission model below is not a later refinement — it
is the precondition for the accounts feature existing at all.

## Data model

```
profiles          one per account: approved (may host), is_staff (may approve)
events            one row per tournament: owner_id, name, format, data (jsonb)
event_referees    (event_id, user_id) — who may run which tournament
```

The per-tournament blob keeps its present shape, so the existing domain code
carries over. `events` is a new table: the live `tournaments` table is left
alone, and Xtreme Clash S2 keeps working throughout.

## Who can do what

| | Spectator | Signed up | Approved host | Referee on an event | Staff |
|---|---|---|---|---|---|
| Read any scoreboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create a tournament | | | ✅ | | ✅ |
| Score, draw, build brackets | | | own | assigned | |
| Rename / delete | | | own | | |
| Add or remove referees | | | own | | |
| Approve a host | | | | | ✅ |

### Policies alone do not achieve this

A referee satisfies the events `UPDATE` policy, and nothing in that policy stops
them writing `owner_id = auth.uid()` — which would hand them the tournament.
The same hole lets any user set their own `approved` or `is_staff`.

Row policies decide which **rows** are writable; only column grants decide which
**columns** are. Hence, in `v2-schema.sql`:

```sql
grant update (name, format, data, archived) on events to authenticated;
grant update (display_name) on profiles to authenticated;
```

Approval is a `security definer` function that checks `is_staff()`, so the
privilege cannot be granted by anyone who merely holds a login.

## Formats

All three share one blob shape; `format` says how to read it.

- **knockout** — what exists now: groups, then a bracket.
- **tag** — identical, except a competitor carries `members: string[]`. Your own
  observation, and it is the whole implementation: the draw, scoring, bracket,
  standings and CSV need no change beyond showing the members under the name.
- **league** — no groups and no bracket. One round robin across everyone, and a
  table ranked on league points, then winning margin. Reuses the existing
  `roundRobin()` fixture generator.

## Spectator links

With several tournaments live, a QR code has to name one: `/?t=<event id>`.
`scripts/make-qr.mjs` takes that id and the tournament's own logo.

## Applying the schema

Run **`supabase/v2-schema.sql` in full** in the Supabase SQL editor, then the
one line at the bottom of it that makes you staff. That order is not optional:
the line updates a table the file creates.

The editor runs a file as a single transaction, so a failure anywhere rolls
back everything and the error you see may name a table that was never created.
`node scripts/check-sql.mjs supabase/v2-schema.sql` parses a migration with
Postgres's own parser first, which rules out shape as the cause.

The profile row is created by `ensure_profile()`, which the app calls once
after signing in — deliberately not a trigger on `auth.users`, which Supabase
owns and newer projects refuse.

## Build order

1. **Schema** — `supabase/v2-schema.sql`. Blocks everything else.
2. **Auth** — sign up, sign in, and the waiting-for-approval state.
3. **Tournaments** — list, create, open, archive; load and save by id; `?t=`.
4. **Referees** — add by email, remove; the staff approvals screen.
5. **Formats** — tag team, then league.
6. **Migration** — copy S2 into `events`, then retire the old table.

## Migrating Xtreme Clash S2

Once you are approved, with the old row still in place:

```sql
insert into events (owner_id, name, format, data)
select (select id from auth.users where email = 'your-account@example.com'),
       coalesce(data->>'name', 'Xtreme Clash S2'), 'knockout', data
from tournaments where id = 'current';
```

Leave `tournaments` in place until the new app is live and verified. Deleting it
is the last step, not the first.
