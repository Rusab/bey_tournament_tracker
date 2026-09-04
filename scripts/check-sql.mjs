/**
 * Parses a migration with Postgres's own parser before anyone runs it.
 *   node scripts/check-sql.mjs supabase/v2-schema.sql
 *
 * Catches shape, not permissions. Worth having because the Supabase SQL
 * editor runs a file as a single transaction: one bad statement rolls the
 * whole thing back, and the error you see may be from a later statement
 * complaining that a table the file was supposed to create does not exist.
 */
import { readFileSync } from "node:fs";
import initPgQuery from "pg-query-emscripten";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-sql.mjs <file.sql>");
  process.exit(2);
}

const sql = readFileSync(file, "utf8");
const pg = await initPgQuery();
const res = pg.parse(sql);

if (res.error) {
  const at = res.error.cursorpos || 0;
  const line = sql.slice(0, at).split("\n").length;
  console.error(`${file}:${line}  ${res.error.message}`);
  console.error("  " + (sql.split("\n")[line - 1] || "").trim());
  process.exit(1);
}

const stmts = res.parse_tree?.stmts || [];
const kinds = {};
for (const s of stmts) {
  const k = Object.keys(s.stmt || {})[0] || "?";
  kinds[k] = (kinds[k] || 0) + 1;
}

console.log(`${file}: parsed cleanly, ${stmts.length} statements`);
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}

// A trigger on auth.users is refused by newer Supabase projects, and because
// the editor runs the file in one transaction it takes the schema down with it.
if (/create\s+trigger[\s\S]{0,200}?on\s+auth\.users/i.test(sql)) {
  console.error("\nWARNING: this file creates a trigger on auth.users.");
  console.error("Supabase owns that schema and will likely refuse it, rolling back the file.");
  process.exit(1);
}
