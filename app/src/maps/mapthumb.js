// A map's view picture: the whole map zoomed out as Amplifier shows it (drawn by the editor's own renderer, see mapview.js), kept on disk under the map's id + last-updated stamp so it is drawn once and again only when the map changes.
import { renderMapView } from './mapview.js';

const inflight = new Map();
// One at a time: the draw shares one worker, and a Browse page of maps shouldn't start a dozen at once.
let last = Promise.resolve(null);
// Maps that couldn't be drawn this session: a broken one (its JSON doesn't parse) is latched, the rest
// (a busy worker, an offline Hub) is tried a few times, further apart each time, and then left alone.
const failed = new Map();
// How often a transient failure is tried again, and how long before the next try (doubled every time).
const TRIES = 3, BACKOFF = 2000;

// The stamp a Hub map's picture is kept under, so installed and not-yet-installed copies share
// one file. The caller passes something that changes when the map changes - its last update
// time and revision - because a stamp built from the upload time alone never changes, and the
// map's picture would then stay whatever the first version looked like.
export const hubStamp = (changed) => 'h' + (changed || '0');
// What to show on a card: a picture the author uploaded wins, else the drawn view.
export const cardImage = (uploaded, drawn) => uploaded || drawn || null;
// Whether a map still needs its drawn view fetched (it has no uploaded picture and none drawn yet).
export const needsView = (uploaded, drawn) => !uploaded && !drawn;
// Bumped whenever the drawing of a view changes (r2: the map's backdrop is drawn behind it), so
// pictures kept from an older renderer are drawn again once. It is appended to every stamp the
// picture is kept under, installed or Hub, and the old file is replaced by the new write.
export const VIEW_RENDERER = 'r2';
export const versioned = (stamp) => { const s = String(stamp); return s.endsWith('-' + VIEW_RENDERER) ? s : s + '-' + VIEW_RENDERER; };
export const viewKey = (id, stamp) => id + '@' + stamp;

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Whether the map may be drawn again: a broken map never is, a transient failure waits for its backoff.
function mayTry(key) {
  const f = failed.get(key);
  if (!f) return true;
  if (f.broken || f.tries >= TRIES) return false;
  return Date.now() >= f.at;
}
// The map could not be drawn: a broken one is latched, anything else gets a few tries with a backoff.
function failedTry(key, broken) {
  const f = failed.get(key);
  if (broken) { failed.set(key, { tries: TRIES, at: 0, broken: true }); return; }
  const tries = (f?.tries || 0) + 1;
  failed.set(key, { tries, at: Date.now() + BACKOFF * Math.pow(2, tries - 1), broken: false });
}

// The map's own background image as a Blob, when it has one and it can be found (the worker cannot read assets); null draws the level backdrop instead.
async function ownBackground(map, invoke) {
  const file = (map.editor?.background || map.background)?.image;
  if (typeof file !== 'string') return null;
  try {
    const bin = atob(await invoke('find_map_asset', { file }));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes]);
  } catch { return null; }
}

async function work(id, stamp) {
  const { invoke } = window.__TAURI__.core;
  stamp = versioned(stamp || (await invoke('map_view_stamp', { id }).catch(() => null)) || 'x');
  const kept = await invoke('read_map_view', { id, stamp }).catch(() => null);
  if (kept) return 'data:image/png;base64,' + kept;
  const key = viewKey(id, stamp);
  if (!mayTry(key)) return null;
  let text = null;
  try { text = await invoke('read_map', { id }); } catch {
    try { text = await invoke('fetch_hub_map_json', { id }); } catch { text = null; }
  }
  // No map to draw: the Hub may be offline, so the fetch waits for its backoff instead of happening on every render.
  if (!text) { failedTry(key, false); return null; }
  let map;
  try { map = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (e) { failedTry(key, true); console.warn('map view', id, e); return null; }
  try {
    const blob = await renderMapView(map, 960, 540, await ownBackground(map, invoke));
    // No editor data: nothing to draw, and nothing that a later try would change.
    if (!blob) { failedTry(key, true); return null; }
    const data = await blobToBase64(blob);
    await invoke('write_map_view', { id, stamp, data }).catch(() => {});
    failed.delete(key);
    return 'data:image/png;base64,' + data;
  } catch (e) {
    // The worker was busy, timed out or crashed: transient, so it is tried again.
    failedTry(key, false);
    console.warn('map view', id, e);
    return null;
  }
}

// opts.stamp: what the map changed at (hubStamp of its update time and revision for a Hub
// map); left out, an installed map's file time is used.
export function mapThumbFor(id, opts = {}) {
  const key = viewKey(id, opts.stamp || '');
  if (inflight.has(key)) return inflight.get(key);
  const p = last.then(() => work(id, opts.stamp)).catch(() => null);
  last = p;
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}

// The map list was refreshed: what failed was the session, not the map, so every map is tried again.
export function clearFailed() { failed.clear(); }

// Whether a map's view could not be drawn: the card says so instead of showing nothing.
export function viewFailed(id) {
  for (const k of failed.keys()) if (k.startsWith(id + '@')) return true;
  return false;
}
// The card asks for another try: what failed is forgotten, so the next draw is made again.
export function retryView(id) {
  let n = 0;
  for (const k of [...failed.keys()]) if (k.startsWith(id + '@')) { failed.delete(k); n++; }
  return n;
}

// The kept picture's file path (for an upload), drawing it first if needed; null when it can't be had.
export async function mapViewFile(id, opts = {}) {
  const { invoke } = window.__TAURI__.core;
  if (!(await mapThumbFor(id, opts))) return null;
  const stamp = versioned(opts.stamp || (await invoke('map_view_stamp', { id }).catch(() => null)) || 'x');
  return invoke('map_view_path', { id, stamp }).catch(() => null);
}
