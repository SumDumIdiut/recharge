import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyStringify } from '../src/maps/prettyjson.js';

let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
function gen(depth) {
  const r = rnd();
  if (depth > 4 || r < 0.35) return pick([0, 1, -3, 2.5, 1e21, 'x', 'a"b\\c\nd', '', true, false, null, 'é€😀', NaN, Infinity, undefined, () => 1]);
  if (r < 0.65) { const n = Math.floor(rnd() * (depth < 2 ? 40 : 6)); return Array.from({ length: n }, () => gen(depth + 1)); }
  const o = {}; const n = Math.floor(rnd() * (depth < 2 ? 40 : 6));
  for (let i = 0; i < n; i++) o[pick(['k', '', '7', '12', 'a b', 'z', '__proto__x']) + i % 9 + (rnd() < 0.1 ? '' : 'q' + i)] = gen(depth + 1);
  if (rnd() < 0.2) o[String(Math.floor(rnd() * 50))] = gen(depth + 1);
  return o;
}

test('the pieced pretty JSON is byte for byte the engine\'s', async () => {
  for (let i = 0; i < 300; i++) {
    const v = gen(0), want = JSON.stringify(v, null, 2);
    for (const big of [3, 10, 2000]) assert.equal(await prettyStringify(v, { big, slice: 7, yieldNow: async () => {}, budgetMs: -1 }), want, 'case ' + i + ' big ' + big);
  }
});

test('shapes of a map: a big array deep inside small objects, a big object, empties, dropped values', async () => {
  const objects = Array.from({ length: 5000 }, (_, i) => ({ type: 'tile', cellX: i, cellY: -i, matrix: [1, 0, 0, 1], ...(i % 3 ? { group: 'g' } : {}) }));
  const blocks = {}; for (let i = 0; i < 4001; i++) blocks[i + ',' + (i % 7)] = i % 2 ? 'ground' : 'dark';
  const v = { uid: 'u', formatVersion: 1, images: [], customImages: [], levelOrigin: [1, 2], editor: { blocks, spikes: {}, placed: [], tiles: undefined, n: 1 }, groups: [{ gates: true, courses: [], objects }], tail: [objects.slice(0, 5)] };
  const want = JSON.stringify(v, null, 2);
  let yields = 0;
  const got = await prettyStringify(v, { budgetMs: -1, yieldNow: async () => { yields++; } });
  assert.equal(got, want);
  assert.ok(yields >= 4, 'the page is handed back between slices: ' + yields);
  assert.equal(await prettyStringify([]), '[]');
  assert.equal(await prettyStringify({}), '{}');
  assert.equal(await prettyStringify('s'), '"s"');
  assert.equal(await prettyStringify(undefined), undefined);
});
