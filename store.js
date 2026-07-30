// Shared write layer: a GitHub token stored encrypted behind a password
// (Web Crypto), plus the save/delete adapters that commit sessions.json via the
// GitHub API. Used by both the log form (logform.js) and the session cards
// (sessions.js). To move to a Vercel backend later, only commitSessions() changes.

import { REPO, SESSIONS_PATH } from "./config.js";

// ---------------------------------------------------------------------------
// Token encrypted behind a password
// ---------------------------------------------------------------------------
const AUTH_KEY = "surfcast:auth:v1";
let unlockedToken = null; // in memory for this tab only

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
}

export const hasToken = () => !!localStorage.getItem(AUTH_KEY);
export const isUnlocked = () => !!unlockedToken;
export const forgetToken = () => { localStorage.removeItem(AUTH_KEY); unlockedToken = null; };

// ---------------------------------------------------------------------------
// GitHub commit adapter (the single swap point for a future Vercel backend)
// ---------------------------------------------------------------------------
const utf8ToB64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; bytes.forEach((x) => (bin += String.fromCharCode(x))); return btoa(bin); };
const b64ToUtf8 = (str) => new TextDecoder().decode(unb64(str.replace(/\n/g, "")));
const GH = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });

async function commitSessions(mutate, message) {
  if (!unlockedToken) throw new Error("Not unlocked");
  const url = `https://api.github.com/repos/${REPO}/contents/${SESSIONS_PATH}`;
  const getRes = await fetch(url, { headers: GH(unlockedToken) });
  let sessions = [], sha = null;
  if (getRes.ok) {
    const data = await getRes.json();
    sessions = JSON.parse(b64ToUtf8(data.content));
    sha = data.sha;
  } else if (getRes.status !== 404) {
    throw new Error(`Couldn't read sessions (${getRes.status}) — check the token has access to ${REPO}.`);
  }
  const next = mutate(sessions);
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...GH(unlockedToken), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: utf8ToB64(JSON.stringify(next, null, 2) + "\n"), ...(sha ? { sha } : {}) }),
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(err.message || `Save failed (${putRes.status}).`);
  }
  return next;
}

const sortSessions = (list) => list.sort((a, b) => (b.date + b.timeRange.start).localeCompare(a.date + a.timeRange.start));

// removeId: also drop a session with this id (used when an edit changes the id)
export function saveSession(record, removeId = null) {
  return commitSessions(
    (list) => sortSessions([...list.filter((s) => s.id !== record.id && s.id !== removeId), record]),
    `Log session: ${record.spotName} ${record.date} ${record.timeRange.label}`,
  );
}

export function deleteSession(id) {
  return commitSessions((list) => list.filter((s) => s.id !== id), `Delete session: ${id}`);
}

// ---------------------------------------------------------------------------
// Edit hand-off (session card → log form) + shared auth UI
// ---------------------------------------------------------------------------
let pendingEdit = null;
export const setEditSession = (s) => { pendingEdit = s; };
export const takeEditSession = () => { const s = pendingEdit; pendingEdit = null; return s; };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// setup / unlock / ready panel; calls onReady() whenever the unlock state changes
export function renderAuth(container, onReady = () => {}) {
  container.replaceChildren();
  const box = el("div", "lf-auth");

  if (unlockedToken) {
    box.append(el("span", "lf-auth-ok", "🔓 Ready"));
    const forget = el("button", "lf-link", "forget token");
    forget.type = "button";
    forget.addEventListener("click", () => { forgetToken(); renderAuth(container, onReady); onReady(); });
    box.append(forget);
    container.append(box);
    return;
  }

  if (hasToken()) {
    box.append(el("div", "lf-auth-title", "🔒 Enter your password"));
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

// Ensure unlocked for an action outside the form (e.g. delete). Resolves true if
// unlocked, false if the user cancels. Shows a modal with the auth panel.
export function ensureUnlocked() {
  return new Promise((resolve) => {
    if (isUnlocked()) return resolve(true);
    const overlay = el("div", "sc-modal");
    const boxEl = el("div", "sc-modal-box");
    const panel = el("div");
    renderAuth(panel, () => { if (isUnlocked()) { overlay.remove(); resolve(true); } });
    const cancel = el("button", "lf-link", "cancel"); cancel.type = "button";
    cancel.addEventListener("click", () => { overlay.remove(); resolve(false); });
    boxEl.append(panel, cancel);
    overlay.append(boxEl);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    document.body.append(overlay);
  });
}
