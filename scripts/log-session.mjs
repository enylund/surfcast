// Logs a surf session with an objective conditions "fingerprint" (chat path).
// The in-app form (logform.js) shares the same fingerprint logic via
// ../fingerprint.js. Run when Eric describes a session in chat:
//   node scripts/log-session.mjs '{"date":"2026-07-19","spotId":"rockaway","start":"07:00","end":"09:00", ...}'
//
// Expected input JSON:
//   date        "YYYY-MM-DD"
//   spotId      one of config.js SPOTS ids (rockaway | lido | ditch)
//   start,end   "HH:MM" 24h local (e.g. "07:00","09:00")
//   label       optional display label (e.g. "7–9am")
//   ratings     { swellSize, swellDirection, wind, crowd, overall }  each 0–5
//                 (crowd: 5 = empty/great; wind: 5 = ideal wind for surfing)
//   gear        { board, wetsuit, gloves, booties, hood }
//                 board:   longboard | midlength | fish | short
//                 wetsuit: none | top | 2mm spring | 2/2 full | 3/2 full |
//                          4/3 full | 5/4 full | 6/5 full
//   comfort     { tooCold, tooWarm }   booleans
//   comments    free text (repo is public — keep it non-sensitive)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SPOTS } from "../config.js";
import { buildRecord } from "../fingerprint.js";

const SESSIONS_FILE = fileURLToPath(new URL("../sessions.json", import.meta.url));

async function main() {
  const input = JSON.parse(process.argv[2] || "null");
  if (!input) throw new Error("Pass the session as a JSON string argument");

  const record = await buildRecord(input, SPOTS);

  let all = [];
  try { all = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { /* first session */ }
  all = all.filter((s) => s.id !== record.id); // overwrite same-slot re-log
  all.push(record);
  all.sort((a, b) => (b.date + b.timeRange.start).localeCompare(a.date + a.timeRange.start)); // newest first
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2) + "\n");

  console.log(JSON.stringify(record.fingerprint, null, 2));
  console.log(`\nLogged ${record.id} — ${all.length} session(s) total`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
