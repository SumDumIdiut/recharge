/** Pure helpers for the what's-new popup (no DOM, so tools/ui-tests can run them). */

export const SEEN_VERSION_KEY = 'recharge:changelogSeenVersion';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The version the user last booted with, or null on a first run / blocked storage. */
export function readSeenVersion(store?: StorageLike | null): string | null {
  try {
    const target = store === undefined ? browserStorage() : store;
    const value = target && target.getItem(SEEN_VERSION_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Remembers the current version; storage failures are harmless (private mode, embedded browser). */
export function writeSeenVersion(version: string, store?: StorageLike | null): void {
  if (!version) return;
  try {
    const target = store === undefined ? browserStorage() : store;
    if (target) target.setItem(SEEN_VERSION_KEY, version);
  } catch {
    /* Nothing to do: the popup is best effort. */
  }
}

/** Only a previous, different version means this boot followed an update. */
export function shouldShowChangelog(lastSeen: string | null, version: string): boolean {
  return !!lastSeen && !!version && lastSeen !== version;
}

/** Split notes into lines, keeping indentation and flattening CRLF/CR to LF. */
export function noteLines(notes: string): string[] {
  return notes.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
}

export function isBulletLine(line: string): boolean {
  return /^\s*[-*•]\s+/.test(line);
}

export function bulletText(line: string): string {
  return line.replace(/^\s*[-*•]\s+/, '').trim();
}
