/** Shapes, normalisers and small rules for Friends & Messages. DOM-free so the tests can import it. */

export const LIM = { message: 2000, username: 40 };

export type PresenceState = 'online' | 'game' | 'lobby' | 'editing' | 'offline';

export interface Friend { username: string; since: number; state: PresenceState; detail: string; join: string }
export interface Pending { username: string; created: number }
export interface FriendsData { friends: Friend[]; incoming: Pending[]; outgoing: Pending[]; blocked: Pending[] }
export interface Card { type: 'map' | 'skin' | 'lobby'; id: string; name: string }
export interface Message { id: number; from: string; to: string; text: string; card: Card | null; ts: number }
export interface Conversation { username: string; last: Message | null; unread: number; state: PresenceState; friend: boolean }
export interface MessagePage { messages: Message[]; hasMore: boolean; readUpTo: number }

const STATES: PresenceState[] = ['online', 'game', 'lobby', 'editing', 'offline'];

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function num(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export function stateOf(value: unknown): PresenceState {
  return STATES.includes(value as PresenceState) ? (value as PresenceState) : 'offline';
}

export function normalizeFriend(raw: unknown): Friend {
  const o = obj(raw);
  return { username: text(o.username), since: num(o.since), state: stateOf(o.state), detail: text(o.detail), join: text(o.join) };
}

function pending(raw: unknown): Pending {
  const o = obj(raw);
  return { username: text(o.username), created: num(o.created) };
}

export function normalizeFriends(raw: unknown): FriendsData {
  const o = obj(raw);
  return {
    friends: list(o.friends).map(normalizeFriend).filter((f) => f.username),
    incoming: list(o.incoming).map(pending).filter((p) => p.username),
    outgoing: list(o.outgoing).map(pending).filter((p) => p.username),
    blocked: list(o.blocked).map(pending).filter((p) => p.username),
  };
}

export function normalizeCard(raw: unknown): Card | null {
  const o = obj(raw);
  const type = text(o.type);
  if ((type !== 'map' && type !== 'skin' && type !== 'lobby') || !text(o.id)) return null;
  return { type, id: text(o.id), name: text(o.name) };
}

export function normalizeMessage(raw: unknown): Message {
  const o = obj(raw);
  return { id: num(o.id), from: text(o.from), to: text(o.to), text: text(o.text), card: normalizeCard(o.card), ts: num(o.ts) };
}

export function normalizeConversations(raw: unknown): { conversations: Conversation[]; unread: number } {
  const o = obj(raw);
  const conversations = list(o.conversations).map((item): Conversation => {
    const c = obj(item);
    return { username: text(c.username), last: c.last ? normalizeMessage(c.last) : null, unread: num(c.unread), state: stateOf(c.state), friend: c.friend === true };
  }).filter((c) => c.username);
  return { conversations, unread: num(o.unread) };
}

export function normalizeMessages(raw: unknown): MessagePage {
  const o = obj(raw);
  return { messages: list(o.messages).map(normalizeMessage).filter((m) => m.id > 0), hasMore: o.hasMore === true, readUpTo: num(o.readUpTo) };
}

/** "Online", "In a game", "In lobby: Speedrun", "Editing Cliffside", or "Offline". */
export function presenceLabel(state: PresenceState, detail: string): string {
  switch (state) {
    case 'online': return 'Online';
    case 'game': return detail ? 'In game: ' + detail : 'In a game';
    case 'lobby': return detail ? 'In lobby: ' + detail : 'In a lobby';
    case 'editing': return detail ? 'Editing ' + detail : 'Editing a map';
    default: return 'Offline';
  }
}

/** True when a friend has something you can join (a lobby, or a map they invite you to). */
export function isJoinable(state: PresenceState, join: string): boolean {
  return (state === 'lobby' || state === 'editing') && join.length > 0;
}

/** Why a message can't be sent, or null. */
export function validateMessage(raw: string): string | null {
  const value = raw.replace(/\r\n?/g, '\n').trim();
  if (!value) return 'Write a message first.';
  if (value.length > LIM.message) return 'That message is too long (' + LIM.message + ' characters at most).';
  return null;
}

export function validateUsername(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Type a username.';
  if (value.length > LIM.username) return 'That username is too long.';
  if (!/^[\p{L}\p{N}_. -]+$/u.test(value)) return 'Usernames use letters, numbers, spaces and _ . - only.';
  return null;
}

export function messagesRoute(username?: string): string {
  return '#/community/messages' + (username ? '/' + encodeURIComponent(username) : '');
}

/** Merge a pushed message into a (sorted by id) list without duplicates. */
export function mergeMessage(messages: Message[], incoming: Message): Message[] {
  if (messages.some((m) => m.id === incoming.id)) return messages;
  return messages.concat(incoming).sort((a, b) => a.id - b.id);
}

/** "14:05" today, "Mon 14:05" this week, else "3 Mar". */
export function messageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const days = Math.floor((now - ts) / 86400000);
  if (new Date(now).toDateString() === d.toDateString()) return hm;
  if (days < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + hm;
  return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
}
