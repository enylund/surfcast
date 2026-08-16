// Overview homepage PROTOTYPE — at-a-glance scoreboard + 7-day heatmap + an
// opinionated "worth the drive" verdict, across all spots. Standalone page
// (overview.html); does not touch the live app. Reuses the existing data layer.

import { SPOTS, DATA_SOURCE } from "./config.js";
import { getSpotData, nyToday, nyNow } from "./data.js";

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

function hourScore(h) {
  if (h == null || h.swellHt == null) return 0;
  return Math.round(100 * sizeFactor(h.swellHt) * periodFactor(h.swellPer)
    * (SWELL_MULT[h.swellClass] ?? 0.6) * (WIND_MULT[h.windClass] ?? 0.6));
}

const scoreClass = (s) => (s >= 72 ? "sc-fire" : s >= 55 ? "sc-good" : s >= 38 ? "sc-fun" : s >= 22 ? "sc-marg" : "sc-flat");
const verdict = (s) => (s >= 72 ? "Fire" : s >= 55 ? "Good" : s >= 38 ? "Fun" : s >= 22 ? "Marginal" : "Flat");
const fmtTime = (min) => { let h = Math.floor(min / 60); const ap = h < 12 ? "a" : "p"; h = h % 12 || 12; return `${h}${ap}`; };
const dayLabel = (date, i) => (i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`)));

// Peak daylight score per day + the current-hour score.
function analyze(model) {
  const now = nyNow();
  const days = model.days.map((d, i) => {
    const rise = d.sunrise ?? 5 * 60, set = d.sunset ?? 21 * 60;
    let peak = 0, peakHr = null;
    for (const h of d.hours) {
      if (h.min < rise || h.min > set) continue;
      const sc = hourScore(h);
      if (sc > peak) { peak = sc; peakHr = h; }
    }
    return { i, date: d.date, label: dayLabel(d.date, i), peak, peakHr,
      weekday: new Date(`${d.date}T12:00:00Z`).getUTCDay() };
  });
  const today = model.days.find((d) => d.date === now.date);
  const nowHr = today?.hours[Math.min(23, Math.floor(now.min / 60))];
  const best = days.reduce((a, b) => (b.peak > a.peak ? b : a), days[0]);
  return { spotId: model.spotId, days, now: { score: hourScore(nowHr), hr: nowHr }, best };
}

// Opinionated drive call: a spot must clear a "worth going" bar AND beat home by
// a margin that scales with drive time.
function driveVerdict(a, homeA) {
  if (a.spotId === HOME) return { kind: "home", text: "your home break" };
  const drive = DRIVE[a.spotId]?.min ?? 120;
  const margin = Math.round(drive / 7); // 45m→6, 1.5h→13, 2.5h→21, 3h→26
  const homeThatDay = homeA.days[a.best.i]?.peak ?? 0;
  const beatsHome = a.best.peak - homeThatDay;
  if (a.best.peak >= 55 && beatsHome >= margin) {
    return { kind: "go", text: `Worth the drive — ${a.best.label} ${fmtTime(a.best.peakHr.min)} (${a.best.peak})` };
  }
  if (a.best.peak >= 55 && beatsHome >= margin - 8) {
    return { kind: "maybe", text: `Maybe — ${a.best.label}, but barely beats home` };
  }
  return { kind: "no", text: "Stay local — not worth the drive" };
}

// ---------------------------------------------------------------------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function nowCell(a, spot) {
  const wrap = el("div", "ov-now");
  const hr = a.now.hr;
  if (!hr || hr.swellHt == null) { wrap.append(el("span", "ov-dim", "—")); return wrap; }
  wrap.append(el("span", "ov-now-swell", `${hr.swellHt}ft ${hr.swellPer ? "@" + Math.round(hr.swellPer) + "s" : ""} ${hr.swellDir_compass || ""}`.trim()));
  const w = el("span", `ov-now-wind wc-${hr.windClass || "cross"}`, `${Math.round(hr.windSpd)}mph ${hr.windClass || ""}`);
  wrap.append(w);
  return wrap;
}

function scoreBadge(score, big) {
  const b = el("div", `ov-score ${scoreClass(score)}${big ? " ov-score-lg" : ""}`);
  b.append(el("span", "ov-score-num", String(score)));
  if (big) b.append(el("span", "ov-score-verdict", verdict(score)));
  return b;
}

function render(container, analyses, models) {
  container.replaceChildren();
  const home = analyses.find((a) => a.spotId === HOME);
  const spotName = (id) => SPOTS.find((s) => s.id === id).name;

  // --- top-line best call across everything ---
  const bestOverall = analyses.map((a) => ({ a, ...a.best })).reduce((x, y) => (y.peak > x.peak ? y : x));
  const banner = el("div", `ov-banner ${scoreClass(bestOverall.peak)}`);
  const bId = bestOverall.a.spotId;
  const driveTxt = bId === HOME ? "" : ` · ${DRIVE[bId].label} drive`;
  banner.append(el("div", "ov-banner-label", "This week's best"));
  banner.append(el("div", "ov-banner-main", `${spotName(bId)} — ${bestOverall.label} ${fmtTime(bestOverall.peakHr.min)} · ${verdict(bestOverall.peak)} (${bestOverall.peak})${driveTxt}`));
  container.append(banner);

  // --- weekend spotlight ---
  const weekend = [6, 0]; // Sat, Sun
  const weekendDays = home.days.filter((d) => weekend.includes(d.weekday)).slice(0, 2);
  if (weekendDays.length) {
    const wk = el("div", "ov-weekend");
    wk.append(el("h3", "ov-h", "Weekend"));
    const row = el("div", "ov-weekend-row");
    for (const wd of weekendDays) {
      const best = analyses.map((a) => ({ id: a.spotId, d: a.days.find((x) => x.i === wd.i) }))
        .filter((x) => x.d).reduce((x, y) => (y.d.peak > x.d.peak ? y : x));
      const card = el("div", "ov-weekend-card");
      card.append(el("div", "ov-weekend-day", new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(`${wd.date}T12:00:00Z`))));
      card.append(scoreBadge(best.d.peak, true));
      card.append(el("div", "ov-weekend-spot", `${spotName(best.id)}${best.id === HOME ? "" : " · " + DRIVE[best.id].label}`));
      card.append(el("div", "ov-weekend-when", best.d.peakHr ? `best ~${fmtTime(best.d.peakHr.min)}` : ""));
      row.append(card);
    }
    wk.append(row);
    container.append(wk);
  }

  // --- scoreboard (home pinned, then by week-best) ---
  const board = el("div", "ov-board");
  board.append(el("h3", "ov-h", "Spots"));
  const ordered = [home, ...analyses.filter((a) => a.spotId !== HOME).sort((x, y) => y.best.peak - x.best.peak)];
  for (const a of ordered) {
    const dv = driveVerdict(a, home);
    const rowLink = el("a", `ov-row ${a.spotId === HOME ? "ov-home" : ""}`);
    rowLink.href = `index.html#${a.spotId}`;
    const nameCol = el("div", "ov-name");
    nameCol.append(el("span", "ov-name-txt", spotName(a.spotId)));
    nameCol.append(el("span", "ov-drive", DRIVE[a.spotId]?.label || ""));
    rowLink.append(nameCol);
    rowLink.append(nowCell(a, a.spotId));
    rowLink.append(scoreBadge(a.now.score));
    const wk = el("div", "ov-weekbest");
    wk.append(el("span", "ov-weekbest-label", "wk best"));
    wk.append(el("span", "ov-weekbest-val", `${a.best.label} ${a.best.peak}`));
    rowLink.append(wk);
    rowLink.append(el("div", `ov-verdict ov-verdict-${dv.kind}`, dv.text));
    board.append(rowLink);
  }
  container.append(board);

  // --- 7-day heatmap ---
  const heat = el("div", "ov-heat");
  heat.append(el("h3", "ov-h", "Next 7 days"));
  const grid = el("div", "ov-grid");
  grid.append(el("div", "ov-grid-corner", ""));
  for (const d of home.days) grid.append(el("div", "ov-grid-daylabel", d.label));
  for (const a of ordered) {
    grid.append(el("div", "ov-grid-spot", spotName(a.spotId)));
    for (const d of a.days) {
      const cell = el("div", `ov-cell ${scoreClass(d.peak)}`, String(d.peak));
      cell.title = `${spotName(a.spotId)} · ${d.label}: ${verdict(d.peak)} (${d.peak})${d.peakHr ? " ~" + fmtTime(d.peakHr.min) : ""}`;
      grid.append(cell);
    }
  }
  heat.append(grid);
  container.append(heat);

  container.append(el("div", "ov-foot", "Prototype · score = size × period × swell angle × wind. Tap a spot for the full forecast."));
}

async function main() {
  const root = document.getElementById("overview");
  root.append(el("div", "ov-loading", "Reading the whole coast…"));
  try {
    const models = await Promise.all(SPOTS.map((s) => getSpotData(s)));
    const analyses = models.map(analyze);
    render(root, analyses, models);
  } catch (e) {
    root.replaceChildren(el("div", "ov-loading", `Couldn't load: ${e.message}`));
  }
}
main();
