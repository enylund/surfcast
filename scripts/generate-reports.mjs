// Generates AI surf reports for each spot and writes them to reports/{id}.json.
// Runs in GitHub Actions on a schedule (see .github/workflows/reports.yml).
// Requires ANTHROPIC_API_KEY (or another credential the SDK resolves).

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { SPOTS } from "../config.js";
import { classifyWind, classifySwell, compass, nyToday, addDays, marineUrl, windUrl, tideUrl } from "../data.js";

const OUT_DIR = fileURLToPath(new URL("../reports/", import.meta.url));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "API error");
  return json;
}

const fmtClock = (t) => {
  let h = Number(t.slice(11, 13));
  const m = t.slice(14, 16);
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
};

// Circular mean of compass directions, weighted equally.
function meanDir(degs) {
  const rad = degs.map((d) => (d * Math.PI) / 180);
  const s = rad.reduce((a, r) => a + Math.sin(r), 0);
  const c = rad.reduce((a, r) => a + Math.cos(r), 0);
  return ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
}

const round1 = (v) => Math.round(v * 10) / 10;

// Condense the raw hourly forecast into a short per-day text digest that the
// model reasons over. Keeping it compact keeps token usage (and cost) low.
function buildDigest(spot, marine, wind, hilo) {
  const mh = marine.hourly;
  const windIdx = new Map(wind.hourly.time.map((t, i) => [t, i]));

  const dayIdxs = new Map();
  mh.time.forEach((t, i) => {
    const d = t.slice(0, 10);
    if (!dayIdxs.has(d)) dayIdxs.set(d, []);
    dayIdxs.get(d).push(i);
  });

  const tidesByDate = new Map();
  for (const p of hilo.predictions || []) {
    const d = p.t.slice(0, 10);
    if (!tidesByDate.has(d)) tidesByDate.set(d, []);
    tidesByDate.get(d).push(`${p.type} ${fmtClock(p.t.replace(" ", "T"))} ${round1(Number(p.v))}ft`);
  }

  // Time-of-day blocks (hours, 24h local)
  const BLOCKS = [["dawn", 5, 9], ["morning", 9, 13], ["afternoon", 13, 17], ["evening", 17, 20]];

  const lines = [];
  for (const [date, idxs] of dayIdxs) {
    const daylight = idxs.filter((i) => {
      const h = Number(mh.time[i].slice(11, 13));
      return h >= 5 && h <= 20;
    });
    if (!daylight.length) continue;

    const hts = daylight.map((i) => mh.swell_wave_height[i]).filter((v) => v != null);
    const pers = daylight.map((i) => mh.swell_wave_period[i]).filter((v) => v != null);
    const dirs = daylight.map((i) => mh.swell_wave_direction[i]).filter((v) => v != null);
    const totals = daylight.map((i) => mh.wave_height[i]).filter((v) => v != null);
    if (!hts.length) continue;

    const dir = meanDir(dirs);
    const label = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
      .format(new Date(`${date}T12:00:00Z`));

    const windParts = [];
    for (const [name, from, to] of BLOCKS) {
      const block = daylight.filter((i) => {
        const h = Number(mh.time[i].slice(11, 13));
        return h >= from && h < to;
      });
      const speeds = [], wdirs = [];
      for (const i of block) {
        const wi = windIdx.get(mh.time[i]);
        if (wi == null) continue;
        speeds.push(wind.hourly.wind_speed_10m[wi]);
        wdirs.push(wind.hourly.wind_direction_10m[wi]);
      }
      if (!speeds.length) continue;
      const spd = Math.round(speeds.reduce((a, b) => a + b) / speeds.length);
      const wd = meanDir(wdirs);
      windParts.push(`${name} ${spd}mph ${compass(wd)} (${classifyWind(wd, spot.facing, spd)})`);
    }

    const noonIdx = idxs.find((i) => mh.time[i].slice(11, 13) === "12");
    const water = noonIdx != null && mh.sea_surface_temperature?.[noonIdx] != null
      ? ` water ${Math.round(mh.sea_surface_temperature[noonIdx])}F.`
      : "";

    lines.push(
      `${label}: swell ${round1(Math.min(...hts))}-${round1(Math.max(...hts))}ft @ ` +
      `${round1(Math.min(...pers))}-${round1(Math.max(...pers))}s from ${compass(dir)} (${Math.round(dir)}deg, ` +
      `${classifySwell(dir, spot)} angle for this spot), ` +
      `total wave to ${round1(Math.max(...totals))}ft. Wind: ${windParts.join("; ")}. ` +
      `Tides: ${(tidesByDate.get(date) || []).join(", ")}.${water}`,
    );
  }

  return `## ${spot.name} (id: ${spot.id}; beach faces ${spot.facing}deg true)\n${lines.join("\n")}`;
}

const SYSTEM_PROMPT = `You are the forecaster for a personal surf app covering three NYC-area beach breaks: Rockaway 67th St, Lido Beach, and Ditch Plains (Montauk). You write short daily reports from an hourly forecast digest.

Voice: a local forecaster talking to fellow surfers. Casual, direct, practical, a little dry. Reference board choice (log, groveler, fish, shortboard), tide windows, and wind timing. Recommend the best window of the day when there is one. Be honest when it's flat, junky, or blown out — never oversell. No emoji, no exclamation marks.

Calibration for these spots (model swell heights, ft): under ~1.5ft at short period (<6s) is flat to barely surfable; ~2ft at 6-8s is loggable; 2-3ft at 8s+ is fun for most boards; 3ft+ at 9s+ is a solid day worth rearranging plans for. Short-period S windswell is typical summer junk; SE/ESE swells at longer periods are the good ones. Wind classes in the digest (offshore/cross-off/cross/cross-on/onshore/light) are computed per beach orientation — trust them. Light wind = glassy. Each swell line also carries a direction-quality tag (prime/good/fair/marginal/poor angle) computed from that spot's swell windows, deliberately stringent: "prime" is the narrow peeling window (e.g. ESE at Rockaway) and is rare — a prime angle at decent period and size is THE day to flag; "marginal" and "poor" angles mean junk regardless of size.

For each spot produce:
- headline: one punchy sentence summarizing today (e.g. "Knee-high windswell leftovers — log it or skip it.").
- today: 2-4 sentences on how today plays out, morning vs afternoon, best window, board call.
- daysToWatch: only upcoming days (not today) genuinely worth flagging — good days to target AND clear warnings (e.g. blown out, flat spell). 0-4 entries per spot; skip unremarkable days. day is the short weekday label from the digest (e.g. "Wed").

Base everything strictly on the digest. Do not invent swells, storms, or buoy readings not present in the data.`;

const SCHEMA = {
  type: "object",
  properties: {
    reports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          spotId: { type: "string", enum: SPOTS.map((s) => s.id) },
          headline: { type: "string" },
          today: { type: "string" },
          daysToWatch: {
            type: "array",
            items: {
              type: "object",
              properties: { day: { type: "string" }, note: { type: "string" } },
              required: ["day", "note"],
              additionalProperties: false,
            },
          },
        },
        required: ["spotId", "headline", "today", "daysToWatch"],
        additionalProperties: false,
      },
    },
  },
  required: ["reports"],
  additionalProperties: false,
};

async function main() {
  const today = nyToday();
  const end = addDays(today, 6);

  const digests = await Promise.all(
    SPOTS.map(async (spot) => {
      const [marine, wind, hilo] = await Promise.all([
        fetchJson(marineUrl(spot)),
        fetchJson(windUrl(spot)),
        fetchJson(tideUrl(spot, "hilo", today, end)),
      ]);
      return buildDigest(spot, marine, wind, hilo);
    }),
  );

  // DIGEST_ONLY=1 prints the model input and exits — for debugging without an API key.
  if (process.env.DIGEST_ONLY) {
    console.log(digests.join("\n\n"));
    return;
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Today is ${today}. Write the report for each spot.\n\n${digests.join("\n\n")}`,
    }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });

  if (response.stop_reason === "refusal") throw new Error("Model refused the request");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
  const { reports } = JSON.parse(text);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  for (const spot of SPOTS) {
    const report = reports.find((r) => r.spotId === spot.id);
    if (!report) {
      console.error(`No report returned for ${spot.id} — leaving previous file in place`);
      continue;
    }
    fs.writeFileSync(
      `${OUT_DIR}${spot.id}.json`,
      JSON.stringify({ spotId: spot.id, spotName: spot.name, generatedAt, ...report }, null, 2) + "\n",
    );
    console.log(`wrote reports/${spot.id}.json — "${report.headline}"`);
  }
  console.log(`tokens: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
