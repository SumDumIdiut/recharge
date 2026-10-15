// Amplifier memory guards (source-level: the editor needs a browser to run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/maps/editor.js', import.meta.url), 'utf8');

test('tile workers (~200 MB each) start only when the base game is on', () => {
  assert.match(src, /if \(draft\.useBase\) startTileWorkers\(\);/);
  assert.match(src, /if \(baseSettled && draft\.useBase\) startTileWorkers\(\);/);
  assert.match(src, /if \(!workersAsked && baseSettled && baseOn\(\)\)/);
});

test('closing the editor drops decoded pictures, text and undo history', () => {
  const body = src.slice(src.indexOf('function releaseEditorMemory'), src.indexOf('function syncChrome'));
  for (const part of ['atlasImg = null', 'sceneImg = null', 'delete bgImages[k]', 'fontImages.length = 0', 'delete vineImages[k]', 'textCache.clear()', 'undoStack = []', 'workersAsked = false']) {
    assert.ok(body.includes(part), part);
  }
});
