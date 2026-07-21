// Entry point: spot tabs (hash-routed), data orchestration, Now card, day cards.

import { SPOTS, DEFAULT_VISIBLE_DAYS } from "./config.js";
import { getSpotData, nyNow, nyToday, compass, selfTest } from "./data.js";
import { renderSwellChart, renderWindRow, renderTideChart, renderWeatherRow, renderSpotMap } from "./charts.js";
import { loadSessions, renderSessionsView } from "./sessions.js";
import { renderLogForm } from "./logform.js";

const $ = (sel) => document.querySelector(sel);
const tabsEl = $("#tabs");
const reportEl = $("#report");
const sessionsEl = $("#sessions-view");
const logEl = $("#log-view");
const nowEl = $("#now-card");
const daysEl = $("#days");
const errorsEl = $("#errors");
const updatedEl = $("#updated");

const WIND_CLASS_LABEL = {
  offshore: "offshore", "cross-off": "cross-offshore", cross: "cross-shore",
  "cross-on": "cross-onshore", onshore: "onshore", light: "light / glassy",
};

let currentSpot = null;
let renderSeq = 0; // ignore stale async renders after quick tab switches
const expandedSpots = new Set(); // spots showing the full week this session

function spotFromHash() {
  const id = location.hash.slice(1);
  return SPOTS.find((s) => s.id === id) || SPOTS[0];
}

function buildTabs() {
  for (const spot of SPOTS) {
    const btn = document.createElement("button");
    btn.textContent = spot.name;
    btn.dataset.spot = spot.id;
    btn.addEventListener("click", () => { location.hash = spot.id; });
    tabsEl.append(btn);
  }
}

function markActiveTab() {
  for (const btn of tabsEl.children)
    btn.classList.toggle("active", btn.dataset.spot === currentSpot.id);
}

function fmtClock(min) {
  let h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  const ap = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function dayTitle(dateStr, idx) {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  }).format(new Date(`${dateStr}T12:00:00Z`));
  if (idx === 0) return `Today · ${label}`;
  if (idx === 1) return `Tomorrow · ${label}`;
  return label;
}

function skeleton() {
  daysEl.replaceChildren();
  nowEl.hidden = true;
  reportEl.hidden = true;
  errorsEl.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const d = document.createElement("div");
    d.className = "day-card skeleton";
    daysEl.append(d);
  }
}

function renderErrors(model, spot) {
  errorsEl.replaceChildren();
  for (const [source, msg] of Object.entries(model.errors || {})) {
    const chip = document.createElement("div");
    chip.className = "error-chip";
    chip.textContent = `${source} data unavailable (${msg}) `;
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => render(spot, { force: true }));
    chip.append(retry);
    errorsEl.append(chip);
  }
}

function renderNowCard(model, spot) {
  const now = nyNow();
  const day = model.days.find((d) => d.date === now.date);
  const hr = day?.hours[Math.min(23, Math.floor(now.min / 60))];
  if (!hr) { nowEl.hidden = true; return; }

  const nowAbs = model.days.findIndex((d) => d.date === now.date) * 1440 + now.min;
  const nextTide = model.tide.hilo.find((ev) => ev.dayIndex * 1440 + ev.min >= nowAbs);

  nowEl.replaceChildren();
  nowEl.hidden = false;

  const blocks = [];
  if (hr.swellHt != null) {
    const lined = hr.swellClass === "prime" ? " · prime angle"
      : hr.swellClass === "good" ? " · good angle"
      : hr.swellClass === "marginal" ? " · junky angle"
      : hr.swellClass === "poor" ? " · wrong angle" : "";
    blocks.push(["Swell", `${hr.swellHt} ft @ ${Math.round(hr.swellPer)}s`,
      `${compass(hr.swellDir)} (${Math.round(hr.swellDir)}°)${lined}`, null, `sw-${hr.swellClass || "fair"}`]);
  }
  if (hr.windSpd != null) {
    blocks.push(["Wind", `${Math.round(hr.windSpd)} mph ${compass(hr.windDir)}`, null, hr.windClass]);
  }
  if (nextTide) {
    blocks.push(["Next tide", `${nextTide.type === "H" ? "High" : "Low"} ${fmtClock(nextTide.min)}`, `${nextTide.ft} ft`]);
  }

  for (const [label, big, sub, windClass, subClass] of blocks) {
    const div = document.createElement("div");
    div.className = "now-block";
    const l = document.createElement("div"); l.className = "now-label"; l.textContent = label;
    const b = document.createElement("div"); b.className = "now-big"; b.textContent = big;
    div.append(l, b);
    if (windClass) {
      const badge = document.createElement("span");
      badge.className = `wind-badge wc-bg-${windClass}`;
      badge.textContent = WIND_CLASS_LABEL[windClass];
      div.append(badge);
    } else if (sub) {
      const s = document.createElement("div");
      s.className = `now-sub${subClass ? " " + subClass : ""}`;
      s.textContent = sub;
      div.append(s);
    }
    nowEl.append(div);
  }

  // Map rail: zoomed coastline with the current swell/wind arrows overlaid.
  nowEl.append(renderSpotMap(spot, hr));

  // Webcams at or near the spot (★ = Surfline, needs premium for full view).
  if (spot.cams?.length) {
    const row = document.createElement("div");
    row.className = "cam-row";
    const label = document.createElement("span");
    label.className = "cam-label";
    label.textContent = "Cams";
    row.append(label);
    for (const cam of spot.cams) {
      const a = document.createElement("a");
      a.href = cam.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = cam.name;
      row.append(a);
    }
    nowEl.append(row);
  }
}

// AI-generated report, produced twice daily by a GitHub Action
// (scripts/generate-reports.mjs) and committed as reports/{id}.json.
// Missing file (e.g. running locally before the first generation) → section hidden.
async function loadReport(spot) {
  try {
    const res = await fetch(`reports/${spot.id}.json`, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function reportAge(generatedAt) {
  const mins = Math.round((Date.now() - Date.parse(generatedAt)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

function renderReport(report) {
  reportEl.replaceChildren();
  if (!report) { reportEl.hidden = true; return; }
  reportEl.hidden = false;

  const headline = document.createElement("h3");
  headline.textContent = report.headline;
  const body = document.createElement("p");
  body.textContent = report.today;
  reportEl.append(headline, body);

  if (report.daysToWatch?.length) {
    const h4 = document.createElement("h4");
    h4.textContent = "Days to watch";
    const list = document.createElement("ul");
    list.className = "dtw";
    for (const d of report.daysToWatch) {
      const li = document.createElement("li");
      const day = document.createElement("span");
      day.className = "dtw-day";
      day.textContent = d.day;
      li.append(day, ` ${d.note}`);
      list.append(li);
    }
    reportEl.append(h4, list);
  }

  const meta = document.createElement("div");
  meta.className = "report-meta";
  const stale = Date.now() - Date.parse(report.generatedAt) > 36 * 3600 * 1000;
  meta.textContent = `AI-generated forecast · updated ${reportAge(report.generatedAt)}${stale ? " · may be out of date" : ""}`;
  reportEl.append(meta);
}

function renderDays(model, spot) {
  const expanded = expandedSpots.has(spot.id);
  const visibleDays = expanded ? model.days : model.days.slice(0, DEFAULT_VISIBLE_DAYS);

  // scales are computed over the visible window so days stay comparable
  const allHours = visibleDays.flatMap((d) => d.hours);
  const maxSwell = Math.max(0, ...allHours.map((h) => h.swellHt ?? 0));
  const yMax = Math.max(4, Math.ceil(maxSwell));

  const tideVals = model.tide.curve.filter((p) => p.dayIndex < visibleDays.length).map((p) => p.ft);
  const tideMin = tideVals.length ? Math.min(...tideVals) - 0.5 : 0;
  const tideMax = tideVals.length ? Math.max(...tideVals) + 0.5 : 5;

  const now = nyNow();
  daysEl.replaceChildren();

  visibleDays.forEach((day, i) => {
    const card = document.createElement("div");
    card.className = "day-card";

    const h2 = document.createElement("h2");
    h2.textContent = dayTitle(day.date, i);
    const extras = [];
    // midday water temp as the day's representative value
    const waterTemp = day.hours[12]?.waterTemp ?? day.hours.find((h) => h.waterTemp != null)?.waterTemp;
    if (waterTemp != null) extras.push(`💧 ${waterTemp}°F`);
    if (day.sunrise != null) extras.push(`☀ ${fmtClock(day.sunrise)} – ${fmtClock(day.sunset)}`);
    if (extras.length) {
      const sun = document.createElement("span");
      sun.className = "sun-times";
      sun.textContent = extras.join("   ");
      h2.append(sun);
    }
    card.append(h2);

    const scroll = document.createElement("div");
    scroll.className = "charts-scroll";
    const nowMin = day.date === now.date ? now.min : null;
    scroll.append(
      renderSwellChart(day, { yMax, nowMin }),
      renderWindRow(day, { nowMin }),
      renderTideChart(day, i, model.tide, { tideMin, tideMax, nowMin, clipId: `tclip-${spot.id}-${i}` }),
      renderWeatherRow(day, { nowMin }),
    );
    card.append(scroll);
    daysEl.append(card);
  });

  if (model.days.length > DEFAULT_VISIBLE_DAYS) {
    const btn = document.createElement("button");
    btn.className = "load-more";
    btn.textContent = expanded
      ? "Show fewer days"
      : `Load full week (+${model.days.length - DEFAULT_VISIBLE_DAYS} days)`;
    btn.addEventListener("click", () => {
      expandedSpots.has(spot.id) ? expandedSpots.delete(spot.id) : expandedSpots.add(spot.id);
      renderDays(model, spot); // data is already fetched; expanding is instant
    });
    daysEl.append(btn);
  }
}

async function render(spot, { force = false } = {}) {
  const seq = ++renderSeq;
  currentSpot = spot;
  markActiveTab();
  skeleton();
  try {
    const [model, report] = await Promise.all([getSpotData(spot, { force }), loadReport(spot)]);
    if (seq !== renderSeq) return; // user switched tabs mid-fetch
    renderErrors(model, spot);
    renderNowCard(model, spot);
    renderReport(report);
    renderDays(model, spot);
    updatedEl.textContent = `updated ${new Date(model.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
    if (new URLSearchParams(location.search).has("debug")) {
      console.log("model", model);
      console.table(model.days[0].hours.map(({ t, swellHt, swellPer, swellDir, windSpd, windDir, windClass }) =>
        ({ t, swellHt, swellPer, swellDir, windSpd, windDir, windClass })));
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    daysEl.replaceChildren();
    const chip = document.createElement("div");
    chip.className = "error-chip";
    chip.textContent = `Could not load forecast: ${err.message} `;
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => render(spot, { force: true }));
    chip.append(retry);
    errorsEl.replaceChildren(chip);
  }
}

// Toggle between forecast / session-log / log-form views.
function setView(mode) {
  const forecast = mode === "forecast";
  for (const el of [nowEl, reportEl, errorsEl, daysEl]) el.hidden = !forecast;
  sessionsEl.hidden = mode !== "sessions";
  logEl.hidden = mode !== "log";
  $("#sessions-btn").classList.toggle("active", mode === "sessions");
  $("#log-btn").classList.toggle("active", mode === "log");
  for (const btn of tabsEl.children) btn.classList.toggle("dimmed", !forecast);
}

async function renderSessions() {
  renderSeq++; // cancel any in-flight forecast render
  setView("sessions");
  renderSessionsView(sessionsEl, []); // instant shell
  const sessions = await loadSessions();
  renderSessionsView(sessionsEl, sessions);
}

function route() {
  const hash = location.hash.slice(1);
  if (hash === "sessions") return renderSessions();
  if (hash === "log") { renderSeq++; setView("log"); return renderLogForm(logEl); }
  setView("forecast");
  render(spotFromHash());
}

buildTabs();
window.addEventListener("hashchange", route);
$("#sessions-btn").addEventListener("click", () => { location.hash = "sessions"; });
$("#log-btn").addEventListener("click", () => { location.hash = "log"; });
$("#refresh").addEventListener("click", () => {
  const hash = location.hash.slice(1);
  if (hash === "sessions") renderSessions();
  else if (hash !== "log") render(currentSpot, { force: true });
});

// Keep the now-marker and "Today" boundary honest without user interaction.
setInterval(() => { if (currentSpot && !["sessions", "log"].includes(location.hash.slice(1))) render(currentSpot); }, 5 * 60 * 1000);

if (new URLSearchParams(location.search).has("debug")) selfTest();
route();
