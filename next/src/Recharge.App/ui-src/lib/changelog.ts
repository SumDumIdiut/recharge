/** Pure helpers for the what's-new popup (no DOM, so tools/ui-tests can run them). */

export const SEEN_BUILD_KEY = 'recharge:changelogSeenBuild';

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

/** The installed build the user last booted with, or null on a first run / blocked storage / bad value. */
export function readSeenBuild(store?: StorageLike | null): number | null {
  try {
    const target = store === undefined ? browserStorage() : store;
    const value = target && target.getItem(SEEN_BUILD_KEY);
    const build = Number(value);
    return Number.isInteger(build) && build > 0 ? build : null;
  } catch {
    return null;
  }
}

/** Remembers the current build; storage failures are harmless (private mode, embedded browser). */
export function writeSeenBuild(build: number, store?: StorageLike | null): void {
  if (!Number.isInteger(build) || build <= 0) return;
  try {
    const target = store === undefined ? browserStorage() : store;
    if (target) target.setItem(SEEN_BUILD_KEY, String(build));
  } catch {
    /* Nothing to do: the popup is best effort. */
  }
}

/** Only a previous, different build means this boot followed an update (the version string can stay the same). */
export function shouldShowChangelog(lastSeen: number | null, build: number): boolean {
  return lastSeen !== null && Number.isInteger(build) && build > 0 && lastSeen !== build;
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
