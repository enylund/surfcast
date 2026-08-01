// One-time seed: import the existing sessions.json into Neon Postgres.
// Run once after the Neon DB exists:
//   DATABASE_URL='postgres://…neon…' node scripts/seed-db.mjs
// Idempotent — safe to re-run (upserts by id).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!DB_URL) {
  console.error("Set DATABASE_URL (the Neon connection string) first.");
  process.exit(1);
}

const sql = neon(DB_URL);
const file = fileURLToPath(new URL("../sessions.json", import.meta.url));

async function main() {
  const sessions = JSON.parse(fs.readFileSync(file, "utf8"));
  await sql`create table if not exists sessions (
    id text primary key, date text not null, start text not null,
    data jsonb not null, updated_at timestamptz default now()
  )`;
  for (const s of sessions) {
    await sql`
      insert into sessions (id, date, start, data)
      values (${s.id}, ${s.date}, ${s.timeRange.start}, ${JSON.stringify(s)}::jsonb)
      on conflict (id) do update set data = excluded.data, date = excluded.date, start = excluded.start, updated_at = now()`;
  }
  const [{ count }] = await sql`select count(*)::int as count from sessions`;
  console.log(`Seeded ${sessions.length} from sessions.json; table now has ${count} row(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
