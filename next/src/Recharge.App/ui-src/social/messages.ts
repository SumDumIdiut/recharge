/** Messages: conversation list (DMs and groups), thread with history, replies, optimistic sends, live updates, read state. The rules live in convo.ts. */
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { authorName } from '../components/itemCard.js';
import { describeError } from '../bridge.js';
import { icon } from '../icons.js';
import { currentUser } from '../account/session.js';
import { fallbackColor, playerAvatar } from '../community/people.js';
import { hubAuthor } from '../community/hubUsers.js';
import { libraryRoute, profileRoute } from '../community/format.js';
import type { View } from '../community/forum.js';
import { SocialError, socialJson, userPath } from './api.js';
import { openFeed, type FeedEvent } from './events.js';
import {
  LIM, cleanText, isConvId, messagesRoute, normalizeConversation, normalizeConversations, normalizeFriends, normalizeMessage, normalizeMessages,
  presenceLabel, stateOf, validateGroupName, validateMessage, type Card, type FriendsData, type ReplyRef,
} from './model.js';
import {
  Drafts, addPending, applyConversation, applyMessage, applyPresence, applyRead, buildEntries, clock, convIdOf, dmId, filterEntries, findEntry,
  groupThread, isMine, isRetryable, listStamp, mergeThread, newCid, otherMember, pendingMessage, prependOlder, previewOf, removeEntry,
  removePending, replaceHistory, replyRefOf, replySnippet, setSendState, shouldMarkRead, statusFor, totalUnread, unreadLabel,
  type Entry, type ThreadMessage,
} from './convo.js';
import { refreshUnread, setUnread } from './unread.js';
import { setActiveConversation } from './messageAlerts.js';

const PAGE = 40;
const drafts = new Drafts();

/** A person's own picture and frame (hub image, then their profile look on top), at a fixed size. Falls back to coloured initials. */
function userAvatar(name: string, size = 32): HTMLElement {
  const slot = h('span', { className: 'msg-av', attrs: { 'data-user': name } });
  slot.style.setProperty('--sz', size + 'px');
  slot.appendChild(playerAvatar({ username: name, avatar_url: '/api/users/' + encodeURIComponent(name) + '/avatar', frame: 'none', frame_colors: [] }, size));
  void hubAuthor(name).then((author) => {
    if (author && slot.isConnected) slot.replaceChildren(playerAvatar(author, size));
  });
  return slot;
}

/** A name in the person's own colour (their profile look, else the hub name colour, else a stable fallback colour). */
function userName(name: string, className = 'msg-who'): HTMLElement {
  const wrap = h('span', { className });
  wrap.style.color = fallbackColor(name);
  wrap.appendChild(authorName(name, null, 'author'));
  void hubAuthor(name).then((author) => {
    if (author && author.name_color && wrap.isConnected) wrap.replaceChildren(authorName(name, author.name_color, 'author'));
  });
  return wrap;
}

/** The avatar of a group: a tile in the group's colour with the people glyph. */
function groupTile(name: string, size = 36): HTMLElement {
  const tile = h('span', { className: 'group-tile' });
  tile.style.setProperty('--sz', size + 'px');
  tile.style.setProperty('--gc', fallbackColor(name));
  tile.appendChild(icon('users', Math.round(size * 0.55)));
  return tile;
}

const convPath = (key: string): string => '/api/conversations/' + userPath(key);

/** A DM is addressed by the other person's name (which works before the chat has any messages); a group by its id. */
function pathKey(e: Entry | undefined, id: string): string {
  return e && e.kind === 'dm' && e.name && !isConvId(e.name) ? e.name : id;
}

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
  let friendsData: FriendsData | null = null;
  // The open conversation: by id (`dm:`/`g:`). Opening by a bare username works out the DM's id from the two names.
  let current = initialUser ? (isConvId(initialUser) ? initialUser : dmId(me, initialUser)) : '';
  let currentName = initialUser && !isConvId(initialUser) ? initialUser : (initialUser || '');
  let replyTo: ReplyRef | null = null;
  let thread: ThreadMessage[] = [];
  let hasMore = false;
  let loadingOlder = false;
  let loadedList = false;
  let threadReady = false;
  let threadFailed = false;
  let disposed = false;
  let query = '';
  let seenUpTo = 0;
  let readMark = 0;            // the "new messages" line: what you had read when you opened the chat
  let readSent = 0;
  let sequence = 0;
  let reload = 0;
  let queue: Promise<void> = Promise.resolve();
  const refused = new Set<string>();   // unsent messages the server turned down: retrying them would not help
  let offline = false;

  const cur = (): Entry | undefined => findEntry(entries, current);
  const isGroup = (): boolean => (cur()?.kind === 'group') || current.startsWith('g:');

  // ---- pieces that stay put ----
  const listHead = h('div', { className: 'conv-top' });
  const searchBox = h('input', { className: 'input conv-search', attrs: { type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search conversations', maxlength: String(LIM.username), autocomplete: 'off' } });
  const newBtn = button('New group', { kind: 'secondary', icon: 'plus', onClick: () => newGroup() });
  newBtn.classList.add('conv-new');
  const listItems = h('div', { className: 'conv-items' });
  listHead.append(h('div', { className: 'conv-titlebar' }, h('h2', { className: 'conv-title', text: 'Messages' }), newBtn), searchBox);
  listBox.append(listHead, listItems);

  const banner = h('div', { className: 'msg-banner', attrs: { role: 'status' }, hidden: true }, 'Reconnecting... messages will send when you are back online.');
  const headEl = h('header', { className: 'thread-head' });
  const threadEl = h('div', { className: 'thread-scroll', attrs: { 'aria-live': 'polite', role: 'log', 'aria-label': 'Messages' } });
  const jump = h('button', { className: 'jump-new', attrs: { type: 'button' }, hidden: true, text: 'New messages' });
  const area = h('textarea', { className: 'input textarea composer-input', attrs: { rows: '1', placeholder: 'Write a message', 'aria-label': 'Message', maxlength: String(LIM.message * 2) } });
  const count = h('span', { className: 'form-count dim' });
  const sendBtn = button('Send', { kind: 'primary', icon: 'forum', type: 'submit' });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const replyBar = h('div', { className: 'reply-preview', hidden: true });
  const composer = h('form', { className: 'composer' }, replyBar, h('div', { className: 'composer-line' }, area, sendBtn), h('div', { className: 'composer-row' }, error, count));
  const threadBox = h('div', { className: 'thread-box' }, threadEl, jump);

  // ---- list ----
  function rowAvatar(e: Entry): HTMLElement {
    if (e.kind === 'group') return h('span', { className: 'conv-av' }, groupTile(e.name, 40));
    return h('span', { className: 'conv-av' }, userAvatar(e.name, 40), h('span', { className: 'presence-dot conv-presence is-' + e.state }));
  }

  function paintList(): void {
    listItems.replaceChildren();
    if (!loadedList) { listItems.appendChild(h('p', { className: 'dim conv-empty', text: 'Loading...' })); return; }
    if (entries.length === 0) {
      listItems.appendChild(h('p', { className: 'dim conv-empty', text: 'No conversations yet. Add a friend, then message them from here, or start a group.' }));
      return;
    }
    const shown = filterEntries(entries, query);
    if (shown.length === 0) { listItems.appendChild(h('p', { className: 'dim conv-empty', text: 'Nothing matches "' + query.trim() + '".' })); return; }
    for (const e of shown) {
      const on = e.id === current;
      const item = h('button', { className: 'conv-item' + (on ? ' is-on' : '') + (e.unread > 0 ? ' is-unread' : '') + (e.kind === 'group' ? ' is-group' : ''), attrs: { type: 'button', 'aria-current': on ? 'true' : 'false' } });
      const nameEl = e.kind === 'group' ? h('span', { className: 'conv-name', text: e.name }) : h('span', { className: 'conv-name' }, userName(e.name, 'conv-who'));
      const top = h('div', { className: 'conv-line' }, nameEl, h('span', { className: 'conv-stamp dim', text: e.last ? listStamp(e.last.ts) : '' }));
      const sub = e.kind === 'group' && !e.last ? (e.members.length || 0) + ' members' : previewOf(e.last, me, e.kind === 'group');
      const bottom = h('div', { className: 'conv-line' }, h('span', { className: 'conv-last dim', text: sub }));
      if (e.unread > 0) bottom.appendChild(h('span', { className: 'conv-badge', text: unreadLabel(e.unread), attrs: { 'aria-label': e.unread + ' unread' } }));
      item.append(rowAvatar(e), h('div', { className: 'conv-text' }, top, bottom));
      item.addEventListener('click', () => void select(e.id, e.name));
      listItems.appendChild(item);
    }
  }

  function syncUnread(): void {
    if (loadedList) setUnread(totalUnread(entries));
  }

  // ---- thread header ----
  const amAdmin = (e: Entry | undefined): boolean => !!e && e.members.some((m) => m.admin && m.username.toLowerCase() === me.toLowerCase());

  function paintHead(): void {
    headEl.replaceChildren();
    const e = cur();
    const back = h('button', { className: 'thread-back', attrs: { type: 'button', 'aria-label': 'Back to conversations' }, text: '‹ Back' });
    back.addEventListener('click', () => leave());
    headEl.appendChild(back);
    if (isGroup()) {
      const name = e ? e.name : currentName;
      headEl.appendChild(groupTile(name, 40));
      const text = h('div', { className: 'thread-who' });
      text.appendChild(h('span', { className: 'thread-group-name', text: name }));
      const count = e ? e.members.length : 0;
      text.appendChild(h('div', { className: 'social-sub', text: count ? count + (count === 1 ? ' member' : ' members') : '' }));
      headEl.appendChild(text);
      if (e && e.members.length > 0) {
        const stack = h('div', { className: 'member-stack', attrs: { 'aria-hidden': 'true' } });
        for (const m of e.members.slice(0, 5)) stack.appendChild(userAvatar(m.username, 26));
        if (e.members.length > 5) stack.appendChild(h('span', { className: 'member-more', text: '+' + (e.members.length - 5) }));
        headEl.appendChild(stack);
      }
      headEl.appendChild(groupMenu(e));
      return;
    }
    const name = e ? e.name : currentName;
    const state = e ? e.state : 'offline';
    headEl.appendChild(userAvatar(name, 40));
    const text = h('div', { className: 'thread-who' });
    text.appendChild(h('a', { className: 'social-name', attrs: { href: profileRoute(name) } }, userName(name, 'thread-name')));
    text.appendChild(h('div', { className: 'social-sub' }, h('span', { className: 'presence-dot is-' + state }), presenceLabel(state, e ? e.detail : '')));
    headEl.appendChild(text);
  }

  // ---- group menu and dialogs ----
  let closeMenu: (() => void) | null = null;

  function groupMenu(e: Entry | undefined): HTMLElement {
    const wrap = h('div', { className: 'thread-menu' });
    const toggle = h('button', { className: 'icon-btn thread-menu-btn', title: 'Group options', attrs: { type: 'button', 'aria-label': 'Group options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
    toggle.appendChild(h('span', { className: 'dots', text: '⋯' }));
    const menu = h('div', { className: 'thread-menu-list', attrs: { role: 'menu' }, hidden: true });
    const add = (label: string, run: () => void, danger = false): void => {
      const item = h('button', { className: 'thread-menu-item' + (danger ? ' is-danger' : ''), attrs: { type: 'button', role: 'menuitem' }, text: label });
      item.addEventListener('click', () => { close(); run(); });
      menu.appendChild(item);
    };
    add('Members', () => showMembers());
    if (amAdmin(e)) { add('Add member', () => addMember()); add('Rename group', () => renameGroup()); }
    add('Leave group', () => leaveGroup(), true);
    function close(): void { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); closeMenu = null; }
    function outside(event: Event): void { if (!wrap.contains(event.target as Node)) close(); }
    toggle.addEventListener('click', () => {
      if (!menu.hidden) { close(); return; }
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside, true);
      closeMenu = close;
      (menu.querySelector('button') as HTMLElement | null)?.focus();
    });
    menu.addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); toggle.focus(); } });
    wrap.append(toggle, menu);
    return wrap;
  }

  /** Close a modal the proper way (its own close button), so focus returns and listeners go. */
  function closeModal(overlay: HTMLElement): void {
    (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
  }

  /** A list of friends to tick (or pick one of). */
  function picker(candidates: string[], multi: boolean, empty: string): { node: HTMLElement; selected: () => string[] } {
    const box = h('div', { className: 'pick-list', attrs: { role: multi ? 'group' : 'radiogroup', 'aria-label': 'Friends' } });
    const chosen = new Set<string>();
    if (candidates.length === 0) box.appendChild(h('p', { className: 'dim', text: empty }));
    for (const name of candidates) {
      const input = h('input', { attrs: { type: multi ? 'checkbox' : 'radio', name: 'pick', value: name } });
      input.addEventListener('change', () => {
        if (!multi) chosen.clear();
        if (input.checked) chosen.add(name); else chosen.delete(name);
      });
      box.appendChild(h('label', { className: 'pick-item' }, input, userAvatar(name, 28), userName(name, 'pick-name')));
    }
    return { node: box, selected: () => Array.from(chosen) };
  }

  const friendNames = (): string[] => (friendsData ? friendsData.friends.map((f) => f.username) : []);

  function newGroup(): void {
    const nameInput = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'Group name (optional)', 'aria-label': 'Group name', maxlength: '60', autocomplete: 'off' } });
    const pick = picker(friendNames(), true, 'Add some friends first, then you can start a group with them.');
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    const body = h('div', { className: 'group-form' }, nameInput, h('p', { className: 'dim pick-hint', text: 'Choose who to add' }), pick.node, err);
    let busy = false;
    const overlay = modal({
      title: 'New group',
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create group', kind: 'primary',
          onClick: () => {
            const members = pick.selected();
            const problem = members.length === 0 ? 'Pick at least one friend.' : validateGroupName(nameInput.value);
            err.hidden = !problem; err.textContent = problem || '';
            if (problem || busy) return false;
            busy = true;
            socialJson('POST', '/api/conversations', { name: nameInput.value.trim(), members }).then((raw) => {
              const conv = normalizeConversation(raw);
              if (!conv) throw new SocialError(0, 'The server sent something unreadable.');
              entries = applyConversation(entries, conv);
              closeModal(overlay);
              void select(conv.id, conv.name);
            }).catch((e) => { busy = false; err.hidden = false; err.textContent = describeError(e); });
            return false;
          },
        },
      ],
    });
  }

  function takeConversation(raw: unknown): void {
    const conv = normalizeConversation(raw);
    if (!conv) return;
    entries = applyConversation(entries, conv);
    paintList();
    if (conv.id === current) { currentName = conv.name; paintHead(); }
  }

  function showMembers(): void {
    const e = cur();
    if (!e) return;
    const admin = amAdmin(e);
    const body = h('div', { className: 'member-list' });
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let overlay: HTMLElement | null = null;
    for (const m of e.members) {
      const row = h('div', { className: 'member-row' }, userAvatar(m.username, 32), h('a', { className: 'social-name', attrs: { href: profileRoute(m.username) } }, userName(m.username, 'member-name')));
      if (m.admin) row.appendChild(h('span', { className: 'member-tag dim', text: 'Owner' }));
      row.appendChild(h('span', { className: 'member-state dim' }, h('span', { className: 'presence-dot is-' + m.state }), presenceLabel(m.state, '')));
      if (admin && m.username.toLowerCase() !== me.toLowerCase()) {
        const rm = button('Remove', { kind: 'ghost', onClick: () => {
          rm.disabled = true;
          socialJson('DELETE', convPath(e.id) + '/members/' + userPath(m.username)).then(() => {
            entries = entries.map((x) => (x.id === e.id ? { ...x, members: x.members.filter((y) => y.username !== m.username) } : x));
            row.remove();
            paintList(); if (e.id === current) paintHead();
          }).catch((x) => { rm.disabled = false; err.hidden = false; err.textContent = describeError(x); });
        } });
        rm.classList.add('member-remove');
        row.appendChild(rm);
      }
      body.appendChild(row);
    }
    body.appendChild(err);
    overlay = modal({ title: e.name + ' - members', body });
    void overlay;
  }

  function addMember(): void {
    const e = cur();
    if (!e) return;
    const have = new Set(e.members.map((m) => m.username.toLowerCase()));
    const pick = picker(friendNames().filter((n) => !have.has(n.toLowerCase())), false, 'All your friends are already in this group.');
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let busy = false;
    const overlay = modal({
      title: 'Add a member', body: h('div', { className: 'group-form' }, pick.node, err),
      actions: [{ label: 'Cancel' }, {
        label: 'Add', kind: 'primary',
        onClick: () => {
          const [who] = pick.selected();
          if (!who) { err.hidden = false; err.textContent = 'Pick a friend to add.'; return false; }
          if (busy) return false;
          busy = true;
          socialJson('POST', convPath(e.id) + '/members', { username: who }).then((raw) => { takeConversation(raw); closeModal(overlay); })
            .catch((x) => { busy = false; err.hidden = false; err.textContent = describeError(x); });
          return false;
        },
      }],
    });
  }

  function renameGroup(): void {
    const e = cur();
    if (!e) return;
    const input = h('input', { className: 'input', attrs: { type: 'text', 'aria-label': 'Group name', maxlength: '60', autocomplete: 'off' } });
    input.value = e.name;
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let busy = false;
    const overlay = modal({
      title: 'Rename group', body: h('div', { className: 'group-form' }, input, err),
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary',
        onClick: () => {
          const name = input.value.trim();
          const problem = !name ? 'Give the group a name.' : validateGroupName(name);
          if (problem) { err.hidden = false; err.textContent = problem; return false; }
          if (busy) return false;
          busy = true;
          socialJson('POST', convPath(e.id) + '/name', { name }).then((raw) => { takeConversation(raw); closeModal(overlay); })
            .catch((x) => { busy = false; err.hidden = false; err.textContent = describeError(x); });
          return false;
        },
      }],
    });
  }

  function leaveGroup(): void {
    const e = cur();
    if (!e) return;
    modal({
      title: 'Leave group', body: 'Leave "' + e.name + '"? You will stop getting its messages.',
      actions: [{ label: 'Stay' }, {
        label: 'Leave', kind: 'danger',
        onClick: () => {
          socialJson('DELETE', convPath(e.id) + '/members/' + userPath(me)).then(() => {
            entries = removeEntry(entries, e.id);
            if (e.id === current) leave(); else paintList();
            syncUnread();
          }).catch((x) => toast('Could not leave: ' + describeError(x), 'error'));
        },
      }],
    });
  }

  // ---- messages ----
  function setReply(m: ThreadMessage | null): void {
    replyTo = m && m.id > 0 ? replyRefOf(m) : null;
    paintReplyBar();
    if (replyTo) area.focus();
  }

  function paintReplyBar(): void {
    replyBar.replaceChildren();
    replyBar.hidden = !replyTo;
    if (!replyTo) return;
    const cancel = h('button', { className: 'icon-btn reply-cancel', title: 'Cancel reply', attrs: { type: 'button', 'aria-label': 'Cancel reply' } });
    cancel.appendChild(icon('x', 16));
    cancel.addEventListener('click', () => { setReply(null); area.focus(); });
    const who = isMine({ from: replyTo.from }, me) ? 'yourself' : replyTo.from;
    replyBar.append(
      h('div', { className: 'reply-bar-text' }, h('div', { className: 'reply-bar-who' }, 'Replying to ', userName(who === 'yourself' ? me : who, 'reply-name')), h('div', { className: 'reply-bar-snippet dim', text: replySnippet(replyTo) })),
      cancel);
  }

  function jumpTo(id: number): void {
    const node = threadEl.querySelector('[data-key="' + id + '"]') as HTMLElement | null;
    if (!node) { toast('That message is further back - load older messages first.', 'info'); return; }
    node.scrollIntoView({ block: 'center' });
    node.classList.add('is-flash');
    window.setTimeout(() => node.classList.remove('is-flash'), 1500);
  }

  // Discord-style: avatar + coloured name + time on the first message of a sender's run, then flat text lines — the
  // same for your own messages and theirs (no left/right bubbles).
  function messageNode(row: { msg: ThreadMessage; mine: boolean; first: boolean; last: boolean }): HTMLElement {
    const m = row.msg;
    const wrap = h('div', {
      className: 'msg-row' + (row.first ? ' is-first' : '') + (m.state !== 'sent' ? ' is-' + m.state : ''),
      dataset: { key: m.id > 0 ? String(m.id) : m.cid },
    });
    const gutter = h('div', { className: 'msg-gutter' });
    gutter.appendChild(row.first ? userAvatar(m.from, 40) : h('span', { className: 'msg-gutter-time dim', text: clock(m.ts) }));
    const col = h('div', { className: 'msg-col' });
    if (m.replyTo) {
      const quote = h('button', { className: 'msg-quote', attrs: { type: 'button', title: 'Show the original message' } },
        h('span', { className: 'msg-quote-arrow dim', attrs: { 'aria-hidden': 'true' }, text: '↱' }),
        userName(m.replyTo.from, 'msg-quote-who'), h('span', { className: 'msg-quote-text', text: replySnippet(m.replyTo) }));
      quote.style.setProperty('--qc', fallbackColor(m.replyTo.from));
      const target = m.replyTo.id;
      quote.addEventListener('click', () => jumpTo(target));
      col.appendChild(quote);
    }
    if (row.first) {
      col.appendChild(h('div', { className: 'msg-head' },
        userName(m.from, 'msg-who'),
        h('span', { className: 'msg-stamp dim', text: clock(m.ts), title: new Date(m.ts).toLocaleString() })));
    }
    if (m.text) col.appendChild(h('div', { className: 'msg-text', text: m.text }));
    if (m.card) col.appendChild(cardNode(m.card));
    wrap.append(gutter, col);
    if (m.id > 0) {
      const reply = h('button', { className: 'msg-reply-btn', title: 'Reply', attrs: { type: 'button', 'aria-label': 'Reply to ' + m.from } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '↩' }));
      reply.addEventListener('click', () => setReply(m));
      wrap.appendChild(reply);
      col.addEventListener('dblclick', () => setReply(m));
    }
    return wrap;
  }

  function statusNode(): HTMLElement | null {
    const s = statusFor(thread, me, seenUpTo);
    if (!s) return null;
    const node = h('div', { className: 'msg-status dim' + (s.text === 'Not sent' ? ' is-failed' : '') });
    node.appendChild(document.createTextNode(s.text));
    const failed = thread.filter((m) => m.state === 'failed' && isMine(m, me));
    if (failed.length > 0) {
      const last = failed[failed.length - 1];
      node.append(' ', h('span', { className: 'msg-err', text: last.error ? '(' + last.error + ')' : '' }));
      const retry = h('button', { className: 'link-btn', attrs: { type: 'button' }, text: failed.length > 1 ? 'Retry all' : 'Retry' });
      retry.addEventListener('click', () => { for (const f of failed) resend(f.cid); });
      const drop = h('button', { className: 'link-btn', attrs: { type: 'button' }, text: failed.length > 1 ? 'Delete all' : 'Delete' });
      drop.addEventListener('click', () => { for (const f of failed) thread = removePending(thread, f.cid); paintThread(); });
      node.append(' ', retry, ' ', drop);
    }
    return node;
  }

  /** Redraw the messages. Stays pinned to the bottom if you were there (or `forceBottom`); keeps your place after loading older ones. */
  function paintThread(opts: { forceBottom?: boolean; keepFromBottom?: boolean } = {}): void {
    const fromBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
    const pinned = fromBottom < 80;
    threadEl.replaceChildren();
    if (!threadReady) {
      if (threadFailed) threadEl.appendChild(errorState('Messages could not be loaded.', () => { void loadThread(); }));
      else threadEl.appendChild(h('p', { className: 'dim thread-empty', text: 'Loading...' }));
      return;
    }
    const name = cur() ? cur()!.name : currentName;
    if (hasMore) {
      const more = button(loadingOlder ? 'Loading...' : 'Load older messages', { kind: 'ghost', onClick: () => void older() });
      more.classList.add('load-older');
      more.disabled = loadingOlder;
      threadEl.appendChild(more);
    } else if (thread.length > 0) {
      threadEl.appendChild(h('p', { className: 'dim thread-start', text: isGroup() ? 'This is the start of ' + name + '.' : 'This is the start of your conversation with ' + name + '.' }));
    }
    if (thread.length === 0) threadEl.appendChild(h('div', { className: 'thread-empty' }, h('p', { text: 'No messages yet.' }), h('p', { className: 'dim', text: isGroup() ? 'Say hello to the group.' : 'Say hello to ' + name + '.' })));
    const status = statusNode();
    const statusAfter = (() => { let k = ''; for (const m of thread) if (isMine(m, me)) k = m.id > 0 ? String(m.id) : m.cid; return k; })();
    for (const row of groupThread(thread, me, Date.now(), readMark)) {
      if (row.kind === 'day') threadEl.appendChild(h('div', { className: 'day-sep' }, h('span', { text: row.label })));
      else if (row.kind === 'new') threadEl.appendChild(h('div', { className: 'new-sep', attrs: { role: 'separator' } }, h('span', { text: 'New messages' })));
      else {
        threadEl.appendChild(messageNode(row));
        if (status && row.mine && (row.msg.id > 0 ? String(row.msg.id) : row.msg.cid) === statusAfter) threadEl.appendChild(status);
      }
    }
    if (opts.forceBottom || (pinned && !opts.keepFromBottom)) threadEl.scrollTop = threadEl.scrollHeight;
    else threadEl.scrollTop = threadEl.scrollHeight - threadEl.clientHeight - fromBottom;
    if (pinned || opts.forceBottom) jump.hidden = true;
  }

  function paintBanner(): void {
    banner.hidden = !offline;
  }

  function paintPane(): void {
    pane.replaceChildren();
    root.classList.toggle('is-thread', !!current);
    if (!current) {
      pane.appendChild(emptyState('forum', 'Pick a conversation', 'Choose someone on the left to read and send messages, or start a group.'));
      return;
    }
    paintHead();
    area.placeholder = isGroup() ? 'Message the group' : 'Write a message';
    pane.append(headEl, banner, threadBox, composer);
    paintBanner();
    paintReplyBar();
    paintThread({ forceBottom: true });
  }

  function leave(): void {
    if (closeMenu) closeMenu();
    drafts.set(current, area.value);
    current = '';
    currentName = '';
    setActiveConversation(null);
    thread = [];
    replyTo = null;
    try { history.replaceState(null, '', messagesRoute()); } catch { /* the address is cosmetic */ }
    paintList();
    paintPane();
  }

  // ---- read state ----
  async function markRead(): Promise<void> {
    const id = current;
    const upTo = shouldMarkRead(thread, readSent, !document.hidden);
    if (!id || !upTo) return;
    entries = applyRead(entries, id);
    paintList();
    syncUnread();
    const before = readSent;
    readSent = upTo;
    try { await socialJson('POST', convPath(pathKey(cur(), id)) + '/read', { upTo }); refreshUnread(400); } catch { if (readSent === upTo) readSent = before; }
  }

  // ---- loading ----
  async function loadThread(): Promise<void> {
    const id = current;
    if (!id) return;
    const mine = ++sequence;
    threadFailed = false;
    try {
      const page = normalizeMessages(await socialJson('GET', convPath(pathKey(cur(), id)) + '/messages?limit=' + PAGE));
      if (disposed || mine !== sequence || id !== current) return;
      const first = !threadReady;
      if (page.conversation && page.conversation.id) {
        const conv = page.conversation;
        if (conv.id !== current) { entries = removeEntry(entries, current); current = conv.id; setActiveConversation(current); }   // the server's id wins
        currentName = conv.name;
        entries = applyConversation(entries, conv);
        paintList();
        paintHead();
      }
      thread = replaceHistory(thread, page.messages);
      hasMore = page.hasMore;
      seenUpTo = page.seenUpTo;
      if (first) readMark = page.readUpTo;
      threadReady = true;
      paintThread({ forceBottom: first });
      void markRead();
    } catch (e) {
      if (disposed || mine !== sequence) return;
      if (e instanceof SocialError && e.status === 404) { threadReady = true; thread = []; hasMore = false; paintThread(); return; }
      if (!threadReady) { threadFailed = true; paintThread(); threadEl.prepend(h('p', { className: 'dim', text: describeError(e) })); }
    }
  }

  async function older(): Promise<void> {
    const oldest = thread.find((m) => m.id > 0);
    if (!current || !oldest || loadingOlder) return;
    const id = current;
    loadingOlder = true;
    paintThread({ keepFromBottom: true });
    try {
      const page = normalizeMessages(await socialJson('GET', convPath(pathKey(cur(), id)) + '/messages?limit=' + PAGE + '&before=' + oldest.id));
      if (disposed || id !== current) return;
      thread = prependOlder(thread, page.messages);
      hasMore = page.hasMore;
    } catch (e) {
      toast('Could not load older messages: ' + describeError(e), 'error');
    } finally {
      loadingOlder = false;
      if (!disposed && id === current) paintThread({ keepFromBottom: true });
    }
  }

  async function loadList(): Promise<void> {
    try {
      const [convs, friends] = await Promise.all([
        socialJson('GET', '/api/conversations').then(normalizeConversations),
        socialJson('GET', '/api/friends').then(normalizeFriends).catch(() => friendsData),
      ]);
      if (disposed) return;
      friendsData = friends;
      entries = buildEntries(convs.conversations, friends, current ? { id: current, name: currentName || current } : null, me);
      if (current && readSent > 0) entries = applyRead(entries, current);
      loadedList = true;
      paintList();
      syncUnread();
      if (current) paintHead();
    } catch (e) {
      if (disposed || loadedList) return;
      listItems.replaceChildren(errorState('Conversations could not be loaded (' + describeError(e) + ').', () => { void loadList(); }));
    }
  }

  async function select(id: string, name: string): Promise<void> {
    if (id === current && threadReady) { area.focus(); return; }
    if (closeMenu) closeMenu();
    drafts.set(current, area.value);
    current = id;
    currentName = name;
    setActiveConversation(id);
    thread = [];
    hasMore = false;
    threadReady = false;
    threadFailed = false;
    readSent = 0;
    readMark = 0;
    seenUpTo = 0;
    replyTo = null;
    jump.hidden = true;
    if (!findEntry(entries, id)) entries = entries.concat({ id, kind: id.startsWith('g:') ? 'group' : 'dm', name, members: [], last: null, unread: 0, state: 'offline', detail: '', friend: false });
    try { history.replaceState(null, '', messagesRoute(id)); } catch { /* the address is cosmetic */ }
    paintList();
    paintPane();
    area.value = drafts.get(id);
    autosize();
    updateCount();
    await loadThread();
    area.focus();
  }

  // ---- sending ----
  function post(m: ThreadMessage): Promise<void> {
    const id = m.convId;
    const cid = m.cid;
    const body: { text: string; cid: string; replyTo?: number } = { text: m.text, cid };
    if (m.replyTo) body.replyTo = m.replyTo.id;
    return socialJson('POST', convPath(pathKey(findEntry(entries, id), id)) + '/messages', body).then((raw) => {
      const sent = normalizeMessage(raw);
      if (disposed) return;
      if (id === current) { thread = mergeThread(thread, sent); paintThread({ forceBottom: true }); }
      entries = applyMessage(entries, sent.convId ? sent : { ...sent, convId: id }, me, current, true);
      paintList();
    }).catch((e) => {
      if (disposed) return;
      const status = e instanceof SocialError ? e.status : 0;
      const text = e instanceof SocialError ? e.message : 'No connection';
      if (!isRetryable(status)) refused.add(cid);
      if (id === current) { thread = setSendState(thread, cid, 'failed', text); paintThread({ forceBottom: true }); }
      else {
        drafts.set(id, drafts.get(id) || m.text);   // you left the chat: the words go back to its draft
        const e2 = findEntry(entries, id);
        toast('Your message to ' + (e2 ? e2.name : 'that chat') + ' was not sent: ' + text, 'error');
      }
    });
  }

  /** Sends go out one at a time, so they arrive in the order they were typed. */
  function enqueue(m: ThreadMessage): void {
    queue = queue.then(() => post(m));
  }

  function resend(cid: string): void {
    const m = thread.find((x) => x.id <= 0 && x.cid === cid);
    if (!m) return;
    refused.delete(cid);
    thread = setSendState(thread, cid, 'sending');
    paintThread({ forceBottom: true });
    enqueue({ ...m, state: 'sending', error: '' });
  }

  function submit(): void {
    const text = cleanText(area.value.replace(/\r\n?/g, '\n')).trim();
    const problem = validateMessage(text);
    error.hidden = !problem;
    error.textContent = problem || '';
    if (problem || !current) return;
    const m = pendingMessage(me, current, text, newCid(), Date.now(), replyTo);
    thread = addPending(thread, m);
    area.value = '';
    drafts.set(current, '');
    replyTo = null;
    paintReplyBar();
    autosize();
    updateCount();
    paintThread({ forceBottom: true });
    enqueue(m);
    area.focus();
  }

  function autosize(): void {
    area.style.height = 'auto';
    area.style.height = Math.min(area.scrollHeight, 150) + 'px';
  }

  function updateCount(): void {
    const length = area.value.replace(/\r\n?/g, '\n').trim().length;
    count.textContent = length + ' / ' + LIM.message;
    count.hidden = length < LIM.message * 0.8;
    count.classList.toggle('is-over', length > LIM.message);
    sendBtn.disabled = length === 0 || length > LIM.message;
    if (length <= LIM.message && !error.hidden) error.hidden = true;
  }

  area.addEventListener('input', () => { autosize(); updateCount(); drafts.set(current, area.value); });
  area.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    else if (event.key === 'Escape' && replyTo) { event.preventDefault(); setReply(null); }
  });
  composer.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  searchBox.addEventListener('input', () => { query = searchBox.value; paintList(); });
  threadEl.addEventListener('scroll', () => {
    const fromBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
    if (fromBottom < 80) { jump.hidden = true; void markRead(); }
    if (threadEl.scrollTop < 30 && hasMore && !loadingOlder && threadReady) void older();
  });
  jump.addEventListener('click', () => { threadEl.scrollTop = threadEl.scrollHeight; jump.hidden = true; });
  const onVisible = (): void => { if (!document.hidden) void markRead(); };
  document.addEventListener('visibilitychange', onVisible);

  // ---- live updates ----
  function onMessage(m: ReturnType<typeof normalizeMessage>, conv: ReturnType<typeof normalizeConversation>): void {
    const id = convIdOf(m, me);
    const open = id === current;
    const reading = open && !document.hidden;
    entries = applyMessage(entries, m, me, current, reading, conv);
    if (open) {
      const fromBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
      const wasPinned = fromBottom < 80;
      thread = mergeThread(thread, m);
      paintThread({ forceBottom: wasPinned || isMine(m, me) });
      if (!wasPinned && !isMine(m, me)) jump.hidden = false;
      else void markRead();
    }
    paintList();
    syncUnread();
  }

  const stop = openFeed((event: FeedEvent) => {
    if (disposed) return;
    if (event.type === 'message') {
      onMessage(normalizeMessage(event.message), event.conversation ? normalizeConversation(event.conversation) : null);
    } else if (event.type === 'seen') {
      if (String(event.convId || '') === current) {
        seenUpTo = Math.max(seenUpTo, Number(event.upTo) || 0);
        paintThread();
      }
    } else if (event.type === 'read') {
      if (event.convId) { entries = applyRead(entries, String(event.convId)); paintList(); syncUnread(); }   // read on another device
    } else if (event.type === 'conversation') {
      takeConversation(event.conversation);
      syncUnread();
    } else if (event.type === 'conversation-left') {
      const id = String(event.convId || '');
      entries = removeEntry(entries, id);
      if (id === current) leave(); else paintList();
      syncUnread();
    } else if (event.type === 'presence') {
      entries = applyPresence(entries, String(event.username || ''), stateOf(event.state), String(event.detail || ''));
      paintList();
      if (current) paintHead();
    } else if (event.type === 'disconnected' || event.type === 'connected') {
      offline = event.type === 'disconnected';
      paintBanner();
      if (!offline) {
        for (const m of thread) if (m.state === 'failed' && !refused.has(m.cid)) resend(m.cid);   // back online: try the unsent ones again
        window.clearTimeout(reload);
        reload = window.setTimeout(() => { void loadList(); if (current) void loadThread(); }, 150);
      }
    } else if (event.type === 'friends' || event.type === 'reset') {
      window.clearTimeout(reload);
      reload = window.setTimeout(() => { void loadList(); if (current) void loadThread(); }, 150);
    }
  });

  updateCount();
  paintList();
  paintPane();
  if (current) { setActiveConversation(current); area.value = drafts.get(current); }
  autosize();
  updateCount();
  const ready = Promise.all([loadList(), current ? loadThread() : Promise.resolve()]).then(() => undefined);

  return {
    element: root,
    ready,
    dispose(): void {
      disposed = true;
      setActiveConversation(null);
      window.clearTimeout(reload);
      document.removeEventListener('visibilitychange', onVisible);
      if (closeMenu) closeMenu();
      drafts.set(current, area.value);
      stop();
    },
  };
}
