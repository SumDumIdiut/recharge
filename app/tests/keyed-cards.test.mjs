import test from 'node:test';
import assert from 'node:assert/strict';
import { cardKey, reconcile } from '../src/ui.js';

const c = (key, html = key) => ({ key, html });

test('cardKey reads data-k from the root, else falls back to the position', () => {
  assert.equal(cardKey('<div class="browse-card" data-k="abc" onclick="x">'), 'abc');
  assert.equal(cardKey('<div>no key</div>', 3), '#3');
});

test('reconcile keeps unchanged cards, replaces changed ones, drops gone ones', () => {
  const prev = [c('a'), c('b', 'b1'), c('c')];
  const next = [c('c'), c('a'), c('b', 'b2'), c('d')];
  const { reuse, remove } = reconcile(prev, next);
  assert.deepEqual(reuse, [2, 0, -1, -1]);
  assert.deepEqual(remove, [1]); // old b is replaced by the new b2
});

test('reconcile with identical lists reuses everything and removes nothing', () => {
  const l = [c('a'), c('b')];
  assert.deepEqual(reconcile(l, [c('a'), c('b')]), { reuse: [0, 1], remove: [] });
});

test('reconcile never reuses one node twice', () => {
  const { reuse } = reconcile([c('a')], [c('a'), c('a')]);
  assert.deepEqual(reuse, [0, -1]);
});
