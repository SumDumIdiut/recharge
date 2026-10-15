// The far-out level overview kept between sessions: its key follows the level data and its edits (a changed state must never reuse a saved picture).
// node tests/amp-mip.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };
globalThis.fetch = async (url) => {
  const file = path.join(mapsDir, String(url).replace(/^.*\/maps\//, '').split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } };
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text, json: async () => JSON.parse(text) };
};

const { __test: T } = await import('../src/maps/editor.js');
await T.fetchBase();
assert.ok(T.base?.art, 'basemap loaded');

await test('the overview key is stable and carries the level fingerprint', () => {
  const a = T.ov().sig, b = T.ov().sig;
  assert.equal(a, b);
  assert.ok(T.ov().fp && a.includes(T.ov().fp), 'level fingerprint in the key');
});

await test('an edit to the level changes the key (cells removed from the level, then put back)', () => {
  const before = T.ov().sig;
  T.gone.removed.add('3,3');
  const after = T.ov().sig;
  assert.notEqual(before, after, 'removing a level cell must not reuse the saved overview');
  T.gone.removed.delete('3,3');
  assert.equal(T.ov().sig, before, 'undoing the edit finds the old picture again');
});

await test('moved or hidden level things change the key too', () => {
  const before = T.ov().sig;
  T.gone.movedScene.set('x', [10, 0]);
  assert.notEqual(T.ov().sig, before);
  T.gone.movedScene.delete('x');
  assert.equal(T.ov().sig, before);
});

console.log(n + ' mip tests passed');
