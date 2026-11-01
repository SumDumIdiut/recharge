/**
 * The extended profile: its shape, the whitelists every value must come from, and a sanitiser. DOM-free.
 * Mirrors Recharge.Server/ProfileSchema.cs: the server refuses what does not fit, and the UI drops it (falls back to the
 * default), so only enum members, #rrggbb colours, bounded numbers and bounded text can ever reach a renderer.
 */
import { FRAME_PICKER, ringFor } from '../community/format.js';

export interface Choice { value: string; label: string }

function c(...pairs: Array<[string, string]>): Choice[] { return pairs.map(([value, label]) => ({ value, label })); }

export const NAME_MODES = c(['default', 'Default'], ['solid', 'One colour'], ['gradient', 'Gradient']);
export const EFFECTS = c(['shimmer', 'Shimmer'], ['glow', 'Glow'], ['outline', 'Outline'], ['pixel', 'Pixel shadow'], ['rainbow', 'Rainbow cycle'], ['pulse', 'Pulse']);
export const FONTS = c(['vt323', 'VT323 (pixel)'], ['mono', 'Monospace'], ['sans', 'Clean sans'], ['serif', 'Serif'], ['rounded', 'Rounded'], ['typewriter', 'Typewriter']);
export const WEIGHTS = c(['normal', 'Normal'], ['bold', 'Bold'], ['heavy', 'Heavy']);
export const SPACINGS = c(['tight', 'Tight'], ['normal', 'Normal'], ['wide', 'Wide'], ['wider', 'Extra wide']);
export const SHAPES = c(['circle', 'Circle'], ['squircle', 'Rounded square'], ['hex', 'Hexagon'], ['diamond', 'Pixel diamond']);
export const ORNAMENTS = c(['none', 'None'], ['crown', 'Crown'], ['halo', 'Halo'], ['ears', 'Cat ears'], ['horns', 'Horns'], ['sparkles', 'Sparkles'], ['antenna', 'Antennae'], ['wreath', 'Wreath'], ['flame', 'Flames'], ['star', 'Star']);
export const GLOWS = c(['none', 'None'], ['soft', 'Soft glow'], ['neon', 'Neon']);
export const STATUS_STYLES = c(['dot', 'Dot'], ['ring', 'Ring'], ['pixel', 'Pixel square'], ['pulse', 'Pulsing dot'], ['bar', 'Bar'], ['none', 'Hidden']);
export const BANNER_MODES = c(['color', 'Solid colour'], ['gradient', 'Gradient'], ['image', 'Picture']);
export const PATTERNS = c(['none', 'None'], ['grid', 'Grid'], ['dots', 'Dots'], ['scanlines', 'Scanlines'], ['stars', 'Stars'], ['hex', 'Hexagons']);
export const ANIMS = c(['none', 'None'], ['stars', 'Drifting stars'], ['aurora', 'Aurora'], ['sweep', 'Scanline sweep'], ['signature', 'Signature circuit'], ['frostfall', 'Frostfall']);
export const HEIGHTS = c(['slim', 'Slim'], ['normal', 'Normal'], ['tall', 'Tall'], ['hero', 'Hero']);
export const CARDS = c(['glass', 'Glass'], ['solid', 'Solid'], ['gradient', 'Gradient'], ['pattern', 'Pattern']);
export const BGS = c(['none', 'None'], ['color', 'Solid colour'], ['gradient', 'Gradient'], ['grid', 'Grid'], ['dots', 'Dots'], ['stars', 'Stars'], ['aurora', 'Aurora']);
export const CORNERS = c(['sharp', 'Sharp'], ['soft', 'Soft'], ['round', 'Round'], ['pixel', 'Pixel']);
export const SECTION_IDS = c(['about', 'About'], ['showcase', 'Showcase'], ['uploads', 'Uploads'], ['stats', 'Stats'], ['links', 'Links'], ['friends', 'Friends'], ['activity', 'Activity']);
export const STAT_IDS = c(['uploads', 'Uploads'], ['threads', 'Threads'], ['replies', 'Replies'], ['comments', 'Comments'], ['friends', 'Friends'], ['played', 'Maps played']);
export const STAT_STYLES = c(['chips', 'Chips'], ['big', 'Big numbers'], ['minimal', 'Minimal']);
export const PROFILE_VIS = c(['everyone', 'Everyone'], ['friends', 'Friends only']);
export const FRIENDS_VIS = c(['everyone', 'Everyone'], ['friends', 'Friends only'], ['nobody', 'Only me']);
export const PRESENCE_VIS = c(['friends', 'My friends'], ['nobody', 'Nobody (appear offline)']);
export const KINDS = c(['map', 'Map'], ['mod', 'Mod'], ['skin', 'Skin'], ['background', 'Background'], ['playlist', 'Playlist'], ['game', 'Game']);

export const LIMITS = {
  bio: 600, pronouns: 20, statusText: 60, emoji: 16, linkLabel: 30, itemName: 60, note: 120,
  links: 8, showcase: 6, nameStops: 4, bannerStops: 3, bytes: 16 * 1024,
} as const;

const values = (list: Choice[]): string[] => list.map((entry) => entry.value);

export interface NameStyle {
  mode: string; colors: string[]; angle: number; effects: string[]; effectColor: string | null; font: string; weight: string; spacing: string;
}
export interface AvatarStyle {
  shape: string; frame: string; frameColors: string[]; ornament: string; ornamentColor: string | null; glow: string;
  zoom: number; x: number; y: number; status: string;
}
export interface BannerStyle {
  mode: string; colors: string[]; angle: number; imgX: number; imgY: number; imgZoom: number; pattern: string; anim: string;
  dim: number; tint: string | null; height: string;
}
export interface ThemeStyle { accent: string | null; card: string; bg: string; bgColors: string[]; corner: string; preset: string | null }
export interface LinkItem { url: string; label: string }
export interface ShowcaseItem { kind: string; id: string; name: string }
export interface Featured extends ShowcaseItem { note: string }
export interface ContentData {
  status: { emoji: string; text: string; expires: number };
  bio: string; pronouns: string; links: LinkItem[]; showcase: ShowcaseItem[]; featured: Featured | null;
}
export interface SectionState { id: string; on: boolean }
export interface Ext {
  v: 1;
  name: NameStyle;
  avatar: AvatarStyle;
  banner: BannerStyle;
  theme: ThemeStyle;
  content: ContentData;
  sections: SectionState[];
  stats: { show: string[]; style: string };
  privacy: { profile: string; friends: string; presence: string };
}

export function defaultSections(): SectionState[] {
  return values(SECTION_IDS).map((id) => ({ id, on: id !== 'friends' && id !== 'activity' }));
}

export function defaultExt(): Ext {
  return {
    v: 1,
    name: { mode: 'default', colors: ['#41f88d', '#c63ed8'], angle: 90, effects: [], effectColor: null, font: 'vt323', weight: 'normal', spacing: 'normal' },
    avatar: { shape: 'circle', frame: 'none', frameColors: [], ornament: 'none', ornamentColor: null, glow: 'none', zoom: 100, x: 50, y: 50, status: 'dot' },
    banner: { mode: 'color', colors: ['#1f3a2a', '#c63ed8'], angle: 135, imgX: 50, imgY: 50, imgZoom: 100, pattern: 'none', anim: 'none', dim: 0, tint: null, height: 'normal' },
    theme: { accent: null, card: 'glass', bg: 'none', bgColors: ['#101a14', '#1f3a2a'], corner: 'soft', preset: null },
    content: { status: { emoji: '', text: '', expires: 0 }, bio: '', pronouns: '', links: [], showcase: [], featured: null },
    sections: defaultSections(),
    stats: { show: ['uploads', 'threads', 'replies', 'comments'], style: 'chips' },
    privacy: { profile: 'everyone', friends: 'everyone', presence: 'friends' },
  };
}

/* ---------------- primitive checks ---------------- */

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const PRESET = /^[a-z0-9-]{1,32}$/;
// Controls, line/paragraph separators, direction overrides and the byte-order mark.
const BAD_CHAR = new RegExp('[' + ['\\u0000-\\u0009', '\\u000b-\\u001f', '\\u007f-\\u009f', '\\u2028', '\\u2029', '\\u202a-\\u202e', '\\u2066-\\u2069', '\\u200e', '\\u200f', '\\ufeff'].join('') + ']');

export function hex(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;
}

function hexOr(value: unknown, fallback: string): string { return hex(value) ?? fallback; }
function hexOrNull(value: unknown): string | null { return hex(value); }

function pick(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function hexList(value: unknown, min: number, max: number, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback.slice();
  const colors = value.map(hex);
  if (colors.some((color) => !color) || colors.length < min || colors.length > max) return fallback.slice();
  return colors as string[];
}

export function textLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** Text as the server stores it: LF line ends, no control or direction characters (a bad character voids the value), trimmed, bounded. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (!multiline && text.includes('\n')) return '';
  if (BAD_CHAR.test(text)) return '';
  text = text.trim();
  return textLength(text) > max ? [...text].slice(0, max).join('') : text;
}

/** The server's link rule: https only, no credentials, no markup or quote characters, at most 200 characters. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/[^\s<>"'`\\{}|^]{1,192}$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) return null;
  } catch {
    return null;
  }
  return value;
}

export function knownFrame(frame: unknown): string {
  if (typeof frame !== 'string' || !/^[a-z0-9-]{1,32}$/.test(frame)) return 'none';
  return frame === 'none' || ringFor(frame, []) ? frame : 'none';
}

export function frameColorCount(frame: string): number {
  return FRAME_PICKER.find((entry) => entry.id === frame)?.colors ?? 0;
}

/* ---------------- sanitising ---------------- */

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function item(value: unknown): ShowcaseItem | null {
  const r = obj(value);
  if (typeof r.id !== 'string' || !ID.test(r.id)) return null;
  const kind = pick(r.kind, values(KINDS), '');
  if (!kind) return null;
  return { kind, id: r.id, name: cleanText(r.name, LIMITS.itemName) };
}

/** Any input to a complete, valid profile: whatever does not fit falls back to its default. Never throws. */
export function sanitize(raw: unknown, now: number = Math.floor(Date.now() / 1000)): Ext {
  const d = defaultExt();
  const r = obj(raw);
  const n = obj(r.name), a = obj(r.avatar), b = obj(r.banner), t = obj(r.theme), ct = obj(r.content), st = obj(r.stats), pv = obj(r.privacy);
  const effects: string[] = [];
  for (const e of list(n.effects)) if (typeof e === 'string' && values(EFFECTS).includes(e) && !effects.includes(e)) effects.push(e);
  const name: NameStyle = {
    mode: pick(n.mode, values(NAME_MODES), d.name.mode),
    colors: hexList(n.colors, 1, LIMITS.nameStops, d.name.colors),
    angle: whole(n.angle, 0, 360, d.name.angle),
    effects,
    effectColor: hexOrNull(n.effectColor),
    font: pick(n.font, values(FONTS), d.name.font),
    weight: pick(n.weight, values(WEIGHTS), d.name.weight),
    spacing: pick(n.spacing, values(SPACINGS), d.name.spacing),
  };
  if (name.mode === 'gradient' && name.colors.length < 2) name.mode = 'solid';
  const frame = knownFrame(a.frame);
  const avatar: AvatarStyle = {
    shape: pick(a.shape, values(SHAPES), d.avatar.shape),
    frame,
    frameColors: hexList(a.frameColors, 0, 2, []),
    ornament: pick(a.ornament, values(ORNAMENTS), d.avatar.ornament),
    ornamentColor: hexOrNull(a.ornamentColor),
    glow: pick(a.glow, values(GLOWS), d.avatar.glow),
    zoom: whole(a.zoom, 100, 300, d.avatar.zoom),
    x: whole(a.x, 0, 100, d.avatar.x),
    y: whole(a.y, 0, 100, d.avatar.y),
    status: pick(a.status, values(STATUS_STYLES), d.avatar.status),
  };
  const banner: BannerStyle = {
    mode: pick(b.mode, values(BANNER_MODES), d.banner.mode),
    colors: hexList(b.colors, 1, LIMITS.bannerStops, d.banner.colors),
    angle: whole(b.angle, 0, 360, d.banner.angle),
    imgX: whole(b.imgX, 0, 100, 50), imgY: whole(b.imgY, 0, 100, 50), imgZoom: whole(b.imgZoom, 100, 300, 100),
    pattern: pick(b.pattern, values(PATTERNS), d.banner.pattern),
    anim: pick(b.anim, values(ANIMS), d.banner.anim),
    dim: whole(b.dim, 0, 80, 0),
    tint: hexOrNull(b.tint),
    height: pick(b.height, values(HEIGHTS), d.banner.height),
  };
  if (banner.mode === 'gradient' && banner.colors.length < 2) banner.mode = 'color';
  const theme: ThemeStyle = {
    accent: hexOrNull(t.accent),
    card: pick(t.card, values(CARDS), d.theme.card),
    bg: pick(t.bg, values(BGS), d.theme.bg),
    bgColors: hexList(t.bgColors, 1, 2, d.theme.bgColors),
    corner: pick(t.corner, values(CORNERS), d.theme.corner),
    preset: typeof t.preset === 'string' && PRESET.test(t.preset) ? t.preset : null,
  };
  const s = obj(ct.status);
  let expires = whole(s.expires, 0, 2147483647, 0);
  let status = { emoji: cleanText(s.emoji, LIMITS.emoji), text: cleanText(s.text, LIMITS.statusText), expires };
  if (expires > 0 && expires <= now) status = { emoji: '', text: '', expires: 0 };
  expires = status.expires;
  const links: LinkItem[] = [];
  for (const l of list(ct.links)) {
    const url = httpsUrl(obj(l).url);
    if (url && links.length < LIMITS.links) links.push({ url, label: cleanText(obj(l).label, LIMITS.linkLabel) });
  }
  const showcase: ShowcaseItem[] = [];
  for (const entry of list(ct.showcase)) {
    const one = item(entry);
    if (one && showcase.length < LIMITS.showcase) showcase.push(one);
  }
  const f = item(ct.featured);
  const content: ContentData = {
    status, bio: cleanText(ct.bio, LIMITS.bio, true), pronouns: cleanText(ct.pronouns, LIMITS.pronouns), links, showcase,
    featured: f ? { ...f, note: cleanText(obj(ct.featured).note, LIMITS.note) } : null,
  };
  const sections: SectionState[] = [];
  for (const entry of list(r.sections)) {
    const id = pick(obj(entry).id, values(SECTION_IDS), '');
    if (id && !sections.some((x) => x.id === id)) sections.push({ id, on: obj(entry).on !== false });
  }
  for (const entry of defaultSections()) if (!sections.some((x) => x.id === entry.id)) sections.push(entry);
  const show: string[] = [];
  for (const e of list(st.show)) if (typeof e === 'string' && values(STAT_IDS).includes(e) && !show.includes(e)) show.push(e);
  return {
    v: 1, name, avatar, banner, theme, content, sections,
    stats: { show: Array.isArray(st.show) ? show : d.stats.show, style: pick(st.style, values(STAT_STYLES), d.stats.style) },
    privacy: {
      profile: pick(pv.profile, values(PROFILE_VIS), 'everyone'),
      friends: pick(pv.friends, values(FRIENDS_VIS), 'everyone'),
      presence: pick(pv.presence, values(PRESENCE_VIS), 'friends'),
    },
  };
}

/** The sections in the owner's order, with the hidden ones marked. */
export function orderedSections(ext: Ext): SectionState[] {
  return sanitize(ext).sections;
}

export function sameProfile(a: Ext, b: Ext): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function wireSize(ext: Ext): number {
  return new TextEncoder().encode(JSON.stringify(ext)).length;
}

/** Moves one entry of a list to another place (reordering sections, links and showcase items). Returns a new list. */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [one] = out.splice(from, 1);
  out.splice(target, 0, one);
  return out;
}

export function isExpired(status: { expires: number }, now: number = Math.floor(Date.now() / 1000)): boolean {
  return status.expires > 0 && status.expires <= now;
}
