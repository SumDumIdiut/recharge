// A3: the list of repo mods lives in one table, and the installer and the auto-updater read it
// from there. Two lists were the same concept in two shapes, and they already disagreed about
// Navigator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { REPO_MODS, REPO_MOD_IDS, BUILT_IN_MOD_IDS } from '../src/repo-mods.js';
import { pendingUpdates } from '../src/autoupdate.js';

const SRC = new URL('../src/', import.meta.url);

// Every source file the app ships, so a literal cannot hide in a file nobody thought to check.
function* sourceFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(js|html|css|json)$/.test(e.name)) yield p;
  }
}
const rel = (u) => u.href.split('/src/')[1];

test('the installer table and the update skip set are the same list', () => {
  assert.deepEqual([...REPO_MOD_IDS].sort(), Object.keys(REPO_MODS).sort());
  for (const id of Object.keys(REPO_MODS)) assert.ok(REPO_MOD_IDS.has(id), id);
});

test('every repo mod is skipped by the auto-updater', () => {
  for (const id of Object.keys(REPO_MODS)) {
    const catalog = [{ id: 'hub-' + id, modId: id, name: id, version: '9.0.0', revision: 5 }];
    const installed = [{ id, version: '1.0.0', hubId: 'hub-' + id, revision: 1 }];
    assert.deepEqual(pendingUpdates('mods', installed, catalog), [], id);
  }
});

test('Navigator is built in: never installed, never updated', () => {
  assert.equal(REPO_MODS['recharge.maps'].builtIn, true);
  assert.ok(BUILT_IN_MOD_IDS.has('recharge.maps'));
  const catalog = [{ id: 'h1', modId: 'recharge.maps', name: 'Navigator', version: '9.0.0', revision: 5 }];
  assert.deepEqual(pendingUpdates('mods', [{ id: 'recharge.maps', version: '1.0.0', hubId: 'h1', revision: 1 }], catalog), []);
});

test('a mod that is not a repo mod is still updated from the hub', () => {
  const catalog = [{ id: 'h1', modId: 'cool.mod', name: 'Cool', version: '1.1.0', revision: 2 }];
  assert.equal(pendingUpdates('mods', [{ id: 'cool.mod', version: '1.0.0', hubId: 'h1', revision: 1 }], catalog).length, 1);
});

test('a repo mod is written down in one module only', () => {
  // The whole point of the table: a new repo mod is one edit, not two.
  for (const id of Object.keys(REPO_MODS)) {
    const where = [...sourceFiles(SRC)].filter((f) => readFileSync(f, 'utf8').includes(id)).map(rel);
    assert.deepEqual(where, ['repo-mods.js'], `${id} also appears in ${where.join(', ')}`);
  }
});
