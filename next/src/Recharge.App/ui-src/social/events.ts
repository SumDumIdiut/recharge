/** The realtime feed: the app keeps one socket to the social server; this polls its event list while a view is open. */
import { call } from '../bridge.js';
import { cleanText, normalizeReactions, type Reactions } from './model.js';

export interface FeedEvent { type: string; seq?: number; [key: string]: unknown }
export interface ReactionEvent extends FeedEvent { convId: string; messageId: number; emoji: string; reactions: Reactions }
export interface EditEvent extends FeedEvent { convId: string; messageId: number; text: string; editedAt: number }
export interface DeleteEvent extends FeedEvent { convId: string; messageId: number; deletedAt: number }
type Listener = (event: FeedEvent) => void;

/** Parse a reaction push, or null when it is malformed. */
export function reactionEvent(event: FeedEvent): ReactionEvent | null {
  const convId = typeof event.convId === 'string' ? event.convId : '';
  const messageId = typeof event.messageId === 'number' ? event.messageId : 0;
  const emoji = typeof event.emoji === 'string' ? event.emoji : '';
  if (!convId || !Number.isInteger(messageId) || messageId <= 0 || !emoji) return null;
  return { ...event, type: 'reaction', convId, messageId, emoji, reactions: normalizeReactions(event.reactions) };
}

/** Apply a reaction push to the open thread via `update`; returns true when it was handled. */
export function handleReaction(event: FeedEvent, openId: string, update: (messageId: number, reactions: Reactions) => void): boolean {
  const r = reactionEvent(event);
  if (!r || !openId || r.convId !== openId) return false;
  update(r.messageId, r.reactions);
  return true;
}

/** Parse an edit push, or null when it is malformed. */
export function editEvent(event: FeedEvent): EditEvent | null {
  const convId = typeof event.convId === 'string' ? event.convId : '';
  const messageId = typeof event.messageId === 'number' ? event.messageId : 0;
  if (!convId || !Number.isInteger(messageId) || messageId <= 0) return null;
  const text = cleanText(typeof event.text === 'string' ? event.text : '');
  const editedAt = typeof event.editedAt === 'number' ? event.editedAt : 0;
  return { ...event, type: 'edit', convId, messageId, text, editedAt };
}

/** Apply an edit push to the open thread via `update`; returns true when it was handled. */
export function handleEdit(event: FeedEvent, openId: string, update: (messageId: number, text: string, editedAt: number) => void): boolean {
  const e = editEvent(event);
  if (!e || !openId || e.convId !== openId) return false;
  update(e.messageId, e.text, e.editedAt);
  return true;
}

/** Parse a delete push, or null when it is malformed. */
export function deleteEvent(event: FeedEvent): DeleteEvent | null {
  const convId = typeof event.convId === 'string' ? event.convId : '';
  const messageId = typeof event.messageId === 'number' ? event.messageId : 0;
  if (!convId || !Number.isInteger(messageId) || messageId <= 0) return null;
  const deletedAt = typeof event.deletedAt === 'number' ? event.deletedAt : 0;
  return { ...event, type: 'delete', convId, messageId, deletedAt };
}

/** Apply a delete push to the open thread via `update`; returns true when it was handled. */
export function handleDelete(event: FeedEvent, openId: string, update: (messageId: number, deletedAt: number) => void): boolean {
  const d = deleteEvent(event);
  if (!d || !openId || d.convId !== openId) return false;
  update(d.messageId, d.deletedAt);
  return true;
}

export const POLL_MS = 1000;
export const KEEPALIVE_MS = 8000;
export const HIDDEN_POLL_MS = 5000;

interface EventsReply { seq: number; connected: boolean; reset: boolean; events: FeedEvent[] }

const listeners = new Set<Listener>();
let since: number | null = null;
let timer = 0;
let keep = 0;
let busy = false;
let connected = false;

export function feedConnected(): boolean {
  return connected;
}

function dispatch(event: FeedEvent): void {
  for (const listener of Array.from(listeners)) {
    try { listener(event); } catch (error) { console.error('feed listener failed', error); }
  }
}

async function watch(on: boolean): Promise<void> {
  try { await call('social.watch', { on }); } catch { /* the next poll reports the problem */ }
}

async function tick(): Promise<void> {
  if (listeners.size === 0 || busy) return;
  busy = true;
  try {
    // The first poll only learns the current position, so old events are not replayed.
    const reply = await call<EventsReply>('social.events', { since: since === null ? Number.MAX_SAFE_INTEGER : since });
    const first = since === null;
    since = reply.seq;
    if (connected !== reply.connected) {
      connected = reply.connected;
      dispatch({ type: connected ? 'connected' : 'disconnected' });
    }
    if (!first) {
      if (reply.reset) dispatch({ type: 'reset' });
      for (const event of reply.events || []) dispatch(event);
    }
  } catch {
    if (connected) { connected = false; dispatch({ type: 'disconnected' }); }
  } finally {
    busy = false;
    if (listeners.size > 0) timer = window.setTimeout(() => void tick(), document.hidden ? HIDDEN_POLL_MS : POLL_MS);
  }
}

/** Start listening. Returns the function that stops. The socket runs while at least one listener is open. */
export function openFeed(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    since = null;
    void watch(true);
    keep = window.setInterval(() => void watch(true), KEEPALIVE_MS);
    void tick();
  }
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    window.clearTimeout(timer);
    window.clearInterval(keep);
    connected = false;
    void watch(false);
  };
}

/** Tell your friends what you are doing. */
export function setPresence(state: string, detail = '', join = ''): void {
  void call('social.presence', { state, detail, join }).catch(() => undefined);
}
