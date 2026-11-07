/**
 * App-wide message alerts. While you're signed in, one feed listener runs for the whole app (independent of the
 * Messages view). When a message arrives that you aren't already reading, it raises a clickable toast and adds an
 * entry the notification bell shows. Opening or reading that conversation clears its entry.
 */
import { openFeed, type FeedEvent } from './events.js';
import { currentUser, onSession, sessionReady } from '../account/session.js';
import { go } from '../navigation.js';
import { toast } from '../components/toast.js';
import { messagesRoute, normalizeConversation, normalizeMessage, type Conversation, type Message } from './model.js';

export interface MsgAlert { convId: string; from: string; group: string; text: string; ts: number }
type Listener = (unread: number, items: MsgAlert[]) => void;

let items: MsgAlert[] = [];
let listeners: Listener[] = [];
let stopFeed: (() => void) | null = null;
let active: string | null = null;   // the conversation currently open in the Messages view, if any

/** The number of conversations with a waiting alert (one per conversation). */
export function alertCount(): number { return items.length; }

export function onMessageAlerts(listener: Listener): () => void {
  listeners = listeners.concat(listener);
  try { listener(items.length, items.slice()); } catch (e) { console.error('alert listener failed', e); }
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

/** The Messages view calls this as you open/leave a chat so an open conversation doesn't also toast. */
export function setActiveConversation(id: string | null): void {
  active = id || null;
  if (id) clearAlertsFor(id);
}

export function clearAlertsFor(convId: string): void {
  const next = items.filter((x) => x.convId !== convId);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function clearAllAlerts(): void {
  if (items.length === 0) return;
  items = [];
  emit();
}

function emit(): void {
  for (const l of listeners.slice()) { try { l(items.length, items.slice()); } catch (e) { console.error('alert listener failed', e); } }
}

/** The conversation id for an incoming message: the server sends it on the event; for a DM we can also derive it. */
function convIdFor(m: Message, conv: Conversation | null, me: string): string {
  if (conv && conv.id) return conv.id;
  if (m.convId) return m.convId;
  const other = m.from.toLowerCase() === me.toLowerCase() ? m.to : m.from;
  const a = me.toLowerCase();
  const b = other.toLowerCase();
  return 'dm:' + (a <= b ? a + '|' + b : b + '|' + a);
}

function previewOf(m: Message): string {
  if (m.text) return m.text;
  if (m.card) return m.card.type === 'lobby' ? 'shared a lobby' : m.card.type === 'skin' ? 'shared a skin' : 'shared a map';
  return 'sent a message';
}

function handle(event: FeedEvent): void {
  if (event.type !== 'message') return;
  const me = currentUser()?.username || '';
  if (!me) return;
  const m = normalizeMessage(event.message);
  if (!m || m.id <= 0) return;
  if (m.from.toLowerCase() === me.toLowerCase()) return;   // your own message, echoed back
  const conv = event.conversation ? normalizeConversation(event.conversation) : null;
  const convId = convIdFor(m, conv, me);
  // If you're looking at this very conversation, the Messages view already shows it — don't toast.
  if (active === convId && document.visibilityState === 'visible') return;
  const group = conv && conv.kind === 'group' ? conv.name : '';
  const preview = previewOf(m);
  const label = group ? group + ' · ' + m.from : m.from;
  toast(label + ': ' + preview, 'info', () => go(messagesRoute(convId)));
  items = items.filter((x) => x.convId !== convId);   // one entry per conversation, newest first
  items.unshift({ convId, from: m.from, group, text: preview, ts: m.ts });
  if (items.length > 24) items = items.slice(0, 24);
  emit();
}

function start(): void { if (!stopFeed) stopFeed = openFeed(handle); }
function stop(): void { if (stopFeed) { stopFeed(); stopFeed = null; } clearAllAlerts(); }

/** Start watching for messages while signed in. Safe to call once at start-up. */
export function initMessageAlerts(): void {
  const sync = (): void => { if (currentUser()) start(); else stop(); };
  onSession(sync);
  void sessionReady().then(sync);
}
