/** The realtime feed: the app keeps one socket to the social server; this polls its event list while a view is open. */
import { call } from '../bridge.js';

export interface FeedEvent { type: string; seq?: number; [key: string]: unknown }
type Listener = (event: FeedEvent) => void;

export const POLL_MS = 1000;
export const KEEPALIVE_MS = 8000;

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
    if (listeners.size > 0) timer = window.setTimeout(() => void tick(), POLL_MS);
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
