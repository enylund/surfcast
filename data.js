// Data layer: fetch Open-Meteo (swell, wind) + NOAA CO-OPS (tides), normalize
// timestamps, join everything onto one hourly timeline, cache the merged model.

import { TZ, FORECAST_DAYS, CACHE_TTL_MS, LIGHT_WIND_MPH, WIND_BANDS } from "./config.js";

// ---------------------------------------------------------------------------
// Time helpers. All API data is requested in America/New_York local time and
// aligned by *string* keys ("YYYY-MM-DDTHH:mm") — never via Date parsing,
// which would re-introduce timezone ambiguity.
// ---------------------------------------------------------------------------

export function nyToday() {
  // en-CA locale formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

export function nyNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    min: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function addDays(dateStr, n) {
  const d = new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

const compact = (dateStr) => dateStr.replaceAll("-", "");

// "2026-07-19T05:38" or "05:38" -> minutes since midnight
function toMinutes(t) {
  const hm = t.includes("T") ? t.slice(11, 16) : t.slice(0, 5);
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

// ---------------------------------------------------------------------------
// Wind classification & compass labels
// ---------------------------------------------------------------------------

const COMPASS16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

export function compass(deg) {
  return COMPASS16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// windFrom: direction the wind is coming from (degrees true, Open-Meteo convention).
// facing: azimuth from the sand out to sea. Perfect offshore comes from (facing+180).
export function classifyWind(windFrom, facing, mph) {
  if (mph < LIGHT_WIND_MPH) return "light";
  const offshoreFrom = (facing + 180) % 360;
  let delta = Math.abs(((windFrom % 360) + 360) % 360 - offshoreFrom);
  if (delta > 180) delta = 360 - delta;
  return WIND_BANDS.find((b) => delta <= b.max).cls;
}

// Rate a swell's "coming from" direction against the spot's known-good windows.
// Returns "optimal" | "fair" | "poor".
export function classifySwell(deg, spot) {
  if (!spot.swell || deg == null) return "fair";
  const d = ((deg % 360) + 360) % 360;
  const inArc = ([a, b]) => d >= a && d <= b;
  if (inArc(spot.swell.optimal)) return "optimal";
  if (inArc(spot.swell.fair)) return "fair";
  return "poor";
}

export function selfTest() {
  // Rockaway faces 170 -> offshore wind comes from 350.
  const cases = [
    [0, "offshore"], [180, "onshore"], [270, "cross"], [225, "cross-on"], [315, "cross-off"],
  ];
  for (const [from, expect] of cases) {
    const got = classifyWind(from, 170, 10);
    console.assert(got === expect, `classifyWind(${from}, 170): expected ${expect}, got ${got}`);
  }
  console.assert(classifyWind(0, 170, 3) === "light", "wind < 5 mph should be light");
  console.assert(compass(190) === "S", `compass(190): expected S, got ${compass(190)}`);
  console.assert(compass(200) === "SSW", `compass(200): expected SSW, got ${compass(200)}`);
  const rock = { swell: { optimal: [95, 170], fair: [80, 205] } };
  console.assert(classifySwell(135, rock) === "optimal", "SE at Rockaway should be optimal");
  console.assert(classifySwell(190, rock) === "fair", "S at Rockaway should be fair");
  console.assert(classifySwell(250, rock) === "poor", "WSW at Rockaway should be poor");
  console.log("selfTest done (failures would appear above as assertion errors)");
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

// URL builders are exported for reuse by scripts/generate-reports.mjs (Node).
export function marineUrl(spot) {
  const p = new URLSearchParams({
    latitude: spot.lat, longitude: spot.lon,
    hourly: "swell_wave_height,swell_wave_period,swell_wave_direction,wind_wave_height,wave_height,wave_period,wave_direction,sea_surface_temperature",
    length_unit: "imperial", temperature_unit: "fahrenheit", timezone: TZ, forecast_days: FORECAST_DAYS,
  });
  return `https://marine-api.open-meteo.com/v1/marine?${p}`;
}

export function windUrl(spot) {
  const p = new URLSearchParams({
    latitude: spot.lat, longitude: spot.lon,
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    daily: "sunrise,sunset",
    wind_speed_unit: "mph", timezone: TZ, forecast_days: FORECAST_DAYS,
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

export function tideUrl(spot, interval, begin, end) {
  const p = new URLSearchParams({
    station: spot.tideStation, product: "predictions", datum: "MLLW",
    time_zone: "lst_ldt", units: "english", format: "json",
    begin_date: compact(begin), end_date: compact(end),
    interval, application: "surfcast-personal",
  });
  return `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${p}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "API error");
  return json;
}

// ---------------------------------------------------------------------------
// Model building
// ---------------------------------------------------------------------------

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function buildModel(spot, marine, wind, tideHilo, tideCurve, errors) {
  // Master timeline: marine hourly time array (already NY-local "YYYY-MM-DDTHH:mm").
  // Fall back to the wind timeline if marine failed.
  const timeline = marine?.hourly?.time || wind?.hourly?.time;
  if (!timeline) throw new Error("No forecast data available");

  const windIdx = new Map((wind?.hourly?.time || []).map((t, i) => [t, i]));
  const sun = new Map();
  if (wind?.daily?.time) {
    wind.daily.time.forEach((date, i) => {
      sun.set(date, {
        sunrise: toMinutes(wind.daily.sunrise[i]),
        sunset: toMinutes(wind.daily.sunset[i]),
      });
    });
  }

  const days = [];
  const dayIndexByDate = new Map();
  const mh = marine?.hourly;

  timeline.forEach((t, i) => {
    const date = t.slice(0, 10);
    if (!dayIndexByDate.has(date)) {
      dayIndexByDate.set(date, days.length);
      days.push({ date, sunrise: sun.get(date)?.sunrise ?? null, sunset: sun.get(date)?.sunset ?? null, hours: [] });
    }
    const wi = windIdx.get(t);
    const windSpd = wi != null ? round1(wind.hourly.wind_speed_10m[wi]) : null;
    const windDir = wi != null ? wind.hourly.wind_direction_10m[wi] : null;
    days[dayIndexByDate.get(date)].hours.push({
      t,
      min: toMinutes(t),
      swellHt: round1(mh?.swell_wave_height?.[i]),
      swellPer: round1(mh?.swell_wave_period?.[i]),
      swellDir: mh?.swell_wave_direction?.[i] ?? null,
      swellClass: mh?.swell_wave_direction?.[i] != null ? classifySwell(mh.swell_wave_direction[i], spot) : null,
      waveHt: round1(mh?.wave_height?.[i]),
      windWaveHt: round1(mh?.wind_wave_height?.[i]),
      waterTemp: mh?.sea_surface_temperature?.[i] != null ? Math.round(mh.sea_surface_temperature[i]) : null,
      windSpd,
      windGust: wi != null ? round1(wind.hourly.wind_gusts_10m[wi]) : null,
      windDir,
      windClass: windSpd != null && windDir != null ? classifyWind(windDir, spot.facing, windSpd) : null,
    });
  });

  const parseTide = (json, withType) =>
    (json?.predictions || [])
      .map((p) => {
        const key = p.t.replace(" ", "T"); // NOAA lst_ldt: "YYYY-MM-DD HH:mm"
        const dayIndex = dayIndexByDate.get(key.slice(0, 10));
        if (dayIndex == null) return null;
        const entry = { t: key, dayIndex, min: toMinutes(key), ft: round1(Number(p.v)) };
        if (withType) entry.type = p.type; // "H" | "L"
        return entry;
      })
      .filter(Boolean);

  return {
    spotId: spot.id,
    fetchedAt: Date.now(),
    days,
    tide: { curve: parseTide(tideCurve, false), hilo: parseTide(tideHilo, true) },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Cache (memory + localStorage). Models with per-source errors are NOT cached,
// so a retry actually retries.
// ---------------------------------------------------------------------------

// Subordinate NOAA stations (e.g. Jones Inlet for Lido) only publish high/low
// predictions — no hourly curve. Synthesize one with cosine interpolation
// between consecutive H/L events (the standard tide-clock approximation).
// Works on the raw datagetter JSON and returns the same shape.
function synthesizeCurve(hiloJson) {
  const evs = (hiloJson?.predictions || []).map((p) => ({
    abs: Date.parse(p.t.replace(" ", "T") + ":00Z") / 60000, // minutes; uniform fake-UTC, only differences matter
    ft: Number(p.v),
  }));
  if (evs.length < 2) return null;

  const out = [];
  const fmt = (absMin) => {
    const d = new Date(absMin * 60000).toISOString();
    return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
  };
  for (let i = 0; i < evs.length - 1; i++) {
    const a = evs[i], b = evs[i + 1];
    for (let t = a.abs; t < b.abs; t += 30) {
      const frac = (t - a.abs) / (b.abs - a.abs);
      const ft = a.ft + (b.ft - a.ft) * (1 - Math.cos(Math.PI * frac)) / 2;
      out.push({ t: fmt(t), v: String(ft) });
    }
  }
  out.push({ t: fmt(evs.at(-1).abs), v: String(evs.at(-1).ft) });
  return { predictions: out };
}

const memCache = new Map();
// bump the version when the model shape changes so stale cached models are ignored
const lsKey = (spotId) => `surfcast:v4:${spotId}`;

function isFresh(model) {
  return (
    model &&
    Date.now() - model.fetchedAt < CACHE_TTL_MS &&
    model.days?.[0]?.date === nyToday() // guard against overnight staleness
  );
}

function readCache(spotId) {
  const mem = memCache.get(spotId);
  if (isFresh(mem)) return mem;
  try {
    const stored = JSON.parse(localStorage.getItem(lsKey(spotId)));
    if (isFresh(stored)) {
      memCache.set(spotId, stored);
      return stored;
    }
  } catch { /* corrupt or missing — ignore */ }
  return null;
}

function writeCache(model) {
  memCache.set(model.spotId, model);
  try {
    localStorage.setItem(lsKey(model.spotId), JSON.stringify(model));
  } catch { /* quota — persistence is optional */ }
}

export async function getSpotData(spot, { force = false } = {}) {
  if (!force) {
    const cached = readCache(spot.id);
    if (cached) return cached;
  }

  const today = nyToday();
  const end = addDays(today, FORECAST_DAYS - 1);

  // hilo is fetched with a day of padding on each side so a synthesized curve
  // has boundary events to interpolate from; out-of-window days are dropped
  // during model building anyway.
  const [marine, wind, hilo, curve] = await Promise.allSettled([
    fetchJson(marineUrl(spot)),
    fetchJson(windUrl(spot)),
    fetchJson(tideUrl(spot, "hilo", addDays(today, -1), addDays(end, 1))),
    fetchJson(tideUrl(spot, "h", today, end)),
  ]);

  const errors = {};
  if (marine.status === "rejected") errors.swell = String(marine.reason.message || marine.reason);
  if (wind.status === "rejected") errors.wind = String(wind.reason.message || wind.reason);

  const hiloJson = hilo.status === "fulfilled" ? hilo.value : null;
  let curveJson = curve.status === "fulfilled" ? curve.value : null;
  if (!curveJson && hiloJson) curveJson = synthesizeCurve(hiloJson); // subordinate station fallback
  if (!hiloJson) errors.tide = String(hilo.reason?.message || hilo.reason);

  const model = buildModel(spot,
    marine.status === "fulfilled" ? marine.value : null,
    wind.status === "fulfilled" ? wind.value : null,
    hiloJson, curveJson, errors,
  );

  if (Object.keys(errors).length === 0) writeCache(model);
  return model;
}
