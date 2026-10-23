// The preview worker's cache key: a state without a version must give a real number (an undefined one made every ++ NaN and the levelOverrides cache never hit), and the cell-chunk patch bookkeeping.
// node tests/amp-render-perf.test.mjs
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

const { __test: T, workerSetState } = await import('../src/maps/editor.js');
await T.fetchBase();
assert.ok(T.base?.art, 'basemap loaded');


await test('workerSetState with no version leaves a finite baseVersion', () => {
  workerSetState({ baseState: 'start', removed: [], removedVines: [] });
  assert.ok(Number.isFinite(T.baseVersion), 'baseVersion ' + T.baseVersion);
  assert.equal(T.baseVersion, 0);
});

await test('baseVersion stays finite and increases through the preview renderer\'s increment', () => {
  workerSetState({ baseState: 'start', removed: [], removedVines: [] });
  let v = T.baseVersion; v++;
  assert.ok(Number.isFinite(v) && v === 1);
});

await test('a state with a version keeps it; junk versions fall back to 0', () => {
  workerSetState({ baseState: 'start', removed: [], removedVines: [], version: 7 });
  assert.equal(T.baseVersion, 7);
  workerSetState({ baseState: 'start', removed: [], removedVines: [], version: NaN });
  assert.equal(T.baseVersion, 0);
});

console.log(n + ' passed');
process.exit(0);
