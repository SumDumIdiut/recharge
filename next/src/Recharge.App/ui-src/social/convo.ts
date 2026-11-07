/** The messaging model: thread merge, send state, day grouping, conversation list and unread rules. DOM-free so the tests can import it. */
import type { Conversation, FriendsData, Member, Message, PresenceState, ReplyRef } from './model.js';

export type SendState = 'sent' | 'sending' | 'failed';

/** A message in an open thread. Unsent ones carry a negative id and a client id (cid) the server uses to drop duplicates. */
export interface ThreadMessage extends Message {
  state: SendState;
  error: string;
}

export interface Entry {
  /** The conversation id: `dm:a|b` or `g:...`. */
  id: string;
  kind: 'dm' | 'group';
  /** The other person's name for a DM, the group's name for a group. */
  name: string;
  members: Member[];
  last: Message | null;
  unread: number;
  state: PresenceState;
  detail: string;
  friend: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const norm = (a: string): string => a.trim().toLowerCase();

/** The id the server gives the DM between two people (so a chat can be opened before it has any messages). */
export function dmId(a: string, b: string): string {
  return 'dm:' + [norm(a), norm(b)].sort().join('|');
}

/** The conversation a message belongs to: its own id, or the DM between the two people on an old-style message. */
export function convIdOf(m: Message, me: string): string {
  if (m.convId) return m.convId;
  return dmId(me, isMine(m, me) ? m.to : m.from);
}

/** The reply snapshot to send along with / show for a message. */
export function replyRefOf(m: { id: number; from: string; text: string; card: unknown }): ReplyRef {
  return { id: m.id, from: m.from, text: m.text.replace(/\s+/g, ' ').trim().slice(0, 120) };
}

/** What a quoted message shows: its text, or a note when it was a card. */
export function replySnippet(r: ReplyRef): string {
  return r.text || 'Attachment';
}

export function isMine(m: { from: string }, me: string): boolean {
  return same(m.from, me);
}

/** A fresh client id: letters, digits, - and _ only (what the server accepts), 64 characters at most. */
export function newCid(random: () => number = Math.random, now: number = Date.now()): string {
  let out = 'c' + now.toString(36) + '-';
  for (let i = 0; i < 10; i++) out += Math.floor(random() * 36).toString(36);
  return out;
}

let pendingSeq = 0;

/** The local copy of a message being sent (shown at once, before the server answers). */
export function pendingMessage(me: string, convId: string, text: string, cid: string, ts: number = Date.now(), replyTo: ReplyRef | null = null): ThreadMessage {
  pendingSeq += 1;
  return { id: -pendingSeq, convId, from: me, to: '', text, card: null, ts, cid, replyTo, state: 'sending', error: '' };
}

export function confirmed(m: Message): ThreadMessage {
  return { ...m, state: 'sent', error: '' };
}

/** Confirmed messages by id, then unsent ones in the order they were typed. */
export function sortThread(list: ThreadMessage[]): ThreadMessage[] {
  return list.slice().sort((a, b) => {
    const pa = a.id <= 0; const pb = b.id <= 0;
    if (pa !== pb) return pa ? 1 : -1;
    return pa ? b.id - a.id : a.id - b.id;   // unsent ids count down (-1 was typed first), so they sort by typing order
  });
}

/** Add a message the server told us about. A copy we already hold (same id) is ignored; our own unsent copy (same cid) is replaced. */
export function mergeThread(list: ThreadMessage[], incoming: Message): ThreadMessage[] {
  if (incoming.id <= 0) return list;
  if (list.some((m) => m.id === incoming.id)) return list;
  const rest = incoming.cid ? list.filter((m) => !(m.id <= 0 && m.cid === incoming.cid)) : list;
  return sortThread(rest.concat(confirmed(incoming)));
}

export function addPending(list: ThreadMessage[], m: ThreadMessage): ThreadMessage[] {
  return sortThread(list.concat(m));
}

/** Older history arrives from the server: merge it in without duplicates. */
export function prependOlder(list: ThreadMessage[], older: Message[]): ThreadMessage[] {
  const seen = new Set(list.filter((m) => m.id > 0).map((m) => m.id));
  const fresh = older.filter((m) => m.id > 0 && !seen.has(m.id)).map(confirmed);
  return sortThread(fresh.concat(list));
}

/** A fresh first page from the server replaces what we know, but unsent messages stay. */
export function replaceHistory(list: ThreadMessage[], page: Message[]): ThreadMessage[] {
  const keep = list.filter((m) => m.id <= 0 && !page.some((p) => p.cid && p.cid === m.cid));
  return sortThread(page.filter((m) => m.id > 0).map(confirmed).concat(keep));
}

export function setSendState(list: ThreadMessage[], cid: string, state: SendState, error = ''): ThreadMessage[] {
  return list.map((m) => (m.id <= 0 && m.cid === cid ? { ...m, state, error } : m));
}

export function removePending(list: ThreadMessage[], cid: string): ThreadMessage[] {
  return list.filter((m) => !(m.id <= 0 && m.cid === cid));
}

/** Network trouble and server errors are worth another try; a refusal (blocked, not friends, too long) is not. */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// ---- grouping for display ----

export type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'msg'; key: string; msg: ThreadMessage; mine: boolean; first: boolean; last: boolean };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const startOfDay = (ts: number): number => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Yesterday", a weekday this week, else "3 Mar" (with the year when it is not this year). */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAYS[d.getDay()];
  const base = d.getDate() + ' ' + MONTHS[d.getMonth()];
  return d.getFullYear() === new Date(now).getFullYear() ? base : base + ' ' + d.getFullYear();
}

/** "14:05". */
export function clock(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export const CLUSTER_MS = 5 * 60 * 1000;

/**
 * Turn a thread into display rows: a separator at each new day, a "New messages" line after `readUpTo` (when something
 * from the other person is unread), and flags so messages from one sender within five minutes sit together.
 */
export function groupThread(list: ThreadMessage[], me: string, now: number = Date.now(), readUpTo: number | null = null): Row[] {
  const rows: Row[] = [];
  let day = '';
  let newShown = false;
  let prev: ThreadMessage | null = null;
  const msgRows: Array<Extract<Row, { kind: 'msg' }>> = [];
  for (const m of list) {
    const dayKey = String(startOfDay(m.ts));
    if (dayKey !== day) {
      day = dayKey;
      rows.push({ kind: 'day', key: 'd' + dayKey, label: dayLabel(m.ts, now) });
      prev = null;
    }
    if (!newShown && readUpTo !== null && m.id > readUpTo && !isMine(m, me)) {
      newShown = true;
      rows.push({ kind: 'new', key: 'new' });
      prev = null;
    }
    const mine = isMine(m, me);
    const joins = prev !== null && same(prev.from, m.from) && m.ts - prev.ts < CLUSTER_MS;
    const row = { kind: 'msg' as const, key: m.id > 0 ? 'm' + m.id : 'p' + m.cid, msg: m, mine, first: !joins, last: true };
    if (joins && msgRows.length > 0) msgRows[msgRows.length - 1].last = false;
    msgRows.push(row);
    rows.push(row);
    prev = m;
  }
  return rows;
}

/** Id of your newest confirmed message, or 0. */
export function lastMineId(list: ThreadMessage[], me: string): number {
  let id = 0;
  for (const m of list) if (m.id > id && isMine(m, me)) id = m.id;
  return id;
}

/** The small status under your newest message: "Sending...", "Not sent", "Seen", or "Delivered". Empty when there is none. */
export function statusFor(list: ThreadMessage[], me: string, seenUpTo: number): { key: string; text: string } | null {
  let lastMine: ThreadMessage | null = null;
  for (const m of list) if (isMine(m, me)) lastMine = m;
  if (!lastMine) return null;
  if (lastMine.state === 'sending') return { key: lastMine.cid, text: 'Sending...' };
  if (lastMine.state === 'failed') return { key: lastMine.cid, text: 'Not sent' };
  return { key: 'id' + lastMine.id, text: lastMine.id <= seenUpTo ? 'Seen' : 'Delivered' };
}

// ---- conversation list and unread ----

function entryOf(c: Conversation): Entry {
  return { id: c.id, kind: c.kind, name: c.name, members: c.members, last: c.last, unread: c.unread, state: c.state, detail: '', friend: c.friend };
}

/** The other person in a DM (anyone who is not you), for presence and avatars. */
export function otherMember(e: { members: Member[]; name: string }, me: string): string {
  const other = e.members.find((m) => !same(m.username, me));
  return other ? other.username : e.name;
}

/**
 * One list from the server's conversations plus your friends (so a friend you never wrote to still shows a DM row),
 * and the chat that is open (so it stays listed even before it has a message).
 */
export function buildEntries(convs: Conversation[], friends: FriendsData | null, current: { id: string; name: string } | null, me: string): Entry[] {
  const byId = new Map<string, Entry>();
  for (const c of convs) if (c.id) byId.set(c.id, entryOf(c));
  if (friends) {
    for (const f of friends.friends) {
      const id = dmId(me, f.username);
      const e = byId.get(id);
      if (e) { e.state = f.state; e.detail = f.detail; e.friend = true; } else byId.set(id, { id, kind: 'dm', name: f.username, members: [], last: null, unread: 0, state: f.state, detail: f.detail, friend: true });
    }
  }
  if (current && current.id && !byId.has(current.id)) {
    byId.set(current.id, { id: current.id, kind: current.id.startsWith('g:') ? 'group' : 'dm', name: current.name, members: [], last: null, unread: 0, state: 'offline', detail: '', friend: false });
  }
  return sortEntries(Array.from(byId.values()));
}

/** Newest activity first, then names. */
export function sortEntries(entries: Entry[]): Entry[] {
  return entries.slice().sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0) || a.name.localeCompare(b.name));
}

export function findEntry(entries: Entry[], id: string): Entry | undefined {
  return entries.find((e) => e.id === id);
}

/** A conversation arrived or changed (group created, renamed, members changed): add or refresh its row, keeping local presence detail. */
export function applyConversation(entries: Entry[], c: Conversation): Entry[] {
  if (!c.id) return entries;
  const old = findEntry(entries, c.id);
  const next = entryOf(c);
  if (old) {
    next.detail = old.detail;
    if (c.kind === 'dm') next.state = old.state !== 'offline' && c.state === 'offline' ? old.state : c.state;
    if (!c.last && old.last) next.last = old.last;
    if (c.unread === 0 && old.unread > 0 && !c.last) next.unread = old.unread;
  }
  return sortEntries(entries.filter((e) => e.id !== c.id).concat(next));
}

export function removeEntry(entries: Entry[], id: string): Entry[] {
  return entries.filter((e) => e.id !== id);
}

/**
 * A message arrived (or was sent): update that conversation's preview, and count it as unread when it is for you and that
 * chat is not the one being read. `conv` (sent along with pushes) lets us add a conversation we have not loaded yet.
 */
export function applyMessage(entries: Entry[], m: Message, me: string, openId: string, reading: boolean, conv: Conversation | null = null): Entry[] {
  const mine = isMine(m, me);
  const id = convIdOf(m, me);
  const next = entries.map((e) => ({ ...e }));
  let e = findEntry(next, id);
  if (!e) {
    e = conv && conv.id ? entryOf({ ...conv, unread: 0 }) : { id, kind: id.startsWith('g:') ? 'group' : 'dm', name: mine ? m.to : m.from, members: [], last: null, unread: 0, state: 'offline', detail: '', friend: false };
    next.push(e);
  } else if (conv && conv.id) {
    e.name = conv.name; e.kind = conv.kind;
    if (conv.members.length > 0) e.members = conv.members;
  }
  if (e.last && e.last.id === m.id) return entries;      // seen already (the same push twice)
  if (!e.last || m.id >= e.last.id || e.last.id <= 0) e.last = m;
  if (!mine && !(reading && id === openId)) e.unread += 1;
  return sortEntries(next);
}

/** You read this chat (here or on another device). */
export function applyRead(entries: Entry[], id: string): Entry[] {
  return entries.map((e) => (e.id === id && e.unread > 0 ? { ...e, unread: 0 } : e));
}

/** Someone's presence changed: update their DM row and their dot in any group. */
export function applyPresence(entries: Entry[], username: string, state: PresenceState, detail: string): Entry[] {
  return entries.map((e) => {
    const inGroup = e.members.some((m) => same(m.username, username));
    if (e.kind === 'dm' && same(e.name, username)) return { ...e, state, detail, members: e.members.map((m) => (same(m.username, username) ? { ...m, state } : m)) };
    return inGroup ? { ...e, members: e.members.map((m) => (same(m.username, username) ? { ...m, state } : m)) } : e;
  });
}

export function totalUnread(entries: Entry[]): number {
  let n = 0;
  for (const e of entries) n += e.unread;
  return n;
}

/** "3", or "99+". */
export function unreadLabel(n: number): string {
  return n > 99 ? '99+' : String(Math.max(0, Math.floor(n)));
}

/** The one-line preview under a name: "You: hi", a card, or an invitation to write. In a group other people's lines carry their name. */
export function previewOf(m: Message | null, me: string, group = false): string {
  if (!m) return 'Say hello';
  const body = m.text.replace(/\s+/g, ' ').trim() || (m.card ? 'Sent a ' + m.card.type : '');
  if (isMine(m, me)) return 'You: ' + body;
  return group ? m.from + ': ' + body : body;
}

/** The list search: names (or group members) containing the text, anywhere, ignoring case. */
export function filterEntries(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q) || (e.kind === 'group' && e.members.some((m) => m.username.toLowerCase().includes(q)))) : entries;
}

/** "14:05" today, "Yesterday", a weekday, else "3 Mar": the short stamp in the list. */
export function listStamp(ts: number, now: number = Date.now()): string {
  if (!ts) return '';
  const label = dayLabel(ts, now);
  if (label === 'Today') return clock(ts);
  return DAYS.includes(label) ? label.slice(0, 3) : label;
}

/** Whether to ask the server to mark a thread read: something newer than what we already told it, and the window is in use. */
export function shouldMarkRead(list: ThreadMessage[], sentUpTo: number, visible: boolean): number {
  if (!visible) return 0;
  let top = 0;
  for (const m of list) if (m.id > top) top = m.id;
  return top > sentUpTo ? top : 0;
}

/** Drafts survive switching chats while the page is open. */
export class Drafts {
  private map = new Map<string, string>();
  get(id: string): string { return this.map.get(id.toLowerCase()) || ''; }
  set(id: string, text: string): void {
    if (text) this.map.set(id.toLowerCase(), text);
    else this.map.delete(id.toLowerCase());
  }
}
