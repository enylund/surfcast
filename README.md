# Surfcast

Personal surf forecast dashboard — swell, wind (offshore/onshore/cross), and tide
for today + the next 3 days at Rockaway 67th St, Lido Beach, and Ditch Plains.

## Run

```sh
cd ~/Projects/surfcast
python3 -m http.server 8000
```

Open http://localhost:8000. From a phone on the same wifi: `http://<your-mac-ip>:8000`
(find it with `ipconfig getifaddr en0`).

## Data sources (free, no API keys)

- **Open-Meteo Marine API** — hourly swell height/period/direction (ft)
- **Open-Meteo Forecast API** — hourly wind speed/gusts (mph), direction, sunrise/sunset
- **NOAA CO-OPS** — tide predictions (stations: 8516881 Rockaway, 8516385 Lido, 8510560 Montauk)

Lido's station is a "subordinate" NOAA station that only publishes high/low times,
so its curve is synthesized with cosine interpolation between H/L events.

## Tuning (config.js)

- `facing` per spot — compass azimuth from the sand out to sea; drives the
  offshore/cross/onshore wind call. Adjust if classifications feel off.
- `tideStation` per spot — swap the NOAA station id (Ditch Plains currently uses
  Montauk/Fort Pond Bay, which is bay-side; ocean-side timing may differ a bit).
- `CACHE_TTL_MS` — forecast cache lifetime (default 30 min; data is cached in
  localStorage, the ↻ button forces a refetch).

## AI surf report

A GitHub Action ([.github/workflows/reports.yml](.github/workflows/reports.yml)) runs
each morning (~5am ET), sends a condensed forecast digest to the Claude API
(`claude-opus-4-8`), and commits `reports/{spot}.json` — a headline, a "today" writeup,
and "Days to watch" — which the app renders at the top of each spot. Requires the
`ANTHROPIC_API_KEY` repo secret (`gh secret set ANTHROPIC_API_KEY`). Trigger manually with
`gh workflow run reports.yml`. Test the digest locally without a key:
`DIGEST_ONLY=1 node scripts/generate-reports.mjs`.

## Session log

Tracks surfed sessions with an objective conditions fingerprint. Two ways to log:

**In-app form (`#log`, the "+ Log" header button).** Fill the form on the site; it
runs the same fingerprint capture in the browser ([conditions.js](conditions.js))
and commits the session to `sessions.json` via the GitHub API. Gated by a GitHub
fine-grained token (Contents: read/write on this repo) stored **encrypted behind a
password** in your browser (Web Crypto, AES-GCM/PBKDF2 — see [logform.js](logform.js)).
First use: paste the token + set a password; after that, just enter the password.
Saved sessions appear in the log ~1 min later (after Pages rebuilds). To move to a
Vercel backend later, only `saveSession()` in logform.js changes (swap the GitHub
commit for a `fetch()` to your API route).

**Chat.** Describe a session to Claude; it runs
[scripts/log-session.mjs](scripts/log-session.mjs) (same [conditions.js](conditions.js))
and commits the record.

Either way: Open-Meteo marine + forecast + NOAA tides for that spot/date/time
window, averaged over the session, wind/swell classified per spot, appended to
`sessions.json`. The **Sessions** view reads and displays them.

Log a session:
```sh
node scripts/log-session.mjs '{"date":"2026-07-19","spotId":"rockaway","start":"07:00","end":"09:00","label":"7–9am","ratings":{"swellSize":3,"swellDirection":4,"wind":5,"crowd":2,"overall":4},"gear":{"board":"fish","wetsuit":"3/2 full","gloves":false,"booties":false,"hood":false},"comfort":{"tooCold":false,"tooWarm":false},"comments":"..."}'
```
Fields: `board` = longboard|midlength|fish|short; `wetsuit` = none|top|2mm spring|
2/2 full|3/2 full|4/3 full|5/4 full|6/5 full; ratings 0–5 (crowd: 5 = empty; wind: 5 = ideal).
The fingerprint uses recent-past forecast data, so log within ~3 months of the date.
Note: the repo is public, so keep `comments` non-sensitive.

## Debugging

Open with `?debug=1` to run the wind-classification self-test and dump the
merged data model (`console.table`) for comparison against the raw API JSON in
the Network tab.

## Notes

- Reading the charts: arrows point where the swell/wind is *going*; text labels
  name the direction it comes *from* (surf convention).
- Night hours are dimmed using actual sunrise/sunset.
- The yellow dashed line marks "now" on today's card (refreshes every 5 min).
