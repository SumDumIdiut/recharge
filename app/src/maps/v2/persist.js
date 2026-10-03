// The v2 draft in IndexedDB (its own database, apart from the old editor's): the
// document without its tiles as one record, the tile store's tables, and its
// chunks one record each, so a save writes only the chunks that changed.
const DB = 'rechargeMapEditor2';
let opening = null;

function open() {
  if (!opening) opening = new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('chunks'); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => { opening = null; fail(req.error); };
  });
  return opening;
}
const done = (tx) => new Promise((ok, fail) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => fail(tx.error); });
const result = (req) => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });

export async function readDraft() {
  const db = await open();
  const tx = db.transaction(['kv', 'chunks'], 'readonly');
  const doc = await result(tx.objectStore('kv').get('doc'));
  if (!doc) return null;
  const meta = await result(tx.objectStore('kv').get('tiles'));
  const store = tx.objectStore('chunks');
  const [keys, values] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
  return { doc, meta, chunks: keys.map((k, i) => [k, values[i]]) };
}

// chunks: [[key, Uint32Array | null]] (null deletes); all: these are every chunk there is.
export async function writeDraft(doc, meta, chunks, all = false) {
  const db = await open();
  const tx = db.transaction(['kv', 'chunks'], 'readwrite');
  const kv = tx.objectStore('kv'), cs = tx.objectStore('chunks');
  kv.put(doc, 'doc');
  if (meta) kv.put(meta, 'tiles');
  if (all) cs.clear();
  for (const [k, c] of chunks) { if (c) cs.put(c, k); else cs.delete(k); }
  await done(tx);
}

// Saves a Doc a moment after it last changed; whole after a new document is loaded.
export class Saver {
  constructor(doc) {
    this.doc = doc;
    this.timer = 0;
    this.all = true;
    this.busy = Promise.resolve();
    doc.onChange(() => this.soon());
  }
  replaced() { this.all = true; this.soon(); }
  soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.now(), 600); }
  now() {
    clearTimeout(this.timer);
    const d = this.doc, all = this.all;
    this.all = false;
    const chunks = all ? [...d.tiles.layers.values()].flatMap((l) => [...l.chunks].map(([ck, c]) => [l.name + '|' + ck, c.slice()])) : d.tiles.takeDirty();
    if (all) d.tiles.takeDirty();
    const body = { v: 2, meta: d.meta, entities: d.entities, courses: d.courses, cellGroups: d.cellGroups || {} };
    this.busy = this.busy.then(() => writeDraft(body, d.tiles.meta(), chunks, all)).catch((e) => console.warn('draft save failed', e));
    return this.busy;
  }
}
