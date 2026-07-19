// Entry point: spot tabs (hash-routed), data orchestration, Now card, day cards.

import { SPOTS } from "./config.js";
import { getSpotData, nyNow, nyToday, compass, selfTest } from "./data.js";
import { renderSwellChart, renderWindRow, renderTideChart } from "./charts.js";

const $ = (sel) => document.querySelector(sel);
const tabsEl = $("#tabs");
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
    blocks.push(["Swell", `${hr.swellHt} ft @ ${Math.round(hr.swellPer)}s`, `${compass(hr.swellDir)} (${Math.round(hr.swellDir)}°)`]);
  }
  if (hr.windSpd != null) {
    blocks.push(["Wind", `${Math.round(hr.windSpd)} mph ${compass(hr.windDir)}`, null, hr.windClass]);
  }
  if (nextTide) {
    blocks.push(["Next tide", `${nextTide.type === "H" ? "High" : "Low"} ${fmtClock(nextTide.min)}`, `${nextTide.ft} ft`]);
  }

  for (const [label, big, sub, windClass] of blocks) {
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
      const s = document.createElement("div"); s.className = "now-sub"; s.textContent = sub;
      div.append(s);
    }
    nowEl.append(div);
  }
}

function renderDays(model, spot) {
  const allHours = model.days.flatMap((d) => d.hours);
  const maxSwell = Math.max(0, ...allHours.map((h) => h.swellHt ?? 0));
  const yMax = Math.max(4, Math.ceil(maxSwell));

  const tideVals = model.tide.curve.map((p) => p.ft);
  const tideMin = tideVals.length ? Math.min(...tideVals) - 0.5 : 0;
  const tideMax = tideVals.length ? Math.max(...tideVals) + 0.5 : 5;

  const now = nyNow();
  daysEl.replaceChildren();

  model.days.forEach((day, i) => {
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
    );
    card.append(scroll);
    daysEl.append(card);
  });
}

async function render(spot, { force = false } = {}) {
  const seq = ++renderSeq;
  currentSpot = spot;
  markActiveTab();
  skeleton();
  try {
    const model = await getSpotData(spot, { force });
    if (seq !== renderSeq) return; // user switched tabs mid-fetch
    renderErrors(model, spot);
    renderNowCard(model, spot);
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

buildTabs();
window.addEventListener("hashchange", () => render(spotFromHash()));
$("#refresh").addEventListener("click", () => render(currentSpot, { force: true }));

// Keep the now-marker and "Today" boundary honest without user interaction.
setInterval(() => { if (currentSpot) render(currentSpot); }, 5 * 60 * 1000);

if (new URLSearchParams(location.search).has("debug")) selfTest();
render(spotFromHash());
