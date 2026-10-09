// Playlist editor logic + Browse has no selection bar.  node tests/playlist-editor.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDraft, draftFromPlaylist, addItems, removeItem, moveItem, editorSoundOptions, validateDraft, savePayload, summarizeImport, progressText, skippedText, pathsFrom, baseName } from '../src/backgrounds/editor.js';
import { cardAction } from '../src/backgrounds/media.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('add dedupes, remove, reorder', () => {
  const d = newDraft();
  assert.equal(addItems(d, ['a.png', 'b.mp4', 'a.png', 'c.mp3']), 3);
  assert.deepEqual(d.items, ['a.png', 'b.mp4', 'c.mp3']);
  assert.equal(moveItem(d, 0, 2), true);
  assert.deepEqual(d.items, ['b.mp4', 'c.mp3', 'a.png']);
  assert.equal(moveItem(d, 2, 99), false);
  assert.equal(moveItem(d, 2, -5), true);
  assert.deepEqual(d.items, ['a.png', 'b.mp4', 'c.mp3']);
  removeItem(d, 1);
  assert.deepEqual(d.items, ['a.png', 'c.mp3']);
  removeItem(d, 10);
  assert.equal(d.items.length, 2);
});

test('sound options only list songs in the playlist; removing the chosen song resets to auto', () => {
  const d = newDraft();
  addItems(d, ['a.png', 'song.mp3', 'other.ogg']);
  const vals = editorSoundOptions(d).map((o) => o[0]);
  assert.deepEqual(vals, ['auto', 'off', 'own', 'song.mp3', 'other.ogg']);
  d.sound = 'song.mp3';
  removeItem(d, 1);
  assert.equal(d.sound, 'auto');
});

test('validation and save payload', () => {
  const d = newDraft();
  assert.match(validateDraft(d), /name/);
  d.name = '  Chill  ';
  d.interval = '300';
  addItems(d, ['a.png', 'b.png']);
  assert.equal(validateDraft(d), null);
  assert.deepEqual(savePayload(d), { id: null, name: 'Chill', images: ['a.png', 'b.png'], interval: 300, sound: 'auto' });
  d.sound = 'gone.mp3';
  assert.equal(savePayload(d).sound, 'auto');
});

test('editing keeps the id and public id', () => {
  const d = draftFromPlaylist({ id: 'pl_1', name: 'X', images: ['a.png'], interval: 60, sound: 'own', public_id: 'pub' });
  assert.equal(savePayload(d).id, 'pl_1');
  assert.equal(d.publicId, 'pub');
  assert.equal(savePayload(d).sound, 'own');
  const old = draftFromPlaylist({ id: 'o', name: 'O', images: [] });
  assert.equal(old.sound, 'auto');
  assert.equal(old.interval, 0);
});

test('import summary, progress and skipped text', () => {
  const s = summarizeImport([
    { source: '/x/a.png', file_name: 'a-2.png' },
    { source: '/x/b.txt', error: 'unsupported type' },
    { source: 'C:\\x\\c.mp4', error: 'too big (max 90 MB for videos)' },
  ]);
  assert.deepEqual(s.added, ['a-2.png']);
  assert.equal(s.skipped.length, 2);
  assert.equal(s.skipped[1].name, 'c.mp4');
  assert.equal(progressText(11, 40), 'Adding 12 of 40...');
  assert.equal(progressText(40, 40), 'Adding 40 of 40...');
  const lines = skippedText(s.skipped, { unsupported: 3, truncated: true });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Skipped 2: b\.txt \(unsupported type\), c\.mp4/);
  assert.equal(baseName('a/b\\c.png'), 'c.png');
});

test('dialog results normalise', () => {
  assert.deepEqual(pathsFrom('/a'), ['/a']);
  assert.deepEqual(pathsFrom(['/a', { path: '/b' }]), ['/a', '/b']);
  assert.deepEqual(pathsFrom(null), []);
});

test('Browse: no selection bar, no click-to-select, share clicks intact', () => {
  const html = readFileSync(new URL('../src/backgrounds/view.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/backgrounds/script.js', import.meta.url), 'utf8');
  for (const needle of ['bg-selection', 'Save playlist', 'bg-selection-count']) assert.ok(!html.includes(needle), `view.html has ${needle}`);
  assert.ok(!/bg-selection|selected\.(add|has|delete)|bg-card-selected/.test(js));
  assert.ok(html.includes('bg-pl-new') && html.includes('+ New playlist'));
  assert.ok(html.includes('bg-upload-btn') && html.includes('bg-share-btn'));
  assert.equal(cardAction({ shareMode: false, shared: false, loggedIn: true }), 'none');
  assert.equal(cardAction({ shareMode: true, shared: false, loggedIn: true }), 'publish');
  assert.equal(cardAction({ shareMode: true, shared: true, loggedIn: true }), 'unpublish');
  assert.equal(cardAction({ shareMode: true, shared: false, loggedIn: false }), 'login');
});

console.log(`${n} passed`);
