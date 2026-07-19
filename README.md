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

## Debugging

Open with `?debug=1` to run the wind-classification self-test and dump the
merged data model (`console.table`) for comparison against the raw API JSON in
the Network tab.

## Notes

- Reading the charts: arrows point where the swell/wind is *going*; text labels
  name the direction it comes *from* (surf convention).
- Night hours are dimmed using actual sunrise/sunset.
- The yellow dashed line marks "now" on today's card (refreshes every 5 min).
