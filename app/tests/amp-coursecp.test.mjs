// Course checkpoints: palette item, the "Belongs to" link (placed and level checkpoints) through export,
// and picking them (inside the box over art, the badge, the flag pin) without opening the palette popover.
// node tests/amp-coursecp.test.mjs
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
const objs = T.base.catalog.objects;
const iCourse = objs.findIndex((o) => o.name === 'Course checkpoint'), iPlain = objs.findIndex((o) => o.name === 'Checkpoint');
const open = (extra = {}) => T.open({ name: 't', useBase: true, baseState: 'start', ...extra });
const exported = () => (T.buildMap().groups?.[0]?.objects || T.buildMap().objects || []);
const place = (i, x, y, extra = {}) => ({ cat: 'objects', i, n: objs[i].name, x, y, ...extra });

await test('Course checkpoint is a placeable palette item next to Checkpoint', () => {
  assert.ok(iCourse >= 0 && iPlain >= 0);
  const names = T.paletteItems('gates').map((it) => it.label);
  assert.ok(names.includes('Course checkpoint') && names.includes('Checkpoint'), names.join(','));
});

await test('a placed course checkpoint and a plain checkpoint keep their course link through export', () => {
  open({ courses: [{ id: 'cA', start: null, end: null, reward: { currency: 'Cash', amount: 0 } }], placed: [place(iCourse, 100, 100, { course: 'cA' }), place(iPlain, 400, 100, { course: 'level:2' }), place(iCourse, 800, 100)] });
  const o = exported().filter((x) => x.courseCheckpoint || x.course);
  const cc = o.find((x) => x.courseCheckpoint && x.course === 'cA'), pl = o.find((x) => x.course === 'level:2');
  assert.ok(cc, 'course checkpoint linked to the user course');
  assert.ok(pl && !pl.courseCheckpoint, 'plain checkpoint linked to level course 2');
  assert.ok(o.some((x) => x.courseCheckpoint && !x.course), 'unlinked course checkpoint stays "any course"');
  const back = T.save();
  assert.equal(back.placed[0].course, 'cA');
});

await test('a level checkpoint\'s link is exported as a modify op, and removed again with Any course', () => {
  open();
  const cp = T.objects.find((o) => o.checkpoint && o.path);
  assert.ok(cp);
  T.selection = { kind: 'base', id: cp.id };
  T.setBaseCheckpointLink('level:1');
  const op = exported().find((x) => x.type === 'modify' && x.checkpoint);
  assert.deepEqual([op.course, op.x, op.y], ['level:1', cp.srcX ?? cp.x, cp.srcY ?? cp.y]);
  assert.equal(T.save().baseEdits[cp.id].course, 'level:1');
  T.setBaseCheckpointLink('');
  assert.ok(!exported().some((x) => x.type === 'modify' && x.checkpoint));
});

await test('clicking inside a placed course checkpoint, on its badge and on its flag pin selects it', () => {
  open({ placed: [place(iCourse, 5000, 5000)] });
  T.setScale(1);
  const item = objs[iCourse], b = item.box, cx = 5000 + (b[0] + b[2]) / 2, cy = 5000 + (b[1] + b[3]) / 2;
  const sel = (p) => T.itemsAt(p.x, p.y)[0];
  assert.deepEqual(sel({ x: cx, y: cy + 40 }), { kind: 'object', index: 0 }, 'inside the box');
  assert.deepEqual(sel({ x: cx + 5, y: 5000 + b[3] + 14 }), { kind: 'object', index: 0 }, 'badge');
  const f = T.checkpointFlag(0);
  assert.deepEqual(sel({ x: f.x + 4, y: f.y + 8 }), { kind: 'object', index: 0 }, 'flag pin');
});

await test('a level course checkpoint is picked inside its box, even over scenery art', () => {
  open();
  T.setScale(1);
  const cc = T.objects.find((o) => o.checkpoint && o.label === 'Course checkpoint') || T.objects.find((o) => o.checkpoint);
  const p = { x: cc.hitX ?? cc.x, y: cc.hitY ?? cc.y };
  const t = T.itemsAt(p.x, p.y).find((x) => x.kind === 'base' && x.id === cc.id);
  assert.ok(t, 'checkpoint among the hits at its box centre');
  const first = T.itemsAt(p.x, p.y)[0];
  const scenery = first?.kind === 'scene';
  assert.ok(!scenery, 'scenery art does not outrank the checkpoint');
  const badge = { x: (cc.hitX ?? cc.x) + 5, y: (cc.hitY ?? cc.y) + cc.h / 2 + 14 };
  assert.deepEqual(T.itemsAt(badge.x, badge.y)[0], { kind: 'base', id: cc.id }, 'badge');
});

await test('selecting on the canvas never opens the palette popover', () => {
  assert.equal(T.showInDropdownOpens?.(), false);
});
console.log(n + ' passed');
