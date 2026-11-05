/**
 * Hub and installed-data loading with a session cache that is stale-while-revalidate: a list that is older than TTL_MS is still
 * answered at once, and refreshed in the background (one request at a time per list); pages that care subscribe with onHubChange
 * and redraw when the refreshed data differs. Lists and the installed scan are also kept in localStorage, so the next start shows
 * them before the network answers. Anything that changes what the lists or the scan say clears the entry (invalidatesFor).
 */
import { call, describeError, onCallSettled } from '../bridge.js';
import { KINDS, rowsToItems, str, type InstalledData, type Item, type Kind, type Lists } from './library.js';

export const TTL_MS = 60_000;

interface Entry<T> { at: number; value: T; raw: string }

export type HubChange = { kind: Kind } | { installed: true };

const lists = new Map<Kind, Entry<Item[]>>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<(change: HubChange) => void>();
let installedEntry: Entry<InstalledData> | null = null;
let hydrated = false;

const STORE_PREFIX = 'recharge.cache.v1.';

function store(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function persist(name: string, raw: string): void {
  try { store()?.setItem(STORE_PREFIX + name, raw); } catch { /* full or blocked: the cache is only a head start */ }
}

function unpersist(name: string): void {
  try { store()?.removeItem(STORE_PREFIX + name); } catch { /* ignore */ }
}

/** Entries saved by an earlier run, loaded once. They count as stale (at = 0), so the first use refreshes them. */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const area = store();
  if (!area) return;
  for (const kind of KINDS) {
    try {
      const raw = area.getItem(STORE_PREFIX + kind);
      if (raw && !lists.has(kind)) lists.set(kind, { at: 0, value: rowsToItems(kind, JSON.parse(raw)), raw });
    } catch { /* unreadable: fetch instead */ }
  }
  try {
    const raw = area.getItem(STORE_PREFIX + 'installed');
    if (raw && !installedEntry) installedEntry = { at: 0, value: normalizeInstalled(JSON.parse(raw)), raw };
  } catch { /* unreadable: scan instead */ }
}

function isFresh(entry: Entry<unknown> | null | undefined, now = Date.now()): boolean {
  return !!entry && now - entry.at < TTL_MS;
}

/** Whether a cache entry saved at `at` still counts as fresh at `now`. */
export function isFreshAt(at: number, now: number): boolean {
  return now - at < TTL_MS;
}

/** Cached list (possibly stale: pair it with loadKind, which refreshes it), or null when there is none. */
export function peekKind(kind: Kind): Item[] | null {
  hydrate();
  return lists.get(kind)?.value ?? null;
}

export function peekInstalled(): InstalledData | null {
  hydrate();
  return installedEntry?.value ?? null;
}

/** Forget everything cached (memory and storage). */
export function clearCache(): void {
  lists.clear();
  installedEntry = null;
  hydrated = true;
  for (const kind of KINDS) unpersist(kind);
  unpersist('installed');
}

/** Forget what is installed (after an install, removal, game change...). The next read asks the app again. */
export function invalidateInstalled(): void {
  installedEntry = null;
  unpersist('installed');
}

/** Forget some hub lists (after something was uploaded, edited or deleted there). */
export function invalidateKinds(kinds: Kind[]): void {
  for (const kind of kinds) { lists.delete(kind); unpersist(kind); }
}

/** Called for every finished bridge call; clears the cache entries the command can have made wrong. */
export function invalidatesFor(command: string, args: Record<string, unknown> | undefined): { installed: boolean; kinds: Kind[] } {
  const none = { installed: false, kinds: [] as Kind[] };
  if (command === 'library.install' || command === 'library.update' || command === 'library.remove' || command === 'library.removeFolder') {
    return { installed: true, kinds: [] };
  }
  if (command === 'settings.setGamePath' || (command.startsWith('backgrounds.') && !['backgrounds.list', 'backgrounds.mediaBase', 'backgrounds.pickFile'].includes(command))) {
    return { installed: true, kinds: [] };
  }
  if (command === 'hub.submit' && args) {
    const fields = (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>;
    const kind = typeof fields.kind === 'string' ? fields.kind + 's' : '';
    return { installed: false, kinds: (KINDS as string[]).includes(kind) ? [kind as Kind] : [...KINDS] };
  }
  if (command === 'hub.request' && args) {
    const method = String(args.method || 'GET').toUpperCase();
    const path = typeof args.path === 'string' ? args.path : '';
    if (method !== 'GET') {
      const match = /^\/api\/(maps|mods|skins|backgrounds|playlists|games)(\/|$)/.exec(path);
      if (match) return { installed: false, kinds: [match[1] as Kind] };
      if (path.startsWith('/api/me/')) return { installed: false, kinds: [...KINDS] }; // an upload or removal from your account
    }
  }
  return none;
}

onCallSettled((command, args) => {
  const effect = invalidatesFor(command, args);
  if (effect.installed) invalidateInstalled();
  if (effect.kinds.length) invalidateKinds(effect.kinds);
});

/** Subscribe to background refreshes that changed a list or the installed scan. Returns the unsubscribe function. */
export function onHubChange(listener: (change: HubChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(change: HubChange): void {
  for (const listener of [...listeners]) {
    try { listener(change); } catch (error) { console.error('hub listener failed: ' + describeError(error)); }
  }
}

function dedupe<T>(key: string, make: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = make().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function fetchKindNow(kind: Kind): Promise<Item[]> {
  return dedupe('kind:' + kind, async () => {
    const reply = await call<{ status: number; body: string }>('hub.get', { path: '/api/' + kind });
    if (reply.status !== 200) throw new Error('the hub answered ' + reply.status);
    const previous = lists.get(kind);
    if (previous && previous.raw === reply.body) {
      previous.at = Date.now(); // nothing changed: keep the parsed items (and the pages' references to them)
      return previous.value;
    }
    let json: unknown;
    try {
      json = JSON.parse(reply.body);
    } catch {
      throw new Error('the hub sent something unreadable');
    }
    const items = rowsToItems(kind, json);
    lists.set(kind, { at: Date.now(), value: items, raw: reply.body });
    persist(kind, reply.body);
    if (previous) notify({ kind });
    return items;
  });
}

export function loadKind(kind: Kind, force = false): Promise<Item[]> {
  hydrate();
  if (!force) {
    const cached = lists.get(kind);
    if (cached) {
      if (!isFresh(cached)) fetchKindNow(kind).catch((error) => console.error('hub list ' + kind + ' refresh failed: ' + describeError(error)));
      return Promise.resolve(cached.value);
    }
  }
  return fetchKindNow(kind);
}

function fetchInstalledNow(): Promise<InstalledData> {
  return dedupe('installed', async () => {
    const raw = await call<Record<string, unknown>>('library.installed', {});
    const text = JSON.stringify(raw);
    const previous = installedEntry;
    if (previous && previous.raw === text) {
      previous.at = Date.now();
      return previous.value;
    }
    const value = normalizeInstalled(raw);
    installedEntry = { at: Date.now(), value, raw: text };
    persist('installed', text);
    if (previous) notify({ installed: true });
    return value;
  });
}

export function loadInstalled(force = false): Promise<InstalledData> {
  hydrate();
  if (!force && installedEntry) {
    if (!isFresh(installedEntry)) fetchInstalledNow().catch((error) => console.error('installed refresh failed: ' + describeError(error)));
    return Promise.resolve(installedEntry.value);
  }
  return fetchInstalledNow();
}

export function normalizeInstalled(raw: unknown): InstalledData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
  const content = (s: Record<string, unknown>) => ({
    folder: str(s.folder), name: str(s.name),
    hubId: typeof s.hubId === 'string' ? s.hubId : null,
    revision: typeof s.revision === 'number' ? s.revision : null,
  });
  return {
    game: typeof r.game === 'string' ? r.game : null,
    mods: arr(r.mods).map((m) => ({
      id: str(m.id), displayName: str(m.displayName), version: str(m.version), enabled: m.enabled !== false, folder: str(m.folder),
      hubId: typeof m.hubId === 'string' ? m.hubId : null,
      revision: typeof m.revision === 'number' ? m.revision : null,
    })),
    maps: arr(r.maps).map((m) => ({
      folder: str(m.folder), name: str(m.name),
      hubId: typeof m.hubId === 'string' ? m.hubId : null,
      revision: typeof m.revision === 'number' ? m.revision : null,
    })),
    skins: arr(r.skins).map(content),
    backgrounds: arr(r.backgrounds).map(content),
    playlists: arr(r.playlists).map(content),
  };
}

export function peekLists(): Lists {
  const out = {} as Lists;
  for (const kind of KINDS) out[kind] = peekKind(kind);
  return out;
}

export interface Comment { id: number; author: string; authorColor: string | null; text: string; time: string; replyTo: number | null }

/** Read comments, tolerating several response shapes. Throws when the shape is unexpected. */
export async function loadComments(kind: Kind, id: string): Promise<Comment[]> {
  const reply = await call<{ status: number; body: string }>('hub.get', { path: '/api/' + kind + '/' + encodeURIComponent(id) + '/comments' });
  if (reply.status !== 200) throw new Error('the hub answered ' + reply.status);
  return parseComments(JSON.parse(reply.body));
}

/**
 * Posts a comment, or a reply when parentId is given. The hub takes { body, parent_id } and only allows replies to top-level
 * comments, so a reply to a reply goes to its thread's top comment. Answers the stored comment.
 */
export async function postComment(kind: Kind, id: string, text: string, parentId: number | null = null): Promise<Comment> {
  const body: Record<string, unknown> = { body: text };
  if (parentId !== null) body.parent_id = parentId;
  const reply = await call<{ status: number; body: string }>('hub.request', {
    method: 'POST',
    path: '/api/' + kind + '/' + encodeURIComponent(id) + '/comments',
    body,
  });
  if (reply.status === 401) throw new Error('Log in to comment.');
  if (reply.status !== 200 && reply.status !== 201) throw new Error(hubErrorText(reply.body) || 'the hub answered ' + reply.status);
  const json = JSON.parse(reply.body) as Record<string, unknown>;
  const stored = parseComment(json && typeof json === 'object' && 'comment' in json ? json.comment : json);
  if (!stored) throw new Error('The hub sent an unreadable comment.');
  return stored;
}

/** The hub's { error } message, when it sent one. */
function hubErrorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return typeof j.error === 'string' ? j.error : '';
  } catch {
    return '';
  }
}

/** One comment from the hub ({ id, parent_id, body, created_at, author: { username, name_color } }), tolerating older shapes. Null without text. */
export function parseComment(json: unknown): Comment | null {
  if (!json || typeof json !== 'object') return null;
  const c = json as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = c[key];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  const text = pick('body', 'text', 'content', 'message', 'comment');
  if (!text) return null;
  const who = c.author && typeof c.author === 'object' ? c.author as Record<string, unknown> : null;
  const whoName = who && typeof who.username === 'string' ? who.username : '';
  const whoColor = who && typeof who.name_color === 'string' ? who.name_color : null;
  const id = typeof c.id === 'number' ? c.id : typeof c.id === 'string' && /^\d+$/.test(c.id) ? parseInt(c.id, 10) : 0;
  return {
    id,
    author: whoName || pick('author', 'username', 'user', 'name', 'uploader') || 'Someone',
    authorColor: whoColor,
    text,
    time: pick('created_at', 'createdAt', 'time', 'date', 'updatedAt'),
    replyTo: typeof c.parent_id === 'number' ? c.parent_id : null,
  };
}

/** A comments page, flattened: each top-level comment followed by its replies (the hub nests them under "replies"). */
export function parseComments(json: unknown): Comment[] {
  let rows: unknown = json;
  if (json && typeof json === 'object' && !Array.isArray(json)) rows = (json as Record<string, unknown>).comments;
  if (!Array.isArray(rows)) throw new Error('unexpected comments shape');
  const out: Comment[] = [];
  for (const row of rows) {
    const top = parseComment(row);
    if (!top) continue;
    out.push(top);
    const replies = (row as Record<string, unknown>).replies;
    if (!Array.isArray(replies)) continue;
    for (const raw of replies) {
      const r = parseComment(raw);
      if (r) out.push({ ...r, replyTo: r.replyTo ?? top.id });
    }
  }
  return out;
}

export { describeError };

// Images whose pixels the page reads (skin sheets) come through the bridge as bytes, so they are same-origin blobs: the hub's
// redirect to its CDN carries no CORS header, and a cross-origin canvas read would be refused. One blob URL per image, kept.
const blobs = new Map<string, Promise<string>>();

export function galleryPath(kind: Kind, id: string, file: string): string {
  return '/api/' + kind + '/' + encodeURIComponent(id) + '/gallery/' + encodeURIComponent(file);
}

export function imageBlobUrl(kind: Kind, id: string, file: string): Promise<string> {
  const path = galleryPath(kind, id, file);
  let pending = blobs.get(path);
  if (!pending) {
    pending = call<{ status: number; mime: string; data: string }>('hub.image', { path }).then(async (reply) => {
      if (reply.status !== 200 || !reply.data) throw new Error('the hub answered ' + reply.status);
      // the engine decodes the base64 natively and off the main thread's byte loop
      const blob = await (await fetch('data:' + reply.mime + ';base64,' + reply.data)).blob();
      return URL.createObjectURL(blob);
    });
    pending.catch(() => blobs.delete(path)); // a failure can be retried later
    blobs.set(path, pending);
  }
  return pending;
}
