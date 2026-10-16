// User text: always escaped. The only markup produced is <a> for http(s) links; line breaks come from CSS (white-space: pre-wrap).
import { escapeHtml } from '../ui.js';

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAIL_RE = /[.,;:!?)\]}]+$/;

// Returns the normalised URL when it is a plain http/https link, else ''. (No javascript:, data:, file: ...; no credentials.)
export function safeUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function linkHtml(href, label) {
  const safe = safeUrl(href);
  if (!safe) return escapeHtml(label ?? href);
  return `<a class="ext-link" href="${escapeHtml(safe)}" data-ext-url="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label ?? safe)}</a>`;
}

export function richText(text) {
  const s = String(text ?? '');
  let out = '', last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    let url = m[0];
    const trail = url.match(TRAIL_RE)?.[0] || '';
    if (trail) url = url.slice(0, -trail.length);
    out += escapeHtml(s.slice(last, m.index));
    out += safeUrl(url) ? linkHtml(url, url) : escapeHtml(url);
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  return out + escapeHtml(s.slice(last));
}

// Opens http(s) links through the Tauri opener; used by the delegated click handler.
export async function openExternal(url, tauri = globalThis.window?.__TAURI__) {
  const safe = safeUrl(url);
  if (!safe) return false;
  try {
    if (tauri?.opener?.openUrl) await tauri.opener.openUrl(safe);
    else await tauri.core.invoke('plugin:opener|open_url', { url: safe });
    return true;
  } catch {
    return false;
  }
}

export function timeAgo(t, now = Date.now()) {
  let ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t || '').includes('T') || /\d{4}-\d\d-\d\d/.test(t) ? (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z') : t);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
