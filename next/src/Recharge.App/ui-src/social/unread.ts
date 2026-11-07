/** The unread-message count for the whole app: one number kept fresh from the social feed, shown on the sidebar and the Messages tab. */
import { onSession, currentUser, sessionReady } from '../account/session.js';
import { socialJson } from './api.js';
import { openFeed, type FeedEvent } from './events.js';
import { normalizeConversations } from './model.js';
import { unreadLabel } from './convo.js';

type Listener = (count: number) => void;

let count = 0;
let listeners: Listener[] = [];
let stopFeed: (() => void) | null = null;
let timer = 0;
let token = 0;

export function unreadCount(): number {
  return count;
}

export function onUnread(listener: Listener): () => void {
  listeners = listeners.concat(listener);
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

/** The Messages view knows the exact number the moment you read a chat; it tells everyone else here. */
export function setUnread(n: number): void {
  const next = Math.max(0, Math.floor(n) || 0);
  if (next === count) return;
  count = next;
  for (const l of listeners.slice()) {
    try { l(count); } catch (error) { console.error('unread listener failed', error); }
  }
}

async function refresh(): Promise<void> {
  const mine = ++token;
  try {
    const data = normalizeConversations(await socialJson('GET', '/api/conversations'));
    if (mine === token && currentUser()) setUnread(data.unread);
  } catch { /* keep the old number; the next event tries again */ }
}

/** Ask for the count soon (events arrive in bursts; one request covers them). */
export function refreshUnread(delay = 250): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), delay);
}

function onEvent(event: FeedEvent): void {
  if (event.type === 'message' || event.type === 'read' || event.type === 'connected' || event.type === 'reset' || event.type === 'friends') refreshUnread();
}

function start(): void {
  if (stopFeed) return;
  stopFeed = openFeed(onEvent);
  refreshUnread(0);
}

function stop(): void {
  window.clearTimeout(timer);
  token += 1;
  if (stopFeed) { stopFeed(); stopFeed = null; }
  setUnread(0);
}

/** Watch for messages while someone is signed in. Safe to call once at start-up. */
export function initUnread(): void {
  const sync = (): void => { if (currentUser()) start(); else stop(); };
  onSession(sync);
  void sessionReady().then(sync);
}

/** A small "3" bubble inside `host`, kept in step with the count (hidden at zero). Returns the function that stops updating. */
export function unreadBadge(host: HTMLElement, className: string): () => void {
  const badge = document.createElement('span');
  badge.className = className;
  badge.setAttribute('aria-hidden', 'true');
  host.appendChild(badge);
  const base = host.getAttribute('aria-label') || '';
  const paint = (n: number): void => {
    badge.hidden = n <= 0;
    badge.textContent = unreadLabel(n);
    if (base) host.setAttribute('aria-label', n > 0 ? base + ', ' + n + ' unread' : base);
  };
  paint(count);
  return onUnread(paint);
}
