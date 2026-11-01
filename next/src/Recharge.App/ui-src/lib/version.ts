/** RechargeVersion rules (ported from Recharge.Core.Models.RechargeVersion). */

export interface Version {
  parts: number[];
  pre: string | null;
  text: string;
}

export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let core = text;
  let pre: string | null = null;
  const dash = text.indexOf('-');
  if (dash >= 0) {
    core = text.slice(0, dash);
    pre = text.slice(dash + 1);
    if (core.length === 0 || pre.length === 0) return null;
    if (text.indexOf('-', dash + 1) >= 0) return null;
  }
  if (core.length === 0) return null;
  const pieces = core.split('.');
  if (pieces.length < 1 || pieces.length > 4) return null;
  const parts: number[] = [];
  for (const piece of pieces) {
    if (piece.length === 0 || !/^[0-9]+$/.test(piece)) return null;
    if (piece.length > 1 && piece[0] === '0') return null;
    const value = Number(piece);
    if (!Number.isSafeInteger(value) || value > 2147483647) return null;
    parts.push(value);
  }
  if (pre !== null && /[ \t]/.test(pre)) return null;
  return { parts, pre, text };
}

function splitTrailingNumber(value: string): [string, number | null] {
  const match = /^(.*?)([0-9]+)$/.exec(value);
  if (!match) return [value, null];
  return [match[1], Number(match[2])];
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  const [pa, na] = splitTrailingNumber(a);
  const [pb, nb] = splitTrailingNumber(b);
  if (pa === pb) {
    if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
    if (na !== null) return -1;
    if (nb !== null) return 1;
  }
  return ordinal(a, b);
}

/** Compare parsed versions: negative, 0 or positive. */
export function compareParsed(a: Version, b: Version): number {
  const max = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < max; i += 1) {
    const x = i < a.parts.length ? a.parts[i] : 0;
    const y = i < b.parts.length ? b.parts[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePre(a.pre, b.pre);
}

/**
 * Compare version strings. An unparsable version sorts below a parsable one;
 * two unparsable versions compare equal, so they never look like an update.
 */
export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) return compareParsed(pa, pb);
  if (pa) return 1;
  if (pb) return -1;
  return 0;
}

export function isNewer(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0;
}
