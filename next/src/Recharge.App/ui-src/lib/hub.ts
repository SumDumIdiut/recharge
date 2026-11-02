/** Hub and installed-data loading with a 60 s in-memory cache. */
import { call, describeError } from '../bridge.js';
import { KINDS, rowsToItems, str, type InstalledData, type Item, type Kind, type Lists } from './library.js';

export const TTL_MS = 60_000;

interface Entry<T> { at: number; value: T }

const lists = new Map<Kind, Entry<Item[]>>();
const inflight = new Map<string, Promise<unknown>>();
let installedEntry: Entry<InstalledData> | null = null;

function fresh<T>(entry: Entry<T> | null | undefined): T | null {
  return entry && Date.now() - entry.at < TTL_MS ? entry.value : null;
}

/** Cached list, or null when it needs fetching. */
export function peekKind(kind: Kind): Item[] | null {
  return fresh(lists.get(kind));
}

export function peekInstalled(): InstalledData | null {
  return fresh(installedEntry);
}

export function clearCache(): void {
  lists.clear();
  installedEntry = null;
}

function dedupe<T>(key: string, make: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = make().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function loadKind(kind: Kind, force = false): Promise<Item[]> {
  if (!force) {
    const cached = peekKind(kind);
    if (cached) return Promise.resolve(cached);
  }
  return dedupe('kind:' + kind, async () => {
    const reply = await call<{ status: number; body: string }>('hub.get', { path: '/api/' + kind });
    if (reply.status !== 200) throw new Error('the hub answered ' + reply.status);
    let json: unknown;
    try {
      json = JSON.parse(reply.body);
    } catch {
      throw new Error('the hub sent something unreadable');
    }
    const items = rowsToItems(kind, json);
    lists.set(kind, { at: Date.now(), value: items });
    return items;
  });
}

export function loadInstalled(force = false): Promise<InstalledData> {
  if (!force) {
    const cached = peekInstalled();
    if (cached) return Promise.resolve(cached);
  }
  return dedupe('installed', async () => {
    const raw = await call<Record<string, unknown>>('library.installed', {});
    const value = normalizeInstalled(raw);
    installedEntry = { at: Date.now(), value };
    return value;
  });
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
  const reply = await call<{ status: number; body: string }>('hub.get', { path: '/api/' + kind + '/' + id + '/comments' });
  if (reply.status !== 200) throw new Error('the hub answered ' + reply.status);
  return parseComments(JSON.parse(reply.body));
}

/** Post a comment (or a reply when parentId is given). */
export async function postComment(kind: Kind, id: string, text: string, parentId: number | null = null): Promise<Comment> {
  const body: Record<string, unknown> = { text };
  if (parentId !== null) body.parent_id = parentId;
  const reply = await call<{ status: number; body: string }>('hub.request', {
    method: 'POST',
    path: '/api/' + kind + '/' + id + '/comments',
    body,
  });
  if (reply.status !== 200 && reply.status !== 201) throw new Error('the hub answered ' + reply.status);
  return parseComment(JSON.parse(reply.body));
}

function parseComment(json: unknown): Comment {
  const c = json as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = c[key];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  const text = pick('text', 'body', 'content', 'message', 'comment');
  if (!text) throw new Error('comment has no text');
  const who = c.author && typeof c.author === 'object' ? c.author as Record<string, unknown> : null;
  const whoName = who && typeof who.username === 'string' ? who.username : '';
  const whoColor = who && typeof who.name_color === 'string' ? who.name_color : null;
  const id = typeof c.id === 'number' ? c.id : typeof c.id === 'string' ? parseInt(c.id, 10) : 0;
  return {
    id,
    author: whoName || pick('author', 'username', 'user', 'name', 'uploader') || 'Someone',
    authorColor: whoColor,
    text,
    time: pick('createdAt', 'created_at', 'time', 'date', 'updatedAt'),
    replyTo: typeof c.parent_id === 'number' ? c.parent_id : null,
  };
}

export function parseComments(json: unknown): Comment[] {
  let rows: unknown = json;
  if (json && typeof json === 'object' && !Array.isArray(json)) rows = (json as Record<string, unknown>).comments;
  if (!Array.isArray(rows)) throw new Error('unexpected comments shape');
  const out: Comment[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const c = row as Record<string, unknown>;
    const pick = (...keys: string[]): string => {
      for (const key of keys) {
        const value = c[key];
        if (typeof value === 'string' && value) return value;
      }
      return '';
    };
    const text = pick('text', 'body', 'content', 'message', 'comment');
    if (!text) continue;
    // The hub sends author as an object: { username, avatar_url, frame, frame_colors, name_color }.
    const who = c.author && typeof c.author === 'object' ? c.author as Record<string, unknown> : null;
    const whoName = who && typeof who.username === 'string' ? who.username : '';
    const whoColor = who && typeof who.name_color === 'string' ? who.name_color : null;
    out.push({
      author: whoName || pick('author', 'username', 'user', 'name', 'uploader') || 'Someone',
      authorColor: whoColor,
      text,
      time: pick('createdAt', 'created_at', 'time', 'date', 'updatedAt'),
      replyTo: typeof c.parent_id === 'number' ? c.parent_id : null,
    });
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
    pending = call<{ status: number; mime: string; data: string }>('hub.image', { path }).then((reply) => {
      if (reply.status !== 200 || !reply.data) throw new Error('the hub answered ' + reply.status);
      const raw = atob(reply.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: reply.mime }));
    });
    pending.catch(() => blobs.delete(path)); // a failure can be retried later
    blobs.set(path, pending);
  }
  return pending;
}
