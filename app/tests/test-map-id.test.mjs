// A10: the editor's test-launch slot is a map on disk with a fixed id, so every listing has to
// leave it out. The id is written down once; the listings ask for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { TEST_MAP_ID, isTestMap } from '../src/maps/test-map.js';

const SRC = new URL('../src/', import.meta.url);

function* sourceFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(js|html|css|json)$/.test(e.name)) yield p;
  }
}
const rel = (u) => u.href.split('/src/')[1];

test('the test slot is told apart from a real map', () => {
  assert.equal(isTestMap({ id: TEST_MAP_ID }), true);
  assert.equal(isTestMap({ id: 'my-map' }), false);
  assert.equal(isTestMap(null), false);
  assert.equal(isTestMap(undefined), false);
  assert.equal(isTestMap({}), false);
});

test('the id is written down in one module only', () => {
  const where = [...sourceFiles(SRC)].filter((f) => readFileSync(f, 'utf8').includes(TEST_MAP_ID)).map(rel);
  assert.deepEqual(where, ['maps/test-map.js'], `the id also appears in ${where.join(', ')}`);
});

test('every listing leaves the test slot out through isTestMap', () => {
  for (const f of ['maps/script.js', 'account/script.js', 'autoupdate.js', 'maps/editor.js']) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    assert.match(src, /isTestMap/, `${f} does not use the shared helper`);
    assert.ok(!src.includes(TEST_MAP_ID), `${f} still spells the id out`);
  }
});
