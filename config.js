// All tunable knobs live here.

export const TZ = "America/New_York";
export const FORECAST_DAYS = 7;        // fetched (full week)
export const DEFAULT_VISIBLE_DAYS = 4; // shown before "Load full week"
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const LIGHT_WIND_MPH = 5; // below this, wind class is "light" (glassy) regardless of angle

// facing = compass azimuth (degrees true) pointing from the sand straight out to sea.
// Tune these if the offshore/onshore calls feel off for a spot.
export const SPOTS = [
  { id: "rockaway", name: "Rockaway 67th St", lat: 40.582, lon: -73.818, tideStation: "8516881", facing: 170 },
  { id: "lido",     name: "Lido Beach",       lat: 40.588, lon: -73.625, tideStation: "8516385", facing: 175 },
  { id: "ditch",    name: "Ditch Plains",     lat: 41.033, lon: -71.919, tideStation: "8510560", facing: 165 },
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
};

// If sunrise/sunset data is missing, dim outside this window (hours, 24h clock).
export const DAYLIGHT_FALLBACK = [5, 21];
