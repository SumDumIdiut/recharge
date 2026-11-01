/** Escape text for use in an HTML string. Prefer textContent; this is the fallback. */
export function esc(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trim a string to a single line of readable text. */
export function oneLine(value: unknown): string {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

/** A stable, readable id from arbitrary text. */
export function slug(value: unknown): string {
  return oneLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

/** Human count, e.g. 1 map / 2 maps. */
export function count(n: number, singular: string, plural?: string): string {
  return n + ' ' + (n === 1 ? singular : plural || singular + 's');
}
