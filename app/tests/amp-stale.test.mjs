// The picture cache: an edit's changed cells are drawn live over the chunk that still shows the old
// picture, and a chunk that stays stale too long is dropped (source-level: the editor needs a browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/maps/editor.js', import.meta.url), 'utf8');

test('an edit marks its chunk, and the changed cells are drawn live', () => {
  assert.match(src, /c\.stale = true; c\.edit = true; c\.at = now;/, 'the changed cells mark the chunk');
  assert.match(src, /function ccLive\(/, 'the live draw exists');
  assert.match(src, /drawCellLayers\(useArt, pad, CELL, \[x0, y0, x1, y1\]\)/, 'only the changed cells are drawn');
  assert.match(src, /function ccClearChanged\(/, 'the old picture is cleared where the cells changed');
});

test('an edit\'s chunk is built first, so the change shows in the same frame', () => {
  assert.match(src, /missing\.sort\(\(p, q\) => \(edited\.has/);
});

test('a chunk that stays stale too long is dropped', () => {
  assert.match(src, /const CC_STALE_MS = \d+;/, 'the bound is named');
  assert.match(src, /if \(c\.edit && c\.stale && now - \(c\.at \|\| 0\) > CC_STALE_MS\)/, 'and used');
});

test('a pan keeps the old picture: only an edit is drawn live', () => {
  assert.match(src, /for \(const c of cellCache\.chunks\.values\(\)\) \{ if \(!c\.stale\) c\.at = now; c\.stale = true; c\.full = true; c\.dirty = null; \}/);
});

test('a backlog of chunks waiting for their picture is said in the status bar', () => {
  assert.match(src, /ccBacklogNote\(missing\.length - built\)/, 'the chunks still to be built are counted');
  assert.match(src, /rebuilding the view/, 'and the status bar says the view is behind');
});
