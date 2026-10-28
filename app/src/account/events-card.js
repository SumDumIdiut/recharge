// Admin-only "Events" card on the Account page: the Halloweencharge 2026 switch (moved here from Settings).
// Test build: toggles a session-only local override and never calls the hub.
import { canSetEvents, getEventOn, isForcedOn, setLocalEvent, pushEvent, onThemeChange } from '../halloween.js';

export function renderEventsCard(doc = document) {
  const card = doc.getElementById('account-events');
  if (!card) return;
  const admin = canSetEvents();
  card.hidden = !admin;
  if (!admin) return;
  const on = getEventOn();
  doc.getElementById('account-events-state').textContent = on ? 'On' : 'Off';
  doc.getElementById('account-events-toggle').textContent = on ? 'Turn off' : 'Turn on';
  doc.getElementById('account-events-status').textContent = isForcedOn() ? 'Test build: local only' : on ? 'On for everyone' : 'Off';
}

export async function toggleEvent(doc = document) {
  const btn = doc.getElementById('account-events-toggle');
  const err = doc.getElementById('account-events-error');
  err.hidden = true;
  const want = !getEventOn();
  btn.disabled = true;
  try {
    if (isForcedOn()) setLocalEvent(want);
    else await pushEvent(want);
  } catch (e) {
    err.textContent = String(e?.message || e);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    renderEventsCard(doc);
  }
}

let unsub = null;
export function initEventsCard(doc = document) {
  doc.getElementById('account-events-toggle').onclick = () => toggleEvent(doc);
  if (unsub) unsub();
  unsub = onThemeChange(() => renderEventsCard(doc));
  renderEventsCard(doc);
}
