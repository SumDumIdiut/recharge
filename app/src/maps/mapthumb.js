// The extracted fullmap picture for a map (Hub id, also the id once installed): the installed map's own, else one drawn from its map.json (installed copy, or fetched from the Library).
const inflight = new Map();
// One at a time: thumbOf shares one offscreen renderer, so concurrent draws would race.
let last = Promise.resolve(null);

async function work(id) {
  const { invoke } = window.__TAURI__.core;
  const b64 = await invoke('read_map_thumb', { id }).catch(() => null);
  if (b64) return 'data:image/png;base64,' + b64;
  let json = null;
  try { json = await invoke('read_map', { id }); } catch {
    try { json = await invoke('fetch_hub_map_json', { id }); } catch { json = null; }
  }
  if (!json) return null;
  try {
    // No pre-rendered thumb: fall back to null (the server-side read_map_thumb returns one for installed maps).
    await invoke('write_map_thumb', { id, data: null }).catch(() => {});
    return null;
  } catch (e) {
    console.warn('map picture', id, e);
    return null;
  }
}

export function mapThumbFor(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = last.then(() => work(id)).catch(() => null);
  last = p;
  inflight.set(id, p);
  p.finally(() => inflight.delete(id));
  return p;
}