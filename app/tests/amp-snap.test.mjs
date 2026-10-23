// The editor's one snapping rule (E1-E7): every draw path rounds a destination rect's edges to the
// pixel grid instead of overscanning it by a hand-tuned constant, so two neighbours that share an
// edge meet exactly - and the two 9-slice paths (the scrolled scene and the rotated one) share one
// helper and so draw the same thing.
// node tests/amp-snap.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- a stub browser: enough DOM for the editor's module to load ----
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
const snap = T.snapRect;

await test('a snapped rect is the gap between two snapped edges, and neighbours share the edge exactly', () => {
  for (const ratio of [1, 1.5, 2, 3]) {
    globalThis.window.devicePixelRatio = ratio;
    for (const x of [0, 3.25, -7.5, 100.125, 42.6667]) {
      const a = snap(x, x, 10, 10), b = snap(x + 10, x + 10, 10, 10);
      assert.ok(Math.abs(a.x + a.w - b.x) < 1e-9, 'the pieces meet at dpr ' + ratio);
      assert.ok(Math.abs(a.y + a.h - b.y) < 1e-9, 'the pieces meet at dpr ' + ratio);
      assert.ok(a.w > 0 && a.h > 0, 'a piece keeps its size');
      // every edge is on the device-pixel grid
      for (const v of [a.x, a.x + a.w, a.y, a.y + a.h]) assert.ok(Math.abs(v * ratio - Math.round(v * ratio)) < 1e-9, 'edge on the grid');
    }
  }
  globalThis.window.devicePixelRatio = 1;
});

await test('a piece smaller than a pixel keeps one whole pixel instead of vanishing', () => {
  globalThis.window.devicePixelRatio = 1;
  const p = snap(0.2, 0.2, 0.2, 0.2);
  assert.equal(p.w, 1);
  assert.equal(p.h, 1);
  assert.equal(snap(0.2, 0.2, 0, 0).w, 0, 'nothing to draw stays nothing');
});

await test('the backdrops keep the canvas pixel, so their tiles are still blitted 1:1', () => {
  globalThis.window.devicePixelRatio = 2;
  const r = snap(10.4, 20.6, 30.2, 40.1, 1, false);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h), 'a whole-pixel tile');
  // the device grid would put the same tile on half pixels
  const d = snap(10.4, 20.6, 30.2, 40.1);
  assert.notEqual(d.x, r.x);
});

await test('the 9-slice draws nine pieces whose edges meet exactly', () => {
  globalThis.window.devicePixelRatio = 1;
  const calls = [];
  const g = { drawImage: (...a) => calls.push(a) };
  const src = [0, 30, 90, 120], dst = [0, 30.5, 90.25, 120];
  T.drawNineSlice(g, 'img', src, src, dst, dst, 1);
  assert.equal(calls.length, 9, 'nine pieces');
  const piece = (i, j) => calls[i * 3 + j];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 2; i++) {
      const a = piece(i, j), b = piece(i + 1, j);
      assert.equal(a[5] + a[7], b[5], 'the pieces in a row meet');
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const a = piece(i, j), b = piece(i, j + 1);
      assert.equal(a[6] + a[8], b[6], 'the pieces in a column meet');
    }
  }
  // no destination is stretched past its source by more than the grid allows
  for (const c of calls) assert.ok(c[7] <= c[3] + 1 && c[8] <= c[4] + 1, 'no overscan');
});

await test('the scrolled scene and the rotated one draw the same 9-slice (one helper)', () => {
  globalThis.window.devicePixelRatio = 2;
  const src = [0, 30, 90, 120];
  const sprite = [0, 30, 90, 120];               // the scrolled scene's own units
  const screen = sprite.map((v) => v * 2);        // the rotated one's screen pixels
  const calls = [];
  const g = { drawImage: (...a) => calls.push(a) };
  T.drawNineSlice(g, 'img', src, src, sprite, sprite, { x: 2, y: 2 });
  const e6 = calls.splice(0).map((c) => [c[5] * 2, c[6] * 2, c[7] * 2, c[8] * 2]);
  T.drawNineSlice(g, 'img', src, src, screen, screen, 1);
  const e7 = calls.splice(0).map((c) => [c[5], c[6], c[7], c[8]]);
  assert.deepEqual(e6, e7, 'the same image at the same size draws the same thing');
});

console.log(n + ' tests passed');
