// The draft autosave (E20) and the undo memory budget (E22), headless.
// node --test --test-concurrency=1 tests/amp-autosave-undo.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');

// ---- a stub browser: enough DOM for the editor's module to load and its state functions to run ----
const store = {};
const session = {};
let lsBroken = false; // localStorage refuses what it is given (a full quota)
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { if (lsBroken) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.sessionStorage = {
  getItem: (k) => session[k] ?? null,
  setItem: (k, v) => { session[k] = String(v); },
  removeItem: (k) => { delete session[k]; },
};
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2, deviceMemory: 4 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };
globalThis.fetch = async (url) => {
  const file = path.join(mapsDir, String(url).replace(/^.*\/maps\//, '').split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } };
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text, json: async () => JSON.parse(text) };
};

// ---- a small in-memory IndexedDB, enough for draftdb.js (a kv store and a chunks store) ----
const idbState = { putBroken: false, db: null };
const idbReq = (fn) => {
  const req = { onsuccess: null, onerror: null, result: undefined, error: null };
  setTimeout(() => { try { req.result = fn(); req.onsuccess?.(); } catch (e) { req.error = e; req.onerror?.(); } }, 0);
  return req;
};
const makeDb = () => {
  const stores = new Map();
  return {
    stores,
    createObjectStore: (n) => { stores.set(n, new Map()); },
    transaction(names, mode) {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = (n) => {
        if (!stores.has(n)) stores.set(n, new Map());
        const s = stores.get(n);
        return {
          put: (v, k) => { if (idbState.putBroken) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } s.set(k, v); },
          get: (k) => idbReq(() => s.get(k)),
          getAllKeys: () => idbReq(() => [...s.keys()]),
          getAll: () => idbReq(() => [...s.values()]),
          clear: () => s.clear(),
          delete: (k) => s.delete(k),
        };
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
};
globalThis.indexedDB = {
  open(name) {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null, error: null };
    Object.defineProperty(req, 'result', { get: () => idbState.db });
    setTimeout(() => {
      if (!idbState.db) { idbState.db = makeDb(); req.onupgradeneeded?.(); }
      req.onsuccess?.();
    }, 0);
    return req;
  },
};
const idbDraft = () => idbState.db?.stores.get('kv')?.get('draft') || null;

// ---- the editor ----
const { __test: T } = await import('../src/maps/editor.js');
await T.fetchBase();

// A fake element that counts how often its text is set (a flash that repeats is a bug).
const fakeEl = () => {
  const el = { innerHTML: '', hidden: false, title: '', sets: 0, _text: '' };
  el.classList = { toggle() {}, remove() {}, add() {} };
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = String(v); el.sets++; } });
  return el;
};
// A fake root: the editor writes its status and its indicators into it.
const fakeRoot = (els) => ({ querySelector: (sel) => els[sel] || null });
// An undo step that claims to be huge (the byte budget is what trims it).
const hugeStep = (bytes) => ({ bytes, rest: 'x'.repeat(16) });

const reset = () => {
  lsBroken = false;
  idbState.putBroken = false;
  for (const s of idbState.db?.stores.values() || []) s.clear();
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(session)) delete session[k];
  T.undoStack = [];
  T.undoTrimReported = false;
  T.autosaveOff = false;
  T.autosaveAt = 0;
  T.tooBigAt = Infinity;
  T.open({ name: 't', useBase: false });
};

await test('E20: a normal map autosaves and the indicator says when', async () => {
  reset();
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft();
  assert.equal(T.autosaveOff, false, 'the autosave stays on');
  assert.ok(T.autosaveAt > 0, 'the time of the autosave is known');
  assert.match(T.autosaveLabel(), /Draft autosaved/, 'the indicator says the draft was autosaved');
  assert.ok(store.rechargeMapMakerDraft, 'the draft is in localStorage');
  assert.equal(JSON.parse(store.rechargeMapMakerDraft).blocks['0,0'], 'ground', 'the draft holds the edits');
});

await test('E20: a draft too big for localStorage goes to IndexedDB instead of switching the autosave off', async () => {
  reset();
  lsBroken = true; // localStorage is full
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft();
  assert.equal(T.autosaveOff, false, 'the autosave is not switched off');
  assert.equal(T.autosaveStore, 'idb', 'the draft went to IndexedDB');
  assert.ok(idbDraft(), 'the draft is in IndexedDB');
  assert.equal(idbDraft().blocks['0,0'], 'ground', 'the draft holds the edits');
  assert.match(T.autosaveLabel(), /Draft autosaved/, 'the indicator still says the draft was autosaved');
});

await test('E20: when neither store takes it, a persistent badge says the autosave is off', async () => {
  reset();
  lsBroken = true;
  idbState.putBroken = true;
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft();
  assert.equal(T.autosaveOff, true, 'the autosave is off');
  assert.match(T.autosaveLabel(), /autosave off - use Save or Export/, 'the badge names the fallback');
  // and it stays: another failed autosave does not make it go away
  await T.persistDraft();
  assert.match(T.autosaveLabel(), /autosave off - use Save or Export/, 'the badge is persistent');
  const el = fakeEl();
  T.setRoot(fakeRoot({ '#mm-autosave-state': el }));
  T.updateAutosaveIndicator();
  assert.equal(el.hidden, false, 'the badge is shown');
  assert.match(el.textContent, /autosave off - use Save or Export/, 'the badge says so in the editor too');
});

await test('E20: the last good draft is kept when a later write fails', async () => {
  reset();
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft();
  const good = store.rechargeMapMakerDraft;
  lsBroken = true;
  idbState.putBroken = true;
  T.own.blocks.set('1,0', 'ground');
  await T.persistDraft();
  assert.equal(T.autosaveOff, true, 'the autosave is off');
  assert.equal(store.rechargeMapMakerDraft, good, 'the last good draft is still there');
  assert.match(T.autosaveLabel(), /the last draft that fit is from/, 'the badge says when the last good draft is from');
});

await test('E20: a map that shrinks below the latch resumes the autosave', async () => {
  reset();
  T.own.tiles.set('ground|0,0', { t: 'x' });
  lsBroken = true;
  idbState.putBroken = true;
  await T.persistDraft();
  assert.equal(T.autosaveOff, true, 'the autosave is off while the map does not fit');
  T.own.tiles.delete('ground|0,0'); // the map shrinks
  lsBroken = false;
  await T.persistDraft();
  assert.equal(T.autosaveOff, false, 'the autosave resumes once the map fits again');
  assert.match(T.autosaveLabel(), /Draft autosaved/, 'the badge is back to normal');
});

await test('E20: loading takes the newer of the localStorage and the IndexedDB draft', async () => {
  reset();
  const older = { name: 'older', useBase: false, autosavedAt: 1000 };
  const newer = { name: 'newer', useBase: false, autosavedAt: 2000 };
  // the IndexedDB copy is the newer one
  store.rechargeMapMakerDraft = JSON.stringify(older);
  idbState.db.stores.get('kv').set('draft', newer);
  await T.loadDraft();
  assert.equal(T.draft.name, 'newer', 'the newer IndexedDB draft wins');
  // and the localStorage copy when it is the newer one
  store.rechargeMapMakerDraft = JSON.stringify(newer);
  idbState.db.stores.get('kv').set('draft', older);
  await T.loadDraft();
  assert.equal(T.draft.name, 'newer', 'the newer localStorage draft wins');
  // with only one of them, that one is loaded
  store.rechargeMapMakerDraft = JSON.stringify(older);
  idbState.db.stores.get('kv').delete('draft');
  await T.loadDraft();
  assert.equal(T.draft.name, 'older', 'the localStorage draft is loaded when it is the only one');
});

await test('E20: a session whose autosave failed warns the next one that the newest edits are gone', async () => {
  reset();
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft(); // a good draft in localStorage
  lsBroken = true;
  idbState.putBroken = true;
  T.own.blocks.set('1,0', 'ground');
  await T.persistDraft(); // this one fails: the newest edits are not stored anywhere
  assert.equal(T.autosaveOff, true);
  // the next session loads the last good draft and says so
  lsBroken = false;
  idbState.putBroken = false;
  const flash = fakeEl();
  T.setRoot(fakeRoot({ '#mm-flash': flash, '#mm-autosave-state': fakeEl() }));
  await T.loadDraft();
  assert.equal(T.draft.blocks['1,0'], undefined, 'the draft that comes back is the last one that fit');
  assert.equal(T.draft.blocks['0,0'], 'ground', 'and it holds the edits that were stored');
  assert.match(T.draftOffNote, /autosave failed/, 'the author is told the newest edits were not kept');
  // a good autosave clears the note
  await T.persistDraft();
  assert.equal(T.draftOffNote, '');
});

await test('E20: the draft autosave indicator is separate from the file save indicator', async () => {
  reset();
  const auto = fakeEl(), save = fakeEl();
  T.setRoot(fakeRoot({ '#mm-autosave-state': auto, '#mm-save-state': save }));
  T.own.blocks.set('0,0', 'ground');
  await T.persistDraft();
  T.updateAutosaveIndicator();
  T.syncSaveState();
  assert.match(auto.textContent, /Draft autosaved/, 'the autosave line says when the draft was stored');
  assert.doesNotMatch(save.textContent, /Draft autosaved/, 'the file save line does not report the draft');
  assert.match(save.textContent, /Not saved yet/, 'the file save line talks about the file save');
  assert.doesNotMatch(auto.textContent, /your maps/, 'the autosave line does not talk about the file save');
});

await test('E22: the status bar reports the undo depth and the estimated size', async () => {
  reset();
  T.own.blocks.set('0,0', 'ground');
  T.pushUndo();
  T.own.blocks.set('1,0', 'ground');
  T.pushUndo();
  const status = fakeEl();
  T.setRoot(fakeRoot({ '#mm-status': status }));
  T.updateStatus();
  assert.match(status.innerHTML, /Undo: 2 steps \([\d.]+ MB\)/, 'the status shows the depth and the estimated MB');
  assert.ok(T.undoBytes() > 0, 'the history has an estimated size');
});

await test('E22: the first trim of the session is reported once', async () => {
  reset();
  const flash = fakeEl(), status = fakeEl();
  T.setRoot(fakeRoot({ '#mm-flash': flash, '#mm-status': status }));
  T.undoStack = [hugeStep(1024 * 1024 * 1024), hugeStep(1024 * 1024 * 1024)]; // more than the budget
  T.trimUndo();
  assert.equal(T.undoTrimReported, true, 'the trim is remembered');
  assert.match(flash.textContent, /history trimmed/, 'the author is told');
  const told = flash.sets;
  T.undoStack = [hugeStep(1024 * 1024 * 1024), hugeStep(1024 * 1024 * 1024)];
  T.trimUndo();
  assert.equal(flash.sets, told, 'the trim is not reported again');
  T.updateStatus();
  assert.match(status.innerHTML, /history trimmed/, 'the status says the history is shorter than expected');
});

await test('E22: the newest step is never trimmed', async () => {
  reset();
  const newest = hugeStep(1024 * 1024 * 1024);
  T.undoStack = [newest];
  T.trimUndo();
  assert.equal(T.undoStack.length, 1, 'the step stays');
  assert.equal(T.undoStack[0], newest, 'the newest step is the one that stays');
  const older = hugeStep(1024 * 1024 * 1024);
  T.undoStack = [older, newest];
  T.trimUndo();
  assert.equal(T.undoStack.length, 1, 'the old step goes, not the new one');
  assert.equal(T.undoStack[0], newest, 'the newest step is still there');
});

await test('E22: 200 small steps all stay (the byte cap is not hit)', async () => {
  reset();
  for (let i = 0; i < 200; i++) { T.own.blocks.set(i + ',0', 'ground'); T.pushUndo(); }
  assert.equal(T.undoStack.length, 200, 'every step is kept');
  assert.ok(T.undoBytes() < T.undoLimits().maxBytes, 'the history is well inside the byte budget');
});

await test('E22: huge steps are trimmed by size, not by count', async () => {
  reset();
  T.undoStack = Array.from({ length: 20 }, () => hugeStep(1024 * 1024 * 1024));
  T.trimUndo();
  assert.ok(T.undoStack.length < 20, 'the history is trimmed');
  assert.equal(T.undoStack.length, 1, 'only the newest step is left');
  assert.ok(T.undoBytes() >= T.undoLimits().maxBytes, 'a single step may be over the budget on its own');
});

await test('E22: undo after a trim restores without throwing', async () => {
  reset();
  T.own.blocks.set('0,0', 'ground');
  T.pushUndo(); // the step the first undo goes back to
  T.own.blocks.set('1,0', 'ground');
  T.pushUndo();
  T.own.blocks.set('2,0', 'ground');
  for (const s of T.undoStack) s.bytes = 1024 * 1024 * 1024; // the byte cap trims them
  T.trimUndo();
  assert.ok(T.undoStack.length >= 1, 'there is something left to undo');
  T.undo();
  assert.equal(T.own.blocks.has('2,0'), false, 'the last edit is undone');
  assert.equal(T.own.blocks.has('1,0'), true, 'the state before it is back');
  T.redo();
  assert.equal(T.own.blocks.has('2,0'), true, 'and redo puts it back');
});

await test('E22: the per-entry overhead is a named constant', async () => {
  const src = fs.readFileSync(path.join(mapsDir, 'editor.js'), 'utf8');
  assert.match(src, /const UNDO_ENTRY_OVERHEAD = 60;/, 'the 60 byte estimate is a named constant');
  assert.equal(T.undoLimits().entryOverhead, 60, 'and it is the per-entry overhead');
  assert.ok(T.undoLimits().maxSteps > 0 && T.undoLimits().maxBytes > 0, 'the limits are known');
});

// ---- a big draft in IndexedDB is written in pieces (a record per area of cells) ----
const idbChunks = () => idbState.db?.stores.get('chunks') || new Map();
const sameCells = (a, b) => { if (a.size !== b.size) return false; for (const [k, v] of a) if (JSON.stringify(b.get(k)) !== JSON.stringify(v)) return false; return true; };

await test('E20: a big draft goes to IndexedDB in pieces, an autosave writes only the areas that changed, and it loads back the same', async () => {
  reset();
  lsBroken = true;
  for (let i = 0; i < 30000; i++) T.own.blocks.set((i % 300) + ',' + Math.floor(i / 300), i % 7 ? 'ground' : 'dark');
  for (let i = 0; i < 300; i++) T.own.spikes.set(i + ',-3', { c: 'spike', q: i % 4 });
  T.own.vines.set('5,-9', { s: 'smallArc', q: 1 });
  T.own.tiles.set('front|3,3', { layer: 'front', tile: 't', m: [1, 0, 0, 1] });
  await T.persistDraft();
  assert.equal(T.autosaveStore, 'idb', 'it went to IndexedDB');
  assert.equal(idbDraft().cellChunks, true, 'the draft record says its cells are in pieces');
  assert.deepEqual(Object.keys(idbDraft().blocks), [], 'and holds none itself');
  const first = new Map(idbChunks());
  assert.ok(first.size > 20, 'a record per area: ' + first.size);
  // an edit in one area, a block taken from another, a spike added elsewhere
  T.own.blocks.set('10,10', 'blue');
  T.own.blocks.delete('250,90');
  T.own.spikes.set('7,-4', { c: 'dark', q: 2 });
  await T.persistDraft();
  const second = idbChunks();
  let rewritten = 0;
  for (const [k, v] of second) if (first.get(k) !== v) rewritten++;
  assert.ok(rewritten >= 2 && rewritten <= 4, 'only the touched areas were written again: ' + rewritten + ' of ' + second.size);
  // nothing changed: nothing but the draft record is written
  const third = new Map(idbChunks());
  await T.persistDraft();
  for (const [k, v] of idbChunks()) assert.equal(third.get(k), v, 'an unchanged area is not rewritten');
  // a cell removed from an area empties its record
  for (let i = 0; i < 300; i++) T.own.spikes.delete(i + ',-3');
  T.own.spikes.delete('7,-4');
  await T.persistDraft();
  assert.ok(![...idbChunks().keys()].some((k) => k.startsWith('spikes|')), 'a collection with no cells left has no records');
  // load it back
  const order = { blocks: [...T.own.blocks.keys()], spikes: [...T.own.spikes.keys()], tiles: [...T.own.tiles.keys()] };
  const want = { blocks: new Map(T.own.blocks), spikes: new Map(T.own.spikes), vines: new Map(T.own.vines), tiles: new Map(T.own.tiles) };
  T.open({ name: 'other', useBase: false });
  await T.loadDraft();
  assert.ok(sameCells(T.own.blocks, want.blocks), 'the blocks come back the same');
  assert.ok(sameCells(T.own.spikes, want.spikes), 'the spikes come back the same');
  assert.ok(sameCells(T.own.vines, want.vines), 'the vines come back the same');
  assert.ok(sameCells(T.own.tiles, want.tiles), 'the tiles come back the same');
  assert.equal(T.own.blocks.get('10,10'), 'blue');
  assert.equal(T.own.blocks.has('250,90'), false);
  assert.deepEqual([...T.own.blocks.keys()], order.blocks, 'and in the order they were in');
  assert.deepEqual([...T.own.spikes.keys()], order.spikes);
  assert.deepEqual([...T.own.tiles.keys()], order.tiles);
});

await test('E20: a failed write of pieces is written whole the next time, so nothing is lost', async () => {
  reset();
  lsBroken = true;
  for (let i = 0; i < 25000; i++) T.own.blocks.set((i % 250) + ',' + Math.floor(i / 250), 'ground');
  await T.persistDraft();
  T.own.blocks.set('3,3', 'dark');
  idbState.putBroken = true;
  await T.persistDraft();
  assert.equal(T.autosaveOff, true, 'the autosave says it is off');
  idbState.putBroken = false;
  T.own.blocks.set('4,4', 'dark');
  await T.persistDraft();
  assert.equal(T.autosaveOff, false);
  T.open({ name: 'other', useBase: false });
  await T.loadDraft();
  assert.equal(T.own.blocks.get('3,3'), 'dark', 'the edit of the failed write is in the next one');
  assert.equal(T.own.blocks.get('4,4'), 'dark');
  assert.equal(T.own.blocks.size, 25000);
});

await test('E20: a draft that shrinks below the pieces size is written whole and the pieces are dropped', async () => {
  reset();
  lsBroken = true;
  for (let i = 0; i < 22000; i++) T.own.blocks.set((i % 200) + ',' + Math.floor(i / 200), 'ground');
  await T.persistDraft();
  assert.ok(idbChunks().size > 0);
  for (let i = 0; i < 22000; i++) if (i > 100) T.own.blocks.delete((i % 200) + ',' + Math.floor(i / 200));
  T.tooBigAt = Infinity;
  await T.persistDraft();
  assert.equal(idbChunks().size, 0, 'no pieces are left behind');
  assert.equal(Object.keys(idbDraft().blocks).length, T.own.blocks.size, 'the draft holds its cells itself again');
});
