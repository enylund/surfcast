// Session log view — reads sessions.json (written by scripts/log-session.mjs)
// and renders each logged session with its objective conditions fingerprint
// alongside the subjective ratings.

const WX = {
  0: "clear", 1: "clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "rain", 63: "rain", 65: "heavy rain",
  71: "snow", 73: "snow", 75: "snow", 80: "showers", 81: "showers", 82: "heavy showers",
  95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm",
};

const BOARD = { longboard: "Longboard", midlength: "Mid-length", fish: "Fish", short: "Shortboard" };

// Fractional stars: a gold ★★★★★ layer clipped to (rating/5) width over a gray
// ★★★★★ track, so 2.5 reads as exactly half of the third star.
function starsEl(n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  const wrap = document.createElement("span");
  wrap.className = "stars";
  wrap.title = `${v} / 5`;
  const bg = document.createElement("span");
  bg.className = "stars-bg";
  bg.textContent = "★★★★★";
  const fg = document.createElement("span");
  fg.className = "stars-fg";
  fg.textContent = "★★★★★";
  fg.style.width = `${(v / 5) * 100}%`;
  wrap.append(bg, fg);
  return wrap;
}

export async function loadSessions() {
  try {
    const res = await fetch("sessions.json", { cache: "no-cache" });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ratingRow(label, n, extra) {
  const div = el("div", "sess-rating");
  div.append(el("span", "sess-rating-label", label));
  div.append(starsEl(n));
  if (extra) div.append(el("span", "sess-rating-x", extra));
  return div;
}

function fpChip(text, cls) {
  const c = el("span", `sess-chip${cls ? " " + cls : ""}`, text);
  return c;
}

function sessionCard(s) {
  const fp = s.fingerprint || {};
  const card = el("div", "sess-card");

  const head = el("div", "sess-head");
  const title = el("div", "sess-title");
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${s.date}T12:00:00Z`));
  title.append(el("span", "sess-date", `${date} · ${s.timeRange?.label || ""}`));
  title.append(el("span", "sess-spot", s.spotName));
  head.append(title);
  const overall = el("div", "sess-overall");
  overall.append(starsEl(s.ratings?.overall));
  head.append(overall);
  card.append(head);

  // Objective conditions fingerprint
  const cond = el("div", "sess-cond");
  if (fp.swellHt_ft != null)
    cond.append(fpChip(`${fp.swellHt_ft}ft @ ${fp.swellPer_s}s ${fp.swellDir_compass}`, `sw-${fp.swellClass || "fair"}`));
  if (fp.windSpd_mph != null)
    cond.append(fpChip(`${fp.windSpd_mph}mph ${fp.windDir_compass}`, `wc-fg-${fp.windClass || "cross"}`));
  if (fp.waterTemp_f != null) cond.append(fpChip(`💧 ${fp.waterTemp_f}°`));
  if (fp.airTemp_f != null) cond.append(fpChip(`☀ ${fp.airTemp_f}°`));
  if (fp.tide_state) {
    const arrow = fp.tide_state === "rising" ? "↑" : fp.tide_state === "falling" ? "↓" : "→";
    cond.append(fpChip(`tide ${arrow} ${fp.tide_ft_start}→${fp.tide_ft_end}ft`));
  }
  if (fp.weatherCode != null && WX[fp.weatherCode]) cond.append(fpChip(WX[fp.weatherCode]));
  card.append(cond);

  if (fp.tide_prev || fp.tide_next) {
    const t = [];
    if (fp.tide_prev) t.push(`${fp.tide_prev.type} ${fp.tide_prev.time} (${fp.tide_prev.ft}ft)`);
    if (fp.tide_next) t.push(`${fp.tide_next.type} ${fp.tide_next.time} (${fp.tide_next.ft}ft)`);
    card.append(el("div", "sess-tide-detail", `Tides: ${t.join(" → ")}`));
  }

  // Ratings
  const ratings = el("div", "sess-ratings");
  ratings.append(ratingRow("Size/period", s.ratings?.swellSize));
  ratings.append(ratingRow("Direction", s.ratings?.swellDirection));
  if (s.ratings?.wind != null) ratings.append(ratingRow("Wind", s.ratings.wind));
  ratings.append(ratingRow("Emptiness", s.ratings?.crowd));
  card.append(ratings);

  // Gear + comfort
  const g = s.gear || {};
  const gearParts = [];
  if (g.board) gearParts.push(BOARD[g.board] || g.board);
  if (g.wetsuit) {
    let w = g.wetsuit === "none" ? "no wetsuit" : g.wetsuit;
    const acc = [g.booties && "booties", g.gloves && "gloves", g.hood && "hood"].filter(Boolean);
    if (acc.length) w += ` + ${acc.join(", ")}`;
    gearParts.push(w);
  }
  const comfort = [];
  if (s.comfort?.tooCold) comfort.push("🥶 too cold");
  if (s.comfort?.tooWarm) comfort.push("🥵 too warm");
  if (gearParts.length || comfort.length) {
    const gear = el("div", "sess-gear");
    if (gearParts.length) gear.append(el("span", null, gearParts.join(" · ")));
    for (const c of comfort) gear.append(el("span", "sess-comfort", c));
    card.append(gear);
  }

  if (s.comments) card.append(el("div", "sess-comments", s.comments));
  return card;
}

export function renderSessionsView(container, sessions) {
  container.replaceChildren();
  const head = el("div", "sess-view-head");
  head.append(el("h2", "sess-view-title", "Session log"));
  if (sessions.length) head.append(el("span", "sess-count", `${sessions.length} logged`));
  container.append(head);

  if (!sessions.length) {
    container.append(el("p", "sess-empty",
      "No sessions logged yet. Tell Claude about a surf session — day, time range, spot, and your ratings — and it captures the conditions and adds it here."));
    return;
  }
  for (const s of sessions) container.append(sessionCard(s));
}
