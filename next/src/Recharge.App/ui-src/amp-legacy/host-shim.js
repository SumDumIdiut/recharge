// Shims window.__TAURI__.core.invoke onto recharge-next's bridge (call()), so the old Amplifier editor (built for the
// old Tauri app) runs in the new WebKit/WebView2 shell. Install before mountEditor; the returned fn uninstalls it.
import { call } from '../bridge.js';

// amp.save needs the name separately; the old save_map carried it inside the map JSON.
function nameOf(mapJson) {
  try { const o = JSON.parse(mapJson); return (typeof o.name === 'string' && o.name) || 'Untitled map'; } catch { return 'Untitled map'; }
}

const handlers = {
  // --- core: read / save / list installed maps ---
  async read_map(a) { const r = await call('amp.load', { id: a.id }); return r.map; },
  async save_map(a) {
    const r = await call('amp.save', { id: a.id || '', name: nameOf(a.mapJson), map: a.mapJson });
    return r.id;
  },
  async list_maps() {
    try {
      const r = await call('library.installed', {});
      const maps = (r && Array.isArray(r.maps)) ? r.maps : (Array.isArray(r) ? r : []);
      return maps.map((m) => ({ id: m.folder || m.id, name: m.name || m.folder || m.id, description: m.description || '', uid: m.uid }));
    } catch { return []; }
  },
  async uninstall_map(a) { try { await call('library.remove', { id: a.id || a.folder }); } catch (e) { /* best effort */ } return null; },

  // --- test in game: hand the map to the launcher (best effort) ---
  async test_launch_map(a) { try { return await call('game.launch', { testMap: a.mapJson }); } catch (e) { throw new Error('unsupported'); } },

  // --- export / hub browse / upload: not wired in the embedded editor yet ---
  async export_map_zip() { throw new Error('unsupported'); },
  async fetch_hub_map_json() { throw new Error('unsupported'); },
  async install_from_hub_cmd() { throw new Error('unsupported'); },
  async submit_installed_map_cmd() { throw new Error('unsupported'); },
  async delete_hub_submission_cmd() { throw new Error('unsupported'); },
  async set_map_hub_name() { return null; },

  // --- map-view thumbnail cache + installed-asset reads: no-op (thumbnails / custom images just won't show) ---
  async map_view_path() { return null; },
  async map_view_stamp() { return 0; },
  async read_map_view() { return null; },
  async write_map_view() { return null; },
  async read_map_asset() { return null; },
  async find_map_asset() { return null; },
};

export function installAmpHostShim() {
  const w = window;
  const prev = w.__TAURI__;
  const invoke = async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) { console.warn('[amp-legacy] unhandled invoke: ' + cmd); throw new Error('unsupported'); }
    return h(args || {});
  };
  w.__TAURI__ = Object.assign({}, prev, { core: Object.assign({}, prev && prev.core, { invoke }) });
  return () => { w.__TAURI__ = prev; };
}
