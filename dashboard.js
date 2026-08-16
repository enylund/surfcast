// Dashboard homepage — an AI read of the week, an at-a-glance scoreboard, a
// weekend spotlight, and a 7-day heatmap across all spots, with an opinionated
// "worth the drive" call. Rendered as the default view in the app (app.js).
// Every score links to the specific day it refers to on the full forecast.

import { SPOTS } from "./config.js";
import { getSpotData, nyNow } from "./data.js";

// Rough drive times from NYC/Rockaway. Rockaway is "home".
const DRIVE = {
  rockaway: { min: 0, label: "home" },
  lido: { min: 45, label: "45 min" },
  manasquan: { min: 90, label: "1.5 hr" },
  ditch: { min: 150, label: "2.5 hr" },
  matunuck: { min: 180, label: "3 hr" },
};
const HOME = "rockaway";

// ---- surfability score (0–100) = size × period × swell-angle × wind ----
function sizeFactor(ft) {
  if (ft == null) return 0;
  if (ft < 1) return 0.15;
  if (ft < 1.5) return 0.4;
  if (ft < 2) return 0.6;
  if (ft < 3) return 0.85;
  if (ft < 5) return 1.0;
  if (ft < 8) return 0.95;
  return 0.8;
}
function periodFactor(s) {
  if (s == null) return 0.7;
  if (s < 5) return 0.6;
  if (s < 6) return 0.78;
  if (s < 8) return 0.9;
  return 1.0;
}
const SWELL_MULT = { prime: 1.0, good: 0.85, fair: 0.6, marginal: 0.35, poor: 0.15 };
const WIND_MULT = { offshore: 1.0, light: 0.95, "cross-off": 0.85, cross: 0.6, "cross-on": 0.4, onshore: 0.2 };

// Wind's effect on quality is really speed-gated: below ~7 mph the ocean is
// basically glassy no matter the direction (a light onshore dusk is clean, nearly
// as good as offshore), and direction only fully bites once it's blowing. So we
// floor the direction penalty at low speeds and only let it take over as it builds.
function windMult(h) {
  const spd = h.windSpd ?? 0;
  const base = WIND_MULT[h.windClass] ?? 0.6;
  if (spd < 5) return Math.max(base, 0.95); // glassy — direction irrelevant
  if (spd < 8) return Math.max(base, 0.88); // light — clean, direction barely matters
  if (spd < 11) return Math.max(base, 0.7); // moderate — direction starts to bite
  return base;                              // 11+ mph — direction fully in play
}

function hourScore(h) {
  if (h == null || h.swellHt == null) return 0;
  return Math.round(100 * sizeFactor(h.swellHt) * periodFactor(h.swellPer)
    * (SWELL_MULT[h.swellClass] ?? 0.6) * windMult(h));
}

const scoreClass = (s) => (s >= 72 ? "sc-fire" : s >= 55 ? "sc-good" : s >= 38 ? "sc-fun" : s >= 22 ? "sc-marg" : "sc-flat");
const verdict = (s) => (s >= 72 ? "Fire" : s >= 55 ? "Good" : s >= 38 ? "Fun" : s >= 22 ? "Marginal" : "Flat");
const fmtTime = (min) => { let h = Math.floor(min / 60); const ap = h < 12 ? "a" : "p"; h = h % 12 || 12; return `${h}${ap}`; };
const dayLabel = (date, i) => (i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`)));

function ageStr(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

// Peak daylight score per day + the current-hour score.
function analyze(model) {
  const now = nyNow();
  const days = model.days.map((d, i) => {
    const rise = d.sunrise ?? 5 * 60, set = d.sunset ?? 21 * 60;
    // Morning vs afternoon windows split at noon — the two often play out very
    // differently (offshore dawn vs blown-out midday, or a glassy evening).
    const am = { peak: 0, hr: null }, pm = { peak: 0, hr: null };
    for (const h of d.hours) {
      if (h.min < rise || h.min > set) continue;
      const sc = hourScore(h);
      const w = h.min < 12 * 60 ? am : pm;
      if (sc > w.peak) { w.peak = sc; w.hr = h; }
    }
    const peak = Math.max(am.peak, pm.peak);
    const peakHr = am.peak >= pm.peak ? am.hr : pm.hr;
    return { i, date: d.date, label: dayLabel(d.date, i), am, pm, peak, peakHr,
      weekday: new Date(`${d.date}T12:00:00Z`).getUTCDay() };
  });
  const today = model.days.find((d) => d.date === now.date);
  const nowHr = today?.hours[Math.min(23, Math.floor(now.min / 60))];
  const best = days.reduce((a, b) => (b.peak > a.peak ? b : a), days[0]);
  return { spotId: model.spotId, days, now: { score: hourScore(nowHr), hr: nowHr }, best };
}

// Opinionated drive call: a spot must clear a "worth going" bar (best day at least
// "fire"-tier, ~70) AND beat home by a margin that scales with drive time.
function driveVerdict(a, homeA) {
  if (a.spotId === HOME) return { kind: "home", text: "your home break" };
  const drive = DRIVE[a.spotId]?.min ?? 120;
  const margin = Math.round(drive / 7); // 45m→6, 1.5h→13, 2.5h→21, 3h→26
  const homeThatDay = homeA.days[a.best.i]?.peak ?? 0;
  const beatsHome = a.best.peak - homeThatDay;
  if (a.best.peak >= 70 && beatsHome >= margin) {
    return { kind: "go", text: `Worth the drive — ${a.best.label} ${fmtTime(a.best.peakHr.min)}` };
  }
  if (a.best.peak >= 60 && beatsHome >= margin - 8) {
    return { kind: "maybe", text: `Maybe — ${a.best.label}, but a stretch for the drive` };
  }
  return { kind: "no", text: "Stay local — not worth the drive" };
}

// ---------------------------------------------------------------------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// Deep link to a specific day on a spot's full forecast (app.js handles #spot/date).
const dayHref = (spotId, date) => `#${spotId}/${date}`;

function nowCell(a) {
  const wrap = el("div", "ov-now");
  const hr = a.now.hr;
  if (!hr || hr.swellHt == null) { wrap.append(el("span", "ov-dim", "—")); return wrap; }
  wrap.append(el("span", "ov-now-swell", `${hr.swellHt}ft ${hr.swellPer ? "@" + Math.round(hr.swellPer) + "s" : ""} ${hr.swellDir_compass || ""}`.trim()));
  wrap.append(el("span", `ov-now-wind wc-${hr.windClass || "cross"}`, `${Math.round(hr.windSpd)}mph ${hr.windClass || ""}`));
  return wrap;
}

function scoreBadge(score, big) {
  const b = el("div", `ov-score ${scoreClass(score)}${big ? " ov-score-lg" : ""}`);
  b.append(el("span", "ov-score-num", String(score)));
  if (big) b.append(el("span", "ov-score-verdict", verdict(score)));
  return b;
}

function render(container, analyses, models, ai) {
  container.replaceChildren();
  const home = analyses.find((a) => a.spotId === HOME);
  const spotName = (id) => SPOTS.find((s) => s.id === id).name;

  // --- AI read of the week (generated alongside the daily spot reports) ---
  if (ai?.summary) {
    const card = el("div", "ov-ai");
    card.append(el("div", "ov-ai-label", "The read"));
    card.append(el("p", "ov-ai-text", ai.summary));
    if (ai.generatedAt) card.append(el("div", "ov-ai-meta", `AI-generated · updated ${ageStr(ai.generatedAt)}`));
    container.append(card);
  }

  // --- top-line best call across everything (links to that day) ---
  const bestOverall = analyses.map((a) => ({ a, ...a.best })).reduce((x, y) => (y.peak > x.peak ? y : x));
  const bId = bestOverall.a.spotId;
  const banner = el("a", `ov-banner ${scoreClass(bestOverall.peak)}`);
  banner.href = dayHref(bId, bestOverall.date);
  const driveTxt = bId === HOME ? "" : ` · ${DRIVE[bId].label} drive`;
  banner.append(el("div", "ov-banner-label", "This week's best"));
  banner.append(el("div", "ov-banner-main", `${spotName(bId)} — ${bestOverall.label} ${fmtTime(bestOverall.peakHr.min)} · ${verdict(bestOverall.peak)} (${bestOverall.peak})${driveTxt}`));
  container.append(banner);

  // --- scoreboard: two clearly separated zones per spot ---
  //   NOW (current conditions → jumps to the spot) | OUTLOOK (week's best day →
  //   jumps to that day, plus the worth-the-drive call).
  const board = el("div", "ov-board");
  board.append(el("h3", "ov-h", "Spots"));
  const ordered = [home, ...analyses.filter((a) => a.spotId !== HOME).sort((x, y) => y.best.peak - x.best.peak)];
  for (const a of ordered) {
    const dv = driveVerdict(a, home);
    const row = el("div", `ov-row ${a.spotId === HOME ? "ov-home" : ""}`);

    // NOW zone → the spot's forecast (defaults to today)
    const nowA = el("a", "ov-cur");
    nowA.href = `#${a.spotId}`;
    const head = el("div", "ov-cur-head");
    head.append(el("span", "ov-name-txt", spotName(a.spotId)));
    head.append(el("span", "ov-drive", DRIVE[a.spotId]?.label || ""));
    nowA.append(head);
    nowA.append(el("span", "ov-zone-label", "Now"));
    const curLine = el("div", "ov-cur-line");
    curLine.append(nowCell(a));
    curLine.append(scoreBadge(a.now.score));
    nowA.append(curLine);
    row.append(nowA);

    // OUTLOOK zone → the best day itself
    const outA = el("a", "ov-out");
    outA.href = dayHref(a.spotId, a.best.date);
    outA.append(el("span", "ov-zone-label", "This week's best"));
    const outLine = el("div", "ov-out-line");
    outLine.append(el("span", "ov-out-day", `${a.best.label}${a.best.peakHr ? " " + fmtTime(a.best.peakHr.min) : ""}`));
    outLine.append(scoreBadge(a.best.peak));
    outA.append(outLine);
    outA.append(el("div", `ov-verdict ov-verdict-${dv.kind}`, dv.text));
    row.append(outA);

    board.append(row);
  }
  container.append(board);

  // --- 7-day heatmap: each day split into a morning + afternoon pill ---
  const heat = el("div", "ov-heat");
  heat.append(el("h3", "ov-h", "Next 7 days"));
  heat.append(el("div", "ov-subhead", "Each day split into morning · afternoon — the two windows often differ."));
  const grid = el("div", "ov-grid");
  grid.append(el("div", "ov-grid-corner", ""));
  for (const d of home.days) grid.append(el("div", "ov-grid-daylabel", d.label));
  for (const a of ordered) {
    grid.append(el("div", "ov-grid-spot", spotName(a.spotId)));
    for (const d of a.days) {
      const cell = el("div", "ov-cell2");
      for (const [key, label, w] of [["am", "morning", d.am], ["pm", "afternoon", d.pm]]) {
        const half = el("a", `ov-half ${scoreClass(w.peak)}`, String(w.peak));
        half.href = dayHref(a.spotId, d.date);
        half.title = `${spotName(a.spotId)} · ${d.label} ${label}: ${verdict(w.peak)} (${w.peak})${w.hr ? " ~" + fmtTime(w.hr.min) : ""}`;
        cell.append(half);
      }
      grid.append(cell);
    }
  }
  heat.append(grid);
  container.append(heat);

  // --- weekend game plan: the single best spot to be at each weekend day ---
  const weekend = [6, 0]; // Sat, Sun
  const weekendDays = home.days.filter((d) => weekend.includes(d.weekday)).slice(0, 2);
  if (weekendDays.length) {
    const wk = el("div", "ov-weekend");
    wk.append(el("h3", "ov-h", "Weekend game plan"));
    wk.append(el("div", "ov-subhead", "The highest-scoring spot to be at each weekend day, across every spot — drive included on the card."));
    const row = el("div", "ov-weekend-row");
    for (const wd of weekendDays) {
      const best = analyses.map((a) => ({ id: a.spotId, d: a.days.find((x) => x.i === wd.i) }))
        .filter((x) => x.d).reduce((x, y) => (y.d.peak > x.d.peak ? y : x));
      const card = el("a", "ov-weekend-card");
      card.href = dayHref(best.id, best.d.date);
      card.append(el("div", "ov-weekend-day", new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(`${wd.date}T12:00:00Z`))));
      card.append(scoreBadge(best.d.peak, true));
      card.append(el("div", "ov-weekend-spot", `${spotName(best.id)}${best.id === HOME ? "" : " · " + DRIVE[best.id].label}`));
      card.append(el("div", "ov-weekend-when", best.d.peakHr ? `best ~${fmtTime(best.d.peakHr.min)}` : ""));
      row.append(card);
    }
    wk.append(row);
    container.append(wk);
  }

  container.append(el("div", "ov-foot", "Score = size × period × swell angle × wind, at the day's peak daylight hour. Tap any spot or day to open its full forecast."));
}

async function loadSummary() {
  try {
    const res = await fetch("reports/dashboard.json", { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function renderDashboard(root) {
  root.replaceChildren(el("div", "ov-loading", "Reading the whole coast…"));
  try {
    const [models, ai] = await Promise.all([
      Promise.all(SPOTS.map((s) => getSpotData(s))),
      loadSummary(),
    ]);
    render(root, models.map(analyze), models, ai);
  } catch (e) {
    root.replaceChildren(el("div", "ov-loading", `Couldn't load: ${e.message}`));
  }
}
