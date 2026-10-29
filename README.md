# Beyblade X Tournament Tracker

An open-source base for any Beyblade X community to run its own tournaments: live
scoring, brackets that spectators follow on their phones, blader profiles, medals,
decks, and a meta ranking of the blades your community actually plays.

It runs entirely on free tiers (Supabase for the database, Cloudflare for hosting),
so a community can have its own copy, under its own name, at no cost.

---

## What it does

**Tournaments**
- Three formats: **Groups & knockout**, **League**, and **Tag team**.
- Draw groups, score every battle finish by finish (Spin, Over, Burst, Xtreme, penalties),
  and build the knockout bracket from the group tables. A **tree view** shows the bracket
  with group positions (A1, B2…).
- Best-of sets, third-place match, tie-breaks, and a configurable final ranking.
- **Referees**: the host adds helpers by email, and they score on their own phones.
- **Live for spectators**: anyone with the link (or a QR code) watches scores update in
  real time, with no account needed.
- Played matches are protected. Nothing that would wipe a saved result goes through until
  that match is cleared by hand.
- Export a CSV of the whole tournament, or a **ranking image** sized for social media.

**Bladers**
- Accounts with a public **blader profile**: name, photo, experience, favourite combo.
- Tournament players can be linked to profiles, so results follow a blader across events.
- **Series**: rank several tournaments together (a season, a saga, a lifetime ranking).

**Medals**
- Podium medals on blader profiles, by category (Ranked Locals open; League, S1, G3, G2,
  G1 and GP listed as coming soon).
- Bladers send their own medals in with photos of both sides; an approver accepts or
  turns them down, and the photos are deleted either way.

**Decks and the meta**
- A **parts catalogue** of about 190 Beyblade X parts (blades, ratchets, bits, and every
  Custom Line part), with pictures, editable from the app as new releases come out.
- Bladers enter their own decks; organisers can edit any deck. Decks stay hidden until
  the tournament starts.
- **Deck scanning**: photograph a deck, tap each bey, and the app suggests the blade. It
  runs a small vision model (DINOv2) in the browser, free, with no server.
- The **Meta page** ranks blades and combos across every tournament by podiums, top cuts,
  usage and win rate.
- **Legacy tournaments**: record podiums (and decks) from events played before the app.

---

## What you need

- A computer with **[Node.js](https://nodejs.org) 20 or newer** and **[Git](https://git-scm.com)**.
- Three free accounts: **[GitHub](https://github.com)**, **[Supabase](https://supabase.com)**
  and **[Cloudflare](https://dash.cloudflare.com/sign-up)**.
- About an hour for the first setup.

No programming is needed to run your own copy. You will copy and paste some database
scripts and fill in a few settings.

---

## Step 1 — Get the code

1. On GitHub, press **Fork** at the top of this page. You now have your own copy.
2. On your computer, download it and install what it needs:

   ```bash
   git clone https://github.com/YOUR-GITHUB-NAME/bey_tournament_tracker.git
   cd bey_tournament_tracker
   npm install
   ```

---

## Step 2 — Create the Supabase project

Supabase holds everything: accounts, tournaments, profiles, pictures.

1. In the [Supabase dashboard](https://supabase.com/dashboard), press **New project**.
   - **Name**: anything, for example `beyblade-community`.
   - **Database password**: press *Generate* and save it in a password manager. The app
     never needs it; it's only for you.
   - **Region**: the one closest to your community, since scores travel there and back.
2. Wait a minute or two while it starts.
3. Open **Project Settings → API** (also listed as **Data API** / **API Keys**) and copy two values:
   - the **Project URL** (`https://xxxxxxxx.supabase.co`)
   - the **anon / public** key (on newer projects: the **publishable** key)

   Do **not** use the `service_role` / secret key anywhere in the app. It bypasses every
   security rule.

---

## Step 3 — Build the database

All the app's tables, security rules and storage buckets are in the `supabase/` folder.
Run them **in this order**, one at a time:

1. Open **SQL Editor** in Supabase and press **New query**.
2. Open the file from the `supabase/` folder in any text editor, copy **all** of it,
   paste it in, and press **Run**.
3. Check it ends with "Success" (most files finish by printing a small summary table),
   then move on to the next.

| # | File | What it sets up |
|---|------|-----------------|
| 1 | `v2-schema.sql` | Accounts, tournaments, referees, live updates |
| 2 | `profiles-schema.sql` | Blader profiles and the profile-photo bucket |
| 3 | `linking-schema.sql` | Linking tournament players to blader profiles |
| 4 | `picker-schema.sql` | Choosing bladers from a list |
| 5 | `series-schema.sql` | Series (tournaments ranked together) |
| 6 | `medals-schema.sql` | Medals |
| 7 | `medal-claims-schema.sql` | Medal categories, and medals sent in with photo proof |
| 8 | `own-medals-schema.sql` | Bladers removing their own medals |
| 9 | `parts-schema.sql` | The parts catalogue (about 190 parts) and the part-picture bucket |
| 10 | `new-parts-2026-10.sql` | Parts from later releases |
| 11 | `decks-schema.sql` | Decks, kept hidden until a tournament starts |
| 12 | `detection-schema.sql` | Deck scanning (turns on the `vector` extension) |
| 13 | `legacy-schema.sql` | Legacy tournaments |
| 14 | `images-schema.sql` | Tournament backgrounds and logos |

Every file is safe to run twice, so if one stops partway, fix the problem and run it
again.

**You can skip these.** They exist only to upgrade older copies of the app:
`decks-visitor-fix.sql`, `decks-lock-setting.sql`, `retire-unranked-locals.sql`,
`unlock-old-decks.sql`, `migrate-v1-tournament.sql`, `legacy-from-medals.sql`.

**Optional: check the security rules.** Each `*-permission-tests.sql` file pretends to be
different kinds of users and checks what each may do, then undoes everything it touched.
Run one after its schema; every row should say `pass`. Most need two or three accounts to
exist first, so they are easiest to run after Step 5.

---

## Step 4 — Set up sign-in

Under **Authentication** in Supabase:

1. **Sign In / Providers → Email**: make sure **Enable sign ups** and **Confirm email**
   are both **on**. Bladers make their own accounts; nobody can host a tournament until
   you approve them, so open sign-ups are safe.
2. **URL Configuration**:
   - **Site URL**: for now, `http://localhost:5173`. You'll change it to your live
     address in Step 6.
   - **Redirect URLs**: add `http://localhost:5173/**`.

   Confirmation and password-reset emails send people back to these addresses. A wrong
   value sends them to a page that doesn't exist.
3. **Emails (SMTP)**: Supabase's built-in email sender only allows a few emails an
   hour, which is fine for testing but not for a sign-up rush at an event. Before you go
   live, connect a free email service under **Authentication → Emails → SMTP Settings**
   (for example [Resend](https://resend.com) or [Brevo](https://www.brevo.com)).

---

## Step 5 — Run it on your computer and make yourself the admin

1. In the project folder, copy the example settings file and fill it in with the two
   values from Step 2:

   ```bash
   cp .env.example .env
   ```

   ```
   VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
   ```

   `.env` is never uploaded to GitHub, which is deliberate.

2. Start the app:

   ```bash
   npm run dev
   ```

   Open the address it prints (`http://localhost:5173`).

3. Press **Sign in**, then **No account yet? Sign up**. Sign up with your own email and
   click the link in the confirmation email.

4. Make that account the administrator. Open `supabase/make-admin.sql`, replace
   `your-email@example.com` with your email, and run it in the SQL Editor. Your row should
   show `true` in every column.

5. Reload the app. You now have:
   - **New tournament**, because you're approved to host
   - **Approvals**: hosting requests, medals sent in, deck photos
   - **Parts**: the catalogue and the deck detector
   - the **Legacy tournaments** tab

Each of these is a separate permission and can be handed to different people later. The
comments in `make-admin.sql` show how.

---

## Step 6 — Put it online with Cloudflare

The app is a website with no server of its own: Cloudflare serves its files, and
everything else talks to Supabase directly.

1. Push your copy to GitHub if you've changed anything (`git push`).
2. Open `wrangler.jsonc` and change `"name"` to your own, for example
   `"name": "my-community-bx"`. This becomes part of your web address. Commit and push.
3. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages →
   Create → Import a repository**, connect GitHub, and pick your fork.
4. Settings:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Variables** (under the build settings, *not* runtime variables): add
     `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the same values as your `.env`.
     They are built into the site, so they must be there **when it builds**. If you add
     them later, deploy again.
5. Press **Deploy**. When it finishes you'll have an address like
   `https://my-community-bx.your-name.workers.dev`.
6. Back in Supabase, **Authentication → URL Configuration**:
   - set **Site URL** to that address
   - add `https://my-community-bx.your-name.workers.dev/**` to **Redirect URLs**
     (keep the localhost one for testing)

From now on, every push to your main branch rebuilds and redeploys the site on its own.

**Your own domain (optional):** in Cloudflare, open the worker → **Settings → Domains &
Routes → Add**. Then add that address to Supabase's Redirect URLs too.

**QR code for events (optional):** put your address in `URL_TO_ENCODE` at the top of
`scripts/make-qr.mjs` and run `node scripts/make-qr.mjs`. It writes `qr-dark.png` and
`qr-light.png` for posters and screens.

---

## Step 7 — Set up the parts catalogue and deck scanning

The catalogue starts with about 190 parts but **no pictures**. Pictures belong to your
Supabase project, not to the code. Open **Parts** (top of the home screen):

1. **Add pictures.** Either open a part and upload its picture, or use the bulk tools on
   the Catalogue tab:
   - **Choose pictures** / **Choose a folder**: pick many image files at once; files
     named after their part are matched for you.
   - **From links**: paste lines like `blade/Dran Sword | https://…/image.png` and the
     app fetches them in your browser.

   Transparent PNGs look best. The app shrinks each picture to 256 px before uploading.
2. **Build the detector's references.** Open **Parts → Detection** and press **Build the
   missing**. Your browser downloads the model once (about 45 MB), then works out a
   "fingerprint" for each blade picture, about 3 seconds a blade. Keep the tab open.
   Rebuild a blade whenever you change its picture.
3. **It learns from your community.** When bladers scan their decks and tick "Send this
   photo", the photos wait in **Approvals → Photos**. Each one you approve becomes an
   extra reference, and real photos of real beys improve accuracy far more than catalogue
   pictures alone.

When a new set releases, add its parts in **Parts → Catalogue**, with pictures, and build
their references. No code change is needed.

---

## Step 8 — Keep the free project awake

Free Supabase projects **pause after a week with no activity**, and a paused project
means a dead app on event day. A free monitor prevents it:

1. Sign up at [UptimeRobot](https://uptimerobot.com) (free).
2. Add an **HTTP(s)** monitor, checking every 5 minutes, for
   `https://xxxxxxxx.supabase.co/rest/v1/?apikey=YOUR-ANON-KEY`. That's your Project URL
   and anon key from Step 2. The anon key is public by design, so this is safe.

(Opening the app regularly does the same job, but the monitor doesn't forget.)

---

## Running an event

- **Before**: create the tournament, add bladers by name or email, add referees, and put
  the QR code on a screen.
- **Bladers** sign up, link to their player (or the host links them), and enter their
  decks, typing or scanning. Decks lock when the first match is scored; the host can
  unlock them in Settings.
- **During**: referees score on their own phones; everyone else watches live.
- **After**: confirm the final ranking, download the CSV, share the ranking image, and
  give out medals.

---

## Updating your copy

When this project gets new features:

1. On your fork's GitHub page, press **Sync fork**. Cloudflare redeploys on its own.
2. If the update added new files to `supabase/`, run them in the SQL Editor. Each says at
   the top what it needs to have run first. They're all safe to run twice.

---

## Troubleshooting

| What you see | Usually means |
|---|---|
| "…not set up yet: run X.sql" | That SQL file hasn't been run. Run it (and anything before it in the table above). |
| The confirmation email opens a broken page | **Site URL / Redirect URLs** in Supabase don't include the address you signed up from. |
| No **New tournament** button | That account isn't approved to host. Approve it in **Approvals → Hosting**, or with `make-admin.sql`. |
| A blank page after deploying | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` were missing when it built. Add them to the build variables and deploy again. |
| "Email rate limit exceeded" | Supabase's built-in sender has hit its hourly limit. Connect your own SMTP (Step 4). |
| The deck scanner says it has nothing to compare against | Build the references in **Parts → Detection** (Step 7). |
| Everything stopped working after a quiet week | The Supabase project paused. Restore it from the dashboard and set up Step 8. |

---

## For developers

```bash
npm run dev      # local development server
npm test         # all the logic tests (brackets, standings, decks, meta, …)
npm run build    # production build into dist/
node scripts/check-sql.mjs supabase/some-file.sql   # parse a SQL file before running it
```

- **Stack**: React 18 + Vite, Supabase (Postgres, Auth, Storage, Realtime, pgvector),
  Cloudflare Workers static assets, transformers.js / ONNX Runtime for the in-browser model.
- **Where things are**: the interface lives in `src/App.jsx`. The logic that tests can
  reach is split out: `src/deck.js` (decks and combos), `src/parts.js` (the built-in
  catalogue), `src/meta.js` (meta table), `src/detect.js` (deck scanning),
  `src/series.js`, `src/rankingImage.js`. All database calls are in `src/lib/db.js`.
- **Security lives in the database.** Every permission is enforced by Postgres row
  policies, column grants and functions, never by hiding a button. The app only avoids
  offering buttons that would be refused. If you change who may do what, change the SQL,
  and add a check to the matching `*-permission-tests.sql`.
- **The deck model** (`public/models/dinov2-small`, 24 MB) ships with the site. The ONNX
  runtime files are copied into `public/ort/` from `node_modules` at build time, so the
  scanner needs nothing from any other site.
- Design notes for larger features are in `docs/`.

---

## Contributing

Issues and pull requests are welcome, from bug reports at your events to new formats and
translations. If you run your own copy for your community, opening an issue to say hello
helps us see where it's being used.
