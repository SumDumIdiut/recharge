// A map's view picture: the whole map zoomed out as Amplifier shows it (drawn by the editor's own renderer, see mapview.js), kept on disk under the map's id + last-updated stamp so it is drawn once and again only when the map changes.
import { renderMapView } from './mapview.js';

const inflight = new Map();
// One at a time: the draw shares one worker, and a Browse page of maps shouldn't start a dozen at once.
let last = Promise.resolve(null);
// Maps that failed to draw this session: not retried until the app restarts.
const failed = new Set();

// The stamp a Hub map's picture is kept under (its upload time), so installed and not-yet-installed copies share one file.
export const hubStamp = (createdAt) => 'h' + (createdAt || '0');
// What to show on a card: a picture the author uploaded wins, else the drawn view.
export const cardImage = (uploaded, drawn) => uploaded || drawn || null;
// Whether a map still needs its drawn view fetched (it has no uploaded picture and none drawn yet).
export const needsView = (uploaded, drawn) => !uploaded && !drawn;
export const viewKey = (id, stamp) => id + '@' + stamp;

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function work(id, stamp) {
  const { invoke } = window.__TAURI__.core;
  stamp = stamp || (await invoke('map_view_stamp', { id }).catch(() => null)) || 'x';
  const kept = await invoke('read_map_view', { id, stamp }).catch(() => null);
  if (kept) return 'data:image/png;base64,' + kept;
  if (failed.has(viewKey(id, stamp))) return null;
  let text = null;
  try { text = await invoke('read_map', { id }); } catch {
    try { text = await invoke('fetch_hub_map_json', { id }); } catch { text = null; }
  }
  if (!text) return null;
  try {
    const blob = await renderMapView(typeof text === 'string' ? JSON.parse(text) : text);
    if (!blob) { failed.add(viewKey(id, stamp)); return null; }
    const data = await blobToBase64(blob);
    await invoke('write_map_view', { id, stamp, data }).catch(() => {});
    return 'data:image/png;base64,' + data;
  } catch (e) {
    failed.add(viewKey(id, stamp));
    console.warn('map view', id, e);
    return null;
  }
}

// opts.stamp: the map's last-updated stamp (hubStamp(row.createdAt) for a Hub map); left out, an installed map's file time is used.
export function mapThumbFor(id, opts = {}) {
  const key = viewKey(id, opts.stamp || '');
  if (inflight.has(key)) return inflight.get(key);
  const p = last.then(() => work(id, opts.stamp)).catch(() => null);
  last = p;
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

// The kept picture's file path (for an upload), drawing it first if needed; null when it can't be had.
export async function mapViewFile(id, opts = {}) {
  const { invoke } = window.__TAURI__.core;
  if (!(await mapThumbFor(id, opts))) return null;
  const stamp = opts.stamp || (await invoke('map_view_stamp', { id }).catch(() => null)) || 'x';
  return invoke('map_view_path', { id, stamp }).catch(() => null);
}
