// Opening the Amplifier from a downloaded copy, with fallback to the built-in one.
// node tests/amp-loader.test.mjs
import assert from 'node:assert/strict';
import { openAmplifier } from '../src/amp-loader.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function harness({ status, mods, statusThrows }) {
  const calls = [];
  const styles = [];
  const root = { innerHTML: 'x', replaceChildren() { this.innerHTML = ''; } };
  const deps = {
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'amp_status') { if (statusThrows) throw new Error('unknown command'); return status; }
      return null;
    },
    importModule: async (url) => { calls.push(['import', url]); const m = mods[url]; if (m instanceof Error) throw m; if (!m) throw new Error('404 ' + url); return m; },
    addStyle: (href) => { styles.push(href); return () => styles.splice(styles.indexOf(href), 1); },
    warn: () => {},
  };
  return { deps, calls, styles, root };
}
const good = (tag) => ({ tag, mountEditor: async (r) => { r.innerHTML = tag; } });
const URL_ = 'http://127.0.0.1:39286/amp-5/';

await test('no downloaded copy: opens the built-in editor', async () => {
  const h = harness({ status: { active: false, url: null }, mods: { '/maps/editor.js': good('builtin') } });
  const r = await openAmplifier(h.root, h.deps);
  assert.deepEqual([r.version, r.fallback, h.root.innerHTML], [null, false, 'builtin']);
  assert.deepEqual(h.calls.map((c) => c[0]), ['amp_status', 'import']);
});

await test('an app without amp_status falls back to built-in', async () => {
  const h = harness({ statusThrows: true, mods: { '/maps/editor.js': good('builtin') } });
  assert.equal((await openAmplifier(h.root, h.deps)).fallback, false);
  assert.equal(h.root.innerHTML, 'builtin');
});

await test('an active downloaded copy is imported from its url, with its stylesheet', async () => {
  const h = harness({ status: { active: true, url: URL_, version: 'amp-5' }, mods: { [URL_ + 'editor.js']: good('amp5') } });
  const r = await openAmplifier(h.root, h.deps);
  assert.deepEqual([r.version, r.fallback, h.root.innerHTML], ['amp-5', false, 'amp5']);
  assert.deepEqual(h.styles, [URL_ + 'style.css']);
  assert.ok(!h.calls.some((c) => c[0] === 'amp_mark_bad'));
});

await test('an import failure marks the version bad and opens the built-in editor', async () => {
  const h = harness({ status: { active: true, url: URL_, version: 'amp-5' }, mods: { [URL_ + 'editor.js']: new Error('SyntaxError'), '/maps/editor.js': good('builtin') } });
  const r = await openAmplifier(h.root, h.deps);
  assert.deepEqual([r.version, r.fallback, h.root.innerHTML], [null, true, 'builtin']);
  assert.deepEqual(h.calls.find((c) => c[0] === 'amp_mark_bad'), ['amp_mark_bad', { version: 'amp-5' }]);
  assert.deepEqual(h.styles, [], 'downloaded stylesheet removed');
});

await test('a mount failure also falls back, clearing the half-built page', async () => {
  const broken = { mountEditor: async (r) => { r.innerHTML = 'half'; throw new Error('boom'); } };
  const h = harness({ status: { active: true, url: URL_, version: 'amp-5' }, mods: { [URL_ + 'editor.js']: broken, '/maps/editor.js': good('builtin') } });
  const r = await openAmplifier(h.root, h.deps);
  assert.deepEqual([r.fallback, h.root.innerHTML], [true, 'builtin']);
  assert.ok(h.calls.some((c) => c[0] === 'amp_mark_bad'));
});

await test('a failing amp_mark_bad does not stop the fallback', async () => {
  const h = harness({ status: { active: true, url: URL_, version: 'amp-5' }, mods: { [URL_ + 'editor.js']: new Error('x'), '/maps/editor.js': good('builtin') } });
  const inv = h.deps.invoke;
  h.deps.invoke = async (c, a) => { if (c === 'amp_mark_bad') throw new Error('nope'); return inv(c, a); };
  assert.equal((await openAmplifier(h.root, h.deps)).fallback, true);
});

console.log(`${n} passed`);
