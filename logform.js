// In-app "Log a session" / "Edit session" form. Captures the conditions
// fingerprint in the browser, then saves via store.js (GitHub commit, gated by
// the password-unlocked token). Edit mode prefills from an existing session.

import { SPOTS } from "./config.js";
import { nyToday } from "./data.js";
import { buildRecord } from "./conditions.js";
import { renderAuth, isUnlocked, saveSession, takeEditSession } from "./store.js";

const WETSUITS = ["none", "top", "2mm spring", "2/2 full", "3/2 full", "4/3 full", "5/4 full", "6/5 full"];
const BOARDS = [["longboard", "Longboard"], ["midlength", "Mid-length"], ["fish", "Fish"], ["short", "Shortboard"]];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ratingField(name, label, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const row = el("div", "lf-rating");
  const input = document.createElement("input");
  input.type = "range"; input.min = "0"; input.max = "5"; input.step = "0.5"; input.value = String(def);
  const out = el("span", "lf-rating-out");
  const paint = () => {
    const v = Number(input.value);
    out.textContent = `${"★".repeat(Math.floor(v))}${v % 1 ? "½" : ""}${"☆".repeat(5 - Math.ceil(v))}  ${v}`;
  };
  input.addEventListener("input", paint); paint();
  row.append(input, out); wrap.append(row);
  wrap.get = () => Number(input.value);
  wrap.set = (v) => { input.value = String(v); paint(); };
  return wrap;
}

function selectField(label, options, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const sel = document.createElement("select");
  for (const o of options) {
    const [val, txt] = Array.isArray(o) ? o : [o, o];
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = txt;
    if (val === def) opt.selected = true;
    sel.append(opt);
  }
  wrap.append(sel);
  wrap.get = () => sel.value;
  wrap.set = (v) => { sel.value = v; };
  return wrap;
}

function checkField(label) {
  const lab = el("label", "lf-check");
  const box = document.createElement("input");
  box.type = "checkbox";
  lab.append(box, document.createTextNode(" " + label));
  lab.get = () => box.checked;
  lab.set = (v) => { box.checked = !!v; };
  return lab;
}

function inputField(label, type, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const inp = document.createElement("input");
  inp.type = type; if (def != null) inp.value = def;
  if (type === "date") inp.max = nyToday();
  wrap.append(inp);
  wrap.get = () => inp.value;
  wrap.set = (v) => { inp.value = v; };
  return wrap;
}

export function renderLogForm(container) {
  const edit = takeEditSession(); // an existing session record, or null
  container.replaceChildren();
  container.append(el("h2", "sess-view-title", edit ? "Edit session" : "Log a session"));

  const authWrap = el("div");
  container.append(authWrap);

  const form = el("form", "lf-form");
  const fields = {
    spot: selectField("Spot", SPOTS.map((s) => [s.id, s.name]), SPOTS[0].id),
    date: inputField("Day", "date", nyToday()),
    start: inputField("Start", "time", "07:00"),
    end: inputField("End", "time", "09:00"),
    overall: ratingField("overall", "Overall fun", 3),
    swellSize: ratingField("swellSize", "Swell size / period", 3),
    swellDirection: ratingField("swellDirection", "Swell direction (peel)", 3),
    wind: ratingField("wind", "Wind", 3),
    crowd: ratingField("crowd", "Emptiness (5 = empty)", 3),
    board: selectField("Board", BOARDS, "longboard"),
    wetsuit: selectField("Wetsuit", WETSUITS, "3/2 full"),
  };
  for (const f of Object.values(fields)) form.append(f);

  const addonRow = el("div", "lf-checks");
  const booties = checkField("Booties"), gloves = checkField("Gloves"), hood = checkField("Hood");
  addonRow.append(booties, gloves, hood);
  const addons = el("div", "lf-field");
  addons.append(el("label", "lf-label", "Add-ons"), addonRow);
  form.append(addons);

  const comfortRow = el("div", "lf-checks");
  const cold = checkField("Too cold"), warm = checkField("Too warm");
  comfortRow.append(cold, warm);
  const comfort = el("div", "lf-field");
  comfort.append(el("label", "lf-label", "Comfort"), comfortRow);
  form.append(comfort);

  const comments = document.createElement("textarea");
  comments.rows = 3; comments.className = "lf-textarea";
  const commentsWrap = el("div", "lf-field");
  commentsWrap.append(el("label", "lf-label", "Comments (repo is public)"), comments);
  form.append(commentsWrap);

  // prefill in edit mode
  let editingId = null;
  if (edit) {
    editingId = edit.id;
    fields.spot.set(edit.spotId);
    fields.date.set(edit.date);
    fields.start.set(edit.timeRange?.start || "07:00");
    fields.end.set(edit.timeRange?.end || "09:00");
    const r = edit.ratings || {};
    for (const k of ["overall", "swellSize", "swellDirection", "wind", "crowd"]) if (r[k] != null) fields[k].set(r[k]);
    const g = edit.gear || {};
    if (g.board) fields.board.set(g.board);
    if (g.wetsuit) fields.wetsuit.set(g.wetsuit);
    booties.set(g.booties); gloves.set(g.gloves); hood.set(g.hood);
    cold.set(edit.comfort?.tooCold); warm.set(edit.comfort?.tooWarm);
    comments.value = edit.comments || "";
  }

  const submit = el("button", "lf-btn lf-submit", edit ? "Update session" : "Save session");
  submit.type = "submit";
  const status = el("div", "lf-status");
  form.append(submit, status);
  container.append(form);

  const syncEnabled = () => { submit.disabled = !isUnlocked(); };
  renderAuth(authWrap, syncEnabled);
  syncEnabled();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isUnlocked()) { status.className = "lf-status err"; status.textContent = "Unlock saving first."; return; }
    if (fields.end.get() <= fields.start.get()) { status.className = "lf-status err"; status.textContent = "End time must be after start."; return; }

    submit.disabled = true;
    status.className = "lf-status"; status.textContent = "Fetching the conditions for that window…";
    try {
      const input = {
        date: fields.date.get(), spotId: fields.spot.get(),
        start: fields.start.get(), end: fields.end.get(),
        ratings: {
          overall: fields.overall.get(), swellSize: fields.swellSize.get(),
          swellDirection: fields.swellDirection.get(), wind: fields.wind.get(), crowd: fields.crowd.get(),
        },
        gear: { board: fields.board.get(), wetsuit: fields.wetsuit.get(), booties: booties.get(), gloves: gloves.get(), hood: hood.get() },
        comfort: { tooCold: cold.get(), tooWarm: warm.get() },
        comments: comments.value.trim(),
      };
      const record = await buildRecord(input, SPOTS);
      status.textContent = edit ? "Updating…" : "Saving to your log…";
      // if an edit changed the date/spot/start, the id changes → drop the old one
      await saveSession(record, editingId && editingId !== record.id ? editingId : null);
      status.className = "lf-status ok";
      status.textContent = edit
        ? "Updated. Returning to your log…"
        : "Saved. It'll appear in your Session log within ~1 minute (after the site rebuilds).";
      if (edit) { setTimeout(() => { location.hash = "sessions"; }, 900); }
      else {
        form.reset();
        for (const f of Object.values(fields)) f.querySelector?.("input[type=range]")?.dispatchEvent(new Event("input"));
      }
    } catch (err) {
      status.className = "lf-status err";
      status.textContent = `Couldn't save: ${err.message}`;
    } finally {
      submit.disabled = !isUnlocked();
    }
  });
}
