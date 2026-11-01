/**
 * The pure part of backgrounds: settings model, the whitelisted style builder, playlist rotation and the playback rule.
 * No DOM in here, so node can test it.
 */

export const FITS = ['cover', 'contain', 'center'] as const;
export const POSITIONS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export const PAGES = ['home', 'lobbies', 'library', 'amplifier', 'community', 'notebook', 'create', 'settings'] as const;
export const SOURCES = ['none', 'background', 'playlist'] as const;

export type Fit = (typeof FITS)[number];
export type Position = (typeof POSITIONS)[number];
export type Source = (typeof SOURCES)[number];
export type PageId = (typeof PAGES)[number];

export const LIMITS = { dim: [0, 90], blur: [0, 24], interval: [5, 86400], fadeMs: [0, 5000] } as const;

export interface BgConfig {
  source: Source;
  background: string | null;
  playlist: string | null;
  fit: Fit;
  position: Position;
  dim: number;
  tint: string | null;
  blur: number;
  interval: number;
  shuffle: boolean;
  fadeMs: number;
  pauseUnfocused: boolean;
  stillOnly: boolean;
  pageDim: Partial<Record<PageId, number>>;
}

export const DEFAULTS: BgConfig = {
  source: 'none', background: null, playlist: null, fit: 'cover', position: 'center', dim: 35, tint: null, blur: 0,
  interval: 300, shuffle: false, fadeMs: 1000, pauseUnfocused: true, stillOnly: false, pageDim: {},
};

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function validHex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function name(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\\/\0:]/.test(value) && value !== '.' && value !== '..' ? value : null;
}

/** Turns whatever settings.get returned into a safe config: unknown or out-of-range values fall back to the defaults. */
export function configFromSettings(raw: unknown): BgConfig {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const background = name(s.background);
  const playlist = name(s.backgroundPlaylist);
  let source = oneOf(s.backgroundSource, SOURCES, background ? 'background' : 'none');
  if (source === 'background' && !background) source = 'none';
  if (source === 'playlist' && !playlist) source = 'none';
  const pageDim: Partial<Record<PageId, number>> = {};
  if (s.bgPageDim && typeof s.bgPageDim === 'object') {
    for (const page of PAGES) {
      const v = (s.bgPageDim as Record<string, unknown>)[page];
      if (typeof v === 'number') pageDim[page] = clampInt(v, 0, 90, 0);
    }
  }
  return {
    source, background, playlist,
    fit: oneOf(s.bgFit, FITS, DEFAULTS.fit),
    position: oneOf(s.bgPosition, POSITIONS, DEFAULTS.position),
    dim: clampInt(s.bgDim, 0, 90, DEFAULTS.dim),
    tint: validHex(s.bgTint),
    blur: clampInt(s.bgBlur, 0, 24, 0),
    interval: clampInt(s.bgInterval, 5, 86400, DEFAULTS.interval),
    shuffle: s.bgShuffle === true,
    fadeMs: clampInt(s.bgFadeMs, 0, 5000, DEFAULTS.fadeMs),
    pauseUnfocused: s.bgPauseUnfocused !== false,
    stillOnly: s.bgStillOnly === true,
    pageDim,
  };
}

/** The settings.set patch for a config (the keys the app saves). */
export function configToPatch(c: BgConfig): Record<string, unknown> {
  return {
    backgroundSource: c.source, background: c.background, backgroundPlaylist: c.playlist, bgFit: c.fit, bgPosition: c.position,
    bgDim: c.dim, bgTint: c.tint, bgBlur: c.blur, bgInterval: c.interval, bgShuffle: c.shuffle, bgFadeMs: c.fadeMs,
    bgPauseUnfocused: c.pauseUnfocused, bgStillOnly: c.stillOnly, bgPageDim: c.pageDim,
  };
}

export interface MediaStyle {
  objectFit: string;
  objectPosition: string;
}

/** object-fit and object-position of a picture or video. Only whitelisted words ever reach the style. */
export function fitStyle(c: Pick<BgConfig, 'fit' | 'position'>): MediaStyle {
  const fit = oneOf(c.fit, FITS, 'cover');
  const position = oneOf(c.position, POSITIONS, 'center');
  return { objectFit: fit === 'center' ? 'none' : fit, objectPosition: position };
}

/** The pageId of a hash route like "#/library/item/maps/x". Unknown pages give null. */
export function pageOf(hash: string): PageId | null {
  const first = (hash || '').replace(/^#\/?/, '').split(/[/?#]/)[0];
  return (PAGES as readonly string[]).includes(first) ? (first as PageId) : null;
}

/** The dimming layer: colour and opacity (0 to 0.95). The page's extra dimming adds to the base, capped at 90 percent. */
export function dimStyle(c: Pick<BgConfig, 'dim' | 'tint' | 'pageDim'>, page: PageId | null): { background: string; opacity: string } {
  const extra = page ? c.pageDim[page] || 0 : 0;
  const total = Math.min(90, clampInt(c.dim, 0, 90, 0) + clampInt(extra, 0, 90, 0));
  return { background: validHex(c.tint) || '#000000', opacity: String(total / 100) };
}

/** The CSS filter and the scale that hides the soft edge. A blur of 0 uses neither. */
export function blurStyle(c: Pick<BgConfig, 'blur'>): { filter: string; transform: string } {
  const px = clampInt(c.blur, 0, 24, 0);
  if (px === 0) return { filter: 'none', transform: 'none' };
  return { filter: 'blur(' + px + 'px)', transform: 'scale(1.06)' };
}

export interface PlaylistItem {
  file: string;
  kind: 'image' | 'video';
  poster?: string | null;
}

/** Items in a stable order that never repeats an index inside one pass; with shuffle each pass is a new permutation. */
export class Rotation {
  private order: number[] = [];
  private pos = -1;
  private last = -1;

  private readonly size: number;
  private readonly shuffle: boolean;
  private readonly rng: () => number;

  constructor(size: number, shuffle: boolean, rng: () => number = Math.random) {
    this.size = size;
    this.shuffle = shuffle;
    this.rng = rng;
  }

  /** The next index, or -1 when the list is empty. */
  next(): number {
    if (this.size <= 0) return -1;
    if (this.pos < 0 || this.pos >= this.order.length) this.refill();
    const index = this.order[this.pos];
    this.pos += 1;
    this.last = index;
    return index;
  }

  private refill(): void {
    this.order = shuffledOrder(this.size, this.shuffle ? this.rng : null, this.size > 1 ? this.last : -1);
    this.pos = 0;
  }
}

/** 0..n-1 in order, or (with an rng) a Fisher-Yates permutation whose first entry is not `avoidFirst`. */
export function shuffledOrder(n: number, rng: (() => number) | null, avoidFirst = -1): number[] {
  const a = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  if (!rng) return a;
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (a.length > 1 && a[0] === avoidFirst) [a[0], a[a.length - 1]] = [a[a.length - 1], a[0]];
  return a;
}

export interface PlaybackInput {
  documentHidden: boolean;
  windowFocused: boolean;
  pauseUnfocused: boolean;
  stillOnly: boolean;
  reducedMotion: boolean;
}

/** Whether a video may decode right now, and why not. Rotation follows the same rule (it only moves while playing). */
export function playbackPlan(i: PlaybackInput): { play: boolean; reason: 'hidden' | 'unfocused' | 'still' | null } {
  if (i.documentHidden) return { play: false, reason: 'hidden' };
  if (i.stillOnly || i.reducedMotion) return { play: false, reason: 'still' };
  if (i.pauseUnfocused && !i.windowFocused) return { play: false, reason: 'unfocused' };
  return { play: true, reason: null };
}

export function mediaUrl(kind: 'backgrounds' | 'playlists', folder: string, file: string): string {
  return 'recharge://bg/' + kind + '/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file);
}

/**
 * Where a video is played from. WebKitGTK plays video through GStreamer, which can't open recharge:// addresses, so videos come from
 * the app's own loopback server (the base address has a per-run token). Pictures and posters use the recharge://bg/ route.
 */
export function videoUrl(base: string, kind: 'backgrounds' | 'playlists', folder: string, file: string): string {
  return base.replace(/\/?$/, '/') + kind + '/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file);
}

/** Moves the item at `from` to `to` (a new array). Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const copy = list.slice();
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy;
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}
