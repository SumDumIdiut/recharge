/** Talking to the hub for the community pages. Every request goes through the app, which adds the session token. */
import { call } from '../bridge.js';
import { currentUser, refreshSession } from '../account/session.js';

export class HubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Reply { status: number; body: string }

function messageOf(status: number, body: string): string {
  try {
    const json = JSON.parse(body) as { error?: unknown; retry_after?: unknown };
    if (typeof json.error === 'string' && json.error) {
      if (status === 429 && typeof json.retry_after === 'number') return json.error + ' (try again in ' + json.retry_after + ' s)';
      return json.error;
    }
  } catch {
    /* not JSON */
  }
  if (status === 401) return 'You are not logged in.';
  if (status === 404) return 'That was not found.';
  return 'The hub answered ' + status + '.';
}

/** A JSON request. Throws HubError with the hub's own message for any non-2xx answer. */
export async function hubJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const reply = await call<Reply>('hub.request', body === undefined ? { method, path } : { method, path, body });
  if (reply.status === 401 && currentUser()) void refreshSession();
  if (reply.status < 200 || reply.status >= 300) throw new HubError(reply.status, messageOf(reply.status, reply.body));
  if (!reply.body) return {} as T;
  try {
    return JSON.parse(reply.body) as T;
  } catch {
    throw new HubError(reply.status, 'The hub sent something unreadable.');
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A multipart request: text fields plus picked image files. */
export async function hubForm<T = unknown>(
  method: string,
  path: string,
  fields: Record<string, string | number | boolean | string[] | null>,
  files: Array<{ field: string; file: File }> = []
): Promise<T> {
  const parts = [];
  for (const { field, file } of files) {
    parts.push({ field, name: safeName(file.name), mime: file.type, data: toBase64(await file.arrayBuffer()) });
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== null) clean[key] = value;
  return hubJson<T>(method, path, { __multipart: { fields: clean, files: parts } });
}

function safeName(name: string): string {
  const cleaned = String(name || 'image').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned || 'image';
}

const blobs = new Map<string, Promise<string | null>>();

/** A hub avatar, banner or forum picture as an object URL; null when it cannot be had. Cached per path. */
export function hubImage(path: string): Promise<string | null> {
  let pending = blobs.get(path);
  if (!pending) {
    pending = call<{ status: number; mime: string; data: string }>('account.image', { path }).then((reply) => {
      if (reply.status !== 200 || !reply.data) return null;
      const raw = atob(reply.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: reply.mime }));
    }).catch(() => null);
    blobs.set(path, pending);
  }
  return pending;
}

/** Forget cached pictures at a path (after replacing an avatar, for example). */
export function forgetImage(path: string | null | undefined): void {
  if (path) blobs.delete(path);
}
