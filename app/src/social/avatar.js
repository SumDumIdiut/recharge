// The avatar component: a picture (or the first letter of the name when there is none) inside a CSS-drawn frame.
import { escapeHtml } from '../ui.js';
import { HUB_BASE } from '../hub.js';

// Frame ids (no names are shown; the picker is a grid of the frames themselves). Must match the hub's list.
export const FRAMES = [
  'none', 'green', 'gold', 'pixel', 'neon', 'double', 'ring-red', 'ring-orange',
  'ring-yellow', 'ring-cyan', 'ring-blue', 'ring-violet', 'ring-magenta', 'ring-pink', 'ring-white', 'ring-silver',
  'ring-ink', 'ring-lime', 'duo-mint-sky', 'duo-ember', 'duo-berry', 'duo-frost', 'duo-dusk', 'duo-royal',
  'g-rainbow', 'g-aurora', 'g-sunset', 'g-fire', 'g-ice', 'g-gilded', 'g-holo', 'g-toxic',
  'g-ocean', 'g-candy', 'g-bee', 'g-zebra', 'g-dashed', 'g-dotted', 'g-segments', 'g-half',
  'g-quarters', 'spin-rainbow-spin', 'spin-aurora-spin', 'spin-dashed-spin', 'spin-arc-spin', 'spin-comet-spin', 'spin-segments-spin', 'pixel-gold',
  'pixel-blue', 'pixel-pink', 'pixel-white', 'square-green', 'square-violet', 'square-red', 'pixel-rainbow',
  // Shapes that take one or two colours of the user's choosing (frame_colors).
  's-ring', 's-thick', 's-double', 's-inner', 's-gradient', 's-half', 's-stripes', 's-dashed', 's-dotted', 's-segments', 's-square', 's-pixel', 's-pixel-duo', 's-spin-arc', 's-spin-comet', 's-spin-dashed', 's-spin-segments', 's-spin-gradient',
].map((id) => ({ id }));
export const FRAME_IDS = FRAMES.map((f) => f.id);

// What the picker offers: shapes (with how many colours each takes, and the colours it starts with) plus a few fixed designs.
// The older one-colour variants (ring-red, duo-ember ...) still draw for whoever chose them, but aren't offered any more.
export const FRAME_PICKER = [
  ['none', 0], ['s-ring', 1], ['s-thick', 1], ['s-double', 2], ['s-inner', 2], ['s-gradient', 2], ['s-half', 2], ['s-stripes', 2],
  ['s-dashed', 1], ['s-dotted', 1], ['s-segments', 1], ['s-square', 1], ['s-pixel', 1], ['s-pixel-duo', 2],
  ['s-spin-arc', 1], ['s-spin-comet', 1], ['s-spin-dashed', 1], ['s-spin-segments', 1], ['s-spin-gradient', 2],
  ['g-rainbow', 0], ['g-holo', 0], ['g-gilded', 0], ['g-quarters', 0], ['g-fire', 0], ['spin-rainbow-spin', 0], ['pixel-rainbow', 0],
].map(([id, colors]) => ({ id, colors, def: ['#41f88d', '#c63ed8'].slice(0, colors) }));
export const frameColorCount = (id) => FRAME_PICKER.find((f) => f.id === id)?.colors || 0;
// A frame's colours as CSS variables (only #rrggbb gets through).
export function frameVars(colors) {
  const l = (Array.isArray(colors) ? colors : []).filter((c) => /^#[0-9a-f]{6}$/i.test(String(c))).slice(0, 2);
  return l.map((c, i) => `;--fc${i + 1}:${c}`).join('');
}

export const frameOf = (f) => (FRAME_IDS.includes(f) ? f : 'none');

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const safeColor = (c, fallback = '') => (COLOR_RE.test(String(c || '')) ? String(c) : fallback);

// A name colour can also be a gradient, in the hub's strict, normalised form only (nothing else reaches the CSS):
//   linear-gradient(<0-360>deg, #hex [<0-100>%], ... 2-6 stops)
const GRADIENT_RE = /^linear-gradient\((\d{1,3})deg((?:, #[0-9a-f]{6}(?: \d{1,3}%)?){2,6})\)$/;
// What someone typed (any case / spacing, #rgb or #rrggbb) -> that strict form, or '' when it isn't a valid gradient.
export function normalizeGradient(v) {
  const m = /^linear-gradient\(\s*(\d{1,3})deg\s*((?:,\s*#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:\s+\d{1,3}%)?\s*){2,6})\)$/.exec(String(v || '').trim().toLowerCase());
  if (!m || Number(m[1]) > 360) return '';
  const stops = m[2].split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    let [hex, pct] = x.split(/\s+/);
    if (hex.length === 4) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('');
    return pct && Number(pct.slice(0, -1)) > 100 ? null : hex + (pct ? ' ' + pct : '');
  });
  return stops.includes(null) ? '' : `linear-gradient(${Number(m[1])}deg, ${stops.join(', ')})`;
}
// The inline style for a name colour (plain #hex or a gradient drawn through the letters), or '' when it's neither.
export function nameStyle(c) {
  const v = String(c || '');
  if (COLOR_RE.test(v)) return `color:${v}`;
  const m = v.length <= 200 && GRADIENT_RE.exec(v);
  if (m && Number(m[1]) <= 360) return `background-image:${v};-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent`;
  return '';
}

export const initialOf = (name) => {
  const ch = [...String(name || '').trim()][0];
  return ch ? ch.toUpperCase() : '?';
};

// A hub-relative path (/api/...) or full URL -> full URL. Only http(s) survives.
export function hubUrl(u, base = HUB_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('/')) {
    try { return new URL(base).origin + s; } catch { return ''; }
  }
  return /^https?:\/\//i.test(s) ? s : '';
}

// Reads the author fields a hub item carries (flat or nested) into one shape.
export function userOf(item) {
  const a = item && typeof item.author === 'object' && item.author ? item.author : item || {};
  const name = (typeof item?.author === 'string' ? item.author : null) ?? a.username ?? item?.username ?? a.name ?? '';
  return {
    username: String(name || ''),
    avatar: a.avatar_url ?? '',
    frame: a.frame ?? 'none',
    frameColors: Array.isArray(a.frame_colors) ? a.frame_colors : [],
    nameColor: a.name_color ?? '',
    accent: a.accent_color ?? '',
    title: a.title ?? '',
    titles: Array.isArray(a.titles) ? a.titles : a.title ? [a.title] : [],
  };
}

// Someone's titles as small badges (a profile, or a user from userOf()).
export function titlesHtml(u, cls = 'cm-title') {
  const list = Array.isArray(u?.titles) ? u.titles : u?.title ? [u.title] : [];
  return list.map((t) => `<span class="${cls}">${escapeHtml(t)}</span>`).join('');
}

// size in px. The box is fixed-size, so lists never jump while pictures load. data-user makes it open the profile card.
export function avatarHtml(user, size = 36, { clickable = true } = {}) {
  const u = user || {};
  const name = u.username || '';
  const src = hubUrl(u.avatar);
  const frame = frameOf(u.frame);
  const accent = safeColor(u.accent);
  const img = src ? `<img class="avatar-img" src="${escapeHtml(src)}" alt="" decoding="async" onerror="this.remove()" />` : '';
  const attrs = clickable && name ? ` data-user="${escapeHtml(name)}" role="button" tabindex="0" title="${escapeHtml(name)}"` : '';
  const px = Math.max(16, Math.min(160, Math.round(size)));
  return `<span class="avatar frame-${frame}" style="--av:${px}px${accent ? `;--av-accent:${accent}` : ''}${frameVars(u.frameColors ?? u.frame_colors)}"${attrs}><span class="avatar-initial" aria-hidden="true">${escapeHtml(initialOf(name))}</span>${img}</span>`;
}

// Clickable name in the user's chosen colour.
export function nameHtml(user, extra = '') {
  const u = user || {};
  const st = nameStyle(u.nameColor);
  const name = u.username || 'unknown';
  return `<a class="user-name ${escapeHtml(extra)}" data-user="${escapeHtml(name)}" role="button" tabindex="0"${st ? ` style="${st}"` : ''}>${escapeHtml(u.label ?? name)}</a>`;
}

// The author of a hub submission: a clickable name when the hub knows the uploader's account (`uploader`), else the plain `author` text (uploads made without an account).
export function uploaderHtml(item, extra = '') {
  const author = String(item?.author ?? '');
  const account = String(item?.uploader ?? '');
  return account ? nameHtml({ username: account, label: author || account, nameColor: item?.uploader_name_color || '' }, extra) : escapeHtml(author);
}
