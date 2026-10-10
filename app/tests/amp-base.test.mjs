// The Amplifier's base-game editing, headless: delete / move / edit each kind of level thing,
// save, reload, undo / redo, and unload / load the base game without losing the edits.
// node tests/amp-base.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- a stub browser: enough DOM for the editor's module to load and its state functions to run ----
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;

globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };
globalThis.fetch = async (url) => {
  const file = path.join(mapsDir, String(url).replace(/^\/maps\//, '').split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } };
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text, json: async () => JSON.parse(text) };
};

const { __test: T } = await import('../src/maps/editor.js');
await T.fetchBase();
const base = T.base;
assert.ok(base?.art && T.objects.length > 100, 'basemap loaded');

const fresh = (extra = {}) => { T.open({ name: 't', useBase: true, baseState: 'start', ...extra }); };
const blank = () => fresh();
const keyOf = T.key;
const centre = (k) => { const [cx, cy] = k.split(',').map(Number); const w = T.cellWorld(cx, cy); return { x: w.x + 16, y: w.y + 16 }; };
const reload = () => { const st = T.save(); T.open(JSON.parse(JSON.stringify(st))); return st; };

// A few real level cells to work with: a ground cell with air above, a spike, a vine.
const firstOf = (set, pred = () => true) => { for (const k of set) if (pred(k)) return k; };
const neighbours = (k) => { const [x, y] = k.split(',').map(Number); return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => keyOf(x + a, y + b)); };
const lonelyGround = () => firstOf(T.sets.ground, (k) => !T.sets.moss.has(k) && neighbours(k).every((m) => !T.sets.haz.has(m)));
const spikeK = () => [...T.sets.haz].find(([, h]) => h.kind === 'spike')[0];
const vineK = () => [...T.sets.haz].find(([, h]) => h.kind === 'vine')[0];
const selectCells = (what, k) => { T.selection = T.baseCellsAt(...k.split(',').map(Number)); assert.ok(T.selection, what + ' selectable at ' + k); return T.selection; };

await test('ground: select, delete, undo, redo, save and reload', () => {
  blank();
  const k = lonelyGround();
  selectCells('ground', k);
  assert.equal(T.selection.kind, 'basecells');
  T.pushUndo();
  T.deleteSelection();
  assert.ok(T.gone.removed.has(k));
  const st = reload();
  assert.ok(T.gone.removed.has(k), 'removal survives a reload');
  assert.ok(st.removed.includes(k));
  T.undo();
  assert.ok(!T.gone.removed.has(k), 'undo brings it back');
  T.redo();
  assert.ok(T.gone.removed.has(k), 'redo removes it again');
  const objs = T.buildMap().groups[0].objects;
  assert.ok(objs.some((o) => o.type === 'erase'), 'exports an erase');
});

await test('level cells move: lifted out of the level into your own, saved and reloaded', () => {
  blank();
  const k = lonelyGround();
  selectCells('ground', k);
  const cells = [...T.selection.cells];
  T.selection = { kind: 'basecells', cells: [k], what: 'Ground' };
  assert.ok(T.nudgeSelection(1, 0, false));
  const [x, y] = k.split(',').map(Number), nk = keyOf(x + 1, y);
  assert.ok(T.gone.removed.has(k), 'old cell erased');
  assert.equal(T.own.blocks.get(nk), 'ground', 'own copy one cell over');
  reload();
  assert.equal(T.own.blocks.get(nk), 'ground');
  assert.ok(T.gone.removed.has(k));
  T.undo();
  assert.ok(!T.gone.removed.has(k) && !T.own.blocks.has(nk), 'undo puts it back');
  assert.ok(cells.length >= 1);
});

await test('blue and orange blocks move as their own colour', () => {
  for (const [name, set] of [['blue', T.sets.blue], ['orange', T.sets.orange]]) {
    blank();
    const k = firstOf(set);
    assert.ok(k, name + ' blocks exist');
    T.selection = { kind: 'basecells', cells: [k], what: name };
    assert.ok(T.nudgeSelection(0, 1, false));
    const [x, y] = k.split(',').map(Number);
    assert.equal(T.own.blocks.get(keyOf(x, y + 1)), name);
    assert.ok(T.gone.removed.has(k));
  }
});

await test('moss is ground when it moves', () => {
  blank();
  const k = firstOf(T.sets.moss);
  T.selection = { kind: 'basecells', cells: [k], what: 'Moss' };
  assert.ok(T.nudgeSelection(1, 0, false));
  const [x, y] = k.split(',').map(Number);
  assert.equal(T.own.blocks.get(keyOf(x + 1, y)), 'ground');
});

await test('spikes: select, move (keeps direction), delete', () => {
  blank();
  const k = spikeK(), h = T.sets.haz.get(k);
  const sel = selectCells('spike', k);
  assert.equal(sel.what, 'Spike');
  assert.ok(T.nudgeSelection(1, 0, false));
  const [x, y] = k.split(',').map(Number);
  assert.equal(T.own.spikes.get(keyOf(x + 1, y)).q, h.q);
  assert.ok(T.gone.removed.has(k));
  T.undo();
  selectCells('spike', k);
  T.deleteSelection();
  assert.ok(T.gone.removed.has(k));
});

await test('vines: selectable, delete, move', () => {
  blank();
  const k = vineK();
  const sel = selectCells('vine', k);
  assert.equal(sel.vine, true);
  T.pushUndo();
  assert.ok(T.nudgeSelection(0, 1, false));
  const [x, y] = k.split(',').map(Number);
  assert.ok(T.gone.removedVines.has(k));
  assert.ok(T.own.vines.has(keyOf(x, y + 1)));
  T.undo();
  assert.ok(!T.gone.removedVines.has(k));
  selectCells('vine', k);
  T.deleteSelection();
  assert.ok(T.gone.removedVines.has(k));
  assert.equal(reload().removedVines.includes(k), true);
  assert.ok(T.gone.removedVines.has(k));
});

await test('decoration tiles: delete and move', () => {
  blank();
  let hit = null;
  outer: for (const o of base.art.layers.filter((l) => /nvironment/.test(l.name) && l.state !== 'overgrown')) {
    const g = { size: o.size, ox: o.ox, oy: o.oy };
    for (let i = 0; i < o.runs.length; i += 5) {
      const d = T.decoAt(g.ox + (o.runs[i + 1] + 0.5) * g.size, g.oy + (o.runs[i] + 0.5) * g.size);
      if (d) { hit = d; break outer; }
    }
  }
  assert.ok(hit, 'found decoration');
  T.selection = JSON.parse(JSON.stringify(hit));
  T.pushUndo();
  T.deleteSelection();
  const id = hit.layer + '|' + hit.cells[0];
  assert.ok(T.gone.removedDeco.has(id));
  assert.equal(reload().removedDeco.includes(id), true);
  T.undo();
  assert.ok(!T.gone.removedDeco.has(id));
  T.selection = JSON.parse(JSON.stringify(hit));
  assert.ok(T.nudgeSelection(1, 0, false));
  assert.ok(T.gone.removedDeco.has(id));
  assert.ok(T.own.tiles.size >= 1, 'became your own tiles');
});

await test('marquee region: delete and move take the level\'s cells with it', () => {
  blank();
  const k = lonelyGround(), [x, y] = k.split(',').map(Number);
  T.selection = { kind: 'region', x0: x, y0: y, x1: x, y1: y, cellsOnly: true };
  T.nudgeSelection(2, 0, false);
  assert.ok(T.gone.removed.has(k));
  assert.equal(T.own.blocks.get(keyOf(x + 2, y)), 'ground');
  T.undo();
  T.selection = { kind: 'region', x0: x, y0: y, x1: x, y1: y, cellsOnly: true };
  T.deleteSelection();
  assert.ok(T.gone.removed.has(k));
});

const upgradeBox = () => T.objects.find((o) => o.kind === 'upgrade' && o.box);

await test('level objects (upgrade boxes, doors, triggers): delete / move / edit, save, reload, undo', () => {
  blank();
  const kinds = new Set(T.objects.map((o) => o.kind));
  for (const kind of kinds) {
    blank();
    const o = T.objects.find((x) => x.kind === kind);
    T.selection = { kind: 'base', id: o.id };
    T.pushUndo();
    T.deleteSelection();
    assert.ok(T.gone.removedObjects.has(o.id), kind + ' deleted');
    assert.ok(T.buildMap().groups[0].objects.some((e) => e.type === 'hide' && e.path === o.path), kind + ' exports a hide');
    reload();
    assert.ok(T.gone.removedObjects.has(o.id), kind + ' removal reloads');
    T.undo();
    assert.ok(!T.gone.removedObjects.has(o.id));
    T.selection = { kind: 'base', id: o.id };
    assert.ok(T.nudgeSelection(1, 0, true));
    const d = T.gone.movedObjects.get(o.id);
    assert.ok(d && d[0] !== 0, kind + ' moved');
    assert.ok(T.buildMap().groups[0].objects.some((e) => e.type === 'move' && e.path === o.path), kind + ' exports a move');
    reload();
    assert.deepEqual(T.gone.movedObjects.get(o.id), d, kind + ' move reloads');
  }
  const box = upgradeBox();
  blank();
  T.editBaseUpgrade(box.id, 'price', '777');
  const mod = T.buildMap().groups[0].objects.find((e) => e.type === 'modify' && e.path === box.path);
  assert.equal(mod.upgrade.prices[0], 777);
  reload();
  assert.equal(T.gone.baseEdits[box.id].price, 777, 'upgrade edit reloads');
  T.undo();
  assert.ok(!T.gone.baseEdits[box.id]?.price || T.gone.baseEdits[box.id].price !== 777, 'edit undone');
});

await test('level scenery (sprites, plants, signs): delete / move, save, reload', () => {
  blank();
  const p = T.scene.items.find((x) => x.id && !x.group && x.reach < 400 && x.a !== 0);
  T.selection = { kind: 'scene', id: p.id };
  T.pushUndo();
  T.deleteSelection();
  assert.ok(T.gone.removedScene.has(p.id));
  reload();
  assert.ok(T.gone.removedScene.has(p.id));
  T.undo();
  T.selection = { kind: 'scene', id: p.id };
  assert.ok(T.nudgeSelection(0, 1, true));
  const d = T.gone.movedScene.get(p.id);
  assert.ok(d);
  reload();
  assert.deepEqual(T.gone.movedScene.get(p.id), d);
  assert.ok(T.buildMap().groups[0].objects.some((e) => e.type === 'move' && e.path === p.p));
});

await test('unload the base game: your content and the level edits are kept; load again re-applies them', () => {
  blank();
  const k = lonelyGround(), box = upgradeBox();
  T.selection = { kind: 'basecells', cells: [k], what: 'Ground' };
  T.deleteSelection();
  T.selection = { kind: 'base', id: box.id };
  T.deleteSelection();
  T.editBaseUpgrade(upgradeBox().id === box.id ? T.objects.filter((o) => o.box).find((o) => o.id !== box.id).id : box.id, 'price', '5');
  T.own.blocks.set('1000,1000', 'ground');
  const edits = T.baseEditCount();
  assert.ok(edits >= 3);
  T.setBaseOn(false);
  assert.equal(T.baseOn, false);
  const out = T.save();
  assert.equal(out.useBase, false, 'saves with the base unloaded');
  assert.ok(out.removed.includes(k) && out.removedObjects.includes(box.id), 'edits still in the file');
  // Editing your own content while it is unloaded.
  T.own.blocks.set('1001,1000', 'blue');
  const map = T.buildMap();
  assert.ok(!map.overlay, 'unloaded exports a map of your own');
  assert.ok(!map.groups[0].objects.some((e) => e.type === 'erase' || e.type === 'hide'), 'no level edits in a map without the level');
  // Reload from the file with it unloaded, then load it again.
  T.open(JSON.parse(JSON.stringify(T.save())));
  assert.equal(T.baseOn, false);
  assert.equal(T.baseEditCount(), edits, 'the edits survive a reload while unloaded');
  T.setBaseOn(true);
  assert.equal(T.baseOn, true);
  assert.ok(T.own.blocks.has('1000,1000') && T.own.blocks.has('1001,1000'), 'own content untouched');
  const objs = T.buildMap().groups[0].objects;
  assert.ok(objs.some((e) => e.type === 'erase'), 'the ground erase is back');
  assert.ok(objs.some((e) => e.type === 'hide' && e.path === box.path), 'the box removal is back');
  assert.ok(T.buildMap().overlay);
});

await test('art-fix: a failed image load retries and resolves, never a broken Image', async () => {
  const RealImage = globalThis.Image;
  globalThis.Image = class { constructor() { this.naturalWidth = 8; } set src(v) { this._s = v; setTimeout(() => (/[?&]r=/.test(v) ? this.onload?.() : this.onerror?.()), 0); } get src() { return this._s; } };
  const img = await T.loadImage('/maps/x-test.png', 3);
  assert.ok(img && img.naturalWidth, 'second try succeeded');
  assert.equal(T.assetLog.get('/maps/x-test.png').ok, true);
  globalThis.Image = class { set src(v) { setTimeout(() => this.onerror?.(), 0); } };
  assert.equal(await T.loadImage('/maps/y-test.png', 2), null, 'gives up with null');
  assert.equal(T.assetLog.get('/maps/y-test.png').ok, false);
  globalThis.Image = RealImage;
});

console.log(n + ' passed');
process.exit(0);
