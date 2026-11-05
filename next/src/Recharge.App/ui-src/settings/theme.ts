import type { Settings } from './api.js';
import { call } from '../bridge.js';
import { applyBackgroundSettings, backgroundLayer } from '../backgrounds/index.js';

/**
 * The look of the app. Classic is the default token set in tokens.css; Halloween overrides the tokens only (flat colours, no blur,
 * no glow). The background picture sits on one fixed, composited layer (body::before) that is only moved while scrolling, the
 * WebKitGTK rule: never a fixed background-attachment and never a blur.
 */
const CSS = `
body::before {
  content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image: var(--bg-image, none); background-size: cover; background-position: center; background-repeat: no-repeat;
  transform: translateZ(0); will-change: transform;
}
:root[data-theme="halloween"] {
  --bg: #1a0028; --panel: #26103a;
  --line: rgba(255, 238, 214, 0.18); --line-hi: rgba(255, 238, 214, 0.45);
  --text: #fff1de; --text-dim: rgba(255, 241, 222, 0.68);
  --green: #ff8a1f; --green-dim: rgba(255, 138, 31, 0.65);
  --magenta: #c98cff; --magenta-dim: rgba(201, 140, 255, 0.75);
  --surface-0: #1a0028; --surface-1: rgba(30, 10, 46, 0.86); --surface-2: #31194a; --surface-nav: rgba(32, 10, 51, 0.9);
}
:root[data-theme="halloween"] body::before { background-image: url("settings/bg-halloween.png"); }
/* The event look wins over your own background (it stays saved, and comes back with Classic), and the logo turns Halloween. */
:root[data-theme="halloween"] #bg-layer { display: none; }
:root[data-theme="halloween"][data-bg="on"] body::before { display: block !important; }
:root[data-theme="halloween"] .brand img, :root[data-theme="halloween"] .hero-logo { content: url("assets/logo-halloween.png"); }
.settings-row-wrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.settings-input { background: var(--panel); color: var(--text); border: 1px solid var(--line-hi); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; min-width: 320px; }
.settings-input:focus { outline: none; border-color: var(--green); }
.settings-error { color: var(--danger); }
.settings-ok { color: var(--green); }
.settings-links { display: flex; gap: 12px; flex-wrap: wrap; padding: 12px 0; border-top: 1px solid var(--line); }
.theme-choice { display: flex; gap: 10px; }
.theme-choice .btn[aria-pressed="true"] { border-color: var(--green); color: var(--green); }
`;

let styleNode: HTMLStyleElement | null = null;

function ensureStyle(): void {
  if (styleNode && styleNode.isConnected) return;
  styleNode = document.createElement('style');
  styleNode.id = 'settings-theme-style';
  styleNode.textContent = CSS;
  document.head.appendChild(styleNode);
}

export type ThemeChoice = 'auto' | 'classic' | 'halloween';

/**
 * Halloweencharge 2026, as the current app does it: the hub says whether the event runs (GET /api/event, public), and "auto",
 * the default, shows Halloween exactly while it does. Classic or Halloween picked by hand always win.
 */
export function effectiveTheme(eventOn: boolean, choice: string): 'classic' | 'halloween' {
  if (choice === 'classic' || choice === 'halloween') return choice;
  return eventOn ? 'halloween' : 'classic';
}

const EVENT_KEY = 'recharge.event.halloween2026'; // the last answer, so the next start paints the right look at once
const EVENT_POLL_MS = 10 * 60 * 1000;
let choice: string = 'auto';
let eventOn = readEvent();
let watching = 0;
const listeners = new Set<() => void>();

function readEvent(): boolean {
  try { return localStorage.getItem(EVENT_KEY) === '1'; } catch { return false; }
}

/** Whether the hub's Halloween event is on (the last known answer). */
export function isEventOn(): boolean { return eventOn; }

/** Runs when the event flag or the shown theme changes (the settings page repaints its note). */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Reads the event flag from the hub now, then every 10 minutes. A hub that can't be reached keeps the last answer. */
export function startEventWatch(): void {
  if (watching) return;
  const poll = async (): Promise<void> => {
    try {
      const reply = await call<{ status: number; body: string }>('hub.get', { path: '/api/event' });
      if (reply.status !== 200) return;
      const next = (JSON.parse(reply.body) as { halloween2026?: unknown }).halloween2026 === true;
      try { localStorage.setItem(EVENT_KEY, next ? '1' : '0'); } catch { /* the flag just isn't remembered */ }
      if (next !== eventOn) { eventOn = next; applyTheme(choice); }
    } catch { /* offline: keep the last answer */ }
  };
  void poll();
  watching = window.setInterval(() => void poll(), EVENT_POLL_MS);
}

/** Shows the theme for a choice ('auto', 'classic' or 'halloween'). */
export function applyTheme(next: string): void {
  ensureStyle();
  choice = next;
  const theme = effectiveTheme(eventOn, choice);
  if (theme === 'halloween') document.documentElement.setAttribute('data-theme', 'halloween');
  else document.documentElement.removeAttribute('data-theme');
  // A hidden background video shouldn't keep decoding: the layer checks the theme in its playback rule.
  backgroundLayer()?.syncPlayback();
  for (const fn of listeners) { try { fn(); } catch { /* one bad listener */ } }
}

/** Applies the theme and the background (picture, video or playlist) from the saved settings. Returns a short note when the background couldn't be shown. */
export async function applyAll(settings: Settings): Promise<string | null> {
  applyTheme(settings.theme);
  try {
    return await applyBackgroundSettings(settings);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
