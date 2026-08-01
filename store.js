// Shared write layer for the session log. Two backends, selected by
// config.DATA_SOURCE:
//   "github" — token (encrypted behind a password) commits sessions.json via the
//              GitHub API. Works on GitHub Pages.
//   "api"    — a log password gates POST/DELETE to /api/sessions (Vercel + Neon).
// Both expose the same interface: renderAuth, isUnlocked, ensureUnlocked,
// saveSession, deleteSession, setEditSession, takeEditSession.

import { REPO, SESSIONS_PATH, DATA_SOURCE } from "./config.js";

const isApi = DATA_SOURCE === "api";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------
// Edit hand-off (session card → log form) — shared by both modes
// ---------------------------------------------------------------------------
let pendingEdit = null;
export const setEditSession = (s) => { pendingEdit = s; };
export const takeEditSession = () => { const s = pendingEdit; pendingEdit = null; return s; };

const sortSessions = (list) => list.sort((a, b) => (b.date + b.timeRange.start).localeCompare(a.date + a.timeRange.start));

// ===========================================================================
// API mode (Vercel + Neon): a log password sent with each write
// ===========================================================================
const PW_KEY = "surfcast:pw:v1";
let apiPw = null;
try { apiPw = localStorage.getItem(PW_KEY); } catch { /* ignore */ }

async function apiWrite(method, body) {
  const res = await fetch("/api/sessions", {
    method,
    headers: { "Content-Type": "application/json", "x-log-password": apiPw || "" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { apiPw = null; try { localStorage.removeItem(PW_KEY); } catch {} throw new Error("Wrong password — re-enter it."); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Save failed (${res.status}).`); }
  return res.json().catch(() => ({}));
}

const apiSave = (record, removeId = null) => apiWrite("POST", { record, removeId });
const apiDelete = (id) => apiWrite("DELETE", { id });

function apiRenderAuth(container, onReady = () => {}) {
  container.replaceChildren();
  const box = el("div", "lf-auth");
  if (apiPw) {
    box.append(el("span", "lf-auth-ok", "🔓 Ready"));
    const forget = el("button", "lf-link", "forget password"); forget.type = "button";
    forget.addEventListener("click", () => { apiPw = null; try { localStorage.removeItem(PW_KEY); } catch {} apiRenderAuth(container, onReady); onReady(); });
    box.append(forget);
    container.append(box);
    return;
  }
  box.append(el("div", "lf-auth-title", "🔒 Enter your log password"));
  const pw = document.createElement("input");
  pw.type = "password"; pw.placeholder = "log password"; pw.className = "lf-auth-input";
  const btn = el("button", "lf-btn", "Unlock"); btn.type = "button";
  const save = () => {
    if (!pw.value) return;
    apiPw = pw.value; try { localStorage.setItem(PW_KEY, apiPw); } catch {}
    apiRenderAuth(container, onReady); onReady();
  };
  btn.addEventListener("click", save);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  box.append(pw, btn);
  container.append(box);
}

// ===========================================================================
// GitHub mode: token encrypted behind a password, commits sessions.json
// ===========================================================================
const AUTH_KEY = "surfcast:auth:v1";
let unlockedToken = null;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function ghStoreToken(token, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  localStorage.setItem(AUTH_KEY, JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
  unlockedToken = token;
}
async function ghUnlockToken(password) {
  const blob = JSON.parse(localStorage.getItem(AUTH_KEY));
  const key = await deriveKey(password, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct));
  unlockedToken = new TextDecoder().decode(pt);
}
const ghHasToken = () => !!localStorage.getItem(AUTH_KEY);
const ghForget = () => { localStorage.removeItem(AUTH_KEY); unlockedToken = null; };

const utf8ToB64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; bytes.forEach((x) => (bin += String.fromCharCode(x))); return btoa(bin); };
const b64ToUtf8 = (str) => new TextDecoder().decode(unb64(str.replace(/\n/g, "")));
const GH = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });

async function ghCommit(mutate, message) {
  if (!unlockedToken) throw new Error("Not unlocked");
  const url = `https://api.github.com/repos/${REPO}/contents/${SESSIONS_PATH}`;
  const getRes = await fetch(url, { headers: GH(unlockedToken) });
  let sessions = [], sha = null;
  if (getRes.ok) { const d = await getRes.json(); sessions = JSON.parse(b64ToUtf8(d.content)); sha = d.sha; }
  else if (getRes.status !== 404) throw new Error(`Couldn't read sessions (${getRes.status}) — check the token has access to ${REPO}.`);
  const next = mutate(sessions);
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...GH(unlockedToken), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: utf8ToB64(JSON.stringify(next, null, 2) + "\n"), ...(sha ? { sha } : {}) }),
  });
  if (!putRes.ok) { const e = await putRes.json().catch(() => ({})); throw new Error(e.message || `Save failed (${putRes.status}).`); }
  return next;
}
const ghSave = (record, removeId = null) => ghCommit(
  (list) => sortSessions([...list.filter((s) => s.id !== record.id && s.id !== removeId), record]),
  `Log session: ${record.spotName} ${record.date} ${record.timeRange.label}`);
const ghDelete = (id) => ghCommit((list) => list.filter((s) => s.id !== id), `Delete session: ${id}`);

function ghRenderAuth(container, onReady = () => {}) {
  container.replaceChildren();
  const box = el("div", "lf-auth");
  if (unlockedToken) {
    box.append(el("span", "lf-auth-ok", "🔓 Ready"));
    const forget = el("button", "lf-link", "forget token"); forget.type = "button";
    forget.addEventListener("click", () => { ghForget(); ghRenderAuth(container, onReady); onReady(); });
    box.append(forget); container.append(box); return;
  }
  if (ghHasToken()) {
    box.append(el("div", "lf-auth-title", "🔒 Enter your password"));
    const pw = document.createElement("input"); pw.type = "password"; pw.placeholder = "password"; pw.className = "lf-auth-input";
    const btn = el("button", "lf-btn", "Unlock"); btn.type = "button";
    const err = el("div", "lf-err");
    const tryUnlock = async () => { err.textContent = ""; try { await ghUnlockToken(pw.value); ghRenderAuth(container, onReady); onReady(); } catch { err.textContent = "Wrong password."; } };
    btn.addEventListener("click", tryUnlock);
    pw.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    const reset = el("button", "lf-link", "reset (re-enter token)"); reset.type = "button";
    reset.addEventListener("click", () => { ghForget(); ghRenderAuth(container, onReady); });
    box.append(pw, btn, reset, err); container.append(box); return;
  }
  box.append(el("div", "lf-auth-title", "One-time setup: paste a GitHub token and choose a password"));
  const help = el("div", "lf-auth-help");
  help.innerHTML = `Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with access to only <b>${REPO}</b> and <b>Contents: Read and write</b>. It's stored encrypted in this browser behind your password.`;
  const tok = document.createElement("input"); tok.type = "password"; tok.placeholder = "github_pat_…"; tok.className = "lf-auth-input";
  const pw = document.createElement("input"); pw.type = "password"; pw.placeholder = "choose a password"; pw.className = "lf-auth-input";
  const pw2 = document.createElement("input"); pw2.type = "password"; pw2.placeholder = "confirm password"; pw2.className = "lf-auth-input";
  const btn = el("button", "lf-btn", "Save setup"); btn.type = "button";
  const err = el("div", "lf-err");
  btn.addEventListener("click", async () => {
    err.textContent = "";
    if (!tok.value.trim()) return (err.textContent = "Paste your GitHub token.");
    if (pw.value.length < 4) return (err.textContent = "Password must be at least 4 characters.");
    if (pw.value !== pw2.value) return (err.textContent = "Passwords don't match.");
    await ghStoreToken(tok.value.trim(), pw.value); ghRenderAuth(container, onReady); onReady();
  });
  box.append(help, tok, pw, pw2, btn, err); container.append(box);
}

// ===========================================================================
// Unified interface (dispatches on DATA_SOURCE)
// ===========================================================================
export const isUnlocked = () => (isApi ? !!apiPw : !!unlockedToken);
export const saveSession = (record, removeId = null) => (isApi ? apiSave(record, removeId) : ghSave(record, removeId));
export const deleteSession = (id) => (isApi ? apiDelete(id) : ghDelete(id));
export const renderAuth = (container, onReady) => (isApi ? apiRenderAuth(container, onReady) : ghRenderAuth(container, onReady));

// Ensure unlocked for an action outside the form (delete). Resolves true/false.
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
