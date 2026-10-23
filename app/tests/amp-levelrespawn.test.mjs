// Level course respawn markers: picking them on the map, moving them, deleting them, exporting them and undoing it.
// node tests/amp-levelrespawn.test.mjs
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

const open = () => T.open({ name: 't', useBase: true, baseState: 'start' });
const respawn = (course) => T.levelRespawns().find((r) => r.course === course);
const gateAt = (x, y) => T.itemsAt(x, y).find((t) => t.kind === 'gate' && t.which === 'lrespawn');

await test('the level course respawns are there and can be picked on the map', () => {
  open();
  const rs = T.levelRespawns();
  assert.equal(rs.length, 10);
  assert.ok(rs.every((r) => r.g && typeof r.g.x === 'number' && typeof r.g.y === 'number'), 'every respawn has a place');
  const r = rs[0];
  assert.deepEqual([r.g.x, r.g.y], [r.at.x, r.at.y], 'untouched respawns sit where the level put them');
  assert.deepEqual(gateAt(r.g.x, r.g.y), { kind: 'gate', which: 'lrespawn', course: r.course });
});

await test('a respawn moves a cell and is saved and exported there', () => {
  open();
  const r = T.levelRespawns()[0];
  T.selection = { kind: 'gate', which: 'lrespawn', course: r.course };
  assert.ok(T.nudgeSelection(1, 0, false), 'it moved');
  assert.deepEqual([respawn(r.course).g.x, respawn(r.course).g.y], [r.at.x + 32, r.at.y]);
  assert.deepEqual(T.save().levelRespawns[r.course], [r.at.x + 32, r.at.y]);
  assert.deepEqual(T.buildMap().groups[0].levelRespawns[r.course], [r.at.x + 32, r.at.y]);
});

await test('a respawn can be deleted: it goes, the export says so and it is no longer picked', () => {
  open();
  const r = T.levelRespawns()[0];
  T.selection = { kind: 'gate', which: 'lrespawn', course: r.course };
  T.deleteSelection();
  assert.equal(respawn(r.course).g, null, 'it is gone');
  assert.equal(T.buildMap().groups[0].levelRespawns[r.course], null);
  assert.equal(gateAt(r.at.x, r.at.y), undefined, 'nothing to pick there any more');
});

await test('undo brings a deleted respawn back, and a moved one too', () => {
  open();
  const r = T.levelRespawns()[0];
  T.selection = { kind: 'gate', which: 'lrespawn', course: r.course };
  T.nudgeSelection(1, 0, false);
  T.selection = { kind: 'gate', which: 'lrespawn', course: r.course };
  T.deleteSelection();
  assert.equal(respawn(r.course).g, null);
  T.undo();
  assert.deepEqual([respawn(r.course).g.x, respawn(r.course).g.y], [r.at.x + 32, r.at.y], 'the moved respawn is back');
  T.undo();
  assert.deepEqual([respawn(r.course).g.x, respawn(r.course).g.y], [r.at.x, r.at.y], 'and the original one with it');
});

console.log(n + ' passed');
