// Select tool hit order on the base-game map: what is under the cursor wins; trigger areas (checkpoints,
// course gates, long-fall zones, triggers) only by their badge or when nothing else is there.
// node tests/amp-select.test.mjs     (AMP_EDITOR=<path to another editor.js> to run the same probes on it)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
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

const { __test: T } = await import(process.env.AMP_EDITOR ? pathToFileURL(process.env.AMP_EDITOR).href : '../src/maps/editor.js');
await T.fetchBase();
const CUR = !process.env.AMP_EDITOR;
const open = (extra = {}) => T.open({ name: 't', useBase: true, baseState: 'start', ...extra });
const cen = (k) => { const [cx, cy] = k.split(',').map(Number); const w = T.cellWorld(cx, cy); return { x: w.x + 16, y: w.y + 16 }; };
const isArea = (o) => o.checkpoint || o.kind === 'trigger';
const visible = (o) => !o.checkpoint || !o.state || o.state === 'always' || o.state === 'start';
open();
const cps = () => T.objects.filter((o) => o.checkpoint && visible(o));
const inBox = (o, p) => Math.abs(p.x - (o.hitX ?? o.x)) <= o.w / 2 && Math.abs(p.y - (o.hitY ?? o.y)) <= o.h / 2;
const inAnyCp = (p) => cps().find((o) => inBox(o, p));
const showPick = (t) => (t ? (t.kind + (t.what ? ':' + t.what : '') + (t.id ? ':' + t.id.split('/').pop() : '')) : 'nothing');

// ---- the probes: [name, point, what the editor must select] ----
const rows = [];
const probe = (name, p, expect) => { const got = T.itemAt(p.x, p.y); rows.push({ name, got: showPick(got), want: expect ? showPick(expect) : '-' }); return got; };
const groundIn = [...T.sets.ground].map(cen).find((p) => inAnyCp(p));
const spikeIn = [...T.sets.haz].filter(([, h]) => h.kind === 'spike').map(([k]) => cen(k)).find((p) => inAnyCp(p));
const lone = [...T.sets.ground].filter((k) => !T.sets.moss.has(k)).map(cen).find((p) => !inAnyCp(p) && !T.objects.some((o) => isArea(o) && inBox(o, p)));
const spikeOut = [...T.sets.haz].filter(([, h]) => h.kind === 'spike').map(([k]) => cen(k)).find((p) => !inAnyCp(p));
const vine = [...T.sets.haz].filter(([, h]) => h.kind === 'vine').map(([k]) => cen(k))[0];
const upgrade = T.objects.find((o) => o.kind === 'upgrade'), tele = T.objects.find((o) => o.kind === 'teleporter');
const longFall = T.objects.find((o) => o.label === 'Long fall start');
const pt = (o) => ({ x: o.hitX ?? o.x, y: o.hitY ?? o.y });

const results = {};
const t1 = probe('base block', lone); results.block = t1;
results.spike = probe('base spike', spikeOut);
results.vine = probe('base vine', vine);
results.upgrade = probe('upgrade box', pt(upgrade));
results.tele = probe('teleporter', pt(tele));
if (CUR) {
  assert.ok(groundIn && spikeIn, 'level has ground and a spike inside a checkpoint box');
  results.groundInCp = probe('block inside a checkpoint box', groundIn);
  results.spikeInCp = probe('spike inside a checkpoint box', spikeIn);
} else {
  results.groundInCp = probe('block in a checkpoint box (4.0.1: no checkpoints)', groundIn || lone);
}
let deco, sprite;
for (const it of T.scene.items.slice(0, 600)) { if (sprite) break; if (!it.id || it.group || it.a === 0) continue; const q = { x: it.x, y: it.y }; if (!inAnyCp(q) && T.itemAt(q.x, q.y)?.id === it.id) sprite = q; }
let si = 0;
for (const k of T.sets.ground) { if (deco || ++si % 11) continue; const p = cen(k); for (const dy of [96, -96, 192, -192, 288, -288]) { const q = { x: p.x, y: p.y + dy }; if (!inAnyCp(q) && T.decoAt(q.x, q.y) && T.itemAt(q.x, q.y)?.kind === 'decotiles') { deco = q; break; } } }
if (deco) results.deco = probe('decoration tile', deco);
if (sprite) results.sprite = probe('level sprite', sprite);

// your own placed things
const own = { x: lone.x + 4000, y: lone.y + 4000 };
const oc = T.cellOf(own.x, own.y), ow = T.cellWorld(oc.cx, oc.cy);
const k0 = `${oc.cx},${oc.cy}`, k1 = `${oc.cx + 2},${oc.cy}`;
open({ blocks: { [k0]: 'ground' }, spikes: { [k1]: { q: 0, c: 'spike' } }, signs: [{ x: own.x, y: own.y + 400, w: 96, h: 64, text: 'hi' }] });
results.ownBlock = probe('your block', cen(k0));
results.ownSpike = probe('your spike', cen(k1));
results.ownSign = probe('your sign', { x: own.x, y: own.y + 400 });

// a checkpoint: inside its box over nothing, and its badge
open();
const cp = cps().find((o) => { const p = pt(o); return T.itemAt(p.x, p.y) === null || T.itemAt(p.x, p.y)?.kind === 'base'; }) || cps()[0];
if (CUR) {
  const c = pt(cp);
  const emptySpot = [[0, 0], [60, 60], [-60, 60], [60, -60], [-60, -60], [0, 100], [0, -100]].map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy })).filter((p) => inBox(cp, p)).find((p) => T.itemAt(p.x, p.y)?.id === cp.id);
  results.cpEmpty = probe('empty spot in a checkpoint box', emptySpot || c);
  const badge = { x: c.x, y: c.y + cp.h / 2 + 14 / 0.75 };
  results.cpBadge = probe('checkpoint badge', badge);
  rows.at(-1).want = 'base:' + cp.id.split('/').pop();
  results.cp = cp; results.badge = badge; results.emptySpot = emptySpot;
}
if (!CUR) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }

// ================= assertions (current editor) =================
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
test('block, spike, vine select as themselves', () => {
  assert.equal(results.block.kind, 'basecells'); assert.equal(results.block.what, 'Ground');
  assert.equal(results.spike.kind, 'basecells'); assert.equal(results.spike.what, 'Spike');
  assert.equal(results.vine.kind, 'basecells'); assert.equal(results.vine.what, 'Vine');
});
test('upgrade box and teleporter select as themselves', () => {
  assert.deepEqual(results.upgrade, { kind: 'base', id: upgrade.id });
  assert.deepEqual(results.tele, { kind: 'base', id: tele.id });
});
test('block / spike inside a checkpoint box win over the checkpoint', () => {
  assert.equal(results.groundInCp.kind, 'basecells');
  assert.equal(results.spikeInCp.kind, 'basecells'); assert.equal(results.spikeInCp.what, 'Spike');
});
test('decoration tiles and level sprites are selectable', () => {
  assert.ok(deco || sprite, 'found a decoration tile or sprite');
  if (deco) assert.equal(results.deco.kind, 'decotiles');
  if (sprite) assert.equal(results.sprite.kind, 'scene');
});
test('your own blocks, spikes, signs select', () => {
  assert.equal(results.ownBlock.kind, 'blocks'); assert.equal(results.ownSpike.kind, 'cell'); assert.equal(results.ownSign.kind, 'sign');
});
test('a checkpoint is selected by its badge, and by its box where nothing else is', () => {
  assert.deepEqual(results.cpBadge, { kind: 'base', id: results.cp.id });
  assert.equal(T.checkpointHitAt(results.badge.x, results.badge.y), results.cp.id);
  if (results.emptySpot) assert.deepEqual(results.cpEmpty, { kind: 'base', id: results.cp.id });
});
test('the badge wins even over a block under it; Select then selects the checkpoint', () => {
  const b = results.badge;
  T.setTool('select'); T.selection = null;
  assert.equal(T.selectCanvasTargetAt(b.x, b.y), true);
  assert.deepEqual(T.selection, { kind: 'base', id: results.cp.id });
});
test('clicking a block inside a checkpoint box selects the block, not the checkpoint', () => {
  T.selection = null; T.setTool('select');
  T.selectCheckpointAt(groundIn.x, groundIn.y);
  assert.equal(T.selection, null, 'checkpoint did not grab the click');
  assert.equal(T.clickSelectsAt(groundIn.x, groundIn.y), true);
  assert.equal(T.itemAt(groundIn.x, groundIn.y).kind, 'basecells');
});
test('painting tools only take a checkpoint by its badge', () => {
  const c = pt(results.cp); T.selection = null;
  T.setTool('ground');
  assert.equal(T.selectCheckpointAt(c.x, c.y), false, 'inside the box: paint');
  assert.equal(T.selectCheckpointAt(results.badge.x, results.badge.y), true, 'badge: select');
  T.setTool('select');
});
test('trigger areas (long-fall zone) lose to anything under them, win in empty space', () => {
  open();
  const lf = longFall, c = pt(lf);
  const hits = [];
  for (let dx = -lf.w / 2 + 8; dx < lf.w / 2; dx += 32) for (let dy = -lf.h / 2 + 8; dy < lf.h / 2; dy += 32) { const g = T.itemAt(c.x + dx, c.y + dy); hits.push(g?.kind === 'base' && g.id === lf.id ? 'zone' : g ? 'other' : 'none'); }
  assert.ok(!hits.includes('none') || true);
  assert.ok(hits.includes('zone') || hits.includes('other'));
  for (let dx = -lf.w / 2 + 8; dx < lf.w / 2; dx += 32) for (let dy = -lf.h / 2 + 8; dy < lf.h / 2; dy += 32) {
    const p = { x: c.x + dx, y: c.y + dy }, g = T.itemAt(p.x, p.y);
    if (g?.kind === 'base' && g.id === lf.id) {
      const cell = T.cellOf(p.x, p.y), k = `${cell.cx},${cell.cy}`;
      assert.ok(!T.sets.ground.has(k) && !T.sets.haz.has(k), 'zone only where no block / spike is');
    }
  }
});
test('hover and erase use the same order', () => {
  open();
  const gk = [...T.sets.ground].find((k) => inAnyCp(cen(k))), p = cen(gk), c = T.cellOf(p.x, p.y);
  T.setTool('erase');
  const before = T.gone.removedObjects.size;
  T.eraseAt(c.cx, c.cy);
  assert.equal(T.gone.removedObjects.size, before, 'erasing a block inside a checkpoint box does not delete the checkpoint');
  assert.ok(T.gone.removed.has(gk), 'the block went');
  T.setTool('select');
});
test('your own trigger zone: block wins, empty air selects it', () => {
  const g = lone, spot = (() => { for (let r = 32; r <= 192; r += 32) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (T.itemAt(g.x + dx, g.y + dy) === null) return { x: g.x + dx, y: g.y + dy }; })();
  open({ triggers: [{ kind: 'swapBlocks', x: (spot.x + g.x) / 2, y: (spot.y + g.y) / 2, w: 640, h: 640 }] });
  assert.equal(T.itemAt(g.x, g.y).kind, 'basecells');
  assert.deepEqual(T.itemAt(spot.x, spot.y), { kind: 'mtrig', index: 0 });
});
test('marquee: cells and objects inside; a checkpoint only when its whole box is inside', () => {
  open();
  const c = pt(results.cp), cell = (x, y) => T.cellOf(x, y);
  const a = cell(c.x - results.cp.w / 2, c.y - results.cp.h / 2), b = cell(c.x + results.cp.w / 2, c.y + results.cp.h / 2);
  const full = T.marqueeTargets({ x0: Math.min(a.cx, b.cx) - 1, x1: Math.max(a.cx, b.cx) + 1, y0: Math.min(a.cy, b.cy) - 1, y1: Math.max(a.cy, b.cy) + 1 });
  assert.ok(full.some((t) => t.kind === 'base' && t.id === results.cp.id), 'fully enclosed checkpoint is in');
  const mid = cell(c.x, c.y);
  const part = T.marqueeTargets({ x0: mid.cx - 1, x1: mid.cx + 1, y0: mid.cy - 1, y1: mid.cy + 1 });
  assert.ok(!part.some((t) => t.kind === 'base' && t.id === results.cp.id), 'a small marquee inside the box does not take the checkpoint');
  assert.ok(part.some((t) => t.kind === 'region'), 'but still selects the cells');
});

test('level checkpoint matches a placed one: same badge rule, box outline, move, delete', () => {
  open();
  T.setScale(0.75);
  const cp = results.cp, c = pt(cp);
  assert.equal(T.checkpointHitAt(results.badge.x, results.badge.y), cp.id, 'badge at box top-left, like a placed checkpoint');
  assert.equal(T.areaBadgeAt(cp.id).text, cp.label.toUpperCase());
  assert.equal(T.areaHitsAt(c.x, c.y + cp.h / 2 + 14 / 0.75, true).some((t) => t.kind === 'base' && t.id === cp.id), true);
  const noPath = T.objects.find((o) => o.checkpoint && !o.path);
  assert.ok(noPath, 'a pathless level checkpoint exists (cannot be moved in the game)');
});
test('level zones carry named badges that select their zone; hidden zoomed out like checkpoint badges', () => {
  open();
  T.setScale(0.75);
  const names = { longFallColliderController: null, TutorialTextTrigger: 'TEXT TRIGGER', EndCreditsTrigger: 'END CREDITS', FakeCreditsControlScript: 'FAKE CREDITS', tripBreakerScript: 'TRIP BREAKER', SceneTransitionObject: 'SCENE CHANGE' };
  const zones = T.objects.filter((o) => o.kind === 'trigger');
  assert.ok(zones.length >= 10, 'zones: ' + zones.length + ' ' + [...new Set(zones.map((z) => z.cls))]);
  for (const z of zones) {
    const b = T.areaBadgeAt(z.id);
    assert.ok(b && b.text, 'zone has a label: ' + z.cls);
    if (names[z.cls]) assert.ok(b.text.startsWith(names[z.cls]), z.cls + ' -> ' + b.text);
    else assert.equal(b.text, z.label.toUpperCase());
    const at = { x: z.hitX ?? z.x, y: (z.hitY ?? z.y) + z.h / 2 + 14 / 0.75 };
    assert.ok(T.areaHitsAt(at.x, at.y, true).some((t) => t.kind === 'base' && t.id === z.id), 'badge hit: ' + z.cls);
    assert.deepEqual(T.itemAt(at.x, at.y), { kind: 'base', id: T.itemAt(at.x, at.y).id }, 'selects a base thing');
  }
  const one = zones.find((z) => z.cls === 'TutorialTextTrigger');
  assert.deepEqual(T.itemAt(one.x, one.y + one.h / 2 + 14 / 0.75).id, one.id);
  T.setScale(0.1);
  assert.equal(T.areaBadgeAt(one.id).text, '', 'icon only between 0.05 and 0.2');
  T.setScale(0.04);
  assert.equal(T.areaBadgeAt(one.id), null, 'hidden zoomed far out');
  assert.equal(T.areaBadgeAt(T.objects.find((o) => o.checkpoint).id), null, 'checkpoint badge hides at the same zoom');
  T.setScale(0.75);
});
test('a click inside a checkpoint / zone box over background art selects the area; foreground still wins', () => {
  open();
  T.setScale(0.75);
  const areas = T.objects.filter((o) => (o.checkpoint || o.kind === 'trigger') && visible(o));
  let found = 0, fg = 0;
  for (const o of areas) {
    for (let dx = -o.w / 2 + 8; dx < o.w / 2; dx += 20) for (let dy = -o.h / 2 + 8; dy < o.h / 2; dy += 20) {
      const p = { x: (o.hitX ?? o.x) + dx, y: (o.hitY ?? o.y) + dy };
      const bgDeco = T.decoAt(p.x, p.y), c = T.cellOf(p.x, p.y), k = `${c.cx},${c.cy}`;
      if (T.sets.ground.has(k) || T.sets.moss.has(k) || T.sets.haz.has(k)) continue;
      const list = T.itemsAt(p.x, p.y), got = T.itemAt(p.x, p.y);
      const smallest = T.areaHitsAt(p.x, p.y, false)[0];
      if (!list.some((t) => t.kind === 'decotiles' || (t.kind === 'scene' && T.isBackgroundScene(T.scene.items.find((i) => i.id === t.id))))) continue;
      if (got && (got.kind === 'base' && T.objects.find((x) => x.id === got.id && !x.checkpoint && x.kind !== 'trigger'))) { fg++; continue; }
      if (got && got.kind !== 'base' && got.kind !== 'basecells' && got.kind !== 'scene' && got.kind !== 'decotiles') continue;
      if (got?.kind === 'basecells' || (got?.kind === 'scene' && !T.isBackgroundScene(T.scene.items.find((i) => i.id === got.id)))) { fg++; continue; }
      assert.ok(smallest, 'an area is under the point');
      if (!T.areaHitsAt(p.x, p.y, false).some((t) => t.kind === 'base' && t.id === got.id)) { fg++; continue; } // another checkpoint's flag art
      assert.ok(got.kind === 'base' && T.areaHitsAt(p.x, p.y, false).some((t) => t.kind === 'base' && t.id === got.id), `background art does not beat the area at ${p.x},${p.y} (${bgDeco ? 'deco' : 'scene'}) got ${JSON.stringify(got)} vs ${JSON.stringify(smallest)}`);
      found++;
    }
  }
  assert.ok(found > 20, 'background art inside area boxes found: ' + found);
  // a block inside a checkpoint box still wins
  assert.equal(T.itemAt(groundIn.x, groundIn.y).kind, 'basecells');
});
test('with nothing else under it, background art is still selectable', () => {
  open();
  const free = T.scene.items.find((it) => it.id && !it.group && it.a !== 0 && T.isBackgroundScene(it) && T.areaHitsAt(it.x, it.y, false).length === 0 && T.itemAt(it.x, it.y)?.id === it.id);
  const deco2 = (() => { for (const k of T.sets.ground) for (const dy of [96, -96, 192, -192]) { const q = cen(k); q.y += dy; if (T.decoAt(q.x, q.y) && !T.areaHitsAt(q.x, q.y, false).length && T.itemAt(q.x, q.y)?.kind === 'decotiles') return q; } })();
  assert.ok(free || deco2, 'free background art is selectable');
});
test('every zone kind has a label, with the same zoom rules', () => {
  open();
  T.setScale(0.75);
  const z = T.stageZone();
  assert.ok(z.cells > 0 && z.anchors.length > 0, 'the orange dashed overgrowth area is found');
  assert.match(z.badge.text, /^OVERGROWTH AREA/);
  const start = z.badge.color;
  open({ baseState: 'overgrown' });
  assert.notEqual(T.stageZone().badge.color, start, 'green outline in the overgrown state has its own label');
  assert.match(T.stageZone().badge.text, /OVERGROWN STATE$/);
  open();
  const kinds = new Set(T.objects.filter((o) => o.checkpoint || o.kind === 'trigger').map((o) => o.cls || 'checkpoint'));
  for (const o of T.objects.filter((o) => (o.checkpoint || o.kind === 'trigger') && visible(o))) assert.ok(T.areaBadgeAt(o.id)?.text, 'label: ' + o.id);
  assert.ok(kinds.size >= 3);
});
console.log(n + ' passed');
