// Is the window worth animating for? False while the document is hidden or the window is minimised / not visible
// (bgmedia.js feeds the window part, because the webview never fires visibilitychange on minimise or a workspace switch).
// While inactive, <html class="app-idle"> pauses every CSS animation (style.css), and timers/loops subscribe via onActivity.
let winBackground = false;
let lastActive = true;
const listeners = new Set();

export function isActive() {
  const hidden = typeof document !== 'undefined' && !!document.hidden;
  return !hidden && !winBackground;
}

function refresh() {
  const now = isActive();
  if (now === lastActive) return;
  lastActive = now;
  try { document.documentElement.classList.toggle('app-idle', !now); } catch (e) {}
  for (const cb of [...listeners]) { try { cb(now); } catch (e) {} }
}

// Called by bgmedia when the Tauri window state changes.
export function setWindowBackground(on) {
  winBackground = !!on;
  refresh();
}

// cb(active) on every change; returns an unsubscribe function.
export function onActivity(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
