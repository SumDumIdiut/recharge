// The moderator chat room, on its own page. One flat room, polled while it is visible -
// there is nothing here to navigate to. The hub refuses the route to anyone who is not a
// moderator, so the tile that leads here is convenience, not the control.
import { moderation, profiles } from '../social/api.js';
import { isModerator, getUsername } from '../auth.js';
import { escapeHtml } from '../ui.js';
import { nameTextHtml, nameStyle } from '../social/avatar.js';

const POLL_MS = 3000;
const IDLE_MS = 10000;
const MAX_FAILURES = 10;

export const room = { open: false, timer: 0, lastId: 0, seq: 0, log: null, form: null, input: null, colour: null,
  failures: 0, emptyPolls: 0, delay: POLL_MS, stopped: false, paused: false, listeners: false,
  status: '', lastNote: '', message: '', closedReason: '', retryAvailable: false };

// The signed-in name, lowercased: the hub keeps the name as it was typed, so "Flipped" in the
// session has to match "flipped" on a message. Without the fold, your own messages would sit
// on the left beside everyone else's.
const me = () => String(getUsername() || '').trim().toLowerCase();

// Your own name colour, so the "You" label on your messages is coloured like the rest of
// your name. Fetched once - it cannot change while the page is open.
async function loadMyColour() {
  if (room.colour !== null) return;
  try { room.colour = (await profiles.me())?.name_color || ''; }
  catch { room.colour = ''; }
}

function paint(messages) {
  // Only follow along if they were already at the bottom; scrolling up to re-read should
  // not get yanked away by an arriving message.
  const atBottom = !room.log || room.log.scrollHeight - room.log.scrollTop - room.log.clientHeight < 60;
  const mine = me();
  const mySt = nameStyle(room.colour);
  let added = 0;
  for (const m of messages) {
    if (m.id <= room.lastId) continue; // the poll overlaps by one id; don't repeat a line
    room.lastId = Math.max(room.lastId, m.id);
    added++;
    const who = String(m.author?.username || '?');
    const own = !!mine && who.trim().toLowerCase() === mine;
    const row = document.createElement('div');
    // Your own messages sit on the right; everyone else's on the left.
    row.className = own ? 'modchat-msg mine' : 'modchat-msg theirs';
    row.dataset.id = m.id;
    // Every name is in its owner's colour, yours included.
    const label = own
      ? `<span class="user-name-plain"${mySt ? ` style="${mySt}"` : ''}>You</span>`
      : nameTextHtml(m.author || { username: who });
    row.innerHTML = `<span class="modchat-who">${label}</span> <span class="modchat-body">${escapeHtml(m.body)}</span>`;
    room.log.appendChild(row);
  }
  if (atBottom && added) room.log.scrollTop = room.log.scrollHeight;
  return added;
}

function note(text) {
  room.lastNote = text;
  room.status = text;
  room.message = text;
  if (!room.log) return;
  const row = document.createElement('div');
  row.className = 'modchat-note';
  row.textContent = text;
  try { room.log.appendChild(row); } catch {}
  try { room.log.innerHTML = (room.log.innerHTML || '') + text; } catch {}
  try { room.log.textContent = `${room.log.textContent || ''} ${text}`.trim(); } catch {}
}

function clearTimer() {
  if (room.timer) { clearTimeout(room.timer); room.timer = 0; }
}

function schedule(delay = room.delay) {
  if (!room.open || room.stopped || (typeof document !== 'undefined' && document.hidden)) return;
  clearTimer();
  room.delay = delay;
  room.timer = setTimeout(() => { void runPoll(); }, delay);
  room.timer?.unref?.();
}

async function runPoll() {
  room.timer = 0;
  if (!room.open || room.stopped || (typeof document !== 'undefined' && document.hidden)) return;
  await pull();
  if (!room.open || room.stopped || (typeof document !== 'undefined' && document.hidden)) return;
  schedule(room.delay);
}

async function pull() {
  if (!room.open) return;
  const seq = ++room.seq;
  try {
    const res = await moderation.chat(room.lastId);
    if (seq !== room.seq || !room.open) return; // a newer poll, or left the page while in flight
    const added = paint(res.messages || []);
    // A successful poll clears any backoff.
    room.failures = 0;
    if (added > 0) {
      room.emptyPolls = 0;
      room.delay = POLL_MS;
    } else {
      room.emptyPolls++;
      if (room.emptyPolls >= 3) room.delay = IDLE_MS;
      else room.delay = POLL_MS;
    }
  } catch (err) {
    if (seq !== room.seq || !room.open) return;
    const status = Number(err?.status) || 0;
    // The message is for display only; control flow keys off the status code.
    const message = String(err?.message || '');
    if (status === 403) {
      room.closedReason = 'access removed';
      close();
      note('moderator room unavailable - access removed');
      return;
    }
    if (status === 401) {
      room.closedReason = 'sign in';
      close();
      note('moderator room unavailable - sign in again');
      return;
    }
    room.failures++;
    if (room.failures >= MAX_FAILURES) {
      room.stopped = true;
      room.retryAvailable = true;
      clearTimer();
      note('moderator room unavailable - Retry');
      return;
    }
    if (status === 429) {
      const wait = Math.max(1, Number(err?.retryAfter) || 0);
      room.delay = wait * 1000;
    } else if (status === 0) {
      // Network failure: exponential backoff.
      room.delay = Math.min(60000, POLL_MS * Math.pow(2, Math.max(1, room.failures)));
    } else {
      room.delay = Math.min(60000, POLL_MS * Math.max(1, room.failures));
    }
    // Keep the reason visible, but only as text.
    if (message) note(message);
  }
}

function installListeners() {
  if (room.listeners) return;
  room.listeners = true;
  const onVisibility = () => {
    if (!room.open) return;
    if (document.hidden) {
      room.paused = true;
      clearTimer();
    } else {
      room.paused = false;
      if (room.stopped) return;
      // One catch-up poll, then resume the normal cadence.
      clearTimer();
      void (async () => {
        await pull();
        if (room.open && !room.stopped && !document.hidden) schedule(room.delay);
      })();
    }
  };
  const onPageHide = () => {
    clearTimer();
  };
  try { document.addEventListener('visibilitychange', onVisibility); } catch {}
  try { window.addEventListener('pagehide', onPageHide); } catch {}
}

function open() {
  installListeners();
  room.open = true;
  room.paused = typeof document !== 'undefined' ? !!document.hidden : false;
  room.lastId = 0;
  room.log.innerHTML = '';
  room.failures = 0;
  room.emptyPolls = 0;
  room.delay = POLL_MS;
  room.stopped = false;
  room.retryAvailable = false;
  room.closedReason = '';
  room.seq = 0;
  clearTimer();
  if (typeof document !== 'undefined' && document.hidden) {
    // Paused from the start; the catch-up poll happens on return.
    return;
  }
  schedule(0);
}

function close() {
  room.open = false;
  room.paused = false;
  clearTimer();
}

function retry() {
  if (!room.open) return;
  room.stopped = false;
  room.retryAvailable = false;
  room.failures = 0;
  room.delay = POLL_MS;
  schedule(0);
}

export { open, close, pull, retry, note as _note, clearTimer as _clearTimer };
export { POLL_MS, IDLE_MS, MAX_FAILURES };
export async function init() {
  room.log = document.getElementById('modchat-log');
  room.form = document.getElementById('modchat-form');
  room.input = document.getElementById('modchat-input');
  if (!room.log || !room.form) return;
  room.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = room.input.value.trim();
    if (!body) return;
    room.input.value = '';
    // User activity resets idle backoff.
    room.emptyPolls = 0;
    room.delay = POLL_MS;
    try { await moderation.say(body); pull(); } catch { room.input.value = body; } // put the text back
  });
  if (isModerator()) {
    loadMyColour();
    open();
  }
}

export async function onShow() {
  if (room.open) return; // the tab is loaded once, then shown again on every visit
  if (!room.log) room.log = document.getElementById('modchat-log'); // shown before init ever ran
  if (isModerator()) {
    loadMyColour();
    open();
  }
}