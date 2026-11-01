/** A cache of other people's name and avatar looks, fetched in batches. DOM-free; the fetcher is injected. */
import { sanitize, type AvatarStyle, type NameStyle } from './schema.js';

export interface ChipStyle { name: NameStyle; avatar: AvatarStyle; accent: string | null }

export type Fetcher = (names: string[]) => Promise<unknown>;

export interface StyleCache {
  /** The cached look: a style, null (known to have none), or undefined (not known yet). */
  peek(name: string): ChipStyle | null | undefined;
  /** Calls back with the look as soon as it is known (at once when cached), fetching it in the next batch otherwise. */
  watch(name: string, cb: (style: ChipStyle | null) => void): void;
  prefetch(names: string[]): void;
  /** Puts a look in the cache directly (after you save your own profile). */
  prime(name: string, style: ChipStyle | null): void;
  forget(name: string): void;
  clear(): void;
}

export const BATCH = 40;
export const TTL_MS = 5 * 60 * 1000;
export const FAIL_MS = 20 * 1000;

const key = (name: string): string => name.trim().toLowerCase();

/** A server answer ({ profiles: [{ username, name, avatar, theme }] }) as looks by lower-case name. Junk is ignored. */
export function readStyles(json: unknown): Map<string, ChipStyle> {
  const out = new Map<string, ChipStyle>();
  const list = json && typeof json === 'object' ? (json as { profiles?: unknown }).profiles : null;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.username !== 'string' || !r.username) continue;
    const theme = r.theme && typeof r.theme === 'object' ? (r.theme as Record<string, unknown>) : {};
    const ext = sanitize({ name: r.name, avatar: r.avatar, theme: { accent: theme.accent } });
    out.set(key(r.username), { name: ext.name, avatar: ext.avatar, accent: ext.theme.accent });
  }
  return out;
}

export function createStyleCache(fetcher: Fetcher, now: () => number = () => Date.now(), schedule: (run: () => void) => void = (run) => { setTimeout(run, 25); }): StyleCache {
  const entries = new Map<string, { style: ChipStyle | null; until: number }>();
  const waiting = new Map<string, Array<(style: ChipStyle | null) => void>>();
  const queued = new Set<string>();
  let flushing = false;
  let failedUntil = 0;

  function settle(name: string, style: ChipStyle | null, ttl: number): void {
    entries.set(name, { style, until: now() + ttl });
    const callbacks = waiting.get(name);
    waiting.delete(name);
    if (callbacks) for (const cb of callbacks) { try { cb(style); } catch { /* one bad listener must not stop the rest */ } }
  }

  async function flush(): Promise<void> {
    flushing = false;
    const names = [...queued];
    queued.clear();
    for (let i = 0; i < names.length; i += BATCH) {
      const chunk = names.slice(i, i + BATCH);
      if (now() < failedUntil) { for (const n of chunk) settle(n, null, FAIL_MS); continue; }
      try {
        const found = readStyles(await fetcher(chunk));
        for (const n of chunk) settle(n, found.get(n) ?? null, TTL_MS);
      } catch {
        failedUntil = now() + FAIL_MS;
        for (const n of chunk) settle(n, null, FAIL_MS);
      }
    }
  }

  function request(name: string): void {
    if (queued.has(name)) return;
    queued.add(name);
    if (!flushing) { flushing = true; schedule(() => { void flush(); }); }
  }

  function fresh(name: string): { style: ChipStyle | null } | null {
    const hit = entries.get(name);
    return hit && hit.until > now() ? hit : null;
  }

  return {
    peek(name): ChipStyle | null | undefined {
      const hit = fresh(key(name));
      return hit ? hit.style : undefined;
    },
    watch(name, cb): void {
      const k = key(name);
      const hit = fresh(k);
      if (hit) { cb(hit.style); return; }
      const list = waiting.get(k) ?? [];
      list.push(cb);
      waiting.set(k, list);
      request(k);
    },
    prefetch(names): void {
      for (const n of names) { const k = key(n); if (k && !fresh(k) && !waiting.has(k)) request(k); }
    },
    prime(name, style): void { settle(key(name), style, TTL_MS); },
    forget(name): void { entries.delete(key(name)); },
    clear(): void { entries.clear(); },
  };
}
