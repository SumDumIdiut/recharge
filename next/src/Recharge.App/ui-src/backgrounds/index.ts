import { listBackgrounds, videoBaseUrl, type BackgroundList } from './api.js';
import { BackgroundLayer, type LayerItem } from './layer.js';
import { configFromSettings, mediaUrl, videoUrl, type BgConfig } from './model.js';

let layer: BackgroundLayer | null = null;
let current: BgConfig | null = null;
let generation = 0;

export function currentConfig(): BgConfig | null {
  return current;
}

/** The layer items for a config, from the installed list; a note when the chosen thing is missing. */
export function resolveItems(config: BgConfig, list: BackgroundList): { items: LayerItem[]; note: string | null } {
  if (config.source === 'background' && config.background) {
    const row = list.backgrounds.find((b) => b.folder === config.background);
    if (!row || !row.media) return { items: [], note: "That background isn't installed any more." };
    return { items: [toItem('backgrounds', row.folder, row.media)], note: null };
  }
  if (config.source === 'playlist' && config.playlist) {
    const row = list.playlists.find((p) => p.folder === config.playlist);
    if (!row) return { items: [], note: "That playlist isn't installed any more." };
    if (row.items.length === 0) return { items: [], note: 'That playlist has nothing in it yet.' };
    return { items: row.items.map((m) => toItem('playlists', row.folder, m)), note: null };
  }
  return { items: [], note: null };
}

function toItem(kind: 'backgrounds' | 'playlists', folder: string, m: { file: string; kind: 'image' | 'video'; poster?: string | null }): LayerItem {
  const base = videoBaseUrl();
  const url = m.kind === 'video' && base ? videoUrl(base, kind, folder, m.file) : mediaUrl(kind, folder, m.file);
  return { url, kind: m.kind, poster: m.poster ? mediaUrl(kind, folder, m.poster) : null };
}

/** Applies the saved settings to the app's one background layer. Returns a short note when something chosen is missing. */
export async function applyBackgroundSettings(raw: unknown, preloaded?: BackgroundList): Promise<string | null> {
  return applyConfig(configFromSettings(raw), preloaded);
}

/** Applies an already-validated config (the settings page does this on every change, before saving). */
export async function applyConfig(config: BgConfig, preloaded?: BackgroundList): Promise<string | null> {
  current = config;
  const mine = ++generation;
  if (!layer && typeof document !== 'undefined' && document.body) layer = new BackgroundLayer();
  if (!layer) return null;
  if (config.source === 'none') {
    layer.apply(config, []);
    return null;
  }
  const list = preloaded || (await listBackgrounds());
  if (mine !== generation) return null;
  const { items, note } = resolveItems(config, list);
  layer.apply(config, items);
  return note;
}

export function backgroundLayer(): BackgroundLayer | null {
  return layer;
}
