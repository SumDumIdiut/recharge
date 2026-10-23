// A4: window.__modInstall is called from rendered markup, so its argument is a hint, not a fact.
// The catalog is a cache that can be replaced between rendering a row and clicking it, and the
// hub's shape is not ours to trust.
import test from 'node:test';
import assert from 'node:assert/strict';

const alerts = [];
const toasts = [];

function stubBrowser() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, textContent: '', innerHTML: '', hidden: true, value: '', disabled: false,
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {}, addEventListener() {}, remove() {}, setAttribute() {}, focus() {},
        querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return els.get(id);
  };
  globalThis.window = {
    addEventListener() {}, location: { href: '' }, navigate() {},
    __TAURI__: { core: { invoke: async () => [] } },
    __showToast: (html) => toasts.push(String(html)),
  };
  globalThis.document = {
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: (id) => el(id), createElement: el, body: el('body'),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.alert = (msg) => alerts.push(String(msg));
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  return el;
}

const el = stubBrowser();
const mods = await import('../src/mods/script.js');

const button = () => ({ disabled: false, textContent: 'Install', classList: { contains: () => false } });

test('an id that is no longer in the catalog says so and does not throw', async () => {
  mods.__test.setCatalog([{ id: 'h1', modId: 'cool.mod', name: 'Cool' }]);
  const btn = button();
  btn.disabled = true;
  await window.__modInstall('gone', btn);
  assert.equal(toasts.length, 1, 'the person is told');
  assert.match(toasts[0], /no longer in the catalog/i);
  assert.equal(btn.disabled, false, 'the button is clickable again');
  assert.equal(alerts.length, 0, 'no raw alert');
});

test('a dependencies field that is not a list is ignored, not spread', () => {
  mods.__test.setCatalog([{ id: 'h1', modId: 'cool.mod', name: 'Cool', dependencies: 'h2' }]);
  const res = mods.__test.resolveMissingDependencies({ id: 'h2', name: 'Two', dependencies: 'h1' });
  assert.deepEqual(res, { missing: [], unavailable: [] });
});

test('a dependency cycle still terminates', () => {
  mods.__test.setCatalog([
    { id: 'a', modId: 'a.mod', name: 'A', dependencies: ['b'] },
    { id: 'b', modId: 'b.mod', name: 'B', dependencies: ['a'] },
  ]);
  const res = mods.__test.resolveMissingDependencies({ id: 'a', name: 'A', dependencies: ['b'] });
  assert.deepEqual(res.missing.map((m) => m.id), ['b']);
  assert.deepEqual(res.unavailable, []);
});

test('a dependency that is not in the catalog opens the "Can\'t Install" modal', async () => {
  mods.__test.setCatalog([{ id: 'a', modId: 'a.mod', name: 'A', dependencies: ['gone'] }]);
  await window.__modInstall('a');
  assert.equal(el('mods-dep-title').textContent, "Can't Install");
  assert.equal(el('mods-dep-overlay').hidden, false);
});

test('a mod that needs another one says which, and installs both', async () => {
  mods.__test.setInstalled([]);
  mods.__test.setCatalog([
    { id: 'a', modId: 'a.mod', name: 'A', dependencies: ['b'] },
    { id: 'b', modId: 'b.mod', name: 'B', dependencies: [] },
  ]);
  await window.__modInstall('a');
  assert.equal(el('mods-dep-title').textContent, 'Additional Mods Required');
  assert.match(el('mods-dep-body').innerHTML, /B/);
});

test('a failed install leaves the button clickable', async () => {
  const calls = [];
  globalThis.window.__TAURI__.core.invoke = async (cmd) => { calls.push(cmd); throw new Error('boom'); };
  mods.__test.setCatalog([{ id: 'a', modId: 'a.mod', name: 'A', dependencies: [] }]);
  const btn = button();
  await window.__modInstall('a', btn);
  await new Promise((r) => setTimeout(r, 20)); // the install runs on, past the click
  assert.deepEqual(calls, ['install_from_hub_cmd']);
  assert.equal(btn.disabled, false);
  assert.equal(alerts.length, 1, 'the failure is reported');
});
