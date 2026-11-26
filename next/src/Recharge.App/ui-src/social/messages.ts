/** Messages: conversation list (DMs and groups), thread with history, replies, optimistic sends, live updates, read state. The rules live in convo.ts. */
import { h, iconButton } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { authorName } from '../components/itemCard.js';
import { describeError } from '../bridge.js';
import { icon } from '../icons.js';
import { emojiPopover } from './emojiPicker.js';
import { customByShort, onCustomEmojis, setArsenal, setCustomEmojis } from './emojis.js';
import { currentUser } from '../account/session.js';
import { fallbackColor, playerAvatar } from '../community/people.js';
import { hubAuthor } from '../community/hubUsers.js';
import { isVideoPath, libraryRoute, profileRoute } from '../community/format.js';
import { imagePicker } from '../community/forms.js';
import type { View } from '../community/forum.js';
import { socialMediaSrc, loadSocialBase, SocialError, createChannel, createServer, deleteChannel, deleteMessage, editMessage, listEmojis, myArsenal, listServers, react, renameChannel, renameServer, setGroupProfile, socialJson, uploadChatMedia, userPath, createCategory, updateCategory, deleteCategory, createRole, updateRole, deleteRole, setMemberRoles, listServerEmojis, addServerEmoji, removeServerEmoji, type ServerEmoji } from './api.js';
import { handleDelete, handleEdit, handleReaction, openFeed, type FeedEvent } from './events.js';
import {
  LIM, cleanText, isConvId, messagesRoute, normalizeConversation, normalizeConversations, normalizeFriends, normalizeMessage, normalizeMessages, normalizeServer,
  presenceLabel, stateOf, validateGroupName, validateMessage, type Card, type Category, type Channel, type FriendsData, type Member, type ReplyRef, type Role, type Server,
} from './model.js';
import {
  Drafts, addPending, applyConversation, applyDelete, applyEdit, applyMessage, applyPresence, applyRead, applyReactions, buildEntries, clock, convIdOf, dmId, filterEntries, findEntry,
  groupThread, isMine, isRetryable, listStamp, mergeThread, newCid, otherMember, pendingMessage, prependOlder, previewOf, removeEntry,
  removePending, replaceHistory, replyRefOf, replySnippet, setSendState, shouldMarkRead, statusFor, toggleReactionMap, totalUnread, unreadLabel,
  type Entry, type ThreadMessage,
} from './convo.js';
import { refreshUnread, setUnread } from './unread.js';
import { setActiveConversation } from './messageAlerts.js';
import { VoiceClient, type CallKind, type VoiceState } from './voice.js';
import { CALL_ACCEPT_EVENT, takeCallJoin } from './callAlert.js';

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
  if (avatar) tile.appendChild(h('img', { attrs: { src: socialMediaSrc(avatar), alt: name + ' group picture', decoding: 'async' } }));
  else tile.appendChild(icon('users', Math.round(size * 0.55)));
  return tile;
}

/** A server icon, or a colour tile with its initials (the groupTile idea). */
function serverTile(server: Server, size = 40): HTMLElement {
  const tile = h('span', { className: 'server-tile' + (server.icon ? ' has-avatar' : '') });
  tile.style.setProperty('--sz', size + 'px');
  tile.style.setProperty('--gc', fallbackColor(server.name));
  if (server.icon) tile.appendChild(h('img', { attrs: { src: socialMediaSrc(server.icon), alt: '', decoding: 'async' } }));
  else {
    const initials = server.name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase() || '#';
    tile.appendChild(h('span', { className: 'server-initials', text: initials }));
  }
  return tile;
}

const convPath = (key: string): string => '/api/conversations/' + userPath(key);
const avatarUrl = (name: string): string => socialMediaSrc('/api/conversations/media/' + encodeURIComponent(name));

/** A DM is addressed by the other person's name (which works before the chat has any messages); groups and channels by id. */
function pathKey(e: Entry | undefined, id: string): string {
  if (id.startsWith('ch:')) return id;
  return e && e.kind === 'dm' && e.name && !isConvId(e.name) ? e.name : id;
}

function cardNode(card: Card): HTMLElement {
  const kind = card.type === 'lobby' ? 'Lobby' : card.type === 'skin' ? 'Skin' : 'Map';
  const node = h('div', { className: 'msg-card' });
  node.appendChild(icon(card.type === 'lobby' ? 'lobbies' : card.type === 'skin' ? 'user' : 'map', 22));
  node.appendChild(h('div', { className: 'msg-card-text' }, h('div', { className: 'msg-card-kind dim', text: kind }), h('div', { className: 'msg-card-name', text: card.name || card.id })));
  const href = card.type === 'lobby' ? null : libraryRoute(card.type === 'skin' ? 'skin' : 'map', card.id);
  if (href) node.appendChild(button('Open', { kind: 'secondary', onClick: () => go(href) }));
  return node;
}

/** Attached pictures and videos, laid out under the message text. */
function mediaNode(urls: string[]): HTMLElement | null {
  if (urls.length === 0) return null;
  const strip = h('div', { className: 'msg-media' });
  for (const url of urls) {
    const src = socialMediaSrc(url);
    if (isVideoPath(url)) strip.appendChild(h('video', { attrs: { src, controls: 'controls', playsinline: 'playsinline', preload: 'metadata' } }));
    else strip.appendChild(h('img', { attrs: { src, alt: 'Attached picture', decoding: 'async' } }));
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
  return h('img', { className: 'msg-emoji', attrs: { src: socialMediaSrc(custom.url), alt: full, decoding: 'async' } });
}

/** Reaction chip face: custom art when registered, otherwise the emoji text. */
function reactionFace(value: string): HTMLElement {
  const custom = customByShort.get(value);
  return custom
    ? h('img', { className: 'msg-emoji', attrs: { src: socialMediaSrc(custom.url), alt: '', decoding: 'async' } })
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
  const rail = h('nav', { className: 'server-rail', attrs: { 'aria-label': 'Servers' } });
  const listBox = h('aside', { className: 'conv-list', attrs: { 'aria-label': 'Conversations' } });
  const pane = h('section', { className: 'conv-pane' });
  const memberPane = h('aside', { className: 'member-pane', attrs: { 'aria-label': 'Members' }, hidden: true });
  root.append(rail, listBox, pane, memberPane);

  let entries: Entry[] = [];
  let friendsData: FriendsData | null = null;
  let servers: Server[] = [];
  let serversLoaded = false;
  let activeServerId = '';   // '' is Home/DMs
  // The open conversation: by id (`dm:`/`g:`/`ch:`). Opening by a bare username works out the DM's id from the two names.
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
  let voice: VoiceClient | null = null;
  let voiceState: VoiceState | null = null;
  let voiceError = '';
  let voiceBusy = false;
  let joinedVoiceId = '';   // the voice conv the user has committed to (shows their own tile + joined controls while media connects)
  let voicePaneShown = false;
  let deafened = false;
  const speaking = new Set<string>();
  const collapsedCats = new Set<string>();   // server channel categories the user has folded away (key: serverId:kind)

  const cur = (): Entry | undefined => findEntry(entries, current);
  const isGroup = (): boolean => (cur()?.kind === 'group') || current.startsWith('g:');
  const isChannel = (): boolean => current.startsWith('ch:');
  const activeServer = (): Server | undefined => servers.find((s) => s.id === activeServerId);
  const channelOf = (id: string): Channel | undefined => {
    for (const s of servers) { const ch = s.channels.find((c) => c.id === id); if (ch) return ch; }
    return undefined;
  };
  const isVoice = (): boolean => channelOf(current)?.kind === 'voice';
  const isCall = (): boolean => current.startsWith('dm:') || current.startsWith('g:');
  const serverOfChannel = (id: string): Server | undefined => servers.find((s) => s.channels.some((c) => c.id === id));
  const ownsServer = (s: Server | undefined): boolean => !!s && (
    s.owner.toLowerCase() === me.toLowerCase() || s.members.some((m) => m.admin && m.username.toLowerCase() === me.toLowerCase()));

  // ---- pieces that stay put ----
  const listHead = h('div', { className: 'conv-top' });
  const searchBox = h('input', { className: 'input conv-search', attrs: { type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search conversations', maxlength: String(LIM.username), autocomplete: 'off' } });
  const newBtn = button('New group', { kind: 'secondary', icon: 'plus', onClick: () => newGroup() });
  newBtn.classList.add('conv-new');
  const listItems = h('div', { className: 'conv-items' });
  listHead.append(h('div', { className: 'conv-titlebar' }, h('h2', { className: 'conv-title', text: 'Messages' }), newBtn), searchBox);
  listBox.append(listHead, listItems);
  const channelHead = h('div', { className: 'conv-top channel-top' });
  const channelItems = h('div', { className: 'conv-items channel-items' });

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
  const voiceNotice = h('p', { className: 'voice-notice', attrs: { role: 'status' }, hidden: true });
  const voiceTiles = h('div', { className: 'voice-tiles' });
  const voiceControls = h('div', { className: 'voice-controls' });
  const voiceRoom = h('div', { className: 'voice-room' }, voiceNotice, voiceTiles, voiceControls);
  const callDock = h('div', { className: 'call-dock', attrs: { hidden: 'hidden' } }, voiceRoom);

  // ---- list ----
  function rowAvatar(e: Entry): HTMLElement {
    if (e.kind === 'group') return h('span', { className: 'conv-av' }, groupTile(e.name, 40, e.avatar || '', e.color || ''));
    return h('span', { className: 'conv-av' }, userAvatar(e.name, 40), h('span', { className: 'presence-dot conv-presence is-' + e.state }));
  }

  // ---- servers rail and channel list ----
  function mergeServer(s: Server): void {
    servers = servers.some((x) => x.id === s.id) ? servers.map((x) => (x.id === s.id ? s : x)) : servers.concat(s);
    servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    serversLoaded = true;
    if (isChannel() && serverOfChannel(current)?.id === s.id) paintMemberPane();
  }

  function paintRail(): void {
    rail.replaceChildren();
    const home = h('button', {
      className: 'rail-btn rail-home' + (activeServerId ? '' : ' is-on'),
      attrs: { type: 'button', title: 'Home / DMs', 'aria-label': 'Home and direct messages', 'aria-current': activeServerId ? 'false' : 'true' },
    });
    home.append(icon('home', 22), h('span', { className: 'rail-label', text: 'Home' }));
    home.addEventListener('click', () => showHome());
    rail.appendChild(home);
    rail.appendChild(h('div', { className: 'rail-sep' }));
    for (const s of servers) {
      const on = s.id === activeServerId;
      const btn = h('button', {
        className: 'rail-btn rail-server' + (on ? ' is-on' : ''),
        attrs: { type: 'button', title: s.name, 'aria-label': s.name, 'aria-current': on ? 'true' : 'false' },
      });
      btn.appendChild(serverTile(s));
      btn.addEventListener('click', () => selectServer(s.id));
      rail.appendChild(btn);
    }
    const add = h('button', {
      className: 'rail-btn rail-add',
      attrs: { type: 'button', title: 'New server', 'aria-label': 'New server' },
    });
    add.append(icon('plus', 22), h('span', { className: 'rail-label', text: 'New server' }));
    add.addEventListener('click', () => newServer());
    rail.appendChild(add);
  }

  function paintChannels(): void {
    channelHead.replaceChildren();
    channelItems.replaceChildren();
    const s = activeServer();
    if (!s) {
      channelHead.appendChild(h('div', { className: 'conv-titlebar' }, h('h2', { className: 'conv-title', text: 'Servers' })));
      channelItems.appendChild(h('p', { className: 'dim conv-empty', text: serversLoaded ? 'No servers yet. Use + to make one.' : 'Loading...' }));
      return;
    }
    const manage = s.manage;
    const title = h('div', { className: 'conv-titlebar channel-serverbar' }, h('h2', { className: 'conv-title', text: s.name }));
    if (manage) {
      const actions = h('div', { className: 'conv-title-actions' });
      actions.append(
        iconButton('New category', icon('plus', 16), () => newCategory(s), 'channel-head-btn'),
        iconButton('Server settings', icon('settings', 16), () => openServerSettings(s), 'channel-head-btn'),
      );
      title.appendChild(actions);
    }
    channelHead.append(title, h('div', { className: 'channel-sub dim', text: s.members.length + (s.members.length === 1 ? ' member' : ' members') }));

    const channelRow = (ch: Channel): void => {
      const on = ch.id === current;
      const voiceCh = ch.kind === 'voice';
      const row = h('button', {
        className: 'channel-item' + (on ? ' is-on' : '') + (voiceCh ? ' is-voice' : ''),
        attrs: { type: 'button', 'aria-current': on ? 'true' : 'false', title: ch.topic || (voiceCh ? 'Voice: ' : '#') + ch.name },
      });
      row.append(h('span', { className: 'channel-hash dim' }, voiceCh ? icon('lobbies', 18) : h('span', { text: '#' })), h('span', { className: 'channel-name', text: ch.name }));
      row.addEventListener('click', () => void selectChannel(s, ch));
      if (manage) row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openChannelMenu(s, ch, ev.clientX, ev.clientY); });
      channelItems.appendChild(row);
      // Discord shows who is connected beneath a voice channel; we know the roster for the room we're in.
      if (voiceCh && voiceState && voiceState.convId === ch.id && voiceState.members.length) {
        const roster = h('ul', { className: 'channel-voice-roster', attrs: { 'aria-label': ch.name + ' voice members' } });
        for (const m of voiceState.members) {
          const nm = userName(m.username, 'channel-voice-name');
          tintName(nm, s, m.username);
          roster.appendChild(h('li', { className: 'channel-voice-member' + (m.muted ? ' is-muted' : '') + (speaking.has(m.username.toLowerCase()) ? ' is-speaking' : '') },
            userAvatar(m.username, 24), nm,
            m.cam ? icon('video', 14) : m.muted ? icon('x', 14) : h('span', { className: 'channel-voice-spk' })));
        }
        channelItems.appendChild(roster);
      }
    };

    const kindOf = (c: Channel): 'text' | 'voice' => (c.kind === 'voice' ? 'voice' : 'text');
    const group = (catId: string, label: string, cat?: Category, kind?: 'text' | 'voice'): void => {
      const chans = s.channels.filter((c) => (c.categoryId || '') === catId && (!kind || kindOf(c) === kind))
        .slice().sort((a, b) => (kindOf(a) === 'voice' ? 1 : 0) - (kindOf(b) === 'voice' ? 1 : 0) || (a.position - b.position) || a.name.localeCompare(b.name));
      if (chans.length === 0 && !(manage && (cat || kind))) return;   // empty text/voice headers (and named categories) stay visible to managers
      const key = s.id + ':' + (catId || '_uncat') + ':' + (kind || 'all');
      const folded = collapsedCats.has(key);
      const head = h('div', { className: 'channel-cat' });
      const toggle = h('button', {
        className: 'channel-cat-toggle',
        attrs: { type: 'button', 'aria-expanded': folded ? 'false' : 'true', title: (folded ? 'Show ' : 'Hide ') + label },
      }, h('span', { className: 'channel-cat-caret' }, icon(folded ? 'chevron-right' : 'chevron-down', 14)), h('span', { className: 'channel-cat-label', text: label }));
      toggle.addEventListener('click', () => { if (folded) collapsedCats.delete(key); else collapsedCats.add(key); paintChannels(); });
      head.appendChild(toggle);
      if (manage) {
        if (cat) head.appendChild(iconButton('Edit category', icon('settings', 14), () => editCategory(s, cat), 'channel-cat-add'));
        head.appendChild(iconButton('Add channel', icon('plus', 16), () => newChannelDialog(s, catId, kind || 'text'), 'channel-cat-add'));
      }
      channelItems.appendChild(head);
      if (!folded) for (const ch of chans) channelRow(ch);
    };

    // Uncategorised channels keep the Text / Voice split; named categories list their channels (text first).
    group('', 'Text Channels', undefined, 'text');
    group('', 'Voice Channels', undefined, 'voice');
    for (const cat of s.categories) group(cat.id, cat.name, cat);
    if (s.channels.length === 0 && !manage) channelItems.appendChild(h('p', { className: 'dim conv-empty', text: 'No channels yet.' }));
  }

  /** A member's highest role colour in this server, or '' when none. */
  function serverRoleColor(s: Server, username: string): string {
    const m = s.members.find((x) => x.username.toLowerCase() === username.toLowerCase());
    if (!m) return '';
    let best: Role | undefined;
    for (const rid of m.roles) {
      const r = s.roles.find((x) => x.id === rid);
      if (r && r.color && (!best || r.position > best.position)) best = r;
    }
    return best ? best.color : '';
  }

  /** Paint a rendered name in the member's top role colour, if they have one. */
  function tintName(el: HTMLElement, s: Server, username: string): void {
    const color = serverRoleColor(s, username);
    if (color) el.style.color = color;
  }

  /** A member's highest-position role (any role, not just coloured), for grouping. */
  function topRole(s: Server, m: Member): Role | undefined {
    let best: Role | undefined;
    for (const rid of m.roles) { const r = s.roles.find((x) => x.id === rid); if (r && (!best || r.position > best.position)) best = r; }
    return best;
  }

  /** Discord-style member list on the right of a server channel: online grouped by top role, then plain Online, then Offline. */
  function paintMemberPane(): void {
    const s = isChannel() ? serverOfChannel(current) : undefined;
    if (!s) { memberPane.hidden = true; memberPane.replaceChildren(); return; }
    memberPane.hidden = false;
    memberPane.replaceChildren();
    memberPane.appendChild(h('div', { className: 'member-pane-head', text: s.members.length + (s.members.length === 1 ? ' member' : ' members') }));

    const online = s.members.filter((m) => m.state !== 'offline');
    const offline = s.members.filter((m) => m.state === 'offline');
    const groups: { label: string; color: string; members: Member[] }[] = [];
    for (const r of s.roles) {
      const mem = online.filter((m) => { const t = topRole(s, m); return t ? t.id === r.id : false; });
      if (mem.length) groups.push({ label: r.name, color: r.color, members: mem });
    }
    const plainOnline = online.filter((m) => !topRole(s, m));
    if (plainOnline.length) groups.push({ label: 'Online', color: '', members: plainOnline });
    if (offline.length) groups.push({ label: 'Offline', color: '', members: offline });

    for (const g of groups) {
      const head = h('div', { className: 'member-pane-cat', text: g.label.toUpperCase() + ' — ' + g.members.length });
      if (g.color) head.style.color = g.color;
      memberPane.appendChild(head);
      for (const m of g.members) {
        const nm = userName(m.username, 'member-pane-name');
        tintName(nm, s, m.username);
        const row = h('a', { className: 'member-pane-row' + (m.state === 'offline' ? ' is-off' : ''), attrs: { href: profileRoute(m.username), title: m.username } },
          h('span', { className: 'member-pane-av' }, userAvatar(m.username, 28), h('span', { className: 'presence-dot member-pane-dot is-' + m.state })), nm);
        if (m.username.toLowerCase() === s.owner.toLowerCase()) row.appendChild(h('span', { className: 'role-admin-badge member-pane-badge', text: 'owner' }));
        else if (m.admin) row.appendChild(h('span', { className: 'role-admin-badge member-pane-badge', text: 'admin' }));
        memberPane.appendChild(row);
      }
    }
  }

  function syncListPane(): void {
    if (activeServerId) listBox.replaceChildren(channelHead, channelItems);
    else listBox.replaceChildren(listHead, listItems);
  }

  function showHome(): void {
    if (!activeServerId && !isChannel()) return;
    activeServerId = '';
    syncListPane();
    if (isChannel()) leave(); else { paintRail(); paintList(); paintPane(); }
    paintRail();
  }

  function selectServer(id: string): void {
    const s = servers.find((x) => x.id === id);
    if (!s) return;
    if (closeMenu) closeMenu();
    if (activeServerId === id) { paintRail(); paintList(); return; }
    activeServerId = id;
    syncListPane();
    if (current) leave(); else paintPane();
    paintRail();
    paintList();
  }

  function selectChannel(s: Server, ch: Channel): void {
    if (activeServerId !== s.id) { activeServerId = s.id; syncListPane(); }
    void select(ch.id, ch.name);
  }

  /** Small name prompt shared by new server / new channel / rename channel. */
  function nameDialog(title: string, label: string, actionLabel: string, run: (name: string) => Promise<void>): void {
    const input = h('input', { className: 'input', attrs: { type: 'text', placeholder: label, 'aria-label': label, maxlength: '60', autocomplete: 'off' } });
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let busy = false;
    const overlay = modal({
      title, body: h('div', { className: 'group-form' }, input, err),
      actions: [{ label: 'Cancel' }, {
        label: actionLabel, kind: 'primary',
        onClick: () => {
          const name = input.value.trim();
          const problem = !name ? 'Give it a name.' : validateGroupName(name);
          err.hidden = !problem; err.textContent = problem || '';
          if (problem || busy) return false;
          busy = true;
          closeModal(overlay);
          run(name).catch((x) => toast('Could not save: ' + describeError(x), 'error'));
          return false;
        },
      }],
    });
  }

  function newServer(): void {
    nameDialog('New server', 'Server name', 'Create server', (name) => createServer(name).then((s) => {
      mergeServer(s);
      activeServerId = s.id;
      syncListPane();
      paintRail();
      paintList();
      const general = s.channels.find((c) => c.name.toLowerCase() === 'general') || s.channels[0];
      if (general) void selectChannel(s, general); else paintPane();
    }));
  }

  function newChannelDialog(s: Server, categoryId = '', defaultKind: 'text' | 'voice' = 'text'): void {
    const input = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'Channel name', 'aria-label': 'Channel name', maxlength: '60', autocomplete: 'off' } });
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let kind: 'text' | 'voice' = defaultKind;
    const textBtn = h('button', { className: 'seg' + (defaultKind === 'text' ? ' is-on' : ''), attrs: { type: 'button' } }, icon('forum', 16), h('span', { text: 'Text' }));
    const voiceBtn = h('button', { className: 'seg' + (defaultKind === 'voice' ? ' is-on' : ''), attrs: { type: 'button' } }, icon('lobbies', 16), h('span', { text: 'Voice' }));
    const pick = (k: 'text' | 'voice'): void => { kind = k; textBtn.classList.toggle('is-on', k === 'text'); voiceBtn.classList.toggle('is-on', k === 'voice'); };
    textBtn.addEventListener('click', () => pick('text'));
    voiceBtn.addEventListener('click', () => pick('voice'));
    let busy = false;
    const overlay = modal({
      title: 'New channel', body: h('div', { className: 'group-form' }, h('div', { className: 'channel-kind-seg' }, textBtn, voiceBtn), input, err),
      actions: [{ label: 'Cancel' }, {
        label: 'Create channel', kind: 'primary',
        onClick: () => {
          const name = input.value.trim();
          const problem = !name ? 'Give it a name.' : validateGroupName(name);
          err.hidden = !problem; err.textContent = problem || '';
          if (problem || busy) return false;
          busy = true; closeModal(overlay);
          createChannel(s.id, name, kind, categoryId || undefined).then((ch) => {
            const fresh = servers.find((x) => x.id === s.id) || s;
            mergeServer({ ...fresh, channels: fresh.channels.concat(ch).sort((a, b) => a.position - b.position) });
            paintRail();
            void selectChannel(servers.find((x) => x.id === s.id) || fresh, ch);
          }).catch((x) => toast('Could not create channel: ' + describeError(x), 'error'));
          return false;
        },
      }],
    });
  }

  function newCategory(s: Server): void {
    nameDialog('New category', 'Category name', 'Create category', (name) => createCategory(s.id, name).then((cat) => {
      const fresh = servers.find((x) => x.id === s.id) || s;
      mergeServer({ ...fresh, categories: fresh.categories.concat(cat).sort((a, b) => a.position - b.position) });
      paintList();
    }));
  }

  function editCategory(s: Server, cat: Category): void {
    const input = h('input', { className: 'input', attrs: { type: 'text', 'aria-label': 'Category name', maxlength: '60', autocomplete: 'off' } });
    input.value = cat.name;
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let busy = false;
    const overlay = modal({
      title: 'Edit category', body: h('div', { className: 'group-form' }, input, err),
      actions: [
        {
          label: 'Delete', kind: 'danger', onClick: () => {
            if (busy) return false; busy = true; closeModal(overlay);
            deleteCategory(s.id, cat.id).then(() => {
              const fresh = servers.find((x) => x.id === s.id); if (!fresh) return;
              mergeServer({ ...fresh, categories: fresh.categories.filter((c) => c.id !== cat.id), channels: fresh.channels.map((c) => (c.categoryId === cat.id ? { ...c, categoryId: '' } : c)) });
              paintList();
            }).catch((x) => toast('Could not delete category: ' + describeError(x), 'error'));
            return false;
          },
        },
        { label: 'Cancel' },
        {
          label: 'Save', kind: 'primary', onClick: () => {
            const name = input.value.trim();
            const problem = !name ? 'Give it a name.' : validateGroupName(name);
            err.hidden = !problem; err.textContent = problem || '';
            if (problem || busy) return false;
            busy = true; closeModal(overlay);
            updateCategory(s.id, cat.id, { name }).then((updated) => {
              const fresh = servers.find((x) => x.id === s.id); if (!fresh) return;
              mergeServer({ ...fresh, categories: fresh.categories.map((c) => (c.id === updated.id ? updated : c)) });
              paintList();
            }).catch((x) => toast('Could not rename category: ' + describeError(x), 'error'));
            return false;
          },
        },
      ],
    });
  }

  function settingsSection(title: string, ...children: Node[]): HTMLElement {
    return h('section', { className: 'settings-section' }, h('h3', { className: 'settings-h', text: title }), ...children);
  }

  function editRole(s: Server, role: Role | null, done: () => void): void {
    const name = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'Role name', 'aria-label': 'Role name', maxlength: '40', autocomplete: 'off' } });
    name.value = role ? role.name : '';
    const color = h('input', { className: 'role-color', attrs: { type: 'color', 'aria-label': 'Role colour' } });
    color.value = role && role.color ? role.color : '#88ccff';
    const noColor = h('input', { attrs: { type: 'checkbox' } });
    noColor.checked = !!role && !role.color;
    const admin = h('input', { attrs: { type: 'checkbox' } });
    admin.checked = !!role && role.admin;
    const err = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    let busy = false;
    const body = h('div', { className: 'group-form' },
      name,
      h('label', { className: 'settings-check' }, color, h('span', { text: 'Name colour' })),
      h('label', { className: 'settings-check' }, noColor, h('span', { text: 'No colour' })),
      h('label', { className: 'settings-check' }, admin, h('span', { text: 'Admin — can manage this server' })),
      err);
    const overlay = modal({
      title: role ? 'Edit role' : 'New role', body,
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary', onClick: () => {
          const nm = name.value.trim();
          if (!nm) { err.hidden = false; err.textContent = 'Give it a name.'; return false; }
          if (busy) return false; busy = true; closeModal(overlay);
          const col = noColor.checked ? '' : color.value;
          const p = role ? updateRole(s.id, role.id, { name: nm, color: col, admin: admin.checked }) : createRole(s.id, nm, col, admin.checked);
          p.then(done).catch((x) => toast('Could not save role: ' + describeError(x), 'error'));
          return false;
        },
      }],
    });
  }

  function emojiAddRow(s: Server, done: () => void): HTMLElement {
    const short = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'shortcode', maxlength: '32', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Emoji shortcode' } });
    const file = h('input', { className: 'settings-emoji-file', attrs: { type: 'file', accept: 'image/png,image/gif,image/webp', 'aria-label': 'Emoji image (PNG, GIF or WebP)' } });
    const msg = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
    const add = button('Add emoji', { kind: 'secondary', icon: 'plus', onClick: () => {
      const sc = short.value.trim().toLowerCase();
      const f = file.files && file.files[0];
      if (!/^[a-z0-9_]{2,32}$/.test(sc)) { msg.hidden = false; msg.textContent = 'Shortcode: 2-32 letters, numbers or underscores.'; return; }
      if (!f) { msg.hidden = false; msg.textContent = 'Choose a PNG, GIF or WebP image.'; return; }
      msg.hidden = true;
      addServerEmoji(s.id, sc, f).then(() => { short.value = ''; file.value = ''; done(); }).catch((x) => { msg.hidden = false; msg.textContent = describeError(x); });
    } });
    return h('div', { className: 'settings-emoji-add' }, h('div', { className: 'settings-emoji-add-row' }, file), h('div', { className: 'settings-emoji-add-row' }, short, add), msg);
  }

  function openServerSettings(s0: Server): void {
    const body = h('div', { className: 'server-settings' });
    let emojis: ServerEmoji[] = [];
    const cur = (): Server => servers.find((x) => x.id === s0.id) || s0;
    const refresh = (): void => { void loadServers().then(() => render()); };

    const render = (): void => {
      const s = cur();
      body.replaceChildren();

      // Overview — rename
      const nameInput = h('input', { className: 'input', attrs: { type: 'text', 'aria-label': 'Server name', maxlength: '60', autocomplete: 'off' } });
      nameInput.value = s.name;
      const saveName = button('Save', { kind: 'primary', onClick: () => {
        const name = nameInput.value.trim(); if (!name) return;
        renameServer(s.id, name).then((up) => { mergeServer(up); render(); }).catch((x) => toast('Could not rename: ' + describeError(x), 'error'));
      } });
      body.appendChild(settingsSection('Server name', h('div', { className: 'settings-row' }, nameInput, saveName)));

      // Roles
      const rolesBox = h('div', { className: 'settings-roles' });
      for (const r of s.roles) {
        const chip = h('span', { className: 'role-chip', text: r.name });
        if (r.color) chip.style.color = r.color;
        rolesBox.appendChild(h('div', { className: 'settings-list-row' },
          chip,
          r.admin ? h('span', { className: 'role-admin-badge', text: 'admin' }) : h('span'),
          h('div', { className: 'settings-row-actions' },
            button('Edit', { kind: 'ghost', onClick: () => editRole(s, r, refresh) }),
            button('Delete', { kind: 'ghost', onClick: () => deleteRole(s.id, r.id).then(refresh).catch((x) => toast('Could not delete role: ' + describeError(x), 'error')) }))));
      }
      if (s.roles.length === 0) rolesBox.appendChild(h('p', { className: 'dim', text: 'No roles yet.' }));
      rolesBox.appendChild(button('Add role', { kind: 'secondary', icon: 'plus', onClick: () => editRole(s, null, refresh) }));

      const membersBox = h('div', { className: 'settings-members' });
      for (const m of s.members) {
        const row = h('div', { className: 'settings-member-row' });
        const nm = userName(m.username, 'settings-member-name'); tintName(nm, s, m.username);
        row.append(userAvatar(m.username, 28), nm);
        if (m.username.toLowerCase() === s.owner.toLowerCase()) row.appendChild(h('span', { className: 'role-admin-badge', text: 'owner' }));
        const toggles = h('div', { className: 'role-toggles' });
        for (const r of s.roles) {
          const on = m.roles.includes(r.id);
          const t = h('button', { className: 'role-toggle' + (on ? ' is-on' : ''), attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false' }, text: r.name });
          if (r.color && on) { t.style.borderColor = r.color; t.style.color = r.color; }
          t.addEventListener('click', () => {
            const next = on ? m.roles.filter((x) => x !== r.id) : m.roles.concat(r.id);
            setMemberRoles(s.id, m.username, next).then(refresh).catch((x) => toast('Could not set roles: ' + describeError(x), 'error'));
          });
          toggles.appendChild(t);
        }
        row.appendChild(toggles);
        membersBox.appendChild(row);
      }
      body.appendChild(settingsSection('Roles', rolesBox, s.roles.length ? h('p', { className: 'dim settings-note', text: 'Give members roles:' }) : h('span'), membersBox));

      // Emoji
      const grid = h('div', { className: 'settings-emoji-grid' });
      for (const e of emojis) {
        const cell = h('div', { className: 'settings-emoji' },
          h('img', { attrs: { src: socialMediaSrc(e.url), alt: ':' + e.shortcode + ':', title: ':' + e.shortcode + ':', decoding: 'async' } }),
          h('span', { className: 'settings-emoji-code dim', text: ':' + e.shortcode + ':' }));
        cell.appendChild(iconButton('Remove emoji', icon('x', 14), () => {
          removeServerEmoji(s.id, e.shortcode).then(() => { emojis = emojis.filter((x) => x.shortcode !== e.shortcode); render(); }).catch((x) => toast('Could not remove: ' + describeError(x), 'error'));
        }, 'settings-emoji-rm'));
        grid.appendChild(cell);
      }
      if (emojis.length === 0) grid.appendChild(h('p', { className: 'dim', text: 'No server emoji yet.' }));
      body.appendChild(settingsSection('Emoji',
        h('p', { className: 'dim settings-note', text: 'Anyone who joins this server unlocks these in their own emoji picker — forever, anywhere.' }),
        grid, emojiAddRow(s, () => { void reloadEmojis(); })));
    };

    const reloadEmojis = async (): Promise<void> => {
      try { emojis = await listServerEmojis(s0.id); } catch { emojis = []; }
      render();
    };
    modal({ title: 'Server settings', body, actions: [{ label: 'Done' }] });
    render();
    void reloadEmojis();
  }

  let closeContextMenu: (() => void) | null = null;
  /** A small floating menu at (x, y); each item is [label, run] (a 'danger' third entry tints it). Closes on outside click or Escape. */
  function contextMenu(x: number, y: number, items: { label: string; run: () => void; danger?: boolean }[]): void {
    if (closeContextMenu) closeContextMenu();
    const menu = h('div', { className: 'ctx-menu', attrs: { role: 'menu' } });
    for (const it of items) {
      const b = h('button', { className: 'ctx-item' + (it.danger ? ' is-danger' : ''), attrs: { type: 'button', role: 'menuitem' }, text: it.label });
      b.addEventListener('click', () => { close(); it.run(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 80;
    menu.style.left = Math.round(Math.min(x, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = Math.round(Math.min(y, window.innerHeight - mh - 8)) + 'px';
    const onDown = (ev: Event): void => { if (!menu.contains(ev.target as Node)) close(); };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
    function close(): void {
      menu.remove();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      if (closeContextMenu === close) closeContextMenu = null;
    }
    closeContextMenu = close;
    setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function openChannelMenu(s: Server, ch: Channel, x: number, y: number): void {
    contextMenu(x, y, [
      { label: 'Rename channel', run: () => renameChannelDialog(s, ch) },
      { label: 'Delete channel', run: () => removeChannel(s, ch), danger: true },
    ]);
  }

  function renameChannelDialog(s: Server, ch: Channel): void {
    nameDialog('Rename channel', 'Channel name', 'Save', (name) => renameChannel(s.id, ch.id, { name }).then((updated) => {
      const fresh = servers.find((x) => x.id === s.id);
      if (!fresh) return;
      mergeServer({ ...fresh, channels: fresh.channels.map((c) => (c.id === updated.id ? updated : c)) });
      if (current === updated.id) { currentName = updated.name; paintHead(); }
      paintRail();
      paintList();
    }));
  }

  function removeChannel(s: Server, ch: Channel): void {
    modal({
      title: 'Delete channel', body: 'Delete #' + ch.name + '? Its messages will be removed.',
      actions: [{ label: 'Cancel' }, {
        label: 'Delete', kind: 'danger',
        onClick: () => {
          deleteChannel(s.id, ch.id).then(() => {
            const fresh = servers.find((x) => x.id === s.id);
            if (!fresh) return;
            mergeServer({ ...fresh, channels: fresh.channels.filter((c) => c.id !== ch.id) });
            if (current === ch.id) leave();
            paintRail();
            paintList();
          }).catch((x) => toast('Could not delete channel: ' + describeError(x), 'error'));
        },
      }],
    });
  }

  async function loadServers(): Promise<void> {
    try {
      const loaded = await listServers();
      if (disposed) return;
      servers = loaded;
      serversLoaded = true;
      servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      if (isChannel() && !activeServerId) {
        const s = serverOfChannel(current);
        if (s) { activeServerId = s.id; syncListPane(); }
      }
      if (isChannel()) { const ch = channelOf(current); if (ch) currentName = ch.name; }
      paintRail();
      paintList();
      if (current) { paintHead(); syncVoicePane(); }
    } catch {
      // The rail is still usable (Home and + work); a reconnect reload will retry.
    }
  }

  function takeServer(raw: unknown): void {
    const s = normalizeServer(raw);
    if (!s) return;
    mergeServer(s);
    if (isChannel() && !serverOfChannel(current)) leave();   // deleted channel, or we were removed
    if (isChannel()) { const ch = channelOf(current); if (ch) currentName = ch.name; }
    paintRail();
    paintList();
    if (current) { paintHead(); syncVoicePane(); }
  }

  function paintList(): void {
    if (activeServerId) { paintChannels(); return; }
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

  /** DM/group only: channels already have their own Join voice control. */
  function callButtons(): HTMLElement {
    const busy = !!voice && voice.convId === current && (voice.joined || voiceBusy);
    return h('div', { className: 'thread-call-actions' },
      button('Call', { kind: 'ghost', icon: 'phone', title: 'Start an audio call', disabled: busy, onClick: () => startCall('audio') }),
      button('Video call', { kind: 'ghost', icon: 'camera', title: 'Start a video call', disabled: busy, onClick: () => startCall('video') }));
  }

  function paintHead(): void {
    headEl.replaceChildren();
    paintMemberPane();
    const e = cur();
    const back = h('button', { className: 'thread-back', attrs: { type: 'button', 'aria-label': isChannel() ? 'Back to channels' : 'Back to conversations' }, text: '‹ Back' });
    back.addEventListener('click', () => leave());
    headEl.appendChild(back);
    if (isChannel()) {
      const s = serverOfChannel(current);
      const ch = channelOf(current);
      const name = ch ? ch.name : currentName;
      const voiceCh = isVoice();
      headEl.appendChild(h('span', { className: 'channel-hash thread-hash dim' }, voiceCh ? icon('lobbies', 22) : h('span', { text: '#' })));
      headEl.appendChild(h('div', { className: 'thread-who' },
        h('span', { className: 'thread-channel-name', text: name }),
        h('div', { className: 'social-sub', text: voiceCh
          ? (voiceState && voiceState.convId === current ? voiceState.members.length : 0) + ' in voice'
          : (ch && ch.topic ? ch.topic : (s ? s.name : '')) })));
      // Channel management lives on the sidebar row's right-click menu now, not here.
      return;
    }
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
      headEl.appendChild(callButtons());
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
    headEl.appendChild(callButtons());
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
  // Only renders when the message actually has reactions, so empty messages don't reserve a row of height.
  function reactionRow(m: ThreadMessage): HTMLElement | null {
    if (m.id <= 0) return null;
    const reactions = m.reactions || {};
    const emojis = Object.keys(reactions).filter((e) => (reactions[e] || []).length > 0);
    if (emojis.length === 0) return null;
    const row = h('div', { className: 'msg-reactions' });
    for (const emoji of emojis) {
      const users = reactions[emoji] || [];
      const mine = users.some((u) => u.toLowerCase() === me.toLowerCase());
      const chip = h('button', {
        className: 'msg-reaction' + (mine ? ' is-mine' : ''),
        title: emoji + ' ' + users.length + (mine ? ' (you reacted)' : ''),
        attrs: { type: 'button', 'aria-label': 'React ' + emoji + ', ' + users.length + (mine ? '. Remove your reaction' : '. Add your reaction'), 'aria-pressed': mine ? 'true' : 'false' },
      }, reactionFace(emoji), h('span', { className: 'msg-reaction-count', text: String(users.length) }));
      chip.addEventListener('click', () => toggleReaction(m, emoji));
      row.appendChild(chip);
    }
    return row;
  }

  /** The delivered/seen tick shown at the left gutter of your newest message. */
  function leftTick(seen: boolean): HTMLElement {
    const t = h('span', { className: 'msg-tick-left' + (seen ? ' is-seen' : ''), attrs: { title: seen ? 'Seen' : 'Delivered', 'aria-label': seen ? 'Seen' : 'Delivered' } });
    t.appendChild(icon('check', 13));
    if (seen) t.appendChild(icon('check', 13));
    return t;
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
      const who = userName(m.from, 'msg-who');
      const chSrv = isChannel() ? serverOfChannel(current) : undefined;
      if (chSrv) tintName(who, chSrv, m.from);
      const head = h('div', { className: 'msg-head' },
        who,
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
      const reactBtn = h('button', { className: 'msg-react-btn', title: 'Add reaction', attrs: { type: 'button', 'aria-label': 'Add reaction' } }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '🙂' }));
      reactBtn.addEventListener('click', () => { reactionTarget = m; reactionPicker.open(reactBtn); });
      wrap.appendChild(reactBtn);
      col.addEventListener('dblclick', () => setReply(m));
    }
    return wrap;
  }

  function statusNode(): HTMLElement | null {
    const s = statusFor(thread, me, seenUpTo);
    if (!s || s.kind === 'delivered' || s.kind === 'seen') return null;   // the tick is drawn on the left of the last message
    const node = h('div', { className: 'msg-status dim' + (s.kind === 'failed' ? ' is-failed' : '') });
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
      const start = isChannel() ? 'This is the start of #' + name + '.'
        : isGroup() ? 'This is the start of ' + name + '.' : 'This is the start of your conversation with ' + name + '.';
      threadEl.appendChild(h('p', { className: 'dim thread-start', text: start }));
    }
    if (thread.length === 0) {
      const hint = isChannel() ? 'Say hello in #' + name + '.' : isGroup() ? 'Say hello to the group.' : 'Say hello to ' + name + '.';
      threadEl.appendChild(h('div', { className: 'thread-empty' }, h('p', { text: 'No messages yet.' }), h('p', { className: 'dim', text: hint })));
    }
    const tickStatus = statusFor(thread, me, seenUpTo);
    const status = statusNode();
    const statusAfter = (() => { let k = ''; for (const m of thread) if (isMine(m, me)) k = m.id > 0 ? String(m.id) : m.cid; return k; })();
    for (const row of groupThread(thread, me, Date.now(), readMark)) {
      if (row.kind === 'day') threadEl.appendChild(h('div', { className: 'day-sep' }, h('span', { text: row.label })));
      else if (row.kind === 'new') threadEl.appendChild(h('div', { className: 'new-sep', attrs: { role: 'separator' } }, h('span', { text: 'New messages' })));
      else {
        const node = messageNode(row);
        threadEl.appendChild(node);
        const key = row.msg.id > 0 ? String(row.msg.id) : row.msg.cid;
        if (row.mine && key === statusAfter) {
          if (tickStatus && (tickStatus.kind === 'delivered' || tickStatus.kind === 'seen')) node.appendChild(leftTick(tickStatus.kind === 'seen'));
          if (status) threadEl.appendChild(status);
        }
      }
    }
    if (opts.forceBottom || (pinned && !opts.keepFromBottom)) threadEl.scrollTop = threadEl.scrollHeight;
    else threadEl.scrollTop = threadEl.scrollHeight - threadEl.clientHeight - fromBottom;
    if (pinned || opts.forceBottom) jump.hidden = true;
  }

  function paintBanner(): void {
    banner.hidden = !offline;
  }

  // ---- voice rooms and calls ----
  function stopVoice(): void {
    if (voice) voice.leave();
    voice = null;
    voiceState = null;
    voiceError = '';
    voiceBusy = false;
    joinedVoiceId = '';
    deafened = false;
    speaking.clear();
  }

  function ensureVoice(): VoiceClient | null {
    if (disposed || !(isVoice() || isCall())) return null;
    if (voice && voice.convId === current) return voice;
    stopVoice();
    voice = new VoiceClient(current, me, {
      onState: (state) => { voiceState = state; paintVoiceRoom(); paintHead(); },
      onTrack: () => paintVoiceRoom(),
      onTrackLost: () => paintVoiceRoom(),
      onError: (message) => { voiceError = message; paintVoiceRoom(); },
      onLevel: (name, active) => { if (active) speaking.add(name); else speaking.delete(name); paintVoiceRoom(); },
    });
    if (isVoice()) voice.enter();   // channel roster preview only; calls ring on join
    return voice;
  }

  /** Servers arrive after the hash route; switch the pane once a voice channel is known. */
  function syncVoicePane(): void {
    if (!current || disposed) return;
    const nowVoice = isVoice();
    if (nowVoice !== voicePaneShown) paintPane();
    if (nowVoice) ensureVoice();
    else if (voice && !isCall()) stopVoice();
  }

  async function joinVoice(kind: CallKind = 'audio'): Promise<void> {
    let client = ensureVoice();
    if (!client || voiceBusy || client.joined) return;
    if (client.closed) { stopVoice(); client = ensureVoice(); if (!client) return; }
    joinedVoiceId = current;   // you're in the room now (your tile shows); media connects in the background
    voiceBusy = true;
    voiceError = '';
    paintVoiceRoom();
    paintHead();
    await client.join(kind);
    voiceBusy = false;
    if (!disposed && voice === client) { paintVoiceRoom(); paintHead(); }
  }

  function startCall(kind: CallKind): void {
    if (!disposed && isCall()) void joinVoice(kind);
  }

  /** An accepted incoming call joins from whichever view the router lands in. */
  function usePendingCall(): void {
    if (disposed || !current) return;
    const next = takeCallJoin(current);
    if (next) void joinVoice(next.kind);
  }

  function leaveVoice(): void {
    const wasCall = isCall();
    stopVoice();
    if (!disposed) { if (wasCall) paintPane(); else if (isVoice()) paintVoiceRoom(); }
  }

  function paintVoiceRoom(): void {
    if (disposed || !voiceRoom.isConnected || !(isVoice() || isCall())) return;
    callDock.hidden = !(isCall() && !!voice && voice.convId === current);
    voiceNotice.hidden = !voiceError;
    voiceNotice.textContent = voiceError;
    voiceTiles.replaceChildren();
    const inThisRoom = joinedVoiceId === current;
    const members = voiceState && voiceState.convId === current ? voiceState.members.slice() : [];
    // Once you've joined, your own tile shows straight away (Discord-style), even before the SFU roster round-trips.
    if (inThisRoom && !members.some((m) => m.username.toLowerCase() === me.toLowerCase())) {
      members.unshift({ username: me, muted: voice ? voice.isMuted : false, cam: voice ? voice.cameraOn : false } as never);
    }
    if (members.length === 0) {
      voiceTiles.appendChild(h('p', { className: 'dim voice-empty', text: voice
        ? (isCall() ? 'Connecting...' : 'You are the first one here.')
        : 'Nobody here yet. Join to see who is in this room.' }));
    }
    for (const m of members) {
      const mine = m.username.toLowerCase() === me.toLowerCase();
      const tile = h('div', {
        className: 'voice-tile' + (mine ? ' is-me' : '') + (m.muted ? ' is-muted' : '') + (speaking.has(m.username.toLowerCase()) ? ' is-speaking' : ''),
      });
      tile.appendChild(userAvatar(m.username, 64));
      tile.appendChild(h('div', { className: 'voice-person' },
        userName(m.username, 'voice-name'),
        h('span', { className: 'voice-state dim', text: m.muted ? 'Muted' : m.cam ? 'Camera on' : mine ? 'You' : '' })));
      if (voice) {
        const audio = voice.mediaFor(m.username, 'mic');
        if (audio) { audio.classList.add('voice-media-mic'); tile.appendChild(audio); }
      }
      if (voice && m.cam) {
        const video = voice.mediaFor(m.username, 'cam');
        if (video) { video.classList.add('voice-cam'); tile.appendChild(video); }
      }
      voiceTiles.appendChild(tile);
    }
    voiceControls.replaceChildren();
    if (!inThisRoom) {
      const label = isCall() ? (voiceBusy ? 'Calling...' : 'Join call') : voiceBusy ? 'Joining...' : 'Join voice';
      const join = button(label, { kind: 'primary', icon: isCall() ? 'phone' : 'lobbies', disabled: voiceBusy, onClick: () => { void joinVoice(); } });
      voiceControls.append(join, h('span', { className: 'voice-hint dim', text: members.length
        ? members.length + (members.length === 1 ? ' person here' : ' people here')
        : isCall() ? 'Ringing...' : 'Be the first to talk' }));
      return;
    }
    if (voiceBusy || !voice || !voice.joined) voiceControls.appendChild(h('span', { className: 'voice-hint dim', text: voiceError || 'Connecting audio…' }));
    voiceControls.append(
      button(voice.isMuted ? 'Unmute' : 'Mute', { kind: voice.isMuted ? 'secondary' : 'primary', icon: 'forum', onClick: () => voice && voice.toggleMute() }),
      button(voice.cameraOn ? 'Camera off' : 'Camera on', { kind: 'secondary', icon: 'image', onClick: () => { if (voice) void voice.toggleCamera(); } }),
      button(deafened ? 'Undeafen' : 'Deafen', { kind: 'secondary', icon: 'bell', onClick: () => { deafened = !deafened; if (voice) voice.setDeafened(deafened); paintVoiceRoom(); } }),
      button('Leave', { kind: 'danger', icon: 'x', onClick: () => leaveVoice() }),
    );
  }

  function paintPane(): void {
    pane.replaceChildren();
    root.classList.toggle('is-thread', !!current);
    if (!current) {
      voicePaneShown = false;
      pane.appendChild(activeServerId
        ? emptyState('forum', 'Pick a channel', 'Choose a channel on the left to read and send messages.')
        : emptyState('forum', 'Pick a conversation', 'Choose someone on the left to read and send messages, or start a group.'));
      return;
    }
    paintHead();
    const voiceNow = isVoice();
    voicePaneShown = voiceNow;
    if (voiceNow) {
      ensureVoice();
      pane.append(headEl, voiceRoom);
      paintVoiceRoom();
      return;
    }
    area.placeholder = isChannel() ? 'Message #' + (channelOf(current)?.name || currentName) : isGroup() ? 'Message the group' : 'Write a message';
    if (callDock.firstChild !== voiceRoom) callDock.appendChild(voiceRoom);
    pane.append(headEl, banner, callDock, threadBox, composer);
    callDock.hidden = !(voice && voice.convId === current);
    if (!callDock.hidden) paintVoiceRoom();
    paintBanner();
    paintReplyBar();
    paintThread({ forceBottom: true });
  }

  function leave(): void {
    if (closeMenu) closeMenu();
    stopVoice();
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
    paintMemberPane();
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
    if (id === current && (isVoice() ? !!voice : threadReady)) { area.focus(); return; }
    if (closeMenu) closeMenu();
    if (id !== current) stopVoice();
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
    if (!findEntry(entries, id)) entries = entries.concat({ id, kind: id.startsWith('g:') || id.startsWith('ch:') ? 'group' : 'dm', name, members: [], last: null, unread: 0, state: 'offline', detail: '', friend: false });
    try { history.replaceState(null, '', messagesRoute(id)); } catch { /* the address is cosmetic */ }
    paintList();
    paintPane();
    area.value = drafts.get(id);
    autosize();
    updateCount();
    if (isVoice()) threadReady = true;   // voice channels have no message history
    else await loadThread();
    usePendingCall();
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

  const onCallAccept = (event: Event): void => {
    const detail = (event as CustomEvent<{ convId: string; kind: CallKind }>).detail;
    if (!detail || detail.convId !== current) return;   // a remounted view consumes the pending join
    const next = takeCallJoin(current);
    if (next) void joinVoice(next.kind);
  };
  window.addEventListener(CALL_ACCEPT_EVENT, onCallAccept);

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
    } else if (event.type === 'call.ended' || event.type === 'call.declined') {
      if (String(event.convId || '') === current && isCall() && voice && (event.type === 'call.ended' || !voice.joined)) {
        stopVoice();
        paintPane();
      }
    } else if (event.type === 'server') {
      takeServer(event.server);
    } else if (event.type === 'server-left') {
      const id = String(event.id || '');
      servers = servers.filter((s) => s.id !== id);
      if (activeServerId === id) { activeServerId = ''; syncListPane(); }
      if (isChannel() && !serverOfChannel(current)) leave();
      paintRail();
      paintList();
      paintPane();
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
        reload = window.setTimeout(() => { void loadList(); void loadServers(); if (current && !isVoice()) void loadThread(); void refreshEmojis(); }, 150);
      }
    } else if (event.type === 'friends' || event.type === 'reset') {
      window.clearTimeout(reload);
      reload = window.setTimeout(() => { void loadList(); void loadServers(); if (current) void loadThread(); void refreshEmojis(); }, 150);
    }
  });

  // Emoji: the full registry renders every :shortcode: for everyone; the arsenal is what the picker offers (own uploads +
  // everything unlocked by joining servers). Load both on open and repaint when either changes.
  function refreshEmojis(): Promise<void> {
    return Promise.all([
      listEmojis().then(setCustomEmojis).catch(() => undefined),
      myArsenal().then(setArsenal).catch(() => undefined),
    ]).then(() => undefined);
  }
  const offEmojiChanges = onCustomEmojis(() => paintThread());

  updateCount();
  paintRail();
  paintList();
  paintPane();
  if (current) { setActiveConversation(current); area.value = drafts.get(current); }
  autosize();
  updateCount();
  const ready = Promise.all([loadSocialBase(), loadList(), loadServers(), current ? loadThread() : Promise.resolve(), refreshEmojis()]).then(() => { usePendingCall(); });

  return {
    element: root,
    ready,
    dispose(): void {
      stopVoice();
      disposed = true;
      setActiveConversation(null);
      window.clearTimeout(reload);
      window.removeEventListener(CALL_ACCEPT_EVENT, onCallAccept);
      document.removeEventListener('visibilitychange', onVisible);
      if (closeMenu) closeMenu();
      offEmojiChanges();
      emoji.dispose();
      reactionPicker.dispose();
      drafts.set(current, area.value);
      stop();
    },
  };
}
