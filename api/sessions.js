// Vercel serverless function: session storage backed by Neon Postgres.
//   GET    /api/sessions        → list all sessions (public; data is public anyway)
//   POST   /api/sessions        → upsert a session record (password-gated)
//                                  body: { record, removeId? }  (removeId drops an
//                                  old row when an edit changed the id)
//   DELETE /api/sessions?id=...  → delete a session (password-gated)
//
// Env vars (set in Vercel): DATABASE_URL (Neon, auto-added by the integration),
// LOG_PASSWORD (your write password). Reads need no password.

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

async function ensureTable() {
  await sql`create table if not exists sessions (
    id text primary key,
    date text not null,
    start text not null,
    data jsonb not null,
    updated_at timestamptz default now()
  )`;
}

function authed(req) {
  const pw = req.headers["x-log-password"];
  return !!process.env.LOG_PASSWORD && pw === process.env.LOG_PASSWORD;
}

export default async function handler(req, res) {
  try {
    await ensureTable();

    if (req.method === "GET") {
      const rows = await sql`select data from sessions order by date desc, start desc`;
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(rows.map((r) => r.data));
    }

    if (!authed(req)) return res.status(401).json({ error: "Wrong or missing password." });

    if (req.method === "POST") {
      const { record, removeId } = req.body || {};
      if (!record || !record.id || !record.timeRange) return res.status(400).json({ error: "Missing session record." });
      if (removeId && removeId !== record.id) await sql`delete from sessions where id = ${removeId}`;
      await sql`
        insert into sessions (id, date, start, data)
        values (${record.id}, ${record.date}, ${record.timeRange.start}, ${JSON.stringify(record)}::jsonb)
        on conflict (id) do update set data = excluded.data, date = excluded.date, start = excluded.start, updated_at = now()`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) return res.status(400).json({ error: "Missing id." });
      await sql`delete from sessions where id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
