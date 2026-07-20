// Logs a surf session with an objective conditions "fingerprint".
// Run when Eric describes a session in chat:
//   node scripts/log-session.mjs '{"date":"2026-07-19","spotId":"rockaway","start":"07:00","end":"09:00", ...}'
//
// It fetches the actual conditions for that spot/date/time window (Open-Meteo
// marine + forecast for recent-past dates, NOAA tide predictions), averages
// them over the session, classifies wind + swell per spot, and appends the
// full record to sessions.json (which the app reads for the Session log view).
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
//                 gloves/booties/hood: booleans
//   comfort     { tooCold, tooWarm }   booleans
//   comments    free text (repo is public — keep it non-sensitive)

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SPOTS } from "../config.js";
import { classifyWind, classifySwell, compass } from "../data.js";

const TZ = "America/New_York";
const SESSIONS_FILE = fileURLToPath(new URL("../sessions.json", import.meta.url));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.reason || json.error.message || "API error");
  return json;
}

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const round = (v, p = 0) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function meanDeg(degs) {
  if (!degs.length) return null;
  const r = degs.map((d) => (d * Math.PI) / 180);
  const s = r.reduce((a, x) => a + Math.sin(x), 0);
  const c = r.reduce((a, x) => a + Math.cos(x), 0);
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
}

const fmtClock = (min) => {
  let h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
};

// Cosine-interpolate tide height (ft) at an absolute-minute target between H/L
// events. Works for subordinate stations (Lido) that only publish hi/lo.
function tideAt(events, absMin) {
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i], b = events[i + 1];
    if (absMin >= a.abs && absMin <= b.abs) {
      const frac = (absMin - a.abs) / (b.abs - a.abs);
      return a.ft + (b.ft - a.ft) * (1 - Math.cos(Math.PI * frac)) / 2;
    }
  }
  return null;
}

async function fingerprint(spot, date, startMin, endMin) {
  const q = (base, hourly, extra) =>
    `${base}?latitude=${spot.lat}&longitude=${spot.lon}&hourly=${hourly}` +
    `&timezone=${encodeURIComponent(TZ)}&start_date=${date}&end_date=${date}${extra}`;
  const marineUrl = q(
    "https://marine-api.open-meteo.com/v1/marine",
    "swell_wave_height,swell_wave_period,swell_wave_direction,wind_wave_height,wave_height,sea_surface_temperature",
    "&length_unit=imperial&temperature_unit=fahrenheit",
  );
  const windUrl = q(
    "https://api.open-meteo.com/v1/forecast",
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,weather_code",
    "&wind_speed_unit=mph&temperature_unit=fahrenheit",
  );
  const tideUrl =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${spot.tideStation}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&interval=hilo&format=json` +
    `&begin_date=${addDays(date, -1).replaceAll("-", "")}&end_date=${addDays(date, 1).replaceAll("-", "")}` +
    `&application=surfcast-personal`;

  const [marine, wind, tide] = await Promise.all([fetchJson(marineUrl), fetchJson(windUrl), fetchJson(tideUrl)]);
  const mh = marine.hourly, wj = wind.hourly;

  const idxs = mh.time.map((t, i) => [t, i]).filter(([t]) => {
    const m = toMin(t.slice(11, 16));
    return m >= startMin && m <= endMin;
  }).map(([, i]) => i);
  if (!idxs.length) throw new Error("No hourly samples fell in that time window");

  const wIdx = new Map(wj.time.map((t, i) => [t, i]));
  const wi = idxs.map((i) => wIdx.get(mh.time[i])).filter((x) => x != null);

  const swellDir = round(meanDeg(idxs.map((i) => mh.swell_wave_direction[i]).filter((v) => v != null)));
  const windDir = round(meanDeg(wi.map((i) => wj.wind_direction_10m[i]).filter((v) => v != null)));
  const windSpd = round(avg(wi.map((i) => wj.wind_speed_10m[i])));

  // tide: shared fake-UTC epoch so event and session times share a timeline (only differences used)
  const epoch = Date.parse(`${addDays(date, -1)}T00:00:00Z`);
  const events = (tide.predictions || []).map((p) => ({
    abs: (Date.parse(p.t.replace(" ", "T") + ":00Z") - epoch) / 60000,
    ft: Number(p.v), type: p.type, t: p.t,
  })).sort((a, b) => a.abs - b.abs);
  const dayAbs = (Date.parse(`${date}T00:00:00Z`) - epoch) / 60000;
  const startAbs = dayAbs + startMin, endAbs = dayAbs + endMin, midAbs = (startAbs + endAbs) / 2;
  const tideStart = round(tideAt(events, startAbs), 1);
  const tideEnd = round(tideAt(events, endAbs), 1);
  const prev = [...events].reverse().find((e) => e.abs <= midAbs);
  const next = events.find((e) => e.abs > midAbs);
  const ev = (e) => (e ? { type: e.type === "H" ? "high" : "low", time: fmtClock(toMin(e.t.slice(11, 16))), ft: round(e.ft, 1) } : null);

  const midWi = wIdx.get(mh.time[idxs[Math.floor(idxs.length / 2)]]);

  return {
    capturedAt: new Date().toISOString(),
    source: "open-meteo forecast+marine, noaa tide predictions",
    swellHt_ft: round(avg(idxs.map((i) => mh.swell_wave_height[i])), 1),
    swellPer_s: round(avg(idxs.map((i) => mh.swell_wave_period[i])), 1),
    swellDir_deg: swellDir,
    swellDir_compass: swellDir == null ? null : compass(swellDir),
    swellClass: swellDir == null ? null : classifySwell(swellDir, spot),
    waveHt_ft: round(avg(idxs.map((i) => mh.wave_height[i])), 1),
    windWaveHt_ft: round(avg(idxs.map((i) => mh.wind_wave_height[i])), 1),
    windSpd_mph: windSpd,
    windGust_mph: round(avg(wi.map((i) => wj.wind_gusts_10m[i]))),
    windDir_deg: windDir,
    windDir_compass: windDir == null ? null : compass(windDir),
    windClass: windDir == null || windSpd == null ? null : classifyWind(windDir, spot.facing, windSpd),
    airTemp_f: round(avg(wi.map((i) => wj.temperature_2m[i]))),
    waterTemp_f: round(avg(idxs.map((i) => mh.sea_surface_temperature[i]))),
    weatherCode: midWi != null ? wj.weather_code[midWi] : null,
    tide_ft_start: tideStart,
    tide_ft_end: tideEnd,
    tide_state: tideStart == null || tideEnd == null ? null : tideEnd > tideStart ? "rising" : tideEnd < tideStart ? "falling" : "slack",
    tide_prev: ev(prev),
    tide_next: ev(next),
    spotFacing_deg: spot.facing,
    sampleHours: idxs.map((i) => mh.time[i].slice(11, 16)),
  };
}

async function main() {
  const input = JSON.parse(process.argv[2] || "null");
  if (!input) throw new Error("Pass the session as a JSON string argument");
  const spot = SPOTS.find((s) => s.id === input.spotId);
  if (!spot) throw new Error(`Unknown spotId: ${input.spotId} (expected one of ${SPOTS.map((s) => s.id).join(", ")})`);

  const startMin = toMin(input.start), endMin = toMin(input.end);
  const fp = await fingerprint(spot, input.date, startMin, endMin);

  const record = {
    id: `${input.date}T${input.start.replace(":", "")}-${spot.id}`,
    date: input.date,
    spotId: spot.id,
    spotName: spot.name,
    timeRange: { start: input.start, end: input.end, label: input.label || `${fmtClock(startMin)}–${fmtClock(endMin)}` },
    loggedAt: new Date().toISOString(),
    fingerprint: fp,
    ratings: input.ratings || {},
    gear: input.gear || {},
    comfort: input.comfort || {},
    comments: input.comments || "",
  };

  let all = [];
  try { all = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { /* first session */ }
  all = all.filter((s) => s.id !== record.id); // overwrite same-slot re-log
  all.push(record);
  all.sort((a, b) => (b.date + b.timeRange.start).localeCompare(a.date + a.timeRange.start)); // newest first
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2) + "\n");

  console.log(JSON.stringify(fp, null, 2));
  console.log(`\nLogged ${record.id} — ${all.length} session(s) total`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
