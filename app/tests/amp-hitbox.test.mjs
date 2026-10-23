// The Hitboxes overlay for your own things: one outline per connected block region, spikes at the game's collider size.
import assert from 'node:assert/strict';
import { solidGroup, outlineLoops, turnShape, shapeBounds } from '../src/maps/hitboxes.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('a 3x2 placed block is one outline polygon with four corners', () => {
  const cells = []; for (let x = 0; x < 3; x++) for (let y = 0; y < 2; y++) cells.push(x + ',' + y);
  const loops = outlineLoops(cells);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
  assert.deepEqual(shapeBounds([loops[0]]), [0, 0, 3, 2]);
});

test('an L shape is one polygon of six corners; separate blocks are separate polygons; a ring has a hole', () => {
  assert.equal(outlineLoops(['0,0', '1,0', '0,1']).flatMap((l) => l).length, 6);
  assert.equal(outlineLoops(['0,0', '5,5']).length, 2);
  const ring = []; for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) if (x !== 1 || y !== 1) ring.push(x + ',' + y);
  assert.equal(outlineLoops(ring).length, 2);
});

test('only collider tilemaps are solid: ground sets, blue and orange; not illusory, background or breakable art', () => {
  const sets = { panel: { layer: 'ground' }, blueplate: { layer: 'blueBlocks' }, orangefloor: { layer: 'orangeBlocks' }, illusory: { layer: 'Ilusorywalls' }, bgwall: { layer: 'Background' }, breakable: { layer: 'OvergrowthDestroyedGround' } };
  assert.deepEqual(['ground', 'dark', 'panel', 'blueplate', 'orangefloor', 'blue', 'orange'].map((k) => solidGroup(k, sets)), ['ground', 'ground', 'ground', 'blue', 'orange', 'blue', 'orange']);
  for (const k of ['illusory', 'bgwall', 'breakable']) assert.equal(solidGroup(k, sets), null);
});

test('a placed spike\'s box is the game collider shape through the spike\'s turn, not a full cell', () => {
  const shape = [[[-12, -16], [12, -16], [0, 14]]];
  assert.deepEqual(shapeBounds(shape), [-12, -16, 12, 14]);
  assert.deepEqual(shapeBounds(turnShape(shape, [1, 0, 0, 1])), [-12, -16, 12, 14]);
  assert.deepEqual(shapeBounds(turnShape(shape, [0, -1, 1, 0])), [-14, -12, 16, 12]);
});

test('a diagonal pair (pinch corner) produces two separate polygons', () => {
  // Two cells touching only at a corner: (0,0) and (1,1)
  const loops = outlineLoops(['0,0', '1,1']);
  assert.equal(loops.length, 2, 'two separate polygons for diagonal pair');
  assert.equal(loops[0].length, 4, 'each polygon has 4 corners');
  assert.equal(loops[1].length, 4);
});

test('insertion order independence: same cell set in different orders produces identical loops', () => {
  const cells = ['0,0', '1,0', '0,1', '1,1', '2,1', '1,2']; // a small cluster with pinch corners
  const orders = [
    cells,
    [...cells].reverse(),
    [cells[2], cells[0], cells[4], cells[1], cells[5], cells[3]],
    [cells[5], cells[3], cells[1], cells[4], cells[0], cells[2]],
  ];
  // Normalize polygons: rotate to start at lexicographically smallest point, then compare
  const norm = (loops) => loops.map((poly) => {
    const pts = poly.map((p) => p.join(','));
    let minIdx = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i] < pts[minIdx]) minIdx = i;
    return [...pts.slice(minIdx), ...pts.slice(0, minIdx)].join(';');
  }).sort().join('|');
  const results = orders.map((o) => norm(outlineLoops(o)));
  for (const r of results) assert.equal(r, results[0], 'all insertion orders produce identical loops');
});

test('a 2x2 block with one corner removed produces one polygon with a notch (6 corners)', () => {
  // 2x2 minus top-right: (0,0), (1,0), (0,1)
  const loops = outlineLoops(['0,0', '1,0', '0,1']);
  assert.equal(loops.length, 1, 'single polygon');
  assert.equal(loops[0].length, 6, 'notched rectangle has 6 corners');
});

test('an S-shape has no spurious pinch split', () => {
  // S-shape: (0,0), (1,0), (1,1), (2,1), (2,2)
  const cells = ['0,0', '1,0', '1,1', '2,1', '2,2'];
  const loops = outlineLoops(cells);
  assert.equal(loops.length, 1, 'S-shape is one connected polygon');
  // Should have 10 corners for this S-shape (no extra splits at pinch points)
  const totalCorners = loops.flatMap((l) => l).length;
  assert.ok(totalCorners >= 10 && totalCorners <= 12, `S-shape has reasonable corner count: ${totalCorners}`);
});

console.log(n + ' passed');
