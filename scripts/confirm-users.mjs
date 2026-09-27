/*
 * Confirm every account that predates working confirmation emails.
 *
 * Sign-ups happened while "Confirm email" was off, so nobody ever had an
 * address to verify. Turning it on strands all of them: unconfirmed, unable
 * to sign in, and with no email they could ever have acted on.
 *
 * The SQL editor cannot do this - Supabase does not grant it the auth schema -
 * so this goes through the admin API instead. No email is sent.
 *
 * The service role key bypasses every row policy you have, so it lives in your
 * environment and nowhere else: not in this file, not in the repo, not in your
 * shell history. Run it like this, from the project root:
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/confirm-users.mjs --dry-run
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/confirm-users.mjs
 *
 * It reads the project URL from .env. Start with --dry-run: it prints the
 * accounts it would confirm and changes nothing. Read that list before
 * running it for real, because confirming an address asserts on someone's
 * behalf the very thing the email would have proved.
 */
import { readFileSync } from "node:fs";

const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set. See the comment at the top of this file.");
  process.exit(1);
}

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const url = (env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/) || [])[1];
if (!url) { console.error("No VITE_SUPABASE_URL in .env"); process.exit(1); }

const dry = process.argv.includes("--dry-run");
const head = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

/* The admin list is paged, and silently stops at one page if you let it. */
const users = [];
for (let page = 1; ; page++) {
  const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: head });
  if (!res.ok) {
    console.error(`Listing users failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  const batch = body.users || [];
  users.push(...batch);
  if (batch.length < 200) break;
}

const pending = users.filter((u) => !u.email_confirmed_at);
console.log(`${users.length} account${users.length === 1 ? "" : "s"}, ${pending.length} unconfirmed.`);
if (!pending.length) process.exit(0);

for (const u of pending) {
  console.log(`  ${u.email}   signed up ${new Date(u.created_at).toLocaleString()}`);
}

if (dry) {
  console.log("\n--dry-run: nothing was changed. Drop the flag to confirm these.");
  process.exit(0);
}

let ok = 0;
for (const u of pending) {
  const res = await fetch(`${url}/auth/v1/admin/users/${u.id}`, {
    method: "PUT", headers: head, body: JSON.stringify({ email_confirm: true }),
  });
  if (res.ok) { ok++; console.log(`confirmed  ${u.email}`); }
  else console.error(`FAILED     ${u.email}: ${res.status} ${await res.text()}`);
}
console.log(`\n${ok} of ${pending.length} confirmed. No email was sent.`);
