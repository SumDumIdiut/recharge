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
console.log(n + ' passed');
