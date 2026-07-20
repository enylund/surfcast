// All tunable knobs live here.

export const TZ = "America/New_York";
export const FORECAST_DAYS = 7;        // fetched (full week)
export const DEFAULT_VISIBLE_DAYS = 4; // shown before "Load full week"
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const LIGHT_WIND_MPH = 5; // below this, wind class is "light" (glassy) regardless of angle

// facing = compass azimuth (degrees true) pointing from the sand straight out to sea.
// Tune these if the offshore/onshore calls feel off for a spot.
//
// swell = direction-quality bands (degrees true, "coming from", [start, end] arcs).
// Five tiers matching the wind color ramp, checked narrowest-first:
//   prime (green)     — the peeling window; stringent on purpose
//   good (yellow-green) — quality angle, worth a session
//   fair (gray)       — breaks, nothing special
//   marginal (orange) — junky angle
//   poor (red)        — anything outside marginal: wrong angle entirely
// Bands from spot guides (Surfline/surf-forecast/deepswell, 2026-07) tightened by
// local experience: Rockaway really needs ESE to be truly great.
export const SPOTS = [
  { id: "rockaway", name: "Rockaway 67th St", lat: 40.582, lon: -73.818, tideStation: "8516881", facing: 170,
    swell: { prime: [100, 130], good: [90, 145], fair: [80, 165], marginal: [70, 205] },
    cams: [
      { name: "TSV Rockaway", url: "https://thesurfersview.com/live-cams/new-york/rockaway-beach-cam-and-surf-report/" },
      { name: "NYSEA Rockaway", url: "https://nysea.com/live-cam/rockaway-ny/" },
      { name: "90th St", url: "https://www.eastcoastcams.com/new-york/rockaway-point/90th-st-rockaways/" },
      { name: "Surfline B90 ★", url: "https://www.surfline.com/surf-report/rockaways/5842041f4e65fad6a7708852" },
    ] },
  { id: "lido",     name: "Lido Beach",       lat: 40.588, lon: -73.625, tideStation: "8516385", facing: 175,
    swell: { prime: [125, 160], good: [110, 180], fair: [95, 200], marginal: [80, 215] },
    cams: [
      { name: "TSV Lido", url: "https://thesurfersview.com/live-cams/new-york/lido-beach-cam-and-surf-report/" },
      { name: "NYSEA Lido", url: "https://nysea.com/live-cam/lido-beach-ny/" },
      { name: "Skudin Long Beach", url: "https://www.skudinsurf.com/surf-cam" },
      { name: "Surfline Lido ★", url: "https://www.surfline.com/surf-report/lido-beach/5842041f4e65fad6a77089e2" },
    ] },
  { id: "ditch",    name: "Ditch Plains",     lat: 41.033, lon: -71.919, tideStation: "8510560", facing: 165,
    swell: { prime: [130, 170], good: [110, 195], fair: [90, 215], marginal: [60, 240] },
    cams: [
      { name: "Marram (beachfront)", url: "https://www.marrammontauk.com/surf" },
      { name: "Surf-Forecast Ditch", url: "https://www.surf-forecast.com/breaks/Ditch-Plains/webcams/latest" },
      { name: "Montauk cam", url: "https://nybeachcams.com/long-island/montauk-surf-cam/" },
      { name: "Surfline Ditch ★", url: "https://www.surfline.com/surf-report/ditch-plains/5842041f4e65fad6a77089ec" },
    ] },
];

// Wind class band edges: angular distance (degrees) between the wind's "from"
// direction and the perfect-offshore "from" direction. See classifyWind() in data.js.
export const WIND_BANDS = [
  { max: 22.5,  cls: "offshore"  },
  { max: 67.5,  cls: "cross-off" },
  { max: 112.5, cls: "cross"     },
  { max: 157.5, cls: "cross-on"  },
  { max: 180,   cls: "onshore"   },
];

// Chart geometry (SVG user units == CSS px). All three charts share the x-scale.
export const LAYOUT = {
  gutter: 40,          // left gutter for y-axis labels
  hourW: 28,           // px per hour
  plotW: 24 * 28,      // 672
  swellH: 148,
  windH: 64,
  tideH: 108,
  wxH: 54,
};

// If sunrise/sunset data is missing, dim outside this window (hours, 24h clock).
export const DAYLIGHT_FALLBACK = [5, 21];
