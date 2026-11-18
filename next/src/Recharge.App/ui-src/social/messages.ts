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
import { emojiPopover } from './emojiPicker.js';
import { customByShort } from './emojis.js';
import { currentUser } from '../account/session.js';
import { fallbackColor, playerAvatar } from '../community/people.js';
import { hubAuthor } from '../community/hubUsers.js';
import { isVideoPath, libraryRoute, profileRoute } from '../community/format.js';
import { imagePicker } from '../community/forms.js';
import type { View } from '../community/forum.js';
import { SocialError, deleteMessage, editMessage, react, setGroupProfile, socialJson, uploadChatMedia, userPath } from './api.js';
import { handleDelete, handleEdit, handleReaction, openFeed, type FeedEvent } from './events.js';
import {
  LIM, cleanText, isConvId, messagesRoute, normalizeConversation, normalizeConversations, normalizeFriends, normalizeMessage, normalizeMessages,
  presenceLabel, stateOf, validateGroupName, validateMessage, type Card, type FriendsData, type Member, type ReplyRef,
} from './model.js';
import {
  Drafts, addPending, applyConversation, applyDelete, applyEdit, applyMessage, applyPresence, applyRead, applyReactions, buildEntries, clock, convIdOf, dmId, filterEntries, findEntry,
  groupThread, isMine, isRetryable, listStamp, mergeThread, newCid, otherMember, pendingMessage, prependOlder, previewOf, removeEntry,
  removePending, replaceHistory, replyRefOf, replySnippet, setSendState, shouldMarkRead, statusFor, toggleReactionMap, totalUnread, unreadLabel,
  type Entry, type ThreadMessage,
} from './convo.js';
import { refreshUnread, setUnread } from './unread.js';
import { setActiveConversation } from './messageAlerts.js';

const PAGE = 40;
const DEFAULT_GROUP_COLOR = '#2ea043';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const drafts = new Drafts();

/** A person's own picture and frame (hub image, then their profile look on top), at a fixed size. Falls back to coloured initials. */
/** Make an element open `name`'s profile on click / Enter / Space. */
function toProfile(el: HTMLElement, name: string): void {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('title', name + '’s profile');
  el.style.cursor = 'pointer';
  const open = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (target && target !== el && target.closest('button, input, a, select, textarea')) return;   // let controls handle themselves
    e.stopPropagation(); e.preventDefault(); go(profileRoute(name));
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') open(e); });
}

function userAvatar(name: string, size = 32): HTMLElement {
  const slot = h('span', { className: 'msg-av', attrs: { 'data-user': name } });
  slot.style.setProperty('--sz', size + 'px');
  slot.appendChild(playerAvatar({ username: name, avatar_url: '/api/users/' + encodeURIComponent(name) + '/avatar', frame: 'none', frame_colors: [] }, size));
  void hubAuthor(name).then((author) => {
    if (author && slot.isConnected) slot.replaceChildren(playerAvatar(author, size));
  });
  toProfile(slot, name);
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
  toProfile(wrap, name);
  return wrap;
}

/** The avatar of a group: its picture when it has one, else a tile in the group's colour with the people glyph. */
function groupTile(name: string, size = 36, avatar = '', color = ''): HTMLElement {
  const tile = h('span', { className: 'group-tile' + (avatar ? ' has-avatar' : '') });
  tile.style.setProperty('--sz', size + 'px');
  tile.style.setProperty('--gc', color || fallbackColor(name));
  if (avatar) tile.appendChild(h('img', { attrs: { src: avatar, alt: name + ' group picture', decoding: 'async' } }));
  else tile.appendChild(icon('users', Math.round(size * 0.55)));
  return tile;
}

const convPath = (key: string): string => '/api/conversations/' + userPath(key);
const avatarUrl = (name: string): string => '/api/conversations/media/' + encodeURIComponent(name);

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

/** Attached pictures and videos, laid out under the message text. */
function mediaNode(urls: string[]): HTMLElement | null {
  if (urls.length === 0) return null;
  const strip = h('div', { className: 'msg-media' });
  for (const url of urls) {
    if (isVideoPath(url)) strip.appendChild(h('video', { attrs: { src: url, controls: 'controls', playsinline: 'playsinline', preload: 'metadata' } }));
    else strip.appendChild(h('img', { attrs: { src: url, alt: 'Attached picture', decoding: 'async' } }));
  }
  return strip;
}

// ---- lightweight message formatting: **bold**, *italic* / _italic_, ~~strike~~, ||spoiler||, `code` ----
interface FmtRule { re: RegExp; make: (inner: string) => HTMLElement }
const FMT_RULES: FmtRule[] = [
  { re: /`([^`\n]+)`/, make: (s) => h('code', { className: 'msg-code', text: s }) },
  { re: /:([A-Za-z0-9_+-]{1,32}):/, make: (s) => shortcodeNode(s) },
  { re: /\|\|([\s\S]+?)\|\|/, make: (s) => spoilerNode(s) },
  { re: /\*\*([\s\S]+?)\*\*/, make: (s) => fmtInto(h('strong', {}), s) },
  { re: /~~([\s\S]+?)~~/, make: (s) => fmtInto(h('s', {}), s) },
  { re: /\*([^*\n]+?)\*|_([^_\n]+?)_/, make: (s) => fmtInto(h('em', {}), s) },
];

function spoilerNode(inner: string): HTMLElement {
  const span = h('span', { className: 'msg-spoiler', attrs: { role: 'button', tabindex: '0', title: 'Spoiler — click to reveal' } });
  fmtInto(span, inner);
  const reveal = (e: Event): void => { e.stopPropagation(); span.classList.add('is-revealed'); };
  span.addEventListener('click', reveal);
  span.addEventListener('keydown', (e) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') reveal(e); });
  return span;
}

/** Known :shortcode: -> inline art; unknown stays literal text. */
function shortcodeNode(short: string): HTMLElement {
  const full = ':' + short + ':';
  const custom = customByShort.get(short);
  if (!custom) return h('span', { text: full });
  return h('img', { className: 'msg-emoji', attrs: { src: custom.url, alt: full, decoding: 'async' } });
}

/** Reaction chip face: custom art when registered, otherwise the emoji text. */
function reactionFace(value: string): HTMLElement {
  const custom = customByShort.get(value);
  return custom
    ? h('img', { className: 'msg-emoji', attrs: { src: custom.url, alt: '', decoding: 'async' } })
    : h('span', { attrs: { 'aria-hidden': 'true' }, text: value });
}

/** Append text, turning newlines into <br> (and never injecting HTML — everything is a text node). */
function appendTextLines(parent: Node, text: string): void {
  const parts = text.split('\n');
  parts.forEach((part, i) => {
    if (i > 0) parent.appendChild(h('br'));
    if (part) parent.appendChild(document.createTextNode(part));
  });
}

/** Parse inline formatting into `parent` (earliest marker wins; code is literal). Safe: builds only text nodes and known tags. */
function fmtInto<T extends Node>(parent: T, text: string): T {
  let rest = text;
  let guard = 0;
  while (rest.length > 0 && guard++ < 10000) {
    let best: { idx: number; len: number; node: HTMLElement } | null = null;
    for (const r of FMT_RULES) {
      const m = r.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, len: m[0].length, node: r.make(m[1] ?? m[2] ?? '') };
    }
    if (!best) { appendTextLines(parent, rest); break; }
    if (best.idx > 0) appendTextLines(parent, rest.slice(0, best.idx));
    parent.appendChild(best.node);
    rest = rest.slice(best.idx + best.len);
  }
  return parent;
}

function renderMessageText(text: string): HTMLElement {
  return fmtInto(h('div', { className: 'msg-text' }), text);
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
  let editing: { id: number; text: string } | null = null;
  let editFocusId: number | null = null;
  let uploading = false;
  let reactionTarget: ThreadMessage | null = null;

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
  const emoji = emojiPopover((value) => insertAtCaret(area, value), 'Choose emoji');
  const reactionPicker = emojiPopover((value) => {
    const m = reactionTarget;
    if (m) toggleReaction(m, value);
  }, 'Add reaction');
  const count = h('span', { className: 'form-count dim' });
  const sendBtn = button('Send', { kind: 'primary', icon: 'forum', type: 'submit' });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const replyBar = h('div', { className: 'reply-preview', hidden: true });
  const pictures = imagePicker(4, [], true);   // images + one video, checked by validateImages in error()
  const mediaBox = h('div', { className: 'composer-media' }, pictures.element);
  const composer = h('form', { className: 'composer' }, replyBar, mediaBox, h('div', { className: 'composer-line' }, area, emoji.button, sendBtn), h('div', { className: 'composer-row' }, error, count));
  const threadBox = h('div', { className: 'thread-box' }, threadEl, jump);

  // ---- list ----
  function rowAvatar(e: Entry): HTMLElement {
    if (e.kind === 'group') return h('span', { className: 'conv-av' }, groupTile(e.name, 40, e.avatar || '', e.color || ''));
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
      const count = e ? e.members.length : 0;
      const open = h('button', { className: 'thread-group-open', attrs: { type: 'button', 'aria-label': 'Open ' + name + ' group profile' } });
      open.append(
        groupTile(name, 40, e ? e.avatar || '' : '', e ? e.color || '' : ''),
        h('div', { className: 'thread-who' },
          h('span', { className: 'thread-group-name', text: name }),
          h('div', { className: 'social-sub', text: count ? count + (count === 1 ? ' member' : ' members') : '' })));
      open.addEventListener('click', () => showGroupProfile());
      headEl.appendChild(open);
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

  // An open group profile refreshes from pushes (and from add/remove member).
  let profileId = '';
  let refreshProfile: (() => void) | null = null;

  function takeConversation(raw: unknown): void {
    const conv = normalizeConversation(raw);
    if (!conv) return;
    entries = applyConversation(entries, conv);
    paintList();
    if (conv.id === current) { currentName = conv.name; paintHead(); }
    if (conv.id === profileId && refreshProfile) refreshProfile();
  }

  /** A member row: picture, name and the row itself open their profile; the owner also gets a remove control. */
  function memberRow(e: Entry, m: Member, admin: boolean, err: HTMLElement, changed: () => void): HTMLElement {
    const row = h('div', { className: 'member-row' });
    row.append(
      userAvatar(m.username, 32),
      h('a', { className: 'social-name', attrs: { href: profileRoute(m.username) } }, userName(m.username, 'member-name')),
    );
    if (m.admin) row.appendChild(h('span', { className: 'member-tag dim', text: 'Owner' }));
    row.appendChild(h('span', { className: 'member-state dim' }, h('span', { className: 'presence-dot is-' + m.state }), presenceLabel(m.state, '')));
    if (admin && m.username.toLowerCase() !== me.toLowerCase()) {
      const rm = button('Remove', { kind: 'ghost', onClick: (event) => {
        event.stopPropagation();
        rm.disabled = true;
        socialJson('DELETE', convPath(e.id) + '/members/' + userPath(m.username)).then(() => {
          entries = entries.map((x) => (x.id === e.id ? { ...x, members: x.members.filter((y) => y.username !== m.username) } : x));
          row.remove();
          paintList(); if (e.id === current) paintHead();
          changed();
        }).catch((x) => { rm.disabled = false; err.hidden = false; err.textContent = describeError(x); });
      } });
      rm.classList.add('member-remove');
      row.appendChild(rm);
    }
    toProfile(row, m.username);
    return row;
  }

  function showMembers(): void {
    const e = cur();
    if (!e) return;
    const body = h('div', { className: 'member-list' });
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    for (const m of e.members) body.appendChild(memberRow(e, m, amAdmin(e), err, () => undefined));
    body.appendChild(err);
    modal({ title: e.name + ' - members', body });
  }

  /** Group profile: picture, name, colour and members. Any member can change the look. */
  function showGroupProfile(): void {
    const first = cur();
    if (!first || first.kind !== 'group') return;
    const id = first.id;
    if (profileId === id && refreshProfile) return;
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    const preview = h('span', { className: 'group-profile-av' });
    const nameInput = h('input', { className: 'input', attrs: { type: 'text', 'aria-label': 'Group name', maxlength: '60', autocomplete: 'off' } });
    nameInput.value = first.name;
    const nameSave = button('Save', { kind: 'ghost', onClick: () => commitName() });
    const colorInput = h('input', { className: 'group-profile-color', attrs: { type: 'color', 'aria-label': 'Group colour' } });
    colorInput.value = HEX_COLOR.test(first.color || '') ? first.color || DEFAULT_GROUP_COLOR : DEFAULT_GROUP_COLOR;
    const fileInput = h('input', { hidden: true, attrs: { type: 'file', accept: 'image/*', 'aria-label': 'Group avatar image' } });
    fileInput.addEventListener('change', () => void changeAvatar());
    const membersBox = h('div', { className: 'member-list' });

    const top = h('div', { className: 'group-profile-top' },
      h('div', { className: 'group-profile-avatar' }, preview,
        button('Change', { kind: 'ghost', onClick: () => fileInput.click() }), fileInput),
      h('div', { className: 'group-profile-fields' },
        h('label', { className: 'group-profile-label', text: 'Group name' }, h('div', { className: 'group-profile-row' }, nameInput, nameSave)),
        h('label', { className: 'group-profile-label', text: 'Colour' }, colorInput)));
    const body = h('div', { className: 'group-profile' }, top, h('h3', { className: 'group-profile-heading', text: 'Members' }), membersBox, err);

    function paintPreview(): void {
      const e = findEntry(entries, id);
      preview.replaceChildren(groupTile(e ? e.name : first.name, 96, e ? e.avatar || '' : '', e ? e.color || '' : ''));
    }

    /** Patch locally at once; the returned function puts the old values back if the server says no. */
    function patch(p: { name?: string; color?: string; avatar?: string }): () => void {
      const old = findEntry(entries, id);
      const before: { name: string; color: string; avatar: string } = { name: old ? old.name : '', color: old ? old.color || '' : '', avatar: old ? old.avatar || '' : '' };
      const local = { ...p };
      if (local.avatar !== undefined) local.avatar = avatarUrl(local.avatar);
      const put = (v: { name?: string; color?: string; avatar?: string }): void => {
        entries = entries.map((x) => (x.id === id ? { ...x, ...v } : x));
        paintList();
        if (id === current) paintHead();
        paintPreview();
      };
      put(local);
      return () => put(before);
    }

    async function save(p: { name?: string; color?: string; avatar?: string }): Promise<boolean> {
      err.hidden = true;
      const undo = patch(p);
      try {
        await setGroupProfile(id, p);
        return true;
      } catch (x) {
        undo();
        err.hidden = false;
        err.textContent = 'Could not save: ' + describeError(x);
        toast('Could not save group profile: ' + describeError(x), 'error');
        return false;
      }
    }

    function commitName(): void {
      const name = nameInput.value.trim();
      const problem = !name ? 'Give the group a name.' : validateGroupName(name);
      if (problem) { err.hidden = false; err.textContent = problem; return; }
      const e = findEntry(entries, id);
      if (e && name === e.name) return;
      void save({ name });
    }
    nameInput.addEventListener('change', commitName);
    nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commitName(); } });
    colorInput.addEventListener('change', () => {
      const color = colorInput.value;
      if (!HEX_COLOR.test(color)) return;
      const e = findEntry(entries, id);
      if (e && color === e.color) return;
      void save({ color });
    });

    async function changeAvatar(): Promise<void> {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('Group avatars must be an image.', 'error'); return; }
      try {
        const name = await uploadChatMedia(id, file);
        await save({ avatar: name });
      } catch (x) {
        toast('Could not upload group picture: ' + describeError(x), 'error');
      }
    }

    function renderMembers(): void {
      const e = findEntry(entries, id);
      membersBox.replaceChildren();
      if (!e) return;
      const admin = amAdmin(e);
      for (const m of e.members) membersBox.appendChild(memberRow(e, m, admin, err, renderMembers));
      if (admin) membersBox.appendChild(button('Add member', { kind: 'ghost', onClick: () => addMember() }));
    }

    const overlay = modal({
      title: first.name, body, actions: [{ label: 'Done' }],
      onClose: () => { if (profileId === id) { profileId = ''; refreshProfile = null; } },
    });
    profileId = id;
    refreshProfile = () => {
      const e = findEntry(entries, id);
      if (!e || !overlay.isConnected) return;
      if (document.activeElement !== nameInput) nameInput.value = e.name;
      if (document.activeElement !== colorInput) colorInput.value = HEX_COLOR.test(e.color || '') ? e.color || DEFAULT_GROUP_COLOR : DEFAULT_GROUP_COLOR;
      const title = overlay.querySelector('.modal-title');
      if (title) title.textContent = e.name;
      paintPreview();
      renderMembers();
    };
    refreshProfile();
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

  function startEdit(m: ThreadMessage): void {
    if (!isMine(m, me) || m.id <= 0) return;
    editing = { id: m.id, text: m.text };
    editFocusId = m.id;
    paintThread();
  }

  function cancelEdit(): void {
    editing = null;
    editFocusId = null;
    paintThread();
  }

  async function saveEdit(id: number): Promise<void> {
    if (!editing || editing.id !== id || !current) return;
    const raw = editing.text;
    const problem = validateMessage(raw);
    if (problem) { toast(problem, 'error'); return; }
    const newText = cleanText(raw.replace(/\r\n?/g, '\n')).trim();
    const prev = thread.find((m) => m.id === id);
    if (prev && prev.text === newText) { editing = null; editFocusId = null; paintThread(); return; }
    const prevText = prev ? prev.text : '';
    const prevEditedAt = prev ? (prev.editedAt || 0) : 0;
    const key = pathKey(findEntry(entries, current), current);
    thread = applyEdit(thread, id, newText, Date.now());
    editing = null;
    editFocusId = null;
    paintThread();
    try {
      await editMessage(key, id, newText);
    } catch (e) {
      thread = applyEdit(thread, id, prevText, prevEditedAt);
      paintThread();
      toast('Could not save edit: ' + describeError(e), 'error');
    }
  }

  async function removeMessage(id: number): Promise<void> {
    if (!current) return;
    const prev = thread.find((m) => m.id === id);
    if (!prev || !isMine(prev, me) || (prev.deletedAt || 0) > 0) return;
    if (editing && editing.id === id) { editing = null; editFocusId = null; }
    const key = pathKey(findEntry(entries, current), current);
    thread = applyDelete(thread, id, Date.now());
    paintThread();
    try {
      await deleteMessage(key, id);
    } catch (e) {
      thread = thread.map((m) => (m.id === id ? prev : m));   // restore the original content on failure
      paintThread();
      toast('Could not delete: ' + describeError(e), 'error');
    }
  }

  function askDelete(m: ThreadMessage): void {
    if (!isMine(m, me) || m.id <= 0 || (m.deletedAt || 0) > 0) return;
    modal({
      title: 'Delete message',
      body: 'Delete this message? It will be replaced with a note for everyone in the conversation.',
      actions: [{ label: 'Cancel' }, {
        label: 'Delete', kind: 'danger',
        onClick: () => { void removeMessage(m.id); },
      }],
    });
  }

  function editBox(m: ThreadMessage): HTMLElement {
    const box = h('div', { className: 'msg-edit' });
    const ta = h('textarea', { className: 'input msg-edit-input', attrs: { rows: '1', 'aria-label': 'Edit message' } });
    ta.value = editing && editing.id === m.id ? editing.text : m.text;
    const save = button('Save', { kind: 'primary', type: 'button', onClick: () => void saveEdit(m.id) });
    save.classList.add('msg-edit-save');
    const cancel = button('Cancel', { kind: 'ghost', type: 'button', onClick: () => cancelEdit() });
    cancel.classList.add('msg-edit-cancel');
    const actions = h('div', { className: 'msg-edit-actions' }, save, cancel);
    box.append(ta, actions);
    ta.addEventListener('input', () => { if (editing && editing.id === m.id) editing.text = ta.value; });
    ta.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(m.id); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    if (editFocusId === m.id) queueMicrotask(() => { if (editFocusId === m.id) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); editFocusId = null; } });
    return box;
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

  function toggleReaction(m: ThreadMessage, emoji: string): void {
    if (!current || m.id <= 0) return;
    thread = applyReactions(thread, m.id, toggleReactionMap(m.reactions, emoji, me));
    paintThread();
    void react(pathKey(findEntry(entries, current), current), m.id, emoji).catch((e) => {
      const latest = thread.find((x) => x.id === m.id);
      if (latest) { thread = applyReactions(thread, m.id, toggleReactionMap(latest.reactions, emoji, me)); paintThread(); }
      toast('Could not save your reaction: ' + describeError(e), 'error');
    });
  }

  /** A chip per emoji, plus a small button that opens the picker for any reaction. */
  function reactionRow(m: ThreadMessage): HTMLElement | null {
    if (m.id <= 0) return null;
    const reactions = m.reactions || {};
    const row = h('div', { className: 'msg-reactions' });
    for (const emoji of Object.keys(reactions)) {
      const users = reactions[emoji] || [];
      if (users.length === 0) continue;
      const mine = users.some((u) => u.toLowerCase() === me.toLowerCase());
      const chip = h('button', {
        className: 'msg-reaction' + (mine ? ' is-mine' : ''),
        title: emoji + ' ' + users.length + (mine ? ' (you reacted)' : ''),
        attrs: { type: 'button', 'aria-label': 'React ' + emoji + ', ' + users.length + (mine ? '. Remove your reaction' : '. Add your reaction'), 'aria-pressed': mine ? 'true' : 'false' },
      }, reactionFace(emoji), h('span', { className: 'msg-reaction-count', text: String(users.length) }));
      chip.addEventListener('click', () => toggleReaction(m, emoji));
      row.appendChild(chip);
    }
    const add = h('button', { className: 'msg-reaction-add', title: 'Add reaction', attrs: { type: 'button', 'aria-label': 'Add reaction' } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '+' }));
    add.addEventListener('click', () => { reactionTarget = m; reactionPicker.open(add); });
    row.appendChild(add);
    return row;
  }

  // Discord-style: avatar + coloured name + time on the first message of a sender's run, then flat text lines — the
  // same for your own messages and theirs (no left/right bubbles).
  function messageNode(row: { msg: ThreadMessage; mine: boolean; first: boolean; last: boolean }): HTMLElement {
    const m = row.msg;
    const deleted = (m.deletedAt || 0) > 0;
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
      const head = h('div', { className: 'msg-head' },
        userName(m.from, 'msg-who'),
        h('span', { className: 'msg-stamp dim', text: clock(m.ts), title: new Date(m.ts).toLocaleString() }));
      if (!deleted && (m.editedAt || 0) > 0) head.appendChild(h('span', { className: 'msg-edited dim', text: '(edited)', title: 'Edited ' + new Date(m.editedAt as number).toLocaleString() }));
      col.appendChild(head);
    }
    if (deleted) col.appendChild(h('div', { className: 'msg-deleted', text: 'This message was deleted.' }));
    else {
      if (editing && editing.id === m.id) col.appendChild(editBox(m));
      else if (m.text) col.appendChild(renderMessageText(m.text));
      if (m.card) col.appendChild(cardNode(m.card));
      const media = mediaNode(m.media || []);
      if (media) col.appendChild(media);
      const reactions = reactionRow(m);
      if (reactions) col.appendChild(reactions);
    }
    wrap.append(gutter, col);
    if (m.id > 0 && !deleted) {
      if (isMine(m, me)) {
        const edit = h('button', { className: 'msg-edit-btn', title: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit message' } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '✎' }));
        edit.addEventListener('click', () => startEdit(m));
        wrap.appendChild(edit);
        const del = h('button', { className: 'msg-delete-btn', title: 'Delete', attrs: { type: 'button', 'aria-label': 'Delete message' } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '✕' }));
        del.addEventListener('click', () => askDelete(m));
        wrap.appendChild(del);
      }
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
    const node = h('div', { className: 'msg-status dim' + (s.kind === 'failed' ? ' is-failed' : '') });
    if (s.kind === 'delivered' || s.kind === 'seen') {
      const tick = h('span', { className: 'msg-tick' + (s.kind === 'seen' ? ' is-seen' : ''), attrs: { title: s.text, 'aria-label': s.text } });
      tick.appendChild(icon('check', 14));
      if (s.kind === 'seen') tick.appendChild(icon('check', 14));
      node.appendChild(tick);
    } else {
      node.appendChild(document.createTextNode(s.text));
    }
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
    editing = null;
    editFocusId = null;
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
    editing = null;
    editFocusId = null;
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
    const body: { text: string; cid: string; replyTo?: number; media?: string[] } = { text: m.text, cid };
    if (m.replyTo) body.replyTo = m.replyTo.id;
    if (m.mediaNames && m.mediaNames.length) body.media = m.mediaNames;
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

  async function submit(): Promise<void> {
    if (uploading) return;
    const text = cleanText(area.value.replace(/\r\n?/g, '\n')).trim();
    const files = pictures.files();
    const problem = pictures.error() || (files.length
      ? (text.length > LIM.message ? 'That message is too long (' + LIM.message + ' characters at most).' : null)
      : validateMessage(text));
    error.hidden = !problem;
    error.textContent = problem || '';
    if (problem || !current) return;
    const conv = current;
    const key = pathKey(findEntry(entries, conv), conv);
    const names: string[] = [];
    if (files.length) {
      uploading = true;
      sendBtn.disabled = true;
      try {
        for (const file of files) names.push(await uploadChatMedia(key, file));
      } catch (e) {
        error.hidden = false;
        error.textContent = 'Could not upload attachment: ' + describeError(e);
        uploading = false;
        updateCount();
        return;
      }
      uploading = false;
    }
    if (disposed || conv !== current) return;   // navigated away while uploading
    const m = pendingMessage(me, conv, text, newCid(), Date.now(), replyTo, names);
    thread = addPending(thread, m);
    area.value = '';
    drafts.set(conv, '');
    replyTo = null;
    pictures.clear();
    paintReplyBar();
    autosize();
    updateCount();
    paintThread({ forceBottom: true });
    enqueue(m);
    area.focus();
  }

  /** Insert at the remembered textarea caret and fire input so drafts/count/autosize stay in sync. */
  function insertAtCaret(input: HTMLTextAreaElement, value: string): void {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(value, start, end, 'end');
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    sendBtn.disabled = uploading || (length === 0 && pictures.files().length === 0) || length > LIM.message;
    if (length <= LIM.message && !error.hidden) error.hidden = true;
  }

  pictures.element.addEventListener('change', () => { updateCount(); error.hidden = true; });
  pictures.element.addEventListener('click', () => updateCount());
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
    } else if (handleReaction(event, current, (messageId, reactions) => {
      thread = applyReactions(thread, messageId, reactions);
      paintThread();
    })) {
      // the update callback repainted the open thread
    } else if (handleEdit(event, current, (messageId, text, editedAt) => {
      thread = applyEdit(thread, messageId, text, editedAt);
      paintThread();
    })) {
      // the update callback repainted the open thread
    } else if (handleDelete(event, current, (messageId, deletedAt) => {
      thread = applyDelete(thread, messageId, deletedAt);
      paintThread();
    })) {
      // the update callback repainted the open thread
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
      emoji.dispose();
      reactionPicker.dispose();
      drafts.set(current, area.value);
      stop();
    },
  };
}
