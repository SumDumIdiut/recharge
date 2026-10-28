// Settings > Appearance, admin only: "Event for everyone". Talks to the real hub even in the test build (where the user's
// own look is forced on locally); the Live marker follows the hub's real state (getHubEvent), not the local flag.
import { canSetEvents, getHubEvent, onHubEventChange, onThemeChange, isForcedOn, pushEvent, HUB_MISSING_MSG } from '../halloween.js';

const KINDS = ['off', 'on'];
let pending = null; // 'on' | 'off' while a confirm is open
let busy = false;
let error = '';

function status(hub) {
  if (hub === true) return 'Hub: on for everyone';
  if (hub === false) return 'Hub: off';
  if (hub === 'missing') return HUB_MISSING_MSG;
  return "Hub: can't reach it";
}

export function renderEventAdmin(doc = document) {
  const section = doc.getElementById('event-admin');
  if (!section) return;
  const admin = canSetEvents();
  section.hidden = !admin;
  if (!admin) return;
  const hub = getHubEvent();
  for (const k of KINDS) {
    const live = hub === (k === 'on');
    const card = doc.getElementById(`event-card-${k}`);
    if (card) card.setAttribute('aria-current', String(live));
    doc.getElementById(`event-tag-${k}`).textContent = live ? 'Live' : '';
    doc.getElementById(`event-main-${k}`).disabled = busy || live;
    doc.getElementById(`event-confirm-${k}`).hidden = pending !== k;
    doc.getElementById(`event-yes-${k}`).disabled = busy;
    doc.getElementById(`event-no-${k}`).disabled = busy;
  }
  doc.getElementById('event-admin-status').textContent = status(hub);
  const err = doc.getElementById('event-admin-error');
  err.textContent = error;
  err.hidden = !error;
  doc.getElementById('event-admin-note').hidden = !isForcedOn();
}

export async function confirmEvent(kind, doc = document) {
  if (busy || pending !== kind) return;
  busy = true; error = '';
  renderEventAdmin(doc);
  try { await pushEvent(kind === 'on'); }
  catch (e) { error = String(e?.message || e); }
  finally { busy = false; pending = null; renderEventAdmin(doc); }
}

let unsubs = [];
export function initEventAdmin(doc = document, { refresh = null } = {}) {
  if (!doc.getElementById('event-admin')) return;
  pending = null; busy = false; error = '';
  // Same previews as the theme picker: clone them rather than duplicating the markup.
  for (const slot of doc.querySelectorAll?.('.event-preview-slot') || []) {
    const src = doc.querySelector(`#theme-picker [data-theme-choice="${slot.dataset.preview}"] .theme-preview`);
    if (src && !slot.firstChild) slot.appendChild(src.cloneNode(true));
  }
  for (const k of KINDS) {
    doc.getElementById(`event-main-${k}`).onclick = () => { if (busy || getHubEvent() === (k === 'on')) return; pending = k; error = ''; renderEventAdmin(doc); };
    doc.getElementById(`event-no-${k}`).onclick = () => { if (busy) return; pending = null; renderEventAdmin(doc); };
    doc.getElementById(`event-yes-${k}`).onclick = () => confirmEvent(k, doc);
  }
  for (const u of unsubs) u();
  unsubs = [onHubEventChange(() => renderEventAdmin(doc)), onThemeChange(() => renderEventAdmin(doc))];
  renderEventAdmin(doc);
  if (refresh && canSetEvents()) Promise.resolve(refresh()).catch(() => {}); // settings/script.js already calls refreshEvent()
}
