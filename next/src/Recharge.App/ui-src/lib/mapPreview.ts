/** Shows a rendered map picture where a map has no uploaded one. An uploaded gallery image always wins; this only fills the gap. */
import { call } from '../bridge.js';
import { h } from '../dom.js';
import { hasPreview, mapPreviewUrl } from '../amp/preview.js';
import type { Json } from '../amp/core/types.js';
import type { Item } from './library.js';

interface PreviewReply { map: string | null; rev: string; same?: boolean }

/** The revision each folder's picture was last made from, so an unchanged map is not read again. */
const known = new Map<string, string>();

/** Whether a map could have a rendered picture: no uploaded image, and a folder on this machine to read the data from. */
export function wantsRenderedPreview(item: Item): boolean {
  return item.kind === 'maps' && item.gallery.length === 0 && !!item.installed?.folder;
}

async function fetchPreview(folder: string): Promise<{ rev: string; json: Json | null }> {
  let since = known.get(folder);
  if (since && !hasPreview(folder, since)) since = undefined;
  const r = await call<PreviewReply>('amp.preview', { id: folder, ...(since ? { since } : {}) });
  known.set(folder, r.rev);
  return { rev: r.rev, json: r.map ? (JSON.parse(r.map) as Json) : null };
}

/**
 * Fill `box` with the map's rendered picture (an <img>) when it has one; calls `onShown` when it appears. The data is
 * read lazily - only when `box` scrolls near the view - and cached by folder and revision.
 */
export function attachRenderedPreview(item: Item, box: HTMLElement, onShown?: (img: HTMLImageElement) => void): void {
  if (!wantsRenderedPreview(item)) return;
  const folder = item.installed!.folder as string;
  const start = (): void => {
    // the revision comes with the data, so the cache is keyed after the first read of this folder's current file
    void fetchPreview(folder).then(async ({ rev, json }) => {
      const url = await mapPreviewUrl(folder, rev, async () => json);
      if (!url) return;
      const img = h('img', { className: 'pixel map-render', attrs: { alt: '', decoding: 'async', src: url } });
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;image-rendering:pixelated;';
      box.appendChild(img);
      onShown?.(img);
    }, () => { /* the placeholder stays */ });
  };
  if (typeof IntersectionObserver === 'undefined') { start(); return; }
  const seen = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { seen.disconnect(); start(); }
  }, { rootMargin: '240px 0px' });
  seen.observe(box);
}
