// Building and saving a big map: the export's block grid, the pieced pretty JSON, and undo/redo keeping the entries' order.
// node --test tests/amp-save-build.test.mjs
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


import crypto from 'node:crypto';

const { __test: T } = await import('../src/maps/editor.js');
await T.fetchBase();

let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const KINDS = ['ground', 'ground', 'ground', 'dark', 'blue', 'orange', 'bgwall', 'bgfloor', 'bglight', 'breakable', 'illusory', 'floorplate'];
function fill(n) {
  T.open({ name: 'save-build', useBase: false });
  for (let i = 0; i < n; i++) T.own.blocks.set((Math.floor(rnd() * 140) - 50) + ',' + (Math.floor(rnd() * 90) - 30), KINDS[Math.floor(rnd() * KINDS.length)]);
  for (let i = 0; i < 200; i++) T.own.spikes.set((Math.floor(rnd() * 140) - 50) + ',' + (Math.floor(rnd() * 90) - 30), { c: ['spike', 'dark', 'true'][i % 3], q: i % 4 });
  for (let i = 0; i < 30; i++) T.own.vines.set((Math.floor(rnd() * 140) - 50) + ',' + (Math.floor(rnd() * 90) - 30), { s: 'smallArc', q: i % 4 });
  for (let i = 0; i < 20; i++) T.own.tiles.set('ground|' + i + ',' + (i % 5), { layer: 'ground', tile: 'x' + i, m: [1, 0, 0, 1] });
}
const text = (m) => JSON.stringify(m, null, 2).replace(/"uid": "m[0-9a-z]+"/, '"uid": "X"');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

test('the export reads neighbours off a grid and gets what the Map lookups got', () => {
  fill(5000);
  const withGrid = text(T.buildMap());
  T.exportGridOff = true;
  const without = text(T.buildMap());
  T.exportGridOff = false;
  assert.ok(withGrid.length > 100000, 'a real map: ' + withGrid.length);
  assert.equal(sha(withGrid), sha(without), 'the same map.json, byte for byte');
});

test('the pieced pretty JSON of a built map is the engine\'s own', async () => {
  fill(4000);
  const map = T.buildMap();
  assert.equal(await T.mapJsonText(map), JSON.stringify(map, null, 2));
});

test('undo and redo put the entries back in the order they had, so the saved file is the same as before the edit', () => {
  fill(3000);
  T.pushUndo(); T.undo(); // (an undo writes the draft's empty hiddenGroups; the file compared is one from after it)
  const orderOf = () => [T.own.blocks, T.own.spikes, T.own.vines, T.own.tiles].map((m) => [...m].map(([k, v]) => k + '=' + JSON.stringify(v)).join(';')).join('|');
  const before = orderOf(), savedBefore = sha(text(T.buildMap()));
  T.pushUndo();
  const firstKeys = [...T.own.blocks.keys()].slice(100, 130);
  for (const k of firstKeys) T.own.blocks.delete(k); // erased from the middle of the map
  T.own.blocks.set(firstKeys[3], 'dark'); // and one put back later (so it sits at the end now)
  T.own.spikes.delete([...T.own.spikes.keys()][5]);
  T.own.blocks.set('900,900', 'ground');
  const edited = orderOf(), savedEdited = sha(text(T.buildMap()));
  assert.notEqual(edited, before);
  T.undo();
  assert.equal(orderOf(), before, 'undo: the same entries in the same order');
  assert.equal(sha(text(T.buildMap())), savedBefore, 'undo: the saved file is the one from before the edit');
  T.redo();
  assert.equal(orderOf(), edited, 'redo: the edited state, in its order');
  assert.equal(sha(text(T.buildMap())), savedEdited);
  T.undo();
  assert.equal(orderOf(), before);
});

test('saving writes the map as pieces that join to the engine\'s pretty JSON', async () => {
  fill(3000);
  const sent = [];
  globalThis.window.__TAURI__ = { core: { invoke: async (cmd, a) => { sent.push([cmd, a]); return cmd === 'list_maps' ? [] : null; } } };
  await T.saveMap();
  const save = sent.find(([c]) => c === 'save_map');
  assert.ok(save, 'save_map was called');
  assert.equal(save[1].mapJson.replace(/"uid": "m[0-9a-z]+"/, '"uid": "X"'), text(T.buildMap()), 'the text it was given is the pretty JSON of the map');
  globalThis.window.__TAURI__ = undefined;
});

test('a second save asked for while one is being written follows it', async () => {
  fill(500);
  let calls = 0;
  globalThis.window.__TAURI__ = { core: { invoke: async (cmd) => { if (cmd === 'save_map') calls++; return cmd === 'list_maps' ? [] : null; } } };
  const a = T.saveMap(), b = T.saveMap(), c = T.saveMap();
  await Promise.all([a, b, c]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2, 'one save, and one more for everything asked for during it');
  globalThis.window.__TAURI__ = undefined;
});
