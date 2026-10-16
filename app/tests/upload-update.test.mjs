// The upload forms' "Update of" choice (upload-update.js): pre-selection by map id / mod id / skin name, and the select's options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultUpdateTarget, updateOptionsHtml, fillUpdateSelect, chosenUpdate } from '../src/upload-update.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('maps: the same map id is pre-picked, a different map is a new upload', () => {
  const mine = [{ id: 'a', name: 'Clau v0.3A', mapUid: 'u1' }, { id: 'b', name: 'Other', mapUid: 'u2' }];
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'Clau v0.3B' }), 'a');
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u3', name: 'Clau v0.3A' }), '');
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u3', hubId: 'b' }), 'b', 'the upload this map came from');
});

test('maps with no id yet: the upload it came from, else the same name', () => {
  const mine = [{ id: 'a', name: 'Legacy' }, { id: 'b', name: 'Withid', mapUid: 'u2' }];
  assert.equal(defaultUpdateTarget('maps', mine, { name: 'legacy' }), 'a');
  assert.equal(defaultUpdateTarget('maps', mine, { name: 'Withid' }), '', 'an upload that has an id is not matched by name');
  assert.equal(defaultUpdateTarget('maps', mine, { name: 'x', hubId: 'a' }), 'a');
});

test('mods by mod id, skins by name (case-insensitive)', () => {
  assert.equal(defaultUpdateTarget('mods', [{ id: 'm', modId: 'cool.mod' }], { modId: 'cool.mod' }), 'm');
  assert.equal(defaultUpdateTarget('mods', [{ id: 'm', modId: 'cool.mod' }], { modId: 'other' }), '');
  assert.equal(defaultUpdateTarget('mods', [{ id: 'm', modId: 'cool.mod' }], {}), '');
  assert.equal(defaultUpdateTarget('skins', [{ id: 's', name: 'Fancy' }], { name: ' fancy ' }), 's');
  assert.equal(defaultUpdateTarget('skins', [{ id: 's', name: 'Fancy' }], { name: '' }), '');
});

test('options: New upload first, the pre-picked one selected, text escaped', () => {
  const html = updateOptionsHtml([{ id: 'a', name: '<b>x</b>', version: '1.2.0', revision: 3 }], 'a', esc);
  assert.match(html, /^<option value="">New upload<\/option>/);
  assert.match(html, /<option value="a" selected>&lt;b&gt;x&lt;\/b&gt; · v1\.2\.0 · update 3<\/option>/);
  assert.ok(!updateOptionsHtml([{ id: 'a', name: 'x' }], '', esc).includes('selected><'), 'nothing but New upload selected');
});

function fakeDoc() {
  const els = { 'maps-upload-updates-row': { hidden: true }, 'maps-upload-updates': { innerHTML: '', value: '' } };
  return { getElementById: (id) => els[id] || null, els };
}

test('the form row shows only when the user has uploads of that kind, with the right one chosen', () => {
  const doc = fakeDoc();
  fillUpdateSelect(doc, 'maps', 'maps', [], { mapUid: 'u1' }, esc);
  assert.equal(doc.els['maps-upload-updates-row'].hidden, true);
  assert.equal(chosenUpdate(doc, 'maps'), undefined);
  const mine = [{ id: 'a', name: 'A', mapUid: 'u1' }];
  const chosen = fillUpdateSelect(doc, 'maps', 'maps', mine, { mapUid: 'u1' }, esc);
  assert.equal(chosen, 'a');
  assert.equal(doc.els['maps-upload-updates-row'].hidden, false);
  assert.equal(chosenUpdate(doc, 'maps'), 'a', 'sent as updates');
  doc.els['maps-upload-updates'].value = '';
  assert.equal(chosenUpdate(doc, 'maps'), undefined, '"New upload" sends nothing');
});
