// The map maker's draft in IndexedDB: the draft itself (without its tiles),
// the tile store's tables, and its chunks one record each, so a save only
// writes what changed. A whole level is far past localStorage's few MB.
const DB = 'rechargeMapMaker';
let opening = null;

function open() {
  if (!opening) opening = new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('chunks');
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => { opening = null; fail(req.error); };
  });
  return opening;
}

const done = (tx) => new Promise((ok, fail) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => fail(tx.error); });
const result = (req) => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });

// { draft, meta, chunks: [[key, Uint32Array]] } or null.
export async function readDraft() {
  const db = await open();
  const tx = db.transaction(['kv', 'chunks'], 'readonly');
  const draft = await result(tx.objectStore('kv').get('draft'));
  if (!draft) return null;
  const meta = await result(tx.objectStore('kv').get('tiles'));
  const store = tx.objectStore('chunks');
  const [keys, values] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
  return { draft, meta, chunks: keys.map((k, i) => [k, values[i]]) };
}

// chunks: [[key, Uint32Array | null]] - null deletes; all: the chunks are every chunk there is.
export async function writeDraft(draft, meta, chunks, all = false) {
  const db = await open();
  const tx = db.transaction(['kv', 'chunks'], 'readwrite');
  const kv = tx.objectStore('kv'), cs = tx.objectStore('chunks');
  kv.put(draft, 'draft');
  if (meta) kv.put(meta, 'tiles');
  if (all) cs.clear();
  for (const [k, c] of chunks) { if (c) cs.put(c, k); else cs.delete(k); }
  await done(tx);
}
