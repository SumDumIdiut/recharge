/** Conversations with realtime messages. */
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { toast } from '../components/toast.js';
import { avatar } from '../components/avatar.js';
import { describeError } from '../bridge.js';
import { icon } from '../icons.js';
import { currentUser } from '../account/session.js';
import { fallbackColor } from '../community/people.js';
import { libraryRoute, profileRoute } from '../community/format.js';
import type { View } from '../community/forum.js';
import { socialJson, userPath } from './api.js';
import { openFeed, type FeedEvent } from './events.js';
import {
  LIM, mergeMessage, messageTime, normalizeConversations, normalizeFriends, normalizeMessage, normalizeMessages, presenceLabel, stateOf,
  validateMessage, type Card, type Conversation, type Message, type PresenceState,
} from './model.js';

interface Entry { username: string; last: Message | null; unread: number; state: PresenceState; detail: string }

function cardNode(card: Card): HTMLElement {
  const kind = card.type === 'lobby' ? 'Lobby' : card.type === 'skin' ? 'Skin' : 'Map';
  const node = h('div', { className: 'msg-card' });
  node.appendChild(icon(card.type === 'lobby' ? 'lobbies' : card.type === 'skin' ? 'user' : 'map', 22));
  node.appendChild(h('div', { className: 'msg-card-text' }, h('div', { className: 'msg-card-kind dim', text: kind }), h('div', { className: 'msg-card-name', text: card.name || card.id })));
  const href = card.type === 'lobby' ? '#/lobbies' : libraryRoute(card.type === 'skin' ? 'skin' : 'map', card.id);
  if (href) node.appendChild(button(card.type === 'lobby' ? 'Join' : 'Open', { kind: 'secondary', onClick: () => go(href) }));
  return node;
}

export function messagesView(initialUser?: string): View {
  const me = currentUser()?.username || '';
  const root = h('div', { className: 'social messages' });
  const listBox = h('aside', { className: 'conv-list', attrs: { 'aria-label': 'Conversations' } });
  const pane = h('section', { className: 'conv-pane' });
  root.append(listBox, pane);

  let entries: Entry[] = [];
  let current = initialUser || '';
  let thread: Message[] = [];
  let hasMore = false;
  let disposed = false;
  let loadedList = false;
  let sequence = 0;
  let reload = 0;
  let readSent = 0;

  const threadEl = h('div', { className: 'thread-scroll', attrs: { 'aria-live': 'polite' } });
  const headEl = h('header', { className: 'thread-head' });
  const area = h('textarea', { className: 'input textarea composer-input', attrs: { rows: '2', placeholder: 'Write a message', 'aria-label': 'Message' } });
  const count = h('span', { className: 'form-count dim' });
  const sendBtn = button('Send', { kind: 'primary', icon: 'forum', type: 'submit' });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const composer = h('form', { className: 'composer' }, area, h('div', { className: 'composer-row' }, count, error, sendBtn));

  function entryFor(name: string): Entry | undefined {
    return entries.find((e) => e.username.toLowerCase() === name.toLowerCase());
  }

  function sortEntries(): void {
    entries.sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0) || a.username.localeCompare(b.username));
  }

  function paintList(): void {
    listBox.replaceChildren();
    listBox.appendChild(h('h2', { className: 'conv-title', text: 'Messages' }));
    if (!loadedList) return;
    if (entries.length === 0) {
      listBox.appendChild(h('p', { className: 'dim conv-empty', text: 'No conversations yet. Add a friend, then message them from here.' }));
      return;
    }
    for (const e of entries) {
      const item = h('button', { className: 'conv-item' + (e.username.toLowerCase() === current.toLowerCase() ? ' is-on' : ''), attrs: { type: 'button' } });
      item.appendChild(avatar(e.username, fallbackColor(e.username)));
      const text = h('div', { className: 'conv-text' });
      text.appendChild(h('div', { className: 'conv-name' }, h('span', { className: 'presence-dot is-' + e.state }), e.username));
      text.appendChild(h('div', { className: 'conv-last dim', text: e.last ? (e.last.card && !e.last.text ? '[' + e.last.card.type + ' card]' : e.last.text) : 'Say hello' }));
      item.appendChild(text);
      if (e.unread > 0) item.appendChild(h('span', { className: 'conv-badge', text: e.unread > 99 ? '99+' : String(e.unread) }));
      item.addEventListener('click', () => void select(e.username));
      listBox.appendChild(item);
    }
  }

  function paintHead(): void {
    headEl.replaceChildren();
    const e = entryFor(current);
    headEl.appendChild(avatar(current, fallbackColor(current)));
    const text = h('div', { className: 'thread-who' });
    text.appendChild(h('a', { className: 'social-name', text: current, attrs: { href: profileRoute(current) } }));
    text.appendChild(h('div', { className: 'social-sub' }, h('span', { className: 'presence-dot is-' + (e ? e.state : 'offline') }), presenceLabel(e ? e.state : 'offline', e ? e.detail : '')));
    headEl.appendChild(text);
  }

  function paintThread(keepBottom = true): void {
    const nearBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 80;
    const top = threadEl.scrollHeight;
    threadEl.replaceChildren();
    if (hasMore) threadEl.appendChild(button('Load older messages', { kind: 'ghost', onClick: () => void older() }));
    if (thread.length === 0) threadEl.appendChild(h('p', { className: 'dim thread-empty', text: 'No messages yet. Say hello.' }));
    for (const m of thread) {
      const mine = m.from.toLowerCase() === me.toLowerCase();
      const bubble = h('div', { className: 'msg ' + (mine ? 'is-mine' : 'is-theirs') });
      if (m.text) bubble.appendChild(h('div', { className: 'msg-text', text: m.text }));
      if (m.card) bubble.appendChild(cardNode(m.card));
      bubble.appendChild(h('div', { className: 'msg-time dim', text: messageTime(m.ts) }));
      threadEl.appendChild(bubble);
    }
    if (keepBottom && nearBottom) threadEl.scrollTop = threadEl.scrollHeight;
    else if (!keepBottom) threadEl.scrollTop = threadEl.scrollHeight - top;
  }

  function paintPane(): void {
    pane.replaceChildren();
    if (!current) {
      pane.appendChild(emptyState('forum', 'Pick a conversation', 'Choose someone on the left to read and send messages.'));
      return;
    }
    paintHead();
    pane.append(headEl, threadEl, composer);
    paintThread();
  }

  async function markRead(): Promise<void> {
    const last = thread.length > 0 ? thread[thread.length - 1].id : 0;
    const e = entryFor(current);
    if (!current || last <= readSent) return;
    readSent = last;
    if (e && e.unread > 0) { e.unread = 0; paintList(); }
    try { await socialJson('POST', '/api/conversations/' + userPath(current) + '/read', { upTo: last }); } catch { /* shown next time */ }
  }

  async function loadThread(): Promise<void> {
    const name = current;
    if (!name) return;
    const mine = ++sequence;
    try {
      const page = normalizeMessages(await socialJson('GET', '/api/conversations/' + userPath(name) + '/messages?limit=50'));
      if (disposed || mine !== sequence || name !== current) return;
      thread = page.messages;
      hasMore = page.hasMore;
      paintThread();
      void markRead();
    } catch (e) {
      if (disposed || mine !== sequence) return;
      threadEl.replaceChildren(errorState('Messages could not be loaded (' + describeError(e) + ').', () => { void loadThread(); }));
    }
  }

  async function older(): Promise<void> {
    if (!current || thread.length === 0) return;
    try {
      const page = normalizeMessages(await socialJson('GET', '/api/conversations/' + userPath(current) + '/messages?limit=50&before=' + thread[0].id));
      thread = page.messages.concat(thread);
      hasMore = page.hasMore;
      paintThread(false);
    } catch (e) {
      toast('Could not load older messages: ' + describeError(e), 'error');
    }
  }

  async function select(name: string): Promise<void> {
    current = name;
    thread = [];
    hasMore = false;
    readSent = 0;
    if (!entryFor(name)) { entries.unshift({ username: name, last: null, unread: 0, state: 'offline', detail: '' }); }
    paintList();
    paintPane();
    await loadThread();
    area.focus();
  }

  async function loadList(): Promise<void> {
    try {
      const [convs, friends] = await Promise.all([
        socialJson('GET', '/api/conversations').then(normalizeConversations),
        socialJson('GET', '/api/friends').then(normalizeFriends),
      ]);
      if (disposed) return;
      const byName = new Map<string, Entry>();
      for (const c of convs.conversations as Conversation[]) byName.set(c.username.toLowerCase(), { username: c.username, last: c.last, unread: c.unread, state: c.state, detail: '' });
      for (const f of friends.friends) {
        const key = f.username.toLowerCase();
        const e = byName.get(key);
        if (e) { e.state = f.state; e.detail = f.detail; } else byName.set(key, { username: f.username, last: null, unread: 0, state: f.state, detail: f.detail });
      }
      if (current && !byName.has(current.toLowerCase())) byName.set(current.toLowerCase(), { username: current, last: null, unread: 0, state: 'offline', detail: '' });
      entries = Array.from(byName.values());
      const open = byName.get(current.toLowerCase());
      if (open && readSent > 0) open.unread = 0;
      sortEntries();
      loadedList = true;
      paintList();
      if (current) paintHead();
    } catch (e) {
      if (disposed) return;
      if (!loadedList) listBox.replaceChildren(errorState('Conversations could not be loaded (' + describeError(e) + ').', () => { void loadList(); }));
    }
  }

  function updateCount(): void {
    const length = area.value.replace(/\r\n?/g, '\n').trim().length;
    count.textContent = length + ' / ' + LIM.message;
    count.classList.toggle('is-over', length > LIM.message);
  }
  area.addEventListener('input', updateCount);
  area.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const problem = validateMessage(area.value);
    error.hidden = !problem;
    error.textContent = problem || '';
    if (problem || !current) return;
    sendBtn.disabled = true;
    const text = area.value.trim();
    socialJson('POST', '/api/conversations/' + userPath(current) + '/messages', { text }).then((raw) => {
      area.value = '';
      updateCount();
      thread = mergeMessage(thread, normalizeMessage(raw));
      paintThread();
      void loadList();
    }).catch((e) => {
      error.hidden = false;
      error.textContent = describeError(e);
    }).finally(() => { sendBtn.disabled = false; area.focus(); });
  });
  updateCount();

  const stop = openFeed((event: FeedEvent) => {
    if (disposed) return;
    if (event.type === 'message') {
      const m = normalizeMessage(event.message);
      const other = m.from.toLowerCase() === me.toLowerCase() ? m.to : m.from;
      let e = entryFor(other);
      if (!e) { e = { username: other, last: null, unread: 0, state: 'offline', detail: '' }; entries.push(e); }
      if (!e.last || m.id >= e.last.id) e.last = m;
      if (other.toLowerCase() === current.toLowerCase()) {
        thread = mergeMessage(thread, m);
        paintThread();
        void markRead();
      } else if (m.to.toLowerCase() === me.toLowerCase()) {
        e.unread += 1;
      }
      sortEntries();
      paintList();
    } else if (event.type === 'presence') {
      const e = entryFor(String(event.username || ''));
      if (e) { e.state = stateOf(event.state); e.detail = String(event.detail || ''); paintList(); if (current) paintHead(); }
    } else if (event.type === 'friends' || event.type === 'reset' || event.type === 'connected') {
      window.clearTimeout(reload);
      reload = window.setTimeout(() => { void loadList(); if (current) void loadThread(); }, 150);
    }
  });

  paintList();
  paintPane();
  const ready = Promise.all([loadList(), current ? loadThread() : Promise.resolve()]).then(() => undefined);

  return {
    element: root,
    ready,
    dispose(): void { disposed = true; window.clearTimeout(reload); stop(); },
  };
}
