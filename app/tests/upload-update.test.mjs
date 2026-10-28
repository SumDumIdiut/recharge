// The upload forms' "Update of" choice (upload-update.js): pre-selection by map id / mod id / skin name, and the select's options.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapIdentityCounts, uidIsShared, defaultUpdateTarget, updateOptionsHtml, fillUpdateSelect, chosenUpdate } from '../src/upload-update.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('maps: the same map id and name is pre-picked, a different map is a new upload', () => {
  const mine = [{ id: 'a', name: 'Clau v0.3A', mapUid: 'u1' }, { id: 'b', name: 'Other', mapUid: 'u2' }];
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'clau v0.3a' }), 'a', 'a genuine update still auto-matches');
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'Clau v0.3B' }), '', 'same id but another name (a copy) is new');
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
  const chosen = fillUpdateSelect(doc, 'maps', 'maps', mine, { mapUid: 'u1', name: 'A' }, esc);
  assert.equal(chosen, 'a');
  assert.equal(doc.els['maps-upload-updates-row'].hidden, false);
  assert.equal(chosenUpdate(doc, 'maps'), 'a', 'sent as updates');
  doc.els['maps-upload-updates'].value = '';
  assert.equal(chosenUpdate(doc, 'maps'), undefined, '"New upload" sends nothing');
});

test('maps: a copy that kept its source map id never defaults to updating the source', () => {
  const mine = [{ id: 'igtech-hub', name: 'igtech', mapUid: 'u1', revision: 6 }];
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'Cosmic Ocean', uidCount: 2 }), '');
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'igtech', uidCount: 2 }), '', 'two local folders share the id: ambiguous');
  assert.equal(defaultUpdateTarget('maps', mine, { mapUid: 'u1', name: 'igtech', uidCount: 1 }), 'igtech-hub');
});

test('maps: the folder installed as an upload keeps it; a copy of that folder (same hub.json) with another name does not', () => {
  const mine = [{ id: 'h1', name: 'igtech', mapUid: 'u1' }];
  assert.equal(defaultUpdateTarget('maps', mine, { hubId: 'h1', name: 'igtech', hubCount: 2 }), 'h1');
  assert.equal(defaultUpdateTarget('maps', mine, { hubId: 'h1', name: 'Cosmic Ocean', hubCount: 2 }), '');
  assert.equal(defaultUpdateTarget('maps', mine, { hubId: 'h1', name: 'renamed', hubCount: 1 }), 'h1', 'a renamed map that is the only one of its upload');
});

test('mapIdentityCounts / uidIsShared', () => {
  const inst = [{ id: 'igtech', uid: 'u1', hub: 'h1' }, { id: 'cosmic', uid: 'u1', hub: 'h1' }, { id: 'x', uid: 'u2' }];
  assert.deepEqual(mapIdentityCounts(inst, inst[1]), { uidCount: 2, hubCount: 2 });
  assert.deepEqual(mapIdentityCounts(inst, inst[2]), { uidCount: 1, hubCount: 0 });
  assert.equal(uidIsShared(inst, 'cosmic', 'u1'), true, 'a copy needs a fresh uid');
  assert.equal(uidIsShared(inst, 'x', 'u2'), false);
  assert.equal(uidIsShared(inst, null, undefined), false);
});

test('the editor gives a map sharing its id with another folder a fresh one', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/maps/editor.js', import.meta.url), 'utf8');
  assert.match(src, /uidIsShared\(.*draft\.savedId, draft\.mapUid\)\) draft\.mapUid = undefined/);
});

test('the card shows installed info per hub id (autoupdate.pendingUpdates)', async () => {
  const { pendingUpdates } = await import('../src/autoupdate.js');
  const installed = [{ id: 'igtech', uid: 'u1', hub: 'hI', revision: 6 }, { id: 'cosmic', uid: 'u1', hub: 'hC', revision: 7 }];
  const catalog = [{ id: 'hI', name: 'igtech', revision: 6 }, { id: 'hC', name: 'Cosmic Ocean', revision: 7 }];
  assert.deepEqual(pendingUpdates('maps', installed, catalog), [], 'same map id does not link folders to the wrong entry');
  assert.deepEqual(pendingUpdates('maps', installed, [{ id: 'hI', revision: 6 }, { id: 'hC', revision: 8, name: 'Cosmic Ocean' }]), [{ kind: 'maps', id: 'hC', name: 'Cosmic Ocean' }]);
});
