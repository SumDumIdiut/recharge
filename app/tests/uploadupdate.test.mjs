// Updating an upload you already made. The hub has always supported it (an `updates` field
// naming the entry to replace, bumping its revision and keeping its comments), and the
// matching on the hub can even work it out from the map id on its own. What was missing was
// a way to *ask* for it from the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultUpdateTarget, updateOptionsHtml } from '../src/upload-update.js';

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const MINE = [
  { id: 'h1', name: 'Flip Sides', version: '1.0.0', revision: 1, mapUid: 'flip' },
  { id: 'h2', name: 'Renamed', version: '2.0.0', revision: 4, mapUid: 'other' },
];

test('a map with the same map id and name updates the upload that carried it; a differently named one is new', () => {
  assert.equal(defaultUpdateTarget('maps', MINE, { mapUid: 'flip', name: 'flip sides' }), 'h1');
  assert.equal(defaultUpdateTarget('maps', MINE, { mapUid: 'flip', name: 'Anything' }), '');
});

test('an id-less package only matches an upload that has no map id of its own', () => {
  // The map id is the strong signal: a package carrying one must not be matched to an upload
  // by name, or renaming a map would quietly rewrite the wrong entry.
  assert.equal(defaultUpdateTarget('maps', MINE, { name: '  rEnAmEd  ' }), '');
  assert.equal(defaultUpdateTarget('maps', [...MINE, { id: 'h3', name: 'Plain' }], { name: ' plain ' }), 'h3');
});

test('an unrelated map is a new upload, not an update of somebody else\'s', () => {
  assert.equal(defaultUpdateTarget('maps', MINE, { mapUid: 'unknown', name: 'Something else' }), '');
});

test('the choice can be forced to a named upload', () => {
  // What "Upload a new version" does: it does not ask the matcher, it says which one.
  const html = updateOptionsHtml(MINE, 'h2', escape);
  assert.match(html, /<option value="h2" selected>Renamed · v2\.0\.0 · update 4</);
  assert.match(html, /<option value="">New upload<\/option>/);
  assert.ok(html.includes('<option value="h1">Flip Sides · v1.0.0</option>'), html);
});

// The entry point itself: the Edit upload dialog, where the map is picked from a dropdown.
const account = readFileSync(new URL('../src/account/script.js', import.meta.url), 'utf8');
const accountView = readFileSync(new URL('../src/account/view.html', import.meta.url), 'utf8');
const maps = readFileSync(new URL('../src/maps/script.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/social/api.js', import.meta.url), 'utf8');

test('the edit dialog carries the map dropdown, for maps only', () => {
  assert.match(accountView, /id="account-edit-upload"/);
  assert.match(accountView, /id="account-edit-upload-row" hidden/);
  assert.match(account, /const isMap = row\.kind === 'map'/);
  assert.match(account, /wrap\.hidden = !isMap/);
  // A mod or a skin has no map folder to upload from, so it gets no dropdown.
  assert.match(account, /if \(!isMap\) \{[\s\S]{0,120}select\.innerHTML = '';\n    return;/);
});

test('the dropdown defaults to doing nothing, then lists the installed maps', () => {
  // "Just save the changes above" is first and is what Save means when nothing is picked.
  assert.match(account, /<option value="">Just save the changes above<\/option>\$\{opts\}/);
  // Every installed map is offered, because an upload is made from the map's folder on disk.
  assert.match(account, /invoke\('list_maps'\)/);
  // The editor's test-launch slot is not a map you would publish: it is filtered out by name.
  assert.match(account, /installed\.filter\(\(m\) => !isTestMap\(m\)\)/);
});

test('the copy that came from this upload is pre-selected', () => {
  assert.match(account, /const same = usable\.find\(\(m\) => m\.hub === row\.id \|\| m\.id === row\.id\)/);
  assert.match(account, /m === same \? ' selected'/);
});

test('it says so when there is no map installed to upload, or none that matches', () => {
  // Neither case may look like a working dropdown that silently does nothing.
  assert.match(account, /No maps are installed here/);
  assert.match(account, /Install it from Maps > Browse first/);
  assert.match(account, /None of the installed maps came from this upload/);
});

test('saving with a map picked uploads it as a new version of this same entry', () => {
  assert.match(account, /const uploadFrom = document\.getElementById\('account-edit-upload'\)\?\.value \|\| ''/);
  // updates: editingId is what makes it an update rather than a second upload.
  assert.match(account, /invoke\('submit_installed_map_cmd', \{/);
  assert.match(account, /updates: editingId,/);
  // The text in the fields goes up with it, so one Save does both.
  assert.match(account, /displayName: name,/);
  assert.match(account, /author,/);
  assert.match(account, /description,/);
});

test('saving with nothing picked only saves the text', () => {
  // The old behaviour has to survive untouched for the common case.
  // The request itself goes through the shared hub client (social/api.js).
  assert.match(account, /submissions\.patch\(editingId, \{ name, author, description \}\)/);
  assert.match(api, /patch: \(id, body, opts\) => hub\(`\/api\/submissions\/\$\{enc\(id\)\}`/);
  assert.match(api, /method: 'PATCH'/);
});

test('the button tells you which of the two it is doing', () => {
  assert.match(account, /saveBtn\.textContent = uploadFrom \? 'Uploading…' : 'Saving…'/);
  assert.match(account, /finally \{/);
  assert.match(account, /saveBtn\.disabled = false;/);
});

test('the old separate button and the helper it needed are gone', () => {
  // They were only there to open the other tab; the dropdown makes them dead weight.
  assert.ok(!/__acctUploadVersion/.test(account));
  assert.ok(!/__openTab/.test(account));
  assert.ok(!/__openTab/.test(readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')));
  assert.ok(!/__mapUploadNewVersion/.test(maps));
  assert.ok(!/ICON_UPLOAD/.test(readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8')));
});
