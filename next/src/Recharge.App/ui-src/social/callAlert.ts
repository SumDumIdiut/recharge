/** App-wide call ringing: a persistent prompt with Accept / Decline, independent of the Messages view. */
import { h } from '../dom.js';
import { button } from '../components/button.js';
import { playerAvatar } from '../community/people.js';
import { currentUser, onSession, sessionReady } from '../account/session.js';
import { go } from '../navigation.js';
import { messagesRoute } from './model.js';
import { openFeed, type FeedEvent } from './events.js';
import { sendFrame, type CallKind } from './voice.js';

export const CALL_ACCEPT_EVENT = 'recharge:call-accept';
const RING_MS = 30000;

interface Ring { convId: string; node: HTMLElement; timer: number }
interface Pending { convId: string; kind: CallKind }

const rings = new Map<string, Ring>();
let pending: Pending | null = null;
let stopFeed: (() => void) | null = null;

/** The Messages view consumes this after navigating, so it can join and dock the call UI. */
export function requestCallJoin(convId: string, kind: CallKind): void {
  pending = { convId, kind };
  // Let navigation mount the target Messages view before it consumes the handoff.
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(CALL_ACCEPT_EVENT, { detail: pending })), 0);
}

export function takeCallJoin(convId: string): Pending | null {
  if (!pending || pending.convId !== convId) return null;
  const next = pending;
  pending = null;
  return next;
}

function frameOf(event: FeedEvent, type: string): { convId: string; from: string; kind: CallKind } | null {
  if (event.type !== type) return null;
  const convId = typeof event.convId === 'string' ? event.convId : '';
  const from = typeof event.from === 'string' ? event.from : '';
  if (!convId || !from) return null;
  return { convId, from, kind: event.kind === 'video' ? 'video' : 'audio' };
}

function dismiss(convId: string): void {
  const ring = rings.get(convId);
  if (!ring) return;
  window.clearTimeout(ring.timer);
  ring.node.remove();
  rings.delete(convId);
}

function box(): HTMLElement {
  let node = document.getElementById('toast-container');
  if (!node) {
    node = h('div', { className: 'toast-container', attrs: { id: 'toast-container', 'aria-live': 'polite', 'aria-atomic': 'false' } });
    document.body.appendChild(node);
  }
  return node;
}

function show(convId: string, from: string, kind: CallKind): void {
  dismiss(convId);
  const node = h('div', { className: 'call-prompt', attrs: { role: 'alert' } });
  const av = h('span', { className: 'call-av' });
  av.appendChild(playerAvatar({ username: from, avatar_url: '/api/users/' + encodeURIComponent(from) + '/avatar', frame: 'none', frame_colors: [] }, 44));
  node.append(
    h('div', { className: 'call-info' }, av, h('div', { className: 'call-text' },
      h('strong', { text: from }),
      h('span', { className: 'dim', text: (kind === 'video' ? 'Video call' : 'Audio call') + ' — incoming' }))),
    h('div', { className: 'call-actions' },
      button('Decline', { kind: 'danger', icon: 'x', onClick: () => {
        sendFrame({ type: 'call.decline', convId });
        dismiss(convId);
      } }),
      button('Accept', { kind: 'primary', icon: kind === 'video' ? 'camera' : 'phone', onClick: () => {
        requestCallJoin(convId, kind);
        dismiss(convId);
        go(messagesRoute(convId));
      } })),
  );
  box().appendChild(node);
  const timer = window.setTimeout(() => dismiss(convId), RING_MS);
  rings.set(convId, { convId, node, timer });
}

function handle(event: FeedEvent): void {
  const me = currentUser()?.username || '';
  const ring = frameOf(event, 'call.ring');
  if (ring) {
    if (ring.from.toLowerCase() !== me.toLowerCase()) show(ring.convId, ring.from, ring.kind);
    return;
  }
  if (event.type === 'call.ended' || event.type === 'call.declined') {
    const id = typeof event.convId === 'string' ? event.convId : '';
    if (id) dismiss(id);
    return;
  }
  if (event.type === 'reset' || event.type === 'disconnected') for (const id of Array.from(rings.keys())) dismiss(id);
}

function start(): void { if (!stopFeed) stopFeed = openFeed(handle); }
function stop(): void {
  if (stopFeed) { stopFeed(); stopFeed = null; }
  for (const id of Array.from(rings.keys())) dismiss(id);
}

/** Start watching for calls while signed in. Safe to call once at start-up. */
export function initCallAlerts(): void {
  const sync = (): void => { if (currentUser()) start(); else stop(); };
  onSession(sync);
  void sessionReady().then(sync);
}
