// The map to and from the game: save into the installed maps (one slot per map, its
// earlier saves kept as history), test in the game, export a .zip.
import { buildMap } from './export.js';
import { shoot } from './thumb.js';

const TEST_MAP_ID = 'map-maker-test';
const invoke = () => window.__TAURI__?.core?.invoke;

// Files a map uses (your images and music), kept in IndexedDB by the editor.
let assetDb = null;
function assets() {
  assetDb ||= new Promise((ok, fail) => {
    const req = indexedDB.open('rechargeMapAssets', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  return assetDb;
}
async function assetBlob(file) {
  const db = await assets();
  return new Promise((ok) => { const r = db.transaction('files').objectStore('files').get(file); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); });
}
async function putAsset(file, blob) {
  const db = await assets();
  return new Promise((ok, fail) => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(blob, file); t.oncomplete = ok; t.onerror = () => fail(t.error); });
}
export function pickFile(accept) {
  return new Promise((ok) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => ok(inp.files[0] || null);
    inp.click();
  });
}
// A file of yours into the map (kind: 'image' | 'music'): kept under a name of its own.
export async function addAsset(doc, kind, fileObj) {
  const ext = (fileObj.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
  const file = kind + '-' + Date.now().toString(36) + ext;
  await putAsset(file, fileObj);
  doc.change('Add ' + kind, () => { doc.touchMeta(); doc.meta.assets = [...(doc.meta.assets || []), { file, name: fileObj.name, kind }]; });
  return file;
}
export async function assetUrl(file) { const b = await assetBlob(file); return b ? URL.createObjectURL(b) : null; }
// A map opened from the installed maps brings its files back in.
export async function fetchInstalledAssets(doc, id) {
  const run = invoke();
  if (!run) return;
  for (const a of doc.meta.assets || []) {
    if (await assetBlob(a.file)) continue;
    try {
      const bin = atob(await run('read_map_asset', { id, file: a.file })), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await putAsset(a.file, new Blob([bytes]));
    } catch { /* this build can't read them: the choice stays, the preview won't */ }
  }
}

export async function mapAssets(doc) {
  const used = new Set(), note = (m) => { if (typeof m === 'string' && m.startsWith('asset:')) used.add(m.slice(6)); };
  note(doc.meta.music);
  if (doc.meta.background?.image) used.add(doc.meta.background.image);
  for (const e of doc.entities) {
    if (e.kind === 'sprite' && e.image) used.add(e.image);
    if (e.kind === 'trigger' || e.kind === 'spawn') { note(e.music); if (e.background?.image) used.add(e.background.image); }
  }
  const out = [];
  for (const file of used) {
    const blob = await assetBlob(file);
    if (!blob) continue;
    out.push({ file, data: await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); }) });
  }
  return out;
}

const slug = (s) => (s || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'map';

export class MapFiles {
  constructor(ed) {
    this.ed = ed;
    this.lastSaved = null;
    this.autoAt = 0;
    this.timer = setInterval(() => this.autosaveTick(), 10000);
  }
  get doc() { return this.ed.doc; }

  // The installed map that is this map (same uid), if any.
  async slot() {
    const run = invoke(), uid = this.doc.meta.uid;
    if (!run || !uid) return null;
    try { return (await run('list_maps')).find((m) => m.uid === uid && m.id !== TEST_MAP_ID)?.id || null; } catch { return null; }
  }

  async save({ auto = false } = {}) {
    const run = invoke();
    if (!run) { if (!auto) this.ed.flash('Saving needs the Recharge app.'); return false; }
    let map;
    try { map = buildMap(this.ed); } catch (e) { if (!auto) this.ed.flash('Couldn\'t build the map: ' + e.message); return false; }
    const text = JSON.stringify(map);
    if (auto && text === this.lastSaved) return false;
    try {
      let id = this.doc.meta.savedId || await this.slot();
      if (!id) {
        const taken = new Set((await run('list_maps')).map((m) => m.id));
        taken.add(TEST_MAP_ID);
        const stem = slug(map.name);
        id = stem;
        for (let n = 2; taken.has(id); n++) id = stem + '-' + n;
      }
      await run('save_map', { id, mapJson: text, assets: await mapAssets(this.doc), auto });
      // Its picture in the maps list: the whole map zoomed out (drawn here, then the view put back).
      try { const img = shoot(this.ed.renderer, this.ed.gl, this.doc); this.ed.draw(); if (img) await run('write_map_thumb', { id, data: img }); } catch { /* the list shows it without */ }
      this.lastSaved = text;
      this.doc.meta.savedId = id;
      this.doc.meta.savedAt = Date.now();
      this.ed.saver.soon();
      if (!auto) this.ed.flash(`Saved "${map.name}" to your maps`);
      this.ed.emit('doc');
      return true;
    } catch (e) {
      if (!auto) this.ed.flash('Couldn\'t save: ' + e);
      return false;
    }
  }

  autosaveTick() {
    const every = (this.doc?.meta.autosave || 0) * 60000;
    if (!every || !this.doc.meta.savedId || this.ed.tools?.drag || this.ed.root.hidden) return;
    if (!this.autoAt) this.autoAt = Date.now() + every;
    if (Date.now() < this.autoAt) return;
    this.autoAt = Date.now() + every;
    this.save({ auto: true });
  }

  async history() {
    const run = invoke(), id = this.doc.meta.savedId;
    if (!run || !id) return [];
    try { return await run('map_history', { id }); } catch { return []; }
  }
  async openVersion(file) {
    const run = invoke(), id = this.doc.meta.savedId;
    const text = await run('read_map_version', { id, file });
    return JSON.parse(text);
  }

  async test() {
    const run = invoke();
    if (!run) { this.ed.flash('Testing needs the Recharge app.'); return; }
    try {
      const map = buildMap(this.ed);
      const how = await run('test_launch_map', { mapJson: JSON.stringify(map), assets: await mapAssets(this.doc) });
      this.ed.flash(how === 'steam' || how?.method === 'steam' ? 'Starting the game through Steam…' : 'Starting the game…');
    } catch (e) { this.ed.flash('Couldn\'t start the test: ' + e); }
  }

  async exportZip() {
    const run = invoke();
    const map = buildMap(this.ed), text = JSON.stringify(map);
    if (run) {
      try {
        const where = await run('export_map_zip', { mapJson: text, fileName: slug(map.name) + '.zip', assets: await mapAssets(this.doc) });
        if (where) this.ed.flash('Exported to ' + where);
      } catch (e) { this.ed.flash('Couldn\'t export: ' + e); }
      return;
    }
    // Outside the app: the map.json as a download.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = slug(map.name) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}
