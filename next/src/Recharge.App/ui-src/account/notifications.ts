/** The bell in the top bar: the hub's notifications for the signed-in account (new mod submissions for admins, review results for uploaders). */
import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { relativeTime } from '../create/format.js';
import { libraryRoute } from '../community/format.js';
import { hubJson } from '../community/api.js';
import { go } from '../navigation.js';
import { currentUser, onSession } from './session.js';

export interface HubNotification {
  id: number;
  type: string;
  title: string;
  body: string;
  kind: string;
  targetId: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationList { unread: number; items: HubNotification[] }

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Shapes /api/me/notifications; rows without a numeric id are dropped, and the unread count never goes below what is listed as unread. */
export function normalizeNotifications(json: unknown): NotificationList {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const items: HubNotification[] = [];
  for (const raw of Array.isArray(root.notifications) ? root.notifications : []) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof r.id !== 'number') continue;
    items.push({ id: r.id, type: str(r.type), title: str(r.title) || 'Notification', body: str(r.body), kind: str(r.kind), targetId: str(r.targetId), createdAt: str(r.createdAt), read: r.read === true });
  }
  const listed = items.filter((n) => !n.read).length;
  const unread = typeof root.unread === 'number' && Number.isFinite(root.unread) ? Math.max(root.unread, listed) : listed;
  return { unread, items };
}

/** The badge text on the bell: nothing for zero, 9+ past nine. */
export function badgeText(unread: number): string {
  return unread <= 0 ? '' : unread > 9 ? '9+' : String(unread);
}

/** Where a notification leads: a submission waiting for review opens the review list, anything about an item opens that item. */
export function notificationRoute(n: Pick<HubNotification, 'type' | 'kind' | 'targetId'>): string | null {
  if (n.type === 'mod-submission') return '#/library?kind=mods&view=uploads';
  if (n.type === 'submission-rejected') return '#/library?kind=' + (n.kind || 'mods') + '&view=uploads';
  return libraryRoute(n.kind, n.targetId);
}

const POLL_MS = 60_000;

/** Wires the bell button: a count badge, a list that opens under it, and a refresh every minute while signed in. */
export function initBell(bell: HTMLElement): void {
  const badge = h('span', { className: 'bell-badge', hidden: true });
  bell.appendChild(badge);
  let state: NotificationList = { unread: 0, items: [] };
  let panel: HTMLElement | null = null;
  let timer = 0;

  function paintBadge(): void {
    const text = badgeText(state.unread);
    badge.textContent = text;
    badge.hidden = !text;
    bell.classList.toggle('has-unread', !!text);
  }

  async function refresh(): Promise<void> {
    if (!currentUser()) { state = { unread: 0, items: [] }; paintBadge(); paintPanel(); return; }
    try {
      state = normalizeNotifications(await hubJson('GET', '/api/me/notifications'));
    } catch {
      return; // offline or the hub is down: keep what is shown
    }
    paintBadge();
    paintPanel();
  }

  async function markRead(ids?: number[]): Promise<void> {
    try {
      await hubJson('POST', '/api/me/notifications/read', ids ? { ids } : {});
    } catch (error) {
      console.error('could not mark notifications read: ' + describeError(error));
    }
    await refresh();
  }

  function closePanel(): void {
    panel?.remove();
    panel = null;
    document.removeEventListener('mousedown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onAway(event: Event): void {
    if (panel && !panel.contains(event.target as Node) && !bell.contains(event.target as Node)) closePanel();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') closePanel();
  }

  function paintPanel(): void {
    if (!panel) return;
    panel.replaceChildren();
    const head = h('div', { className: 'bell-head' }, h('strong', { text: 'Notifications' }));
    if (state.unread > 0) {
      const all = h('button', { className: 'link-btn', text: 'Mark all read', attrs: { type: 'button' } });
      all.addEventListener('click', () => { void markRead(); });
      head.appendChild(all);
    }
    panel.appendChild(head);
    if (!currentUser()) { panel.appendChild(h('p', { className: 'dim bell-empty', text: 'Sign in to see your notifications.' })); return; }
    if (state.items.length === 0) { panel.appendChild(h('p', { className: 'dim bell-empty', text: 'No notifications yet.' })); return; }
    for (const n of state.items) {
      const route = notificationRoute(n);
      const item = h('button', { className: 'bell-item' + (n.read ? '' : ' is-unread'), attrs: { type: 'button' } },
        h('span', { className: 'bell-title', text: n.title }),
        n.body ? h('span', { className: 'bell-body dim', text: n.body }) : null,
        n.createdAt ? h('span', { className: 'bell-when dim', text: relativeTime(n.createdAt) }) : null);
      item.addEventListener('click', () => {
        if (!n.read) void markRead([n.id]);
        closePanel();
        if (route) go(route);
      });
      panel.appendChild(item);
    }
  }

  bell.addEventListener('click', () => {
    if (panel) { closePanel(); return; }
    panel = h('div', { className: 'bell-panel', attrs: { role: 'dialog', 'aria-label': 'Notifications' } });
    document.body.appendChild(panel);
    paintPanel();
    document.addEventListener('mousedown', onAway, true);
    document.addEventListener('keydown', onKey, true);
    void refresh();
  });

  onSession(() => { void refresh(); });
  timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, POLL_MS);
  void timer;
  void refresh();
}
