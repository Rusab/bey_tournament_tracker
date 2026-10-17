# Player profiles — plan

Every account is a player account. Hosting approval stays separate and manual,
exactly as it is now.

## Decisions made

| Question | Decision |
|---|---|
| Where medals come from | Typed in by hand only. The app never awards a medal itself. |
| Who can enter medals | Organisers (approved hosts) and staff only. Players cannot add or change their own. |
| Who can see a real name | The player themselves, organisers and staff. Never public. |
| Tag team medals | Each linked member gets the medal on their own profile. |
| Blader names | Unique, ignoring capitals, so two people cannot both be "Rusab". |

## Where things live

| What | Where | Readable by |
|---|---|---|
| Blader name, experience, favourite combo, photo | New `bladers` table, one row per account | Everyone |
| Real name | Existing private `profiles` table, next to the email | Self, organisers, staff — through a function that checks |
| Email, hosting approval, staff flag | `profiles`, unchanged | Self and staff, as now |
| Profile photos | New public `avatars` bucket, one folder per account | Everyone; only the owner writes to their folder |
| Medals | New `medals` table | Everyone; only organisers and staff write |
| Tournament player ↔ profile link | Optional `profileId` on each player inside the tournament's data | Same as the tournament |
| Parts catalogue | A data file in the app | Everyone |

Keeping the public profile in its own table is the central choice: profiles go
public without any of the existing permission rules being loosened, and email
and real name never leave the private table.

## Phases

Each phase ships on its own. Every database script only adds tables, columns
and functions, runs before the code that needs it, and comes with permission
tests run as each kind of account. No existing tournament ever needs migrating.

### 1. Profiles

- Sign up asks for blader name and real name, both required. They travel with
  the account and are copied in on first sign-in, after the email is confirmed.
- Existing accounts start with both names set to the part of their email before
  the @, and change them from their profile.
- Profile button: edit your own details and photo. Photos are shrunk in the
  browser before upload, the same way tournament backgrounds are.
- Bladers list, public and searchable; tap anyone for their profile.
- Organisers in the tournament directory show their blader name.
- Touches no tournament.

### 2. Medals

- On any profile, an organiser or staff member sees **Add medal**: place (1st,
  2nd, 3rd, Swiss medal), tournament name, organiser, season (default "S1").
- Tag team: **also award to teammate**, so each member gets it.
- A medal can be removed by whoever added it, or by staff.
- The profile shows a count per medal, grouped by season as
  "S1 Regular Tournament Podium List", expanding to tournament and organiser.

### 3. Linking tournament players to profiles

- In setup, an email in place of a name links that account and uses its blader
  name. No such account: say so, and allow it as a plain name instead.
- After setup: **Link to profile** by email on any player, and unlink.
- Tag team members are linked one by one.
- The lookup works for the tournament's owner and its referees, and only ever
  returns a blader name — never an email.
- Unlinked players and old tournaments are untouched; everything still reads a
  player's name the way it does today.
- The profile can list the tournaments that blader has played in the app.

### 4. Parts and decks

- The full Beyblade X parts catalogue — blades, ratchets, bits, and the Custom
  Line lock chips, main blades and assist blades — compiled from a published
  list and checked before it ships. No part names from memory.
- Optional deck per player in a tournament: 3 combos for group-stage
  tournaments and leagues, 4 for tag team, each built from the catalogue.
- Favourite combo on the profile can then use the same picker.
