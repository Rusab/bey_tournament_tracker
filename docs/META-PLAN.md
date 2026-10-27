# Meta leaderboard — plan

The goal: a public page showing which blades and combos are being used most and
which win most, worked out from the app's own tournaments.

## Decisions made

| Question | Decision |
|---|---|
| Where the parts list lives | In the database. You add, edit, merge and photograph parts from a Parts screen only you can use. |
| Part images | Yes. Small PNGs with transparency kept, shrunk in the browser to about 256px. |
| Which tournaments count | All of them. You can tag a tournament as **official**, and the Meta page can show official only. |
| Who enters decks | Bladers (for themselves, in a tournament they are linked to) and organisers. A blader's own editing locks when the tournament starts; organisers can change any deck at any time, during or after the tournament. |
| How results are credited | Deck credit: a podium, top cut or match record counts for every blade and combo in that deck. |

## Phase 1 — parts catalogue in the database (built)

- A `parts` table: kind (blade, infinity blade, lock chip, main blade, metal blade,
  over blade, assist blade, ratchet, bit), name, short name used in combo labels,
  flags (bit fused with a ratchet, metal lock chip), image, and **aliases**.
- Seeded with everything in today's `src/parts.js`, so nothing is lost.
- Readable by everyone. Writable only by an account given parts access, set for
  your account alone, the way medal access is.
- If the database cannot be reached, the app falls back to the built-in list.
- **Images:** a public `part-images` bucket. Uploaded from the Parts screen,
  shrunk first, PNG or WebP with the transparent background kept, about 100KB at most.
- **Merging:** decks store part names, so merging a misspelt name into the right
  part adds it as an alias. Old decks then count toward the right part without
  being rewritten.
- **Names typed in that are not in the catalogue:** the Parts screen lists every
  unknown name found in decks, with how many decks use it. For each one: add it
  as a new part, or merge it into an existing one.

Looking ahead to automatic blade detection: one catalogue image per part is a
start, but a recognition model would need many photos of each part, from
different angles. The Parts screen can grow a photo set per part later.

## Phase 2 — official tournaments

- An `official` flag on each tournament. Only you can set or clear it.
- Shown as an **Official** badge on the tournament list and the scoreboard.

## Phase 3 — decks entered by bladers (built)

- A blader linked to a player in a tournament can enter or change that deck.
- Organisers (host and referees) can change any deck at any time.
- Decks move to their own table, one row per player per tournament, so a
  blader's save can never be overwritten by an organiser's scoreboard saving
  at the same moment. Existing decks are copied over.
- A blader's own editing locks once the tournament starts. Organisers can
  still change it.

## Phase 4 — the Meta page

Public, with two tables and a filter: **All tournaments / Official only**.

| Column | What it counts |
|---|---|
| Decks | Tournament entries whose deck includes it |
| Usage | Share of all entered decks |
| 1st / 2nd / 3rd | Final placings, once a tournament's top three are decided |
| Top cut | Entries that made the knockout bracket |
| Match record | Group, league and Swiss matches won and lost, and win % |

- **Blades** table, and a **Combos** table for each exact combo. Tap a blade to
  see its own combos ranked.
- **Default order:** podium points (1st = 3, 2nd = 2, 3rd = 1). Ties go to more
  top cuts, then more decks. Any column can be tapped to sort by it.
- Percentages need at least 5 decks behind them, so one lucky entry cannot top a chart.

## Later

- Battle credit: the score sheet records which bey each side launched, so
  combos are credited for the battles they actually won.
- Automatic blade detection from a photo.

## Deck photo detection (in the browser, free)

- Done first: part pickers show each match's picture and name, and decks are
  shown with part pictures beside the text.
- One photo of the whole deck: beys laid out top-down on a plain surface, not
  touching. Each bey is found with plain image processing (background
  separation, then round shapes), cropped, and matched. The player can move or
  add a box the processing missed.
- Matching: DINOv2-small, quantised, run in the browser (transformers.js or
  onnxruntime-web). Its embedding is compared in Supabase with pgvector
  against verified references of each part. The top 3 are shown with pictures
  and names; the player confirms.
- References: the catalogue pictures, embedded offline with rotations, colour
  jitter and synthetic backgrounds. A confirmed player photo is a reference
  only once you approve it, from a Photos tab in Approvals.
- Every approved deck photo comes with its boxes and labels, the dataset for
  training a small detector later.
- Below a minimum similarity the app says it is not sure and asks the player
  to pick the part.
