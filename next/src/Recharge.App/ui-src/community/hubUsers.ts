/** Players' hub records (picture, frame, name colour) by name, fetched once per name for lists that only know names. */
import { hubJson } from './api.js';
import { normalizeProfile, type Author } from './format.js';

const cache = new Map<string, Promise<Author | null>>();

/** The hub's author record for a username, or null when there is none (or the hub can't be reached; retried on the next page). */
export function hubAuthor(username: string): Promise<Author | null> {
  const key = username.trim().toLowerCase();
  let pending = cache.get(key);
  if (!pending) {
    pending = hubJson('GET', '/api/users/' + encodeURIComponent(username)).then(
      (reply) => normalizeProfile(reply)?.author ?? null,
      () => { cache.delete(key); return null; });
    cache.set(key, pending);
  }
  return pending;
}
