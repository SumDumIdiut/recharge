/** Community: limits, validation and shaping of hub data. DOM-free, so it is unit-tested directly. */
import { validNameColor } from '../lib/library.js';

const MB = 1024 * 1024;

/** The hub's limits (forum.js LIM), checked here first so people get an answer before the upload. */
export const LIM = {
  title: 120, post: 5000, reply: 3000, bio: 300, pronouns: 20, link: 200, links: 3,
  postImages: 4, replyImages: 2, image: 5 * MB, avatar: 2 * MB, q: 100,
} as const;

export interface Choice { value: string; label: string }

export const CATEGORIES: Choice[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'issue', label: 'Issue' },
  { value: 'question', label: 'Question' },
  { value: 'suggestion', label: 'Suggestion' },
];
export const STATUSES: Choice[] = [
  { value: 'open', label: 'Open' },
  { value: 'solved', label: 'Solved' },
  { value: 'closed', label: 'Closed' },
];

export function labelOf(list: Choice[], value: string): string {
  const found = list.find((entry) => entry.value === value);
  return found ? found.label : value;
}

export function isCategory(value: unknown): boolean {
  return typeof value === 'string' && CATEGORIES.some((entry) => entry.value === value);
}

const CONTROL = new RegExp('[' + ['\\x00-\\x08','\\x0b','\\x0c','\\x0e-\\x1f','\\x7f','\\u2028','\\u2029','\\u202a-\\u202e','\\u2066-\\u2069'].join('') + ']', 'g');

/** Same clean-up the hub does before measuring: CRLF to LF, no control characters, trimmed. */
export function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .trim();
}

export function validateThread(input: { title: string; body: string; category: string }): string | null {
  const title = cleanText(input.title);
  const body = cleanText(input.body);
  if (!isCategory(input.category)) return 'Pick a category.';
  if (!title) return 'Give the thread a title.';
  if (title.length > LIM.title) return 'The title is too long (max ' + LIM.title + ' characters).';
  if (!body) return 'Write something in the thread.';
  if (body.length > LIM.post) return 'The post is too long (max ' + LIM.post + ' characters).';
  return null;
}

export function validateReply(body: string): string | null {
  const text = cleanText(body);
  if (!text) return 'Write a reply first.';
  if (text.length > LIM.reply) return 'The reply is too long (max ' + LIM.reply + ' characters).';
  return null;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Checks picked image files against a count and size limit. */
export function validateImages(files: Array<{ type: string; size: number; name?: string }>, max: number, maxBytes: number = LIM.image): string | null {
  if (files.length > max) return 'At most ' + max + ' image' + (max === 1 ? '' : 's') + ' allowed.';
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) return 'Images must be PNG, JPEG, GIF or WebP.';
    if (file.size <= 0) return 'An image is empty.';
    if (file.size > maxBytes) return 'An image is larger than ' + Math.round(maxBytes / MB) + ' MB.';
  }
  return null;
}

/** An http(s) link, as the hub accepts for profile links; anything else is null. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > LIM.link || /[\s\x00-\x1f]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

export interface ProfileInput { bio: string; pronouns: string; links: string[] }

export function validateProfile(input: ProfileInput): string | null {
  if (cleanText(input.bio).length > LIM.bio) return 'The bio is too long (max ' + LIM.bio + ' characters).';
  if (cleanText(input.pronouns).length > LIM.pronouns) return 'Pronouns are too long (max ' + LIM.pronouns + ' characters).';
  const links = input.links.map((link) => link.trim()).filter(Boolean);
  if (links.length > LIM.links) return 'At most ' + LIM.links + ' links allowed.';
  for (const link of links) {
    if (!safeHref(link)) return 'Each link must be an http or https address of at most ' + LIM.link + ' characters.';
  }
  return null;
}

export const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function validHex(value: unknown): string | null {
  return typeof value === 'string' && HEX6.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** The hub's strict gradient form for a name colour: 2 to 6 stops. */
export function buildGradient(angle: number, stops: string[]): string | null {
  const clean = stops.map((stop) => validHex(stop)).filter((stop): stop is string => !!stop);
  if (clean.length < 2 || clean.length > 6 || clean.length !== stops.length) return null;
  const degrees = Math.max(0, Math.min(360, Math.round(Number.isFinite(angle) ? angle : 90)));
  return 'linear-gradient(' + degrees + 'deg, ' + clean.join(', ') + ')';
}

/** Splits a stored name colour into the editor's pieces. */
export function parseNameColor(value: unknown): { mode: 'solid' | 'gradient'; colors: string[]; angle: number } {
  const valid = validNameColor(value);
  if (!valid) return { mode: 'solid', colors: ['#41f88d'], angle: 90 };
  if (valid.startsWith('#')) return { mode: 'solid', colors: [valid.toLowerCase()], angle: 90 };
  const angle = /(\d{1,3})deg/.exec(valid);
  const colors = (valid.match(/#[0-9a-fA-F]{6}/g) || []).map((color) => color.toLowerCase());
  return { mode: 'gradient', colors: colors.length >= 2 ? colors : ['#41f88d', '#c63ed8'], angle: angle ? Number(angle[1]) : 90 };
}

/* ---------------- shaping hub data ---------------- */

export interface Author {
  username: string;
  avatar_url: string | null;
  frame: string;
  frame_colors: string[];
  name_color: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeAuthor(value: unknown): Author {
  const a = obj(value);
  const colors = Array.isArray(a.frame_colors) ? a.frame_colors.map(validHex).filter((c): c is string => !!c).slice(0, 2) : [];
  return {
    username: str(a.username) || '[deleted]',
    avatar_url: hubImagePath(a.avatar_url),
    frame: str(a.frame) || 'none',
    frame_colors: colors,
    name_color: validNameColor(a.name_color),
  };
}

/** Only hub image paths (what account.image accepts) are kept; any other URL is dropped. */
export function hubImagePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let path = value.trim().split('?')[0];
  const api = path.indexOf('/api/');
  if (api > 0 && /^https?:\/\//i.test(path)) path = path.slice(api);
  return /^\/api\/(avatars|banners)\/[A-Za-z0-9._-]{1,160}$/.test(path) || /^\/api\/forum\/images\/[A-Za-z0-9._-]{1,160}$/.test(path)
    ? path
    : null;
}

export interface ThreadRow {
  id: number;
  title: string;
  category: string;
  status: string;
  pinned: boolean;
  excerpt: string;
  thumb: string | null;
  imageCount: number;
  replyCount: number;
  createdAt: string;
  lastActivity: string;
  author: Author;
}

export interface ThreadPage { threads: ThreadRow[]; page: number; pages: number; total: number }

export function normalizeThreadPage(json: unknown): ThreadPage {
  const root = obj(json);
  const rows = Array.isArray(root.posts) ? root.posts : [];
  const threads: ThreadRow[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    if (typeof r.id !== 'number') continue;
    threads.push({
      id: r.id,
      title: str(r.title),
      category: str(r.category),
      status: str(r.status) || 'open',
      pinned: r.pinned === true,
      excerpt: str(r.excerpt),
      thumb: hubImagePath(r.thumb),
      imageCount: typeof r.image_count === 'number' ? r.image_count : 0,
      replyCount: typeof r.reply_count === 'number' ? r.reply_count : 0,
      createdAt: str(r.created_at),
      lastActivity: str(r.last_activity_at) || str(r.created_at),
      author: normalizeAuthor(r.author),
    });
  }
  return {
    threads,
    page: typeof root.page === 'number' ? root.page : 1,
    pages: typeof root.pages === 'number' ? Math.max(1, root.pages) : 1,
    total: typeof root.total === 'number' ? root.total : threads.length,
  };
}

export interface Perms { edit: boolean; remove: boolean; status?: boolean; pin?: boolean }

export interface Post {
  id: number;
  title: string;
  body: string;
  category: string;
  status: string;
  pinned: boolean;
  images: string[];
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  author: Author;
  can: Perms;
}

export interface Reply {
  id: number;
  postId: number;
  body: string;
  images: string[];
  createdAt: string;
  editedAt: string | null;
  author: Author;
  can: Perms;
}

function images(value: unknown): string[] {
  return Array.isArray(value) ? value.map(hubImagePath).filter((p): p is string => !!p) : [];
}

export function normalizePost(value: unknown): Post | null {
  const r = obj(value);
  if (typeof r.id !== 'number') return null;
  return {
    id: r.id,
    title: str(r.title),
    body: str(r.body),
    category: str(r.category),
    status: str(r.status) || 'open',
    pinned: r.pinned === true,
    images: images(r.images),
    replyCount: typeof r.reply_count === 'number' ? r.reply_count : 0,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    author: normalizeAuthor(r.author),
    can: { edit: r.can_edit === true, remove: r.can_delete === true, status: r.can_status === true, pin: r.can_pin === true },
  };
}

export function normalizeReply(value: unknown): Reply | null {
  const r = obj(value);
  if (typeof r.id !== 'number') return null;
  return {
    id: r.id,
    postId: typeof r.post_id === 'number' ? r.post_id : 0,
    body: str(r.body),
    images: images(r.images),
    createdAt: str(r.created_at),
    editedAt: str(r.edited_at) || null,
    author: normalizeAuthor(r.author),
    can: { edit: r.can_edit === true, remove: r.can_delete === true },
  };
}

export interface Thread { post: Post; replies: Reply[] }

export function normalizeThread(json: unknown): Thread | null {
  const root = obj(json);
  const post = normalizePost(root.post);
  if (!post) return null;
  const replies = (Array.isArray(root.replies) ? root.replies : []).map(normalizeReply).filter((r): r is Reply => !!r);
  return { post, replies };
}

export interface Player {
  author: Author;
  uploads: Record<string, number>;
  createdAt: string;
}

export function normalizePlayers(json: unknown): { players: Player[]; total: number } {
  const root = obj(json);
  const rows = Array.isArray(root.users) ? root.users : [];
  const players: Player[] = [];
  for (const raw of rows) {
    const r = obj(raw);
    if (!str(r.username)) continue;
    const uploads: Record<string, number> = {};
    for (const [kind, n] of Object.entries(obj(r.uploads))) if (typeof n === 'number' && n > 0) uploads[kind] = n;
    players.push({ author: normalizeAuthor(r), uploads, createdAt: str(r.created_at) });
  }
  return { players, total: typeof root.total === 'number' ? root.total : players.length };
}

export interface Upload { id: string; kind: string; name: string; version: string; createdAt: string; gallery: string[] }

export interface Profile {
  author: Author;
  admin: boolean;
  bannerColor: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  bio: string;
  pronouns: string | null;
  links: string[];
  createdAt: string;
  posts: number;
  replies: number;
  comments: number;
  uploads: Upload[];
}

export function normalizeProfile(json: unknown): Profile | null {
  const r = obj(json);
  if (!str(r.username)) return null;
  const uploads: Upload[] = [];
  for (const raw of Array.isArray(r.uploads) ? r.uploads : []) {
    const u = obj(raw);
    if (!str(u.id) || !str(u.kind)) continue;
    uploads.push({
      id: str(u.id), kind: str(u.kind), name: str(u.name) || 'Untitled', version: str(u.version), createdAt: str(u.createdAt),
      gallery: Array.isArray(u.gallery) ? u.gallery.filter((g): g is string => typeof g === 'string') : [],
    });
  }
  return {
    author: normalizeAuthor(r),
    admin: r.admin === true,
    bannerColor: validHex(r.banner_color),
    bannerUrl: hubImagePath(r.banner_url),
    accentColor: validHex(r.accent_color),
    bio: str(r.bio),
    pronouns: str(r.pronouns) || null,
    links: (Array.isArray(r.links) ? r.links : []).map(safeHref).filter((l): l is string => !!l),
    createdAt: str(r.created_at),
    posts: typeof r.post_count === 'number' ? r.post_count : 0,
    replies: typeof r.reply_count === 'number' ? r.reply_count : 0,
    comments: typeof r.comment_count === 'number' ? r.comment_count : 0,
    uploads,
  };
}

const KIND_PLURAL: Record<string, string> = { mod: 'mods', map: 'maps', skin: 'skins', background: 'backgrounds', playlist: 'playlists', game: 'games' };

/** The Library kind (plural) for a hub submission kind such as "map"; null when unknown. */
export function libraryKind(kind: string): string | null {
  return KIND_PLURAL[kind] || (Object.values(KIND_PLURAL).includes(kind) ? kind : null);
}

export function libraryRoute(kind: string, id: string): string | null {
  const plural = libraryKind(kind);
  return plural && id ? '#/library/item/' + plural + '/' + encodeURIComponent(id) : null;
}

/** "3 maps · 1 skin" for an uploads count map. */
export function uploadsSummary(uploads: Record<string, number>): string {
  const parts: string[] = [];
  for (const [kind, n] of Object.entries(uploads)) {
    const plural = libraryKind(kind);
    if (!plural || n <= 0) continue;
    parts.push(n + ' ' + (n === 1 ? plural.replace(/s$/, '') : plural));
  }
  return parts.join(' · ');
}

export function profileRoute(username: string): string {
  return '#/community/players/' + encodeURIComponent(username);
}

export function threadRoute(id: number): string {
  return '#/community/forum/' + id;
}

/** "October 2026" from an ISO date; empty when it is not one. */
export function monthYear(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* ---------------- frames ---------------- */

export const FRAME_PICKER: Array<{ id: string; label: string; colors: number }> = [
  { id: 'none', label: 'None', colors: 0 },
  { id: 's-ring', label: 'Ring', colors: 1 }, { id: 's-thick', label: 'Thick ring', colors: 1 },
  { id: 's-double', label: 'Double ring', colors: 2 }, { id: 's-inner', label: 'Inner ring', colors: 2 },
  { id: 's-gradient', label: 'Gradient', colors: 2 }, { id: 's-half', label: 'Half and half', colors: 2 },
  { id: 's-stripes', label: 'Stripes', colors: 2 }, { id: 's-dashed', label: 'Dashed', colors: 1 },
  { id: 's-dotted', label: 'Dotted', colors: 1 }, { id: 's-segments', label: 'Segments', colors: 1 },
  { id: 's-square', label: 'Square', colors: 1 }, { id: 's-pixel', label: 'Pixel', colors: 1 },
  { id: 's-pixel-duo', label: 'Pixel duo', colors: 2 }, { id: 's-spin-arc', label: 'Spinning arc', colors: 1 },
  { id: 's-spin-comet', label: 'Comet', colors: 1 }, { id: 's-spin-dashed', label: 'Spinning dashes', colors: 1 },
  { id: 's-spin-segments', label: 'Spinning segments', colors: 1 }, { id: 's-spin-gradient', label: 'Spinning gradient', colors: 2 },
  { id: 'g-rainbow', label: 'Rainbow', colors: 0 }, { id: 'g-holo', label: 'Holo', colors: 0 },
  { id: 'g-gilded', label: 'Gilded', colors: 0 }, { id: 'g-quarters', label: 'Quarters', colors: 0 },
  { id: 'g-fire', label: 'Fire', colors: 0 }, { id: 'spin-rainbow-spin', label: 'Spinning rainbow', colors: 0 },
  { id: 'pixel-rainbow', label: 'Pixel rainbow', colors: 0 },
];

export interface Ring {
  /** A CSS background (gradient or colour) for the ring. */
  background: string;
  square: boolean;
  spin: boolean;
  /** Thickness as a fraction of the avatar size. */
  weight: number;
  /** A dark gap between the ring and the picture. */
  gap: boolean;
}

const SOLID: Record<string, string> = {
  green: '#41f88d', gold: '#e8c14b', neon: '#39ff14', pixel: '#41f88d',
  'ring-red': '#ff4d4d', 'ring-orange': '#ff9a3c', 'ring-yellow': '#ffe14d', 'ring-cyan': '#3ce6e6', 'ring-blue': '#4d8dff',
  'ring-violet': '#9a5cff', 'ring-magenta': '#c63ed8', 'ring-pink': '#ff7ac8', 'ring-white': '#f9ffe4', 'ring-silver': '#b8bcc4',
  'ring-ink': '#2a2a2a', 'ring-lime': '#b6ff3c', 'square-green': '#41f88d', 'square-violet': '#9a5cff', 'square-red': '#ff4d4d',
  'pixel-gold': '#e8c14b', 'pixel-blue': '#4d8dff', 'pixel-pink': '#ff7ac8', 'pixel-white': '#f9ffe4',
};
const DUO: Record<string, [string, string]> = {
  'duo-mint-sky': ['#7dffc4', '#5cc8ff'], 'duo-ember': ['#ff5d3c', '#ffc23c'], 'duo-berry': ['#d23ca8', '#6a3cd2'],
  'duo-frost': ['#e6f6ff', '#5cb4ff'], 'duo-dusk': ['#ff8a5c', '#5c4cff'], 'duo-royal': ['#4c5cff', '#e8c14b'],
};
const CONIC: Record<string, string> = {
  'g-rainbow': 'conic-gradient(#ff4d4d, #ffe14d, #41f88d, #3ce6e6, #4d8dff, #c63ed8, #ff4d4d)',
  'g-aurora': 'conic-gradient(#41f88d, #3ce6e6, #9a5cff, #41f88d)',
  'g-sunset': 'conic-gradient(#ff9a3c, #ff4d8d, #9a5cff, #ff9a3c)',
  'g-fire': 'conic-gradient(#ffe14d, #ff9a3c, #ff3c3c, #ff9a3c, #ffe14d)',
  'g-ice': 'conic-gradient(#e6f6ff, #5cb4ff, #4c5cff, #5cb4ff, #e6f6ff)',
  'g-gilded': 'conic-gradient(#fff3b0, #e8c14b, #9a7418, #e8c14b, #fff3b0)',
  'g-holo': 'conic-gradient(#ff9ad5, #9ad5ff, #9affc0, #fff39a, #ff9ad5)',
  'g-toxic': 'conic-gradient(#b6ff3c, #1f5c1f, #b6ff3c, #1f5c1f, #b6ff3c)',
  'g-ocean': 'conic-gradient(#3ce6e6, #1c4dd2, #3ce6e6)',
  'g-candy': 'conic-gradient(#ff7ac8, #ffffff, #ff7ac8, #ffffff, #ff7ac8)',
  'g-bee': 'repeating-conic-gradient(#ffe14d 0 20deg, #1c1c1c 20deg 40deg)',
  'g-zebra': 'repeating-conic-gradient(#f9ffe4 0 15deg, #1c1c1c 15deg 30deg)',
  'g-dashed': 'repeating-conic-gradient(#41f88d 0 18deg, transparent 18deg 30deg)',
  'g-dotted': 'repeating-conic-gradient(#41f88d 0 6deg, transparent 6deg 18deg)',
  'g-segments': 'repeating-conic-gradient(#41f88d 0 40deg, transparent 40deg 45deg)',
  'g-half': 'conic-gradient(#41f88d 0 180deg, #c63ed8 180deg 360deg)',
  'g-quarters': 'conic-gradient(#41f88d 0 90deg, #c63ed8 90deg 180deg, #3ce6e6 180deg 270deg, #ffe14d 270deg 360deg)',
  'pixel-rainbow': 'conic-gradient(#ff4d4d, #ffe14d, #41f88d, #3ce6e6, #4d8dff, #c63ed8, #ff4d4d)',
  'spin-rainbow-spin': 'conic-gradient(#ff4d4d, #ffe14d, #41f88d, #3ce6e6, #4d8dff, #c63ed8, #ff4d4d)',
  'spin-aurora-spin': 'conic-gradient(#41f88d, #3ce6e6, #9a5cff, #41f88d)',
  'spin-dashed-spin': 'repeating-conic-gradient(#41f88d 0 18deg, transparent 18deg 30deg)',
  'spin-arc-spin': 'conic-gradient(#41f88d 0 90deg, transparent 90deg 360deg)',
  'spin-comet-spin': 'conic-gradient(transparent, #41f88d)',
  'spin-segments-spin': 'repeating-conic-gradient(#41f88d 0 40deg, transparent 40deg 45deg)',
};

/** What to draw around an avatar for a frame id and its picked colours. Only validated hex colours reach CSS. */
export function ringFor(frame: string, colors: string[]): Ring | null {
  if (!frame || frame === 'none') return null;
  const c1 = validHex(colors[0]) || '#41f88d';
  const c2 = validHex(colors[1]) || '#c63ed8';
  const base = { square: false, spin: false, weight: 0.08, gap: false };
  if (SOLID[frame]) {
    const square = frame.startsWith('square') || frame.startsWith('pixel');
    return { ...base, background: SOLID[frame], square, weight: frame === 'gold' ? 0.1 : 0.08 };
  }
  if (frame === 'double') return { ...base, background: '#41f88d', gap: true, weight: 0.14 };
  if (DUO[frame]) return { ...base, background: 'conic-gradient(' + DUO[frame][0] + ' 0 180deg, ' + DUO[frame][1] + ' 180deg 360deg)' };
  if (CONIC[frame]) return { ...base, background: CONIC[frame], spin: frame.startsWith('spin-'), square: frame === 'pixel-rainbow' };
  switch (frame) {
    // Flipped's signature (see profile/exclusive.ts): the Recharge palette turning around the avatar.
    case 'x-flipped-signature': return { ...base, background: 'conic-gradient(#41f88d, #2fd6d0, #3a7bff, #c63ed8, #41f88d)', spin: true, weight: 0.11 };
    // Flipped's frost signature: turning ice, white through glacier blue to violet, with a bright glint running round it.
    case 'x-flipped-frost': return { ...base, background: 'conic-gradient(#ffffff 0deg, #bfe8ff 40deg, #5cb4ff 120deg, #7a6bff 190deg, #5cb4ff 250deg, #bfe8ff 320deg, #ffffff 344deg, #ffffff 352deg, #ffffff 360deg)', spin: true, weight: 0.12 };
    case 's-ring': return { ...base, background: c1 };
    case 's-thick': return { ...base, background: c1, weight: 0.14 };
    case 's-double': return { ...base, background: 'conic-gradient(' + c1 + ', ' + c2 + ', ' + c1 + ')', gap: true, weight: 0.15 };
    case 's-inner': return { ...base, background: c1, gap: true, weight: 0.12 };
    case 's-gradient': return { ...base, background: 'linear-gradient(135deg, ' + c1 + ', ' + c2 + ')' };
    case 's-half': return { ...base, background: 'conic-gradient(' + c1 + ' 0 180deg, ' + c2 + ' 180deg 360deg)' };
    case 's-stripes': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 15deg, ' + c2 + ' 15deg 30deg)' };
    case 's-dashed': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 18deg, transparent 18deg 30deg)' };
    case 's-dotted': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 6deg, transparent 6deg 18deg)' };
    case 's-segments': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 40deg, transparent 40deg 45deg)' };
    case 's-square': return { ...base, background: c1, square: true };
    case 's-pixel': return { ...base, background: c1, square: true, weight: 0.12 };
    case 's-pixel-duo': return { ...base, background: 'conic-gradient(' + c1 + ' 0 180deg, ' + c2 + ' 180deg 360deg)', square: true, weight: 0.12 };
    case 's-spin-arc': return { ...base, background: 'conic-gradient(' + c1 + ' 0 90deg, transparent 90deg 360deg)', spin: true };
    case 's-spin-comet': return { ...base, background: 'conic-gradient(transparent, ' + c1 + ')', spin: true };
    case 's-spin-dashed': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 18deg, transparent 18deg 30deg)', spin: true };
    case 's-spin-segments': return { ...base, background: 'repeating-conic-gradient(' + c1 + ' 0 40deg, transparent 40deg 45deg)', spin: true };
    case 's-spin-gradient': return { ...base, background: 'conic-gradient(' + c1 + ', ' + c2 + ', ' + c1 + ')', spin: true };
    default: return null;
  }
}
