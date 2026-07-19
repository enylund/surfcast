// Pure SVG chart renderers. Each takes a day's data + shared scale context and
// returns an <svg> element. All three charts share the same x-scale so hour
// columns line up vertically within a day card.

import { LAYOUT, DAYLIGHT_FALLBACK } from "./config.js";
import { compass } from "./data.js";

const NS = "http://www.w3.org/2000/svg";
const { gutter, plotW } = LAYOUT;
const W = gutter + plotW + 4;

function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

const x = (min) => gutter + (min / 1440) * plotW;

function fmtTime(min) {
  let h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, "0");
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
}

// Arrowhead drawn pointing north (up). Directions from the APIs are "coming
// from"; surf-app convention is to point the arrow where the flow is going TO,
// hence the +180 rotation. Text labels elsewhere still name the FROM direction.
function arrow(cx, cy, fromDeg, { size = 6, cls = "" } = {}) {
  const s = size;
  return svgEl("path", {
    d: `M0,${-s} L${s * 0.7},${s * 0.7} L0,${s * 0.25} L${-s * 0.7},${s * 0.7} Z`,
    class: cls,
    transform: `translate(${cx},${cy}) rotate(${(fromDeg + 180) % 360})`,
  });
}

// Dim the hours outside sunrise..sunset.
function nightRects(day, plotTop, plotH) {
  const rise = day.sunrise ?? DAYLIGHT_FALLBACK[0] * 60;
  const set = day.sunset ?? DAYLIGHT_FALLBACK[1] * 60;
  const rect = (x0, x1) =>
    svgEl("rect", { x: x0, y: plotTop, width: Math.max(0, x1 - x0), height: plotH, class: "night", "pointer-events": "none" });
  return [rect(x(0), x(rise)), rect(x(set), x(1440))];
}

function hourGrid(plotTop, plotBottom, withLabels = false) {
  const g = svgEl("g", { class: "grid" });
  for (const h of [6, 12, 18]) {
    const gx = x(h * 60);
    g.append(svgEl("line", { x1: gx, y1: plotTop, x2: gx, y2: plotBottom }));
    if (withLabels) {
      const label = h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`;
      g.append(svgEl("text", { x: gx, y: plotBottom + 14, "text-anchor": "middle", class: "axis-label" }, label));
    }
  }
  return g;
}

function nowLine(nowMin, plotTop, plotBottom) {
  return svgEl("line", { x1: x(nowMin), y1: plotTop, x2: x(nowMin), y2: plotBottom, class: "now-line" });
}

// ---------------------------------------------------------------------------
// Swell chart: hourly bars + direction arrows + period labels
// ---------------------------------------------------------------------------

export function renderSwellChart(day, { yMax, nowMin }) {
  const H = LAYOUT.swellH;
  const plotTop = 34, plotBottom = H - 8;
  const plotH = plotBottom - plotTop;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart swell-chart" });
  const y = (ft) => plotBottom - (ft / yMax) * plotH;

  // gridlines
  const step = yMax > 8 ? 2 : 1;
  for (let ft = step; ft <= yMax; ft += step) {
    svg.append(svgEl("line", { x1: gutter, y1: y(ft), x2: gutter + plotW, y2: y(ft), class: "grid-h" }));
    svg.append(svgEl("text", { x: gutter - 6, y: y(ft) + 3, "text-anchor": "end", class: "axis-label" }, `${ft}ft`));
  }
  svg.append(hourGrid(plotTop, plotBottom));

  for (const [i, hr] of day.hours.entries()) {
    if (hr.swellHt == null) continue;
    const bx = x(hr.min) + 2;
    const bw = plotW / 24 - 4;
    const by = y(hr.swellHt);
    const sizeCls = hr.swellHt < 2 ? "bar-small" : hr.swellHt < 4 ? "bar-fun" : "bar-solid";
    const bar = svgEl("rect", {
      x: bx, y: by, width: bw, height: Math.max(1, plotBottom - by), rx: 2, class: `bar ${sizeCls}`,
    });
    bar.append(svgEl("title", {},
      `${fmtTime(hr.min)} — swell ${hr.swellHt} ft @ ${hr.swellPer}s from ${compass(hr.swellDir)} (${Math.round(hr.swellDir)}°)` +
      (hr.swellClass ? ` — ${hr.swellClass} direction for this spot` : "") +
      (hr.waveHt != null ? `\ntotal wave ${hr.waveHt} ft` : "")));
    svg.append(bar);

    const cx = x(hr.min) + plotW / 48;
    if (i % 2 === 0 && hr.swellDir != null)
      svg.append(arrow(cx, 10, hr.swellDir, { size: 5, cls: `swell-arrow sw-${hr.swellClass || "fair"}` }));
    if (i % 3 === 0 && hr.swellPer != null)
      svg.append(svgEl("text", { x: cx, y: 27, "text-anchor": "middle", class: "period-label" }, `${Math.round(hr.swellPer)}s`));
  }

  svg.append(...nightRects(day, plotTop, plotH));
  if (nowMin != null) svg.append(nowLine(nowMin, plotTop, plotBottom));
  return svg;
}

// ---------------------------------------------------------------------------
// Wind row: arrow per hour colored by class, mph beneath
// ---------------------------------------------------------------------------

export function renderWindRow(day, { nowMin }) {
  const H = LAYOUT.windH;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart wind-chart" });
  svg.append(svgEl("text", { x: gutter - 6, y: 28, "text-anchor": "end", class: "axis-label" }, "wind"));
  svg.append(hourGrid(4, H - 18));

  for (const hr of day.hours) {
    if (hr.windSpd == null || hr.windDir == null) continue;
    const cx = x(hr.min) + plotW / 48;
    const g = svgEl("g", {});
    const a = arrow(cx, 22, hr.windDir, { size: 7, cls: `wind-arrow wc-${hr.windClass}` });
    g.append(a);
    g.append(svgEl("text", { x: cx, y: 44, "text-anchor": "middle", class: "wind-speed" }, String(Math.round(hr.windSpd))));
    g.append(svgEl("title", {},
      `${fmtTime(hr.min)} — ${hr.windSpd} mph from ${compass(hr.windDir)} (${Math.round(hr.windDir)}°), gusts ${hr.windGust} mph — ${hr.windClass}`));
    svg.append(g);
  }

  svg.append(...nightRects(day, 4, H - 22));
  if (nowMin != null) svg.append(nowLine(nowMin, 4, H - 18));
  return svg;
}

// ---------------------------------------------------------------------------
// Tide chart: smoothed curve + H/L markers + hour axis labels
// ---------------------------------------------------------------------------

export function renderTideChart(day, dayIndex, tide, { tideMin, tideMax, nowMin, clipId }) {
  const H = LAYOUT.tideH;
  const plotTop = 20, plotBottom = H - 24;
  const plotH = plotBottom - plotTop;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart tide-chart" });
  const y = (ft) => plotBottom - ((ft - tideMin) / (tideMax - tideMin)) * plotH;

  svg.append(svgEl("text", { x: gutter - 6, y: (plotTop + plotBottom) / 2 + 3, "text-anchor": "end", class: "axis-label" }, "tide"));
  svg.append(hourGrid(plotTop, plotBottom, true));

  // Include neighbor-day edge points so the curve enters/exits the card cleanly.
  const pts = tide.curve
    .filter((p) => Math.abs(p.dayIndex - dayIndex) <= 1)
    .map((p) => ({ x: x(p.min + (p.dayIndex - dayIndex) * 1440), y: y(p.ft) }))
    .filter((p) => p.x >= gutter - plotW / 12 && p.x <= gutter + plotW + plotW / 12);

  if (pts.length >= 2) {
    // Quadratic Béziers through segment midpoints = cheap smoothing.
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x},${pts[i].y} ${mx},${my}`;
    }
    d += ` L ${pts.at(-1).x},${pts.at(-1).y}`;

    const clip = svgEl("clipPath", { id: clipId },
      svgEl("rect", { x: gutter, y: 0, width: plotW, height: H }));
    svg.append(svgEl("defs", {}, clip));
    const g = svgEl("g", { "clip-path": `url(#${clipId})` });
    g.append(svgEl("path", { d: `${d} L ${pts.at(-1).x},${plotBottom} L ${pts[0].x},${plotBottom} Z`, class: "tide-fill" }));
    g.append(svgEl("path", { d, class: "tide-line" }));
    svg.append(g);
  }

  for (const ev of tide.hilo.filter((p) => p.dayIndex === dayIndex)) {
    const ex = x(ev.min), ey = y(ev.ft);
    svg.append(svgEl("circle", { cx: ex, cy: ey, r: 3, class: "tide-dot" }));
    const above = ev.type === "H";
    const ty = above ? Math.max(10, ey - 8) : Math.min(H - 26, ey + 14);
    svg.append(svgEl("text", { x: ex, y: ty, "text-anchor": "middle", class: "tide-label" },
      `${ev.ft}ft ${fmtTime(ev.min)}`));
  }

  svg.append(...nightRects(day, plotTop, plotH));
  if (nowMin != null) {
    svg.append(nowLine(nowMin, plotTop, plotBottom));
  }
  return svg;
}
