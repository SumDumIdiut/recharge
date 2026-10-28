// Halloweencharge 2026: the event flag lives on the hub (GET /api/event), the choice in localStorage. The theme is an
// attribute on <html> (data-theme="halloween"); style.css does the rest, including the forced background, so the
// user's own texture / playlist settings are never touched. theme.js suspends the playlist while this is on.
import { HUB_BASE } from './hub.js';
import { getToken, isAdmin, getUsername } from './auth.js';

const CHOICE_KEY = 'rechargeTheme'; // 'classic' | 'halloween'; unset = default (Halloween while the event runs)
const EVENT_KEY = 'rechargeEvent'; // last known event flag, '1' / '0', so the next start paints right away
const POLL_MS = 10 * 60 * 1000;

// The whole decision: Halloween only while the event runs, unless the user picked Classic.
export function effectiveTheme(eventOn, choice) {
  return eventOn && choice !== 'classic' ? 'halloween' : 'classic';
}

// Only the account named exactly "Flipped" may flip the event for everyone (the hub enforces the same rule).
export function canSetEvents() { return isAdmin() && getUsername() === 'Flipped'; }

export function getThemeChoice() {
  try { const c = localStorage.getItem(CHOICE_KEY); return c === 'classic' || c === 'halloween' ? c : null; } catch (e) { return null; }
}

export function setThemeChoice(choice) {
  try {
    if (choice === 'classic' || choice === 'halloween') localStorage.setItem(CHOICE_KEY, choice);
    else localStorage.removeItem(CHOICE_KEY);
  } catch (e) {}
  applyTheme();
}

// Test build (RECHARGE_NO_LIVE=1): the event is forced on locally. Never written to localStorage: the test build shares
// WebKit storage with the real app, and live-boot.js would copy a stored '1' into it.
let forcedOn = false;
export function isForcedOn() { return forcedOn; }
export async function detectTestBuild(invokeFn) {
  try {
    const s = await invokeFn('live_status');
    if (s && (s.managedReason ?? s.managed_reason) === 'env') { forcedOn = true; applyTheme(); }
  } catch (e) { /* no Tauri, or no live_status: not a test build */ }
  return forcedOn;
}

// Test build only: a session-only on/off so the switch on the Account page can show both looks. sessionStorage, never
// localStorage (live-boot.js copies localStorage into the real app).
const LOCAL_KEY = 'rechargeEventLocal';
let localOverride = null;
function readLocal() {
  if (localOverride !== null) return localOverride;
  try { const v = sessionStorage.getItem(LOCAL_KEY); if (v === '1' || v === '0') localOverride = v === '1'; } catch (e) {}
  return localOverride;
}
export function setLocalEvent(on) {
  localOverride = !!on;
  try { sessionStorage.setItem(LOCAL_KEY, on ? '1' : '0'); } catch (e) {}
  return applyTheme();
}

export function getEventOn() {
  if (forcedOn) { const l = readLocal(); return l === null ? true : l; }
  try { return localStorage.getItem(EVENT_KEY) === '1'; } catch (e) { return false; }
}

export function currentTheme() {
  return effectiveTheme(getEventOn(), getThemeChoice());
}

export function isHalloween() {
  return currentTheme() === 'halloween';
}

const listeners = new Set();
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let applied = null;
// Sets or removes <html data-theme>; tells listeners (settings, theme.js) when the theme or the event flag changed.
export function applyTheme() {
  const theme = currentTheme();
  const key = theme + (getEventOn() ? '+event' : '');
  try {
    const root = document.documentElement;
    if (theme === 'halloween') root.setAttribute('data-theme', 'halloween');
    else root.removeAttribute('data-theme');
  } catch (e) {}
  if (key === applied) return theme;
  applied = key;
  if (theme === 'halloween') probeLogo();
  for (const fn of [...listeners]) { try { fn(theme); } catch (e) {} }
  try { window.dispatchEvent(new CustomEvent('recharge-theme', { detail: theme })); } catch (e) {}
  return theme;
}

// The Halloween logo may not be shipped yet: only when it loads does <html> get has-halloween-logo (style.css swaps the images then).
let logoProbe = null;
function probeLogo() {
  if (logoProbe || typeof Image === 'undefined') return;
  logoProbe = true;
  const img = new Image();
  img.onload = () => { try { document.documentElement.classList.add('has-halloween-logo'); } catch (e) {} };
  img.onerror = () => { logoProbe = null; };
  img.src = '/assets/logo-halloween.png';
}

export function setEventOn(on) {
  try { localStorage.setItem(EVENT_KEY, on ? '1' : '0'); } catch (e) {}
  return applyTheme();
}

// The hub's real answer, tracked apart from the local flag (which the test build forces): true | false | 'missing'
// (GET /api/event 404: the hub lacks the event switch) | null (unknown / unreachable). The admin "Event for everyone"
// section in Settings reads this; it is updated on every refreshEvent, forced or not.
export const HUB_MISSING_MSG = "The hub doesn't have the event switch yet (needs the hub update).";
let hubEventState = null;
const hubListeners = new Set();
export function getHubEvent() { return hubEventState; }
export function onHubEventChange(fn) { hubListeners.add(fn); return () => hubListeners.delete(fn); }
function setHubEvent(v) {
  if (v === hubEventState) return;
  hubEventState = v;
  for (const fn of [...hubListeners]) { try { fn(v); } catch (e) {} }
}

// Asks the hub whether the event runs. Offline or an error keeps the cached answer.
export async function refreshEvent(fetchFn = (...a) => fetch(...a)) {
  try {
    const res = await fetchFn(`${HUB_BASE}/api/event`);
    if (res.status === 404) { setHubEvent('missing'); return getEventOn(); }
    if (!res.ok) { setHubEvent(null); return getEventOn(); }
    const body = await res.json();
    const on = body.halloween2026 === true;
    setHubEvent(on);
    if (!forcedOn) setEventOn(on);
  } catch (e) { setHubEvent(null); /* offline - keep the cached flag */ }
  return getEventOn();
}

// Admin only (the hub answers 403 otherwise). Throws with the hub's message on failure.
export async function pushEvent(on, fetchFn = (...a) => fetch(...a)) {
  const res = await fetchFn(`${HUB_BASE}/api/admin/event`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ halloween2026: !!on }),
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch (e) {}
    if (res.status === 404) throw new Error("The hub doesn't have the event switch yet (needs the hub update).");
    throw new Error(msg || (res.status === 403 ? 'Only admins can change this.' : `The hub answered ${res.status}.`));
  }
  return refreshEvent(fetchFn);
}

// Startup: apply the cached state, ask the hub now and every 10 minutes.
let pollTimer = null;
export function startEventWatch({ fetchFn, periodMs = POLL_MS } = {}) {
  applyTheme();
  detectTestBuild(globalThis.window?.__TAURI__?.core?.invoke).then(() => refreshEvent(fetchFn));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshEvent(fetchFn), periodMs);
  return () => { clearInterval(pollTimer); pollTimer = null; };
}
