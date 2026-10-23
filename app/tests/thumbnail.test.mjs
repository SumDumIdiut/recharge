// The map picture: what the thumbnail shows, and what makes it change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubStamp } from '../src/maps/mapthumb.js';

const editor = readFileSync(new URL('../src/maps/editor.js', import.meta.url), 'utf8');
const mapthumb = readFileSync(new URL('../src/maps/mapthumb.js', import.meta.url), 'utf8');
const maps = readFileSync(new URL('../src/maps/script.js', import.meta.url), 'utf8');
const account = readFileSync(new URL('../src/account/script.js', import.meta.url), 'utf8');
const news = readFileSync(new URL('../src/home-news.js', import.meta.url), 'utf8');

// ---- backgrounds in the drawn view ----

test('the map view draws the backdrop, not just a flat colour', () => {
  assert.match(editor, /drawBackground\(w, h, 1\)/);
  // It has to come before the tiles, or the backdrop paints over the map.
  assert.ok(editor.indexOf('drawBackground(w, h, 1)') < editor.indexOf('drawCellLayers(useArt'), 'backdrop must be drawn first');
});

test('the backdrop is drawn at full strength, not faded out by the zoom', () => {
  // The game fades backdrops away as you zoom out, and a whole-map view is about as far out
  // as it goes - passing the normal fade would have drawn nothing at all.
  assert.match(editor, /function drawBackground\(W, H, alpha = backdropFade\(\)\)/);
  assert.ok(!/const fade = backdropFade\(\);\s*if \(!fade\) return;/.test(editor), 'the default still fades, but the caller chooses');
});

test('the tile worker preloads the backdrop images', () => {
  // workerInit loads the atlas, scene atlas, fonts and vines - but not the scene's backdrops,
  // so the view had nothing to draw and the worker has no `Image` to fetch them with.
  assert.match(editor, /base\.scene\?\.backgrounds \|\| \[\]\)\.map\(\(b\) => b\.img\)/);
  assert.match(editor, /worldBackdrops \|\| \[\]\)\.map\(\(b\) => b\.img\)/);
  assert.match(editor, /bgImages\[src\] = backdropBitmaps\[n\]/);
});

test('a backdrop the worker could not load skips itself, not the whole backdrop', () => {
  assert.match(editor, /if \(IN_WORKER\) return DEAD_IMAGE;/);
  assert.match(editor, /DEAD_IMAGE = Object\.freeze\(\{ complete: false/);
});

// ---- the thumbnail changing when a map is updated ----

test('a new version uploads a fresh picture', () => {
  // The hub deliberately keeps a map's old picture when an update arrives without one, so
  // sending nothing froze the thumbnail at the version before the edit.
  assert.match(account, /const \{ mapViewFile \} = await import\('\.\.\/maps\/mapthumb\.js'\)/);
  assert.match(account, /gallery = \[await mapViewFile\(uploadFrom\)\]\.filter\(Boolean\)/);
  assert.match(account, /galleryPaths: gallery,/);
  assert.ok(!/galleryPaths: null/.test(account));
});

test('the hub picture cache moves when a map is updated', () => {
  // The stamp was built from createdAt, which never changes on an update - so the drawn view
  // of the first version was reused forever.
  assert.match(maps, /stamp: hubStamp\(`\$\{row\.updatedAt \|\| row\.createdAt\}\|\$\{row\.revision \|\| 1\}`\)/);
  assert.ok(!/stamp: hubStamp\(row\.createdAt\)/.test(maps));
  assert.match(mapthumb, /export const hubStamp = \(changed\) =>/);
});

test('the home news picture uses the same key, and the date is left alone', () => {
  assert.match(news, /stamp: `\$\{row\.updatedAt \|\| row\.createdAt\}\|\$\{row\.revision \|\| 1\}`/);
  assert.match(news, /hubStamp\(e\.stamp \|\| e\.when\)/);
  // `when` is shown as the news date; folding the revision into it would break ago().
  assert.match(news, /when: row\.createdAt,/);
});

test('two versions of the same map get different stamps', () => {
  const v1 = hubStamp('2026-01-01T00:00:00Z|1');
  const v2 = hubStamp('2026-01-02T00:00:00Z|2');
  assert.notEqual(v1, v2, 'an update must not reuse the old picture');
  assert.equal(hubStamp('x|1'), hubStamp('x|1'), 'but the same version must reuse it');
});
