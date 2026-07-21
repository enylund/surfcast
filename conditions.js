// Objective conditions "fingerprint" for a session window. Environment-agnostic
// ESM (uses fetch + Intl, available in Node 18+ and browsers), so it's shared by
// both scripts/log-session.mjs (chat logging) and logform.js (in-app form).

import { classifyWind, classifySwell, compass, addDays } from "./data.js";

const TZ = "America/New_York";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.reason || json.error.message || "API error");
  return json;
}

export const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const round = (v, p = 0) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** p) / 10 ** p);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function meanDeg(degs) {
  if (!degs.length) return null;
  const r = degs.map((d) => (d * Math.PI) / 180);
  const s = r.reduce((a, x) => a + Math.sin(x), 0);
  const c = r.reduce((a, x) => a + Math.cos(x), 0);
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
}

export function fmtClock(min) {
  let h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
}

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

export async function buildFingerprint(spot, date, startMin, endMin) {
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
    hours: idxs.map((i) => {
      const w = wIdx.get(mh.time[i]);
      const sd = mh.swell_wave_direction[i];
      const wd = w != null ? wj.wind_direction_10m[w] : null;
      const ws = w != null ? round(wj.wind_speed_10m[w]) : null;
      return {
        time: mh.time[i].slice(11, 16),
        swellHt: round(mh.swell_wave_height[i], 1),
        swellPer: round(mh.swell_wave_period[i], 1),
        swellDir: sd == null ? null : Math.round(sd),
        swellClass: sd == null ? null : classifySwell(sd, spot),
        windSpd: ws,
        windDir: wd == null ? null : Math.round(wd),
        windClass: wd == null || ws == null ? null : classifyWind(wd, spot.facing, ws),
      };
    }),
  };
}

// Assemble a full session record from form/CLI input + the fetched fingerprint.
export async function buildRecord(input, SPOTS) {
  const spot = SPOTS.find((s) => s.id === input.spotId);
  if (!spot) throw new Error(`Unknown spotId: ${input.spotId}`);
  const startMin = toMin(input.start), endMin = toMin(input.end);
  const fp = await buildFingerprint(spot, input.date, startMin, endMin);
  return {
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
}
