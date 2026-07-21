// In-app "Log a session" form. Runs the shared fingerprint capture in the
// browser, then saves via saveSession(). Gated by a GitHub token that's stored
// encrypted behind a password (Web Crypto). To move to a Vercel backend later,
// only saveSession() needs to change — swap the GitHub commit for a fetch() to
// your API route.

import { SPOTS, REPO, SESSIONS_PATH } from "./config.js";
import { nyToday } from "./data.js";
import { buildRecord } from "./conditions.js";

// ---------------------------------------------------------------------------
// Token storage: encrypt the GitHub token with a password (AES-GCM/PBKDF2)
// ---------------------------------------------------------------------------
const AUTH_KEY = "surfcast:auth:v1";
let unlockedToken = null; // held in memory for this tab only

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function storeToken(token, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  localStorage.setItem(AUTH_KEY, JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
  unlockedToken = token;
}

async function unlockToken(password) {
  const blob = JSON.parse(localStorage.getItem(AUTH_KEY));
  const key = await deriveKey(password, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
  unlockedToken = new TextDecoder().decode(pt); // throws on wrong password
  return unlockedToken;
}

const hasToken = () => !!localStorage.getItem(AUTH_KEY);
const forgetToken = () => { localStorage.removeItem(AUTH_KEY); unlockedToken = null; };

// ---------------------------------------------------------------------------
// Save adapter — commit the updated sessions.json to the repo via GitHub API.
// (Swap this single function for a fetch() to your Vercel route later.)
// ---------------------------------------------------------------------------
const utf8ToB64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; bytes.forEach((x) => (bin += String.fromCharCode(x))); return btoa(bin); };
const b64ToUtf8 = (str) => new TextDecoder().decode(unb64(str.replace(/\n/g, "")));
const GH = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

async function saveSession(record, token) {
  const url = `https://api.github.com/repos/${REPO}/contents/${SESSIONS_PATH}`;
  const getRes = await fetch(url, { headers: GH(token) });
  let sessions = [], sha = null;
  if (getRes.ok) {
    const data = await getRes.json();
    sessions = JSON.parse(b64ToUtf8(data.content));
    sha = data.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`Couldn't read sessions (${getRes.status}) — check the token has access to ${REPO}.`);
  }

  const next = sessions.filter((s) => s.id !== record.id);
  next.push(record);
  next.sort((a, b) => (b.date + b.timeRange.start).localeCompare(a.date + a.timeRange.start));

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...GH(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Log session: ${record.spotName} ${record.date} ${record.timeRange.label}`,
      content: utf8ToB64(JSON.stringify(next, null, 2) + "\n"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(err.message || `Save failed (${putRes.status}).`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const WETSUITS = ["none", "top", "2mm spring", "2/2 full", "3/2 full", "4/3 full", "5/4 full", "6/5 full"];
const BOARDS = [["longboard", "Longboard"], ["midlength", "Mid-length"], ["fish", "Fish"], ["short", "Shortboard"]];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// star-preview slider (0–5, half steps)
function ratingField(name, label, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const row = el("div", "lf-rating");
  const input = document.createElement("input");
  input.type = "range"; input.min = "0"; input.max = "5"; input.step = "0.5"; input.value = String(def);
  input.name = name;
  const out = el("span", "lf-rating-out");
  const paint = () => {
    const v = Number(input.value);
    out.textContent = `${"★".repeat(Math.floor(v))}${v % 1 ? "½" : ""}${"☆".repeat(5 - Math.ceil(v))}  ${v}`;
  };
  input.addEventListener("input", paint);
  paint();
  row.append(input, out);
  wrap.append(row);
  wrap.get = () => Number(input.value);
  return wrap;
}

function selectField(name, label, options, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const sel = document.createElement("select");
  sel.name = name;
  for (const o of options) {
    const [val, txt] = Array.isArray(o) ? o : [o, o];
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = txt;
    if (val === def) opt.selected = true;
    sel.append(opt);
  }
  wrap.append(sel);
  wrap.get = () => sel.value;
  return wrap;
}

function checkField(name, label) {
  const lab = el("label", "lf-check");
  const box = document.createElement("input");
  box.type = "checkbox"; box.name = name;
  lab.append(box, document.createTextNode(" " + label));
  lab.get = () => box.checked;
  return lab;
}

function inputField(name, label, type, def) {
  const wrap = el("div", "lf-field");
  wrap.append(el("label", "lf-label", label));
  const inp = document.createElement("input");
  inp.type = type; inp.name = name; if (def != null) inp.value = def;
  if (type === "date") inp.max = nyToday();
  wrap.append(inp);
  wrap.get = () => inp.value;
  return wrap;
}

// ---- auth panel (setup / unlock / ready) ----
function renderAuth(container, onReady) {
  container.replaceChildren();
  const box = el("div", "lf-auth");

  if (unlockedToken) {
    box.append(el("span", "lf-auth-ok", "🔓 Ready to save"));
    const forget = el("button", "lf-link", "forget token");
    forget.type = "button";
    forget.addEventListener("click", () => { forgetToken(); renderAuth(container, onReady); onReady(); });
    box.append(forget);
    container.append(box);
    return;
  }

  if (hasToken()) {
    box.append(el("div", "lf-auth-title", "🔒 Enter your password to enable saving"));
    const pw = document.createElement("input");
    pw.type = "password"; pw.placeholder = "password"; pw.className = "lf-auth-input";
    const btn = el("button", "lf-btn", "Unlock"); btn.type = "button";
    const err = el("div", "lf-err");
    const tryUnlock = async () => {
      err.textContent = "";
      try { await unlockToken(pw.value); renderAuth(container, onReady); onReady(); }
      catch { err.textContent = "Wrong password."; }
    };
    btn.addEventListener("click", tryUnlock);
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    const reset = el("button", "lf-link", "reset (re-enter token)");
    reset.type = "button";
    reset.addEventListener("click", () => { forgetToken(); renderAuth(container, onReady); });
    box.append(pw, btn, reset, err);
    container.append(box);
    return;
  }

  // first-time setup
  box.append(el("div", "lf-auth-title", "One-time setup: paste a GitHub token and choose a password"));
  const help = el("div", "lf-auth-help");
  help.innerHTML = `Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with access to only <b>${REPO}</b> and <b>Contents: Read and write</b>. It's stored encrypted in this browser behind your password.`;
  const tok = document.createElement("input");
  tok.type = "password"; tok.placeholder = "github_pat_…"; tok.className = "lf-auth-input";
  const pw = document.createElement("input");
  pw.type = "password"; pw.placeholder = "choose a password"; pw.className = "lf-auth-input";
  const pw2 = document.createElement("input");
  pw2.type = "password"; pw2.placeholder = "confirm password"; pw2.className = "lf-auth-input";
  const btn = el("button", "lf-btn", "Save setup"); btn.type = "button";
  const err = el("div", "lf-err");
  btn.addEventListener("click", async () => {
    err.textContent = "";
    if (!tok.value.trim()) return (err.textContent = "Paste your GitHub token.");
    if (pw.value.length < 4) return (err.textContent = "Password must be at least 4 characters.");
    if (pw.value !== pw2.value) return (err.textContent = "Passwords don't match.");
    await storeToken(tok.value.trim(), pw.value);
    renderAuth(container, onReady); onReady();
  });
  box.append(help, tok, pw, pw2, btn, err);
  container.append(box);
}

export function renderLogForm(container) {
  container.replaceChildren();
  container.append(el("h2", "sess-view-title", "Log a session"));

  const authWrap = el("div");
  container.append(authWrap);

  const form = el("form", "lf-form");
  const fields = {
    spot: selectField("spot", "Spot", SPOTS.map((s) => [s.id, s.name]), SPOTS[0].id),
    date: inputField("date", "Day", "date", nyToday()),
    start: inputField("start", "Start", "time", "07:00"),
    end: inputField("end", "End", "time", "09:00"),
    overall: ratingField("overall", "Overall fun", 3),
    swellSize: ratingField("swellSize", "Swell size / period", 3),
    swellDirection: ratingField("swellDirection", "Swell direction (peel)", 3),
    wind: ratingField("wind", "Wind", 3),
    crowd: ratingField("crowd", "Emptiness (5 = empty)", 3),
    board: selectField("board", "Board", BOARDS, "longboard"),
    wetsuit: selectField("wetsuit", "Wetsuit", WETSUITS, "3/2 full"),
  };
  for (const f of Object.values(fields)) form.append(f);

  const addons = el("div", "lf-field");
  addons.append(el("label", "lf-label", "Add-ons"));
  const addonRow = el("div", "lf-checks");
  const booties = checkField("booties", "Booties");
  const gloves = checkField("gloves", "Gloves");
  const hood = checkField("hood", "Hood");
  addonRow.append(booties, gloves, hood);
  addons.append(addonRow);
  form.append(addons);

  const comfort = el("div", "lf-field");
  comfort.append(el("label", "lf-label", "Comfort"));
  const comfortRow = el("div", "lf-checks");
  const cold = checkField("tooCold", "Too cold");
  const warm = checkField("tooWarm", "Too warm");
  comfortRow.append(cold, warm);
  comfort.append(comfortRow);
  form.append(comfort);

  const commentsWrap = el("div", "lf-field");
  commentsWrap.append(el("label", "lf-label", "Comments (repo is public)"));
  const comments = document.createElement("textarea");
  comments.rows = 3; comments.className = "lf-textarea";
  commentsWrap.append(comments);
  form.append(commentsWrap);

  const submit = el("button", "lf-btn lf-submit", "Save session");
  submit.type = "submit";
  const status = el("div", "lf-status");
  form.append(submit, status);
  container.append(form);

  const syncEnabled = () => { submit.disabled = !unlockedToken; };
  renderAuth(authWrap, syncEnabled);
  syncEnabled();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!unlockedToken) { status.className = "lf-status err"; status.textContent = "Unlock saving first."; return; }
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
      status.textContent = "Saving to your log…";
      await saveSession(record, unlockedToken);
      status.className = "lf-status ok";
      status.textContent = "Saved. It'll appear in your Session log within ~1 minute (after the site rebuilds).";
      form.reset();
      for (const f of Object.values(fields)) if (f.querySelector) f.querySelector("input[type=range]")?.dispatchEvent(new Event("input"));
    } catch (err) {
      status.className = "lf-status err";
      status.textContent = `Couldn't save: ${err.message}`;
    } finally {
      submit.disabled = !unlockedToken;
    }
  });
}
