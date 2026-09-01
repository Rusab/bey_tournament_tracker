# Going live — your remaining steps

The code side is done: `src/App.jsx` now reads/writes Supabase instead of
`window.storage`, admin access is a real sign-in (`supabase.auth.signInWithPassword`),
and spectators get pushed live updates via Realtime. What's left only you can do,
since it all happens inside your logged-in Supabase/Cloudflare accounts.

## 1. Database — Supabase SQL editor

In your `bey_tournament_track` project → **SQL Editor**, run:

```sql
create table tournaments (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table tournaments enable row level security;

create policy "public read"
  on tournaments for select
  using (true);

create policy "admin write"
  on tournaments for insert
  to authenticated with check (true);

create policy "admin update"
  on tournaments for update
  to authenticated using (true) with check (true);

create policy "admin delete"
  on tournaments for delete
  to authenticated using (true);
```

Then, so spectators' phones update live without refreshing:

```sql
alter publication supabase_realtime add table tournaments;
```

## 2. Admin account

**Authentication → Users → Add user.** Give it an email and password —
this is what you'll type into the app's "Admin sign-in" screen at events, so
pick a password you're fine typing on a phone. (Don't reuse your Supabase
account password for this — make it a separate credential.)

Then **Authentication → Providers → Email → turn off "Enable sign ups."**
Without this, anyone could self-register an account and get write access.

## 3. Get your API keys

**Project Settings → API.** You need two values:
- **Project URL**
- **anon / public key** (not the `service_role` key — never put that one in frontend code)

## 4. Wire up the app locally

In this folder, copy `.env.example` to `.env` and fill in the two values from step 3:

```bash
cp .env.example .env
```

```
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Then run it locally to confirm it talks to Supabase:

```bash
npm run dev
```

Open the URL it prints, tap "I'm the organiser," and sign in with the admin
account from step 2. Create a test tournament and confirm it appears in the
Supabase **Table Editor** under `tournaments`.

## 4b. Storage bucket for images

Needed only for the optional tournament background image. In the SQL editor:

```sql
insert into storage.buckets (id, name, public)
values ('tournament-bg', 'tournament-bg', true)
on conflict (id) do nothing;

-- Public bucket, so reads work without a policy. Writes stay admin-only.
create policy "bg admin insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'tournament-bg');

create policy "bg admin update" on storage.objects
  for update to authenticated using (bucket_id = 'tournament-bg');

create policy "bg admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'tournament-bg');
```

This one bucket holds both the background image and the organiser logo — no
extra setup for the logo.

The app shrinks pictures in your browser before uploading. Backgrounds go to
max 1400px on the long edge (WebP, or JPEG on Safari before 16.4), so a 10MB
phone photo lands around 55–150KB. Logos go to max 320px and keep their
transparency — WebP, falling back to PNG rather than JPEG, which would fill a
transparent cut-out with black. A typical logo ends up around 5KB.

Only the resulting URLs are stored on the tournament; image bytes never enter
the record that gets pushed to spectators on every score.

## 5. Keep the free Supabase project awake

Free projects pause after 7 days of no requests. Point a free
[UptimeRobot](https://uptimerobot.com) monitor at your Supabase project URL,
pinging every 5 minutes — 5 minutes to set up, no code.

## 6. Deploy — Cloudflare Pages

```bash
git init
git add -A
git commit -m "Beyblade X tournament tracker"
```

Push to a GitHub repo, then in the Cloudflare dashboard:
**Workers & Pages → Create → Pages → Connect to Git.**
- Build command: `npm run build`
- Output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as your `.env`)

You'll get a `*.pages.dev` HTTPS URL. That's what goes on the QR code.

---

### Why I couldn't do steps 1–3 for you

Logging into your Supabase account and typing your password is something I'm
not able to do on your behalf, even with the password given directly — it's a
hard rule I follow for account credentials. Everything downstream of that
(the code, the SQL, the file wiring) I've already done.
